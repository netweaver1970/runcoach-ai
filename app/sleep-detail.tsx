import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, SafeAreaView, ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { DailyRecovery, SleepSession } from '../src/types';
import { fetchSleepHistory, fetchOvernightHRHistory, fetchStrainHistory } from '../src/services/healthkit';
import { computeSleepBankSeries, computeSleepNeeded } from '../src/services/trainingLoad';
import { useThemedStyles, Palette } from '../src/theme';
import {
  normaliseKPIs, applyWeights,
  DEFAULT_SLEEP_WEIGHTS, SleepWeights,
  loadCustomSleepWeights, computePersonalSleepGoal, loadPersonalSleepGoal,
} from '../src/services/bevelCalibration';

const SLEEP_COLOR = '#8e44ad';
const FALLBACK_SLEEP_GOAL = 375; // 6h15m — used until personal goal loads

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

/** minutes → "Xh Ym" (handles negatives) */
function fmtHm(min: number): string {
  const a = Math.abs(Math.round(min));
  const h = Math.floor(a / 60), m = a % 60;
  return (min < 0 ? '-' : '') + (h > 0 ? `${h}h ${m}m` : `${m}m`);
}

/** Stats over an array of numbers */
function stats(arr: number[]): { mean: number; sd: number } {
  if (arr.length === 0) return { mean: 0, sd: 0 };
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const sd   = Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length);
  return { mean, sd };
}

/** Compute all sub-KPI raw values from a SleepSession + optional HR dip */
function getSubKPIs(session: SleepSession, hrDipPct: number) {
  const totalInBed = session.totalMinutes + session.awakeMinutes;
  const efficiency = totalInBed > 0 ? (session.totalMinutes / totalInBed) * 100 : 0;
  return {
    totalMinutes: session.totalMinutes,
    deepMinutes:  session.deepMinutes,
    remMinutes:   session.remMinutes,
    awakeMinutes: session.awakeMinutes,
    efficiency,
    hrDipPct,
  };
}

/** Compute overall sleep score using Bevel's 5-KPI model */
function computeSleepScore(
  kpis: ReturnType<typeof getSubKPIs>,
  sleepGoalMin: number,
  weights: SleepWeights,
): number {
  const scores = normaliseKPIs(kpis, sleepGoalMin);
  return applyWeights(scores, weights);
}

type StatusTag = 'Below normal' | 'Normal range' | 'Above normal';
function getStatus(value: number, mean: number, sd: number, higherIsBetter = true): StatusTag {
  if (sd === 0) return 'Normal range';
  const z = (value - mean) / sd;
  if (higherIsBetter) {
    if (z < -1.0) return 'Below normal';
    if (z >  1.0) return 'Above normal';
    return 'Normal range';
  } else {
    if (z >  1.0) return 'Below normal';
    if (z < -1.0) return 'Above normal';
    return 'Normal range';
  }
}

const STATUS_COLOR: Record<StatusTag, string> = {
  'Normal range': '#27ae60',
  'Below normal': '#e67e22',
  'Above normal': '#2980b9',
};

// ─── Sparkline ────────────────────────────────────────────────────────────────

const SPARK_H = 36;
const SPARK_W = 120;

