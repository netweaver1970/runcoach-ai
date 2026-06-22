/**
 * Bridge to the native WorkoutKit module (modules/runcoach-workout) that pushes a
 * structured "Day" workout to the Apple Watch. Everything degrades gracefully: if the
 * native module isn't in the build or the OS is < iOS 17, the functions no-op.
 */
import { requireNativeModule } from 'expo-modules-core';
import type { WatchWorkout } from './coach';

interface Native {
  isSupported(): Promise<boolean>;
  authorize(): Promise<string>;
  pushDailyWorkout(specJson: string): Promise<boolean>;
  clearDailyWorkout(name: string): Promise<boolean>;
}

/** Short weekday slot name (e.g. "Mon") for a date — workouts are grouped/overwritten by it. */
export const weekdaySlot = (date?: Date): string =>
  (date ?? new Date()).toLocaleDateString('en-US', { weekday: 'short' });

let mod: Native | null = null;
try { mod = requireNativeModule('RunCoachWorkout'); } catch { mod = null; }

export const watchModuleAvailable = (): boolean => mod != null;

export async function watchWorkoutSupported(): Promise<boolean> {
  if (!mod) return false;
  try { return await mod.isSupported(); } catch { return false; }
}

export async function authorizeWatch(): Promise<string> {
  if (!mod) return 'unavailable';
  try { return await mod.authorize(); } catch { return 'error'; }
}

/** Push (overwrite) today's "Day" workout to the watch. Returns false if unavailable. */
export async function pushWorkoutToWatch(w: WatchWorkout): Promise<boolean> {
  if (!mod) return false;
  try {
    if (!(await mod.isSupported())) return false;
    return await mod.pushDailyWorkout(JSON.stringify(w));
  } catch { return false; }
}

/** Remove the named weekday-slot workout (e.g. on a rest day). Defaults to today. */
export async function clearWatchWorkout(name: string = weekdaySlot()): Promise<boolean> {
  if (!mod) return false;
  try { return await mod.clearDailyWorkout(name); } catch { return false; }
}
