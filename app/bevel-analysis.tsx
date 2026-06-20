import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator,
  SafeAreaView, StyleSheet, Share, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as FileSystem from 'expo-file-system';
import { fetchOurDailyComponents } from '../src/services/healthkit';
import {
  allBevelDays, seedBevelDataIfEmpty, buildExportPayload, formatCanonical, BevelDay,
} from '../src/services/bevelData';
import { buildBevelComparison, KpiComparison, ComponentComparison } from '../src/services/bevelCompare';
import { useThemedStyles, useTheme, Palette } from '../src/theme';

const KPI_COLOR: Record<string, string> = { strain: '#e67e22', recovery: '#27ae60', sleep: '#7c6cf0' };
const OK = '#27ae60', OFF = '#e67e22';

export default function BevelAnalysisScreen() {
  const router = useRouter();
  const s = useThemedStyles(makeStyles);
  const { c } = useTheme();

  const [loading, setLoading] = useState(true);
  const [days, setDays]   = useState<BevelDay[]>([]);
  const [ours, setOurs]   = useState<Record<string, Record<string, number>>>({});
  const [kpis, setKpis]   = useState<KpiComparison[]>([]);

  const load = async () => {
    setLoading(true);
    try {
      await seedBevelDataIfEmpty();
      const [d, o] = await Promise.all([allBevelDays(), fetchOurDailyComponents(3)]);
      setDays(d); setOurs(o);
      setKpis(buildBevelComparison(d, o));
    } catch (e: any) {
      Alert.alert('Could not load comparison', e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const exportData = async () => {
    try {
      const json = buildExportPayload(days, ours);
      const uri = `${FileSystem.documentDirectory}runcoach-bevel-export.json`;
      await FileSystem.writeAsStringAsync(uri, json);
      await Share.share({ url: uri, title: 'RunCoach AI · Bevel export' });
    } catch (e: any) {
      Alert.alert('Export failed', e?.message ?? String(e));
    }
  };

  const totalOff = kpis.reduce((a, k) => a + k.offCount, 0);

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={{ paddingHorizontal: 4 }}>
          <Text style={s.backText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={s.title}>Bevel Calibration</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView contentContainerStyle={s.scroll}>
        <View style={s.actions}>
          <TouchableOpacity style={s.action} onPress={() => router.push('/bevel-import' as any)}>
            <Text style={s.actionText}>＋ Import screenshots</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.action, s.actionAlt]} onPress={exportData}>
            <Text style={[s.actionText, { color: c.accent }]}>↑ Export data</Text>
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={s.center}><ActivityIndicator color={c.accent} /><Text style={s.muted}>Comparing against your HealthKit data…</Text></View>
        ) : (
          <>
            <Text style={s.summary}>
              {days.length} Bevel day{days.length === 1 ? '' : 's'} imported · {totalOff} component{totalOff === 1 ? '' : 's'} off vs ours
            </Text>

            {kpis.map(k => <KpiBlock key={k.kpi} k={k} s={s} c={c} />)}

            <Text style={s.foot}>
              Strain "today" is intra-day and excluded only where partial. Correlation (r) needs ≥3 days; import
              more (scroll Bevel back, screenshot) to strengthen it. Use Export for full offline analysis.
            </Text>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function KpiBlock({ k, s, c }: { k: KpiComparison; s: any; c: Palette }) {
  const color = KPI_COLOR[k.kpi];
  return (
    <View style={s.kpiCard}>
      <View style={s.kpiHead}>
        <View style={[s.kpiDot, { backgroundColor: color }]} />
        <Text style={s.kpiTitle}>{k.label}</Text>
        {k.offCount > 0 && <Text style={[s.offBadge, { color: OFF }]}>{k.offCount} off</Text>}
      </View>
      <Row comp={k.score} s={s} c={c} isScore />
      {k.components.map(comp => <Row key={comp.key} comp={comp} s={s} c={c} />)}
    </View>
  );
}

function Row({ comp, s, c, isScore }: { comp: ComponentComparison; s: any; c: Palette; isScore?: boolean }) {
  const has = comp.n > 0 && comp.bevelMean !== null && comp.oursMean !== null;
  const flagColor = comp.flag === 'off' ? OFF : comp.flag === 'ok' ? OK : c.textFaint;
  const biasStr = !has ? '—'
    : comp.biasPct !== null
      ? `${comp.bias! > 0 ? '+' : ''}${comp.biasPct}%`
      : `${comp.bias! > 0 ? '+' : ''}${comp.bias}m`;
  return (
    <View style={[s.row, isScore && s.rowScore]}>
      <View style={s.rowTop}>
        <View style={[s.rowDot, { backgroundColor: flagColor }]} />
        <Text style={[s.rowLabel, isScore && { fontWeight: '700', color: c.text }]}>{comp.label}</Text>
        <Text style={s.rowVals}>
          {has ? `${formatCanonical(comp.unit, comp.oursMean!)}  vs  ${formatCanonical(comp.unit, comp.bevelMean!)}` : 'no paired days'}
        </Text>
      </View>
      <View style={s.rowBot}>
        <Text style={[s.rowBias, { color: flagColor }]}>{biasStr}</Text>
        <Text style={s.rowMeta}>{comp.r !== null ? `r ${comp.r}` : `n=${comp.n}`}</Text>
      </View>
      {comp.recommendation && <Text style={s.rec}>⚠️ {comp.recommendation}</Text>}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.border },
  backText: { color: c.accent, fontSize: 16, fontWeight: '600' },
  title: { color: c.text, fontSize: 17, fontWeight: '700' },
  scroll: { padding: 14, paddingBottom: 48 },

  actions: { flexDirection: 'row', gap: 10 },
  action: { flex: 1, backgroundColor: c.accent, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  actionAlt: { backgroundColor: 'transparent', borderWidth: 1, borderColor: c.accent },
  actionText: { color: c.onAccent, fontSize: 14, fontWeight: '700' },

  center: { alignItems: 'center', gap: 10, marginTop: 40 },
  muted: { color: c.textSub, fontSize: 13 },
  summary: { color: c.textSub, fontSize: 13, marginTop: 16, marginBottom: 4 },

  kpiCard: { backgroundColor: c.surface, borderRadius: 12, padding: 14, marginTop: 14, borderWidth: 1, borderColor: c.border },
  kpiHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  kpiDot: { width: 10, height: 10, borderRadius: 5 },
  kpiTitle: { color: c.text, fontSize: 16, fontWeight: '700', flex: 1 },
  offBadge: { fontSize: 12, fontWeight: '700' },

  row: { paddingVertical: 7, borderTopWidth: 1, borderTopColor: c.border },
  rowScore: { borderTopWidth: 0 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowDot: { width: 7, height: 7, borderRadius: 4 },
  rowLabel: { color: c.textSub, fontSize: 14, flex: 1 },
  rowVals: { color: c.text, fontSize: 13, fontWeight: '600' },
  rowBot: { flexDirection: 'row', justifyContent: 'space-between', marginLeft: 15, marginTop: 1 },
  rowBias: { fontSize: 12, fontWeight: '700' },
  rowMeta: { color: c.textFaint, fontSize: 12 },
  rec: { color: OFF, fontSize: 12, lineHeight: 17, marginLeft: 15, marginTop: 4 },

  foot: { color: c.textFaint, fontSize: 11, lineHeight: 16, marginTop: 20 },
});
