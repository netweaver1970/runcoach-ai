/**
 * Body Energy Battery + stress model (Garmin / Bevel-style), computed on-device from
 * Apple Health. Stress (0–100) is driven by heart rate vs the resting baseline, modulated
 * by HRV (SDNN) when a TRUSTWORTHY reading is available; the battery (0–100) charges when
 * calm/asleep and discharges under stress/activity.
 *
 * HRV SELECTIVITY (important). NOTE (corrected 2026-07-14 by Geert): there is NO second app — ALL HRV comes
 * from the Apple Watch. What's going on is that he enabled **AFib History in Apple Health**, which makes the
 * WATCH ITSELF sample HRV far more often (~25 reads/night vs the usual 5–15). So the extra reads are genuine
 * Apple Watch SDNN samples, just taken at more varied moments (incl. arousals/movement) — hence a wider,
 * lower-skewed distribution, NOT third-party junk. The trust filter below is still right (it rejects reads
 * taken while HR is elevated/erratic), but the old "junk app" framing was wrong and misled the 60-day
 * baseline work. The stale wording is kept below only where it names the R-R gap behaviour.
 * (was: the athlete runs an AFib-check app that logs many HRV
 * readings, some taken while moving (garbage). We only trust an HRV sample when:
 *   - its value is physiologically plausible (5–200 ms SDNN),
 *   - the Apple Watch heartbeat (R-R) series for that minute has no internal gaps
 *     (buildHeartbeatQualityMap / isGoodHRVSample — i.e. no motion drop-out), and
 *   - the surrounding heart rate looks at-rest (near resting, low variability).
 *
 * Figures are our estimate; calibration vs Bevel is a separate follow-up.
 */
import HealthKit from '@kingstinct/react-native-healthkit';
import * as FileSystem from 'expo-file-system';
import { buildHeartbeatQualityMap, isGoodHRVSample, loadSnapshotCache } from './healthkit';

const HR_ID    = 'HKQuantityTypeIdentifierHeartRate';
const HRV_ID   = 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN';
const RHR_ID   = 'HKQuantityTypeIdentifierRestingHeartRate';
const SLEEP_ID = 'HKCategoryTypeIdentifierSleepAnalysis';
const STEP_ID  = 'HKQuantityTypeIdentifierStepCount';
// Movement gating (Bevel-method): Bevel uses motion to separate physical EXERTION (walking, housework)
// from autonomic stress — HR raised by moving around is NOT counted as stress. We approximate motion with
// step rate: at ≥ MOVE_STEPS_FULL steps/min the HR bump is treated as movement and daytime stress is
// discounted by up to MOVE_GATE. (Initial values — tune against the next paired Bevel export.)
const MOVE_STEPS_FULL = 70;   // steps/min ≈ steady walking → full movement
const MOVE_GATE       = 0.6;  // fraction of daytime stress removed at full movement
const ASLEEP = new Set([1, 3, 4, 5]); // asleepUnspecified/core/deep/REM (0=inBed, 2=awake)

const BIN_MIN = 5;            // 5-min bins → finer curve (drain rates are per-minute, so the
                             // battery is unchanged; STRESS_SMOOTH is set to hold the decay time)
const WINDOW_H = 60;          // compute window (2+ nights so the seed washes out)
// HRV baseline window. 14 → 60 DAYS (2026-07-14, Bevel parity — see the 60-day baseline block below).
// HRV samples are sparse (a few dozen/day at most), so 60 days is still a cheap HealthKit query.
const BASELINE_DAYS = 60;

// Battery dynamics (per-minute), Bevel "Energy Bank" style: the battery charges ONLY while
// asleep — but, like Bevel, the overnight charge is CAPPED BY RECOVERY: a poor-HRV night
// barely charges, a good night charges fully. Awake it drains, slowly when calm, fast when
// stressed. Calibrated against Bevel via scripts/bbtune.mjs on the 23-Jun device dump:
// our NOW 20% vs Bevel 17%, overnight charge to 40% vs Bevel "last charged 38%".
const REST_STRESS   = 33;     // kept for the debug dump; Bevel sleep-stress ~25
// ── Fitted recovery model (Bevel-calibrated, per HOUR) ────────────────────────────────────────────
// Reverse-engineered from one night of paired Bevel energy + our stress + HK stages (the
// energy/stress correlation fit). Two regimes, each LINEAR in stress, NO ceiling:
//   asleep: ΔE/h = CHARGE_BASE − CHARGE_STRESS_K·S_eff   (floored ≥0 — sleep always charges)
//   awake:  ΔE/h = DRAIN_BASE  − DRAIN_STRESS_K·S        (break-even at S≈32 — calm day holds/recharges)
// Stage barely matters on its own (deep = core — energy ran straight through the deep block); the one
// real stage effect is REM's autonomic stress SPIKE, which isn't real strain → cap S during REM.
// ── ASLEEP CHARGE: ASYMPTOTIC TOWARD RECOVERY (the anchor) ────────────────────────────────────────────
// REWRITTEN 2026-07-14 after a full paired Bevel export (bottom-up: HR/HRV verified identical to Bevel —
// sleep HR 54.4 vs 54.3, HRV 44.7 vs 45.1 — and the awake drain-vs-stress curve already matched Bevel's
// 0.5−0.1·S; so the fault was here, in the charge law).
//
// THE BUG: the old law was LINEAR and LEVEL-BLIND — charge/h = CHARGE_BASE − CHARGE_STRESS_K·stress, i.e. a
// constant rate no matter how full the tank was. That makes the battery a FREE-RUNNING INTEGRATOR with NO
// restoring force: charge and drain roughly balanced, so it kept whatever orbit history left it in. It had
// sunk to a low orbit (5 → 71) and could never climb out — the morning read 68 while recovery said 100 and
// Bevel 85, and the evening pinned at the floor (5) for 4+ hours, losing all information.
//
// THE FIX: charge ASYMPTOTICALLY toward a TARGET = the day's RECOVERY score. Fitting Bevel's own overnight
// curve (36→85, 14 Jul) to rate = k·(T − E) gives k = 0.148/h and T = 102.9 ≈ the recovery score (97) — its
// charge is fast when empty (~10/h at E=36) and tapers as it fills (~3/h at E=83). This is the missing
// restoring force: however low the day drove it, a good night pulls it back to what recovery says you've
// actually recovered — which is exactly what recovery MEANS. Sleep quality enters via the TARGET (recovery
// already encodes HRV/sleep), so stress only modulates the RATE, and only on a genuinely disturbed night.
const SLEEP_CHARGE_K     = 0.16;  // /h per point of (target − battery). Bevel fit 0.148; 0.16 converges a touch faster.
const SLEEP_TARGET_MIN   = 40;    // never target below this (a terrible night still recovers something)
const SLEEP_TARGET_FALLB = 85;    // when the recovery score isn't in the snapshot cache yet — still ANCHORED, never free-drift
const SLEEP_STRESS_FREE  = 25;    // sleep stress below this costs nothing (typical night runs 15–24)
const SLEEP_STRESS_K     = 0.02;  // rate lost per stress point ABOVE the free band (a disturbed night charges slower)
const SLEEP_QUALITY_MIN  = 0.40;  // floor on that penalty — even a bad night charges
const CHARGE_BASE     = 16;    // (legacy — no longer drives the rate; kept for the debug dump / A-B against old exports)
const CHARGE_STRESS_K = 0.45;  // (legacy — as above)
// Drain = PURE stress model, NO time-of-day factor (re-fit vs a full paired Bevel export 29 Jun 2026:
// our drain was clock-shaped and over-drained the calm morning, sitting ~10% below Bevel all day). Bevel
// holds energy flat through a low-stress morning and drains proportionally to stress above a break-even.
// Regressing Bevel ΔEnergy on OUR stress at matching clock times → break-even ≈32, slope ≈0.09; the
// integrated curve tracks Bevel within ~1.5% RMSE across the day. The DRAIN_TIME_* constants below are
// no longer applied (timeMult = 1) but retained for the debug dump.
//   drain/h = DRAIN_BASE − DRAIN_STRESS_K·S
const DRAIN_BASE      = 0.5;   // /h awake intercept. RE-FIT 2026-07-09 vs a same-day paired Bevel export (6-min
const DRAIN_STRESS_K  = 0.10;  // energy+stress) + our bb dump. The 07-05 gentling (below) OVER-corrected: we then
                               // UNDER-drained — ours ended ~63 vs Bevel 44 (drained −17 vs −32) with our stress
                               // TRACKING Bevel's (spikes align, ~30 mean). Two faults at 0.7/0.07: break-even S≈10
                               // let us hold/charge through the calm midday (our stress dips to 8–15) while Bevel keeps
                               // draining; slope too shallow at peaks. This is the MIRROR of the June over-drain (33 vs
                               // 49). Bumped BASE 0.7→0.5 (break-even ≈5, drains through calm like Bevel) + K 0.07→0.10
                               // (steeper at peaks) → integrates to ≈Bevel −32. CONFIRM against a 2nd paired day.
                               // (Prior 07-05 note: old 0.129 over-drained — at S=90 −9.5/h vs Bevel −4.5/h, ended 33
                               // vs 49 — so slope 0.129→0.07, break-even ≈10; that swung too far the other way.)
