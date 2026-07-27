/**
 * Power-Duration Curve (mean-maximal power).
 *
 * For each of a set of durations, the BEST average running power the athlete has sustained over any
 * window of that length, taken across their runs. Short durations show neuromuscular/sprint power; long
 * durations converge on aerobic/threshold power — so the curve is the honest, measured answer to "what
 * can you actually hold?", the same question the zone calibration is chasing.
 *
 * Per-run mean-max arrays are tiny (~17 numbers) and cached by run UUID, so only NEW runs are fetched on
 * a repeat visit. The first build fetches each run's 1 Hz power series via fetchWorkoutDetail (expensive),
 * so callers should show progress.
 */
import * as FileSystem from 'expo-file-system';
import { fetchWorkoutDetail } from './healthkit';
import type { RunWorkout } from '../types';

// v2: forward-fill resampling (v1 zero-filled gaps → long-window averages collapsed). Bumping the name
// discards the wrong v1 cache so every run recomputes correctly on first open.
const CACHE = `${FileSystem.documentDirectory}power-curve-cache-v2.json`;
const MAX_HOLD_SEC = 20;   // carry a power reading forward at most this long; a bigger gap = a real break

// Durations sampled along the curve (seconds): dense enough to draw a smooth line, anchored on the
// classic reference points (5s neuromuscular · 1min · 5min VO₂ · 20min threshold · 60min aerobic).
export const PDC_DURATIONS = [5, 10, 15, 30, 45, 60, 90, 120, 180, 240, 300, 420, 600, 900, 1200, 1800, 2700, 3600];
export const PDC_ANCHORS = new Set([5, 60, 300, 1200, 3600]);

export interface PdcPoint { sec: number; watts: number; date: string; }   // best watts for this duration + when
export interface PowerCurve { points: PdcPoint[]; runsUsed: number; cp: number | null; wPrime: number | null; }

type RunResult = Record<number, number>;   // duration(sec) → best avg watts in that run
type Cache = Record<string, RunResult>;    // uuid → per-run mean-max

async function readCache(): Promise<Cache> {
  try { return JSON.parse(await FileSystem.readAsStringAsync(CACHE)) as Cache; } catch { return {}; }
}
async function writeCache(c: Cache): Promise<void> {
  try { await FileSystem.writeAsStringAsync(CACHE, JSON.stringify(c)); } catch { /* best-effort */ }
}

// Power series (t = ms from start, IRREGULARLY sampled — Apple records running power every few seconds,
// and downsampleTo1PerSecond only emits the seconds that HAD a sample) → a continuous 1 Hz watts array via
// ZERO-ORDER HOLD: carry the last reading forward until the next sample. The original code filled the
// in-between seconds with 0, which dragged every long-window average toward zero — a 20-min "best" read
// 104 W for an athlete who holds 250+ (2026-07-27). A gap longer than MAX_HOLD_SEC, or a recorded pause,
// is a genuine break → 0, so pauses can't inflate the curve either.
function toPerSecond(power: { t: number; v: number }[], pauses: { s: number; e: number }[] = []): number[] {
  if (!power.length) return [];
  const last = Math.floor(power[power.length - 1].t / 1000);
  if (last < 0 || last > 36_000) return [];   // >10 h → corrupt, skip
  const at = new Map<number, number>();
  for (const p of power) { const s = Math.floor(p.t / 1000); if (s >= 0 && s <= last) at.set(s, p.v); }
  const arr = new Array(last + 1).fill(0);
  let lastV = 0, lastAt = -Infinity;
  for (let s = 0; s <= last; s++) {
    if (at.has(s)) { lastV = at.get(s)!; lastAt = s; arr[s] = lastV; }
    else if (s - lastAt <= MAX_HOLD_SEC) arr[s] = lastV;   // hold across a normal inter-sample gap
    // else: leave 0 — the recording genuinely stopped here
  }
  for (const p of pauses) {
    const a = Math.max(0, Math.floor(p.s / 1000)), b = Math.min(last, Math.ceil(p.e / 1000));
    for (let s = a; s <= b; s++) arr[s] = 0;
  }
  return arr;
}

// Best average over ANY window of `win` seconds — sliding sum, O(n).
function bestWindowAvg(arr: number[], win: number): number {
  if (arr.length < win || win <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < win; i++) sum += arr[i];
  let best = sum;
  for (let i = win; i < arr.length; i++) { sum += arr[i] - arr[i - win]; if (sum > best) best = sum; }
  return best / win;
}

