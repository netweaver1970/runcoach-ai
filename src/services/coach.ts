/**
 * LLM training coach. Feeds the FULL daily picture — recovery, HRV/RHR vs baseline,
 * respiration, SpO₂, sleep & sleep debt, and the training-load history (CTL/ATL/TSB,
 * ACWR, recent strain) — to the configured model and asks for a session
 * recommendation grounded in current endurance-training science. Returns structured
 * JSON so the UI can render it and reconcile the advisable strain band.
 */
import * as FileSystem from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { callLLM, getLLMStatus } from './llm';
import { buildKnowledgePrompt, recordPrescription, readKnowledgeContent } from './coachFiles';
import { raceActive, getRaceWeekPlan, raceSlotForToday, getRaceConfig, fmtTime } from './racePlan';
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
  recoveryStale?: boolean;  // true = no overnight recovery data for last night (watch not worn) → the
                            // recovery/hrv/sleep/readiness fields are the last KNOWN values, not today's
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
  paceMinPerKm?:     number;   // trailing real-work pace (min/km) — km↔min conversion when distance basis
  yesterdayTofMin?:  number;   // yesterday's running minutes
  yesterdayStrain?:  number;   // yesterday's strain score
  weather?: {                  // current conditions — heat/humidity raise strain
    tempC: number; apparentC: number; humidity: number; windKmh: number;
    description: string; place?: string;
  };
  localContext?: string;       // real GPS place + local time, e.g. "Location: Merelbeke · Thu 25 Jun, 18:42"
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
  runKm?:     number;        // prescribed distance (km) — shown instead of minutes when distance basis
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
  shrinkForced?: boolean;    // shrink-to-fit placed this quality on its day OVER the cap → skip the budget/cap refresh checks
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
  // Budget / cap-flip checks — SKIPPED for a shrink-to-fit / race plan that intentionally holds a session
  // over the cap (otherwise it would refresh forever against its own over-budget minutes). EXCEPTION: once
  // you've actually RUN today, the forced session is DONE → re-check so it can't keep prescribing another
  // run (the phantom-2nd-run bug — force-placed this morning at todayDone 0, then you ran).
  const todayRunMin = (snap.recentTimeOnFeet ?? []).find(d => d.date === snap.date)?.min ?? 0;
  if (!plan.shrinkForced || todayRunMin >= 8) {
    // A run done since the plan was written shrinks today's remaining budget — if the prescribed run now
    // exceeds it, regenerate so we don't keep advising a session that would blow the weekly cap.
    if (plan.intensity !== 'rest' && (plan.runMinutes ?? 0) > 0 && snap.tofBudgetTodayMin != null
        && plan.runMinutes > snap.tofBudgetTodayMin + 5) return true;
    // The deterministic volume gate disagrees with the cached plan → the run/rest decision is stale
    // (a run got counted so the cap now blocks today, or a rest day rolled the cap free again).
    const cappedNow = (snap.tofNextRunInDays ?? 0) > 0;
    if (cappedNow && plan.intensity !== 'rest') return true;
    if (!cappedNow && (plan.nextRunInDays ?? 0) > 0) return true;
  }
  return false;
}

// True when shrink-to-fit should FORCE a quality on today (scheduled template quality day, recovered,
// not yet run) — the same conditions deterministicCoachPlan uses. The home calls this so a cached REST
// plan (from before shrink was on, or the cap) regenerates into today's short quality automatically,
// without a manual ↻. Async (reads the setting + schedule file) → kept out of the sync planNeedsRefresh.
export async function shrinkWantsQualityToday(snap: CoachSnapshot): Promise<boolean> {
  if (!snap.date) return false;
  const todayDone = (snap.recentTimeOnFeet ?? []).find(d => d.date === snap.date)?.min ?? 0;
  if (todayDone >= 8) return false;
  // RACE MODE: a cached REST plan should regenerate when the race week prescribes a run today.
  if (await raceActive()) { const rs = await raceSlotForToday(snap); return !!rs && rs.intensity !== 'rest'; }
  if (!(await getShrinkToFit())) return false;
  if ((snap.readiness ?? 0) < 60) return false;
  const tmpl = parseWeeklyTemplate(await readKnowledgeContent('running-schedule').catch(() => ''));
  const dow = new Date(snap.date + 'T00:00:00').getDay();
  return ['intervals', 'tempo', 'long'].includes(tmpl[dow] as string);
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
SECOND SESSION SAME DAY: if a run is ALREADY done today (recentActivities/strainReal reflect a session) \
and strainReal merely sits below the band, a second run is rarely worth it. Cumulative autonomic stress \
ADDS across sessions and an extra session — especially late in the day (read localContext for the local \
time) — pushes stress that tails into the night and degrades sleep + overnight recovery. So when a session \
is already logged: prefer a SHORT easy walk / cross-train top-up or rest over a second real run; only \
prescribe a second genuine run when recovery is good AND it is still early; and NEVER prescribe a hard or \
long second run in the evening. Say so explicitly in the rationale when you hold back. \
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
export function weekdayName(dateKey?: string): string {
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
    drillsMinutes: Math.max(0, Math.min(8, num(o.drillsMinutes) ?? 4)),  // drills are SHORT form-work, never the main set
    blocks,
    cooldownMeters: 600,
  };
}

// Map an HR zone (Z1–Z5) to its watt window from the athlete's power zones.
function zoneToWatts(zone: string | undefined, pz?: CoachSnapshot['powerZones']): [number?, number?] {
  if (!pz || !zone) return [undefined, undefined];
  let lo: number | undefined, hi: number | undefined;
  switch (zone) {
    case 'Z1': lo = Math.round(pz.recoveryMax * 0.7); hi = pz.recoveryMax;     break;
    case 'Z2': lo = pz.recoveryMax;                   hi = pz.z2Max;           break;
    case 'Z3': lo = pz.tempoMin;                      hi = pz.tempoMax;        break;
    case 'Z4': lo = pz.tempoMax;                      hi = pz.intervalsMin;    break;
    case 'Z5': lo = pz.intervalsMin;                  hi = pz.intervalsMin + 60; break;
    default:   return [undefined, undefined];
  }
  // Prescribe a NARROWER band in the UPPER half of the zone (the lower end felt too easy).
  if (lo != null && hi != null && hi > lo) lo = Math.round(lo + 0.5 * (hi - lo));
  return [lo, hi];
}

// Guarantee every work block carries a power window so the watch can give in-band cues.
// Fills missing watts from the block's HR zone (defaulting to Z2) using the power zones.
export function ensureBlockPower(w: WatchWorkout | null, pz?: CoachSnapshot['powerZones']): WatchWorkout | null {
  if (!w) return w;
  w.blocks = w.blocks.map(b => {
    if (b.powerLowWatts && b.powerHighWatts) return b;
    const [lo, hi] = zoneToWatts(b.hrZone ?? 'Z2', pz);
    return { ...b, powerLowWatts: b.powerLowWatts ?? lo, powerHighWatts: b.powerHighWatts ?? hi };
  });
  return w;
}