function Sparkline({
  values, mean, sd, color,
}: { values: number[]; mean: number; sd: number; color: string }) {
  if (values.length < 2) return <View style={{ width: SPARK_W, height: SPARK_H }} />;
  const lo = Math.min(...values, mean - sd * 1.5);
  const hi = Math.max(...values, mean + sd * 1.5);
  const range = hi - lo || 1;
  const toX = (i: number) => (i / (values.length - 1)) * SPARK_W;
  const toY = (v: number) => SPARK_H - ((v - lo) / range) * SPARK_H;
  const bandLo = clamp((mean - sd - lo) / range * SPARK_H, 0, SPARK_H);
  const bandHi = clamp((mean + sd - lo) / range * SPARK_H, 0, SPARK_H);
  const bandY  = SPARK_H - bandHi;
  const bandH  = bandHi - bandLo;

  return (
    <View style={{ width: SPARK_W, height: SPARK_H, position: 'relative' }}>
      {/* Normal band shading */}
      <View style={{
        position: 'absolute', left: 0, right: 0,
        top: bandY, height: Math.max(2, bandH),
        backgroundColor: color + '22',
      }} />
      {/* Mean line */}
      <View style={{
        position: 'absolute', left: 0, right: 0,
        top: toY(mean) - 0.5, height: 1,
        backgroundColor: color + '55',
      }} />
      {/* Data segments */}
      {values.map((v, i) => {
        if (i === 0) return null;
        const x1 = toX(i - 1), y1 = toY(values[i - 1]);
        const x2 = toX(i),     y2 = toY(v);
        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx) * 180 / Math.PI;
        return (
          <View key={i} style={{
            position: 'absolute',
            width: len, height: 1.5,
            left: (x1 + x2) / 2 - len / 2,
            top: (y1 + y2) / 2 - 0.75,
            backgroundColor: color,
            transform: [{ rotate: `${angle}deg` }],
          }} />
        );
      })}
      {/* Last dot */}
      <View style={{
        position: 'absolute',
        width: 5, height: 5, borderRadius: 3,
        left: toX(values.length - 1) - 2.5,
        top: toY(values[values.length - 1]) - 2.5,
        backgroundColor: color,
      }} />
    </View>
  );
}

// ─── Sub-KPI Card ─────────────────────────────────────────────────────────────

