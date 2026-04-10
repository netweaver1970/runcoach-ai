import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ScrollView,
  SafeAreaView,
  Switch,
} from 'react-native';
import { getApiKey, saveApiKey, deleteApiKey, MODEL, saveBodyMassKg, DEFAULT_BODY_MASS_KG } from '../src/services/claude';
import { resolveBodyMassKg } from '../src/services/healthkit';
import {
  scheduleWeeklyCoachReminder,
  cancelWeeklyCoachReminder,
  isWeeklyReminderActive,
  scheduleDailyRecoveryReminder,
  cancelDailyRecoveryReminder,
  isDailyRecoveryActive,
  requestNotificationPermissions,
} from '../src/services/notifications';

export default function SettingsScreen() {
  const [apiKey, setApiKey] = useState('');
  const [saved, setSaved] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [weeklyActive, setWeeklyActive] = useState(false);
  const [dailyActive, setDailyActive] = useState(false);
  const [bodyMass, setBodyMass] = useState(String(DEFAULT_BODY_MASS_KG));
  const [massSaved, setMassSaved] = useState(false);

  useEffect(() => {
    getApiKey().then((k) => {
      if (k) { setHasKey(true); setApiKey(k); }
    });
    isWeeklyReminderActive().then(setWeeklyActive);
    isDailyRecoveryActive().then(setDailyActive);
    resolveBodyMassKg().then(kg => setBodyMass(String(kg)));
  }, []);

  const handleSaveMass = async () => {
    const kg = parseFloat(bodyMass);
    if (isNaN(kg) || kg < 30 || kg > 250) {
      Alert.alert('Invalid weight', 'Enter a weight between 30 and 250 kg.');
      return;
    }
    await saveBodyMassKg(kg);
    setMassSaved(true);
    setTimeout(() => setMassSaved(false), 2000);
  };

  const handleSave = async () => {
    const trimmed = apiKey.trim();
    if (!trimmed.startsWith('sk-ant-')) {
      Alert.alert('Invalid key', 'Anthropic API keys start with "sk-ant-".');
      return;
    }
    await saveApiKey(trimmed);
    setHasKey(true);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    Alert.alert('Saved', 'API key stored securely on device.');
  };

  const handleDelete = async () => {
    Alert.alert('Remove API Key', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive', onPress: async () => {
          await deleteApiKey();
          setApiKey('');
          setHasKey(false);
        },
      },
    ]);
  };

  const toggleWeekly = async (value: boolean) => {
    if (value) {
      const granted = await requestNotificationPermissions();
      if (!granted) {
        Alert.alert('Notifications blocked', 'Enable notifications in iOS Settings to use this feature.');
        return;
      }
      await scheduleWeeklyCoachReminder();
      setWeeklyActive(true);
    } else {
      await cancelWeeklyCoachReminder();
      setWeeklyActive(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>

        {/* API Key */}
        <Section title="Anthropic API Key">
          <Text style={styles.hint}>
            Your key is stored securely in the iOS Keychain — never leaves your device.
            {'\n'}Get one at console.anthropic.com
          </Text>
          <TextInput
            style={styles.input}
            value={apiKey}
            onChangeText={setApiKey}
            placeholder="sk-ant-api03-…"
            placeholderTextColor="#bbb"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry={hasKey}
          />
          <View style={styles.row}>
            <TouchableOpacity
              style={[styles.btn, saved && styles.btnSuccess]}
              onPress={handleSave}
            >
              <Text style={styles.btnText}>{saved ? '✓ Saved' : 'Save Key'}</Text>
            </TouchableOpacity>
            {hasKey && (
              <TouchableOpacity style={styles.btnDanger} onPress={handleDelete}>
                <Text style={styles.btnText}>Remove</Text>
              </TouchableOpacity>
            )}
          </View>
        </Section>

        {/* Daily recovery */}
        <Section title="Daily Recovery Notification">
          <View style={styles.switchRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.switchLabel}>Every morning at 7:30 AM</Text>
              <Text style={styles.switchSub}>
                Reminds you to check your recovery score (based on last night's HRV during sleep).
              </Text>
            </View>
            <Switch
              value={dailyActive}
              onValueChange={async (v) => {
                if (v) {
                  const granted = await requestNotificationPermissions();
                  if (!granted) {
                    Alert.alert('Notifications blocked', 'Enable notifications in iOS Settings.');
                    return;
                  }
                  await scheduleDailyRecoveryReminder();
                  setDailyActive(true);
                } else {
                  await cancelDailyRecoveryReminder();
                  setDailyActive(false);
                }
              }}
              trackColor={{ true: '#FF6B35', false: '#ccc' }}
              thumbColor="#fff"
            />
          </View>
        </Section>

        {/* Weekly coach */}
        <Section title="Weekly Coach Report">
          <View style={styles.switchRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.switchLabel}>Every Monday at 8:00 AM</Text>
              <Text style={styles.switchSub}>A notification reminds you to open your full coaching report.</Text>
            </View>
            <Switch
              value={weeklyActive}
              onValueChange={toggleWeekly}
              trackColor={{ true: '#FF6B35', false: '#ccc' }}
              thumbColor="#fff"
            />
          </View>
        </Section>

        {/* Body Weight */}
        <Section title="Body Weight">
          <Text style={styles.hint}>
            Used to estimate running power (W) when Apple Watch power data is unavailable.
            Auto-filled from Apple Health if recorded there.
          </Text>
          <View style={styles.row}>
            <TextInput
              style={[styles.input, { flex: 1, marginBottom: 0 }]}
              value={bodyMass}
              onChangeText={setBodyMass}
              placeholder="70"
              placeholderTextColor="#bbb"
              keyboardType="decimal-pad"
              returnKeyType="done"
            />
            <Text style={styles.unitLabel}>kg</Text>
            <TouchableOpacity
              style={[styles.btn, massSaved && styles.btnSuccess, { flex: 0, paddingHorizontal: 16 }]}
              onPress={handleSaveMass}
            >
              <Text style={styles.btnText}>{massSaved ? '✓ Saved' : 'Save'}</Text>
            </TouchableOpacity>
          </View>
        </Section>

        {/* Model info */}
        <Section title="AI Model">
          <Text style={styles.hint}>
            Using <Text style={{ fontWeight: '700' }}>{MODEL}</Text>.{'\n'}
            Fast and cost-efficient (~$0.01–0.03 per analysis).
          </Text>
        </Section>

        {/* Data info */}
        <Section title="Data & Privacy">
          <Text style={styles.hint}>
            RunCoach AI reads Apple Health data directly on your device.{'\n\n'}
            Your health data is sent to Anthropic's API only when you request a coaching report. Anthropic does not use API data to train models.{'\n\n'}
            No data is stored on any server. Your API key stays in the iOS Keychain.
          </Text>
        </Section>

      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F5F5F5' },
  scroll: { padding: 16, paddingBottom: 40 },
  section: { marginBottom: 20 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
    marginLeft: 4,
  },
  sectionBody: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 2,
  },
  hint: { fontSize: 13, color: '#777', lineHeight: 20, marginBottom: 12 },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#222',
    backgroundColor: '#fafafa',
    marginBottom: 10,
  },
  row: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  unitLabel: { fontSize: 14, color: '#555', fontWeight: '600' },
  btn: {
    flex: 1,
    backgroundColor: '#FF6B35',
    borderRadius: 8,
    paddingVertical: 11,
    alignItems: 'center',
  },
  btnSuccess: { backgroundColor: '#27ae60' },
  btnDanger: {
    backgroundColor: '#c0392b',
    borderRadius: 8,
    paddingVertical: 11,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  switchLabel: { fontSize: 14, color: '#333', fontWeight: '600', marginBottom: 2 },
  switchSub: { fontSize: 12, color: '#999' },
});