function runMeanMax(power: { t: number; v: number }[], pauses: { s: number; e: number }[]): RunResult {
  const arr = toPerSecond(power, pauses);
  const out: RunResult = {};
  for (const d of PDC_DURATIONS) { const w = bestWindowAvg(arr, d); if (w > 0) out[d] = Math.round(w); }
  return out;
}

/**
 * 2-point Critical Power estimate from the 3-min and 12-min bests (the standard pair): the work-vs-time
 * line's slope is CP (sustainable power) and its intercept is W′ (finite work above CP). Rough — a full
 * fit would be better — but it turns the curve into the one number that maps to threshold. Null if either
 * anchor is missing.
 */
function estimateCP(byDur: Map<number, number>): { cp: number | null; wPrime: number | null } {
  const p3 = byDur.get(180), p12 = byDur.get(720) ?? byDur.get(600);
  const t3 = 180, t12 = byDur.get(720) ? 720 : 600;
  if (!p3 || !p12 || p3 <= p12) return { cp: null, wPrime: null };
  // work = P·t linear in t: W = W′ + CP·t → CP = (P3·t3 − P12·t12)/(t3 − t12)
  const cp = (p3 * t3 - p12 * t12) / (t3 - t12);
  const wPrime = (p3 - cp) * t3;
  return cp > 0 && cp < 1000 ? { cp: Math.round(cp), wPrime: Math.round(wPrime) } : { cp: null, wPrime: null };
}

/**
 * Build the mean-maximal power curve across the given runs. Uses the per-run cache; fetches only runs not
 * already cached (progress reports uncached-fetch count). Runs without power are skipped (no fetch).
 */
export async function computePowerCurve(
  runs: RunWorkout[],
  onProgress?: (done: number, total: number) => void,
): Promise<PowerCurve> {
  const cache = await readCache();
  // Only runs that plausibly HAVE power (workPower > 0 means the sensor recorded it) — avoids fetching
  // detail for treadmill/no-power runs that would just return empty.
  const withPower = (runs ?? []).filter(r => (r.workPower ?? 0) > 0 && r.duration > 0);
  const toFetch = withPower.filter(r => !cache[r.uuid]);
  let done = 0;
  onProgress?.(0, toFetch.length);
  for (const r of toFetch) {
    try {
      const detail = await fetchWorkoutDetail(r.date, r.duration);
      cache[r.uuid] = runMeanMax(detail.power ?? [], detail.pauseIntervals ?? []);
    } catch { cache[r.uuid] = {}; }   // cache the miss so we don't refetch a bad run every visit
    onProgress?.(++done, toFetch.length);
  }
  if (toFetch.length) await writeCache(cache);

  // Aggregate: best watts per duration across all cached runs that are in THIS run set.
  const uuids = new Set(withPower.map(r => r.uuid));
  const dateByUuid = new Map(withPower.map(r => [r.uuid, r.date]));
  const best = new Map<number, { watts: number; uuid: string }>();
  for (const [uuid, res] of Object.entries(cache)) {
    if (!uuids.has(uuid)) continue;
    for (const [dStr, w] of Object.entries(res)) {
      const d = Number(dStr);
      const cur = best.get(d);
      if (!cur || w > cur.watts) best.set(d, { watts: w, uuid });
    }
  }
  const points: PdcPoint[] = PDC_DURATIONS
    .filter(d => best.has(d))
    .map(d => ({ sec: d, watts: best.get(d)!.watts, date: (dateByUuid.get(best.get(d)!.uuid) ?? '').slice(0, 10) }));

  const byDur = new Map(points.map(p => [p.sec, p.watts]));
  const { cp, wPrime } = estimateCP(byDur);
  return { points, runsUsed: withPower.length, cp, wPrime };
}

export async function clearPowerCurveCache(): Promise<void> {
  try { await FileSystem.deleteAsync(CACHE, { idempotent: true }); } catch { /* ignore */ }
}

/** "5s" · "1:30" · "20:00" · "60:00" — compact axis/label formatter. */
export function fmtDur(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60), s = sec % 60;
  return s === 0 ? `${m}min` : `${m}:${String(s).padStart(2, '0')}`;
}
