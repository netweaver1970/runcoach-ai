import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, TextInput, useWindowDimensions, ActivityIndicator, Alert } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import Svg, { Polyline, Line, Rect, Circle, Text as SvgText } from 'react-native-svg';
import { loadLabs, LabStore, loadTemplates, saveTemplate, deleteTemplate, LabTemplate } from '../src/services/labsStore';
import { LabAnalyte } from '../src/services/labs';
import { analyseLab } from '../src/services/labsAnalysis';
import { loadEvents } from '../src/services/timelineEvents';
import { useTheme, useThemedStyles, Palette } from '../src/theme';

const tOf = (d: string) => new Date(d.length <= 10 ? d + 'T00:00:00' : d).getTime();
const yr = (t: number) => new Date(t).getFullYear();
const sig4 = (v: number) => Number(v.toPrecision(4)).toString();
const TOL = 0.005;   // 0.5% boundary tolerance so unit-rounding at a limit doesn't false-flag
type Status = 'low' | 'high' | 'in' | 'na';
function statusOf(v: number, lo: number | null, hi: number | null): Status {
  if (hi != null && v > hi * (1 + TOL)) return 'high';
  if (lo != null && v < lo * (1 - TOL)) return 'low';
  if (lo != null || hi != null) return 'in';
  return 'na';
}
type Range = 'All' | '10Y' | '5Y' | '1Y';
const RANGES: Range[] = ['All', '10Y', '5Y', '1Y'];
const RANGE_YEARS: Record<Range, number> = { All: 0, '10Y': 10, '5Y': 5, '1Y': 1 };
const EV_COLOR: Record<string, string> = { medical: '#ef4444', life: '#10b981' };
interface Ev { t: number; label: string; category: string }

