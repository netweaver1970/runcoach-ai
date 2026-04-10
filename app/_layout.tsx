import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { TouchableOpacity, Text } from 'react-native';
import { useRouter } from 'expo-router';

export default function RootLayout() {
  const router = useRouter();

  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: '#FF6B35' },
          headerTintColor: '#fff',
          headerTitleStyle: { fontWeight: '700' },
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
        <Stack.Screen
          name="analysis"
          options={{ title: 'Coach Report' }}
        />
        <Stack.Screen
          name="chat"
          options={{
            title: 'Chat with Coach',
            headerStyle: { backgroundColor: '#FF6B35' },
            headerTintColor: '#fff',
          }}
        />
        <Stack.Screen
          name="settings"
          options={{ title: 'Settings' }}
        />
      </Stack>
    </>
  );
}
