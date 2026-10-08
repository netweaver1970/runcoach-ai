/**
 * LLM training coach. Feeds the FULL daily picture — recovery, HRV/RHR vs baseline,
 * respiration, SpO₂, sleep & sleep debt, and the training-load history (CTL/ATL/TSB,
 * ACWR, recent strain) — to the configured model and asks for a session
 * recommendation grounded in current endurance-training science. Returns structured
 * JSON so the UI can render it and reconcile the advisable strain band.
 */
import * as FileSystem from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { callLLM, getLLMStatus, extractJsonObject, setUsageFeature } from './llm';
import { buildKnowledgePrompt, recordPrescription, readKnowledgeContent } from './coachFiles';
import { raceActive, getRaceWeekPlan, raceSlotForToday, getRaceConfig, fmtTime } from './racePlan';
import { fetchOurDailyComponents, fetchDailyDurationHistory, fetchDailyWorkDistanceHistory, fetchDailyRunWeatherHistory, fetchTrainingLoadHistory, loadSnapshotCache, getSnapshotVersion } from './healthkit';
import { getLocalWeather } from './weather';
import { getPowerZones, getLongRunMinutes, getEffectiveMaxHr } from './claude';
import { ensureZonesFile } from './zones';
import type { TrimpRates } from './trainingLoad';
import { activityCategory, heatStrainFactor, DEFAULT_HEAT_SENSITIVITY, setHeatSensitivityCache, prescribedTrimp, singleHrTrimp, isFloatZone, trainingDayKey, estimateDayTrimp } from './trainingLoad';
import { getSwitchList, regimeForDate, getAccountingMode, DEFAULT_ACCOUNTING, AccountingMode } from './accounting';
import { getAthleteStatus, loadEvents, buildTimelineContext } from './timelineEvents';
import { loadSupplements, buildSupplementContext } from './supplements';
import { DayStrain, ActivitySummary, RunWorkout } from '../types';

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
  // Most-recent WORK minutes per quality type (the true intensity dose) → the gradual, per-type work ramp
  // in synthesizeWorkout. Distinct from recentTimeOnFeet (which for intervals over-counts the work with
  // recovery jogs + warm-up/cool-down, so a ToF ramp alone can't cap the actual interval work).
  recentQualityWork?: { intervals?: number; tempo?: number };
  // Most-recent measured WORK-segment Banister TRIMP per quality type — the realised LOAD the quality dose
  // ramps from when the cap basis is 'trimp' (work-HR + work-duration, so recovery jogs don't dilute it).
  recentQualityTrimp?: { intervals?: number; tempo?: number; long?: number };
  // Time-on-feet (running minutes) — drives the alternation + rolling-volume rules.
  recentTimeOnFeet?: { date: string; min: number }[]; // last ~14 days (0 = no run)
  recentTof28?:      { date: string; min: number }[]; // last 28 days — week planner's max-of-N-weeks cap base
  heatByDate?:       Record<string, number>;          // date → heat factor experienced (week-planner heat-credit)
  tof7d?:            number;   // trailing 7-day running minutes (completed days only)
  tofPrev7d?:        number;   // the 7 days before that
  tofBudgetTodayMin?: number;  // max running MINUTES today under the rolling cap (distance cap → via pace)
  tofNextRunLabel?:  string;   // when a meaningful-length run next fits the cap, e.g. "Thu 26 Jun"
  tofNextRunInDays?: number;   // days until that — 0 = today's budget already allows it
  loadCapBasis?:     'tof' | 'distance' | 'trimp'; // what the +X% cap is measured on
  loadCapPct?:       number;   // the rolling increase cap % (default 10)
  ctlRampTarget?:    number;   // fitness ramp target, CTL points/week (null/undefined = off) — the week fill aims at it
  trimpRates?:       TrimpRates; // the athlete's CALIBRATED TRIMP/min (CTL's own units) — prices the ramp target
  rampBudget?:       RampBudget; // CTL ramp on → the 7-day LOAD budget (target / load so far / left) the daily cap uses
  recentLoad28?:     { date: string; load: number }[];   // daily training load (CTL units), last 28 days → the week planner's ramp budget
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
  // Overall athlete status + a compact life-events context (medical/holiday/travel).
  athleteStatus?:      'running' | 'injured' | 'sick' | 'holiday';
  athleteStatusUntil?: string;
  timelineContext?:    string;
}

export type CoachIntensity = 'rest' | 'easy' | 'moderate' | 'hard';
// Canonical session TYPE — the single source of truth for the UI label (home card / headline / watch),
// so a tempo carrying a Z4 "push" block is never mislabelled "Intervals" from its hardest zone.
export type SessionKind = 'intervals' | 'tempo' | 'long' | 'easy' | 'recovery';

// A structured running workout for the Apple Watch (WorkoutKit): warmup → drills →
// work/recovery blocks → cooldown. Null on rest days (no watch workout pushed).
export interface WatchWorkoutBlock {
  repeats:     number;          // how many work+recovery reps
  workMinutes: number;          // work-interval duration
  restMinutes: number;          // recovery duration (0 = continuous)
  hrZone?:     string;          // driving HR zone: Z1–Z5 (the WORK effort)
  recoveryZone?: string;        // the RECOVERY effort between reps: Z1 = jog/standing, Z3 = float — a load lever
  powerLowWatts?:  number;      // power window mapped from the HR zone (lower bound, watts)
  powerHighWatts?: number;      // upper bound, watts
  recoveryLowWatts?:  number;   // FLOAT only (Z2/Z3 recovery): its own, lower power window — the float goes to
  recoveryHighWatts?: number;   // the watch as a WORK step at these watts, so it counts as work, not rest
  paceLoSec?:  number;          // INDOOR/treadmill: work pace band, sec/km. Lo = FAST bound, Hi = SLOW bound.
  paceHiSec?:  number;          // Derived from trailing pace × zone factor (addBlockPace) — pace, not power/GPS.
  label?:      string;          // e.g. "tempo", "VO2"
}
export interface WatchWorkout {
  name:          string;        // weekday slot, e.g. "Mon" — overwrites that day's workout
  warmupMeters:  number;        // metres; 0 = OPEN goal (athlete-controlled) — from WorkoutStructure config
  drillsMinutes: number;        // small drills block after warmup (0 to skip)
  blocks:        WatchWorkoutBlock[];
  cooldownMeters: number;       // metres; 0 = OPEN goal — from WorkoutStructure config
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
  genReadiness?: number;     // readiness (0–100) when generated — morning plans use STALE (yesterday's) readiness
                             // before overnight HRV/sleep lands; refresh once it crosses the green (≥60) gate
  shrinkForced?: boolean;    // shrink-to-fit placed this quality on its day OVER the cap → skip the budget/cap refresh checks
  rampHeld?: boolean;        // a FITNESS-RAMP week slot honoured over the daily +cap% budget → same refresh exemption
  coachEdited?: boolean;     // the athlete APPROVED a chat-coach proposal → never auto-regenerate over it (only ↻ Regenerate)
  sessionKind?: SessionKind; // canonical type → drives the honest UI label (not the workout's hardest zone)
  prescribedLoad?: number;   // derived readout: the session's prescribed Banister TRIMP (impact), incl. warm-up/cool-down
  secondSession?: {          // present ONLY on a split long run — the day's Part 2 (a later easy/Z2 run)
    runMinutes: number;
    workout: WatchWorkout | null;
    label: string;           // e.g. "Long run — Part 2"
    earliestAfterHrs?: number; // suggested gap before Part 2 (glycogen/partial recovery), e.g. 4
  } | null;
  optional2nd?: boolean;     // this run is an OPTIONAL post-completion top-up (not auto-pushed to the watch)
  sessionComplete?: boolean; // today's prescribed session is DONE → this rest plan is final for the day (never re-prescribe a run)
}

