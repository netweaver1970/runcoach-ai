import * as Notifications from 'expo-notifications';
import { DailyRecovery } from '../types';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

export async function requestNotificationPermissions(): Promise<boolean> {
  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

// ─── Daily recovery notification (7:30 AM) ───────────────────────────────────

const RECOVERY_NOTIFICATION_TAG = 'daily-recovery';

export async function scheduleDailyRecoveryReminder(): Promise<string> {
  await cancelDailyRecoveryReminder();
  const id = await Notifications.scheduleNotificationAsync({
    content: {
      title: '🫀 Morning Recovery Check',
      body: 'Tap to see your recovery score and today\'s training recommendation.',
      data: { screen: 'analysis', tag: RECOVERY_NOTIFICATION_TAG },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DAILY,
      hour: 7,
      minute: 30,
    },
  });
  return id;
}

export async function cancelDailyRecoveryReminder(): Promise<void> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  const toCancel = scheduled.filter(
    (n) => n.content.data?.tag === RECOVERY_NOTIFICATION_TAG
  );
  await Promise.all(
    toCancel.map((n) =>
      Notifications.cancelScheduledNotificationAsync(n.identifier)
    )
  );
}

export async function isDailyRecoveryActive(): Promise<boolean> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  return scheduled.some(
    (n) => n.content.data?.tag === RECOVERY_NOTIFICATION_TAG
  );
}

// ─── Weekly coach report reminder (Monday 8:00 AM) ───────────────────────────

const WEEKLY_NOTIFICATION_TAG = 'weekly-coach';

export async function scheduleWeeklyCoachReminder(): Promise<string> {
  await cancelWeeklyCoachReminder();
  const id = await Notifications.scheduleNotificationAsync({
    content: {
      title: '🏃 Weekly Running Review',
      body: "Time for your RunCoach AI analysis — tap to see your coaching report.",
      data: { screen: 'analysis', tag: WEEKLY_NOTIFICATION_TAG },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
      weekday: 2, // 1=Sun, 2=Mon
      hour: 8,
      minute: 0,
    },
  });
  return id;
}

export async function cancelWeeklyCoachReminder(): Promise<void> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  const toCancel = scheduled.filter(
    (n) => n.content.data?.tag === WEEKLY_NOTIFICATION_TAG
  );
  await Promise.all(
    toCancel.map((n) =>
      Notifications.cancelScheduledNotificationAsync(n.identifier)
    )
  );
}

export async function isWeeklyReminderActive(): Promise<boolean> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  return scheduled.some((n) => n.content.data?.tag === WEEKLY_NOTIFICATION_TAG);
}
