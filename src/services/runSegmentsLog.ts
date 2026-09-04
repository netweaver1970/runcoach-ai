/**
 * Executed run structure, forwarded by the watch at run end (WorkoutEngine.sendExecStructure →
 * runcoach-watchsync `onRunSegments`). Our own watch app records the run as a single HKWorkoutActivity, so the
 * phone can't read the phases back from HealthKit; instead the watch sends the ACTUAL phase boundaries and we
 * match them to the HK workout by start time to rebuild the Warmup/Work/Recovery/Cooldown bands + per-phase
 * stats. Bounded to the last 40 runs; matched with a generous ±2 min tolerance on the start time.
 */
import * as FileSystem from 'expo-file-system';

const FILE = `${FileSystem.documentDirectory}runcoach-run-segments.json`;
const MAX = 40;
const MATCH_TOL_MS = 120_000;   // ±2 min: watch session start ≈ HK workout start, but clocks/rounding differ

export interface ExecPhase { label: string; kind: string; zone: string; startSec: number; endSec: number }
export interface ExecStructure { start: number; dur: number; segs: ExecPhase[] }

let cache: ExecStructure[] | null = null;

async function readAll(): Promise<ExecStructure[]> {
  if (cache) return cache;
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (info.exists) {
      const a = JSON.parse(await FileSystem.readAsStringAsync(FILE));
      if (Array.isArray(a)) { cache = a; return a; }
    }
  } catch { /* ignore */ }
  cache = [];
  return cache;
}

export async function logRunSegments(e: ExecStructure): Promise<void> {
  try {
    const all = await readAll();
    // replace any existing entry for the same run (re-sends), else append
    const idx = all.findIndex(x => Math.abs(x.start - e.start) < MATCH_TOL_MS);
    if (idx >= 0) all[idx] = e; else all.push(e);
    while (all.length > MAX) all.shift();
    cache = all;
    await FileSystem.writeAsStringAsync(FILE, JSON.stringify(all));
  } catch { /* best-effort */ }
}

/** The executed structure for a run whose HK start time is `startMs`, or null if none within tolerance. */
export async function getExecStructure(startMs: number): Promise<ExecStructure | null> {
  const all = await readAll();
  let best: ExecStructure | null = null, bestDelta = MATCH_TOL_MS;
  for (const e of all) {
    const d = Math.abs(e.start - startMs);
    if (d < bestDelta) { bestDelta = d; best = e; }
  }
  return best;
}

/** Warm the cache once at launch (side-effect import), so lookups are fast. */
export async function loadRunSegments(): Promise<void> { await readAll(); }
