/**
 * Bevel Calibration Service
 *
 * Two calibration models:
 *
 * 1. SLEEP SCORE (internal) — 5 KPIs: time asleep, deep, REM, efficiency, HR dip
 *    Used to compute our sleep quality score.
 *
 * 2. RECOVERY SCORE (calibrated vs Bevel) — 4 KPIs: HRV, RHR, SpO₂, Sleep Score
 *    Regression finds optimal weights (Σ = 1, all ≥ 0) to minimise MAE vs
 *    Bevel's published Recovery %. Respiratory rate is NOT included — Bevel
 *    shows it as informational only, not as a recovery input.
 */

import * as FileSystem from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { SleepSession } from '../types';

// ─── SecureStore keys ─────────────────────────────────────────────────────────

const SLEEP_GOAL_KEY    = 'personal_sleep_goal_min_v1';
const CUSTOM_WEIGHTS_KEY = 'sleep_weights_custom_v1';

export async function loadPersonalSleepGoal(): Promise<number | null> {
  try { const v = await SecureStore.getItemAsync(SLEEP_GOAL_KEY); return v ? Number(v) : null; }
  catch { return null; }
}
export async function savePersonalSleepGoal(min: number): Promise<void> {
  await SecureStore.setItemAsync(SLEEP_GOAL_KEY, String(Math.round(min)));
}

export async function loadCustomSleepWeights(): Promise<SleepWeights | null> {
  try { const v = await SecureStore.getItemAsync(CUSTOM_WEIGHTS_KEY); return v ? JSON.parse(v) : null; }
  catch { return null; }
}
export async function saveCustomSleepWeights(w: SleepWeights): Promise<void> {
  await SecureStore.setItemAsync(CUSTOM_WEIGHTS_KEY, JSON.stringify(w));
}
export async function clearCustomSleepWeights(): Promise<void> {
  await SecureStore.deleteItemAsync(CUSTOM_WEIGHTS_KEY);
}

// ─── Types ────────────────────────────────────────────────────────────────────

/** Raw HealthKit-derived values for one night (5 Bevel sub-KPIs) */
export interface SleepSubKPIs {
  totalMinutes:  number;   // actual sleep time
  deepMinutes:   number;   // slow-wave / deep
  remMinutes:    number;   // REM
  awakeMinutes:  number;   // awake during night (used for efficiency calc)
  efficiency:    number;   // totalMinutes / (total + awake) * 100
  hrDipPct:      number;   // (daytimeHR - nightHR) / daytimeHR * 100; 0 = unavailable
}

/** Optimal weights found by regression — 5 sub-KPIs, no Continuity */
export interface SleepWeights {
  totalMinutes: number;
  deepMinutes:  number;
  remMinutes:   number;
  efficiency:   number;
  hrDip:        number;
}

/** One day of calibration data */
export interface BevelEntry {
  date:           string;       // YYYY-MM-DD
  sleep:          SleepSubKPIs;
  sleepGoalMin:   number;       // personal goal used for this night's score
  bevelSleep:     number;       // Bevel's published Sleep % (0-100)
  bevelRecovery:  number;       // Bevel's published Recovery % (0-100); 0 = not entered
  ourSleep:       number;       // our computed sleep score at time of entry
  notes?:         string;
}

export interface RegressionResult {
  weights:      SleepWeights;
  mae:          number;
  r2:           number;
  dataPoints:   number;
  perDayErrors: { date: string; ours: number; bevel: number; error: number }[];
}

// ─── Personal sleep goal ──────────────────────────────────────────────────────

/**
 * Compute personal sleep goal from the 90-day median of actual sleep durations.
 * This mirrors Bevel's approach: find the realistic baseline from recent history.
 */
export function computePersonalSleepGoal(sessions: SleepSession[]): number {
  const recent = sessions
    .filter(s => s.totalMinutes >= 120) // ignore very short naps
    .slice(-90)
    .map(s => s.totalMinutes)
    .sort((a, b) => a - b);
  if (recent.length === 0) return 375; // fallback: 6h15m
  const mid = Math.floor(recent.length / 2);
  return recent.length % 2 === 0
    ? Math.round((recent[mid - 1] + recent[mid]) / 2)
    : recent[mid];
}

/**
 * Compute tonight's adjusted sleep goal (simplified Bevel logic):
 *   base goal + debt adjustment + strain adjustment
 *
 * @param baseGoalMin   - personal base goal (90-day median)
 * @param sleepBankMin  - rolling 7-night surplus/deficit vs goal (negative = debt)
 * @param prevDayStrain - yesterday's training strain 0-1 (e.g. 0.05 = 5%)
 * @param lastEfficiency - last night's sleep efficiency % (e.g. 85)
 */