// Carry the power targets from a SOURCE workout (the cached plan's — the LLM / zone file already set
// them) onto a freshly synthesized one that may lack them. Used when the user nudges run minutes ± and
// we re-synthesize: only the DURATION changed, the per-zone watts are unchanged, so don't drop them
// (the live powerZones state can be empty/stale at that moment → otherwise no PowerRangeAlert reaches
// the watch). Matches by HR zone, falls back to any powered block.
export function mergeWorkoutPower(target: WatchWorkout | null, source?: WatchWorkout | null): WatchWorkout | null {
  if (!target || !source) return target;
  const byZone = new Map<string, [number, number]>();
  let anyPow: [number, number] | undefined;
  for (const b of source.blocks) {
    if (b.powerLowWatts && b.powerHighWatts) {
      anyPow = anyPow ?? [b.powerLowWatts, b.powerHighWatts];
      if (b.hrZone) byZone.set(b.hrZone, [b.powerLowWatts, b.powerHighWatts]);
    }
  }
  target.blocks = target.blocks.map(b => {
    if (b.powerLowWatts && b.powerHighWatts) return b;
    const m = (b.hrZone && byZone.get(b.hrZone)) || anyPow;
    return m ? { ...b, powerLowWatts: m[0], powerHighWatts: m[1] } : b;
  });
  return target;
}

// Fallback structured session when the LLM prescribes a run but omits the workout JSON.
// Maps the intensity to an HR zone + the matching watt window from the athlete's zones.
export function synthesizeWorkout(
  intensity: CoachIntensity, runMinutes: number, name: string,
  pz?: CoachSnapshot['powerZones'],
  kind?: 'intervals' | 'tempo' | 'long' | 'easy' | 'recovery',
): WatchWorkout {
  // Reserve ~6 min for the 600m warm-up + 600m cool-down; the rest is work.
  const workBudget = Math.max(8, (runMinutes || 35) - 6);
  // TYPE-aware structure — the session TYPE, not just the effort tier, decides the shape (so a Long
  // run is a long Z2 run, a Tempo is sustained Z3, only Intervals are short Z4 reps). Falls back to
  // the intensity when no kind is given (legacy callers like the daily plan's fallback).
  const t = kind ?? (intensity === 'hard' ? 'intervals' : intensity === 'moderate' ? 'tempo' : 'easy');
  let blocks: WatchWorkoutBlock[];
  if (t === 'intervals') {
    const reps = Math.max(4, Math.min(8, Math.round(workBudget / 5)));
    blocks = [{ repeats: reps, workMinutes: 3, restMinutes: 2, hrZone: 'Z4', label: 'intervals' }];
  } else if (t === 'tempo') {
    blocks = [{ repeats: 1, workMinutes: workBudget, restMinutes: 0, hrZone: 'Z3', label: 'tempo' }]; // ONE continuous threshold block — no jog gaps
  } else { // long / easy / recovery → ONE continuous aerobic block at Z2
    blocks = [{ repeats: 1, workMinutes: Math.min(150, workBudget), restMinutes: 0, hrZone: 'Z2', label: t === 'long' ? 'long' : 'aerobic' }];
  }
  const drills = 4;  // a short drills block on EVERY run, incl. easy — the runner's coaching files ask for it
  return ensureBlockPower({ name, warmupMeters: 600, drillsMinutes: drills, blocks, cooldownMeters: 600 }, pz)!;
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

export interface WeekPlanDay {
  date: string;        // YYYY-MM-DD
  weekday: string;     // "Fri"
  intensity: CoachIntensity;
  runMinutes: number;
  structure: string;   // concise, e.g. "40min @ Z2" or "4× 6min @ Z4 + 2min jog"
  note: string;        // ≤ ~8 words
  kind?: string;       // resolved session kind: intervals|tempo|long|easy|rest — drives the synthesized structure + the UI label
  forced?: boolean;    // shrink-to-fit force-placed this short quality on its day — the screen must NOT re-trim it away
  runKm?: number;      // target distance (km) — shown instead of minutes when distance basis
}

// Forward 7-day plan (tomorrow → +7), following the preferred weekly schedule but adjusted
// for the rolling volume cap, recovery, alternation and the morning weather forecast. The app
// computes strain + CTL/ATL.
// DETERMINISTIC 7-day scheduler — NO LLM. Same inputs → same week, every open (the old LLM version
// rolled a fresh, cap-ignoring answer each time → "3 opens, 3 plans", and contradicted the daily cap).
// The preferred week is PARSED from the editable "Weekly Schedule" knowledge file (so the runner's own
// structure drives it). Decision order per day: parsed KIND → re-entry override → readiness gate
// (quality only when green) → no-two-quality-back-to-back → ease a hard hot morning → resolve flex
// (easy-or-rest by cap) → HARD volume-cap gate (forward-rolled time-on-feet) forces rest when there's
// no budget. The screen still heat-cuts, cap-clamps the minutes and projects CTL/ATL/strain. (Kept
// async + same signature so the week screen needs no change. The DAILY plan still uses the LLM for prose.)
type WeekKind = 'intervals' | 'tempo' | 'long' | 'easy' | 'flex' | 'rest';
const DOW_IX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const FALLBACK_TEMPLATE: Record<number, WeekKind> = { // Geert's week (used if the file can't be read)
  1: 'intervals', 2: 'flex', 3: 'tempo', 4: 'flex', 5: 'long', 6: 'flex', 0: 'flex',
};
// Parse "- Mon: Intervals …" lines → weekday→kind. "recovery/easy … or rest" = flex (easy-or-rest);
// "recovery/easy" alone = easy (always a jog); bare "rest" = rest.
export function parseWeeklyTemplate(text: string): Record<number, WeekKind> {
  const out: Record<number, WeekKind> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/\b(mon|tue|wed|thu|fri|sat|sun)\b/i);
    if (!m) continue;
    const dow = DOW_IX[m[1].toLowerCase()];
    if (out[dow] !== undefined) continue; // first line per weekday wins
    const l = line.toLowerCase();
    const recover = /recover|\beasy\b/.test(l), rest = /\brest\b/.test(l);
    out[dow] =
      /interval/.test(l)        ? 'intervals' :
      /tempo|threshold/.test(l) ? 'tempo' :
      /\blong\b/.test(l)        ? 'long' :
      (recover && rest)         ? 'flex' :
      recover                   ? 'easy' :
      rest                      ? 'rest' : 'flex';
  }
  for (let d = 0; d < 7; d++) if (out[d] === undefined) out[d] = FALLBACK_TEMPLATE[d];
  return out;
}

