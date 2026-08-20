import { requireNativeModule } from 'expo-modules-core';

export interface RunCoachWorkoutNative {
  isSupported(): Promise<boolean>;
  authorize(): Promise<string>;
  pushDailyWorkout(specJson: string): Promise<boolean>;
  clearDailyWorkout(name: string): Promise<boolean>;
  /** Expand a HKQuantitySeries (HR/power) into individual measurements. typeId = HKQuantityTypeIdentifier raw string. */
  queryQuantitySeries(typeId: string, startMs: number, endMs: number): Promise<{ t: number; v: number }[]>;
}

// Resolves to null if the native module isn't built into this binary.
let native: RunCoachWorkoutNative | null = null;
try { native = requireNativeModule('RunCoachWorkout'); } catch { native = null; }

export default native;
