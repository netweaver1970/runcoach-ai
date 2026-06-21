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
  // Time-on-feet (running minutes) — drives the alternation + rolling-volume rules.
  recentTimeOnFeet?: { date: string; min: number }[]; // last ~14 days (0 = no run)
  tof7d?:            number;   // trailing 7-day running minutes (completed days only)
  tofPrev7d?:        number;   // the 7 days before that
  tofBudgetTodayMin?: number;  // max running minutes TODAY under the +10% rolling cap
  yesterdayTofMin?:  number;   // yesterday's running minutes
  yesterdayStrain?:  number;   // yesterday's strain score
}

export type CoachIntensity = 'rest' | 'easy' | 'moderate' | 'hard';

export interface CoachPlan {
  headline:   string;        // one-line readiness verdict
  session:    string;        // the recommended session
  strength:   string;        // leg-strength / injury-prevention prescription
  intensity:  CoachIntensity;
  runMinutes: number;        // prescribed running time-on-feet (≤ rolling cap)
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
- NEVER schedule sequential longer / quality sessions. Alternate strictly: Quality → Recovery → Quality. If the \
previous 1–2 days were a quality, hard, or long run, today MUST be a genuine recovery day (short + easy) or rest — \
never a second longer or higher-volume run back-to-back. Use yesterdayStrain / yesterdayTofMin and recentTimeOnFeet \
to judge this.
- Recovery days stay SHORT and easy. Do not let an easy day creep into a longer Z2 run — a recovery run is brief and \
relaxed, clearly shorter than the surrounding quality days.
- HARD VOLUME CAP (do not violate): 7-day rolling time-on-feet must not increase more than 10% week-over-week. \
Today's running minutes must NOT exceed tofBudgetTodayMin (provided). If tofBudgetTodayMin is ~0, prescribe rest or \
cross-training/strength only. Never exceed this cap to chase a session.
- ALWAYS include leg-strength / injury-prevention work in EVERY plan (even rest days → light mobility + activation). \
Name 2–4 specific exercises with rough sets×reps from: eccentric calf raises / heel drops, single-leg squats, \
step-downs, glute bridges, clamshells, hip abduction, tibialis raises, hamstring curls/bridges, Copenhagen planks.
- ACWR sweet spot 0.8–1.3; >1.4 is a spike → pull right back. Negative TSB = fatigue → easy/recovery only. \
HRV below baseline, elevated resting/respiratory rate, low SpO₂, or sleep debt → reduce load and watch for illness; \
never stack hard days on suppressed parasympathetic signals. Keep ≥48h between any hard efforts.
- "strain" is a 0–100 daily-load score (this app's scale). Recommend a CONSERVATIVE strainLow–strainHigh target; \
prefer the lower half of the advisable band on any doubt.

Produce the runner's DAILY OUTLOOK as the OUTCOME of these rules applied to all the data. State today's run \
minutes and how they sit against the rolling-7-day cap. Return ONLY minified JSON, no markdown, with EXACTLY these keys: \
{"headline":string,"session":string,"strength":string,"intensity":"rest"|"easy"|"moderate"|"hard","runMinutes":number,"strainLow":number,"strainHigh":number,"rationale":string,"cautions":string}. \
headline ≤ 12 words (the outlook); session ≤ 50 words (type, run minutes, how it respects the cap & alternation); \
runMinutes = prescribed running time-on-feet (≤ tofBudgetTodayMin); strength ≤ 40 words; rationale ≤ 45 words \
(must reference the cap and alternation); cautions ≤ 25 words ("" if none).`;

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
    runMinutes: Math.max(0, Math.min(
      snap.tofBudgetTodayMin ?? 999,
      Math.round(Number(o.runMinutes)) || 0,
    )),
    strainLow:  clampScore(o.strainLow, snap.advisableLow ?? 30),
    strainHigh: clampScore(o.strainHigh, snap.advisableHigh ?? 60),
    rationale:  String(o.rationale ?? '').slice(0, 400),
    cautions:   o.cautions ? String(o.cautions).slice(0, 200) : undefined,
    generatedAt: new Date().toISOString(),
  };
}

export interface TofPlan {
  series14:       { date: string; min: number }[];
  tof7d:          number;   // rolling 7-day total ending today (today so far)
  tofPrev7d:      number;   // the 7 days before that
  cap7dMin:       number;   // 1.10 × prior-7 (the rolling ceiling)
  budgetTodayMin: number;   // running minutes still allowed today
  yesterdayMin:   number;
}

/**
 * Rolling time-on-feet model for the +10% rule: the 7-day total ending today must not
 * exceed 1.10× the 7-day total ending a week ago. Returns today's remaining running
 * budget plus a 14-day series for the alternation check. A small floor keeps a short
 * easy run available when returning from a near-zero base.
 */
export function computeTimeOnFeetPlan(
  daily: { date: string; value: number }[], today = new Date(),
): TofPlan {
  const map = new Map(daily.map(d => [d.date, d.value]));
  const p = (n: number) => String(n).padStart(2, '0');
  const dayStr = (offset: number) => {
    const d = new Date(today); d.setDate(d.getDate() - offset);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const minsAt = (offset: number) => map.get(dayStr(offset)) ?? 0;

  let tofLast6 = 0; for (let o = 1; o <= 6;  o++) tofLast6 += minsAt(o);
  let tofPrev7 = 0; for (let o = 7; o <= 13; o++) tofPrev7 += minsAt(o);
  const cap = Math.round(1.10 * tofPrev7);
  let budget = Math.max(0, cap - tofLast6);
  if (tofPrev7 < 30) budget = Math.max(budget, 20); // re-entry / very low base

  const series14: { date: string; min: number }[] = [];
  for (let o = 13; o >= 0; o--) series14.push({ date: dayStr(o), min: minsAt(o) });

  return {
    series14,
    tof7d: tofLast6 + minsAt(0),
    tofPrev7d: tofPrev7,
    cap7dMin: cap,
    budgetTodayMin: budget,
    yesterdayMin: minsAt(1),
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
