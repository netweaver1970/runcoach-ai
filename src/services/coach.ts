/**
 * LLM training coach. Feeds the FULL daily picture — recovery, HRV/RHR vs baseline,
 * respiration, SpO₂, sleep & sleep debt, and the training-load history (CTL/ATL/TSB,
 * ACWR, recent strain) — to the configured model and asks for a session
 * recommendation grounded in current endurance-training science. Returns structured
 * JSON so the UI can render it and reconcile the advisable strain band.
 */
import * as FileSystem from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { callLLM } from './llm';
import { buildKnowledgePrompt } from './coachFiles';
import { fetchOurDailyComponents, fetchDailyDurationHistory, fetchDailyWorkDistanceHistory } from './healthkit';
import { getLocalWeather } from './weather';
import { getPowerZones } from './claude';
import { ensureZonesFile } from './zones';
import { activityCategory, heatStrainFactor } from './trainingLoad';
import { DayStrain, ActivitySummary } from '../types';

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
  tofBudgetTodayMin?: number;  // max running MINUTES today under the rolling cap (distance cap → via pace)
  tofNextRunLabel?:  string;   // when a meaningful-length run next fits the cap, e.g. "Thu 26 Jun"
  tofNextRunInDays?: number;   // days until that — 0 = today's budget already allows it
  loadCapBasis?:     'tof' | 'distance'; // what the +X% cap is measured on
  loadCapPct?:       number;   // the rolling increase cap % (default 10)
  loadBudgetToday?:  number;   // remaining budget today in loadUnit
  loadUnit?:         'min' | 'km';
  yesterdayTofMin?:  number;   // yesterday's running minutes
  yesterdayStrain?:  number;   // yesterday's strain score
  weather?: {                  // current conditions — heat/humidity raise strain
    tempC: number; apparentC: number; humidity: number; windKmh: number;
    description: string; place?: string;
  };
  // Running-power zones (watts) so the watch workout can target POWER, not pace.
  powerZones?: { recoveryMax: number; z2Max: number; tempoMin: number; tempoMax: number; intervalsMin: number };
  // Recent NON-run training (dance/walk/cardio/strength) — no zones/structure, but real
  // fatigue/load the coach should weigh alongside the runs.
  recentActivities?: { date: string; name: string; durationMin: number; avgHR?: number }[];
}

export type CoachIntensity = 'rest' | 'easy' | 'moderate' | 'hard';

// A structured running workout for the Apple Watch (WorkoutKit): warmup → drills →
// work/recovery blocks → cooldown. Null on rest days (no watch workout pushed).
export interface WatchWorkoutBlock {
  repeats:     number;          // how many work+recovery reps
  workMinutes: number;          // work-interval duration
  restMinutes: number;          // recovery duration (0 = continuous)
  hrZone?:     string;          // driving HR zone: Z1–Z5
  powerLowWatts?:  number;      // power window mapped from the HR zone (lower bound, watts)
  powerHighWatts?: number;      // upper bound, watts
  label?:      string;          // e.g. "tempo", "VO2"
}
export interface WatchWorkout {
  name:          string;        // weekday slot, e.g. "Mon" — overwrites that day's workout
  warmupMeters:  number;        // always 600
  drillsMinutes: number;        // small drills block after warmup (0 to skip)
  blocks:        WatchWorkoutBlock[];
  cooldownMeters: number;       // always 600
}

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
  workout?:   WatchWorkout | null; // structured watch workout (null = rest, no push)
  nextRunLabel?:  string;    // set ONLY when the volume cap blocks a run today — e.g. "Thu 26 Jun"
  nextRunInDays?: number;    // days until that meaningful run (>0 implies capped today)
  generatedAt: string;
  genTempC?:  number;        // apparent temp (°C) when generated — for staleness checks
  genStrain?: number;        // the day's accumulated strain when generated
}

