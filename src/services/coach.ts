/**
 * LLM training coach. Feeds the FULL daily picture — recovery, HRV/RHR vs baseline,
 * respiration, SpO₂, sleep & sleep debt, and the training-load history (CTL/ATL/TSB,
 * ACWR, recent strain) — to the configured model and asks for a session
 * recommendation grounded in current endurance-training science. Returns structured
 * JSON so the UI can render it and reconcile the advisable strain band.
 */
import * as FileSystem from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { callLLM, getLLMStatus, extractJsonObject } from './llm';
import { buildKnowledgePrompt, recordPrescription, readKnowledgeContent } from './coachFiles';
import { raceActive, getRaceWeekPlan, raceSlotForToday, getRaceConfig, fmtTime } from './racePlan';
import { fetchOurDailyComponents, fetchDailyDurationHistory, fetchDailyWorkDistanceHistory } from './healthkit';
import { getLocalWeather } from './weather';
import { getPowerZones, getLongRunMinutes, getEffectiveMaxHr } from './claude';
import { ensureZonesFile } from './zones';
import { activityCategory, heatStrainFactor, DEFAULT_HEAT_SENSITIVITY, setHeatSensitivityCache, prescribedTrimp, singleHrTrimp, isFloatZone } from './trainingLoad';
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
  tof7d?:            number;   // trailing 7-day running minutes (completed days only)
  tofPrev7d?:        number;   // the 7 days before that
  tofBudgetTodayMin?: number;  // max running MINUTES today under the rolling cap (distance cap → via pace)
  tofNextRunLabel?:  string;   // when a meaningful-length run next fits the cap, e.g. "Thu 26 Jun"
  tofNextRunInDays?: number;   // days until that — 0 = today's budget already allows it
  loadCapBasis?:     'tof' | 'distance' | 'trimp'; // what the +X% cap is measured on
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
  if (plan.intensity !== 'rest' && !plan.secondSession
      && doneToday >= Math.max(15, Math.round((plan.runMinutes ?? 0) * 0.7))) return true;
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
workout to null (no watch workout).`;

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
  // Reserve ~6 min for the warm-up + cool-down (open or distance); the rest is work.
  const workBudget = Math.max(8, (runMinutes || 35) - 6);
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
export function thresholdTestWorkout(name: string): WatchWorkout {
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
      label: 'threshold test — even, maximal; last 60s all-out',
    }],
    cooldownMeters: st.cooldownMeters > 0 ? st.cooldownMeters : 0,
  };
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
  return Math.round(base * (1 + capPct / 100));
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

// ── PROGRESSIVE OVERLOAD, per session TYPE (no jumps) ─────────────────────────
// Each session type ramps its duration from WHERE IT RECENTLY WAS, capped at +cap%/week, toward its target.
// Weekday ≈ type (the schedule fixes Mon=intervals, Fri=long, …), so we baseline each day's ramp on the recent
// MAX time-on-feet for that weekday. This stops the coach jumping a type straight to its full target (the
// "daunting" week) — it climbs over several weeks and self-holds at target once reached (the min() cap). The
// same +cap% ToF ceiling drives it, so it's one knob. The LONG additionally never jumps > LONG_STEP_MAX min/wk
// (a %-cap alone lets a big long jump too far — a joint-protecting backstop, dormant at 10%).
const RAMP_LONG_STEP_MAX = 10;
function buildTypeRamp(recentTof: { date: string; min: number }[] | undefined, capPct: number) {
  // Baseline = the MOST RECENT session on each weekday (weekday ≈ type). recentTof is chronological, so the
  // last non-zero entry per weekday wins → a clean +cap% off where you actually were last, not a past peak.
  const byDow = new Map<number, number>();
  for (const e of (recentTof ?? [])) {
    const dw = new Date(e.date + 'T00:00:00').getDay();
    if ((e.min ?? 0) > 0) byDow.set(dw, e.min);
  }
  return (dow: number, fullBase: number, isLong: boolean): number => {
    const recent = byDow.get(dow) ?? 0;
    if (recent <= 0) return Math.min(fullBase, isLong ? 45 : 30);   // no recent history → conservative first dose
    let cap = recent * (1 + capPct / 100);
    if (isLong) cap = Math.min(cap, recent + RAMP_LONG_STEP_MAX);   // long: absolute per-week jump backstop
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
  const typeRamp = buildTypeRamp(snap.recentTimeOnFeet, capPct);   // per-type progressive-overload cap (no jumps)
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
  const EASY_MAX  = 60;     // PROGRESSIVE GROWTH: an easy/flex day GROWS toward the available budget (aerobic
  const EASY_MIN  = 20;     // …but never below this — a short easy day is still a real run (see easyGrow)
  const EASY_BASE = 35;     // volume) instead of a fixed jog — capped per-day so no single day spikes. The
  const QRESERVE  = 55;     // +cap% rolling cap + the green gate keep it controlled; QRESERVE is budget held
  //                           back per still-unplaced quality session so easy growth NEVER starves the week's
  //                           quality (incl. the long — verified in the harness: without it the long got squeezed out).
  const longTargetMin = await getLongRunMinutes().catch(() => 75);  // athlete's configured long-run length (not hardcoded 65)
  // Grow an easy day to spend the SPARE budget (after reserving for quality still to place) up to EASY_MAX,
  // when green; hold at EASY_BASE when run-down or when there's no genuine surplus (never below EASY_BASE, so
  // it's always a real easy run — and never worse than the pre-growth fixed 35).
  const easyGrow = (allowance: number) => {
    if (!green) return Math.max(EASY_MIN, Math.min(EASY_BASE, Math.round(allowance)));
    const reserve = Math.max(0, Qtotal - qPlaced) * QRESERVE;
    const spare = Math.round(allowance - reserve);
    // Grow into a genuine surplus; otherwise take what THIS day's allowance actually affords, down to
    // EASY_MIN. The old floor of EASY_BASE made every easy day cost ≥35 min whatever the budget, so at a
    // low weekly base (Geert: ~150 min/wk) only about four days fitted the week at all — the schedule
    // says every day may be a run day, but the arithmetic priced most of them out. A short easy day is a
    // real run; two 22-min days beat one 35-min day plus a forced rest.
    return spare > EASY_BASE
      ? Math.min(EASY_MAX, spare)
      : Math.max(EASY_MIN, Math.min(EASY_BASE, Math.round(allowance)));
  };
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
    } else if (kind === 'easy') {
      // Easy volume day — but only up to maxRunDays total (else REST so the week isn't a jog every day).
      if (runDays < maxRunDays) { intensity = 'easy'; base = easyGrow(allowance); placed = 'easy'; }
    }
    else if (kind === 'rest')   { intensity = 'rest'; base = 0; }
    else { // flex: MOP UP the spare budget with easy volume rather than banking it by resting. easyGrow already
      // reserves for pending quality (so easy can't starve the long/intervals), and the runner can always skip
      // or shorten — better to OFFER the aerobic volume than hoard it. Rest when the budget is spent OR the
      // week already has maxRunDays runs (concentrate volume into fewer, meaningful days).
      if (allowance < MEANINGFUL || runDays >= maxRunDays) { intensity = 'rest'; }
      else { intensity = 'easy'; base = easyGrow(allowance); placed = 'easy'; }
    }
    if (intensity === 'hard' && (fc?.apparentC ?? 0) >= 24) intensity = 'moderate';    // ease a hot hard morning
    // PROGRESSIVE OVERLOAD: ramp this day's TYPE from where it recently was (+cap%/week), so it climbs toward
    // its target instead of jumping there. Applies to every run type (long gets the extra +10min/wk backstop).
    if (intensity !== 'rest') base = typeRamp(d.getDay(), base, placed === 'long');

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
  // Race force-places the day's session — but ONLY if you haven't already run today (else it re-prescribes
  // a 2nd run after you've done it: the ghost run). Same todayDone<8 guard shrink-to-fit uses.
  const raceForced  = !!raceSlot && raceSlot.intensity !== 'rest' && todayDone < 8;
  const honorDirect = honourSlot || raceForced;
  const strainLow   = clampScore(snap.advisableLow, 30);
  const strainHigh  = clampScore(snap.advisableHigh, 60);
  const strainReal  = snap.strainReal ?? null;
  const recoveryStale = snap.recoveryStale === true;
  const heatFactor  = heatStrainFactor(snap.weather);
  const apparentC   = snap.weather?.apparentC ?? snap.weather?.tempC;
  // "Next run" tracks the 7-DAY PLAN (may hold a reduced shrink-to-fit run tomorrow), not the raw
  // meaningful-run cap projection — so the daily card + home agree with the 7-day screen. Race mode is
  // suppressed (the race block, not the cap, decides the days → avoids "run 25m" + "next run Sat").
  let nextRunLabel  = (cappedToday && !raceForced) ? snap.tofNextRunLabel : undefined;
  let nextRunInDays = raceForced ? undefined : snap.tofNextRunInDays;
  if (cappedToday && !raceForced) {
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
  if (cappedToday && !honourSlot && !raceForced) {
    return {
      headline: 'At your volume cap — recovery day',
      session: `Rest from running today — your trailing 7-day time-on-feet is at the +${capPct}% ceiling. Keep it to easy mobility/strength; next run ${nextRunLabel ?? 'in a couple of days'}.`,
      strength: STRENGTH_DEFAULT, intensity: 'rest', runMinutes: 0,
      rationale: bandPhrase(strainReal, strainLow, strainHigh, 'cap reached, so banking volume for the next quality day'),
      cautions: recoveryStale ? STALE_CAUTION : undefined, workout: null, sessionKind: 'recovery', secondSession: null, ...stamp,
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
  const slot = todaySlot;
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
      cautions: recoveryStale ? STALE_CAUTION : undefined, workout: null, sessionKind: 'recovery', secondSession: null, ...stamp,
    };
  }

  // PROGRESSIVE OVERLOAD: ramp this session's TYPE from its recent duration (+cap%/week) before capping to
  // budget — matches the 7-day plan's per-type ramp so a type climbs to target instead of jumping (the slot
  // path is already ramped, so this is idempotent there; it's the no-slot fallback that needs it).
  if (!honorDirect) {   // intensity is already non-rest here (rest returned earlier)
    const typeRamp = buildTypeRamp(snap.recentTimeOnFeet, snap.loadCapPct ?? DEFAULT_LOAD_CAP_PCT);
    base = typeRamp(new Date(snap.date + 'T00:00:00').getDay(), base, sk === 'long');
  }
  // Build the structured session. A shrink-to-fit slot is HONOURED at its (already-short) minutes —
  // only today's heat eases it — so the daily card matches the 7-day plan instead of re-capping to rest.
  const totalMin = Math.max(8, honorDirect ? Math.round(base / Math.max(1, heatFactor)) : Math.min(budget, base));

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
  const primaryDone = todayDone >= Math.max(15, Math.round(plannedMorning * 0.7));
  if (primaryDone && !secondSession && !honorDirect) {
    return {
      headline: 'Today’s session done ✓',
      session: 'You’ve done today’s run — recover now. Optional easy mobility & strength; no more running today.',
      strength: STRENGTH_DEFAULT, intensity: 'rest', runMinutes: 0,
      rationale: bandPhrase(strainReal, strainLow, strainHigh, 'today’s prescribed session is complete — recover (no 2nd run within today’s caps)'),
      cautions: recoveryStale ? STALE_CAUTION : undefined, workout: null, sessionKind: 'recovery', secondSession: null, ...stamp,
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
    cautions: recoveryStale ? STALE_CAUTION : undefined, workout, shrinkForced: honorDirect,
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
    const forced = basis.shrinkForced
      ? `\n\nIMPORTANT — TODAY'S SESSION IS DELIBERATELY FORCE-PLACED. The rolling volume cap is nearly spent, but the app has INTENTIONALLY held this shortened quality session on its scheduled day (shrink-to-fit) and banked budget elsewhere in the week. A low tofBudgetTodayMin therefore does NOT mean today is a rest day: do NOT return intensity "rest", and do NOT write that the cap forces rest today. Honour the prescribed session (you may still ease it slightly if today's recovery genuinely warrants).`
      : '';
    const system = `${ROLE}${raceHdr}${snap.timelineContext ?? ''}\n\n===== COACHING KNOWLEDGE =====\n${knowledge}\n===== END COACHING KNOWLEDGE =====\n\n${OUTPUT}${ceiling}${forced}`;
    const txt = await callLLM({
      system,
      // Feed the LLM the SAME next-run the basis resolved from the 7-day plan (may be tomorrow's shrink-to-fit
      // run), so its prose doesn't state the raw cap date (e.g. "run Saturday") while the card shows Friday.
      messages: [{ role: 'user', content: JSON.stringify({ ...snap, tofNextRunLabel: basis.nextRunLabel ?? snap.tofNextRunLabel, tofNextRunInDays: basis.nextRunInDays ?? snap.tofNextRunInDays, heatStrainFactor: heatFactor, prescribedCeiling: { intensity: basis.intensity, runMinutes: basis.runMinutes, forcePlaced: !!basis.shrinkForced } }) }],
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
    const wellFormed = parsed != null && blockTotal >= workRef * 0.5 && blockTotal <= workRef * 1.5 + 6;

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
    const easedOff = intensity !== basis.intensity;
    const workout = intensity === 'rest' ? null
      : wellFormed ? ensureBlockPower(parsed, snap.powerZones)
      : (basis.workout && !easedOff) ? basis.workout
      : ensureBlockPower(synthesizeWorkout(intensity, runMinutes, wkName, snap.powerZones), snap.powerZones);
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
    const finalLabel    = intensity === 'hard' ? 'Intervals' : intensity === 'moderate' ? 'Tempo'
                        : runMinutes <= 30 ? 'Recovery run' : 'Easy Z2';
    const finalHeadline = `Eased — ${finalLabel.toLowerCase()} today`;
    const finalSession  = `${finalLabel} — ${runMinutes} min${structureNow ? `, ${structureNow}` : ''}.`;

    const runKm = intensity !== 'rest' && snap.loadUnit === 'km' && snap.paceMinPerKm
      ? Math.round((runMinutes / snap.paceMinPerKm) * 10) / 10 : undefined;
    // Canonical kind follows the FINAL (possibly eased) intensity so the label stays honest; a moderate
    // session is 'long' only if the basis was a long run (keeps the split), else 'tempo'.
    const sessionKind: SessionKind =
      intensity === 'rest' ? 'recovery' :
      intensity === 'hard' ? 'intervals' :
      intensity === 'easy' ? 'easy' :
      basis.sessionKind === 'long' ? 'long' : 'tempo';
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
      cautions:  basis.cautions ?? (o.cautions ? String(o.cautions).slice(0, 200) : undefined),
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
  try { const v = await SecureStore.getItemAsync(LOAD_CAP_BASIS_KEY); return (v === 'distance' || v === 'trimp') ? v : 'tof'; }
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
export async function assembleCoachSnapshot(strain: DayStrain | null, activities?: ActivitySummary[], runs?: RunWorkout[]): Promise<CoachSnapshot> {
  // Refresh the sync-readable workout-structure cache so synthesizeWorkout / parseWorkout (both sync) see
  // the athlete's current warm-up / cool-down / drills config before any plan or watch workout is built.
  // Awaited in parallel below (the throwaway slot) so it's settled before the caller builds a workout.
  const [comps, dur, weather, powerZones, capPct, capBasis, status, events, supps, maxHR] = await Promise.all([
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
    refreshWorkoutStructure().catch(() => DEFAULT_WORKOUT_STRUCTURE),
    refreshHeatSensitivity().catch(() => DEFAULT_HEAT_SENSITIVITY),
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
  // Yesterday = the calendar day BEFORE the plan's date, looked up by KEY — not strainHist[length-2],
  // which is off by one whenever today's components aren't in `comps` yet (then the array ends at
  // yesterday, so [length-2] reads the day BEFORE yesterday → "yesterday's intervals" ghost).
  const yDate = new Date(new Date(date + 'T00:00:00').getTime() - 86_400_000);
  const yesterdayKey = `${yDate.getFullYear()}-${String(yDate.getMonth() + 1).padStart(2, '0')}-${String(yDate.getDate()).padStart(2, '0')}`;

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
    loadBudgetToday:   cap.budgetTodayMin,   // in loadUnit
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
