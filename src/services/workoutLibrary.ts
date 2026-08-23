/**
 * Workout library — a reusable database of named, structured workouts (the TP-style "workout builder /
 * library" the app was missing, gap 5). A workout is the same shape the watch + coach prescriptions already
 * use (`WatchWorkoutBlock`), so a library entry drops straight into: the athlete's day (self-coached), a
 * push to the Apple Watch, or a human coach's prescription (see coach-athlete.tsx).
 *
 * Local-first: stored in `runcoach-workout-library.json` (backed up). `describeWorkout` is a pure summary
 * (unit-testable); `WatchWorkoutBlock` is a type-only import so this module stays decoupled from coach.ts.
 */
import * as FileSystem from 'expo-file-system';
import type { WatchWorkoutBlock } from './coach';

export type WorkoutKind = 'intervals' | 'tempo' | 'long' | 'easy' | 'recovery' | 'custom';
export const WORKOUT_KINDS: WorkoutKind[] = ['intervals', 'tempo', 'long', 'easy', 'recovery', 'custom'];
export const KIND_COLOR: Record<WorkoutKind, string> = {
  intervals: '#e74c3c', tempo: '#e67e22', long: '#2f6fed', easy: '#27ae60', recovery: '#16a085', custom: '#8e44ad',
};

export interface LibraryWorkout {
  id: string;
  name: string;
  kind: WorkoutKind;
  warmupMeters: number;
  drillsMinutes: number;
  cooldownMeters: number;
  blocks: WatchWorkoutBlock[];
  notes?: string;
  updatedAt: number;
}

export const LIBRARY_FILE = `${FileSystem.documentDirectory}runcoach-workout-library.json`;

/** Estimated moving minutes across the blocks (work + rest), warm-up/cool-down excluded (they're open goals). */
export function workoutMinutes(w: LibraryWorkout): number {
  return Math.round(w.blocks.reduce((a, b) => a + (b.workMinutes + (b.restMinutes || 0)) * Math.max(1, b.repeats), 0) + (w.drillsMinutes || 0));
}

/** Pure one-line structure summary, e.g. "WU · drills 4m · 6×3min Z4 / 2min Z1 · 25min Z3 · CD". */
export function describeWorkout(w: LibraryWorkout): string {
  const parts: string[] = [];
  if (w.warmupMeters > 0) parts.push(`WU ${w.warmupMeters}m`); else parts.push('WU');
  if (w.drillsMinutes > 0) parts.push(`drills ${w.drillsMinutes}m`);
  for (const b of w.blocks) {
    const work = `${b.workMinutes}min ${b.hrZone ?? 'Z2'}`;
    const rest = b.restMinutes > 0 ? ` / ${b.restMinutes}min ${b.recoveryZone ?? 'Z1'}` : '';
    parts.push(b.repeats > 1 ? `${b.repeats}×${work}${rest}` : `${work}${rest}`);
  }
  parts.push(w.cooldownMeters > 0 ? `CD ${w.cooldownMeters}m` : 'CD');
  return parts.join(' · ');
}

/** Build the workout blob (WatchWorkout-shaped) a coach prescription / watch push consumes, for a slot. */
export function toWorkoutBlob(w: LibraryWorkout, slotName: string) {
  return {
    name: slotName,
    warmupMeters: w.warmupMeters,
    drillsMinutes: w.drillsMinutes,
    cooldownMeters: w.cooldownMeters,
    blocks: w.blocks.map(b => ({ ...b })),
  };
}

let _nextSeq = 0;
export function newWorkout(now = Date.now()): LibraryWorkout {
  return {
    id: `w${now}_${_nextSeq++}`, name: 'New workout', kind: 'intervals',
    warmupMeters: 0, drillsMinutes: 4, cooldownMeters: 0,
    blocks: [{ repeats: 5, workMinutes: 3, restMinutes: 2, hrZone: 'Z4', recoveryZone: 'Z1', label: 'work' }],
    updatedAt: now,
  };
}

/** Starter library — a few staple sessions (open warm-up/cool-down; power is set on-device from the athlete's zones). */
function seed(now = Date.now()): LibraryWorkout[] {
  const mk = (id: string, name: string, kind: WorkoutKind, drills: number, blocks: WatchWorkoutBlock[]): LibraryWorkout =>
    ({ id, name, kind, warmupMeters: 0, drillsMinutes: drills, cooldownMeters: 0, blocks, updatedAt: now });
  return [
    mk('seed-vo2',  'VO₂ 5×3min Z4',      'intervals', 6, [{ repeats: 5, workMinutes: 3, restMinutes: 2, hrZone: 'Z4', recoveryZone: 'Z1', label: 'VO2' }]),
    mk('seed-thr',  'Threshold 4×6min Z3', 'tempo',    5, [{ repeats: 4, workMinutes: 6, restMinutes: 2, hrZone: 'Z3', recoveryZone: 'Z2', label: 'threshold' }]),
    mk('seed-tmp',  'Tempo 25min Z3',      'tempo',    4, [{ repeats: 1, workMinutes: 25, restMinutes: 0, hrZone: 'Z3', label: 'tempo' }]),
    mk('seed-long', 'Long 90min Z2',       'long',     0, [{ repeats: 1, workMinutes: 90, restMinutes: 0, hrZone: 'Z2', label: 'long' }]),
    mk('seed-rec',  'Recovery 30min Z1',   'recovery', 0, [{ repeats: 1, workMinutes: 30, restMinutes: 0, hrZone: 'Z1', label: 'recovery' }]),
  ];
}

export async function loadLibrary(): Promise<LibraryWorkout[]> {
  try {
    const info = await FileSystem.getInfoAsync(LIBRARY_FILE);
    if (!info.exists) { const s = seed(); await saveLibrary(s); return s; }
    const parsed = JSON.parse(await FileSystem.readAsStringAsync(LIBRARY_FILE));
    if (Array.isArray(parsed)) return parsed as LibraryWorkout[];
    return seed();
  } catch { return seed(); }
}

export async function saveLibrary(list: LibraryWorkout[]): Promise<void> {
  try { await FileSystem.writeAsStringAsync(LIBRARY_FILE, JSON.stringify(list)); } catch { /* ignore */ }
}
