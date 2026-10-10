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

export type ChatMode = 'labs' | 'biology' | 'stats' | 'strength' | 'food';
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

interface ToolKit { schemas: any[]; run: (name: string, input: any) => any | Promise<any>; context: string }

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

// ── STRENGTH tools (routines, sessions, progression, muscles, the 7-day plan) ─────────────────
async function strengthKit(): Promise<ToolKit> {
  const S = require('./strength') as typeof import('./strength');
  const st = await S.loadStrength();
  const { getEffectiveMaxHr } = require('./claude') as typeof import('./claude');
  const snap = await loadSnapshotCache().catch(() => null);
  const maxHr = await getEffectiveMaxHr().catch(() => 188);
  const events = S.muscleEvents(st, ((snap?.runs ?? []) as any[]), maxHr || 188);
  const fresh = S.muscleFreshness(events);
  const load = S.muscularLoad(events);
  const name = (id: string) => S.exerciseById(st, id)?.name ?? id;
  const kit = S.currentKit(st);
  const routines = st.routines.filter(r => r.items.length);
  const finished = st.sessions.filter(x => x.finishedAt).sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  const sessLine = (x: typeof finished[number]) => {
    const by = new Map<string, string[]>();
    for (const l of x.sets) if (S.isWorkSet(l)) by.set(l.exerciseId, [...(by.get(l.exerciseId) ?? []), `${l.weightKg}×${l.reps}${l.rir != null ? `@${l.rir}` : ''}`]);
    const feel = Object.entries(x.feel ?? {}).map(([k, v]) => `${name(k)} ${v}`).join(', ');
    return `${x.date} ${x.routineName}${x.rpe ? ` RPE ${x.rpe}` : ''}${x.tailored ? ` (${x.tailored})` : ''}: ${[...by].map(([k, v]) => `${name(k)} ${v.join(' ')}`).join('; ')}${feel ? ` | feel: ${feel}` : ''}`;
  };
  const plan = st.autoPlanOn !== false ? st.autoPlan : undefined;
  const planLines = plan ? plan.days.map(d => `${d.date} ${S.WEEKDAYS[new Date(d.date + 'T12:00:00').getDay()]}: run ${d.run ?? '?'} · strength ${d.kind === 'session' ? `${d.name}${d.done ? ' ✅' : ''}${d.minutes ? ` ~${d.minutes}′` : ''}` : d.kind === 'prehab' ? 'runner prehab (optional)' : 'none'} — ${d.why}${d.changes?.length ? ` [tailored: ${d.changes.join('; ')}]` : ''}`) : [];
  const progress = routines.flatMap(r => S.flatRoutine(st, r).items).filter((it, i, a) => a.findIndex(x => x.exerciseId === it.exerciseId) === i)
    .map(it => { const sg = S.suggestWeight(st, it); return sg.why ? `${name(it.exerciseId)}: ${sg.kg != null ? `${sg.kg} kg — ` : ''}${sg.why}` : ''; }).filter(Boolean);
  const context = [
    `Today ${S.localDateKey()} · equipment: ${st.here?.name ?? 'Merelbeke'} — ${S.KITS[kit].label}.`,
    plan ? `COACH'S 7-DAY PLAN (runs fixed; strength placed around them — ${plan.target} sessions, ${plan.targetWhy}${plan.summary ? `; ${plan.summary}` : ''}):\n${planLines.join('\n')}` : 'Strength auto-plan: off.',
    `ROUTINES: ${routines.map(r => `${r.name}${r.mode === 'superset' ? ' [superset]' : ''}: ${S.flatRoutine(st, r).items.map(it => `${name(it.exerciseId)} ${it.sets}×${it.repsLo}-${it.repsHi}${it.weightKg != null ? ` @${it.weightKg}kg` : ''}${it.ss ? ' (ss)' : ''}`).join(', ')}`).join('\n')}`,
    `LAST SESSIONS (newest last):\n${finished.slice(-8).map(sessLine).join('\n') || 'none yet'}`,
    `PROGRESSION (next weight per exercise, the app's rule):\n${progress.join('\n')}`,
    `MUSCLE FRESHNESS now: ${fresh.filter(f => f.state !== 'Calibrating').map(f => `${S.MUSCLE_LABEL[f.muscle]} ${f.pct}% ${f.state}`).join(', ') || 'calibrating'}`,
    `MUSCULAR LOAD (7 d vs 6 wk): ${load.map(g => `${g.label} ${g.status}${g.ratio != null ? ` ×${g.ratio.toFixed(2)}` : ''}`).join(', ')}`,
  ].join('\n\n');
  const findEx = (q: string) => { const n = String(q ?? '').toLowerCase(); return S.allExercises(st).find(e => e.id === q || e.name.toLowerCase() === n) ?? S.allExercises(st).find(e => e.name.toLowerCase().includes(n)); };
  return {
    context,
    schemas: [
      { name: 'get_exercise_history', description: "One exercise's full history: per session date, top kg, best reps, est. 1RM, volume, sets, feel. Accepts the exercise name or id.", input_schema: { type: 'object', properties: { exercise: { type: 'string' } }, required: ['exercise'] } },
      { name: 'list_exercises', description: 'Every exercise in the database with muscles, equipment needs and (if trained) last top weight × reps, est. 1RM and 8-week trend.', input_schema: { type: 'object', properties: {} } },
      { name: 'get_sessions', description: 'Logged strength sessions in a date range (YYYY-MM-DD), each with every work set (kg×reps@RIR), RPE, feel.', input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } } },
      { name: 'get_muscles', description: 'Per-muscle freshness (0-100 %, state) and muscular-load status per group (7-day vs 6-week ratio).', input_schema: { type: 'object', properties: {} } },
    ],
    run: (tool, input) => {
      if (tool === 'get_exercise_history') { const e = findEx(input?.exercise); if (!e) return { error: `no exercise "${input?.exercise}"` }; return { exercise: e.name, sessions: S.exerciseHistory(st, e.id).map(h => ({ date: h.date, topKg: f(h.topKg), bestReps: h.bestReps, e1rm: f(h.bestE1rm), volume: h.volume, sets: h.sets, feel: h.feel })) }; }
      if (tool === 'list_exercises') return S.allExercises(st).map(e => { const l = S.exerciseStatLine(st, e.id); return { name: e.name, muscles: Object.entries(e.muscles).filter(([, v]) => (v ?? 0) >= 0.5).map(([m]) => m), needs: e.needs ?? [], available_here: S.exerciseAvailable(e, kit), ...(l ? { sessions: l.sessions, last: `${l.lastTop}×${l.lastReps}`, e1rm: f(l.e1rm), trendPct: f(l.trendPct) } : {}) }; });
      if (tool === 'get_sessions') { const a = String(input?.from ?? '0000'), b = String(input?.to ?? '9999'); return finished.filter(x => x.date >= a && x.date <= b).map(sessLine); }
      if (tool === 'get_muscles') return { freshness: fresh.map(x => ({ muscle: x.muscle, pct: x.pct, state: x.state })), load: load.map(g => ({ group: g.label, status: g.status, ratio: f(g.ratio), days: g.days })) };
      return { error: `unknown tool ${tool}` };
    },
  };
}

