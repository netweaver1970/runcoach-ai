// Two separate agentic chats over the athlete's own health data:
//   • 'biology' — body composition (weight / body-fat% / lean) + blood pressure, with training context
//   • 'labs'    — imported clinical blood-lab history
// Each keeps its OWN persisted history and its OWN tool context. The model can pull detail (a metric's
// full series, a marker's history, events, out-of-range set) across round-trips before answering.
// Non-diagnostic by construction; falls back to a single-shot call on providers without tool support.
import * as FileSystem from 'expo-file-system';
import { callLLM, callLLMTools, agenticSupported } from './llm';
import { loadLabs } from './labsStore';
import { getBiologyReport } from './biology';
import { loadEvents } from './timelineEvents';
import { loadSnapshotCache } from './healthkit';
import { efficiencyTrend, zoneSummary, zoneDistributionOverTime, acwrSeries, decouplingTrend, decouplingBanded } from './runStats';
import { computePowerCurve } from './powerCurve';
import { getPowerZones } from './claude';
import { loadStatsRuns, mergeRuns } from './statsRunsCache';
import { repairWorkStats } from './workStatsRepair';

export type ChatMode = 'labs' | 'biology' | 'stats';
export interface ChatMsg { role: 'user' | 'assistant'; content: string }

const MAX_TOKENS = 4000, MAX_STEPS = 5;   // generous ceiling so a table + prose answer never truncates mid-way
const f = (v: number | null) => (v == null ? null : Number(v.toPrecision(4)));

