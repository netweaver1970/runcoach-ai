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
  if ((w.warmupMeters ?? 0) > 0)  out.push('Warmup');
  if ((w.drillsMinutes ?? 0) > 0) out.push('Drills');
  for (const b of w.blocks ?? []) {
    const reps = Math.max(1, b.repeats ?? 1);
    for (let i = 0; i < reps; i++) {
      out.push('Work');
      if ((b.restMinutes ?? 0) > 0 && i < reps - 1) out.push('Recovery');
    }
  }
  if ((w.cooldownMeters ?? 0) > 0) out.push('Cooldown');
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
