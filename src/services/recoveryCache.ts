import * as FileSystem from 'expo-file-system';
import { NightlyHRV } from '../types';

// Incremental nightly-recovery cache (Bevel-style). A past night's RMSSD/overnight-HR never change once
// scored, yet every launch re-fetched 60 days of heartbeat series (the heaviest HealthKit query) and
// recomputed RMSSD for every night. We persist the computed values per COMPLETE night and, on a warm
// cache, only fetch heartbeat + recompute the last ~16 days — reusing the cache for the ≤60-day recovery
// baseline. Samples are NOT cached (only the displayed recent nights, which are always recomputed, keep
// them); the baseline only needs weightedRMSSD.
//
// SAFETY: bump CACHE_VERSION whenever the RMSSD/recovery formula changes → forces a one-time full recompute.

export const RECOVERY_CACHE_VERSION = 1;
const FILE = `${FileSystem.documentDirectory}runcoach-recovery-nights.json`;

export interface CachedNight { date: string; weightedRMSSD: number; overnightHR: number; }
interface RecoveryCacheFile { version: number; nights: CachedNight[]; }

export async function loadRecoveryCache(): Promise<CachedNight[] | null> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (!info.exists) return null;
    const d = JSON.parse(await FileSystem.readAsStringAsync(FILE)) as RecoveryCacheFile;
    if (d.version !== RECOVERY_CACHE_VERSION) return null;   // formula changed → recompute all
    return Array.isArray(d.nights) ? d.nights : null;
  } catch { return null; }
}

/** Persist complete nights (date < today), keeping the last ~95 and stripping samples. */
export async function saveRecoveryCache(nights: NightlyHRV[], todayKey: string): Promise<void> {
  try {
    const complete = nights
      .filter(n => n.date < todayKey && n.weightedRMSSD > 0)
      .map<CachedNight>(n => ({ date: n.date, weightedRMSSD: n.weightedRMSSD, overnightHR: n.overnightHR }))
      .slice(-95);
    await FileSystem.writeAsStringAsync(FILE, JSON.stringify({ version: RECOVERY_CACHE_VERSION, nights: complete }));
  } catch { /* ignore */ }
}