// A cached plan goes stale when the day's conditions drift from when it was written:
// the apparent temperature (heat changes the strain a session causes) or the strain
// already accumulated today (which moves the remaining advisable budget).
const TEMP_DRIFT_C = 4;
const STRAIN_DRIFT = 10;
export function planNeedsRefresh(plan: CoachPlan, snap: CoachSnapshot): boolean {
  const nowTemp = snap.weather?.apparentC ?? snap.weather?.tempC;
  // A plan from before conditions-tracking has no genTempC — refresh it once so it
  // picks up the current weather (and gets stamped for future drift checks).
  if (nowTemp != null && plan.genTempC == null) return true;
  if (plan.genTempC != null && nowTemp != null && Math.abs(nowTemp - plan.genTempC) >= TEMP_DRIFT_C) return true;
  if (plan.genStrain != null && snap.strainReal != null && Math.abs(snap.strainReal - plan.genStrain) >= STRAIN_DRIFT) return true;
  return false;
}


// The detailed rules now live in editable knowledge files (coachFiles.ts). The wrapper
// keeps only the role framing and the (non-editable) output contract so a user edit
// can't break JSON parsing.
const ROLE = `You are a running coach. The COACHING KNOWLEDGE below is AUTHORITATIVE — \
follow every rule in it. You receive a JSON snapshot of today's physiology, training load, time-on-feet \
and weather. OTHER TRAINING: recentActivities lists recent NON-run sessions (dance, walk, cardio/HIIT, \
strength). They carry no running structure or power zones, but they add real fatigue and already count in \
today's strain — factor them in (e.g. tired legs after a long dance session → ease the run). Today's strain TARGET is fixed and provided as advisableLow–advisableHigh — treat that as THE \
target; do NOT invent a different band. RUN LENGTH: when readiness is decent (≥55) and there is budget \
(tofBudgetTodayMin not near 0), prescribe runMinutes so the day's TOTAL strain (existing strainReal + the \
run + drills) reaches the MIDDLE-to-UPPER of the band — do NOT prescribe a token short run that only clears \
the floor while leaving most of tofBudgetTodayMin unused. EASY minutes add little strain each, so an easy \
session that reaches the band usually means a LONGER run (e.g. 35–50 min), not a 20–25 min one. Only go short \
when recovery is poor, ACWR is high, or the budget is genuinely small. HEAT: heatStrainFactor says a given effort costs that MULTIPLE of its \
normal strain today (heat + humidity). The target band is temperature-independent, so to keep run+drills within \
it you MUST scale the session DOWN by heatStrainFactor — cut running minutes to roughly runMinutes ÷ \
heatStrainFactor (and/or drop a notch in intensity). Make the cut explicit in the rationale (e.g. "28°C, \
factor 1.20 → 25→21 min"). Prescribe a session whose total strain (run + drills × heatStrainFactor) lands within \
the band, never more than 10% over the ceiling. In the rationale, ALWAYS state where \
today's actual strain (strainReal) sits relative to the target band — BELOW / WITHIN / ABOVE — and why that \
is appropriate for your call (e.g. "strain 7% is below the 23–47% band, which is right given low recovery — \
rest"). Use the exact strainReal figure; never invent a different number. SpO₂ note: brief overnight dips to \
~92–95% are normal and must NOT reduce load on their own — only treat SpO₂ as a concern if it is below ~92%. \
VOLUME CAP: the progression cap is +loadCapPct% per rolling 7 days, measured on loadCapBasis \
("tof" = time-on-feet minutes, "distance" = real-work km); loadBudgetToday is what's left today in \
loadUnit, and tofBudgetTodayMin is that same budget expressed in run-minutes (already pace-converted \
for a distance cap) — keep the prescribed run ≤ tofBudgetTodayMin. When tofBudgetTodayMin is ~0 (cap \
reached) and you therefore prescribe rest/cross-train, you MUST tell the runner WHEN the next meaningful \
run becomes possible — state the exact tofNextRunLabel in the session (it has the weekday; assuming rest \
until then, tofNextRunInDays days out). E.g. session "Volume cap reached — rest; next run Thu 26 Jun, in \
2 days". If tofNextRunInDays is 0 the cap is not limiting, so omit this. \
Produce the runner's DAILY OUTLOOK as the OUTCOME of the rules applied to all the data.

WATCH WORKOUT: if you prescribe a RUN (intensity easy/moderate/hard, not rest), also design a structured \
"workout" object for the Apple Watch that pushes today's strain to the UPPER end of the target band \
(near strainHigh): a 600m warmup, a short drills block (drillsMinutes, ~3–5 min, 0 to skip), one or more \
work blocks (reps × workMinutes, with restMinutes recovery), and a 600m cooldown. Choose reps/durations so total \
running stays ≤ tofBudgetTodayMin yet reaches the upper band. The HR ZONE + duration + structure are the DRIVING \
facts: set each block's hrZone (Z1–Z5) and the matching powerLowWatts/powerHighWatts by reading them straight \
from the "Power & HR Zones" table in the COACHING KNOWLEDGE above (that table is calibrated from real runs — use \
its watt ranges, do not invent them). If no zones table is present, omit power. If intensity is "rest", set \
workout to null (no watch workout).`;

