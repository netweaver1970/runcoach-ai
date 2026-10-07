import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, Linking, useWindowDimensions } from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect } from 'expo-router';
import Svg, { Polyline, Circle, Line, Text as SvgText } from 'react-native-svg';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import { StrengthStore, loadStrength, exerciseById, exerciseHistory, MUSCLE_LABEL, Muscle } from '../src/services/strength';

// Exercise detail: video + cue + muscles, personal records, and the estimated-1RM trend (Bevel-style exercise chart).
export default function StrengthExerciseScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  const [st, setSt] = useState<StrengthStore | null>(null);
  useFocusEffect(useCallback(() => { loadStrength().then(x => setSt({ ...x })).catch(() => {}); }, []));

  if (!st) return <View style={[s.screen, { justifyContent: 'center' }]}><ActivityIndicator color={c.accent} /></View>;
  const ex = exerciseById(st, id);
  if (!ex) return <View style={s.screen}><Stack.Screen options={{ title: 'Exercise' }} /><Text style={[s.meta, { padding: 16 }]}>Exercise not found.</Text></View>;
  const h = exerciseHistory(st, ex.id);
  const best = (f: (x: typeof h[number]) => number) => (h.length ? Math.max(...h.map(f)) : 0);
  const e1 = h.filter(x => x.bestE1rm != null);
  const bw = !!ex.bodyweightFrac;

  // e1RM trend chart
  const W = width - 32, H = 150, P = 26;
  const vals = e1.map(x => x.bestE1rm!);
  const lo = vals.length ? Math.min(...vals) * 0.95 : 0, hi = vals.length ? Math.max(...vals) * 1.05 : 1;
  const xy = (i: number, v: number) => [P + (vals.length > 1 ? (i / (vals.length - 1)) * (W - 2 * P) : (W - 2 * P) / 2), H - P - ((v - lo) / Math.max(1e-6, hi - lo)) * (H - 2 * P)];

  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
      <Stack.Screen options={{ title: ex.name, headerBackTitle: 'Back' }} />
      {ex.video && (
        <TouchableOpacity style={s.video} onPress={() => Linking.openURL(ex.video!.url)}>
          <Text style={s.videoTxt}>▶  {ex.video.title ?? 'Technique video'}</Text>
          {ex.video.channel ? <Text style={s.meta}>{ex.video.channel} · YouTube</Text> : null}
        </TouchableOpacity>
      )}
      {ex.cue ? <Text style={s.cue}>{ex.cue}</Text> : null}
      <View style={s.chips}>
        {(Object.entries(ex.muscles) as [Muscle, number][]).sort((a, b) => b[1] - a[1]).map(([m, v]) => (
          <View key={m} style={[s.chip, { opacity: 0.45 + 0.55 * v }]}><Text style={s.chipTxt}>{MUSCLE_LABEL[m]}{v < 1 ? ` · ${Math.round(v * 100)}%` : ''}</Text></View>
        ))}
      </View>

      <Text style={s.section}>Personal records</Text>
      {h.length ? (
        <View style={s.grid}>
          <View style={s.pr}><Text style={s.prVal}>{best(x => x.bestE1rm ?? 0) || '—'}</Text><Text style={s.prLbl}>est. 1RM kg</Text></View>
          <View style={s.pr}><Text style={s.prVal}>{best(x => x.topKg)}</Text><Text style={s.prLbl}>{bw ? 'most added kg' : 'heaviest kg'}</Text></View>
          <View style={s.pr}><Text style={s.prVal}>{best(x => x.bestSetVol).toLocaleString()}</Text><Text style={s.prLbl}>best set kg×reps</Text></View>
          <View style={s.pr}><Text style={s.prVal}>{best(x => x.volume).toLocaleString()}</Text><Text style={s.prLbl}>best session kg</Text></View>
        </View>
      ) : <Text style={s.meta}>No sets logged yet — records appear after your first session.</Text>}
      {bw ? <Text style={s.meta}>Body-weight exercise: loads include {Math.round(ex.bodyweightFrac! * 100)}% of your body weight.</Text> : null}

      {vals.length >= 2 && (
        <>
          <Text style={s.section}>Estimated 1RM</Text>
          <Svg width={W} height={H}>
            <Line x1={P} y1={H - P} x2={W - P} y2={H - P} stroke={c.border} strokeWidth={1} />
            <Polyline points={vals.map((v, i) => xy(i, v).join(',')).join(' ')} fill="none" stroke={c.accent} strokeWidth={2.5} />
            {vals.map((v, i) => { const [x, y] = xy(i, v); return <Circle key={i} cx={x} cy={y} r={i === vals.length - 1 ? 4.5 : 3} fill={c.accent} />; })}
            <SvgText x={P} y={14} fill={c.textSub} fontSize={11}>{Math.round(hi)} kg</SvgText>
            <SvgText x={P} y={H - 8} fill={c.textSub} fontSize={11}>{e1[0].date.slice(5)}</SvgText>
            <SvgText x={W - P} y={H - 8} fill={c.textSub} fontSize={11} textAnchor="end">{e1[e1.length - 1].date.slice(5)}</SvgText>
          </Svg>
        </>
      )}

      {h.length > 0 && <Text style={s.section}>History</Text>}
      {h.slice().reverse().map(x => (
        <View key={x.sessionId} style={s.row}>
          <Text style={s.rowDate}>{x.date.slice(5)}</Text>
          <Text style={s.rowTxt}>{x.sets} sets · top {x.topKg} kg{x.bestE1rm ? ` · e1RM ${x.bestE1rm}` : ''}</Text>
          <Text style={s.meta}>{x.volume.toLocaleString()} kg</Text>
        </View>
      ))}
    </ScrollView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:  { flex: 1, backgroundColor: c.bg },
  meta:    { color: c.textSub, fontSize: 13, lineHeight: 18, marginTop: 4 },
  video:   { backgroundColor: c.surface, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: c.border },
  videoTxt:{ color: c.accent, fontSize: 15, fontWeight: '700' },
  cue:     { color: c.text, fontSize: 14, lineHeight: 20, marginTop: 12 },
  chips:   { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12 },
  chip:    { backgroundColor: c.accent, borderRadius: 14, paddingVertical: 4, paddingHorizontal: 10 },
  chipTxt: { color: c.onAccent, fontWeight: '700', fontSize: 12 },
  section: { color: c.textSub, fontSize: 13, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', marginTop: 20, marginBottom: 8 },
  grid:    { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pr:      { width: '48%', backgroundColor: c.surface, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: c.border },
  prVal:   { color: c.text, fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  prLbl:   { color: c.textSub, fontSize: 12, marginTop: 2 },
  row:     { flexDirection: 'row', alignItems: 'baseline', gap: 10, paddingVertical: 7, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  rowDate: { color: c.textFaint, fontSize: 13, width: 44, fontVariant: ['tabular-nums'] },
  rowTxt:  { color: c.text, fontSize: 14, flex: 1 },
});
