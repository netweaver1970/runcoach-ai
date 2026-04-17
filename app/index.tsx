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
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import {
  requestPermissions,
  fetchHealthSnapshot,
  formatDistance,
  formatDuration,
  formatPace,
  subscribeToWorkoutChanges,
} from '../src/services/healthkit';
import { getApiKey, getSyncMonths, setSyncMonths, SyncMonths, getRunOverrides } from '../src/services/claude';
import { HealthSnapshot, RunWorkout, DailyRecovery, WorkoutLabel } from '../src/types';
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

export default function HomeScreen() {
  const router = useRouter();
  const [snapshot, setSnapshot]         = useState<HealthSnapshot | null>(null);
  const [loading, setLoading]           = useState(true);
  const [refreshing, setRefreshing]     = useState(false);
  const [hasApiKey, setHasApiKey]       = useState(false);
  const [exporting, setExporting]       = useState(false);
  const [runFilter, setRunFilter]       = useState<RunFilter>('All');
  const [syncMonths, setSyncMonthsState] = useState<SyncMonths>(3);
  const [loadingStep, setLoadingStep]   = useState<{ step: string; pct: number } | null>(null);
  const appState      = useRef(AppState.currentState);
  // Ref so `load` never needs syncMonths in its dependency array (avoids double-load)
  const syncMonthsRef  = useRef<SyncMonths>(3);
  // Guard against concurrent loads (AppState + subscription can both fire at startup)
  const isLoadingRef   = useRef(false);

  // Load persisted sync-months preference once on mount (does NOT trigger a re-load)
  useEffect(() => {
    getSyncMonths().then((m) => {
      syncMonthsRef.current = m;
      setSyncMonthsState(m);
    });
  }, []);

  // ── Core load function ──────────────────────────────────────────────────
  const load = useCallback(async (isRefresh = false, monthsOverride?: SyncMonths) => {
    // Prevent concurrent loads (AppState + workout subscription can both fire at startup)
    if (isLoadingRef.current) return;
    isLoadingRef.current = true;

    const months = monthsOverride ?? syncMonthsRef.current;
    if (isRefresh) {
      setRefreshing(true);  // Set inside load so it's always paired with the finally reset
    } else {
      setLoading(true);
      setLoadingStep(null);
    }
    try {
      const granted = await requestPermissions();
      if (!granted) {
        Alert.alert(
          'Health Access Required',
          'RunCoach AI needs Apple Health access. Allow it in Settings → Privacy → Health.'
        );
        return;
      }
      const [snap, key] = await Promise.all([
        fetchHealthSnapshot({
          months,
          onProgress: (step, pct) => setLoadingStep({ step, pct }),
        }),
        getApiKey(),
      ]);
      setSnapshot(snap);
      setHasApiKey(!!key);
    } catch (err: any) {
      Alert.alert('Error loading health data', err.message);
    } finally {
      isLoadingRef.current = false;
      setLoading(false);
      setLoadingStep(null);
      setRefreshing(false);
    }
  }, []); // stable — reads syncMonths via ref

  // ── Change sync range ───────────────────────────────────────────────────
  const promptSyncMonths = useCallback(() => {
    const options: SyncMonths[] = [1, 3, 6, 12];
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
  useEffect(() => { load(); }, [load]);

  // ── Re-apply overrides when returning from workout detail ─────────────────
  // IMPORTANT: do NOT close over `snapshot` here — useCallback(fn, []) captures
  // it as null (initial render).  Use functional setSnapshot(prev =>) instead
  // so we always operate on the latest state regardless of when the callback fires.
  useFocusEffect(useCallback(() => {
    // Re-check the API key every time we return to this screen (e.g. after
    // the user saves a key in Settings) so the Chat button appears immediately.
    getApiKey().then((k) => setHasApiKey(!!k)).catch(() => {});

    getRunOverrides().then((overrides) => {
      setSnapshot((prev) => {
        if (!prev) return prev;
        let changed = false;
        const newRuns = prev.runs.map((r) => {
          const ov = overrides[r.uuid];
          if (ov && r.label !== ov) { changed = true; return { ...r, label: ov, confidence: 'high' as const }; }
          return r;
        });
        return changed ? { ...prev, runs: newRuns } : prev;
      });
    }).catch(() => {});
  }, [])); // [] is intentional — functional updates handle stale state

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

  // ── Export snapshot as JSON (for CLI use) ───────────────────────────────
  const exportSnapshot = useCallback(async () => {
    if (!snapshot) return;
    setExporting(true);
    try {
      const filename = `runcoach-snapshot-${new Date().toISOString().split('T')[0]}.json`;
      const path = `${FileSystem.cacheDirectory}${filename}`;
      await FileSystem.writeAsStringAsync(path, JSON.stringify(snapshot, null, 2));
      await Sharing.shareAsync(path, {
        mimeType: 'application/json',
        dialogTitle: 'Save RunCoach snapshot',
        UTI: 'public.json',
      });
    } catch (err: any) {
      Alert.alert('Export failed', err.message);
    } finally {
      setExporting(false);
    }
  }, [snapshot]);

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
  const latestVO2 = snapshot?.vo2max?.slice(-1)[0];
  const latestRHR = snapshot?.restingHR?.slice(-1)[0];
  const totalKmThisWeek = snapshot?.weeklyMileage?.slice(-1)[0]?.km ?? 0;
  const recovery = snapshot?.todayRecovery ?? null;

  return (
    <SafeAreaView style={styles.container}>
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
        {/* Wellness rings — top priority */}
        <WellnessRings
          recovery={recovery}
          onRefresh={onRefresh}
          refreshing={refreshing}
          onShowHistory={() => router.push({ pathname: '/history' as any, params: { type: 'hrv' } })}
        />

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
              <Text style={styles.coachBtnText}>📋 Full Report</Text>
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
            <Text style={styles.statValue}>{totalKmThisWeek} km</Text>
            <Text style={styles.statLabel}>This week ›</Text>
          </TouchableOpacity>
          {latestVO2 && (
            <TouchableOpacity
              style={styles.statCard}
              onPress={() => router.push({ pathname: '/history' as any, params: { type: 'vo2' } })}
              activeOpacity={0.75}
            >
              <Text style={styles.statValue}>{latestVO2.value}</Text>
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
          <TouchableOpacity
            style={[styles.statCard, styles.exportCard]}
            onPress={exportSnapshot}
            disabled={exporting || !snapshot}
          >
            {exporting
              ? <ActivityIndicator size="small" color="#FF6B35" />
              : <Text style={styles.exportIcon}>↑</Text>}
            <Text style={styles.statLabel}>Export</Text>
          </TouchableOpacity>
        </View>

        {/* Recent runs */}
        <View style={styles.sectionRow}>
          <Text style={styles.sectionTitle}>Recent Runs</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {runFilter !== 'All' && (
              <Text style={styles.filterCount}>{runs.length} of {allRuns.length}</Text>
            )}
            <TouchableOpacity onPress={promptSyncMonths} style={styles.monthsBtn}>
              <Text style={styles.monthsBtnText}>{syncMonths}M ▾</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Filter chips */}
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

        {runs.length === 0 ? (
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
            <RunCard key={run.uuid} run={run} />
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Ring arc component ───────────────────────────────────────────────────────

function Ring({
  size, strokeWidth, progress, color, label, value,
}: {
  size: number; strokeWidth: number; progress: number;
  color: string; label: string; value: string;
}) {
  const p     = Math.min(1, Math.max(0, progress));
  const angle = p * 360;
  const half  = size / 2;

  const rightRotate = `${angle <= 180 ? angle - 90 : 90}deg`;
  const leftVisible = angle > 180;
  const leftRotate  = `${(angle - 180) - 90}deg`;

  return (
    <View style={{ alignItems: 'center', gap: 6 }}>
      <View style={{ width: size, height: size }}>
        {/* Track ring */}
        <View style={{
          position: 'absolute', width: size, height: size,
          borderRadius: half, borderWidth: strokeWidth,
          borderColor: color + '28',
        }} />

        {/* Right half (0 → 180°) — clip to right side of container */}
        {angle > 0 && (
          <View style={{
            position: 'absolute', left: half, top: 0,
            width: half, height: size, overflow: 'hidden',
          }}>
            <View style={{
              position: 'absolute', left: -half, top: 0,
              width: size, height: size,
              borderRadius: half, borderWidth: strokeWidth,
              borderColor: color,
              transform: [{ rotate: rightRotate }],
            }} />
          </View>
        )}

        {/* Left half (180 → 360°) — clip to left side of container */}
        {leftVisible && (
          <View style={{
            position: 'absolute', left: 0, top: 0,
            width: half, height: size, overflow: 'hidden',
          }}>
            <View style={{
              position: 'absolute', left: 0, top: 0,
              width: size, height: size,
              borderRadius: half, borderWidth: strokeWidth,
              borderColor: color,
              transform: [{ rotate: leftRotate }],
            }} />
          </View>
        )}

        {/* Center label */}
        <View style={{
          position: 'absolute', width: size, height: size,
          alignItems: 'center', justifyContent: 'center',
        }}>
          <Text style={{ fontSize: size * 0.24, fontWeight: '800', color, lineHeight: size * 0.28 }}>
            {value}
          </Text>
          <Text style={{ fontSize: size * 0.11, color: '#aaa', letterSpacing: 0.3 }}>
            {label}
          </Text>
        </View>
      </View>
    </View>
  );
}

// ─── Wellness Rings Card ──────────────────────────────────────────────────────

type WellnessRingsProps = {
  recovery: DailyRecovery | null;
  onRefresh: () => void;
  refreshing: boolean;
  onShowHistory: () => void;
};

function WellnessRings({ recovery, onRefresh, refreshing, onShowHistory }: WellnessRingsProps) {
  const router = useRouter();
  const today  = new Date().toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short',
  });

  const navToRecovery = () => {
    if (recovery) router.push({ pathname: '/recovery-detail' as any, params: { data: JSON.stringify(recovery) } });
  };
  const navToSleep = () => {
    if (recovery) router.push({ pathname: '/sleep-detail' as any, params: { data: JSON.stringify(recovery) } });
  };

  if (!recovery) {
    return (
      <View style={styles.wellnessCard}>
        <View style={styles.wellnessHeader}>
          <Text style={styles.wellnessTitle}>Today's Wellness</Text>
          <Text style={styles.wellnessSubtitle}>{today}</Text>
        </View>
        <Text style={styles.wellnessUnavailable}>🌙  Waiting for sleep data to sync…</Text>
        <Text style={styles.recoveryUnavailableHint}>
          Apple Health sometimes needs a moment after waking up.
        </Text>
        <TouchableOpacity style={styles.refreshBtn} onPress={onRefresh} disabled={refreshing}>
          {refreshing
            ? <ActivityIndicator size="small" color="#FF6B35" />
            : <Text style={styles.refreshBtnText}>↻  Refresh</Text>}
        </TouchableOpacity>
      </View>
    );
  }

  const recScore   = recovery.recoveryScore;
  const sleepScore = recovery.sleepScore ?? 0;
  const { color, sleep, weightedRMSSD, overnightHR } = recovery;

  const advice =
    recScore >= 75 ? 'Great recovery — quality session is fine today.' :
    recScore >= 55 ? 'Good recovery — moderate intensity is fine.' :
    recScore >= 35 ? 'Moderate recovery — keep intensity easy.' :
                     'Low recovery — prioritise rest or easy movement.';

  const noHRV = recovery.weightedRMSSD === 0;

  return (
    <View style={styles.wellnessCard}>
      <View style={styles.wellnessHeader}>
        <Text style={styles.wellnessTitle}>Today's Wellness</Text>
        <Text style={styles.wellnessSubtitle}>{today}</Text>
      </View>

      {noHRV ? (
        <>
          <Text style={styles.wellnessUnavailable}>🫀  Sleep detected — HRV syncing…</Text>
          {sleep && (
            <Text style={styles.sleepText}>
              🌙  {Math.round(sleep.totalMinutes / 60 * 10) / 10}h  ·  {sleep.deepMinutes}m deep  ·  {sleep.remMinutes}m REM
            </Text>
          )}
          <View style={styles.ringsRow}>
            <View style={{ flex: 1, alignItems: 'center' }}>
              <Ring size={80}  strokeWidth={8}  progress={0}              color="#e74c3c" label="STRAIN"   value="--" />
            </View>
            <View style={{ flex: 1, alignItems: 'center' }}>
              <Ring size={100} strokeWidth={10} progress={0}              color="#888"    label="RECOVERY" value="--" />
            </View>
            <TouchableOpacity style={{ flex: 1, alignItems: 'center' }} onPress={navToSleep} activeOpacity={0.75}>
              <Ring size={80}  strokeWidth={8}  progress={sleepScore/100} color="#8e44ad" label="SLEEP"    value={sleepScore > 0 ? String(sleepScore) : '--'} />
              <Text style={styles.ringHint}>tap for details</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity style={[styles.refreshBtn, { marginTop: 10 }]} onPress={onRefresh} disabled={refreshing}>
            {refreshing
              ? <ActivityIndicator size="small" color="#FF6B35" />
              : <Text style={styles.refreshBtnText}>↻  Refresh</Text>}
          </TouchableOpacity>
        </>
      ) : (
        <>
          <View style={styles.ringsRow}>
            {/* Strain — placeholder, not tappable yet */}
            <View style={{ flex: 1, alignItems: 'center' }}>
              <Ring size={80}  strokeWidth={8}  progress={0}             color="#e74c3c" label="STRAIN"   value="--" />
            </View>
            {/* Recovery — tappable */}
            <TouchableOpacity style={{ flex: 1, alignItems: 'center' }} onPress={navToRecovery} activeOpacity={0.75}>
              <Ring size={100} strokeWidth={10} progress={recScore/100}  color={color}   label="RECOVERY" value={String(recScore)} />
              <Text style={styles.ringHint}>tap for details</Text>
            </TouchableOpacity>
            {/* Sleep — tappable */}
            <TouchableOpacity style={{ flex: 1, alignItems: 'center' }} onPress={navToSleep} activeOpacity={0.75}>
              <Ring size={80}  strokeWidth={8}  progress={sleepScore/100} color="#8e44ad" label="SLEEP"   value={sleepScore > 0 ? String(sleepScore) : '--'} />
              <Text style={styles.ringHint}>tap for details</Text>
            </TouchableOpacity>
          </View>

          <Text style={[styles.wellnessAdvice, { color }]}>{advice}</Text>

          <View style={styles.wellnessMetrics}>
            {weightedRMSSD > 0 && (
              <Text style={styles.wellnessMetric}>RMSSD {weightedRMSSD} ms</Text>
            )}
            {overnightHR > 0 && (
              <Text style={styles.wellnessMetric}>Night HR {overnightHR} bpm</Text>
            )}
            {sleep && (
              <Text style={styles.wellnessMetric}>
                🌙 {Math.round(sleep.totalMinutes / 60 * 10) / 10}h  ·  {sleep.deepMinutes}m deep  ·  {sleep.remMinutes}m REM
              </Text>
            )}
          </View>
        </>
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

function RunCard({ run }: { run: RunWorkout }) {
  const router = useRouter();
  const date = new Date(run.date).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short',
  });
  const startTime = new Date(run.date).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit',
  });
  const labelStyle = run.label ? (LABEL_STYLE[run.label] ?? LABEL_STYLE.Unknown) : null;
  const displayPace  = run.workPace  ?? run.pace;
  const displayHR    = run.workHR    ?? run.avgHeartRate;
  const isWorkPace   = !!run.workPace && run.workPace !== run.pace;

  const openDetail = () => {
    router.push({
      pathname: '/workout/[id]' as any,
      params: {
        id:        run.uuid,
        startDate: run.date,
        duration:  String(run.duration),
        label:     run.label ?? '',
        date:      run.date,
        distance:  String(run.distance),
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
            <View style={[styles.workoutBadge, { backgroundColor: labelStyle.bg }]}>
              <Text style={[styles.workoutBadgeText, { color: labelStyle.color }]}>
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
          {formatDuration(run.duration)}{'  '}{formatPace(displayPace)}
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F5F5F5' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  loadingText: { marginTop: 12, color: '#666', fontSize: 15, textAlign: 'center' },
  progressTrack: {
    marginTop: 16, width: 220, height: 6, borderRadius: 3,
    backgroundColor: '#eee', overflow: 'hidden',
  },
  progressFill: { height: 6, borderRadius: 3, backgroundColor: '#FF6B35' },
  progressPct: { marginTop: 6, fontSize: 12, color: '#aaa' },

  monthsBtn: {
    borderRadius: 8, borderWidth: 1, borderColor: '#ddd',
    backgroundColor: '#fff', paddingHorizontal: 8, paddingVertical: 3,
  },
  monthsBtnText: { fontSize: 11, color: '#888', fontWeight: '600' },

  wellnessCard: {
    backgroundColor: '#fff', margin: 12, marginBottom: 8, borderRadius: 16,
    padding: 16,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08, shadowRadius: 6, elevation: 3,
  },
  wellnessHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  wellnessTitle: { fontSize: 16, fontWeight: '700', color: '#222' },
  wellnessSubtitle: { fontSize: 12, color: '#aaa' },
  ringsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', marginBottom: 14 },
  wellnessAdvice: { fontSize: 13, fontStyle: 'italic', fontWeight: '500', marginBottom: 10 },
  wellnessMetrics: { gap: 3, borderTopWidth: 1, borderTopColor: '#f5f5f5', paddingTop: 8 },
  wellnessMetric: { fontSize: 12, color: '#777' },
  ringHint: { fontSize: 9, color: '#bbb', marginTop: 3 },
  wellnessUnavailable: { fontSize: 15, color: '#555', marginBottom: 4, fontWeight: '500' },
  recoveryUnavailableHint: { fontSize: 12, color: '#aaa', marginBottom: 12, lineHeight: 18 },
  refreshBtn: {
    alignSelf: 'flex-start', backgroundColor: '#FFF3EE', borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1, borderColor: '#FF6B35',
  },
  refreshBtnText: { color: '#FF6B35', fontSize: 14, fontWeight: '700' },
  sleepText: { fontSize: 12, color: '#777', marginBottom: 6 },

  btnRow: { flexDirection: 'row', marginHorizontal: 12, marginBottom: 8, gap: 8 },
  btnFlex: { flex: 1, marginHorizontal: 0 },
  coachBtn: { marginHorizontal: 12, marginBottom: 8, backgroundColor: '#FF6B35', borderRadius: 12, paddingVertical: 16, alignItems: 'center' },
  coachBtnSecondary: { backgroundColor: '#2c3e50' },
  coachBtnWarning: { backgroundColor: '#888' },
  coachBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },

  statsRow: { flexDirection: 'row', paddingHorizontal: 12, gap: 6, marginBottom: 12 },
  statCard: { flex: 1, backgroundColor: '#fff', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 7, alignItems: 'center' },
  exportCard: { borderWidth: 1, borderColor: '#FF6B35', backgroundColor: '#FFF3EE' },
  exportIcon: { fontSize: 13, fontWeight: '700', color: '#FF6B35' },
  statValue: { fontSize: 13, fontWeight: '700', color: '#FF6B35' },
  statLabel: { fontSize: 10, color: '#888', marginTop: 1 },

  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginHorizontal: 16, marginBottom: 6 },
  sectionTitle: { fontSize: 12, fontWeight: '700', color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 },
  filterCount: { fontSize: 12, color: '#aaa' },
  filterBar: { paddingHorizontal: 12, gap: 6, paddingBottom: 2 },
  filterChip: { borderRadius: 12, borderWidth: 1, borderColor: '#ddd', backgroundColor: '#fff', paddingHorizontal: 9, paddingVertical: 3 },
  filterChipActive: { backgroundColor: '#FF6B35', borderColor: '#FF6B35' },
  filterChipText: { fontSize: 11, color: '#666', fontWeight: '500' },
  filterChipTextActive: { color: '#fff', fontWeight: '700' },
  emptyBox: { margin: 16, alignItems: 'center' },
  emptyText: { fontSize: 15, color: '#555', marginBottom: 6 },
  emptySubtext: { fontSize: 13, color: '#999', textAlign: 'center' },
  emptyLink: { fontSize: 14, color: '#FF6B35', fontWeight: '600' },

  runCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#fff', marginHorizontal: 12, marginBottom: 6, borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 10,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 3, elevation: 2,
  },
  runDate:     { fontSize: 13, fontWeight: '600', color: '#333' },
  runStartTime: { fontSize: 13, fontWeight: '700', color: '#555' },
  workoutBadge: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  workoutBadgeText: { fontSize: 11, fontWeight: '700' },
  runDistance:  { fontSize: 16, fontWeight: '800', color: '#111' },
  runStat:      { fontSize: 13, color: '#555' },
  runStatWork:  { color: '#FF6B35', fontWeight: '600' },
  runStatPower: { fontSize: 12, color: '#8e44ad' },
  runStatHR:    { fontSize: 12, color: '#e74c3c' },
});
