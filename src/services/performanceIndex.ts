/**
 * General Performance Index (GPI) — one 0–100 daily line that answers "is my overall performance
 * trending up?" by blending three pillars, each measured against a FIXED personal baseline so a genuine
 * multi-month improvement shows as a rising line:
 *
 *   • Recovery  ← HRV (nightly RMSSD, ↑ better) + resting HR (↓ better)   — autonomic health
 *   • Sleep     ← sleep score (↑ better)
 *   • Training  ← 60% fitness (CTL, ↑) + 40% efficiency (EC = speed÷power, ↑)
 *
 * Scale: each sub-metric's trailing 7-day average is z-scored against the athlete's EARLIEST ~8 weeks of
 * data (a fixed anchor), mapped to 50 + 12·z (clamped 10–90). So 50 = your baseline; above 50 = improved.
 *
 * Missing-data proof: every pillar averages over ONLY the days it has data in the trailing 7. A no-workout
 * day doesn't dent it (CTL is defined daily; EC carries between runs). A watch-off night just thins that
 * week's sleep/recovery sample. A fully-absent pillar re-weights to the ones present rather than crashing.
 */

import { fetchOurDailyComponents, fetchTrainingLoadHistory } from './healthkit';
import { RunWorkout } from '../types';

export interface GpiPoint {
  date:     string;                 // YYYY-MM-DD
  gpi:      number | null;          // 0–100 composite (null = no pillar had data)
  recovery: number | null;
  sleep:    number | null;
  training: number | null;
}
export interface GpiResult {
  series:       GpiPoint[];         // one point per calendar day, oldest → newest
  baselineDays: number;            // how many days fed the fixed baseline
  enoughData:   boolean;            // false → baseline is thin, treat the level cautiously
}

interface Raw { date: string; hrv?: number; rhr?: number; sleep?: number; ctl?: number; ec?: number; }

const WIN_DAYS   = 7;    // trailing smoothing window
const BASE_DAYS  = 56;   // earliest window that fixes the personal baseline (~8 weeks)
const Z_GAIN     = 12;   // 50 + Z_GAIN·z → a +1 SD lift reads ~62
const SUB_LO = 10, SUB_HI = 90;

const dkey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** EC (running economy = speed m/min ÷ power W) per run day — the HR-independent efficiency signal. */
function ecByDay(runs: RunWorkout[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of runs ?? []) {
    const paceSec = r.workPace ?? r.pace ?? 0;
    const power   = r.workPower ?? 0;
    if (paceSec > 0 && power > 0) {
      const ec = (60000 / paceSec) / power;
      const k = r.date.slice(0, 10);
      m.set(k, Math.max(m.get(k) ?? 0, ec)); // best effort of the day
    }
  }
  return m;
}

/** Mean + (population) SD of the first `n` present values, SD floored so a flat baseline can't blow up z. */
function baseline(values: (number | undefined)[], n: number): { mean: number; sd: number; count: number } {
  const present = values.filter((v): v is number => v != null && !Number.isNaN(v)).slice(0, n);
  if (present.length === 0) return { mean: 0, sd: 1, count: 0 };
  const mean = present.reduce((s, v) => s + v, 0) / present.length;
  const varc = present.reduce((s, v) => s + (v - mean) ** 2, 0) / present.length;
  const sd   = Math.max(Math.sqrt(varc), Math.abs(mean) * 0.05 || 1);  // floor: 5% of mean, min 1
  return { mean, sd, count: present.length };
}

/** Trailing 7-day average of a per-day value map, over ONLY the days present in the window. */
function trailingAvg(dates: string[], byDay: Map<string, number>, idx: number): number | undefined {
  let sum = 0, n = 0;
  for (let j = idx; j >= 0 && j > idx - WIN_DAYS; j--) {
    const v = byDay.get(dates[j]);
    if (v != null) { sum += v; n++; }
  }
  return n ? sum / n : undefined;
}

