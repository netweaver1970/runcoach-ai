import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { TouchableOpacity, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import { cancelDailyRecoveryReminder } from '../src/services/notifications';
import { initICloudAutoSave, maybeRestoreFromICloud, scheduleICloudSync } from '../src/services/icloudSync';
import { ThemeProvider, useTheme } from '../src/theme';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import '../src/services/runKeepAlive';   // side effect: registers the background-location task + run-state listener at launch

// Route a tapped notification to the right screen based on its `data.screen`.
function routeNotification(router: ReturnType<typeof useRouter>, data: any) {
  if (!data || typeof data !== 'object') return;
  switch (data.screen) {
    case 'run-analysis':
      router.push({ pathname: '/run-analysis', params: data.runUUID ? { runUUID: String(data.runUUID) } : {} } as any);
      break;
    case 'analysis':
      router.push('/analysis' as any);
      break;
    case 'coach':
      // Morning "plan is ready" tap → the daily coach page for that day.
      router.push({ pathname: '/daily-coach', params: data.date ? { date: String(data.date) } : {} } as any);
      break;
    // 'home' (and anything else) just opens the app — no navigation needed.
  }
}

function RootStack() {
  const router = useRouter();
  const { c } = useTheme();

  // Retire the old fixed-7:30 daily reminder — the morning notification is now event-driven
  // (fires when the plan is actually ready). Cancels any lingering schedule from a prior install.
  useEffect(() => { cancelDailyRecoveryReminder().catch(() => {}); }, []);

  // iCloud auto-sync: on a FRESH install, pull the user's own iCloud backup (guarded — no-op if the app is
  // already set up, iCloud is off, or the native module isn't built in yet); then keep it saved whenever the
  // app backgrounds, and seed a first backup for existing installs. Fully inert until the iCloud entitlement
  // is provisioned + prebuilt, so this is safe to ship beforehand.
  useEffect(() => {
    let alive = true;
    maybeRestoreFromICloud()
      .then((restored) => { if (restored && alive) router.replace('/'); }) // re-render from restored state (skips onboarding)
      .catch(() => {})
      .finally(() => { initICloudAutoSave(); scheduleICloudSync(8000); });
    return () => { alive = false; };
  }, [router]);

  // Deep-link notification taps (both warm taps and cold launches).
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      routeNotification(router, resp.notification.request.content.data);
    });
    Notifications.getLastNotificationResponseAsync().then((resp) => {
      if (resp) routeNotification(router, resp.notification.request.content.data);
    });
    return () => sub.remove();
  }, [router]);

  return (
    <>
      {/* Header is brand-orange in both themes, so light content always reads */}
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: c.accent },
          headerTintColor: '#fff',
          headerTitleStyle: { fontWeight: '700' },
          contentStyle: { backgroundColor: c.bg },
        }}
      >
        <Stack.Screen
          name="index"
          options={{
            title: 'RunCoach AI',
            headerRight: () => (
              <TouchableOpacity
                onPress={() => router.push('/settings')}
                hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
                style={{ paddingVertical: 6, paddingHorizontal: 10, marginRight: 2 }}
              >
                <Text style={{ color: '#fff', fontSize: 22 }}>⚙️</Text>
              </TouchableOpacity>
            ),
          }}
        />
        <Stack.Screen name="analysis" options={{ title: 'Coach Report', headerBackTitle: 'Back' }} />
        <Stack.Screen name="timeline" options={{ title: 'Timeline', headerBackTitle: 'Back' }} />
        <Stack.Screen name="week-plan" options={{ title: '7-Day Plan', headerBackTitle: 'Back' }} />
        <Stack.Screen name="run-analysis" options={{ title: 'Run Analysis', headerBackTitle: 'Back' }} />
        <Stack.Screen name="wayfinder" options={{ title: 'Route', headerBackTitle: 'Back' }} />
        <Stack.Screen
          name="chat"
          options={{
            title: 'Chat with Coach',
            headerStyle: { backgroundColor: c.accent },
            headerTintColor: '#fff',
          }}
        />
        <Stack.Screen name="settings" options={{ headerShown: false }} />
        <Stack.Screen name="bevel-import" options={{ headerShown: false }} />
        <Stack.Screen name="bevel-analysis" options={{ headerShown: false }} />
        <Stack.Screen name="recovery-detail" options={{ headerShown: false }} />
        <Stack.Screen name="sleep-detail" options={{ headerShown: false }} />
        <Stack.Screen name="strain-detail" options={{ headerShown: false }} />
        <Stack.Screen name="daily-coach" options={{ headerShown: false }} />
        <Stack.Screen name="body-battery" options={{ headerShown: false }} />
        <Stack.Screen name="history" options={{ headerShown: false }} />
        <Stack.Screen name="training-load" options={{ headerShown: false }} />
        <Stack.Screen name="statistics" options={{ headerShown: false }} />
        <Stack.Screen name="coach-knowledge" options={{ headerShown: false }} />
        <Stack.Screen name="coach-knowledge-edit" options={{ headerShown: false }} />
        <Stack.Screen name="account" options={{ headerShown: false }} />
        <Stack.Screen name="coach" options={{ headerShown: false }} />
        <Stack.Screen name="coach-athlete" options={{ headerShown: false }} />
        <Stack.Screen name="bevel-calibration" options={{ headerShown: false }} />
        <Stack.Screen name="debug" options={{ headerShown: false }} />
        <Stack.Screen name="onboarding" options={{ headerShown: false, gestureEnabled: false }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <ErrorBoundary>
        <RootStack />
      </ErrorBoundary>
    </ThemeProvider>
  );
}