function SubKPICard({
  label, value, unit, history, higherIsBetter = true, color, onPress,
}: {
  label: string;
  value: string;
  unit: string;
  history: number[];
  higherIsBetter?: boolean;
  color: string;
  onPress?: () => void;
}) {
  const kpi = useThemedStyles(makeKpi);
  const { mean, sd } = stats(history);
  const current = history.length > 0 ? history[history.length - 1] : 0;
  const status  = history.length > 5
    ? getStatus(current, mean, sd, higherIsBetter)
    : 'Normal range';
  const statusColor = STATUS_COLOR[status];

  const content = (
    <View style={kpi.card}>
      {/* Left: label + status */}
      <View style={kpi.left}>
        <Text style={kpi.label}>{label}</Text>
        <View style={[kpi.badge, { backgroundColor: statusColor + '22' }]}>
          <Text style={[kpi.badgeText, { color: statusColor }]}>{status}</Text>
        </View>
      </View>

      {/* Middle: sparkline */}
      {history.length > 1 ? (
        <Sparkline values={history} mean={mean} sd={sd} color={color} />
      ) : (
        <View style={{ width: SPARK_W }} />
      )}

      {/* Right: value */}
      <View style={kpi.right}>
        <Text style={[kpi.value, { color }]}>{value}</Text>
        <Text style={kpi.unit}>{unit}</Text>
        {onPress && <Text style={kpi.arrow}>›</Text>}
      </View>
    </View>
  );

  if (onPress) {
    return (
      <TouchableOpacity onPress={onPress} activeOpacity={0.75}>
        {content}
      </TouchableOpacity>
    );
  }
  return content;
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function SleepDetailScreen() {
  const { data, date } = useLocalSearchParams<{ data: string; date?: string }>();
  const dateLbl = date ? new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
  const dayLabel = dateLbl || new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const router   = useRouter();
  const s = useThemedStyles(makeS);
  const recovery = data ? JSON.parse(data) as DailyRecovery : null;

  const [history, setHistory]       = useState<SleepSession[]>([]);
  const [hrDipHistory, setHrDipH]   = useState<number[]>([]);
  const [strainByDate, setStrainByDate] = useState<Map<string, number>>(new Map());
  const [sleepGoalMin, setSleepGoalMin] = useState(FALLBACK_SLEEP_GOAL);
  const [weights, setWeights]       = useState<SleepWeights>(DEFAULT_SLEEP_WEIGHTS);
  const [loadingH, setLoadingH]     = useState(true);

  useEffect(() => {
    Promise.all([
      fetchSleepHistory(3),
      fetchOvernightHRHistory(3),
      loadPersonalSleepGoal(),
      loadCustomSleepWeights(),
      fetchStrainHistory(3),
    ]).then(([sessions, dipData, savedGoal, customWeights, strainHist]) => {
      setHistory(sessions);
      setHrDipH(dipData.map(d => d.value));
      setStrainByDate(new Map(strainHist.map(x => [x.date, x.value])));
      // Personal sleep goal: use stored value, else compute from 90-day median
      const goal = savedGoal ?? computePersonalSleepGoal(sessions);
      setSleepGoalMin(goal > 0 ? goal : FALLBACK_SLEEP_GOAL);
      if (customWeights) setWeights(customWeights);
    }).catch(() => {}).finally(() => setLoadingH(false));
  }, []);

  if (!recovery || !recovery.sleep) {
    return (
      <SafeAreaView style={s.container}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => router.back()} style={{ paddingHorizontal: 4 }}>
            <Text style={s.backText}>‹ Back</Text>
          </TouchableOpacity>
          <View style={{ alignItems: 'center' }}>
            <Text style={s.title}>Sleep Detail</Text>
            {!!dateLbl && <Text style={s.headerDate}>{dateLbl}</Text>}
          </View>
          <View style={{ width: 60 }} />
        </View>
        <View style={s.center}>
          <Text style={s.emptyText}>No sleep data for last night.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const { sleepScore = 0, overnightHR, overnightHRBaseline, sleep } = recovery;

  // HR dip %
  const hrDipPct =
    overnightHR > 0 && overnightHRBaseline > 0
      ? ((overnightHRBaseline - overnightHR) / overnightHRBaseline) * 100
      : 0;

  const todayKPIs = getSubKPIs(sleep, hrDipPct);

  // Build per-KPI history arrays from fetched sessions (oldest → newest)
  const totalHistory    = history.map(s => s.totalMinutes);
  const awakeHistory    = history.map(s => s.awakeMinutes);
  const deepHistory     = history.map(s => s.deepMinutes);
  const remHistory      = history.map(s => s.remMinutes);
  const coreHistory     = history.map(s => s.coreMinutes);
  const effHistory      = history.map(s => {
    const inBed = s.totalMinutes + s.awakeMinutes;
    return inBed > 0 ? (s.totalMinutes / inBed) * 100 : 0;
  });
  const scoreHistory    = history.map(s => computeSleepScore(getSubKPIs(s, 0), sleepGoalMin, weights));

  // Sleep Bank (Bevel-style): rolling 7-night recency-weighted balance of
  // (Time Asleep − dynamic Sleep Needed). Sleep Needed = goal + strain tax + debt + efficiency.
  const bankNights = history.map(sn => {
    const inBed = sn.totalMinutes + sn.awakeMinutes;
    return {
      date:       sn.date,
      asleepMin:  sn.totalMinutes,
      dayStrain:  strainByDate.get(sn.date) ?? 0,
      efficiency: inBed > 0 ? sn.totalMinutes / inBed : 1,
    };
  });
  const bankSeries   = computeSleepBankSeries(bankNights, sleepGoalMin);
  const bankHistory  = bankSeries.map(b => b.bank);
  const sleepBankMin = bankHistory.length > 0 ? bankHistory[bankHistory.length - 1] : 0;

  // Tonight's projected Sleep Needed: today's strain + current debt drive it up.
  const todayStrain = strainByDate.get(sleep.date)
    ?? (bankNights.length > 0 ? bankNights[bankNights.length - 1].dayStrain : 0);
  const recentEff   = bankNights.length > 0 ? bankNights[bankNights.length - 1].efficiency : 1;
  const sleepNeeded = computeSleepNeeded(sleepGoalMin, todayStrain, sleepBankMin, recentEff);

  const scoreColor = sleepScore >= 75 ? '#27ae60' : sleepScore >= 55 ? '#2ecc71' : sleepScore >= 35 ? '#f39c12' : '#e74c3c';

  const navTo = (type: string) =>
    router.push({ pathname: '/history' as any, params: { type } });

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={{ paddingHorizontal: 4 }}>
          <Text style={s.backText}>‹ Back</Text>
        </TouchableOpacity>
        <View style={{ alignItems: 'center' }}>
          <Text style={s.title}>Sleep Detail</Text>
          {!!dateLbl && <Text style={s.headerDate}>{dateLbl}</Text>}
        </View>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView contentContainerStyle={s.scroll}>

        {/* Score hero */}
        <View style={[s.hero, { borderColor: SLEEP_COLOR }]}>
          <View style={[s.scoreCircle, { borderColor: SLEEP_COLOR + '55' }]}>
            <Text style={[s.scoreNumber, { color: scoreColor }]}>{sleepScore}</Text>
            <Text style={s.scoreUnit}>/100</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[s.scoreLabel, { color: SLEEP_COLOR }]}>SLEEP SCORE</Text>
            <Text style={s.scoreAdvice}>
              {sleepScore >= 75 ? 'Excellent night — well recovered.' :
               sleepScore >= 55 ? 'Good sleep — adequate recovery.' :
               sleepScore >= 35 ? 'Moderate sleep — some fatigue expected.' :
                                   'Poor sleep — prioritise rest today.'}
            </Text>
            <Text style={s.scoreTime}>
              {new Date(sleep.bedtime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
              {' → '}
              {new Date(sleep.wakeTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
            </Text>
          </View>
        </View>

        {/* Sleep Needed tonight + Sleep Bank (dynamic, Bevel-style) */}
        <View style={s.needCard}>
          <View style={s.needCol}>
            <Text style={s.needLabel}>SLEEP NEEDED TONIGHT</Text>
            <Text style={s.needVal}>{fmtHm(sleepNeeded)}</Text>
            <Text style={s.needSub}>
              goal {fmtHm(sleepGoalMin)}{sleepNeeded > sleepGoalMin ? ` + ${sleepNeeded - sleepGoalMin}m` : ''}
            </Text>
          </View>
          <View style={s.needDivider} />
          <View style={s.needCol}>
            <Text style={s.needLabel}>SLEEP BANK</Text>
            <Text style={[s.needVal, { color: sleepBankMin < 0 ? '#e67e22' : '#27ae60' }]}>
              {sleepBankMin >= 0 ? '+' : ''}{fmtHm(sleepBankMin)}
            </Text>
            <Text style={s.needSub}>{sleepBankMin < 0 ? 'debt' : 'surplus'} · 7-night</Text>
          </View>
        </View>

        {loadingH && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12, paddingHorizontal: 4 }}>
            <ActivityIndicator size="small" color={SLEEP_COLOR} />
            <Text style={{ fontSize: 12, color: '#aaa' }}>Loading 90-day history…</Text>
          </View>
        )}

        {/* Sub-KPI section */}
        <Text style={s.metricsDate}>📅 {dayLabel}</Text>
        <Text style={s.sectionTitle}>SLEEP METRICS</Text>
        <View style={s.kpiList}>

          {/* Sleep Score history */}
          <SubKPICard
            label="Sleep Score"
            value={String(sleepScore)}
            unit="/ 100"
            history={[...scoreHistory, sleepScore]}
            higherIsBetter
            color={SLEEP_COLOR}
            onPress={() => navTo('sleep-score')}
          />

          {/* Time Asleep */}
          <SubKPICard
            label="Time Asleep"
            value={(todayKPIs.totalMinutes / 60).toFixed(1)}
            unit="h"
            history={totalHistory}
            higherIsBetter
            color="#2980b9"
            onPress={() => navTo('sleep-total')}
          />

          {/* Time Awake */}
          <SubKPICard
            label="Time Awake"
            value={String(sleep.awakeMinutes)}
            unit="min"
            history={awakeHistory}
            higherIsBetter={false}
            color="#e67e22"
            onPress={() => navTo('sleep-awake')}
          />

          {/* Deep Sleep */}
          <SubKPICard
            label="Deep Sleep"
            value={String(todayKPIs.deepMinutes)}
            unit="min"
            history={deepHistory}
            higherIsBetter
            color="#3498db"
            onPress={() => navTo('sleep-deep')}
          />

          {/* REM Sleep */}
          <SubKPICard
            label="REM Sleep"
            value={String(todayKPIs.remMinutes)}
            unit="min"
            history={remHistory}
            higherIsBetter
            color="#9b59b6"
            onPress={() => navTo('sleep-rem')}
          />

          {/* Sleep Efficiency */}
          <SubKPICard
            label="Efficiency"
            value={Math.round(todayKPIs.efficiency).toString()}
            unit="%"
            history={effHistory}
            higherIsBetter
            color="#27ae60"
            onPress={() => navTo('sleep-efficiency')}
          />

          {/* Heart Rate Dip */}
          <SubKPICard
            label="HR Dip"
            value={overnightHR > 0 && overnightHRBaseline > 0 ? hrDipPct.toFixed(1) : '—'}
            unit="% vs daytime"
            history={hrDipHistory}
            higherIsBetter
            color="#e74c3c"
            onPress={() => navTo('sleep-hrdip')}
          />

          {/* Sleep Bank */}
          <SubKPICard
            label="Sleep Bank"
            value={(sleepBankMin >= 0 ? '+' : '') + Math.round(sleepBankMin)}
            unit={`min  (7d vs ${Math.round(sleepGoalMin / 60)}h${sleepGoalMin % 60 > 0 ? `${sleepGoalMin % 60}m` : ''} goal)`}
            history={bankHistory}
            higherIsBetter
            color={sleepBankMin >= 0 ? '#27ae60' : '#e74c3c'}
            onPress={() => navTo('sleep-bank')}
          />
        </View>
        <Text style={s.metricsDate}>📅 {dayLabel}</Text>

        {/* Score Breakdown */}
        <Text style={[s.sectionTitle, { marginTop: 16 }]}>SCORE BREAKDOWN</Text>
        <View style={s.breakdownCard}>
          <Text style={{ fontSize: 11, color: '#aaa', marginBottom: 6 }}>
            Goal: {Math.floor(sleepGoalMin / 60)}h{sleepGoalMin % 60 > 0 ? ` ${sleepGoalMin % 60}m` : ''} (90-day personal)
          </Text>
          {([
            ['Time asleep', weights.totalMinutes],
            ['Deep sleep',  weights.deepMinutes],
            ['REM sleep',   weights.remMinutes],
            ['Efficiency',  weights.efficiency],
            ['HR dip',      weights.hrDip],
          ] as [string, number][]).map(([lbl, w]) => (
            <View key={lbl} style={s.breakdownRow}>
              <Text style={s.breakdownLabel}>{lbl}</Text>
              <View style={s.breakdownBar}>
                <View style={[s.breakdownFill, { width: `${Math.round(w * 100)}%` as any, backgroundColor: SLEEP_COLOR }]} />
              </View>
              <Text style={s.breakdownPct}>{Math.round(w * 100)} %</Text>
            </View>
          ))}
          <View style={[s.breakdownRow, { borderTopWidth: 1, borderTopColor: '#f0f0f0', marginTop: 4, paddingTop: 8 }]}>
            <Text style={[s.breakdownLabel, { fontWeight: '700' }]}>Total score</Text>
            <View style={{ flex: 1 }} />
            <Text style={[s.breakdownPct, { fontWeight: '800', color: scoreColor, fontSize: 16 }]}>
              {sleepScore} / 100
            </Text>
          </View>
        </View>

        {/* Raw values */}
        <Text style={[s.sectionTitle, { marginTop: 16 }]}>TONIGHT'S DATA</Text>
        <View style={s.breakdownCard}>
          {[
            ['Bedtime', new Date(sleep.bedtime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })],
            ['Wake time', new Date(sleep.wakeTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })],
            ['Total sleep', `${(sleep.totalMinutes / 60).toFixed(1)} h  (${sleep.totalMinutes} min)`],
            ['Deep sleep', `${sleep.deepMinutes} min  (${sleep.totalMinutes > 0 ? Math.round(sleep.deepMinutes / sleep.totalMinutes * 100) : 0}%)`],
            ['REM sleep', `${sleep.remMinutes} min  (${sleep.totalMinutes > 0 ? Math.round(sleep.remMinutes / sleep.totalMinutes * 100) : 0}%)`],
            ['Core sleep', `${sleep.coreMinutes} min  (${sleep.totalMinutes > 0 ? Math.round(sleep.coreMinutes / sleep.totalMinutes * 100) : 0}%)`],
            ['Awake time', `${sleep.awakeMinutes} min`],
            ...(overnightHR > 0 ? [['Overnight HR', `${overnightHR} bpm`]] : []),
            ...(overnightHRBaseline > 0 ? [['Daytime baseline', `${overnightHRBaseline} bpm`]] : []),
            ...(hrDipPct > 0 ? [['HR dip', `${hrDipPct.toFixed(1)} %  (target ≥10 %)`]] : []),
          ].map(([lbl, val]) => (
            <View key={lbl} style={s.breakdownRow}>
              <Text style={s.breakdownLabel}>{lbl}</Text>
              <Text style={[s.breakdownPct, { color: '#333' }]}>{val}</Text>
            </View>
          ))}
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Sub-KPI styles ───────────────────────────────────────────────────────────

const makeKpi = (c: Palette) => StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    gap: 10,
  },
  left: {
    width: 110,
    gap: 4,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: c.text,
  },
  badge: {
    borderRadius: 5,
    paddingHorizontal: 5,
    paddingVertical: 2,
    alignSelf: 'flex-start',
  },
  badgeText: {
    fontSize: 9,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.2,
  },
  right: {
    alignItems: 'flex-end',
    flex: 1,
  },
  value: {
    fontSize: 20,
    fontWeight: '800',
  },
  unit: {
    fontSize: 10,
    color: c.textFaint,
    marginTop: 1,
  },
  arrow: {
    fontSize: 16,
    color: c.textFaint,
    marginTop: 2,
  },
});