export async function getWeekPlan(
  snap: CoachSnapshot,
  forecast?: { date: string; apparentC: number; humidity: number; description: string }[],
): Promise<WeekPlanDay[]> {
  // RACE MODE overrides the leisure template + cap: the LLM-designed race week IS the plan.
  if (await raceActive()) { const rw = await getRaceWeekPlan(snap); if (rw) return rw.days; }
  const today = new Date(snap.date + 'T00:00:00');
  const capPct = snap.loadCapPct ?? DEFAULT_LOAD_CAP_PCT;
  const periodization = await getPeriodization();  // build/deload cycle modulates each week's cap multiplier
  const MEANINGFUL = 20;
  const shrink = await getShrinkToFit();  // ON → a cap-blocked quality SHRINKS to fit its day instead of deferring
  const green = (snap.readiness ?? 60) >= 60; // quality only on a decent-readiness day
  // Re-entry: ~no running in the last week (holiday/illness) → rebuild gently with EASY Z2 ONLY, never
  // quality. The daily plan refines each morning by that day's actual recovery; here we lay out the
  // intended easy-run days so the forecast doesn't either slam intervals or show an empty week.
  const reentry = (snap.tof7d ?? 0) < 30;
  const template = parseWeeklyTemplate(await readKnowledgeContent('running-schedule').catch(() => ''));
  const fxBy = new Map((forecast ?? []).map(f => [f.date, f]));
  const p = (n: number) => String(n).padStart(2, '0');

  const tof = (snap.recentTimeOnFeet ?? []).map(d => d.min);
  while (tof.length < 14) tof.unshift(0);
  tof.splice(0, tof.length - 14);

  // Shuffle state: a quality session the cap blocks on its template day is DEFERRED (FIFO) and
  // rescheduled onto the next budgeted, well-spaced flex day — so the runner's key sessions shift
  // FORWARD instead of vanishing, and the normal structure resumes as the rolling cap frees up.
  // Anything still deferred at week's end simply reappears in next week's recompute.
  const QMIN = 25;          // (shrink OFF) a quality needs ≥ this much budget to run on its day; below it → defer
  const SHRINK_FLOOR = 20;  // shrink-to-fit: tempo/intervals never shorter than this (still a real short quality)
  const SHRINK_TARGET = 28; // shrink-to-fit: cap tempo/intervals at ~this (≤30 min) so the week stays short + balanced
  const LONG_MIN = 45;      // shrink-to-fit: the long run is PROTECTED — never shrunk below this (keeps it a "long")
  const EASY_RESERVE = 35;  // headroom kept on a flex day before spending budget on an easy jog
  const isQuality = (k: WeekKind) => k === 'intervals' || k === 'tempo' || k === 'long';
  const resolveQuality = (k: WeekKind): [CoachIntensity, number] =>
    k === 'intervals' ? ['hard', 45] : k === 'long' ? ['moderate', 65] : ['moderate', 50];
  const qName = (k: WeekKind) => k === 'intervals' ? 'Intervals' : k === 'tempo' ? 'Tempo' : k === 'long' ? 'Long run' : 'Run';
  // Goal: fit ALL the week's quality TYPES (intervals + tempo + long) inside the rolling cap. Count
  // them; while any are still pending, recovery/flex days REST to BANK budget rather than burn it on an
  // easy jog — and a deferred quality may land on ANY later flex day, including the WEEKEND. Easy jogs
  // only fill once the quality is placed or the budget is plentiful.
  let Qtotal = 0;
  for (let i = 0; i < 7; i++) if (isQuality(template[(today.getDay() + 1 + i) % 7])) Qtotal++;
  let qPlaced = 0;
  let lastQ = -99;                 // index of the last quality session placed (≥2 apart = spacing)
  const deferred: WeekKind[] = []; // quality kinds bumped by the cap, awaiting a later slot
  const out: WeekPlanDay[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today); d.setDate(d.getDate() + 1 + i);
    const key = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const weekday = weekdayName(key);
    const fc = fxBy.get(key);
    const heat = fc ? heatStrainFactor({ apparentC: fc.apparentC, humidity: fc.humidity }) : 1;

    const j = tof.length;
    const ref7   = tof.slice(j - 13, j - 6).reduce((a, b) => a + b, 0);
    const prior6 = tof.slice(j - 6,  j).reduce((a, b) => a + b, 0);
    let allowance = ref7 > 0 ? Math.max(0, Math.round(ref7 * weekCapMultiplier(d, periodization, capPct) - prior6)) : 45;
    if (ref7 < 30) allowance = Math.max(allowance, MEANINGFUL); // re-entry floor (matches computeTimeOnFeetPlan)

    const kind = template[d.getDay()];
    const spaced = (i - lastQ) >= 2; // ≥1 non-quality day since the last quality session
    let intensity: CoachIntensity = 'rest'; let base = 0; let placed: WeekKind = 'rest';
    let shifted = false, deferredHere = false, banked = false, shrunk = false, forcePlaced = false;
    if (reentry) {
      // easy Z2 on the anchor (quality/easy) days, rest on the recovery/flex days → ~3 gentle runs/wk
      if (kind !== 'rest' && kind !== 'flex') { intensity = 'easy'; base = 28; placed = 'easy'; }
    } else if (isQuality(kind)) {
      if (!green) { intensity = 'easy'; base = 35; placed = 'easy'; }                  // readiness too low → easy
      else if (shrink && spaced) {                                                     // SHRINK-TO-FIT (structure-first): hold it on its day
        const [qi, qb] = resolveQuality(kind);
        intensity = qi; placed = kind; lastQ = i; qPlaced++; forcePlaced = true;
        // tempo/intervals → a SHORT dose (≤ SHRINK_TARGET) so the week keeps its shape AND banks budget for
        // the long; the LONG is PROTECTED — kept long (≥ LONG_MIN), never downgraded to a Z2. Placed on its
        // own day even when the cap is tight: fitting the structure in is the whole point of shrink-to-fit.
        base = kind === 'long' ? Math.min(qb, Math.max(LONG_MIN, allowance))
                               : Math.max(SHRINK_FLOOR, Math.min(SHRINK_TARGET, allowance));
        shrunk = base < qb;
      } else if (allowance >= QMIN && spaced) {                                         // (shrink OFF) run full on its template day
        [intensity, base] = resolveQuality(kind); placed = kind; lastQ = i; qPlaced++;
      } else {                                                                         // (shrink OFF) cap/spacing-blocked → DEFER
        deferred.push(kind); deferredHere = true;
        if (allowance >= MEANINGFUL) { intensity = 'easy'; base = 30; placed = 'easy'; } // light jog instead of the quality
      }
    } else if (deferred.length && green && allowance >= QMIN && spaced) {              // SHUFFLE: reschedule a deferred quality here (incl. the weekend)
      const dk = deferred.shift()!; [intensity, base] = resolveQuality(dk); placed = dk; lastQ = i; shifted = true; qPlaced++;
    } else if (kind === 'easy') { intensity = 'easy'; base = 35; placed = 'easy'; }
    else if (kind === 'rest')   { intensity = 'rest'; base = 0; }
    else { // flex (recovery run or rest): rest to BANK budget while quality is still pending, else easy jog
      const bank = green && qPlaced < Qtotal && allowance < QMIN + EASY_RESERVE;
      if (bank || allowance < MEANINGFUL) { intensity = 'rest'; banked = bank; }
      else { intensity = 'easy'; base = 32; placed = 'easy'; }
    }
    if (intensity === 'hard' && (fc?.apparentC ?? 0) >= 24) intensity = 'moderate';    // ease a hot hard morning

    let capRest = false;
    // HARD cap gate (safety) — but shrink-to-fit's force-placed quality keeps its day even over budget.
    if (intensity !== 'rest' && allowance < MEANINGFUL && !forcePlaced) { intensity = 'rest'; capRest = true; }
    if (intensity === 'rest') placed = 'rest';
    const runMinutes = intensity === 'rest' ? 0 : base;
    const heatMin = intensity === 'rest' ? 0 : Math.max(8, Math.round(runMinutes / heat));
    // Force-placed quality counts its REAL minutes (so later days' budgets — esp. the long — see the true
    // load); otherwise the day's counted ToF is capped at the available allowance.
    tof.push(intensity === 'rest' ? 0 : forcePlaced ? heatMin : Math.min(heatMin, Math.max(MEANINGFUL, allowance)));

    const isLong = placed === 'long';
    const structure = intensity === 'rest' ? 'Rest'
      : intensity === 'hard'     ? `${runMinutes}min incl. intervals`
      : intensity === 'moderate' ? `${runMinutes}min ${isLong ? 'long-ish aerobic' : 'tempo'}`
      :                            `${runMinutes}min easy @ Z2`;
    const note =
      reentry && intensity === 'easy' ? 'Easy Z2 — rebuilding after the break (recovery-gated)' :
      reentry                         ? 'Recovery day — rebuilding' :
      shifted                         ? `${qName(placed)} — rescheduled here as the cap freed up` :
      shrunk && placed === 'long'     ? 'Long run — protected (kept long on a tight week)' :
      shrunk                          ? `${qName(placed)} — shortened to hold its day (banks budget for the long)` :
      deferredHere                    ? `${qName(kind)} deferred past the +${capPct}% cap${intensity === 'rest' ? '' : ' — easy jog instead'}` :
      banked                          ? 'Recovery — banking volume for the week’s quality' :
      capRest                         ? `Cap rest — 7-day volume at the +${capPct}% ceiling` :
      intensity === 'rest'            ? 'Recovery run or rest' :
      intensity === 'hard'            ? 'Intervals — keep it genuinely hard' :
      intensity === 'moderate'        ? (isLong ? 'Long-ish aerobic run' : 'Tempo / threshold') :
      kind === 'flex'                 ? 'Easy recovery jog' : 'Easy aerobic Z2';
    const runKm = intensity !== 'rest' && snap.loadUnit === 'km' && snap.paceMinPerKm
      ? Math.round((runMinutes / snap.paceMinPerKm) * 10) / 10 : undefined;
    out.push({ date: key, weekday, intensity, runMinutes, structure, note, kind: placed, forced: forcePlaced, runKm });
  }
  return out;
}

