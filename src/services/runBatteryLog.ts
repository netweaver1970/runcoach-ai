/**
 * Internal battery profiling. The watch snapshots its battery at run start/end and forwards a drain-per-hour
 * figure over WatchConnectivity (WorkoutEngine.reportBattery → runcoach-watchsync `onRunBattery`). We append
 * each run's figures to a small local log so the trend (%/hr per run) is visible in the debug export — an
 * off-device way to see how much a structured run actually costs the watch battery. Bounded to the last 40 runs.
 */
import * as FileSystem from 'expo-file-system';

const FILE = `${FileSystem.documentDirectory}runcoach-run-battery.json`;
const MAX = 40;

export interface RunBatteryEntry {
  at: string;            // ISO time the run ended
  device: string;        // "watch"
  perHr: number;         // battery % drained per hour
  drainPct: number;      // total % drained over the run (may be negative if it charged)
  durMin: number;        // run duration, minutes
  startPct: number;      // battery % at start
  endPct: number;        // battery % at end
}

export async function logRunBattery(e: Omit<RunBatteryEntry, 'at'>): Promise<void> {
  try {
    const log = await getRunBatteryLog();
    log.push({ at: new Date().toISOString(), ...e });
    while (log.length > MAX) log.shift();
    await FileSystem.writeAsStringAsync(FILE, JSON.stringify(log));
  } catch { /* ignore — profiling is best-effort */ }
}

export async function getRunBatteryLog(): Promise<RunBatteryEntry[]> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (info.exists) {
      const a = JSON.parse(await FileSystem.readAsStringAsync(FILE));
      if (Array.isArray(a)) return a;
    }
  } catch { /* ignore */ }
  return [];
}
