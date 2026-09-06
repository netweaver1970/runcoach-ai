/**
 * Per-run WORK-TIME override. Time-on-feet is work-accounting (warm-up/recovery/cool-down excluded), computed
 * from a run's recorded segments. When a run is badly structured — segments mislabelled, structure not recorded,
 * a long easy jog logged as one "Work" block — that counted work time is wrong and skews the rolling volume cap,
 * the budget, and the schedule. This lets the runner hand-correct the counted work MINUTES for a single run;
 * fetchDailyWorkHistory uses the override in place of the segment-derived value (distance is left untouched).
 * Keyed by the run's HK workout uuid. Absolute value in minutes; clearing reverts to the automatic figure.
 */
import * as FileSystem from 'expo-file-system';

const FILE = `${FileSystem.documentDirectory}runcoach-run-work-override.json`;

let cache: Record<string, number> | null = null;   // uuid → work MINUTES

export async function loadRunWorkOverrides(): Promise<Record<string, number>> {
  if (cache) return cache;
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (info.exists) {
      const o = JSON.parse(await FileSystem.readAsStringAsync(FILE));
      if (o && typeof o === 'object') { cache = o as Record<string, number>; return cache; }
    }
  } catch { /* ignore */ }
  cache = {};
  return cache;
}

export async function getRunWorkOverride(uuid: string): Promise<number | undefined> {
  return (await loadRunWorkOverrides())[uuid];
}

/** Set the counted work minutes for a run (absolute). Pass null / a non-finite value to clear (revert to auto). */
export async function setRunWorkOverride(uuid: string, minutes: number | null): Promise<void> {
  const o = await loadRunWorkOverrides();
  if (minutes == null || !Number.isFinite(minutes) || minutes < 0) delete o[uuid];
  else o[uuid] = Math.round(minutes);
  cache = o;
  try { await FileSystem.writeAsStringAsync(FILE, JSON.stringify(o)); } catch { /* ignore */ }
}
