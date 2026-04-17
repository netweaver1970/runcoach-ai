import React from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, SafeAreaView,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { DailyRecovery } from '../src/types';

function Row({ label, value, valueColor, sub }: {
  label: string; value: string; valueColor?: string; sub?: string;
}) {
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
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>{title}</Text>
      <View style={s.card}>{children}</View>
    </View>
  );
}

export default function RecoveryDetailScreen() {
  const { data } = useLocalSearchParams<{ data: string }>();
  const router   = useRouter();
  const recovery = data ? JSON.parse(data) as DailyRecovery : null;

  if (!recovery) {
    return (
      <SafeAreaView style={s.container}>
        <View style={s.center}><Text style={s.emptyText}>No recovery data available.</Text></View>
      </SafeAreaView>
    );
  }

  const {
    recoveryScore, color, label, trend,
    weightedRMSSD, baseline7Day,
    overnightHR, overnightHRBaseline,
    sleep,
  } = recovery;

  const trendSymbol = trend === 'rising' ? '↑ Rising' : trend === 'falling' ? '↓ Falling' : '→ Stable';
  const trendColor  = trend === 'rising' ? '#27ae60' : trend === 'falling' ? '#c0392b' : '#888';

  // HRV score component (mirrors absoluteHRVScore from healthkit.ts)
  const absHRV = weightedRMSSD > 0 ? Math.min(98, Math.max(5, 38 + weightedRMSSD * 0.95)) : 0;
  const absRHR = overnightHR   > 0 ? Math.min(95, Math.max(5, 190 - overnightHR * 2.1))   : 0;

  return (
    <SafeAreaView style={s.container}>
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={{ paddingHorizontal: 4 }}>
          <Text style={s.backText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={s.title}>Recovery Detail</Text>
        <View style={{ width: 60 }} />
      </View>

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

        {/* HRV */}
        <Section title="Heart Rate Variability">
          <Row
            label="RMSSD (sleep-weighted)"
            value={weightedRMSSD > 0 ? `${weightedRMSSD} ms` : 'No data'}
            sub="Deep×3  REM×2  Core×1  Awake×0"
          />
          <Row
            label="7-day baseline"
            value={baseline7Day > 0 ? `${baseline7Day} ms` : '—'}
            sub="Rolling mean of recent nights"
          />
          {weightedRMSSD > 0 && baseline7Day > 0 && (
            <Row
              label="vs baseline"
              value={`${weightedRMSSD > baseline7Day ? '+' : ''}${Math.round(weightedRMSSD - baseline7Day)} ms`}
              valueColor={weightedRMSSD >= baseline7Day ? '#27ae60' : '#c0392b'}
            />
          )}
          <Row label="Trend" value={trendSymbol} valueColor={trendColor} />
          {absHRV > 0 && (
            <Row
              label="HRV score component"
              value={`${Math.round(absHRV)} / 100`}
              sub="Population norm: 38 + RMSSD × 0.95"
              valueColor={color}
            />
          )}
        </Section>

        {/* Overnight HR */}
        <Section title="Overnight Heart Rate">
          <Row
            label="Overnight HR"
            value={overnightHR > 0 ? `${overnightHR} bpm` : 'No data'}
            sub="Average during actual sleep stages"
          />
          {overnightHRBaseline > 0 && (
            <Row
              label="Personal baseline"
              value={`${overnightHRBaseline} bpm`}
              sub="Rolling average of recent nights"
            />
          )}
          {overnightHR > 0 && overnightHRBaseline > 0 && (
            <Row
              label="vs baseline"
              value={`${overnightHR > overnightHRBaseline ? '+' : ''}${overnightHR - overnightHRBaseline} bpm`}
              valueColor={overnightHR <= overnightHRBaseline ? '#27ae60' : '#c0392b'}
              sub="Lower overnight HR = better recovery"
            />
          )}
          {absRHR > 0 && (
            <Row
              label="HR score component"
              value={`${Math.round(absRHR)} / 100`}
              sub="Population norm: 190 − HR × 2.1"
              valueColor={color}
            />
          )}
        </Section>

        {/* Score formula */}
        <Section title="Score Calculation">
          <Row label="HRV component weight"  value="65 %" />
          <Row label="Overnight HR weight"   value={overnightHR > 0 ? '35 %' : '0 % (no data)'} />
          <Row label="Baseline blend"        value="Day 1–7 grows from 0→40%" sub="Absolute score dominates early; personal z-score blends in over 7 days" />
          <Row label="Final score" value={`${recoveryScore} / 100`} valueColor={color} />
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

      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F5F5F5' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#eee',
  },
  backText: { fontSize: 17, color: '#FF6B35', fontWeight: '600' },
  title:    { fontSize: 17, fontWeight: '700', color: '#222' },
  center:   { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText:{ fontSize: 15, color: '#aaa' },
  scroll:   { padding: 12, paddingBottom: 40 },

  hero: {
    flexDirection: 'row', alignItems: 'center', gap: 16,
    backgroundColor: '#fff', borderRadius: 16, padding: 16, marginBottom: 14,
    borderLeftWidth: 5,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.07, shadowRadius: 5, elevation: 3,
  },
  scoreCircle: {
    width: 88, height: 88, borderRadius: 44, borderWidth: 4,
    alignItems: 'center', justifyContent: 'center',
  },
  scoreNumber: { fontSize: 36, fontWeight: '800', lineHeight: 40 },
  scoreUnit:   { fontSize: 12, color: '#aaa' },
  scoreLabel:  { fontSize: 16, fontWeight: '800', marginBottom: 4 },
  scoreAdvice: { fontSize: 13, color: '#666', lineHeight: 19 },

  section:      { marginBottom: 14 },
  sectionTitle: {
    fontSize: 11, fontWeight: '700', color: '#888',
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6, marginLeft: 4,
  },
  card: {
    backgroundColor: '#fff', borderRadius: 12, overflow: 'hidden',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 3, elevation: 2,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 11,
    borderBottomWidth: 1, borderBottomColor: '#f5f5f5',
  },
  rowLabel: { fontSize: 13, color: '#333', fontWeight: '500' },
  rowSub:   { fontSize: 11, color: '#aaa', marginTop: 2 },
  rowValue: { fontSize: 13, fontWeight: '700', color: '#222' },
});
