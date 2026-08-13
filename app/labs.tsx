import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, TextInput, useWindowDimensions, ActivityIndicator, Alert, PanResponder } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import Svg, { Polyline, Line, Rect, Circle, Text as SvgText } from 'react-native-svg';
import { loadLabs, LabStore, loadTemplates, saveTemplate, deleteTemplate, LabTemplate } from '../src/services/labsStore';
import { LabAnalyte } from '../src/services/labs';
import { analyseLab } from '../src/services/labsAnalysis';
import { loadEvents } from '../src/services/timelineEvents';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import MarkdownBody from '../src/MarkdownBody';
import { TABLE_CELL } from '../src/mdTable';

const tOf = (d: string) => new Date(d.length <= 10 ? d + 'T00:00:00' : d).getTime();
const yr = (t: number) => new Date(t).getFullYear();
const sig4 = (v: number) => Number(v.toPrecision(4)).toString();
const TOL = 0.005;
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

const mLabel = (t: number) => new Date(t).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });

function LabChart({ a, width, c, t0, t1, events }: { a: LabAnalyte; width: number; c: Palette; t0: number; t1: number; events: Ev[] }) {
  const H = 186, PL = 46, PR = 12, PT = 12, PB = 22;
  const plotW = Math.max(1, width - PL - PR), plotH = H - PT - PB, span = Math.max(1, t1 - t0);
  const pts = a.series.filter(p => { const t = tOf(p.date); return t >= t0 && t <= t1; });

  // scrub cursor (local): map a plot-relative touch x → time; held in a ref reassigned every render
  const [cur, setCur] = useState<number | null>(null);
  const mapRef = useRef<(x: number) => number>(() => t0);
  mapRef.current = (x: number) => t0 + ((Math.max(PL, Math.min(PL + plotW, x)) - PL) / plotW) * span;
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > Math.abs(g.dy) && Math.abs(g.dx) > 3,
    onPanResponderGrant: (e) => setCur(mapRef.current(e.nativeEvent.locationX)),
    onPanResponderMove: (e) => setCur(mapRef.current(e.nativeEvent.locationX)),
  })).current;

  if (pts.length < 2) return <Text style={{ color: c.textFaint, fontSize: 12, paddingVertical: 8 }}>Fewer than 2 readings in this period.</Text>;

  const vals = pts.map(p => p.value);
  const lo = Math.min(...vals, a.refLow ?? Infinity), hi = Math.max(...vals, a.refHigh ?? -Infinity);
  const pad = (hi - lo) * 0.1 || Math.abs(hi) * 0.1 || 1;
  const yLo = lo - pad, yHi = hi + pad;
  const x = (t: number) => PL + ((t - t0) / span) * plotW;
  const y = (v: number) => PT + (1 - (v - yLo) / (yHi - yLo)) * plotH;
  const line = pts.map(p => `${x(tOf(p.date)).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const evIn = events.filter(e => e.t >= t0 && e.t <= t1);

  // year/month vertical shading bands
  const yearly = span > 2.2 * 365 * 86400000;
  const bands: { x: number; w: number; mid: number }[] = [];
  { const d = new Date(t0); if (yearly) d.setMonth(0, 1); else d.setDate(1); d.setHours(0, 0, 0, 0); let i = 0;
    while (d.getTime() <= t1) { const sMs = Math.max(t0, d.getTime()); const n = new Date(d);
      if (yearly) n.setFullYear(n.getFullYear() + 1); else n.setMonth(n.getMonth() + 1);
      const eMs = Math.min(t1, n.getTime());
      bands.push({ x: PL + ((sMs - t0) / span) * plotW, w: Math.max(0, ((eMs - sMs) / span) * plotW), mid: (sMs + eMs) / 2 });
      if (yearly) d.setFullYear(d.getFullYear() + 1); else d.setMonth(d.getMonth() + 1); i++; } }
  const bandFill = c.mode === 'dark' ? '#FFFFFF' : '#000000';
  const labelStep = Math.max(1, Math.ceil(bands.length / 6));   // ≤ ~6 x labels

  // Y gridlines — 5 divisions
  const yTicks = Array.from({ length: 5 }, (_, i) => yLo + ((yHi - yLo) * i) / 4);

  // cursor → nearest point
  const nearest = (() => { if (cur == null) return pts[pts.length - 1]; let best = pts[0], bd = Infinity;
    for (const p of pts) { const dd = Math.abs(tOf(p.date) - cur); if (dd < bd) { bd = dd; best = p; } } return best; })();
  const cx = x(tOf(nearest.date));
  const nearEv = cur != null ? evIn.map(e => ({ e, dx: Math.abs(x(e.t) - x(cur)) })).sort((p, q) => p.dx - q.dx)[0] : null;
  const readEv = nearEv && nearEv.dx < 14 ? nearEv.e : null;

  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingHorizontal: 2, marginBottom: 2 }}>
        <Text style={{ color: c.textSub, fontSize: 12, fontWeight: '700' }}>{nearest.date}</Text>
        {readEv
          ? <Text style={{ color: EV_COLOR[readEv.category] ?? c.textSub, fontSize: 12, fontWeight: '700' }} numberOfLines={1}>{readEv.label}</Text>
          : <Text style={{ color: c.accent, fontSize: 13, fontWeight: '800' }}>{sig4(nearest.value)} <Text style={{ color: c.textFaint, fontSize: 11 }}>{a.unit}</Text></Text>}
      </View>
      <View {...pan.panHandlers}>
        <Svg width={width} height={H}>
          {bands.map((b, i) => i % 2 === 0 ? <Rect key={`b${i}`} x={b.x} y={PT} width={b.w} height={plotH} fill={bandFill} opacity={0.04} /> : null)}
          {yTicks.map((v, i) => <Line key={`g${i}`} x1={PL} y1={y(v)} x2={PL + plotW} y2={y(v)} stroke={c.gridline} strokeWidth={1} />)}
          {yTicks.map((v, i) => <SvgText key={`yl${i}`} x={PL - 5} y={y(v) + 3} fontSize={9.5} fill={c.textSub} fontWeight="600" textAnchor="end">{sig4(v)}</SvgText>)}
          {a.refLow != null && a.refHigh != null &&
            <Rect x={PL} y={y(a.refHigh)} width={plotW} height={Math.max(1, y(a.refLow) - y(a.refHigh))} fill="#22c55e" opacity={0.13} />}
          {a.refLow != null && a.refHigh == null && <Line x1={PL} y1={y(a.refLow)} x2={PL + plotW} y2={y(a.refLow)} stroke="#22c55e" strokeOpacity={0.6} strokeDasharray="4 4" />}
          {a.refHigh != null && a.refLow == null && <Line x1={PL} y1={y(a.refHigh)} x2={PL + plotW} y2={y(a.refHigh)} stroke="#ef4444" strokeOpacity={0.6} strokeDasharray="4 4" />}
          {evIn.map((e, i) => <Line key={`e${i}`} x1={x(e.t)} y1={PT} x2={x(e.t)} y2={PT + plotH} stroke={EV_COLOR[e.category] ?? c.textFaint} strokeOpacity={0.5} strokeWidth={1.5} strokeDasharray="2 3" />)}
          {bands.filter((_, i) => i % labelStep === 0).map((b, i) =>
            <SvgText key={`x${i}`} x={Math.min(PL + plotW - 8, Math.max(PL + 8, b.mid <= t1 && b.mid >= t0 ? x(b.mid) : b.x))} y={H - 6} fontSize={9.5} fill={c.textSub} fontWeight="600" textAnchor="middle">{yearly ? yr(b.mid) : mLabel(b.mid)}</SvgText>)}
          <Polyline points={line} fill="none" stroke={c.accent} strokeWidth={2.2} />
          {pts.map((p, i) => <Circle key={i} cx={x(tOf(p.date))} cy={y(p.value)} r={2} fill={c.surface} stroke={c.accent} strokeWidth={1.2} />)}
          {/* cursor */}
          <Line x1={cx} y1={PT} x2={cx} y2={PT + plotH} stroke={c.accent} strokeOpacity={0.5} strokeWidth={1} />
          <Circle cx={cx} cy={y(nearest.value)} r={4.5} fill={c.accent} stroke={c.surface} strokeWidth={1.5} />
        </Svg>
      </View>
    </View>
  );
}

export default function LabsScreen() {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const md = useThemedStyles(makeMarkdownStyles);
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedOnly, setSelectedOnly] = useState(false);

  useEffect(() => { loadLabs().then(setStore); }, []);
  useEffect(() => { loadTemplates().then(setTemplates); }, []);
  useEffect(() => { loadEvents().then(list => setEvents(
    list.filter((e: any) => e.type === 'event' && (e.category === 'medical' || e.category === 'life'))
      .map((e: any) => ({ t: tOf(e.date), label: e.title || e.category, category: e.category })))).catch(() => {}); }, []);
  useEffect(() => { setOffset(0); }, [range]);

  const latestOf = (a: LabAnalyte) => a.series[a.series.length - 1];
  const oobNow = (a: LabAnalyte) => { const l = latestOf(a); return l ? statusOf(l.value, a.refLow, a.refHigh) : 'na'; };

  const [gMin, gMax] = useMemo(() => {
    const ts = (store?.analytes ?? []).flatMap(a => a.series.map(p => tOf(p.date)));
    return ts.length ? [Math.min(...ts), Math.max(...ts)] : [Date.now() - 365 * 86400000, Date.now()];
  }, [store]);
  const years = RANGE_YEARS[range];
  const spanMs = years ? years * 365 * 86400000 : Math.max(1, gMax - gMin);
  const t1 = years ? gMax - offset * spanMs : gMax;
  const t0 = years ? t1 - spanMs : gMin;

  // markers passing search + out-of-range filter (BEFORE the "selected only" view filter)
  const baseVisible = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return (store?.analytes ?? []).filter(a =>
      (!ql || a.label.toLowerCase().includes(ql) || a.category.toLowerCase().includes(ql)) &&
      (!oobOnly || oobNow(a) === 'low' || oobNow(a) === 'high'));
  }, [store, q, oobOnly]);

  const groups = useMemo(() => {
    const m = new Map<string, LabAnalyte[]>();
    for (const a of baseVisible) {
      if (selectedOnly && !selected.has(a.key)) continue;
      if (!m.has(a.category)) m.set(a.category, []);
      m.get(a.category)!.push(a);
    }
    return [...m.entries()];
  }, [baseVisible, selectedOnly, selected]);

  const toggleSel = (k: string) => setSelected(p => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const setGroup = (items: LabAnalyte[], on: boolean) => setSelected(p => { const n = new Set(p); for (const a of items) on ? n.add(a.key) : n.delete(a.key); return n; });
  const selectAllVisible = () => setSelected(p => { const n = new Set(p); for (const a of baseVisible) n.add(a.key); return n; });
  const clearSel = () => { setSelected(new Set()); setSelectedOnly(false); };

  function savePanel() {
    const keys = [...selected];
    if (!keys.length) { Alert.alert('Nothing selected', 'Tick some markers (or “All”) first, then save them as a panel.'); return; }
    if (!Alert.prompt) { Alert.alert('Not available', 'Naming panels needs iOS.'); return; }
    const existing = templates.length ? `\n\nExisting panels: ${templates.map(t => t.name).join(', ')}` : '';
    Alert.prompt('Save panel', `Name this panel of ${keys.length} markers.${existing}`, async (name?: string) => {
      const nm = name?.trim(); if (!nm) return;
      const clash = templates.some(t => t.name.toLowerCase() === nm.toLowerCase());
      const doSave = async () => setTemplates(await saveTemplate(nm, keys));
      if (clash) Alert.alert('Overwrite panel?', `A panel named “${nm}” already exists. Overwrite it?`,
        [{ text: 'Cancel', style: 'cancel' }, { text: 'Overwrite', style: 'destructive', onPress: doSave }]);
      else await doSave();
    });
  }
  function restorePanel(t: LabTemplate) {
    const avail = new Set((store?.analytes ?? []).map(a => a.key));
    const present = t.keys.filter(k => avail.has(k));
    setSelected(new Set(present));
    setSelectedOnly(true);
    const missing = t.keys.length - present.length;
    if (missing > 0) Alert.alert('Panel partly available', `${missing} of ${t.keys.length} markers in “${t.name}” aren't in your current data — showing the ${present.length} that are. The panel is kept as-is.`);
  }
  function removePanel(t: LabTemplate) {
    Alert.alert('Delete panel', `Delete “${t.name}”?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => setTemplates(await deleteTemplate(t.name)) },
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
        <TouchableOpacity style={s.importBtn} onPress={() => router.push('/data-chat?mode=labs' as any)}><Text style={s.importTxt}>💬 Chat</Text></TouchableOpacity>
        <TouchableOpacity style={s.importBtn} onPress={() => router.push('/labs-import' as any)}><Text style={s.importTxt}>Import</Text></TouchableOpacity>
      </View>
      <TextInput style={s.search} value={q} onChangeText={setQ} placeholder="Search markers…" placeholderTextColor={c.textFaint} autoCapitalize="none" />

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

      {/* Selection toolbar */}
      <View style={s.selRow}>
        <TouchableOpacity style={s.selBtn} onPress={selectAllVisible}><Text style={s.selBtnTxt}>Select all</Text></TouchableOpacity>
        <TouchableOpacity style={s.selBtn} onPress={clearSel}><Text style={s.selBtnTxt}>Clear</Text></TouchableOpacity>
        <TouchableOpacity style={[s.selBtn, selectedOnly && s.selBtnOn]} onPress={() => setSelectedOnly(v => !v)}><Text style={[s.selBtnTxt, selectedOnly && s.selBtnTxtOn]}>Selected only ({selected.size})</Text></TouchableOpacity>
        <View style={{ flex: 1 }} />
        <TouchableOpacity style={s.savePanel} onPress={savePanel}><Text style={s.savePanelTxt}>＋ Save panel</Text></TouchableOpacity>
      </View>
      {/* Panels — tap to restore a saved selection, long-press to delete */}
      {templates.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.panelRow} contentContainerStyle={s.panelRowInner} keyboardShouldPersistTaps="handled">
          <Text style={s.panelLbl}>Panels:</Text>
          {templates.map(t => (
            <TouchableOpacity key={t.name} style={s.tpl} onPress={() => restorePanel(t)} onLongPress={() => removePanel(t)}>
              <Text style={s.tplTxt}>{t.name}</Text><Text style={s.tplN}>{t.keys.length}</Text>
            </TouchableOpacity>))}
        </ScrollView>
      )}

      {!store ? <View style={s.center}><ActivityIndicator color={c.accent} /></View>
        : store.analytes.length === 0 ? (
          <View style={s.center}>
            <Text style={s.empty}>No labs yet.</Text>
            <TouchableOpacity style={s.importBtnBig} onPress={() => router.push('/labs-import' as any)}><Text style={s.importTxtBig}>Import blood tests</Text></TouchableOpacity>
          </View>
        ) : (
          <ScrollView contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
            {groups.length === 0 && <Text style={s.none}>No markers match.</Text>}
            {groups.map(([cat, items]) => {
              const selN = items.filter(a => selected.has(a.key)).length;
              const tri = selN === 0 ? '' : selN === items.length ? '✓' : '–';
              return (
                <View key={cat}>
                  <View style={s.catRow}>
                    <TouchableOpacity onPress={() => setGroup(items, selN !== items.length)}><Text style={[s.cbBox, tri && s.cbBoxOn]}>{tri}</Text></TouchableOpacity>
                    <Text style={s.catTitle}>{cat}</Text><Text style={s.catCount}>{selN}/{items.length}</Text>
                  </View>
                  {items.map(a => {
                    const isOpen = open === a.key; const sel = selected.has(a.key);
                    const last = latestOf(a); const lastText = a.textSeries?.[a.textSeries.length - 1];
                    const st = last ? statusOf(last.value, a.refLow, a.refHigh) : 'na';
                    const an = analysis[a.key];
                    return (
                      <View key={a.key} style={s.card}>
                        <View style={s.cardHead}>
                          <TouchableOpacity onPress={() => toggleSel(a.key)}><Text style={[s.cbBox, sel && s.cbBoxOn]}>{sel ? '✓' : ''}</Text></TouchableOpacity>
                          <TouchableOpacity style={s.cardMain} onPress={() => setOpen(isOpen ? null : a.key)}>
                            <View style={{ flex: 1 }}>
                              <Text style={s.aLabel} numberOfLines={1}>{a.label}</Text>
                              <Text style={s.aMeta}>{a.series.length + (a.textSeries?.length ?? 0)} readings{a.refLow != null || a.refHigh != null ? ` · ref ${a.refLow != null ? sig4(a.refLow) : '—'}–${a.refHigh != null ? sig4(a.refHigh) : '—'}` : ''}</Text>
                            </View>
                            {last && <View style={s.lastWrap}>
                              <Text style={[s.lastVal, { color: STATUS_COLOR[st] }]}>{sig4(last.value)}<Text style={s.lastUnit}> {a.unit}</Text></Text>
                              <Text style={s.lastDate}>{last.date}</Text></View>}
                            {!last && lastText && <View style={s.lastWrap}><Text style={s.lastText}>{lastText.text}</Text><Text style={s.lastDate}>{lastText.date}</Text></View>}
                          </TouchableOpacity>
                        </View>
                        {isOpen && (
                          <View style={s.chartWrap}>
                            {a.series.length >= 2 ? <LabChart a={a} width={cardW} c={c} t0={t0} t1={t1} events={showEvents ? events : []} />
                              : a.textSeries?.length ? a.textSeries.slice().reverse().map((t, i) => <Text key={i} style={s.textRow}>{t.date}: <Text style={{ color: c.text }}>{t.text}</Text></Text>)
                              : <Text style={s.textRow}>Not enough data to chart.</Text>}
                            {(() => {
                              const shown = a.series.filter(p => { const t = tOf(p.date); return t >= t0 && t <= t1; }).length;
                              return a.series.length >= 2 && shown < a.series.length
                                ? <TouchableOpacity onPress={() => setRange('All')}><Text style={s.clip}>Showing {shown} of {a.series.length} readings in this window — tap for the full history.</Text></TouchableOpacity>
                                : null;
                            })()}
                            {a.note && <Text style={s.note}>{a.note}</Text>}
                            <TouchableOpacity style={s.analyseBtn} disabled={an?.loading} onPress={() => runAnalysis(a)}>
                              {an?.loading ? <ActivityIndicator color={c.onAccent} size="small" /> : <Text style={s.analyseTxt}>{an?.text ? '↻ Re-analyse' : '✨ Analyse'}</Text>}
                            </TouchableOpacity>
                            {an?.error && <Text style={s.err}>{an.error}</Text>}
                            {an?.text && <View style={{ marginTop: 10 }}><MarkdownBody content={an.text} style={md} c={c} /></View>}
                          </View>
                        )}
                      </View>
                    );
                  })}
                </View>
              );
            })}
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
  selRow:   { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, marginTop: 8 },
  selBtn:   { paddingVertical: 5, paddingHorizontal: 9, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  selBtnOn: { backgroundColor: c.accent, borderColor: c.accent },
  selBtnTxt:{ color: c.textSub, fontSize: 12, fontWeight: '700' },
  selBtnTxtOn:{ color: c.onAccent },
  savePanel:{ paddingVertical: 5, paddingHorizontal: 10, borderRadius: 8, backgroundColor: c.surface, borderWidth: 1, borderColor: c.accent },
  savePanelTxt:{ color: c.accent, fontSize: 12.5, fontWeight: '800' },
  panelRow: { height: 42, marginTop: 8, flexGrow: 0 },
  panelRowInner:{ paddingHorizontal: 14, gap: 6, alignItems: 'center' },
  panelLbl: { color: c.textFaint, fontSize: 12, fontWeight: '700', marginRight: 2 },
  tpl:      { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 11, borderRadius: 8, backgroundColor: c.surface, borderWidth: 1, borderColor: c.accent },
  tplTxt:   { color: c.accent, fontSize: 12.5, fontWeight: '700' },
  tplN:     { color: c.textFaint, fontSize: 11, fontWeight: '600' },
  center:   { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 },
  empty:    { color: c.textSub, fontSize: 15 },
  none:     { color: c.textFaint, fontSize: 14, textAlign: 'center', marginTop: 30 },
  importBtnBig:{ backgroundColor: c.accent, borderRadius: 12, paddingVertical: 13, paddingHorizontal: 22 },
  importTxtBig:{ color: c.onAccent, fontSize: 15, fontWeight: '800' },
  pad:      { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 20 },
  catRow:   { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16, marginBottom: 6 },
  catTitle: { color: c.textSub, fontSize: 13, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5, flex: 1 },
  catCount: { color: c.textFaint, fontSize: 12, fontWeight: '700' },
  card:     { backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.border, marginBottom: 8, overflow: 'hidden' },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 },
  cardMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  cbBox:    { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: c.textFaint, color: c.onAccent, textAlign: 'center', fontSize: 14, fontWeight: '800', overflow: 'hidden', lineHeight: 19 },
  cbBoxOn:  { backgroundColor: c.accent, borderColor: c.accent },
  aLabel:   { color: c.text, fontSize: 14, fontWeight: '700' },
  aMeta:    { color: c.textFaint, fontSize: 11.5, marginTop: 2 },
  lastWrap: { alignItems: 'flex-end' },
  lastVal:  { fontSize: 16, fontWeight: '800' },
  lastUnit: { fontSize: 11, fontWeight: '600', color: c.textFaint },
  lastText: { color: c.text, fontSize: 14, fontWeight: '700', maxWidth: 120, textAlign: 'right' },
  lastDate: { color: c.textFaint, fontSize: 10.5, marginTop: 1 },
  chartWrap:{ borderTopWidth: 1, borderTopColor: c.border, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: c.surfaceAlt },
  textRow:  { color: c.textSub, fontSize: 12.5, lineHeight: 20 },
  note:     { color: c.textFaint, fontSize: 11, marginTop: 6, fontStyle: 'italic' },
  clip:     { color: c.accent, fontSize: 11.5, marginTop: 6, fontWeight: '600' },
  analyseBtn:{ backgroundColor: c.accent, borderRadius: 10, paddingVertical: 10, alignItems: 'center', marginTop: 10 },
  analyseTxt:{ color: c.onAccent, fontSize: 14, fontWeight: '800' },
  err:      { color: '#ef4444', fontSize: 12.5, marginTop: 8 },
});

const makeMarkdownStyles = (c: Palette) => StyleSheet.create({
  body: { color: c.text, fontSize: 13.5, lineHeight: 20 },
  heading1: { fontSize: 16, fontWeight: '800', color: c.text, marginTop: 8, marginBottom: 4 },
  heading2: { fontSize: 15, fontWeight: '700', color: c.accent, marginTop: 10, marginBottom: 3 },
  heading3: { fontSize: 14, fontWeight: '700', color: c.text, marginTop: 8, marginBottom: 2 },
  strong: { fontWeight: '800', color: c.text },
  em: { fontStyle: 'italic', color: c.text },
  paragraph: { marginBottom: 7 },
  bullet_list: { marginBottom: 7, color: c.text },
  ordered_list: { marginBottom: 7, color: c.text },
  list_item: { marginBottom: 3, color: c.text },
  code_inline: { fontFamily: 'Courier', fontSize: 12.5, color: c.text, backgroundColor: c.surfaceAlt, borderRadius: 3, paddingHorizontal: 4 },
  hr: { borderBottomWidth: 1, borderColor: c.border, marginVertical: 8 },
  table: { borderWidth: 1, borderColor: c.border, borderRadius: 4, marginBottom: 8, overflow: 'hidden' },
  thead: { backgroundColor: c.surfaceAlt },
  th: { ...TABLE_CELL, fontWeight: '700', padding: 4, fontSize: 10, color: c.text, borderRightWidth: 1, borderColor: c.border },
  td: { ...TABLE_CELL, padding: 4, fontSize: 10, color: c.text, borderRightWidth: 1, borderColor: c.border },
  tr: { borderBottomWidth: 1, borderColor: c.border },
});
