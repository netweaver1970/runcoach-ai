/**
 * Bridge to the native WorkoutKit module (modules/runcoach-workout) that pushes a
 * structured "Day" workout to the Apple Watch. Everything degrades gracefully: if the
 * native module isn't in the build or the OS is < iOS 17, the functions no-op.
 */
import { requireNativeModule } from 'expo-modules-core';
import * as SecureStore from 'expo-secure-store';
import type { WatchWorkout } from './coach';

// Which watch app RECORDS the run when you push a session from the Daily Coach:
//   'apple'    — Apple's Workout app via WorkoutKit (DEFAULT; stable, native visual countdown for timed steps)
//   'runcoach' — our own watch app (voice cues, interval 3-2-1 countdown, off-route speech; still stabilising)
// A route sent from Wayfinder always uses our app (a route implies map guidance); this only governs the
// Daily Coach's "Send to Watch" button.
export type WatchRecorder = 'apple' | 'runcoach';
const RECORDER_KEY = 'watch_recorder_v1';
export async function getWatchRecorder(): Promise<WatchRecorder> {
  try { return (await SecureStore.getItemAsync(RECORDER_KEY)) === 'runcoach' ? 'runcoach' : 'apple'; }
  catch { return 'apple'; }
}
export async function setWatchRecorder(r: WatchRecorder): Promise<void> {
  try { await SecureStore.setItemAsync(RECORDER_KEY, r, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK }); } catch { /* ignore */ }
}

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