// ── FOOD tools (log, meals, macros, micronutrients, caffeine, training context) ─────────────────
async function foodKit(): Promise<ToolKit> {
  const F = require('./foodLog') as typeof import('./foodLog');
  const D = require('./foodDb') as typeof import('./foodDb');
  const { trainingDayKey } = require('./trainingLoad') as typeof import('./trainingLoad');
  const dc = (await (require('./healthkit') as typeof import('./healthkit')).peekDailyComponents().catch(() => ({ days: {} as Record<string, Record<string, number>> }))).days;
  const today = trainingDayKey(Date.now());
  const dayKey = (k: number) => { const d = new Date(today + 'T12:00:00'); d.setDate(d.getDate() - k); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const r = (v?: number) => (v == null ? 0 : Math.round(v));
  const days: { date: string; log: Awaited<ReturnType<typeof F.loadDay>> }[] = [];
  for (let k = 0; k < 14; k++) { const date = dayKey(k); const log = await F.loadDay(date).catch(() => null); if (log && (log.entries.length || log.water.length)) days.push({ date, log }); }
  const dayLine = (date: string, log: any) => { const t = F.dayTotals(log); return `${date}${log.complete ? ' (complete)' : ''}: ${r(t.kcal)} kcal · P ${r(t.prot)} C ${r(t.carb)} F ${r(t.fat)} g · fibre ${r(t.fib)}${t.rs ? ` · resistant starch ${r(t.rs)}` : ''}${t.caf ? ` · caffeine ${r(t.caf)} mg` : ''} · water ${(t.waterMl / 1000).toFixed(1)} L${dc[date]?.totalEnergy > 0 ? ` · watch energy ${r(dc[date].totalEnergy)} kcal` : ''}`; };
  const entryLine = (e: any) => `${e.t.slice(11, 16)} [${F.entryMealLabel(e)}] ${e.name}${e.grams ? ` ${r(e.grams)}${e.unit === 'ml' ? 'ml' : 'g'}` : ''} — ${r(F.netNutr(e.n).kcal)} kcal, P ${r(e.n.prot)} C ${r(F.netNutr(e.n).carb)} F ${r(e.n.fat)}`;
  // micronutrients: 14-day daily average vs the EU NRV (only days with food logged)
  const logged = days.filter(d => d.log.entries.length);
  const micro = F.MICROS.map(m => { const v = logged.reduce((a, d) => a + (F.dayTotals(d.log)[m.k] ?? 0), 0) / Math.max(1, logged.length); return `${m.label} ${Math.round((v / m.nrv) * 100)}%`; }).join(', ');
  const lib = await F.loadLibrary();
  const meals = lib.meals.map(m => { const n = F.sumNutr(m.items.map(it => (it.per100 && it.grams != null ? F.scaleNutr(F.withRs(it.key, it.per100), it.grams) : (it.n ?? {})))); return `${m.name} (${m.items.length} items): ${r(n.kcal)} kcal · P ${r(n.prot)} C ${r(n.carb)} F ${r(n.fat)} — ${m.items.map(i => `${i.name.split(',')[0]} ${i.grams ?? ''}g`).join(', ')}`; });
  const coach = require('./coach') as typeof import('./coach');
  const plan = await coach.loadCachedPlan(today).catch(() => null);
  const cafLine = await (async () => { const C = require('./caffeineHrv') as typeof import('./caffeineHrv'); return C.cafHrvSummary(await C.caffeineHrv()); })().catch(() => '');
  const kg = await (require('./healthkit') as typeof import('./healthkit')).fetchBodyMassHistory(3).then((x: any[]) => x.filter(v => v.value > 0).slice(-1)[0]?.value).catch(() => undefined);
  const context = [
    `Today (food day) ${today}.${kg ? ` Body weight ${Math.round(kg)} kg.` : ''}${plan ? ` Today's run plan: ${plan.intensity}${plan.runMinutes ? `, ${plan.runMinutes} min` : ''}${plan.sessionKind ? ` (${plan.sessionKind})` : ''}.` : ''}`,
    `DAILY TOTALS (last 14 days, newest first; carbs = available, resistant starch excluded and at 2 kcal/g):\n${days.map(d => dayLine(d.date, d.log)).join('\n') || 'nothing logged'}`,
    `TODAY'S ENTRIES:\n${(days.find(d => d.date === today)?.log.entries ?? []).map(entryLine).join('\n') || 'none yet'}`,
    `YESTERDAY'S ENTRIES:\n${(days.find(d => d.date === dayKey(1))?.log.entries ?? []).map(entryLine).join('\n') || 'none'}`,
    `MICRONUTRIENTS (14-day daily average, % of EU NRV; sodium vs 2.4 g max; unmeasured values count 0, so true intake can be higher): ${micro}`,
    `SAVED MEALS:\n${meals.join('\n') || 'none'}`,
    cafLine,
  ].filter(Boolean).join('\n\n');
  return {
    context,
    schemas: [
      { name: 'get_day', description: 'Every logged item of one food day (YYYY-MM-DD): time, meal, food, amount, kcal + macros; and the day totals.', input_schema: { type: 'object', properties: { date: { type: 'string' } }, required: ['date'] } },
      { name: 'get_range', description: 'Daily totals (kcal, protein, carbs, fat, fibre, resistant starch, caffeine, water, watch energy) for a date range, max 120 days.', input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } },
      { name: 'find_food', description: "Nutrition per 100 g of foods matching a name (the athlete's own foods + the CIQUAL table + built-ins), incl. minerals/vitamins/caffeine.", input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
    ],
    run: async (tool: string, input: any) => {
      if (tool === 'get_day') { const log = await F.loadDay(String(input?.date ?? today)); return { entries: log.entries.map(entryLine), totals: dayLine(log.date, log) }; }
      if (tool === 'get_range') {
        const out: string[] = []; const a = new Date(String(input?.from) + 'T12:00:00'), b = new Date(String(input?.to) + 'T12:00:00');
        for (let d = new Date(a), n = 0; d <= b && n < 120; d.setDate(d.getDate() + 1), n++) { const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; const log = await F.loadDay(k).catch(() => null); if (log?.entries.length) out.push(dayLine(k, log)); }
        return out;
      }
      if (tool === 'find_food') { const q = String(input?.name ?? ''); const own = F.searchCustom(lib, q, D.norm); return [...own, ...D.searchFoodsEx(q, 6).items].slice(0, 6).map(f => ({ name: f.name, src: f.src, per100: f.per100, serving: f.serving })); }
      return { error: `unknown tool ${tool}` };
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
    + `• SE speed÷HR — speed per heartbeat, THE aerobic-efficiency signal (hot runs read low): latest ${f(tSe?.latest)} (${chg(tSe)}).\n`
    + `• EF power÷HR ≈ SE × body weight: latest ${f(tEf?.latest)} (${chg(tEf)}).\n`
    + `• EC speed÷power — ≈ CONSTANT by construction (Apple Watch power is modelled from speed+slope+weight), NOT an economy signal: latest ${f(tEc?.latest)} (${chg(tEc)}).\n`
    + (zs ? `INTENSITY (last 8wk): easy ${zs.easyPct}% / moderate ${zs.modPct}% / hard ${zs.hardPct}%, polarization ${zs.polarizationIndex} (>0 polarised), ${zs.minutes} min.\n` : '')
    + (load ? `LOAD: CTL(fitness) ${f(load.ctl)}, ATL(fatigue) ${f(load.atl)}, TSB(form) ${f(load.tsb ?? load.ctl - load.atl)}, ACWR ${acwr.length ? f(acwr[acwr.length - 1].ratio) : '—'} (0.8–1.3 sweet spot).\n` : '')
    + (curve ? `POWER-DURATION (best W): 5s ${watt(5)}, 1min ${watt(60)}, 5min ${watt(300)}, 20min ${watt(1200)}, 60min ${watt(3600)}; Critical Power ≈ ${curve.cp ?? '—'} W.\n` : '')
    + (pz ? `POWER ZONES (W): recovery≤${pz.recoveryMax}, Z2≤${pz.z2Max}, tempo ${pz.tempoMin}–${pz.tempoMax}, intervals≥${pz.intervalsMin}.\n` : '')
    + (dc.length ? `AEROBIC DECOUPLING (Pw:HR drift, <5% strong base): latest ${f(dc[dc.length - 1].pct)}%, recent median ${f(dcMed)}%.\n` : '')
    + `HEAT: runs ≥19°C are flagged hot (tempC/hot on the efficiency + decoupling tools). Heat raises HR for the same effort, so hot runs read LOW on EF/SE and HIGH on decoupling — weather, not fitness. Across a hot spell judge SE on the cooler runs — EC can't stand in (≈ constant by construction).\n`
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
  food:
    'You are the NUTRITION COACH inside a running-coach app, talking to a runner who also lifts. Answer from THE DATA BELOW (his food log, ' +
    'daily totals vs the watch\'s energy, micronutrient averages, saved meals, today\'s run plan, the caffeine → HRV finding). The app\'s ' +
    'conventions: carbs are AVAILABLE carbs; resistant starch (e.g. his raw potato starch) is excluded from carbs and counted at 2 kcal/g; ' +
    'fibre 2 kcal/g; watch energy is ±15–20 %. FUELLING PREFERENCE: he runs FASTED by default — suggest carbs ONLY for interval sessions ' +
    'and very long runs (≥ 90 min); say nothing about fuel for easy / tempo / recovery runs, and give no daily carb targets. Protein ' +
    '~1.6 g/kg supports strength + endurance. For micronutrients flag clear gaps (< 70 % NRV) and sodium above the maximum, with food ' +
    'suggestions — mind that unmeasured values count as 0. If he wants to change something, say exactly where in the app (📚 Food ' +
    'database for foods / meals, ＋ Add on a meal card, ⋯ for time / meal). Be BRIEF and concrete; call the tools for older days or a ' +
    'food\'s values instead of guessing. Never invent numbers. Not medical advice. Use light markdown — short paragraphs, bullets, small tables.',
  strength:
    'You are the STRENGTH COACH inside a running-coach app, talking to a runner who lifts (beginner with exercise names — explain movements plainly, ' +
    'name the muscles). Answer from THE DATA BELOW: his routines, the coach\'s 7-day plan (runs are FIXED, strength is placed around them), ' +
    'recent sessions (kg×reps@RIR, RPE, feel), the progression status, muscle freshness and muscular load, and where he trains today. ' +
    'Know the app\'s rules and stay consistent with them: weights go up only after 3 STABLE sessions in a row (every planned set at the top ' +
    'of the rep range, same weight, not graded hard), in steps of 5 / 2.5 / 1 kg within ~8 %; a muscle rests by the RPE of the session that ' +
    'trained it (RPE ≤ 5 → 1 day, 6–7 → 2, ≥ 8 → 3, +1 day if graded hard); no leg day on a long-run day or the day before intervals / tempo / ' +
    'a long run; readiness < 20 → no lifting, < 50 → upper body only, lighter; supersets alternate one set each (A1 B1 A2 B2); the equipment ' +
    'depends on the location (Merelbeke = Marcy machine + one cable stack + dumbbells, no dual cable). If he wants a change (move a session, ' +
    'swap an exercise, different sets/reps), say exactly what to do in the app (Fitness → Coach\'s strength week → Re-plan; the routine ' +
    'editor; ⇄ switch in a session). Be BRIEF and concrete — a few sentences or a short list; he can ask follow-ups. Call the tools for an ' +
    'exercise\'s full history or older sessions rather than guessing. Never invent numbers. Use light markdown — short paragraphs, bullets, small tables where they help.',
  stats:
    'You are a running-performance analyst for an athlete reviewing their OWN training statistics. Answer from THE DATA BELOW ' +
    '(efficiency EC/EF/SE, intensity distribution & polarization, load CTL/ATL/TSB/ACWR, power-duration curve & critical power, ' +
    'aerobic decoupling, power zones, body weight). Be BRIEF and concrete — a few sentences or a short list; the user can ask follow-ups. ' +
    'Use these facts correctly: Apple Watch running power is MODELLED from speed + slope + body weight, not measured. So EC = speed÷power is ≈ constant by construction — it only moves with body weight, hills and GPS noise and must NEVER be presented as economy progress (a precomputed EC↔weight Spearman rho is in the data: a NEGATIVE rho = EC up as weight down = the mass artifact). SE = speed÷HR (speed per heartbeat) is THE aerobic-efficiency signal; EF = power÷HR ≈ SE × body weight. SE/EF are HR-based and heat-sensitive. Power stays valid for pacing, zones, the power curve and load. ' +
    'For the full per-run series call the tools (do call them rather than saying you lack data). Note association≠causation and flag confounders (heat, HR dropout, device change). Not medical advice. ' +
    'Use light markdown — short paragraphs, bullets, and small tables where they help.',
};

export async function runDataChat(mode: ChatMode, history: ChatMsg[]): Promise<string> {
  const kit = mode === 'labs' ? await labsKit() : mode === 'biology' ? await biologyKit() : mode === 'strength' ? await strengthKit() : mode === 'food' ? await foodKit() : await statsKit();
  const system = `${SYSTEM[mode]}\n\n=== THE ATHLETE'S DATA ===\n${kit.context}`;
  try {
    if (await agenticSupported()) {
      const messages: any[] = history.map(m => ({ role: m.role, content: m.content }));
      for (let step = 0; step < MAX_STEPS; step++) {
        const res = await callLLMTools({ system, messages, tools: kit.schemas, maxTokens: MAX_TOKENS, temperature: 0.4 });
        if (res.stopReason !== 'tool_use') return res.text;   // has data in context, so a plain answer is fine
        messages.push({ role: 'assistant', content: res.content });
        const uses = res.content.filter((b: any) => b.type === 'tool_use');
        // a tool may be async (the food tools read the log files) → await each result
        messages.push({ role: 'user', content: await Promise.all(uses.map(async (u: any) => {
          let out: any; try { out = await kit.run(u.name, u.input ?? {}); } catch (e: any) { out = { error: e?.message ?? 'tool failed' }; }
          return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, 6000) };
        })) });
      }
      const final = await callLLMTools({ system, messages, tools: [], maxTokens: MAX_TOKENS, temperature: 0.4 });
      return final.text || 'I ran out of steps — please ask again.';
    }
  } catch (e: any) { if (!/AGENTIC_UNSUPPORTED/.test(e?.message ?? '')) throw e; }
  // single-shot fallback (no tool support) — the data is already in the system prompt
  return callLLM({ system, messages: history, maxTokens: MAX_TOKENS, temperature: 0.4 });
}
