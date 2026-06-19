import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { TouchableOpacity, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { ThemeProvider, useTheme } from '../src/theme';

function RootStack() {
  const router = useRouter();
  const { c } = useTheme();

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
                style={{ marginRight: 4 }}
              >
                <Text style={{ color: '#fff', fontSize: 22 }}>⚙️</Text>
              </TouchableOpacity>
            ),
          }}
        />
        <Stack.Screen name="analysis" options={{ title: 'Coach Report' }} />
        <Stack.Screen
          name="chat"
          options={{
            title: 'Chat with Coach',
            headerStyle: { backgroundColor: '#FF6B35' },
            headerTintColor: '#fff',
          }}
        />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <RootStack />
    </ThemeProvider>
  );
}
