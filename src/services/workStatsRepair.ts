/**
 * Repair work stats that are diluted by STATIONARY time.
 *
 * The problem (see the 17/24 Jul 2026 runs): if a run isn't paused — a phone call, a long traffic light,
 * navigation stops in a new area — the standing minutes stay inside the Work segment. `workPace`,
 * `workPower` and `workHR` are duration-weighted averages over that segment, so every one of them is
 * dragged toward zero and the efficiency ratios read as an economy collapse that never happened.
 *
 * The cheap workaround was to DISCARD such runs (cadence gate in runStats.efficiencyTrend). This module
 * does the real thing: re-derive the work stats from the per-second streams counting only the seconds the
 * athlete was actually RUNNING, so the run keeps a correct datapoint instead of vanishing.
 *
 * Needs a per-run detail fetch, so results are cached by uuid exactly like the power curve / decoupling.
 */
import * as FileSystem from 'expo-file-system';
import { fetchWorkoutDetail } from './healthkit';
import { toPerSecond } from './powerCurve';
import type { RunWorkout } from '../types';

// v1: initial stationary-aware recomputation.
const CACHE = `${FileSystem.documentDirectory}work-stats-repair-v1.json`;

// A second counts as RUNNING when DISTANCE is actually accruing. This is the detector, and it is chosen
// from the data rather than by assumption: reconstructing the 17 Jul 2026 run shows the power meter keeps
// reporting ~100 W while the athlete stands still (fitting that model reproduces the observed 198 W and
// EC 0.611 almost exactly, whereas a power-collapses-to-zero model predicts 170 W / EC 0.713). So power
// CANNOT detect a stop — but distance can: standing accrues none. That asymmetry is also precisely why
// these runs read as an economy dip, since EC = speed÷power keeps most of the power but loses the speed.
const MOVING_MS = 0.8;          // m/s — below this (slower than ~20 min/km) nobody is running
// Only used when a run has no pace/distance stream at all, where a low-power test is better than nothing.
const MOVING_W = 25;
// Below this much stationary time the averages are effectively unaffected — keep the original numbers so a
// clean run never churns just because we re-derived it a slightly different way.
const MIN_STATIONARY_PCT = 2;

export interface RepairedWork {
  wPower: number;        // W, mean over running seconds only
  wHR: number;           // bpm, ditto
  wPaceSec: number;      // s/km, from distance covered while running ÷ running time
  movingSec: number;
  stationarySec: number;
  stationaryPct: number; // share of the work window spent stopped
}

async function read(): Promise<Record<string, RepairedWork | null>> {
  try { return JSON.parse(await FileSystem.readAsStringAsync(CACHE)); } catch { return {}; }
}
async function write(c: Record<string, RepairedWork | null>): Promise<void> {
  try { await FileSystem.writeAsStringAsync(CACHE, JSON.stringify(c)); } catch { /* best-effort */ }
}

/** Work windows (ms from workout start) from the structured activities; [] when the run is unstructured. */
function workWindows(activities: { startMs: number; endMs: number; label: string }[] | undefined): { s: number; e: number }[] {
  return (activities ?? [])
    .filter(a => /work/i.test(a.label ?? '') && a.endMs > a.startMs)
    .map(a => ({ s: Math.floor(a.startMs / 1000), e: Math.ceil(a.endMs / 1000) }));
}

/** Recompute the work averages over running-only seconds. Returns null when it can't be done reliably. */
export function repairFromDetail(detail: {
  hr?: { t: number; v: number }[]; power?: { t: number; v: number }[]; pace?: { t: number; v: number }[];
  pauseIntervals?: { s: number; e: number }[]; activities?: { startMs: number; endMs: number; label: string }[];
}): RepairedWork | null {
  const wins = workWindows(detail.activities);
  if (!wins.length) return null;                       // unstructured run — no work window to re-derive
  const pauses = detail.pauseIntervals ?? [];
  const pw = toPerSecond(detail.power ?? [], pauses);
  const hr = toPerSecond(detail.hr ?? [], pauses);
  // pace is s/km → speed in m/s, so one second contributes `speed` metres.
  const speed = toPerSecond((detail.pace ?? []).map(p => ({ t: p.t, v: p.v > 0 ? 1000 / p.v : 0 })), pauses);
  const hasSpeed = speed.some(v => v > 0);   // distance stream present → the reliable stop detector

  let movingSec = 0, stationarySec = 0, sumP = 0, sumH = 0, distM = 0, hrSec = 0;
  for (const w of wins) {
    for (let i = Math.max(0, w.s); i <= w.e; i++) {
      const p = pw[i] ?? 0, v = speed[i] ?? 0, h = hr[i] ?? 0;
      if (i >= Math.max(pw.length, speed.length, hr.length)) break;
      const running = hasSpeed ? v >= MOVING_MS : p >= MOVING_W;
      if (!running) { stationarySec++; continue; }
      movingSec++;
      sumP += p; distM += v;
      if (h > 0) { sumH += h; hrSec++; }
    }
  }
  const total = movingSec + stationarySec;
  if (total < 300 || movingSec < 240 || distM < 200) return null;   // too little to trust
  const stationaryPct = (stationarySec / total) * 100;
  return {
    wPower: Math.round(sumP / movingSec),
    wHR: hrSec > 0 ? Math.round(sumH / hrSec) : 0,
    wPaceSec: Math.round(movingSec / (distM / 1000)),
    movingSec, stationarySec,
    stationaryPct: Math.round(stationaryPct * 10) / 10,
  };
}

/**
 * Repaired work stats per run uuid, cached. Only runs whose work window contained a meaningful amount of
 * stationary time get an entry — everything else maps to null and keeps its original stats.
 */
export async function repairWorkStats(
  runs: RunWorkout[],
  onProgress?: (done: number, total: number) => void,
): Promise<Record<string, RepairedWork | null>> {
  const cache = await read();
  const todo = (runs ?? []).filter(r => r.uuid && !(r.uuid in cache) && (r.duration ?? 0) >= 600);
  let done = 0;
  onProgress?.(0, todo.length);
  for (const r of todo) {
    try {
      const d = await fetchWorkoutDetail(r.date, r.duration);
      const rep = repairFromDetail(d);
      cache[r.uuid] = rep && rep.stationaryPct >= MIN_STATIONARY_PCT ? rep : null;
    } catch { cache[r.uuid] = null; }
    onProgress?.(++done, todo.length);
  }
  if (todo.length) await write(cache);
  return cache;
}

export async function clearWorkStatsRepairCache(): Promise<void> {
  try { await FileSystem.deleteAsync(CACHE, { idempotent: true }); } catch { /* ignore */ }
}