// A cached plan goes stale when the day's conditions drift from when it was written:
// the apparent temperature (heat changes the strain a session causes) or the strain
// already accumulated today (which moves the remaining advisable budget).
const TEMP_DRIFT_C = 4;
const STRAIN_DRIFT = 10;
export function planNeedsRefresh(plan: CoachPlan, snap: CoachSnapshot): boolean {
  // An APPROVED chat-coach edit is the athlete's deliberate choice (e.g. Achilles → walk recoveries, capped
  // power). Weather/readiness drift must NOT silently regenerate it away — that would undo a modification
  // made for an injury without the athlete noticing. Only an explicit ↻ Regenerate replaces it.
  if (plan.coachEdited) return false;
  // Today's prescribed session is already DONE → this rest plan is FINAL for the day. Never regenerate it back
  // into a run (that's the "home says rest, Daily Coach says do the intervals" split: one screen's fresh scan
  // saw the completed run, the other's stale time-on-feet didn't and re-prescribed). Once ANY screen writes the
  // completion rest, every screen loads it and holds it. The manual ↻ Regenerate still bypasses this.
  if (plan.sessionComplete) return false;
  const nowTemp = snap.weather?.apparentC ?? snap.weather?.tempC;
  // A plan from before conditions-tracking has no genTempC — refresh it once so it
  // picks up the current weather (and gets stamped for future drift checks).
  if (nowTemp != null && plan.genTempC == null) return true;
  if (plan.genTempC != null && nowTemp != null && Math.abs(nowTemp - plan.genTempC) >= TEMP_DRIFT_C) return true;
  if (plan.genStrain != null && snap.strainReal != null && Math.abs(snap.strainReal - plan.genStrain) >= STRAIN_DRIFT) return true;
  // A plan from before readiness-tracking has no genReadiness — refresh it once so it picks up today's
  // readiness (and gets stamped for future flip checks). Mirrors the genTempC bootstrap above; without it,
  // TODAY's already-cached (pre-upgrade) eased plan would never self-correct.
  if (snap.readiness != null && plan.genReadiness == null) return true;
  // A plan from before the canonical-kind upgrade has no sessionKind — refresh once so it picks up the
  // honest label + the tempo≤Z3 clamp + split support. Every regenerated plan now stamps sessionKind, so
  // this fires at most once (self mode only — coach mode returns before planNeedsRefresh).
  if (plan.intensity !== 'rest' && plan.sessionKind == null) return true;
  // The "optional 2nd run" concept was retired — any plan still carrying that flag is STALE (from an older
  // build) and must regenerate to the current logic ("session done → recover"). Fires at most once: the new
  // plan never sets optional2nd, so it can't loop.
  if (plan.optional2nd) return true;
  // COMPLETION: today's prescribed run is now essentially DONE (you ran ≥70% of it). Regenerate so the plan
  // becomes "session done → recover" instead of re-offering the session you just did — the "2nd run ghost".
  // Skipped once the plan is already a rest (no re-loop).
  const doneToday = (snap.recentTimeOnFeet ?? []).find(d => d.date === snap.date)?.min ?? 0;
  // Floor is 10, not 15: time-on-feet is WORK-accounting (warm-up/recovery/cool-down excluded), so a fully
  // completed INTERVALS session counts only its work+drills minutes (~13 for a 14-min prescription) and a
  // 15-min floor made a short quality session impossible to mark done — the coach kept re-offering it.
  if (plan.intensity !== 'rest' && !plan.secondSession
      && doneToday >= Math.max(10, Math.round((plan.runMinutes ?? 0) * 0.7))) return true;
  // Readiness crossed the green (≥60) gate since the plan was written. The morning plan is often built on
  // STALE readiness — yesterday's recovery, because last night's HRV/sleep hasn't landed yet — so a scheduled
  // tempo/intervals day gets eased to "easy Z2" (green=false). Once today's recovery is in and readiness goes
  // green, the fresh compute is the real quality session. This is THE fix for the home + Daily Coach showing a
  // stale eased plan all day (planNeedsRefresh previously never re-checked readiness). Symmetric: green→red re-eases.
  if (plan.genReadiness != null && snap.readiness != null
      && (plan.genReadiness >= 60) !== (snap.readiness >= 60)) return true;
  // Budget / cap-flip checks — SKIPPED for a shrink-to-fit / race plan that intentionally holds a session
  // over the cap (otherwise it would refresh forever against its own over-budget minutes). EXCEPTION: once
  // you've actually RUN today, the forced session is DONE → re-check so it can't keep prescribing another
  // run (the phantom-2nd-run bug — force-placed this morning at todayDone 0, then you ran).
  const todayRunMin = (snap.recentTimeOnFeet ?? []).find(d => d.date === snap.date)?.min ?? 0;
  if (!(plan.shrinkForced || plan.rampHeld) || todayRunMin >= 8) {
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
  const md = await readKnowledgeContent('running-schedule').catch(() => '');
  const tmpl = parseWeeklyTemplate(md), cm = parseWeeklyCommitments(md);
  const dow = new Date(snap.date + 'T00:00:00').getDay();
  // Never force a quality session onto a standing-commitment day (or the day after a hard one).
  if (cm[dow] || (cm[(dow + 6) % 7]?.hard && cm[(dow + 6) % 7]?.certain)) return false;
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
is appropriate for your call (e.g. "strain 7% is below your target band, which is right given low recovery — \
rest"). Use the exact strainReal figure; never invent a different number, and do NOT restate the band's \
numeric bounds (the readiness card already shows them live — repeating a baked copy just drifts out of sync). \ SpO₂ note: brief overnight dips to \
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
(near strainHigh): one or more work blocks (reps × workMinutes, with restMinutes recovery). The warm-up, \
cool-down and drills that wrap the work are applied AUTOMATICALLY from the athlete's own settings — design \
ONLY the work blocks (warmupMeters/cooldownMeters/drillsMinutes you send are ignored). Choose reps/durations so total \
running stays ≤ tofBudgetTodayMin yet reaches the upper band. The HR ZONE + duration + structure are the DRIVING \
facts: set each block's hrZone (Z1–Z5) and the matching powerLowWatts/powerHighWatts by reading them straight \
from the "Power & HR Zones" table in the COACHING KNOWLEDGE above (that table is calibrated from real runs — use \
its watt ranges, do not invent them). If no zones table is present, omit power. Set each multi-rep block's \
recoveryZone: "Z0"/"Z1" for a walk/jog rest, "Z2"/"Z3" for a FLOAT (easy running between reps). A float is \
counted as WORK — it goes to the watch as a work step at its own lower watts and its minutes count toward \
tofBudgetTodayMin — so only choose it when you intend that extra running. If intensity is "rest", set \
workout to null (no watch workout).\n\nLONG RUN: when plannedSessionKind is "long", the session is a LONG RUN — ONE continuous aerobic \
block at Z2, no reps, no recovery, and NEVER a Z3+ effort. Its purpose is uninterrupted aerobic time, not \
threshold work; a broken tempo-style structure will be REJECTED and replaced. Length may be trimmed to the \
budget, but the shape stays continuous.`;

const OUTPUT = `Return ONLY minified JSON, no markdown, with EXACTLY these keys: \
{"headline":string,"session":string,"strength":string,"intensity":"rest"|"easy"|"moderate"|"hard","runMinutes":number,"rationale":string,"cautions":string,\
"workout":null OR {"warmupMeters":600,"drillsMinutes":number,"blocks":[{"repeats":number,"workMinutes":number,"restMinutes":number,"hrZone":"Z1".."Z5","recoveryZone":"Z0".."Z3","powerLowWatts":number,"powerHighWatts":number,"label":string}],"cooldownMeters":600}}. \
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
// A block's label is a SHORT tag ("intervals", "tempo", "VO2") shown AFTER the computed structure line —
// not a second structure. The LLM sometimes writes a verbose "8× 3min @ …W, 90s reco" label that then
// duplicated + contradicted the computed line (worst after a rep ± edit: computed 6× vs a stale label 8×).
// Strip anything structure-like (digits / × / @ / units / recovery words) down to a canonical zone tag.
export function cleanBlockLabel(raw: any, zone?: string): string | undefined {
  const s = raw ? String(raw).trim() : '';
  if (!s) return undefined;
  if (/\d|×|@|\bmin\b|\bW\b|reco|recover|float|jog/i.test(s)) {
    return zone === 'Z4' || zone === 'Z5' ? 'intervals' : zone === 'Z3' ? 'tempo' : undefined;
  }
  return s.slice(0, 24);
}

function parseWorkout(o: any, intensity: CoachIntensity, name: string): WatchWorkout | null {
  if (intensity === 'rest' || !o || typeof o !== 'object') return null;
  const rawBlocks = Array.isArray(o.blocks) ? o.blocks : [];
  const watts = (v: any) => { const n = num(v); return n != null ? Math.max(50, Math.min(700, Math.round(n))) : undefined; };
  // Clamp the workout to the session's rating: a moderate/tempo day is ≤ Z3, an easy day ≤ Z2 — the LLM
  // must not slip a Z4/Z5 "push" into a tempo (that read as "Intervals" on the home + violated the
  // same-rating rule). Only true intervals (intensity 'hard') may go Z4/Z5.
  const maxZone = intensity === 'hard' ? 5 : intensity === 'moderate' ? 3 : 2;
  const blocks: WatchWorkoutBlock[] = rawBlocks.slice(0, 8).map((b: any) => {
    const rawZone = typeof b?.hrZone === 'string' && /^Z[1-5]$/.test(b.hrZone) ? b.hrZone : undefined;
    const zone = rawZone && Number(rawZone[1]) > maxZone ? `Z${maxZone}` : rawZone;
    const downgraded = rawZone != null && zone !== rawZone;   // watts belong to the OLD zone → drop, ensureBlockPower refills
    return {
      repeats:     Math.max(1, Math.min(30, Math.round(num(b?.repeats) ?? 1))),
      workMinutes: Math.max(0.5, Math.min(120, num(b?.workMinutes) ?? 5)),
      // Recovery between reps is a jog/float — ≤5 min, ever. The old ceiling of 30 let an LLM "30m jog"
      // hallucination through, turning a 35-min tempo into a 122-min session (2026-07-15).
      restMinutes: Math.max(0, Math.min(5, num(b?.restMinutes) ?? 0)),
      hrZone: zone,
      // Recovery TYPE survives the parse (it was silently dropped, so an LLM/chat-proposed float
      // arrived as a default Z1 jog): walk/jog rest vs float changes both the load AND, since a float
      // is pushed as a work step, whether those minutes count toward time-on-feet. Never above Z3.
      recoveryZone: typeof b?.recoveryZone === 'string' && /^Z[0-3]$/.test(b.recoveryZone) ? b.recoveryZone : undefined,
      powerLowWatts:  downgraded ? undefined : watts(b?.powerLowWatts),
      powerHighWatts: downgraded ? undefined : watts(b?.powerHighWatts),
      label: cleanBlockLabel(b?.label, zone),
    };
  }).filter((b: WatchWorkoutBlock) => b.workMinutes > 0);
  if (blocks.length === 0) return null;
  // Warm-up / cool-down / drills come from the athlete's WorkoutStructure config (0 = open goal) — a
  // structural preference that OVERRIDES whatever the LLM proposed for those wrapper phases.
  const st = workoutStructureCache;
  return {
    name,
    warmupMeters:  st.warmupMeters,
    drillsMinutes: st.drillsMinutes,
    blocks,
    cooldownMeters: st.cooldownMeters,
  };
}

/**
 * Public wrapper over parseWorkout for the CHAT COACH's proposals. Deliberately reuses the exact same
 * validation the LLM daily plan goes through — zone clamped to the session rating, restMinutes ≤ 5,
 * repeats/workMinutes bounded, warm-up/cool-down/drills taken from the athlete's own WorkoutStructure —
 * so a proposal can never smuggle in something the daily path would have rejected.
 */
export function buildProposedWorkout(o: any, intensity: CoachIntensity, name: string): WatchWorkout | null {
  return parseWorkout(o, intensity, name);
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
// Minimum watt spread for a power band. WorkoutKit TRAPS (fatalError: unsupportedRange) on a ZERO-WIDTH
// range, which kills the whole process — see the crash guard in RunCoachWorkoutModule.swift. That guard is
// the real backstop; this keeps a degenerate band from being STORED in a cached plan in the first place
// (an LLM handing back one power target as both bounds, e.g. 191/191, is what caused the 2026-07-18 loop).
const MIN_WATT_SPREAD = 6;
function widenPower(lo?: number, hi?: number): [number | undefined, number | undefined] {
  if (lo == null || hi == null || !(lo > 0) || !(hi > 0)) return [lo, hi];
  let l = Math.min(lo, hi), h = Math.max(lo, hi);
  if (h - l < MIN_WATT_SPREAD) { const mid = (l + h) / 2; l = Math.max(1, Math.round(mid - MIN_WATT_SPREAD / 2)); h = l + MIN_WATT_SPREAD; }
  return [l, h];
}

// ── Indoor / treadmill pace targets ───────────────────────────────────────────────────────────────────────
// Per-HR-zone pace multiplier RELATIVE to the athlete's trailing run pace (treated as the easy/Z2 anchor);
// faster (smaller ×) for higher zones. Used ONLY for indoor/treadmill runs where PACE — not power/GPS — is the
// dial. Derived, not calibrated: an estimate the runner fine-tunes on the belt.
const ZONE_PACE_FACTOR: Record<string, number> = { Z1: 1.08, Z2: 1.0, Z3: 0.92, Z4: 0.86, Z5: 0.80 };

/** Fill each block's pace band (sec/km; paceLoSec = FAST bound, paceHiSec = SLOW bound) = trailing pace ×
 *  zone factor, ±4%. `paceMinPerKm` is the athlete's recent median run pace (min/km, the easy anchor). */
export function addBlockPace(w: WatchWorkout | null, paceMinPerKm: number): WatchWorkout | null {
  if (!w || !(paceMinPerKm > 0)) return w;
  const baseSec = paceMinPerKm * 60;
  w.blocks = w.blocks.map(b => {
    const f = ZONE_PACE_FACTOR[b.hrZone ?? 'Z2'] ?? 1.0;
    const target = baseSec * f;
    return { ...b, paceLoSec: Math.round(target * 0.96), paceHiSec: Math.round(target * 1.04) };
  });
  return w;
}

/** Trailing median run pace (min/km) from recent real runs (≥8 min) — basis-independent, for treadmill pace
 *  targets. Falls back to ~6:00/km when there's no run history. */
export async function getTrailingPaceMinPerKm(): Promise<number> {
  try {
    const snap = await loadSnapshotCache();
    const paces = (snap?.runs ?? [])
      .filter(r => (r.pace ?? 0) > 0 && (r.duration ?? 0) >= 480)
      .slice(0, 12).map(r => r.pace).sort((a, b) => a - b);
    if (paces.length === 0) return 6;
    return paces[Math.floor(paces.length / 2)] / 60;   // median sec/km → min/km
  } catch { return 6; }
}

export function ensureBlockPower(w: WatchWorkout | null, pz?: CoachSnapshot['powerZones']): WatchWorkout | null {
  if (!w) return w;
  w.blocks = w.blocks.map(b => {
    let out = b;
    if (b.powerLowWatts && b.powerHighWatts) {
      const [l, h] = widenPower(b.powerLowWatts, b.powerHighWatts);
      if (l !== b.powerLowWatts || h !== b.powerHighWatts) out = { ...b, powerLowWatts: l, powerHighWatts: h };
    } else {
      const [lo, hi] = zoneToWatts(b.hrZone ?? 'Z2', pz);
      const [l, h] = widenPower(b.powerLowWatts ?? lo, b.powerHighWatts ?? hi);
      out = { ...b, powerLowWatts: l, powerHighWatts: h };
    }
    // A FLOAT recovery (Z2/Z3) is running work at a lower effort, so it needs its OWN watt window —
    // the watch pushes it as a work step with this band. A jog/walk rest (Z0/Z1) gets no band: it stays
    // a WorkoutKit .recovery step and, correctly, stays outside time-on-feet.
    if (out.restMinutes > 0 && isFloatZone(out.recoveryZone)) {
      const [rl, rh] = widenPower(...zoneToWatts(out.recoveryZone, pz));
      if (rl && rh) out = { ...out, recoveryLowWatts: rl, recoveryHighWatts: rh };
    }
    return out;
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
    // The float's own band is zone-keyed too — a Z2 float and a Z2 work block share watts.
    if (b.recoveryLowWatts && b.recoveryHighWatts && b.recoveryZone)
      byZone.set(b.recoveryZone, [b.recoveryLowWatts, b.recoveryHighWatts]);
  }
  target.blocks = target.blocks.map(b => {
    let out = b;
    if (!(b.powerLowWatts && b.powerHighWatts)) {
      const m = (b.hrZone && byZone.get(b.hrZone)) || anyPow;
      if (m) out = { ...out, powerLowWatts: m[0], powerHighWatts: m[1] };
    }
    // Without this the float loses its band → it would push as a plain .recovery step and drop out
    // of time-on-feet, silently, just because the athlete nudged the minutes.
    if (out.restMinutes > 0 && isFloatZone(out.recoveryZone) && !(out.recoveryLowWatts && out.recoveryHighWatts)) {
      const m = byZone.get(out.recoveryZone!);
      if (m) out = { ...out, recoveryLowWatts: m[0], recoveryHighWatts: m[1] };
    }
    return out;
  });
  return target;
}

// Fallback structured session when the LLM prescribes a run but omits the workout JSON.
// Maps the intensity to an HR zone + the matching watt window from the athlete's zones.
// ── Interval / tempo VARIETY, load-normalized ─────────────────────────────────
// The interval SHAPE rotates week to week (work zone, recovery TYPE, rep length) — for training variety and to
// stress different systems — but every variant is sized so its prescribedTrimp equals the plain default's, so
// changing the shape never silently changes how HARD the session is. TRIMP is the equalising currency: a short
// Z5 set with a Z3 float and a longer Z4 set with a jog recovery land at the SAME load, just fewer minutes for
// the sharper one. (Recovery DURATION isn't a load lever — see trainingLoad.prescribedTrimp — so variety comes
// from work zone + recovery TYPE, both of which move load; the minutes budget stays the guardrail.)
interface IntervalArchetype { work: number; workZone: string; rest: number; recoveryZone: string; label: string; }
const INTERVAL_ARCHETYPES: IntervalArchetype[] = [
  { work: 3,   workZone: 'Z4', rest: 2,   recoveryZone: 'Z1', label: 'intervals' },        // 0 — the classic default (unchanged)
  { work: 3,   workZone: 'Z5', rest: 2,   recoveryZone: 'Z1', label: 'VO₂ intervals' },    // 1 — higher intensity
  { work: 4,   workZone: 'Z4', rest: 1.5, recoveryZone: 'Z1', label: 'cruise intervals' }, // 2 — longer threshold reps
  { work: 3,   workZone: 'Z5', rest: 1.5, recoveryZone: 'Z3', label: 'VO₂ · float reco' }, // 3 — active (float) recovery
  { work: 1.5, workZone: 'Z5', rest: 1,   recoveryZone: 'Z1', label: 'short–sharp reps' }, // 4 — speed / neuromuscular
];

type StructShell = { warmupMeters: number; drillsMinutes: number; cooldownMeters: number };
const loadOf = (blocks: WatchWorkoutBlock[], st: StructShell): number =>
  prescribedTrimp({ warmupMeters: st.warmupMeters, drillsMinutes: st.drillsMinutes, blocks, cooldownMeters: st.cooldownMeters });

// Rep count for a rotated interval archetype whose prescribedTrimp best matches `targetLoad`, bounded by the
// minutes guardrail (reps × (work+rest) ≤ workBudget) and a sane 3–12. A sharper (Z5) variant needs fewer reps
// to reach the same load → it comes out SHORTER in minutes but equal in impact. That's the point.
function intervalBlocksForLoad(seed: number, targetLoad: number, workBudget: number, st: StructShell): WatchWorkoutBlock[] {
  const a = INTERVAL_ARCHETYPES[((seed % INTERVAL_ARCHETYPES.length) + INTERVAL_ARCHETYPES.length) % INTERVAL_ARCHETYPES.length];
  const per = a.work + a.rest;
  const maxReps = Math.max(3, Math.min(12, Math.floor((workBudget + a.rest) / per)));   // +rest: the last rep needs no trailing recovery
  let best = 3, bestErr = Infinity;
  for (let r = 3; r <= maxReps; r++) {
    const err = Math.abs(loadOf([{ repeats: r, workMinutes: a.work, restMinutes: a.rest, hrZone: a.workZone, recoveryZone: a.recoveryZone }], st) - targetLoad);
    if (err < bestErr) { bestErr = err; best = r; }
  }
  return [{ repeats: best, workMinutes: a.work, restMinutes: a.rest, hrZone: a.workZone, recoveryZone: a.recoveryZone, label: a.label }];
}

// Tempo variety: alternate the plain continuous Z3 threshold with broken "cruise intervals" (Z4 reps + a short
// Z2 float) sized to the SAME load — rep length searched to match, rep count from the budget.
function tempoCruiseForLoad(targetLoad: number, workBudget: number, st: StructShell): WatchWorkoutBlock[] {
  const reps = workBudget >= 28 ? 3 : 2;
  const rest = 2;                                                    // Z2 float between cruise reps
  const maxWork = Math.max(4, Math.floor((workBudget - (reps - 1) * rest) / reps));
  let best = Math.min(12, maxWork), bestErr = Infinity;
  for (let wmin = 4; wmin <= Math.min(12, maxWork); wmin++) {
    const err = Math.abs(loadOf([{ repeats: reps, workMinutes: wmin, restMinutes: rest, hrZone: 'Z4', recoveryZone: 'Z2' }], st) - targetLoad);
    if (err < bestErr) { bestErr = err; best = wmin; }
  }
  return [{ repeats: reps, workMinutes: best, restMinutes: rest, hrZone: 'Z4', recoveryZone: 'Z2', label: 'cruise intervals' }];
}

// Continuous-Z3 tempo whose length best matches `targetLoad` ('trimp' basis), bounded by the minutes guardrail.
function tempoContinuousForLoad(targetLoad: number, workBudget: number, st: StructShell): WatchWorkoutBlock[] {
  const hi = Math.max(8, Math.round(workBudget));
  let best = Math.min(hi, 20), bestErr = Infinity;
  for (let wmin = 8; wmin <= hi; wmin++) {
    const err = Math.abs(loadOf([{ repeats: 1, workMinutes: wmin, restMinutes: 0, hrZone: 'Z3', recoveryZone: 'Z2' }], st) - targetLoad);
    if (err < bestErr) { bestErr = err; best = wmin; }
  }
  return [{ repeats: 1, workMinutes: best, restMinutes: 0, hrZone: 'Z3', recoveryZone: 'Z2', label: 'tempo' }];
}

// Deterministic week index (fixed Monday epoch, stable within a week) → rotates session variety so consecutive
// interval/tempo WEEKS differ. mondayOf/PERIODIZATION_EPOCH are declared later but resolved at call time.
export function variantSeedFor(dateKey: string): number {
  const d = new Date(dateKey + 'T00:00:00');
  if (isNaN(d.getTime())) return 0;
  return Math.max(0, Math.round((mondayOf(d).getTime() - PERIODIZATION_EPOCH.getTime()) / (7 * 86_400_000)));
}

export function synthesizeWorkout(
  intensity: CoachIntensity, runMinutes: number, name: string,
  pz?: CoachSnapshot['powerZones'],
  kind?: 'intervals' | 'tempo' | 'long' | 'easy' | 'recovery',
  recentWorkMin?: number,   // most-recent same-TYPE session's WORK minutes → gradual TRUE-work-minutes ramp
  capPct?: number,          // rolling increase cap % (kept for signature compat; ramp lives in buildTypeRamp)
  variantSeed?: number,     // rotates the interval/tempo SHAPE (0 / even = classic default); load held constant
  targetLoad?: number,      // 'trimp' basis: the quality dose is sized to THIS Banister load (minutes stay the guardrail)
): WatchWorkout {
  // Warm-up / cool-down (0 = open) + drills length are the athlete's configured structure (WorkoutStructure).
  const st = workoutStructureCache;
  // Split `runMinutes` into its parts so the pieces sum back to it (accounting.ts). runMinutes carries the
  // COUNTED time-on-feet basis, which is WORK + DRILLS in both regimes (drills are never excluded); FULL
  // additionally folds the warm-up/cool-down into the counted session, WORK leaves them open + uncounted:
  //   • 'work'  — work = runMinutes − drills (warm-up/cool-down are OPEN additions, not in the budget).
  //   • 'full'  — work = runMinutes − drills − ~6 (the counted warm-up/cool-down).
  // So drills + work (+ warm/cool in full) == runMinutes, and the 7-day plan's printed structure reconciles
  // with the footer budget instead of under/over-shooting it.
  const reserve = (st.drillsMinutes || 0) + (accountingModeSync() === 'full' ? 6 : 0);
  const workBudget = Math.max(8, (runMinutes || 35) - reserve);
  // TYPE-aware structure — the session TYPE, not just the effort tier, decides the shape (so a Long
  // run is a long Z2 run, a Tempo is sustained Z3, only Intervals are short Z4/Z5 reps). Falls back to
  // the intensity when no kind is given (legacy callers like the daily plan's fallback).
  const t = kind ?? (intensity === 'hard' ? 'intervals' : intensity === 'moderate' ? 'tempo' : 'easy');
  const seed = variantSeed ?? 0;
  let blocks: WatchWorkoutBlock[];
  if (t === 'intervals') {
    const WORK_MIN = 3;
    let reps = Math.max(4, Math.min(8, Math.round(workBudget / 5)));
    // TRUE-WORK-MINUTES ramp: intervals grow by AT MOST +1 rep vs the most-recent interval session. A %
    // cap can't move a discrete rep (4×3→5×3 is +25%), so +1 rep/session is the gradual "no huge jumps"
    // step — it climbs a rep at a time over the weeks and self-holds once the base stops rising. No
    // interval history → the base-derived reps (floor 4) as the first dose.
    if (recentWorkMin != null && recentWorkMin > 0) {
      const recentReps = Math.max(1, Math.round(recentWorkMin / WORK_MIN));
      reps = Math.min(reps, recentReps + 1);
    }
    // The DEFAULT dose sets this session's TARGET LOAD; every rotated variant is sized to match it, so the
    // progression (load) is identical whatever shape the week is. In 'trimp' mode the target comes straight
    // from the load ramp (targetLoad, sized within the minutes guardrail); otherwise it's the +1-rep minutes
    // dose expressed as load.
    const defBlocks: WatchWorkoutBlock[] = targetLoad != null
      ? intervalBlocksForLoad(0, targetLoad, workBudget, st)          // load drives the dose (default shape, sized to load)
      : [{ repeats: reps, workMinutes: WORK_MIN, restMinutes: 2, hrZone: 'Z4', recoveryZone: 'Z1', label: 'intervals' }];
    const target = targetLoad ?? loadOf(defBlocks, st);
    blocks = (seed % INTERVAL_ARCHETYPES.length === 0)
      ? defBlocks                                                     // variant 0 = the classic shape, EXACTLY as before ('tof' seed 0)
      : intervalBlocksForLoad(seed, target, workBudget, st);
  } else if (t === 'tempo') {
    // Continuous threshold: the tempo work IS the session (minus warm-up/cool-down/drills). In 'tof' mode the
    // length is the ToF ramp (buildTypeRamp); in 'trimp' mode it's sized to targetLoad (≤ minutes guardrail).
    // Odd weeks swap in broken cruise intervals at the SAME load for variety.
    const defBlocks: WatchWorkoutBlock[] = targetLoad != null
      ? tempoContinuousForLoad(targetLoad, workBudget, st)
      : [{ repeats: 1, workMinutes: Math.max(8, workBudget), restMinutes: 0, hrZone: 'Z3', recoveryZone: 'Z2', label: 'tempo' }];
    const target = targetLoad ?? loadOf(defBlocks, st);
    blocks = (seed % 2 === 0)
      ? defBlocks                                                     // even weeks = ONE continuous threshold block
      : tempoCruiseForLoad(target, workBudget, st);                   // odd weeks = broken cruise intervals, same load
  } else { // long / easy / recovery → ONE continuous aerobic block at Z2
    blocks = [{ repeats: 1, workMinutes: Math.min(150, workBudget), restMinutes: 0, hrZone: 'Z2', label: t === 'long' ? 'long' : 'aerobic' }];
  }
  return ensureBlockPower({ name, warmupMeters: st.warmupMeters, drillsMinutes: st.drillsMinutes, blocks, cooldownMeters: st.cooldownMeters }, pz)!;
}

// ── Threshold test ────────────────────────────────────────────────────────────
// A 20-minute maximal-but-even effort, used to MEASURE threshold power + HR rather than to train.
// Deliberately carries NO power target and NO hrZone: every other session reads its watts from the
// athlete's power zones, but this session exists precisely because those zones are unvalidated —
// pushing a PowerRangeAlert would cap the effort at the number the test is meant to discover. It must
// therefore never be passed through ensureBlockPower (which would fill watts from the zone table).
export const THRESHOLD_TEST_MIN = 20;
export const THRESHOLD_TEST_NAME = 'Threshold test';
export function thresholdTestWorkout(name: string, target?: { low: number; high: number } | null): WatchWorkout {
  const st = workoutStructureCache;
  return {
    name,
    // A test needs a real warm-up; the athlete's configured one is used when it's long enough,
    // otherwise an open goal (0) so they can take as long as they need.
    warmupMeters:  st.warmupMeters >= 1500 ? st.warmupMeters : 0,
    drillsMinutes: st.drillsMinutes,
    blocks: [{
      repeats: 1,
      workMinutes: THRESHOLD_TEST_MIN,
      restMinutes: 0,
      // PACING TARGET on the watch. Originally the test carried NO power target — the reasoning was that a
      // PowerRangeAlert would "cap" the effort. That was wrong: the alert only nudges (haptic when you drift
      // out of band), it never stops you. And with no target the watch showed no power at all, so on the
      // 2026-07-27 test Geert went out blind, started too fast, and blew up before 20 min. A band derived
      // from his OWN best sustained effort (thresholdTestTarget) is exactly the pacing aid that prevents
      // that — hold it for 19 min, then ignore the alert and empty the tank in the last 60 s. He may exceed
      // it late; what calibrates the zones is HR-at-power, which we measure whatever he holds.
      ...(target && target.low > 0 && target.high > target.low
        ? { powerLowWatts: target.low, powerHighWatts: target.high }
        : {}),
      label: 'threshold test — even, maximal; last 60s all-out',
    }],
    cooldownMeters: st.cooldownMeters > 0 ? st.cooldownMeters : 0,
  };
}

/**
 * Suggested watt target for the test, from the athlete's OWN best sustained effort.
 *
 * The commonest way a first threshold test fails is going out too fast and fading — and a faded test
 * doesn't just waste the session, it writes a too-low threshold into the zones. A personal anchor beats
 * a generic "go hard": the best power already held for >= the test duration is a FLOOR the athlete knows
 * they can live with, so the target is that up to ~6% above it. Null when there's no qualifying effort
 * (then the UI just omits the line rather than inventing a number).
 */
export function thresholdTestTarget(
  runs: { workPower?: number; workDuration?: number }[],
): { low: number; high: number; heldMin: number } | null {
  let best: { w: number; min: number } | null = null;
  for (const r of runs ?? []) {
    const w = r.workPower ?? 0;
    const min = (r.workDuration ?? 0) / 60;
    if (w <= 0 || min < THRESHOLD_TEST_MIN) continue;      // only genuinely SUSTAINED efforts anchor it
    if (!best || w > best.w) best = { w, min: Math.round(min) };
  }
  if (!best) return null;
  return { low: best.w, high: Math.round(best.w * 1.06 / 5) * 5, heldMin: best.min };
}

// 'trimp' basis: the quality dose ramps on LOAD — +cap%/week off the most-recent measured same-type WORK
// TRIMP (or a nominal first dose). Returns undefined for non-quality types or a non-trimp basis, so intervals
// + tempo become load-driven while easy/long/recovery stay minutes-driven (the volume guardrail). The minutes
// budget still ceilings whatever load this asks for (synthesizeWorkout sizes within workBudget).
const NOMINAL_QUALITY_LOAD: Record<string, number> = { intervals: 70, tempo: 75 };
function qualityTargetLoad(snap: CoachSnapshot, sk: string, capPct: number): number | undefined {
  if (snap.loadCapBasis !== 'trimp' || (sk !== 'intervals' && sk !== 'tempo')) return undefined;
  const recent = sk === 'intervals' ? snap.recentQualityTrimp?.intervals : snap.recentQualityTrimp?.tempo;
  const base = recent && recent > 0 ? recent : NOMINAL_QUALITY_LOAD[sk];
  return Math.round(base * (1 + Math.max(capPct, SESSION_RAMP_MIN_PCT) / 100));   // quality dose keeps progressing under a low ramp cap
}

// Concise one-line structure for the daily plan, e.g. "3× 10min @ 180–205W + 2min jog" or "60min @ 205W".
// Work blocks only (warm-up/cool-down are implied); power range if present, else HR zone; recovery TYPE
// (jog / float) shown for multi-rep blocks so the week's variety is visible, not hidden in the zone number.
const recoveryWord = (zone?: string): string =>
  zone === 'Z3' || zone === 'Z2' ? 'float' : zone === 'Z0' ? 'walk' : 'jog';
export function formatWorkoutStructure(w?: WatchWorkout | null): string {
  if (!w?.blocks?.length) return '';
  const fmtMin = (m: number) => (m % 1 === 0 ? `${m}` : m.toFixed(1));
  const parts = w.blocks.map((b) => {
    const lo = b.powerLowWatts, hi = b.powerHighWatts;
    const pwr = lo && hi ? (lo === hi ? ` @ ${lo}W` : ` @ ${lo}–${hi}W`)
              : b.hrZone ? ` @ ${b.hrZone}` : '';
    const rep = b.repeats > 1 ? `${b.repeats}× ${fmtMin(b.workMinutes)}min` : `${fmtMin(b.workMinutes)}min`;
    const rlo = b.recoveryLowWatts, rhi = b.recoveryHighWatts;
    // A float carries its own (lower) watt band — show it, so the session reads as work at two efforts.
    const recoPwr = rlo && rhi ? ` @ ${rlo}–${rhi}W` : '';
    const reco = b.repeats > 1 && b.restMinutes > 0
      ? ` / ${fmtMin(b.restMinutes)}min ${recoveryWord(b.recoveryZone)}${recoPwr}` : '';
    return `${rep}${pwr}${reco}`;
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
  commitment?: string; // standing commitment on this day (e.g. "dancing") — lets the UI find the day to offer the "not this week" toggle, whatever weekday it falls on
  capRest?: boolean;   // rested ONLY because the rolling +cap% was full (not schedule/commitment) — the ramp fill may use it
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
  // Gap-fill: the FALLBACK is only for a file that yielded NOTHING (unreadable/empty). Once the athlete's
  // file has defined any day, an unmatched weekday must fall back to 'flex' — never to a quality kind.
  // FALLBACK_TEMPLATE[5] is 'long', so the old blanket fill INVENTED a Friday long run whenever that line
  // failed to parse, and no amount of editing the schedule could remove it.
  const parsedAny = Object.keys(out).length > 0;
  for (let d = 0; d < 7; d++) if (out[d] === undefined) out[d] = parsedAny ? 'flex' : FALLBACK_TEMPLATE[d];
  return out;
}

// ── Recurring NON-RUNNING commitments (dance class, football, gym…) ──────────────────────────────────
// A standing weekly commitment is training load the planner has to schedule AROUND, not just react to
// after the fact. Written on the same running-schedule line, e.g. "- Thu: rest + dancing (evening)".
// `hard` marks the impact-heavy ones: they also protect the FOLLOWING day, because that is when the legs
// pay for them. Running sessions listed on the same line still parse normally — this is additive.
export interface WeeklyCommitment { label: string; hard: boolean; certain: boolean }
const COMMITMENTS: { re: RegExp; label: string; hard: boolean }[] = [
  { re: /\bdanc(e|ing)\b/i,                     label: 'dancing',    hard: true  },
  { re: /\bfootball|soccer|basketbal|tennis|padel|squash\b/i, label: 'team sport', hard: true },
  { re: /\bclimb(ing)?|bouldering\b/i,          label: 'climbing',   hard: true  },
  { re: /\bgym|strength|weights|crossfit\b/i,   label: 'gym',        hard: true  },
  { re: /\bswim(ming)?|yoga|pilates|cycl(e|ing)|spinning\b/i, label: 'cross-training', hard: false },
];
/** weekday → recurring commitment, parsed from the same schedule file the template comes from. */
export function parseWeeklyCommitments(text: string): Record<number, WeeklyCommitment> {
  const out: Record<number, WeeklyCommitment> = {};
  for (const line of (text ?? '').split('\n')) {
    const m = line.match(/\b(mon|tue|wed|thu|fri|sat|sun)\b/i);
    if (!m) continue;
    const dow = DOW_IX[m[1].toLowerCase()];
    if (out[dow]) continue;                       // first mention per weekday wins, like the template
    const hit = COMMITMENTS.find(c => c.re.test(line));
    // "every week"/"weekly" marks a commitment you ALWAYS keep. Without it the commitment is treated as
    // occasional: the planner reserves the day itself (so there's space for it) but does NOT pre-emptively
    // protect the following day, which would otherwise cost two days a week for a night you may not take.
    // The day-after easing then comes from the ACTUAL logged session — it lands in strain/recentActivities
    // and the daily coach already eases the next run off tired legs.
    if (hit) out[dow] = { label: hit.label, hard: hit.hard, certain: /\bevery week\b|\bweekly\b/i.test(line) };
  }
  return out;
}

// ── SHAPE ENVELOPE — who decides what ─────────────────────────────────────────
// Three layers, deliberately separated:
//   1. YOU pick the session TYPE per weekday (running-schedule.md → parseWeeklyTemplate).
//   2. The DETERMINISTIC model turns that into a DOSE — total duration and total load — from the ToF
//      budget, the ramp caps, recovery/TSB, heat and periodization.
//   3. The LLM may vary the EXECUTION within that dose (rep length × count, recovery type, ordering).
//
// This envelope is what makes layer 3 safe. Duration and load alone are NOT enough to pin a session's
// identity: on 2026-07-24 the model shipped 10min Z2 + 3×8min Z3 + 5min Z2 against a deterministic
// 54min Z2 long run, and the two scored 80 vs 81 TRIMP — one point apart. Load is a scalar that
// collapses duration × intensity, so many different sessions map to the same number. That is exactly
// why it works as a dose currency and exactly why it cannot tell a long run from a tempo. Session
// identity lives in the DISTRIBUTION of intensity, so the distribution is what we constrain.
//
// The bounds must admit every archetype the deterministic engine itself produces (INTERVAL_ARCHETYPES,
// tempoCruiseForLoad, tempoContinuousForLoad, the continuous Z2 long) — otherwise the fallback would be
// rejected by its own rule. There is a harness check for exactly that.
// How far the LLM's execution may drift from the deterministic dose before it's rejected.
export const DOSE_MIN_TOL  = 0.10;   // total work+recovery minutes, ±10%
export const DOSE_LOAD_TOL = 0.15;   // prescribed Banister TRIMP, ±15%

export interface ShapeEnvelope {
  zones:     string[];   // work zones this KIND may use
  maxBlocks: number;     // distinct block entries
  maxReps:   number;     // total reps summed across blocks
  repMin:    [number, number];   // per-rep work minutes, [min, max]
  maxRest:   number;     // recovery minutes between reps (0 = must be continuous)
}
export const SHAPE_ENVELOPE: Record<string, ShapeEnvelope> = {
  // The long run's job is uninterrupted aerobic time — one block, no reps, no recovery.
  long:      { zones: ['Z1', 'Z2'],             maxBlocks: 1, maxReps: 1,  repMin: [12, 180], maxRest: 0 },
  easy:      { zones: ['Z1', 'Z2'],             maxBlocks: 2, maxReps: 2,  repMin: [8, 150],  maxRest: 0 },
  recovery:  { zones: ['Z1', 'Z2'],             maxBlocks: 1, maxReps: 1,  repMin: [5, 60],   maxRest: 0 },
  // Sustained threshold: few long efforts, short recoveries (cruise intervals live here).
  // Bounds are generous at the top: a continuous block IS the session for these kinds, so the ceiling
  // only has to exclude nonsense (verified against every archetype x seed x length in the harness).
  // tempoContinuousForLoad builds ONE continuous block whose length just tracks the run length, so the
  // ceiling only has to sit above anything the schedule can ask for (real tempo days here are 20-60 min). The Z3 zone floor — not the rep length — is what separates this from a long run.
  tempo:     { zones: ['Z2', 'Z3', 'Z4'],       maxBlocks: 3, maxReps: 6,  repMin: [4, 150],  maxRest: 3 },
  // Short hard reps with real recovery.
  intervals: { zones: ['Z3', 'Z4', 'Z5'],       maxBlocks: 3, maxReps: 12, repMin: [1, 10],   maxRest: 5 },
};

/** null when the blocks fit the kind's envelope, else a short human reason (logged, not shown). */
export function shapeFits(kind: string | undefined, blocks?: WatchWorkoutBlock[] | null): string | null {
  const env = SHAPE_ENVELOPE[kind ?? ''];
  if (!env || !blocks?.length) return null;              // unknown kind → don't constrain
  if (blocks.length > env.maxBlocks) return `${blocks.length} blocks > ${env.maxBlocks}`;
  let reps = 0;
  for (const b of blocks) {
    const r = Math.max(1, b.repeats ?? 1);
    reps += r;
    const z = b.hrZone ?? 'Z2';
    if (!env.zones.includes(z)) return `${z} not allowed for ${kind}`;
    if (b.workMinutes < env.repMin[0] || b.workMinutes > env.repMin[1]) return `rep ${b.workMinutes}min outside ${env.repMin.join('-')}`;
    if ((b.restMinutes ?? 0) > env.maxRest) return `rest ${b.restMinutes}min > ${env.maxRest}`;
  }
  if (reps > env.maxReps) return `${reps} reps > ${env.maxReps}`;
  return null;
}

// ── PROGRESSIVE OVERLOAD, per session TYPE (no jumps) ─────────────────────────
// Each session type ramps its duration from WHERE IT RECENTLY WAS, capped at +cap%/week, toward its target.
// Weekday ≈ type (the schedule fixes Mon=intervals, Fri=long, …), so we baseline each day's ramp on the recent
// MAX time-on-feet for that weekday. This stops the coach jumping a type straight to its full target (the
// "daunting" week) — it climbs over several weeks and self-holds at target once reached (the min() cap). The
// same +cap% ToF ceiling drives it, so it's one knob. The LONG additionally never jumps > LONG_STEP_MAX min/wk
// (a %-cap alone lets a big long jump too far — a joint-protecting backstop, dormant at 10%).
const RAMP_LONG_STEP_MAX = 10;
const RAMP_LONG_STEP_BUILD = 14;   // BUILD week: let the long climb a little faster toward its target (still a backstop)
// Map a logged run label onto the planner's session kinds, so the ramp can key off the TYPE actually run.
function kindOfRunType(t: string | undefined): WeekKind | null {
  const s = (t ?? '').toLowerCase();
  if (!s) return null;
  if (s.includes('interval')) return 'intervals';
  if (s.includes('tempo') || s.includes('threshold')) return 'tempo';
  if (s.includes('long')) return 'long';
  if (s.includes('z2') || s.includes('recovery') || s.includes('easy')) return 'easy';
  return null;
}
export function buildTypeRamp(
  recentTof: { date: string; min: number }[] | undefined,
  recentRuns: { date: string; type: string }[] | undefined,
  capPct: number,
) {
  // Baseline = the MOST RECENT session of the SAME TYPE. This used to key off the WEEKDAY on the assumption
  // "weekday ≈ type", which silently breaks the moment the athlete reorganises the week: moving the long run
  // to a day that previously held short Z2s ramped the long off those short runs and capped it far too low.
  // recentRuns carries the logged label per date, so we join on that and fall back to the weekday only when
  // the type is unknown (older entries / non-run days).
  const byKind = new Map<WeekKind, number>();
  const byDow = new Map<number, number>();
  const typeByDate = new Map<string, string>();
  for (const r of (recentRuns ?? [])) typeByDate.set(r.date.slice(0, 10), r.type);
  for (const e of (recentTof ?? [])) {
    if (!((e.min ?? 0) > 0)) continue;
    byDow.set(new Date(e.date + 'T00:00:00').getDay(), e.min);          // chronological → last one wins
    const k = kindOfRunType(typeByDate.get(e.date.slice(0, 10)));
    if (k) byKind.set(k, e.min);
  }
  return (dow: number, fullBase: number, isLong: boolean, kind?: WeekKind, buildWeek = false): number => {
    // Type-keying applies to the QUALITY kinds only. 'easy' covers everything from a 20-min recovery jog to
    // a 45-min Z2, so keying it by type collapses every easy day onto whichever of those ran most recently
    // — one short recovery run then caps the whole week's aerobic volume (observed: 280 → 233 min/wk).
    // Easy keeps the per-weekday baseline; easyGrow already grows easy volume against the budget.
    const typed = kind && kind !== 'easy' && kind !== 'flex' ? byKind.get(kind) : undefined;
    const recent = typed ?? byDow.get(dow) ?? 0;
    if (recent <= 0) return Math.min(fullBase, isLong ? 45 : 30);   // no recent history → conservative first dose
    let cap = recent * (1 + capPct / 100);
    if (isLong) cap = Math.min(cap, recent + (buildWeek ? RAMP_LONG_STEP_BUILD : RAMP_LONG_STEP_MAX));   // long: absolute per-week jump backstop (a touch higher on build weeks)
    return Math.min(fullBase, Math.round(cap));
  };
}

export async function getWeekPlan(
  snap: CoachSnapshot,
  forecast?: { date: string; apparentC: number; humidity: number; description: string }[],
): Promise<WeekPlanDay[]> {
  // RACE MODE overrides the leisure template + cap: the LLM-designed race week IS the plan.
  if (await raceActive()) { const rw = await getRaceWeekPlan(snap); if (rw) return rw.days; }
  const today = new Date(snap.date + 'T00:00:00');
  const capPct = snap.loadCapPct ?? DEFAULT_LOAD_CAP_PCT;
  const typeRamp = buildTypeRamp(snap.recentTimeOnFeet, snap.recentRuns, Math.max(capPct, SESSION_RAMP_MIN_PCT));   // per-type progressive-overload cap (no jumps; ≥5 % even under a low CTL-ramp week cap)
  const periodization = await getPeriodization();  // build/deload cycle modulates each week's cap multiplier
  const MEANINGFUL = 20;
  const shrink = await getShrinkToFit();  // ON → a cap-blocked quality SHRINKS to fit its day instead of deferring
  const maxRunDays = await getMaxRunDays();  // cap the easy/flex mop-up so volume concentrates (default 5)
  // The forward week lays out the INTENDED structure. EVERY day here is tomorrow-or-later (today + 1 + i),
  // so TODAY's single readiness reading must NOT gate the whole week — doing so collapsed every quality day
  // (intervals/tempo/long) to Z2 whenever today happened to be red, AND made shrink-to-fit a no-op (its
  // placement branch lives inside the else of this gate). Readiness is a DAILY signal, not a week predictor:
  // plan the structure here; the DAILY plan (deterministicCoachPlan) applies the real gate each morning.
  const green = true;
  // Re-entry: ~no running in the last week (holiday/illness) → rebuild gently with EASY Z2 ONLY, never
  // quality. The daily plan refines each morning by that day's actual recovery; here we lay out the
  // intended easy-run days so the forecast doesn't either slam intervals or show an empty week.
  const reentry = (snap.tof7d ?? 0) < 30;
  const scheduleMd = await readKnowledgeContent('running-schedule').catch(() => '');
  const template = parseWeeklyTemplate(scheduleMd);
  // Freshness modulates the raw-sum ceiling (see freshnessCapFactor): the ACWR/TSB model has decay, the
  // rolling minutes sum does not, so two rest days move one and not the other. Computed PER-DAY inside the
  // loop below (freshDay) so a BUILD week relaxes it to accumulate load while a DELOAD week stays strict.
  // Standing weekly commitments (dance night, team sport…) — planned around, not just absorbed afterwards.
  const commitments = parseWeeklyCommitments(scheduleMd);
  const fxBy = new Map((forecast ?? []).map(f => [f.date, f]));
  const p = (n: number) => String(n).padStart(2, '0');

  // Seed the history with 28 days (dates kept) so the base can take the MAX over the last 3 comparable
  // weeks and heat-credit each day — matching the daily engine (computeTimeOnFeetPlan) so the 7-day
  // forecast's ceiling equals the budget the runner actually trains against. Falls back to the 14-day
  // series on older snapshots.
  const HIST = 28;
  const histSrc = (snap.recentTof28 && snap.recentTof28.length ? snap.recentTof28 : (snap.recentTimeOnFeet ?? []));
  const tof: number[] = histSrc.map(d => d.min);
  const tofDate: string[] = histSrc.map(d => d.date);
  while (tof.length < HIST) {
    tof.unshift(0);
    const f = tofDate.length ? new Date(tofDate[0] + 'T00:00:00') : new Date(today);
    f.setDate(f.getDate() - 1);
    tofDate.unshift(`${f.getFullYear()}-${p(f.getMonth() + 1)}-${p(f.getDate())}`);
  }
  tof.splice(0, tof.length - HIST); tofDate.splice(0, tofDate.length - HIST);
  const heatBy = snap.heatByDate ?? {};
  const clampCredit = (fac?: number) => Math.min(Math.max(1, fac ?? 1), HEAT_CREDIT_MAX);
  const creditedAt = (idx: number) => (tof[idx] ?? 0) * clampCredit(heatBy[tofDate[idx]]);

  // Shuffle state: a quality session the cap blocks on its template day is DEFERRED (FIFO) and
  // rescheduled onto the next budgeted, well-spaced flex day — so the runner's key sessions shift
  // FORWARD instead of vanishing, and the normal structure resumes as the rolling cap frees up.
  // Anything still deferred at week's end simply reappears in next week's recompute.
  const QMIN = 25;          // (shrink OFF) a quality needs ≥ this much budget to run on its day; below it → defer
  const SHRINK_FLOOR = 20;  // shrink-to-fit: tempo/intervals never shorter than this (still a real short quality)
  const SHRINK_TARGET = 28; // shrink-to-fit: cap tempo/intervals at ~this (≤30 min) so the week stays short + balanced
  const LONG_MIN = 45;      // shrink-to-fit: the long run is PROTECTED — never shrunk below this (keeps it a "long")
  const EASY_RESERVE = 35;  // headroom kept on a flex day before spending budget on an easy jog
  const EASY_MAX  = 60;     // PROGRESSIVE GROWTH: an easy/flex day GROWS toward the available budget (aerobic
  const EASY_MIN  = 20;     // …but never below this — a short easy day is still a real run (see easyGrow)
  const EASY_BASE = 35;     // volume) instead of a fixed jog — capped per-day so no single day spikes. The
  const QRESERVE  = 55;     // +cap% rolling cap + the green gate keep it controlled; QRESERVE is budget held
  //                           back per still-unplaced quality session so easy growth NEVER starves the week's
  //                           quality (incl. the long — verified in the harness: without it the long got squeezed out).
  const longTargetMin = await getLongRunMinutes().catch(() => 75);  // athlete's configured long-run length (not hardcoded 65)
  const minTSB = await getMinTSB().catch(() => -16);                 // the athlete's fatigue floor (for the trajectory-aware fill)
  const danceOff = await getDanceOffDates().catch(() => new Set<string>());   // dates marked "not dancing this week" → Thu frees up
  // MAINTENANCE FLOOR for BUILD weeks. A 4-on/1-off block only works if the build weeks actually build: a
  // "+cap% over recent" week can land BELOW the load that holds CTL (maintenance = CTL×7 in TRIMP), so a
  // fully-compliant build week detrains like a deload — and stacked with the real deload you get two easy
  // weeks in a row. So on a BUILD week (healthy, not re-entry) the weekly ceiling is floored at maintenance:
  // never prescribe a build week below what holds your fitness. Converted to the ToF basis via the easy
  // TRIMP/min rate (the week is mostly easy, so TRIMP/min ≈ that), and BOUNDED to +25%/wk over the recent
  // base so it stays a controlled ramp; the TSB floor + freshness cut remain the safety backstops above it.
  const easyTpm  = estimateDayTrimp('easy', 100) / 100 || 1.3;       // easy TRIMP per minute
  const maintMin = (snap.ctl && snap.ctl > 0) ? Math.round(snap.ctl * 7 / easyTpm) : 0;   // ToF-min that hold CTL
  // FITNESS RAMP target (CTL/wk): Geert chose (2026-10-05) that it WINS over the +cap% minutes guard, bounded at
  // +25 % minutes over the recent base. Only the load-aware PROGRESSIVE FILL chases it (it stops at the target
  // load, priced in the athlete's CALIBRATED TRIMP rates = CTL's own units); the main loop is untouched.
  const rampT    = snap.ctlRampTarget && snap.ctlRampTarget > 0 ? snap.ctlRampTarget : 0;
  // RAMP MODE (2026-10-08, Geert: "load, not minutes"): each day's room is the ramp's 7-day LOAD target minus the 6
  // days before it — real loads for past days, estimated loads for the days this plan places — instead of the +cap%
  // on minutes. With minutes, a 4 % day (after a high-load / low-minute week) rested Wednesday's tempo and the week
  // fell to +0.5 CTL. Same idea as the daily budget (rampLoadPlan; that one uses yesterday's CTL + a measured floor).
  // The fill's +25 % MINUTES bound stays (Geert, 2026-10-08: "keep +25%"). No ramp → unchanged.
  const rampRates = snap.trimpRates;
  const loadByDate = new Map((snap.recentLoad28 ?? []).map(d => [d.date, d.load]));
  const rampMode = rampT > 0 && loadByDate.size >= 7 && (snap.ctl ?? 0) > 0 && snap.loadCapBasis !== 'distance';
  const rampEasyTpm = (estimateDayTrimp('easy', 100, rampRates) / 100) || easyTpm;
  const rampFloorLoad = estimateDayTrimp('rest', 0, rampRates);
  // load history aligned with tof/tofDate; today = max(load so far, the background floor) — today itself is the daily
  // engine's call, the plan starts tomorrow
  const loadW: number[] = rampMode ? tofDate.map((dt, k) => {
    const v = loadByDate.get(dt) ?? 0;
    return k === tofDate.length - 1 ? Math.max(v, rampFloorLoad) : v;
  }) : [];
  const maintFloor = (gross: number, recentBase: number, isBuild: boolean) =>
    (isBuild && !reentry && maintMin > 0) ? Math.max(gross, Math.min(maintMin, Math.round(recentBase * 1.25))) : gross;
  // Grow an easy day to spend the SPARE budget (after reserving for quality still to place) up to EASY_MAX,
  // when green; hold at EASY_BASE when run-down or when there's no genuine surplus (never below EASY_BASE, so
  // it's always a real easy run — and never worse than the pre-growth fixed 35).
  const easyGrow = (allowance: number, maxCap: number = EASY_MAX) => {
    if (!green) return Math.max(EASY_MIN, Math.min(EASY_BASE, Math.round(allowance)));
    const reserve = Math.max(0, Qtotal - qPlaced) * QRESERVE;
    const spare = Math.round(allowance - reserve);
    // Grow into a genuine surplus; otherwise take what THIS day's allowance actually affords, down to
    // EASY_MIN. The old floor of EASY_BASE made every easy day cost ≥35 min whatever the budget, so at a
    // low weekly base (Geert: ~150 min/wk) only about four days fitted the week at all — the schedule
    // says every day may be a run day, but the arithmetic priced most of them out. A short easy day is a
    // real run; two 22-min days beat one 35-min day plus a forced rest.
    return spare > EASY_BASE
      ? Math.min(maxCap, spare)
      : Math.max(EASY_MIN, Math.min(EASY_BASE, Math.round(allowance)));
  };
  const EASY_MAX_BUILD = 80;   // BUILD-week push: let an easy/flex day absorb more of the surplus so the week
  //                              actually reaches the +cap% ceiling (per-type +10%/wk ramp still applies below).
  const isQuality = (k: WeekKind) => k === 'intervals' || k === 'tempo' || k === 'long';
  const resolveQuality = (k: WeekKind): [CoachIntensity, number] =>
    k === 'intervals' ? ['hard', 45] : k === 'long' ? ['moderate', longTargetMin] : ['moderate', 50];
  const qName = (k: WeekKind) => k === 'intervals' ? 'Intervals' : k === 'tempo' ? 'Tempo' : k === 'long' ? 'Long run' : 'Run';
  // Goal: fit ALL the week's quality TYPES (intervals + tempo + long) inside the rolling cap. Count
  // them; while any are still pending, recovery/flex days REST to BANK budget rather than burn it on an
  // easy jog — and a deferred quality may land on ANY later flex day, including the WEEKEND. Easy jogs
  // only fill once the quality is placed or the budget is plentiful.
  let Qtotal = 0;
  for (let i = 0; i < 7; i++) if (isQuality(template[(today.getDay() + 1 + i) % 7])) Qtotal++;
  let qPlaced = 0;
  let runDays = 0;                 // run days placed so far → caps the easy/flex mop-up at maxRunDays
  let lastQ = -99;                 // index of the last quality session placed (≥2 apart = spacing)
  const deferred: WeekKind[] = []; // quality kinds bumped by the cap, awaiting a later slot
  let weekCeiling = 0;             // the week's +cap% ToF ceiling (captured at day 0 for the progressive fill)
  // Quality sessions still to come this week (by forward index) — the maxRunDays gate on easy/jog days must
  // RESERVE a run-day slot for each, or filling easy days (esp. after a freed dance day) fills to the cap and
  // then the long/tempo pushes the week PAST it, leaving zero rest days. fwdKinds mirrors the loop's `kind`.
  const fwdKinds: WeekKind[] = [];
  for (let ii = 0; ii < 7; ii++) { const dd = new Date(today); dd.setDate(dd.getDate() + 1 + ii); fwdKinds.push(template[dd.getDay()] ?? 'rest'); }
  const pendingQualAfter = (idx: number) => { let n = 0; for (let k = idx + 1; k < 7; k++) if (isQuality(fwdKinds[k])) n++; return n; };
  const out: WeekPlanDay[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today); d.setDate(d.getDate() + 1 + i);
    const key = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const weekday = weekdayName(key);
    const fc = fxBy.get(key);
    const heat = fc ? heatStrainFactor({ apparentC: fc.apparentC, humidity: fc.humidity }) : 1;

    const phase = periodization.on ? cyclePhase(d, periodization).phase : 'off';   // 'off' ⇒ neither build nor deload (leisure)
    const buildWk = phase === 'build';
    const deloadDay = phase === 'deload';
    // A deload week trims QUALITY length too (long/tempo/intervals), not just the volume cap — else the Monday
    // long on a deload week shows full-length and the block never actually deloads. Easy days already shrink
    // via the cap (weekCapMultiplier 0.75 in `allowance`), so only quality is scaled here.
    const deloadScale = deloadDay ? Math.max(0.5, 1 - periodization.deloadDropPct / 100) : 1;
    // Per-day freshness (build weeks relax it — see freshnessCapFactor). Build weeks also earn one extra
    // easy run day so the recovery slot after a hard quality becomes an easy jog instead of a forced rest,
    // adding aerobic volume toward the ceiling without adding intensity.
    const freshDay = freshnessCapFactor(snap.tsb, snap.acwr, buildWk);
    const effMaxRunDays = buildWk ? maxRunDays + 1 : maxRunDays;
    const j = tof.length;
    // Base = MAX over the last BASE_WINDOWS 7-day blocks, each heat-credited (a hot/sick week can't drag
    // the ceiling down; a heat-cut run counts as its normal-conditions volume). Consumption (prior6) and
    // the re-entry gate (rawPrev7) stay RAW. Mirrors computeTimeOnFeetPlan so budget == forecast.
    let baseRef = 0;
    for (let w = 0; w < BASE_WINDOWS; w++) { let s = 0; for (let idx = j - 13 - 7 * w; idx <= j - 7 - 7 * w; idx++) s += creditedAt(idx); baseRef = Math.max(baseRef, s); }
    const prior6   = tof.slice(j - 6, j).reduce((a, b) => a + b, 0);
    const rawPrev7 = tof.slice(Math.max(0, j - 13), j - 6).reduce((a, b) => a + b, 0);
    // After a break the ceiling never drops below the restart floor (75% of pre-break, +cap%/wk; see restartVolumeFloor).
    const restartFloor = Math.round(restartVolumeFloor(d, periodization, capPct) * Math.min(1, freshDay));
    const grossCeil = Math.max(baseRef > 0 ? maintFloor(baseRef * weekCapMultiplier(d, periodization, capPct, BASE_WINDOWS > 1) * freshDay, baseRef, buildWk) : 0, restartFloor);
    let allowance = grossCeil > 0 ? Math.max(0, Math.round(grossCeil - prior6)) : 45;
    if (rawPrev7 < 30) allowance = Math.max(allowance, MEANINGFUL); // re-entry floor (matches computeTimeOnFeetPlan)
    if (rampMode) {
      // the ramp's LOAD room for this day (easy-minute equivalents); freshness may only shrink the increment
      // a DELOAD week keeps its cut: no ramp increment, maintenance × (1 − deloadDropPct)
      const targetL = deloadDay
        ? 7 * (snap.ctl ?? 0) * Math.max(0.5, 1 - periodization.deloadDropPct / 100)
        : 7 * ((snap.ctl ?? 0) + Math.max(0, Math.min(1, freshDay)) * rampT / CTL_WEEK_RESPONSE);
      const prior6L = loadW.slice(-6).reduce((a, b) => a + b, 0);
      allowance = Math.max(0, Math.round((targetL - prior6L) / rampEasyTpm));
    }
    // Capture the week's +cap% ToF ceiling from day 0 — RAW recent-max weekly ToF × the (periodization- and
    // freshness-adjusted) cap multiplier. Same number the Volume-vs-Budget budget shows; the progressive-fill
    // post-pass grows easy volume UP TO here so a compliant week reaches its ceiling instead of parking under it.
    if (i === 0) {
      // A SAFE progressive step: at most +cap% over the athlete's RECENT actual (max of the last 2 weeks) —
      // NOT the max-of-3 anti-erosion base, which can sit on a peak from weeks ago and would make the fill
      // jump volume 30%+ in one week. Take the higher of the last two weeks so a reduced/travel week doesn't
      // drop the target.
      const w1 = tof.slice(j - 7, j).reduce((a, b) => a + (b || 0), 0);
      const w2 = tof.slice(j - 14, j - 7).reduce((a, b) => a + (b || 0), 0);
      weekCeiling = Math.max(restartFloor, Math.round(maintFloor(Math.max(w1, w2) * weekCapMultiplier(d, periodization, capPct, BASE_WINDOWS > 1) * freshDay, Math.max(w1, w2), buildWk)));
      // ramp: the fill may grow up to +25 % minutes over the recent week (it stops once the CTL-target load is met)
      if (rampT > 0 && !deloadDay) weekCeiling = Math.max(weekCeiling, Math.round(Math.max(w1, w2) * 1.25));
    }

    const kind = template[d.getDay()];
    // A recurring commitment TODAY is itself a load, and a hard one (dance, team sport) also compromises
    // TOMORROW — that's when the legs pay for it. Both cases block quality so the week's hard days don't
    // stack against it; the session is DEFERRED rather than dropped, so the shuffle re-places it later.
    // "Not dancing this week": on a date the athlete marked no-dance, ignore that day's commitment (so Thu can
    // train — rest→jog on a build week) and don't treat the NEXT day as day-after-dance.
    const yd = new Date(d); yd.setDate(yd.getDate() - 1);
    const ydKey = `${yd.getFullYear()}-${p(yd.getMonth() + 1)}-${p(yd.getDate())}`;
    const commitToday = danceOff.has(key)   ? undefined : commitments[d.getDay()];
    const commitYday  = danceOff.has(ydKey) ? undefined : commitments[(d.getDay() + 6) % 7];
    const commitBlock = !!commitToday || !!(commitYday?.hard && commitYday?.certain);
    const spaced = (i - lastQ) >= 2 && !commitBlock; // ≥1 non-quality day since the last quality session
    let intensity: CoachIntensity = 'rest'; let base = 0; let placed: WeekKind = 'rest';
    let shifted = false, deferredHere = false, banked = false, shrunk = false, forcePlaced = false, restJog = false;
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
    } else if (kind === 'easy') {
      // Easy volume day — but only up to effMaxRunDays total, RESERVING a slot for each quality still to come
      // (else the week's easy days + the later long overrun the cap and leave no rest day).
      if (runDays + pendingQualAfter(i) < effMaxRunDays) { intensity = 'easy'; base = easyGrow(allowance, buildWk ? EASY_MAX_BUILD : EASY_MAX); placed = 'easy'; }
    }
    else if (kind === 'rest')   {
      // BUILD week only: a PLAIN rest day (never a commitment/dance rest) may become a SHORT easy recovery
      // jog when a run-day slot and budget remain — the "6th day" that lets a build actually accumulate
      // aerobic volume. Kept to a recovery length (≤35, then the type ramp trims a no-history day to ~30),
      // so it adds base miles without becoming a volume day. Deload/leisure weeks keep the rest.
      if (buildWk && !commitBlock && runDays + pendingQualAfter(i) < effMaxRunDays && allowance >= MEANINGFUL) {
        intensity = 'easy'; placed = 'easy'; restJog = true;
        base = Math.max(EASY_MIN, Math.min(35, allowance));
      } else { intensity = 'rest'; base = 0; }
    }
    else { // flex: MOP UP the spare budget with easy volume rather than banking it by resting. easyGrow already
      // reserves for pending quality (so easy can't starve the long/intervals), and the runner can always skip
      // or shorten — better to OFFER the aerobic volume than hoard it. Rest when the budget is spent OR the
      // week already has maxRunDays runs (concentrate volume into fewer, meaningful days).
      if (allowance < MEANINGFUL || runDays >= effMaxRunDays) { intensity = 'rest'; }
      else { intensity = 'easy'; base = easyGrow(allowance, buildWk ? EASY_MAX_BUILD : EASY_MAX); placed = 'easy'; }
    }
    if (intensity === 'hard' && (fc?.apparentC ?? 0) >= 24) intensity = 'moderate';    // ease a hot hard morning
    // PROGRESSIVE OVERLOAD: ramp this day's TYPE from where it recently was (+cap%/week), so it climbs toward
    // its target instead of jumping there. Applies to every run type (long gets the extra +10min/wk backstop).
    if (intensity !== 'rest') base = typeRamp(d.getDay(), base, placed === 'long', placed, buildWk);
    if (deloadDay && isQuality(placed)) base = Math.round(base * deloadScale);   // deload week: shorten the long/tempo/intervals too

    let capRest = false;
    // HARD cap gate (safety) — but shrink-to-fit's force-placed quality keeps its day even over budget.
    if (intensity !== 'rest' && allowance < MEANINGFUL && !forcePlaced) { intensity = 'rest'; capRest = true; }
    if (intensity === 'rest') placed = 'rest';
    if (intensity !== 'rest') runDays++;   // count this run day toward the maxRunDays cap
    const runMinutes = intensity === 'rest' ? 0 : base;
    const heatMin = intensity === 'rest' ? 0 : Math.max(8, Math.round(runMinutes / heat));
    // Force-placed quality counts its REAL minutes (so later days' budgets — esp. the long — see the true
    // load); otherwise the day's counted ToF is capped at the available allowance.
    tof.push(intensity === 'rest' ? 0 : forcePlaced ? heatMin : Math.min(heatMin, Math.max(MEANINGFUL, allowance)));
    tofDate.push(key);   // keep the date array aligned so the max-window base indexes correctly as the loop projects forward
    if (rampMode) loadW.push(intensity === 'rest' ? rampFloorLoad : estimateDayTrimp(intensity, runMinutes, rampRates));

    const isLong = placed === 'long';
    const structure = intensity === 'rest' ? 'Rest'
      : intensity === 'hard'     ? `${runMinutes}min incl. intervals`
      : intensity === 'moderate' ? `${runMinutes}min ${isLong ? 'long-ish aerobic' : 'tempo'}`
      :                            `${runMinutes}min easy @ Z2`;
    const note =
      // Commitment days explain themselves first — otherwise "deferred past the cap" reads as a volume
      // problem when the real reason is the standing commitment on the calendar.
      commitToday && intensity === 'rest'  ? `Rest — space kept for ${commitToday.label}` :
      commitToday                          ? `Easy — ${commitToday.label} tonight if you go` :
      commitYday?.hard && commitYday?.certain && intensity === 'rest' ? `Recovery — day after ${commitYday.label}` :
      commitYday?.hard && commitYday?.certain ? `Easy recovery — day after ${commitYday.label}` :
      restJog                         ? 'Easy recovery jog — build-week base miles' :
      reentry && intensity === 'easy' ? 'Easy Z2 — rebuilding after the break (recovery-gated)' :
      reentry                         ? 'Recovery day — rebuilding' :
      shifted                         ? `${qName(placed)} — rescheduled here as the cap freed up` :
      shrunk && placed === 'long'     ? 'Long run — protected (kept long on a tight week)' :
      shrunk                          ? `${qName(placed)} — shortened to hold its day (banks budget for the long)` :
      deferredHere                    ? `${qName(kind)} deferred past the ${rampMode ? 'ramp load target' : `+${capPct}% cap`}${intensity === 'rest' ? '' : ' — easy jog instead'}` :
      banked                          ? 'Recovery — banking volume for the week’s quality' :
      capRest && rampMode             ? `Cap rest — 7-day load at your +${rampT} CTL/week target` :
      capRest                         ? `Cap rest — 7-day volume at the +${capPct}% ceiling` :
      intensity === 'rest'            ? 'Recovery run or rest' :
      intensity === 'hard'            ? 'Intervals — keep it genuinely hard' :
      intensity === 'moderate'        ? (isLong ? 'Long-ish aerobic run' : 'Tempo / threshold') :
      kind === 'flex'                 ? 'Easy recovery jog' : 'Easy aerobic Z2';
    const runKm = intensity !== 'rest' && snap.loadUnit === 'km' && snap.paceMinPerKm
      ? Math.round((runMinutes / snap.paceMinPerKm) * 10) / 10 : undefined;
    out.push({ date: key, weekday, intensity, runMinutes, structure, note, kind: placed, forced: forcePlaced, runKm, commitment: commitments[d.getDay()]?.label, ...(capRest ? { capRest: true } : {}) });
  }

  // ── PROGRESSIVE FILL — trajectory-aware build instead of parking at maintenance ───────────────────────
  // The rolling per-day allowance is conservative: it reserves budget for still-unplaced quality and depletes
  // as the week fills, so the week routinely lands BELOW its own +cap% ceiling (repro'd from Geert's real
  // data: 202 min prescribed vs a 239 min ceiling — under maintenance, so a fully-compliant week didn't
  // build). Grow the EASY/LONG days into that SAFE headroom so the week reaches its ceiling and CTL climbs.
  //
  // The growth FOLLOWS THE TSB TRAJECTORY the plan already projects, instead of an all-or-nothing decision off
  // TODAY's ACWR: seed CTL/ATL from today and walk the week forward day by day. A day is grown only once its
  // PROJECTED form has recovered (TSB back above `minTSB + RECOVERED_MARGIN`) AND only up to the load that
  // keeps THAT day's projected TSB above the athlete's floor. So after a hard long run the fatigued front of
  // the week stays easy (letting form rebuild) while the back half — once the projection shows TSB has climbed
  // back — grows toward the ceiling. Deeply fatigued ⇒ nothing grows (self-regulating); fresh ⇒ fills from
  // day 1 (old behaviour). Quality is never inflated (daily readiness gate's job); tendon-safe caps keep any
  // single easy day from ballooning; the ceiling is heat/freshness-scaled so filling to it stays within cap.
  // The outer ACWR ≤ 1.45 is only a spike backstop — the per-day TSB floor is the real, finer-grained gate.
  if (!reentry && weekCeiling > 0 && (snap.ctl ?? 0) > 0 && (snap.acwr == null || snap.acwr <= 1.45)) {
    const La = 1 - Math.exp(-1 / 7), Lc = 1 - Math.exp(-1 / 42);
    const totalToF = out.reduce((a, o) => a + (o.intensity === 'rest' ? 0 : o.runMinutes), 0);
    let headroom = Math.round(weekCeiling - totalToF);
    if (headroom >= 8) {
      const grown = new Set<WeekPlanDay>();
      // FITNESS RAMP target set → the fill aims at the weekly LOAD that grows CTL by it (Geert chose: the CTL target
      // wins over the +cap% minutes guard, within the +25 % ceiling) and an easy day may reach 60 min. The fill
      // stops once the projected week reaches that load, so it doesn't overshoot either.
      const rates = snap.trimpRates;   // calibrated (CTL units); undefined → defaults
      // With a ramp, the fill's FORM walk is priced in the same calibrated units as snap.ctl/atl (the defaults count
      // an interval minute at 2.8 vs ~1.1 measured → phantom fatigue that blocked the growth). No ramp → unchanged.
      const walkRates = rampT > 0 ? rates : undefined;
      const rampLoad = rampT > 0 ? 7 * ((snap.ctl ?? 0) + rampT / CTL_WEEK_RESPONSE) : 0;
      let weekLoad = rampT > 0 ? out.reduce((a, o) => a + estimateDayTrimp(o.intensity, o.intensity === 'rest' ? 0 : o.runMinutes, rates), 0) : 0;
      let extraRunDayUsed = false;
      let converted: WeekPlanDay | null = null;   // the cap-rest day turned into the extra jog (not grown further)
      const FILL_EASY_MAX = rampT > 0 ? 60 : 50; // TENDON-SAFE: an easy day never grows past this via the fill…
      const FILL_STEP     = 15;                 // …nor more than this above its pre-fill length in one week
      // Two TSB thresholds shape the trajectory. GATE: only START adding load to a day once its projected form
      // has recovered a little off the floor — this is what holds the fatigued FRONT of the week easy (TSB deep
      // near the floor ⇒ no growth) without penalising a normally-fatigued athlete (TSB −7 mid-build still
      // builds). FLOOR: grow only until the day's OWN projected post-day TSB would reach here — a small buffer
      // over the hard floor so the fill never fights the screen's floor-trim, but low enough that a healthy week
      // still fills toward its ceiling (no regression to the flat-CTL under-build).
      // BUILD weeks accumulate DEEPER fatigue on purpose — the deload that follows is what clears it — so on a
      // build day the floor drops 4pt below the athlete's everyday floor (and the gate with it) so week 4 can
      // reach a real PEAK instead of stalling at the leisure floor. Deload/leisure days snap back to minTSB.
      let ctlP = snap.ctl ?? 0, atlP = snap.atl ?? 0;   // seed from today (screen re-trims with today's run folded in)
      // LOOK-AHEAD (2026-10-08): growing an easy day must not leave the NEXT quality session (tempo/intervals/long)
      // without the form to happen — the 7-day screen's TSB floor would then REST that quality day, and the week
      // ends up with LESS load than before the fill (Geert: Fri/Sun/Tue grown toward the ramp → Wed tempo rested →
      // +0.5 CTL instead of +1). Walk forward from day `idx` with `mins` on it, through the next quality day itself.
      const isQual = (o: WeekPlanDay) => o.intensity !== 'rest' && (o.kind === 'tempo' || o.kind === 'intervals' || o.kind === 'long');
      const qualityKeepsForm = (idx: number, mins: number, c0: number, a0: number, intens?: CoachIntensity): boolean => {
        let c = c0, a = a0;
        for (let k = idx; k < out.length; k++) {
          const ok = out[k];
          const m = k === idx ? mins : (ok.intensity === 'rest' ? 0 : ok.runMinutes);
          const load = estimateDayTrimp(k === idx ? (intens ?? ok.intensity) : ok.intensity, m, walkRates);
          a += La * (load - a); c += Lc * (load - c);
          if (k > idx && isQual(ok)) {
            // the screen's per-day floor: build days (periodization on) may go 4 deeper, everything else holds minTSB
            const buildQ = periodization.on && cyclePhase(new Date(ok.date + 'T00:00:00'), periodization).phase === 'build';
            const floorQ = buildQ ? Math.max(-25, minTSB - 4) : minTSB;
            if (c - a < floorQ + 1.5) return false;                              // margin over the screen's trim (+ today's seed)
          }
        }
        return true;   // every remaining quality day keeps its form
      };
      out.forEach((o, idx) => { (o as any).__idx = idx; });
      for (const o of out) {
        const preTSB = ctlP - atlP;
        const isEasy = o.kind === 'easy' || o.kind === 'flex';
        const isLong = o.kind === 'long';
        const oPhase = periodization.on ? cyclePhase(new Date(o.date + 'T00:00:00'), periodization).phase : 'build';
        const oBuild = oPhase === 'build';
        const oDeload = oPhase === 'deload';   // never GROW a deload day — the point of a deload is to reduce load
        const growFloorTSB = oBuild ? Math.max(-25, minTSB - 2) : minTSB + 2;   // build weeks push ~4pt deeper
        const growGateTSB  = growFloorTSB + 2;
        // FITNESS RAMP short of its load: ONE cap-rest day (rested only because the minutes cap was full — not a
        // scheduled rest, not a commitment day, not a deload) may become a short easy run, one run day beyond
        // maxRunDays (Geert's chosen lever, 2026-10-05). Only while its projected form allows it.
        if (rampT > 0 && !extraRunDayUsed && o.capRest && o.intensity === 'rest' && !o.commitment && !oDeload
            && weekLoad < rampLoad && headroom >= MEANINGFUL && preTSB >= growGateTSB + 2   // +2: margin over the screen's re-trim
            && out.filter(x => x.intensity !== 'rest').length < maxRunDays + 1) {
          const perMinE = estimateDayTrimp('easy', 100, rates) / 100;
          const tMaxE   = (ctlP * (1 - Lc) - atlP * (1 - La) - (growFloorTSB + 2)) / (La - Lc);   // TSB-floor load bound (+2 margin)
          const byFloor = Math.floor(tMaxE / (estimateDayTrimp('easy', 100, walkRates) / 100));
          const byLoad  = perMinE > 0 ? Math.ceil((rampLoad - weekLoad + estimateDayTrimp('rest', 0, rates)) / perMinE) : 0;
          let mins    = Math.min(30, byFloor, byLoad, headroom);
          while (mins >= MEANINGFUL && !qualityKeepsForm((o as any).__idx, mins, ctlP, atlP, 'easy')) mins -= 5;   // same look-ahead (this branch is ramp-only)
          if (mins >= MEANINGFUL) {
            weekLoad += estimateDayTrimp('easy', mins, rates) - estimateDayTrimp('rest', 0, rates);
            o.intensity = 'easy'; o.kind = 'easy'; o.runMinutes = mins; o.capRest = undefined;
            o.structure = `${mins}min easy @ Z2`;
            o.note = `Easy jog — extra run day toward your +${rampT} CTL/week fitness target`;
            headroom -= mins; extraRunDayUsed = true; converted = o;
          }
        }
        if (headroom >= 5 && !oDeload && o.intensity !== 'rest' && (isEasy || isLong) && preTSB >= growGateTSB && o !== converted) {
          // the most extra load this day can take while its OWN projected post-day TSB stays above the fill floor
          const tMax   = (ctlP * (1 - Lc) - atlP * (1 - La) - growFloorTSB) / (La - Lc);
          const cur    = estimateDayTrimp(o.intensity, o.runMinutes, walkRates);
          const perMin = estimateDayTrimp(o.intensity, 100, walkRates) / 100;   // per-minute load at this intensity
          const addByFloor = perMin > 0 ? Math.max(0, Math.floor((tMax - cur) / perMin)) : 0;
          const cap    = isLong ? longTargetMin : Math.min(FILL_EASY_MAX, o.runMinutes + FILL_STEP);
          // ramp: no more than the load still missing to the CTL target (in this day's minutes)
          const perMinC = estimateDayTrimp(o.intensity, 100, rates) / 100;
          const addByRamp = rampT > 0 ? (perMinC > 0 ? Math.max(0, Math.ceil((rampLoad - weekLoad) / perMinC)) : 0) : Infinity;
          let target = Math.min(cap, o.runMinutes + Math.min(addByFloor, headroom, addByRamp));
          // shrink the growth until the next quality day still has its form (see qualityKeepsForm)
          const idxO = (o as any).__idx as number;
          while (rampMode && target > o.runMinutes && !qualityKeepsForm(idxO, target, ctlP, atlP)) target -= 5;   // ramp mode only (ToF mode unchanged)
          if (target < o.runMinutes) target = o.runMinutes;
          if (target > o.runMinutes) {
            const add = target - o.runMinutes;
            weekLoad += estimateDayTrimp(o.intensity, target, rates) - estimateDayTrimp(o.intensity, o.runMinutes, rates);
            o.runMinutes = target; headroom -= add; grown.add(o);
          }
        }
        const dt = estimateDayTrimp(o.intensity, o.runMinutes, walkRates);   // roll the projection forward with the (grown) load
        atlP += La * (dt - atlP);
        ctlP += Lc * (dt - ctlP);
      }
      out.forEach(o => { delete (o as any).__idx; });
      grown.forEach(o => {
        o.structure = `${o.runMinutes}min ${o.kind === 'long' ? 'long-ish aerobic' : 'easy @ Z2'}`;
        o.note = rampT > 0
          ? `${o.kind === 'long' ? 'Long aerobic' : 'Easy Z2'} — grown toward your +${rampT} CTL/week fitness target`
          : `${o.kind === 'long' ? 'Long aerobic' : 'Easy Z2'} — grown as your form recovers this week, toward the +${capPct}% ceiling (build)`;
      });
    }
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
  // Don't restate the L–H numbers here — the readiness card shows the live "Target L–H% strain" and the two
  // drift apart (the plan bakes its band at generation time). Quote just where strain sits vs. the target.
  return `Strain ${Math.round(real)}% is ${where} your target band — ${driver}.`;
}

// The daily card's "next run" should match the 7-DAY PLAN the athlete actually sees — which, with
// shrink-to-fit on, may hold a REDUCED run TOMORROW even while the raw volume cap only clears a FULL
// meaningful run days later (e.g. it said "Saturday" while the 7-day plan ran a short Z2 on Friday). Read
// the forward plan and return its first real run day so the daily + home "next run" agree with the 7-day
// screen. getWeekPlan starts at TOMORROW (today+1+i), so index i → inDays i+1.
async function nextRunFromWeekPlan(snap: CoachSnapshot): Promise<{ label: string; inDays: number } | null> {
  try {
    const days = await getWeekPlan(snap);
    for (let i = 0; i < days.length; i++) {
      if (days[i].intensity !== 'rest' && (days[i].runMinutes ?? 0) > 0) {
        const d = new Date(days[i].date + 'T00:00:00');
        const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return { label: `${WD[d.getDay()]} ${d.getDate()} ${MO[d.getMonth()]}`, inDays: i + 1 };
      }
    }
  } catch { /* fall back to the cap projection */ }
  return null;
}

export async function deterministicCoachPlan(snap: CoachSnapshot): Promise<CoachPlan> {
  await ensureZonesFile().catch(() => {});
  // OVERALL STATUS override: Injured / Sick / On-a-break (set via the home status button) → no running,
  // whatever the cap/schedule say. Highest-priority gate; clears when the athlete sets status back to Active.
  const st = snap.athleteStatus;
  if (st === 'injured' || st === 'sick' || st === 'holiday') {
    const label = st === 'injured' ? 'Injured' : st === 'sick' ? 'Sick' : 'On a break';
    const untilTxt = snap.athleteStatusUntil ? ` until ${snap.athleteStatusUntil}` : '';
    return {
      headline: `${label} — no run today`,
      session: st === 'holiday'
        ? `You're on a break${untilTxt}. Rest or light cross-training only; the plan resumes when you set your status back to Active.`
        : `Status is "${label}"${untilTxt} — rest and recover. Gentle pain-free mobility only; set your status back to Active when you're ready to run.`,
      strength: st === 'injured' ? 'Only pain-free mobility/rehab as advised by your physio.' : STRENGTH_DEFAULT,
      intensity: 'rest', runMinutes: 0,
      rationale: `Athlete status "${label}" — running suppressed until cleared.`,
      cautions: undefined, workout: null, sessionKind: 'recovery', secondSession: null,
      strainLow: clampScore(snap.advisableLow, 30), strainHigh: clampScore(snap.advisableHigh, 60),
      generatedAt: new Date().toISOString(),
      // Stamp conditions like every other plan — without these, planNeedsRefresh saw genTempC == null and
      // regenerated (an LLM call in self-mode) on EVERY home refresh for as long as the status was set.
      genTempC:  snap.weather?.apparentC ?? snap.weather?.tempC,
      genStrain: snap.strainReal,
      genReadiness: snap.readiness,   // stamp on EVERY path so the genReadiness==null bootstrap can't loop
    };
  }
  const capPct      = snap.loadCapPct ?? DEFAULT_LOAD_CAP_PCT;
  const cappedToday = (snap.tofNextRunInDays ?? 0) > 0;
  const wkName      = weekdayName(snap.date);
  const reentry     = (snap.tof7d ?? 0) < 30;
  const shrinkOn    = await getShrinkToFit();
  const schedMd     = await readKnowledgeContent('running-schedule').catch(() => '');
  const template    = parseWeeklyTemplate(schedMd);
  const commits     = parseWeeklyCommitments(schedMd);
  const dow         = new Date(snap.date + 'T00:00:00').getDay();
  // Standing commitment today (dance night) or a hard one yesterday → today is NOT a quality day, whatever
  // the template says. Mirrors getWeekPlan so the daily card and the 7-day plan can't disagree — including the
  // "not dancing this week" override, which clears the commitment on the marked dates.
  const danceOffD   = await getDanceOffDates().catch(() => new Set<string>());
  const ydDate      = new Date(snap.date + 'T00:00:00'); ydDate.setDate(ydDate.getDate() - 1);
  const pad2        = (n: number) => String(n).padStart(2, '0');
  const ydKeyD      = `${ydDate.getFullYear()}-${pad2(ydDate.getMonth() + 1)}-${pad2(ydDate.getDate())}`;
  const commitToday = danceOffD.has(snap.date) ? undefined : commits[dow];
  const commitYday  = danceOffD.has(ydKeyD)    ? undefined : commits[(dow + 6) % 7];
  const commitBlock = !!commitToday || !!(commitYday?.hard && commitYday?.certain);
  const todaySlot   = reentry ? null : await loadTodaysWeekPlanSlot(snap.date);
  const todayDone   = (snap.recentTimeOnFeet ?? []).find(d => d.date === snap.date)?.min ?? 0;
  // Shrink-to-fit FORCE-PLACES today's scheduled quality (short) even over the cap — driven by the
  // TEMPLATE, NOT by finding a prior-day slot (that read is fragile: cache timing / which regen persisted).
  // Only on a real template quality day, only when recovered (green) and you haven't already run today —
  // so a cap-exhausted recovery day (e.g. after a double) still rests. Uses the slot's exact shrunk minutes
  // if one WAS found, else the shrink default.
  const honourSlot  = shrinkOn
    && ['intervals', 'tempo', 'long'].includes(template[dow] as string)
    && !commitBlock                      // never force quality onto a dance night / the day after one
    && (snap.readiness ?? 60) >= 60
    && todayDone < 8;
  // RACE MODE: today's session comes from the LLM race week (overrides the leisure template + cap).
  const raceSlot    = (await raceActive()) ? await raceSlotForToday(snap) : null;
  // Race force-places the day's session — but ONLY if you haven't already run today (else it re-prescribes
  // a 2nd run after you've done it: the ghost run). Same todayDone<8 guard shrink-to-fit uses.
  const raceForced  = !!raceSlot && raceSlot.intensity !== 'rest' && todayDone < 8;
  const honorDirect = honourSlot || raceForced;
  // FITNESS RAMP: the 7-day plan grew today's EASY/LONG slot (or turned a cap-rest into a jog) toward the CTL target,
  // up to +25 % minutes — beyond this daily +cap% budget. Honour the slot's minutes instead of re-capping it to rest /
  // clipping it, else the ramp only ever exists on the 7-day screen and never reaches the watch. Readiness can still
  // ease or rest it (the hard-rest floor + the !green ease below), and not after you've already run today.
  // …only from a FRESH plan (made yesterday or the day before, not a week-old slot) and never when load is already
  // spiking (ACWR > 1.45, the same backstop the fill itself uses).
  const rampSlot    = (snap.ctlRampTarget ?? 0) > 0 && !!todaySlot && todaySlot.intensity !== 'rest'
    && (todaySlot.kind === 'easy' || todaySlot.kind === 'long') && todayDone < 8 && !raceForced
    && (snap.acwr == null || snap.acwr <= 1.45) && !!(await loadTodaysWeekPlanSlot(snap.date, 2));
  const strainLow   = clampScore(snap.advisableLow, 30);
  const strainHigh  = clampScore(snap.advisableHigh, 60);
  const strainReal  = snap.strainReal ?? null;
  const recoveryStale = snap.recoveryStale === true;
  const heatFactor  = heatStrainFactor(snap.weather);
  const apparentC   = snap.weather?.apparentC ?? snap.weather?.tempC;
  // "Next run" tracks the 7-DAY PLAN (may hold a reduced shrink-to-fit run tomorrow), not the raw
  // meaningful-run cap projection — so the daily card + home agree with the 7-day screen. Race mode is
  // suppressed (the race block, not the cap, decides the days → avoids "run 25m" + "next run Sat").
  let nextRunLabel  = (cappedToday && !raceForced && !rampSlot) ? snap.tofNextRunLabel : undefined;
  let nextRunInDays = raceForced || rampSlot ? undefined : snap.tofNextRunInDays;
  if (cappedToday && !raceForced && !rampSlot && !snap.rampBudget) {   // ramp: the load budget's own next-run day stands
    const wp = await nextRunFromWeekPlan(snap);
    if (wp) { nextRunLabel = wp.label; nextRunInDays = wp.inDays; }
  }
  const stamp = {
    strainLow, strainHigh,
    nextRunLabel,
    nextRunInDays,
    generatedAt: new Date().toISOString(),
    genTempC:  apparentC,
    genStrain: snap.strainReal,
    genReadiness: snap.readiness,
  };

  // Cap reached → mandatory recovery day, unless a session is genuinely being force-placed today (shrink
  // or race — both now require you HAVEN'T run yet). Once you've run + are capped, this rests, whatever mode.
  if (cappedToday && !honourSlot && !raceForced && !rampSlot) {
    return {
      headline: 'At your volume cap — recovery day',
      session: snap.rampBudget
        ? `Rest from running today — your 7-day training load (${snap.rampBudget.load7}) is within ${snap.rampBudget.budgetLoad} of this week's fitness-ramp target (${snap.rampBudget.target7} for +${snap.rampBudget.ramp} CTL/week), too little for a meaningful run. Keep it to easy mobility/strength; next run ${nextRunLabel ?? 'in a couple of days'}.`
        : `Rest from running today — your trailing 7-day time-on-feet is at the +${capPct}% ceiling. Keep it to easy mobility/strength; next run ${nextRunLabel ?? 'in a couple of days'}.`,
      strength: STRENGTH_DEFAULT, intensity: 'rest', runMinutes: 0,
      rationale: bandPhrase(strainReal, strainLow, strainHigh, 'cap reached, so banking volume for the next quality day'),
      cautions: recoveryStale ? STALE_CAUTION : undefined, workout: null, sessionKind: 'recovery', secondSession: null, ...stamp,
    };
  }

  // ── HARD REST FLOOR (safety — highest priority after athlete status) ────────────────────────────────
  // Low readiness previously only EASED a quality to "easy Z2 ~35 min"; nothing forced rest however
  // wrecked you were. So a catastrophic morning — recovery 0 after a 3.5 h dance session + poor sleep
  // (2026-07-27) — still got "run 24 min", while Bevel was flagging near-total overreach. When readiness
  // is genuinely low AND the data is fresh, REST outright, overriding schedule / 7-day slot /
  // shrink-to-fit / race force-placement — you never force a session onto an athlete this depleted.
  // Gated on !recoveryStale because a missing night anchors readiness at a neutral 55 (see
  // advisableStrainRange), so stale data can never trip this floor on false pretences.
  const HARD_REST_READINESS = 35;
  if (!recoveryStale && (snap.readiness ?? 100) < HARD_REST_READINESS) {
    const r = Math.round(snap.readiness ?? 0);
    const flags = (snap.drivers && snap.drivers.length) ? ` Flags: ${snap.drivers.join(', ')}.` : '';
    return {
      headline: 'Rest today — recovery is very low',
      session: `Readiness ${r}/100. Your body is deep in the hole — little sleep, high strain, or both. No running today: rest, hydrate, gentle mobility only. Pushing a session now digs deeper and risks injury or illness; the plan resumes the moment recovery comes back up.`,
      strength: 'Skip strength too — only pain-free mobility if you feel like moving.',
      intensity: 'rest', runMinutes: 0,
      rationale: bandPhrase(strainReal, strainLow, strainHigh, `readiness ${r} is below the ${HARD_REST_READINESS} rest floor — recovery is the priority today`) + flags,
      cautions: undefined, workout: null, sessionKind: 'recovery', secondSession: null, ...stamp,
    };
  }

  // Today's session: PREFER the slot the rolling 7-day plan already laid out for today (generated on a
  // PRIOR day, so it SPREADS the week's volume) over a greedy single-day budget. Today's recovery can only
  // EASE it (never inflate). Fall back to the editable weekly template + readiness gate when no prior plan
  // covers today (first run, or re-entry where the gentle rebuild logic should win).
  const green    = (snap.readiness ?? 60) >= 60;
  const heatBudget = snap.tofBudgetTodayMin != null ? Math.round(snap.tofBudgetTodayMin / heatFactor) : undefined;
  const budget   = heatBudget ?? snap.tofBudgetTodayMin ?? 45;
  const longTargetMin = await getLongRunMinutes().catch(() => 75);  // the athlete's configured long-run length

  type SK = 'intervals' | 'tempo' | 'long' | 'easy' | 'recovery';
  const toSK = (k: string | undefined, it: CoachIntensity): SK =>
    (k === 'intervals' || k === 'tempo' || k === 'long' || k === 'easy') ? k
      : it === 'hard' ? 'intervals' : it === 'moderate' ? 'tempo' : it === 'easy' ? 'easy' : 'recovery';
  let intensity: CoachIntensity; let sk: SK; let base: number; let eased = '';
  let kind: string = template[dow];                 // scheduled session TYPE (drives the rest-day wording)
  // FITNESS RAMP: a cached 7-day slot that rested ONLY for the minutes cap ("capRest") doesn't bind when the LOAD
  // budget still has room for a meaningful run — the ramp's budget decides (the template/budget path below sizes it)
  const slot = (snap.rampBudget && todaySlot?.capRest && (snap.tofBudgetTodayMin ?? 0) >= 20) ? null : todaySlot;   // 20 = a meaningful run
  if (raceSlot) {
    // RACE MODE: today = the LLM race-week session (overrides template/cap). Recovery may still ease it.
    // If you've ALREADY run today, the session is done → rest (don't re-prescribe the same run).
    if (raceSlot.intensity === 'rest' || todayDone >= 8) { intensity = 'rest'; sk = 'recovery'; base = 0; kind = 'rest'; }
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
    // Only inherit the slot's minutes when the slot was the SAME session kind. A cached slot planned as an
    // easy day (e.g. the week plan built while shrink-to-fit was off) otherwise force-places the LONG at the
    // easy dose — observed as a 36min "long" on a template long day. Mismatched kind → the shrink default.
    const slotMatches = slot && slot.intensity !== 'rest' && slot.kind === k;
    base = slotMatches ? slot.runMinutes : (k === 'long' ? 45 : 28);
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
    if (green) { intensity = 'moderate'; sk = 'long'; base = longTargetMin; }   // the athlete's configured long-run length, not a hardcoded 65
    else { intensity = 'easy'; sk = 'easy'; base = 40; eased = 'readiness low, so the long run is just easy Z2'; }
  } else if (kind === 'easy') {
    // GROW easy volume toward the day's budget when green (progressive base-building); min(budget,base) below
    // caps it. Hold at 35 when run-down. Matches the week plan's easyGrow so the daily card agrees with it.
    intensity = 'easy'; sk = 'easy'; base = green ? 60 : 35;
  } else if (kind === 'rest') {
    intensity = 'rest'; sk = 'recovery'; base = 0;
  } else { // flex
    intensity = 'easy'; sk = 'recovery'; base = green ? 60 : 32;
  }
  let heatCut = false;
  if (intensity === 'hard' && (apparentC ?? 0) >= 24) { intensity = 'moderate'; sk = 'tempo'; heatCut = true; }
  if (intensity !== 'rest' && budget < 12 && !honorDirect && !rampSlot) { intensity = 'rest'; sk = 'recovery'; base = 0; }

  // Rest day (scheduled or out of budget).
  if (intensity === 'rest') {
    return {
      headline: 'Recovery day',
      session: kind === 'rest'
        ? 'Scheduled recovery — rest or an easy walk; optional mobility & strength.'
        : 'Volume’s used up for now — rest or cross-train; mobility & strength.',
      strength: STRENGTH_DEFAULT, intensity: 'rest', runMinutes: 0,
      rationale: bandPhrase(strainReal, strainLow, strainHigh, kind === 'rest' ? 'a scheduled recovery day' : 'no running budget left today'),
      cautions: recoveryStale ? STALE_CAUTION : undefined, workout: null, sessionKind: 'recovery', secondSession: null, ...stamp,
    };
  }

  // PROGRESSIVE OVERLOAD: ramp this session's TYPE from its recent duration (+cap%/week) before capping to
  // budget — matches the 7-day plan's per-type ramp so a type climbs to target instead of jumping (the slot
  // path is already ramped, so this is idempotent there; it's the no-slot fallback that needs it).
  if (!honorDirect && !rampSlot) {   // intensity is already non-rest here (rest returned earlier); a ramp slot is already sized
    const typeRamp = buildTypeRamp(snap.recentTimeOnFeet, snap.recentRuns, Math.max(snap.loadCapPct ?? DEFAULT_LOAD_CAP_PCT, SESSION_RAMP_MIN_PCT));
    base = typeRamp(new Date(snap.date + 'T00:00:00').getDay(), base, sk === 'long', sk as any);
  }
  // Build the structured session. A shrink-to-fit slot is HONOURED at its (already-short) minutes —
  // only today's heat eases it — so the daily card matches the 7-day plan instead of re-capping to rest.
  // ramp: the budget is in EASY-minute equivalents — a moderate/hard minute costs its own (calibrated) TRIMP/min
  const rr = snap.rampBudget ? (snap.rampBudget.rates ?? snap.trimpRates) : undefined;
  const iRate = rr ? (intensity === 'hard' ? rr.hard : intensity === 'moderate' ? rr.moderate : rr.easy) : 0;
  // never LONGER than the easy budget (calibrated rates aren't monotonic — a hard rate can read below easy)
  const budgetI = rr && iRate > 0 ? Math.round(budget * Math.min(1, rr.easy / iRate)) : budget;
  const totalMin = Math.max(8, honorDirect || rampSlot ? Math.round(base / Math.max(1, heatFactor)) : Math.min(budgetI, base));

  // SPLIT LONG RUN: on a long day, per the athlete's Long-run style, deliver the SAME long target as Part 1
  // (now) + Part 2 (later, easy Z2). This redistributes today's long — it does NOT add volume — so there's
  // no "cannibalise tomorrow" concern (that gate belongs to the opportunistic 2nd run, not the split); if
  // anything a split is LESS fatiguing before a quality day than one continuous long.
  let secondSession: CoachPlan['secondSession'] = null;
  let runMinutes = totalMin;                       // Part 1 (the run prescribed NOW); === total when not split
  const SPLIT_MIN_TOTAL = 60;                       // only split a genuinely long run
  if (sk === 'long' && totalMin >= SPLIT_MIN_TOTAL && !honorDirect) {
    const style = await getLongRunStyle();
    const doSplit = style === 'auto'  ? await shouldSplitLong(snap, base)   // base = the DESIRED (uncapped) long
                  : style === 'optin' ? await getLongSplitOptIn(snap.date)
                  : false;                           // 'long' (default) → never split
    if (doSplit) {
      runMinutes = Math.ceil(totalMin * 0.6);        // ~60% now
      const part2Min = totalMin - runMinutes;        // ~40% later
      const p2wo = ensureBlockPower(synthesizeWorkout('easy', part2Min, `${wkName} P2`, snap.powerZones, 'long'), snap.powerZones);
      secondSession = { runMinutes: part2Min, workout: p2wo, label: 'Long run — Part 2', earliestAfterHrs: 4 };
    }
  }

  // COMPLETION-AWARE: once you've done (≥70% of) today's PRESCRIBED session, the day's running is complete —
  // don't re-prescribe it (the "ghost 2nd run"). The bar is the MORNING prescription (the cached plan's
  // minutes), NOT a fresh recompute: post-run the fresh compute EXPANDS (shrink-to-fit's todayDone<8 guard
  // flips off, base jumps 28→50), which used to look "cut short" and conjure a bogus 2nd run. Split days are
  // handled by their own Part 2. A cut-short easy top-up is a deliberate FOLLOW-UP (needs the ToF accounting
  // proven first) — for now, complete = recover, honouring the cap that already shaped the morning session.
  const cachedToday = await loadCachedPlan(snap.date);
  const plannedMorning = (cachedToday && cachedToday.intensity !== 'rest' && !cachedToday.optional2nd)
    ? (cachedToday.runMinutes ?? 0) : 0;
  const primaryDone = todayDone >= Math.max(10, Math.round(plannedMorning * 0.7));   // 10, not 15 — intervals count few WORK minutes (see planNeedsRefresh)
  if (primaryDone && !secondSession && !honorDirect) {
    return {
      headline: 'Today’s session done ✓',
      session: 'You’ve done today’s run — recover now. Optional easy mobility & strength; no more running today.',
      strength: STRENGTH_DEFAULT, intensity: 'rest', runMinutes: 0,
      rationale: bandPhrase(strainReal, strainLow, strainHigh, 'today’s prescribed session is complete — recover (no 2nd run within today’s caps)'),
      cautions: recoveryStale ? STALE_CAUTION : undefined, workout: null, sessionKind: 'recovery', secondSession: null, sessionComplete: true, ...stamp,
    };
  }

  const runKm      = snap.loadUnit === 'km' && snap.paceMinPerKm ? Math.round((runMinutes / snap.paceMinPerKm) * 10) / 10 : undefined;
  // TRUE-work-minutes ramp: quality types cap their work off the most-recent same-type session (intervals
  // grow +1 rep, tempo +cap%). honorDirect (user forced today's slot/duration) skips the ramp entirely.
  const recentWork = honorDirect ? undefined
    : sk === 'intervals' ? snap.recentQualityWork?.intervals
    : sk === 'tempo'     ? snap.recentQualityWork?.tempo
    : undefined;
  const variantSeed = variantSeedFor(snap.date);   // rotate the interval/tempo SHAPE week to week (load held constant)
  // 'trimp' basis: the quality dose is LOAD-driven (+cap%/week off recent measured TRIMP), still ceilinged by
  // the minutes guardrail. honorDirect (user/race forced today's minutes) skips it, like the work-minutes ramp.
  const targetLoad = honorDirect ? undefined : qualityTargetLoad(snap, sk, capPct);
  const workout    = ensureBlockPower(synthesizeWorkout(intensity, runMinutes, wkName, snap.powerZones, sk, recentWork, capPct, variantSeed, targetLoad), snap.powerZones);
  // 'trimp' load-driven dose can be SHORTER than the minutes budget (a sharp session hits its load in fewer
  // minutes) → report the REAL session length so "N min" + the ToF accounting match the structure actually
  // pushed to the watch (warm-up/cool-down ≈ 6 min, mirroring synthesizeWorkout's workBudget reserve).
  if (targetLoad != null && workout) {
    const blocksMin = workout.blocks.reduce((s, b) => s + b.repeats * (b.workMinutes + b.restMinutes), 0);
    runMinutes = Math.min(runMinutes, Math.max(8, Math.round(blocksMin) + 6));
  }
  const structure  = formatWorkoutStructure(workout);
  const prescribedLoad = workout ? prescribedTrimp(workout) : undefined;   // derived impact readout (TRIMP)
  const dose       = runKm != null ? `${runKm} km` : `${runMinutes} min`;  // display unit follows the cap basis
  const label = sk === 'intervals' ? 'Intervals' : sk === 'tempo' ? 'Tempo' : sk === 'long' ? (secondSession ? 'Long run (Part 1 of 2)' : 'Long run') : base <= 30 ? 'Recovery run' : 'Easy Z2';
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
    ? ` Heat ×${heatFactor.toFixed(2)} → trimmed to ${totalMin} min${secondSession ? ' (split)' : ''}.` : '';

  const splitNote = secondSession
    ? ` Then Part 2 later (after ~${secondSession.earliestAfterHrs}h): ${secondSession.runMinutes} min easy Z2.` : '';
  return {
    headline,
    session: `${label} — ${dose}${structure ? `, ${structure}` : ''}.${splitNote}`,
    strength: STRENGTH_DEFAULT, intensity, runMinutes, runKm,
    rationale: bandPhrase(strainReal, strainLow, strainHigh, driver) + heatNote,
    cautions: recoveryStale ? STALE_CAUTION : undefined, workout, shrinkForced: honorDirect, ...(rampSlot ? { rampHeld: true } : {}),
    sessionKind: sk, secondSession, prescribedLoad, ...stamp,
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
    // SHRINK-TO-FIT / RACE force-placement: the deterministic basis DELIBERATELY held a (shortened) quality
    // session on its scheduled day even though the rolling cap is nearly spent — banking budget elsewhere.
    // The model only sees `tofBudgetTodayMin` (e.g. 14 min) + "cap reached" and reasonably concludes REST,
    // which then fights the app: on 2026-07-22 it returned rest, the rest→easy floor made it `easy`, its
    // (absent) structure was rejected, and the card ended up "Z2 · Z4 259-265W · Cap hit — rest today".
    // Telling it about the force-placement removes the contradiction at SOURCE rather than papering over it.
    const forced = basis.rampHeld && !basis.shrinkForced
      ? `\n\nIMPORTANT — TODAY'S SESSION IS DELIBERATELY HELD OVER THE DAILY VOLUME BUDGET for the athlete's FITNESS RAMP TARGET (+${snap.ctlRampTarget} CTL/week): the 7-day plan grew this easy/long run (up to +25 % minutes on the week) so CTL climbs at that rate. A low tofBudgetTodayMin or a reached +cap% therefore does NOT mean rest: do NOT return intensity "rest" and do NOT write that the cap forces rest. Honour the prescribed minutes (ease only if today's recovery genuinely warrants).`
      : basis.shrinkForced
      ? `\n\nIMPORTANT — TODAY'S SESSION IS DELIBERATELY FORCE-PLACED. The rolling volume cap is nearly spent, but the app has INTENTIONALLY held this shortened quality session on its scheduled day (shrink-to-fit) and banked budget elsewhere in the week. A low tofBudgetTodayMin therefore does NOT mean today is a rest day: do NOT return intensity "rest", and do NOT write that the cap forces rest today. Honour the prescribed session (you may still ease it slightly if today's recovery genuinely warrants).`
      : '';
    // FITNESS RAMP ON → the volume budget is LOAD (the ramp's 7-day target), not the +loadCapPct% on minutes
    const rampNote = snap.rampBudget
      ? `\n\nVOLUME BUDGET (fitness ramp +${snap.rampBudget.ramp} CTL/week): the rolling 7-day budget is LOAD, not a % on minutes — target ${snap.rampBudget.target7}, done ${snap.rampBudget.load7}, left ${snap.rampBudget.budgetLoad} (≈ tofBudgetTodayMin easy minutes; harder minutes cost more). Ignore loadCapPct for volume; never cite a "+X% ceiling".`
      : '';
    // personal caffeine → overnight HRV: lets the prose explain a low-HRV morning after a late-caffeine night
    const cafNote = await (async () => { const C = require('./caffeineHrv') as typeof import('./caffeineHrv'); const r = await C.caffeineHrv(); const ln = r.lastNight;
      return ln && ln.night === snap.date ? `\n\nCAFFEINE LAST NIGHT: ${ln.atBed} mg still active at bedtime, HRV ${ln.hrv} ms (${ln.z > 0 ? '+' : ''}${ln.z} SD vs baseline). ${C.cafHrvSummary(r)} If HRV is low and caffeine was late, say the HRV dip is likely partly caffeine, not only fatigue.` : `\n\n${C.cafHrvSummary(r)}`; })().catch(() => '');
    const system = `${ROLE}${raceHdr}${snap.timelineContext ?? ''}\n\n===== COACHING KNOWLEDGE =====\n${knowledge}\n===== END COACHING KNOWLEDGE =====${cafNote}\n\n${OUTPUT}${ceiling}${forced}${rampNote}`;
    setUsageFeature('coach-plan');
    const txt = await callLLM({
      system,
      // Feed the LLM the SAME next-run the basis resolved from the 7-day plan (may be tomorrow's shrink-to-fit
      // run), so its prose doesn't state the raw cap date (e.g. "run Saturday") while the card shows Friday.
      messages: [{ role: 'user', content: JSON.stringify({ ...snap, tofNextRunLabel: basis.nextRunLabel ?? snap.tofNextRunLabel, tofNextRunInDays: basis.nextRunInDays ?? snap.tofNextRunInDays, heatStrainFactor: heatFactor, prescribedCeiling: { intensity: basis.intensity, runMinutes: basis.runMinutes, forcePlaced: !!(basis.shrinkForced || basis.rampHeld) }, plannedSessionKind: basis.sessionKind }) }],
      maxTokens: 1200,
      temperature: 0.2,
    });
    const json = extractJsonObject(txt);
    if (!json) return basis;
    const o = JSON.parse(json);
    // CAP at the basis — recovery/weather may only EASE (no intensity escalation, no extra minutes).
    const llmIntensity: CoachIntensity = ['rest', 'easy', 'moderate', 'hard'].includes(o.intensity) ? o.intensity : basis.intensity;
    const eased: CoachIntensity = INTENSITY_RANK[llmIntensity] <= INTENSITY_RANK[basis.intensity] ? llmIntensity : basis.intensity;
    // The LLM may EASE the session (hard→moderate→easy) but must NEVER cancel a scheduled RUN to REST — rest
    // days are decided upstream (the 7-day plan + rolling volume cap + readiness gate), not by the prose
    // model. Without this floor the home (LLM path) silently downgraded a green-day intervals session to
    // rest and disagreed with the notification / coach-detail / 7-day plan, which all use the deterministic
    // basis. Floor at 'easy' whenever the basis prescribed a run.
    const intensity: CoachIntensity = (basis.intensity !== 'rest' && eased === 'rest') ? 'easy' : eased;
    const runMinutes = intensity === 'rest' ? 0
      : Math.max(8, Math.min(basis.runMinutes, Math.round(Number(o.runMinutes)) || basis.runMinutes));
    // Did we override the model's own call? (the rest→easy floor, or the cap at the basis). If so, its
    // prose describes a session we are NOT prescribing and must not be shown.
    const overrodeLlm = intensity !== llmIntensity;
    const wkName = weekdayName(snap.date);
    // Keep the LLM's structure (it honours the coaching-file drills), but reject a malformed one — where
    // the interval BLOCKS (work + between-rep recovery) don't account for a reasonable share of the run
    // (e.g. the main work mislabeled as a giant drills block) — and fall back to the clean synthesized
    // session. Count work + recovery, NOT work alone: intervals are naturally low WORK-density (a 3×5min/
    // 2min set is only 15 work min in a 44min run), so a work-only test wrongly rejected valid interval
    // sets and swapped in a denser synthesized 8×3 — while the LLM's 3×5 PROSE stayed, so the two disagreed.
    const parsed = intensity === 'rest' ? null : parseWorkout(o.workout, intensity, wkName);
    const blockTotal = (parsed?.blocks ?? []).reduce((s, b) => s + (b.workMinutes + b.restMinutes) * b.repeats, 0);
    // The LLM may only go EASIER/SHORTER than the basis — NEVER inflate the session past the prescribed
    // volume. wellFormed now has BOTH bounds: reject a too-SHORT structure (under-specified) AND a too-LONG
    // one (2026-07-15: a hallucinated "30m jog" ballooned a 35-min tempo to a 122-min, load-137 session).
    // Either way → fall back to the deterministic basis workout (the short tempo the athlete already had).
    const workRef = Math.max(8, runMinutes - (parsed?.drillsMinutes ?? 0) - 6);   // work-minutes the session budgets
    // THE DETERMINISTIC MODEL OWNS THE DOSE; THE LLM VARIES THE EXECUTION. Three checks (see
    // SHAPE_ENVELOPE): the shape must fit the day's KIND, and — while we're still doing the basis
    // session — its duration and load must match what the deterministic model prescribed.
    //
    // wellFormed used to check total MINUTES only, against a band so wide (0.5x-1.5x) that a session
    // could be half or half-again the intended dose. That let 2026-07-24 through: the week plan said
    // "Long, 54min @ 190-196W" and the daily plan shipped 10min Z2 + 3x8min Z3 + 5min Z2 under a "Long
    // Run" label. Note the loads were 80 vs 81 TRIMP — one point apart — so a load check alone would
    // have passed it too. The ENVELOPE is what catches it.
    const effKind: SessionKind =
      intensity === 'rest' ? 'recovery' :
      intensity === 'hard' ? 'intervals' :
      intensity === 'easy' ? (runMinutes <= 30 ? 'recovery' : 'easy') :
      basis.sessionKind === 'long' ? 'long' : 'tempo';
    const shapeReason = shapeFits(effKind, parsed?.blocks);
    // Compare against the basis dose ONLY when we're still doing the basis session — if the plan eased
    // off, the basis dose is the wrong target and the workout gets synthesized for the final intensity
    // anyway.
    const easedOff  = intensity !== basis.intensity;
    const refMin    = (!easedOff && basis.workout) ? basis.workout.blocks.reduce((t, b) => t + b.repeats * (b.workMinutes + b.restMinutes), 0) : 0;
    const refLoad   = (!easedOff && basis.workout) ? prescribedTrimp(basis.workout) : 0;
    const near      = (v: number, ref: number, tol: number) => ref <= 0 || Math.abs(v - ref) <= ref * tol;
    const durOk     = near(blockTotal, refMin, DOSE_MIN_TOL);
    const loadOk    = near(parsed ? prescribedTrimp(parsed) : 0, refLoad, DOSE_LOAD_TOL);
    const wellFormed = parsed != null && !shapeReason && durOk && loadOk
      && blockTotal >= workRef * 0.5 && blockTotal <= workRef * 1.5 + 6;

    // wellFormed → the LLM's parsed structure (its prose describes it). Rejected → the DETERMINISTIC basis
    // workout (ramp-capped) paired with basis.session below, so the prescribed prose + the watch structure
    // can never disagree (was: synth workout + the LLM's now-stale prose → 3×5 prose vs 8×3 watch).
    // ⚠️ The fallback workout MUST match the FINAL intensity. `basis.workout` was built for the BASIS
    // intensity, so reusing it after the session was EASED welds a hard structure onto an easy label.
    // That produced the 2026-07-22 card: the LLM correctly said "rest — cap hit", the rest→easy floor
    // above turned that into `easy`, its (absent) rest-day structure failed wellFormed, and we fell back
    // to the basis's Z4 259–265 W intervals — so the home showed "Z2 · 2× 4min @ 259–265W · Z4" under a
    // headline reading "Cap hit — rest today". Three sources, three different intensities.
    // When the intensity moved, SYNTHESIZE for the intensity we actually landed on.
    let workout = intensity === 'rest' ? null
      : wellFormed ? ensureBlockPower(parsed, snap.powerZones)
      : (basis.workout && !easedOff) ? basis.workout
      : ensureBlockPower(synthesizeWorkout(intensity, runMinutes, wkName, snap.powerZones, effKind), snap.powerZones);
    // A LONG run is aerobic Z2 BY DEFINITION — never a Z3/tempo block. Two ways it slipped to Z3 and pushed
    // 267–288 W for a Z2 long run (2026-09-07): the LLM handed back a 'tempo' Z3 block that the intensity-based
    // effort clamp (moderate → ≤Z3) let through, AND the fallback synth above used to drop effKind so a
    // 'moderate' long run synthesized as a tempo. Clamp every work block to Z2 here and refill the watts, so the
    // pushed power always matches the easy long-run effort regardless of the tier or what the model proposed.
    if (workout && effKind === 'long') {
      workout = ensureBlockPower(
        { ...workout, blocks: workout.blocks.map(b => ({ ...b, hrZone: 'Z2', powerLowWatts: undefined, powerHighWatts: undefined })) },
        snap.powerZones,
      );
    }
    // PROSE must describe the session we ACTUALLY prescribe. Three cases:
    //  • kept the model's structure AND its intensity  → its words are accurate.
    //  • rejected the structure but intensity is unchanged → the basis words match the basis workout.
    //  • we EASED off the basis / overrode the model  → NEITHER fits (the model wrote for its session, the
    //    basis for the harder one), so describe the final workout ourselves. Without this the home read
    //    "Cap hit — rest today" (model) or "Good to go — intervals day" (basis) over an easy Z2 run.
    // NOTE: easing off the basis does NOT by itself invalidate the model's words — if we HONOURED its
    // intensity choice (overrodeLlm=false) it wrote for the session we're actually giving. Only an
    // OVERRIDE (or a rejected structure) makes its prose stale.
    const useLlmProse   = wellFormed && !overrodeLlm && !!o.headline;
    const useBasisProse = !easedOff && !overrodeLlm;
    const structureNow  = workout ? formatWorkoutStructure(workout) : '';
    // When easing lands on rest / 0 min, EVERY text field must read as rest — otherwise the card shows a REST
    // pill + "no run today" + "no watch workout" over a headline/session that still say "Recovery run — 0 min".
    const isRestFinal   = intensity === 'rest' || runMinutes <= 0;
    const finalLabel    = intensity === 'hard' ? 'Intervals' : intensity === 'moderate' ? 'Tempo'
                        : isRestFinal ? 'Rest'
                        : runMinutes <= 30 ? 'Recovery run' : 'Easy Z2';
    const finalHeadline = isRestFinal ? 'Eased — rest today' : `Eased — ${finalLabel.toLowerCase()} today`;
    const finalSession  = isRestFinal
                        ? 'Rest day — no run. Let recovery come back up.'
                        : `${finalLabel} — ${runMinutes} min${structureNow ? `, ${structureNow}` : ''}.`;

    const runKm = intensity !== 'rest' && snap.loadUnit === 'km' && snap.paceMinPerKm
      ? Math.round((runMinutes / snap.paceMinPerKm) * 10) / 10 : undefined;
    // Canonical kind follows the FINAL (possibly eased) intensity so the label stays honest; a moderate
    // session is 'long' only if the basis was a long run (keeps the split), else 'tempo'.
    // effKind (computed above for the envelope) already encodes this, except that the label wants plain
    // 'easy' where the envelope treats a short easy run as 'recovery'.
    const sessionKind: SessionKind = intensity === 'easy' ? 'easy' : effKind;
    return {
      ...basis,
      // PROSE MUST DESCRIBE THE SESSION WE ACTUALLY PRESCRIBE. The model's words were written for the
      // session IT proposed — so they're stale the moment we reject its structure (wellFormed=false) OR
      // override its intensity (the rest→easy floor). Keeping the headline in that case is how the home
      // ended up reading "Cap hit — rest today, run Friday" above a prescribed workout (2026-07-22).
      // `session` already had this guard; headline/rationale did not.
      headline:  useLlmProse ? String(o.headline).slice(0, 120)  : useBasisProse ? basis.headline : finalHeadline,
      session:   useLlmProse && o.session ? String(o.session).slice(0, 280) : useBasisProse ? basis.session : finalSession,
      strength:  o.strength  ? String(o.strength).slice(0, 240)  : basis.strength,
      intensity, runMinutes, runKm, workout,
      prescribedLoad: workout ? prescribedTrimp(workout) : undefined,   // derived readout — from the FINAL workout (LLM's or fallback)
      rationale: (useLlmProse && o.rationale) ? String(o.rationale).slice(0, 400) : basis.rationale,
      // On a rest override, drop the model's cautions — they were written for the run it proposed
      // ("stop if legs feel heavy after 20 min" makes no sense at 0 min). Keep only a deterministic rest note.
      cautions:  isRestFinal ? basis.cautions : (basis.cautions ?? (o.cautions ? String(o.cautions).slice(0, 200) : undefined)),
      sessionKind,
      // Keep Part 2 only if it's STILL a long run (the LLM designs Part 1 within the split ceiling); if it
      // eased the long to easy, the day is no longer a split.
      secondSession: sessionKind === 'long' ? basis.secondSession : null,
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

// Long-run style: how a scheduled LONG run is delivered.
//   'long'  (default) = one continuous long run, never split.
//   'auto'            = the coach may split it (Part 1 now + Part 2 later, both Z2) when shouldSplitLong() says so
//                       — hot day, low readiness, or the target won't fit today's budget (and not a race peak).
//   'optin'           = only split when the athlete flips the per-day toggle on the coach screen.
// Physiology: splitting keeps the volume-driven aerobic adaptations + lowers heat/injury load, but forgoes the
// race-specific durability of a continuous long run — so it's a base/leisure/heat tool, not for race-peak weeks.
export type LongRunStyle = 'long' | 'auto' | 'optin';
const LONG_RUN_STYLE_KEY = 'long_run_style_v1';
const VALID_LONG_RUN_STYLES = ['long', 'auto', 'optin'] as const;
export const DEFAULT_LONG_RUN_STYLE: LongRunStyle = 'long';
export async function getLongRunStyle(): Promise<LongRunStyle> {
  try {
    const raw = await SecureStore.getItemAsync(LONG_RUN_STYLE_KEY);
    return (VALID_LONG_RUN_STYLES as readonly string[]).includes(raw ?? '') ? (raw as LongRunStyle) : DEFAULT_LONG_RUN_STYLE;
  } catch { return DEFAULT_LONG_RUN_STYLE; }
}
export async function setLongRunStyle(v: LongRunStyle): Promise<void> {
  try { await SecureStore.setItemAsync(LONG_RUN_STYLE_KEY, v); } catch { /* ignore */ }
}

// ── Heat sensitivity: how hard heat scales down running (see heatStrainFactor). Default SENSITIVE. ──
const HEAT_SENS_KEY = 'heat_sensitivity_v1';
export async function getHeatSensitivity(): Promise<number> {
  try { const v = Number(await SecureStore.getItemAsync(HEAT_SENS_KEY)); return Number.isFinite(v) && v > 0 ? v : DEFAULT_HEAT_SENSITIVITY; }
  catch { return DEFAULT_HEAT_SENSITIVITY; }
}
export async function setHeatSensitivity(v: number): Promise<void> {
  const c = Math.max(0.5, Math.min(2.5, v));
  try { await SecureStore.setItemAsync(HEAT_SENS_KEY, String(c)); } catch { /* ignore */ }
  setHeatSensitivityCache(c);   // apply immediately for the sync heatStrainFactor
}
export async function refreshHeatSensitivity(): Promise<number> {
  const v = await getHeatSensitivity(); setHeatSensitivityCache(v); return v;
}

// ── Max running DAYS per week: caps the easy/flex mop-up so volume concentrates into fewer, meaningful
// days instead of a short jog every day (default 5). Quality days (intervals/tempo/long) always run. ──
const MAX_RUN_DAYS_KEY = 'max_run_days_v1';
export const DEFAULT_MAX_RUN_DAYS = 5;
export async function getMaxRunDays(): Promise<number> {
  try { const v = Number(await SecureStore.getItemAsync(MAX_RUN_DAYS_KEY)); return Number.isFinite(v) && v >= 1 && v <= 7 ? Math.round(v) : DEFAULT_MAX_RUN_DAYS; }
  catch { return DEFAULT_MAX_RUN_DAYS; }
}
export async function setMaxRunDays(v: number): Promise<void> {
  try { await SecureStore.setItemAsync(MAX_RUN_DAYS_KEY, String(Math.max(1, Math.min(7, Math.round(v))))); } catch { /* ignore */ }
}

// ── Workout structure (warm-up / cool-down / drills) ──────────────────────────
// The athlete's fixed session shell that wraps every prescribed run. warmup/cooldown are in METRES where
// **0 = OPEN goal** (athlete-controlled, ended with the watch lap button — the watch already runs these as
// open steps; 0 just makes the app say "Open" and skip a distance target). drills = minutes (0 to skip).
// These are structural preferences the athlete owns — applied to every workout, overriding the LLM.
export interface WorkoutStructure { warmupMeters: number; cooldownMeters: number; drillsMinutes: number; }
export const DEFAULT_WORKOUT_STRUCTURE: WorkoutStructure = { warmupMeters: 0, cooldownMeters: 0, drillsMinutes: 4 };
const WARMUP_KEY = 'warmup_meters_v1', COOLDOWN_KEY = 'cooldown_meters_v1', DRILLS_KEY = 'drills_minutes_v1';
// Synchronously-readable snapshot for the sync workout builders (synthesizeWorkout / parseWorkout). Kept in
// sync with storage by refreshWorkoutStructure(), called in assembleCoachSnapshot before any plan is built.
let workoutStructureCache: WorkoutStructure = { ...DEFAULT_WORKOUT_STRUCTURE };
export function workoutStructureSync(): WorkoutStructure { return workoutStructureCache; }
export async function getWorkoutStructure(): Promise<WorkoutStructure> {
  const n = (raw: string | null, def: number) => { const v = Number(raw); return raw != null && Number.isFinite(v) && v >= 0 ? Math.round(v) : def; };
  try {
    const [w, c, d] = await Promise.all([
      SecureStore.getItemAsync(WARMUP_KEY), SecureStore.getItemAsync(COOLDOWN_KEY), SecureStore.getItemAsync(DRILLS_KEY),
    ]);
    return {
      warmupMeters:   n(w, DEFAULT_WORKOUT_STRUCTURE.warmupMeters),
      cooldownMeters: n(c, DEFAULT_WORKOUT_STRUCTURE.cooldownMeters),
      drillsMinutes:  n(d, DEFAULT_WORKOUT_STRUCTURE.drillsMinutes),
    };
  } catch { return { ...DEFAULT_WORKOUT_STRUCTURE }; }
}
export async function refreshWorkoutStructure(): Promise<WorkoutStructure> {
  workoutStructureCache = await getWorkoutStructure();
  return workoutStructureCache;
}

// Sync-readable accounting mode (like workoutStructureCache) so synthesizeWorkout can decide whether the
// warm-up/cool-down are folded into the counted session ('full') or are open, uncounted additions ('work').
// Refreshed by refreshAccountingMode(), called in assembleCoachSnapshot before any plan is built.
let accountingModeCache: AccountingMode = DEFAULT_ACCOUNTING;
export function accountingModeSync(): AccountingMode { return accountingModeCache; }
export async function refreshAccountingMode(): Promise<AccountingMode> {
  accountingModeCache = await getAccountingMode();
  return accountingModeCache;
}
export async function setWorkoutStructure(v: Partial<WorkoutStructure>): Promise<void> {
  const clamp = (x: number) => String(Math.max(0, Math.round(x)));
  try {
    if (v.warmupMeters   != null) await SecureStore.setItemAsync(WARMUP_KEY,   clamp(v.warmupMeters));
    if (v.cooldownMeters != null) await SecureStore.setItemAsync(COOLDOWN_KEY, clamp(v.cooldownMeters));
    if (v.drillsMinutes  != null) await SecureStore.setItemAsync(DRILLS_KEY,   clamp(v.drillsMinutes));
  } catch { /* ignore */ }
  await refreshWorkoutStructure();
}

// Per-DATE opt-in flag for the 'optin' long-run style (transient day flags — not backed up).
const longSplitKey = (d: string) => `long_split_optin_${d}`;
export async function getLongSplitOptIn(d: string): Promise<boolean> {
  try { return (await SecureStore.getItemAsync(longSplitKey(d))) === '1'; } catch { return false; }
}
export async function setLongSplitOptIn(d: string, on: boolean): Promise<void> {
  try {
    if (on) await SecureStore.setItemAsync(longSplitKey(d), '1');
    else    await SecureStore.deleteItemAsync(longSplitKey(d));
  } catch { /* ignore */ }
}

// AUTO-split criteria: split today's long run when the continuous version is either too taxing to do well
// (heat / low readiness) or won't fit today's rolling volume budget — but NEVER in a race peak/taper week,
// where the continuous long run IS the specific stimulus.
export async function shouldSplitLong(snap: CoachSnapshot, longTargetMin: number): Promise<boolean> {
  if (await raceActive()) {
    const rw = await getRaceWeekPlan(snap);
    if (rw && /peak|taper/i.test(rw.phase ?? '')) return false;
  }
  const apparentC = snap.weather?.apparentC ?? snap.weather?.tempC ?? 0;
  const budget    = snap.tofBudgetTodayMin ?? Infinity;
  const readiness = snap.readiness ?? 100;
  // longTargetMin is the DESIRED (uncapped) long — so "won't fit today's budget" can actually fire. A long
  // run only reaches here when green (≥60), so the readiness gate is the LOW end of green (not fresh enough
  // for one big continuous effort → split it gentler).
  return apparentC >= 24 || longTargetMin > budget || readiness < 65; // heat / over-budget / low-end readiness
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

// 'tof' = time-on-feet minutes · 'distance' = real-work km · 'trimp' = Banister load (quality dose ramps on
// LOAD, minutes stay the volume guardrail). Default stays 'tof' until 'trimp' is validated on device.
export type LoadCapBasis = 'tof' | 'distance' | 'trimp';
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

// ── "Not dancing this week" override ──────────────────────────────────────────
// Dancing is an OCCASIONAL Thursday commitment: the planner reserves Thu as rest and works around it. On a
// week the athlete ISN'T dancing they can train Thursday, which (on a build week) is the extra run-day that
// lets the week reach its maintenance peak. This stores the specific dates (the Thursdays) marked "no dance";
// getWeekPlan then ignores the commitment on those dates so Thu frees up (rest→jog) and Fri isn't day-after.
const DANCE_OFF_KEY = 'dance_off_dates_v1';
export async function getDanceOffDates(): Promise<Set<string>> {
  try {
    const raw = await SecureStore.getItemAsync(DANCE_OFF_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
  } catch { return new Set(); }
}
export async function toggleDanceOff(iso: string): Promise<boolean> {
  try {
    const set = await getDanceOffDates();
    const on = !set.has(iso);
    if (on) set.add(iso); else set.delete(iso);
    // prune dates more than 21 days in the past so the list can't grow unbounded
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 21);
    const pad = (n: number) => String(n).padStart(2, '0');
    const cutIso = `${cutoff.getFullYear()}-${pad(cutoff.getMonth() + 1)}-${pad(cutoff.getDate())}`;
    const kept = [...set].filter(d => d >= cutIso);
    await SecureStore.setItemAsync(DANCE_OFF_KEY, JSON.stringify(kept));
    return on;
  } catch { return false; }
}
export async function setMinTSB(v: number): Promise<void> {
  try { await SecureStore.setItemAsync(MIN_TSB_KEY, String(Math.round(v))); } catch { /* ignore */ }
}

// The +cap% is a date-keyed SWITCH LIST (mirrors accounting.ts's regime switches), NOT a single scalar:
// changing the cap must affect volume budgets only FROM the change date forward, so past weeks in the
// Volume-vs-Budget history keep the % that was actually in force then (point-in-time honest). Storage:
//   load_cap_pct_switches = [{ since:'1970-01-01', pct:10 }, { since:'2026-08-18', pct:12 }, …]
// A week's % = the latest switch with since ≤ its Monday. Reconstructible after a wipe from the tiny list.
const LOAD_CAP_PCT_SWITCHES_KEY = 'load_cap_pct_switches';
const CAP_EPOCH = '1970-01-01';
export interface CapPctSwitch { since: string; pct: number }   // since = YYYY-MM-DD, inclusive
const clampCapPct = (n: number) => Math.max(5, Math.min(50, Math.round(n))); // 5–50% sane bounds
const capTodayKey = (): string => { const d = new Date(); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

let capPctSwitchCache: CapPctSwitch[] | null = null;
async function loadCapPctSwitches(): Promise<CapPctSwitch[]> {
  if (capPctSwitchCache) return capPctSwitchCache;
  try {
    const raw = await SecureStore.getItemAsync(LOAD_CAP_PCT_SWITCHES_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) {
        capPctSwitchCache = arr.map((s: any) => ({ since: String(s.since), pct: clampCapPct(Number(s.pct)) }));
        return capPctSwitchCache;
      }
    }
    // Migrate the legacy single scalar: seed it at EPOCH so history is UNCHANGED on upgrade (every week
    // already used the current scalar) — only FUTURE changes get dated.
    const legacy = await SecureStore.getItemAsync(LOAD_CAP_PCT_KEY);
    const seed = legacy != null && legacy !== '' ? clampCapPct(parseInt(legacy, 10)) : DEFAULT_LOAD_CAP_PCT;
    capPctSwitchCache = [{ since: CAP_EPOCH, pct: Number.isFinite(seed) ? seed : DEFAULT_LOAD_CAP_PCT }];
    await saveCapPctSwitches(capPctSwitchCache);
  } catch { capPctSwitchCache = [{ since: CAP_EPOCH, pct: DEFAULT_LOAD_CAP_PCT }]; }
  return capPctSwitchCache!;
}
async function saveCapPctSwitches(list: CapPctSwitch[]): Promise<void> {
  capPctSwitchCache = list;
  try { await SecureStore.setItemAsync(LOAD_CAP_PCT_SWITCHES_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}
/** Invalidate the in-memory cache (call after a restore writes a new switch list). */
export function clearCapPctCache(): void { capPctSwitchCache = null; rampMemo = null; rampGen++; }

/** The +cap% in force on a given date = the latest switch with since ≤ date. Pure (list passed in). */
export function capPctForDate(date: string, list: CapPctSwitch[]): number {
  const d = date.slice(0, 10);
  let pct = DEFAULT_LOAD_CAP_PCT;
  for (const s of list) { if (s.since <= d) pct = s.pct; else break; }
  return pct;
}
export async function getLoadCapPctList(): Promise<CapPctSwitch[]> { return [...(await loadCapPctSwitches())]; }

// ── CTL ramp target (Geert, 2026-10-05: "set the coach to +1.5 per week") ─────────────────────────────────────
// Instead of a fixed +cap%, steer by FITNESS: hold CTL growth at ~N points/week. CTL is a 42-day EWMA, so over the
// next 7 days ΔCTL ≈ (avg daily load − CTL) × (1 − e^(−7/42)). The load that gives +N is therefore
// 7 × (CTL + N / 0.1535); the cap % is that relative to the higher of the last two completed weeks (the 7-day plan's
// weekCeiling reference). Bounded 0–10 %: an under-filled week lets it catch up (never past the classic +10 %),
// over-delivery → 0 % (no growth beyond the recent best week; the freshness factor can still nudge it).
// The derived % is NEVER written into the manual switch list (that list stays the athlete's own setting, so turning
// the ramp off restores it). A small separate log keeps the % per week for the point-in-time Volume-vs-Budget
// history, plus the last value as a fallback when the snapshot cache is stale.
const CTL_RAMP_KEY = 'ctl_ramp_target';
const CTL_RAMP_LOG_KEY = 'ctl_ramp_log';
const RAMP_OPT = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK } as const;   // readable in the locked morning flow
const CTL_WEEK_RESPONSE = 1 - Math.exp(-7 / 42);
export const CTL_RAMP_MAX_PCT = 10;
/** Per-session growth (long/tempo/quality dose) keeps its old 5 % floor — a 0–3 % weekly cap must not freeze it. */
export const SESSION_RAMP_MIN_PCT = 5;
interface RampLog { last?: { date: string; pct: number }; weeks: Record<string, number> }

export async function getCtlRampTarget(): Promise<number | null> {
  try { const v = parseFloat((await SecureStore.getItemAsync(CTL_RAMP_KEY)) ?? ''); return Number.isFinite(v) && v >= 0.1 && v <= 10 ? v : null; }
  catch { return null; }
}
/** v = CTL points/week (0.1–10, one decimal), or null = off (back to the manual +cap%). */
export async function setCtlRampTarget(v: number | null): Promise<void> {
  rampMemo = null; rampGen++;
  try {
    // the fallback value belongs to the OLD target → drop it (the per-week history stays)
    const log = await readRampLog();
    if (log.last) { delete log.last; await SecureStore.setItemAsync(CTL_RAMP_LOG_KEY, JSON.stringify(log), RAMP_OPT); }
  } catch { /* ignore */ }
  try {
    if (v == null) await SecureStore.deleteItemAsync(CTL_RAMP_KEY);
    else await SecureStore.setItemAsync(CTL_RAMP_KEY, String(Math.min(10, Math.max(0.1, Math.round(v * 10) / 10))), RAMP_OPT);
  } catch { /* ignore */ }
}
/** Steady-state weekly % a sustained +ramp implies at this CTL (for multi-week projections, e.g. the season plan). */
export function steadyRampPct(ramp: number, ctl: number): number {
  const w = ctl + ramp / CTL_WEEK_RESPONSE;
  return w > 0 ? Math.round((100 * ramp / w) * 10) / 10 : 0;
}
/**
 * Pure: the +cap% that steers CTL up by `ramp`/week. Completed days only, and only when the series is CURRENT
 * (its last completed day is yesterday) — a cache from yesterday morning has a partial "yesterday" and would read
 * the reference low. null = can't tell.
 */
export function capPctForCtlRamp(series: { date: string; load: number; ctl: number }[], ramp: number, todayKey: string, yesterdayKey: string): number | null {
  const done = series.filter(d => d.date < todayKey);
  if (done.length < 14 || done[done.length - 1].date !== yesterdayKey) return null;
  const ctl = done[done.length - 1].ctl;
  const sum = (a: typeof done) => a.reduce((s, d) => s + (Number.isFinite(d.load) ? d.load : 0), 0);
  const ref = Math.max(sum(done.slice(-7)), sum(done.slice(-14, -7)));
  if (!(ref > 0) || !Number.isFinite(ctl)) return null;
  const target = 7 * (ctl + ramp / CTL_WEEK_RESPONSE);
  return Math.max(0, Math.min(CTL_RAMP_MAX_PCT, Math.round((target / ref - 1) * 100)));
}
async function readRampLog(): Promise<RampLog> {
  try { const j = JSON.parse((await SecureStore.getItemAsync(CTL_RAMP_LOG_KEY)) ?? ''); if (j && typeof j === 'object' && j.weeks) return j; } catch { /* none */ }
  return { weeks: {} };
}
/** The ramp-derived % per Monday (overlays the manual list in the Volume-vs-Budget history). */
export async function getCtlRampWeeks(): Promise<Record<string, number>> { return (await readRampLog()).weeks; }

let rampMemo: { at: number; pct: number | null } | null = null;   // getLoadCapPct is hot → re-derive ≤ once a minute
let rampGen = 0;                                                     // bumps on set/restore → drops in-flight results
async function rampDerivedPct(): Promise<number | null> {
  if (rampMemo && Date.now() - rampMemo.at < 60_000) return rampMemo.pct;
  const gen = rampGen;
  const ramp = await getCtlRampTarget();
  let pct: number | null = null;
  if (ramp != null) {
    const today = capTodayKey();
    const y = new Date(); y.setDate(y.getDate() - 1);
    const p2 = (n: number) => String(n).padStart(2, '0');
    const yKey = `${y.getFullYear()}-${p2(y.getMonth() + 1)}-${p2(y.getDate())}`;
    const snap = await loadSnapshotCache().catch(() => null);
    // only a snapshot SCANNED TODAY: one from yesterday morning ends on a partial "yesterday" yet passes the
    // series check (its last completed day IS yesterday by then) → the ≤2-day log fallback covers that case
    const f = snap?.fetchedAt ? new Date(snap.fetchedAt) : null;
    const fresh = !!f && `${f.getFullYear()}-${p2(f.getMonth() + 1)}-${p2(f.getDate())}` === today;
    pct = fresh && snap?.trainingLoad?.length ? capPctForCtlRamp(snap.trainingLoad, ramp, today, yKey) : null;
    const log = await readRampLog();
    if (pct == null) {
      // stale/short data → keep the last derived % for up to 2 days rather than snapping back to the manual one
      if (log.last && (Date.parse(today) - Date.parse(log.last.date)) / 86_400_000 <= 2) pct = log.last.pct;
    } else {
      const mon = mondayOf(new Date()); const mKey = `${mon.getFullYear()}-${p2(mon.getMonth() + 1)}-${p2(mon.getDate())}`;
      const changed = log.last?.pct !== pct || log.last?.date !== today || log.weeks[mKey] == null;
      if (changed && gen === rampGen) {
        if (log.weeks[mKey] == null) log.weeks[mKey] = pct;            // the week's % = its first derivation
        const keys = Object.keys(log.weeks).sort();
        for (const k of keys.slice(0, Math.max(0, keys.length - 30))) delete log.weeks[k];   // keep ~30 weeks
        log.last = { date: today, pct };
        try { await SecureStore.setItemAsync(CTL_RAMP_LOG_KEY, JSON.stringify(log), RAMP_OPT); } catch { /* ignore */ }
      }
    }
  }
  if (gen === rampGen) rampMemo = { at: Date.now(), pct };
  return pct;
}

/** Today's CTL-ramp-derived % — null when no ramp target is set OR no fresh data yet (then the manual % applies). */
export async function getCtlRampPctToday(): Promise<number | null> { return rampDerivedPct(); }

export async function getLoadCapPct(): Promise<number> {
  // The CURRENT cap % — what the forward plan + today's budget train against: the CTL-ramp-derived % when a ramp
  // target is set, else the athlete's manual one.
  const derived = await rampDerivedPct();
  return derived ?? getManualLoadCapPct();
}
/** The athlete's own (manual) +cap% — what applies whenever no CTL ramp target is set. */
export async function getManualLoadCapPct(): Promise<number> {
  const list = await loadCapPctSwitches();
  return list[list.length - 1]?.pct ?? DEFAULT_LOAD_CAP_PCT;
}
export async function setLoadCapPct(pct: number): Promise<void> { await storeCapPct(clampCapPct(pct)); }
async function storeCapPct(pct: number): Promise<void> {
  // Append a DATED switch (effective today) instead of overwriting, so past weeks keep their in-force %.
  const p = clampCapPct(pct);
  const list = await loadCapPctSwitches();
  if ((list[list.length - 1]?.pct ?? DEFAULT_LOAD_CAP_PCT) === p) return;   // unchanged → no-op
  const today = capTodayKey();
  let next = list.filter(s => s.since !== today);              // drop a same-day flip-flop
  next.push({ since: today, pct: p });
  next.sort((a, b) => a.since.localeCompare(b.since));
  if (next[0].since !== CAP_EPOCH) next.unshift({ since: CAP_EPOCH, pct: DEFAULT_LOAD_CAP_PCT });
  next = next.filter((s, i) => i === 0 || s.pct !== next[i - 1].pct); // collapse consecutive same-pct runs
  await saveCapPctSwitches(next);
  // Mirror the current value into the legacy scalar so any un-migrated reader still sees it.
  try { await SecureStore.setItemAsync(LOAD_CAP_PCT_KEY, String(p)); } catch { /* ignore */ }
}
export async function getLoadCapBasis(): Promise<LoadCapBasis> {
  try { const v = await SecureStore.getItemAsync(LOAD_CAP_BASIS_KEY); return (v === 'distance' || v === 'trimp') ? v : 'tof'; }
  catch { return DEFAULT_LOAD_CAP_BASIS; }
}
export async function setLoadCapBasis(b: LoadCapBasis): Promise<void> {
  try { await SecureStore.setItemAsync(LOAD_CAP_BASIS_KEY, b); } catch { /* ignore */ }
}

export interface TofPlan {
  series14:       { date: string; min: number }[];
  series28:       { date: string; min: number }[];   // last 28 days (week-planner max-window base + cap history)
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
// the athlete/coach with safe defaults. Cycle phase is a deterministic function of the athlete's cycle-start
// anchor (a blank anchor auto-fills to the current week on first use) + the settings.
export interface Periodization {
  on: boolean; buildWeeks: number; deloadWeeks: number; deloadDropPct: number; anchor: string;
  restartAfterBreak?: boolean;   // persisted; default ON — time off restarts the cycle at Build 1 (see computeCycleRestarts)
  restarts?: CycleRestart[];     // DERIVED on every getPeriodization() from runs + timeline — never persisted
}
// A cycle restart after time off: `from` = first day back (YYYY-MM-DD), `monday` = the Monday that becomes Build 1
// (the return week itself when back Mon–Wed; the NEXT Monday when back Thu–Sun, so the build phase is full-length).
export interface CycleRestart {
  from: string; monday: string; reason: string;
  preBreakMin?: number;   // best 7-day time-on-feet in the 3 weeks before the break (for the volume restart floor)
}
// After a break the rolling cap's base is just the (tiny) post-break weeks, so the comeback crawled. Instead the
// return week's ceiling = RESTART_VOLUME_PCT% of the pre-break level, and each following week +cap% on that —
// Geert 2026-09-28: "last week would have had a limit of 150, this week of 150+20%".
export const RESTART_VOLUME_PCT = 75;
const BREAK_GAP_DAYS    = 7;   // ≥7 full days without a run = time off (a deload week still has runs)
const BREAK_STATUS_DAYS = 5;   // or a Sick / Injured / "On a break" status period of ≥5 days

/**
 * Restart points for the build/deload cycle after TIME OFF (Geert 2026-09-28: "after a time off (vacation/illness/
 * whatever), restart the training block nr. to 1 again, so there's a full build phase again"). Pure + derived from
 * data — run days + status timeline events — so it's reconstructible after a reinstall and never rewrites the
 * stored anchor; a restart before the athlete's own (later) anchor is ignored.
 */
export function computeCycleRestarts(
  runDaysIn: string[], events: { date: string; type: string; status?: string; endDate?: string }[],
  anchor: string, today: string, currentStatus?: string,
): CycleRestart[] {
  const DAY = 86_400_000;
  const t = (k: string) => new Date(k + 'T00:00:00').getTime();
  const key = (ms: number) => isoDate(new Date(ms));
  const runDays = [...new Set(runDaysIn)].filter(d => d <= today).sort();
  const firstRunOnOrAfter = (k: string) => runDays.find(d => d >= k);
  const out: { from: string; reason: string }[] = [];
  // (a) a gap between consecutive runs of ≥ BREAK_GAP_DAYS full days → restart on the run that ends it.
  for (let i = 1; i < runDays.length; i++) {
    const off = Math.round((t(runDays[i]) - t(runDays[i - 1])) / DAY) - 1;
    if (off >= BREAK_GAP_DAYS) out.push({ from: runDays[i], reason: `${off} days without running` });
  }
  // Still in a gap TODAY (no run for ≥ BREAK_GAP_DAYS) and not on a logged break → today is the return day, so
  // today's plan is already Build 1 / "back from break" instead of whatever week the old cycle has reached.
  const last = runDays[runDays.length - 1];
  if (last && (currentStatus ?? 'running') === 'running') {
    const off = Math.round((t(today) - t(last)) / DAY) - 1;
    if (off >= BREAK_GAP_DAYS) out.push({ from: today, reason: `${off} days without running` });
  }
  // (b) a non-running STATUS period (sick / injured / holiday) of ≥ BREAK_STATUS_DAYS → restart on the first run
  // on/after it ends (its own "until", else the next status change, else today while it's still ongoing).
  const statuses = events.filter(e => e.type === 'status' && e.status).sort((a, b) => a.date.localeCompare(b.date));
  statuses.forEach((e, i) => {
    if (e.status === 'running') return;
    const next = statuses[i + 1]?.date;
    const end = e.endDate && (!next || e.endDate < next) ? e.endDate : (next ?? today);
    const days = Math.round((t(end) - t(e.date)) / DAY);
    if (days < BREAK_STATUS_DAYS) return;
    const back = firstRunOnOrAfter(end);
    // Only when the run history reaches back PAST the status start: otherwise (an old break whose return run has
    // aged out of the ~90-day snapshot) `back` would be the oldest run still in the window and slide forward
    // every week, freezing the cycle. Old restarts are kept by the persisted list instead (getPeriodization).
    if (back && runDays.length && runDays[0] < e.date) out.push({ from: back, reason: `${e.status} ${days} days` });
  });
  // Build-1 Monday: the return week when back Mon–Wed, else the next Monday. Only restarts AFTER the anchor count.
  const anchorMon = anchor ? t(isoDate(mondayOf(new Date(anchor + 'T00:00:00')))) : -Infinity;
  const byMonday = new Map<string, CycleRestart>();
  for (const r of out) {
    const d = new Date(r.from + 'T00:00:00');
    const mon = mondayOf(d);
    if (((d.getDay() + 6) % 7) >= 3) mon.setDate(mon.getDate() + 7);   // Thu–Sun return → Build 1 next Monday
    const monday = isoDate(mon);
    if (t(monday) <= anchorMon) continue;
    const prev = byMonday.get(monday);
    if (!prev || r.from < prev.from) byMonday.set(monday, { from: r.from, monday, reason: r.reason });
  }
  return [...byMonday.values()].sort((a, b) => a.monday.localeCompare(b.monday));
}
// anchor = ISO date (YYYY-MM-DD) the athlete chose to START a cycle (its week = Build 1); '' → fixed calendar default.
export const DEFAULT_PERIODIZATION: Periodization = { on: true, buildWeeks: 3, deloadWeeks: 1, deloadDropPct: 25, anchor: '' };
const PERIODIZATION_KEY = 'periodization_v1';
const RESTARTS_KEY = 'periodization_restarts_v1';   // grow-only list of CONFIRMED restarts (survive the snapshot window)
let restartMemo: { key: string; at: number; p: Promise<CycleRestart[]> } | null = null;

// Detected restarts (from the ~90-day snapshot + timeline) MERGED with the persisted confirmed ones — a break older
// than the snapshot window can no longer be seen in the run gaps, and forgetting it would jump the cycle back onto
// the anchor's phase. Only confirmed restarts (return day before today) are persisted; the provisional "today" one
// isn't. Restarts at/before the (possibly later-moved) anchor are dropped on read.
async function detectRestarts(anchor: string): Promise<CycleRestart[]> {
  const today = isoDate(new Date());
  const [snap, events, status, storedRaw] = await Promise.all([
    loadSnapshotCache().catch(() => null), loadEvents().catch(() => []), getAthleteStatus().catch(() => null),
    SecureStore.getItemAsync(RESTARTS_KEY).catch(() => null),
  ]);
  // 4 am training-day attribution, like the rest of the load maths (a 1 am run belongs to the previous day).
  const runDays = ((snap as any)?.runs ?? []).map((r: RunWorkout) => trainingDayKey(r.date));
  const detected = computeCycleRestarts(runDays, events as any[], anchor, today, status?.status);
  let stored: CycleRestart[] = [];
  try { const a = storedRaw ? JSON.parse(storedRaw) : []; if (Array.isArray(a)) stored = a; } catch { /* ignore */ }
  // Re-validate stored restarts while the data can still see them: one whose return day is well INSIDE the run
  // window (≥30 days past its start) but is no longer detected — a Sick status logged by mistake and deleted, or a
  // run backfilled into the gap — is dropped. Older ones (outside what the window can prove) are kept.
  const sortedDays = [...runDays].sort();
  if (sortedDays.length) {
    const revalidateFrom = isoDate(new Date(new Date(sortedDays[0] + 'T00:00:00').getTime() + 30 * 86_400_000));
    stored = stored.filter(r => r.from < revalidateFrom || detected.some(d => d.monday === r.monday));
  }
  const byMonday = new Map<string, CycleRestart>();
  for (const r of [...stored, ...detected]) {
    const prev = byMonday.get(r.monday);
    const preBreakMin = prev?.preBreakMin ?? r.preBreakMin;   // a stored pre-break level survives re-detection
    if (!prev || r.from < prev.from) byMonday.set(r.monday, { ...r, preBreakMin });
    else if (preBreakMin != null && prev.preBreakMin == null) byMonday.set(r.monday, { ...prev, preBreakMin });
  }
  // Pre-break volume for restarts that don't have it yet: the best 7-day time-on-feet (the cap's own minutes basis)
  // in the 3 weeks ending on the last run before the break. Computed ONCE and persisted — old restarts keep theirs
  // after the history window moves on.
  const missing = [...byMonday.values()].filter(r => r.preBreakMin == null);
  if (missing.length) {
    // The last run BEFORE each return, from the run days we already have (the snapshot); the fetch then only has
    // to reach 3 weeks before the earliest of those. Unresolvable (no run before it in the snapshot, or no volume)
    // → preBreakMin 0 = "no floor", persisted, so the heavy lookup never re-runs on every refresh.
    const daysAsc: string[] = [...new Set<string>(runDays as string[])].sort();
    const lastBefore = new Map<string, string | undefined>(missing.map(r => [r.monday, [...daysAsc].reverse().find(dt => dt < r.from)]));
    const lasts = [...lastBefore.values()].filter((x): x is string => !!x);
    const minsBy = new Map<string, number>();
    let fetched = false;   // HealthKit actually answered (it throws while the phone is LOCKED — e.g. the morning auto-plan)
    if (lasts.length) {
      const earliestLast = lasts.reduce((m, x) => (x < m ? x : m));
      const span = Math.min(365, Math.round((new Date(today + 'T00:00:00').getTime() - new Date(earliestLast + 'T00:00:00').getTime()) / 86_400_000) + 22);
      const hist = await fetchDailyDurationHistory(undefined, span).catch(() => [] as { date: string; value: number }[]);
      fetched = hist.length > 0;   // there IS a run in the span (`last`), so an empty answer means "couldn't read", not "no volume"
      for (const h of hist) minsBy.set(h.date, h.value);
    }
    const shift = (k: string, n: number) => { const x = new Date(k + 'T00:00:00'); x.setDate(x.getDate() + n); return isoDate(x); };
    for (const r of missing) {
      const last = lastBefore.get(r.monday);
      if (last && !fetched) continue;   // HealthKit unreadable → leave it unset and retry later, never persist a false 0
      let best = 0;
      if (last) {
        for (let w = 0; w < 3; w++) {
          let s = 0; for (let j = 0; j < 7; j++) s += minsBy.get(shift(last, -j - 7 * w)) ?? 0;
          best = Math.max(best, s);
        }
      }
      byMonday.set(r.monday, { ...r, preBreakMin: Math.round(best) });   // 0 = unresolved → no floor, no retry
    }
  }
  const confirmed = [...byMonday.values()].filter(r => r.from < today).sort((a, b) => a.monday.localeCompare(b.monday)).slice(-50);
  if (confirmed.length !== stored.length || confirmed.some((r, i) => r.monday !== stored[i]?.monday || r.from !== stored[i]?.from || r.preBreakMin !== stored[i]?.preBreakMin)) {
    SecureStore.setItemAsync(RESTARTS_KEY, JSON.stringify(confirmed)).catch(() => {});
  }
  const anchorMon = anchor ? isoDate(mondayOf(new Date(anchor + 'T00:00:00'))) : '';
  return [...byMonday.values()].filter(r => !anchorMon || r.monday > anchorMon).sort((a, b) => a.monday.localeCompare(b.monday));
}
export async function getPeriodization(): Promise<Periodization> {
  try {
    const raw = await SecureStore.getItemAsync(PERIODIZATION_KEY);
    const p: Periodization = raw ? { ...DEFAULT_PERIODIZATION, ...JSON.parse(raw) } : { ...DEFAULT_PERIODIZATION };
    p.buildWeeks    = Math.max(1, Math.min(12, Math.round(p.buildWeeks)));
    p.deloadWeeks   = Math.max(1, Math.min(4,  Math.round(p.deloadWeeks)));
    p.deloadDropPct = Math.max(5, Math.min(60, Math.round(p.deloadDropPct)));
    p.anchor = typeof p.anchor === 'string' ? p.anchor : '';
    // First-use default: a blank anchor USED to fall back to a fixed 2024 epoch, which dropped a fresh
    // install onto an ARBITRARY point in the build/deload cycle (e.g. "deload week" in its very first week,
    // unrelated to that phone's training — the exact surprise Geert hit on a 2nd phone). Instead, anchor a
    // blank cycle to THIS week so the athlete starts at Build 1 now, and persist it once so it's stable and
    // shows up (editable) in Settings. Two devices only diverge if their anchors differ → reconcile by
    // setting the same Cycle start, tapping "This wk" on both, or restoring a backup (anchor is included).
    if (p.on && !p.anchor) {
      p.anchor = isoDate(mondayOf(new Date()));
      await setPeriodization(p);
    }
    p.restartAfterBreak = p.restartAfterBreak !== false;
    p.restarts = [];
    if (p.on && p.restartAfterBreak) {
      // Memoised ~60 s AS A PROMISE (parallel callers share one computation): getPeriodization runs for every plan
      // and every LLM call, and the snapshot is a few-hundred-KB JSON parse. Keyed on anchor + day + snapshot
      // version, so a changed cycle start, a new day or FRESH health data recomputes.
      const memoKey = `${p.anchor}|${isoDate(new Date())}|${getSnapshotVersion()}`;
      if (!restartMemo || restartMemo.key !== memoKey || Date.now() - restartMemo.at > 60_000) {
        restartMemo = { key: memoKey, at: Date.now(), p: detectRestarts(p.anchor) };
      }
      p.restarts = await restartMemo.p.catch(() => []);
    }
    return p;
  } catch { return { ...DEFAULT_PERIODIZATION }; }
}
export async function setPeriodization(p: Periodization): Promise<void> {
  const { restarts: _derived, ...persist } = p;   // restarts are derived from data every read — never stored
  try { await SecureStore.setItemAsync(PERIODIZATION_KEY, JSON.stringify(persist)); } catch { /* ignore */ }
}

// Monday of the ISO week containing `d` (local).
function mondayOf(d: Date): Date { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
// Local YYYY-MM-DD (the anchor storage format, read back via `new Date(anchor + 'T00:00:00')`).
function isoDate(d: Date): string { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
// Last-resort reference only: getPeriodization now fills a blank anchor with the current week, so weekIndex
// almost always has a real anchor. This epoch just keeps the math finite if an anchor is somehow missing/invalid.
const PERIODIZATION_EPOCH = new Date(2024, 0, 1); // a Monday
// Week position in the cycle. The reference Monday is the anchor, or the latest RESTART after time off whose
// first day back is on/before `d`. `returnWeek` = a Thu–Sun return's partial week before its Build-1 Monday (a
// gentle build week, never a deload); `restarted` = the position counts from a restart, not the anchor.
function cyclePos(d: Date, per: Periodization): { idx: number; returnWeek: boolean; restarted: boolean; restart?: CycleRestart } {
  let ref = per.anchor ? mondayOf(new Date(per.anchor + 'T00:00:00')) : PERIODIZATION_EPOCH;
  if (Number.isNaN(ref.getTime())) ref = PERIODIZATION_EPOCH;
  const md = mondayOf(d), dKey = isoDate(d);
  let restarted = false, restart: CycleRestart | undefined;
  for (const r of per.restarts ?? []) {                          // sorted by monday (monotonic in `from`)
    const rm = new Date(r.monday + 'T00:00:00');
    // Not back yet on `d` AND `d` is before the restart's Build-1 week → the restart doesn't apply. (A Mon–Wed return
    // makes its WHOLE week Build 1, including the days before the first run back.)
    if (r.from > dKey && md.getTime() < rm.getTime()) break;
    if (md.getTime() < rm.getTime()) return { idx: 0, returnWeek: true, restarted: true, restart: r };
    ref = rm; restarted = true; restart = r;
  }
  return { idx: Math.round((md.getTime() - ref.getTime()) / (7 * 86_400_000)), returnWeek: false, restarted, restart };
}

/**
 * Volume-ceiling FLOOR (minutes of time on feet per rolling 7 days) after a break: the return week gets
 * RESTART_VOLUME_PCT% of the pre-break level, each week after it +capPct% on that, never above the pre-break level.
 * Applies only in the return week + the first build phase after the restart (a deload week keeps its normal cap).
 * 0 = no floor. Call sites use max(normal ceiling, floor), so a strong comeback's own base still wins.
 */
export function restartVolumeFloor(date: Date, per: Periodization, capPct: number): number {
  if (!per.on) return 0;
  const pos = cyclePos(date, per);
  const r = pos.restart;
  if (!pos.restarted || !r?.preBreakMin) return 0;
  if (!pos.returnWeek && pos.idx >= per.buildWeeks) return 0;
  // Weeks since the RETURN week: Mon–Wed return → its own week is Build 1 (k = idx); Thu–Sun return → the partial
  // "back from break" week is k 0 and Build 1 (the next Monday) is k 1.
  const thuSun = r.monday > isoDate(mondayOf(new Date(r.from + 'T00:00:00')));
  const k = pos.returnWeek ? 0 : pos.idx + (thuSun ? 1 : 0);
  const base0 = r.preBreakMin * RESTART_VOLUME_PCT / 100;
  return Math.round(Math.min(r.preBreakMin, base0 * Math.pow(1 + capPct / 100, k)));
}
function weekIndex(d: Date, per: Periodization): number { return cyclePos(d, per).idx; }

// Per-week cap multiplier: +cap% ramp on a build week; a drop on the FIRST deload week (hold thereafter);
// a rebuild jump on the first build week AFTER a deload (undo the drop + ramp → back to the pre-deload
// level, not the trough). Returns the plain ramp when periodization is off.
// `smoothBase`: the base the cap grows off is the MAX of the last N weeks (anti-heat-erosion), which does
// NOT dip during the deload week — so the rebuild-jump compensation would DOUBLE-COUNT (base already holds
// the pre-deload peak). With a smoothed base the first build week after a deload uses the PLAIN ramp: base
// (=peak) × ramp = peak+cap%, resuming from where you left off. The rebuild jump is only correct when the
// base tracks last-week (which collapsed to the deload trough), so keep it for the raw-base default.
// ── Freshness-aware volume cap ────────────────────────────────────────────────────────────────────
// The rolling +X%/week ceiling is a RAW 7-day minutes sum: it has no decay, so two full rest days do not
// move it at all. The physiological load model does have decay — ACWR (acute:chronic) and TSB (form) —
// and those two can disagree sharply with the raw sum. Observed 2026-08-17: 270 min in the trailing
// window said "no budget", while ACWR 0.98 / TSB +2.3 after two rest days said "fully absorbed, go".
//
// ACWR is the injury-risk measure the sports-science literature actually validates (0.8–1.3 sweet spot),
// so when it sits in or below that band AND form is neutral-or-positive, the raw ceiling is the cruder,
// over-restrictive guard and may flex UP. When ACWR is above the band, or form is deeply negative, it
// tightens instead. Deliberately BOUNDED — freshness modulates the ramp, it never unlocks an open week.
export const FRESHNESS_MAX_BONUS = 0.20;   // most the ceiling may flex up when demonstrably absorbed
export const FRESHNESS_MAX_CUT   = 0.25;   // most it tightens when the acute load is spiking
export function freshnessCapFactor(tsb?: number | null, acwr?: number | null, buildWeek = false): number {
  let f = 1;
  // A BUILD week is SUPPOSED to accumulate a little fatigue — the deload week that follows is what
  // dissipates it. So on a build week the freshness cap stops FIGHTING the block: the milder ACWR cut is
  // deferred (1.45 not 1.3), the deep-fatigue cut is deferred (−22 not −15), and the growth band opens at a
  // mildly-negative TSB (−8) instead of demanding you already be fresh. A real spike (ACWR > 1.5) still
  // hard-tightens on ANY week — that's a safety floor, not a periodization lever. Deload/leisure weeks
  // (buildWeek=false) keep the strict thresholds, so this only unlocks controlled overload inside a build.
  const midCut       = buildWeek ? 1.45 : 1.3;
  const fatigueFloor = buildWeek ? -22  : -15;
  const relaxFloor   = buildWeek ? -8   : 0;
  // TIGHTEN first — a spiking acute:chronic ratio outranks any amount of self-reported freshness.
  if (acwr != null && acwr > 1.5)         f -= FRESHNESS_MAX_CUT;       // clear spike → hard tighten (all weeks)
  else if (acwr != null && acwr > midCut) f -= 0.10;                    // above the (week-dependent) sweet spot
  if (tsb != null && tsb <= fatigueFloor) f -= 0.10;                    // deeply fatigued
  // RELAX when the load is being absorbed: form at/above the (week-dependent) floor and ACWR in/below band.
  else if (tsb != null && tsb >= relaxFloor && (acwr == null || acwr <= midCut)) {
    // Scale with form from the floor (no bonus) to +13 (full bonus); the "fully-absorbed" kicker still needs
    // a genuinely non-negative TSB, so a mildly-fatigued build day gets a gentle nudge, not the full stack.
    const span = 13 - relaxFloor;
    f += Math.min(FRESHNESS_MAX_BONUS, Math.max(0, (tsb - relaxFloor) / span) * FRESHNESS_MAX_BONUS)
       + (tsb >= 0 && acwr != null && acwr <= 1.0 ? 0.05 : 0);          // fully absorbed → a little more
  }
  return Math.max(1 - FRESHNESS_MAX_CUT, Math.min(1 + FRESHNESS_MAX_BONUS, Math.round(f * 1000) / 1000));
}

export function weekCapMultiplier(dateInWeek: Date, per: Periodization, capPct: number, smoothBase = false): number {
  const ramp = 1 + capPct / 100;
  if (!per.on) return ramp;
  const cycleLen = per.buildWeeks + per.deloadWeeks;
  const pos = cyclePos(dateInWeek, per);
  if (pos.returnWeek) return ramp;                  // back from a break (partial week) → a plain build ramp
  const idx = pos.idx;
  // (After a restart idx counts from the restart Monday, so its first cycle is cycleNum 0 → no rebuild jump.)
  const cycleNum = Math.floor(idx / cycleLen);
  const w = ((idx % cycleLen) + cycleLen) % cycleLen;
  const deload = 1 - per.deloadDropPct / 100;
  if (w < per.buildWeeks) return (w === 0 && cycleNum > 0 && !smoothBase) ? ramp / deload : ramp;
  return (w === per.buildWeeks) ? deload : 1;
}

// Human-readable phase for the week containing `date`.
export function cyclePhase(date: Date, per: Periodization): { phase: 'build' | 'deload'; label: string } {
  if (!per.on) return { phase: 'build', label: '' };
  const cycleLen = per.buildWeeks + per.deloadWeeks;
  const pos = cyclePos(date, per);
  if (pos.returnWeek) return { phase: 'build', label: 'Back from break' };
  const w = ((pos.idx % cycleLen) + cycleLen) % cycleLen;
  const fresh = pos.restarted && pos.idx < per.buildWeeks;   // the first build phase after a break
  if (w < per.buildWeeks) return { phase: 'build', label: `Build ${w + 1}/${per.buildWeeks}${fresh ? ' · after break' : ''}` };
  return { phase: 'deload', label: per.deloadWeeks > 1 ? `Deload ${w - per.buildWeeks + 1}/${per.deloadWeeks}` : 'Deload week' };
}

export interface CapOpts {
  capPct?:       number;  // rolling increase cap % (default 10)
  meaningful?:   number;  // a run "counts" once the budget allows ≥ this (min or km)
  reentryBelow?: number;  // prior-7 below this → apply the re-entry floor
  reentryFloor?: number;  // minimum budget when returning from a near-zero base
  periodization?: Periodization; // build/deload cycle modulating the per-week cap multiplier
  // Anti-heat-erosion (see computeTimeOnFeetPlan): the base the +cap% ceiling grows off used to be
  // the single raw prior week, so a heat-shortened week permanently dragged next week's ceiling down.
  heatCredit?:   Record<string, number>; // date(YYYY-MM-DD) → heat factor experienced that day (≥1). A heat-cut
  //                                         run counts as its ~normal-conditions volume so weather doesn't erode fitness.
  heatCreditMax?: number; // per-day credit ceiling (default 1.15) — bounds crediting so it can't spiral the cap up.
  freshness?:    number;  // ceiling modulation from ACWR/TSB (freshnessCapFactor); 1 = neutral
  // restartVolumeFloor is in TIME-ON-FEET MINUTES; a caller whose series is another unit converts it (km: 1/pace).
  // Default 1 (minutes series).
  restartFloorScale?: number;
  baseWindows?:  number;  // # of prior 7-day blocks to take the MAX over as the base (default 1). >1 → a single bad
  //                         (hot / sick / travel) week can't drop the ceiling; the base tracks demonstrated capacity.
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
  // smoothBase = the base is a max-of-N-weeks (doesn't dip in deload) → skip the rebuild jump (see weekCapMultiplier).
  const smoothBase = (opts.baseWindows ?? 1) > 1;
  const weekMultAt = (offsetDays: number) => {
    if (!per) return (1 + capPct / 100) * freshFac;
    const d = new Date(today); d.setDate(d.getDate() + offsetDays);
    return weekCapMultiplier(d, per, capPct, smoothBase) * freshFac;
  };
  const meaningful   = opts.meaningful   ?? 20;
  const reentryBelow = opts.reentryBelow ?? 30;
  const reentryFloor = opts.reentryFloor ?? 20;
  const heatCredit   = opts.heatCredit   ?? {};
  const heatCreditMax = opts.heatCreditMax ?? 1.15;
  const baseWindows  = Math.max(1, Math.round(opts.baseWindows ?? 1));
  // Freshness modulation of the ceiling (1 = neutral). Passed in so this stays a pure function.
  const freshFac     = opts.freshness ?? 1;
  const map = new Map(daily.map(d => [d.date, d.value]));
  const p = (n: number) => String(n).padStart(2, '0');
  const dayStr = (offset: number) => {
    const d = new Date(today); d.setDate(d.getDate() - offset);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const minsAt = (offset: number) => map.get(dayStr(offset)) ?? 0;
  // Heat-credit: a run done in the heat counts as its ~normal-conditions volume (raw × the day's heat
  // factor, capped) so weather doesn't erode the fitness base. clampCredit keeps it in [1, heatCreditMax].
  const clampCredit = (f?: number) => Math.min(Math.max(1, f ?? 1), heatCreditMax);
  const creditAt = (offset: number) => minsAt(offset) * clampCredit(heatCredit[dayStr(offset)]);
  // The base the +cap% ceiling grows off = the MAX over the last `baseWindows` 7-day blocks (each
  // heat-credited). max-of-N means a single hot/sick/travel week can't ratchet the ceiling down —
  // it tracks demonstrated capacity. baseWindows=1 + empty heatCredit ⇒ identical to the old raw prev-7.
  const blockSumAgo = (startAgo: number) => { let s = 0; for (let j = 0; j < 7; j++) s += creditAt(startAgo + j); return s; };
  const baseRefAgo  = () => { let best = 0; for (let w = 0; w < baseWindows; w++) best = Math.max(best, blockSumAgo(7 + 7 * w)); return best; };

  let tofLast6  = 0; for (let o = 1; o <= 6;  o++) tofLast6  += minsAt(o);
  let tofPrev7  = 0; for (let o = 7; o <= 13; o++) tofPrev7  += minsAt(o);  // RAW immediate prior week (re-entry gate + display)
  const todayDone = minsAt(0);                       // time-on-feet ALREADY done today (e.g. a morning run)
  // After a break: never below the restart floor (75% of pre-break, +cap%/wk). Freshness may still CUT it (safety),
  // never raise it.
  const floorAt = (offsetDays: number) => {
    if (!per) return 0;
    const d = new Date(today); d.setDate(d.getDate() + offsetDays);
    return Math.round(restartVolumeFloor(d, per, capPct) * Math.min(1, freshFac) * (opts.restartFloorScale ?? 1));
  };
  const cap = Math.max(Math.round(weekMultAt(0) * baseRefAgo()), floorAt(0));
  // The cap limits the TRAILING-7 window (days 0–6), so today's remaining room must subtract BOTH the
  // last 6 days AND what's already been run today — otherwise after a morning run the plan offers the
  // whole day's allowance again and a second session blows the weekly cap (eating next week's budget).
  let budget = Math.max(0, cap - tofLast6 - todayDone);
  if (tofPrev7 < reentryBelow) budget = Math.max(budget, reentryFloor); // re-entry / very low base

  const series14: { date: string; min: number }[] = [];
  for (let o = 13; o >= 0; o--) series14.push({ date: dayStr(o), min: minsAt(o) });
  const series28: { date: string; min: number }[] = [];
  for (let o = 27; o >= 0; o--) series28.push({ date: dayStr(o), min: minsAt(o) });

  // Forward-project the rolling cap to find the earliest day a meaningful-length run fits again,
  // ASSUMING REST until then: each future rest day rolls an old high-volume day off the trailing
  // window, so the budget recovers. minIdx(i): past/today carry real minutes, future days = 0.
  const minIdx = (i: number) => (i <= 0 ? minsAt(-i) : 0);
  // Credited/max-window base for a projected day k (mirrors baseRefAgo but indexed forward in time;
  // future days carry 0 minutes so they never inflate the base). Consumption (last6) stays RAW.
  const creditIdx = (i: number) => minIdx(i) * (i <= 0 ? clampCredit(heatCredit[dayStr(-i)]) : 1);
  const baseRefAt = (k: number) => {
    let best = 0;
    for (let w = 0; w < baseWindows; w++) { let s = 0; for (let j = 7; j <= 13; j++) s += creditIdx(k - j - 7 * w); best = Math.max(best, s); }
    return best;
  };
  let nextRunInDays = 0, nextRunBudgetMin = budget;
  for (let k = 0; k <= 21; k++) {
    let last6 = 0; for (let j = 1; j <= 6;  j++) last6 += minIdx(k - j);
    let prev7 = 0; for (let j = 7; j <= 13; j++) prev7 += minIdx(k - j);   // raw, for the re-entry gate only
    // minIdx(k) = the current day's already-done minutes (today's run for k=0; 0 for future days) —
    // subtract it too so "does a run fit today?" reflects what's already on the legs today.
    let b = Math.max(0, Math.max(Math.round(weekMultAt(k) * baseRefAt(k)), floorAt(k)) - last6 - minIdx(k));
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
    series28,
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
  cap: TofPlan;            // the ACTIVE-basis plan (=== tof when basis is 'tof'; the LOAD plan under a CTL ramp)
  ramp?: RampBudget;       // set when a CTL ramp target drives the budget (load, not minutes)
  budgetMin: number;       // today's budget as run-MINUTES (distance cap → pace-converted)
  loadUnit: 'min' | 'km';
  capBasis: LoadCapBasis;
  capPct: number;
  paceMinPerKm: number;    // trailing real-work pace (min/km); 0 in tof mode (unused there)
  heatCredit: Record<string, number>; // date → heat factor experienced (for the week planner's matching base)
}

/**
 * FITNESS-RAMP volume budget (2026-10-08, Geert: "load, not minutes"). With a CTL ramp target set, the rolling 7-day
 * budget is the ramp's own LOAD target — 7·(CTL + ramp/(1−e^(−7/42))), the load that lifts CTL by `ramp`/week — minus
 * the last 6 days' load and today's so far. The old path turned that target into a +% on the previous week's MINUTES,
 * which broke when the two weeks' intensity mix differed (2026-10-08: 317 load in 179 min, then 289 load in 208 min
 * → "at the +4 % ceiling, rest" while ~48 load / ~40 min easy was still due). Expressed back in easy-run minutes via
 * the athlete's calibrated easy TRIMP/min so every minute-based consumer (daily plan, LLM, next-run) just works.
 * Freshness (TSB/ACWR) may only shrink the ramp's increment (never boost it, never below maintenance); recovery/sleep
 * ease or rest the day further down (unchanged).
 */
export interface RampBudget { ramp: number; target7: number; load7: number; budgetLoad: number; easyRate: number; rates?: TrimpRates }
export function rampLoadPlan(
  series: { date: string; load: number; ctl: number }[], ramp: number, toDate: Date, easyRate: number, freshFac = 1,
  deloadDropPct?: number,   // a deload week → no ramp increment, maintenance × (1 − drop)
): { plan: TofPlan; info: RampBudget } | null {
  const p = (n: number) => String(n).padStart(2, '0');
  const keyAt = (offset: number) => { const d = new Date(toDate); d.setDate(d.getDate() - offset); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  const byDate = new Map(series.map(d => [d.date, d]));
  const loadAt = (offset: number) => { const v = byDate.get(keyAt(offset))?.load; return Number.isFinite(v) ? (v as number) : 0; };
  const ctl = byDate.get(keyAt(1))?.ctl;   // CTL at the end of yesterday (the last completed day)
  if (!Number.isFinite(ctl) || !(easyRate > 0)) return null;
  // Freshness (TSB/ACWR) may only EASE the ramp's increment — never boost it, never cut below maintenance
  const target7 = deloadDropPct != null
    ? 7 * (ctl as number) * Math.max(0.5, 1 - deloadDropPct / 100)
    : 7 * ((ctl as number) + Math.max(0, Math.min(1, freshFac)) * ramp / CTL_WEEK_RESPONSE);
  let last6 = 0; for (let o = 1; o <= 6; o++) last6 += loadAt(o);
  // every day carries background load (NEAT / activity floor ~ the quietest days' load): reserve it for the rest of
  // today and for future rest days, so the budget and the next-run day don't overshoot by a day's floor
  const quiet = Array.from({ length: 14 }, (_, i) => loadAt(i + 1)).sort((a, b) => a - b).slice(0, 3);
  const floor = quiet.length ? quiet[Math.floor(quiet.length / 2)] : 0;
  const today = Math.max(loadAt(0), floor);
  const budgetLoad = Math.max(0, target7 - last6 - today);
  const toMin = (load: number) => Math.round(load / easyRate);
  // next day a meaningful (20-min easy) run fits, assuming rest until then (old high days roll off the window)
  const meaningful = 20 * easyRate;
  let nextRunInDays = 0, nextBudget = budgetLoad;
  for (let k = 0; k <= 21; k++) {
    let l6 = 0; for (let j = 1; j <= 6; j++) l6 += k - j < 0 ? loadAt(j - k) : k - j === 0 ? today : floor;
    const b = Math.max(0, target7 - l6 - (k === 0 ? today : floor));
    if (b >= meaningful) { nextRunInDays = k; nextBudget = b; break; }
  }
  const nd = new Date(toDate); nd.setDate(nd.getDate() + nextRunInDays);
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const seriesN = (n: number) => { const out: { date: string; min: number }[] = []; for (let o = n - 1; o >= 0; o--) out.push({ date: keyAt(o), min: toMin(loadAt(o)) }); return out; };
  let prev7 = 0; for (let o = 7; o <= 13; o++) prev7 += loadAt(o);
  const plan: TofPlan = {
    series14: seriesN(14), series28: seriesN(28),
    tof7d: toMin(last6 + today), tofPrev7d: toMin(prev7), cap7dMin: toMin(target7),
    budgetTodayMin: toMin(budgetLoad), yesterdayMin: toMin(loadAt(1)),
    nextRunInDays, nextRunDate: `${nd.getFullYear()}-${p(nd.getMonth() + 1)}-${p(nd.getDate())}`,
    nextRunLabel: `${WD[nd.getDay()]} ${nd.getDate()} ${MO[nd.getMonth()]}`, nextRunBudgetMin: toMin(nextBudget),
  };
  return { plan, info: { ramp, target7: Math.round(target7), load7: Math.round(last6 + today), budgetLoad: Math.round(budgetLoad), easyRate } };
}

// Anti-heat-erosion tuning for the rolling cap (shared by the daily engine + the week planner so both
// grow off the same base). See computeTimeOnFeetPlan / CapOpts.
export const HEAT_CREDIT_MAX = 1.15;  // a heat day counts for at most +15% of its raw minutes
export const BASE_WINDOWS    = 3;     // ceiling = +cap% × MAX of the last 3 comparable weeks (heat-credited)

/**
 * The rolling progression cap, honouring the user's settings. Time-on-feet is ALWAYS computed (the
 * alternation rule + the watch-workout time budget need it); when the basis is DISTANCE the cap is
 * recomputed on real-work km and its budget converted back to run-minutes via trailing pace.
 * `durSeries` = work+drills minutes per day (caller already has it); `toDate` is the viewed day.
 */
export async function buildCapContext(
  durSeries: { date: string; value: number }[], toDate: Date, capPct: number, capBasis: LoadCapBasis,
  // Current load model — lets the raw-sum ceiling flex with ACWR/TSB. Omitted → neutral (factor 1), so
  // every existing caller keeps today's behaviour until it opts in.
  tsbNow?: number | null, acwrNow?: number | null,
  tlSeries?: { date: string; load: number; ctl: number }[],   // the caller's fresh training-load series (saves a re-fetch)
): Promise<CapContext> {
  const periodization = await getPeriodization();
  const buildWk = periodization.on && cyclePhase(toDate, periodization).phase === 'build';  // relax freshness inside a build block
  // HEAT-CREDIT map: reconstruct each past run-day's heat factor from its stored workout weather, so the
  // rolling-cap base counts a heat-shortened run as its ~normal-conditions volume (weather ≠ fitness drop).
  const weatherHist = await fetchDailyRunWeatherHistory(toDate).catch(() => ({} as Record<string, { tempC: number; humidity?: number }>));
  const heatCredit: Record<string, number> = {};
  for (const [date, w] of Object.entries(weatherHist)) heatCredit[date] = heatStrainFactor({ tempC: w.tempC, humidity: w.humidity });
  const antiErosion = { heatCredit, heatCreditMax: HEAT_CREDIT_MAX, baseWindows: BASE_WINDOWS };
  const tof = computeTimeOnFeetPlan(durSeries, toDate, { capPct, meaningful: 20, reentryBelow: 30, reentryFloor: 20, periodization, freshness: freshnessCapFactor(tsbNow, acwrNow, buildWk), ...antiErosion });
  // A CTL ramp target → the budget is LOAD (the ramp's own 7-day target), not a % on minutes (see rampLoadPlan)
  const rampT = await getCtlRampTarget().catch(() => null);
  if (rampT != null && capBasis !== 'distance') {
    // up to NOW (or the end of a past viewed day) — a midnight toDate would drop today's load from the budget
    const eod = new Date(toDate); eod.setHours(23, 59, 59, 999);
    const tlEnd = new Date(Math.min(Date.now(), eod.getTime()));
    const [tl, snapC] = await Promise.all([tlSeries?.length ? tlSeries : fetchTrainingLoadHistory(1, tlEnd).catch(() => [] as any[]), loadSnapshotCache().catch(() => null)]);
    const easyRate = (snapC as any)?.trimpRates?.easy ?? estimateDayTrimp('easy', 100) / 100;
    // freshness from the same series the home uses when the caller didn't pass TSB/ACWR (Daily Coach / Strain screens)
    const tk = (() => { const q = (n: number) => String(n).padStart(2, '0'); return `${toDate.getFullYear()}-${q(toDate.getMonth() + 1)}-${q(toDate.getDate())}`; })();
    const last = (tl as any[]).filter(d => d.date <= tk).at(-1) ?? (tl as any[]).at(-1);   // same entry the home uses (tlLast)
    const tsbF = tsbNow ?? last?.tsb, acwrF = acwrNow ?? (last?.ctl > 0 ? last.atl / last.ctl : undefined);
    const deloadNow = periodization.on && cyclePhase(toDate, periodization).phase === 'deload';
    const rp = rampLoadPlan(tl as any[], rampT, toDate, easyRate, freshnessCapFactor(tsbF, acwrF, buildWk), deloadNow ? periodization.deloadDropPct : undefined);
    if (rp) return { tof, cap: rp.plan, ramp: { ...rp.info, ...((snapC as any)?.trimpRates ? { rates: (snapC as any).trimpRates } : {}) }, budgetMin: rp.plan.budgetTodayMin, loadUnit: 'min', capBasis, capPct, paceMinPerKm: 0, heatCredit };
  }
  if (capBasis !== 'distance') return { tof, cap: tof, budgetMin: tof.budgetTodayMin, loadUnit: 'min', capBasis, capPct, paceMinPerKm: 0, heatCredit };

  const distKm = await fetchDailyWorkDistanceHistory(toDate);
  const p = (n: number) => String(n).padStart(2, '0');
  const dStr = `${toDate.getFullYear()}-${p(toDate.getMonth() + 1)}-${p(toDate.getDate())}`;
  // The 7 CALENDAR days ending today (same window as tof7d). `slice(-7)` took the last 7 RUN days — right after a
  // break those reach back before it, giving a far-too-low pace that inflated the km floor and budget.
  const wk0 = new Date(toDate); wk0.setDate(wk0.getDate() - 7);
  const dStrMinus7 = `${wk0.getFullYear()}-${p(wk0.getMonth() + 1)}-${p(wk0.getDate())}`;
  const dist7d = distKm.filter(d => d.date <= dStr && d.date > dStrMinus7).reduce((s, d) => s + d.value, 0);
  const paceMinPerKm = dist7d > 0 ? tof.tof7d / dist7d : 6; // fallback ~6 min/km
  // The restart floor is in MINUTES → convert to km for this km series (applying it raw made a 193-km cap).
  const cap = computeTimeOnFeetPlan(distKm, toDate, { capPct, meaningful: 2, reentryBelow: 3, reentryFloor: 2, periodization, freshness: freshnessCapFactor(tsbNow, acwrNow, buildWk), restartFloorScale: paceMinPerKm > 0 ? 1 / paceMinPerKm : 0, ...antiErosion });
  return { tof, cap, budgetMin: Math.round(cap.budgetTodayMin * paceMinPerKm), loadUnit: 'km', capBasis, capPct, paceMinPerKm, heatCredit };
}

export interface CapWeek {
  weekStart:  string;   // Monday YYYY-MM-DD
  label:      string;   // e.g. "Aug 4"
  actualMin:  number;   // raw time-on-feet that week
  ceilingMin: number;   // the +cap% rolling ceiling entering that week (heat-credited, max-of-N base)
  hitPct:     number;   // actualMin / ceilingMin × 100  (>100 = at/over the cap)
  phase:      string;   // "Build 2/4" | "Deload week" | ''
  heatTaxPct: number;   // avg heat tax over the week's run days: (heatFactor − 1) × 100
  capPct:     number;   // the +cap% in force THAT week (point-in-time; may differ from the current setting)
  isCurrent:  boolean;  // the in-progress week (actual still accumulating)
}

/**
 * Week-by-week BUDGET vs ACTUAL readout (see the Volume vs Budget card in app/statistics.tsx): for each of the last `weeks` weeks,
 * the +cap% ceiling that applied (heat-credited, max-of-N-weeks base — the same math the daily engine
 * uses) vs what was actually run, plus that week's heat tax and periodization phase. Makes the
 * anti-erosion cap visible: are you reaching the ceiling, and how much is heat costing you?
 */
export async function computeCapHistory(weeks = 12, toDate = new Date()): Promise<CapWeek[]> {
  const [periodization, capList, rampWeeks] = await Promise.all([getPeriodization(), getLoadCapPctList(), getCtlRampWeeks()]);
  const spanDays = weeks * 7 + 28;   // +28d so the earliest week's base lookback is covered
  const [dur, weatherHist] = await Promise.all([
    fetchDailyDurationHistory(toDate, spanDays),
    fetchDailyRunWeatherHistory(toDate, spanDays).catch(() => ({} as Record<string, { tempC: number; humidity?: number }>)),
  ]);
  const heatCredit: Record<string, number> = {};
  for (const [date, w] of Object.entries(weatherHist)) heatCredit[date] = heatStrainFactor({ tempC: w.tempC, humidity: w.humidity });
  const map = new Map(dur.map(d => [d.date, d.value]));
  const pad = (n: number) => String(n).padStart(2, '0');
  const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const thisMonday = mondayOf(toDate);
  const out: CapWeek[] = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const monday = new Date(thisMonday); monday.setDate(monday.getDate() - 7 * w);
    // POINT-IN-TIME cap %: use the +cap% that was in force ON THIS MONDAY (not the current one), so changing
    // the cap only affects budgets from its change date forward and past weeks keep the % they trained under.
    const capPct = rampWeeks[iso(monday)] ?? capPctForDate(iso(monday), capList);   // a CTL-ramp week → its derived %
    // Ceiling ENTERING the week = the daily engine's cap7d computed as of that Monday (weekMult × the
    // max-of-N heat-credited base of the 3 weeks before it) — guaranteed identical to what the plan uses.
    const plan = computeTimeOnFeetPlan(dur, monday, { capPct, baseWindows: BASE_WINDOWS, heatCredit, heatCreditMax: HEAT_CREDIT_MAX, periodization });
    let actual = 0, heatSum = 0, runDays = 0;
    for (let j = 0; j < 7; j++) {
      const d = new Date(monday); d.setDate(d.getDate() + j);
      const min = map.get(iso(d)) ?? 0;
      actual += min;
      if (min > 0) { runDays++; heatSum += (heatCredit[iso(d)] ?? 1) - 1; }
    }
    const ceiling = plan.cap7dMin;
    out.push({
      weekStart:  iso(monday),
      label:      `${MO[monday.getMonth()]} ${monday.getDate()}`,
      actualMin:  Math.round(actual),
      ceilingMin: Math.round(ceiling),
      hitPct:     ceiling > 0 ? Math.round((actual / ceiling) * 100) : 0,
      phase:      cyclePhase(monday, periodization).label,
      heatTaxPct: runDays > 0 ? Math.round((heatSum / runDays) * 100) : 0,
      capPct,
      isCurrent:  w === 0,
    });
  }
  return out;
}

export interface Rolling7d { actualMin: number; ceilingMin: number; hitPct: number }
// Rolling (trailing) 7-day time-on-feet vs the same +cap% ceiling — the "am I over the cap right now"
// view, complementing the calendar-week bars. Reuses the identical daily engine as computeCapHistory.
export async function computeRolling7d(toDate = new Date()): Promise<Rolling7d> {
  const [periodization, capPct] = await Promise.all([getPeriodization(), getLoadCapPct()]);
  const [dur, weatherHist] = await Promise.all([
    fetchDailyDurationHistory(toDate, 35),
    fetchDailyRunWeatherHistory(toDate, 35).catch(() => ({} as Record<string, { tempC: number; humidity?: number }>)),
  ]);
  const heatCredit: Record<string, number> = {};
  for (const [date, w] of Object.entries(weatherHist)) heatCredit[date] = heatStrainFactor({ tempC: w.tempC, humidity: w.humidity });
  const map = new Map(dur.map(d => [d.date, d.value]));
  const pad = (n: number) => String(n).padStart(2, '0');
  const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  let actual = 0;
  for (let j = 0; j < 7; j++) { const d = new Date(toDate); d.setDate(d.getDate() - j); actual += map.get(iso(d)) ?? 0; }
  const plan = computeTimeOnFeetPlan(dur, toDate, { capPct, baseWindows: BASE_WINDOWS, heatCredit, heatCreditMax: HEAT_CREDIT_MAX, periodization });
  const ceiling = Math.round(plan.cap7dMin);
  return { actualMin: Math.round(actual), ceilingMin: ceiling, hitPct: ceiling > 0 ? Math.round((actual / ceiling) * 100) : 0 };
}

/**
 * Build the full coach snapshot from HealthKit + weather for a given day's strain.
 * Single source used by both the Strain screen and the background day-view updater, so
 * the on-demand plan and the auto-prepared plan are identical.
 */


export async function assembleCoachSnapshot(strain: DayStrain | null, activities?: ActivitySummary[], runs?: RunWorkout[]): Promise<CoachSnapshot> {
  // Refresh the sync-readable workout-structure cache so synthesizeWorkout / parseWorkout (both sync) see
  // the athlete's current warm-up / cool-down / drills config before any plan or watch workout is built.
  // Awaited in parallel below (the throwaway slot) so it's settled before the caller builds a workout.
  const [comps, dur, weather, powerZones, capPct, capBasis, status, events, supps, maxHR, tlSeries, ctlRampT] = await Promise.all([
    fetchOurDailyComponents(1),
    fetchDailyDurationHistory(),
    getLocalWeather().catch(() => null),
    getPowerZones().catch(() => undefined),
    getLoadCapPct(),
    getLoadCapBasis(),
    getAthleteStatus(),
    loadEvents(),
    loadSupplements(),
    getEffectiveMaxHr().catch(() => 190),   // to normalise realised run HR → reserve for the quality LOAD ramp
    fetchTrainingLoadHistory(1).catch(() => [] as any[]),  // FRESH CTL/ATL/TSB (see below) — not the DC cache
    getCtlRampTarget().catch(() => null),                   // fitness ramp → the week planner's fill target
    refreshWorkoutStructure().catch(() => DEFAULT_WORKOUT_STRUCTURE),
    refreshAccountingMode().catch(() => DEFAULT_ACCOUNTING),
    refreshHeatSensitivity().catch(() => DEFAULT_HEAT_SENSITIVITY),
  ]);
  const dates  = Object.keys(comps).sort();
  const latest = dates.length ? comps[dates[dates.length - 1]] : {};
  const dataDate = dates.length ? dates[dates.length - 1] : '';
  // CTL/ATL/TSB come FRESH from the training-load engine, NOT the daily-components CACHE. The cache serves a
  // stored value that can drift stale (observed CTL 44 in the plan vs a freshly-computed ~40 — the latter
  // confirmed by an independent app (HealthFit CTL 41) — because the cache held CTL from an earlier build
  // with since-changed inputs). This is the SAME computation the Training Load screen uses, so the coach,
  // that screen, and HealthFit agree. Falls back to the cached components value if the fetch failed.
  const tlLast = Array.isArray(tlSeries) && tlSeries.length ? tlSeries[tlSeries.length - 1] : null;
  // ACWR MUST be consistent with the CTL/ATL we report — both from tlLast (the authoritative
  // training-load history the Training Load screen + HealthFit agree with). The old strain.acwr came
  // from a SEPARATE snapshot, so the coach/LLM quoted an ATL & CTL that didn't divide to the ACWR it
  // also quoted (e.g. ATL 47.9 / CTL 41.3 = 1.16, but acwr read 1.22). Derive it here; fall back to strain.
  const acwrConsistent = (tlLast && (tlLast.ctl ?? 0) > 0)
    ? Math.round((tlLast.atl / tlLast.ctl) * 100) / 100
    : (strain?.acwr || undefined);
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
  // Yesterday = the calendar day BEFORE the plan's date, looked up by KEY — not strainHist[length-2],
  // which is off by one whenever today's components aren't in `comps` yet (then the array ends at
  // yesterday, so [length-2] reads the day BEFORE yesterday → "yesterday's intervals" ghost).
  const yDate = new Date(new Date(date + 'T00:00:00').getTime() - 86_400_000);
  const yesterdayKey = `${yDate.getFullYear()}-${String(yDate.getMonth() + 1).padStart(2, '0')}-${String(yDate.getDate()).padStart(2, '0')}`;

  // ToF per day already honours the accounting regime — fetchDailyWorkHistory prefers the cached run
  // SEGMENTS over the uuid-metadata decode, whose full-duration fallback used to count warm-up/cool-down.
  const { tof, cap, budgetMin, loadUnit, paceMinPerKm, heatCredit, ramp: rampBudget } = await buildCapContext(dur, new Date(), capPct, capBasis, latest.tsb, acwrConsistent, Array.isArray(tlSeries) ? tlSeries as any[] : undefined);
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
    ctl:          tlLast?.ctl ?? latest.ctl,
    atl:          tlLast?.atl ?? latest.cardioLoad,
    tsb:          tlLast?.tsb ?? latest.tsb,
    acwr:         acwrConsistent,
    strainReal:   strain?.real,
    advisableLow:  strain?.safeLow,
    advisableHigh: strain?.safeHigh,
    readiness:    strain?.readiness,
    recoveryStale,
    drivers:      strain?.drivers,
    recentStrain: strainHist.slice(-10),
    recentTimeOnFeet:  tof.series14,
    recentTof28:       tof.series28,   // longer window for the week planner's max-of-N-weeks base
    heatByDate:        heatCredit,     // per-day heat factor → week planner matches the daily engine's heat-credit
    recentQualityWork: buildRecentQualityWork(runs),
    recentQualityTrimp: buildRecentQualityTrimp(runs, latest.restingHr ?? 50, maxHR),
    tof7d:             tof.tof7d,
    tofPrev7d:         tof.tofPrev7d,
    tofBudgetTodayMin: budgetMin,            // run-minutes budget (distance cap → converted via pace)
    tofNextRunLabel:   cap.nextRunLabel,     // next-run day comes from the ACTIVE cap basis
    tofNextRunInDays:  cap.nextRunInDays,
    yesterdayTofMin:   tof.yesterdayMin,
    loadCapBasis:      capBasis,
    loadCapPct:        capPct,
    ctlRampTarget:     ctlRampT ?? undefined,
    trimpRates:        ctlRampT ? (await loadSnapshotCache().catch(() => null))?.trimpRates : undefined,
    loadBudgetToday:   cap.budgetTodayMin,   // in loadUnit
    rampBudget,
    recentLoad28:      Array.isArray(tlSeries) ? (tlSeries as any[]).slice(-28).map(d => ({ date: d.date, load: d.load })) : undefined,
    loadUnit,
    paceMinPerKm,
    yesterdayStrain:   comps[yesterdayKey]?.strainScore,
    weather: weather ? {
      tempC: weather.tempC, apparentC: weather.apparentC, humidity: weather.humidity,
      windKmh: weather.windKmh, description: weather.description, place: weather.place,
    } : undefined,
    localContext: `${weather?.place ? `Location: ${weather.place} · ` : ''}${new Date().toLocaleString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    })}`,
    powerZones,
    recentActivities: buildRecentActivities(activities),
    athleteStatus:      status.status,
    athleteStatusUntil: status.until,
    timelineContext:    buildTimelineContext(events, status, date) + buildSupplementContext(supps, 7, date),
  };
}

// The most-recent WORK minutes for each quality type — the true intensity dose the coach ramps from.
// Uses the run's classified label + its work-segment duration (seconds → minutes), NOT time-on-feet.
function buildRecentQualityWork(runs?: RunWorkout[]): CoachSnapshot['recentQualityWork'] {
  if (!runs?.length) return undefined;
  const newest = [...runs].sort((a, b) => (b.date > a.date ? 1 : -1)); // newest first
  const lastWork = (label: string): number | undefined => {
    const r = newest.find(x => x.label === label && (x.workDuration ?? 0) > 0);
    return r ? Math.round((r.workDuration as number) / 60) : undefined;
  };
  const iv = lastWork('Intervals'), tp = lastWork('Tempo');
  return (iv != null || tp != null) ? { intervals: iv, tempo: tp } : undefined;
}

// Most-recent measured WORK-segment Banister TRIMP per quality type — the realised LOAD the 'trimp'-basis
// quality dose ramps from. Uses work-HR (falls back to whole-run avg) + work-duration (falls back to total),
// so a hard interval session isn't diluted by its recovery jogs. rest/max needed to normalise HR → reserve.
function buildRecentQualityTrimp(runs: RunWorkout[] | undefined, restHR: number, maxHR: number): CoachSnapshot['recentQualityTrimp'] {
  if (!runs?.length || maxHR <= restHR) return undefined;
  const newest = [...runs].sort((a, b) => (b.date > a.date ? 1 : -1));
  const lastTrimp = (label: string): number | undefined => {
    const r = newest.find(x => x.label === label && ((x.workHR ?? x.avgHeartRate ?? 0) > 0));
    if (!r) return undefined;
    const min = Math.round(((r.workDuration ?? r.duration) as number) / 60);
    const hr  = r.workHR ?? r.avgHeartRate ?? 0;
    const t = singleHrTrimp(min, hr, restHR, maxHR);
    return t > 0 ? t : undefined;
  };
  const iv = lastTrimp('Intervals'), tp = lastTrimp('Tempo'), lg = lastTrimp('Long');
  return (iv != null || tp != null || lg != null) ? { intervals: iv, tempo: tp, long: lg } : undefined;
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

// The FULLEST run the coach prescribed for a day (max runMinutes across the day's non-rest plan versions).
// Survives the flip to a 'session done' rest — the top-up feature needs the ORIGINAL target to size the
// shortfall, and the current cached plan may already be rest (runMinutes 0). Returns 0 if never a run day.
export async function getPrescribedMinutes(date: string): Promise<number> {
  const log = await readPlanLog(date);
  let m = 0;
  for (const e of log) {
    const p = e.plan;
    if (p && p.intensity !== 'rest' && !p.optional2nd) m = Math.max(m, p.runMinutes ?? 0);
  }
  return m;
}

// ── PENDING (PROPOSED) PRESCRIPTION — the chat coach PROPOSES, the athlete APPROVES ────────────────────
// The chat coach used to be structurally READ-ONLY: it could diagnose (e.g. Achilles soreness) and design a
// sensible modified session, but the insight died in the chat — the app kept the old prescription and had no
// record of the issue. This is the write path, deliberately gated: the agent writes a PROPOSAL here, and the
// Daily Coach surfaces it with Apply / Discard. Nothing reaches the watch without a human tap — the same LLM
// path produced a 30-min-jog session and a zero-width power range that crash-looped the app, so an
// LLM silently rewriting training is exactly what we don't want.
export interface PendingPrescription {
  date: string;
  session: string;              // prose the athlete reads
  rationale?: string;           // WHY the change (e.g. "Achilles soreness — walk recoveries, capped power")
  intensity: CoachIntensity;
  runMinutes: number;
  workout: WatchWorkout | null; // already validated through parseWorkout + ensureBlockPower
  source: string;               // 'chat-coach'
  createdAt: string;
}
const pendingFile = (date: string) => `${FileSystem.documentDirectory}runcoach-pending-plan-${date}.json`;

export async function savePendingPrescription(p: PendingPrescription): Promise<void> {
  try { await FileSystem.writeAsStringAsync(pendingFile(p.date), JSON.stringify(p)); } catch { /* ignore */ }
}
export async function loadPendingPrescription(date: string): Promise<PendingPrescription | null> {
  try {
    const f = pendingFile(date);
    const info = await FileSystem.getInfoAsync(f);
    if (!info.exists) return null;
    return JSON.parse(await FileSystem.readAsStringAsync(f)) as PendingPrescription;
  } catch { return null; }
}
export async function clearPendingPrescription(date: string): Promise<void> {
  try { await FileSystem.deleteAsync(pendingFile(date), { idempotent: true }); } catch { /* ignore */ }
}

/** Approve a proposal → it becomes the day's real plan, flagged so auto-refresh can't silently undo it. */
export async function applyPendingPrescription(date: string, base: CoachPlan): Promise<CoachPlan | null> {
  const p = await loadPendingPrescription(date);
  if (!p) return null;
  const plan: CoachPlan = {
    ...base,
    session:    p.session || base.session,
    rationale:  p.rationale ? `${p.rationale}` : base.rationale,
    intensity:  p.intensity,
    runMinutes: p.runMinutes,
    workout:    p.workout,
    prescribedLoad: p.workout ? prescribedTrimp(p.workout) : undefined,
    coachEdited: true,                       // planNeedsRefresh must not regenerate over this
    generatedAt: new Date().toISOString(),
  };
  await saveCachedPlan(date, plan);
  await clearPendingPrescription(date);
  return plan;
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
  capSig?:     string;        // the volume cap in force (basis:%) — a cap / fitness-ramp change re-plans the week
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
export async function loadTodaysWeekPlanSlot(date: string, maxBack = 7): Promise<WeekPlanDay | null> {
  const base = new Date(date + 'T00:00:00');
  const p = (n: number) => String(n).padStart(2, '0');
  for (let back = 1; back <= maxBack; back++) {
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
