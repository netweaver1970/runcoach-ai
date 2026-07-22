/**
 * Training Load model — CTL / ATL / TSB (the "Performance Manager Chart")
 *
 * Uses ALL HealthKit activity (runs, rides, strength, walks…), not just runs, so
 * the coach sees total systemic load — exactly how a human coach would weigh a
 * leg day or a long hike against your running.
 *
 * Per-workout load:
 *   • Primary driver is active energy (kcal) — it scales with both duration AND
 *     intensity and is available for every workout type. load = kcal × 0.1
 *     (a 600-kcal session ≈ 60 load units, comparable to a moderate-hard TRIMP).
 *   • When kcal is missing we fall back to durationMin × per-activity intensity.
 *   • Runs with a heart-rate average get a small Banister-TRIMP nudge so a hard
 *     interval session outweighs an easy jog of the same calorie burn.
 *
 * Daily series:
 *   ATL = 7-day  exponentially-weighted moving average of daily load  (fatigue)
 *   CTL = 42-day exponentially-weighted moving average of daily load  (fitness)
 *   TSB = yesterday's (CTL − ATL)                                      (form/freshness)
 *
 * EWMA update:  x[i] = x[i-1] + λ·(load[i] − x[i-1]),  λ = 1 − e^(−1/τ)
 */

import { ActivitySummary, DailyLoad, DayStrain } from '../types';

// ─── HKWorkoutActivityType → name + intensity factor (load/min, kcal-free fallback) ──

interface ActivityMeta { name: string; factor: number }

const ACTIVITY_META: Record<number, ActivityMeta> = {
  37: { name: 'Run',          factor: 1.0 },  // running
  24: { name: 'Hike',         factor: 0.6 },  // hiking
  52: { name: 'Walk',         factor: 0.35 }, // walking
  13: { name: 'Cycling',      factor: 0.75 }, // cycling
  16: { name: 'Elliptical',   factor: 0.7 },  // elliptical
  44: { name: 'Rowing',       factor: 0.85 }, // rowing
  46: { name: 'Swim',         factor: 0.9 },  // swimming
  63: { name: 'HIIT',         factor: 1.1 },  // highIntensityIntervalTraining
  20: { name: 'Strength',     factor: 0.6 },  // functionalStrengthTraining
  50: { name: 'Strength',     factor: 0.6 },  // traditionalStrengthTraining
  57: { name: 'Yoga',         factor: 0.3 },  // yoga
  59: { name: 'Mobility',     factor: 0.3 },  // flexibility / preparationAndRecovery
  35: { name: 'Rope',         factor: 1.0 },  // jumpRope
  70: { name: 'Tennis',       factor: 0.8 },  // tennis / racquet
  77: { name: 'Dance',        factor: 0.7 },  // cardioDance
  78: { name: 'Dance',        factor: 0.55 }, // socialDance
  79: { name: 'Core',         factor: 0.55 }, // coreTraining
  3:  { name: 'Strength',     factor: 0.6 },  // americanFootball? no — keep generic; rarely used
};

// Coarse sport categories for the main-screen filter + coach context. Running keeps its
// own structured pipeline (zones/classification); everything else is start-to-end only.
export type SportCategory = 'Run' | 'Walk' | 'Dance' | 'Cardio' | 'Other';
export function activityCategory(type: number): SportCategory {
  if (type === 37) return 'Run';
  if (type === 52 || type === 24) return 'Walk';                        // walking, hiking
  if (type === 77 || type === 78) return 'Dance';                       // cardio/social dance
  if ([63, 79, 16, 44, 13, 46, 35, 70].includes(type)) return 'Cardio'; // HIIT/Tabata/VO2, core, elliptical, row, bike, swim, rope, racquet
  return 'Other';                                                       // strength, yoga, mobility, …
}

export function activityName(type: number): string {
  return ACTIVITY_META[type]?.name ?? 'Workout';
}
export function activityFactor(type: number): number {
  return ACTIVITY_META[type]?.factor ?? 0.6;
}

const KCAL_TO_LOAD = 0.1;

/**
 * Banister-TRIMP intensity multiplier from a heart-rate reserve fraction.
 * hrr = (avgHR − restHR) / (maxHR − restHR), clamped 0..1.
 * Returns ~0.9 at easy effort, ~1.0 at moderate, up to ~1.35 near max — a gentle
 * nudge layered on top of the kcal-based load so intensity is not ignored.
 */
function trimpMultiplier(avgHR: number, maxHR: number, restHR: number): number {
  if (!avgHR || !maxHR || maxHR <= restHR) return 1;
  const hrr = Math.min(1, Math.max(0, (avgHR - restHR) / (maxHR - restHR)));
  // Map hrr 0→0.85, 0.5→1.0, 1.0→1.35 (smooth, exp-ish)
  return 0.85 + 0.5 * hrr * hrr + 0.0 * hrr;
}

/** Compute the load contribution of a single workout. */
export function computeWorkoutLoad(
  a: ActivitySummary,
  maxHR = 0,
  restHR = 50,
): number {
  const durationMin = a.durationMin;
  let base: number;
  if (a.kcal > 0) {
    base = a.kcal * KCAL_TO_LOAD;
  } else {
    base = durationMin * activityFactor(a.activityType);
  }
  // Intensity nudge for runs (only place we reliably have avgHR)
  const mult = (a.activityType === 37 && a.avgHR > 0)
    ? trimpMultiplier(a.avgHR, maxHR, restHR)
    : 1;
  return Math.round(base * mult);
}

const TAU_ATL = 7;
const TAU_CTL = 42;
const LAMBDA_ATL = 1 - Math.exp(-1 / TAU_ATL);
const LAMBDA_CTL = 1 - Math.exp(-1 / TAU_CTL);

