import React, { useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, useWindowDimensions, PanResponder } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import Svg, { Polyline, Line, Rect, Circle, Text as SvgText } from 'react-native-svg';
import { requestPermissions } from '../src/services/healthkit';
import { computeBiologyReport, compositionChange, BiologyReport, BioMetric, BioPoint } from '../src/services/biology';
import { useTheme, useThemedStyles, Palette } from '../src/theme';

type Range = '3M' | '6M' | '1Y' | '5Y' | '10Y';
const RANGES: Range[] = ['3M', '6M', '1Y', '5Y', '10Y'];
const RANGE_MONTHS: Record<Range, number> = { '3M': 3, '6M': 6, '1Y': 12, '5Y': 60, '10Y': 120 };
const CAT_COLOR: Record<string, string> = { medical: '#ef4444', life: '#10b981', travel: '#3b82f6', holiday: '#f59e0b', other: '#9ca3af' };
const CAT_ICON: Record<string, string> = { medical: '🩺', life: '🎉', travel: '✈️', holiday: '🏖️', other: '📌' };
const SERIES: Record<string, string> = { weight: '#3b82f6', bodyfat: '#f59e0b', lean: '#10b981', bpSys: '#ef4444', bpDia: '#8b5cf6' };

const CH_H = 128, PAD_L = 34, PAD_R = 10, PAD_T = 8, PAD_B = 16;
const monthYear = (t: number) => new Date(t).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
const labelAt = (t: number, months: number) => months > 12
  ? new Date(t).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
  : new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

