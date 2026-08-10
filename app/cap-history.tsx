import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity } from 'react-native';
import { Stack } from 'expo-router';
import { computeCapHistory, CapWeek } from '../src/services/coach';
import { useTheme, useThemedStyles, Palette } from '../src/theme';

type Span = 8 | 12 | 26;
const SPANS: Span[] = [8, 12, 26];

export default function CapHistoryScreen() {
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [weeks, setWeeks] = useState<CapWeek[] | null>(null);
  const [span, setSpan] = useState<Span>(12);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    computeCapHistory(span).then(w => { if (alive) { setWeeks(w); setLoading(false); } })
      .catch(() => { if (alive) { setWeeks([]); setLoading(false); } });
    return () => { alive = false; };
  }, [span]);

  // Bar scale: the largest of ceiling/actual across the window, so bars are comparable week to week.
  const maxVal = Math.max(60, ...(weeks ?? []).flatMap(w => [w.ceilingMin, w.actualMin]));

  // Summary: how often did completed weeks reach ≥90% of the ceiling (the "tread-water" bar)?
  const done = (weeks ?? []).filter(w => !w.isCurrent);
  const reached = done.filter(w => w.hitPct >= 90).length;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
      <Stack.Screen options={{ title: 'Volume vs Budget' }} />

      <Text style={styles.h1}>Volume vs budget</Text>
      <Text style={styles.sub}>
        Each week's rolling <Text style={styles.bold}>+cap% ceiling</Text> (heat-credited, best-of-recent-weeks base)
        vs what you actually ran. You need to reach ~<Text style={styles.bold}>90%</Text> of the ceiling to hold volume flat;
        under that, and next week's ceiling drifts down.
      </Text>

      <View style={styles.spanRow}>
        {SPANS.map(s => (
          <TouchableOpacity key={s} onPress={() => setSpan(s)} style={[styles.spanBtn, span === s && styles.spanBtnOn]}>
            <Text style={[styles.spanTxt, span === s && styles.spanTxtOn]}>{s}w</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading && <ActivityIndicator style={{ marginTop: 40 }} color={c.accent} />}

      {!loading && weeks && done.length > 0 && (
        <Text style={styles.summary}>
          Reached the ceiling (≥90%) in <Text style={styles.bold}>{reached}/{done.length}</Text> completed weeks.
        </Text>
      )}

      {!loading && weeks && weeks.map(w => {
        const ceilPct = Math.round((w.ceilingMin / maxVal) * 100);
        const actPct  = Math.round((w.actualMin  / maxVal) * 100);
        const hitColor = w.isCurrent ? c.textFaint : w.hitPct >= 90 ? '#22c55e' : w.hitPct >= 70 ? '#f59e0b' : '#ef4444';
        const isDeload = /deload/i.test(w.phase);
        return (
          <View key={w.weekStart} style={styles.row}>
            <View style={styles.rowHead}>
              <Text style={styles.wkLabel}>{w.label}{w.isCurrent ? '  •now' : ''}</Text>
              {!!w.phase && <Text style={[styles.phase, isDeload && styles.phaseDeload]}>{w.phase}</Text>}
              {w.heatTaxPct >= 3 && <Text style={styles.heat}>🌡 +{w.heatTaxPct}%</Text>}
              <View style={{ flex: 1 }} />
              <Text style={[styles.hit, { color: hitColor }]}>
                {w.isCurrent ? 'in progress' : `${w.hitPct}%`}
              </Text>
            </View>
            {/* Ceiling track (faint) with the actual fill on top */}
            <View style={styles.track}>
              <View style={[styles.ceilFill, { width: `${ceilPct}%` }]} />
              <View style={[styles.actFill, { width: `${actPct}%`, backgroundColor: hitColor }]} />
            </View>
            <Text style={styles.nums}>
              {w.actualMin}m run  ·  ceiling {w.ceilingMin}m
            </Text>
          </View>
        );
      })}

      {!loading && weeks && weeks.length === 0 && (
        <Text style={styles.sub}>No run history yet.</Text>
      )}

      <Text style={styles.footnote}>
        Ceiling = +cap% over the best of your last few weeks (a single hot/sick/travel week can't drag it down).
        Heat-cut runs are credited toward their normal-conditions volume so weather doesn't erode your base.
        🌡 shows the average heat tax on that week's runs.
      </Text>
    </ScrollView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:   { flex: 1, backgroundColor: c.bg },
  h1:       { color: c.text, fontSize: 22, fontWeight: '700', marginBottom: 6 },
  sub:      { color: c.textSub, fontSize: 13, lineHeight: 19, marginBottom: 14 },
  bold:     { color: c.text, fontWeight: '700' },
  summary:  { color: c.textSub, fontSize: 13, marginBottom: 12 },
  spanRow:  { flexDirection: 'row', gap: 8, marginBottom: 14 },
  spanBtn:  { paddingVertical: 6, paddingHorizontal: 16, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  spanBtnOn:{ backgroundColor: c.accent, borderColor: c.accent },
  spanTxt:  { color: c.textSub, fontWeight: '600', fontSize: 13 },
  spanTxtOn:{ color: c.onAccent },
  row:      { marginBottom: 14 },
  rowHead:  { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 5 },
  wkLabel:  { color: c.text, fontSize: 14, fontWeight: '600', minWidth: 52 },
  phase:    { color: c.accent, fontSize: 11, fontWeight: '600' },
  phaseDeload: { color: '#8b5cf6' },
  heat:     { color: '#f59e0b', fontSize: 11, fontWeight: '600' },
  hit:      { fontSize: 13, fontWeight: '700' },
  track:    { height: 16, borderRadius: 5, backgroundColor: c.surfaceAlt, overflow: 'hidden', justifyContent: 'center' },
  ceilFill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: c.gridline, borderRightWidth: 2, borderRightColor: c.border },
  actFill:  { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 5 },
  nums:     { color: c.textFaint, fontSize: 11, marginTop: 4 },
  footnote: { color: c.textFaint, fontSize: 11, lineHeight: 17, marginTop: 20 },
});