// AWAKE REST-CHARGE (Garmin/Bevel behaviour): lying/sitting STILL at low stress is genuine recovery, so the
// battery CHARGES even awake — a calm awake morning in bed recovers (Bevel does; our sleep-gated model
// didn't once Apple Health ended the sleep session). Gated on STILLNESS (≈no steps) so up-and-about calm
// time still uses the drain curve (which is why 07-05's up-and-about morning correctly held flat). Gentle:
// well below the asleep charge, break-even at S≈20 (matches "in bed, awake, <20% stress → charging").
// (Rates are provisional — validate/​trim against a fresh paired export of an awake-in-bed morning.)
const REST_STEPS_MAX    = 12;  // steps/min below this ≈ lying/sitting still (a few in-bed shifts); above = moving
const REST_CHARGE_BASE  = 6;   // /h rest-charge intercept (vs asleep CHARGE_BASE 16)
const REST_CHARGE_K     = 0.3; // /h charge lost per stress unit while resting awake → break-even S≈20
const DRAIN_TIME_MMAX = 1.6;   // M at wake (h=0): steepest drain, fresh out of bed
const DRAIN_TIME_DECAY= 0.6;   // logarithmic taper of the drain through the waking day
const DRAIN_TIME_MMIN = 0.3;   // afternoon/evening floor — gentle drain even at high stress
// Near-empty asymptote: Bevel's energy bank NEVER crashes to a flat 0 — it approaches a small floor and
// drain throttles hard once low (Geert: 8% → 3h dancing → still 2%). Below the knee we taper the drain
// linearly toward 0 at the floor, so the battery approaches but never slams into it. Charge is unaffected.
const BATTERY_FLOOR     = 2;   // displayed minimum — you can't spend energy you don't have
const DRAIN_FLOOR_KNEE  = 15;  // below this, drain scales down toward 0 at BATTERY_FLOOR
const WORKOUT_STRESS_CAP = 65; // (legacy) cap on workout drain-stress — superseded by the HRR drain below
// A real session drains FAR faster than the stress-linear daytime curve allows (capped stress tops out
// ~−6/h, but a paired Bevel export showed a HR-130 run draining ~−13/h). So during a workout we drain on
// HR intensity (%HRR) instead. Fit 30 Jun to two paired days: a HR-130 run (≈0.5 HRR) ≈ −13/h, an easy
// walk (≈0.2 HRR) ≈ −5/h → ~27/h per unit HRR.
// RE-FIT 2026-07-14 vs the paired Bevel export: 27 was ~50% too steep. Our workout bins drained −9.0/h at
// mean HR 102 (HRR 0.36) while Bevel drained −6.25/h over the same morning run → per-HRR ≈ 17. Combined
// with the anchored charge above, this lands the daily orbit at ≈ wake 82 / bottom 34 (Bevel: 85 / 36).
// The old 27 was the single biggest drain term (−46 over the window) and is what pinned the evening at the floor.
const WORKOUT_DRAIN_PER_HRR = 18;
const REM_STRESS_CAP  = 13;    // cap stress during REM (sleep-baseline) so the spike doesn't starve charge
// Z-SCORE STRESS INDEX (research-aligned, replaces the old HR-reserve + HRV-suppression + gate +
// floor): stress = STRESS_BASE + (zHR − zHRV)·STRESS_SCALE, where z is THIS reading's deviation from
// YOUR baseline — computed SEPARATELY for day vs night (circadian). Higher HR and/or lower HRV than
// your typical → more stress. Self-normalizing, no per-person tuning. The night uses the night
// baseline (so a low-HRV night reads as poor recovery) plus a sleep-stage bump.
const STRESS_BASE   = 26;     // stress at "typical" (z = 0)
// NIGHT stress pts per unit of drive. RE-FIT 2026-07-14 against a paired Bevel night — see NIGHT_STRESS_BASE
// below; this is the AMPLITUDE half of that fix and is NIGHT-ONLY (the day path uses DAY_STRESS_SCALE).
const STRESS_SCALE  = 22;     // was 8.3 — the night curve was compressed to a 2.8-SD sliver vs Bevel's 7.3
// DAY needs a STEEPER scale: paired vs Bevel our daytime stress was compressed (sat 15–23 while Bevel swings
// 1–28) → calm moments read far too high (user saw 15 vs Bevel 2). Steepening around the pivot (BASE+OFFSET
// ≈27.5) decompresses it: day mean → 17.2 (Bevel 17.1) and the calm floor drops toward Bevel's ~2-5. Night
// keeps STRESS_SCALE. (2026-07-05 paired refit; the wake spikes still under-read — our z-index doesn't spike
// like Bevel's, an accepted limitation.)
const DAY_STRESS_SCALE = 15;
// (B) DAYTIME stress correction. vs Bevel's stress export our DAY stress correlates r=0.93 but reads
// ~12 BELOW it (a near-constant offset). Lift it so the stress METRIC — and the drain it drives — match
// Bevel. NIGHT is untouched (zStressNight + its own base already matches). Tunable; the raw (pre-offset)
// smoothed value is emitted as `s0` in the debug dump so we can A/B against clean data.
const DAY_STRESS_OFFSET = 1.5;  // was 12 — the old lift assumed our day-stress read BELOW Bevel; it now reads
                                // ABOVE, so with STRESS_SCALE 8.3 this gives daytime stress = 3.3 + 0.64·old.
