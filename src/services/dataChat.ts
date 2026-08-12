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

export type ChatMode = 'labs' | 'biology';
export interface ChatMsg { role: 'user' | 'assistant'; content: string }

const MAX_TOKENS = 1400, MAX_STEPS = 6;
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

interface ToolKit { schemas: any[]; run: (name: string, input: any) => any; summary: string }

// ── LABS tools ──────────────────────────────────────────────────────────────
async function labsKit(): Promise<ToolKit> {
  const store = await loadLabs();
  const latest = (a: any) => a.series[a.series.length - 1];
  const status = (a: any) => { const l = latest(a); if (!l) return 'na'; if (a.refHigh != null && l.value > a.refHigh) return 'HIGH'; if (a.refLow != null && l.value < a.refLow) return 'LOW'; return a.refLow != null || a.refHigh != null ? 'in-range' : 'na'; };
  const oob = store.analytes.filter((a: any) => status(a) === 'HIGH' || status(a) === 'LOW');
  return {
    summary: `The athlete has ${store.analytes.length} blood-lab markers (updated ${store.updatedAt?.slice(0, 10) || '—'}); ${oob.length} are currently out of range.`,
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
  return {
    summary: `Body metrics (latest): ${rep.metrics.filter(m => m.latest != null).map(m => `${m.label} ${f(m.latest)}${m.unit === '%' ? '%' : ' ' + m.unit}`).join(', ') || 'none'}. Fitness CTL ≈ ${ctlLatest ?? '—'}.`,
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

const SYSTEM: Record<ChatMode, string> = {
  labs:
    'You are a careful health-data assistant for an athlete reading their OWN long-term blood-lab history. ' +
    'Be concise and concrete. Use the tools to pull whatever markers/history you need before answering; do not ' +
    'invent values. Read trends over years, flag out-of-range values, and connect related markers (iron, lipids, ' +
    'thyroid, liver, glucose/insulin) into a picture. You are NOT a physician — give context and "raise with your ' +
    'GP" pointers, never a diagnosis or treatment. Use markdown (short paragraphs, bullets, small tables).',
  biology:
    'You are a data assistant for an athlete reviewing their OWN body composition (weight, body-fat %, lean mass) ' +
    'and blood pressure, in the context of their training (fitness/CTL, run volume) and medical/life events. Be ' +
    'concise and concrete. Use the tools to pull metric histories, correlations and event effects before answering. ' +
    'Explain trends and plausible drivers, but note association≠causation and flag confounders. Not medical advice. ' +
    'Use markdown (short paragraphs, bullets, small tables).',
};

export async function runDataChat(mode: ChatMode, history: ChatMsg[]): Promise<string> {
  const kit = mode === 'labs' ? await labsKit() : await biologyKit();
  const system = SYSTEM[mode];
  try {
    if (await agenticSupported()) {
      const messages: any[] = history.map(m => ({ role: m.role, content: m.content }));
      for (let step = 0; step < MAX_STEPS; step++) {
        const res = await callLLMTools({ system, messages, tools: kit.schemas, maxTokens: MAX_TOKENS, temperature: 0.4 });
        if (res.stopReason !== 'tool_use') return res.text;
        messages.push({ role: 'assistant', content: res.content });
        const uses = res.content.filter((b: any) => b.type === 'tool_use');
        messages.push({ role: 'user', content: uses.map((u: any) => {
          let out: any; try { out = kit.run(u.name, u.input ?? {}); } catch (e: any) { out = { error: e?.message ?? 'tool failed' }; }
          return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, 6000) };
        }) });
      }
      const final = await callLLMTools({ system, messages, tools: [], maxTokens: MAX_TOKENS, temperature: 0.4 });
      return final.text || 'I pulled the data but ran out of steps — please ask again.';
    }
  } catch (e: any) { if (!/AGENTIC_UNSUPPORTED/.test(e?.message ?? '')) throw e; }
  // single-shot fallback: prepend a data summary to the system prompt
  return callLLM({ system: `${system}\n\nData snapshot: ${kit.summary}`, messages: history, maxTokens: MAX_TOKENS, temperature: 0.4 });
}
