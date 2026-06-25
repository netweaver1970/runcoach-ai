import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  AppState,
  AppStateStatus,
  PanResponder,
  Modal,
} from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useRouter, useFocusEffect } from 'expo-router';

import {
  requestPermissions,
  fetchHealthSnapshot,
  formatDistance,
  formatDuration,
  formatPace,
  subscribeToWorkoutChanges,
  saveSnapshotCache,
  loadSnapshotCache,
} from '../src/services/healthkit';
import { computeWorkoutTypeStats } from '../src/services/workoutClassifier';
import { getApiKey, getSyncMonths, setSyncMonths, SyncMonths, getRunOverrides, TrainingRecommendation } from '../src/services/claude';
import { loadCachedPlan, saveCachedPlan, assembleCoachSnapshot, getCoachPlan, planNeedsRefresh, formatWorkoutStructure, CoachPlan } from '../src/services/coach';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { computeBodyBattery, BodyBattery } from '../src/services/bodyBattery';
import { syncWatch } from '../src/services/watchSync';

const batteryColor = (v: number) => (v >= 60 ? '#22C55E' : v >= 30 ? '#F59E0B' : '#EF4444');

// Bump the trailing schema rev when the snapshot shape changes, to force one full rescan.
const SCAN_MARKER = `${Constants.expoConfig?.version ?? '0'}|s1`;
const SCAN_MARKER_KEY = 'scan_marker_v1';
import { getLocalWeather, weatherSummary } from '../src/services/weather';
import { tsbStatus, strainStatus, cardioLoadStatus, activityCategory } from '../src/services/trainingLoad';
import { maybeRunDayView, startSleepObserver, startWorkoutObserver, isAutoDayViewEnabled } from '../src/services/dayUpdate';
import { maybeAnalyzeLatestRun, loadLatestRunAnalysis, RunAnalysis } from '../src/services/runAnalysis';
import { maybeAutoRecalibrate } from '../src/services/zones';
import { fetchOurDailyComponents } from '../src/services/healthkit';
import { buildDayView, toDateKey } from '../src/services/dayView';
import { markPrescriptionExecuted } from '../src/services/coachFiles';
import { loadRunMeta } from '../src/services/runMeta';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import { HealthSnapshot, RunWorkout, DailyRecovery, WorkoutLabel, DailyLoad, DayStrain, ActivitySummary } from '../src/types';
// WorkoutLabel is used by the RunFilter type and RUN_FILTERS array

type RunFilter = 'All' | WorkoutLabel;

const RUN_FILTERS: { label: string; value: RunFilter; emoji: string }[] = [
  { label: 'All', value: 'All', emoji: '🏃' },
  { label: 'Z2', value: 'Z2', emoji: '🟢' },
  { label: 'Tempo', value: 'Tempo', emoji: '🟠' },
  { label: 'Intervals', value: 'Intervals', emoji: '🔴' },
  { label: 'Long Run', value: 'LongRun', emoji: '🔵' },
  { label: 'Recovery', value: 'Recovery', emoji: '🟣' },
];

// Top-level sport filter (default Runs). Non-run sports have no zones/structure — shown
// as simple start-to-end cards from the all-workout activity list.
type SportFilter = 'Run' | 'Walk' | 'Dance' | 'Cardio' | 'All';
const SPORT_FILTERS: { label: string; value: SportFilter; emoji: string }[] = [
  { label: 'Runs',   value: 'Run',    emoji: '🏃' },
  { label: 'Walk',   value: 'Walk',   emoji: '🚶' },
  { label: 'Dance',  value: 'Dance',  emoji: '💃' },
  { label: 'Cardio', value: 'Cardio', emoji: '🔥' },
  { label: 'All',    value: 'All',    emoji: '✨' },
];