// ── Deterministic daily plan (NO LLM) ──────────────────────────────────────────
// Mirrors the deterministic week planner for TODAY: the editable weekly template + readiness gate +
// rolling volume cap + heat budget pick the session, synthesizeWorkout builds the structured watch
// workout, and the prose is templated from signals the engine already computes. Used when there's no
// API key (keyless mode) or the key is broken, and as the fallback when an LLM call fails — so the
// core daily loop never depends on the model.
const STRENGTH_DEFAULT = 'Calf raises 3×15, single-leg squats 3×8/leg, hip bridges 3×15, side plank 3×30s/side.';
const STALE_CAUTION = "⚠️ Watch not worn overnight — recovery unknown; plan carried from your schedule. If you don't feel fully rested, run this easy in Z2 (keep HR in Z2).";

function bandPhrase(real: number | null | undefined, low: number, high: number, driver: string): string {
  if (real == null) return driver.charAt(0).toUpperCase() + driver.slice(1) + '.';
  const where = real < low ? 'below' : real > high ? 'above' : 'within';
  return `Strain ${Math.round(real)}% is ${where} the ${low}–${high}% band — ${driver}.`;
}

export async function deterministicCoachPlan(snap: CoachSnapshot): Promise<CoachPlan> {
  await ensureZonesFile().catch(() => {});
  const capPct      = snap.loadCapPct ?? DEFAULT_LOAD_CAP_PCT;
  const cappedToday = (snap.tofNextRunInDays ?? 0) > 0;
  const wkName      = weekdayName(snap.date);
  const reentry     = (snap.tof7d ?? 0) < 30;
  const shrinkOn    = await getShrinkToFit();
  const template    = parseWeeklyTemplate(await readKnowledgeContent('running-schedule').catch(() => ''));
  const dow         = new Date(snap.date + 'T00:00:00').getDay();
  const todaySlot   = reentry ? null : await loadTodaysWeekPlanSlot(snap.date);
  const todayDone   = (snap.recentTimeOnFeet ?? []).find(d => d.date === snap.date)?.min ?? 0;
  // Shrink-to-fit FORCE-PLACES today's scheduled quality (short) even over the cap — driven by the
  // TEMPLATE, NOT by finding a prior-day slot (that read is fragile: cache timing / which regen persisted).
  // Only on a real template quality day, only when recovered (green) and you haven't already run today —
  // so a cap-exhausted recovery day (e.g. after a double) still rests. Uses the slot's exact shrunk minutes
  // if one WAS found, else the shrink default.
  const honourSlot  = shrinkOn
    && ['intervals', 'tempo', 'long'].includes(template[dow] as string)
    && (snap.readiness ?? 60) >= 60
    && todayDone < 8;
  // RACE MODE: today's session comes from the LLM race week (overrides the leisure template + cap).
  const raceSlot    = (await raceActive()) ? await raceSlotForToday(snap) : null;
  const raceForced  = !!raceSlot && raceSlot.intensity !== 'rest';
  const honorDirect = honourSlot || raceForced;
  const strainLow   = clampScore(snap.advisableLow, 30);
  const strainHigh  = clampScore(snap.advisableHigh, 60);
  const strainReal  = snap.strainReal ?? null;
  const recoveryStale = snap.recoveryStale === true;
  const heatFactor  = heatStrainFactor(snap.weather);
  const apparentC   = snap.weather?.apparentC ?? snap.weather?.tempC;
  const stamp = {
    strainLow, strainHigh,
    nextRunLabel:  cappedToday ? snap.tofNextRunLabel : undefined,
    nextRunInDays: snap.tofNextRunInDays,
    generatedAt: new Date().toISOString(),
    genTempC:  apparentC,
    genStrain: snap.strainReal,
  };

  // Cap reached → mandatory recovery day (unless shrink-to-fit is holding a quality on its day).
  if (cappedToday && !honourSlot && !raceSlot) {
    return {
      headline: 'At your volume cap — recovery day',
      session: `Rest from running today — your trailing 7-day time-on-feet is at the +${capPct}% ceiling. Keep it to easy mobility/strength; next run ${snap.tofNextRunLabel ?? 'in a couple of days'}.`,
      strength: STRENGTH_DEFAULT, intensity: 'rest', runMinutes: 0,
      rationale: bandPhrase(strainReal, strainLow, strainHigh, 'cap reached, so banking volume for the next quality day'),
      cautions: recoveryStale ? STALE_CAUTION : undefined, workout: null, ...stamp,
    };
  }

  // Today's session: PREFER the slot the rolling 7-day plan already laid out for today (generated on a
  // PRIOR day, so it SPREADS the week's volume) over a greedy single-day budget. Today's recovery can only
  // EASE it (never inflate). Fall back to the editable weekly template + readiness gate when no prior plan
  // covers today (first run, or re-entry where the gentle rebuild logic should win).
  const green    = (snap.readiness ?? 60) >= 60;
  const heatBudget = snap.tofBudgetTodayMin != null ? Math.round(snap.tofBudgetTodayMin / heatFactor) : undefined;
  const budget   = heatBudget ?? snap.tofBudgetTodayMin ?? 45;

  type SK = 'intervals' | 'tempo' | 'long' | 'easy' | 'recovery';
  const toSK = (k: string | undefined, it: CoachIntensity): SK =>
    (k === 'intervals' || k === 'tempo' || k === 'long' || k === 'easy') ? k
      : it === 'hard' ? 'intervals' : it === 'moderate' ? 'tempo' : it === 'easy' ? 'easy' : 'recovery';
  let intensity: CoachIntensity; let sk: SK; let base: number; let eased = '';
  let kind: string = template[dow];                 // scheduled session TYPE (drives the rest-day wording)
  const slot = todaySlot;
  if (raceSlot) {
    // RACE MODE: today = the LLM race-week session (overrides template/cap). Recovery may still ease it.
    if (raceSlot.intensity === 'rest') { intensity = 'rest'; sk = 'recovery'; base = 0; kind = 'rest'; }
    else {
      intensity = raceSlot.intensity; sk = toSK(raceSlot.kind, raceSlot.intensity); base = raceSlot.runMinutes; kind = raceSlot.kind ?? kind;
      if (!green && (intensity === 'hard' || intensity === 'moderate')) { intensity = 'easy'; sk = 'easy'; base = Math.min(base, 35); eased = 'readiness low, eased the race session to easy'; }
    }
  } else if (honourSlot) {
    // shrink-to-fit: force-place today's SCHEDULED quality, short. Prefer the week plan's exact (shrunk)
    // minutes if a slot was found; else the shrink default (tempo/intervals ~28 min, long 45).
    const k = template[dow];
    intensity = k === 'intervals' ? 'hard' : 'moderate';
    sk = (k === 'intervals' || k === 'tempo' || k === 'long') ? k : 'tempo';
    base = (slot && slot.intensity !== 'rest') ? slot.runMinutes : (k === 'long' ? 45 : 28);
    kind = k;
  } else if (slot) {
    // The rolling 7-day plan already decided today — honour it as the basis (spread, not greedy).
    kind = slot.intensity === 'rest' ? 'rest' : (slot.kind ?? kind);
    if (slot.intensity === 'rest') { intensity = 'rest'; sk = 'recovery'; base = 0; }
    else {
      intensity = slot.intensity; sk = toSK(slot.kind, slot.intensity); base = slot.runMinutes;
      if (!green && (intensity === 'hard' || intensity === 'moderate')) {  // recovery can only push DOWN
        intensity = 'easy'; sk = 'easy'; base = Math.min(base, 35); eased = 'readiness low, eased the planned session to easy Z2';
      }
    }
  } else if (reentry) {
    intensity = 'easy'; sk = 'easy'; base = 28; eased = 'rebuilding after a light week — easy Z2 only';
  } else if (kind === 'intervals') {
    if (green) { intensity = 'hard'; sk = 'intervals'; base = 45; }
    else { intensity = 'easy'; sk = 'easy'; base = 35; eased = 'readiness low, so intervals dropped to easy Z2'; }
  } else if (kind === 'tempo') {
    if (green) { intensity = 'moderate'; sk = 'tempo'; base = 50; }
    else { intensity = 'easy'; sk = 'easy'; base = 35; eased = 'readiness low, so tempo dropped to easy Z2'; }
  } else if (kind === 'long') {
    if (green) { intensity = 'moderate'; sk = 'long'; base = 65; }
    else { intensity = 'easy'; sk = 'easy'; base = 40; eased = 'readiness low, so the long run is just easy Z2'; }
  } else if (kind === 'easy') {
    intensity = 'easy'; sk = 'easy'; base = 35;
  } else if (kind === 'rest') {
    intensity = 'rest'; sk = 'recovery'; base = 0;
  } else { // flex
    intensity = 'easy'; sk = 'recovery'; base = 32;
  }
  let heatCut = false;
  if (intensity === 'hard' && (apparentC ?? 0) >= 24) { intensity = 'moderate'; sk = 'tempo'; heatCut = true; }
  if (intensity !== 'rest' && budget < 12 && !honorDirect) { intensity = 'rest'; sk = 'recovery'; base = 0; }

  // Rest day (scheduled or out of budget).
  if (intensity === 'rest') {
    return {
      headline: 'Recovery day',
      session: kind === 'rest'
        ? 'Scheduled recovery — rest or an easy walk; optional mobility & strength.'
        : 'Volume’s used up for now — rest or cross-train; mobility & strength.',
      strength: STRENGTH_DEFAULT, intensity: 'rest', runMinutes: 0,
      rationale: bandPhrase(strainReal, strainLow, strainHigh, kind === 'rest' ? 'a scheduled recovery day' : 'no running budget left today'),
      cautions: recoveryStale ? STALE_CAUTION : undefined, workout: null, ...stamp,
    };
  }

  // Build the structured session. A shrink-to-fit slot is HONOURED at its (already-short) minutes —
  // only today's heat eases it — so the daily card matches the 7-day plan instead of re-capping to rest.
  const runMinutes = Math.max(8, honorDirect ? Math.round(base / Math.max(1, heatFactor)) : Math.min(budget, base));
  const runKm      = snap.loadUnit === 'km' && snap.paceMinPerKm ? Math.round((runMinutes / snap.paceMinPerKm) * 10) / 10 : undefined;
  const workout    = ensureBlockPower(synthesizeWorkout(intensity, runMinutes, wkName, snap.powerZones, sk), snap.powerZones);
  const structure  = formatWorkoutStructure(workout);
  const dose       = runKm != null ? `${runKm} km` : `${runMinutes} min`;  // display unit follows the cap basis
  const label = sk === 'intervals' ? 'Intervals' : sk === 'tempo' ? 'Tempo' : sk === 'long' ? 'Long run' : base <= 30 ? 'Recovery run' : 'Easy Z2';
  const headline =
    sk === 'intervals' ? 'Good to go — intervals day' :
    sk === 'tempo'     ? 'Solid day — tempo' :
    sk === 'long'      ? 'Endurance day — long run' :
    green              ? 'Easy aerobic day' : 'Keep it easy today';
  const driver = eased ? eased
    : heatCut ? `${Math.round(apparentC ?? 0)}°C — eased off the intervals`
    : (sk === 'intervals' || sk === 'tempo' || sk === 'long') ? 'on-schedule for the week’s quality'
    : 'easy aerobic to keep ticking over';
  const heatNote = heatFactor > 1.08 && heatBudget != null && heatBudget < (snap.tofBudgetTodayMin ?? 999)
    ? ` Heat ×${heatFactor.toFixed(2)} → trimmed to ${runMinutes} min.` : '';

  return {
    headline,
    session: `${label} — ${dose}${structure ? `, ${structure}` : ''}.`,
    strength: STRENGTH_DEFAULT, intensity, runMinutes, runKm,
    rationale: bandPhrase(strainReal, strainLow, strainHigh, driver) + heatNote,
    cautions: recoveryStale ? STALE_CAUTION : undefined, workout, shrinkForced: honorDirect, ...stamp,
  };
}

