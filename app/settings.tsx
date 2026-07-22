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
  getUserMaxHr, setMaxHrRecalcAll, setMaxHrFromNow, getMaxHrHistory, setOnboardingDone,
} from '../src/services/claude';
import {
  loadLLMConfig, saveLLMConfig, deleteLLMApiKey, validateLLMKey,
  loadModelHistory, PROVIDER_LABELS, PROVIDER_KEY_PLACEHOLDER, SUGGESTED_MODELS,
  fetchAvailableModels, loadModelList, LLMProvider,
} from '../src/services/llm';
import { getAgenticMode, setAgenticMode } from '../src/services/agent';
import { PowerZones } from '../src/types';
import { recalibrateZonesFromLastRun } from '../src/services/zones';
import { WATCH_KPIS, getWatchKPI, setWatchKPI, watchSyncAvailable } from '../src/services/watchSync';
import { useTheme, useThemedStyles, Palette, ThemeMode, FontSizeStep, ACCENT_OPTIONS } from '../src/theme';
import { resolveBodyMassKg, loadSnapshotCache, fetchHealthSnapshot, saveSnapshotCache } from '../src/services/healthkit';
import { loadScanTimings, loadAutoTimings } from '../src/services/perf';
import { computeWorkoutLoad } from '../src/services/trainingLoad';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useRouter, useNavigation } from 'expo-router';
import { clearWorkoutCache } from '../src/services/workoutClassifier';
import { loadChatPersistence, saveChatPersistence, clearChatPersistence } from '../src/services/chatMemory';
import * as Clipboard from 'expo-clipboard';
import { exportAllSettings, restoreAllSettings } from '../src/services/backup';
import { buildDebugExportJson, buildDebugSections } from '../src/services/debugExport';
import { shareJson } from '../src/shareJson';
import { connectDrive, disconnectDrive, isDriveConnected, uploadDebugSections } from '../src/services/googleDrive';
import { isAutoDayViewEnabled, setAutoDayViewEnabled, maybeRunDayView } from '../src/services/dayUpdate';
import { getLoadCapPct, setLoadCapPct, getLoadCapBasis, setLoadCapBasis, DEFAULT_LOAD_CAP_PCT, LoadCapBasis, getMinTSB, setMinTSB, DEFAULT_MIN_TSB, getCoachingMode, setCoachingMode, CoachingMode, getPeriodization, setPeriodization, clearTodayPlanCache, assembleCoachSnapshot, loadCachedPlan, loadWeekPlanCache, getShrinkToFit, getLongRunStyle, setLongRunStyle, LongRunStyle, getWorkoutStructure, setWorkoutStructure, getHeatSensitivity, setHeatSensitivity, getMaxRunDays, setMaxRunDays, DEFAULT_MAX_RUN_DAYS } from '../src/services/coach';
import { readKnowledgeContent } from '../src/services/coachFiles';
import { getPlanMode, setPlanMode, getRaceConfig, setRaceConfig, PlanMode } from '../src/services/racePlan';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Picker } from '@react-native-picker/picker';
import { getAccountingMode, setAccountingMode, AccountingMode } from '../src/services/accounting';
import {
  scheduleWeeklyCoachReminder,
  cancelWeeklyCoachReminder,
  isWeeklyReminderActive,
  requestNotificationPermissions,
} from '../src/services/notifications';

