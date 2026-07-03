/**
 * Auto day-view updater. When last night's sleep is FULLY determined (Apple Health has
 * delivered the complete overnight data — `snapshot.todayRecovery` becomes non-null),
 * refresh all KPIs, compute today's DETERMINISTIC coach plan (no LLM — the prose is a
 * separate on-request button on the coach page), push the structured workout to the watch,
 * then notify. Two triggers: (1) app foreground/refresh, and (2) a HealthKit observer that
 * wakes the app when new sleep data lands (ending your sleep in Apple Health is the only
 * manual step). Idempotent — prepared once per night. The whole path is profiled (perf.ts).
 */
import * as FileSystem from 'expo-file-system';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import HealthKit from '@kingstinct/react-native-healthkit';
import { HealthSnapshot } from '../types';
import { fetchHealthSnapshot, saveSnapshotCache } from './healthkit';
import { assembleCoachSnapshot, deterministicCoachPlan, saveCachedPlan, CoachPlan } from './coach';
import { trySyncSnapshot } from './cloudSync';
import { pushWorkoutToWatch, clearWatchWorkout } from './watchWorkout';
import { maybeAutoRecalibrate, seedPowerZonesFromRuns } from './zones';
import { maybeAnalyzeLatestRun } from './runAnalysis';
import { saveAutoTimings, AutoTimings } from './perf';

/** Concise one-line structure for the morning notification: "45min Z2 long", "6×3min Z4", or "Rest day". */
function planStructure(plan: CoachPlan | null): string {
  if (!plan || plan.intensity === 'rest' || !plan.workout) return 'Rest day';
  const b = plan.workout.blocks?.[0];
  if (b) {
    const zone = b.hrZone ? ` ${b.hrZone}` : '';
    const lbl  = b.label ? ` ${b.label}` : '';
    return ((b.repeats ?? 1) > 1 ? `${b.repeats}×${b.workMinutes}min${zone}${lbl}` : `${b.workMinutes}min${zone}${lbl}`).trim();
  }
  return `${plan.intensity} ${plan.runMinutes}min`;
}

const AUTO_KEY = 'dayview_auto_v1';
const SLEEP_ID = 'HKCategoryTypeIdentifierSleepAnalysis';
const marker   = (date: string) => `${FileSystem.documentDirectory}dayview-${date}.json`;

export async function isAutoDayViewEnabled(): Promise<boolean> {
  try { const v = await SecureStore.getItemAsync(AUTO_KEY); return v == null ? true : v === '1'; }
  catch { return true; }
}
export async function setAutoDayViewEnabled(on: boolean): Promise<void> {
  try { await SecureStore.setItemAsync(AUTO_KEY, on ? '1' : '0'); } catch { /* ignore */ }
}

export async function dayViewDoneFor(date: string): Promise<boolean> {
  try { return (await FileSystem.getInfoAsync(marker(date))).exists; } catch { return false; }
}

async function readMarker(date: string): Promise<{ recovery?: number; sleepScore?: number } | null> {
  try { return JSON.parse(await FileSystem.readAsStringAsync(marker(date))); } catch { return null; }
}

export interface DayViewResult {
  ran: boolean; date: string; reason?: string; recovery?: number; readiness?: number; headline?: string; structure?: string;
}

/**
 * If last night is fully determined and today's view isn't prepared yet, refresh the
 * cached KPIs, pre-generate + cache the coach plan, and (optionally) notify. Pass a
 * freshly-loaded `snap` to reuse it instead of re-fetching.
 */