export function computeAdjustedGoal(
  baseGoalMin:    number,
  sleepBankMin:   number,
  prevDayStrain:  number,  // 0-1
  lastEfficiency: number,  // 0-100
): number {
  // Debt: add up to 30 min when ≥ 1h in debt
  const debtAdjust = sleepBankMin < 0
    ? Math.min(30, Math.round((-sleepBankMin / 60) * 15))
    : Math.max(-15, Math.round((sleepBankMin / 60) * -5));

  // Strain: add up to 20 min for high-strain days
  const strainAdjust = Math.round(prevDayStrain * 20);

  // Efficiency: if consistently low efficiency, boost goal slightly
  const effAdjust = lastEfficiency < 80 ? 10 : 0;

  return Math.max(baseGoalMin, baseGoalMin + debtAdjust + strainAdjust + effAdjust);
}

// ─── Normalisation targets ────────────────────────────────────────────────────

/**
 * Targets for each sub-KPI.
 * totalMinutes target comes from the personal sleep goal (dynamic).
 * The rest are expressed as fractions of sleep time or absolute values.
 */
export function getSleepTargets(sleepGoalMin: number) {
  return {
    totalMinutes: sleepGoalMin,         // personal goal (e.g. 375 min)
    deepMinutes:  sleepGoalMin * 0.17,  // ~17% of goal = deep sleep target
    remMinutes:   sleepGoalMin * 0.22,  // ~22% of goal = REM target
    efficiency:   85,                   // 85% efficiency target (realistic, not 90%)
    hrDip:        10,                   // 10% overnight HR dip target
  } as const;
}

/** Convert raw sub-KPI values to 5 normalised scores [0-100] */
export function normaliseKPIs(kpis: SleepSubKPIs, sleepGoalMin: number): number[] {
  const t = getSleepTargets(sleepGoalMin);
  return [
    Math.min(100, (kpis.totalMinutes / t.totalMinutes)  * 100),
    Math.min(100, (kpis.deepMinutes  / t.deepMinutes)   * 100),
    Math.min(100, (kpis.remMinutes   / t.remMinutes)    * 100),
    Math.min(100, (kpis.efficiency   / t.efficiency)    * 100),
    kpis.hrDipPct > 0
      ? Math.min(100, (kpis.hrDipPct / t.hrDip) * 100)
      : 50, // neutral (50/100) when HR data unavailable
  ];
}

/** Apply weights to 5 normalised scores → sleep score 0-100 */
export function applyWeights(scores: number[], w: SleepWeights): number {
  const arr = weightsToArray(w);
  return Math.round(scores.reduce((sum, s, i) => sum + s * arr[i], 0));
}

export function weightsToArray(w: SleepWeights): number[] {
  return [w.totalMinutes, w.deepMinutes, w.remMinutes, w.efficiency, w.hrDip];
}
export function arrayToWeights(arr: number[]): SleepWeights {
  return { totalMinutes: arr[0], deepMinutes: arr[1], remMinutes: arr[2], efficiency: arr[3], hrDip: arr[4] };
}

/** Default starting weights (sum = 1) */
export const DEFAULT_SLEEP_WEIGHTS: SleepWeights = {
  totalMinutes: 0.35,
  deepMinutes:  0.20,
  remMinutes:   0.20,
  efficiency:   0.15,
  hrDip:        0.10,
};

// ─── Storage ──────────────────────────────────────────────────────────────────

const STORAGE_FILE = `${FileSystem.documentDirectory}bevel-calibration.json`;

export async function loadEntries(): Promise<BevelEntry[]> {
  try {
    const info = await FileSystem.getInfoAsync(STORAGE_FILE);
    if (!info.exists) return [];
    return JSON.parse(await FileSystem.readAsStringAsync(STORAGE_FILE)) as BevelEntry[];
  } catch { return []; }
}

export async function saveEntry(entry: BevelEntry): Promise<BevelEntry[]> {
  const all = await loadEntries();
  const idx = all.findIndex(e => e.date === entry.date);
  if (idx >= 0) all[idx] = entry; else all.push(entry);
  all.sort((a, b) => a.date.localeCompare(b.date));
  await FileSystem.writeAsStringAsync(STORAGE_FILE, JSON.stringify(all));
  return all;
}

export async function deleteEntry(date: string): Promise<BevelEntry[]> {
  const all = (await loadEntries()).filter(e => e.date !== date);
  await FileSystem.writeAsStringAsync(STORAGE_FILE, JSON.stringify(all));
  return all;
}