// ── history persistence (per mode) ─────────────────────────────────────────────
const histFile = (m: ChatMode) => `${FileSystem.documentDirectory}runcoach-${m}-chat.json`;
export async function loadChatHistory(m: ChatMode): Promise<ChatMsg[]> {
  try {
    const info = await FileSystem.getInfoAsync(histFile(m));
    if (!info.exists) return [];
    const v = JSON.parse(await FileSystem.readAsStringAsync(histFile(m)));
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
export async function saveChatHistory(m: ChatMode, msgs: ChatMsg[]): Promise<void> {
  try { await FileSystem.writeAsStringAsync(histFile(m), JSON.stringify(msgs.slice(-40))); } catch { /* ignore */ }
}
export async function clearChatHistory(m: ChatMode): Promise<void> {
  try { await FileSystem.deleteAsync(histFile(m), { idempotent: true }); } catch { /* ignore */ }
}

interface ToolKit { schemas: any[]; run: (name: string, input: any) => any; context: string }

// ── LABS tools ──────────────────────────────────────────────────────────────
async function labsKit(): Promise<ToolKit> {
  const store = await loadLabs();
  const latest = (a: any) => a.series[a.series.length - 1];
  const status = (a: any) => { const l = latest(a); if (!l) return 'na'; if (a.refHigh != null && l.value > a.refHigh) return 'HIGH'; if (a.refLow != null && l.value < a.refLow) return 'LOW'; return a.refLow != null || a.refHigh != null ? 'in-range' : 'na'; };
  const oob = store.analytes.filter((a: any) => status(a) === 'HIGH' || status(a) === 'LOW');
  // Full compact snapshot in the context so the model can always answer even if it can't call tools
  // (some providers don't reliably emit tool_use). Each line: latest value + status + ref + count + earliest
  // value for a rough trend. get_marker_history gives the full year-by-year series on demand.
  const line = (a: any) => { const l = latest(a); const first = a.series[0]; const st = status(a);
    const trend = first && l && first.date !== l.date ? `, was ${f(first.value)} in ${first.date.slice(0, 4)}` : '';
    if (!l && a.textSeries?.length) { const t = a.textSeries[a.textSeries.length - 1]; return `${a.label} [${a.category}]: ${t.text} (${t.date})`; }
    return `${a.label} [${a.category}]: ${l ? f(l.value) : '—'} ${a.unit}${st === 'HIGH' || st === 'LOW' ? ` «${st}»` : ''} (ref ${a.refLow ?? '–'}–${a.refHigh ?? '–'}, ${a.series.length}×${trend})`; };
  const events = await loadEvents().catch(() => [] as any[]);
  const evLines = events.filter((e: any) => e.type === 'event' && (e.category === 'medical' || e.category === 'life'))
    .map((e: any) => `${String(e.date).slice(0, 10)}${e.endDate ? `–${String(e.endDate).slice(0, 10)}` : ''} ${e.title || e.category} (${e.category})`);
  const bio = await getBiologyReport().catch(() => null);   // reuse the memoised report for training context
  const ctlLine = bio && bio.ctl.length
    ? `\n\nTraining load: current fitness CTL ≈ ${f(bio.ctl[bio.ctl.length - 1].value)}${bio.runKm7d?.length ? `, ~${f(bio.runKm7d[bio.runKm7d.length - 1].value)} km run in the last 7 days` : ''}.`
    : '';
  const context = `Blood-lab panel (updated ${store.updatedAt?.slice(0, 10) || '—'}, ${store.analytes.length} markers, ${oob.length} out of range):\n`
    + store.analytes.map(line).join('\n')
    + ctlLine
    + (evLines.length ? `\n\nMedical/life timeline (dates to line up against lab changes):\n${evLines.join('\n')}` : '');
  return {
    context,
    schemas: [
      { name: 'list_markers', description: 'Every marker with category, unit, reference range, latest value/date and in/out-of-range status.', input_schema: { type: 'object', properties: {} } },
      { name: 'get_out_of_range', description: 'Only the markers whose latest value is outside the reference range.', input_schema: { type: 'object', properties: {} } },
      { name: 'get_marker_history', description: "A marker's full dated history, oldest→newest.", input_schema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] } },
    ],
    run: (name, input) => {
      if (name === 'list_markers') return store.analytes.map((a: any) => { const l = latest(a); return { label: a.label, category: a.category, unit: a.unit, ref: [a.refLow, a.refHigh], latest: l ? f(l.value) : null, date: l?.date, status: status(a) }; });
      if (name === 'get_out_of_range') return oob.map((a: any) => { const l = latest(a); return { label: a.label, value: f(l.value), unit: a.unit, ref: [a.refLow, a.refHigh], status: status(a) }; });
      if (name === 'get_marker_history') { const q = String(input?.label ?? '').toLowerCase(); const m = store.analytes.find((a: any) => a.label.toLowerCase() === q) ?? store.analytes.find((a: any) => a.label.toLowerCase().includes(q)); if (!m) return { error: `no marker matching "${input?.label}"` }; return { label: m.label, unit: m.unit, ref: [m.refLow, m.refHigh], history: m.series.map((p: any) => `${p.date}:${f(p.value)}`), text: m.textSeries?.map((t: any) => `${t.date}:${t.text}`) }; }
      return { error: `unknown tool ${name}` };
    },
  };
}

