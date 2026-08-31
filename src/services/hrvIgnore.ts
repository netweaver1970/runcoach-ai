/**
 * User-ignored HRV readings. HealthKit won't let us delete the Apple-Watch-written samples, so instead we keep
 * a local list of reading start-times to EXCLUDE from everything the app computes (the readings list, and — via
 * the filters in healthkit.ts — the overnight RMSSD that drives the recovery score & HRV KPIs). Reversible.
 *
 * `isHRVIgnored` is SYNCHRONOUS (the recovery maths calls it inline) → the list is cached in memory. Load it once
 * at launch (side-effect import in app/_layout) so the cache is warm before any recovery computation runs.
 */
import * as FileSystem from 'expo-file-system';

const FILE = `${FileSystem.documentDirectory}runcoach-hrv-ignore.json`;
const TOL = 5000;   // ±5 s: a reading's heartbeat-series start and its SDNN-sample start differ slightly

let ignored: number[] = [];   // start-times (ms) of ignored readings
let version = 0;              // bumps on any change → screens re-fetch dependent KPIs on focus
export function getIgnoreVersion(): number { return version; }

export async function loadHRVIgnore(): Promise<number[]> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (info.exists) {
      const a = JSON.parse(await FileSystem.readAsStringAsync(FILE));
      if (Array.isArray(a)) ignored = a.filter((x): x is number => typeof x === 'number');
    }
  } catch { /* ignore */ }
  return ignored;
}

export function isHRVIgnored(ms: number): boolean {
  for (const t of ignored) if (Math.abs(t - ms) < TOL) return true;
  return false;
}
export function getIgnoredCount(): number { return ignored.length; }

/** Toggle a reading's ignored state; returns the NEW state (true = now ignored). Persists. */
export async function toggleHRVIgnore(ms: number): Promise<boolean> {
  const idx = ignored.findIndex(t => Math.abs(t - ms) < TOL);
  if (idx >= 0) ignored.splice(idx, 1); else ignored.push(ms);
  ignored.sort((a, b) => a - b);
  version++;
  try { await FileSystem.writeAsStringAsync(FILE, JSON.stringify(ignored)); } catch { /* ignore */ }
  return idx < 0;
}