const OUTPUT = `Return ONLY minified JSON, no markdown, with EXACTLY these keys: \
{"headline":string,"session":string,"strength":string,"intensity":"rest"|"easy"|"moderate"|"hard","runMinutes":number,"rationale":string,"cautions":string,\
"workout":null OR {"warmupMeters":600,"drillsMinutes":number,"blocks":[{"repeats":number,"workMinutes":number,"restMinutes":number,"hrZone":"Z1".."Z5","powerLowWatts":number,"powerHighWatts":number,"label":string}],"cooldownMeters":600}}. \
Be concise and skimmable — no filler. headline ≤ 7 words (the outlook); session ≤ 25 words \
(type, run minutes, run/walk or alternation if relevant); runMinutes = prescribed running time-on-feet \
(≤ tofBudgetTodayMin); strength ≤ 22 words (just the named exercises × sets/reps); rationale ≤ 22 words \
(the 1–2 signals that drove it); cautions ≤ 12 words ("" if none). workout = null when intensity is rest.`;

function clampScore(n: any, fallback: number): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : fallback;
}

const num = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : undefined; };

// Short weekday slot name for the day (e.g. "Mon") — workouts are grouped/overwritten by it.
function weekdayName(dateKey?: string): string {
  const d = dateKey ? new Date(dateKey + 'T00:00:00') : new Date();
  return d.toLocaleDateString('en-US', { weekday: 'short' });
}

// Validate/clamp the LLM's workout into a safe WatchWorkout (or null on rest/garbage).
function parseWorkout(o: any, intensity: CoachIntensity, name: string): WatchWorkout | null {
  if (intensity === 'rest' || !o || typeof o !== 'object') return null;
  const rawBlocks = Array.isArray(o.blocks) ? o.blocks : [];
  const watts = (v: any) => { const n = num(v); return n != null ? Math.max(50, Math.min(700, Math.round(n))) : undefined; };
  const blocks: WatchWorkoutBlock[] = rawBlocks.slice(0, 8).map((b: any) => ({
    repeats:     Math.max(1, Math.min(30, Math.round(num(b?.repeats) ?? 1))),
    workMinutes: Math.max(0.5, Math.min(120, num(b?.workMinutes) ?? 5)),
    restMinutes: Math.max(0, Math.min(30, num(b?.restMinutes) ?? 0)),
    hrZone: typeof b?.hrZone === 'string' && /^Z[1-5]$/.test(b.hrZone) ? b.hrZone : undefined,
    powerLowWatts:  watts(b?.powerLowWatts),
    powerHighWatts: watts(b?.powerHighWatts),
    label: b?.label ? String(b.label).slice(0, 40) : undefined,
  })).filter((b: WatchWorkoutBlock) => b.workMinutes > 0);
  if (blocks.length === 0) return null;
  return {
    name,
    warmupMeters:  600,
    drillsMinutes: Math.max(0, Math.min(20, num(o.drillsMinutes) ?? 4)),
    blocks,
    cooldownMeters: 600,
  };
}

// Map an HR zone (Z1–Z5) to its watt window from the athlete's power zones.
function zoneToWatts(zone: string | undefined, pz?: CoachSnapshot['powerZones']): [number?, number?] {
  if (!pz || !zone) return [undefined, undefined];
  switch (zone) {
    case 'Z1': return [Math.round(pz.recoveryMax * 0.7), pz.recoveryMax];
    case 'Z2': return [pz.recoveryMax, pz.z2Max];
    case 'Z3': return [pz.tempoMin, pz.tempoMax];
    case 'Z4': return [pz.tempoMax, pz.intervalsMin];
    case 'Z5': return [pz.intervalsMin, pz.intervalsMin + 60];
    default:   return [undefined, undefined];
  }
}