// ─── Regression (projected gradient descent onto the probability simplex) ────

function projectSimplex(w: number[]): number[] {
  const n = w.length;
  const u = [...w].sort((a, b) => b - a);
  let cumSum = 0, rho = 0;
  for (let j = 0; j < n; j++) {
    cumSum += u[j];
    if (u[j] > (cumSum - 1) / (j + 1)) rho = j; else break;
  }
  const theta = (u.slice(0, rho + 1).reduce((s, v) => s + v, 0) - 1) / (rho + 1);
  return w.map(v => Math.max(0, v - theta));
}

function loss(w: number[], X: number[][], y: number[]): number {
  return X.reduce((s, xi, i) => {
    const p = xi.reduce((ps, x, j) => ps + x * w[j], 0);
    return s + (p - y[i]) ** 2;
  }, 0) / X.length;
}

function gradient(w: number[], X: number[][], y: number[]): number[] {
  const n = X.length, k = w.length;
  const g = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    const err = X[i].reduce((s, x, j) => s + x * w[j], 0) - y[i];
    for (let j = 0; j < k; j++) g[j] += (2 / n) * err * X[i][j];
  }
  return g;
}

export function runRegression(entries: BevelEntry[]): RegressionResult | null {
  // Prefer bevelRecovery; fall back to bevelSleep for backward compat
  const valid = entries.filter(e =>
    (e.bevelRecovery > 0 || e.bevelSleep > 0) && e.sleep.totalMinutes > 0
  );
  if (valid.length < 3) return null;

  // Feature matrix: each row = normalised scores for one night (0-1 scale)
  const X: number[][] = valid.map(e =>
    normaliseKPIs(e.sleep, e.sleepGoalMin || 375).map(s => s / 100)
  );
  const y: number[] = valid.map(e =>
    (e.bevelRecovery > 0 ? e.bevelRecovery : e.bevelSleep) / 100
  );

  let w = weightsToArray(DEFAULT_SLEEP_WEIGHTS);
  let lr = 0.1;

  for (let iter = 0; iter < 8000; iter++) {
    const g    = gradient(w, X, y);
    const wNew = projectSimplex(w.map((v, j) => v - lr * g[j]));
    if (loss(wNew, X, y) < loss(w, X, y)) {
      w  = wNew;
      lr = Math.min(0.5, lr * 1.05);
    } else {
      lr *= 0.5;
      if (lr < 1e-9) break;
    }
  }

  // Normalise to sum = 1, round to 3 dp
  const sum = w.reduce((s, v) => s + v, 0) || 1;
  w = w.map(v => Math.round((v / sum) * 1000) / 1000);

  const perDayErrors = valid.map((e, i) => {
    const pred   = Math.round(X[i].reduce((s, x, j) => s + x * w[j], 0) * 100);
    const bevel  = e.bevelRecovery > 0 ? e.bevelRecovery : e.bevelSleep;
    return { date: e.date, ours: pred, bevel, error: pred - bevel };
  });

  const mae = perDayErrors.reduce((s, d) => s + Math.abs(d.error), 0) / perDayErrors.length;

  const yMean = y.reduce((s, v) => s + v, 0) / y.length;
  const ssTot = y.reduce((s, v) => s + (v - yMean) ** 2, 0);
  const ssRes = X.reduce((s, xi, i) => {
    const p = xi.reduce((ps, x, j) => ps + x * w[j], 0);
    return s + (y[i] - p) ** 2;
  }, 0);
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;

  return {
    weights: arrayToWeights(w),
    mae:     Math.round(mae * 10) / 10,
    r2:      Math.round(r2 * 1000) / 1000,
    dataPoints: valid.length,
    perDayErrors,
  };
}

// ─── Recovery score calibration ───────────────────────────────────────────────
// Features: HRV (RMSSD ms), RHR (overnight HR bpm), SpO₂ (%), Sleep Score (0-100)
// Target:   Bevel Recovery % (0-100)
// Respiratory rate is intentionally excluded — Bevel shows it as info only.

const RECOVERY_WEIGHTS_KEY = 'recovery_weights_v1';

export interface RecoveryWeights {
  hrv:             number;  // weight for overnight HRV (RMSSD)
  rhr:             number;  // weight for resting heart rate
  spO2:            number;  // weight for blood oxygen
  sleepScore:      number;  // weight for sleep quality score
  respiratoryRate: number;  // weight for resting respiratory rate
  intercept:       number;  // personal baseline offset (0-1); captures user's abs recovery level
}

