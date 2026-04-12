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
import { useRouter } from 'expo-router';
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
import { getApiKey, getSyncMonths, setSyncMonths, SyncMonths } from '../src/services/claude';
import { HealthSnapshot, RunWorkout, DailyRecovery, WorkoutLabel } from '../src/types';

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
  const appState = useRef(AppState.currentState);

  // Load persisted sync-months preference once on mount
  useEffect(() => {
    getSyncMonths().then(setSyncMonthsState);
  }, []);

  // ── Core load function ──────────────────────────────────────────────────
  const load = useCallback(async (isRefresh = false, monthsOverride?: SyncMonths) => {
    const months = monthsOverride ?? syncMonths;
    if (!isRefresh) {
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
      setLoading(false);
      setLoadingStep(null);
      setRefreshing(false);
    }
  }, [syncMonths]);

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
    setRefreshing(true);
    load(true);
  }, [load]);

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
        {/* Recovery Card — top priority */}
        <RecoveryCard recovery={recovery} onRefresh={onRefresh} refreshing={refreshing} />

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
          <StatCard label="This week" value={`${totalKmThisWeek} km`} />
          {latestVO2 && <StatCard label="VO₂ Max" value={`${latestVO2.value}`} />}
          {latestRHR && <StatCard label="Resting HR" value={`${latestRHR.value} bpm`} />}
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
          runs.map((run) => <RunCard key={run.uuid} run={run} />)
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Recovery Card ────────────────────────────────────────────────────────────

type RecoveryCardProps = {
  recovery: DailyRecovery | null;
  onRefresh: () => void;
  refreshing: boolean;
};

function RecoveryCard({ recovery, onRefresh, refreshing }: RecoveryCardProps) {
  // Case 1: No sleep data yet
  if (!recovery) {
    return (
      <View style={[styles.recoveryCard, { borderLeftColor: '#ccc' }]}>
        <View style={styles.recoveryHeader}>
          <Text style={styles.recoveryTitle}>Today's Recovery</Text>
        </View>
        <Text style={styles.recoveryUnavailable}>
          🌙  Sleep data not available for recovery calculation.
        </Text>
        <Text style={styles.recoveryUnavailableHint}>
          Apple Health sometimes needs a moment after waking up to sync sleep data.
        </Text>
        <TouchableOpacity
          style={styles.refreshBtn}
          onPress={onRefresh}
          disabled={refreshing}
        >
          {refreshing
            ? <ActivityIndicator size="small" color="#FF6B35" />
            : <Text style={styles.refreshBtnText}>↻  Refresh</Text>}
        </TouchableOpacity>
      </View>
    );
  }

  // Case 2: Sleep session found but no HRV readings during it
  if (recovery.weightedRMSSD === 0) {
    return (
      <View style={[styles.recoveryCard, { borderLeftColor: '#f39c12' }]}>
        <View style={styles.recoveryHeader}>
          <Text style={styles.recoveryTitle}>Today's Recovery</Text>
          <View style={[styles.recoveryBadge, { backgroundColor: '#f39c12' }]}>
            <Text style={styles.recoveryBadgeText}>NO HRV</Text>
          </View>
        </View>
        <Text style={styles.recoveryUnavailable}>
          🫀  Sleep detected but HRV readings not yet available.
        </Text>
        {recovery.sleep && (
          <Text style={styles.sleepText}>
            🌙  {Math.round(recovery.sleep.totalMinutes / 60 * 10) / 10}h sleep  ·  {recovery.sleep.deepMinutes}m deep  ·  {recovery.sleep.remMinutes}m REM
          </Text>
        )}
        <Text style={styles.recoveryUnavailableHint}>
          HRV data from sleep is usually synced within 30 minutes of waking up.
        </Text>
        <TouchableOpacity style={styles.refreshBtn} onPress={onRefresh} disabled={refreshing}>
          {refreshing
            ? <ActivityIndicator size="small" color="#FF6B35" />
            : <Text style={styles.refreshBtnText}>↻  Refresh</Text>}
        </TouchableOpacity>
      </View>
    );
  }

  // Case 3: Full recovery data
  const { recoveryScore, weightedRMSSD, baseline7Day, trend, label, color, sleep } = recovery;
  const trendSymbol = trend === 'rising' ? '↑' : trend === 'falling' ? '↓' : '→';
  const trendColor = trend === 'rising' ? '#27ae60' : trend === 'falling' ? '#c0392b' : '#888';

  return (
    <View style={[styles.recoveryCard, { borderLeftColor: color }]}>
      <View style={styles.recoveryHeader}>
        <Text style={styles.recoveryTitle}>Today's Recovery</Text>
        <View style={[styles.recoveryBadge, { backgroundColor: color }]}>
          <Text style={styles.recoveryBadgeText}>{label.toUpperCase()}</Text>
        </View>
      </View>

      <View style={styles.recoveryScoreRow}>
        <View style={[styles.recoveryScoreCircle, { borderColor: color + '44' }]}>
          <Text style={[styles.recoveryScoreNumber, { color }]}>{recoveryScore}</Text>
          <Text style={styles.recoveryScoreLabel}>/100</Text>
        </View>
        <View style={styles.recoveryMetrics}>
          <MetricRow label="RMSSD (sleep)" value={`${weightedRMSSD} ms`} />
          <MetricRow label="HRV baseline" value={`${baseline7Day} ms`} />
          {recovery.overnightHR > 0 && (
            <MetricRow
              label="Overnight HR"
              value={`${recovery.overnightHR} bpm`}
              valueColor={
                recovery.overnightHRBaseline > 0 && recovery.overnightHR > recovery.overnightHRBaseline + 3
                  ? '#c0392b'
                  : recovery.overnightHR < recovery.overnightHRBaseline - 3
                  ? '#27ae60'
                  : undefined
              }
            />
          )}
          <MetricRow label="Trend" value={`${trendSymbol} ${trend}`} valueColor={trendColor} />
        </View>
      </View>

      {sleep && (
        <View style={styles.sleepRow}>
          <Text style={styles.sleepIcon}>🌙</Text>
          <Text style={styles.sleepText}>
            {Math.round(sleep.totalMinutes / 60 * 10) / 10}h  ·  {sleep.deepMinutes}m deep  ·  {sleep.remMinutes}m REM  ·  {sleep.awakeMinutes}m awake
          </Text>
        </View>
      )}

      <Text style={[styles.recoveryAdvice, { color }]}>
        {recoveryScore >= 80
          ? 'Great recovery — quality session or long run is fine.'
          : recoveryScore >= 60
          ? 'Moderate recovery — keep effort easy to moderate today.'
          : 'Low recovery — prioritise easy movement or rest.'}
      </Text>
    </View>
  );
}

function MetricRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <View style={styles.metricRow}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, valueColor ? { color: valueColor } : null]}>{value}</Text>
    </View>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statCard}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
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

  return (
    <View style={styles.runCard}>
      {/* Left: start time / date + badge / km */}
      <View style={{ flex: 1 }}>
        <Text style={styles.runStartTime}>{startTime}</Text>
        <View style={styles.runCardTopRow}>
          <Text style={styles.runDate}>{date}</Text>
          {labelStyle && (
            <View style={[styles.workoutBadge, { backgroundColor: labelStyle.bg }]}>
              <Text style={[styles.workoutBadgeText, { color: labelStyle.color }]}>
                {labelStyle.emoji} {run.label}
                {run.confidence === 'low' ? ' ?' : ''}
              </Text>
            </View>
          )}
        </View>
        <Text style={styles.runDistance}>{formatDistance(run.distance)}</Text>
      </View>

      {/* Right: 2×2 grid — duration | pace / power | HR */}
      <View style={styles.runStatsGrid}>
        <View style={styles.runStatsCol}>
          <Text style={styles.runStat}>{formatDuration(run.duration)}</Text>
          <Text style={styles.runStatPower}>
            {(run.workPower ?? 0) > 0
              ? `⚡ ${run.isEstimatedPower ? '~' : ''}${run.workPower}W`
              : ''}
          </Text>
        </View>
        <View style={[styles.runStatsCol, { alignItems: 'flex-end' }]}>
          <Text style={[styles.runStat, isWorkPace && styles.runStatWork]}>
            {formatPace(displayPace)}
          </Text>
          {displayHR != null && (
            <Text style={styles.runStatHR}>♥ {displayHR} bpm</Text>
          )}
        </View>
      </View>
    </View>
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

  recoveryCard: {
    backgroundColor: '#fff', margin: 12, marginBottom: 8, borderRadius: 16,
    padding: 16, borderLeftWidth: 5, borderLeftColor: '#ccc',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08, shadowRadius: 6, elevation: 3,
  },
  recoveryHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  recoveryTitle: { fontSize: 16, fontWeight: '700', color: '#222' },
  recoveryBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  recoveryBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  recoveryUnavailable: { fontSize: 15, color: '#555', marginBottom: 4, fontWeight: '500' },
  recoveryUnavailableHint: { fontSize: 12, color: '#aaa', marginBottom: 12, lineHeight: 18 },
  refreshBtn: {
    alignSelf: 'flex-start', backgroundColor: '#FFF3EE', borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1, borderColor: '#FF6B35',
  },
  refreshBtnText: { color: '#FF6B35', fontSize: 14, fontWeight: '700' },
  recoveryScoreRow: { flexDirection: 'row', alignItems: 'center', gap: 16, marginBottom: 10 },
  recoveryScoreCircle: {
    width: 80, height: 80, borderRadius: 40, borderWidth: 3,
    alignItems: 'center', justifyContent: 'center',
  },
  recoveryScoreNumber: { fontSize: 32, fontWeight: '800', lineHeight: 36 },
  recoveryScoreLabel: { fontSize: 11, color: '#aaa' },
  recoveryMetrics: { flex: 1, gap: 5 },
  metricRow: { flexDirection: 'row', justifyContent: 'space-between' },
  metricLabel: { fontSize: 12, color: '#999' },
  metricValue: { fontSize: 12, fontWeight: '600', color: '#333' },
  sleepRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 8, marginBottom: 8, borderTopWidth: 1, borderTopColor: '#f5f5f5' },
  sleepIcon: { fontSize: 13 },
  sleepText: { fontSize: 12, color: '#777' },
  recoveryAdvice: { fontSize: 13, fontStyle: 'italic', fontWeight: '500' },

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

  runCard: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#fff', marginHorizontal: 12, marginBottom: 8, borderRadius: 12, padding: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 3, elevation: 2 },
  runCardTopRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 1 },
  runDate: { fontSize: 12, color: '#999' },
  runStartTime: { fontSize: 11, color: '#bbb', marginBottom: 2 },
  workoutBadge: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  workoutBadgeText: { fontSize: 11, fontWeight: '700' },
  runDistance: { fontSize: 17, fontWeight: '700', color: '#222', marginTop: 2 },
  runStatsGrid: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  runStatsCol: { alignItems: 'flex-start', gap: 3 },
  runStat: { fontSize: 13, color: '#555' },
  runStatWork: { color: '#FF6B35', fontWeight: '600' },
  runStatPower: { fontSize: 12, color: '#8e44ad' },
  runStatHR: { fontSize: 12, color: '#e74c3c' },
});
