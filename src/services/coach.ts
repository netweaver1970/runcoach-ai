/**
 * LLM training coach. Feeds the FULL daily picture — recovery, HRV/RHR vs baseline,
 * respiration, SpO₂, sleep & sleep debt, and the training-load history (CTL/ATL/TSB,
 * ACWR, recent strain) — to the configured model and asks for a session
 * recommendation grounded in current endurance-training science. Returns structured
 * JSON so the UI can render it and reconcile the advisable strain band.
 */
import * as FileSystem from 'expo-file-system';
import { callLLM } from './llm';

export interface CoachSnapshot {
  date:          string;
  recovery?:     number;   recoveryLabel?: string;
  hrv?:          number;   hrvBaseline?:   number;
  rhr?:          number;   rhrBaseline?:   number;
  respRate?:     number;   spO2?:          number;
  sleepScore?:   number;   sleepMin?:      number;   sleepDebtMin?: number;
  ctl?:          number;   atl?:           number;   tsb?: number;   acwr?: number;
  strainReal?:   number;   advisableLow?:  number;   advisableHigh?: number;
  readiness?:    number;   drivers?:       string[];
  recentStrain?: number[];                 // last ~10 days, oldest→newest
  recentRuns?:   { date: string; km: number; type: string }[];
}

export type CoachIntensity = 'rest' | 'easy' | 'moderate' | 'hard';

export interface CoachPlan {
  headline:   string;        // one-line readiness verdict
  session:    string;        // the recommended (run/walk) session
  strength:   string;        // leg-strength / injury-prevention prescription
  intensity:  CoachIntensity;
  strainLow:  number;
  strainHigh: number;
  rationale:  string;
  cautions?:  string;
  generatedAt: string;
}

const SYSTEM = `You are a STRICT, injury-prevention-FIRST endurance-running coach for a data-literate runner. \
Your prime directive is to keep the athlete healthy and uninjured. When signals are borderline or conflict, \
ALWAYS choose the more conservative option — less intensity, less volume, lower strain. You receive a JSON \
snapshot of today's physiology and training load.

Readiness is multi-factor, not recovery alone: weigh HRV vs baseline, resting HR vs baseline, respiratory rate, \
SpO₂, sleep quality + sleep debt, form (TSB) and the acute:chronic workload ratio (ACWR).

NON-NEGOTIABLE RULES:
- Stay on the cautious side. Default to easy. Only allow hard/moderate when ALL signals are clearly green.
- NO long continuous running. NEVER prescribe a single uninterrupted run. Break running into short intervals with \
walk/recovery breaks (e.g. run ≤12–18 min then walk 2–3 min, or shorter run-walk reps). Cap continuous run blocks; \
favour run-walk and splitting volume across the session. State the run/walk structure explicitly.
- ALWAYS include leg-strength / injury-prevention work in EVERY plan (even rest days → light mobility + activation). \
Name 2–4 specific exercises with rough sets×reps from: eccentric calf raises / heel drops, single-leg squats, \
step-downs, glute bridges, clamshells, hip abduction, tibialis raises, hamstring curls/bridges, Copenhagen planks.
- ACWR sweet spot 0.8–1.3; >1.4 is a spike → pull right back. Negative TSB = fatigue → easy/recovery only. \
HRV below baseline, elevated resting/respiratory rate, low SpO₂, or sleep debt → reduce load and watch for illness; \
never stack hard days on suppressed parasympathetic signals. Keep ≥48h between any hard efforts.
- "strain" is a 0–100 daily-load score (this app's scale). Recommend a CONSERVATIVE strainLow–strainHigh target; \
prefer the lower half of the advisable band on any doubt.

Return ONLY minified JSON, no markdown, with EXACTLY these keys: \
{"headline":string,"session":string,"strength":string,"intensity":"rest"|"easy"|"moderate"|"hard","strainLow":number,"strainHigh":number,"rationale":string,"cautions":string}. \
headline ≤ 12 words; session ≤ 50 words (must include run/walk structure); strength ≤ 40 words (specific exercises); \
rationale ≤ 45 words; cautions ≤ 25 words ("" if none).`;

function clampScore(n: any, fallback: number): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : fallback;
}

export async function getCoachPlan(snap: CoachSnapshot): Promise<CoachPlan> {
  const txt = await callLLM({
    system: SYSTEM,
    messages: [{ role: 'user', content: JSON.stringify(snap) }],
    maxTokens: 600,
  });
  const match = txt.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Coach response was not JSON.');
  const o = JSON.parse(match[0]);
  const intensity: CoachIntensity =
    ['rest', 'easy', 'moderate', 'hard'].includes(o.intensity) ? o.intensity : 'easy';
  return {
    headline:   String(o.headline ?? 'Plan ready').slice(0, 120),
    session:    String(o.session ?? '').slice(0, 280),
    strength:   String(o.strength ?? '').slice(0, 240),
    intensity,
    strainLow:  clampScore(o.strainLow, snap.advisableLow ?? 30),
    strainHigh: clampScore(o.strainHigh, snap.advisableHigh ?? 60),
    rationale:  String(o.rationale ?? '').slice(0, 400),
    cautions:   o.cautions ? String(o.cautions).slice(0, 200) : undefined,
    generatedAt: new Date().toISOString(),
  };
}

// Cache one plan per calendar day (never serve a previous day's plan).
const planFile = (date: string) => `${FileSystem.documentDirectory}coach-plan-${date}.json`;

export async function loadCachedPlan(date: string): Promise<CoachPlan | null> {
  try {
    const f = planFile(date);
    const info = await FileSystem.getInfoAsync(f);
    if (!info.exists) return null;
    return JSON.parse(await FileSystem.readAsStringAsync(f)) as CoachPlan;
  } catch { return null; }
}

export async function saveCachedPlan(date: string, plan: CoachPlan): Promise<void> {
  try { await FileSystem.writeAsStringAsync(planFile(date), JSON.stringify(plan)); } catch { /* ignore */ }
}