export const DEFAULT_RECOVERY_WEIGHTS: RecoveryWeights = {
  hrv:             0.30,
  rhr:             0.25,
  spO2:            0.15,
  sleepScore:      0.20,
  respiratoryRate: 0.10,
  intercept:       0,       // 0 = no personal offset (use weighted features directly)
};

export interface RecoveryRegressionResult {
  weights:      RecoveryWeights;
  mae:          number;
  r2:           number;
  dataPoints:   number;
  perDayErrors: { date: string; ours: number; bevel: number; error: number }[];
}

export async function loadCustomRecoveryWeights(): Promise<RecoveryWeights | null> {
  try { const v = await SecureStore.getItemAsync(RECOVERY_WEIGHTS_KEY); return v ? JSON.parse(v) : null; }
  catch { return null; }
}
export async function saveCustomRecoveryWeights(w: RecoveryWeights): Promise<void> {
  await SecureStore.setItemAsync(RECOVERY_WEIGHTS_KEY, JSON.stringify(w));
}
export async function clearCustomRecoveryWeights(): Promise<void> {
  await SecureStore.deleteItemAsync(RECOVERY_WEIGHTS_KEY);
}

/**
 * Normalise one night's recovery KPIs to 0-1 scale.
 * Bounds are calibrated to cover the healthy adult range:
 *   HRV  20 ms → 0,  75 ms → 1     (most people 25-65 ms during sleep)
 *   RHR  80 bpm → 0, 40 bpm → 1    (lower = better, inverted)
 *   SpO₂ 92 % → 0,  100 % → 1
 *   Sleep 0 → 0,    100 → 1
 *   RR   20 rpm → 0, 12 rpm → 1    (lower = better, inverted; 0 = unavailable → 0.5 neutral)
 */
export function normaliseRecoveryKPIs(
  hrv: number, rhr: number, spO2: number, sleepScore: number, respiratoryRate: number,
): [number, number, number, number, number] {
  return [
    Math.min(1, Math.max(0, (hrv  - 20)  / (75  - 20))),            // HRV
    Math.min(1, Math.max(0, (80   - rhr)  / (80  - 40))),            // RHR (inverted)
    Math.min(1, Math.max(0, (spO2 - 92)  / (100 - 92))),            // SpO₂
    Math.min(1, Math.max(0, sleepScore   / 100)),                    // Sleep score
    respiratoryRate > 0
      ? Math.min(1, Math.max(0, (20 - respiratoryRate) / (20 - 12))) // RR (inverted); 12→1, 20→0
      : 0.5,                                                         // unavailable → neutral
  ];
}

function recoveryWeightsToArray(w: RecoveryWeights): number[] {
  return [w.hrv, w.rhr, w.spO2, w.sleepScore, w.respiratoryRate];
}
function arrayToRecoveryWeights(arr: number[]): RecoveryWeights {
  return { hrv: arr[0], rhr: arr[1], spO2: arr[2], sleepScore: arr[3], respiratoryRate: arr[4], intercept: 0 };
}

/**
 * Run recovery regression: find weights (Σ=1, all ≥ 0) for
 * [HRV, RHR, SpO₂, SleepScore] that best predict Bevel Recovery %.
 *
 * @param entries           - saved calibration entries (must have bevelRecovery > 0)
 * @param bioByDate         - live biometrics keyed by date (from fetchSleepBiometrics)
 * @param sleepScoreByDate  - our sleep score for each night
 */
/**
 * Prediction using a calibrated model: intercept + weighted normalised features.
 *
 * The intercept captures the user's absolute personal recovery baseline — the
 * portion of Bevel's score that can't be explained by the normalised [0-1] features
 * (e.g. Bevel scores a healthy user 91% on an "average" night, but fixed-range
 * normalisation of HRV/RHR/SpO₂ puts those features around 50-60%).
 */
export function predictRecovery(
  hrv: number, rhr: number, spO2: number, sleepScore: number, respiratoryRate: number,
  w: RecoveryWeights,
): number {
  const [nHrv, nRhr, nSpO2, nRr, nSleep] = normaliseRecoveryKPIs(hrv, rhr, spO2, sleepScore, respiratoryRate);
  const raw = w.intercept
    + w.hrv * nHrv + w.rhr * nRhr + w.spO2 * nSpO2
    + w.respiratoryRate * nRr + w.sleepScore * nSleep;
  return Math.round(Math.min(100, Math.max(0, raw * 100)));
}