// Guarantee every work block carries a power window so the watch can give in-band cues.
// Fills missing watts from the block's HR zone (defaulting to Z2) using the power zones.
function ensureBlockPower(w: WatchWorkout | null, pz?: CoachSnapshot['powerZones']): WatchWorkout | null {
  if (!w) return w;
  w.blocks = w.blocks.map(b => {
    if (b.powerLowWatts && b.powerHighWatts) return b;
    const [lo, hi] = zoneToWatts(b.hrZone ?? 'Z2', pz);
    return { ...b, powerLowWatts: b.powerLowWatts ?? lo, powerHighWatts: b.powerHighWatts ?? hi };
  });
  return w;
}

// Fallback structured session when the LLM prescribes a run but omits the workout JSON.
// Maps the intensity to an HR zone + the matching watt window from the athlete's zones.
export function synthesizeWorkout(
  intensity: CoachIntensity, runMinutes: number, name: string,
  pz?: CoachSnapshot['powerZones'],
): WatchWorkout {
  // Reserve ~6 min for the 600m warm-up + 600m cool-down; the rest is work.
  const workBudget = Math.max(8, (runMinutes || 35) - 6);
  let blocks: WatchWorkoutBlock[];
  if (intensity === 'easy') {
    blocks = [{ repeats: 1, workMinutes: Math.min(90, workBudget), restMinutes: 0, hrZone: 'Z2', label: 'aerobic' }];
  } else if (intensity === 'hard') {
    const reps = Math.max(4, Math.min(8, Math.round(workBudget / 5)));
    blocks = [{ repeats: reps, workMinutes: 3, restMinutes: 2, hrZone: 'Z4', label: 'threshold' }];
  } else { // moderate
    const reps = Math.max(3, Math.min(6, Math.round(workBudget / 7)));
    blocks = [{ repeats: reps, workMinutes: 5, restMinutes: 2, hrZone: 'Z3', label: 'tempo' }];
  }
  return ensureBlockPower({ name, warmupMeters: 600, drillsMinutes: 4, blocks, cooldownMeters: 600 }, pz)!;
}

// Concise one-line structure for the daily plan, e.g. "3× 10min @ 180–205W" or "60min @ 205W".
// Work blocks only (warm-up/cool-down are implied); power range if present, else HR zone.
export function formatWorkoutStructure(w?: WatchWorkout | null): string {
  if (!w?.blocks?.length) return '';
  const fmtMin = (m: number) => (m % 1 === 0 ? `${m}` : m.toFixed(1));
  const parts = w.blocks.map((b) => {
    const lo = b.powerLowWatts, hi = b.powerHighWatts;
    const pwr = lo && hi ? (lo === hi ? ` @ ${lo}W` : ` @ ${lo}–${hi}W`)
              : b.hrZone ? ` @ ${b.hrZone}` : '';
    const rep = b.repeats > 1 ? `${b.repeats}× ${fmtMin(b.workMinutes)}min` : `${fmtMin(b.workMinutes)}min`;
    return `${rep}${pwr}`;
  });
  return parts.join(' + ');
}

