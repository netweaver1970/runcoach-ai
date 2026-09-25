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
/** Per-phase stats (d = metres, hr = avg bpm, p = avg W), aligned 1:1 with `segs`. Computed ONCE from the run's
 *  samples and persisted, because a later (cached) scan doesn't re-fetch samples and must rebuild identical segments. */
export interface ExecPhaseStats { d: number; hr: number; p: number }
export interface ExecStructure { start: number; dur: number; segs: ExecPhase[]; stats?: ExecPhaseStats[] }

let cache: ExecStructure[] | null = null;
let loading: Promise<ExecStructure[]> | null = null;

// SINGLE-FLIGHT: a scan calls this for many runs at once; separate loads would each install their own array,
// and stats saved onto one of them could be dropped when another replaced `cache`.
function readAll(): Promise<ExecStructure[]> {
  if (cache) return Promise.resolve(cache);
  if (!loading) loading = (async () => {
    try {
      const info = await FileSystem.getInfoAsync(FILE);
      if (info.exists) {
        const a = JSON.parse(await FileSystem.readAsStringAsync(FILE));
        if (Array.isArray(a)) { cache = a; return a; }
      }
    } catch { /* ignore */ }
    cache = [];
    return cache;
  })();
  return loading;
}

// Writes are SERIALISED and always write the whole current list: a scan can save stats for several runs at once,
// and overlapping writes of the same file could otherwise land out of order.
let writeChain: Promise<void> = Promise.resolve();
function persist(): Promise<void> {
  writeChain = writeChain
    .then(() => FileSystem.writeAsStringAsync(FILE, JSON.stringify(cache ?? [])))
    .catch(() => { /* best-effort */ });
  return writeChain;
}

export async function logRunSegments(e: ExecStructure): Promise<void> {
  try {
    const all = await readAll();
    // replace any existing entry for the same run (re-sends), else append
    const idx = all.findIndex(x => Math.abs(x.start - e.start) < MATCH_TOL_MS);
    if (idx >= 0) all[idx] = e; else all.push(e);
    while (all.length > MAX) all.shift();
    cache = all;
    await persist();
  } catch { /* best-effort */ }
}

/** Persist per-phase stats onto the entry that started at exactly `start`. */
export async function saveExecStats(start: number, stats: ExecPhaseStats[]): Promise<void> {
  try {
    const e = (await readAll()).find(x => x.start === start);
    if (!e || stats.length !== e.segs.length) return;
    e.stats = stats;
    await persist();
  } catch { /* best-effort */ }
}

/** Closest entry within tolerance of `startMs` in an already-loaded list (sync — for the hot time-on-feet path). */
export function matchExec(all: ExecStructure[], startMs: number): ExecStructure | null {
  let best: ExecStructure | null = null, bestDelta = MATCH_TOL_MS;
  for (const e of all) {
    const d = Math.abs(e.start - startMs);
    if (d < bestDelta) { bestDelta = d; best = e; }
  }
  return best;
}

/** The executed structure for a run whose HK start time is `startMs`, or null if none within tolerance. */
export async function getExecStructure(startMs: number): Promise<ExecStructure | null> {
  return matchExec(await readAll(), startMs);
}

export async function getAllExecStructures(): Promise<ExecStructure[]> { return readAll(); }

/** Warm the cache once at launch (side-effect import), so lookups are fast. */
export async function loadRunSegments(): Promise<void> { await readAll(); }
