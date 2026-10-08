import React, { useCallback, useState } from 'react';
import { ExercisePeek } from '../src/components/ExercisePeek';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, Linking, useWindowDimensions } from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { TChart, trendDelta, signed } from '../src/components/TimeChart';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import { StrengthStore, loadStrength, exerciseById, exerciseHistory, MUSCLE_LABEL, Muscle, Feel, FEEL_LABEL, setExerciseFeel, exerciseMetricSeries, ExMetric, EX_METRIC_LABEL } from '../src/services/strength';
// tap a history row to grade (or re-grade) how the exercise felt that day: – → Easy → OK → Hard → –
const NEXT_FEEL: Record<string, Feel | undefined> = { none: 'easy', easy: 'ok', ok: 'hard', hard: undefined };
const FEEL_COLOR: Record<Feel, string> = { easy: '#2f9e44', ok: '#8a8f98', hard: '#e5484d' };

// Exercise detail: video + cue + muscles, personal records, and the estimated-1RM trend (Bevel-style exercise chart).
export default function StrengthExerciseScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  const [st, setSt] = useState<StrengthStore | null>(null);
  const [metric, setMetric] = useState<ExMetric>('e1rm');
  useFocusEffect(useCallback(() => { loadStrength().then(x => setSt({ ...x })).catch(() => {}); }, []));

  if (!st) return <View style={[s.screen, { justifyContent: 'center' }]}><ActivityIndicator color={c.accent} /></View>;
  const ex = exerciseById(st, id);
  if (!ex) return <View style={s.screen}><Stack.Screen options={{ title: 'Exercise' }} /><Text style={[s.meta, { padding: 16 }]}>Exercise not found.</Text></View>;
  const h = exerciseHistory(st, ex.id);
  const best = (f: (x: typeof h[number]) => number) => (h.length ? Math.max(...h.map(f)) : 0);
  const e1 = h.filter(x => x.bestE1rm != null);
  const bw = !!ex.bodyweightFrac;


  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
      <Stack.Screen options={{ title: ex.name, headerBackTitle: 'Back' }} />
      {ex.video && (
        <TouchableOpacity style={s.video} onPress={() => Linking.openURL(ex.video!.url)}>
          <Text style={s.videoTxt}>▶  {ex.video.title ?? 'Technique video'}</Text>
          {ex.video.channel ? <Text style={s.meta}>{ex.video.channel} · YouTube</Text> : null}
        </TouchableOpacity>
      )}
      <ExercisePeek ex={ex} onClose={() => {}} />
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

      {h.length >= 2 && (() => {
        // the cardio Statistics' time chart for the chosen metric: scrub to read a session, grey OLS trend line
        const pts = exerciseMetricSeries(st, ex.id, metric).map(p => ({ t: p.t, v: p.v }));
        const d = trendDelta(pts.map(p => p.v));
        const unit = metric === 'rel' ? '×' : metric === 'sets' || metric === 'reps' ? '' : ' kg';
        return (
          <>
            <Text style={s.section}>Progress</Text>
            <View style={s.chips}>
              {(['e1rm', 'heaviest', 'volume', 'sets', 'reps', 'rel'] as ExMetric[]).map(m => (
                <TouchableOpacity key={m} style={[s.mChip, metric === m && s.mChipOn]} onPress={() => setMetric(m)}>
                  <Text style={[s.mChipTxt, metric === m && { color: c.onAccent }]}>{EX_METRIC_LABEL[m]}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {pts.length >= 2 ? (
              <TChart pts={pts} t0={pts[0].t} t1={Date.now()} color={c.accent} trend events={[]} showEvents={false} innerW={width - 32}
                yfmt={v => (metric === 'rel' ? `${v.toFixed(2)}×` : `${Math.round(v)}`)}
                {...(metric === 'e1rm' ? { pts2: h.map(x => ({ t: x.at, v: x.topKg })), color2: '#a855f7', y2fmt: (v: number) => `${Math.round(v)}`, y2label: 'kg top' } : {})} />
            ) : <Text style={s.meta}>Not enough data for this metric yet{metric === 'rel' ? ' (needs your body weight from Health)' : ''}.</Text>}
            {d != null ? <Text style={s.meta}>Trend {signed(d, metric === 'rel' ? 2 : 1)}{unit}{pts[0].v > 0 ? ` (${signed((d / pts[0].v) * 100, 1)}%)` : ''} over {pts.length} sessions</Text> : null}
          </>
        );
      })()}

      {h.length > 0 && <Text style={s.section}>History</Text>}
      {h.length > 0 && <Text style={[s.meta, { marginTop: -4, marginBottom: 4 }]}>Tap a session to grade how it felt — "Hard" holds the weight.</Text>}
      {h.slice().reverse().map(x => (
        <TouchableOpacity key={x.sessionId} style={s.row}
          onPress={() => setExerciseFeel(x.sessionId, ex.id, NEXT_FEEL[x.feel ?? 'none']).then(st2 => setSt({ ...st2 })).catch(() => {})}>
          <Text style={s.rowDate}>{x.date.slice(5)}</Text>
          <Text style={s.rowTxt}>{x.sets} sets · top {x.topKg} kg{x.bestE1rm ? ` · e1RM ${x.bestE1rm}` : ''}</Text>
          <Text style={[s.feelTag, x.feel ? { color: FEEL_COLOR[x.feel], borderColor: FEEL_COLOR[x.feel] } : null]}>{x.feel ? FEEL_LABEL[x.feel] : 'feel?'}</Text>
        </TouchableOpacity>
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
  mChip:   { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 12, borderWidth: 1, borderColor: c.border },
  mChipOn: { backgroundColor: c.accent, borderColor: c.accent },
  mChipTxt:{ color: c.textSub, fontWeight: '700', fontSize: 12 },
  chip:    { backgroundColor: c.accent, borderRadius: 14, paddingVertical: 4, paddingHorizontal: 10 },
  chipTxt: { color: c.onAccent, fontWeight: '700', fontSize: 12 },
  section: { color: c.textSub, fontSize: 13, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', marginTop: 20, marginBottom: 8 },
  grid:    { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pr:      { width: '48%', backgroundColor: c.surface, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: c.border },
  prVal:   { color: c.text, fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  prLbl:   { color: c.textSub, fontSize: 12, marginTop: 2 },
  row:     { flexDirection: 'row', alignItems: 'baseline', gap: 10, paddingVertical: 7, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  rowDate: { color: c.textFaint, fontSize: 13, width: 44, fontVariant: ['tabular-nums'] },
  feelTag: { color: c.textFaint, fontSize: 11, fontWeight: '800', borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2, overflow: 'hidden' },
  rowTxt:  { color: c.text, fontSize: 14, flex: 1 },
});
