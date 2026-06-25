import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { TouchableOpacity, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import { ThemeProvider, useTheme } from '../src/theme';
import { ErrorBoundary } from '../src/components/ErrorBoundary';

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
    // 'home' (and anything else) just opens the app — no navigation needed.
  }
}

function RootStack() {
  const router = useRouter();
  const { c } = useTheme();

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
          headerStyle: { backgroundColor: '#FF6B35' },
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
        <Stack.Screen name="analysis" options={{ title: 'Coach Report' }} />
        <Stack.Screen name="run-analysis" options={{ title: 'Run Analysis' }} />
        <Stack.Screen
          name="chat"
          options={{
            title: 'Chat with Coach',
            headerStyle: { backgroundColor: '#FF6B35' },
            headerTintColor: '#fff',
          }}
        />
        <Stack.Screen name="settings" options={{ headerShown: false }} />
        <Stack.Screen name="bevel-import" options={{ headerShown: false }} />
        <Stack.Screen name="bevel-analysis" options={{ headerShown: false }} />
        <Stack.Screen name="recovery-detail" options={{ headerShown: false }} />
        <Stack.Screen name="sleep-detail" options={{ headerShown: false }} />
        <Stack.Screen name="strain-detail" options={{ headerShown: false }} />
        <Stack.Screen name="body-battery" options={{ headerShown: false }} />
        <Stack.Screen name="history" options={{ headerShown: false }} />
        <Stack.Screen name="training-load" options={{ headerShown: false }} />
        <Stack.Screen name="coach-knowledge" options={{ headerShown: false }} />
        <Stack.Screen name="coach-knowledge-edit" options={{ headerShown: false }} />
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