const INTENSITY_RANK: Record<CoachIntensity, number> = { rest: 0, easy: 1, moderate: 2, hard: 3 };

export async function getCoachPlan(snap: CoachSnapshot): Promise<CoachPlan> {
  // THE 7-DAY PLAN SETS THE CEILING. The deterministic basis (same logic as the week planner: editable
  // template → readiness gate → rolling volume cap → heat) decides today's intensity + run minutes. The
  // LLM then DESIGNS the session reading the editable COACHING FILES (warm-up, drills as the files ask
  // for — yes, even on easy runs — work, cool-down) and writes the prose. But it may only go EASIER /
  // SHORTER than the basis: good recovery or cool weather can NEVER inflate the run and eat the rest of
  // the week's budget; only genuinely poor recovery pushes it down. Keyless / broken key / LLM error →
  // the deterministic plan verbatim.
  ensureWeekPlanCached(snap).catch(() => {});  // cache today's rolling plan so tomorrow's daily plan can read its slot
  const basis = await deterministicCoachPlan(snap);
  const status = await getLLMStatus();
  if (!status.hasKey || !status.reachable) return basis;
  try {
    await ensureZonesFile().catch(() => {});
    const knowledge = await buildKnowledgePrompt();
    // RACE PREP context — injected ABOVE the coaching files as the highest-priority instruction.
    let raceHdr = '';
    if (await raceActive()) {
      const race = await getRaceConfig();
      const rw = await getRaceWeekPlan(snap);
      const ts = rw?.days.find(d => d.date === snap.date);
      raceHdr = `\n\n===== RACE PREP (HIGHEST PRIORITY — overrides the weekly-schedule file below) =====\n`
        + `Goal: ${race.distanceKm}km race on ${race.date}${race.goalTimeSec ? `, target ${fmtTime(race.goalTimeSec)}` : ''}. `
        + `Phase: ${rw?.phase ?? '—'}, ${rw?.weeksToRace ?? '?'} week(s) out. `
        + `TODAY's race session: ${ts ? `${ts.kind} — ${ts.structure}${ts.note ? ` (${ts.note})` : ''}` : 'per the ceiling'}. `
        + `Design today to fit this race block; the weekly-schedule file does NOT apply in race mode.\n===== END RACE PREP =====`;
    }
    const heatFactor = heatStrainFactor(snap.weather);
    const ceiling = basis.intensity === 'rest'
      ? `\n\nMANDATORY: today is a REST day (the 7-day plan + rolling volume cap leave no running budget). Return intensity "rest", runMinutes 0, workout null, and a recovery/strength-focused headline + session.`
      : `\n\nPRESCRIBED CEILING — the 7-day plan + today's recovery/heat have ALREADY set today to intensity "${basis.intensity}", about ${basis.runMinutes} min. You MUST honour this as a CEILING: stay at or BELOW it (you may go easier/shorter if today's data warrants), but NEVER prescribe a harder intensity or more minutes — good recovery or cool weather must not inflate the run, as that eats the rest of the week. Within the ceiling, design the session per the COACHING KNOWLEDGE above: open warm-up, a short DRILLS block if the runner's files call for it (they may, even on easy runs), the work, and an open cool-down.`;
    const system = `${ROLE}${raceHdr}\n\n===== COACHING KNOWLEDGE =====\n${knowledge}\n===== END COACHING KNOWLEDGE =====\n\n${OUTPUT}${ceiling}`;
    const txt = await callLLM({
      system,
      messages: [{ role: 'user', content: JSON.stringify({ ...snap, heatStrainFactor: heatFactor, prescribedCeiling: { intensity: basis.intensity, runMinutes: basis.runMinutes } }) }],
      maxTokens: 1200,
      temperature: 0.2,
    });
    const match = txt.match(/\{[\s\S]*\}/);
    if (!match) return basis;
    const o = JSON.parse(match[0]);
    // CAP at the basis — recovery/weather may only EASE (no intensity escalation, no extra minutes).
    const llmIntensity: CoachIntensity = ['rest', 'easy', 'moderate', 'hard'].includes(o.intensity) ? o.intensity : basis.intensity;
    const intensity: CoachIntensity = INTENSITY_RANK[llmIntensity] <= INTENSITY_RANK[basis.intensity] ? llmIntensity : basis.intensity;
    const runMinutes = intensity === 'rest' ? 0
      : Math.max(8, Math.min(basis.runMinutes, Math.round(Number(o.runMinutes)) || basis.runMinutes));
    const wkName = weekdayName(snap.date);
    // Keep the LLM's structure (it honours the coaching-file drills), but reject a malformed one — where
    // the work blocks don't account for most of the run (e.g. the main work mislabeled as a giant drills
    // block) — and fall back to the clean synthesized session (which also carries drills now).
    const parsed = intensity === 'rest' ? null : parseWorkout(o.workout, intensity, wkName);
    const workTotal = (parsed?.blocks ?? []).reduce((s, b) => s + b.workMinutes * b.repeats, 0);
    const wellFormed = parsed != null && workTotal >= Math.max(8, runMinutes - (parsed.drillsMinutes ?? 0) - 6) * 0.5;
    const workout = intensity === 'rest' ? null : ensureBlockPower(
      wellFormed ? parsed : synthesizeWorkout(intensity, runMinutes, wkName, snap.powerZones),
      snap.powerZones);
    const runKm = intensity !== 'rest' && snap.loadUnit === 'km' && snap.paceMinPerKm
      ? Math.round((runMinutes / snap.paceMinPerKm) * 10) / 10 : undefined;
    return {
      ...basis,
      headline:  o.headline  ? String(o.headline).slice(0, 120)  : basis.headline,
      session:   o.session   ? String(o.session).slice(0, 280)   : basis.session,
      strength:  o.strength  ? String(o.strength).slice(0, 240)  : basis.strength,
      intensity, runMinutes, runKm, workout,
      rationale: o.rationale ? String(o.rationale).slice(0, 400) : basis.rationale,
      cautions:  basis.cautions ?? (o.cautions ? String(o.cautions).slice(0, 200) : undefined),
      generatedAt: new Date().toISOString(),
    };
  } catch {
    // bad key / network / quota — keep the app usable with the deterministic plan
    // (callLLM has already flipped the reachability flag, so the LLM buttons grey out too).
    return basis;
  }
}

