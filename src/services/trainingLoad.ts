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
  3:  { name: 'Strength',     factor: 0.6 },  // americanFootball? no — keep generic; rarely used
};

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
  return iso.slice(0, 10);
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
  let prevAtl = 0, prevCtl = 0;

  const fromKey = dayKey(fromDate.toISOString());
  const cursor = new Date(warmStart);
  let first = true;

  while (cursor.getTime() <= end.getTime()) {
    const k = dayKey(cursor.toISOString());
    const load = loadByDay.get(k) ?? 0;

    if (first) {
      // Seed both EWMAs at the first day's load to limit ramp-up artefacts
      atl = load; ctl = load;
      prevAtl = atl; prevCtl = ctl;
      first = false;
    } else {
      prevAtl = atl; prevCtl = ctl;
      atl = atl + LAMBDA_ATL * (load - atl);
      ctl = ctl + LAMBDA_CTL * (load - ctl);
    }

    if (k >= fromKey) {
      out.push({
        date: k,
        load,
        atl: Math.round(atl * 10) / 10,
        ctl: Math.round(ctl * 10) / 10,
        tsb: Math.round((prevCtl - prevAtl) * 10) / 10, // form = yesterday's fitness − fatigue
      });
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return out;
}

// ─── Interpretation ─────────────────────────────────────────────────────────

export interface TsbStatus { label: string; color: string; hint: string }

/** Map TSB (form) to a coaching status. */
export function tsbStatus(tsb: number): TsbStatus {
  if (tsb >= 15)  return { label: 'Fresh',        color: '#3498db', hint: 'Tapered / well-rested — primed for a race or key session.' };
  if (tsb >= 5)   return { label: 'Neutral+',     color: '#27ae60', hint: 'Slightly fresh — good day for quality.' };
  if (tsb >= -10) return { label: 'Neutral',      color: '#27ae60', hint: 'Balanced load — steady training is fine.' };
  if (tsb >= -30) return { label: 'Productive',   color: '#f39c12', hint: 'Building fitness under fatigue — keep recovery tight.' };
  return                 { label: 'Overreaching', color: '#e74c3c', hint: 'High fatigue — prioritise easy/rest to absorb the work.' };
}

/** Short ramp-rate read: weekly CTL change (fitness trend). */
export function ctlRamp(series: DailyLoad[]): number {
  if (series.length < 8) return 0;
  const last = series[series.length - 1].ctl;
  const weekAgo = series[series.length - 8].ctl;
  return Math.round((last - weekAgo) * 10) / 10;
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
// Only heart rate meaningfully above rest counts toward strain. Below this the
// effort is sedentary/very-light (sitting, gentle pottering) and Bevel treats it
// as negligible — without this floor, a whole day of just being awake accumulates
// a large bogus "passive" baseline.
const MIN_HRR = 0.15;

export function computeCardioTrimp(
  samples: { t: number; hr: number }[],
  restHR: number,
  maxHR: number,
): number {
  if (samples.length < 2 || maxHR <= restHR) return 0;
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const MAX_GAP_MS = 8 * 60_000; // cap a single interval at 8 min
  let trimp = 0;
  for (let i = 1; i < sorted.length; i++) {
    const dt = Math.min(MAX_GAP_MS, sorted[i].t - sorted[i - 1].t);
    if (dt <= 0) continue;
    const hr  = sorted[i].hr;
    const hrr = Math.max(0, Math.min(1, (hr - restHR) / (maxHR - restHR)));
    if (hrr < MIN_HRR) continue; // skip sedentary/very-light minutes
    trimp += (dt / 60_000) * hrr * 0.64 * Math.exp(1.92 * hrr);
  }
  return Math.round(trimp);
}

// Log scale: strain% = A·ln(1 + B·TRIMP). With the sedentary floor above, a light
// "active" day reads low single digits (matching Bevel's ~5%) and a hard run day
// reads ~60%. Logarithmic → diminishing returns; uncapped. These two constants
// are the calibration knobs if it drifts from Bevel.
const STRAIN_LOG_A = 65;
const STRAIN_LOG_B = 0.02;

export function strainFromTrimp(trimp: number): number {
  if (trimp <= 0) return 0;
  return Math.max(0, Math.round(STRAIN_LOG_A * Math.log(1 + STRAIN_LOG_B * trimp)));
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
export function computeDayStrain(
  cardioTrimp: number,
  muscularLoad: number,
  recovery: number,
  tsb: number,
): DayStrain {
  const trimp = Math.max(0, cardioTrimp) + Math.max(0, muscularLoad);
  const real  = strainFromTrimp(trimp);

  const tsbAdj  = Math.max(-25, Math.min(25, tsb)) * 0.25;
  const safeMid = recovery > 0 ? clamp01to100(35 + recovery * 0.5 + tsbAdj) : 55;
  const safeLow  = clamp01to100(safeMid - 12);
  const safeHigh = clamp01to100(safeMid + 12);

  return {
    real, safeLow, safeHigh, safeMid,
    trimp: Math.round(trimp),
    cardio: Math.round(cardioTrimp),
    muscular: Math.round(muscularLoad),
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
