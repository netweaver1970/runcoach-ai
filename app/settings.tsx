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
  saveBodyMassKg, DEFAULT_BODY_MASS_KG,
  getPowerZones, savePowerZones, DEFAULT_POWER_ZONES,
  getLongRunMinutes, setLongRunMinutes, DEFAULT_LONG_RUN_MINUTES,
  getAiWeeks, setAiWeeks, DEFAULT_AI_WEEKS,
  getUserMaxHr, setUserMaxHr,
} from '../src/services/claude';
import {
  loadLLMConfig, saveLLMConfig, deleteLLMApiKey, validateLLMKey,
  loadModelHistory, PROVIDER_LABELS, PROVIDER_KEY_PLACEHOLDER, SUGGESTED_MODELS,
  LLMProvider,
} from '../src/services/llm';
import { PowerZones } from '../src/types';
import { recalibrateZonesFromLastRun } from '../src/services/zones';
import { WATCH_KPIS, getWatchKPI, setWatchKPI, watchSyncAvailable } from '../src/services/watchSync';
import { useTheme, useThemedStyles, Palette, ThemeMode, FontSizeStep } from '../src/theme';
import { resolveBodyMassKg, loadSnapshotCache } from '../src/services/healthkit';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useRouter, useNavigation } from 'expo-router';
import { clearWorkoutCache } from '../src/services/workoutClassifier';
import { loadChatPersistence, saveChatPersistence, clearChatPersistence } from '../src/services/chatMemory';
import * as Clipboard from 'expo-clipboard';
import { exportAllSettings, restoreAllSettings } from '../src/services/backup';
import { isAutoDayViewEnabled, setAutoDayViewEnabled, maybeRunDayView } from '../src/services/dayUpdate';
import { getLoadCapPct, setLoadCapPct, getLoadCapBasis, setLoadCapBasis, DEFAULT_LOAD_CAP_PCT, LoadCapBasis } from '../src/services/coach';
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
  const { mode, setMode, c, fontStep, setFontStep } = useTheme();
  const styles = useThemedStyles(makeStyles);

  // ── LLM config ──────────────────────────────────────────────────────────────
  const [provider,      setProvider]      = useState<LLMProvider>('anthropic');
  const [model,         setModel]         = useState('');
  const [apiKey,        setApiKey]        = useState('');
  const [baseUrl,       setBaseUrl]       = useState('');
  const [modelHistory,  setModelHistory]  = useState<string[]>([]);
  const [hasKey,        setHasKey]        = useState(false);
  const [saved,         setSaved]         = useState(false);
  const [validating,    setValidating]    = useState(false);
  const validatingRef = useRef(false);

  const [weeklyActive, setWeeklyActive] = useState(false);
  const [dailyActive, setDailyActive] = useState(false);
  const [bodyMass, setBodyMass] = useState(String(DEFAULT_BODY_MASS_KG));
  const [massSaved, setMassSaved] = useState(false);
  const [powerZones, setPowerZones] = useState<PowerZones>(DEFAULT_POWER_ZONES);
  const [powerZonesSaved, setPowerZonesSaved] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [calibMsg, setCalibMsg] = useState('');
  const [longRunMin, setLongRunMin] = useState(String(DEFAULT_LONG_RUN_MINUTES));
  const [longRunSaved, setLongRunSaved] = useState(false);
  const [capPct, setCapPct] = useState(String(DEFAULT_LOAD_CAP_PCT));
  const [capPctSaved, setCapPctSaved] = useState(false);
  const [capBasis, setCapBasisState] = useState<LoadCapBasis>('tof');
  const [maxHr, setMaxHr] = useState('');
  const [maxHrSaved, setMaxHrSaved] = useState(false);
  const [aiWeeks, setAiWeeksState] = useState(String(DEFAULT_AI_WEEKS));
  const [aiWeeksSaved, setAiWeeksSaved] = useState(false);
  const [coachMemory, setCoachMemory] = useState('');
  const [memorySaved, setMemorySaved] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [dayViewAuto, setDayViewAuto] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [watchKPI, setWatchKPIState] = useState('stress');
  useEffect(() => { getWatchKPI().then(setWatchKPIState); }, []);

  // Back (swipe gesture / header / Android) inside an open category collapses to the
  // category list instead of leaving Settings entirely.
  const navigation = useNavigation();
  useEffect(() => {
    const sub = (navigation as any).addListener('beforeRemove', (e: any) => {
      if (activeCat) {
        e.preventDefault();
        setActiveCat(null);
      }
    });
    return sub;
  }, [navigation, activeCat]);

  useEffect(() => {
    loadLLMConfig().then(cfg => {
      setProvider(cfg.provider);
      setModel(cfg.model ?? '');
      setApiKey(cfg.apiKey ?? '');
      setBaseUrl(cfg.baseUrl ?? '');
      setHasKey(!!(cfg.apiKey));
      return loadModelHistory(cfg.provider);
    }).then(setModelHistory);
    isWeeklyReminderActive().then(setWeeklyActive);
    isDailyRecoveryActive().then(setDailyActive);
    resolveBodyMassKg().then(kg => setBodyMass(String(kg)));
    getPowerZones().then(setPowerZones);
    getLongRunMinutes().then(m => setLongRunMin(String(m)));
    getLoadCapPct().then(p => setCapPct(String(p)));
    getLoadCapBasis().then(setCapBasisState);
    getUserMaxHr().then(h => setMaxHr(h > 0 ? String(h) : ''));
    getAiWeeks().then(w => setAiWeeksState(String(w)));
    loadChatPersistence().then(p => setCoachMemory(p?.memoryNote ?? ''));
    isAutoDayViewEnabled().then(setDayViewAuto);
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

  const handleRecalibrate = async () => {
    setCalibrating(true); setCalibMsg('');
    try {
      const res = await recalibrateZonesFromLastRun();
      setCalibMsg(res.updated ? '✓ Zones refined from your last run (see “Power & HR Zones” in Coaching Knowledge)' : (res.reason ?? 'Nothing to update'));
    } catch (e: any) {
      setCalibMsg('Failed: ' + (e?.message ?? 'error'));
    } finally {
      setCalibrating(false);
    }
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

  const handleSaveCapPct = async () => {
    const n = parseInt(capPct, 10);
    if (isNaN(n) || n < 5 || n > 50) {
      Alert.alert('Invalid value', 'Enter a weekly increase cap between 5 and 50 %.');
      return;
    }
    await setLoadCapPct(n);
    setCapPctSaved(true);
    setTimeout(() => setCapPctSaved(false), 2000);
  };

  const handleSaveMaxHr = async () => {
    const n = parseInt(maxHr, 10);
    if (isNaN(n) || n < 150 || n > 220) {
      Alert.alert('Invalid value', 'Enter your max HR between 150 and 220 bpm.');
      return;
    }
    await setUserMaxHr(n);
    setMaxHrSaved(true);
    setTimeout(() => setMaxHrSaved(false), 2000);
  };

  const handleSave = useCallback(async () => {
    if (validatingRef.current) return;
    Keyboard.dismiss();
    validatingRef.current = true;
    setValidating(true);
    try {
      const result = await validateLLMKey(provider, apiKey, baseUrl || undefined);
      if (!result.valid) {
        Alert.alert('Invalid API Key', result.error ?? 'Could not validate key.');
        return;
      }
      await saveLLMConfig(provider, {
        model:   model.trim() || undefined,
        apiKey:  apiKey.trim(),
        baseUrl: provider === 'custom' ? baseUrl.trim() : undefined,
      });
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
  }, [provider, apiKey, model, baseUrl]);

  const handleDelete = async () => {
    Alert.alert('Remove API Key', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive', onPress: async () => {
          await deleteLLMApiKey(provider);
          setApiKey('');
          setHasKey(false);
        },
      },
    ]);
  };

  // When user taps a provider tab — persist selection and load that provider's stored config
  const handleSwitchProvider = useCallback(async (p: LLMProvider) => {
    setProvider(p);
    await saveLLMConfig(p, {}); // persist provider selection
    // Now loadLLMConfig will return config for p
    const [cfg, hist] = await Promise.all([loadLLMConfig(), loadModelHistory(p)]);
    setModel(cfg.model ?? '');
    setApiKey(cfg.apiKey ?? '');
    setBaseUrl(cfg.baseUrl ?? '');
    setHasKey(!!(cfg.apiKey));
    setModelHistory(hist);
    setSaved(false);
  }, []);

  const handleSaveModel = useCallback(async () => {
    if (!model.trim()) return;
    await saveLLMConfig(provider, { model: model.trim() });
    const hist = await loadModelHistory(provider);
    setModelHistory(hist);
  }, [provider, model]);

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
      <View style={styles.navHeader}>
        <TouchableOpacity
          onPress={() => { if (activeCat) setActiveCat(null); else router.back(); }}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={styles.backLink}>{activeCat ? '‹ Settings' : '‹ Back'}</Text>
        </TouchableOpacity>
        <Text style={styles.navTitle}>{activeCat ? (CATEGORIES.find(x => x.id === activeCat)?.label ?? 'Settings') : 'Settings'}</Text>
        <View style={{ width: 70 }} />
      </View>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {!activeCat && (
          <View style={styles.catList}>
            {CATEGORIES.map(cat => (
              <TouchableOpacity key={cat.id} style={styles.catRow} onPress={() => setActiveCat(cat.id)}>
                <Text style={styles.catIcon}>{cat.icon}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.catLabel}>{cat.label}</Text>
                  <Text style={styles.catDesc}>{cat.desc}</Text>
                </View>
                <Text style={styles.catChevron}>›</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
        <ActiveCat.Provider value={activeCat}>

        {/* Appearance */}
        <Section title="Appearance" cat="appearance">
          <Text style={styles.fieldLabel}>Theme</Text>
          <View style={styles.themeRow}>
            {([['light', '☀️ Light'], ['dark', '🌙 Dark'], ['system', '⚙️ System']] as [ThemeMode, string][]).map(([m, lbl]) => (
              <TouchableOpacity
                key={m}
                style={[styles.themeBtn, mode === m && styles.themeBtnActive]}
                onPress={() => setMode(m)}
              >
                <Text style={[styles.themeBtnText, mode === m && styles.themeBtnTextActive]}>{lbl}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.hint}>
            {mode === 'system' ? `Following your phone (currently ${c.mode}).` : `Always ${mode}.`}
          </Text>

          <Text style={[styles.fieldLabel, { marginTop: 14 }]}>Text Size</Text>
          <View style={styles.themeRow}>
            {([[0, 'Default'], [1, 'Large'], [2, 'Larger']] as [FontSizeStep, string][]).map(([step, lbl]) => (
              <TouchableOpacity
                key={step}
                style={[styles.themeBtn, fontStep === step && styles.themeBtnActive]}
                onPress={() => setFontStep(step)}
              >
                <Text style={[
                  styles.themeBtnText,
                  fontStep === step && styles.themeBtnTextActive,
                  { fontSize: step === 0 ? 13 : step === 1 ? 15 : 17 },
                ]}>
                  {lbl}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.hint}>Enlarges text throughout the app.</Text>
        </Section>

        {/* AI Provider & Model */}
        <Section title="AI Provider & Model" cat="coaching">
          <Text style={styles.hint}>
            Keys stored securely in the iOS Keychain — never leave your device.
          </Text>

          {/* Provider tabs */}
          <View style={styles.providerTabs}>
            {(['anthropic', 'openai', 'custom'] as LLMProvider[]).map(p => (
              <TouchableOpacity
                key={p}
                style={[styles.providerTab, provider === p && styles.providerTabActive]}
                onPress={() => handleSwitchProvider(p)}
              >
                <Text style={[styles.providerTabText, provider === p && styles.providerTabTextActive]}>
                  {PROVIDER_LABELS[p]}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Model input */}
          <Text style={styles.fieldLabel}>Model</Text>
          <View style={styles.row}>
            <TextInput
              style={[styles.input, { flex: 1, marginBottom: 0 }]}
              value={model}
              onChangeText={setModel}
              onEndEditing={handleSaveModel}
              placeholder={SUGGESTED_MODELS[provider][0] ?? 'model name'}
              placeholderTextColor="#bbb"
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              returnKeyType="done"
            />
          </View>

          {/* Model chips: history + suggestions */}
          {(() => {
            const suggestions = SUGGESTED_MODELS[provider];
            const chips = [...new Set([...modelHistory, ...suggestions])].slice(0, 8);
            return chips.length > 0 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipsScroll}>
                {chips.map(m => (
                  <TouchableOpacity
                    key={m}
                    style={[styles.chip, model === m && styles.chipActive]}
                    onPress={async () => { setModel(m); await saveLLMConfig(provider, { model: m }); }}
                  >
                    <Text style={[styles.chipText, model === m && styles.chipTextActive]} numberOfLines={1}>
                      {m}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            ) : null;
          })()}

          {/* Base URL for custom providers */}
          {provider === 'custom' && (
            <>
              <Text style={[styles.fieldLabel, { marginTop: 10 }]}>Base URL</Text>
              <TextInput
                style={styles.input}
                value={baseUrl}
                onChangeText={setBaseUrl}
                placeholder="https://api.groq.com/openai/v1"
                placeholderTextColor="#bbb"
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                keyboardType="url"
                returnKeyType="done"
              />
              <Text style={styles.hint}>
                Any OpenAI-compatible endpoint (Groq, Mistral, Ollama, LM Studio, …)
              </Text>
            </>
          )}

          {/* API Key */}
          <Text style={[styles.fieldLabel, { marginTop: 10 }]}>API Key</Text>
          <TextInput
            style={[styles.input, styles.apiKeyInput]}
            value={apiKey}
            onChangeText={setApiKey}
            placeholder={PROVIDER_KEY_PLACEHOLDER[provider]}
            placeholderTextColor="#bbb"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
            secureTextEntry={false}
          />
          <View style={styles.row}>
            <TouchableOpacity
              style={[styles.btn, saved && styles.btnSuccess, validating && { opacity: 0.7 }]}
              onPress={handleSave}
              disabled={validating}
            >
              {validating
                ? <ActivityIndicator size="small" color="#fff" />
                : <Text style={styles.btnText}>{saved ? '✓ Verified & Saved' : 'Verify & Save'}</Text>
              }
            </TouchableOpacity>
            {hasKey && !validating && (
              <TouchableOpacity style={styles.btnDanger} onPress={handleDelete}>
                <Text style={styles.btnText}>Remove Key</Text>
              </TouchableOpacity>
            )}
          </View>
        </Section>

        {/* Daily recovery */}
        <Section title="Daily Recovery Notification" cat="automation">
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

        {/* Auto day view */}
        <Section title="Auto Day View" cat="automation">
          <View style={styles.switchRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.switchLabel}>Prepare automatically each morning</Text>
              <Text style={styles.switchSub}>
                When last night's sleep is fully determined, refresh all KPIs, generate the AI day view, and
                notify you it's ready. Also runs when the app detects new sleep data.
              </Text>
            </View>
            <Switch
              value={dayViewAuto}
              onValueChange={async (v) => {
                setDayViewAuto(v);
                await setAutoDayViewEnabled(v);
                if (v) await requestNotificationPermissions();
              }}
              trackColor={{ true: '#FF6B35', false: '#ccc' }}
              thumbColor="#fff"
            />
          </View>
          <TouchableOpacity
            style={[styles.btn, { marginTop: 10 }, preparing && { opacity: 0.6 }]}
            disabled={preparing}
            onPress={async () => {
              setPreparing(true);
              try {
                const r = await maybeRunDayView({ months: 3, force: true, notify: true });
                Alert.alert(
                  r.ran ? 'Day view prepared' : 'Not ready yet',
                  r.ran
                    ? `Recovery ${r.recovery}/100${r.headline ? `\n${r.headline}` : ''}\nKPIs refreshed and today's plan generated.`
                    : (r.reason === 'night not yet determined'
                        ? "Last night's sleep hasn't fully synced from Apple Health yet. Open the Health app to force a sync, then try again."
                        : 'Already prepared for today.'),
                );
              } catch (e: any) {
                Alert.alert('Prepare failed', e?.message ?? String(e));
              } finally { setPreparing(false); }
            }}
          >
            <Text style={styles.btnText}>{preparing ? 'Preparing…' : 'Prepare today’s view now'}</Text>
          </TouchableOpacity>
        </Section>

        {/* Watch complication */}
        <Section title="Watch Complication" cat="automation">
          <Text style={styles.hint}>
            Which KPI shows on your Apple Watch face. Tap the complication to open the watch app and
            swipe between all KPIs. {watchSyncAvailable() ? 'Data syncs whenever the iPhone app refreshes.' : 'Install the watch app to use this.'}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {WATCH_KPIS.map(k => {
              const active = watchKPI === k.key;
              return (
                <TouchableOpacity
                  key={k.key}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => { setWatchKPIState(k.key); setWatchKPI(k.key); }}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>{k.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Section>

        {/* Weekly coach */}
        <Section title="Weekly Coach Report" cat="coaching">
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
        <Section title="Power Zones (watts)" cat="zones">
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

          <Text style={[styles.hint, { marginTop: 14 }]}>
            HR zones (Z1–Z5) map to these watts in the editable “Power & HR Zones” coaching file.
            The coach auto-refines that map after every run; you can also trigger it now.
          </Text>
          <TouchableOpacity
            style={[styles.btn, { backgroundColor: '#2b2b2e' }]}
            onPress={handleRecalibrate}
            disabled={calibrating}
          >
            <Text style={styles.btnText}>{calibrating ? 'Analyzing last run…' : '⚙︎ Recalibrate zones from last run'}</Text>
          </TouchableOpacity>
          {calibMsg ? <Text style={[styles.hint, { marginTop: 8 }]}>{calibMsg}</Text> : null}
        </Section>

        {/* Long Run Threshold */}
        <Section title="Long Run Threshold" cat="zones">
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

        <Section title="Max Heart Rate" cat="zones">
          <Text style={styles.hint}>
            Your true max HR sets the strain zones (Bevel-style %max-HR). We can only observe a peak
            from logged runs, which under-reads it if you don't sprint — making strain read too high.
            Set your real max (e.g. a recent test, or 220−age) for accurate zones. Leave blank for auto.
          </Text>
          <View style={styles.row}>
            <TextInput
              style={[styles.input, { flex: 1, marginBottom: 0 }]}
              value={maxHr}
              onChangeText={setMaxHr}
              placeholder="auto"
              placeholderTextColor="#bbb"
              keyboardType="number-pad"
              returnKeyType="done"
            />
            <Text style={styles.unitLabel}>bpm</Text>
            <TouchableOpacity
              style={[styles.btn, maxHrSaved && styles.btnSuccess, { flex: 0, paddingHorizontal: 16 }]}
              onPress={handleSaveMaxHr}
            >
              <Text style={styles.btnText}>{maxHrSaved ? '✓ Saved' : 'Save'}</Text>
            </TouchableOpacity>
          </View>
        </Section>

        <Section title="Progression Cap" cat="zones">
          <Text style={styles.hint}>
            Limits how fast your weekly running load can grow. Default +10% per rolling 7 days (the
            classic guideline). Coming back from injury you can ramp faster — e.g. 20%. Only the REAL
            work + drills count, never warmup/cooldown/recovery or walks.
          </Text>
          <View style={styles.row}>
            <TextInput
              style={[styles.input, { flex: 1, marginBottom: 0 }]}
              value={capPct}
              onChangeText={setCapPct}
              placeholder="10"
              placeholderTextColor="#bbb"
              keyboardType="number-pad"
              returnKeyType="done"
            />
            <Text style={styles.unitLabel}>% / wk</Text>
            <TouchableOpacity
              style={[styles.btn, capPctSaved && styles.btnSuccess, { flex: 0, paddingHorizontal: 16 }]}
              onPress={handleSaveCapPct}
            >
              <Text style={styles.btnText}>{capPctSaved ? '✓ Saved' : 'Save'}</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.switchRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.switchLabel}>Cap by real-work distance</Text>
              <Text style={styles.switchSub}>
                Off = time-on-feet minutes (default). On = real-work kilometres.
              </Text>
            </View>
            <Switch
              value={capBasis === 'distance'}
              onValueChange={async (v) => {
                const b: LoadCapBasis = v ? 'distance' : 'tof';
                setCapBasisState(b);
                await setLoadCapBasis(b);
              }}
              trackColor={{ true: '#FF6B35', false: '#ccc' }}
              thumbColor="#fff"
            />
          </View>
        </Section>

        {/* AI History Depth */}
        <Section title="AI History Depth" cat="coaching">
          <Text style={styles.hint}>
            Weeks of run history included in AI prompts. More = richer context but slightly more tokens. Minimum 6 weeks.
          </Text>
          <View style={styles.row}>
            <TextInput
              style={[styles.input, { flex: 1, marginBottom: 0 }]}
              value={aiWeeks}
              onChangeText={setAiWeeksState}
              placeholder="8"
              placeholderTextColor="#bbb"
              keyboardType="number-pad"
              returnKeyType="done"
            />
            <Text style={styles.unitLabel}>weeks</Text>
            <TouchableOpacity
              style={[styles.btn, aiWeeksSaved && styles.btnSuccess, { flex: 0, paddingHorizontal: 16 }]}
              onPress={async () => {
                const n = parseInt(aiWeeks, 10);
                if (isNaN(n) || n < 6 || n > 52) {
                  Alert.alert('Invalid value', 'Enter a number between 6 and 52 weeks.');
                  return;
                }
                await setAiWeeks(n);
                setAiWeeksSaved(true);
                setTimeout(() => setAiWeeksSaved(false), 2000);
              }}
            >
              <Text style={styles.btnText}>{aiWeeksSaved ? '✓ Saved' : 'Save'}</Text>
            </TouchableOpacity>
          </View>
        </Section>

        {/* Body Weight */}
        <Section title="Body Weight" cat="profile">
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
        <Section title="Bevel Calibration" cat="zones">
          <Text style={styles.hint}>
            Import Bevel screenshots (the AI reads the values) or manually enter daily scores, to reverse-engineer scoring weights and improve RunCoach AI's algorithms.
          </Text>
          <TouchableOpacity
            style={styles.btn}
            onPress={() => router.push('/bevel-analysis' as any)}
          >
            <Text style={styles.btnText}>Calibration &amp; Analysis</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btn, { marginTop: 8 }]}
            onPress={() => router.push('/bevel-import' as any)}
          >
            <Text style={styles.btnText}>Import Bevel Screenshots</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btn, { marginTop: 8, backgroundColor: c.surfaceAlt }]}
            onPress={() => router.push('/bevel-calibration' as any)}
          >
            <Text style={[styles.btnText, { color: c.textSub }]}>Recovery Regression (legacy)</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btn, { marginTop: 8, backgroundColor: '#1a1a2e' }]}
            onPress={() => router.push('/debug' as any)}
          >
            <Text style={[styles.btnText, { color: '#8888aa' }]}>HR Debug Screen</Text>
          </TouchableOpacity>
        </Section>

        <Section title="Backup & Restore" cat="data">
          <Text style={styles.hint}>
            Save all your settings — theme, AI provider/keys, training thresholds, coaching memory, Bevel
            calibration and every coaching-knowledge file — to one file you can store or move to another device.
            The backup contains your API keys; keep it private.
          </Text>
          <TouchableOpacity
            style={styles.btn}
            onPress={async () => {
              try {
                const json = await exportAllSettings(true);
                const uri = `${FileSystem.cacheDirectory}runcoach-settings-backup.json`;
                await FileSystem.writeAsStringAsync(uri, json);
                if (await Sharing.isAvailableAsync()) {
                  await Sharing.shareAsync(uri, { mimeType: 'application/json', dialogTitle: 'RunCoachAI settings backup' });
                } else {
                  await Clipboard.setStringAsync(json);
                  Alert.alert('Copied', 'Sharing unavailable — backup copied to clipboard.');
                }
              } catch (e: any) { Alert.alert('Backup failed', e?.message ?? String(e)); }
            }}
          >
            <Text style={styles.btnText}>Back Up All Settings</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btn, { marginTop: 8, backgroundColor: c.surfaceAlt }]}
            onPress={async () => {
              const json = await Clipboard.getStringAsync();
              if (!json) { Alert.alert('Clipboard empty', 'Copy a backup file\'s contents first, then restore.'); return; }
              Alert.alert(
                'Restore from clipboard',
                'This overwrites your current settings with the backup in your clipboard. Continue?',
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Restore', style: 'destructive', onPress: async () => {
                    try {
                      const r = await restoreAllSettings(json);
                      Alert.alert('Restored', `${r.secure} settings, ${r.files} data files, ${r.knowledge} coaching files restored. Restart the app to apply everything.`);
                    } catch (e: any) { Alert.alert('Restore failed', e?.message ?? String(e)); }
                  } },
                ],
              );
            }}
          >
            <Text style={[styles.btnText, { color: c.textSub }]}>Restore from Clipboard</Text>
          </TouchableOpacity>
        </Section>

        <Section title="Coaching Knowledge" cat="coaching">
          <Text style={styles.hint}>
            The coach's rules and references live in editable files that are fed into its prompt — tune the rules,
            list your preferred strength exercises and pre-run drills, set a weekly schedule, or add your own.
            Import/export each file or let the AI enhance it.
          </Text>
          <TouchableOpacity
            style={styles.btn}
            onPress={() => router.push('/coach-knowledge' as any)}
          >
            <Text style={styles.btnText}>Manage Coaching Files</Text>
          </TouchableOpacity>
        </Section>

        {/* Model info */}
        {/* Coaching Memory */}
        <Section title="Coaching Memory" cat="coaching">
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


        {/* Export */}
        <Section title="Data Export" cat="data">
          <Text style={styles.hint}>
            Export your complete health snapshot as JSON for analysis or backup.
            Load the main screen first to ensure data is fresh.
          </Text>
          <TouchableOpacity
            style={[styles.btn, exporting && { opacity: 0.6 }]}
            disabled={exporting}
            onPress={async () => {
              setExporting(true);
              try {
                const snap = await loadSnapshotCache();
                if (!snap) {
                  Alert.alert('No data', 'Open the main screen first so a snapshot is cached.');
                  return;
                }
                const filename = `runcoach-snapshot-${new Date().toISOString().split('T')[0]}.json`;
                const path = `${FileSystem.cacheDirectory}${filename}`;
                await FileSystem.writeAsStringAsync(path, JSON.stringify(snap, null, 2));
                await Sharing.shareAsync(path, { mimeType: 'application/json', UTI: 'public.json' });
              } catch (err: any) {
                Alert.alert('Export failed', err.message);
              } finally {
                setExporting(false);
              }
            }}
          >
            {exporting
              ? <ActivityIndicator size="small" color="#fff" />
              : <Text style={styles.btnText}>↑  Export snapshot</Text>}
          </TouchableOpacity>
        </Section>

        {/* Data info */}
        <Section title="Data & Privacy" cat="data">
          <Text style={styles.hint}>
            RunCoach AI reads Apple Health data directly on your device.{'\n\n'}
            Your health data is sent to Anthropic's API only when you request a coaching report. Anthropic does not use API data to train models.{'\n\n'}
            No data is stored on any server. Your API key stays in the iOS Keychain.
          </Text>
        </Section>
        </ActiveCat.Provider>

      </ScrollView>
    </SafeAreaView>
  );
}

// Settings hierarchy: a landing list of categories → each opens only its own sections.
const ActiveCat = React.createContext<string | null>(null);

const CATEGORIES: { id: string; label: string; icon: string; desc: string }[] = [
  { id: 'coaching',   label: 'Coaching & AI',              icon: '🧠', desc: 'Provider, knowledge, memory, reports, history depth' },
  { id: 'zones',      label: 'Zones & Training',           icon: '🏃', desc: 'Power zones, long-run threshold, Bevel calibration' },
  { id: 'automation', label: 'Notifications & Automation', icon: '🔔', desc: 'Daily recovery alert, auto day view' },
  { id: 'profile',    label: 'Profile',                    icon: '👤', desc: 'Body weight' },
  { id: 'appearance', label: 'Appearance',                 icon: '🎨', desc: 'Theme & text size' },
  { id: 'data',       label: 'Data & Backup',              icon: '💾', desc: 'Backup/restore, export, privacy' },
];

function Section({ title, cat, children }: { title: string; cat?: string; children: React.ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  const active = React.useContext(ActiveCat);
  if (cat && active !== cat) return null; // hidden until its category is opened
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  navHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border,
  },
  navTitle: { fontSize: 17, fontWeight: '700', color: c.text },
  backLink: { fontSize: 16, color: c.accent, fontWeight: '600', width: 70 },
  catList: { gap: 10, marginBottom: 8 },
  catRow: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    padding: 16, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceAlt,
  },
  catIcon: { fontSize: 24 },
  catLabel: { fontSize: 16, fontWeight: '600', color: c.text },
  catDesc: { fontSize: 12, color: c.textSub, marginTop: 2 },
  catChevron: { fontSize: 22, color: c.textSub, fontWeight: '300' },
  themeRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  themeBtn: { flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: c.border, alignItems: 'center', backgroundColor: c.surfaceAlt },
  themeBtnActive: { backgroundColor: c.accent, borderColor: c.accent },
  themeBtnText: { fontSize: 13, fontWeight: '600', color: c.textSub },
  themeBtnTextActive: { color: c.onAccent },
  scroll: { padding: 16, paddingBottom: 40 },
  section: { marginBottom: 20 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: c.textSub,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
    marginLeft: 4,
  },
  sectionBody: {
    backgroundColor: c.surface,
    borderRadius: 12,
    padding: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: c.shadowOpacity,
    shadowRadius: 3,
    elevation: 2,
  },
  hint: { fontSize: 13, color: c.textSub, lineHeight: 20, marginBottom: 12 },
  input: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: c.text,
    backgroundColor: c.surfaceAlt,
    marginBottom: 10,
  },
  row: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  unitLabel: { fontSize: 14, color: c.textSub, fontWeight: '600' },
  btn: {
    flex: 1,
    backgroundColor: c.accent,
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
  switchLabel: { fontSize: 14, color: c.text, fontWeight: '600', marginBottom: 2 },
  switchSub: { fontSize: 12, color: c.textFaint },
  pzRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  pzLabel: { fontSize: 13, color: c.textSub, fontWeight: '600', width: 106 },
  pzInput: { flex: 1, marginBottom: 0, paddingVertical: 8, textAlign: 'center', minWidth: 52 },
  pzUnit: { fontSize: 13, color: c.textSub, fontWeight: '600', minWidth: 12 },
  apiKeyInput: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
    letterSpacing: 0.3,
  },
  // Provider tabs
  providerTabs: {
    flexDirection: 'row', gap: 6, marginBottom: 14,
  },
  providerTab: {
    flex: 1, paddingVertical: 7, borderRadius: 8,
    backgroundColor: c.surfaceAlt, alignItems: 'center',
  },
  providerTabActive: {
    backgroundColor: c.accent,
  },
  providerTabText: { fontSize: 12, fontWeight: '600', color: c.textSub },
  providerTabTextActive: { color: '#fff' },
  // Field label
  fieldLabel: { fontSize: 12, fontWeight: '700', color: c.textSub, marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.3 },
  // Model chips
  chipsScroll: { marginTop: 6, marginBottom: 4 },
  chip: {
    borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5,
    backgroundColor: c.surfaceAlt, marginRight: 6,
    borderWidth: 1, borderColor: c.border,
  },
  chipActive: { backgroundColor: '#FF6B3522', borderColor: '#FF6B35' },
  chipText: { fontSize: 11, color: c.textSub, fontWeight: '600' },
  chipTextActive: { color: '#FF6B35' },
});
