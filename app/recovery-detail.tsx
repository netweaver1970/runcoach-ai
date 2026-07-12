import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, SafeAreaView, ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { DailyRecovery } from '../src/types';
import { useThemedStyles, Palette } from '../src/theme';
import { SubKPICard, buildHistories } from '../src/components/SubKPICard';
import { fetchOurDailyComponents, scoreToLabel, scoreToColor } from '../src/services/healthkit';
import { useDetailSwipe } from '../src/components/useDetailSwipe';
import { KpiTabs } from '../src/components/KpiTabs';
import { DayNav } from '../src/components/DayNav';
import { cached } from '../src/services/detailCache';

function Row({ label, value, valueColor, sub }: {
  label: string; value: string; valueColor?: string; sub?: string;
}) {
  const s = useThemedStyles(makeStyles);
  return (
    <View style={s.row}>
      <View style={{ flex: 1 }}>
        <Text style={s.rowLabel}>{label}</Text>
        {sub ? <Text style={s.rowSub}>{sub}</Text> : null}
      </View>
      <Text style={[s.rowValue, valueColor ? { color: valueColor } : null]}>{value}</Text>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const s = useThemedStyles(makeStyles);
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>{title}</Text>
      <View style={s.card}>{children}</View>
    </View>
  );
}