function LabChart({ a, width, c, t0, t1, events }: { a: LabAnalyte; width: number; c: Palette; t0: number; t1: number; events: Ev[] }) {
  const H = 160, PL = 42, PR = 12, PT = 12, PB = 20;
  const pts = a.series.filter(p => { const t = tOf(p.date); return t >= t0 && t <= t1; });
  if (pts.length < 2) return <Text style={{ color: c.textFaint, fontSize: 12, paddingVertical: 8 }}>Fewer than 2 readings in this period.</Text>;
  const plotW = Math.max(1, width - PL - PR), plotH = H - PT - PB, span = Math.max(1, t1 - t0);
  const vals = pts.map(p => p.value);
  const lo = Math.min(...vals, a.refLow ?? Infinity), hi = Math.max(...vals, a.refHigh ?? -Infinity);
  const pad = (hi - lo) * 0.1 || Math.abs(hi) * 0.1 || 1;
  const yLo = lo - pad, yHi = hi + pad;
  const x = (t: number) => PL + ((t - t0) / span) * plotW;
  const y = (v: number) => PT + (1 - (v - yLo) / (yHi - yLo)) * plotH;
  const line = pts.map(p => `${x(tOf(p.date)).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const evIn = events.filter(e => e.t >= t0 && e.t <= t1);
  return (
    <Svg width={width} height={H}>
      {a.refLow != null && a.refHigh != null &&
        <Rect x={PL} y={y(a.refHigh)} width={plotW} height={Math.max(1, y(a.refLow) - y(a.refHigh))} fill="#22c55e" opacity={0.12} />}
      {a.refLow != null && a.refHigh == null && <Line x1={PL} y1={y(a.refLow)} x2={PL + plotW} y2={y(a.refLow)} stroke="#22c55e" strokeOpacity={0.5} strokeDasharray="4 4" />}
      {a.refHigh != null && a.refLow == null && <Line x1={PL} y1={y(a.refHigh)} x2={PL + plotW} y2={y(a.refHigh)} stroke="#ef4444" strokeOpacity={0.5} strokeDasharray="4 4" />}
      {evIn.map((e, i) => <Line key={`e${i}`} x1={x(e.t)} y1={PT} x2={x(e.t)} y2={PT + plotH} stroke={EV_COLOR[e.category] ?? c.textFaint} strokeOpacity={0.35} strokeWidth={1} strokeDasharray="2 3" />)}
      <SvgText x={PL - 5} y={y(yHi) + 4} fontSize={9} fill={c.textFaint} textAnchor="end">{sig4(yHi)}</SvgText>
      <SvgText x={PL - 5} y={y(yLo) + 4} fontSize={9} fill={c.textFaint} textAnchor="end">{sig4(yLo)}</SvgText>
      {Array.from({ length: 4 }, (_, i) => t0 + (span * i) / 3).map((t, i) =>
        <SvgText key={`x${i}`} x={PL + (i / 3) * plotW} y={H - 6} fontSize={9} fill={c.textFaint}
          textAnchor={i === 0 ? 'start' : i === 3 ? 'end' : 'middle'}>{yr(t)}</SvgText>)}
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
  const [events, setEvents] = useState<Ev[]>([]);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [oobOnly, setOobOnly] = useState(false);
  const [showEvents, setShowEvents] = useState(true);
  const [range, setRange] = useState<Range>('All');
  const [offset, setOffset] = useState(0);
  const [analysis, setAnalysis] = useState<Record<string, { loading: boolean; text?: string; error?: string }>>({});
  const [templates, setTemplates] = useState<LabTemplate[]>([]);
  const [activeTpl, setActiveTpl] = useState<string | null>(null);

  useEffect(() => { loadLabs().then(setStore); }, []);
  useEffect(() => { loadTemplates().then(setTemplates); }, []);
  useEffect(() => { loadEvents().then(list => setEvents(
    list.filter((e: any) => e.type === 'event' && (e.category === 'medical' || e.category === 'life'))
      .map((e: any) => ({ t: tOf(e.date), label: e.title || e.category, category: e.category })))).catch(() => {}); }, []);
  useEffect(() => { setOffset(0); }, [range]);

  const latestOf = (a: LabAnalyte) => a.series[a.series.length - 1];
  const oobNow = (a: LabAnalyte) => { const l = latestOf(a); return l ? statusOf(l.value, a.refLow, a.refHigh) : 'na'; };

  // shared time window (anchored to the newest reading, not "today", since labs are historical)
  const [gMin, gMax] = useMemo(() => {
    const ts = (store?.analytes ?? []).flatMap(a => a.series.map(p => tOf(p.date)));
    return ts.length ? [Math.min(...ts), Math.max(...ts)] : [Date.now() - 365 * 86400000, Date.now()];
  }, [store]);
  const years = RANGE_YEARS[range];
  const spanMs = years ? years * 365 * 86400000 : Math.max(1, gMax - gMin);
  const t1 = years ? gMax - offset * spanMs : gMax;
  const t0 = years ? t1 - spanMs : gMin;

  // markers passing search + out-of-range filter (BEFORE the panel/template filter) — this is what "Save panel" captures
  const visibleForSave = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return (store?.analytes ?? []).filter(a =>
      (!ql || a.label.toLowerCase().includes(ql) || a.category.toLowerCase().includes(ql)) &&
      (!oobOnly || oobNow(a) === 'low' || oobNow(a) === 'high'));
  }, [store, q, oobOnly]);

  const groups = useMemo(() => {
    const tplKeys = activeTpl ? new Set(templates.find(t => t.name === activeTpl)?.keys ?? []) : null;
    const m = new Map<string, LabAnalyte[]>();
    for (const a of visibleForSave) {
      if (tplKeys && !tplKeys.has(a.key)) continue;
      if (!m.has(a.category)) m.set(a.category, []);
      m.get(a.category)!.push(a);
    }
    return [...m.entries()];
  }, [visibleForSave, activeTpl, templates]);

  function savePanel() {
    const keys = visibleForSave.map(a => a.key);
    if (!keys.length) { Alert.alert('Nothing to save', 'Narrow the list (search / out-of-range) to the markers you want, then save them as a panel.'); return; }
    if (Alert.prompt) {
      Alert.prompt('Save panel', `Save these ${keys.length} markers as a named panel.`, async (name?: string) => {
        if (!name?.trim()) return; const list = await saveTemplate(name, keys); setTemplates(list); setActiveTpl(name.trim());
      });
    } else { Alert.alert('Not available', 'Naming panels needs iOS.'); }
  }
  function removePanel(t: LabTemplate) {
    Alert.alert('Delete panel', `Delete “${t.name}”?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { setTemplates(await deleteTemplate(t.name)); if (activeTpl === t.name) setActiveTpl(null); } },
    ]);
  }

  async function runAnalysis(a: LabAnalyte) {
    if (!store) return;
    setAnalysis(p => ({ ...p, [a.key]: { loading: true } }));
    try { const text = await analyseLab(a, store); setAnalysis(p => ({ ...p, [a.key]: { loading: false, text } })); }
    catch (e: any) { setAnalysis(p => ({ ...p, [a.key]: { loading: false, error: e?.message ?? String(e) } })); }
  }

  const STATUS_COLOR: Record<Status, string> = { low: '#f59e0b', high: '#ef4444', in: '#22c55e', na: c.textFaint };
  const cardW = width - 32 - 24;
  const monthYear = (t: number) => new Date(t).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });

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

      {/* shared window + filters — applies to every chart */}
      <View style={s.ctrlRow}>
        {RANGES.map(r => <TouchableOpacity key={r} onPress={() => setRange(r)} style={[s.tab, range === r && s.tabOn]}><Text style={[s.tabTxt, range === r && s.tabTxtOn]}>{r}</Text></TouchableOpacity>)}
        <View style={{ flex: 1 }} />
        <TouchableOpacity onPress={() => setShowEvents(v => !v)} style={[s.pill, !showEvents && s.pillOff]}><Text style={[s.pillTxt, !showEvents && s.pillTxtOff]}>{showEvents ? '👁' : '🚫'}</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => setOobOnly(v => !v)} style={[s.pill, oobOnly && s.pillOn]}><Text style={[s.pillTxt, oobOnly && s.pillTxtOnAccent]}>⚠︎</Text></TouchableOpacity>
      </View>
      {years > 0 && (
        <View style={s.navRow}>
          <TouchableOpacity style={s.navBtn} onPress={() => setOffset(o => o + 1)}><Text style={s.navTxt}>◀</Text></TouchableOpacity>
          <Text style={s.navLabel}>{monthYear(t0)} – {monthYear(t1)}</Text>
          <TouchableOpacity style={[s.navBtn, offset === 0 && s.navOff]} disabled={offset === 0} onPress={() => setOffset(o => Math.max(0, o - 1))}><Text style={[s.navTxt, offset === 0 && s.navTxtOff]}>▶</Text></TouchableOpacity>
        </View>
      )}

      {/* Panels — save the current filtered set, recall a saved one */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.panelRow} contentContainerStyle={s.panelRowInner} keyboardShouldPersistTaps="handled">
        <TouchableOpacity style={s.savePanel} onPress={savePanel}><Text style={s.savePanelTxt}>＋ Save panel</Text></TouchableOpacity>
        {templates.map(t => { const on = activeTpl === t.name;
          return <TouchableOpacity key={t.name} style={[s.tpl, on && s.tplOn]} onPress={() => setActiveTpl(on ? null : t.name)} onLongPress={() => removePanel(t)}>
            <Text style={[s.tplTxt, on && s.tplTxtOn]}>{t.name}</Text><Text style={[s.tplN, on && s.tplTxtOn]}>{t.keys.length}</Text></TouchableOpacity>; })}
      </ScrollView>

      {!store ? <View style={s.center}><ActivityIndicator color={c.accent} /></View>
        : store.analytes.length === 0 ? (
          <View style={s.center}>
            <Text style={s.empty}>No labs yet.</Text>
            <TouchableOpacity style={s.importBtnBig} onPress={() => router.push('/labs-import' as any)}><Text style={s.importTxtBig}>Import blood tests</Text></TouchableOpacity>
          </View>
        ) : (
          <ScrollView contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
            {groups.length === 0 && <Text style={s.none}>No markers match.</Text>}
            {groups.map(([cat, items]) => (
              <View key={cat}>
                <Text style={s.catTitle}>{cat}</Text>
                {items.map(a => {
                  const isOpen = open === a.key;
                  const last = latestOf(a); const lastText = a.textSeries?.[a.textSeries.length - 1];
                  const st = last ? statusOf(last.value, a.refLow, a.refHigh) : 'na';
                  const an = analysis[a.key];
                  return (
                    <View key={a.key} style={s.card}>
                      <TouchableOpacity style={s.cardHead} onPress={() => setOpen(isOpen ? null : a.key)}>
                        <View style={{ flex: 1 }}>
                          <Text style={s.aLabel} numberOfLines={1}>{a.label}</Text>
                          <Text style={s.aMeta}>{a.series.length + (a.textSeries?.length ?? 0)} readings{a.refLow != null || a.refHigh != null ? ` · ref ${a.refLow != null ? sig4(a.refLow) : '—'}–${a.refHigh != null ? sig4(a.refHigh) : '—'}` : ''}</Text>
                        </View>
                        {last && <View style={s.lastWrap}>
                          <Text style={[s.lastVal, { color: STATUS_COLOR[st] }]}>{sig4(last.value)}<Text style={s.lastUnit}> {a.unit}</Text></Text>
                          <Text style={s.lastDate}>{last.date}</Text></View>}
                        {!last && lastText && <View style={s.lastWrap}><Text style={s.lastText}>{lastText.text}</Text><Text style={s.lastDate}>{lastText.date}</Text></View>}
                      </TouchableOpacity>
                      {isOpen && (
                        <View style={s.chartWrap}>
                          {a.series.length >= 2 ? <LabChart a={a} width={cardW} c={c} t0={t0} t1={t1} events={showEvents ? events : []} />
                            : a.textSeries?.length ? a.textSeries.slice().reverse().map((t, i) => <Text key={i} style={s.textRow}>{t.date}: <Text style={{ color: c.text }}>{t.text}</Text></Text>)
                            : <Text style={s.textRow}>Not enough data to chart.</Text>}
                          {a.note && <Text style={s.note}>{a.note}</Text>}
                          <TouchableOpacity style={s.analyseBtn} disabled={an?.loading} onPress={() => runAnalysis(a)}>
                            {an?.loading ? <ActivityIndicator color={c.onAccent} size="small" /> : <Text style={s.analyseTxt}>{an?.text ? '↻ Re-analyse' : '✨ Analyse'}</Text>}
                          </TouchableOpacity>
                          {an?.error && <Text style={s.err}>{an.error}</Text>}
                          {an?.text && <Text style={s.analysis}>{an.text}</Text>}
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
  search:   { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 10, marginHorizontal: 14, marginTop: 8, paddingHorizontal: 12, paddingVertical: 9, color: c.text, fontSize: 14 },
  ctrlRow:  { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, marginTop: 8 },
  tab:      { paddingVertical: 5, paddingHorizontal: 11, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  tabOn:    { backgroundColor: c.accent, borderColor: c.accent },
  tabTxt:   { color: c.textSub, fontSize: 12.5, fontWeight: '700' },
  tabTxtOn: { color: c.onAccent },
  pill:     { paddingVertical: 5, paddingHorizontal: 9, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  pillOn:   { backgroundColor: c.accent, borderColor: c.accent },
  pillOff:  { opacity: 0.5 },
  pillTxt:  { color: c.text, fontSize: 13, fontWeight: '700' },
  pillTxtOff:{ color: c.textFaint },
  pillTxtOnAccent:{ color: c.onAccent },
  navRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, marginTop: 8 },
  navBtn:   { paddingVertical: 4, paddingHorizontal: 16, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  navOff:   { opacity: 0.4 },
  navTxt:   { color: c.text, fontSize: 14, fontWeight: '800' },
  navTxtOff:{ color: c.textFaint },
  navLabel: { color: c.textSub, fontSize: 12.5, fontWeight: '600' },
  panelRow: { maxHeight: 40, marginTop: 8, flexGrow: 0 },
  panelRowInner:{ paddingHorizontal: 14, gap: 6, alignItems: 'center' },
  savePanel:{ paddingVertical: 6, paddingHorizontal: 11, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  savePanelTxt:{ color: c.accent, fontSize: 12.5, fontWeight: '700' },
  tpl:      { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 11, borderRadius: 8, backgroundColor: c.surface, borderWidth: 1, borderColor: c.accent },
  tplOn:    { backgroundColor: c.accent, borderColor: c.accent },
  tplTxt:   { color: c.accent, fontSize: 12.5, fontWeight: '700' },
  tplTxtOn: { color: c.onAccent },
  tplN:     { color: c.textFaint, fontSize: 11, fontWeight: '600' },
  center:   { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 },
  empty:    { color: c.textSub, fontSize: 15 },
  none:     { color: c.textFaint, fontSize: 14, textAlign: 'center', marginTop: 30 },
  importBtnBig:{ backgroundColor: c.accent, borderRadius: 12, paddingVertical: 13, paddingHorizontal: 22 },
  importTxtBig:{ color: c.onAccent, fontSize: 15, fontWeight: '800' },
  pad:      { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 20 },
  catTitle: { color: c.textSub, fontSize: 13, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 16, marginBottom: 6 },
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
  analyseBtn:{ backgroundColor: c.accent, borderRadius: 10, paddingVertical: 10, alignItems: 'center', marginTop: 10 },
  analyseTxt:{ color: c.onAccent, fontSize: 14, fontWeight: '800' },
  analysis: { color: c.text, fontSize: 13.5, lineHeight: 20, marginTop: 10 },
  err:      { color: '#ef4444', fontSize: 12.5, marginTop: 8 },
});
