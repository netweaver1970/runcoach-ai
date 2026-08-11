import React, { useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, useWindowDimensions, PanResponder } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import Svg, { Polyline, Line, Rect, Circle, Text as SvgText } from 'react-native-svg';
import { requestPermissions } from '../src/services/healthkit';
import { computeBiologyReport, BiologyReport, BioMetric, BioPoint } from '../src/services/biology';
import { useTheme, useThemedStyles, Palette } from '../src/theme';

type Range = '3M' | '6M' | '1Y' | '5Y' | '10Y';
const RANGES: Range[] = ['3M', '6M', '1Y', '5Y', '10Y'];
const RANGE_MONTHS: Record<Range, number> = { '3M': 3, '6M': 6, '1Y': 12, '5Y': 60, '10Y': 120 };
const CAT_COLOR: Record<string, string> = { medical: '#ef4444', life: '#10b981', travel: '#3b82f6', holiday: '#f59e0b', other: '#9ca3af' };
const CAT_ICON: Record<string, string> = { medical: '🩺', life: '🎉', travel: '✈️', holiday: '🏖️', other: '📌' };
const SERIES: Record<string, string> = { weight: '#3b82f6', bodyfat: '#f59e0b', lean: '#10b981', bpSys: '#ef4444', bpDia: '#8b5cf6' };

const CH_H = 190, PAD_L = 34, PAD_R = 10, PAD_T = 12, PAD_B = 22;
const shortDate = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

const isoOfDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const cursorDateLabel = (t: number, months: number) => {
  const d = new Date(t);
  return months > 12 ? d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
                     : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

// One chart: 1–2 metric lines (measured points, BOLD) + faint normalised CTL overlay + event verticals,
// with a scrub cursor whose readout shows each line's value at the cursor AND any event it lands on.
function BioChart({ lines, t0, t1, ctl, events, innerW, c, months, styles }: {
  lines: { key: string; label: string; points: BioPoint[] }[];
  t0: number; t1: number; ctl: BioPoint[];
  events: { date: string; endDate?: string; label: string; category: string }[];
  innerW: number; c: Palette; months: number; styles: any;
}) {
  const [cursorX, setCursorX] = useState<number | null>(null);
  const plotRef = useRef<View>(null);
  const plotLeft = useRef(0);
  const measure = () => plotRef.current?.measureInWindow((x) => { plotLeft.current = x; });
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > Math.abs(g.dy) && Math.abs(g.dx) > 3,
    onPanResponderGrant: (_e, g) => setCursorX(g.x0 - plotLeft.current),
    onPanResponderMove: (_e, g) => setCursorX(g.moveX - plotLeft.current),
    onPanResponderTerminationRequest: () => false,
  })).current;

  const plotW = Math.max(1, innerW - PAD_L - PAD_R);
  const plotH = CH_H - PAD_T - PAD_B;
  const span = Math.max(1, t1 - t0);
  // HealthKit readings carry full ISO timestamps; CTL/events are date-only 'YYYY-MM-DD'. Parse both.
  const tOf = (iso: string) => new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso).getTime();
  const inRange = (iso: string) => tOf(iso) >= t0 && tOf(iso) <= t1;
  const xOf = (iso: string) => PAD_L + Math.max(0, Math.min(1, (tOf(iso) - t0) / span)) * plotW;

  const vals = lines.flatMap(l => l.points.filter(p => inRange(p.date)).map(p => p.value)).filter(Number.isFinite);
  if (vals.length < 2) return <View style={{ height: CH_H, justifyContent: 'center', alignItems: 'center' }}><Text style={{ color: c.textFaint }}>Not enough data in this range.</Text></View>;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.12 || 1;
  const yLo = lo - pad, yHi = hi + pad;
  const yOf = (v: number) => PAD_T + (1 - (v - yLo) / (yHi - yLo)) * plotH;

  // CTL overlay normalised to its own min/max → a shape, not the metric's units.
  const cInR = ctl.filter(p => inRange(p.date));
  const cv = cInR.map(p => p.value).filter(Number.isFinite);
  const cLo = cv.length ? Math.min(...cv) : 0, cHi = cv.length ? Math.max(...cv) : 1;
  const yCtl = (v: number) => PAD_T + (1 - (v - cLo) / Math.max(1, cHi - cLo)) * plotH;
  const ctlPts = cInR.map(p => `${xOf(p.date).toFixed(1)},${yCtl(p.value).toFixed(1)}`).join(' ');

  // Alternating bands: monthly for ≤1Y, yearly for longer ranges.
  const yearly = months > 12;
  const bands: { x: number; w: number }[] = [];
  { const d = new Date(t0); if (yearly) { d.setMonth(0, 1); } else { d.setDate(1); } d.setHours(0, 0, 0, 0); let i = 0;
    while (d.getTime() <= t1) { const s = Math.max(t0, d.getTime()); const n = new Date(d); if (yearly) n.setFullYear(n.getFullYear() + 1); else n.setMonth(n.getMonth() + 1); const e = Math.min(t1, n.getTime());
      if (i % 2 === 0) bands.push({ x: PAD_L + ((s - t0) / span) * plotW, w: ((e - s) / span) * plotW });
      if (yearly) d.setFullYear(d.getFullYear() + 1); else d.setMonth(d.getMonth() + 1); i++; } }
  const bandFill = c.mode === 'dark' ? '#fff' : '#000';

  const yTicks = [yLo + (yHi - yLo) * 0.12, (yLo + yHi) / 2, yHi - (yHi - yLo) * 0.12];
  const nLab = 4;

  // ── Cursor: default to latest (right edge) so the readout is never empty. ──
  const scrubbing = cursorX != null;
  const cx = scrubbing ? Math.max(PAD_L, Math.min(PAD_L + plotW, cursorX!)) : PAD_L + plotW;
  const cursorT = t0 + ((cx - PAD_L) / plotW) * span;
  const nearestOf = (pts: BioPoint[]) => { let best: BioPoint | null = null, bd = Infinity; for (const p of pts) { if (!inRange(p.date)) continue; const d = Math.abs(tOf(p.date) - cursorT); if (d < bd) { bd = d; best = p; } } return best; };
  // Events whose span overlaps the window (a range event may start before t0 / end after t1).
  const evInR = events.filter(e => tOf(e.date) <= t1 && tOf(e.endDate ?? e.date) >= t0);
  const nearEv = evInR.map(e => {
    const xs = xOf(e.date), xe = e.endDate ? xOf(e.endDate) : xs;
    const loX = Math.min(xs, xe), hiX = Math.max(xs, xe);
    const dx = cx >= loX - 2 && cx <= hiX + 2 ? 0 : Math.min(Math.abs(cx - xs), Math.abs(cx - xe));   // inside a zone = hit
    return { e, dx };
  }).sort((a, b) => a.dx - b.dx)[0];
  const showEvent = nearEv && nearEv.dx < 16 ? nearEv.e : null;
  const sameEv = (a: { date: string; label: string }, b: { date: string; label: string }) => a.date === b.date && a.label === b.label;
  const readVals = lines.map(l => ({ key: l.key, label: l.label, p: nearestOf(l.points) }));

  return (
    <View>
      {/* Readout row (updates with the cursor) */}
      <View style={styles.readout}>
        <Text style={styles.readDate}>{cursorDateLabel(cursorT, months)}</Text>
        {readVals.map(r => (
          <Text key={r.key} style={[styles.readVal, { color: SERIES[r.key] }]}>{r.label} {r.p ? r.p.value : '—'}</Text>
        ))}
        {showEvent && <Text style={[styles.readVal, { color: CAT_COLOR[showEvent.category] ?? CAT_COLOR.other }]}>● {showEvent.label}</Text>}
      </View>
      <View ref={plotRef} onLayout={measure} {...pan.panHandlers}>
        <Svg width={innerW} height={CH_H}>
          {bands.map((b, i) => <Rect key={`b${i}`} x={b.x} y={PAD_T} width={b.w} height={plotH} fill={bandFill} opacity={0.04} />)}
          {yTicks.map((v, i) => <React.Fragment key={`y${i}`}>
            <Line x1={PAD_L} y1={yOf(v)} x2={PAD_L + plotW} y2={yOf(v)} stroke={c.gridline} strokeWidth={0.5} />
            <SvgText x={PAD_L - 4} y={yOf(v) + 3} fontSize={8} fill={c.textFaint} textAnchor="end">{Math.round(v * 10) / 10}</SvgText>
          </React.Fragment>)}
          {/* event verticals — the one under the cursor is drawn solid + bright */}
          {/* events: range events → shaded ZONE (start→end); point events → vertical line. Each gets a category ICON. */}
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
                <SvgText x={Math.max(PAD_L + 6, Math.min(PAD_L + plotW - 6, x + w / 2))} y={PAD_T + 9} fontSize={11} textAnchor="middle">{icon}</SvgText>
              </React.Fragment>;
            }
            return <React.Fragment key={`e${i}`}>
              <Line x1={xs} y1={PAD_T + 6} x2={xs} y2={PAD_T + plotH} stroke={col} strokeWidth={on ? 2 : 1} strokeDasharray={on ? undefined : '2,3'} opacity={on ? 0.95 : 0.55} />
              <SvgText x={Math.max(PAD_L + 5, Math.min(PAD_L + plotW - 5, xs))} y={PAD_T + 3} fontSize={11} textAnchor="middle">{icon}</SvgText>
            </React.Fragment>;
          })}
          {/* CTL overlay — slightly accentuated */}
          {ctlPts && <Polyline points={ctlPts} fill="none" stroke={c.textSub} strokeWidth={1.8} opacity={0.8} strokeDasharray="6,3" />}
          {/* metric lines + dots (BOLD) */}
          {lines.map(l => {
            const pts = l.points.filter(p => inRange(p.date));
            const poly = pts.map(p => `${xOf(p.date).toFixed(1)},${yOf(p.value).toFixed(1)}`).join(' ');
            return <React.Fragment key={l.key}>
              {pts.length > 1 && <Polyline points={poly} fill="none" stroke={SERIES[l.key]} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />}
              {pts.map((p, i) => <Circle key={i} cx={xOf(p.date)} cy={yOf(p.value)} r={pts.length > 60 ? 1.6 : 2.6} fill={SERIES[l.key]} />)}
            </React.Fragment>;
          })}
          {/* cursor + highlighted nearest points */}
          <Line x1={cx} y1={PAD_T} x2={cx} y2={PAD_T + plotH} stroke={c.textSub} strokeWidth={1} opacity={scrubbing ? 0.8 : 0.35} />
          {readVals.map(r => r.p && inRange(r.p.date) ? <Circle key={`c${r.key}`} cx={xOf(r.p.date)} cy={yOf(r.p.value)} r={4.5} fill={SERIES[r.key]} stroke={c.surface} strokeWidth={1.5} /> : null)}
          {Array.from({ length: nLab }, (_, k) => new Date(t0 + (span * k) / (nLab - 1))).map((d, i) =>
            <SvgText key={`x${i}`} x={PAD_L + (i / (nLab - 1)) * plotW} y={CH_H - 6} fontSize={8} fill={c.textFaint} textAnchor="middle">{cursorDateLabel(d.getTime(), months)}</SvgText>)}
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
  const innerW = width - 32 - 24; // screen padding + card padding
  const [range, setRange] = useState<Range>('6M');
  const [rep, setRep] = useState<BiologyReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { requestPermissions().catch(() => {}); }, []);
  useEffect(() => {
    let alive = true; setLoading(true);
    computeBiologyReport(RANGE_MONTHS[range]).then(r => { if (alive) { setRep(r); setLoading(false); } }).catch(() => { if (alive) { setRep(null); setLoading(false); } });
    return () => { alive = false; };
  }, [range]);

  const months = RANGE_MONTHS[range];
  const t1 = Date.now();
  const t0 = t1 - months * 30 * 86_400_000;
  const byKey = (k: string): BioMetric | undefined => rep?.metrics.find(m => m.key === k);
  const chartCards: { title: string; keys: string[] }[] = [
    { title: 'Weight', keys: ['weight'] },
    { title: 'Body fat %', keys: ['bodyfat'] },
    { title: 'Lean mass', keys: ['lean'] },
    { title: 'Blood pressure', keys: ['bpSys', 'bpDia'] },
  ];

  return (
    <ScrollView style={s.screen} contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
      <Stack.Screen options={{ title: 'Biology' }} />
      <TouchableOpacity style={s.homeBtn} onPress={() => router.back()}><Text style={s.homeBtnTxt}>🏠  Home</Text></TouchableOpacity>
      <Text style={s.h1}>🧬 Biology</Text>
      <Text style={s.sub}>Body composition & blood pressure from Apple Health, correlated with your training and timeline. The dashed grey line is your <Text style={s.bold}>fitness (CTL)</Text>; dashed verticals mark <Text style={{ color: CAT_COLOR.medical }}>medical</Text> / <Text style={{ color: CAT_COLOR.life }}>life</Text> events.</Text>

      <View style={s.tabs}>{RANGES.map(r => (
        <TouchableOpacity key={r} onPress={() => setRange(r)} style={[s.tab, range === r && s.tabOn]}><Text style={[s.tabTxt, range === r && s.tabTxtOn]}>{r}</Text></TouchableOpacity>
      ))}</View>

      {loading && <ActivityIndicator style={{ marginTop: 40 }} color={c.accent} />}

      {!loading && rep && !rep.hasAnyData && (
        <View style={s.card}><Text style={s.cardTitle}>No body data yet</Text>
          <Text style={s.li}>Nothing found in Apple Health for weight, body fat, lean mass or blood pressure in this range. Connect a smart scale / BP cuff (or log manually in the Health app), grant access when prompted, then pull back here.</Text>
        </View>
      )}

      {!loading && rep && rep.hasAnyData && chartCards
        .filter(card => card.keys.some(k => (byKey(k)?.points.length ?? 0) > 0))   // only plot metrics that actually have valid readings
        .map(card => {
        const metrics = card.keys.map(byKey).filter(Boolean) as BioMetric[];
        const lines = metrics.filter(m => m.points.length > 0).map(m => ({ key: m.key, label: m.label, points: m.points }));
        const anyData = lines.length > 0;
        const primary = metrics[0];
        return (
          <View key={card.title} style={s.card}>
            <View style={s.cardHead}>
              <Text style={s.cardTitle}>{card.title}</Text>
              {anyData && metrics.map(m => m.latest != null && (
                <Text key={m.key} style={[s.latest, { color: SERIES[m.key] }]}>{m.latest}{m.unit === '%' ? '%' : ` ${m.unit}`}</Text>
              ))}
            </View>
            {!anyData
              ? <Text style={s.li}>No data in this range.</Text>
              : <>
                  <BioChart lines={lines} t0={t0} t1={t1} ctl={rep.ctl} events={rep.events} innerW={innerW} c={c} months={months} styles={s} />
                  <Text style={s.scrubHint}>Drag across the chart to scrub · dots = readings, dashed grey = fitness (CTL)</Text>
                  {metrics.map(m => m.trendPerWeek != null && (
                    <Text key={m.key} style={s.trend}>
                      {m.label}: {m.trendDir === 'flat' ? 'flat' : `${m.trendPerWeek > 0 ? '↑' : '↓'} ${Math.abs(m.trendPerWeek)} ${m.unit}/wk`} · {m.n} readings
                    </Text>
                  ))}
                  {primary?.correlations.filter(cr => cr.significant).map((cr, i) => (
                    <Text key={i} style={s.corr}>📈 {cr.note}</Text>
                  ))}
                </>}
          </View>
        );
      })}

      {!loading && rep && rep.eventImpacts.length > 0 && (
        <View style={s.card}>
          <Text style={s.cardTitle}>Around your events (±21 days)</Text>
          <Text style={s.liFaint}>Mean before vs after each medical / life event. Descriptive only — overlapping events & training confound these.</Text>
          {rep.eventImpacts.map((ei, i) => (
            <View key={i} style={s.evt}>
              <Text style={s.evtTitle}><Text style={{ color: CAT_COLOR[ei.category] ?? CAT_COLOR.other }}>●</Text> {ei.label} · {shortDate(ei.date)}</Text>
              {ei.effects.filter(e => e.delta != null).map((e, j) => (
                <Text key={j} style={s.evtRow}>{e.label}: {e.before} → {e.after} {e.unit} ({e.delta! > 0 ? '+' : ''}{e.delta})</Text>
              ))}
            </View>
          ))}
        </View>
      )}

      {!loading && rep && rep.hasAnyData && (
        <Text style={s.method}>
          Method: Spearman rank correlation over days where both series are fresh (sparse metrics forward-filled with a staleness cap), best-lag scan ±21d, flagged only when significant (|t|&gt;2, n≥8). Trends are OLS slope. Associations are not proof of cause — concurrent timeline events (e.g. medication) are confounders.
        </Text>
      )}
    </ScrollView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:    { flex: 1, backgroundColor: c.bg },
  homeBtn:   { alignSelf: 'flex-start', paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border, marginBottom: 14 },
  homeBtnTxt:{ color: c.text, fontWeight: '600', fontSize: 14 },
  h1:        { color: c.text, fontSize: 24, fontWeight: '800', marginBottom: 6 },
  sub:       { color: c.textSub, fontSize: 13, lineHeight: 19, marginBottom: 14 },
  bold:      { color: c.text, fontWeight: '700' },
  tabs:      { flexDirection: 'row', gap: 6, marginBottom: 14 },
  tab:       { flex: 1, alignItems: 'center', paddingVertical: 6, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  tabOn:     { backgroundColor: c.accent, borderColor: c.accent },
  tabTxt:    { color: c.textSub, fontWeight: '600', fontSize: 13 },
  tabTxtOn:  { color: c.onAccent },
  readout:   { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, minHeight: 18, marginBottom: 2 },
  readDate:  { color: c.text, fontSize: 12, fontWeight: '700' },
  readVal:   { fontSize: 12, fontWeight: '700' },
  scrubHint: { color: c.textFaint, fontSize: 11, marginTop: 4 },
  card:      { backgroundColor: c.surface, borderRadius: 16, padding: 12, borderWidth: 1, borderColor: c.border, marginBottom: 14 },
  cardHead:  { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 },
  cardTitle: { color: c.text, fontSize: 15, fontWeight: '700' },
  latest:    { fontSize: 15, fontWeight: '800', marginLeft: 8 },
  trend:     { color: c.textSub, fontSize: 12, marginTop: 6 },
  corr:      { color: c.textSub, fontSize: 12, lineHeight: 18, marginTop: 6 },
  li:        { color: c.textSub, fontSize: 13, lineHeight: 20 },
  liFaint:   { color: c.textFaint, fontSize: 12, lineHeight: 17, marginBottom: 8 },
  evt:       { marginTop: 10 },
  evtTitle:  { color: c.text, fontSize: 13, fontWeight: '600' },
  evtRow:    { color: c.textSub, fontSize: 12, lineHeight: 18, marginLeft: 12 },
  method:    { color: c.textFaint, fontSize: 11, lineHeight: 16, marginTop: 4 },
});