export async function getCoachPlan(snap: CoachSnapshot): Promise<CoachPlan> {
  await ensureZonesFile().catch(() => {}); // seed the Power & HR Zones file into the knowledge
  const knowledge = await buildKnowledgePrompt();
  const system = `${ROLE}\n\n===== COACHING KNOWLEDGE =====\n${knowledge}\n===== END COACHING KNOWLEDGE =====\n\n${OUTPUT}`;
  const heatFactor = heatStrainFactor(snap.weather);
  // Heat shrinks the achievable running time for the same strain — cap the budget by it.
  const heatBudget = snap.tofBudgetTodayMin != null ? Math.round(snap.tofBudgetTodayMin / heatFactor) : undefined;
  const txt = await callLLM({
    system,
    messages: [{ role: 'user', content: JSON.stringify({ ...snap, heatStrainFactor: heatFactor, tofBudgetTodayMin: heatBudget ?? snap.tofBudgetTodayMin }) }],
    maxTokens: 1200,
  });
  const match = txt.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Coach response was not JSON.');
  const o = JSON.parse(match[0]);
  const intensity: CoachIntensity =
    ['rest', 'easy', 'moderate', 'hard'].includes(o.intensity) ? o.intensity : 'easy';
  const runMinutes = Math.max(0, Math.min(
    heatBudget ?? snap.tofBudgetTodayMin ?? 999,    // heat-adjusted running cap
    Math.round(Number(o.runMinutes)) || 0,
  ));
  // The LLM should design the workout; if it omitted one on a run day, synthesize a
  // sensible structured session from the intensity + zones so the watch always has one.
  const wkName = weekdayName(snap.date);
  const workout = ensureBlockPower(
    parseWorkout(o.workout, intensity, wkName)
      ?? (intensity !== 'rest' ? synthesizeWorkout(intensity, runMinutes, wkName, snap.powerZones) : null),
    snap.powerZones,
  );
  return {
    headline:   String(o.headline ?? 'Plan ready').slice(0, 120),
    session:    String(o.session ?? '').slice(0, 280),
    strength:   String(o.strength ?? '').slice(0, 240),
    intensity,
    runMinutes,
    // Target is the single advisable band (synced with the home ring) — not the LLM's own.
    strainLow:  clampScore(snap.advisableLow, 30),
    strainHigh: clampScore(snap.advisableHigh, 60),
    rationale:  String(o.rationale ?? '').slice(0, 400),
    cautions:   o.cautions ? String(o.cautions).slice(0, 200) : undefined,
    workout,
    // Deterministic (not LLM): only surface when the +10% cap actually blocks a run today.
    nextRunLabel:  (snap.tofNextRunInDays ?? 0) > 0 ? snap.tofNextRunLabel : undefined,
    nextRunInDays: snap.tofNextRunInDays,
    generatedAt: new Date().toISOString(),
    genTempC:  snap.weather?.apparentC ?? snap.weather?.tempC,
    genStrain: snap.strainReal,
  };
}

// ── Progression-cap settings (user-configurable) ──────────────────────────────
// The rolling-7-day increase cap. Default +10%/week (the classic guideline), but a returning-from-
// injury athlete may want to ramp faster (e.g. 20%). And the cap can be measured by TIME-ON-FEET
// (default) or by real-work DISTANCE — some athletes prefer a distance ceiling.
export type LoadCapBasis = 'tof' | 'distance';
const LOAD_CAP_PCT_KEY   = 'load_cap_pct';
const LOAD_CAP_BASIS_KEY = 'load_cap_basis';
export const DEFAULT_LOAD_CAP_PCT = 10;
export const DEFAULT_LOAD_CAP_BASIS: LoadCapBasis = 'tof';

export async function getLoadCapPct(): Promise<number> {
  try {
    const raw = await SecureStore.getItemAsync(LOAD_CAP_PCT_KEY);
    const n = raw ? parseInt(raw, 10) : DEFAULT_LOAD_CAP_PCT;
    return Number.isFinite(n) && n >= 5 && n <= 50 ? n : DEFAULT_LOAD_CAP_PCT; // 5–50% sane bounds
  } catch { return DEFAULT_LOAD_CAP_PCT; }
}
export async function setLoadCapPct(pct: number): Promise<void> {
  try { await SecureStore.setItemAsync(LOAD_CAP_PCT_KEY, String(Math.round(pct))); } catch { /* ignore */ }
}
export async function getLoadCapBasis(): Promise<LoadCapBasis> {
  try { return (await SecureStore.getItemAsync(LOAD_CAP_BASIS_KEY)) === 'distance' ? 'distance' : 'tof'; }
  catch { return DEFAULT_LOAD_CAP_BASIS; }
}
export async function setLoadCapBasis(b: LoadCapBasis): Promise<void> {
  try { await SecureStore.setItemAsync(LOAD_CAP_BASIS_KEY, b); } catch { /* ignore */ }
}

export interface TofPlan {
  series14:       { date: string; min: number }[];
  tof7d:          number;   // rolling 7-day total ending today (today so far)
  tofPrev7d:      number;   // the 7 days before that
  cap7dMin:       number;   // (1+pct%) × prior-7 (the rolling ceiling)
  budgetTodayMin: number;   // load still allowed today (unit = the basis: minutes or km)
  yesterdayMin:   number;
  nextRunInDays:  number;   // days until a meaningful run fits — 0 = today
  nextRunDate:    string;   // YYYY-MM-DD of that day (assuming rest until then)
  nextRunLabel:   string;   // human label, e.g. "Thu 26 Jun" (weekday computed in code)
  nextRunBudgetMin: number; // budget available on nextRunDate
}