const BASE_SD_MIN   = 3;      // floor on a baseline's SD so a tight baseline can't explode z-scores
const STRESS_SMOOTH = 0.11;   // awake-day EWMA decay weight (smooth on the way down; rise is instant)
const SESSION_GAP_MS = 60 * 60_000; // merge sleep segments < 1h apart into one night session
// Night stress = a RECOVERY baseline (HRV vs personal baseline) + a stage modulation ADDED on top.
// Research-aligned: night HRV is a recovery-quality signal, shaped by sleep stage. The square wave
// is only crisp on a well-rested (low-baseline) night; on a poor night the bumps drown in the high
// baseline. Stage bump: 0 inBed,1 asleepUnspecified,2 awake-in-bed,3 core,4 deep,5 REM.
const STAGE_BUMP: Record<number, number> = { 0: 6, 1: 3, 2: 8, 3: 2, 4: 0, 5: 6 };
const NIGHT_STAGE_SMOOTH = 0.35; // stress EWMA at night — fast enough that REM bumps form (not smeared)
// NIGHT STRESS (Bevel reads a flat <25% all night). The z-score-vs-night-HR model over-read calm
// sleep: the night HR baseline SD is tiny (~3 bpm), so a normal +5 bpm settling HR looked like a big
// arousal, and the HRV term spiked on physiological REM dips — together pushing NREM stress to 45-65.
// Asleep charging hits 0 at stress ~32, so that phantom stress STARVED the overnight charge → barely
// charged → battery hit 0 by afternoon. Fix: night stress = low anchor + ONLY genuine HR arousal
// (beyond a margin) + a softened HRV term, hard-capped. Day stress is unchanged.
// THE NIGHT-STRESS FLOOR — fixed 2026-07-14 (Geert spotted it in the curve; I had seen the same numbers and
// waved them off as "slightly high, not the driver"). In calm deep sleep the arousal term → 0 and the HRV term
// → 0, so night stress BOTTOMED OUT AT THE ANCHOR: it structurally could not express "deeply calm". Paired
// against Bevel for the same night: our min was 11 and we spent 0/79 bins below 10; Bevel dipped to 1 and spent
// 31/79 below 10. Our SD was 2.8 vs Bevel's 7.3 — a compressed sliver, not a curve.
// Fix = lower the anchor AND raise the amplitude together (dropping the base alone would have fixed the floor
// but under-shot the peaks, which already matched Bevel). Grid-fitted with the REAL formula (drive from raw
// HR/HRV + STAGE_BUMP + EWMA + clamp), S searched to 60 so 22 is a true optimum, not a boundary hit:
//   base 16 → 9, STRESS_SCALE 8.3 → 22   ⇒   RMSE vs Bevel 8.26 → 4.62
//   mean 19.0 → 12.6 (Bevel 12.8) · min 11 → 2 (Bevel 1) · SD 2.8 → 5.4 (Bevel 7.3) · <10: 0/79 → 24/79 (Bevel 31/79)
// NOTE: STAGE_BUMP stays ADDITIVE and unscaled (an early regression that recovered the drive from our emitted
// stress would have silently rescaled it by 1.66× — that's why this was refit from the raw inputs instead).
// The battery is UNAFFECTED: the anchored sleep charge only penalises stress above SLEEP_STRESS_FREE (25), and
// the night now runs 2–26, so charge quality stays ~1. This is a stress-METRIC fidelity fix.
const NIGHT_STRESS_BASE = 9;    // calm-sleep anchor (was 16 — that WAS the floor)
const NIGHT_HR_MARGIN   = 6;    // bpm above the night HR mean before it counts as arousal
const NIGHT_HR_SD_MIN   = 8;    // floor the (too-tight) night HR SD so normal sleep HR isn't "stress"
const NIGHT_HRV_K       = 0.4;  // soften the HRV term at night (REM / transient dips aren't real stress)
const NIGHT_STRESS_CAP  = 30;   // hard cap so artifacts / REM can't paint a spiky night
const SEED          = 42;     // starting level at the window edge
// HRV trust thresholds. The watch R-R "gap" flag over-rejects an AFib-app user's stable
// stress reads, so it is NOT a hard reject — a stable, near-resting HR is the arbiter.
const HRV_VMAX      = 110;    // SDNN above this = artifact (Bevel-style artifact removal)
const HRV_HR_OVER   = 20;     // reject if HR is more than this above resting (= movement)
const HRV_CV_MAX    = 0.18;   // reject if HR is erratic around the read (= movement)
const HRV_WIN_MIN   = 65;     // carry a trusted read this many minutes to fill gaps

const safe = async <T>(fn: () => Promise<T>, fb: T): Promise<T> => { try { return await fn(); } catch { return fb; } };
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface BatteryPoint { t: number; battery: number; stress: number; asleep: boolean; workout: boolean; }
const WORKOUT_SETTLE_MS = 15 * 60_000; // exclude exercise + this settle window from the stress curve
export interface BodyBattery {
  current: number;        // 0–100 now
  currentStress: number;  // 0–100 now
  trendPerHour: number;   // battery change over the last hour (+charging / −draining)
  dayLow: number; dayHigh: number;
  totalCharged: number;   // sum of + deltas over last 24h (Bevel "Total Charged")
  totalDrained: number;   // sum of − deltas over last 24h (Bevel "Total Drained")
  series: BatteryPoint[]; // last ~24h, BIN_MIN spacing
  hrvBaseline: number; restHR: number;
  hrvUsed: number; hrvRejected: number; // selectivity transparency
  computedAt: number;
  debug: any;             // raw trace for off-device calibration (Copy debug)
  correlation: any;       // last-night stage timeline + per-bin series (Copy correlation data)
}

// ── Instant cache ────────────────────────────────────────────────────────────
// computeBodyBattery() runs ~6 heavy HealthKit queries (slow on launch). We persist the
// last result so the home card can show it INSTANTLY, then recompute in the background.
// The bulky debug/correlation traces are stripped — the home card never reads them and the
// detail screen recomputes fresh.
const BB_CACHE_FILE = `${FileSystem.documentDirectory}runcoach-bodybattery.json`;
const BB_CACHE_MAX_AGE_MS = 2 * 60 * 60_000; // show a RECENT cache instantly, but never a stale (e.g. yesterday's) one

export async function loadBodyBatteryCache(): Promise<BodyBattery | null> {
  try {
    const info = await FileSystem.getInfoAsync(BB_CACHE_FILE);
    if (!info.exists) return null;
    const bb = JSON.parse(await FileSystem.readAsStringAsync(BB_CACHE_FILE)) as BodyBattery;
    // Freshness guard: a value older than the window is stale → return null so the UI shows a
    // spinner and recomputes, instead of freezing on yesterday's reading.
    if (!bb || typeof bb.computedAt !== 'number' || Date.now() - bb.computedAt > BB_CACHE_MAX_AGE_MS) return null;
    return bb;
  } catch { return null; }
}

export async function saveBodyBatteryCache(bb: BodyBattery): Promise<void> {
  try {
    const slim = { ...bb, debug: undefined, correlation: undefined };
    await FileSystem.writeAsStringAsync(BB_CACHE_FILE, JSON.stringify(slim));
  } catch { /* ignore */ }
}
export async function clearBodyBatteryCache(): Promise<void> {
  try { await FileSystem.deleteAsync(BB_CACHE_FILE, { idempotent: true }); } catch { /* ignore */ }
}

// ── Manual calibration anchor (dev) ────────────────────────────────────────────
// Force the battery to a known value (e.g. a Bevel reading) at a chosen MOMENT; the model
// then integrates the charge/discharge curve FORWARD from there. Anchoring at a past point
// (e.g. yesterday morning's Bevel %) re-seeds the curve so last night's sleeptime aligns —
// fixing the SEED-at-window-edge weakness. Clear it when done.
const BB_ANCHOR_FILE = `${FileSystem.documentDirectory}runcoach-bb-anchor.json`;
export interface BatteryAnchor { at: number; value: number }

export async function getBatteryAnchor(): Promise<BatteryAnchor | null> {
  try {
    const info = await FileSystem.getInfoAsync(BB_ANCHOR_FILE);
    if (!info.exists) return null;
    const a = JSON.parse(await FileSystem.readAsStringAsync(BB_ANCHOR_FILE));
    return typeof a?.at === 'number' && typeof a?.value === 'number' ? a : null;
  } catch { return null; }
}
export async function setBatteryAnchor(value: number, at: number = Date.now()): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(BB_ANCHOR_FILE, JSON.stringify({ at, value: Math.max(0, Math.min(100, value)) }));
  } catch { /* ignore */ }
}
export async function clearBatteryAnchor(): Promise<void> {
  try { await FileSystem.deleteAsync(BB_ANCHOR_FILE, { idempotent: true }); } catch { /* ignore */ }
}

