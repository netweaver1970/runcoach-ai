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
import { pushWorkoutToWatch, clearWatchWorkout } from './watchWorkout';
import { maybeAutoRecalibrate } from './zones';

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
  if (!opts.force && await dayViewDoneFor(date)) {
    return { ran: false, date, reason: 'already prepared', recovery: rec.recoveryScore };
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

  try {
    await FileSystem.writeAsStringAsync(marker(date), JSON.stringify({
      date, at: new Date().toISOString(), recovery: rec.recoveryScore, headline,
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

// ─── HealthKit observer: recalibrate zones when a new run lands ─────────────────
let workoutObsId: string | null = null;
const WORKOUT_ID = 'HKWorkoutTypeIdentifier';

export async function startWorkoutObserver(): Promise<void> {
  if (workoutObsId) return;
  try {
    await (HealthKit as any).enableBackgroundDelivery?.(WORKOUT_ID, 'immediate');
    workoutObsId = (HealthKit as any).subscribeToChanges?.(WORKOUT_ID, () => {
      maybeAutoRecalibrate().catch(() => {});
    }) ?? null;
  } catch { /* observer unavailable — the foreground trigger still covers it */ }
}

export function stopWorkoutObserver(): void {
  try { if (workoutObsId) (HealthKit as any).unsubscribeQueries?.([workoutObsId]); } catch { /* ignore */ }
  workoutObsId = null;
}