// ─── Screen styles ────────────────────────────────────────────────────────────

const makeS = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border,
  },
  backText: { fontSize: 17, color: '#FF6B35', fontWeight: '600' },
  title:    { fontSize: 17, fontWeight: '700', color: c.text },
  headerDate: { fontSize: 11, color: c.textFaint, marginTop: 1 },
  metricsDate: { fontSize: 13, fontWeight: '800', color: '#FF6B35', textAlign: 'center', paddingVertical: 8 },
  center:   { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText:{ fontSize: 15, color: c.textFaint },
  scroll:   { padding: 12, paddingBottom: 40 },

  hero: {
    flexDirection: 'row', alignItems: 'center', gap: 16,
    backgroundColor: c.surface, borderRadius: 16, padding: 16, marginBottom: 16,
    borderLeftWidth: 5,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: c.shadowOpacity, shadowRadius: 5, elevation: 3,
  },
  needCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: c.surface, borderRadius: 14, padding: 14, marginBottom: 16,
    borderWidth: 1, borderColor: c.border,
  },
  needCol: { flex: 1, alignItems: 'center' },
  needDivider: { width: 1, alignSelf: 'stretch', backgroundColor: c.border, marginHorizontal: 6 },
  needLabel: { fontSize: 10, fontWeight: '700', color: c.textFaint, letterSpacing: 0.5 },
  needVal: { fontSize: 22, fontWeight: '800', color: c.text, marginTop: 3 },
  needSub: { fontSize: 11, color: c.textSub, marginTop: 2 },
  scoreCircle: {
    width: 80, height: 80, borderRadius: 40, borderWidth: 4,
    alignItems: 'center', justifyContent: 'center',
  },
  scoreNumber: { fontSize: 30, fontWeight: '800', lineHeight: 34 },
  scoreUnit:   { fontSize: 11, color: c.textFaint },
  scoreLabel:  { fontSize: 14, fontWeight: '800', marginBottom: 4 },
  scoreAdvice: { fontSize: 12, color: c.textSub, lineHeight: 17 },
  scoreTime:   { fontSize: 11, color: c.textFaint, marginTop: 3 },

  sectionTitle: {
    fontSize: 11, fontWeight: '700', color: c.textSub,
    textTransform: 'uppercase', letterSpacing: 0.5,
    marginBottom: 6, marginLeft: 4,
  },

  kpiList: {
    backgroundColor: c.surface, borderRadius: 14, overflow: 'hidden', marginBottom: 8,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: c.shadowOpacity, shadowRadius: 3, elevation: 2,
  },

  breakdownCard: {
    backgroundColor: c.surface, borderRadius: 12, padding: 14, marginBottom: 8,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: c.shadowOpacity, shadowRadius: 3, elevation: 2,
    gap: 8,
  },
  breakdownRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
  },
  breakdownLabel: {
    fontSize: 13, color: c.textSub, width: 100,
  },
  breakdownBar: {
    flex: 1, height: 5, backgroundColor: c.surfaceAlt, borderRadius: 3, overflow: 'hidden',
  },
  breakdownFill: {
    height: 5, borderRadius: 3,
  },
  breakdownPct: {
    fontSize: 12, fontWeight: '700', color: c.textSub, width: 40, textAlign: 'right',
  },
});