export default function HomeScreen() {
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);
  const [snapshot, setSnapshot]         = useState<HealthSnapshot | null>(null);
  const [loading, setLoading]           = useState(true);
  const [refreshing, setRefreshing]     = useState(false);
  const [hasApiKey, setHasApiKey]       = useState(false);
  const [runFilter, setRunFilter]       = useState<RunFilter>('All');
  const [sportFilter, setSportFilter]   = useState<SportFilter>('Run');
  const [bodyBattery, setBodyBattery]   = useState<BodyBattery | null>(null);
  const [syncMonths, setSyncMonthsState] = useState<SyncMonths>(3);
  const [loadingStep, setLoadingStep]   = useState<{ step: string; pct: number } | null>(null);
  const [recommendation, setRecommendation] = useState<TrainingRecommendation | null>(null);
  const [loadingRec, setLoadingRec]     = useState(false);
  const [runAnalysis, setRunAnalysis]   = useState<RunAnalysis | null>(null);
  // ── Historic time-travel ──────────────────────────────────────────────────
  const [viewDate, setViewDate] = useState<Date>(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; });
  const [dayComps, setDayComps] = useState<Record<string, Record<string, number>>>({});
  const [compsLoading, setCompsLoading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const shiftDayRef = useRef<(d: number) => void>(() => {});
  const appState      = useRef(AppState.currentState);
  // Ref so `load` never needs syncMonths in its dependency array (avoids double-load)
  const syncMonthsRef  = useRef<SyncMonths>(3);
  // Guard against concurrent loads (AppState + subscription can both fire at startup)
  const isLoadingRef   = useRef(false);

  // ── Today's recommendation = the SAME coach plan the Strain screen shows ───
  // Reads the cached coach plan (pre-generated each morning by the day-view) so the home
  // card and the Strain-detail plan never disagree; only generates if none is cached yet.
  const refreshRecommendation = useCallback(async (snap: HealthSnapshot) => {
    const key = await getApiKey();
    if (!key) return;
    setLoadingRec(true);
    try {
      // Use the SAME key the Strain screen + morning day-view use (the latest component
      // date = cs.date), so the home and detail always read the exact same cached plan.
      const cs = await assembleCoachSnapshot(snap.strain ?? null, snap.activities);
      let plan = await loadCachedPlan(cs.date);
      if (!plan || planNeedsRefresh(plan, cs)) {     // regen if heat/strain drifted
        plan = await getCoachPlan(cs);
        await saveCachedPlan(cs.date, plan);
      }
      setRecommendation(coachPlanToRec(plan));
    } catch {
      // silently ignore — card simply won't appear/update
    } finally {
      setLoadingRec(false);
    }
  }, []);

  // Load persisted sync-months preference once on mount (does NOT trigger a re-load)
  useEffect(() => {
    getSyncMonths().then((m) => {
      syncMonthsRef.current = m;
      setSyncMonthsState(m);
    });
  }, []);

  // ── Core load function ──────────────────────────────────────────────────
  const load = useCallback(async (isRefresh = false, monthsOverride?: SyncMonths, light = false, silent = false) => {
    // Prevent concurrent loads (AppState + workout subscription can both fire at startup)
    if (isLoadingRef.current) return;
    isLoadingRef.current = true;

    const months = monthsOverride ?? syncMonthsRef.current;
    if (silent) { /* background refresh over already-shown cache — no blocking spinner */ }
    else if (isRefresh) setRefreshing(true); // paired with the finally reset
    else { setLoading(true); setLoadingStep(null); }
    try {
      const granted = await requestPermissions();
      if (!granted) {
        if (!silent) Alert.alert(
          'Health Access Required',
          'RunCoach AI needs Apple Health access. Allow it in Settings → Privacy → Health.'
        );
        return;
      }
      const [snap, key] = await Promise.all([
        fetchHealthSnapshot({
          months,
          light,
          onProgress: silent ? undefined : (step, pct) => setLoadingStep({ step, pct }),
        }),
        getApiKey(),
      ]);
      setSnapshot(snap);
      saveSnapshotCache(snap).catch(() => {});
      // Body Battery (non-blocking) → also push KPIs to the watch with what we just computed.
      computeBodyBattery().then(bb => { setBodyBattery(bb); syncWatch(bb, snap).catch(() => {}); }).catch(() => {});
      // Only a FULL scan marks this version as fully scanned (so light starts stay light).
      if (!light) SecureStore.setItemAsync(SCAN_MARKER_KEY, SCAN_MARKER).catch(() => {});
      setHasApiKey(!!key);

      // Today's recommendation = the cached coach plan (same source as the Strain screen).
      if (key) refreshRecommendation(snap);

      // Auto-analyse the latest run (prescription-aware) when one just finished, then
      // surface the reduced result on the home card. Idempotent + bounded to fresh runs.
      if (key) maybeAnalyzeLatestRun({ snap, notify: true })
        .then(a => { if (a) setRunAnalysis(a); })
        .catch(() => {});

      // Auto-prepare the AI day view once last night is fully determined (idempotent
      // per night; reuses this snapshot; silent — they're already in the app).
      isAutoDayViewEnabled().then(on => {
        if (on) maybeRunDayView({ months, snap, notify: false }).catch(() => {});
      });
    } catch (err: any) {
      // "Protected health data is inaccessible" (HealthKit error 6) just means the device
      // was locked mid-query — transient; the next refresh succeeds. Don't alarm the user.
      const msg = String(err?.message ?? '');
      const transient = /Protected health data|Code=6|inaccessible/i.test(msg);
      if (!silent && !transient) Alert.alert('Error loading health data', err.message);
    } finally {
      isLoadingRef.current = false;
      setLoading(false);
      setLoadingStep(null);
      setRefreshing(false);
    }
  }, [refreshRecommendation]); // stable — reads syncMonths via ref

  // ── Change sync range ───────────────────────────────────────────────────
  const promptSyncMonths = useCallback(() => {
    const options: SyncMonths[] = [1, 3, 6, 12, 24];
    Alert.alert(
      'History range',
      'How many months of runs to load?',
      [
        ...options.map((m) => ({
          text: `${m} month${m > 1 ? 's' : ''}${m === syncMonths ? ' ✓' : ''}`,
          onPress: async () => {
            syncMonthsRef.current = m;
            await setSyncMonths(m);
            setSyncMonthsState(m);
            load(false, m);
          },
        })),
        { text: 'Cancel', style: 'cancel' as const },
      ]
    );
  }, [syncMonths, load]);

  // ── Initial load ────────────────────────────────────────────────────────
  // Show the cached snapshot instantly, then refresh in the background. A normal start
  // (same version) does a fast LIGHT refresh; a new version or first launch does a full
  // scan with the spinner. Pull-to-refresh always forces a full refresh.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [cached, prevMarker] = await Promise.all([
        loadSnapshotCache(),
        SecureStore.getItemAsync(SCAN_MARKER_KEY).catch(() => null),
      ]);
      if (cancelled) return;
      if (cached && prevMarker === SCAN_MARKER) {
        setSnapshot(cached);
        setLoading(false);
        load(false, undefined, true, true);  // light + silent background refresh
      } else {
        load(false, undefined, false, false); // full scan with spinner
      }
    })();
    return () => { cancelled = true; };
  }, [load]);

  // Wake the app on new sleep data (HealthKit observer) → auto-prepare the day view.
  // Wake on a new run → recalibrate the Power & HR Zones; also catch up on foreground.
  useEffect(() => {
    startSleepObserver(syncMonthsRef.current);
    startWorkoutObserver(syncMonthsRef.current);
    maybeAutoRecalibrate().catch(() => {});
    loadLatestRunAnalysis().then(setRunAnalysis).catch(() => {});
  }, []);

  // ── Re-apply overrides when returning from workout detail ─────────────────
  // IMPORTANT: do NOT close over `snapshot` here — useCallback(fn, []) captures
  // it as null (initial render).  Use functional setSnapshot(prev =>) instead
  // so we always operate on the latest state regardless of when the callback fires.
  useFocusEffect(useCallback(() => {
    // Re-check the API key every time we return to this screen (e.g. after
    // the user saves a key in Settings) so the Chat button appears immediately.
    getApiKey().then((k) => setHasApiKey(!!k)).catch(() => {});

    // Pick up a freshly-generated run analysis (e.g. regenerated on its own screen).
    loadLatestRunAnalysis().then(setRunAnalysis).catch(() => {});

    Promise.all([getRunOverrides(), loadRunMeta()]).then(([overrides, runMeta]) => {
      setSnapshot((prev) => {
        if (!prev) return prev;
        let labelsChanged = false;
        let metaChanged   = false;
        const newRuns = prev.runs.map((r) => {
          let nr = r;
          const ov = overrides[r.uuid];
          if (ov && r.label !== ov) { labelsChanged = true; nr = { ...nr, label: ov, confidence: 'high' as const }; }
          // Merge note + manual temperature edited on the detail screen
          const m = runMeta[r.uuid];
          if (m) {
            const newNote = m.note ?? undefined;
            const newTemp = m.tempSource === 'manual' && m.tempC != null ? m.tempC : nr.tempC;
            if (newNote !== nr.note || newTemp !== nr.tempC) {
              metaChanged = true; nr = { ...nr, note: newNote, tempC: newTemp };
            }
          }
          return nr;
        });
        if (!labelsChanged && !metaChanged) return prev;
        // Reclassification cascade: only re-derive type stats + recommendation when
        // a run's TYPE changed (notes/temp don't affect those). The rec cache is
        // keyed on the label signature, so a label change yields a fresh rec.
        const updated = {
          ...prev,
          runs: newRuns,
          ...(labelsChanged ? { workoutTypeStats: computeWorkoutTypeStats(newRuns) } : {}),
        };
        if (labelsChanged) refreshRecommendation(updated);
        return updated;
      });
    }).catch(() => {});
  }, [refreshRecommendation])); // functional updates handle stale state

  // ── AppState: refresh when app comes back to foreground ─────────────────
  // This catches the common case: user finishes a run → opens app.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      if (appState.current.match(/inactive|background/) && nextState === 'active') {
        load(true);
      }
      appState.current = nextState;
    });
    return () => sub.remove();
  }, [load]);

  // ── HealthKit subscription: fires when a new workout is recorded ─────────
  // Works even when the app is open in the foreground.
  useEffect(() => {
    let cleanup: (() => void) | null = null;
    subscribeToWorkoutChanges(() => load(true)).then((fn) => { cleanup = fn; });
    return () => { cleanup?.(); };
  }, [load]);

  // ── Pull-to-refresh ─────────────────────────────────────────────────────
  const onRefresh = useCallback(() => {
    // setRefreshing(true) is now called inside load() so the guard can't leave it stuck
    load(true);
  }, [load]);

  // Run type override is now handled inside the workout detail screen.

  // ── Historic time-travel handlers (hooks — must stay above any early return) ─
  const ensureComps = useCallback(() => {
    if (compsLoading || Object.keys(dayComps).length > 0) return;
    setCompsLoading(true);
    fetchOurDailyComponents(1).then(setDayComps).catch(() => {}).finally(() => setCompsLoading(false));
  }, [compsLoading, dayComps]);

  const shiftDay = useCallback((delta: number) => {
    const tk = toDateKey(new Date());
    setViewDate(prev => {
      const d = new Date(prev); d.setDate(d.getDate() + delta); d.setHours(0, 0, 0, 0);
      return toDateKey(d) > tk ? prev : d;                 // never the future
    });
    if (delta < 0) ensureComps();
  }, [ensureComps]);
  const goToday = useCallback(() => { const d = new Date(); d.setHours(0, 0, 0, 0); setViewDate(d); }, []);

  shiftDayRef.current = shiftDay;
  const swipe = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 24 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
    onPanResponderRelease: (_e, g) => {
      if (g.dx > 45) shiftDayRef.current(-1);              // swipe right → previous day
      else if (g.dx < -45) shiftDayRef.current(1);         // swipe left  → next day
    },
  })).current;

  // Flip today's prescription-history entry to ✅ once a run is logged for today.
  // Must stay ABOVE the early returns below so the hook order is stable every render.
  useEffect(() => {
    const today = toDateKey(new Date());
    if (toDateKey(viewDate) !== today) return;
    if (!recommendation || recommendation.type === 'Rest') return;
    if ((snapshot?.runs ?? []).some(r => toDateKey(new Date(r.date)) === today)) {
      markPrescriptionExecuted(today).catch(() => {});
    }
  }, [viewDate, snapshot, recommendation]);

  // ── Render ──────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#FF6B35" />
        <Text style={styles.loadingText}>
          {loadingStep?.step ?? 'Connecting to Apple Health…'}
        </Text>
        <View style={styles.progressTrack}>
          <View
            style={[
              styles.progressFill,
              { width: `${loadingStep?.pct ?? 0}%` },
            ]}
          />
        </View>
        {loadingStep && (
          <Text style={styles.progressPct}>{loadingStep.pct}%</Text>
        )}
      </View>
    );
  }

  const allRuns = snapshot?.runs ?? [];
  const runs = runFilter === 'All' ? allRuns : allRuns.filter((r) => r.label === runFilter);
  // Non-run sports: filter the all-workout activity list by category (newest first).
  const allActivities = snapshot?.activities ?? [];
  const sportActivities = (sportFilter === 'All'
    ? allActivities
    : allActivities.filter((a) => activityCategory(a.activityType) === sportFilter)
  ).slice().sort((a, b) => b.date.localeCompare(a.date));
  const latestVO2 = snapshot?.vo2max?.slice(-1)[0];
  const latestRHR = snapshot?.restingHR?.slice(-1)[0];
  const recovery = snapshot?.todayRecovery ?? null;

  // Current week start (Monday 00:00)
  const thisWeekStart = (() => {
    const d = new Date(); const diff = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - diff); d.setHours(0, 0, 0, 0); return d;
  })();
  const thisWeekRuns = allRuns.filter(r => new Date(r.date) >= thisWeekStart);
  const totalKmThisWeek = Math.round(
    thisWeekRuns.reduce((s, r) => s + r.distance / 1000, 0) * 10
  ) / 10;
  const totalMinThisWeek = Math.round(
    thisWeekRuns.reduce((s, r) => s + (r.workDuration ?? r.duration), 0) / 60
  );

  // Non-hook derived values for the time-travel render (the hooks live above the
  // loading guard so the hook order never changes between renders).
  const todayKey    = toDateKey(new Date());
  const isTodayView = toDateKey(viewDate) === todayKey;
  const dayView     = buildDayView(viewDate, snapshot, dayComps);
  const pickerDays  = Object.keys(dayComps).sort().reverse();

  // Has today's prescribed run been executed, and how much extra (walk/cardio) was logged?
  // The card reflects ANY activity (not just runs): the run marks the plan done; cross-training
  // tops up the strain. The top-up reflects the live strain, which already includes both — and
  // once the ceiling is reached we say so instead of nagging for more.
  const completion = (() => {
    if (!recommendation || recommendation.type === 'Rest') return null;
    const todaysRuns = allRuns.filter(r => toDateKey(new Date(r.date)) === todayKey);
    const todaysActs = (snapshot?.activities ?? []).filter(a => toDateKey(new Date(a.date)) === todayKey);
    if (todaysRuns.length === 0 && todaysActs.length === 0) return null; // nothing logged today
    const runMin = Math.round(todaysRuns.reduce((s, r) => s + (r.workDuration ?? r.duration), 0) / 60);
    const runKm  = todaysRuns.reduce((s, r) => s + r.distance, 0) / 1000;
    const xMin   = Math.round(todaysActs.reduce((s, a) => s + (a.durationMin ?? 0), 0));
    const xLabel = todaysActs.length ? activityCategory(todaysActs[0].activityType) : '';
    const str = snapshot?.strain ?? null;
    const atCeiling = !!str && str.real >= str.safeHigh;
    const topUp = (str && !atCeiling)
      ? `At ${str.real}% — easy walk/cycle to reach your ${str.safeHigh}% ceiling.`
      : null;
    return { runDone: todaysRuns.length > 0, runMin, runKm, xMin, xLabel, topUp, atCeiling, strainReal: str?.real ?? null };
  })();

  return (
    <SafeAreaView style={styles.container}>
      {/* Whole screen is day-swipeable (← → between days); the responder only claims
          horizontal gestures so vertical scroll + pull-to-refresh still work. */}
      <View style={{ flex: 1 }} {...swipe.panHandlers}>
      <ScrollView
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#FF6B35"
            title="Refreshing health data…"
            titleColor="#999"
          />
        }
        contentContainerStyle={{ paddingBottom: 32 }}
      >
        {/* Wellness rings — time-travelable (swipe ← → or use the date picker) */}
        <View>
          <WellnessRings
            recovery={dayView.recovery}
            strain={dayView.strain}
            onRefresh={onRefresh}
            refreshing={refreshing}
            onShowHistory={() => router.push({ pathname: '/history' as any, params: { type: 'hrv' } })}
            viewDate={viewDate}
            isToday={isTodayView}
            canGoNext={!isTodayView}
            onPrev={() => shiftDay(-1)}
            onNext={() => shiftDay(1)}
            onPickDate={() => { ensureComps(); setPickerOpen(true); }}
            historic={!isTodayView}
            loadingDay={compsLoading && !isTodayView}
          />
        </View>

        {/* Training recommendation — only meaningful for today. Tapping opens the Strain
            detail (same coach plan, fuller view). */}
        {isTodayView && (loadingRec || recommendation) && (
          <TrainingRecommendationCard
            rec={recommendation}
            loading={loadingRec}
            strain={snapshot?.strain ?? null}
            completion={completion}
            onPress={snapshot?.strain ? () => router.push({
              pathname: '/strain-detail' as any,
              params: { str: JSON.stringify(snapshot.strain), rec: recovery ? JSON.stringify(recovery) : undefined },
            }) : undefined}
          />
        )}

        {/* Last run analysis — reduced; tap through to the full prescription-aware review.
            Only while it's RECENT (≤18h, same window the analyzer uses) so a previous day's run
            doesn't linger on the morning view. */}
        {isTodayView && runAnalysis &&
          Date.now() - new Date(runAnalysis.runDate).getTime() < 18 * 3_600_000 && (
          <TouchableOpacity
            style={styles.raCard}
            onPress={() => router.push('/run-analysis' as any)}
            activeOpacity={0.85}
          >
            <Text style={styles.raEmoji}>🏁</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.raTitle} numberOfLines={1}>Run analysis · {runAnalysis.verdict}</Text>
              <Text style={styles.raSub} numberOfLines={2}>{runAnalysis.headline}</Text>
            </View>
            <Text style={styles.bbChevron}>›</Text>
          </TouchableOpacity>
        )}

        {/* Body Battery — tap for the charge/discharge graph */}
        {isTodayView && bodyBattery && (
          <TouchableOpacity style={styles.bbCard} onPress={() => router.push('/body-battery' as any)} activeOpacity={0.85}>
            <Text style={styles.bbEmoji}>🔋</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.bbTitle}>Body Battery</Text>
              <Text style={styles.bbSub}>
                {bodyBattery.trendPerHour >= 0 ? '▲ charging' : '▼ draining'} {Math.abs(bodyBattery.trendPerHour)}/h · stress {bodyBattery.currentStress}
              </Text>
            </View>
            <Text style={[styles.bbVal, { color: batteryColor(bodyBattery.current) }]}>{bodyBattery.current}%</Text>
            <Text style={styles.bbChevron}>›</Text>
          </TouchableOpacity>
        )}

        {/* Training load (CTL/ATL/TSB) — as of the viewed day */}
        {dayView.trainingLoad.length > 0 && (
          <TrainingLoadCard
            series={dayView.trainingLoad}
            onPress={() => router.push('/training-load' as any)}
          />
        )}

        {/* Coach buttons */}
        {!hasApiKey ? (
          <TouchableOpacity
            style={[styles.coachBtn, styles.coachBtnWarning]}
            onPress={() => router.push('/settings')}
          >
            <Text style={styles.coachBtnText}>⚙️  Add API key to unlock coaching</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.btnRow}>
            <TouchableOpacity
              style={[styles.coachBtn, styles.btnFlex]}
              onPress={() =>
                router.push({ pathname: '/chat', params: { data: JSON.stringify(snapshot) } })
              }
            >
              <Text style={styles.coachBtnText}>💬 Chat</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.coachBtn, styles.btnFlex, styles.coachBtnSecondary]}
              onPress={() =>
                router.push({ pathname: '/analysis', params: { data: JSON.stringify(snapshot) } })
              }
            >
              <Text style={styles.coachBtnText}>📋 Report</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.coachBtn, styles.btnFlex, styles.coachBtnTimeline]}
              onPress={() =>
                router.push({ pathname: '/history', params: { type: 'timeline' } } as any)
              }
            >
              <Text style={styles.coachBtnText}>📅 Timeline</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Stats row */}
        <View style={styles.statsRow}>
          <TouchableOpacity
            style={styles.statCard}
            onPress={() => router.push({ pathname: '/history' as any, params: { type: 'km' } })}
            activeOpacity={0.75}
          >
            <Text style={styles.statValue}>{totalKmThisWeek.toFixed(1)} km</Text>
            <Text style={styles.statLabel}>Distance ›</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.statCard}
            onPress={() => router.push({ pathname: '/history' as any, params: { type: 'time' } })}
            activeOpacity={0.75}
          >
            <Text style={styles.statValue}>{totalMinThisWeek > 0 ? `${Math.floor(totalMinThisWeek / 60)}h ${totalMinThisWeek % 60}m` : '—'}</Text>
            <Text style={styles.statLabel}>Time ›</Text>
          </TouchableOpacity>
          {latestVO2 && (
            <TouchableOpacity
              style={styles.statCard}
              onPress={() => router.push({ pathname: '/history' as any, params: { type: 'vo2' } })}
              activeOpacity={0.75}
            >
              <Text style={styles.statValue}>{Number(latestVO2.value).toFixed(1)}</Text>
              <Text style={styles.statLabel}>VO₂ Max ›</Text>
            </TouchableOpacity>
          )}
          {latestRHR && (
            <TouchableOpacity
              style={styles.statCard}
              onPress={() => router.push({ pathname: '/history' as any, params: { type: 'rhr' } })}
              activeOpacity={0.75}
            >
              <Text style={styles.statValue}>{latestRHR.value} bpm</Text>
              <Text style={styles.statLabel}>Resting HR ›</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Recent activity */}
        <View style={styles.sectionRow}>
          <Text style={styles.sectionTitle}>
            {sportFilter === 'Run' ? 'Recent Runs' : sportFilter === 'All' ? 'Recent Activity' : `Recent ${sportFilter}`}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {sportFilter === 'Run' && runFilter !== 'All' && (
              <Text style={styles.filterCount}>{runs.length} of {allRuns.length}</Text>
            )}
            <TouchableOpacity onPress={promptSyncMonths} style={styles.monthsBtn}>
              <Text style={styles.monthsBtnText}>{syncMonths}M ▾</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Sport filter (top level) */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterBar}
          style={{ marginBottom: 8 }}
        >
          {SPORT_FILTERS.map((f) => {
            const active = sportFilter === f.value;
            return (
              <TouchableOpacity
                key={f.value}
                style={[styles.filterChip, active && styles.filterChipActive]}
                onPress={() => setSportFilter(f.value)}
              >
                <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
                  {f.emoji} {f.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {/* Run-label sub-filter — only for Runs */}
        {sportFilter === 'Run' && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filterBar}
            style={{ marginBottom: 8 }}
          >
            {RUN_FILTERS.map((f) => {
              const active = runFilter === f.value;
              return (
                <TouchableOpacity
                  key={f.value}
                  style={[styles.filterChip, active && styles.filterChipActive]}
                  onPress={() => setRunFilter(f.value)}
                >
                  <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
                    {f.emoji} {f.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}

        {sportFilter !== 'Run' ? (
          sportActivities.length === 0 ? (
            <View style={styles.emptyBox}>
              <Text style={styles.emptyText}>No {sportFilter === 'All' ? 'activities' : sportFilter.toLowerCase()} in the last {syncMonths} month{syncMonths > 1 ? 's' : ''}.</Text>
            </View>
          ) : (
            sportActivities.map((a) => <ActivityCard key={a.uuid} activity={a} />)
          )
        ) : runs.length === 0 ? (
          <View style={styles.emptyBox}>
            {runFilter !== 'All' ? (
              <>
                <Text style={styles.emptyText}>No {runFilter} runs in the last 4 weeks.</Text>
                <TouchableOpacity onPress={() => setRunFilter('All')}>
                  <Text style={styles.emptyLink}>Show all runs</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={styles.emptyText}>No runs in the last {syncMonths} month{syncMonths > 1 ? 's' : ''}.</Text>
                <Text style={styles.emptySubtext}>
                  Make sure your Apple Watch is syncing to Health.
                </Text>
              </>
            )}
          </View>
        ) : (
          runs.map((run) => (
            <RunCard key={run.uuid} run={run} siblings={runs} />
          ))
        )}
      </ScrollView>
      </View>

      {/* Day picker */}
      <Modal visible={pickerOpen} transparent animationType="fade" onRequestClose={() => setPickerOpen(false)}>
        <TouchableOpacity style={styles.pickerBackdrop} activeOpacity={1} onPress={() => setPickerOpen(false)}>
          <View style={styles.pickerSheet}>
            <Text style={styles.pickerTitle}>Jump to a day</Text>
            <TouchableOpacity
              style={[styles.pickerRow, isTodayView && styles.pickerRowActive]}
              onPress={() => { goToday(); setPickerOpen(false); }}
            >
              <Text style={styles.pickerRowText}>Today</Text>
            </TouchableOpacity>
            <ScrollView style={{ maxHeight: 360 }}>
              {pickerDays.map(k => {
                const d = new Date(k + 'T00:00:00');
                const rec = dayComps[k]?.recoveryScore;
                const str = dayComps[k]?.strainScore;
                const active = k === toDateKey(viewDate);
                return (
                  <TouchableOpacity
                    key={k}
                    style={[styles.pickerRow, active && styles.pickerRowActive]}
                    onPress={() => { const nd = new Date(d); nd.setHours(0,0,0,0); setViewDate(nd); setPickerOpen(false); }}
                  >
                    <Text style={styles.pickerRowText}>
                      {d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
                    </Text>
                    <Text style={styles.pickerRowMeta}>
                      {rec != null ? `rec ${Math.round(rec)}` : ''}{str != null ? `  ·  strain ${Math.round(str)}%` : ''}
                    </Text>
                  </TouchableOpacity>
                );
              })}
              {pickerDays.length === 0 && (
                <Text style={styles.pickerEmpty}>{compsLoading ? 'Loading days…' : 'No history loaded yet.'}</Text>
              )}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

// Map the coach plan → the home card's TrainingRecommendation shape, so both screens
// (home + Strain detail) are driven by one source of truth.
function coachPlanToRec(p: CoachPlan): TrainingRecommendation {
  if (p.intensity === 'rest' || !p.workout) {
    return { type: 'Rest', duration: '—', zone: '—', reason: p.headline || p.rationale, nextRunLabel: p.nextRunLabel };
  }
  const zones = p.workout.blocks.map(b => b.hrZone).filter((z): z is string => !!z);
  const zone  = zones.sort().pop() ?? ''; // hardest zone of the day (Z1<…<Z5 lexically)
  const type: TrainingRecommendation['type'] =
    zone === 'Z1' ? 'Easy' :
    zone === 'Z2' ? 'Z2' :
    zone === 'Z3' ? 'Tempo' :
    (zone === 'Z4' || zone === 'Z5') ? 'Intervals' :
    (p.intensity === 'easy' ? 'Z2' : p.intensity === 'hard' ? 'Intervals' : 'Tempo');
  return { type, duration: `${p.runMinutes} min`, zone: zone || '—', structure: formatWorkoutStructure(p.workout), reason: p.headline || p.rationale };
}

// ─── Training Recommendation Card ────────────────────────────────────────────

const REC_ICONS: Record<string, string> = {
  Rest: '😴', Easy: '🟢', Z2: '🟢', Tempo: '🟠', LongRun: '🔵', Intervals: '🔴',
};
const REC_COLORS: Record<string, string> = {
  Rest: '#6B7280', Easy: '#22C55E', Z2: '#22C55E', Tempo: '#F97316', LongRun: '#3B82F6', Intervals: '#EF4444',
};

type Completion = { runDone: boolean; runMin: number; runKm: number; xMin: number; xLabel: string; topUp: string | null; atCeiling: boolean; strainReal: number | null };

function TrainingRecommendationCard({ rec, loading, strain, onPress, completion }: { rec: TrainingRecommendation | null; loading: boolean; strain: DayStrain | null; onPress?: () => void; completion?: Completion | null }) {
  const recStyles = useThemedStyles(makeRecStyles);
  if (loading && !rec) {
    return (
      <View style={[recStyles.card, { flexDirection: 'row', alignItems: 'center' }]}>
        <ActivityIndicator size="small" color="#FF6B35" />
        <Text style={recStyles.loadingText}>Loading recommendation…</Text>
      </View>
    );
  }
  if (!rec) return null;

  const runDone   = completion?.runDone ?? false;
  const xMin      = completion?.xMin ?? 0;
  const atCeiling = completion?.atCeiling ?? false;
  const loggedAny = runDone || xMin > 0;
  const typeNm = rec.type === 'LongRun' ? 'Long Run' : rec.type;
  const color  = runDone ? '#22C55E' : (REC_COLORS[rec.type] ?? '#FF6B35');
  const icon   = runDone ? '✅' : (REC_ICONS[rec.type] ?? '🏃');

  return (
    <TouchableOpacity style={[recStyles.card, { borderLeftColor: color }, runDone && recStyles.cardDone]} onPress={onPress} activeOpacity={0.85} disabled={!onPress}>
      <View style={recStyles.header}>
        <Text style={recStyles.icon}>{icon}</Text>
        <View style={{ flex: 1 }}>
          <Text style={[recStyles.type, { color }]}>
            {typeNm}{runDone ? '  ·  done ✓' : ''}
          </Text>
          {rec.type !== 'Rest' && (
            <Text style={recStyles.meta}>
              {runDone
                ? `Completed ${completion!.runMin} min${completion!.runKm >= 0.1 ? ` · ${completion!.runKm.toFixed(1)} km` : ''}${xMin > 0 ? `  ·  +${xMin}min ${completion!.xLabel}` : ''}`
                : `${rec.structure || `${rec.duration}${rec.zone && rec.zone !== '—' ? ` · ${rec.zone}` : ''}`}${xMin > 0 ? `  ·  +${xMin}min ${completion!.xLabel} logged` : ''}`}
            </Text>
          )}
        </View>
        <Text style={[recStyles.badge, (runDone || atCeiling) && recStyles.badgeDone]}>
          {runDone ? '✓ DONE' : atCeiling ? '✓ TARGET' : `Today's plan${onPress ? ' ›' : ''}`}
        </Text>
      </View>

      {atCeiling ? (
        <Text style={[recStyles.reason, { color: '#22C55E', fontWeight: '700' }]}>
          ✓ Strain target reached — you're at {completion!.strainReal}%, top of your {strain!.safeLow}–{strain!.safeHigh}% band.
        </Text>
      ) : completion?.topUp ? (
        <Text style={recStyles.topUp} numberOfLines={1}>⚡ {completion.topUp}</Text>
      ) : (
        <Text style={recStyles.reason}>{runDone ? 'Prescribed session done. ✓' : rec.reason}</Text>
      )}

      {rec.nextRunLabel && (
        <Text style={recStyles.target}>
          🏃 Next run <Text style={{ color: SAFE_COLOR, fontWeight: '800' }}>{rec.nextRunLabel}</Text> — when volume frees up
        </Text>
      )}

      {strain && (
        <Text style={recStyles.target}>
          Target <Text style={{ color: SAFE_COLOR, fontWeight: '800' }}>{strain.safeLow}–{strain.safeHigh}%</Text> strain
          {loggedAny ? `  ·  now ${strain.real}%` : (rec.type !== 'Rest' && rec.zone && rec.zone !== '—' ? `  ·  ${rec.zone}` : '')}
        </Text>
      )}
    </TouchableOpacity>
  );
}

// ─── Training Load Card (CTL/ATL/TSB) ────────────────────────────────────────

function TrainingLoadCard({ series, onPress }: { series: DailyLoad[]; onPress: () => void }) {
  const tl = useThemedStyles(makeTlStyles);
  const latest = series[series.length - 1];
  if (!latest) return null;
  const status = tsbStatus(latest.tsb);
  const cl = cardioLoadStatus(latest.atl, latest.ctl, latest.tsb); // Bevel-style zone

  // Mini 30-day CTL sparkline
  const spark = series.slice(-30);
  const ctls  = spark.map(d => d.ctl);
  const min   = Math.min(...ctls), max = Math.max(...ctls, min + 1);
  const W = 90, H = 28;
  const pts = spark.map((d, i) => {
    const x = (i / Math.max(1, spark.length - 1)) * W;
    const y = H - ((d.ctl - min) / (max - min)) * H;
    return { x, y };
  });

  return (
    <TouchableOpacity style={tl.card} onPress={onPress} activeOpacity={0.8}>
      <View style={tl.header}>
        <Text style={tl.title}>📈 Cardio Load</Text>
        <Text style={[tl.statusPill, { color: cl.color, borderColor: cl.color }]}>
          {cl.label}
        </Text>
      </View>
      <View style={tl.metricsRow}>
        <View style={tl.metric}>
          <Text style={[tl.metricVal, { color: '#3B82F6' }]}>{Math.round(latest.ctl)}</Text>
          <Text style={tl.metricLbl}>Fitness</Text>
          <Text style={tl.metricSub}>CTL</Text>
        </View>
        <View style={tl.metric}>
          <Text style={[tl.metricVal, { color: '#F97316' }]}>{Math.round(latest.atl)}</Text>
          <Text style={tl.metricLbl}>Fatigue</Text>
          <Text style={tl.metricSub}>ATL</Text>
        </View>
        <View style={tl.metric}>
          <Text style={[tl.metricVal, { color: status.color }]}>
            {latest.tsb >= 0 ? '+' : ''}{Math.round(latest.tsb)}
          </Text>
          <Text style={tl.metricLbl}>Form</Text>
          <Text style={tl.metricSub}>TSB</Text>
        </View>
        {/* Sparkline */}
        <View style={{ width: W, height: H, justifyContent: 'center' }}>
          {pts.map((p, i) => {
            if (i === 0) return null;
            const a = pts[i - 1], b = p;
            const dx = b.x - a.x, dy = b.y - a.y;
            const len = Math.sqrt(dx * dx + dy * dy);
            const ang = Math.atan2(dy, dx) * 180 / Math.PI;
            return (
              <View key={i} style={{
                position: 'absolute', left: (a.x + b.x) / 2 - len / 2, top: (a.y + b.y) / 2 - 1,
                width: len, height: 2, backgroundColor: '#3B82F6', borderRadius: 1,
                transform: [{ rotate: `${ang}deg` }],
              }} />
            );
          })}
        </View>
      </View>
      <Text style={tl.hint} numberOfLines={1}>
        Load <Text style={{ color: cl.color, fontWeight: '800' }}>{Math.round(cl.load)}</Text>
        {cl.ctl > 0 ? ` · sweet spot ${Math.round(cl.bandLo)}–${Math.round(cl.bandHi)}` : ''}  ›
      </Text>
    </TouchableOpacity>
  );
}

const makeTlStyles = (c: Palette) => StyleSheet.create({
  card: {
    marginHorizontal: 16, marginTop: 4, marginBottom: 4,
    backgroundColor: c.surface, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, gap: 6,
    borderLeftWidth: 4, borderLeftColor: '#3B82F6',
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 14, fontWeight: '700', color: c.text },
  statusPill: {
    fontSize: 11, fontWeight: '700', borderWidth: 1, borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 2, overflow: 'hidden',
  },
  metricsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  metric: { alignItems: 'center', minWidth: 50 },
  metricVal: { fontSize: 19, fontWeight: '800' },
  metricLbl: { fontSize: 10, color: c.textSub, marginTop: 1, fontWeight: '600' },
  metricSub: { fontSize: 9, color: c.textFaint, fontWeight: '600' },
  hint: { fontSize: 12, color: c.textSub },
});

const makeRecStyles = (c: Palette) => StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 4,
    backgroundColor: c.surface,
    borderRadius: 12,
    padding: 14,
    borderLeftWidth: 4,
    borderLeftColor: '#FF6B35',
    gap: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  icon: {
    fontSize: 26,
  },
  type: {
    fontSize: 17,
    fontWeight: '700',
    color: c.text,
  },
  meta: {
    fontSize: 13,
    color: c.textSub,
    marginTop: 1,
  },
  badge: {
    fontSize: 11,
    fontWeight: '600',
    color: c.textSub,
    backgroundColor: c.surfaceAlt,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    overflow: 'hidden',
  },
  badgeDone: {
    color: '#fff',
    backgroundColor: '#22C55E',
    fontWeight: '800',
  },
  cardDone: {
    backgroundColor: c.mode === 'dark' ? '#13241a' : '#F0FBF4',
  },
  topUp: {
    fontSize: 13,
    color: '#F59E0B',
    fontWeight: '700',
    lineHeight: 18,
  },
  reason: {
    fontSize: 13,
    color: c.text,
    lineHeight: 18,
  },
  target: {
    fontSize: 12,
    color: c.textSub,
    marginTop: 8,
    fontWeight: '600',
  },
  loadingText: {
    fontSize: 13,
    color: c.textFaint,
    marginLeft: 8,
  },
});

// ─── Ring arc component ───────────────────────────────────────────────────────

// Exact circular-progress arc via SVG strokeDashoffset (replaces the old rotate+clip
// trick, which — using a rotationally-symmetric full ring — could never render a
// proportional fill: it always showed ~50% for any value ≤180° and full above).
function ArcSvg({ size, strokeWidth, progress, color, trackColor }: {
  size: number; strokeWidth: number; progress: number; color: string; trackColor: string;
}) {
  const p    = Math.min(1, Math.max(0, progress));
  const half = size / 2;
  const r    = half - strokeWidth / 2;
  const circ = 2 * Math.PI * r;
  return (
    <Svg width={size} height={size}>
      <Circle cx={half} cy={half} r={r} stroke={trackColor} strokeWidth={strokeWidth} fill="none" />
      {p > 0 && (
        <Circle
          cx={half} cy={half} r={r}
          stroke={color} strokeWidth={strokeWidth} fill="none"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - p)}
          strokeLinecap="round"
          transform={`rotate(-90 ${half} ${half})`}
        />
      )}
    </Svg>
  );
}

function Ring({
  size, strokeWidth, progress, color, value,
}: {
  size: number; strokeWidth: number; progress: number;
  color: string; value: string;
}) {
  return (
    <View style={{ width: size, height: size }}>
      <ArcSvg size={size} strokeWidth={strokeWidth} progress={progress} color={color} trackColor={color + '28'} />
      <View style={{
        position: 'absolute', width: size, height: size,
        alignItems: 'center', justifyContent: 'center',
      }}>
        <Text style={{ fontSize: size * 0.3, fontWeight: '800', color, lineHeight: size * 0.34 }}>
          {value}
        </Text>
      </View>
    </View>
  );
}

// ─── Wellness Rings Card ──────────────────────────────────────────────────────

// ─── Bare ring arc (no centre label) — used for the strain double ring ────────

function ArcRing({ size, strokeWidth, progress, color, trackColor }: {
  size: number; strokeWidth: number; progress: number; color: string; trackColor?: string;
}) {
  return (
    <ArcSvg size={size} strokeWidth={strokeWidth} progress={progress} color={color} trackColor={trackColor ?? color + '24'} />
  );
}

// ─── Strain double ring: outer = real effort, inner = safe target ─────────────

const SAFE_COLOR = '#16a085';

function StrainRing({ size, strain }: { size: number; strain: DayStrain | null }) {
  const real = strain ? strain.real : 0;
  const st   = strain ? strainStatus(strain) : { label: '', color: '#888' };

  // Floor/ceiling markers on the ring circumference (clockwise from 12 o'clock). Kept —
  // they cost no screen space; only the verbose "Target x–y%" caption was dropped.
  const half = size / 2;
  const rad  = half - 4; // centreline of the 8px stroke
  const marker = (pct: number, key: string) => {
    const th = (Math.min(100, Math.max(0, pct)) / 100) * 2 * Math.PI;
    const x = half + rad * Math.sin(th);
    const y = half - rad * Math.cos(th);
    return (
      <View key={key} style={{
        position: 'absolute', left: x - 3.5, top: y - 3.5,
        width: 7, height: 7, borderRadius: 3.5, backgroundColor: SAFE_COLOR,
        borderWidth: 1, borderColor: '#fff',
      }} />
    );
  };

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <ArcRing size={size} strokeWidth={8} progress={real / 100} color={st.color} />
      {strain && marker(strain.safeLow, 'lo')}
      {strain && marker(strain.safeHigh, 'hi')}
      <View style={{ position: 'absolute', alignItems: 'center' }}>
        <Text style={{ fontSize: size * 0.3, fontWeight: '800', color: st.color, lineHeight: size * 0.34 }}>
          {strain ? `${real}%` : '--'}
        </Text>
      </View>
    </View>
  );
}

type WellnessRingsProps = {
  recovery: DailyRecovery | null;
  strain: DayStrain | null;
  onRefresh: () => void;
  refreshing: boolean;
  onShowHistory: () => void;
  viewDate: Date;
  isToday: boolean;
  canGoNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onPickDate: () => void;
  historic: boolean;
  loadingDay: boolean;
};

function WellnessRings({
  recovery, strain, onRefresh, refreshing,
  viewDate, isToday, canGoNext, onPrev, onNext, onPickDate, historic, loadingDay,
}: WellnessRingsProps) {
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);
  const dateKey = toDateKey(viewDate);
  const dateLbl = viewDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

  // Carry BOTH the day's recovery + strain to every detail screen so swiping between
  // Strain/Recovery/Sleep keeps the same day's data.
  const detailParams = {
    rec: recovery ? JSON.stringify(recovery) : undefined,
    str: strain ? JSON.stringify(strain) : undefined,
    date: dateKey,
  };
  const navToRecovery = () => { if (recovery) router.push({ pathname: '/recovery-detail' as any, params: detailParams }); };
  const navToSleep    = () => { if (recovery) router.push({ pathname: '/sleep-detail' as any, params: detailParams }); };
  const navToStrain   = () => { if (strain) router.push({ pathname: '/strain-detail' as any, params: detailParams }); };

  const DateNav = (
    <View style={styles.wellnessHeader}>
      <Text style={styles.wellnessTitle}>{isToday ? "Today's Wellness" : 'Wellness'}</Text>
      <View style={styles.dateNav}>
        <TouchableOpacity onPress={onPrev} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.dateArrow}>‹</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onPickDate}>
          <Text style={[styles.wellnessSubtitle, historic && { color: '#FF6B35', fontWeight: '700' }]}>{dateLbl}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onNext} disabled={!canGoNext} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={[styles.dateArrow, !canGoNext && { opacity: 0.25 }]}>›</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  // Nothing at all (today not synced, or a past day with no data)
  if (!recovery && !strain) {
    return (
      <View style={styles.wellnessCard}>
        {DateNav}
        <Text style={styles.wellnessUnavailable}>
          {loadingDay ? '⏳  Loading day…' : historic ? '🗓  No data for this day' : '🌙  Waiting for data to sync…'}
        </Text>
        {!historic && (
          <TouchableOpacity style={styles.refreshBtn} onPress={onRefresh} disabled={refreshing}>
            {refreshing
              ? <ActivityIndicator size="small" color="#FF6B35" />
              : <Text style={styles.refreshBtnText}>↻  Refresh</Text>}
          </TouchableOpacity>
        )}
      </View>
    );
  }

  const recScore   = recovery?.recoveryScore ?? 0;
  const sleepScore = recovery?.sleepScore ?? 0;
  const recColor   = recovery?.color ?? '#888';
  const noHRV      = !recovery || recovery.weightedRMSSD === 0;

  const RING = 74;

  return (
    <View style={styles.wellnessCard}>
      {DateNav}

      <View style={styles.ringsRow}>
        {/* Sleep — tappable */}
        <TouchableOpacity style={{ flex: 1, alignItems: 'center' }} onPress={navToSleep} activeOpacity={0.75} disabled={!recovery}>
          <Ring size={RING} strokeWidth={8} progress={sleepScore / 100} color="#8e44ad" value={sleepScore > 0 ? String(sleepScore) : '--'} />
          <Text style={styles.ringLabel}>SLEEP</Text>
        </TouchableOpacity>

        {/* Recovery — tappable */}
        <TouchableOpacity style={{ flex: 1, alignItems: 'center' }} onPress={navToRecovery} activeOpacity={0.75} disabled={!recovery}>
          <Ring size={RING} strokeWidth={8} progress={noHRV ? 0 : recScore / 100} color={noHRV ? '#bbb' : recColor} value={noHRV ? '--' : String(recScore)} />
          <Text style={styles.ringLabel}>RECOVERY</Text>
        </TouchableOpacity>

        {/* Strain — real-effort ring, tap → detail */}
        <TouchableOpacity style={{ flex: 1, alignItems: 'center' }} activeOpacity={0.75}
          onPress={navToStrain} disabled={!strain}>
          <StrainRing size={RING} strain={strain} />
          <Text style={styles.ringLabel}>STRAIN</Text>
        </TouchableOpacity>
      </View>

      {!recovery && (
        <Text style={styles.wellnessPending}>
          Last night's sleep &amp; recovery haven't synced from your watch yet. Open the Apple Health app, then pull to refresh.
        </Text>
      )}
    </View>
  );
}


const LABEL_STYLE: Record<string, { color: string; bg: string; emoji: string }> = {
  Intervals: { color: '#c0392b', bg: '#fdedec', emoji: '🔴' },
  Tempo:     { color: '#d35400', bg: '#fef0e7', emoji: '🟠' },
  LongRun:   { color: '#2980b9', bg: '#eaf4fd', emoji: '🔵' },
  Z2:        { color: '#27ae60', bg: '#eafaf1', emoji: '🟢' },
  Recovery:  { color: '#8e44ad', bg: '#f5eef8', emoji: '🟣' },
  Unknown:   { color: '#888',    bg: '#f5f5f5', emoji: '⚪' },
};

const SPORT_EMOJI: Record<string, string> = { Run: '🏃', Walk: '🚶', Dance: '💃', Cardio: '🔥', Other: '🏅' };

// Simple start-to-end card for non-run sports (no zones/structure to show).
function ActivityCard({ activity }: { activity: ActivitySummary }) {
  const styles = useThemedStyles(makeStyles);
  const d = new Date(activity.date);
  const dateStr = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const emoji = SPORT_EMOJI[activityCategory(activity.activityType)] ?? '🏅';
  return (
    <View style={styles.actCard}>
      <Text style={styles.actEmoji}>{emoji}</Text>
      <View style={{ flex: 1 }}>
        <Text style={styles.actName}>{activity.name}</Text>
        <Text style={styles.actMeta}>{dateStr}</Text>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={styles.actStat}>
          {Math.round(activity.durationMin)} min{activity.distanceKm > 0 ? ` · ${activity.distanceKm} km` : ''}
        </Text>
        <Text style={styles.actSub}>
          {activity.avgHR > 0 ? `${activity.avgHR} bpm · ` : ''}{activity.kcal} kcal
        </Text>
      </View>
    </View>
  );
}

function RunCard({ run, siblings }: { run: RunWorkout; siblings: RunWorkout[] }) {
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);
  const { c } = useTheme();
  const date = new Date(run.date).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: '2-digit',
  });
  const startTime = new Date(run.date).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit',
  });
  const labelStyle = run.label ? (LABEL_STYLE[run.label] ?? LABEL_STYLE.Unknown) : null;
  const displayPace     = run.workPace     ?? run.pace;
  const displayHR       = run.workHR       ?? run.avgHeartRate;
  const displayDuration = run.workDuration ?? run.duration;
  const isWorkPace      = !!run.workPace && run.workPace !== run.pace;

  const openDetail = () => {
    // Pass the current filtered+ordered list (compact) so the detail screen can
    // swipe to the prev/next run within the same filter.
    const siblingsParam = JSON.stringify(
      siblings.map(r => ({
        i: r.uuid, s: r.date, du: r.duration, di: r.distance, c: r.calories ?? 0, l: r.label ?? '',
      }))
    );
    router.push({
      pathname: '/workout/[id]' as any,
      params: {
        id:        run.uuid,
        startDate: run.date,
        duration:  String(run.duration),
        label:     run.label ?? '',
        date:      run.date,
        distance:  String(run.distance),
        calories:  String(run.calories ?? 0),
        siblings:  siblingsParam,
      },
    });
  };

  return (
    <TouchableOpacity
      style={styles.runCard}
      onPress={openDetail}
      activeOpacity={0.75}
    >
      {/* Left column: [date + time] / [km + badge] */}
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
          <Text style={styles.runDate}>{date}</Text>
          <Text style={styles.runStartTime}>{startTime}</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={styles.runDistance}>{formatDistance(run.distance)}</Text>
          {labelStyle && (
            <View style={[styles.workoutBadge, { backgroundColor: c.mode === 'dark' ? labelStyle.color + '2e' : labelStyle.bg }]}>
              <Text style={[styles.workoutBadgeText, { color: c.mode === 'dark' ? labelStyle.color : labelStyle.color }]}>
                {labelStyle.emoji} {run.label}
                {run.confidence === 'low' ? ' ?' : ''}
              </Text>
            </View>
          )}
        </View>
      </View>

      {/* Right column: 2 rows — (duration · pace) / (HR · power) */}
      <View style={{ alignItems: 'flex-end', gap: 3 }}>
        <Text style={[styles.runStat, isWorkPace && styles.runStatWork]}>
          {formatDuration(displayDuration)}{'  '}{formatPace(displayPace)}
        </Text>
        {(displayHR != null || (run.workPower ?? 0) > 0) && (
          <Text style={styles.runStatHR}>
            {displayHR != null ? `♥ ${displayHR}` : ''}
            {displayHR != null && (run.workPower ?? 0) > 0 ? '  ' : ''}
            {(run.workPower ?? 0) > 0 ? `⚡ ${run.isEstimatedPower ? '~' : ''}${run.workPower}W` : ''}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: c.bg },
  actCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: c.surface, borderRadius: 12, padding: 14, marginBottom: 8,
    borderWidth: 1, borderColor: c.border,
  },
  bbCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    marginHorizontal: 16, marginTop: 4, marginBottom: 4,
    backgroundColor: c.surface, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
    borderLeftWidth: 4, borderLeftColor: '#22C55E',
  },
  bbEmoji: { fontSize: 20 },
  bbTitle: { fontSize: 14, fontWeight: '700', color: c.text },
  bbSub: { fontSize: 12, color: c.textSub, marginTop: 1 },
  raCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    marginHorizontal: 16, marginTop: 4, marginBottom: 4,
    backgroundColor: c.surface, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
    borderLeftWidth: 4, borderLeftColor: '#FF6B35',
  },
  raEmoji: { fontSize: 20 },
  raTitle: { fontSize: 14, fontWeight: '700', color: c.text },
  raSub: { fontSize: 12, color: c.textSub, marginTop: 2, lineHeight: 16 },
  bbVal: { fontSize: 22, fontWeight: '800' },
  bbChevron: { fontSize: 20, color: c.textSub, fontWeight: '300' },
  actEmoji: { fontSize: 22 },
  actName:  { fontSize: 15, fontWeight: '600', color: c.text },
  actMeta:  { fontSize: 12, color: c.textSub, marginTop: 2 },
  actStat:  { fontSize: 14, fontWeight: '600', color: c.text },
  actSub:   { fontSize: 12, color: c.textSub, marginTop: 2 },
  loadingText: { marginTop: 12, color: c.textSub, fontSize: 15, textAlign: 'center' },
  progressTrack: {
    marginTop: 16, width: 220, height: 6, borderRadius: 3,
    backgroundColor: c.border, overflow: 'hidden',
  },
  progressFill: { height: 6, borderRadius: 3, backgroundColor: '#FF6B35' },
  progressPct: { marginTop: 6, fontSize: 12, color: c.textFaint },

  monthsBtn: {
    borderRadius: 8, borderWidth: 1, borderColor: c.border,
    backgroundColor: c.surface, paddingHorizontal: 8, paddingVertical: 3,
  },
  monthsBtnText: { fontSize: 11, color: c.textSub, fontWeight: '600' },

  wellnessCard: {
    backgroundColor: c.surface, margin: 12, marginBottom: 8, borderRadius: 16,
    paddingHorizontal: 14, paddingVertical: 12,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: c.shadowOpacity, shadowRadius: 6, elevation: 3,
  },
  wellnessHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  wellnessTitle: { fontSize: 15, fontWeight: '700', color: c.text },
  wellnessSubtitle: { fontSize: 13, color: c.text, fontWeight: '600' },
  dateNav: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  dateArrow: { fontSize: 22, color: '#FF6B35', fontWeight: '700', lineHeight: 24 },
  pickerBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  pickerSheet: { backgroundColor: c.surface, borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 28 },
  pickerTitle: { fontSize: 16, fontWeight: '800', color: c.text, marginBottom: 10 },
  pickerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.border },
  pickerRowActive: { backgroundColor: '#FF6B3522', borderRadius: 8, paddingHorizontal: 8 },
  pickerRowText: { fontSize: 15, fontWeight: '600', color: c.text },
  pickerRowMeta: { fontSize: 12, color: c.textFaint },
  pickerEmpty: { fontSize: 13, color: c.textFaint, paddingVertical: 16, textAlign: 'center' },
  ringsRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-around', marginBottom: 2 },
  ringLabel: { fontSize: 11, color: c.text, fontWeight: '700', letterSpacing: 0.8, marginTop: 7 },
  wellnessUnavailable: { fontSize: 15, color: c.textSub, marginBottom: 4, fontWeight: '500' },
  wellnessPending: { fontSize: 11, color: c.textFaint, lineHeight: 15, marginTop: 10, textAlign: 'center' },
  recoveryUnavailableHint: { fontSize: 12, color: c.textFaint, marginBottom: 12, lineHeight: 18 },
  refreshBtn: {
    alignSelf: 'flex-start', backgroundColor: c.mode === 'dark' ? '#3a2218' : '#FFF3EE', borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1, borderColor: '#FF6B35',
  },
  refreshBtnText: { color: '#FF6B35', fontSize: 14, fontWeight: '700' },
  sleepText: { fontSize: 12, color: c.textSub, marginBottom: 6 },

  btnRow: { flexDirection: 'row', marginHorizontal: 12, marginBottom: 8, gap: 8 },
  btnFlex: { flex: 1, marginHorizontal: 0 },
  coachBtn: { marginHorizontal: 12, marginBottom: 8, backgroundColor: '#FF6B35', borderRadius: 12, paddingVertical: 16, alignItems: 'center' },
  coachBtnSecondary: { backgroundColor: '#2c3e50' },
  coachBtnTimeline:  { backgroundColor: '#1a6b4a' },
  coachBtnWarning: { backgroundColor: '#888' },
  coachBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },

  statsRow: { flexDirection: 'row', paddingHorizontal: 12, gap: 6, marginBottom: 12 },
  statCard: { flex: 1, backgroundColor: c.surface, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 7, alignItems: 'center' },

  statValue: { fontSize: 13, fontWeight: '700', color: '#FF6B35' },
  statLabel: { fontSize: 10, color: c.textSub, marginTop: 1 },

  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginHorizontal: 16, marginBottom: 6 },
  sectionTitle: { fontSize: 12, fontWeight: '700', color: c.textSub, textTransform: 'uppercase', letterSpacing: 0.5 },
  filterCount: { fontSize: 12, color: c.textFaint },
  filterBar: { paddingHorizontal: 12, gap: 6, paddingBottom: 2 },
  filterChip: { borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, paddingHorizontal: 9, paddingVertical: 3 },
  filterChipActive: { backgroundColor: '#FF6B35', borderColor: '#FF6B35' },
  filterChipText: { fontSize: 11, color: c.textSub, fontWeight: '500' },
  filterChipTextActive: { color: '#fff', fontWeight: '700' },
  emptyBox: { margin: 16, alignItems: 'center' },
  emptyText: { fontSize: 15, color: c.textSub, marginBottom: 6 },
  emptySubtext: { fontSize: 13, color: c.textFaint, textAlign: 'center' },
  emptyLink: { fontSize: 14, color: '#FF6B35', fontWeight: '600' },

  runCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: c.surface, marginHorizontal: 12, marginBottom: 6, borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 10,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: c.shadowOpacity, shadowRadius: 3, elevation: 2,
  },
  runDate:     { fontSize: 13, fontWeight: '600', color: c.text },
  runStartTime: { fontSize: 13, fontWeight: '700', color: c.textSub },
  workoutBadge: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  workoutBadgeText: { fontSize: 11, fontWeight: '700' },
  runDistance:  { fontSize: 16, fontWeight: '800', color: c.text },
  runStat:      { fontSize: 13, color: c.textSub },
  runStatWork:  { color: '#FF6B35', fontWeight: '600' },
  runStatPower: { fontSize: 12, color: '#8e44ad' },
  runStatHR:    { fontSize: 12, color: '#e74c3c' },
});
