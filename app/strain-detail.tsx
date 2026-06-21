import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, SafeAreaView, ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { DayStrain } from '../src/types';
import { useThemedStyles, Palette } from '../src/theme';
import { SubKPICard, buildHistories } from '../src/components/SubKPICard';
import { fetchOurDailyComponents } from '../src/services/healthkit';
import { strainStatus } from '../src/services/trainingLoad';

export default function StrainDetailScreen() {
  const { data } = useLocalSearchParams<{ data: string }>();
  const router   = useRouter();
  const s = useThemedStyles(makeStyles);
  const strain = data ? JSON.parse(data) as DayStrain : null;

  const [hist, setHist] = useState<Record<string, number[]>>({});
  const [loadingH, setLoadingH] = useState(true);
  useEffect(() => {
    fetchOurDailyComponents(1)
      .then(c => setHist(buildHistories(c, ['strainScore', 'exerciseDuration', 'daytimeHR', 'totalEnergy', 'stepCount', 'cardioLoad'])))
      .catch(() => {})
      .finally(() => setLoadingH(false));
  }, []);
  const navTo = (type: string) => router.push({ pathname: '/history' as any, params: { type } });
  const last = (k: string) => { const a = hist[k]; return a && a.length ? a[a.length - 1] : null; };

  const real   = strain?.real ?? 0;
  const status = strain ? strainStatus(strain) : { label: '—', color: '#888' };

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={{ paddingHorizontal: 4 }}>
          <Text style={s.backText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={s.title}>Strain Detail</Text>
        <TouchableOpacity onPress={() => navTo('strain')} style={{ paddingHorizontal: 4 }}>
          <Text style={s.historyLink}>History ›</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={s.scroll}>

        {/* Score hero */}
        <View style={[s.hero, { borderColor: status.color }]}>
          <View style={[s.scoreCircle, { borderColor: status.color + '55' }]}>
            <Text style={[s.scoreNumber, { color: status.color }]}>{real}</Text>
            <Text style={s.scoreUnit}>%</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[s.scoreLabel, { color: status.color }]}>{status.label.toUpperCase()}</Text>
            <Text style={s.scoreAdvice}>
              {strain
                ? `Today's strain ${real}% — advisable range ${strain.safeLow}–${strain.safeHigh}% given your recovery & form.`
                : 'No strain data yet today.'}
            </Text>
          </View>
        </View>

        {loadingH && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12, paddingHorizontal: 4 }}>
            <ActivityIndicator size="small" color={status.color} />
            <Text style={s.rowSub}>Loading 30-day history…</Text>
          </View>
        )}

        {/* Sub-KPI metrics (sleep-detail pattern: sparkline + tap → history) */}
        <Text style={s.sectionTitle}>STRAIN METRICS</Text>
        <View style={s.card}>
          <SubKPICard label="Strain Score"      value={last('strainScore') !== null ? `${last('strainScore')}` : `${real}`} unit="%" history={hist.strainScore ?? []} higherIsBetter color="#e67e22" onPress={() => navTo('strain')} />
          <SubKPICard label="Cardio Load"        value={last('cardioLoad') !== null ? `${last('cardioLoad')}` : '—'} unit="ATL" history={hist.cardioLoad ?? []} higherIsBetter color="#F97316" onPress={() => navTo('cardio-load')} />
          <SubKPICard label="Exercise Duration"  value={last('exerciseDuration') !== null ? `${last('exerciseDuration')}` : '—'} unit="min" history={hist.exerciseDuration ?? []} higherIsBetter color="#2980b9" onPress={() => navTo('exercise-duration')} />
          <SubKPICard label="Daytime HR"         value={last('daytimeHR') !== null ? `${last('daytimeHR')}` : '—'} unit="bpm" history={hist.daytimeHR ?? []} higherIsBetter={false} color="#e74c3c" onPress={() => navTo('daytime-hr')} />
          <SubKPICard label="Total Energy"       value={last('totalEnergy') !== null ? `${last('totalEnergy')}` : '—'} unit="kcal" history={hist.totalEnergy ?? []} higherIsBetter color="#e67e22" onPress={() => navTo('total-energy')} />
          <SubKPICard label="Step Count"         value={last('stepCount') !== null ? `${last('stepCount')}` : '—'} unit="steps" history={hist.stepCount ?? []} higherIsBetter color="#16a085" onPress={() => navTo('step-count')} />
        </View>

      </ScrollView>
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
  backText: { fontSize: 17, color: '#FF6B35', fontWeight: '600' },
  title:    { fontSize: 17, fontWeight: '700', color: c.text },
  historyLink: { fontSize: 15, color: '#FF6B35', fontWeight: '600' },
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
  scoreNumber: { fontSize: 34, fontWeight: '800', lineHeight: 38 },
  scoreUnit:   { fontSize: 12, color: c.textFaint },
  scoreLabel:  { fontSize: 16, fontWeight: '800', marginBottom: 4 },
  scoreAdvice: { fontSize: 13, color: c.textSub, lineHeight: 19 },

  sectionTitle: {
    fontSize: 11, fontWeight: '700', color: c.textSub,
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6, marginLeft: 4,
  },
  card: {
    backgroundColor: c.surface, borderRadius: 12, overflow: 'hidden',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: c.shadowOpacity, shadowRadius: 3, elevation: 2,
  },
  rowSub: { fontSize: 11, color: c.textFaint },
});