function dayKey(iso: string): string {
  // LOCAL calendar date — slicing the ISO string took the UTC date, which in UTC+2 shifted every
  // cursor/lookup key a day back (the CTL/ATL series never contained "today" and loads landed a day late).
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Training-day attribution (Bevel-style): the LOCAL calendar date of (t − 4h), so an overnight walk or
 * run finishing after midnight counts toward the PREVIOUS day's strain — a new training day starts at
 * 04:00 local, not midnight.
 */
export function trainingDayKey(t: number | string | Date): string {
  const ms = typeof t === 'number' ? t : new Date(t as any).getTime();
  const d = new Date(ms - 4 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Convert daily active energy (kcal) to a training-load unit (keeps CTL in a familiar range). */
export const STRAIN_KCAL_TO_LOAD = 0.1;

/**
 * Build a daily CTL/ATL/TSB series from a per-day load map.
 *
 * Load is derived from total daily active energy (kcal × {@link STRAIN_KCAL_TO_LOAD}),
 * so ALL strain sources — walking, running, every workout, general movement — feed
 * the model, not just logged runs.
 *
 * @param loadByDay  date (YYYY-MM-DD) → training load for that day
 * @param fromDate   first day to RETURN (inclusive)
 * @param toDate     last day to return (inclusive, usually today)
 *
 * The EWMA is warmed up from the earliest day in the map, so callers should pass
 * load reaching ~42 days BEFORE fromDate for an accurate CTL.
 */
export function computeTrainingLoadSeries(
  loadByDay: Map<string, number>,
  fromDate: Date,
  toDate: Date,
  floorByDay?: Map<string, number>,   // per-day activityFloorTrimp — lifts rest/unlogged days off ~0 (Bevel parity)
): DailyLoad[] {
  // Determine the warm-up start: earliest day with load, but no later than fromDate.
  const dayKeys = [...loadByDay.keys()].sort();
  const earliest = dayKeys.length > 0 ? dayKeys[0] : dayKey(fromDate.toISOString());
  const warmStart = new Date(Math.min(
    new Date(earliest).getTime(),
    fromDate.getTime(),
  ));
  warmStart.setHours(0, 0, 0, 0);

  const end = new Date(toDate);
  end.setHours(0, 0, 0, 0);

  const out: DailyLoad[] = [];
  let atl = 0, ctl = 0;

  const fromKey = dayKey(fromDate.toISOString());
  const cursor = new Date(warmStart);
  let first = true;

  while (cursor.getTime() <= end.getTime()) {
    const k = dayKey(cursor.toISOString());
    // NEAT/activity floor: a rest or unlogged-walk day whose HR-window TRIMP is ~0 still carries load
    // (Bevel scores it via energy/steps). max() so a real workout day — where cardio TRIMP dominates —
    // is untouched. Without this the 42-day CTL was dragged down by zeroed rest days.
    const load = Math.max(loadByDay.get(k) ?? 0, floorByDay?.get(k) ?? 0);

    if (first) {
      // Seed both EWMAs at the first day's load to limit ramp-up artefacts
      atl = load; ctl = load;
      first = false;
    } else {
      atl = atl + LAMBDA_ATL * (load - atl);
      ctl = ctl + LAMBDA_CTL * (load - ctl);
    }

    if (k >= fromKey) {
      out.push({
        date: k,
        load,
        atl: Math.round(atl * 10) / 10,
        ctl: Math.round(ctl * 10) / 10,
        // Form reflects SAME-DAY fitness − fatigue so today's training moves it intra-day:
        // fresh in the morning before load accrues, dropping after a run. (Was yesterday's
        // CTL−ATL — the lagged convention — which never reacted to today's session.)
        tsb: Math.round((ctl - atl) * 10) / 10,
      });
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return out;
}

// ─── Forward projection (7-day plan) ─────────────────────────────────────────
// Rough per-MINUTE Banister TRIMP by session intensity, so a planned run → a daily
// cardio-TRIMP estimate we can roll CTL/ATL forward with. Rest = a daily-living baseline
// (steps), so CTL/ATL don't crash on rest days.
export interface TrimpRates { easy: number; moderate: number; hard: number }
const DEFAULT_TRIMP_RATES: TrimpRates = { easy: 1.3, moderate: 2.0, hard: 2.8 };
const REST_DAY_TRIMP = 12;

export function estimateDayTrimp(intensity: string, runMinutes: number, rates: TrimpRates = DEFAULT_TRIMP_RATES): number {
  if (intensity === 'rest' || runMinutes <= 0) return REST_DAY_TRIMP;
  const perMin = intensity === 'hard' ? rates.hard : intensity === 'moderate' ? rates.moderate : rates.easy;
  // NO warm-up fudge: the CALIBRATED rate is dayLoad÷runMinutes (the whole day's TRIMP over the run's
  // minutes), so runMinutes·perMin ALREADY reconstructs the full day's load incl. warm-up/cool-down + NEAT.
  // The old `+ 8·easy` double-counted → the projection over-stated fatigue and showed negative-TSB days that
  // never materialised (realised TSB came in ~2× shallower). Fixed 2026-07-10 (Geert: "predicts negatives
  // that never happen"). Default-rate (no run data) users lose a small warm-up allowance — acceptable.
  return Math.round(runMinutes * perMin);
}

// Continuous ROLLING calibration of per-intensity TRIMP/min from the runner's OWN runs: for each
// run-day, the day's cardio TRIMP (load) ÷ the run's minutes ≈ that run's TRIMP/min. Recent runs
// are weighted exponentially (28-day half-life) so the rates track changing fitness/conditions
// (faster, more power, fitter). Intensities without their own data are derived from a present one
// via standard Z2:Z3:Z4 ratios — the fixed defaults are only used when there is NO run data at all.
const TRIMP_CALIB_HALF_LIFE = 28;                 // days
const TRIMP_RATIO = { easy: 1, moderate: 2.0 / 1.3, hard: 2.8 / 1.3 };


export function calibrateTrimpRates(
  samples: { intensity: 'easy' | 'moderate' | 'hard'; minutes: number; dayLoad: number; daysAgo: number }[],
): TrimpRates {
  const acc: Record<string, { num: number; den: number; n: number }> =
    { easy: { num: 0, den: 0, n: 0 }, moderate: { num: 0, den: 0, n: 0 }, hard: { num: 0, den: 0, n: 0 } };
  for (const s of samples) {
    if (s.minutes < 8 || s.dayLoad <= 0) continue;
    const rate = s.dayLoad / s.minutes;
    if (rate < 0.4 || rate > 5) continue;                          // drop multi-activity / bad data
    const w = Math.pow(0.5, Math.max(0, s.daysAgo) / TRIMP_CALIB_HALF_LIFE);
    acc[s.intensity].num += rate * w;
    acc[s.intensity].den += w;
    acc[s.intensity].n += 1;
  }
  const wmean = (k: string): number | null => acc[k].den > 0 ? acc[k].num / acc[k].den : null;
  const order = ['easy', 'moderate', 'hard'] as const;
  const measured: Record<string, number | null> =
    { easy: wmean('easy'), moderate: wmean('moderate'), hard: wmean('hard') };

  // Anchor on the BEST-SAMPLED intensity (not simply "easy if present") — its rate implies an
  // easy-equivalent base through the standard Z2:Z3:Z4 ratios, from which the whole curve derives.
  let anchor: typeof order[number] | null = null;
  for (const k of order) if (measured[k] != null && (anchor == null || acc[k].n > acc[anchor].n)) anchor = k;
  if (anchor == null) return { ...DEFAULT_TRIMP_RATES };           // no run data at all
  const base = measured[anchor]! / TRIMP_RATIO[anchor];

  // Use each intensity's OWN measured rate wherever it exists; derive from the anchor ONLY where there
  // is no data. Deliberately NO monotonic clamp.
  //
  // The old code ended with `moderate = max(moderate, easy); hard = max(hard, moderate)` "to keep the
  // curve monotonic". But this rate is day-load ÷ TOTAL run minutes, and that quantity has no reason to
  // rise with intensity: a hard session is roughly 1/3 work and 2/3 warm-up, jog recoveries and
  // cool-down, so its average is pulled toward easy — and if the athlete's HR doesn't actually reach the
  // prescribed zone, below it. Geert's live data measured easy 1.28 (n=18) / moderate 0.92 (n=5) /
  // hard 0.75 (n=2); the clamp shipped 1.28/1.28/1.28, so intensity was worth exactly nothing in the
  // 7-day projection, the volume-cap arithmetic or the CTL forecast.
  //
  // The inversion is REAL, not noise: on 07-20 an intervals day prescribed at Z4 259–265 W was executed
  // at 256 W — on target — yet work HR reached only 134 (HR-reserve 0.56, i.e. Z2). His quality sessions
  // genuinely cost less per minute than his easy runs. Clamping hid that; so would deriving the curve
  // from the standard ratios. Report what was measured and let the zone calibration fix the cause.
  const r = (v: number) => Math.round(v * 100) / 100;
  const out = { easy: 0, moderate: 0, hard: 0 } as TrimpRates;
  for (const k of order) out[k] = r(measured[k] ?? base * TRIMP_RATIO[k]);
  return out;
}

// Roll CTL/ATL/TSB forward day-by-day from today's values using each day's planned TRIMP,
// reusing the same EWMA time-constants as computeTrainingLoadSeries.
export function rollLoadForward(
  ctl0: number, atl0: number, dailyTrimp: number[],
): { ctl: number; atl: number; tsb: number }[] {
  let ctl = ctl0, atl = atl0;
  return dailyTrimp.map((load) => {
    atl += LAMBDA_ATL * (load - atl);
    ctl += LAMBDA_CTL * (load - ctl);
    return { ctl: Math.round(ctl * 10) / 10, atl: Math.round(atl * 10) / 10, tsb: Math.round((ctl - atl) * 10) / 10 };
  });
}

// ─── Interpretation ─────────────────────────────────────────────────────────

export interface TsbStatus { label: string; color: string; hint: string }

/** Map TSB (form) to a coaching status. */
export function tsbStatus(tsb: number): TsbStatus {
  // Thresholds for the HR-TRIMP (Bevel-scale) load — TSB now runs ~±15, not ~±35.
  if (tsb >= 7)   return { label: 'Fresh',        color: '#3498db', hint: 'Tapered / well-rested — primed for a race or key session.' };
  if (tsb >= 2)   return { label: 'Neutral+',     color: '#27ae60', hint: 'Slightly fresh — good day for quality.' };
  if (tsb >= -5)  return { label: 'Neutral',      color: '#27ae60', hint: 'Balanced load — steady training is fine.' };
  if (tsb >= -14) return { label: 'Productive',   color: '#f39c12', hint: 'Building fitness under fatigue — keep recovery tight.' };
  return                 { label: 'Overreaching', color: '#e74c3c', hint: 'High fatigue — prioritise easy/rest to absorb the work.' };
}

// ─── Cardio Load (Bevel-style ATL + training-status zones) ────────────────────

export interface CardioLoad {
  load:   number;   // today's ATL (acute load) — the "Cardio Load" value, intra-day
  ctl:    number;   // chronic load (fitness baseline)
  ratio:  number;   // ATL / CTL
  bandLo: number;   // optimal-load floor  ≈ 0.8·CTL
  bandHi: number;   // optimal-load ceiling ≈ 1.3·CTL
  label:  string;   // Building|Detraining|Maintaining|Peaking|Productive|Fatigued|Overtraining
  color:  string;
  hint:   string;
}

// Cardio Status is DIRECTIONAL inside the optimal band (Bevel: "Productive = ratio trending toward
// the upper end"). A flat ATL:CTL ratio at ~1.0 pins you in "Maintaining" forever; but a ratio that's
// CLIMBING back up after a deload is a productive rebuild even below 1.0. So within 0.8–1.3 we split
// by the ratio's recent slope, not by the 1.0 line. (Bevel's own acute/chronic ratio can't be
// reproduced from our daily HR-TRIMP — see the 2026-07-08 fit — so we mirror its INTENT, not its number.)
const TREND_WINDOW = 14;   // days over which "building vs fading" is read
const TREND_EPS    = 0.03; // ratio change beyond ±this = rising / falling; within = flat

/** Change in the ATL:CTL ratio over the trailing `window`, ending at `index` (0 if too little history). */
export function ratioTrend(series: { atl: number; ctl: number }[], index: number, window = TREND_WINDOW): number {
  const j = index - window;
  if (index < 0 || index >= series.length || j < 0) return 0;
  const r = (k: number) => series[k].ctl > 0 ? series[k].atl / series[k].ctl : 0;
  return Math.round((r(index) - r(j)) * 1000) / 1000;
}

/**
 * Training status from the ATL/CTL ratio + its DIRECTION (`trend` = ratioTrend). Bands:
 *   ≥1.5 Overtraining · 1.3–1.5 Fatigued · <0.8 Detraining (or Peaking on a tapered built base).
 * Inside 0.8–1.3: RISING (or already ≥1.0) → Productive (building); FLAT/falling → Maintaining.
 * `trend` omitted → falls back to the old level-only split (≥1.0 = Productive).
 */
export function cardioLoadStatus(atl: number, ctl: number, tsb = 0, trend?: number): CardioLoad {
  const ratio  = ctl > 0 ? atl / ctl : 0;
  const bandLo = Math.round(0.8 * ctl * 10) / 10;
  const bandHi = Math.round(1.3 * ctl * 10) / 10;
  const rising  = trend != null && trend >  TREND_EPS;   // ratio climbing = building fitness
  const falling = trend != null && trend < -TREND_EPS;
  let label: string, color: string, hint: string;
  if (ctl <= 0) {
    label = 'Building'; color = '#7f8c8d'; hint = 'Not enough history yet — keep logging activity to set your baseline.';
  } else if (ratio >= 1.5) {
    label = 'Overtraining'; color = '#e74c3c'; hint = 'Acute load far above your fitness baseline — high overtraining risk; recover now.';
  } else if (ratio >= 1.3) {
    label = 'Fatigued';     color = '#e84393'; hint = 'Recent load is outpacing your fitness — fatigue building; ease off to absorb it.';
  } else if (ratio >= 0.8) {           // optimal band — DIRECTION decides
    if (ratio >= 1.0 || rising) {
      label = 'Productive'; color = '#27ae60';
      hint = (rising && ratio < 1.0)
        ? 'Load climbing back above your baseline — rebuilding fitness (the sweet spot).'
        : 'Load above your baseline — building fitness (the sweet spot).';
    } else {
      label = 'Maintaining'; color = '#2ecc71';
      hint = falling ? 'Load easing within the optimal band — holding fitness.'
                     : 'Load steady around your baseline — holding fitness.';
    }
  } else if (ctl >= 18 && tsb >= 0.30 * ctl) {
    label = 'Peaking';      color = '#3498db'; hint = 'Fresh on a built base — tapered and primed for a race or key session.';
  } else {
    label = 'Detraining';   color = '#f39c12'; hint = 'Load below your baseline — fitness will fade without more stimulus.';
  }
  return {
    load: Math.round(atl * 10) / 10,
    ctl:  Math.round(ctl * 10) / 10,
    ratio: Math.round(ratio * 100) / 100,
    bandLo, bandHi, label, color, hint,
  };
}

/** Short ramp-rate read: weekly CTL change (fitness trend). */
export function ctlRamp(series: DailyLoad[]): number {
  if (series.length < 8) return 0;
  const last = series[series.length - 1].ctl;
  const weekAgo = series[series.length - 8].ctl;
  return Math.round((last - weekAgo) * 10) / 10;
}

// ─── Sleep Bank & dynamic Sleep Needed (Bevel-style) ──────────────────────────

// Sleep Needed = base goal + strain tax + debt repayment + efficiency padding.
// Sleep need = fixed/age goal + cumulative sleep DEBT + EFFICIENCY padding (the standard model);
// the training-strain → extra-need term is kept SMALL (evidence for it is modest).
const STRAIN_SLEEP_MIN  = 0.3;  // minutes of extra sleep need per strain point…
const STRAIN_SLEEP_CAP  = 20;   // …capped (was 0.7 / 45 — too heavy)
const DEBT_RECOVERY_DAYS = 4;   // pay down accumulated debt over ~4 nights
const EFF_PAD_CAP        = 15;   // max minutes added for low sleep efficiency

/** Tonight's dynamic sleep requirement (minutes asleep). priorBank<0 ⇒ debt to repay. */
export function computeSleepNeeded(
  baseGoalMin: number, dayStrain: number, priorBank: number, efficiency: number,
): number {
  const strainAdj = Math.min(STRAIN_SLEEP_CAP, Math.max(0, dayStrain) * STRAIN_SLEEP_MIN);
  const debtAdj   = Math.max(0, -priorBank) / DEBT_RECOVERY_DAYS;
  const eff       = Math.max(0.7, Math.min(1, efficiency || 1));
  const effAdj    = Math.min(EFF_PAD_CAP, baseGoalMin * (1 / eff - 1));
  return Math.round(baseGoalMin + strainAdj + debtAdj + effAdj);
}

export interface SleepBankNight { date: string; asleepMin: number; dayStrain: number; efficiency: number }
export interface SleepBankResult { date: string; needed: number; balance: number; bank: number }

/**
 * Rolling 7-night Sleep Bank (Bevel-style): a recency-weighted balance of
 * (Time Asleep − Sleep Needed). Negative = debt (feeds back into Sleep Needed).
 * Processed chronologically; tonight's Needed uses the PRIOR night's bank, so
 * there's no circular dependency.
 */
export function computeSleepBankSeries(
  nights: SleepBankNight[], baseGoalMin: number,
): SleepBankResult[] {
  // Personal nightly NEED = median asleep over the real nights (≥2h). Measuring the bank against THIS — not a
  // fixed/idealised goal — makes it oscillate around zero (surplus AND debt), matching Bevel, instead of
  // showing chronic debt just because the athlete sleeps less than an 8h ideal. Falls back to baseGoalMin
  // when there are too few nights to form a stable median. (The old model measured vs a high goal AND fed the
  // running debt back into "needed", which biased it ever more negative — that's what pinned it at ~−10h.)
  const real = nights.map(n => n.asleepMin).filter(m => m >= 120).sort((a, b) => a - b);
  const need = real.length >= 5 ? real[Math.floor(real.length / 2)] : baseGoalMin;
  const out: SleepBankResult[] = [];
  for (let i = 0; i < nights.length; i++) {
    // Rolling 7-night SUM of (asleep − need), skipping no-data nights → a ±~3h swing like Bevel's Sleep Bank.
    const window = nights.slice(Math.max(0, i - 6), i + 1).filter(n => n.asleepMin >= 120);
    const bank = Math.round(window.reduce((s, n) => s + (n.asleepMin - need), 0));
    out.push({ date: nights[i].date, needed: need, balance: Math.round(nights[i].asleepMin - need), bank });
  }
  return out;
}

// ─── Daily strain (Bevel-style TRIMP) ─────────────────────────────────────────

const clamp01to100 = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

/**
 * Banister TRIMP integrated over a day's heart-rate samples (24/7).
 *
 * TRIMP = Σ Δt(min) · HRr · 0.64 · e^(1.92·HRr)   (men's coefficients)
 * with HRr = (HR − rest) / (max − rest), the heart-rate reserve fraction.
 *
 * The exponential weight means Zone 4+ efforts contribute disproportionately,
 * while low-HR background movement (walking, housework) adds the passive strain
 * Bevel describes. Gaps between samples are capped so a sparse reading can't
 * represent hours of effort.
 */
// Strain is dominated by EXERCISE, like Bevel (whose KPIs are "Exercise Duration"
// + "Daytime HR"): heart rate DURING a workout counts in full, while background
// (non-workout) heart rate contributes only a small fraction, and only when clearly
// elevated. That's what gives the clear run-day vs rest-day pattern — a no-workout
// day reads low single digits even if your daytime HR was up.
const PASSIVE_FACTOR  = 0.10; // non-workout HR contributes a tenth…
const PASSIVE_MIN_HRR = 0.40; // …and only above ~40% HR reserve

/**
 * Banister TRIMP, exercise-weighted.
 * @param windows workout time spans {s,e} in the SAME ms units as sample `t`
 */
export function computeStrainTrimp(
  samples: { t: number; hr: number }[],
  restHR: number,
  maxHR: number,
  windows: { s: number; e: number }[],
): number {
  if (samples.length < 2 || maxHR <= restHR) return 0;
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const inWorkout = (t: number) => windows.some(w => t >= w.s && t <= w.e);
  const MAX_GAP_MS = 8 * 60_000;
  let trimp = 0;
  for (let i = 1; i < sorted.length; i++) {
    const dt = Math.min(MAX_GAP_MS, sorted[i].t - sorted[i - 1].t);
    if (dt <= 0) continue;
    const hrr = Math.max(0, Math.min(1, (sorted[i].hr - restHR) / (maxHR - restHR)));
    if (hrr <= 0) continue;
    const base = (dt / 60_000) * hrr * 0.64 * Math.exp(1.92 * hrr);
    if (inWorkout(sorted[i].t)) {
      trimp += base;                                   // exercise — full weight
    } else if (hrr >= PASSIVE_MIN_HRR) {
      trimp += base * PASSIVE_FACTOR;                  // background — discounted
    }
  }
  return Math.round(trimp);
}

// Log scale: strain% = A·ln(1 + B·TRIMP). Calibrated against Bevel's own history
// (≈25% 30-day average, Low<34 / Normal 34-67 / High>67): a typical training day
// lands in the 20-35% band, a hard session 50-70%, a no-workout day low single
// digits. Logarithmic → diminishing returns; uncapped. A/B are the tuning knobs.
const STRAIN_LOG_A = 45;
const STRAIN_LOG_B = 0.02;

// ── Zone-weighted strain (Bevel's published model) ────────────────────────────
// Reverse-engineered from Bevel's own breakdown of Geert's walks: a TRIMP-style weighted-HR
// integration. RawLoad = Σ (minutes-in-zone × zone weight); zones are %max-HR; then a near-linear-
// at-low-end log maps RawLoad → 0-100 (diminishing returns up high). Verified exactly: today's
// 38-min walk (28min Z0 + 10min Z1 → RawLoad 12.6) = 12; yesterday's (20·Z0 + 14·Z1 → 16) = 15.
const STRAIN_LOAD_A  = 46;    // log level (grid-fit to Bevel's 8 per-workout strains, avg err 1.3)
const STRAIN_LOAD_B  = 0.022; // curvature (raise → reaches the top faster / more diminishing)
// Target-range floor: Bevel's "minimum active-recovery load" — pinned at ~20 across 14 validated days.
const ACTIVE_RECOVERY_FLOOR = 20;
// Bevel's PASSIVE strain (non-workout) = background HR + STEPS. The HR part is a small saturating
// baseline (caffeine/stress/standing nudge HR above rest → ~strain 1, capped). STEPS are the motion
// term and they GROW the score (a high-step day = moderate passive even with low HR). Verified:
// today 4,775 non-workout steps + low HR → passive 3 (on top of the logged walk's active 12 = 15).
// Bevel's PASSIVE strain is, to a striking degree, just NON-WORKOUT STEPS — linear. Validated
// against 7 of Geert's rest days: Bevel passive ≈ steps/470 (R²≈0.99). The HR "life tax" / daytime-HR
// delta drives Bevel's separate STRESS score, NOT the strain (Jun 22: delta 21 — the highest — but
// strain only 3, matching its low 1,449 steps). So passive = STEP_GAMMA × non-workout steps; the HR
// life-tax term is kept only for the calibration export (informational), not added to strain.
const STRAIN_LIFETAX_K  = 0.00016; // (export only) load per bpm-over-resting × min of non-workout HR
const STRAIN_STEP_GAMMA = 2.2;     // load per 1000 NON-WORKOUT steps (≈ Bevel's steps/470 passive,
                                   // bumped 2.0→2.2 to offset the lower log A so rest days still ≈ 9)

// Zone weights by %max-HR. FITTED (grid-search) to Bevel's 8 per-workout strains — avg error 1.3 pts.
// Bevel is FLAT through Z3 (Z1=Z2=Z3=1: a 25-min-Z3 day scored ~the same per-min as a Z2 day) and only
// escalates at Z4 (threshold). Z0=0.25 so slow/walk minutes still earn (a 54-min Z0 walk → 12, not 5).
// (Z0 is gated to HR > resting by the caller, so sleep/deep-calm = 0.)
function zoneWeight(pctMax: number): number {
  if (pctMax >= 0.9) return 8;    // Z5 Maximum
  if (pctMax >= 0.8) return 5;    // Z4 Threshold (the real escalation point)
  if (pctMax >= 0.7) return 1;    // Z3 Anaerobic
  if (pctMax >= 0.6) return 1;    // Z2 Aerobic
  if (pctMax >= 0.5) return 1;    // Z1 Recovery
  return 0.25;                    // Z0 baseline (slow walking / warmup still counts)
}

// Active workout load (HR-zone weighted) + the HR "life tax" (extra beats over resting on awake
// non-workout minutes). The STEPS/motion term is added separately (caller → passiveLoad).
export function zoneStrainLoad(
  samples: { t: number; hr: number }[], restHR: number, maxHR: number,
  workoutWins: { s: number; e: number }[] = [],
): number {
  if (samples.length < 2 || maxHR <= restHR) return 0;
  const s = [...samples].sort((a, b) => a.t - b.t);
  const inWorkout = (t: number) => workoutWins.some((w) => t >= w.s && t <= w.e);
  const MAX_GAP_MS = 8 * 60_000;
  // Strain's ACTIVE load = workout HR zones only. Passive (non-workout steps) is added by the caller
  // as passiveLoad; the HR life tax is NOT added (it tracks the stress score, not strain).
  return zoneStrainBreakdown(samples, restHR, maxHR, workoutWins).workLoad;
}

// Same computation, but returns the parts + the daytime-HR stats — for calibration export / fitting.
export function zoneStrainBreakdown(
  samples: { t: number; hr: number }[], restHR: number, maxHR: number,
  workoutWins: { s: number; e: number }[] = [],
): { workLoad: number; lifeTax: number; dayHRmean: number; nonWorkoutMin: number } {
  if (samples.length < 2 || maxHR <= restHR) return { workLoad: 0, lifeTax: 0, dayHRmean: 0, nonWorkoutMin: 0 };
  const s = [...samples].sort((a, b) => a.t - b.t);
  const inWorkout = (t: number) => workoutWins.some((w) => t >= w.s && t <= w.e);
  const MAX_GAP_MS = 8 * 60_000;
  let workLoad = 0, lifeTax = 0, hrMinSum = 0, nwMin = 0;
  for (let i = 1; i < s.length; i++) {
    const dt = Math.min(MAX_GAP_MS, s[i].t - s[i - 1].t);
    if (dt <= 0) continue;
    if (s[i].hr <= restHR) continue;   // at/below resting → nothing (sleep, deep calm)
    const dtMin = dt / 60_000;
    if (inWorkout(s[i].t)) {
      workLoad += dtMin * zoneWeight(s[i].hr / maxHR);             // active (zones)
    } else {
      lifeTax  += dtMin * (s[i].hr - restHR) * STRAIN_LIFETAX_K;   // extra beats over resting
      hrMinSum += dtMin * s[i].hr; nwMin += dtMin;                 // daytime (non-workout awake) HR
    }
  }
  return { workLoad, lifeTax, dayHRmean: nwMin > 0 ? hrMinSum / nwMin : 0, nonWorkoutMin: nwMin };
}

// Logarithmic squash: RawLoad → 0-100 strain (diminishing returns near the top, Bevel-style).
export function strainFromLoad(rawLoad: number): number {
  if (rawLoad <= 0) return 0;
  // UNCAPPED (2026-07-20, Geert: "I don't think there's a hard cap at 100 in Bevel either"). The doc on
  // computeDayStrain always said "Uncapped — extreme efforts can exceed 100", but this Math.min(100,…)
  // silently contradicted it. A genuinely huge day SHOULD read >100 rather than flat-lining at the ceiling
  // and losing the information. The strain RING clamps its fill separately (ArcRing: Math.min(1, …)), so
  // the arc stays full while the NUMBER stays truthful.
  return Math.round(STRAIN_LOAD_A * Math.log(1 + STRAIN_LOAD_B * rawLoad));
}

// Estimate a watch workout's strain LOAD (pre-heat) from its blocks + warmup/drills/cooldown,
// using the same zone weights as the strain model (warmup/cooldown ≈ easy Z1, drills ≈ Z2).
// Pair with strainFromLoad((existingRawLoad + load·heatFactor)) to project today's total strain.
const SESSION_ZONE_W: Record<string, number> = { Z0: 0.25, Z1: 1, Z2: 1, Z3: 1.5, Z4: 6, Z5: 8 };
export function estimateWorkoutLoad(w: {
  warmupMeters?: number; drillsMinutes?: number; cooldownMeters?: number;
  blocks?: { repeats?: number; workMinutes?: number; restMinutes?: number; hrZone?: string }[];
}): number {
  // 0 = OPEN goal (athlete-controlled) — estimate it as a nominal ~600 m easy jog so an open warm-up/cool-down
  // still contributes its real load (a literal 0 would under-count the session's strain).
  const nominalM = (m?: number) => (m == null ? 0 : m > 0 ? m : 600);
  let load = ((nominalM(w.warmupMeters) + nominalM(w.cooldownMeters)) / 170) * SESSION_ZONE_W.Z1; // ~170 m/min easy
  load += (w.drillsMinutes ?? 0) * SESSION_ZONE_W.Z2;
  for (const b of w.blocks ?? []) {
    const zw = SESSION_ZONE_W[b.hrZone ?? 'Z2'] ?? 1;
    load += (b.repeats ?? 1) * ((b.workMinutes ?? 0) * zw + (b.restMinutes ?? 0) * SESSION_ZONE_W.Z1);
  }
  return load;
}

// ── Textbook PRESCRIBED Banister TRIMP (HR-kinetics simulation) ────────────────
// The fixed run-MINUTES cap can't tell a dense Z5 set from an easy jog of equal length; zone-weighted
// minutes (estimateWorkoutLoad) can weigh intensity but is DENSITY-BLIND — shorter recovery = fewer minutes
// = LESS load, backwards. TRIMP fixes both, but only as the exponential Banister form integrated over the
// session's HR TRAJECTORY, not a flat per-minute rate. So for a PLANNED session we simulate the HR curve
// (first-order kinetics toward each block's target zone) and integrate the Banister impulse. This natively
// prices the two levers the minutes-cap misses:
//   • intensity — a Z5 rep sits near max HR, and the e^(1.92·HRr) term makes it worth far more/min than Z3.
//   • density   — with short recovery the HR never decays back to the jog zone, so those minutes STILL cost;
//                 tightening the recovery therefore RAISES the session TRIMP even though work minutes are equal.
// Measured counterpart = computeStrainTrimp (the SAME 0.64/1.92 form over real HR samples) — so prescribed
// and realised load live on ONE scale and can be reconciled from the Drive calibration dumps.
// Normalised in HR-reserve space, so a session's TRIMP is defined by its ZONE structure, independent of the
// athlete's own rest/max HR (those only convert zones→bpm for the watch). Only sex enters, via Banister's
// coefficients (men 0.64/1.92, women 0.86/1.67).
const ZONE_HRR: Record<string, number> = { Z0: 0.35, Z1: 0.50, Z2: 0.62, Z3: 0.72, Z4: 0.85, Z5: 0.93 };

/**
 * A between-rep recovery at Z2/Z3 is a FLOAT — genuine running work at a lower effort, not a rest.
 * That distinction is load-bearing: the watch pushes a float as a WORK step (so HealthKit records it as
 * Work) and time-on-feet counts work+drills only, so a float booked as "recovery" would silently vanish
 * from the volume budget. Z0/Z1 = walk/standing/jog rest → genuine recovery, excluded as before.
 * Lives here, next to ZONE_HRR, so coach.ts and planLog.ts share ONE definition of "float".
 */
export const isFloatZone = (zone?: string): boolean => zone === 'Z2' || zone === 'Z3';
const TRIMP_TAU_RISE = 0.75;   // min — HR time-constant climbing toward a harder target (~45 s)
const TRIMP_TAU_FALL = 1.10;   // min — HR decays a touch slower on recovery (~66 s) → density shows up
const TRIMP_DT       = 0.25;   // min — 15 s integration step

function banisterImpulse(hrr: number, sex: 'M' | 'F'): number {
  const h = Math.max(0, Math.min(1, hrr));
  const a = sex === 'F' ? 0.86 : 0.64, b = sex === 'F' ? 1.67 : 1.92;   // Banister's sex coefficients
  return h * a * Math.exp(b * h);                                        // TRIMP per minute at this HR-reserve
}

interface TrimpSeg { hrr: number; min: number }

/** Textbook prescribed Banister TRIMP for a structured session (see block comment above). */
export function prescribedTrimp(w: {
  warmupMeters?: number; drillsMinutes?: number; cooldownMeters?: number;
  blocks?: { repeats?: number; workMinutes?: number; restMinutes?: number; hrZone?: string; recoveryZone?: string }[];
}, sex: 'M' | 'F' = 'M'): number {
  const nominalMin = (m?: number) => (m == null ? 0 : (m > 0 ? m : 600)) / 170;   // open goal → ~600 m easy jog; 170 m/min
  const segs: TrimpSeg[] = [];
  const wu = nominalMin(w.warmupMeters); if (wu > 0) segs.push({ hrr: ZONE_HRR.Z1, min: wu });
  if ((w.drillsMinutes ?? 0) > 0) segs.push({ hrr: ZONE_HRR.Z2, min: w.drillsMinutes! });
  for (const b of w.blocks ?? []) {
    const work = ZONE_HRR[b.hrZone ?? 'Z2'] ?? ZONE_HRR.Z2;
    const reco = ZONE_HRR[b.recoveryZone ?? 'Z1'] ?? ZONE_HRR.Z1;
    for (let r = 0; r < (b.repeats ?? 1); r++) {
      if ((b.workMinutes ?? 0) > 0) segs.push({ hrr: work, min: b.workMinutes! });
      if ((b.restMinutes ?? 0) > 0) segs.push({ hrr: reco, min: b.restMinutes! });
    }
  }
  const cd = nominalMin(w.cooldownMeters); if (cd > 0) segs.push({ hrr: ZONE_HRR.Z1, min: cd });
  if (!segs.length) return 0;

  // First-order HR kinetics toward each segment's target, integrating the Banister impulse per step.
  let hrr = ZONE_HRR.Z0, trimp = 0;
  for (const s of segs) {
    let left = s.min;
    while (left > 1e-6) {
      const dt = Math.min(TRIMP_DT, left);
      const tau = s.hrr > hrr ? TRIMP_TAU_RISE : TRIMP_TAU_FALL;
      hrr += (s.hrr - hrr) * (1 - Math.exp(-dt / tau));
      trimp += banisterImpulse(hrr, sex) * dt;
      left -= dt;
    }
  }
  return Math.round(trimp);
}

// MEASURED single-value Banister TRIMP for a run/segment from an average HR — the realised-load twin of
// prescribedTrimp, used to seed the quality LOAD ramp from what the athlete actually DID. Feed it the
// WORK-segment HR + duration (not the whole-run average) so interval recovery jogs don't dilute the
// intensity — that dilution is exactly what collapsed the old calibrated rates to hard=moderate.
export function singleHrTrimp(minutes: number, avgHR: number, restHR: number, maxHR: number, sex: 'M' | 'F' = 'M'): number {
  if (minutes <= 0 || !avgHR || maxHR <= restHR) return 0;
  const hrr = Math.max(0, Math.min(1, (avgHR - restHR) / (maxHR - restHR)));
  return Math.round(minutes * banisterImpulse(hrr, sex));
}

// Passive strain = NON-WORKOUT steps (workout steps are "active" via HR). Linear, ≈ Bevel's steps/470.
export function stepStrainLoad(nonWorkoutSteps: number): number {
  return STRAIN_STEP_GAMMA * Math.max(0, nonWorkoutSteps) / 1000;
}

export function strainFromTrimp(trimp: number): number {
  if (trimp <= 0) return 0;
  return Math.max(0, Math.round(STRAIN_LOG_A * Math.log(1 + STRAIN_LOG_B * trimp)));
}

// Daily-activity floor (NEAT + unlogged exercise). Our HR-window TRIMP only counts
// LOGGED workouts at full weight, so days of walking / unlogged activity wrongly read
// ~0 — while Bevel scores them via Total Energy / Daytime HR / Steps. We base the
// floor on ACTIVE ENERGY (kcal) — the effort-reflecting part of Bevel's "Total Energy"
// component and a far smoother proxy than raw steps (a low-step but high-burn day still
// scores). Applied as a FLOOR (max with cardio TRIMP), so it lifts rest/unlogged days
// without inflating a logged-workout day whose cardio already dominates.
// Blend two activity signals and take whichever indicates MORE activity, so both
// general-movement days (active energy) and exercise-heavy/low-burn days (Apple
// exercise minutes — e.g. a long easy session) score. Tuned toward Bevel's ~26 mean.
const ENERGY_TRIMP_K = 0.030; // TRIMP per active kcal — fits Bevel's rest/easy-day Cardio Load (07-08 paired export)
const EXMIN_TRIMP    = 0.30;  // TRIMP per Apple exercise minute — 0.60 overshot (bias +4.4 vs Bevel); 0.30 → bias +1.2
export function activityFloorTrimp(activeEnergyKcal: number, exerciseMin: number): number {
  return Math.max(
    Math.max(0, activeEnergyKcal) * ENERGY_TRIMP_K,
    Math.max(0, exerciseMin) * EXMIN_TRIMP,
  );
}

/**
 * Compute today's strain, Bevel-style.
 *
 * REAL strain: log-scaled total daily TRIMP (cardio 24/7 + muscular load).
 *   Uncapped — extreme efforts can exceed 100.
 * SAFE range: the strain it's advisable to take today, from recovery + form (TSB).
 *   High recovery / fresh → higher ceiling; low recovery / deep fatigue → lower.
 *
 * @param cardioTrimp  Banister TRIMP from the day's heart rate
 * @param muscularLoad TRIMP-equivalent from strength/resistance work
 * @param recovery     recovery score 0-100 (0 = unknown)
 * @param tsb          training-stress balance (form)
 */
// Heat inflates the cardiovascular cost of any effort. Tuned for a HEAT-SENSITIVE, heavy-sweating
// runner (Geert): ~+2.5%/°C of apparent temp above 18°C, plus a humidity penalty from 55% RH —
// but humidity only bites once it's WARM enough that evaporative cooling is the bottleneck (at cool
// temps you barely sweat, so high RH does ~nothing). So the humidity term is GATED by temperature:
// 0 at ≤18°C, ramping to full by ≥24°C. Factor is ≥1 (cool/ideal weather = 1.0 = run the full planned
// duration; we never EXTEND past the plan — the volume cap governs length). Capped at 1.6×. Used to
// inflate strain and to scale the prescribed run down (runMinutes ÷ factor). e.g. 24°C/77% → ~1.24,
// but 14°C/85% → 1.0 (perfect — no toning down).
// How hard heat hits THIS athlete: a multiplier on the whole heat penalty above 18°C. 1.0 = the baseline
// physiological model; >1 for the heat-sensitive (Geert), <1 for the heat-tolerant. Default is SENSITIVE.
// Kept as a sync cache (heatStrainFactor is sync + called all over); coach.ts owns the SecureStore setting
// and refreshes this via setHeatSensitivityCache() before building any plan.
export const DEFAULT_HEAT_SENSITIVITY = 1.5;
let heatSensitivity = DEFAULT_HEAT_SENSITIVITY;
export function setHeatSensitivityCache(v: number): void { heatSensitivity = Math.max(0.3, Math.min(3, v)); }
export function heatSensitivitySync(): number { return heatSensitivity; }

export function heatStrainFactor(w?: { tempC?: number; apparentC?: number; humidity?: number } | null): number {
  if (!w) return 1;
  const t = w.apparentC ?? w.tempC;
  if (t == null) return 1;
  const s = heatSensitivity;
  let f = 1 + Math.max(0, t - 18) * 0.025 * s;                       // temperature: ~+2.5%/°C above 18°C, × sensitivity
  const humidGate = Math.max(0, Math.min(1, (t - 18) / 6));          // humidity matters only when warm: 0 ≤18°C → full ≥24°C
  if ((w.humidity ?? 0) > 55) f += ((w.humidity ?? 0) - 55) * 0.004 * s * humidGate;
  return Math.min(1.3 + 0.3 * s, Math.round(f * 100) / 100);         // ceiling scales with sensitivity (1.6 at s=1, 1.75 at 1.5)
}

export function computeDayStrain(
  activeLoad: number,    // zone-weighted active load (zoneStrainLoad) — elevated-HR exertion
  muscularLoad: number,  // strength-training load
  recovery: number,
  tsb: number,
  passiveLoad = 0,       // small passive-movement term (active energy / steps proxy)
  range?: AdvisableRange,
  heatFactor = 1,
  activityLoads?: number[], // PER-ACTIVITY zone loads → additive strain (see below). Omit = legacy behaviour.
): DayStrain {
  // ── AGGREGATION: SUM PER-ACTIVITY STRAINS, don't curve the total (Bevel-verified 2026-07-20) ──────────
  // strainFromLoad is LOGARITHMIC, so applying it to the SUMMED load compresses multi-activity days:
  // ln(a+b) < ln(a)+ln(b). A walk done third in the day lost half its value (15 standalone → 7 marginal),
  // which read as "the walk isn't counted".
  // Bevel's own per-activity breakdown for 19 Jul settles it: Walk 14 + Run 29 + Run 10 = **53, its exact
  // total** → Bevel is ADDITIVE. And our per-activity numbers already match it (15/14, 27/29, 8/10, sum 50
  // vs 53) — so the PARTS were right and only the aggregation was wrong. Curving the total gave 43.
  // PASSIVE is a FLOOR, not an addend: Bevel's total equals the activity sum exactly (no separate passive
  // term on an activity day), while a rest day should still score its non-workout movement.
  const rawLoad = (Math.max(0, activeLoad) + Math.max(0, passiveLoad) + Math.max(0, muscularLoad)) * heatFactor;
  let real: number;
  if (activityLoads && activityLoads.length > 0) {
    const actStrain = activityLoads.reduce((s, L) => s + strainFromLoad(Math.max(0, L) * heatFactor), 0);
    const muscStrain = muscularLoad > 0 ? strainFromLoad(Math.max(0, muscularLoad) * heatFactor) : 0;
    const passiveStrain = passiveLoad > 0 ? strainFromLoad(Math.max(0, passiveLoad) * heatFactor) : 0;
    real = Math.round(Math.max(actStrain + muscStrain, passiveStrain));   // uncapped — see strainFromLoad
  } else {
    real = strainFromLoad(rawLoad);   // legacy: no per-activity breakdown available
  }

  const r = range ?? advisableStrainRange({ recovery: recovery > 0 ? recovery : undefined, tsb });
  return {
    real, safeLow: r.safeLow, safeHigh: r.safeHigh, safeMid: r.safeMid,
    trimp: Math.round(rawLoad),
    cardio: Math.round(activeLoad),
    muscular: Math.round(muscularLoad),
    readiness: r.readiness, drivers: r.drivers, acwr: r.acwr, baseline: r.baseline,
  };
}

// ─── Advisable-strain readiness model ─────────────────────────────────────────
// A real coach doesn't gate today's load on recovery alone — sleep, form (TSB) and
// the acute:chronic workload ratio all matter, plus illness guards (elevated
// respiratory rate, low SpO₂). This blends them into a 0-100 readiness, then maps
// readiness → an advisable strain band. Every input is optional and degrades
// gracefully so it works from day one.

export interface ReadinessInputs {
  recovery?:    number;   // 0-100 recovery score (already encodes HRV + RHR)
  sleepScore?:  number;   // 0-100 last night's sleep score
  sleepDebtMin?: number;  // signed sleep-bank minutes (negative = debt)
  tsb?:         number;   // training-stress balance / "form"
  ctl?:         number;   // chronic load (fitness)
  atl?:         number;   // acute load (fatigue)
  respRate?:    number;   // last night mean respiratory rate
  respBaseline?: number;  // personal respiratory-rate baseline
  spO2?:        number;   // last night mean blood-oxygen %
  yesterdayStrain?: number; // yesterday's strain — enforce quality→recovery alternation
  baseline?:    number;   // 14-day mean total daily strain — Bevel's personal anchor for the range
}

export interface AdvisableRange {
  safeLow:   number;
  safeMid:   number;
  safeHigh:  number;
  readiness: number;    // 0-100 composite
  acwr:      number;    // acute:chronic ratio (0 if unknown)
  drivers:   string[];  // human-readable factors that moved the band
  baseline?: number;    // 14-day strain baseline that anchored the range (if provided)
}

export function advisableStrainRange(i: ReadinessInputs): AdvisableRange {
  const drivers: string[] = [];
  // Anchor on recovery (or a neutral 55 when we don't have it yet).
  let readiness = i.recovery != null && i.recovery > 0 ? i.recovery : 55;

  // Sleep: quality nudges readiness ±; a real sleep debt drags it down.
  if (i.sleepScore != null && i.sleepScore > 0) {
    readiness += (i.sleepScore - 72) * 0.22;
    if (i.sleepScore < 60) drivers.push('poor sleep');
  }
  if (i.sleepDebtMin != null && i.sleepDebtMin < -45) {
    readiness -= Math.min(12, -i.sleepDebtMin / 25);
    drivers.push('sleep debt');
  }

  // Form (TSB): fresh legs → push; deep fatigue → hold back. HR-TRIMP scale → TSB ~±15.
  if (i.tsb != null) {
    readiness += Math.max(-15, Math.min(15, i.tsb)) * 0.6;
    if (i.tsb < -8)      drivers.push('fatigued (low form)');
    else if (i.tsb > 6)  drivers.push('fresh / tapered');
  }

  // Acute:chronic workload ratio — the classic injury-risk sweet spot is 0.8–1.3.
  let acwr = 0;
  if (i.ctl != null && i.ctl > 0 && i.atl != null) {
    acwr = i.atl / i.ctl;
    if (acwr > 1.3) {
      readiness -= Math.min(18, (acwr - 1.3) * 45);
      drivers.push(`high acute load (ACWR ${acwr.toFixed(2)})`);
    } else if (acwr < 0.8 && i.ctl > 5) {
      drivers.push(`room to build (ACWR ${acwr.toFixed(2)})`);
    }
  }

  // Alternation: never two longer/quality days in a row — a hard day yesterday pulls
  // today toward recovery regardless of how good the morning numbers look.
  if (i.yesterdayStrain != null && i.yesterdayStrain >= 55) {
    readiness -= Math.min(20, (i.yesterdayStrain - 50) * 0.6);
    drivers.push('recovery after hard day');
  }

  // Illness / overreach guards — cap hard when the body is flagging stress.
  if (i.respRate != null && i.respBaseline != null && i.respBaseline > 0 &&
      i.respRate > i.respBaseline * 1.12) {
    readiness = Math.min(readiness, 40);
    drivers.push('elevated respiratory rate');
  }
  // Brief overnight dips to ~92–95% are normal for many sleepers; only a real
  // desaturation matters, and even then apply a soft penalty, not a hard cap.
  if (i.spO2 != null && i.spO2 > 0 && i.spO2 < 92) {
    readiness -= Math.min(15, (92 - i.spO2) * 4);
    drivers.push('low SpO₂');
  }

  readiness = clamp01to100(readiness);
  const R = readiness / 100;

  // Bevel-style Target Strain Range: anchor on the athlete's OWN 14-day strain baseline, then let
  // recovery/readiness expand the ceiling. Fitted to Bevel (baseline 23.3 → R .13: 20–40, R .76:
  // 21–55): the floor barely moves with recovery, the ceiling is the lever. Until we have a baseline
  // (early days) fall back to the fixed conservative map.
  let safeLow: number, safeHigh: number, safeMid: number;
  if (i.baseline != null && i.baseline > 0) {
    // Floor = the active-recovery maintenance load, held at ~20 (Bevel pins it there even when the
    // daily baseline dips — validated across 14 days, floor err 0.21). It rises above 20 only when
    // the baseline itself climbs, so it self-scales with fitness. Ceiling is the recovery-driven lever.
    safeLow  = clamp01to100(Math.max(ACTIVE_RECOVERY_FLOOR, i.baseline * (0.83 + 0.10 * R)));
    safeHigh = clamp01to100(i.baseline * (1.59 + 1.03 * R));
    safeMid  = clamp01to100((safeLow + safeHigh) / 2);
  } else {
    // Map readiness → advisable mid-strain — deliberately CONSERVATIVE (injury-first).
    // readiness 100 → ~58, 55 → ~40, 0 → ~18. Ceiling tighter than the floor is loose.
    safeMid          = clamp01to100(18 + readiness * 0.40);
    const spread     = 1 - Math.abs(readiness - 50) / 50;   // 0 at extremes, 1 mid
    const widthUp    = 6 + Math.round(spread * 3);          // 6–9  (tight ceiling)
    const widthDown  = 11 + Math.round(spread * 4);         // 11–15 (easier is fine)
    safeLow  = clamp01to100(safeMid - widthDown);
    safeHigh = clamp01to100(safeMid + widthUp);
  }
  return {
    safeLow, safeHigh, safeMid,
    readiness: Math.round(readiness),
    acwr: Math.round(acwr * 100) / 100,
    drivers,
    baseline: i.baseline != null && i.baseline > 0 ? Math.round(i.baseline * 10) / 10 : undefined,
  };
}

export interface StrainStatus { label: string; color: string }

/** Colour/label for real strain relative to the safe range. */
export function strainStatus(s: DayStrain): StrainStatus {
  if (s.real > s.safeHigh + 8) return { label: 'Overreaching', color: '#e74c3c' };
  if (s.real > s.safeHigh)     return { label: 'Above range',  color: '#f39c12' };
  if (s.real < s.safeLow)      return { label: 'Below range',  color: '#3498db' };
  return                              { label: 'In range',     color: '#27ae60' };
}
