// AI read of a single lab marker in the context of its own history + the rest of the panel.
// Non-diagnostic by construction (system prompt + enforced disclaimer). One call for now; the context is
// pre-assembled here so the model doesn't need round-trips, but it's structured to add tool round-trips later.
import { callLLM } from './llm';
import { LabAnalyte } from './labs';
import { LabStore } from './labsStore';

const f = (v: number) => Number(v.toPrecision(4));
const latestOf = (a: LabAnalyte) => a.series[a.series.length - 1];
const isOob = (a: LabAnalyte) => {
  const l = latestOf(a); if (!l) return false;
  return (a.refLow != null && l.value < a.refLow) || (a.refHigh != null && l.value > a.refHigh);
};

export async function analyseLab(target: LabAnalyte, store: LabStore): Promise<string> {
  const ref = target.refLow != null || target.refHigh != null
    ? `reference ${target.refLow ?? '—'}–${target.refHigh ?? '—'} ${target.unit}` : 'no reference range on file';
  const hist = target.series.map(p => `${p.date}: ${f(p.value)}`).join(', ') || '(no numeric history)';

  const sameCat = store.analytes.filter(a => a.category === target.category && a.key !== target.key && a.series.length);
  const related = sameCat.map(a => { const l = latestOf(a); return l ? `${a.label} ${f(l.value)} ${a.unit} (${l.date})` : ''; })
    .filter(Boolean).join('; ') || 'none';
  const oob = store.analytes.filter(isOob).map(a => { const l = latestOf(a)!;
    return `${a.label} ${f(l.value)} ${a.unit} [ref ${a.refLow ?? '—'}–${a.refHigh ?? '—'}]`; }).join('; ') || 'none';

  const system =
    'You are a careful health-data assistant helping an athlete read their OWN long-term blood-test history. ' +
    'Be concise, concrete and educational. Explain what the marker is, read the multi-year TREND, and flag values ' +
    'outside the reference range. Where relevant, connect related markers into a picture (iron panel, lipid/cardio ' +
    'risk, thyroid set, liver, glucose/insulin). You are NOT a physician: give context and "worth raising with your ' +
    'GP" pointers, never a diagnosis, medication, or dosing advice. Finish with a one-line non-diagnostic disclaimer.';
  const user =
    `Marker: ${target.label} (panel: ${target.category}), unit ${target.unit || '—'}, ${ref}.\n` +
    `My full history, oldest→newest: ${hist}.\n\n` +
    `Latest values of other markers in the same panel: ${related}.\n\n` +
    `All of my currently out-of-range markers: ${oob}.\n\n` +
    `Give me: (1) what this marker is, (2) how MY value and trend look over the years, (3) anything notable versus ` +
    `the reference range, (4) related markers worth reading together, (5) what to discuss with my GP. ` +
    `Keep under 220 words, short paragraphs or bullets.`;

  return callLLM({ system, messages: [{ role: 'user', content: user }], maxTokens: 700, temperature: 0.3 });
}
