import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, useWindowDimensions } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import Svg, { Polyline, Line, Rect, Circle, Text as SvgText } from 'react-native-svg';
import { requestPermissions } from '../src/services/healthkit';
import { computeBiologyReport, BiologyReport, BioMetric, BioPoint } from '../src/services/biology';
import { useTheme, useThemedStyles, Palette } from '../src/theme';

type Range = '3M' | '6M' | '1Y';
const RANGE_MONTHS: Record<Range, number> = { '3M': 3, '6M': 6, '1Y': 12 };
const CAT_COLOR: Record<string, string> = { medical: '#ef4444', life: '#10b981', travel: '#3b82f6', holiday: '#f59e0b', other: '#9ca3af' };
const SERIES: Record<string, string> = { weight: '#3b82f6', bodyfat: '#f59e0b', lean: '#10b981', bpSys: '#ef4444', bpDia: '#8b5cf6' };

const CH_H = 190, PAD_L = 34, PAD_R = 10, PAD_T = 12, PAD_B = 22;
const shortDate = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

// One chart: 1–2 metric lines (measured points) + faint normalised CTL overlay + event verticals.
function BioChart({ lines, t0, t1, ctl, events, innerW, c }: {
  lines: { key: string; label: string; points: BioPoint[] }[];
  t0: number; t1: number; ctl: BioPoint[];
  events: { date: string; label: string; category: string }[];
  innerW: number; c: Palette;
}) {
  const plotW = Math.max(1, innerW - PAD_L - PAD_R);
  const plotH = CH_H - PAD_T - PAD_B;
  const span = Math.max(1, t1 - t0);
  const tOf = (iso: string) => new Date(iso + 'T00:00:00').getTime();
  const xOf = (iso: string) => PAD_L + Math.max(0, Math.min(1, (tOf(iso) - t0) / span)) * plotW;

  const vals = lines.flatMap(l => l.points.map(p => p.value)).filter(Number.isFinite);
  if (vals.length < 2) return <View style={{ height: CH_H, justifyContent: 'center', alignItems: 'center' }}><Text style={{ color: c.textFaint }}>Not enough data in this range.</Text></View>;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.12 || 1;
  const yLo = lo - pad, yHi = hi + pad;
  const yOf = (v: number) => PAD_T + (1 - (v - yLo) / (yHi - yLo)) * plotH;

  // CTL overlay normalised to its own min/max → a shape, not the metric's units.
  const cv = ctl.map(p => p.value).filter(Number.isFinite);
  const cLo = cv.length ? Math.min(...cv) : 0, cHi = cv.length ? Math.max(...cv) : 1;
  const yCtl = (v: number) => PAD_T + (1 - (v - cLo) / Math.max(1, cHi - cLo)) * plotH;
  const ctlPts = ctl.filter(p => tOf(p.date) >= t0 && tOf(p.date) <= t1).map(p => `${xOf(p.date).toFixed(1)},${yCtl(p.value).toFixed(1)}`).join(' ');

  // Alternating month bands.
  const bands: { x: number; w: number }[] = [];
  { const d = new Date(t0); d.setDate(1); let i = 0;
    while (d.getTime() <= t1) { const s = Math.max(t0, d.getTime()); const n = new Date(d); n.setMonth(n.getMonth() + 1); const e = Math.min(t1, n.getTime());
      if (i % 2 === 0) { const x = PAD_L + ((s - t0) / span) * plotW; bands.push({ x, w: ((e - s) / span) * plotW }); } d.setMonth(d.getMonth() + 1); i++; } }
  const bandFill = c.mode === 'dark' ? '#fff' : '#000';

  const yTicks = [yLo + (yHi - yLo) * 0.15, (yLo + yHi) / 2, yHi - (yHi - yLo) * 0.15];
  const nLab = 4;
  const labs = Array.from({ length: nLab }, (_, k) => new Date(t0 + (span * k) / (nLab - 1)));
  const isoOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  return (
    <Svg width={innerW} height={CH_H}>
      {bands.map((b, i) => <Rect key={`b${i}`} x={b.x} y={PAD_T} width={b.w} height={plotH} fill={bandFill} opacity={0.04} />)}
      {yTicks.map((v, i) => <React.Fragment key={`y${i}`}>
        <Line x1={PAD_L} y1={yOf(v)} x2={PAD_L + plotW} y2={yOf(v)} stroke={c.gridline} strokeWidth={0.5} />
        <SvgText x={PAD_L - 4} y={yOf(v) + 3} fontSize={8} fill={c.textFaint} textAnchor="end">{Math.round(v * 10) / 10}</SvgText>
      </React.Fragment>)}
      {/* event verticals */}
      {events.filter(e => tOf(e.date) >= t0 && tOf(e.date) <= t1).map((e, i) =>
        <Line key={`e${i}`} x1={xOf(e.date)} y1={PAD_T} x2={xOf(e.date)} y2={PAD_T + plotH} stroke={CAT_COLOR[e.category] ?? CAT_COLOR.other} strokeWidth={1} strokeDasharray="2,3" opacity={0.7} />)}
      {/* CTL overlay */}
      {ctlPts && <Polyline points={ctlPts} fill="none" stroke={c.textFaint} strokeWidth={1} opacity={0.5} strokeDasharray="4,3" />}
      {/* metric lines + dots */}
      {lines.map(l => {
        const pts = l.points.filter(p => tOf(p.date) >= t0 && tOf(p.date) <= t1);
        const poly = pts.map(p => `${xOf(p.date).toFixed(1)},${yOf(p.value).toFixed(1)}`).join(' ');
        return <React.Fragment key={l.key}>
          {pts.length > 1 && <Polyline points={poly} fill="none" stroke={SERIES[l.key]} strokeWidth={2} />}
          {pts.map((p, i) => <Circle key={i} cx={xOf(p.date)} cy={yOf(p.value)} r={2.2} fill={SERIES[l.key]} />)}
        </React.Fragment>;
      })}
      {labs.map((d, i) => <SvgText key={`x${i}`} x={PAD_L + (span * i) / (nLab - 1) / span * plotW} y={CH_H - 6} fontSize={8} fill={c.textFaint} textAnchor="middle">{shortDate(isoOf(d))}</SvgText>)}
    </Svg>
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

      <View style={s.tabs}>{(['3M', '6M', '1Y'] as Range[]).map(r => (
        <TouchableOpacity key={r} onPress={() => setRange(r)} style={[s.tab, range === r && s.tabOn]}><Text style={[s.tabTxt, range === r && s.tabTxtOn]}>{r}</Text></TouchableOpacity>
      ))}</View>

      {loading && <ActivityIndicator style={{ marginTop: 40 }} color={c.accent} />}

      {!loading && rep && !rep.hasAnyData && (
        <View style={s.card}><Text style={s.cardTitle}>No body data yet</Text>
          <Text style={s.li}>Nothing found in Apple Health for weight, body fat, lean mass or blood pressure in this range. Connect a smart scale / BP cuff (or log manually in the Health app), grant access when prompted, then pull back here.</Text>
        </View>
      )}

      {!loading && rep && rep.hasAnyData && chartCards.map(card => {
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
                  <BioChart lines={lines} t0={t0} t1={t1} ctl={rep.ctl} events={rep.events} innerW={innerW} c={c} />
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
  tabs:      { flexDirection: 'row', gap: 8, marginBottom: 14 },
  tab:       { paddingVertical: 6, paddingHorizontal: 18, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  tabOn:     { backgroundColor: c.accent, borderColor: c.accent },
  tabTxt:    { color: c.textSub, fontWeight: '600', fontSize: 13 },
  tabTxtOn:  { color: c.onAccent },
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