// ── BIOLOGY tools (body comp + BP + training) ─────────────────────────────────
async function biologyKit(): Promise<ToolKit> {
  const rep = await getBiologyReport();
  const ctlLatest = rep.ctl.length ? f(rep.ctl[rep.ctl.length - 1].value) : null;
  const byKey = (k: string) => rep.metrics.find(m => m.key === k);
  const mLine = (m: any) => { const first = m.points[0];
    const trend = first && m.latest != null ? `, was ${f(first.value)} in ${String(first.date).slice(0, 4)}` : '';
    const corr = m.correlations.filter((c: any) => c.significant).map((c: any) => `${c.against} rho ${f(c.rho)} (${c.strength}, lag ${c.lagDays}d)`).join('; ');
    return `${m.label}: ${f(m.latest)}${m.unit === '%' ? '%' : ' ' + m.unit} (${m.n}×, trend ${f(m.trendPerWeek) ?? 0}/wk ${m.trendDir ?? ''}${trend})${corr ? ` — correlates: ${corr}` : ''}`; };
  const context = `Body metrics (latest, updated ${rep.generatedAt?.slice(0, 10) || '—'}):\n`
    + rep.metrics.filter(m => m.n > 0).map(mLine).join('\n')
    + `\nFitness CTL ≈ ${ctlLatest ?? '—'}.`
    + (rep.events.length ? `\nTimeline events: ${rep.events.map(e => `${e.date} ${e.label} (${e.category})`).join('; ')}` : '');
  return {
    context,
    schemas: [
      { name: 'list_metrics', description: 'Body-composition & BP metrics with latest value, trend/week, n readings and any significant correlations vs training (CTL) or run volume.', input_schema: { type: 'object', properties: {} } },
      { name: 'get_metric_series', description: "One metric's full dated history (key: weight|bodyfat|lean|bpSys|bpDia).", input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
      { name: 'get_events', description: 'Medical/life timeline events (dates), and their measured before/after effect on each metric.', input_schema: { type: 'object', properties: {} } },
    ],
    run: (name, input) => {
      if (name === 'list_metrics') return rep.metrics.map(m => ({ key: m.key, label: m.label, unit: m.unit, latest: f(m.latest), latestDate: m.latestDate, n: m.n, trendPerWeek: f(m.trendPerWeek), trendDir: m.trendDir, correlations: m.correlations.filter(c => c.significant).map(c => `${c.against}: rho ${f(c.rho)} (lag ${c.lagDays}d, ${c.strength})`) }));
      if (name === 'get_metric_series') { const m = byKey(String(input?.key ?? '')); if (!m) return { error: `no metric "${input?.key}" (use weight|bodyfat|lean|bpSys|bpDia)` }; return { key: m.key, unit: m.unit, series: m.points.map(p => `${p.date.slice(0, 10)}:${f(p.value)}`) }; }
      if (name === 'get_events') return { events: rep.events.map(e => ({ date: e.date, label: e.label, category: e.category, endDate: e.endDate })), impacts: rep.eventImpacts.map(ei => ({ event: ei.label, date: ei.date, effects: ei.effects.filter(e => e.delta != null).map(e => `${e.label}: ${f(e.before)}→${f(e.after)} (Δ${f(e.delta)})`) })) };
      return { error: `unknown tool ${name}` };
    },
  };
}

// ── STATS tools (running performance analytics) ───────────────────────────────
async function statsKit(): Promise<ToolKit> {
  const snap: any = await loadSnapshotCache();
  const runs: any[] = mergeRuns(snap?.runs ?? [], await loadStatsRuns());   // full durable history, like the screen
  const maxHR = snap?.estimatedMaxHR ?? 188;
  const pz = await getPowerZones().catch(() => null as any);
  // Same stationary-time repair the Statistics screen uses (cache is warm after that screen has run), so
  // the chat reasons on the corrected work stats rather than phone-call-diluted ones.
  const repairs = await repairWorkStats(runs).catch(() => ({} as any));
  const ef = efficiencyTrend(runs, repairs);
  const zs = zoneSummary(runs);
  const tl: any[] = snap?.trainingLoad ?? [];
  const acwr = acwrSeries(tl);
  const load = tl[tl.length - 1];
  const weeks = zoneDistributionOverTime(runs, 0, Date.now() + 86_400_000, maxHR);
  // Power curve + decoupling read their caches (warm after the Statistics screen ran).
  const [curve, dcRaw] = await Promise.all([
    computePowerCurve(runs).catch(() => null) as any,
    decouplingTrend(runs).catch(() => [] as any[]),
  ]);
  const dc = decouplingBanded(dcRaw).clean;   // drop artifact runs outside the moving normal band
  const trendOf = (key: 'ef' | 'ec' | 'se') => {
    const v = ef.filter((p: any) => p.aerobic && p[key] > 0).slice(-15).map((p: any) => p[key]);
    if (v.length < 3) return null;
    const n = v.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sx += i; sy += v[i]; sxx += i * i; sxy += i * v[i]; }
    const den = n * sxx - sx * sx; if (!den) return null;
    const m = (n * sxy - sx * sy) / den; return { change: m * (n - 1), n, latest: v[v.length - 1] };
  };
  const tEf = trendOf('ef'), tEc = trendOf('ec'), tSe = trendOf('se');
  const watt = (sec: number) => curve?.points?.find((p: any) => p.sec === sec)?.watts ?? null;
  const dcRecent = dc.slice(-8).map((d: any) => d.pct);
  const dcMed = dcRecent.length ? [...dcRecent].sort((a: number, b: number) => a - b)[Math.floor(dcRecent.length / 2)] : null;
  const bio = await getBiologyReport().catch(() => null as any);
  const wt = bio?.metrics?.find((m: any) => m.key === 'weight');
  // Does EC actually track body weight? Pair each aerobic EC run with the nearest weigh-in (±14d) and
  // rank-correlate — a strong NEGATIVE rho (EC up as weight down) = the power-from-mass artifact, not real economy.
  const spearman = (a: number[], b: number[]): number | null => {
    const n = a.length; if (n < 3) return null;
    const rank = (arr: number[]) => { const idx = arr.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(n); for (let i = 0; i < n; i++) r[idx[i][1] as number] = i + 1; return r as number[]; };
    const ra = rank(a), rb = rank(b); let d2 = 0; for (let i = 0; i < n; i++) { const d = ra[i] - rb[i]; d2 += d * d; }
    return Math.round((1 - (6 * d2) / (n * (n * n - 1))) * 100) / 100;
  };
  const wSeries = (wt?.points ?? []).map((p: any) => ({ t: new Date(p.date).getTime(), v: p.value })).sort((a: any, b: any) => a.t - b.t);
  const nearW = (t: number) => { let best: number | null = null, bd = Infinity; for (const w of wSeries) { const d = Math.abs(w.t - t); if (d < bd) { bd = d; best = w.v; } } return bd <= 14 * 86_400_000 ? best : null; };
  const ecW = ef.filter((p: any) => p.aerobic && p.ec > 0).map((p: any) => ({ ec: p.ec, w: nearW(new Date(p.date).getTime()) })).filter((x: any) => x.w != null);
  const ecWtRho = ecW.length >= 6 ? spearman(ecW.map((x: any) => x.ec), ecW.map((x: any) => x.w)) : null;
  const events = await loadEvents().catch(() => [] as any[]);
  const evLines = events.filter((e: any) => e.type === 'event' && (e.category === 'medical' || e.category === 'life'))
    .map((e: any) => `${String(e.date).slice(0, 10)} ${e.title || e.category} (${e.category})`);
  const chg = (t: any) => t ? `${t.change >= 0 ? '+' : ''}${f(t.change)} over last ${t.n}` : '—';
  const context =
    `Running performance analytics (${runs.length} runs, maxHR ${maxHR}):\n`
    + `EFFICIENCY (higher=better, steady aerobic runs; sensor/label glitches already removed):\n`
    + `• EC speed÷power — HR-INDEPENDENT, most trustworthy: latest ${f(tEc?.latest)} (${chg(tEc)}).\n`
    + `• EF power÷HR (HR-based): latest ${f(tEf?.latest)} (${chg(tEf)}).\n`
    + `• SE speed÷HR (HR-based): latest ${f(tSe?.latest)} (${chg(tSe)}).\n`
    + (zs ? `INTENSITY (last 8wk): easy ${zs.easyPct}% / moderate ${zs.modPct}% / hard ${zs.hardPct}%, polarization ${zs.polarizationIndex} (>0 polarised), ${zs.minutes} min.\n` : '')
    + (load ? `LOAD: CTL(fitness) ${f(load.ctl)}, ATL(fatigue) ${f(load.atl)}, TSB(form) ${f(load.tsb ?? load.ctl - load.atl)}, ACWR ${acwr.length ? f(acwr[acwr.length - 1].ratio) : '—'} (0.8–1.3 sweet spot).\n` : '')
    + (curve ? `POWER-DURATION (best W): 5s ${watt(5)}, 1min ${watt(60)}, 5min ${watt(300)}, 20min ${watt(1200)}, 60min ${watt(3600)}; Critical Power ≈ ${curve.cp ?? '—'} W.\n` : '')
    + (pz ? `POWER ZONES (W): recovery≤${pz.recoveryMax}, Z2≤${pz.z2Max}, tempo ${pz.tempoMin}–${pz.tempoMax}, intervals≥${pz.intervalsMin}.\n` : '')
    + (dc.length ? `AEROBIC DECOUPLING (Pw:HR drift, <5% strong base): latest ${f(dc[dc.length - 1].pct)}%, recent median ${f(dcMed)}%.\n` : '')
    + `HEAT: runs ≥19°C are flagged hot (tempC/hot on the efficiency + decoupling tools). Heat raises HR for the same effort, so hot runs read LOW on EF/SE and HIGH on decoupling — weather, not fitness. EC (speed÷power) is HR-independent and unaffected: prefer it across a hot spell.\n`
    + (wt ? `BODY WEIGHT: latest ${f(wt.latest)} kg${wt.points?.[0] ? `, was ${f(wt.points[0].value)} kg in ${String(wt.points[0].date).slice(0, 7)}` : ''} (${wt.n ?? wt.points?.length ?? 0} readings, trend ${f(wt.trendPerWeek) ?? 0} kg/wk ${wt.trendDir ?? ''}). Power is estimated from mass, so weight change shifts EC — call get_body_series(weight) to line the full series up against EC.\n` : '')
    + (ecWtRho != null ? `EC↔WEIGHT: Spearman rho ${f(ecWtRho)} across ${ecW.length} paired runs (strong NEGATIVE ⇒ EC rises as weight falls = mass-estimate artifact; near 0 ⇒ EC change is real/pace/device).\n` : '')
    + (evLines.length ? `TIMELINE: ${evLines.join('; ')}\n` : '');
  return {
    context,
    schemas: [
      { name: 'get_efficiency_history', description: 'Full dated EC/EF/SE per run (oldest→newest) with run type.', input_schema: { type: 'object', properties: {} } },
      { name: 'get_power_curve', description: 'Full power-duration curve: best average watts for each duration.', input_schema: { type: 'object', properties: {} } },
      { name: 'get_decoupling_history', description: 'Full Pw:HR (or speed:HR) decoupling % per steady run.', input_schema: { type: 'object', properties: {} } },
      { name: 'get_intensity_weeks', description: 'Weekly easy/moderate/hard minutes over time.', input_schema: { type: 'object', properties: {} } },
      { name: 'get_recent_runs', description: 'Most recent runs with type + work power/HR/pace.', input_schema: { type: 'object', properties: { n: { type: 'number' } } } },
      { name: 'get_body_series', description: 'Full dated body-metric series to line up against runs (key: weight|bodyfat|lean|bpSys|bpDia). Use weight to test whether an EC change is a mass-estimate artifact.', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
    ],
    run: (name, input) => {
      if (name === 'get_efficiency_history') return ef.map((p: any) => ({ date: p.date, type: p.label, ec: p.ec || null, ef: p.ef || null, se: p.se || null, tempC: p.tempC ?? null, hot: !!p.hot, repaired: !!p.repaired, stationaryPct: p.stationaryPct ?? 0 }));
      if (name === 'get_body_series') { const m = bio?.metrics?.find((x: any) => x.key === String(input?.key ?? '')); if (!m) return { error: 'no metric; use weight|bodyfat|lean|bpSys|bpDia' }; return { key: m.key, unit: m.unit, series: (m.points ?? []).map((p: any) => `${String(p.date).slice(0, 10)}:${f(p.value)}`) }; }
      if (name === 'get_power_curve') return curve ? curve.points.map((p: any) => ({ sec: p.sec, watts: p.watts, date: p.date })) : { error: 'no power curve' };
      if (name === 'get_decoupling_history') return dc.map((d: any) => ({ date: d.date, pct: d.pct, type: d.label, tempC: d.tempC ?? null, hot: !!d.hot }));
      if (name === 'get_intensity_weeks') return weeks.map((w: any) => ({ week: w.weekStart, easy: w.easyMin, mod: w.modMin, hard: w.hardMin, total: w.total }));
      if (name === 'get_recent_runs') { const n = Math.min(30, Math.max(1, Number(input?.n) || 12)); return runs.slice(0, n).map((r: any) => ({ date: String(r.date).slice(0, 10), type: r.label, workPower: r.workPower, workHR: r.workHR, workPaceSec: r.workPace, km: r.distance ? Math.round(r.distance / 100) / 10 : null })); }
      return { error: `unknown tool ${name}` };
    },
  };
}

const SYSTEM: Record<ChatMode, string> = {
  labs:
    "You are a health-data assistant for an athlete reading their OWN blood-lab history. Answer from THE DATA " +
    "BELOW — it lists every marker's latest value, status, reference range, count and earliest value. Keep replies " +
    'BRIEF and conversational — a few sentences or a short bulleted list; the user can ask follow-ups, so do NOT ' +
    'dump a full report unless asked. Flag out-of-range values and connect related markers (iron, lipids, thyroid, ' +
    'liver, glucose). When a lab change lines up in time with a medical/life event below (e.g. a medication start), ' +
    'point it out — but note association≠causation. For a marker\'s full year-by-year series call get_marker_history. ' +
    'Never invent values. You are NOT a physician — give context and "raise with your GP" pointers, never a diagnosis. Use light markdown — short paragraphs, bullets, and small tables where they help.',
  biology:
    'You are a data assistant for an athlete reviewing their OWN body composition (weight, body-fat %, lean mass) ' +
    'and blood pressure, alongside training (fitness/CTL) and medical/life events. Answer from THE DATA BELOW ' +
    '(latest values, trends, correlations, events). Keep replies BRIEF and conversational — a few sentences or a ' +
    'short list; the user can ask follow-ups. For a full series call get_metric_series. Note association≠causation ' +
    'and flag confounders. Not medical advice. Use light markdown — short paragraphs, bullets, and small tables where they help.',
  stats:
    'You are a running-performance analyst for an athlete reviewing their OWN training statistics. Answer from THE DATA BELOW ' +
    '(efficiency EC/EF/SE, intensity distribution & polarization, load CTL/ATL/TSB/ACWR, power-duration curve & critical power, ' +
    'aerobic decoupling, power zones, body weight). Be BRIEF and concrete — a few sentences or a short list; the user can ask follow-ups. ' +
    'Use these facts correctly: EC = speed÷power is HR-INDEPENDENT so it is the most trustworthy economy signal; EF/SE are HR-based and heat-sensitive. ' +
    'Running power is estimated from body mass, so a falling EC that tracks falling weight is likely the mass estimate, not a real economy loss — a precomputed EC↔weight Spearman rho is in the data, and get_body_series(weight) gives the full weigh-in series to line up against get_efficiency_history. ' +
    'For the full per-run series call the tools (do call them rather than saying you lack data). Note association≠causation and flag confounders (heat, HR dropout, device change). Not medical advice. ' +
    'Use light markdown — short paragraphs, bullets, and small tables where they help.',
};

export async function runDataChat(mode: ChatMode, history: ChatMsg[]): Promise<string> {
  const kit = mode === 'labs' ? await labsKit() : mode === 'biology' ? await biologyKit() : await statsKit();
  const system = `${SYSTEM[mode]}\n\n=== THE ATHLETE'S DATA ===\n${kit.context}`;
  try {
    if (await agenticSupported()) {
      const messages: any[] = history.map(m => ({ role: m.role, content: m.content }));
      for (let step = 0; step < MAX_STEPS; step++) {
        const res = await callLLMTools({ system, messages, tools: kit.schemas, maxTokens: MAX_TOKENS, temperature: 0.4 });
        if (res.stopReason !== 'tool_use') return res.text;   // has data in context, so a plain answer is fine
        messages.push({ role: 'assistant', content: res.content });
        const uses = res.content.filter((b: any) => b.type === 'tool_use');
        messages.push({ role: 'user', content: uses.map((u: any) => {
          let out: any; try { out = kit.run(u.name, u.input ?? {}); } catch (e: any) { out = { error: e?.message ?? 'tool failed' }; }
          return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, 6000) };
        }) });
      }
      const final = await callLLMTools({ system, messages, tools: [], maxTokens: MAX_TOKENS, temperature: 0.4 });
      return final.text || 'I ran out of steps — please ask again.';
    }
  } catch (e: any) { if (!/AGENTIC_UNSUPPORTED/.test(e?.message ?? '')) throw e; }
  // single-shot fallback (no tool support) — the data is already in the system prompt
  return callLLM({ system, messages: history, maxTokens: MAX_TOKENS, temperature: 0.4 });
}
