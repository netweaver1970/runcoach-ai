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
