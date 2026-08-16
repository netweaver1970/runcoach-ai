// Durable run history for the Statistics screen.
//
// The normal HealthSnapshot only keeps ~3 months of runs (a deliberate startup-speed cap), and every
// app launch's light refresh OVERWRITES it back to that window. So the efficiency/decoupling/intensity
// charts kept "reverting" to ~3 months after a deep-load. This cache is the union of every run the stats
// screen has ever seen, persisted separately so a startup scan can't shrink it. The screen merges fresh
// snapshot runs over this cache (snapshot wins per-uuid → picks up re-processed work stats), then writes
// the union back, so history only ever grows.
import * as FileSystem from 'expo-file-system';
import type { RunWorkout } from '../types';

const FILE = `${FileSystem.documentDirectory}stats-runs-cache.json`;

export async function loadStatsRuns(): Promise<RunWorkout[]> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (!info.exists) return [];
    const v = JSON.parse(await FileSystem.readAsStringAsync(FILE));
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

export async function saveStatsRuns(runs: RunWorkout[]): Promise<void> {
  try { await FileSystem.writeAsStringAsync(FILE, JSON.stringify(runs ?? [])); } catch { /* best-effort */ }
}

/** Merge fresh snapshot runs over the persisted history: snapshot wins per uuid (freshest work stats),
 *  older cached runs beyond the snapshot window are kept. Result is newest-first. */
export function mergeRuns(snapRuns: RunWorkout[], cached: RunWorkout[]): RunWorkout[] {
  const seen = new Set((snapRuns ?? []).map(r => r.uuid));
  const merged = [...(snapRuns ?? []), ...(cached ?? []).filter(r => r.uuid && !seen.has(r.uuid))];
  return merged.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}
