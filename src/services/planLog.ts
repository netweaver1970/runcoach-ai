// Deterministic prescribed-structure lookup.
//
// Every plan the coach generates is appended to a per-day log by saveCachedPlan()
// (coach.ts) as { at, plan }. Because the app itself pushes the structured workout to
// the watch, that saved plan IS the exact step sequence HealthKit later records. So we
// can label a run's segments deterministically — no distance/intensity heuristics — by
// flattening the prescription that was live when the run started and matching by order.
//
// Lives in its own module so BOTH coach.ts and the run-detail screen can use it without
// an import cycle (it only `import type`s from coach, which is erased at compile time).
import * as FileSystem from 'expo-file-system';
import type { CoachPlan, WatchWorkout } from './coach';

const planLogFile = (date: string) => `${FileSystem.documentDirectory}coach-plan-log-${date}.json`;
interface PlanLogEntry { at: string; plan: CoachPlan }

// Local YYYY-MM-DD — same key saveCachedPlan/toDateKey use (replicated here so healthkit
// can import this module without the dayView→healthkit import cycle).
export const dateKeyLocal = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// Relabel an already-chronological list of segments/activities IN PLACE from the
// prescribed phase sequence. Applied only when the counts match within ±2 (otherwise the
// run doesn't match the plan and we leave the labels alone); trailing extras → "Open".
export function relabelByPhases<T extends { label: string }>(ordered: T[], phases: string[]): void {
  if (Math.abs(ordered.length - phases.length) > 2) return;
  ordered.forEach((it, i) => { it.label = i < phases.length ? phases[i] : 'Open'; });
}

export async function readPlanLog(date: string): Promise<PlanLogEntry[]> {
  try {
    const f = planLogFile(date);
    const info = await FileSystem.getInfoAsync(f);
    if (!info.exists) return [];
    return JSON.parse(await FileSystem.readAsStringAsync(f)) as PlanLogEntry[];
  } catch { return []; }
}

// Flatten a structured watch workout into the ordered phase labels the watch executes:
// Warmup, Drills, then per block Work / (Recovery between reps only), then Cooldown —
// mirroring exactly how RunCoachWorkoutModule.swift builds the WorkoutKit intervals.
export function flattenPhases(w?: WatchWorkout | null): string[] {
  if (!w) return [];
  const out: string[] = [];
  if (w.warmupMeters != null)     out.push('Warmup');   // 0 = open goal → still a warm-up phase on the watch
  if ((w.drillsMinutes ?? 0) > 0) out.push('Drills');
  for (const b of w.blocks ?? []) {
    const reps = Math.max(1, b.repeats ?? 1);
    for (let i = 0; i < reps; i++) {
      out.push('Work');
      if ((b.restMinutes ?? 0) > 0 && i < reps - 1) out.push('Recovery');
    }
  }
  if (w.cooldownMeters != null) out.push('Cooldown');   // 0 = open goal → still a cool-down phase on the watch
  return out;
}

// The prescribed phase sequence for the plan that was live when a run STARTED
// (the latest plan generated at/before the run start), or null if none was logged.
export async function prescribedPhasesAt(date: string, atISO: string): Promise<string[] | null> {
  const log = await readPlanLog(date);
  if (!log.length) return null;
  const t = new Date(atISO).getTime();
  let chosen = log[0];
  for (const e of log) if (new Date(e.at).getTime() <= t) chosen = e;
  const phases = flattenPhases(chosen.plan.workout);
  return phases.length ? phases : null;
}
