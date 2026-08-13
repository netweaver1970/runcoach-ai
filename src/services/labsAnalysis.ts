// AI read of a single lab marker. AGENTIC: the model is given tools to pull ANY related marker's history
// (whole iron/lipid/thyroid panels, all out-of-range values) across round-trips before answering, so it can
// build the picture itself rather than being handed a fixed context. Falls back to a single-shot call on
// providers without tool support. Non-diagnostic by construction (system prompt + enforced disclaimer).
import { callLLM, callLLMTools, agenticSupported } from './llm';
import { LabAnalyte } from './labs';
import { LabStore } from './labsStore';

const MAX_TOKENS = 3000;                 // generous — multi-marker synthesis + tables without truncation
const MAX_STEPS = 6;                     // tool round-trips before a forced final answer
const f = (v: number) => Number(v.toPrecision(4));
const latestOf = (a: LabAnalyte) => a.series[a.series.length - 1];
const statusStr = (a: LabAnalyte): string => {
  const l = latestOf(a); if (!l) return 'na';
  if (a.refHigh != null && l.value > a.refHigh) return 'HIGH';
  if (a.refLow != null && l.value < a.refLow) return 'LOW';
  return a.refLow != null || a.refHigh != null ? 'in-range' : 'na';
};
const isOob = (a: LabAnalyte) => statusStr(a) === 'HIGH' || statusStr(a) === 'LOW';

const SYSTEM =
  'You are a careful health-data assistant helping an athlete read their OWN long-term blood-test history. ' +
  'Be concise, concrete and educational. Explain what the marker is, read the multi-year TREND, and flag values ' +
  'outside the reference range. Use the tools to pull whatever RELATED markers you need (e.g. the rest of the ' +
  'iron panel, the full lipid/cardio set, the thyroid set, glucose/insulin) before you answer — do not guess at ' +
  'values you can look up. You are NOT a physician: give context and "worth raising with your GP" pointers, never ' +
  'a diagnosis, medication, or dosing advice. Finish with a one-line non-diagnostic disclaimer.';

const toolSchemas = [
  { name: 'list_markers', description: 'List every available marker with its category, unit, reference range, latest value/date and in/out-of-range status.', input_schema: { type: 'object', properties: {} } },
  { name: 'get_out_of_range', description: 'List only the markers whose latest value is outside its reference range.', input_schema: { type: 'object', properties: {} } },
  { name: 'get_marker_history', description: "One marker's full dated history, oldest→newest.", input_schema: { type: 'object', properties: { label: { type: 'string', description: 'the marker name, e.g. "Ferritin"' } }, required: ['label'] } },
];

function runTool(name: string, input: any, store: LabStore): any {
  if (name === 'list_markers')
    return store.analytes.map(a => { const l = latestOf(a); return { label: a.label, category: a.category, unit: a.unit, ref: [a.refLow, a.refHigh], latest: l ? f(l.value) : null, date: l?.date, status: statusStr(a) }; });
  if (name === 'get_out_of_range')
    return store.analytes.filter(isOob).map(a => { const l = latestOf(a)!; return { label: a.label, value: f(l.value), unit: a.unit, ref: [a.refLow, a.refHigh], status: statusStr(a) }; });
  if (name === 'get_marker_history') {
    const q = String(input?.label ?? '').toLowerCase();
    const m = store.analytes.find(a => a.label.toLowerCase() === q) ?? store.analytes.find(a => a.label.toLowerCase().includes(q));
    if (!m) return { error: `no marker matching "${input?.label}"` };
    return { label: m.label, unit: m.unit, ref: [m.refLow, m.refHigh], history: m.series.map(p => `${p.date}:${f(p.value)}`), text: m.textSeries?.map(t => `${t.date}:${t.text}`) };
  }
  return { error: `unknown tool ${name}` };
}

function targetPrompt(target: LabAnalyte): string {
  const ref = target.refLow != null || target.refHigh != null ? `ref ${target.refLow ?? '—'}–${target.refHigh ?? '—'} ${target.unit}` : 'no reference range';
  const hist = target.series.map(p => `${p.date}:${f(p.value)}`).join(', ') || '(no numeric history)';
  return `Analyse my "${target.label}" (panel: ${target.category}), unit ${target.unit || '—'}, ${ref}.\n` +
    `History oldest→newest: ${hist}.\n\n` +
    `Pull any related markers you need with the tools, then give: (1) what this marker is, (2) how MY value and ` +
    `trend look over the years, (3) anything notable vs the reference range, (4) related markers read together, ` +
    `(5) what to discuss with my GP. Under 300 words, short paragraphs or bullets.`;
}

async function runAgentic(target: LabAnalyte, store: LabStore): Promise<string> {
  const messages: any[] = [{ role: 'user', content: targetPrompt(target) }];
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await callLLMTools({ system: SYSTEM, messages, tools: toolSchemas, maxTokens: MAX_TOKENS, temperature: 0.3 });
    if (res.stopReason !== 'tool_use') return res.text;
    messages.push({ role: 'assistant', content: res.content });
    const uses = res.content.filter((b: any) => b.type === 'tool_use');
    const results = uses.map((u: any) => {
      let out: any; try { out = runTool(u.name, u.input ?? {}, store); } catch (e: any) { out = { error: e?.message ?? 'tool failed' }; }
      return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, 6000) };
    });
    messages.push({ role: 'user', content: results });
  }
  const final = await callLLMTools({ system: SYSTEM, messages, tools: [], maxTokens: MAX_TOKENS, temperature: 0.3 });
  return final.text || 'Pulled the data but ran out of steps to synthesise — try again.';
}

// Single-shot fallback (providers without tool support) — hand it a rich fixed context.
async function runSingleShot(target: LabAnalyte, store: LabStore): Promise<string> {
  const sameCat = store.analytes.filter(a => a.category === target.category && a.key !== target.key && a.series.length)
    .map(a => { const l = latestOf(a)!; return `${a.label} ${f(l.value)} ${a.unit} (${l.date})`; }).join('; ') || 'none';
  const oob = store.analytes.filter(isOob).map(a => { const l = latestOf(a)!; return `${a.label} ${f(l.value)} ${a.unit} [ref ${a.refLow ?? '—'}–${a.refHigh ?? '—'}]`; }).join('; ') || 'none';
  const user = targetPrompt(target) + `\n\nSame-panel latest: ${sameCat}.\nAll out-of-range markers: ${oob}.`;
  return callLLM({ system: SYSTEM, messages: [{ role: 'user', content: user }], maxTokens: MAX_TOKENS, temperature: 0.3 });
}

export async function analyseLab(target: LabAnalyte, store: LabStore): Promise<string> {
  try { if (await agenticSupported()) return await runAgentic(target, store); }
  catch (e: any) { if (!/AGENTIC_UNSUPPORTED/.test(e?.message ?? '')) throw e; }   // real errors surface; unsupported → fall back
  return runSingleShot(target, store);
}