export default function RecoveryDetailScreen() {
  const { rec, str, date } = useLocalSearchParams<{ rec?: string; str?: string; date?: string }>();
  const router   = useRouter();
  const s = useThemedStyles(makeStyles);
  const swipe = useDetailSwipe('/recovery-detail', { rec, str, date });
  const dateLbl = date ? new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' }) : '';
  const dayLabel = dateLbl || new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
  const recovery = rec ? JSON.parse(rec) as DailyRecovery : null;
  // The rich rec-only breakdown (z-scores, score build-up) is only available for TODAY's snapshot. A
  // day-swipe navigates with just `date` (rec dropped) → render the day's score + sub-KPIs from `comps`.
  // Use the live snapshot's recovery (rec) whenever the viewed day IS today — the home passes date=today
  // alongside rec, so the old `!date` test made TODAY fall through to the cached store (which lagged the
  // snapshot → home 44 vs detail 50). Only a PAST day (date != today) reads the components store.
  const todayKey = (() => { const n = new Date(); const p = (x: number) => String(x).padStart(2, '0'); return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`; })();
  const useRec = !!recovery && (!date || date === todayKey);

  const [comps, setComps] = useState<Record<string, Record<string, number>>>({});
  const [loadingH, setLoadingH] = useState(true);
  useEffect(() => {
    cached('comps:3', () => fetchOurDailyComponents(3)).then(setComps).catch(() => {}).finally(() => setLoadingH(false));
  }, []);
  const hist = useMemo(
    () => buildHistories(comps, ['recoveryScore', 'restingHrv', 'restingHr', 'respiratoryRate', 'oxygenSaturation', 'heartRateDip']),
    [comps],
  );
  // Sub-KPI values for the VIEWED day (the `date` param), not just today.
  const dates = Object.keys(comps).sort();
  const viewedDate = (date && comps[date]) ? date : (date || (dates.length ? dates[dates.length - 1] : ''));
  const target = comps[viewedDate] ?? {};
  const navTo = (type: string) => router.push({ pathname: '/history' as any, params: { type } });
  const last = (k: string) => { const v = target[k]; return v != null ? v : null; };

  // Score + colour/label: rec when viewing today, else the viewed day's stored components.
  const recoveryScore = useRec ? recovery!.recoveryScore : Math.round((target.recoveryScore as number) ?? 0);
  const { color, label } = useRec
    ? { color: recovery!.color, label: recovery!.label }
    : { color: scoreToColor(recoveryScore), label: scoreToLabel(recoveryScore) }; // same canonical mapping as home
  const bd            = useRec ? recovery!.breakdown : undefined;
  const weightedRMSSD = useRec ? recovery!.weightedRMSSD : 0;
  const baseline7Day  = useRec ? recovery!.baseline7Day : 0;
  const overnightHR   = useRec ? recovery!.overnightHR : 0;
  const sleep         = useRec ? recovery!.sleep : undefined;
  const trend         = useRec ? recovery!.trend : undefined;

  const hasData = useRec || Object.keys(target).length > 0;
  if (!hasData) {
    return (
      <SafeAreaView style={s.container}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => router.back()} style={{ paddingHorizontal: 4 }}>
            <Text style={s.backText}>‹ Back</Text>
          </TouchableOpacity>
          <View style={{ alignItems: 'center' }}>
            <Text style={s.title}>Recovery Detail</Text>
            <Text style={s.headerDate}>{dayLabel}</Text>
          </View>
          <View style={{ width: 60 }} />
        </View>
        <KpiTabs current="recovery" params={{ rec, str, date }} />
        <View style={s.center} {...swipe}>
          <Text style={s.emptyText}>{loadingH ? 'Loading…' : 'No recovery data for this day.'}</Text>
        </View>
      </SafeAreaView>
    );
  }

  const trendSymbol = trend === 'rising' ? '↑ Rising' : trend === 'falling' ? '↓ Falling' : '→ Stable';
  const trendColor  = trend === 'rising' ? '#27ae60' : trend === 'falling' ? '#c0392b' : '#888';
  const signed = (v: number) => `${v > 0 ? '+' : ''}${v}`;

  return (
    <SafeAreaView style={s.container}>
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={{ paddingHorizontal: 4 }}>
          <Text style={s.backText}>‹ Back</Text>
        </TouchableOpacity>
        <View style={{ alignItems: 'center' }}>
          <Text style={s.title}>Recovery Detail</Text>
          <Text style={s.headerDate}>{dayLabel}</Text>
        </View>
        <TouchableOpacity onPress={() => router.push({ pathname: '/history' as any, params: { type: 'recovery' } })} style={{ paddingHorizontal: 4 }}>
          <Text style={s.historyLink}>History ›</Text>
        </TouchableOpacity>
      </View>
      <KpiTabs current="recovery" params={{ rec, str, date }} />
      <DayNav date={date} />

      <View style={{ flex: 1 }} {...swipe}>
      <ScrollView contentContainerStyle={s.scroll}>

        {/* Score hero */}
        <View style={[s.hero, { borderColor: color }]}>
          <View style={[s.scoreCircle, { borderColor: color + '55' }]}>
            <Text style={[s.scoreNumber, { color }]}>{recoveryScore}</Text>
            <Text style={s.scoreUnit}>/100</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[s.scoreLabel, { color }]}>{label.toUpperCase()}</Text>
            <Text style={s.scoreAdvice}>
              {recoveryScore >= 75 ? 'Ready for a quality session or long run.' :
               recoveryScore >= 55 ? 'Good to go for moderate intensity work.' :
               recoveryScore >= 35 ? 'Keep intensity easy today.' :
                                     'Prioritise rest or very easy movement.'}
            </Text>
          </View>
        </View>

        {/* Sub-KPI metrics (sleep-detail pattern: sparkline + tap → history) */}
        {loadingH && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12, paddingHorizontal: 4 }}>
            <ActivityIndicator size="small" color={color} />
            <Text style={s.rowSub}>Loading 30-day history…</Text>
          </View>
        )}
        {!loadingH && (<>
        <Text style={s.sectionTitle}>RECOVERY METRICS</Text>
        <View style={s.card}>
          <SubKPICard label="Recovery Score" value={`${recoveryScore}`} unit="/100" history={[...(hist.recoveryScore ?? []), recoveryScore]} higherIsBetter color={color} onPress={() => navTo('recovery')} />
          <SubKPICard label="Resting HRV"   value={last('restingHrv') !== null ? `${last('restingHrv')}` : '—'} unit="ms"  history={hist.restingHrv ?? []}       higherIsBetter        color="#8e44ad" onPress={() => navTo('hrv')} />
          <SubKPICard label="Resting HR"    value={last('restingHr') !== null ? `${last('restingHr')}` : '—'}   unit="bpm" history={hist.restingHr ?? []}        higherIsBetter={false} color="#e74c3c" onPress={() => navTo('rhr')} />
          <SubKPICard label="Respiratory Rate" value={last('respiratoryRate') !== null ? `${last('respiratoryRate')}` : '—'} unit="rpm" history={hist.respiratoryRate ?? []} higherIsBetter={false} color="#2980b9" onPress={() => navTo('resp-rate')} />
          <SubKPICard label="Oxygen Saturation" value={last('oxygenSaturation') !== null ? `${last('oxygenSaturation')}` : '—'} unit="%" history={hist.oxygenSaturation ?? []} higherIsBetter color="#27ae60" onPress={() => navTo('spo2')} />
          <SubKPICard label="Heart Rate Dip" value={last('heartRateDip') !== null ? `${last('heartRateDip')}` : '—'} unit="%" history={hist.heartRateDip ?? []} higherIsBetter color="#16a085" onPress={() => navTo('sleep-hrdip')} />
        </View>
        </>)}
        <View style={{ height: 14 }} />

        {/* Detailed breakdown (z-scores, score build-up, last night's sleep) — today's snapshot only. */}
        {useRec && (<>
        {/* HRV — true RMSSD vs 60-day personal baseline (z-score) */}
        <Section title="Heart Rate Variability">
          <Row
            label="RMSSD (true, R-R intervals)"
            value={bd ? `${bd.rmssd} ms` : weightedRMSSD > 0 ? `${weightedRMSSD} ms` : 'No data'}
            sub="Beat-to-beat — Bevel's metric (not Apple's SDNN)"
          />
          <Row
            label="60-day baseline"
            value={bd && bd.hrvMean > 0 ? `${bd.hrvMean} ms` : baseline7Day > 0 ? `${baseline7Day} ms` : '—'}
            sub={bd && bd.hrvSD > 0 ? `mean ± ${bd.hrvSD} ms SD` : 'rolling mean'}
          />
          {bd && (
            <Row label="z-score" value={`${signed(bd.zHRV)} σ`} valueColor={bd.zHRV >= 0 ? '#27ae60' : '#c0392b'} />
          )}
          <Row label="Trend" value={trendSymbol} valueColor={trendColor} />
          {bd && (
            <Row
              label="HRV sub-score"
              value={`${bd.hrvSub} / 100`}
              sub="50 + z × 23.6 (100 ≈ +2 SD)"
              valueColor={color}
            />
          )}
        </Section>

        {/* Overnight HR — vs 60-day baseline (z-score, lower = better) */}
        <Section title="Overnight Heart Rate">
          <Row
            label="Overnight HR"
            value={overnightHR > 0 ? `${overnightHR} bpm` : 'No data'}
            sub="Average during actual sleep stages"
          />
          {bd && bd.rhrMean > 0 && (
            <Row
              label="60-day baseline"
              value={`${bd.rhrMean} bpm`}
              sub={bd.rhrSD > 0 ? `mean ± ${bd.rhrSD} bpm SD` : 'rolling mean'}
            />
          )}
          {bd && (
            <Row label="z-score" value={`${signed(bd.zRHR)} σ`} sub="Lower HR than baseline = positive" valueColor={bd.zRHR >= 0 ? '#27ae60' : '#c0392b'} />
          )}
          {bd && (
            <Row label="HR sub-score" value={`${bd.rhrSub} / 100`} sub="50 + z × 23.6" valueColor={color} />
          )}
        </Section>

        {/* Score build-up — the real model */}
        <Section title="Score Calculation">
          {bd ? (
            <>
              <Row label="Core" value={`${bd.core} / 100`} sub={`${Math.round(bd.hrvWeight * 100)}% HRV + ${Math.round((1 - bd.hrvWeight) * 100)}% overnight HR`} />
              <Row
                label="Sleep adjustment"
                value={`${signed(bd.sleepTerm)}`}
                sub={`0.32 × (sleep ${bd.sleepScore} − 72)`}
                valueColor={bd.sleepTerm >= 0 ? '#27ae60' : '#c0392b'}
              />
              <Row
                label="Respiratory-rate penalty"
                value={bd.rrPenalty < 0 ? `${bd.rrPenalty}` : '0'}
                sub={bd.rrBaseline > 0 ? `−3.9 × max(0, RR ${bd.rr} − base ${bd.rrBaseline})` : 'no RR data'}
                valueColor={bd.rrPenalty < 0 ? '#c0392b' : '#888'}
              />
              <Row label="Final score" value={`${recoveryScore} / 100`} valueColor={color} />
            </>
          ) : (
            <Row label="Final score" value={`${recoveryScore} / 100`} valueColor={color} />
          )}
        </Section>

        {/* Sleep summary if available */}
        {sleep && (
          <Section title="Last Night's Sleep">
            <Row label="Total sleep"    value={`${(sleep.totalMinutes / 60).toFixed(1)} h`} />
            <Row label="Deep sleep"     value={`${sleep.deepMinutes} min`}  valueColor="#3498db" />
            <Row label="REM sleep"      value={`${sleep.remMinutes} min`}   valueColor="#9b59b6" />
            <Row label="Core sleep"     value={`${sleep.coreMinutes} min`} />
            <Row label="Awake time"     value={`${sleep.awakeMinutes} min`} />
            <Row label="Bedtime"        value={new Date(sleep.bedtime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} />
            <Row label="Wake time"      value={new Date(sleep.wakeTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} />
          </Section>
        )}
        </>)}

      </ScrollView>
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border,
  },
  backText: { fontSize: 17, color: c.accent, fontWeight: '600' },
  title:    { fontSize: 17, fontWeight: '700', color: c.text },
  historyLink: { fontSize: 15, color: c.accent, fontWeight: '600' },
  headerDate: { fontSize: 11, color: c.textFaint, marginTop: 1 },
  metricsDate: { fontSize: 13, fontWeight: '800', color: c.accent, textAlign: 'center', paddingVertical: 8 },
  center:   { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText:{ fontSize: 15, color: c.textFaint },
  scroll:   { padding: 12, paddingBottom: 40 },

  hero: {
    flexDirection: 'row', alignItems: 'center', gap: 16,
    backgroundColor: c.surface, borderRadius: 16, padding: 16, marginBottom: 14,
    borderLeftWidth: 5,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: c.shadowOpacity, shadowRadius: 5, elevation: 3,
  },
  scoreCircle: {
    width: 88, height: 88, borderRadius: 44, borderWidth: 4,
    alignItems: 'center', justifyContent: 'center',
  },
  scoreNumber: { fontSize: 36, fontWeight: '800', lineHeight: 40 },
  scoreUnit:   { fontSize: 12, color: c.textFaint },
  scoreLabel:  { fontSize: 16, fontWeight: '800', marginBottom: 4 },
  scoreAdvice: { fontSize: 13, color: c.textSub, lineHeight: 19 },

  section:      { marginBottom: 14 },
  sectionTitle: {
    fontSize: 11, fontWeight: '700', color: c.textSub,
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6, marginLeft: 4,
  },
  card: {
    backgroundColor: c.surface, borderRadius: 12, overflow: 'hidden',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: c.shadowOpacity, shadowRadius: 3, elevation: 2,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 11,
    borderBottomWidth: 1, borderBottomColor: c.border,
  },
  rowLabel: { fontSize: 13, color: c.text, fontWeight: '500' },
  rowSub:   { fontSize: 11, color: c.textFaint, marginTop: 2 },
  rowValue: { fontSize: 13, fontWeight: '700', color: c.text },
});
