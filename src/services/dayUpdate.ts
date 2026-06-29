/**
 * Auto day-view updater. When last night's sleep is FULLY determined (Apple Health has
 * delivered the complete overnight data — `snapshot.todayRecovery` becomes non-null),
 * refresh all KPIs and pre-generate the AI day view (coach plan) so it's ready, then
 * notify. Two triggers: (1) app foreground/refresh, and (2) a HealthKit observer that
 * wakes the app when new sleep data lands. Idempotent — prepared once per night.
 */
import * as FileSystem from 'expo-file-system';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import HealthKit from '@kingstinct/react-native-healthkit';
import { HealthSnapshot } from '../types';
import { fetchHealthSnapshot, saveSnapshotCache } from './healthkit';
import { assembleCoachSnapshot, getCoachPlan, saveCachedPlan } from './coach';
import { trySyncSnapshot } from './cloudSync';
import { pushWorkoutToWatch, clearWatchWorkout } from './watchWorkout';
import { maybeAutoRecalibrate } from './zones';
import { maybeAnalyzeLatestRun } from './runAnalysis';

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
  ran: boolean; date: string; reason?: string; recovery?: number; headline?: string;
}

/**
 * If last night is fully determined and today's view isn't prepared yet, refresh the
 * cached KPIs, pre-generate + cache the coach plan, and (optionally) notify. Pass a
 * freshly-loaded `snap` to reuse it instead of re-fetching.
 */
export async function maybeRunDayView(opts: {
  months: number; snap?: HealthSnapshot | null; force?: boolean; notify?: boolean;
}): Promise<DayViewResult> {
  const snap = opts.snap ?? await fetchHealthSnapshot({ months: opts.months });
  saveSnapshotCache(snap).catch(() => {}); // fresh KPIs for the home to read instantly

  const today = new Date().toISOString().slice(0, 10);
  const rec = snap.todayRecovery;
  if (!rec || !rec.sleep) return { ran: false, date: today, reason: 'night not yet determined' };

  const date = rec.date ?? today;
  // Don't freeze the plan after the FIRST sleep sync. Regenerate when the night materially changes —
  // the rest of the night syncs from the Watch, or you correct sleep by hand in Apple Health — both
  // move recovery/sleep score. Trivial deltas are ignored so we don't re-hit the LLM needlessly.
  if (!opts.force && await dayViewDoneFor(date)) {
    const prev   = await readMarker(date);
    const recDiff   = Math.abs((prev?.recovery   ?? -99) - rec.recoveryScore);
    const sleepDiff = Math.abs((prev?.sleepScore ?? -99) - (rec.sleepScore ?? 0));
    if (recDiff < 3 && sleepDiff < 5) {
      return { ran: false, date, reason: 'already prepared', recovery: rec.recoveryScore };
    }
  }

  let headline: string | undefined;
  try {
    // If a new run landed, refine the Power & HR Zones file before planning today.
    await maybeAutoRecalibrate().catch(() => {});
    const cs   = await assembleCoachSnapshot(snap.strain ?? null, snap.activities);
    const plan = await getCoachPlan(cs);
    await saveCachedPlan(cs.date, plan);
    headline = plan.headline;
    // Push (or clear) the structured "Day" workout on the watch — only on run days.
    if (plan.workout) pushWorkoutToWatch(plan.workout).catch(() => {});
    else clearWatchWorkout().catch(() => {});
  } catch { /* e.g. no API key — KPIs still refreshed; the plan stays on-demand */ }

  // Background, non-blocking: push the fresh recovery/strain/load up to the cloud so a coach sees the
  // new numbers as soon as they're known (the morning HealthKit-observer wake also triggers this).
  trySyncSnapshot(snap).catch(() => {});

  try {
    await FileSystem.writeAsStringAsync(marker(date), JSON.stringify({
      date, at: new Date().toISOString(), recovery: rec.recoveryScore, sleepScore: rec.sleepScore, headline,
    }));
  } catch { /* ignore */ }

  if (opts.notify !== false) {
    try {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: 'Today’s view is ready 🟢',
          body: `Recovery ${rec.recoveryScore}/100${headline ? ' · ' + headline : ' · KPIs updated'}`,
          data: { screen: 'home', tag: 'dayview' },
        },
        trigger: null, // immediate
      });
    } catch { /* notifications not granted — silent */ }
  }
  return { ran: true, date, recovery: rec.recoveryScore, headline };
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