export function runRecoveryRegression(
  entries: BevelEntry[],
  bioByDate: Record<string, { hrv: number; rhr: number; spO2: number; respiratoryRate: number }>,
  sleepScoreByDate: Record<string, number>,
): RecoveryRegressionResult | null {
  const valid = entries.filter(
    e => e.bevelRecovery > 0 && bioByDate[e.date]?.hrv > 0 && bioByDate[e.date]?.rhr > 0
  );
  if (valid.length < 3) return null;

  // Normalised feature matrix (fixed population ranges)
  const X: number[][] = valid.map(e => {
    const bio = bioByDate[e.date];
    return [...normaliseRecoveryKPIs(bio.hrv, bio.rhr, bio.spO2, sleepScoreByDate[e.date] ?? 50, bio.respiratoryRate ?? 0)];
  });
  const y: number[] = valid.map(e => e.bevelRecovery / 100);

  // ── Alternating optimisation: intercept (analytical) + simplex weights (gradient) ──
  //
  // The model is:  pred = b + Σ wᵢ fᵢ   (b = intercept, wᵢ on the simplex)
  //
  // With few nights the model can overfit perfectly (more parameters than data points).
  // We apply L2 regularisation that pulls weights toward DEFAULT_RECOVERY_WEIGHTS.
  // Strength λ = 1 / (n - 2): very strong with 3 nights, fades as data grows.
  //   n=3 → λ=1.0   n=7 → λ=0.2   n=15 → λ=0.077   n=30+ → λ→0

  const defaultW = recoveryWeightsToArray(DEFAULT_RECOVERY_WEIGHTS);
  const lambda   = Math.max(0.01, 1 / Math.max(1, valid.length - 2));

  function regularisedLoss(w: number[], X: number[][], yb: number[]): number {
    return loss(w, X, yb) + lambda * w.reduce((s, wi, i) => s + (wi - defaultW[i]) ** 2, 0);
  }
  function regularisedGradient(w: number[], X: number[][], yb: number[]): number[] {
    const g = gradient(w, X, yb);
    return g.map((gi, i) => gi + 2 * lambda * (w[i] - defaultW[i]));
  }

  let w  = recoveryWeightsToArray(DEFAULT_RECOVERY_WEIGHTS);
  let b  = 0;
  let lr = 0.1;

  for (let iter = 0; iter < 10000; iter++) {
    // Step 1: analytical optimal intercept given current w
    const xw = X.map(xi => xi.reduce((s, x, j) => s + x * w[j], 0));
    b = y.reduce((s, yi, i) => s + (yi - xw[i]), 0) / y.length;

    // Step 2: regularised gradient step on w, treating (y − b) as effective target
    const yb   = y.map(yi => yi - b);
    const g    = regularisedGradient(w, X, yb);
    const wNew = projectSimplex(w.map((v, j) => v - lr * g[j]));
    if (regularisedLoss(wNew, X, yb) < regularisedLoss(w, X, yb)) {
      w  = wNew;
      lr = Math.min(0.5, lr * 1.05);
    } else {
      lr *= 0.5;
      if (lr < 1e-9) break;
    }
  }

  // Normalise weights to exactly sum to 1, then recompute intercept
  const sum = w.reduce((s, v) => s + v, 0) || 1;
  w = w.map(v => Math.round((v / sum) * 1000) / 1000);
  const xwFinal = X.map(xi => xi.reduce((s, x, j) => s + x * w[j], 0));
  b = Math.round((y.reduce((s, yi, i) => s + (yi - xwFinal[i]), 0) / y.length) * 1000) / 1000;

  const weights: RecoveryWeights = { ...arrayToRecoveryWeights(w), intercept: b };

  const perDayErrors = valid.map((e, i) => {
    const pred = Math.round(Math.min(100, Math.max(0, (b + xwFinal[i]) * 100)));
    return { date: e.date, ours: pred, bevel: e.bevelRecovery, error: pred - e.bevelRecovery };
  });

  const mae   = perDayErrors.reduce((s, d) => s + Math.abs(d.error), 0) / perDayErrors.length;
  const yMean = y.reduce((s, v) => s + v, 0) / y.length;
  const ssTot = y.reduce((s, v) => s + (v - yMean) ** 2, 0);
  const ssRes = y.reduce((s, yi, i) => s + (yi - (b + xwFinal[i])) ** 2, 0);
  const r2    = ssTot === 0 ? 1 : 1 - ssRes / ssTot;

  return {
    weights,
    mae:        Math.round(mae * 10) / 10,
    r2:         Math.round(r2 * 1000) / 1000,
    dataPoints: valid.length,
    perDayErrors,
  };
}