export async function maybeRunDayView(opts: {
  months: number; snap?: HealthSnapshot | null; force?: boolean; notify?: boolean;
}): Promise<DayViewResult> {
  // ── Profiling: time the whole automatic path (scan → deterministic plan → watch push) so the debug
  // export shows how long the morning prep takes and where. trigger inferred from how we were called.
  const t0 = Date.now();
  const trigger: AutoTimings['trigger'] = opts.snap ? 'foreground' : opts.force ? 'manual' : 'observer';
  const logTimings = (ran: boolean, extra: Partial<AutoTimings> = {}) =>
    saveAutoTimings({ at: new Date().toISOString(), trigger, ran, totalMs: Date.now() - t0, ...extra }).catch(() => {});

  const scanStart = Date.now();
  const snap = opts.snap ?? await fetchHealthSnapshot({ months: opts.months });
  const scanMs = opts.snap ? 0 : Date.now() - scanStart;
  saveSnapshotCache(snap).catch(() => {}); // fresh KPIs for the home to read instantly

  const today = new Date().toISOString().slice(0, 10);
  const rec = snap.todayRecovery;
  if (!rec || !rec.sleep) {
    logTimings(false, { reason: 'night not yet determined', scanMs });
    return { ran: false, date: today, reason: 'night not yet determined' };
  }

  const date = rec.date ?? today;
  // Don't freeze the plan after the FIRST sleep sync. Regenerate when the night materially changes —
  // the rest of the night syncs from the Watch, or you correct sleep by hand in Apple Health — both
  // move recovery/sleep score. Trivial deltas are ignored so we don't re-prepare needlessly.
  if (!opts.force && await dayViewDoneFor(date)) {
    const prev   = await readMarker(date);
    const recDiff   = Math.abs((prev?.recovery   ?? -99) - rec.recoveryScore);
    const sleepDiff = Math.abs((prev?.sleepScore ?? -99) - (rec.sleepScore ?? 0));
    if (recDiff < 3 && sleepDiff < 5) {
      logTimings(false, { reason: 'already prepared', recovery: rec.recoveryScore, scanMs });
      return { ran: false, date, reason: 'already prepared', recovery: rec.recoveryScore };
    }
  }

  // ── Build today's plan DETERMINISTICALLY — no LLM in the morning path. The prose is generated only
  // on request (button on the daily coach page), so this stays fast + works inside the background budget.
  let headline: string | undefined;
  let readiness: number | undefined;
  let structure = 'Rest day';
  let planOk = false;
  let planMs: number | undefined;
  let pushMs: number | undefined;
  try {
    // If a new run landed, refine the Power & HR Zones file before planning today.
    await maybeAutoRecalibrate().catch(() => {});
    // Seed power zones from the athlete's runs if still unconfigured → the pushed workout carries watt
    // targets even when the background observer fires before the home has ever run. No-op once configured.
    await seedPowerZonesFromRuns(snap.runs).catch(() => {});
    const cs = await assembleCoachSnapshot(snap.strain ?? null, snap.activities);
    const planStart = Date.now();
    const plan = await deterministicCoachPlan(cs);
    planMs = Date.now() - planStart;
    await saveCachedPlan(cs.date, plan);
    headline  = plan.headline;
    readiness = cs.readiness;
    structure = planStructure(plan);
    planOk = true;
    // Push (or clear) the structured "Day" workout on the watch BEFORE we notify — awaited, so the watch
    // is guaranteed up to date by the time the notification lands (only on run days; rest clears it).
    const pushStart = Date.now();
    try { if (plan.workout) await pushWorkoutToWatch(plan.workout); else await clearWatchWorkout(); } catch { /* watch/OS missing */ }
    pushMs = Date.now() - pushStart;
  } catch { /* deterministic plan failed (unexpected) — KPIs still refreshed; no notification */ }

  // Background, non-blocking: push the fresh recovery/strain/load up to the cloud so a coach sees the
  // new numbers as soon as they're known (the morning HealthKit-observer wake also triggers this).
  trySyncSnapshot(snap).catch(() => {});

  try {
    await FileSystem.writeAsStringAsync(marker(date), JSON.stringify({
      date, at: new Date().toISOString(), recovery: rec.recoveryScore, sleepScore: rec.sleepScore, headline,
    }));
  } catch { /* ignore */ }

  // Notify ONLY on a successful plan calc (the whole point of the morning prep), and only after the
  // watch push above resolved. Concise: the two morning KPIs (recovery + readiness — strain is ~0 after
  // sleep) + today's structure (or rest). Tap → the daily coach page.
  if (opts.notify !== false && planOk) {
    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: 'Today’s plan is ready 🟢',
          body: `Recovery ${rec.recoveryScore} · Readiness ${readiness ?? '—'} · ${structure}`,
          data: { screen: 'coach', date, tag: 'dayview' },
        },
        trigger: null, // immediate
      });
    } catch { /* notifications not granted — silent */ }
  }

  logTimings(planOk, { recovery: rec.recoveryScore, readiness, scanMs, planMs, pushMs });
  return { ran: planOk, date, recovery: rec.recoveryScore, readiness, headline, structure };
}

// ─── HealthKit observer: wake on new sleep data ────────────────────────────────
let observerId: string | null = null;

export async function startSleepObserver(months: number): Promise<void> {
  if (observerId) return;
  try {
    await (HealthKit as any).enableBackgroundDelivery?.(SLEEP_ID, 'immediate');
    observerId = (HealthKit as any).subscribeToChanges?.(SLEEP_ID, () => {
      isAutoDayViewEnabled().then(on => { if (on) maybeRunDayView({ months, notify: true }).catch(() => {}); });
    }) ?? null;
  } catch { /* observer unavailable — the foreground trigger still covers it */ }
}

export function stopSleepObserver(): void {
  try { if (observerId) (HealthKit as any).unsubscribeQueries?.([observerId]); } catch { /* ignore */ }
  observerId = null;
}

// ─── HealthKit observer: recalibrate zones + analyse the run when one lands ─────
let workoutObsId: string | null = null;
const WORKOUT_ID = 'HKWorkoutTypeIdentifier';

export async function startWorkoutObserver(months = 3): Promise<void> {
  if (workoutObsId) return;
  try {
    await (HealthKit as any).enableBackgroundDelivery?.(WORKOUT_ID, 'immediate');
    workoutObsId = (HealthKit as any).subscribeToChanges?.(WORKOUT_ID, () => {
      maybeAutoRecalibrate().catch(() => {});
      // Auto-generate a prescription-aware analysis of the just-finished run + notify.
      maybeAnalyzeLatestRun({ months, notify: true }).catch(() => {});
    }) ?? null;
  } catch { /* observer unavailable — the foreground trigger still covers it */ }
}

export function stopWorkoutObserver(): void {
  try { if (workoutObsId) (HealthKit as any).unsubscribeQueries?.([workoutObsId]); } catch { /* ignore */ }
  workoutObsId = null;
}