export interface CapOpts {
  capPct?:       number;  // rolling increase cap % (default 10)
  meaningful?:   number;  // a run "counts" once the budget allows ≥ this (min or km)
  reentryBelow?: number;  // prior-7 below this → apply the re-entry floor
  reentryFloor?: number;  // minimum budget when returning from a near-zero base
}

/**
 * Rolling progression model for the +X% rule: the 7-day total ending today must not exceed
 * (1+capPct%)× the 7-day total ending a week ago. Unit-agnostic — `daily.value` is minutes
 * (time-on-feet basis) or km (distance basis). Returns today's remaining budget + a 14-day series
 * for the alternation check + when a meaningful run next fits. A small floor keeps a short easy run
 * available when returning from a near-zero base.
 */
export function computeTimeOnFeetPlan(
  daily: { date: string; value: number }[], today = new Date(), opts: CapOpts = {},
): TofPlan {
  const capMult      = 1 + (opts.capPct ?? DEFAULT_LOAD_CAP_PCT) / 100;
  const meaningful   = opts.meaningful   ?? 20;
  const reentryBelow = opts.reentryBelow ?? 30;
  const reentryFloor = opts.reentryFloor ?? 20;
  const map = new Map(daily.map(d => [d.date, d.value]));
  const p = (n: number) => String(n).padStart(2, '0');
  const dayStr = (offset: number) => {
    const d = new Date(today); d.setDate(d.getDate() - offset);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const minsAt = (offset: number) => map.get(dayStr(offset)) ?? 0;

  let tofLast6 = 0; for (let o = 1; o <= 6;  o++) tofLast6 += minsAt(o);
  let tofPrev7 = 0; for (let o = 7; o <= 13; o++) tofPrev7 += minsAt(o);
  const cap = Math.round(capMult * tofPrev7);
  let budget = Math.max(0, cap - tofLast6);
  if (tofPrev7 < reentryBelow) budget = Math.max(budget, reentryFloor); // re-entry / very low base

  const series14: { date: string; min: number }[] = [];
  for (let o = 13; o >= 0; o--) series14.push({ date: dayStr(o), min: minsAt(o) });

  // Forward-project the rolling cap to find the earliest day a meaningful-length run fits again,
  // ASSUMING REST until then: each future rest day rolls an old high-volume day off the trailing
  // window, so the budget recovers. minIdx(i): past/today carry real minutes, future days = 0.
  const minIdx = (i: number) => (i <= 0 ? minsAt(-i) : 0);
  let nextRunInDays = 0, nextRunBudgetMin = budget;
  for (let k = 0; k <= 21; k++) {
    let last6 = 0; for (let j = 1; j <= 6;  j++) last6 += minIdx(k - j);
    let prev7 = 0; for (let j = 7; j <= 13; j++) prev7 += minIdx(k - j);
    let b = Math.max(0, Math.round(capMult * prev7) - last6);
    if (prev7 < reentryBelow) b = Math.max(b, reentryFloor); // re-entry / very low base
    if (b >= meaningful) { nextRunInDays = k; nextRunBudgetMin = b; break; }
  }
  const nextDate = new Date(today); nextDate.setDate(nextDate.getDate() + nextRunInDays);
  const nextRunDate = `${nextDate.getFullYear()}-${p(nextDate.getMonth() + 1)}-${p(nextDate.getDate())}`;
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const nextRunLabel = `${WD[nextDate.getDay()]} ${nextDate.getDate()} ${MO[nextDate.getMonth()]}`;

  return {
    series14,
    tof7d: tofLast6 + minsAt(0),
    tofPrev7d: tofPrev7,
    cap7dMin: cap,
    budgetTodayMin: budget,
    yesterdayMin: minsAt(1),
    nextRunInDays,
    nextRunDate,
    nextRunLabel,
    nextRunBudgetMin,
  };
}

export interface CapContext {
  tof: TofPlan;            // time-on-feet plan — always computed (alternation + run-minutes budget)
  cap: TofPlan;            // the ACTIVE-basis plan (=== tof when basis is 'tof')
  budgetMin: number;       // today's budget as run-MINUTES (distance cap → pace-converted)
  loadUnit: 'min' | 'km';
  capBasis: LoadCapBasis;
  capPct: number;
}

/**
 * The rolling progression cap, honouring the user's settings. Time-on-feet is ALWAYS computed (the
 * alternation rule + the watch-workout time budget need it); when the basis is DISTANCE the cap is
 * recomputed on real-work km and its budget converted back to run-minutes via trailing pace.
 * `durSeries` = work+drills minutes per day (caller already has it); `toDate` is the viewed day.
 */
export async function buildCapContext(
  durSeries: { date: string; value: number }[], toDate: Date, capPct: number, capBasis: LoadCapBasis,
): Promise<CapContext> {
  const tof = computeTimeOnFeetPlan(durSeries, toDate, { capPct, meaningful: 20, reentryBelow: 30, reentryFloor: 20 });
  if (capBasis !== 'distance') return { tof, cap: tof, budgetMin: tof.budgetTodayMin, loadUnit: 'min', capBasis, capPct };

  const distKm = await fetchDailyWorkDistanceHistory(toDate);
  const cap = computeTimeOnFeetPlan(distKm, toDate, { capPct, meaningful: 2, reentryBelow: 3, reentryFloor: 2 });
  const p = (n: number) => String(n).padStart(2, '0');
  const dStr = `${toDate.getFullYear()}-${p(toDate.getMonth() + 1)}-${p(toDate.getDate())}`;
  const dist7d = distKm.filter(d => d.date <= dStr).slice(-7).reduce((s, d) => s + d.value, 0);
  const paceMinPerKm = dist7d > 0 ? tof.tof7d / dist7d : 6; // fallback ~6 min/km
  return { tof, cap, budgetMin: Math.round(cap.budgetTodayMin * paceMinPerKm), loadUnit: 'km', capBasis, capPct };
}

/**
 * Build the full coach snapshot from HealthKit + weather for a given day's strain.
 * Single source used by both the Strain screen and the background day-view updater, so
 * the on-demand plan and the auto-prepared plan are identical.
 */
export async function assembleCoachSnapshot(strain: DayStrain | null, activities?: ActivitySummary[]): Promise<CoachSnapshot> {
  const [comps, dur, weather, powerZones, capPct, capBasis] = await Promise.all([
    fetchOurDailyComponents(1),
    fetchDailyDurationHistory(),
    getLocalWeather().catch(() => null),
    getPowerZones().catch(() => undefined),
    getLoadCapPct(),
    getLoadCapBasis(),
  ]);
  const dates  = Object.keys(comps).sort();
  const latest = dates.length ? comps[dates[dates.length - 1]] : {};
  const date   = dates.length ? dates[dates.length - 1] : new Date().toISOString().slice(0, 10);

  const { tof, cap, budgetMin, loadUnit } = await buildCapContext(dur, new Date(), capPct, capBasis);
  const strainHist = dates.map(d => comps[d].strainScore).filter((v): v is number => v !== undefined);
  return {
    date,
    recovery:     latest.recoveryScore,
    hrv:          latest.restingHrv,
    rhr:          latest.restingHr,
    respRate:     latest.respiratoryRate,
    spO2:         latest.oxygenSaturation,
    sleepScore:   latest.sleepScore,
    sleepMin:     latest.timeAsleep,
    sleepDebtMin: latest.sleepBank,
    ctl:          latest.ctl,
    atl:          latest.cardioLoad,
    tsb:          latest.tsb,
    acwr:         strain?.acwr || undefined,
    strainReal:   strain?.real,
    advisableLow:  strain?.safeLow,
    advisableHigh: strain?.safeHigh,
    readiness:    strain?.readiness,
    drivers:      strain?.drivers,
    recentStrain: strainHist.slice(-10),
    recentTimeOnFeet:  tof.series14,
    tof7d:             tof.tof7d,
    tofPrev7d:         tof.tofPrev7d,
    tofBudgetTodayMin: budgetMin,            // run-minutes budget (distance cap → converted via pace)
    tofNextRunLabel:   cap.nextRunLabel,     // next-run day comes from the ACTIVE cap basis
    tofNextRunInDays:  cap.nextRunInDays,
    yesterdayTofMin:   tof.yesterdayMin,
    loadCapBasis:      capBasis,
    loadCapPct:        capPct,
    loadBudgetToday:   cap.budgetTodayMin,   // in loadUnit
    loadUnit,
    yesterdayStrain:   strainHist.length >= 2 ? strainHist[strainHist.length - 2] : undefined,
    weather: weather ? {
      tempC: weather.tempC, apparentC: weather.apparentC, humidity: weather.humidity,
      windKmh: weather.windKmh, description: weather.description, place: weather.place,
    } : undefined,
    powerZones,
    recentActivities: buildRecentActivities(activities),
  };
}

// Last ~14 days of NON-run sessions, newest first — fatigue the coach should weigh.
function buildRecentActivities(activities?: ActivitySummary[]): CoachSnapshot['recentActivities'] {
  if (!activities?.length) return undefined;
  const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
  const out = activities
    .filter(a => activityCategory(a.activityType) !== 'Run' && a.date.slice(0, 10) >= cutoff && a.durationMin >= 5)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 12)
    .map(a => ({ date: a.date.slice(0, 10), name: a.name, durationMin: Math.round(a.durationMin), avgHR: a.avgHR || undefined }));
  return out.length ? out : undefined;
}