// ── Progression-cap settings (user-configurable) ──────────────────────────────
// The rolling-7-day increase cap. Default +10%/week (the classic guideline), but a returning-from-
// injury athlete may want to ramp faster (e.g. 20%). And the cap can be measured by TIME-ON-FEET
// (default) or by real-work DISTANCE — some athletes prefer a distance ceiling.
// ── Coaching mode (Milestone 3) ────────────────────────────────────────────────
// 'self' = the app's own LLM generates the daily plan. 'coach' = use the prescription an
// external coach wrote in the cloud for that day (a "waiting for coach" state when none yet).
export type CoachingMode = 'self' | 'coach';
const COACHING_MODE_KEY = 'coaching_mode_v1';
export async function getCoachingMode(): Promise<CoachingMode> {
  try { return (await SecureStore.getItemAsync(COACHING_MODE_KEY)) === 'coach' ? 'coach' : 'self'; }
  catch { return 'self'; }
}
export async function setCoachingMode(m: CoachingMode): Promise<void> {
  try { await SecureStore.setItemAsync(COACHING_MODE_KEY, m); } catch { /* ignore */ }
}

// Shrink-to-fit (off by default): when ON, a cap-blocked quality session SHORTENS to fit its template
// day instead of being deferred — tempo/intervals shrink to a floor so the week keeps a (short) quality
// touch AND the long run, rather than rest days. Toggled from the 7-Day Plan screen; the daily plan
// reads the same setting via getWeekPlan, so they stay consistent.
const SHRINK_TO_FIT_KEY = 'shrink_to_fit_v1';
export async function getShrinkToFit(): Promise<boolean> {
  try { return (await SecureStore.getItemAsync(SHRINK_TO_FIT_KEY)) === '1'; } catch { return false; }
}
export async function setShrinkToFit(on: boolean): Promise<void> {
  try { await SecureStore.setItemAsync(SHRINK_TO_FIT_KEY, on ? '1' : '0'); } catch { /* ignore */ }
}