interface Sample { t: number; v: number; }

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export async function computeBodyBattery(): Promise<BodyBattery | null> {
  const now = Date.now();
  const from = new Date(now - WINDOW_H * 3_600_000);
  const baseFrom = new Date(now - BASELINE_DAYS * 86_400_000);

  const q = (id: string, start: Date, unit: string, limit = 100_000) =>
    safe(() => (HealthKit.queryQuantitySamples as any)(id, { filter: { startDate: start, endDate: new Date(now) }, unit, ascending: true, limit }), [] as any[]);

  const [hrRaw, hrvRaw, beatsRaw, rhrRaw, sleepRaw, hrvBaseRaw, stepRaw, snap, sleepBaseRaw] = await Promise.all([
    q(HR_ID, from, 'count/min'),
    q(HRV_ID, from, 'ms', 20_000),
    safe(() => (HealthKit as any).queryHeartbeatSeriesSamples({ filter: { startDate: from, endDate: new Date(now) }, ascending: true, limit: 5_000 }), [] as any[]),
    q(RHR_ID, baseFrom, 'count/min', 5_000),
    safe(() => (HealthKit.queryCategorySamples as any)(SLEEP_ID, { filter: { startDate: from, endDate: new Date(now) }, ascending: true, limit: 10_000 }), [] as any[]),
    q(HRV_ID, baseFrom, 'ms', 50_000),
    q(STEP_ID, from, 'count', 50_000),
    loadSnapshotCache(),
    // 60-day SLEEP windows — used ONLY to select which HRV reads belong in the long baseline (below).
    safe(() => (HealthKit.queryCategorySamples as any)(SLEEP_ID, { filter: { startDate: baseFrom, endDate: new Date(now) }, ascending: true, limit: 40_000 }), [] as any[]),
  ]);

  // Steps as time-weighted samples (midpoint, steps/min) → movement gate for daytime stress.
  const stepRate: { t: number; spm: number }[] = (stepRaw as any[])
    .map(s => {
      const t0 = new Date(s.startDate).getTime(), t1 = new Date(s.endDate ?? s.startDate).getTime();
      const durMin = Math.max(1 / 60, (t1 - t0) / 60_000);
      return { t: (t0 + t1) / 2, spm: (s.quantity as number) / durMin };
    })
    .sort((a, b) => a.t - b.t);
  const stepsPerMinNear = (t: number, win = 150_000): number => {
    let sum = 0, n = 0;
    for (const s of stepRate) { if (s.t < t - win) continue; if (s.t > t + win) break; sum += s.spm; n++; }
    return n ? sum / n : 0;
  };

  const hr: Sample[] = (hrRaw as any[]).map(s => ({ t: new Date(s.startDate).getTime(), v: s.quantity })).sort((a, b) => a.t - b.t);
  if (hr.length < 5) return null;

  const restHR = (rhrRaw as any[]).length ? Math.round((rhrRaw as any[]).at(-1).quantity) : 55;
  const maxHR  = (snap as any)?.estimatedMaxHR && (snap as any).estimatedMaxHR > 0 ? (snap as any).estimatedMaxHR : 190;
  // THE ANCHOR: the overnight charge asymptotes toward the RECOVERY score — a fully-recovered night should
  // wake with a full tank, because that is what recovery means. Recovery already encodes HRV + RHR + sleep,
  // so sleep QUALITY enters here (via the target) rather than as a fudge on the charge rate. Read from the
  // snapshot the module already loads (no caller change). No recovery yet → a fixed fallback target, so the
  // battery is still ANCHORED and can never free-drift into a low orbit again.
  // NB: the field is `todayRecovery.recoveryScore` — there is NO `snap.recovery`. The first cut read
  // `(snap as any).recovery`, which is always undefined, so the anchor silently fell back to
  // SLEEP_TARGET_FALLB for everyone and was never recovery-driven at all (caught in the 07-14 12:14 dump:
  // recoveryNow 0 / chargeTarget 85). The `as any` cast is what hid it from the compiler.
  const recoveryNow = Number((snap as any)?.todayRecovery?.recoveryScore) || 0;
  const chargeTarget = recoveryNow > 0 ? clamp(recoveryNow, SLEEP_TARGET_MIN, 100) : SLEEP_TARGET_FALLB;

  // ── HR helpers ──────────────────────────────────────────────────────────────
  const hrStatsNear = (t: number, win = 90_000): { mean: number; cv: number } | null => {
    // hr is sorted; gather samples within ±win
    const xs: number[] = [];
    for (const h of hr) { if (h.t < t - win) continue; if (h.t > t + win) break; xs.push(h.v); }
    if (!xs.length) return null;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    return { mean, cv: mean > 0 ? sd / mean : 1 };
  };

  // ── HRV trust filter ──────────────────────────────────────────────────────────
  const qmap = buildHeartbeatQualityMap(beatsRaw as any[]);
  const trustHRV = (t: number, v: number, useHrContext: boolean): { ok: boolean; why: string } => {
    if (!(v >= 5 && v <= HRV_VMAX)) return { ok: false, why: 'value' }; // implausible / artifact SDNN
    if (useHrContext) {
      // The arbiter is the surrounding HR: heat/stress raises HR while STILL (real low-HRV
      // signal — keep it), whereas movement raises HR a lot and/or makes it erratic (reject).
      // The watch R-R "gap" flag over-rejects this user's stable reads, so it is NOT a reject.
      const s = hrStatsNear(t);
      if (s && s.mean > restHR + HRV_HR_OVER) return { ok: false, why: 'hr-high' };
      if (s && s.cv > HRV_CV_MAX)             return { ok: false, why: 'hr-erratic' };
    }
    return { ok: true, why: 'ok' };
  };

  // Baseline HRV from trusted readings over 14d (HR context not needed for plausibility-only baseline).
  const baseVals = (hrvBaseRaw as any[])
    .map(s => ({ t: new Date(s.startDate).getTime(), v: s.quantity as number }))
    .filter(s => trustHRV(s.t, s.v, false).ok)
    .map(s => s.v);
  const hrvBaseline = median(baseVals) || 45;

  // Trusted HRV inside the compute window (with HR-movement context). Capture per-sample
  // debug so the calibration can be replayed/diagnosed off-device.
  const fromMs = from.getTime();
  const relMin = (t: number) => Math.round((t - fromMs) / 60_000);
  let hrvUsed = 0, hrvRejected = 0;
  const validHrv: { t: number; v: number; hr: number }[] = [];  // trusted reads carry their resting HR
  const hrvDebug: any[] = [];
  for (const s of (hrvRaw as any[])) {
    const t = new Date(s.startDate).getTime(), v = s.quantity as number;
    const ctx = hrStatsNear(t);
    const res = trustHRV(t, v, true);
    if (res.ok) { validHrv.push({ t, v, hr: ctx ? ctx.mean : restHR }); hrvUsed++; } else hrvRejected++;
    hrvDebug.push({ m: relMin(t), v: Math.round(v), hr: ctx ? Math.round(ctx.mean) : 0, cv: ctx ? Math.round(ctx.cv * 100) : -1, rr: isGoodHRVSample(t, qmap) ? 1 : 0, ok: res.ok ? 1 : 0, w: res.why });
  }
  validHrv.sort((a, b) => a.t - b.t);
  const nearestHrv = (t: number, win = HRV_WIN_MIN * 60_000): number | null => {
    let best: number | null = null, bestDt = win;
    for (const s of validHrv) { const dt = Math.abs(s.t - t); if (dt <= bestDt) { bestDt = dt; best = s.v; } }
    return best;
  };

  // ── Sleep windows + sessions ──────────────────────────────────────────────────
  const sleepWins = (sleepRaw as any[])
    .filter(s => ASLEEP.has(s.value))
    .map(s => ({ s: new Date(s.startDate).getTime(), e: new Date(s.endDate).getTime() }));
  const isAsleep = (t: number) => sleepWins.some(w => t >= w.s && t <= w.e);

  // Merge asleep windows separated by < SESSION_GAP into overnight "sessions". A brief
  // awakening INSIDE a session is a micro-wake (still night), not awake-daytime — so we
  // interpret HRV there as sleep, not stress (HK sleep state gating, per the user). The HR
  // gate is the general daytime safeguard; this is the night-specific one.
  const sessions = (() => {
    const sorted = [...sleepWins].sort((a, b) => a.s - b.s);
    const out: { s: number; e: number }[] = [];
    for (const w of sorted) {
      const last = out[out.length - 1];
      if (last && w.s - last.e <= SESSION_GAP_MS) last.e = Math.max(last.e, w.e);
      else out.push({ s: w.s, e: w.e });
    }
    return out;
  })();
  const inSleepSession = (t: number) => sessions.some(w => t >= w.s && t <= w.e);

  // HK sleep STAGE at t (0 inBed, 1 asleep, 2 awake, 3 core, 4 deep, 5 REM; -1 none) — emitted
  // in the debug dump so a future capture can calibrate stage-specific stress ceilings.
  const stageWins = (sleepRaw as any[]).map(s => ({ s: new Date(s.startDate).getTime(), e: new Date(s.endDate).getTime(), v: s.value }));
  const stageAt = (t: number) => { for (const w of stageWins) if (t >= w.s && t <= w.e) return w.v; return -1; };

  // ── Day/night stress baselines (z-score) ──────────────────────────────────────
  // Build mean+SD of HRV and resting HR for DAY vs NIGHT from the trusted reads, so stress is each
  // reading's deviation from the athlete's OWN circadian-appropriate baseline (research-aligned).
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const stdev = (xs: number[]) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1)); };
  const nightRead = (rt: number) => isAsleep(rt) || inSleepSession(rt);
  const dayReads = validHrv.filter(r => !nightRead(r.t));
  const nightReads = validHrv.filter(r => nightRead(r.t));
  const mkBase = (reads: typeof validHrv, fb: { hvM: number; hvS: number; hrM: number; hrS: number }) =>
    reads.length >= 6
      ? { hvM: mean(reads.map(r => r.v)), hvS: Math.max(BASE_SD_MIN, stdev(reads.map(r => r.v))),
          hrM: mean(reads.map(r => r.hr)), hrS: Math.max(BASE_SD_MIN, stdev(reads.map(r => r.hr))) }
      : fb;
  const fbBase = { hvM: hrvBaseline, hvS: 15, hrM: restHR, hrS: 6 };
  const dayBase0 = mkBase(dayReads, fbBase);
  const nightBase0 = mkBase(nightReads, dayBase0); // too few night reads → fall back to the day baseline

  // ── 60-DAY HRV BASELINE (Bevel parity — THE SELF-NORMALISATION FIX) ─────────────────────────────────
  // Asked Bevel directly (2026-07-14): "your baseline is a 60-day rolling average of your morning and sleep
  // HRV readings." OURS was built from the SAME 60-HOUR window we score against — and a baseline computed
  // from the very data you're measuring SELF-NORMALISES: a sustained condition (a heat wave, a hard training
  // block) drifts INTO the baseline and becomes "your normal", so it disappears from the stress signal
  // entirely. That is the long-chased heat-blindness ([[user_physiology]]). Bevel's 60-day window can't do
  // that — a 5-day heat ramp is a small slice of 60 days, so it still reads as deviation.
  // READ SELECTION — this, not the window length, is what actually sets the level. Evidence (07-14 dump):
  // our 60-day baseline came out 41.8 while Bevel's 60-day is 45.4 — BUT our 60-HOUR baseline, which applies
  // the FULL trust filter (HR context: rejects reads taken while moving/elevated), is 45.0 ≈ Bevel. Same
  // HealthKit data. CORRECTED 2026-07-14 (Geert): there is NO second app — all HRV is Apple Watch; he turned
  // on AFib History in Apple Health, which makes the WATCH sample ~25×/night instead of 5–15. So the extra
  // reads are legitimate, just taken at more varied moments. Select the baseline reads by ACTUAL SLEEP
  // WINDOWS over 60 days (cheap extra HK category query), falling back to a 22:00–09:00 clock split when
  // sleep data is too thin (new user / watch not worn). NB sleep-window selection did NOT lift the baseline
  // (41.8 → 40.4) — the denser reads sit inside sleep too. The real lever turned out to be the STATISTIC
  // (pooled sample mean vs mean-of-nightly-means), below.
  // SCOPE: this fixes the HRV channel (the dominant term — Bevel: "an inverse relationship between your
  // current HRV and your baseline", HR only a modifier). HR mean/SD still come from the compute window
  // because we have no dense 60-day HR context; the HR channel therefore remains window-normalised. That is
  // the next lever if heat still under-reads.
  const HRV_BASE_MIN_READS = 10;              // below this, keep the window baseline (a new user has no history)
  const baseReads = (hrvBaseRaw as any[])
    .map(s => ({ t: new Date(s.startDate).getTime(), v: s.quantity as number,
                 src: (s.sourceRevision?.source?.name ?? s.sourceRevision?.source?.bundleIdentifier ?? 'unknown') as string }))
    .filter(s => trustHRV(s.t, s.v, false).ok);   // plausibility only (no dense HR context over 60d)
  // 60-day sleep SESSIONS (merge stage segments < 1h apart → ~one per night, so the lookup stays cheap).
  const baseSleepSessions = (() => {
    const wins = (sleepBaseRaw as any[])
      .filter(s => ASLEEP.has(s.value))
      .map(s => ({ s: new Date(s.startDate).getTime(), e: new Date(s.endDate).getTime() }))
      .filter(w => Number.isFinite(w.s) && Number.isFinite(w.e))
      .sort((a, b) => a.s - b.s);
    const out: { s: number; e: number }[] = [];
    for (const w of wins) {
      const last = out[out.length - 1];
      if (last && w.s - last.e <= SESSION_GAP_MS) last.e = Math.max(last.e, w.e);
      else out.push({ ...w });
    }
    return out;
  })();
  const inBaseSleep = (t: number) => baseSleepSessions.some(w => t >= w.s && t <= w.e);
  const restHour = (t: number) => { const h = new Date(t).getHours(); return h >= 22 || h < 9; };
  // Prefer real sleep windows; fall back to the clock split only if we have almost no sleep history.
  const useSleepWins = baseSleepSessions.length >= 10;
  const isBaseNight = (t: number) => (useSleepWins ? inBaseSleep(t) : restHour(t));
  const nightBaseVals = baseReads.filter(r => isBaseNight(r.t)).map(r => r.v);
  const dayBaseVals   = baseReads.filter(r => !isBaseNight(r.t)).map(r => r.v);
  // hvM = mean of NIGHTLY MEANS (one value per night, equal weight) — NOT a pooled sample mean.
  // WHY (07-14): the pooled mean gave 40.4 vs Bevel's 45.4, and the 60-day read distribution is wildly
  // wide + RIGHT-skewed (p10 21.4 · p50 36.2 · p90 64.5, mean 40.4 > median 36.2). Pooling lets ONE night
  // that logged 60 junk reads outweigh a night that logged 8 good ones — Geert's AFib app logs ~25/night
  // (Apple Watch: 5–15) and we CANNOT filter it by source (every sample reports as "SourceProxy" — the HK
  // bridge doesn't surface the writing app) nor by time (it logs during sleep too). Averaging per-NIGHT
  // means removes that weighting bias, and "a 60-day rolling average of your sleep HRV" is one-value-per-
  // night anyway. hvS stays the POOLED within-read SD (it z-scores individual reads, so it must describe
  // read-level spread, not night-to-night spread).
  const nightlyMeans = (() => {
    if (!useSleepWins) return [] as number[];
    const byNight = new Map<number, number[]>();
    for (const r of baseReads) {
      const i = baseSleepSessions.findIndex(w => r.t >= w.s && r.t <= w.e);
      if (i < 0) continue;
      (byNight.get(i) ?? byNight.set(i, []).get(i)!).push(r.v);
    }
    return [...byNight.values()].filter(v => v.length >= 3).map(v => mean(v));
  })();
  // TREND-CORRECTED LEVEL (2026-07-14). A flat rolling MEAN of a RISING series sits ~half the window behind:
  // Geert's nightly HRV is climbing (+0.10 ms/night — fitness returning after PFPS, plus a fresh
  // CJC-1295/Ipamorelin batch, plus heat acclimatisation, all pushing the same way), so the 60-night mean
  // (40.6) was measuring him against his ~30-days-ago self while he actually sits at 44.7. **3.0 of that
  // 4.1 ms "elevation" was pure baseline LAG, not recovery.** That single bug explains: (a) recovery pinned
  // near 100 (you look elevated every day while you keep improving), (b) our night stress UNDER-reading
  // (a lagging baseline inflates zHRV, which suppresses stress), and (c) why Bevel's 45.4 beat our 40.6 —
  // trend-corrected we get 43.6, so Bevel is recency-weighted, not a flat mean.
  // It also resolves the real tension: we need the baseline to TRACK slow structural change (fitness) while
  // still FLAGGING acute conditions (heat, illness). A flat window can't do both; a TREND LINE does — fitness
  // moves the slope, a heat wave shows up as deviation FROM the slope.
  // Guards: enough nights, a clamped slope, and a clamped correction, so noise can never run the level away.
  const TREND_MIN_NIGHTS = 20;
  const TREND_MAX_SLOPE  = 0.30;   // ms/night — beyond this it's noise, not a trend
  const TREND_MAX_ADJ    = 8;      // ms — hard cap on how far the trend may move the level off the flat mean
  const trendLevel = (perNight: number[], flat: number): number => {
    if (perNight.length < TREND_MIN_NIGHTS) return flat;
    const N = perNight.length;
    const xs = perNight.map((_, i) => i);
    const mx = mean(xs), my = mean(perNight);
    const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    if (den <= 0) return flat;
    const slope = clamp(xs.reduce((a, x, i) => a + (x - mx) * (perNight[i] - my), 0) / den, -TREND_MAX_SLOPE, TREND_MAX_SLOPE);
    const today = (my - slope * mx) + slope * (N - 1);          // regression line AT TODAY, not its mean
    return flat + clamp(today - flat, -TREND_MAX_ADJ, TREND_MAX_ADJ);
  };
  const hv60 = (vals: number[], fbM: number, fbS: number, perNight?: number[]) => {
    if (vals.length < HRV_BASE_MIN_READS) return { hvM: fbM, hvS: fbS };  // fall back to the window baseline
    const flat = (perNight && perNight.length >= 10) ? mean(perNight) : mean(vals);
    return {
      hvM: perNight && perNight.length ? trendLevel(perNight, flat) : flat,
      // hvS stays the POOLED READ-level SD: it z-scores individual reads, and read-to-read spread (~17.8)
      // dwarfs the trend's contribution, so detrending it would be noise-fitting.
      hvS: Math.max(BASE_SD_MIN, stdev(vals)),
    };
  };
  const dayBase   = { ...dayBase0,   ...hv60(dayBaseVals,   dayBase0.hvM,   dayBase0.hvS) };
  const nightBase = { ...nightBase0, ...hv60(nightBaseVals, nightBase0.hvM, nightBase0.hvS, nightlyMeans) };

  // ── Workout windows (+ settle) ───────────────────────────────────────────────
  // During a workout and for ~15 min after, HR is exercise-driven (and still settling),
  // not psychological/physiological stress — exclude that span from the stress curve so a
  // run doesn't read as a stress spike. Built from the snapshot's workouts (runs included).
  const workoutWins = (((snap as any)?.activities ?? []) as any[])
    .map(a => { const s = new Date(a.date).getTime(); return { s, e: s + (a.durationMin ?? 0) * 60_000 + WORKOUT_SETTLE_MS }; })
    .filter(w => Number.isFinite(w.s) && w.e > fromMs);
  const inWorkout = (t: number) => workoutWins.some(w => t >= w.s && t <= w.e);
  // The +WORKOUT_SETTLE_MS tail above exists to keep post-exercise HR OUT OF THE STRESS CURVE. It must NOT
  // also drain you at exercise intensity — you've stopped moving. Draining the settle window at the full
  // %HRR workout rate was silently adding ~15 min of hard drain to EVERY session (2026-07-14 paired-Bevel
  // finding: our workout bins totalled 5.1 h and −46 pts, a big part of what pinned the evening at the
  // floor). So the DRAIN uses the exercise span only; the STRESS exclusion keeps the settle tail.
  const exerciseWins = (((snap as any)?.activities ?? []) as any[])
    .map(a => { const s = new Date(a.date).getTime(); return { s, e: s + (a.durationMin ?? 0) * 60_000 }; })
    .filter(w => Number.isFinite(w.s) && w.e > fromMs);
  const inExercise = (t: number) => exerciseWins.some(w => t >= w.s && t <= w.e);

  // ── Bin + integrate ──────────────────────────────────────────────────────────
  const binMs = BIN_MIN * 60_000;
  const start = Math.floor(from.getTime() / binMs) * binMs;
  let hi = 0;
  // Stress = personal z-score index: STRESS_BASE + (zHR − zHRV)·STRESS_SCALE, against the day or
  // night baseline. Missing HRV → zHRV 0 (HR-only). Capped 0..100.
  const zStress = (avgHR: number, vHrv: number | null, b: { hvM: number; hvS: number; hrM: number; hrS: number }): number => {
    const zHR  = (avgHR - b.hrM) / b.hrS;
    const zHRV = vHrv != null ? (vHrv - b.hvM) / b.hvS : 0;
    return clamp(STRESS_BASE + (zHR - zHRV) * DAY_STRESS_SCALE, 0, 100); // DAY: steeper scale (decompressed to Bevel)
  };
  // Night variant: anchor low and count ONLY HR arousal beyond a margin (normal settling HR ≈ 0),
  // soften the HRV term, hard-cap. Keeps a calm night flat & low (Bevel-like) without starving charge.
  const zStressNight = (avgHR: number, vHrv: number | null, b: { hvM: number; hvS: number; hrM: number; hrS: number }): number => {
    const zHR  = Math.max(0, (avgHR - (b.hrM + NIGHT_HR_MARGIN)) / Math.max(b.hrS, NIGHT_HR_SD_MIN));
    const zHRV = vHrv != null ? (vHrv - b.hvM) / b.hvS : 0;
    return NIGHT_STRESS_BASE + (zHR - NIGHT_HRV_K * zHRV) * STRESS_SCALE;
  };

  const anchor = await getBatteryAnchor(); // dev calibration: force the level at a chosen moment
  let anchored = false;
  let battery = SEED; // washed out by the two nights inside the 60h window
  let smStress: number | null = null; // EWMA-smoothed stress (momentum)
  let wakeAt = start;       // timestamp of the most recent morning get-up (resets the circadian drain clock)
  let prevNight = true;     // window opens mid-sleep, so we start "in the night"
  const series: BatteryPoint[] = [];
  const binDebug: any[] = [];
  const corrBins: { t: number; s: number; hr: number; hrv: number; stg: number; a: number; b: number }[] = [];
  for (let t = start; t <= now; t += binMs) {
    // mean HR in [t, t+bin)
    let sum = 0, n = 0;
    while (hi < hr.length && hr[hi].t < t) hi++;
    for (let j = hi; j < hr.length && hr[j].t < t + binMs; j++) { sum += hr[j].v; n++; }
    const mid = t + binMs / 2;
    const asleep = isAsleep(mid);
    const night = asleep || inSleepSession(mid); // asleep OR a micro-wake inside the night
    const stage = stageAt(mid);                  // HK stage 0..5 (-1 none)
    const workout = inWorkout(mid);      // exercise + settle tail → freezes the STRESS curve
    const exercising = inExercise(mid);  // exercise ONLY → drives the %HRR DRAIN (settle must not drain)
    // Circadian clock: the night→day transition (getting up) restarts time-since-wake; micro-wakes
    // inside the sleep session keep `night` true and don't reset it.
    if (!night && prevNight) wakeAt = mid;
    // Did we just cross the sleep boundary (either way)? Captured BEFORE prevNight is overwritten — the
    // stress EWMA below must RESET on this flip (see the sleepFlip comment at the EWMA).
    const sleepFlip = night !== prevNight;
    prevNight = night;
    const hoursAwake = night ? 0 : Math.max(0, (mid - wakeAt) / 3_600_000);
    if (n === 0 && !asleep) continue; // no data, awake → skip (gap)
    const avgHR = n > 0 ? sum / n : restHR;
    const vHrv = nearestHrv(t);
    // Stress = z-score index vs the day/night baseline (zHR − zHRV). At night add the sleep-stage
    // bump on top (REM bumps; deep sits at the recovery baseline). A low-HRV night → high baseline,
    // so the REM bumps drown; a rested night → low baseline, crisp square wave.
    const base = night ? nightBase : dayBase;
    const dayZ = night ? 0 : zStress(avgHR, vHrv, base); // (B) pre-offset day z-score (recoverable as s0)
    // Movement gate (Bevel-method): discount daytime stress by how much of the HR bump is explained by
    // stepping around — walking/housework HR is exertion, not autonomic stress. Night has no steps → 0.
    const moveFrac = night ? 0 : clamp(stepsPerMinNear(mid) / MOVE_STEPS_FULL, 0, 1);
    const rawStress = night
      ? clamp(zStressNight(avgHR, vHrv, base) + (stage >= 0 ? STAGE_BUMP[stage] : 0), 0, NIGHT_STRESS_CAP)
      : clamp((dayZ + DAY_STRESS_OFFSET) * (1 - MOVE_GATE * moveFrac), 0, 100);
    // EWMA momentum: fast attack only AWAKE-DAY (a real stressor). At night use a faster weight so
    // REM/stage transitions actually show (a slow weight smears the square wave flat). Workout +
    // settle FREEZES the EWMA (bin → gap).
    if (!workout) {
      // RESET THE EWMA WHEN WE CROSS THE SLEEP BOUNDARY (2026-07-14). Falling asleep is a genuine STATE
      // CHANGE — the awake stress must not bleed across it. It was: the evening's high stress (last awake bin
      // 67) decayed into the night at 65%/bin, so the first asleep bins REPORTED 49 → 38 → 31 → 28 while the
      // RAW night stress was already a correct, calm 17. That fake ~40-min ramp was the whole "high early-night
      // stress" (Bevel read 10 there). Same on waking, so night stress can't bleed into the day.
      // NOTE: the base 9 / scale 22 refit above was grid-fitted with a FRESH EWMA at sleep onset, so this reset
      // is REQUIRED for that fit to hold — the two changes are coupled.
      if (smStress == null || sleepFlip) {
        smStress = rawStress;
      } else {
        const alpha: number = night ? NIGHT_STAGE_SMOOTH : (rawStress > smStress ? 1 : STRESS_SMOOTH);
        smStress = alpha * rawStress + (1 - alpha) * smStress;
      }
    } else if (smStress == null) {
      smStress = STRESS_BASE;
    }
    const stress = smStress;
    // Fitted two-regime model (Bevel-calibrated, NO ceiling): ASLEEP charges, AWAKE holds at rest /
    // drains under stress. REM's autonomic stress spike isn't real strain → cap it; NREM (core & deep)
    // share one curve. A workout's real effort drains via its higher stress. Rates are per-HOUR.
    const drainStress = workout ? Math.min(WORKOUT_STRESS_CAP, Math.max(rawStress, stress)) : stress;
    // NO time-of-day factor (29 Jun re-fit vs Bevel): Bevel holds energy FLAT through a calm morning and
    // drains purely on stress — the circadian effect already enters via the measured stress. The old
    // morning multiplier over-drained the low-stress morning (left us ~10% below Bevel all day). Kept as 1
    // (DRAIN_TIME_* constants retained for the debug dump / possible future use).
    const timeMult = 1;
    let ratePerHour: number;
    if (asleep) {
      // ASYMPTOTIC charge toward the RECOVERY target (see the SLEEP_CHARGE_K block above). Fast when the
      // tank is low, tapering as it fills — and it ANCHORS the whole curve, so the battery can no longer
      // drift into a permanent low orbit. REM's autonomic spike isn't real strain → cap it, as before.
      const sSleep = stage === 5 ? Math.min(stress, REM_STRESS_CAP) : stress;
      const quality = clamp(1 - SLEEP_STRESS_K * Math.max(0, sSleep - SLEEP_STRESS_FREE), SLEEP_QUALITY_MIN, 1);
      ratePerHour = Math.max(0, SLEEP_CHARGE_K * quality * (chargeTarget - battery));
    } else if (exercising) {
      // Drain on HR intensity (%HRR) during the SESSION ITSELF — the stress-linear curve is far too gentle
      // here. NOTE: `exercising`, not `workout` — the settle tail is for the stress exclusion only, and must
      // fall through to the normal awake curve below (where a cooling-down HR drains gently, as it should).
      const hrr = clamp((avgHR - restHR) / Math.max(1, maxHR - restHR), 0, 1);
      ratePerHour = -WORKOUT_DRAIN_PER_HRR * hrr;
    } else {
      // AWAKE. Up-and-about burns energy → the drain curve. But STILL (≈no steps) + low stress is genuine
      // recovery → gentle rest-charge (Garmin/Bevel charge a calm awake morning). drainStress is the
      // movement-GATED stress, but when genuinely still moveFrac≈0 so the gate is a no-op — it equals the
      // real, low calm stress the rest-charge wants. If stressed even while still (acute stress), rest-charge
      // goes ≤0 and we fall back to the drain curve.
      const spm = stepsPerMinNear(mid);
      const restCharge = spm < REST_STEPS_MAX ? (REST_CHARGE_BASE - REST_CHARGE_K * drainStress) : -1;
      ratePerHour = restCharge > 0 ? restCharge : (DRAIN_BASE - DRAIN_STRESS_K * drainStress) * timeMult;
    }
    // Near-empty throttle: as the battery approaches the floor, suppress DRAIN toward 0 (asymptote, no
    // flat-line crash). Charge (positive rate) is untouched so it always recovers off the floor.
    if (ratePerHour < 0 && battery < DRAIN_FLOOR_KNEE)
      ratePerHour *= clamp((battery - BATTERY_FLOOR) / (DRAIN_FLOOR_KNEE - BATTERY_FLOOR), 0, 1);
    battery = clamp(battery + ratePerHour * (BIN_MIN / 60), BATTERY_FLOOR, 100);
    // Dev anchor: at the chosen moment, override the integrated level, then keep integrating
    // forward from there (so the curve passes through the known value).
    // Only honour anchors that fall INSIDE the 60h window; a stale one (e.g. days old) would otherwise
    // apply at the window's start and skew the whole curve. anchor.at must be ≥ start to bite here.
    if (anchor && anchor.at >= start && !anchored && mid >= anchor.at) { battery = clamp(anchor.value, 0, 100); anchored = true; }
    series.push({ t, battery: Math.round(battery), stress: Math.round(stress), asleep, workout });
    binDebug.push({ m: relMin(t), hr: Math.round(avgHR), a: asleep ? 1 : 0, ses: night ? 1 : 0, stg: stage, wo: workout ? 1 : 0, hrv: vHrv ? Math.round(vHrv) : 0, s: Math.round(stress), s0: night ? Math.round(stress) : Math.max(0, Math.round(stress - DAY_STRESS_OFFSET)), h: Math.round(hoursAwake * 10) / 10, tm: Math.round(timeMult * 100) / 100, b: Math.round(battery) });
    corrBins.push({ t, s: Math.round(stress), hr: Math.round(avgHR), hrv: vHrv ? Math.round(vHrv) : 0, stg: stage, a: night ? 1 : 0, b: Math.round(battery) });
  }
  if (!series.length) return null;
  // A JUST-set anchor (its time past the last bin's midpoint but still ≤ now) is missed by the in-loop
  // mid-check, so the "now" reading wouldn't reflect it. Pin the final bin to it directly.
  if (anchor && !anchored && anchor.at >= start && anchor.at <= now + binMs) {
    series[series.length - 1].battery = Math.round(clamp(anchor.value, 0, 100));
  }

  // Keep last 24h for display.
  const cut = now - 24 * 3_600_000;
  const shown = series.filter(p => p.t >= cut);
  const last = series[series.length - 1];
  const hourAgo = series.find(p => p.t >= now - 3_600_000) ?? last;
  // Top-line stress pauses during a workout + settle (Bevel-method): show the last NON-workout reading, not
  // the exercise-driven value. Battery is unaffected (it drains via the workout HRR model regardless).
  const lastStress = ([...series].reverse().find(p => !p.workout) ?? last).stress;
  const bats = shown.map(p => p.battery);

  // Cumulative charge/drain over the shown window (Bevel's "Total Charged/Drained").
  let totalCharged = 0, totalDrained = 0;
  for (let i = 1; i < shown.length; i++) {
    const d = shown[i].battery - shown[i - 1].battery;
    if (d > 0) totalCharged += d; else totalDrained += d;
  }

  // ── Correlation dump: the most recent night + the morning after, for fitting the recovery model
  // ΔE_bucket = w(stage)·(a − b·stress) (sleep charges, wake drains, no ceiling). Pair each bin's
  // stress + HK stage with Bevel's energy reading at that clock time.
  const STG_LABEL: Record<number, string> = { 0: 'inBed', 1: 'asleep', 2: 'awake', 3: 'core', 4: 'deep', 5: 'REM' };
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const hhmm = (t: number) => { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
  let nEnd = -1;
  for (let i = corrBins.length - 1; i >= 0; i--) { if (corrBins[i].a) { nEnd = i; break; } }
  let nStart = nEnd;
  while (nStart > 0 && corrBins[nStart - 1].a) nStart--;
  let correlation: any = null;
  if (nEnd >= 0) {
    const stages: { stage: string; from: string; to: string; min: number }[] = [];
    let lastStg = NaN;
    for (let i = nStart; i <= nEnd; i++) {
      const b = corrBins[i];
      if (b.stg === lastStg && stages.length) {
        const cur = stages[stages.length - 1];
        cur.to = hhmm(b.t + binMs); cur.min += BIN_MIN;
      } else {
        stages.push({ stage: STG_LABEL[b.stg] ?? '—', from: hhmm(b.t), to: hhmm(b.t + binMs), min: BIN_MIN });
        lastStg = b.stg;
      }
    }
    const from = Math.max(0, nStart - 3);               // a little pre-sleep context (charge onset)
    const bins = corrBins.slice(from).map((b) => ({
      t: hhmm(b.t), stress: b.s, hr: b.hr, hrv: b.hrv || undefined,
      stage: STG_LABEL[b.stg] ?? '—', asleep: b.a, ourBattery: b.b,
    }));
    correlation = {
      note: 'Per-bin OURS/HK over the last night + the morning after. To fit the recovery model, pair each bin (or 6-min bucket) stress + stage with Bevel\'s ENERGY reading at that clock time, then regress ΔE = w(stage)·(a − b·stress). Sleep charges, wake drains, no ceiling.',
      binMin: BIN_MIN, restHR, hrvBaseline: Math.round(hrvBaseline),
      night: `${hhmm(corrBins[nStart].t)}→${hhmm(corrBins[nEnd].t + binMs)}`,
      stages,   // HK sleep-stage timeline (distinct blocks)
      bins,     // {t, stress, hr, hrv, stage, asleep, ourBattery}
    };
  }

  return {
    current: last.battery,
    currentStress: lastStress,
    trendPerHour: Math.round(last.battery - hourAgo.battery),
    dayLow: bats.length ? Math.min(...bats) : last.battery,
    dayHigh: bats.length ? Math.max(...bats) : last.battery,
    totalCharged: Math.round(totalCharged),
    totalDrained: Math.round(totalDrained),
    series: shown,
    hrvBaseline: Math.round(hrvBaseline),
    restHR,
    hrvUsed, hrvRejected,
    computedAt: now,
    debug: {
      meta: { restHR, maxHR, hrvBaseline: Math.round(hrvBaseline), now, fromMin: relMin(from.getTime()),
        // The anchor actually used this run — verify the next paired export against these.
        recoveryNow, chargeTarget,
        // 60-day HRV baseline vs the OLD 60h-window one. When these two diverge (heat wave, hard block) the
        // old window baseline was self-normalising the condition away. Bevel's own 60-day value was 45.4.
        hrvBase60: { day: dayBase.hvM, night: nightBase.hvM, nDay: dayBaseVals.length, nNight: nightBaseVals.length, days: BASELINE_DAYS,
          sleepSessions: baseSleepSessions.length, selectedBy: useSleepWins ? 'sleep-windows' : 'clock' },
        // WHY the 60-day baseline (40.4) sits below Bevel's (45.4) while our trust-filtered 60h reads give
        // 45.0: we suspect a low-value SOURCE (the AFib app logs ~25 reads/night DURING sleep vs Apple
        // Watch's 5–15). Name it instead of guessing: per-source count + mean over the 60-day SLEEP reads,
        // plus the value distribution. If one source is clearly dragging the mean down, we filter it and the
        // baseline should land at ~45 — at which point the base-9/scale-22 night fit holds again.
        hrvSources: (() => {
          const acc: Record<string, { n: number; mean: number }> = {};
          for (const r of baseReads.filter(r => isBaseNight(r.t))) {
            const e = (acc[r.src] ??= { n: 0, mean: 0 });
            e.mean = (e.mean * e.n + r.v) / (e.n + 1); e.n++;
          }
          for (const k of Object.keys(acc)) acc[k].mean = Math.round(acc[k].mean * 10) / 10;
          return acc;
        })(),
        // hvM is now the mean of NIGHTLY MEANS. Emit them so the next dump shows the per-night level and
        // whether the pooled-vs-per-night statistic is what moved us off Bevel's 45.4.
        hrvNightly: { n: nightlyMeans.length,
          meanOfNightMeans: Math.round(mean(nightlyMeans.length ? nightlyMeans : [0]) * 10) / 10,
          pooledMean: Math.round(mean(nightBaseVals.length ? nightBaseVals : [0]) * 10) / 10,
          trendLevelUsed: Math.round(nightBase.hvM * 10) / 10,   // the LAG-CORRECTED level actually used
          nights: nightlyMeans.map(v => Math.round(v * 10) / 10) },
        hrvNightPct: (() => {
          const v = [...nightBaseVals].sort((a, b) => a - b);
          const p = (q: number) => v.length ? Math.round(v[Math.floor(q * (v.length - 1))] * 10) / 10 : 0;
          return { p10: p(0.10), p25: p(0.25), p50: p(0.50), p75: p(0.75), p90: p(0.90) };
        })(),
        hrvBaseWindow: { day: dayBase0.hvM, night: nightBase0.hvM },
        constants: { BIN_MIN, REST_STRESS, SLEEP_CHARGE_K, SLEEP_TARGET_MIN, SLEEP_TARGET_FALLB, SLEEP_STRESS_FREE, SLEEP_STRESS_K, SLEEP_QUALITY_MIN, WORKOUT_DRAIN_PER_HRR, CHARGE_BASE, CHARGE_STRESS_K, DRAIN_BASE, DRAIN_STRESS_K, DRAIN_TIME_MMAX, DRAIN_TIME_DECAY, DRAIN_TIME_MMIN, WORKOUT_STRESS_CAP, REM_STRESS_CAP, STRESS_SMOOTH, STRESS_BASE, STRESS_SCALE, DAY_STRESS_OFFSET, BASE_SD_MIN, NIGHT_STAGE_SMOOTH, SEED, WINDOW_H },
        baselines: { dayBase, nightBase } },
      hrv: hrvDebug,   // every HRV sample: m=min-from-start, v=ms, hr/cv context, ok, why
      bins: binDebug,  // per 10-min bin: m, hr, a=asleep, hrv=nearest-trusted, s=stress, b=battery
    },
    correlation,       // last-night stage timeline + per-bin series for the recovery-model fit
  };
}
