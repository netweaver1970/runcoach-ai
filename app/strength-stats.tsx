import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, LayoutChangeEvent } from 'react-native';
import { Stack, useFocusEffect } from 'expo-router';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import {
  StrengthStore, loadStrength, allExercises, exerciseHistory, sessionStats, LOAD_GROUPS,
} from '../src/services/strength';
import { TChart, TPt, WeeklyBars, weeklySum, inWin, trendDelta, signed } from '../src/components/TimeChart';

// Strength statistics — the cardio Statistics screen's building blocks (shared time window, weekly bars, the
// scrubbable time chart with its grey OLS trend line + the caption that quotes that same fit) applied to lifting.
type Range = '1M' | '3M' | '6M' | '1Y' | 'All';
const RANGES: Range[] = ['1M', '3M', '6M', '1Y', 'All'];
const RANGE_DAYS: Record<Range, number> = { '1M': 30, '3M': 90, '6M': 180, '1Y': 365, All: 0 };
const AREA_COLOR: Record<string, string> = { legs: '#2f9e44', push: '#e8590c', pull: '#1c7ed6', core: '#ae3ec9' };
const kgFmt = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} t` : `${Math.round(v)}`);

export default function StrengthStatsScreen() {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const [st, setSt] = useState<StrengthStore | null>(null);
  const [range, setRange] = useState<Range>('3M');
  const [exId, setExId] = useState<string | null>(null);
  const [w, setW] = useState(0);
  useFocusEffect(useCallback(() => { loadStrength().then(x => setSt({ ...x })).catch(() => {}); }, []));

  const stats = useMemo(() => (st ? sessionStats(st) : []), [st]);
  // exercises with an e1RM history (≥ 2 sessions), most-trained first → the chips of the e1RM card
  const trained = useMemo(() => (st ? allExercises(st)
    .map(e => ({ e, h: exerciseHistory(st, e.id).filter(x => x.bestE1rm != null) }))
    .filter(x => x.h.length >= 2).sort((a, b) => b.h.length - a.h.length) : []), [st]);

  if (!st) return <View style={[s.screen, { justifyContent: 'center' }]}><ActivityIndicator color={c.accent} /></View>;
  const t1 = Date.now();
  const t0 = RANGE_DAYS[range] ? t1 - RANGE_DAYS[range] * 86_400_000 : Math.min(t1 - 7 * 86_400_000, stats[0]?.t ?? t1);
  const innerW = Math.max(0, w - 24);
  const onLay = (e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width);

  const tonnage = weeklySum(stats.map(x => ({ t: x.t, v: x.tonnage })), t0, t1);
  const sets = weeklySum(stats.map(x => ({ t: x.t, v: x.sets })), t0, t1);
  const sel = trained.find(x => x.e.id === exId) ?? trained[0];
  const e1: TPt[] = sel ? sel.h.map(x => ({ t: x.at, v: x.bestE1rm! })) : [];
  const top: TPt[] = sel ? sel.h.map(x => ({ t: x.at, v: x.topKg })) : [];
  const e1Win = inWin(e1, t0, t1).map(p => p.v);
  const d = trendDelta(e1Win);
  const rpe: TPt[] = stats.filter(x => x.rpe).map(x => ({ t: x.t, v: x.rpe! }));
  // hard sets per area: average of the last 4 COMPLETED weeks vs the 4 before
  const areas = LOAD_GROUPS.filter(g => g.key !== 'body').map(g => {
    const wk = weeklySum(stats.map(x => ({ t: x.t, v: x.areaSets[g.key] ?? 0 })), t1 - 63 * 86_400_000, t1);
    const avg = (a: typeof wk) => (a.length ? a.reduce((q, x) => q + x.v, 0) / a.length : 0);
    const full = wk.filter(x => !x.inProgress);   // completed weeks only (a half week would read as a drop)
    return { g, now: avg(full.slice(-4)), prev: avg(full.slice(-8, -4)) };
  });

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ title: 'Strength stats', headerBackTitle: 'Back' }} />
      <View style={s.ctrlRow}>
        {RANGES.map(r => (
          <TouchableOpacity key={r} style={[s.tab, range === r && s.tabOn]} onPress={() => setRange(r)}>
            <Text style={[s.tabTxt, range === r && s.tabTxtOn]}>{r}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 48 }}>
        {!stats.length && <Text style={s.meta}>No finished strength sessions yet — the charts fill in as you log.</Text>}

        <View style={s.card} onLayout={onLay}>
          <Text style={s.cardTitle}>Weekly volume</Text>
          <Text style={s.meta}>Tonnage = kg × reps over all work sets (body-weight moves include your body-weight share)</Text>
          <WeeklyBars weeks={tonnage} innerW={innerW} fmt={kgFmt} unit="kg" />
        </View>

        <View style={s.card}>
          <Text style={s.cardTitle}>Weekly work sets</Text>
          <WeeklyBars weeks={sets} innerW={innerW} fmt={v => String(Math.round(v))} unit="sets" />
        </View>

        <View style={s.card}>
          <Text style={s.cardTitle}>Hard sets per area</Text>
          <Text style={s.meta}>Per week, last 4 completed weeks vs the 4 before (per area — ~10–20 hard sets per MUSCLE per week is the usual growth range)</Text>
          {areas.map(a => (
            <View key={a.g.key} style={s.areaRow}>
              <View style={[s.dot, { backgroundColor: AREA_COLOR[a.g.key] ?? c.accent }]} />
              <Text style={s.areaLbl}>{a.g.label}</Text>
              <Text style={s.areaVal}>{a.now.toFixed(1)}/wk</Text>
              <Text style={[s.areaDelta, { color: a.now > a.prev + 0.5 ? '#2f9e44' : a.now < a.prev - 0.5 ? '#e5484d' : c.textSub }]}>
                {a.prev > 0 || a.now > 0 ? `${a.now >= a.prev ? '▲' : '▼'} from ${a.prev.toFixed(1)}` : '—'}
              </Text>
            </View>
          ))}
        </View>

        <View style={s.card}>
          <Text style={s.cardTitle}>Estimated 1RM</Text>
          {trained.length ? (
            <>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginVertical: 8 }} contentContainerStyle={{ gap: 6 }}>
                {trained.map(x => (
                  <TouchableOpacity key={x.e.id} style={[s.chip, sel?.e.id === x.e.id && s.chipOn]} onPress={() => setExId(x.e.id)}>
                    <Text style={[s.chipTxt, sel?.e.id === x.e.id && { color: c.onAccent }]} numberOfLines={1}>{x.e.name}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <TChart pts={e1} t0={t0} t1={t1} color={c.accent} trend events={[]} showEvents={false} yfmt={v => `${Math.round(v)}`} innerW={innerW}
                pts2={top} color2="#a855f7" y2fmt={v => `${Math.round(v)}`} y2label="kg top" />
              <Text style={s.caption}>
                Effort-adjusted Epley e1RM per session (purple: heaviest kg){d != null && e1Win.length
                  ? ` · trend ${signed(d, 1)} kg (${signed((d / e1Win[0]) * 100, 1)}%) over this window` : ''}
              </Text>
            </>
          ) : <Text style={s.meta}>Appears once an exercise has 2 sessions.</Text>}
        </View>

        <View style={s.card}>
          <Text style={s.cardTitle}>Session effort (RPE)</Text>
          <TChart pts={rpe} t0={t0} t1={t1} color="#e8590c" trend events={[]} showEvents={false} yfmt={v => v.toFixed(1)} innerW={innerW} />
        </View>
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:   { flex: 1, backgroundColor: c.bg },
  ctrlRow:  { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8 },
  tab:      { paddingVertical: 5, paddingHorizontal: 11, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  tabOn:    { backgroundColor: c.accent, borderColor: c.accent },
  tabTxt:   { color: c.textSub, fontSize: 14, fontWeight: '700' },
  tabTxtOn: { color: c.onAccent },
  card:     { backgroundColor: c.surface, borderRadius: 16, padding: 12, marginBottom: 12 },
  cardTitle:{ color: c.text, fontSize: 15, fontWeight: '800', marginBottom: 2 },
  meta:     { color: c.textSub, fontSize: 12, lineHeight: 16 },
  caption:  { color: c.textSub, fontSize: 11.5, marginTop: 8, lineHeight: 16 },
  chip:     { paddingVertical: 5, paddingHorizontal: 10, borderRadius: 14, borderWidth: 1, borderColor: c.border, maxWidth: 180 },
  chipOn:   { backgroundColor: c.accent, borderColor: c.accent },
  chipTxt:  { color: c.textSub, fontSize: 12.5, fontWeight: '700' },
  areaRow:  { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  dot:      { width: 8, height: 8, borderRadius: 4 },
  areaLbl:  { color: c.text, fontSize: 14, fontWeight: '600', flex: 1 },
  areaVal:  { color: c.text, fontSize: 14, fontWeight: '800', fontVariant: ['tabular-nums'] },
  areaDelta:{ fontSize: 12, fontWeight: '700', width: 92, textAlign: 'right' },
});