// One chart. Cursor is CONTROLLED by the parent (cursorTime) so all charts move together; dragging any
// chart reports the time back via onCursor. Metric lines are bold; CTL is the dashed overlay; events show
// as icons (point) or shaded zones (range).
function BioChart({ lines, t0, t1, ctl, events, innerW, c, months, styles, cursorTime, onCursor }: {
  lines: { key: string; label: string; points: BioPoint[] }[];
  t0: number; t1: number; ctl: BioPoint[];
  events: { date: string; endDate?: string; label: string; category: string }[];
  innerW: number; c: Palette; months: number; styles: any;
  cursorTime: number | null; onCursor: (t: number | null) => void;
}) {
  const plotW = Math.max(1, innerW - PAD_L - PAD_R);
  const plotH = CH_H - PAD_T - PAD_B;
  const span = Math.max(1, t1 - t0);
  // Map a plot-relative touch x → time. Held in a ref RE-ASSIGNED every render so the once-created
  // PanResponder always uses the CURRENT window (fixes the cursor drifting / not reaching the left after nav).
  const mapRef = useRef<(x: number) => number>(() => t0);
  mapRef.current = (x: number) => t0 + ((Math.max(PAD_L, Math.min(PAD_L + plotW, x)) - PAD_L) / plotW) * span;
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > Math.abs(g.dy) && Math.abs(g.dx) > 3,
    // Use the touch x RELATIVE to the plot view (locationX) — no window-measure offset, so the whole width
    // (incl. the first half) is reachable.
    onPanResponderGrant: (evt) => onCursor(mapRef.current(evt.nativeEvent.locationX)),
    onPanResponderMove: (evt) => onCursor(mapRef.current(evt.nativeEvent.locationX)),
    onPanResponderTerminationRequest: () => false,
  })).current;

  const tOf = (iso: string) => new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso).getTime();
  const inRange = (iso: string) => tOf(iso) >= t0 && tOf(iso) <= t1;
  const xOf = (iso: string) => PAD_L + Math.max(0, Math.min(1, (tOf(iso) - t0) / span)) * plotW;

  const vals = lines.flatMap(l => l.points.filter(p => inRange(p.date)).map(p => p.value)).filter(Number.isFinite);
  if (vals.length < 2) return <View style={{ height: CH_H, justifyContent: 'center', alignItems: 'center' }}><Text style={{ color: c.textFaint }}>Not enough data in this range.</Text></View>;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.12 || 1;
  const yLo = lo - pad, yHi = hi + pad;
  const yOf = (v: number) => PAD_T + (1 - (v - yLo) / (yHi - yLo)) * plotH;

  const cInR = ctl.filter(p => inRange(p.date));
  const cv = cInR.map(p => p.value).filter(Number.isFinite);
  const cLo = cv.length ? Math.min(...cv) : 0, cHi = cv.length ? Math.max(...cv) : 1;
  const yCtl = (v: number) => PAD_T + (1 - (v - cLo) / Math.max(1, cHi - cLo)) * plotH;
  const ctlPts = cInR.map(p => `${xOf(p.date).toFixed(1)},${yCtl(p.value).toFixed(1)}`).join(' ');

  const yearly = months > 12;
  const bands: { x: number; w: number }[] = [];
  { const d = new Date(t0); if (yearly) d.setMonth(0, 1); else d.setDate(1); d.setHours(0, 0, 0, 0); let i = 0;
    while (d.getTime() <= t1) { const s = Math.max(t0, d.getTime()); const n = new Date(d); if (yearly) n.setFullYear(n.getFullYear() + 1); else n.setMonth(n.getMonth() + 1); const e = Math.min(t1, n.getTime());
      if (i % 2 === 0) bands.push({ x: PAD_L + ((s - t0) / span) * plotW, w: ((e - s) / span) * plotW });
      if (yearly) d.setFullYear(d.getFullYear() + 1); else d.setMonth(d.getMonth() + 1); i++; } }
  const bandFill = c.mode === 'dark' ? '#fff' : '#000';
  const yTicks = [yLo + (yHi - yLo) * 0.12, (yLo + yHi) / 2, yHi - (yHi - yLo) * 0.12];
  const nLab = 4;

  // Cursor (controlled): default to latest (right edge) so the readout is never empty.
  const scrubbing = cursorTime != null;
  const cT = scrubbing ? Math.max(t0, Math.min(t1, cursorTime!)) : t1;
  const cx = PAD_L + ((cT - t0) / span) * plotW;
  const nearestOf = (pts: BioPoint[]) => { let best: BioPoint | null = null, bd = Infinity; for (const p of pts) { if (!inRange(p.date)) continue; const d = Math.abs(tOf(p.date) - cT); if (d < bd) { bd = d; best = p; } } return best; };
  const evInR = events.filter(e => tOf(e.date) <= t1 && tOf(e.endDate ?? e.date) >= t0);
  const nearEv = evInR.map(e => { const xs = xOf(e.date), xe = e.endDate ? xOf(e.endDate) : xs; const loX = Math.min(xs, xe), hiX = Math.max(xs, xe); const dx = cx >= loX - 2 && cx <= hiX + 2 ? 0 : Math.min(Math.abs(cx - xs), Math.abs(cx - xe)); return { e, dx }; }).sort((a, b) => a.dx - b.dx)[0];
  const showEvent = nearEv && nearEv.dx < 16 ? nearEv.e : null;
  const sameEv = (a: { date: string; label: string }, b: { date: string; label: string }) => a.date === b.date && a.label === b.label;
  const readVals = lines.map(l => ({ key: l.key, label: l.label, p: nearestOf(l.points) }));

  return (
    <View>
      <View style={styles.readout}>
        <Text style={styles.readDate}>{labelAt(cT, months)}</Text>
        {readVals.map(r => <Text key={r.key} style={[styles.readVal, { color: SERIES[r.key] }]}>{r.label} {r.p ? r.p.value : '—'}</Text>)}
        {showEvent && <Text style={[styles.readVal, { color: CAT_COLOR[showEvent.category] ?? CAT_COLOR.other }]}>{CAT_ICON[showEvent.category] ?? '📌'} {showEvent.label}</Text>}
      </View>
      <View {...pan.panHandlers}>
        <Svg width={innerW} height={CH_H}>
          {bands.map((b, i) => <Rect key={`b${i}`} x={b.x} y={PAD_T} width={b.w} height={plotH} fill={bandFill} opacity={0.04} />)}
          {yTicks.map((v, i) => <React.Fragment key={`y${i}`}>
            <Line x1={PAD_L} y1={yOf(v)} x2={PAD_L + plotW} y2={yOf(v)} stroke={c.gridline} strokeWidth={0.5} />
            <SvgText x={PAD_L - 4} y={yOf(v) + 3} fontSize={8} fill={c.textFaint} textAnchor="end">{Math.round(v * 10) / 10}</SvgText>
          </React.Fragment>)}
          {evInR.map((e, i) => {
            const on = !!showEvent && sameEv(e, showEvent);
            const col = CAT_COLOR[e.category] ?? CAT_COLOR.other;
            const icon = CAT_ICON[e.category] ?? CAT_ICON.other;
            const xs = xOf(e.date);
            if (e.endDate && e.endDate !== e.date) {
              const xe = xOf(e.endDate); const x = Math.min(xs, xe); const w = Math.max(1, Math.abs(xe - xs));
              return <React.Fragment key={`e${i}`}>
                <Rect x={x} y={PAD_T} width={w} height={plotH} fill={col} opacity={on ? 0.16 : 0.09} />
                <Line x1={x} y1={PAD_T} x2={x} y2={PAD_T + plotH} stroke={col} strokeWidth={on ? 1.5 : 1} opacity={on ? 0.9 : 0.5} />
                <Line x1={x + w} y1={PAD_T} x2={x + w} y2={PAD_T + plotH} stroke={col} strokeWidth={on ? 1.5 : 1} opacity={on ? 0.9 : 0.5} />
                <SvgText x={Math.max(PAD_L + 6, Math.min(PAD_L + plotW - 6, x + w / 2))} y={PAD_T + 8} fontSize={10} textAnchor="middle">{icon}</SvgText>
              </React.Fragment>;
            }
            return <React.Fragment key={`e${i}`}>
              <Line x1={xs} y1={PAD_T + 5} x2={xs} y2={PAD_T + plotH} stroke={col} strokeWidth={on ? 2 : 1} strokeDasharray={on ? undefined : '2,3'} opacity={on ? 0.95 : 0.55} />
              <SvgText x={Math.max(PAD_L + 5, Math.min(PAD_L + plotW - 5, xs))} y={PAD_T + 2} fontSize={10} textAnchor="middle">{icon}</SvgText>
            </React.Fragment>;
          })}
          {ctlPts && <Polyline points={ctlPts} fill="none" stroke={c.textSub} strokeWidth={1.8} opacity={0.8} strokeDasharray="6,3" />}
          {lines.map(l => {
            const pts = l.points.filter(p => inRange(p.date));
            const poly = pts.map(p => `${xOf(p.date).toFixed(1)},${yOf(p.value).toFixed(1)}`).join(' ');
            return <React.Fragment key={l.key}>
              {pts.length > 1 && <Polyline points={poly} fill="none" stroke={SERIES[l.key]} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />}
              {pts.map((p, i) => <Circle key={i} cx={xOf(p.date)} cy={yOf(p.value)} r={pts.length > 60 ? 1.6 : 2.4} fill={SERIES[l.key]} />)}
            </React.Fragment>;
          })}
          <Line x1={cx} y1={PAD_T} x2={cx} y2={PAD_T + plotH} stroke={c.textSub} strokeWidth={1} opacity={scrubbing ? 0.85 : 0.3} />
          {readVals.map(r => r.p && inRange(r.p.date) ? <Circle key={`c${r.key}`} cx={xOf(r.p.date)} cy={yOf(r.p.value)} r={4.5} fill={SERIES[r.key]} stroke={c.surface} strokeWidth={1.5} /> : null)}
          {Array.from({ length: nLab }, (_, k) => t0 + (span * k) / (nLab - 1)).map((t, i) =>
            <SvgText key={`x${i}`} x={PAD_L + (i / (nLab - 1)) * plotW} y={CH_H - 5} fontSize={8} fill={c.textFaint} textAnchor="middle">{labelAt(t, months)}</SvgText>)}
        </Svg>
      </View>
    </View>
  );
}

