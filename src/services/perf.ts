import * as FileSystem from 'expo-file-system';

// Startup/scan profiling: the last health-scan's phase timings, persisted so the debug export can surface
// them (and we can tune the HealthKit lookback windows from real numbers instead of guessing).

const FILE = `${FileSystem.documentDirectory}runcoach-scan-timings.json`;

export interface ScanTimings {
  at:      string;                         // ISO time the scan finished
  light:   boolean;                        // light (incremental) vs full scan
  months:  number;                         // runs-history window
  runs:    number;                         // runs returned
  totalMs: number;                         // whole scan
  steps:   { step: string; ms: number }[]; // cumulative ms at each onProgress step (deltas = phase cost)
}

export async function saveScanTimings(t: ScanTimings): Promise<void> {
  try { await FileSystem.writeAsStringAsync(FILE, JSON.stringify(t)); } catch { /* ignore */ }
}

export async function loadScanTimings(): Promise<ScanTimings | null> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (!info.exists) return null;
    return JSON.parse(await FileSystem.readAsStringAsync(FILE)) as ScanTimings;
  } catch { return null; }
}
