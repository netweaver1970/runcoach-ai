import { requireNativeModule } from 'expo-modules-core';

export interface RunCoachWorkoutNative {
  isSupported(): Promise<boolean>;
  authorize(): Promise<string>;
  pushDailyWorkout(specJson: string): Promise<boolean>;
  clearDailyWorkout(name: string): Promise<boolean>;
  /** Expand a HKQuantitySeries (HR/power/distance) into individual measurements. typeId = HKQuantityTypeIdentifier raw string. */
  queryQuantitySeries(typeId: string, startMs: number, endMs: number): Promise<{ t: number; tEnd: number; v: number }[]>;
  /** iOS 27+: the athlete's unified HealthKit heart-rate zones as a JSON string (see the Swift doc). */
  preferredHeartRateZones(): Promise<string>;
  /** iOS 27+: request read auth for the native RMSSD HRV type (its own HK type, distinct from SDNN). false pre-27. */
  authorizeRmssd(): Promise<boolean>;
  /** iOS 27+: native RMSSD samples in [startMs,endMs] → [{t: epochMs, v: ms}]. [] pre-27 / no data. */
  queryRmssd(startMs: number, endMs: number): Promise<{ t: number; v: number }[]>;
}

/** Request read authorization for Apple's native RMSSD HRV (iOS 27+). Safe no-op (false) otherwise. */
export async function authorizeAppleRmssd(): Promise<boolean> {
  if (!native?.authorizeRmssd) return false;
  try { return await native.authorizeRmssd(); } catch { return false; }
}

/** Apple's native RMSSD samples (iOS 27+), ms, in [startMs,endMs]. [] when unavailable — the @kingstinct lib
 *  can't read this iOS-27 type, so this native path is the only way to get it. */
export async function queryAppleRmssd(startMs: number, endMs: number): Promise<{ t: number; v: number }[]> {
  if (!native?.queryRmssd) return [];
  try { return (await native.queryRmssd(startMs, endMs)) ?? []; } catch { return []; }
}

export interface AppleHrZones { source: 'user' | 'system' | 'app' | 'none' | 'unavailable' | 'error'; zones: { index: number; min: number; max: number }[] }

/** iOS 27+ unified HR zones, or null when unavailable (iOS < 27, no native module, or none configured).
 *  min=0 means the first zone's open floor; max=0 means the last zone's open ceiling. */
export async function getAppleHeartRateZones(): Promise<AppleHrZones | null> {
  if (!native?.preferredHeartRateZones) return null;
  try {
    const parsed = JSON.parse(await native.preferredHeartRateZones()) as AppleHrZones;
    return parsed && Array.isArray(parsed.zones) ? parsed : null;
  } catch { return null; }
}

// Resolves to null if the native module isn't built into this binary.
let native: RunCoachWorkoutNative | null = null;
try { native = requireNativeModule('RunCoachWorkout'); } catch { native = null; }

export default native;
