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

// ─── Morning auto-process profiling ───────────────────────────────────────────
// The event-driven morning prep (sleep observer / foreground / manual → scan → deterministic plan →
// watch push → notify). Surfaced in the debug export so we can see how long the automatic path takes
// end-to-end and where the time goes — the same "measure, don't guess" discipline as the scan timings.

const AUTO_FILE = `${FileSystem.documentDirectory}runcoach-auto-timings.json`;

export interface AutoTimings {
  at:      string;                    // ISO time the auto-process finished
  trigger: 'observer' | 'foreground' | 'manual';
  ran:     boolean;                   // did it prepare (vs skipped: night not determined / already done)
  reason?: string;                    // skip reason when ran=false
  recovery?: number;
  readiness?: number;
  scanMs?:   number;                  // HealthKit fetch (0 when a snapshot was passed in)
  planMs?:   number;                  // deterministic coach-plan calc
  pushMs?:   number;                  // structured workout → watch (awaited before notify)
  totalMs:   number;                  // whole auto-process
}

export async function saveAutoTimings(t: AutoTimings): Promise<void> {
  try { await FileSystem.writeAsStringAsync(AUTO_FILE, JSON.stringify(t)); } catch { /* ignore */ }
}

export async function loadAutoTimings(): Promise<AutoTimings | null> {
  try {
    const info = await FileSystem.getInfoAsync(AUTO_FILE);
    if (!info.exists) return null;
    return JSON.parse(await FileSystem.readAsStringAsync(AUTO_FILE)) as AutoTimings;
  } catch { return null; }
}