const subScore = (avg: number | undefined, b: { mean: number; sd: number }, dir: 1 | -1): number | null =>
  avg == null ? null : clamp(50 + Z_GAIN * dir * ((avg - b.mean) / b.sd), SUB_LO, SUB_HI);

const avgDefined = (xs: (number | null)[]): number | null => {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};

/**
 * Build the GPI series over `months` ending at `toDate`. Pass the athlete's runs (for the EC efficiency
 * sub-signal). Load a long span (e.g. 12 months) once so the fixed baseline is stable across period views.
 */
export async function computePerformanceIndex(months: number, toDate: Date | undefined, runs: RunWorkout[]): Promise<GpiResult> {
  const [comps, load] = await Promise.all([
    fetchOurDailyComponents(months, toDate).catch(() => ({} as Record<string, Record<string, number>>)),
    fetchTrainingLoadHistory(months, toDate).catch(() => []),
  ]);
  const ctlByDay = new Map<string, number>(load.map(l => [l.date, l.ctl]));
  const ec       = ecByDay(runs);

  // Union of all dates we have any signal for, sorted oldest→newest, gap-filled to a continuous daily axis.
  const keys = new Set<string>([...Object.keys(comps), ...ctlByDay.keys(), ...ec.keys()]);
  if (keys.size === 0) return { series: [], baselineDays: 0, enoughData: false };
  const sorted = [...keys].sort();
  const start = new Date(sorted[0] + 'T00:00:00'), end = new Date(sorted[sorted.length - 1] + 'T00:00:00');
  const dates: string[] = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) dates.push(dkey(d));

  // Per-metric per-day maps (raw). HRV=restingHrv, RHR=restingHr, sleep=sleepScore from components.
  const hrvBy = new Map<string, number>(), rhrBy = new Map<string, number>(), slpBy = new Map<string, number>();
  for (const [d, c] of Object.entries(comps)) {
    if (c.restingHrv > 0) hrvBy.set(d, c.restingHrv);
    if (c.restingHr  > 0) rhrBy.set(d, c.restingHr);
    if (c.sleepScore > 0) slpBy.set(d, c.sleepScore);
  }

  // FIXED baseline: earliest BASE_DAYS present values of each metric (chronological).
  const firstVals = (by: Map<string, number>) => dates.map(d => by.get(d));
  const bHrv = baseline(firstVals(hrvBy), BASE_DAYS);
  const bRhr = baseline(firstVals(rhrBy), BASE_DAYS);
  const bSlp = baseline(firstVals(slpBy), BASE_DAYS);
  const bCtl = baseline(firstVals(ctlByDay), BASE_DAYS);
  const bEc  = baseline(firstVals(ec), BASE_DAYS);
  const baselineDays = Math.max(bHrv.count, bRhr.count, bSlp.count, bCtl.count);

  const series: GpiPoint[] = dates.map((date, i) => {
    const recovery = avgDefined([subScore(trailingAvg(dates, hrvBy, i), bHrv, 1), subScore(trailingAvg(dates, rhrBy, i), bRhr, -1)]);
    const sleep    = subScore(trailingAvg(dates, slpBy, i), bSlp, 1);
    const ctlS     = subScore(trailingAvg(dates, ctlByDay, i), bCtl, 1);
    const ecS      = bEc.count > 0 ? subScore(trailingAvg(dates, ec, i), bEc, 1) : null;
    const training = ctlS == null ? ecS : ecS == null ? ctlS : 0.6 * ctlS + 0.4 * ecS;
    const gpi      = avgDefined([recovery, sleep, training]);
    const r1 = (v: number | null) => v == null ? null : Math.round(v * 10) / 10;
    return { date, gpi: r1(gpi), recovery: r1(recovery), sleep: r1(sleep), training: r1(training) };
  });

  return { series, baselineDays, enoughData: baselineDays >= 21 };
}
