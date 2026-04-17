import React, { useEffect, useState, useCallback, useRef } from 'react';
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
  ActivityIndicator,
  Platform,
  Keyboard,
} from 'react-native';
import {
  getApiKey, validateAndSaveApiKey, deleteApiKey, MODEL, saveBodyMassKg, DEFAULT_BODY_MASS_KG,
  getPowerZones, savePowerZones, DEFAULT_POWER_ZONES,
  getLongRunMinutes, setLongRunMinutes, DEFAULT_LONG_RUN_MINUTES,
  ApiKeyValidationResult,
} from '../src/services/claude';
import { PowerZones } from '../src/types';
import { resolveBodyMassKg } from '../src/services/healthkit';
import { useRouter } from 'expo-router';
import { clearWorkoutCache } from '../src/services/workoutClassifier';
import { loadChatPersistence, saveChatPersistence, clearChatPersistence } from '../src/services/chatMemory';
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
  const router = useRouter();
  const [apiKey, setApiKey] = useState('');
  const [saved, setSaved] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [validating, setValidating] = useState(false);
  const validatingRef = useRef(false);
  const [lastDebug, setLastDebug] = useState<ApiKeyValidationResult['debug'] | null>(null);
  const [weeklyActive, setWeeklyActive] = useState(false);
  const [dailyActive, setDailyActive] = useState(false);
  const [bodyMass, setBodyMass] = useState(String(DEFAULT_BODY_MASS_KG));
  const [massSaved, setMassSaved] = useState(false);
  const [powerZones, setPowerZones] = useState<PowerZones>(DEFAULT_POWER_ZONES);
  const [powerZonesSaved, setPowerZonesSaved] = useState(false);
  const [longRunMin, setLongRunMin] = useState(String(DEFAULT_LONG_RUN_MINUTES));
  const [longRunSaved, setLongRunSaved] = useState(false);
  const [coachMemory, setCoachMemory] = useState('');
  const [memorySaved, setMemorySaved] = useState(false);

  useEffect(() => {
    getApiKey().then((k) => {
      if (k) { setHasKey(true); setApiKey(k); }
    });
    isWeeklyReminderActive().then(setWeeklyActive);
    isDailyRecoveryActive().then(setDailyActive);
    resolveBodyMassKg().then(kg => setBodyMass(String(kg)));
    getPowerZones().then(setPowerZones);
    getLongRunMinutes().then(m => setLongRunMin(String(m)));
    loadChatPersistence().then(p => setCoachMemory(p?.memoryNote ?? ''));
  }, []);

  const setPZ = (key: keyof PowerZones, raw: string) => {
    const val = parseInt(raw, 10);
    setPowerZones(prev => ({ ...prev, [key]: isNaN(val) || val < 0 ? 0 : val }));
  };

  const handleSavePowerZones = async () => {
    // Basic sanity checks
    if (powerZones.z2Max > 0 && powerZones.recoveryMax >= powerZones.z2Max) {
      Alert.alert('Invalid zones', 'Recovery max must be less than Z2 max.');
      return;
    }
    if (powerZones.tempoMin > 0 && powerZones.tempoMax > 0 && powerZones.tempoMin >= powerZones.tempoMax) {
      Alert.alert('Invalid zones', 'Tempo min must be less than tempo max.');
      return;
    }
    await savePowerZones(powerZones);
    setPowerZonesSaved(true);
    setTimeout(() => setPowerZonesSaved(false), 2000);
  };

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

  const handleSaveLongRun = async () => {
    const n = parseInt(longRunMin, 10);
    if (isNaN(n) || n < 20 || n > 300) {
      Alert.alert('Invalid value', 'Enter a duration between 20 and 300 minutes.');
      return;
    }
    await setLongRunMinutes(n);
    await clearWorkoutCache();  // force re-classify with new threshold
    setLongRunSaved(true);
    setTimeout(() => setLongRunSaved(false), 2000);
  };

  const handleSave = useCallback(async () => {
    if (validatingRef.current) return;
    Keyboard.dismiss();
    validatingRef.current = true;
    setValidating(true);
    try {
      const result = await validateAndSaveApiKey(apiKey);
      setLastDebug(result.debug ?? null);
      if (!result.valid) {
        Alert.alert('Invalid API Key', result.error ?? 'Could not validate key.');
        return;
      }
      setHasKey(true);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      if (result.warning) {
        Alert.alert('Key Saved — Warning', result.warning);
      } else {
        Alert.alert('Saved', 'API key verified and stored securely.');
      }
    } finally {
      validatingRef.current = false;
      setValidating(false);
    }
  }, [apiKey]);

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
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">

        {/* API Key */}
        <Section title="Anthropic API Key">
          <Text style={styles.hint}>
            Your key is stored securely in the iOS Keychain — never leaves your device.
            {'\n'}Get one at console.anthropic.com
          </Text>
          <TextInput
            style={[styles.input, styles.apiKeyInput]}
            value={apiKey}
            onChangeText={setApiKey}
            placeholder="sk-ant-api03-…"
            placeholderTextColor="#bbb"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
          />
          <View style={styles.row}>
            <TouchableOpacity
              style={[styles.btn, saved && styles.btnSuccess, validating && { opacity: 0.7 }]}
              onPress={handleSave}
              disabled={validating}
            >
              {validating
                ? <ActivityIndicator size="small" color="#fff" />
                : <Text style={styles.btnText}>{saved ? '✓ Verified & Saved' : 'Verify & Save Key'}</Text>
              }
            </TouchableOpacity>
            {hasKey && !validating && (
              <TouchableOpacity style={styles.btnDanger} onPress={handleDelete}>
                <Text style={styles.btnText}>Remove</Text>
              </TouchableOpacity>
            )}
          </View>
          {lastDebug && (
            <TouchableOpacity
              style={styles.debugBtn}
              onPress={() => Alert.alert(
                'API Key Debug',
                [
                  `── Key ──`,
                  `Prefix  : ${lastDebug.keyPrefix}…`,
                  `Suffix  : …${lastDebug.keySuffix}`,
                  `Length  : ${lastDebug.keyLength}`,
                  `Non-ASCII: ${lastDebug.nonAscii}`,
                  ``,
                  `── Request ──`,
                  `URL     : ${lastDebug.requestUrl}`,
                  `Status  : ${lastDebug.status || '(not sent)'}`,
                  ``,
                  `── Error ──`,
                  `Type    : ${lastDebug.errorType || '—'}`,
                  `Message : ${lastDebug.errorMessage || '—'}`,
                  ``,
                  `── Response headers ──`,
                  lastDebug.responseHeaders || '(none)',
                  ``,
                  `── Body (first 500 chars) ──`,
                  lastDebug.bodySnippet || '(empty)',
                ].join('\n'),
              )}
            >
              <Text style={styles.debugBtnText}>Show debug info</Text>
            </TouchableOpacity>
          )}
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

        {/* Power Zones */}
        <Section title="Power Zones (watts)">
          <Text style={styles.hint}>
            When your Apple Watch records running power, these thresholds override the HR-based auto-classification.
            Set to 0 to leave a boundary unconfigured.
          </Text>

          <View style={styles.pzRow}>
            <Text style={styles.pzLabel}>🟣 Recovery  ≤</Text>
            <TextInput
              style={[styles.input, styles.pzInput]}
              value={powerZones.recoveryMax > 0 ? String(powerZones.recoveryMax) : ''}
              onChangeText={v => setPZ('recoveryMax', v)}
              placeholder="0"
              placeholderTextColor="#bbb"
              keyboardType="number-pad"
              returnKeyType="done"
            />
            <Text style={styles.pzUnit}>W</Text>
          </View>

          <View style={styles.pzRow}>
            <Text style={styles.pzLabel}>🟢 Z2          ≤</Text>
            <TextInput
              style={[styles.input, styles.pzInput]}
              value={powerZones.z2Max > 0 ? String(powerZones.z2Max) : ''}
              onChangeText={v => setPZ('z2Max', v)}
              placeholder="0"
              placeholderTextColor="#bbb"
              keyboardType="number-pad"
              returnKeyType="done"
            />
            <Text style={styles.pzUnit}>W</Text>
          </View>

          <View style={styles.pzRow}>
            <Text style={styles.pzLabel}>🟠 Tempo</Text>
            <TextInput
              style={[styles.input, styles.pzInput]}
              value={powerZones.tempoMin > 0 ? String(powerZones.tempoMin) : ''}
              onChangeText={v => setPZ('tempoMin', v)}
              placeholder="min"
              placeholderTextColor="#bbb"
              keyboardType="number-pad"
              returnKeyType="done"
            />
            <Text style={styles.pzUnit}>–</Text>
            <TextInput
              style={[styles.input, styles.pzInput]}
              value={powerZones.tempoMax > 0 ? String(powerZones.tempoMax) : ''}
              onChangeText={v => setPZ('tempoMax', v)}
              placeholder="max"
              placeholderTextColor="#bbb"
              keyboardType="number-pad"
              returnKeyType="done"
            />
            <Text style={styles.pzUnit}>W</Text>
          </View>

          <View style={styles.pzRow}>
            <Text style={styles.pzLabel}>🔴 Intervals ≥</Text>
            <TextInput
              style={[styles.input, styles.pzInput]}
              value={powerZones.intervalsMin > 0 ? String(powerZones.intervalsMin) : ''}
              onChangeText={v => setPZ('intervalsMin', v)}
              placeholder="0"
              placeholderTextColor="#bbb"
              keyboardType="number-pad"
              returnKeyType="done"
            />
            <Text style={styles.pzUnit}>W</Text>
          </View>

          <TouchableOpacity
            style={[styles.btn, powerZonesSaved && styles.btnSuccess]}
            onPress={handleSavePowerZones}
          >
            <Text style={styles.btnText}>{powerZonesSaved ? '✓ Saved' : 'Save Power Zones'}</Text>
          </TouchableOpacity>
        </Section>

        {/* Long Run Threshold */}
        <Section title="Long Run Threshold">
          <Text style={styles.hint}>
            Runs longer than this are classified as "Long Run" regardless of pace or HR.
            Changing this clears the classification cache so all runs are re-evaluated.
          </Text>
          <View style={styles.row}>
            <TextInput
              style={[styles.input, { flex: 1, marginBottom: 0 }]}
              value={longRunMin}
              onChangeText={setLongRunMin}
              placeholder="75"
              placeholderTextColor="#bbb"
              keyboardType="number-pad"
              returnKeyType="done"
            />
            <Text style={styles.unitLabel}>min</Text>
            <TouchableOpacity
              style={[styles.btn, longRunSaved && styles.btnSuccess, { flex: 0, paddingHorizontal: 16 }]}
              onPress={handleSaveLongRun}
            >
              <Text style={styles.btnText}>{longRunSaved ? '✓ Saved' : 'Save'}</Text>
            </TouchableOpacity>
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

        {/* Bevel Calibration */}
        <Section title="Bevel Calibration">
          <Text style={styles.hint}>
            Manually enter daily Bevel scores and biometrics to reverse-engineer scoring weights and improve RunCoach AI's algorithms.
          </Text>
          <TouchableOpacity
            style={styles.btn}
            onPress={() => router.push('/bevel-calibration' as any)}
          >
            <Text style={styles.btnText}>Open Calibration Tool</Text>
          </TouchableOpacity>
        </Section>

        {/* Model info */}
        {/* Coaching Memory */}
        <Section title="Coaching Memory">
          <Text style={styles.hint}>
            Your coach builds a memory note from your conversations — goals, patterns, agreements.
            {'\n\n'}
            <Text style={{ fontWeight: '600', color: '#555' }}>Seed from Claude.ai:</Text> open your existing running conversation there, ask{' '}
            <Text style={{ fontStyle: 'italic' }}>"Summarise my running context and goals in 150 words"</Text>, then paste the result below.
          </Text>
          <TextInput
            style={[styles.input, { minHeight: 100, textAlignVertical: 'top', marginBottom: 10 }]}
            value={coachMemory}
            onChangeText={setCoachMemory}
            placeholder="Paste coaching context here, or leave blank to let it build automatically…"
            placeholderTextColor="#bbb"
            multiline
            autoCapitalize="sentences"
            autoCorrect
          />
          <View style={styles.row}>
            <TouchableOpacity
              style={[styles.btn, memorySaved && styles.btnSuccess]}
              onPress={async () => {
                const existing = await loadChatPersistence();
                await saveChatPersistence(existing?.messages ?? [], coachMemory.trim());
                setMemorySaved(true);
                setTimeout(() => setMemorySaved(false), 2500);
                Keyboard.dismiss();
              }}
            >
              <Text style={styles.btnText}>{memorySaved ? '✓ Saved' : 'Save memory'}</Text>
            </TouchableOpacity>
            {coachMemory.length > 0 && (
              <TouchableOpacity
                style={styles.btnDanger}
                onPress={() => Alert.alert(
                  'Clear coaching memory',
                  'This removes the memory note. The chat conversation history is kept. Continue?',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Clear', style: 'destructive', onPress: async () => {
                      const existing = await loadChatPersistence();
                      await saveChatPersistence(existing?.messages ?? [], '');
                      setCoachMemory('');
                    }},
                  ],
                )}
              >
                <Text style={styles.btnText}>Clear</Text>
              </TouchableOpacity>
            )}
          </View>
        </Section>

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
  pzRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  pzLabel: { fontSize: 13, color: '#555', fontWeight: '600', width: 106 },
  pzInput: { flex: 1, marginBottom: 0, paddingVertical: 8, textAlign: 'center', minWidth: 52 },
  pzUnit: { fontSize: 13, color: '#888', fontWeight: '600', minWidth: 12 },
  apiKeyInput: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
    letterSpacing: 0.3,
  },
  debugBtn: {
    marginTop: 6, alignSelf: 'flex-start',
    paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 6, borderWidth: 1, borderColor: '#ccc',
    backgroundColor: '#f9f9f9',
  },
  debugBtnText: { fontSize: 11, color: '#888', fontWeight: '500' },
});
