import React from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, SafeAreaView,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { DailyRecovery } from '../src/types';

const SLEEP_COLOR  = '#8e44ad';
const SLEEP_GOAL   = 480; // minutes (8h)

function Row({ label, value, valueColor, sub, bar }: {
  label: string; value: string; valueColor?: string; sub?: string; bar?: number;
}) {
  return (
    <View style={[s.row, bar !== undefined && { paddingBottom: 14 }]}>
      <View style={{ flex: 1 }}>
        <Text style={s.rowLabel}>{label}</Text>
        {sub ? <Text style={s.rowSub}>{sub}</Text> : null}
        {bar !== undefined && (
          <View style={s.barTrack}>
            <View style={[s.barFill, { width: `${Math.min(100, Math.max(0, bar))}%` as any, backgroundColor: valueColor ?? SLEEP_COLOR }]} />
          </View>
        )}
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

export default function SleepDetailScreen() {
  const { data } = useLocalSearchParams<{ data: string }>();
  const router   = useRouter();
  const recovery = data ? JSON.parse(data) as DailyRecovery : null;

  if (!recovery || !recovery.sleep) {
    return (
      <SafeAreaView style={s.container}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => router.back()} style={{ paddingHorizontal: 4 }}>
            <Text style={s.backText}>‹ Back</Text>
          </TouchableOpacity>
          <Text style={s.title}>Sleep Detail</Text>
          <View style={{ width: 60 }} />
        </View>
        <View style={s.center}>
          <Text style={s.emptyText}>No sleep data for last night.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const { sleepScore = 0, overnightHR, sleep } = recovery;

  const totalMin  = sleep.totalMinutes;
  const deepMin   = sleep.deepMinutes;
  const remMin    = sleep.remMinutes;
  const coreMin   = sleep.coreMinutes;
  const awakeMin  = sleep.awakeMinutes;

  const totalInBed    = totalMin + awakeMin;
  const efficiency    = totalInBed > 0 ? totalMin / totalInBed : 1;
  const deepRemFrac   = totalMin > 0 ? (deepMin + remMin) / totalMin : 0;
  const goalRatio     = Math.min(1.2, totalMin / SLEEP_GOAL);

  const scoreColor = sleepScore >= 75 ? '#27ae60' : sleepScore >= 55 ? '#2ecc71' : sleepScore >= 35 ? '#f39c12' : '#e74c3c';

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={{ paddingHorizontal: 4 }}>
          <Text style={s.backText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={s.title}>Sleep Detail</Text>
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
          </View>
        </View>

        {/* Timing */}
        <Section title="Sleep Timing">
          <Row
            label="Bedtime"
            value={new Date(sleep.bedtime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
          />
          <Row
            label="Wake time"
            value={new Date(sleep.wakeTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
          />
          <Row
            label="Total sleep"
            value={`${(totalMin / 60).toFixed(1)} h`}
            valueColor={goalRatio >= 0.9 ? '#27ae60' : goalRatio >= 0.7 ? '#f39c12' : '#e74c3c'}
            sub={`Goal: 8 h  (${Math.round(goalRatio * 100)} % of target)`}
            bar={goalRatio * 100}
          />
          <Row
            label="Time in bed"
            value={`${(totalInBed / 60).toFixed(1)} h`}
          />
        </Section>

        {/* Sleep stages */}
        <Section title="Sleep Stages">
          <Row
            label="Deep sleep"
            value={`${deepMin} min`}
            valueColor="#3498db"
            sub={totalMin > 0 ? `${Math.round(deepMin / totalMin * 100)} % of total sleep  (ideal ≥ 13 %)` : undefined}
            bar={totalMin > 0 ? deepMin / totalMin * 100 : 0}
          />
          <Row
            label="REM sleep"
            value={`${remMin} min`}
            valueColor="#9b59b6"
            sub={totalMin > 0 ? `${Math.round(remMin / totalMin * 100)} % of total sleep  (ideal ≥ 20 %)` : undefined}
            bar={totalMin > 0 ? remMin / totalMin * 100 : 0}
          />
          <Row
            label="Core (light) sleep"
            value={`${coreMin} min`}
            valueColor="#555"
            sub={totalMin > 0 ? `${Math.round(coreMin / totalMin * 100)} % of total sleep` : undefined}
          />
          <Row
            label="Deep + REM combined"
            value={`${Math.round(deepRemFrac * 100)} %`}
            valueColor={deepRemFrac >= 0.35 ? '#27ae60' : deepRemFrac >= 0.25 ? '#f39c12' : '#e74c3c'}
            sub="Ideal: > 35 % of total sleep time"
          />
        </Section>

        {/* Efficiency & continuity */}
        <Section title="Sleep Quality">
          <Row
            label="Sleep efficiency"
            value={`${Math.round(efficiency * 100)} %`}
            valueColor={efficiency >= 0.90 ? '#27ae60' : efficiency >= 0.80 ? '#f39c12' : '#e74c3c'}
            sub="Time asleep ÷ time in bed  (ideal ≥ 90 %)"
            bar={efficiency * 100}
          />
          <Row
            label="Awake time"
            value={`${awakeMin} min`}
            valueColor={awakeMin <= 15 ? '#27ae60' : awakeMin <= 30 ? '#f39c12' : '#e74c3c'}
            sub="Total minutes awake during the night"
          />
          {awakeMin > 0 && totalInBed > 0 && (
            <Row
              label="Interruption fraction"
              value={`${Math.round(awakeMin / totalInBed * 100)} %`}
              valueColor={awakeMin / totalInBed <= 0.05 ? '#27ae60' : '#f39c12'}
              sub="Ideal < 5 %"
            />
          )}
        </Section>

        {/* HR dip */}
        <Section title="Heart Rate Dip">
          {overnightHR > 0 ? (
            <>
              <Row label="Overnight HR"  value={`${overnightHR} bpm`} sub="Average during sleep stages" />
              {recovery.overnightHRBaseline > 0 && (
                <>
                  <Row label="Daytime baseline" value={`${recovery.overnightHRBaseline} bpm`} />
                  <Row
                    label="HR dip"
                    value={`${Math.round((recovery.overnightHRBaseline - overnightHR) / recovery.overnightHRBaseline * 100)} %`}
                    valueColor={
                      (recovery.overnightHRBaseline - overnightHR) / recovery.overnightHRBaseline >= 0.15
                        ? '#27ae60' : '#f39c12'
                    }
                    sub="Ideal: 15–25 % drop vs daytime HR"
                  />
                </>
              )}
            </>
          ) : (
            <Row label="Overnight HR" value="No data" sub="Overnight HR not available for this session" />
          )}
        </Section>

        {/* Score breakdown */}
        <Section title="Score Breakdown (weights)">
          <Row label="Time asleep"     value="40 %" />
          <Row label="Sleep stages"    value="25 %" />
          <Row label="Efficiency"      value="15 %" />
          <Row label="HR dip"          value="10 %" />
          <Row label="Continuity"      value="10 %" />
          <Row label="Total sleep score" value={`${sleepScore} / 100`} valueColor={scoreColor} />
        </Section>

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
  scoreLabel:  { fontSize: 16, fontWeight: '800', marginBottom: 4, color: '#8e44ad' },
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

  barTrack: {
    height: 4, backgroundColor: '#f0f0f0', borderRadius: 2, marginTop: 6, overflow: 'hidden',
  },
  barFill: { height: 4, borderRadius: 2 },
});