// Cache one plan per calendar day (never serve a previous day's plan). The plan stays
// DYNAMIC — it regenerates through the day as conditions drift (heat, accumulated strain).
const planFile = (date: string) => `${FileSystem.documentDirectory}coach-plan-${date}.json`;

// Time-stamped history of every prescription version generated for a day. Lets the run
// analysis reconstruct the prescription that was in effect WHEN A RUN STARTED — i.e. the
// pre-run prescription that drove the decision to train — without freezing the live plan.
const planLogFile = (date: string) => `${FileSystem.documentDirectory}coach-plan-log-${date}.json`;
const PLAN_LOG_CAP = 16;
interface PlanLogEntry { at: string; plan: CoachPlan }

export async function loadCachedPlan(date: string): Promise<CoachPlan | null> {
  try {
    const f = planFile(date);
    const info = await FileSystem.getInfoAsync(f);
    if (!info.exists) return null;
    return JSON.parse(await FileSystem.readAsStringAsync(f)) as CoachPlan;
  } catch { return null; }
}

async function readPlanLog(date: string): Promise<PlanLogEntry[]> {
  try {
    const f = planLogFile(date);
    const info = await FileSystem.getInfoAsync(f);
    if (!info.exists) return [];
    const arr = JSON.parse(await FileSystem.readAsStringAsync(f));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export async function saveCachedPlan(date: string, plan: CoachPlan): Promise<void> {
  try { await FileSystem.writeAsStringAsync(planFile(date), JSON.stringify(plan)); } catch { /* ignore */ }
  // Append this version to the day's prescription log (timestamped at generation time),
  // so a later run can be judged against whatever prescription was live when it started.
  try {
    const at = plan.generatedAt ?? new Date().toISOString();
    const log = await readPlanLog(date);
    if (log.length === 0 || log[log.length - 1].at !== at) log.push({ at, plan });
    const trimmed = log.slice(-PLAN_LOG_CAP);
    await FileSystem.writeAsStringAsync(planLogFile(date), JSON.stringify(trimmed));
  } catch { /* ignore */ }
}

/**
 * The prescription that was in effect at instant `atMs` (e.g. a run's start time) — the
 * latest logged version generated at or before that moment. Falls back to the earliest
 * version on record (if the run predates any logged plan), then to the live plan. Keeps
 * the plan dynamic while judging a run against the pre-run prescription.
 */
export async function loadPrescriptionAt(date: string, atMs: number): Promise<CoachPlan | null> {
  const log = await readPlanLog(date);
  if (log.length > 0) {
    const sorted = [...log].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    let chosen: CoachPlan | null = null;
    for (const e of sorted) {
      if (new Date(e.at).getTime() <= atMs) chosen = e.plan;
      else break;
    }
    return chosen ?? sorted[0].plan; // before any logged plan → earliest on record
  }
  return loadCachedPlan(date);
}