export default function BiologyMode() {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const { width } = useWindowDimensions();
  const innerW = width - 32 - 24;
  const [range, setRange] = useState<Range>('6M');
  const [offset, setOffset] = useState(0);            // periods shifted back (0 = current)
  const [cursorTime, setCursorTime] = useState<number | null>(null);   // coupled cursor across all charts
  const [showEvents, setShowEvents] = useState(true);                  // privacy: hide all event markers when showing others
  const [rep, setRep] = useState<BiologyReport | null>(null);
  const [loading, setLoading] = useState(true);

  const months = RANGE_MONTHS[range];
  const spanMs = months * 30 * 86_400_000;
  const t1 = Date.now() - offset * spanMs;
  const t0 = t1 - spanMs;

  useEffect(() => { requestPermissions().catch(() => {}); }, []);
  useEffect(() => { setCursorTime(null); }, [range, offset]);
  // Load the FULL history once (metrics ~40y, fitness/CTL ~10y). range + offset are then a pure VIEWPORT
  // into the loaded data — so scrolling to any period (incl. >10 years back) shows its data instantly, no
  // per-step re-fetch. The spinner shows once, while that history is pulled from HealthKit.
  useEffect(() => {
    let alive = true; setLoading(true);
    computeBiologyReport(60)   // CTL/fitness overlay over 5y (covers full training history); metrics are full ~40y
      .then(r => { if (alive) { setRep(r); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const byKey = (k: string): BioMetric | undefined => rep?.metrics.find(m => m.key === k);
  const chartCards: { title: string; keys: string[] }[] = [
    { title: 'Weight', keys: ['weight'] },
    { title: 'Body fat %', keys: ['bodyfat'] },
    { title: 'Lean mass', keys: ['lean'] },
    { title: 'Blood pressure', keys: ['bpSys', 'bpDia'] },
  ];
  const comp = rep && rep.hasAnyData ? compositionChange(byKey('weight')?.points ?? [], byKey('bodyfat')?.points ?? [], t0, t1) : null;
  const compShow = comp && (Math.abs(comp.dFat) + Math.abs(comp.dLean)) >= 0.3;   // only when there's a real move
  const compFatW = comp ? Math.max(1, Math.abs(comp.dFat)) : 1;
  const compLeanW = comp ? Math.max(1, Math.abs(comp.dLean)) : 1;
  const leanShare = comp && (Math.abs(comp.dFat) + Math.abs(comp.dLean)) > 0 ? Math.abs(comp.dLean) / (Math.abs(comp.dFat) + Math.abs(comp.dLean)) : 0;
  const sgn = (n: number) => (n > 0 ? '+' : '') + n;

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ title: 'Biology' }} />
      {/* Sticky header — always visible regardless of scroll */}
      <View style={s.header}>
        <View style={s.headerTop}>
          <TouchableOpacity style={s.homeBtn} onPress={() => router.back()}><Text style={s.homeBtnTxt}>🏠  Home</Text></TouchableOpacity>
          <Text style={s.hTitle}>🧬 Biology</Text>
          <View style={{ flex: 1 }} />
          {loading && <ActivityIndicator size="small" color={c.accent} style={{ marginRight: 8 }} />}
          <TouchableOpacity style={[s.eyeBtn, !showEvents && s.eyeBtnOff]} onPress={() => setShowEvents(v => !v)}>
            <Text style={[s.eyeTxt, !showEvents && s.eyeTxtOff]}>{showEvents ? '👁 Events' : '🚫 Events'}</Text>
          </TouchableOpacity>
        </View>
        <View style={s.tabs}>{RANGES.map(r => (
          <TouchableOpacity key={r} onPress={() => setRange(r)} style={[s.tab, range === r && s.tabOn]}><Text style={[s.tabTxt, range === r && s.tabTxtOn]}>{r}</Text></TouchableOpacity>
        ))}</View>
        <View style={s.navRow}>
          <TouchableOpacity style={s.navBtn} onPress={() => setOffset(o => o + 1)}><Text style={s.navTxt}>◀ Prev</Text></TouchableOpacity>
          <Text style={s.navLabel}>{monthYear(t0)} – {monthYear(t1)}</Text>
          <TouchableOpacity style={[s.navBtn, offset === 0 && s.navBtnOff]} disabled={offset === 0} onPress={() => setOffset(o => Math.max(0, o - 1))}><Text style={[s.navTxt, offset === 0 && s.navTxtOff]}>Next ▶</Text></TouchableOpacity>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 12, paddingBottom: 48 }}>
        {loading && <View style={s.loadCard}><ActivityIndicator color={c.accent} /><Text style={s.loadCardTxt}>Loading your full history from Apple Health…</Text></View>}

        {!loading && rep && !rep.hasAnyData && (
          <View style={s.card}><Text style={s.cardTitle}>No body data yet</Text>
            <Text style={s.li}>Nothing in Apple Health for weight, body fat, lean mass or blood pressure in this range. Connect a smart scale / BP cuff (or log manually), grant access when prompted, then come back.</Text>
          </View>
        )}

        {!loading && rep && rep.hasAnyData && chartCards
          .filter(card => card.keys.some(k => (byKey(k)?.points.length ?? 0) > 0))
          .map(card => {
            const metrics = card.keys.map(byKey).filter(Boolean) as BioMetric[];
            const lines = metrics.filter(m => m.points.length > 0).map(m => ({ key: m.key, label: m.label, points: m.points }));
            return (
              <View key={card.title} style={s.card}>
                <View style={s.cardHead}>
                  <Text style={s.cardTitle}>{card.title}</Text>
                  {metrics.map(m => m.latest != null && (
                    <Text key={m.key} style={[s.latest, { color: SERIES[m.key] }]}>{m.latest}{m.unit === '%' ? '%' : ` ${m.unit}`}</Text>
                  ))}
                </View>
                <BioChart lines={lines} t0={t0} t1={t1} ctl={rep.ctl} events={showEvents ? rep.events : []} innerW={innerW} c={c} months={months} styles={s} cursorTime={cursorTime} onCursor={setCursorTime} />
              </View>
            );
          })}

        {/* Fat vs lean change — where weight + body-fat both exist. Relevant on GLP-1: is the loss fat or lean? */}
        {!loading && compShow && comp && (
          <View style={s.card}>
            <View style={s.cardHead}>
              <Text style={s.cardTitle}>Fat vs lean change</Text>
              <Text style={[s.latest, { color: comp.dW <= 0 ? SERIES.lean : c.textSub }]}>{sgn(comp.dW)} kg</Text>
            </View>
            <Text style={s.compSub}>{monthYear(comp.fromT)} → {monthYear(comp.toT)} · of your {sgn(comp.dW)} kg: <Text style={{ color: SERIES.bodyfat, fontWeight: '700' }}>fat {sgn(comp.dFat)} kg</Text>, <Text style={{ color: SERIES.lean, fontWeight: '700' }}>lean {sgn(comp.dLean)} kg</Text></Text>
            <View style={s.compRow}>
              <View style={s.compBar}>
                <View style={{ flex: compFatW, backgroundColor: SERIES.bodyfat }} />
                <View style={{ flex: compLeanW, backgroundColor: SERIES.lean }} />
              </View>
            </View>
            {comp.dW < -0.3 && comp.dLean < -0.2 && leanShare > 0.25 && (
              <Text style={s.compWarn}>⚠ {Math.round(leanShare * 100)}% of the loss is lean mass — on a GLP-1, protect it: ~1.6 g/kg protein + resistance work.</Text>
            )}
            {comp.dW < -0.3 && !(comp.dLean < -0.2 && leanShare > 0.25) && (
              <Text style={[s.compSub, { color: SERIES.lean }]}>Good — the loss is mostly fat, lean largely preserved.</Text>
            )}
            {comp.dW >= -0.3 && comp.dFat < -0.2 && comp.dLean > 0.2 && (
              <Text style={[s.compSub, { color: SERIES.lean }]}>Recomposition — fat down, lean up. Ideal.</Text>
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:    { flex: 1, backgroundColor: c.bg },
  header:    { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10, backgroundColor: c.bg, borderBottomWidth: 1, borderColor: c.border },
  headerTop: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 },
  homeBtn:   { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  homeBtnTxt:{ color: c.text, fontWeight: '600', fontSize: 14 },
  hTitle:    { color: c.text, fontSize: 18, fontWeight: '800' },
  tabs:      { flexDirection: 'row', gap: 6, marginBottom: 8 },
  tab:       { flex: 1, alignItems: 'center', paddingVertical: 6, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  tabOn:     { backgroundColor: c.accent, borderColor: c.accent },
  tabTxt:    { color: c.textSub, fontWeight: '600', fontSize: 13 },
  tabTxtOn:  { color: c.onAccent },
  navRow:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  navBtn:    { paddingVertical: 5, paddingHorizontal: 12, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  navBtnOff: { opacity: 0.4 },
  navTxt:    { color: c.text, fontWeight: '700', fontSize: 13 },
  navTxtOff: { color: c.textFaint },
  navLabel:  { color: c.textSub, fontSize: 12, fontWeight: '600' },
  card:      { backgroundColor: c.surface, borderRadius: 16, padding: 12, borderWidth: 1, borderColor: c.border, marginBottom: 12 },
  cardHead:  { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 2 },
  cardTitle: { color: c.text, fontSize: 15, fontWeight: '700' },
  latest:    { fontSize: 15, fontWeight: '800', marginLeft: 8 },
  li:        { color: c.textSub, fontSize: 13, lineHeight: 20 },
  readout:   { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, minHeight: 16, marginBottom: 2 },
  readDate:  { color: c.text, fontSize: 12, fontWeight: '700' },
  readVal:   { fontSize: 12, fontWeight: '700' },
  loadPill:  { flexDirection: 'row', alignItems: 'center', gap: 6 },
  loadTxt:   { color: c.textSub, fontSize: 12, fontWeight: '600' },
  loadCard:  { backgroundColor: c.surface, borderRadius: 16, padding: 20, borderWidth: 1, borderColor: c.border, alignItems: 'center', gap: 10, marginTop: 8 },
  loadCardTxt: { color: c.textSub, fontSize: 13, textAlign: 'center' },
  eyeBtn:    { paddingVertical: 5, paddingHorizontal: 10, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  eyeBtnOff: { borderColor: c.accent },
  eyeTxt:    { color: c.text, fontSize: 12, fontWeight: '600' },
  eyeTxtOff: { color: c.accent },
  compRow:   { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 },
  compBar:   { flex: 1, height: 16, borderRadius: 5, overflow: 'hidden', flexDirection: 'row', backgroundColor: c.surfaceAlt },
  compSub:   { color: c.textSub, fontSize: 12, lineHeight: 18, marginTop: 8 },
  compWarn:  { color: '#f59e0b', fontSize: 12, lineHeight: 18, marginTop: 6, fontWeight: '600' },
});
