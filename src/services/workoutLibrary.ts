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

/** Render a minute duration, showing sub-minute values as seconds (0.33 → "20s", 1.5 → "1.5min"). */
const dur = (min: number) => (min < 1 ? `${Math.round(min * 60)}s` : `${min}min`);

/** Pure one-line structure summary, e.g. "WU · drills 4m · 6×3min Z4 / 2min Z1 · 25min Z3 · CD". */
export function describeWorkout(w: LibraryWorkout): string {
  const parts: string[] = [];
  if (w.warmupMeters > 0) parts.push(`WU ${w.warmupMeters}m`); else parts.push('WU');
  if (w.drillsMinutes > 0) parts.push(`drills ${w.drillsMinutes}m`);
  for (const b of w.blocks) {
    const work = `${dur(b.workMinutes)} ${b.hrZone ?? 'Z2'}`;
    const rest = b.restMinutes > 0 ? ` / ${dur(b.restMinutes)} ${b.recoveryZone ?? 'Z1'}` : '';
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

/**
 * Starter library — a broad catalogue of standard running sessions across every training zone (common
 * training-science session types, not any copyrighted plan). Open warm-up/cool-down (0 = athlete goal);
 * power is set on-device from each runner's own zones. Rep durations are minute approximations of the
 * classic distance reps (e.g. 400m ≈ 1.5 min). The athlete edits/adds freely from here.
 */
function seed(now = Date.now()): LibraryWorkout[] {
  const blk = (repeats: number, workMinutes: number, restMinutes: number, hrZone: string, recoveryZone?: string, label?: string): WatchWorkoutBlock =>
    ({ repeats, workMinutes, restMinutes, hrZone, ...(recoveryZone ? { recoveryZone } : {}), ...(label ? { label } : {}) });
  const mk = (id: string, name: string, kind: WorkoutKind, drills: number, blocks: WatchWorkoutBlock[]): LibraryWorkout =>
    ({ id, name, kind, warmupMeters: 0, drillsMinutes: drills, cooldownMeters: 0, blocks, updatedAt: now });
  return [
    // ── VO₂max / intervals (Z4–Z5) ──
    mk('seed-vo2-5x3',   'VO₂ 5×3min Z4',        'intervals', 6, [blk(5, 3, 2, 'Z4', 'Z1', 'VO2')]),
    mk('seed-vo2-6x2',   'VO₂ 6×2min Z4',        'intervals', 6, [blk(6, 2, 2, 'Z4', 'Z1', 'VO2')]),
    mk('seed-vo2-4x4',   'VO₂ 4×4min Z4',        'intervals', 6, [blk(4, 4, 3, 'Z4', 'Z2', 'VO2')]),
    mk('seed-400s',      '400m reps 10× (Z5)',   'intervals', 6, [blk(10, 1.5, 1.5, 'Z5', 'Z1', '400m')]),
    mk('seed-800s',      '800m reps 6× (Z4)',    'intervals', 6, [blk(6, 3, 2, 'Z4', 'Z1', '800m')]),
    mk('seed-1k',        '1km reps 5× (Z4)',     'intervals', 6, [blk(5, 3.5, 2, 'Z4', 'Z1', '1km')]),
    mk('seed-mile',      'Mile reps 4× (Z4)',    'intervals', 6, [blk(4, 6, 3, 'Z4', 'Z2', 'mile')]),
    mk('seed-hills-short','Hill reps 10×45s (Z5)','intervals', 6, [blk(10, 0.75, 2, 'Z5', 'Z1', 'hill')]),
    mk('seed-hills-long','Long hills 6×2min (Z4)','intervals', 6, [blk(6, 2, 3, 'Z4', 'Z1', 'hill')]),
    // ── Fartlek ──
    mk('seed-fartlek-1', 'Fartlek 8×1min (Z4)',  'intervals', 4, [blk(8, 1, 2, 'Z4', 'Z2', 'fartlek')]),
    mk('seed-fartlek-2', 'Fartlek 12×1min (Z4)', 'intervals', 4, [blk(12, 1, 1, 'Z4', 'Z2', 'fartlek')]),
    // ── Threshold / tempo (Z3) ──
    mk('seed-tempo-25',  'Tempo 25min Z3',       'tempo',     4, [blk(1, 25, 0, 'Z3', undefined, 'tempo')]),
    mk('seed-tempo-40',  'Tempo 40min Z3',       'tempo',     4, [blk(1, 40, 0, 'Z3', undefined, 'tempo')]),
    mk('seed-cruise',    'Cruise 5×5min Z3',     'tempo',     4, [blk(5, 5, 1, 'Z3', 'Z2', 'cruise')]),
    mk('seed-thr-4x6',   'Threshold 4×6min Z3',  'tempo',     5, [blk(4, 6, 2, 'Z3', 'Z2', 'threshold')]),
    mk('seed-thr-3x10',  'Threshold 3×10min Z3', 'tempo',     5, [blk(3, 10, 2, 'Z3', 'Z2', 'threshold')]),
    mk('seed-thr-2x15',  'Threshold 2×15min Z3', 'tempo',     5, [blk(2, 15, 3, 'Z3', 'Z2', 'threshold')]),
    // ── Race-pace ──
    mk('seed-10k',       '10K pace 5×5min (Z4)', 'intervals', 5, [blk(5, 5, 1.5, 'Z4', 'Z2', '10K pace')]),
    mk('seed-hm',        'HM pace 4×10min (Z3)', 'tempo',     4, [blk(4, 10, 2, 'Z3', 'Z2', 'HM pace')]),
    mk('seed-mp',        'Marathon pace 2×30min','tempo',     4, [blk(2, 30, 5, 'Z3', 'Z2', 'M pace')]),
    // ── Progression / long ──
    mk('seed-long-90',   'Long 90min Z2',        'long',      0, [blk(1, 90, 0, 'Z2', undefined, 'long')]),
    mk('seed-long-120',  'Long 120min Z2',       'long',      0, [blk(1, 120, 0, 'Z2', undefined, 'long')]),
    mk('seed-long-ff',   'Long + fast finish',   'long',      0, [blk(1, 60, 0, 'Z2', undefined, 'easy'), blk(1, 20, 0, 'Z3', undefined, 'finish')]),
    mk('seed-progress',  'Progression 20/20/10', 'long',      0, [blk(1, 20, 0, 'Z2'), blk(1, 20, 0, 'Z3'), blk(1, 10, 0, 'Z4', undefined, 'progression')]),
    // ── Easy / base / recovery / strides ──
    mk('seed-easy-40',   'Easy 40min Z2',        'easy',      0, [blk(1, 40, 0, 'Z2', undefined, 'easy')]),
    mk('seed-easy-60',   'Easy 60min Z2',        'easy',      0, [blk(1, 60, 0, 'Z2', undefined, 'easy')]),
    mk('seed-base-75',   'Base 75min Z2',        'easy',      0, [blk(1, 75, 0, 'Z2', undefined, 'base')]),
    mk('seed-strides',   'Easy 40min + 6 strides','easy',     0, [blk(1, 40, 0, 'Z2', undefined, 'easy'), blk(6, 0.33, 1, 'Z5', 'Z1', 'strides')]),
    mk('seed-rec-30',    'Recovery 30min Z1',    'recovery',  0, [blk(1, 30, 0, 'Z1', undefined, 'recovery')]),
    mk('seed-rec-20',    'Recovery 20min Z1',    'recovery',  0, [blk(1, 20, 0, 'Z1', undefined, 'recovery')]),
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
