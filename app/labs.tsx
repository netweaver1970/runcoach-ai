import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, TextInput, useWindowDimensions, ActivityIndicator } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import Svg, { Polyline, Line, Rect, Circle, Text as SvgText } from 'react-native-svg';
import { loadLabs, LabStore } from '../src/services/labsStore';
import { LabAnalyte } from '../src/services/labs';
import { useTheme, useThemedStyles, Palette } from '../src/theme';

const tOf = (d: string) => new Date(d.length <= 10 ? d + 'T00:00:00' : d).getTime();
const yr = (t: number) => new Date(t).getFullYear();
type Status = 'low' | 'high' | 'in' | 'na';
function statusOf(v: number, lo: number | null, hi: number | null): Status {
  if (lo != null && v < lo) return 'low';
  if (hi != null && v > hi) return 'high';
  if (lo != null || hi != null) return 'in';
  return 'na';
}
const fmt = (v: number) => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100).toString();

function LabChart({ a, width, c }: { a: LabAnalyte; width: number; c: Palette }) {
  const H = 156, PL = 40, PR = 12, PT = 12, PB = 20;
  const pts = a.series;
  if (pts.length < 2) return <Text style={{ color: c.textFaint, fontSize: 12, padding: 12 }}>Only {pts.length} reading — need at least 2 to chart.</Text>;
  const plotW = Math.max(1, width - PL - PR), plotH = H - PT - PB;
  const t0 = tOf(pts[0].date), t1 = tOf(pts[pts.length - 1].date), span = Math.max(1, t1 - t0);
  const vals = pts.map(p => p.value);
  const lo = Math.min(...vals, a.refLow ?? Infinity), hi = Math.max(...vals, a.refHigh ?? -Infinity);
  const pad = (hi - lo) * 0.1 || Math.abs(hi) * 0.1 || 1;
  const yLo = lo - pad, yHi = hi + pad;
  const x = (t: number) => PL + ((t - t0) / span) * plotW;
  const y = (v: number) => PT + (1 - (v - yLo) / (yHi - yLo)) * plotH;
  const line = pts.map(p => `${x(tOf(p.date)).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const years = 4;
  return (
    <Svg width={width} height={H}>
      {/* ref-range band */}
      {a.refLow != null && a.refHigh != null &&
        <Rect x={PL} y={y(a.refHigh)} width={plotW} height={Math.max(1, y(a.refLow) - y(a.refHigh))} fill="#22c55e" opacity={0.12} />}
      {a.refLow != null && a.refHigh == null && <Line x1={PL} y1={y(a.refLow)} x2={PL + plotW} y2={y(a.refLow)} stroke="#22c55e" strokeOpacity={0.5} strokeDasharray="4 4" />}
      {a.refHigh != null && a.refLow == null && <Line x1={PL} y1={y(a.refHigh)} x2={PL + plotW} y2={y(a.refHigh)} stroke="#ef4444" strokeOpacity={0.5} strokeDasharray="4 4" />}
      {/* y axis min/max */}
      <SvgText x={PL - 5} y={y(yHi) + 4} fontSize={9} fill={c.textFaint} textAnchor="end">{fmt(yHi)}</SvgText>
      <SvgText x={PL - 5} y={y(yLo) + 4} fontSize={9} fill={c.textFaint} textAnchor="end">{fmt(yLo)}</SvgText>
      {/* x axis years */}
      {Array.from({ length: years }, (_, i) => t0 + (span * i) / (years - 1)).map((t, i) =>
        <SvgText key={i} x={PL + (i / (years - 1)) * plotW} y={H - 6} fontSize={9} fill={c.textFaint}
          textAnchor={i === 0 ? 'start' : i === years - 1 ? 'end' : 'middle'}>{yr(t)}</SvgText>)}
      <Polyline points={line} fill="none" stroke={c.accent} strokeWidth={2} />
      {pts.map((p, i) => <Circle key={i} cx={x(tOf(p.date))} cy={y(p.value)} r={i === pts.length - 1 ? 3.5 : 2}
        fill={i === pts.length - 1 ? c.accent : c.surface} stroke={c.accent} strokeWidth={1.2} />)}
    </Svg>
  );
}

export default function LabsScreen() {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [store, setStore] = useState<LabStore | null>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => { loadLabs().then(setStore); }, []);

  const groups = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const m = new Map<string, LabAnalyte[]>();
    for (const a of store?.analytes ?? []) {
      if (ql && !a.label.toLowerCase().includes(ql) && !a.category.toLowerCase().includes(ql)) continue;
      if (!m.has(a.category)) m.set(a.category, []);
      m.get(a.category)!.push(a);
    }
    return [...m.entries()];
  }, [store, q]);

  const STATUS_COLOR: Record<Status, string> = { low: '#f59e0b', high: '#ef4444', in: '#22c55e', na: c.textFaint };
  const cardW = width - 32 - 24;

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ title: 'Labs' }} />
      <View style={s.header}>
        <TouchableOpacity style={s.homeBtn} onPress={() => router.back()}><Text style={s.homeTxt}>‹ Biology</Text></TouchableOpacity>
        <Text style={s.title}>🧪 Labs</Text>
        <View style={{ flex: 1 }} />
        <TouchableOpacity style={s.importBtn} onPress={() => router.push('/labs-import' as any)}><Text style={s.importTxt}>Import</Text></TouchableOpacity>
      </View>
      <TextInput style={s.search} value={q} onChangeText={setQ} placeholder="Search markers…" placeholderTextColor={c.textFaint} autoCapitalize="none" />

      {!store ? <View style={s.center}><ActivityIndicator color={c.accent} /></View>
        : store.analytes.length === 0 ? (
          <View style={s.center}>
            <Text style={s.empty}>No labs yet.</Text>
            <TouchableOpacity style={s.importBtnBig} onPress={() => router.push('/labs-import' as any)}><Text style={s.importTxtBig}>Import blood tests</Text></TouchableOpacity>
          </View>
        ) : (
          <ScrollView contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
            {groups.map(([cat, items]) => (
              <View key={cat}>
                <Text style={s.catTitle}>{cat}</Text>
                {items.map(a => {
                  const isOpen = open === a.key;
                  const last = a.series[a.series.length - 1];
                  const lastText = a.textSeries?.[a.textSeries.length - 1];
                  const st = last ? statusOf(last.value, a.refLow, a.refHigh) : 'na';
                  return (
                    <View key={a.key} style={s.card}>
                      <TouchableOpacity style={s.cardHead} onPress={() => setOpen(isOpen ? null : a.key)}>
                        <View style={{ flex: 1 }}>
                          <Text style={s.aLabel} numberOfLines={1}>{a.label}</Text>
                          <Text style={s.aMeta}>{a.series.length + (a.textSeries?.length ?? 0)} readings{a.refLow != null || a.refHigh != null ? ` · ref ${a.refLow ?? '—'}–${a.refHigh ?? '—'}` : ''}</Text>
                        </View>
                        {last && <View style={s.lastWrap}>
                          <Text style={[s.lastVal, { color: STATUS_COLOR[st] }]}>{fmt(last.value)}<Text style={s.lastUnit}> {a.unit}</Text></Text>
                          <Text style={s.lastDate}>{last.date}</Text>
                        </View>}
                        {!last && lastText && <View style={s.lastWrap}><Text style={s.lastText}>{lastText.text}</Text><Text style={s.lastDate}>{lastText.date}</Text></View>}
                      </TouchableOpacity>
                      {isOpen && (
                        <View style={s.chartWrap}>
                          {a.series.length >= 2 ? <LabChart a={a} width={cardW} c={c} />
                            : a.textSeries?.length ? a.textSeries.slice().reverse().map((t, i) => <Text key={i} style={s.textRow}>{t.date}: <Text style={{ color: c.text }}>{t.text}</Text></Text>)
                            : <Text style={s.textRow}>Not enough data to chart.</Text>}
                          {a.note && <Text style={s.note}>{a.note}</Text>}
                        </View>
                      )}
                    </View>
                  );
                })}
              </View>
            ))}
            <View style={{ height: 24 }} />
          </ScrollView>
        )}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:   { flex: 1, backgroundColor: c.bg },
  header:   { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingTop: 8, paddingBottom: 4 },
  homeBtn:  { paddingVertical: 4, paddingRight: 4 },
  homeTxt:  { color: c.accent, fontSize: 15, fontWeight: '700' },
  title:    { color: c.text, fontSize: 18, fontWeight: '800' },
  importBtn:{ paddingVertical: 5, paddingHorizontal: 12, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  importTxt:{ color: c.text, fontSize: 13, fontWeight: '700' },
  search:   { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 10, marginHorizontal: 14, marginVertical: 8, paddingHorizontal: 12, paddingVertical: 9, color: c.text, fontSize: 14 },
  center:   { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 },
  empty:    { color: c.textSub, fontSize: 15 },
  importBtnBig:{ backgroundColor: c.accent, borderRadius: 12, paddingVertical: 13, paddingHorizontal: 22 },
  importTxtBig:{ color: c.onAccent, fontSize: 15, fontWeight: '800' },
  pad:      { paddingHorizontal: 16, paddingBottom: 20 },
  catTitle: { color: c.textSub, fontSize: 13, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 18, marginBottom: 6 },
  card:     { backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.border, marginBottom: 8, overflow: 'hidden' },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 },
  aLabel:   { color: c.text, fontSize: 14, fontWeight: '700' },
  aMeta:    { color: c.textFaint, fontSize: 11.5, marginTop: 2 },
  lastWrap: { alignItems: 'flex-end' },
  lastVal:  { fontSize: 16, fontWeight: '800' },
  lastUnit: { fontSize: 11, fontWeight: '600', color: c.textFaint },
  lastText: { color: c.text, fontSize: 14, fontWeight: '700', maxWidth: 140, textAlign: 'right' },
  lastDate: { color: c.textFaint, fontSize: 10.5, marginTop: 1 },
  chartWrap:{ borderTopWidth: 1, borderTopColor: c.border, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: c.surfaceAlt },
  textRow:  { color: c.textSub, fontSize: 12.5, lineHeight: 20 },
  note:     { color: c.textFaint, fontSize: 11, marginTop: 6, fontStyle: 'italic' },
});