export type LoadCapBasis = 'tof' | 'distance';
const LOAD_CAP_PCT_KEY   = 'load_cap_pct';
const LOAD_CAP_BASIS_KEY = 'load_cap_basis';
export const DEFAULT_LOAD_CAP_PCT = 10;
export const DEFAULT_LOAD_CAP_BASIS: LoadCapBasis = 'tof';

// Minimum allowed TSB (form): the 7-day forecast won't let a session push projected TSB below this,
// trimming the run so fatigue stays "real". Default −10 (a sane training-stress floor).
const MIN_TSB_KEY = 'min_tsb';
export const DEFAULT_MIN_TSB = -10;
export async function getMinTSB(): Promise<number> {
  try {
    const raw = await SecureStore.getItemAsync(MIN_TSB_KEY);
    const n = raw != null && raw !== '' ? parseInt(raw, 10) : DEFAULT_MIN_TSB;
    return Number.isFinite(n) && n >= -40 && n <= 0 ? n : DEFAULT_MIN_TSB; // −40…0 sane bounds
  } catch { return DEFAULT_MIN_TSB; }
}
export async function setMinTSB(v: number): Promise<void> {
  try { await SecureStore.setItemAsync(MIN_TSB_KEY, String(Math.round(v))); } catch { /* ignore */ }
}

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

