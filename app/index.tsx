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

import {
  requestPermissions,
  fetchHealthSnapshot,
  formatDistance,
  formatDuration,
  formatPace,
  subscribeToWorkoutChanges,
  saveSnapshotCache,
} from '../src/services/healthkit';
import { computeWorkoutTypeStats } from '../src/services/workoutClassifier';
import { getApiKey, getSyncMonths, setSyncMonths, SyncMonths, getRunOverrides, getTrainingRecommendation, TrainingRecommendation } from '../src/services/claude';
import { getLocalWeather, weatherSummary } from '../src/services/weather';
import { tsbStatus, strainStatus, cardioLoadStatus } from '../src/services/trainingLoad';
import { loadRunMeta } from '../src/services/runMeta';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import { HealthSnapshot, RunWorkout, DailyRecovery, WorkoutLabel, DailyLoad, DayStrain } from '../src/types';
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
  const styles = useThemedStyles(makeStyles);
  const [snapshot, setSnapshot]         = useState<HealthSnapshot | null>(null);
  const [loading, setLoading]           = useState(true);
  const [refreshing, setRefreshing]     = useState(false);
  const [hasApiKey, setHasApiKey]       = useState(false);
  const [runFilter, setRunFilter]       = useState<RunFilter>('All');
  const [syncMonths, setSyncMonthsState] = useState<SyncMonths>(3);
  const [loadingStep, setLoadingStep]   = useState<{ step: string; pct: number } | null>(null);
  const [recommendation, setRecommendation] = useState<TrainingRecommendation | null>(null);
  const [loadingRec, setLoadingRec]     = useState(false);
  const appState      = useRef(AppState.currentState);
  // Ref so `load` never needs syncMonths in its dependency array (avoids double-load)
  const syncMonthsRef  = useRef<SyncMonths>(3);
  // Guard against concurrent loads (AppState + subscription can both fire at startup)
  const isLoadingRef   = useRef(false);

  // ── Build local-time + city context string for the coach ──────────────────
  const buildLocalContext = useCallback(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const city = tz.split('/').pop()?.replace(/_/g, ' ') ?? '';
    const when = new Date().toLocaleString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: tz,
    });
    return city ? `Location: ${city} · ${when}` : when;
  }, []);

  // ── Generate (or refresh) the training recommendation ─────────────────────
  // Weather is fetched here (GPS → Open-Meteo) and passed in. getTrainingRecommendation
  // caches by a key that includes the run-label signature, so a reclassification
  // automatically yields a fresh recommendation.
  const refreshRecommendation = useCallback(async (snap: HealthSnapshot) => {
    const key = await getApiKey();
    if (!key || snap.runs.length === 0) return;
    setLoadingRec(true);
    try {
      const localCtx = buildLocalContext();
      const weather  = await getLocalWeather();           // null if denied/unavailable
      const wxStr    = weather ? weatherSummary(weather) : undefined;
      const rec = await getTrainingRecommendation(snap, localCtx, wxStr);
      setRecommendation(rec);
    } catch {
      // silently ignore — card simply won't appear/update
    } finally {
      setLoadingRec(false);
    }
  }, [buildLocalContext]);

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
      saveSnapshotCache(snap).catch(() => {});
      setHasApiKey(!!key);

      // Load training recommendation non-blocking (weather + load aware, cached by signature)
      if (key && snap.runs.length > 0) {
        refreshRecommendation(snap);
      }
    } catch (err: any) {
      Alert.alert('Error loading health data', err.message);
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
  useEffect(() => { load(); }, [load]);

  // ── Re-apply overrides when returning from workout detail ─────────────────
  // IMPORTANT: do NOT close over `snapshot` here — useCallback(fn, []) captures
  // it as null (initial render).  Use functional setSnapshot(prev =>) instead
  // so we always operate on the latest state regardless of when the callback fires.
  useFocusEffect(useCallback(() => {
    // Re-check the API key every time we return to this screen (e.g. after
    // the user saves a key in Settings) so the Chat button appears immediately.
    getApiKey().then((k) => setHasApiKey(!!k)).catch(() => {});

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
          strain={snapshot?.strain ?? null}
          onRefresh={onRefresh}
          refreshing={refreshing}
          onShowHistory={() => router.push({ pathname: '/history' as any, params: { type: 'hrv' } })}
        />

        {/* Training recommendation */}
        {(loadingRec || recommendation) && (
          <TrainingRecommendationCard rec={recommendation} loading={loadingRec} />
        )}

        {/* Training load (CTL/ATL/TSB) — its own block */}
        {snapshot?.trainingLoad && snapshot.trainingLoad.length > 0 && (
          <TrainingLoadCard
            series={snapshot.trainingLoad}
            onPress={() => router.push('/training-load' as any)}
          />
        )}

        {/* Bevel calibration shortcut */}
        <TouchableOpacity
          style={styles.calibrateBtn}
          onPress={() => router.push('/bevel-analysis' as any)}
          activeOpacity={0.75}
        >
          <Text style={styles.calibrateBtnText}>⚖️  Overall Bevel Calibration</Text>
          <Text style={styles.calibrateBtnSub}>Compare every KPI &amp; component vs Bevel</Text>
        </TouchableOpacity>

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
            <RunCard key={run.uuid} run={run} siblings={runs} />
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Training Recommendation Card ────────────────────────────────────────────

const REC_ICONS: Record<string, string> = {
  Rest: '😴', Easy: '🟢', Z2: '🟢', Tempo: '🟠', LongRun: '🔵', Intervals: '🔴',
};
const REC_COLORS: Record<string, string> = {
  Rest: '#6B7280', Easy: '#22C55E', Z2: '#22C55E', Tempo: '#F97316', LongRun: '#3B82F6', Intervals: '#EF4444',
};

function TrainingRecommendationCard({ rec, loading }: { rec: TrainingRecommendation | null; loading: boolean }) {
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

  const color = REC_COLORS[rec.type] ?? '#FF6B35';
  const icon  = REC_ICONS[rec.type]  ?? '🏃';

  return (
    <View style={[recStyles.card, { borderLeftColor: color }]}>
      <View style={recStyles.header}>
        <Text style={recStyles.icon}>{icon}</Text>
        <View style={{ flex: 1 }}>
          <Text style={[recStyles.type, { color }]}>{rec.type === 'LongRun' ? 'Long Run' : rec.type}</Text>
          {rec.type !== 'Rest' && (
            <Text style={recStyles.meta}>{rec.duration}{rec.zone && rec.zone !== '—' ? ` · ${rec.zone}` : ''}</Text>
          )}
        </View>
        <Text style={recStyles.badge}>Today's plan</Text>
      </View>
      <Text style={recStyles.reason}>{rec.reason}</Text>
    </View>
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
      <Text style={tl.band}>
        Cardio Load <Text style={{ color: cl.color, fontWeight: '800' }}>{Math.round(cl.load)}</Text>
        {cl.ctl > 0 ? ` · optimal ${Math.round(cl.bandLo)}–${Math.round(cl.bandHi)}` : ''}
      </Text>
      <Text style={tl.hint}>{cl.hint}  ›</Text>
    </TouchableOpacity>
  );
}

const makeTlStyles = (c: Palette) => StyleSheet.create({
  card: {
    marginHorizontal: 16, marginTop: 4, marginBottom: 4,
    backgroundColor: c.surface, borderRadius: 12, padding: 14, gap: 10,
    borderLeftWidth: 4, borderLeftColor: '#3B82F6',
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 15, fontWeight: '700', color: c.text },
  statusPill: {
    fontSize: 11, fontWeight: '700', borderWidth: 1, borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 2, overflow: 'hidden',
  },
  metricsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  metric: { alignItems: 'center', minWidth: 54 },
  metricVal: { fontSize: 22, fontWeight: '800' },
  metricLbl: { fontSize: 11, color: c.textSub, marginTop: 1, fontWeight: '600' },
  metricSub: { fontSize: 9, color: c.textFaint, fontWeight: '600' },
  band: { fontSize: 12, color: c.textSub, fontWeight: '600' },
  hint: { fontSize: 12, color: c.textSub, lineHeight: 16 },
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
  reason: {
    fontSize: 13,
    color: c.text,
    lineHeight: 18,
  },
  loadingText: {
    fontSize: 13,
    color: c.textFaint,
    marginLeft: 8,
  },
});

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

// ─── Bare ring arc (no centre label) — used for the strain double ring ────────

function ArcRing({ size, strokeWidth, progress, color, trackColor }: {
  size: number; strokeWidth: number; progress: number; color: string; trackColor?: string;
}) {
  const p     = Math.min(1, Math.max(0, progress));
  const angle = p * 360;
  const half  = size / 2;
  const rightRotate = `${angle <= 180 ? angle - 90 : 90}deg`;
  const leftVisible = angle > 180;
  const leftRotate  = `${(angle - 180) - 90}deg`;
  return (
    <View style={{ width: size, height: size }}>
      <View style={{ position: 'absolute', width: size, height: size, borderRadius: half, borderWidth: strokeWidth, borderColor: trackColor ?? color + '24' }} />
      {angle > 0 && (
        <View style={{ position: 'absolute', left: half, top: 0, width: half, height: size, overflow: 'hidden' }}>
          <View style={{ position: 'absolute', left: -half, top: 0, width: size, height: size, borderRadius: half, borderWidth: strokeWidth, borderColor: color, transform: [{ rotate: rightRotate }] }} />
        </View>
      )}
      {leftVisible && (
        <View style={{ position: 'absolute', left: 0, top: 0, width: half, height: size, overflow: 'hidden' }}>
          <View style={{ position: 'absolute', left: 0, top: 0, width: size, height: size, borderRadius: half, borderWidth: strokeWidth, borderColor: color, transform: [{ rotate: leftRotate }] }} />
        </View>
      )}
    </View>
  );
}

// ─── Strain double ring: outer = real effort, inner = safe target ─────────────

const SAFE_COLOR = '#16a085';

function StrainRing({ size, strain }: { size: number; strain: DayStrain | null }) {
  const styles = useThemedStyles(makeStyles);
  const real = strain ? strain.real : 0;
  const st   = strain ? strainStatus(strain) : { label: '', color: '#888' };

  // Marker on the ring circumference at a given % (clockwise from 12 o'clock)
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
    <View style={{ alignItems: 'center', gap: 5 }}>
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        {/* Real effort — single ring, same size as recovery/sleep */}
        <ArcRing size={size} strokeWidth={8} progress={real / 100} color={st.color} />
        {/* Suggested-range markers (floor + ceiling) */}
        {strain && marker(strain.safeLow, 'lo')}
        {strain && marker(strain.safeHigh, 'hi')}
        <View style={{ position: 'absolute', alignItems: 'center' }}>
          <Text style={{ fontSize: size * 0.24, fontWeight: '800', color: st.color, lineHeight: size * 0.28 }}>
            {strain ? `${real}%` : '--'}
          </Text>
          <Text style={{ fontSize: size * 0.11, color: '#aaa', letterSpacing: 0.3 }}>STRAIN</Text>
        </View>
      </View>
      <Text style={[styles.strainCaption, { color: SAFE_COLOR }]}>
        {strain ? `range ${strain.safeLow}–${strain.safeHigh}%` : ''}
      </Text>
    </View>
  );
}

type WellnessRingsProps = {
  recovery: DailyRecovery | null;
  strain: DayStrain | null;
  onRefresh: () => void;
  refreshing: boolean;
  onShowHistory: () => void;
};

function WellnessRings({ recovery, strain, onRefresh, refreshing }: WellnessRingsProps) {
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);
  const today  = new Date().toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short',
  });

  const navToRecovery = () => {
    if (recovery) router.push({ pathname: '/recovery-detail' as any, params: { data: JSON.stringify(recovery) } });
  };
  const navToSleep = () => {
    if (recovery) router.push({ pathname: '/sleep-detail' as any, params: { data: JSON.stringify(recovery) } });
  };

  // Nothing at all yet
  if (!recovery && !strain) {
    return (
      <View style={styles.wellnessCard}>
        <View style={styles.wellnessHeader}>
          <Text style={styles.wellnessTitle}>Today's Wellness</Text>
          <Text style={styles.wellnessSubtitle}>{today}</Text>
        </View>
        <Text style={styles.wellnessUnavailable}>🌙  Waiting for data to sync…</Text>
        <TouchableOpacity style={styles.refreshBtn} onPress={onRefresh} disabled={refreshing}>
          {refreshing
            ? <ActivityIndicator size="small" color="#FF6B35" />
            : <Text style={styles.refreshBtnText}>↻  Refresh</Text>}
        </TouchableOpacity>
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
      <View style={styles.wellnessHeader}>
        <Text style={styles.wellnessTitle}>Today's Wellness</Text>
        <Text style={styles.wellnessSubtitle}>{today}</Text>
      </View>

      <View style={styles.ringsRow}>
        {/* Strain — double ring (real effort + safe range), tap → history */}
        <TouchableOpacity style={{ flex: 1, alignItems: 'center' }} activeOpacity={0.75}
          onPress={() => router.push({ pathname: '/history' as any, params: { type: 'strain' } })}>
          <StrainRing size={RING} strain={strain} />
        </TouchableOpacity>

        {/* Recovery — tappable */}
        <TouchableOpacity style={{ flex: 1, alignItems: 'center' }} onPress={navToRecovery} activeOpacity={0.75} disabled={!recovery}>
          <Ring size={RING} strokeWidth={8} progress={noHRV ? 0 : recScore / 100} color={noHRV ? '#bbb' : recColor} label="RECOVERY" value={noHRV ? '--' : String(recScore)} />
          <Text style={styles.ringHint}>{recovery ? 'tap ›' : 'syncing'}</Text>
        </TouchableOpacity>

        {/* Sleep — tappable */}
        <TouchableOpacity style={{ flex: 1, alignItems: 'center' }} onPress={navToSleep} activeOpacity={0.75} disabled={!recovery}>
          <Ring size={RING} strokeWidth={8} progress={sleepScore / 100} color="#8e44ad" label="SLEEP" value={sleepScore > 0 ? String(sleepScore) : '--'} />
          <Text style={styles.ringHint}>{recovery ? 'tap ›' : ''}</Text>
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
  wellnessSubtitle: { fontSize: 12, color: c.textFaint },
  ringsRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-around', marginBottom: 2 },
  ringHint: { fontSize: 9, color: c.textFaint, marginTop: 3 },
  strainCaption: { fontSize: 9, fontWeight: '700' },
  wellnessUnavailable: { fontSize: 15, color: c.textSub, marginBottom: 4, fontWeight: '500' },
  wellnessPending: { fontSize: 11, color: c.textFaint, lineHeight: 15, marginTop: 10, textAlign: 'center' },
  recoveryUnavailableHint: { fontSize: 12, color: c.textFaint, marginBottom: 12, lineHeight: 18 },
  refreshBtn: {
    alignSelf: 'flex-start', backgroundColor: c.mode === 'dark' ? '#3a2218' : '#FFF3EE', borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1, borderColor: '#FF6B35',
  },
  refreshBtnText: { color: '#FF6B35', fontSize: 14, fontWeight: '700' },
  sleepText: { fontSize: 12, color: c.textSub, marginBottom: 6 },

  calibrateBtn: {
    marginHorizontal: 12, marginBottom: 8, marginTop: 0,
    backgroundColor: c.surface, borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 10,
    borderWidth: 1, borderColor: '#8e44ad55',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  calibrateBtnText: { fontSize: 13, fontWeight: '700', color: '#9b59b6' },
  calibrateBtnSub:  { fontSize: 11, color: c.textSub },

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