export default function SettingsScreen() {
  const router = useRouter();
  const { mode, setMode, c, accent, setAccent, fontStep, setFontStep } = useTheme();
  const styles = useThemedStyles(makeStyles);

  // ── LLM config ──────────────────────────────────────────────────────────────
  const [provider,      setProvider]      = useState<LLMProvider>('anthropic');
  const [model,         setModel]         = useState('');
  const [apiKey,        setApiKey]        = useState('');
  const [baseUrl,       setBaseUrl]       = useState('');
  const [modelHistory,  setModelHistory]  = useState<string[]>([]);
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);   // live list from provider /v1/models
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [agentic,       setAgentic]       = useState(false);          // agentic (tool-using) coach
  const [hasKey,        setHasKey]        = useState(false);
  const [saved,         setSaved]         = useState(false);
  const [validating,    setValidating]    = useState(false);
  const validatingRef = useRef(false);

  const [weeklyActive, setWeeklyActive] = useState(false);
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
  const [heatSens, setHeatSens] = useState('1.5');
  const [heatSensSaved, setHeatSensSaved] = useState(false);
  const [maxRunDays, setMaxRunDaysStr] = useState(String(DEFAULT_MAX_RUN_DAYS));
  const [maxRunDaysSaved, setMaxRunDaysSaved] = useState(false);
  const [minTsb, setMinTsb] = useState(String(DEFAULT_MIN_TSB));
  const [minTsbSaved, setMinTsbSaved] = useState(false);
  const [capBasis, setCapBasisState] = useState<LoadCapBasis>('tof');
  const [periodOn, setPeriodOn] = useState(true);
  const [buildW, setBuildW]     = useState('3');
  const [deloadW, setDeloadW]   = useState('1');
  const [dropPct, setDropPct]   = useState('25');
  const [periodSaved, setPeriodSaved] = useState(false);
  const [anchor, setAnchor] = useState('');
  const [planMode, setPlanModeState] = useState<PlanMode>('leisure');
  const [raceDateObj, setRaceDateObj] = useState<Date>(() => { const d = new Date(); d.setDate(d.getDate() + 56); d.setHours(0, 0, 0, 0); return d; });
  const [raceDist, setRaceDist]   = useState('10');
  const [goalH, setGoalH] = useState(0);   // deterministic H : M : S goal — no MM:SS / HH:MM ambiguity
  const [goalM, setGoalM] = useState(45);
  const [goalS, setGoalS] = useState(0);
  const [raceSaved, setRaceSaved] = useState(false);
  const [accMode, setAccModeState] = useState<AccountingMode>('work');
  const [coachMode, setCoachModeState] = useState<CoachingMode>('self');
  const [longRunStyle, setLongRunStyleState] = useState<LongRunStyle>('long');
  const [warmupM, setWarmupM] = useState('');
  const [cooldownM, setCooldownM] = useState('');
  const [drillsMin, setDrillsMin] = useState('4');
  const [structSaved, setStructSaved] = useState(false);
  const [maxHr, setMaxHr] = useState('');
  const [maxHrSaved, setMaxHrSaved] = useState(false);
  const [aiWeeks, setAiWeeksState] = useState(String(DEFAULT_AI_WEEKS));
  const [aiWeeksSaved, setAiWeeksSaved] = useState(false);
  const [coachMemory, setCoachMemory] = useState('');
  const [memorySaved, setMemorySaved] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [dumping, setDumping] = useState(false);
  const [driveConnected, setDriveConnected] = useState(false);
  const [driveBusy, setDriveBusy] = useState(false);
  const [refreshingAll, setRefreshingAll] = useState(false);
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
      loadModelList(cfg.provider).then(setFetchedModels).catch(() => {});
      return loadModelHistory(cfg.provider);
    }).then(setModelHistory);
    getAgenticMode().then(setAgentic);
    isWeeklyReminderActive().then(setWeeklyActive);
    resolveBodyMassKg().then(kg => setBodyMass(String(kg)));
    getPowerZones().then(setPowerZones);
    getLongRunMinutes().then(m => setLongRunMin(String(m)));
    getLoadCapPct().then(p => setCapPct(String(p)));
    getHeatSensitivity().then(h => setHeatSens(String(h)));
    getMaxRunDays().then(d => setMaxRunDaysStr(String(d)));
    isDriveConnected().then(setDriveConnected).catch(() => {});
    getMinTSB().then(v => setMinTsb(String(v)));
    getLoadCapBasis().then(setCapBasisState);
    getPeriodization().then(p => { setPeriodOn(p.on); setBuildW(String(p.buildWeeks)); setDeloadW(String(p.deloadWeeks)); setDropPct(String(p.deloadDropPct)); setAnchor(p.anchor); });
    getPlanMode().then(setPlanModeState);
    getRaceConfig().then(r => {
      if (r.date) { const d = new Date(r.date + 'T00:00:00'); if (!isNaN(d.getTime())) setRaceDateObj(d); }
      setRaceDist(String(r.distanceKm));
      setGoalH(Math.floor(r.goalTimeSec / 3600)); setGoalM(Math.floor((r.goalTimeSec % 3600) / 60)); setGoalS(r.goalTimeSec % 60);
    });
    getAccountingMode().then(setAccModeState);
    getCoachingMode().then(setCoachModeState);
    getLongRunStyle().then(setLongRunStyleState);
    getWorkoutStructure().then(st => {
      setWarmupM(st.warmupMeters > 0 ? String(st.warmupMeters) : '');
      setCooldownM(st.cooldownMeters > 0 ? String(st.cooldownMeters) : '');
      setDrillsMin(String(st.drillsMinutes));
    });
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
      // Pull the refined watts straight back into the inputs above. Recalibration writes both the
      // coaching file AND getPowerZones, but this screen read them on mount — so the fields kept showing
      // the pre-calibration numbers until you navigated away and back.
      if (res.updated) await getPowerZones().then(setPowerZones).catch(() => {});
      setCalibMsg(res.updated ? '✓ Zones refined from your last run — values above updated' : (res.reason ?? 'Nothing to update'));
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

  const handleSaveHeatSens = async () => {
    const v = parseFloat(heatSens.replace(',', '.'));
    if (isNaN(v) || v < 0.5 || v > 2.5) {
      Alert.alert('Invalid value', 'Enter a heat sensitivity between 0.5 (heat-tolerant) and 2.5 (very sensitive).');
      return;
    }
    await setHeatSensitivity(v);
    await clearTodayPlanCache().catch(() => {});   // heat feeds today's plan → recompute
    setHeatSensSaved(true);
    setTimeout(() => setHeatSensSaved(false), 2000);
  };

  const handleSaveMaxRunDays = async () => {
    const n = parseInt(maxRunDays, 10);
    if (isNaN(n) || n < 1 || n > 7) {
      Alert.alert('Invalid value', 'Enter a max running days per week between 1 and 7.');
      return;
    }
    await setMaxRunDays(n);
    setMaxRunDaysSaved(true);
    setTimeout(() => setMaxRunDaysSaved(false), 2000);
  };

  const handleSavePeriod = async (on?: boolean) => {
    const bw = parseInt(buildW, 10), dw = parseInt(deloadW, 10), dp = parseInt(dropPct, 10);
    if ([bw, dw, dp].some(isNaN)) { Alert.alert('Invalid value', 'Enter whole numbers for build weeks, deload weeks and the drop %.'); return; }
    const a = anchor.trim();
    if (a && isNaN(new Date(a + 'T00:00:00').getTime())) { Alert.alert('Invalid date', 'Cycle start must be YYYY-MM-DD (or leave blank for the default).'); return; }
    await setPeriodization({ on: on ?? periodOn, buildWeeks: bw, deloadWeeks: dw, deloadDropPct: dp, anchor: a });
    setPeriodSaved(true); setTimeout(() => setPeriodSaved(false), 2000);
  };

  const handleToggleMode = async (race: boolean) => {
    const m: PlanMode = race ? 'race' : 'leisure';
    setPlanModeState(m); await setPlanMode(m); await clearTodayPlanCache();
  };
  const handleSaveRace = async () => {
    const dist = parseFloat(raceDist);
    if (isNaN(dist) || dist < 1 || dist > 200) { Alert.alert('Invalid distance', 'Enter the race distance in km, e.g. 10, 21.1, 42.2.'); return; }
    const p = (n: number) => String(n).padStart(2, '0');
    const dateISO = `${raceDateObj.getFullYear()}-${p(raceDateObj.getMonth() + 1)}-${p(raceDateObj.getDate())}`;
    const goalSec = goalH * 3600 + goalM * 60 + goalS;
    await setRaceConfig({ date: dateISO, distanceKm: dist, goalTimeSec: goalSec });
    await clearTodayPlanCache();
    setRaceSaved(true); setTimeout(() => setRaceSaved(false), 2000);
  };

  const handleSaveMinTsb = async () => {
    const n = parseInt(minTsb, 10);
    if (isNaN(n) || n < -40 || n > 0) {
      Alert.alert('Invalid value', 'Enter a minimum TSB between −40 and 0 (e.g. −10).');
      return;
    }
    await setMinTSB(n);
    setMinTsbSaved(true);
    setTimeout(() => setMinTsbSaved(false), 2000);
  };

  const handleSaveStructure = async () => {
    const pm = (s: string) => { const v = parseInt(s, 10); return isNaN(v) || v < 0 ? 0 : v; };  // blank / <0 → 0 = open
    const wu = pm(warmupM), cd = pm(cooldownM), dr = pm(drillsMin);
    await setWorkoutStructure({ warmupMeters: wu, cooldownMeters: cd, drillsMinutes: dr });
    // Invalidate today's cached plan so its watch workout regenerates with the new wrapper immediately,
    // instead of the change only showing on the next day's plan.
    await clearTodayPlanCache().catch(() => {});
    setWarmupM(wu > 0 ? String(wu) : ''); setCooldownM(cd > 0 ? String(cd) : ''); setDrillsMin(String(dr));
    setStructSaved(true); setTimeout(() => setStructSaved(false), 1500);
  };

  const handleSaveMaxHr = async () => {
    const n = parseInt(maxHr, 10);
    if (isNaN(n) || n < 150 || n > 220) {
      Alert.alert('Invalid value', 'Enter your max HR between 150 and 220 bpm.');
      return;
    }
    const flash = () => { setMaxHrSaved(true); setTimeout(() => setMaxHrSaved(false), 2000); };
    // Max HR rescales every past day's training load (Banister TRIMP is exponential in %HRR). Ask
    // whether to correct the whole history at the new value, or apply it from today forward.
    const prev = await getUserMaxHr();
    if (prev === n && (await getMaxHrHistory()).length === 0) { flash(); return; } // no change
    Alert.alert(
      `Set max HR to ${n} bpm`,
      'This changes how every past day\'s training load is scored.\n\n• Recalculate history — re-score all past days at the new max (use when correcting a wrong value).\n• From now on — keep past days on the old max, apply the new one going forward (use if your max genuinely changed).',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'From now on', onPress: async () => { await setMaxHrFromNow(n); flash(); } },
        { text: 'Recalculate history', onPress: async () => { await setMaxHrRecalcAll(n); flash(); } },
      ],
    );
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
    loadModelList(p).then(setFetchedModels).catch(() => {});
    setSaved(false);
  }, []);

  // Fetch the provider's live model list from /v1/models (the "Refresh" button).
  const handleRefreshModels = useCallback(async () => {
    setRefreshingModels(true);
    try {
      const list = await fetchAvailableModels(provider, apiKey.trim() || undefined, baseUrl.trim() || undefined);
      setFetchedModels(list);
      Alert.alert('Models updated', list.length ? `Found ${list.length} models for ${PROVIDER_LABELS[provider]}.` : 'No models returned.');
    } catch (e: any) {
      Alert.alert('Could not refresh models', e?.message ?? 'Unknown error.');
    } finally {
      setRefreshingModels(false);
    }
  }, [provider, apiKey, baseUrl]);

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
          <Text style={styles.backLink} numberOfLines={1}>{activeCat ? '‹ Settings' : '‹ Back'}</Text>
        </TouchableOpacity>
        <Text style={styles.navTitle}>{activeCat ? (CATEGORIES.find(x => x.id === activeCat)?.label ?? 'Settings') : 'Settings'}</Text>
        <View style={{ width: 96 }} />
      </View>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets keyboardDismissMode="interactive">
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

          <Text style={[styles.fieldLabel, { marginTop: 14 }]}>Accent Colour</Text>
          <View style={styles.swatchRow}>
            {ACCENT_OPTIONS.map(col => (
              <TouchableOpacity
                key={col}
                style={[styles.swatch, { backgroundColor: col }, accent === col && styles.swatchActive]}
                onPress={() => setAccent(col)}
                accessibilityLabel={`Accent ${col}`}
              >
                {accent === col && <Text style={styles.swatchCheck}>✓</Text>}
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.hint}>Recolours buttons, links and highlights across the whole app.</Text>
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
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={styles.fieldLabel}>Model</Text>
            <TouchableOpacity onPress={handleRefreshModels} disabled={refreshingModels} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={{ color: c.accent, fontWeight: '600', fontSize: 13 }}>
                {refreshingModels ? 'Refreshing…' : `↻ Refresh models${fetchedModels.length ? ` (${fetchedModels.length})` : ''}`}
              </Text>
            </TouchableOpacity>
          </View>
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

          {/* Model chips: live fetched list + history + suggestions */}
          {(() => {
            const suggestions = SUGGESTED_MODELS[provider];
            const chips = [...new Set([...fetchedModels, ...modelHistory, ...suggestions])].slice(0, 15);
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

          {/* Agentic (tool-using) coach */}
          <View style={[styles.switchRow, { marginTop: 14 }]}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={styles.switchLabel}>Agentic coach (tools)</Text>
              <Text style={styles.switchSub}>
                Lets the coach pull specific runs & metrics on demand for deeper answers in Chat and Run Analysis. Anthropic only — slower and uses more tokens.
              </Text>
            </View>
            <Switch
              value={agentic}
              onValueChange={async (v) => { setAgentic(v); await setAgenticMode(v); }}
              trackColor={{ true: c.accent, false: c.switchTrack }} ios_backgroundColor={c.switchTrack}
              thumbColor="#fff"
            />
          </View>

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
            secureTextEntry
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

        {/* Auto day view — the single morning control (the old fixed-7:30 reminder is retired). */}
        <Section title="Auto Day View" cat="automation">
          <View style={styles.switchRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.switchLabel}>Prepare when sleep data lands</Text>
              <Text style={styles.switchSub}>
                No fixed time — when last night's sleep is fully determined (end your sleep in Apple Health),
                the app refreshes all KPIs, computes today's plan, pushes the workout to your watch, then
                notifies you it's ready. Tap the notification for the coach page; AI notes are on request there.
              </Text>
            </View>
            <Switch
              value={dayViewAuto}
              onValueChange={async (v) => {
                setDayViewAuto(v);
                await setAutoDayViewEnabled(v);
                if (v) await requestNotificationPermissions();
              }}
              trackColor={{ true: c.accent, false: c.switchTrack }} ios_backgroundColor={c.switchTrack}
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
              trackColor={{ true: c.accent, false: c.switchTrack }} ios_backgroundColor={c.switchTrack}
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

        <Section title="Long Run Style" cat="zones">
          <Text style={styles.hint}>
            How a scheduled long run is delivered. Splitting keeps the aerobic volume with less heat &amp;
            injury load, but a continuous long run builds more race-specific durability.
          </Text>
          <View style={styles.providerTabs}>
            {([['long', 'Whole'], ['auto', 'Auto'], ['optin', 'Opt-in']] as [LongRunStyle, string][]).map(([v, label]) => (
              <TouchableOpacity
                key={v}
                style={[styles.providerTab, longRunStyle === v && styles.providerTabActive]}
                onPress={async () => { setLongRunStyleState(v); await setLongRunStyle(v); }}
              >
                <Text style={[styles.providerTabText, longRunStyle === v && styles.providerTabTextActive]}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.hint}>
            {longRunStyle === 'long'  ? 'Always one continuous long run (never split).'
             : longRunStyle === 'auto' ? 'Coach may split it on hot, low-readiness, or over-budget days — never in a race peak.'
             : 'Only split when you turn it on for that day (a toggle appears on the Daily Coach on long-run days).'}
          </Text>
        </Section>

        <Section title="Workout Structure" cat="zones">
          <Text style={styles.hint}>
            The warm-up, cool-down and drills that wrap every prescribed run — on the watch and in the plan.
            Leave warm-up / cool-down blank for an OPEN goal (you end it yourself with the lap button); or enter
            a distance in metres. Drills is a short form-work block after the warm-up (0 to skip).
          </Text>
          <View style={styles.row}>
            <Text style={[styles.hint, { flex: 1, marginBottom: 0 }]}>Warm-up</Text>
            <TextInput
              style={[styles.input, { width: 96, marginBottom: 0, textAlign: 'right' }]}
              value={warmupM} onChangeText={setWarmupM}
              placeholder="open" placeholderTextColor="#bbb" keyboardType="number-pad" returnKeyType="done"
            />
            <Text style={styles.unitLabel}>m</Text>
          </View>
          <View style={styles.row}>
            <Text style={[styles.hint, { flex: 1, marginBottom: 0 }]}>Cool-down</Text>
            <TextInput
              style={[styles.input, { width: 96, marginBottom: 0, textAlign: 'right' }]}
              value={cooldownM} onChangeText={setCooldownM}
              placeholder="open" placeholderTextColor="#bbb" keyboardType="number-pad" returnKeyType="done"
            />
            <Text style={styles.unitLabel}>m</Text>
          </View>
          <View style={styles.row}>
            <Text style={[styles.hint, { flex: 1, marginBottom: 0 }]}>Drills</Text>
            <TextInput
              style={[styles.input, { width: 96, marginBottom: 0, textAlign: 'right' }]}
              value={drillsMin} onChangeText={setDrillsMin}
              placeholder="4" placeholderTextColor="#bbb" keyboardType="number-pad" returnKeyType="done"
            />
            <Text style={styles.unitLabel}>min</Text>
          </View>
          <TouchableOpacity
            style={[styles.btn, structSaved && styles.btnSuccess, { marginTop: 12 }]}
            onPress={handleSaveStructure}
          >
            <Text style={styles.btnText}>{structSaved ? '✓ Saved' : 'Save'}</Text>
          </TouchableOpacity>
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
          <Text style={styles.hint}>
            Minimum form (TSB): the 7-day forecast trims any session that would push your projected TSB
            below this. Default −10; more negative allows deeper fatigue.
          </Text>
          <View style={styles.row}>
            <TextInput
              style={[styles.input, { flex: 1, marginBottom: 0 }]}
              value={minTsb}
              onChangeText={setMinTsb}
              placeholder="-10"
              placeholderTextColor="#bbb"
              keyboardType="numbers-and-punctuation"
              returnKeyType="done"
            />
            <Text style={styles.unitLabel}>min TSB</Text>
            <TouchableOpacity
              style={[styles.btn, minTsbSaved && styles.btnSuccess, { flex: 0, paddingHorizontal: 16 }]}
              onPress={handleSaveMinTsb}
            >
              <Text style={styles.btnText}>{minTsbSaved ? '✓ Saved' : 'Save'}</Text>
            </TouchableOpacity>
          </View>
          <View style={{ marginTop: 4 }}>
            <Text style={styles.switchLabel}>Progression basis</Text>
            <Text style={styles.switchSub}>
              What the weekly +cap% grows. Minutes = time-on-feet (default). TRIMP = Banister load, so a
              session's intensity &amp; recovery type count — the quality dose ramps on load and shows on the
              Daily Coach; minutes stay a volume guardrail. Distance = real-work km.
            </Text>
            <View style={[styles.providerTabs, { marginTop: 8 }]}>
              {([['tof', 'Minutes'], ['trimp', 'TRIMP'], ['distance', 'Distance']] as [LoadCapBasis, string][]).map(([v, label]) => (
                <TouchableOpacity
                  key={v}
                  style={[styles.providerTab, capBasis === v && styles.providerTabActive]}
                  onPress={async () => { setCapBasisState(v); await setLoadCapBasis(v); }}
                >
                  <Text style={[styles.providerTabText, capBasis === v && styles.providerTabTextActive]}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
          <View style={styles.switchRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.switchLabel}>Count the full workout as volume</Text>
              <Text style={styles.switchSub}>
                Off = work + drills only (default). On = the whole run — warm-up &amp; cool-down included —
                for when those become real running. Only affects NEW runs; past runs keep how they were
                counted. (Strain &amp; CTL/ATL are unaffected — already HR-based over the full workout.)
              </Text>
            </View>
            <Switch
              value={accMode === 'full'}
              onValueChange={async (v) => {
                const m: AccountingMode = v ? 'full' : 'work';
                setAccModeState(m);
                await setAccountingMode(m);
              }}
              trackColor={{ true: c.accent, false: c.switchTrack }} ios_backgroundColor={c.switchTrack}
              thumbColor="#fff"
            />
          </View>
        </Section>

        {/* Weekly volume shape */}
        <Section title="Weekly Volume" cat="zones">
          <Text style={styles.hint}>
            Max running days per week. The coach fits your quality sessions (intervals / tempo / long)
            first, then fills easy volume up to this many days — so lowering it concentrates the week into
            fewer, more meaningful runs instead of a short jog every day. Default 5.
          </Text>
          <View style={styles.row}>
            <TextInput
              style={[styles.input, { flex: 1, marginBottom: 0 }]}
              value={maxRunDays}
              onChangeText={setMaxRunDaysStr}
              placeholder="5"
              placeholderTextColor="#bbb"
              keyboardType="number-pad"
              returnKeyType="done"
            />
            <Text style={styles.unitLabel}>days / wk</Text>
            <TouchableOpacity
              style={[styles.btn, maxRunDaysSaved && styles.btnSuccess, { flex: 0, paddingHorizontal: 16 }]}
              onPress={handleSaveMaxRunDays}
            >
              <Text style={styles.btnText}>{maxRunDaysSaved ? '✓ Saved' : 'Save'}</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.hint}>
            Heat sensitivity — how hard warm/humid weather scales your runs down. 1.0 = the baseline model;
            higher = a bigger cut in the heat (you run heavy in the heat, so the default is 1.5). Lower it
            if you tolerate heat well. Affects the daily plan + the 7-day forecast.
          </Text>
          <View style={styles.row}>
            <TextInput
              style={[styles.input, { flex: 1, marginBottom: 0 }]}
              value={heatSens}
              onChangeText={setHeatSens}
              placeholder="1.5"
              placeholderTextColor="#bbb"
              keyboardType="decimal-pad"
              returnKeyType="done"
            />
            <Text style={styles.unitLabel}>× heat</Text>
            <TouchableOpacity
              style={[styles.btn, heatSensSaved && styles.btnSuccess, { flex: 0, paddingHorizontal: 16 }]}
              onPress={handleSaveHeatSens}
            >
              <Text style={styles.btnText}>{heatSensSaved ? '✓ Saved' : 'Save'}</Text>
            </TouchableOpacity>
          </View>
        </Section>

        {/* Periodization */}
        <Section title="Periodization" cat="zones">
          <Text style={styles.hint}>
            Instead of growing forever, build for a set number of weeks then take a lighter DELOAD week
            (lower volume) so you recover and absorb the training — the build then resumes from where it
            was, not the trough. All adjustable; safe defaults 3 build / 1 deload / −25%.
          </Text>
          <View style={styles.switchRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.switchLabel}>Periodize training load</Text>
              <Text style={styles.switchSub}>Off = the cap ramps continuously. On = build/deload cycles (default).</Text>
            </View>
            <Switch
              value={periodOn}
              onValueChange={(v) => { setPeriodOn(v); handleSavePeriod(v); }}
              trackColor={{ true: c.accent, false: c.switchTrack }} ios_backgroundColor={c.switchTrack}
              thumbColor="#fff"
            />
          </View>
          <View style={styles.row}>
            <TextInput style={[styles.input, { flex: 1, marginBottom: 0 }]} value={buildW} onChangeText={setBuildW}
              placeholder="3" placeholderTextColor="#bbb" keyboardType="number-pad" returnKeyType="done" />
            <Text style={styles.unitLabel}>build wks</Text>
          </View>
          <View style={styles.row}>
            <TextInput style={[styles.input, { flex: 1, marginBottom: 0 }]} value={deloadW} onChangeText={setDeloadW}
              placeholder="1" placeholderTextColor="#bbb" keyboardType="number-pad" returnKeyType="done" />
            <Text style={styles.unitLabel}>deload wks</Text>
          </View>
          <View style={styles.row}>
            <TextInput style={[styles.input, { flex: 1, marginBottom: 0 }]} value={dropPct} onChangeText={setDropPct}
              placeholder="25" placeholderTextColor="#bbb" keyboardType="number-pad" returnKeyType="done" />
            <Text style={styles.unitLabel}>% drop</Text>
          </View>
          <Text style={styles.hint}>
            Cycle start (optional): the week that becomes Build 1. Blank = calendar default. Tap "This wk"
            to align the cycle to this week.
          </Text>
          <View style={styles.row}>
            <TextInput style={[styles.input, { flex: 1, marginBottom: 0 }]} value={anchor} onChangeText={setAnchor}
              placeholder="YYYY-MM-DD (blank = default)" placeholderTextColor="#bbb" autoCapitalize="none" autoCorrect={false} returnKeyType="done" />
            <TouchableOpacity style={[styles.btn, { flex: 0, paddingHorizontal: 12 }]}
              onPress={() => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); setAnchor(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`); }}>
              <Text style={styles.btnText}>This wk</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.btn, periodSaved && styles.btnSuccess, { flex: 0, paddingHorizontal: 16 }]} onPress={() => handleSavePeriod()}>
              <Text style={styles.btnText}>{periodSaved ? '✓ Saved' : 'Save'}</Text>
            </TouchableOpacity>
          </View>
        </Section>

        {/* Race / Training Goal */}
        <Section title="Race / Training Goal" cat="coaching">
          <View style={styles.switchRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.switchLabel}>Race-prep mode</Text>
              <Text style={styles.switchSub}>
                Off = leisure build-up (periodized). On = the coach builds a periodized plan toward your race
                (base→build→peak→taper), overriding the weekly schedule. Needs a race date + a working API key.
              </Text>
            </View>
            <Switch value={planMode === 'race'} onValueChange={handleToggleMode}
              trackColor={{ true: c.accent, false: c.switchTrack }} ios_backgroundColor={c.switchTrack} thumbColor="#fff" />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6, marginBottom: 22 }}>
            <Text style={[styles.switchLabel, { width: 96 }]}>Race date</Text>
            <DateTimePicker value={raceDateObj} mode="date" display="compact" minimumDate={new Date()}
              onChange={(_e, d) => { if (d) setRaceDateObj(d); }} themeVariant={mode === 'dark' ? 'dark' : 'light'} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
            <Text style={[styles.switchLabel, { width: 96 }]}>Distance</Text>
            <TextInput style={[styles.input, { width: 82, marginBottom: 0, textAlign: 'center' }]} value={raceDist} onChangeText={setRaceDist}
              placeholder="10" placeholderTextColor="#bbb" keyboardType="decimal-pad" returnKeyType="done" />
            <Text style={[styles.unitLabel, { marginLeft: 8 }]}>km</Text>
          </View>
          <Text style={[styles.hint, { marginTop: 14 }]}>Goal time (leave at 0:00:00 for no target)</Text>
          <View style={{ flexDirection: 'row' }}>
            <Picker style={{ flex: 1 }} itemStyle={{ fontSize: 20, height: 132, color: c.text }} selectedValue={goalH} onValueChange={(v) => setGoalH(Number(v))}>
              {Array.from({ length: 10 }, (_, h) => <Picker.Item key={h} label={`${h} h`} value={h} color={c.text} />)}
            </Picker>
            <Picker style={{ flex: 1 }} itemStyle={{ fontSize: 20, height: 132, color: c.text }} selectedValue={goalM} onValueChange={(v) => setGoalM(Number(v))}>
              {Array.from({ length: 60 }, (_, m) => <Picker.Item key={m} label={`${m} m`} value={m} color={c.text} />)}
            </Picker>
            <Picker style={{ flex: 1 }} itemStyle={{ fontSize: 20, height: 132, color: c.text }} selectedValue={goalS} onValueChange={(v) => setGoalS(Number(v))}>
              {Array.from({ length: 60 }, (_, s) => <Picker.Item key={s} label={`${s} s`} value={s} color={c.text} />)}
            </Picker>
          </View>
          <Text style={styles.hint}>
            Target: {(goalH * 3600 + goalM * 60 + goalS) === 0 ? 'none' : (goalH > 0
              ? `${goalH}:${String(goalM).padStart(2, '0')}:${String(goalS).padStart(2, '0')}`
              : `${goalM}:${String(goalS).padStart(2, '0')}`)}
            {'   ·   '}5K=5 · 10K=10 · half=21.1 · marathon=42.2. Re-plans weekly; flags if the goal looks achievable.
          </Text>
          <TouchableOpacity style={[styles.btn, raceSaved && styles.btnSuccess]} onPress={handleSaveRace}>
            <Text style={styles.btnText}>{raceSaved ? '✓ Saved' : 'Save race'}</Text>
          </TouchableOpacity>
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

        {/* Guided setup */}
        <Section title="Guided Setup" cat="profile">
          <Text style={styles.hint}>
            Re-run the welcome flow to reconfigure your profile, goal, weekly schedule and API key from scratch.
          </Text>
          <TouchableOpacity style={styles.btn} onPress={async () => { await setOnboardingDone(false); router.replace('/onboarding' as any); }}>
            <Text style={styles.btnText}>Run setup again</Text>
          </TouchableOpacity>
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
            style={[styles.btnSecondary, { marginTop: 8 }]}
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

        <Section title="Cloud Account & Sync" cat="cloud">
          <Text style={styles.hint}>
            Sign in to sync your training to the cloud so an external coach can view your data and (soon) prescribe
            workouts. The app works fully without this — cloud is optional. Only derived data is uploaded (runs and
            daily readiness/strain/CTL-ATL), never your raw HealthKit caches.
          </Text>
          <TouchableOpacity style={styles.btn} onPress={() => router.push('/account' as any)}>
            <Text style={styles.btnText}>Open Cloud Account</Text>
          </TouchableOpacity>

          <View style={[styles.switchRow, { marginTop: 16 }]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.switchLabel}>Follow my coach's plan</Text>
              <Text style={styles.switchSub}>
                On: today's session comes from the prescription your coach wrote in the cloud (no AI key needed).
                Off: the app's own AI generates your plan. Your metrics sync either way.
              </Text>
            </View>
            <Switch
              value={coachMode === 'coach'}
              onValueChange={async (v) => {
                const m: CoachingMode = v ? 'coach' : 'self';
                setCoachModeState(m);
                await setCoachingMode(m);
              }}
              trackColor={{ true: c.accent, false: c.switchTrack }} ios_backgroundColor={c.switchTrack}
              thumbColor="#fff"
            />
          </View>
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
            style={[styles.btnSecondary, { marginTop: 8 }]}
            onPress={async () => {
              try {
                const snap = await loadSnapshotCache();
                if (!snap) { Alert.alert('No data yet', 'Open the Home screen once to load your health data, then export.'); return; }
                const cs = await assembleCoachSnapshot(snap.strain ?? null, snap.activities, snap.runs);
                const [shrink, per, planMode, minTSB, schedule, cachedPlan, weekCache, scanTimings, autoTimings] = await Promise.all([
                  getShrinkToFit(), getPeriodization(), getPlanMode(), getMinTSB(),
                  readKnowledgeContent('running-schedule').catch(() => ''),
                  loadCachedPlan(cs.date).catch(() => null),
                  loadWeekPlanCache(cs.date).catch(() => null),
                  loadScanTimings().catch(() => null),
                  loadAutoTimings().catch(() => null),
                ]);
                // Today's strain buildup: each activity's individual load contribution (same model as the
                // Strain Detail screen), so the export shows how the day's strain was assembled.
                const _mhr = (snap as any).estimatedMaxHR || 190;
                const _rhr = (snap as any).todayRecovery?.restingHr ?? 50;
                const strainBuildup = (snap.activities ?? [])
                  .filter((a: any) => (a.date ?? '').slice(0, 10) === cs.date)
                  .map((a: any) => ({ name: a.name, min: Math.round(a.durationMin || 0), avgHR: Math.round(a.avgHR || 0), load: computeWorkoutLoad(a, _mhr, _rhr) }))
                  .filter((a: any) => a.load > 0)
                  .sort((x: any, y: any) => y.load - x.load);
                // Matches harness/fixture/scenario.json (drop straight in) + a _debug block with the exact
                // snapshot + cached plans. NO API keys — just training data.
                const scenario = {
                  _note: 'RunCoachAI coach debug snapshot — drop into harness/fixture/ as a scenario. Training data only (no API keys).',
                  date: cs.date,
                  capPct: cs.loadCapPct ?? 10,
                  shrinkToFit: shrink,
                  planMode,
                  periodization: per,
                  minTSB,
                  readiness: cs.readiness,
                  strainReal: cs.strainReal,
                  advisableLow: cs.advisableLow,
                  advisableHigh: cs.advisableHigh,
                  acwr: cs.acwr,
                  weather: cs.weather,
                  schedule,
                  recentTimeOnFeet: cs.recentTimeOnFeet,
                  athleteStatus: cs.athleteStatus,
                  athleteStatusUntil: cs.athleteStatusUntil,
                  _debug: {
                    cachedPlan, weekCache, scanTimings, autoTimings, strainBuildup,
                    // Recovery calibration diagnostics: what the recovery calc actually used vs the raw series.
                    recoveryBreakdown: (snap as any).todayRecovery?.breakdown,
                    sleepHRtoday:      (snap as any).todayRecovery?.overnightHR,   // overnight SLEEP HR (fresh)
                    // OUR FULL nightly series (60-90 nights) — to re-fit Bevel's recovery on OUR sub-KPIs
                    // over a long window (kills the 14-day overfit). date / hrv / sleepHR.
                    nightly: ((snap as any).nightlyLean ?? [])
                      .map((n: any) => ({ date: n.d, hrv: n.h, sleepHR: n.s })),
                    appleRestingHR: ((snap as any).restingHR ?? []).map((r: any) => ({ date: (r.date ?? '').slice(0, 10), value: r.value })),
                    fullSnapshot: cs,
                  },
                };
                const json = JSON.stringify(scenario, null, 2);
                const uri = `${FileSystem.cacheDirectory}runcoach-coach-debug.json`;
                await FileSystem.writeAsStringAsync(uri, json);
                if (await Sharing.isAvailableAsync()) {
                  await Sharing.shareAsync(uri, { mimeType: 'application/json', dialogTitle: 'RunCoachAI coach debug snapshot' });
                } else {
                  await Clipboard.setStringAsync(json);
                  Alert.alert('Copied', 'Sharing unavailable — debug snapshot copied to clipboard.');
                }
              } catch (e: any) { Alert.alert('Export failed', e?.message ?? String(e)); }
            }}
          >
            <Text style={styles.btnTextSecondary}>Export Coach Debug Snapshot</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btnSecondary, { marginTop: 8 }]}
            disabled={refreshingAll}
            onPress={() => Alert.alert(
              'Refresh all history',
              'Read your FULL Apple Health history (multi-year). This can take a while + use more battery. Normal startup only reads recent data for speed.',
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Refresh all', onPress: async () => {
                  setRefreshingAll(true);
                  try {
                    const t0 = Date.now();
                    const snap = await fetchHealthSnapshot({ months: 60, light: false });
                    await saveSnapshotCache(snap);
                    Alert.alert('History loaded', `${snap.runs.length} runs in ${((Date.now() - t0) / 1000).toFixed(1)}s. Go back to Home to see the full history.`);
                  } catch (e: any) { Alert.alert('Refresh failed', e?.message ?? String(e)); }
                  finally { setRefreshingAll(false); }
                } },
              ],
            )}
          >
            <Text style={styles.btnTextSecondary}>{refreshingAll ? 'Reading full history…' : '↻ Refresh all history (multi-year)'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btnSecondary, { marginTop: 8 }]}
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
            style={[styles.input, { minHeight: 100, maxHeight: 160, textAlignVertical: 'top', marginBottom: 10 }]}
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

          <Text style={[styles.hint, { marginTop: 16 }]}>
            Create a single consolidated debug dump (body battery, coach state, training load,
            settings) for analysis. API keys and account tokens are stripped before it leaves the
            device; the dump is labelled with your account so it's identifiable when shared.
          </Text>
          <TouchableOpacity
            style={[styles.btnSecondary, dumping && { opacity: 0.6 }]}
            disabled={dumping}
            onPress={async () => {
              setDumping(true);
              try {
                const json = await buildDebugExportJson();
                await shareJson(json, `runcoach-debug-${new Date().toISOString().split('T')[0]}.json`, 'RunCoachAI debug dump');
              } catch (err: any) {
                Alert.alert('Debug dump failed', err?.message ?? String(err));
              } finally {
                setDumping(false);
              }
            }}
          >
            {dumping
              ? <ActivityIndicator size="small" color={c.accent} />
              : <Text style={styles.btnTextSecondary}>🧪  Create debug dump (share)</Text>}
          </TouchableOpacity>

          <Text style={[styles.hint, { marginTop: 16 }]}>
            Or upload it straight to your own Google Drive (folder <Text style={{ fontWeight: '700' }}>runcoach-debug/latest.json</Text>),
            where it can be read for analysis. The app only ever touches files it creates in your Drive.
          </Text>
          <View style={styles.row}>
            <TouchableOpacity
              style={[styles.btnSecondary, { flex: 1 }, driveBusy && { opacity: 0.6 }]}
              disabled={driveBusy}
              onPress={async () => {
                setDriveBusy(true);
                try {
                  if (driveConnected) { await disconnectDrive(); setDriveConnected(false); }
                  else { await connectDrive(); setDriveConnected(true); }
                } catch (err: any) {
                  Alert.alert('Google Drive', err?.message ?? String(err));
                } finally { setDriveBusy(false); }
              }}
            >
              <Text style={styles.btnTextSecondary}>{driveConnected ? '🔓 Disconnect Drive' : '🔗 Connect Drive'}</Text>
            </TouchableOpacity>
            {driveConnected && (
              <TouchableOpacity
                style={[styles.btn, { flex: 1, paddingHorizontal: 12 }, driveBusy && { opacity: 0.6 }]}
                disabled={driveBusy}
                onPress={async () => {
                  setDriveBusy(true);
                  try {
                    const sections = await buildDebugSections();
                    const { names } = await uploadDebugSections(sections);
                    Alert.alert('Uploaded', `Saved ${names.length} small files to Drive → runcoach-debug/ (${names.map(n => `${n}.json`).join(', ')}).`);
                  } catch (err: any) {
                    Alert.alert('Upload failed', err?.message ?? String(err));
                  } finally { setDriveBusy(false); }
                }}
              >
                {driveBusy ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.btnText}>↑ Upload</Text>}
              </TouchableOpacity>
            )}
          </View>
        </Section>

        {/* Data info */}
        <Section title="Data & Privacy" cat="data">
          <Text style={styles.hint}>
            RunCoach AI reads Apple Health data directly on your device.{'\n\n'}
            Health data leaves the device in exactly two cases: coaching requests send context to your configured AI provider (Anthropic does not use API data to train models), and — only if you set up a Cloud account — daily metrics and runs sync to YOUR OWN Cloudflare Worker so a linked coach can see them.{'\n\n'}
            Your API key and cloud tokens stay in the iOS Keychain.
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
  { id: 'coaching',   label: 'Self-coaching & AI',         icon: '🧠', desc: 'Provider, knowledge, memory, reports, history depth' },
  { id: 'zones',      label: 'Zones & Training',           icon: '🏃', desc: 'Power zones, long-run threshold, Bevel calibration' },
  { id: 'automation', label: 'Notifications & Automation', icon: '🔔', desc: 'Daily recovery alert, auto day view' },
  { id: 'profile',    label: 'Profile',                    icon: '👤', desc: 'Body weight' },
  { id: 'appearance', label: 'Appearance',                 icon: '🎨', desc: 'Theme & text size' },
  { id: 'data',       label: 'Data & Backup',              icon: '💾', desc: 'Backup/restore, export, privacy' },
  { id: 'cloud',      label: 'Cloud & Human Coach',        icon: '☁️', desc: 'Account, sync, external human coach' },
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
    paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: c.surface,   // match the other detail-screen headers (was transparent/bg)
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border,
  },
  navTitle: { fontSize: 17, fontWeight: '700', color: c.text },
  backLink: { fontSize: 16, color: c.accent, fontWeight: '600', width: 96 },
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
  swatchRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 8 },
  swatch: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'transparent' },
  swatchActive: { borderColor: c.text },
  swatchCheck: { color: '#fff', fontSize: 18, fontWeight: '900' },
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
  // Secondary (grey) buttons: a border for definition + THEME text colour (white was invisible on grey).
  btnSecondary: { flex: 1, backgroundColor: c.surfaceAlt, borderRadius: 8, paddingVertical: 11, alignItems: 'center', borderWidth: 1, borderColor: c.border },
  btnTextSecondary: { color: c.text, fontWeight: '700', fontSize: 14 },
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
  chipActive: { backgroundColor: c.accent + '22', borderColor: c.accent },
  chipText: { fontSize: 11, color: c.textSub, fontWeight: '600' },
  chipTextActive: { color: c.accent },
});