// ── Periodization (build / deload cycles) ──────────────────────────────────────
// Replaces "grow forever": volume ramps for `buildWeeks`, then a `deloadWeeks` block drops the ceiling
// by `deloadDropPct`% before the build RESUMES from the pre-deload level (not the trough). Adjustable by
// the athlete/coach with safe defaults. Cycle phase is a deterministic function of the ISO week (fixed
// epoch Monday) + the settings — no per-user anchor to persist.
export interface Periodization { on: boolean; buildWeeks: number; deloadWeeks: number; deloadDropPct: number; anchor: string; }
// anchor = ISO date (YYYY-MM-DD) the athlete chose to START a cycle (its week = Build 1); '' → fixed calendar default.
export const DEFAULT_PERIODIZATION: Periodization = { on: true, buildWeeks: 3, deloadWeeks: 1, deloadDropPct: 25, anchor: '' };
const PERIODIZATION_KEY = 'periodization_v1';
export async function getPeriodization(): Promise<Periodization> {
  try {
    const raw = await SecureStore.getItemAsync(PERIODIZATION_KEY);
    const p: Periodization = raw ? { ...DEFAULT_PERIODIZATION, ...JSON.parse(raw) } : { ...DEFAULT_PERIODIZATION };
    p.buildWeeks    = Math.max(1, Math.min(12, Math.round(p.buildWeeks)));
    p.deloadWeeks   = Math.max(1, Math.min(4,  Math.round(p.deloadWeeks)));
    p.deloadDropPct = Math.max(5, Math.min(60, Math.round(p.deloadDropPct)));
    p.anchor = typeof p.anchor === 'string' ? p.anchor : '';
    return p;
  } catch { return { ...DEFAULT_PERIODIZATION }; }
}
export async function setPeriodization(p: Periodization): Promise<void> {
  try { await SecureStore.setItemAsync(PERIODIZATION_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

// Monday of the ISO week containing `d` (local); fixed epoch Monday (2024-01-01) → deterministic cycle index.
function mondayOf(d: Date): Date { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
const PERIODIZATION_EPOCH = new Date(2024, 0, 1); // a Monday — the default anchor when the athlete hasn't set one
function weekIndex(d: Date, per: Periodization): number {
  const ref = per.anchor ? mondayOf(new Date(per.anchor + 'T00:00:00')) : PERIODIZATION_EPOCH;
  const t = ref.getTime();
  return Math.round((mondayOf(d).getTime() - (Number.isNaN(t) ? PERIODIZATION_EPOCH.getTime() : t)) / (7 * 86_400_000));
}

// Per-week cap multiplier: +cap% ramp on a build week; a drop on the FIRST deload week (hold thereafter);
// a rebuild jump on the first build week AFTER a deload (undo the drop + ramp → back to the pre-deload
// level, not the trough). Returns the plain ramp when periodization is off.
export function weekCapMultiplier(dateInWeek: Date, per: Periodization, capPct: number): number {
  const ramp = 1 + capPct / 100;
  if (!per.on) return ramp;
  const cycleLen = per.buildWeeks + per.deloadWeeks;
  const idx = weekIndex(dateInWeek, per);
  const cycleNum = Math.floor(idx / cycleLen);
  const w = ((idx % cycleLen) + cycleLen) % cycleLen;
  const deload = 1 - per.deloadDropPct / 100;
  if (w < per.buildWeeks) return (w === 0 && cycleNum > 0) ? ramp / deload : ramp;
  return (w === per.buildWeeks) ? deload : 1;
}

// Human-readable phase for the week containing `date`.
export function cyclePhase(date: Date, per: Periodization): { phase: 'build' | 'deload'; label: string } {
  if (!per.on) return { phase: 'build', label: '' };
  const cycleLen = per.buildWeeks + per.deloadWeeks;
  const w = ((weekIndex(date, per) % cycleLen) + cycleLen) % cycleLen;
  if (w < per.buildWeeks) return { phase: 'build', label: `Build ${w + 1}/${per.buildWeeks}` };
  return { phase: 'deload', label: per.deloadWeeks > 1 ? `Deload ${w - per.buildWeeks + 1}/${per.deloadWeeks}` : 'Deload week' };
}

export interface CapOpts {
  capPct?:       number;  // rolling increase cap % (default 10)
  meaningful?:   number;  // a run "counts" once the budget allows ≥ this (min or km)
  reentryBelow?: number;  // prior-7 below this → apply the re-entry floor
  reentryFloor?: number;  // minimum budget when returning from a near-zero base
  periodization?: Periodization; // build/deload cycle modulating the per-week cap multiplier
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
  const capPct       = opts.capPct ?? DEFAULT_LOAD_CAP_PCT;
  const per          = opts.periodization;
  // Per-week cap multiplier (periodized build/deload); plain +cap% ramp when no periodization passed.
  const weekMultAt = (offsetDays: number) => {
    if (!per) return 1 + capPct / 100;
    const d = new Date(today); d.setDate(d.getDate() + offsetDays);
    return weekCapMultiplier(d, per, capPct);
  };
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

  let tofLast6  = 0; for (let o = 1; o <= 6;  o++) tofLast6  += minsAt(o);
  let tofPrev7  = 0; for (let o = 7; o <= 13; o++) tofPrev7  += minsAt(o);
  const todayDone = minsAt(0);                       // time-on-feet ALREADY done today (e.g. a morning run)
  const cap = Math.round(weekMultAt(0) * tofPrev7);
  // The cap limits the TRAILING-7 window (days 0–6), so today's remaining room must subtract BOTH the
  // last 6 days AND what's already been run today — otherwise after a morning run the plan offers the
  // whole day's allowance again and a second session blows the weekly cap (eating next week's budget).
  let budget = Math.max(0, cap - tofLast6 - todayDone);
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
    // minIdx(k) = the current day's already-done minutes (today's run for k=0; 0 for future days) —
    // subtract it too so "does a run fit today?" reflects what's already on the legs today.
    let b = Math.max(0, Math.round(weekMultAt(k) * prev7) - last6 - minIdx(k));
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
  paceMinPerKm: number;    // trailing real-work pace (min/km); 0 in tof mode (unused there)
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
  const periodization = await getPeriodization();
  const tof = computeTimeOnFeetPlan(durSeries, toDate, { capPct, meaningful: 20, reentryBelow: 30, reentryFloor: 20, periodization });
  if (capBasis !== 'distance') return { tof, cap: tof, budgetMin: tof.budgetTodayMin, loadUnit: 'min', capBasis, capPct, paceMinPerKm: 0 };

  const distKm = await fetchDailyWorkDistanceHistory(toDate);
  const cap = computeTimeOnFeetPlan(distKm, toDate, { capPct, meaningful: 2, reentryBelow: 3, reentryFloor: 2, periodization });
  const p = (n: number) => String(n).padStart(2, '0');
  const dStr = `${toDate.getFullYear()}-${p(toDate.getMonth() + 1)}-${p(toDate.getDate())}`;
  const dist7d = distKm.filter(d => d.date <= dStr).slice(-7).reduce((s, d) => s + d.value, 0);
  const paceMinPerKm = dist7d > 0 ? tof.tof7d / dist7d : 6; // fallback ~6 min/km
  return { tof, cap, budgetMin: Math.round(cap.budgetTodayMin * paceMinPerKm), loadUnit: 'km', capBasis, capPct, paceMinPerKm };
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
  const dataDate = dates.length ? dates[dates.length - 1] : '';
  const now = new Date();
  const realToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  // Watch not worn overnight → no overnight recovery for last night. Either there's NO record for today
  // (so `latest` is the last day WITH data, e.g. Saturday), or today's record lacks sleep + overnight
  // HRV. Either way don't get stuck / read it as poor recovery: plan for TODAY and flag recovery as
  // stale (the recovery / hrv / sleep / readiness fields below are then the last-known estimate).
  const recoveryStale =
    (!!dataDate && dataDate < realToday) ||
    (dataDate === realToday && !latest.timeAsleep && latest.restingHrv == null);
  const date = (dataDate && dataDate > realToday) ? dataDate : realToday;

  const { tof, cap, budgetMin, loadUnit, paceMinPerKm } = await buildCapContext(dur, new Date(), capPct, capBasis);
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
    recoveryStale,
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
    paceMinPerKm,
    yesterdayStrain:   strainHist.length >= 2 ? strainHist[strainHist.length - 2] : undefined,
    weather: weather ? {
      tempC: weather.tempC, apparentC: weather.apparentC, humidity: weather.humidity,
      windKmh: weather.windKmh, description: weather.description, place: weather.place,
    } : undefined,
    localContext: `${weather?.place ? `Location: ${weather.place} · ` : ''}${new Date().toLocaleString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    })}`,
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
  // Concise, human-readable prescription history in the coaching notes (newest first).
  recordPrescription(date, plan.intensity === 'rest' ? '' : formatWorkoutStructure(plan.workout)).catch(() => {});
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

// ── 7-day plan cache ───────────────────────────────────────────────────────────
// The week plan is an LLM prescription — it should be STABLE, not re-rolled on every open.
// Cache it per generation-day; reuse until a new day, a newly-completed run, or a manual
// regenerate. The strain/CTL-ATL projection downstream is still recomputed on each open, so the
// numbers track today's real fitness — only the prescribed sessions are frozen.
const weekPlanFile = (date: string) => `${FileSystem.documentDirectory}coach-week-plan-${date}.json`;

export interface WeekPlanCache {
  date:        string;        // the day it was generated for (YYYY-MM-DD)
  generatedAt: string;        // ISO
  lastRunDate: string;        // most recent run date at generation — the staleness signature
  days:        WeekPlanDay[];
}

export async function loadWeekPlanCache(date: string): Promise<WeekPlanCache | null> {
  try {
    const f = weekPlanFile(date);
    const info = await FileSystem.getInfoAsync(f);
    if (!info.exists) return null;
    const cache = JSON.parse(await FileSystem.readAsStringAsync(f));
    return cache && Array.isArray(cache.days) ? (cache as WeekPlanCache) : null;
  } catch { return null; }
}

export async function saveWeekPlanCache(cache: WeekPlanCache): Promise<void> {
  try { await FileSystem.writeAsStringAsync(weekPlanFile(cache.date), JSON.stringify(cache)); } catch { /* ignore */ }
}

// Read TODAY's slot from the most recent rolling 7-day plan generated on a PRIOR day (which therefore
// contains today). This keeps the daily plan consistent with the SPREAD week instead of recomputing a
// greedy single-day budget. Looks back up to 7 generation-days for a cached plan that covers `date`.
export async function loadTodaysWeekPlanSlot(date: string): Promise<WeekPlanDay | null> {
  const base = new Date(date + 'T00:00:00');
  const p = (n: number) => String(n).padStart(2, '0');
  for (let back = 1; back <= 7; back++) {
    const g = new Date(base); g.setDate(g.getDate() - back);
    const cache = await loadWeekPlanCache(`${g.getFullYear()}-${p(g.getMonth() + 1)}-${p(g.getDate())}`);
    const slot = cache?.days.find(d => d.date === date);
    if (slot) return slot;   // most-recent prior plan covering today wins
  }
  return null;
}

// Ensure TODAY's rolling 7-day plan is cached, so TOMORROW's daily plan can read today's-equivalent slot
// from it. Generated at most once per day (the 7-Day Plan screen refreshes it with a forecast + on new
// runs). No forecast here → heat factor 1; the screen refines later. Best-effort, never throws.
export async function ensureWeekPlanCached(snap: CoachSnapshot): Promise<void> {
  try {
    if (await loadWeekPlanCache(snap.date)) return;          // already cached today (screen or a prior call)
    const days = await getWeekPlan(snap);
    const lastRunDate = (snap.recentTimeOnFeet ?? []).filter(d => d.min > 0).map(d => d.date).pop() ?? snap.date;
    await saveWeekPlanCache({ date: snap.date, generatedAt: new Date().toISOString(), lastRunDate, days });
  } catch { /* best-effort */ }
}

function localTodayKey(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Invalidate TODAY's cached daily + week plan so they regenerate from freshly-recomputed load/strain
// (e.g. after a run is reclassified). The prescription LOG is left intact — it's the historical record
// run-analysis judges past runs against.
export async function clearTodayPlanCache(): Promise<void> {
  const k = localTodayKey();
  try { await FileSystem.deleteAsync(planFile(k), { idempotent: true }); } catch { /* ignore */ }
  try { await FileSystem.deleteAsync(weekPlanFile(k), { idempotent: true }); } catch { /* ignore */ }
}
