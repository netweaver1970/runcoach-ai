import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator, useWindowDimensions, PanResponder } from 'react-native';
import { Stack } from 'expo-router';
import Svg, { Polyline, Line, Text as SvgText } from 'react-native-svg';
import { loadSnapshotCache } from '../src/services/healthkit';
import { computePerformanceIndex, GpiPoint, GpiResult } from '../src/services/performanceIndex';
import { useTheme, useThemedStyles, Palette } from '../src/theme';

type Period = '1M' | '3M' | '6M' | '1Y';
const PERIOD_DAYS: Record<Period, number> = { '1M': 30, '3M': 91, '6M': 182, '1Y': 365 };

const GPI_COLOR = '#6366f1';       // indigo — the composite line
const REC_COLOR = '#22c55e';       // recovery
const SLP_COLOR = '#8b5cf6';       // sleep
const TRN_COLOR = '#f97316';       // training

const levelWord = (v: number) => v >= 62 ? 'climbing' : v >= 54 ? 'improving' : v >= 46 ? 'holding steady' : v >= 38 ? 'slipping' : 'declining';

// ─── Chart ────────────────────────────────────────────────────────────────────
const CH_H = 200, PAD_L = 26, PAD_R = 8, PAD_T = 10, PAD_B = 20;
const shortDate = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const longDate  = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

function GpiChart({ points, innerW, showPillars, c, styles }: { points: GpiPoint[]; innerW: number; showPillars: boolean; c: Palette; styles: any }) {
  const [cursorX, setCursorX] = useState<number | null>(null);
  const plotRef  = useRef<View>(null);
  const plotLeft = useRef(0);
  const measure  = () => plotRef.current?.measureInWindow((x) => { plotLeft.current = x; });

  const plotW = Math.max(1, innerW - PAD_L - PAD_R);
  const plotH = CH_H - PAD_T - PAD_B;

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => false,                                   // let vertical page scroll start on the chart
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > Math.abs(g.dy) && Math.abs(g.dx) > 3,  // capture only a horizontal scrub
    onPanResponderGrant: (_e, g) => setCursorX(g.x0 - plotLeft.current),
    onPanResponderMove:  (_e, g) => setCursorX(g.moveX - plotLeft.current),
    onPanResponderTerminationRequest: () => false,
  })).current;

  const vals = points.map(p => p.gpi).filter((v): v is number => v != null);
  if (vals.length < 2) return <View style={{ height: CH_H, justifyContent: 'center', alignItems: 'center' }}><Text style={{ color: c.textFaint }}>Not enough data yet for this range.</Text></View>;

  // Y-scale fits ALL visible series — so pillar lines (which spread wider than the GPI average) fit when shown.
  const scaleVals = showPillars
    ? points.flatMap(p => [p.gpi, p.recovery, p.sleep, p.training]).filter((v): v is number => v != null)
    : vals;
  const lo = Math.min(45, Math.floor(Math.min(...scaleVals) - 3));
  const hi = Math.max(55, Math.ceil(Math.max(...scaleVals) + 3));
  const xOf = (i: number) => PAD_L + (points.length <= 1 ? 0 : (i / (points.length - 1)) * plotW);
  const yOf = (v: number) => PAD_T + (1 - (v - lo) / (hi - lo)) * plotH;

  const line = (key: 'gpi' | 'recovery' | 'sleep' | 'training') =>
    points.map((p, i) => (p[key] == null ? null : `${xOf(i).toFixed(1)},${yOf(p[key]!).toFixed(1)}`)).filter(Boolean).join(' ');

  // Cursor → nearest index; default to the LATEST point so the readout is never empty (shows today).
  const scrubbing = cursorX != null;
  const cursorIdx = !scrubbing ? points.length - 1
    : Math.max(0, Math.min(points.length - 1, Math.round(((cursorX! - PAD_L) / plotW) * (points.length - 1))));
  const cur = points[cursorIdx];

  // X-axis: ~4 evenly-spaced date labels.
  const nLab = Math.min(4, points.length);
  const labelIdx = Array.from({ length: nLab }, (_, k) => Math.round((k / (nLab - 1 || 1)) * (points.length - 1)));
  const pillars = [['recovery', REC_COLOR], ['sleep', SLP_COLOR], ['training', TRN_COLOR]] as const;

  return (
    <View>
      {/* Live readout (cursor point, or latest when not scrubbing) */}
      <View style={styles.readout}>
        <Text style={styles.readoutDate}>{longDate(cur.date)}</Text>
        <View style={{ flexDirection: 'row', gap: 12, marginTop: 2, flexWrap: 'wrap' }}>
          <Text style={[styles.readoutVal, { color: GPI_COLOR }]}>GPI {cur.gpi == null ? '—' : Math.round(cur.gpi)}</Text>
          {showPillars && pillars.map(([k, col]) => (
            <Text key={k} style={[styles.readoutVal, { color: col }]}>{k[0].toUpperCase()} {cur[k] == null ? '—' : Math.round(cur[k]!)}</Text>
          ))}
        </View>
      </View>

      <View ref={plotRef} onLayout={measure} {...pan.panHandlers}>
        <Svg width={innerW} height={CH_H}>
          {[lo, 50, hi].map((t, i) => (
            <React.Fragment key={i}>
              <Line x1={PAD_L} y1={yOf(t)} x2={innerW - PAD_R} y2={yOf(t)} stroke={t === 50 ? c.textSub : c.border} strokeWidth={t === 50 ? 1 : 0.5} strokeDasharray={t === 50 ? '4 3' : undefined} opacity={t === 50 ? 0.7 : 0.5} />
              <SvgText x={PAD_L - 4} y={yOf(t) + 3} fontSize={9} fill={c.textFaint} textAnchor="end">{t}</SvgText>
            </React.Fragment>
          ))}
          {/* X-axis date labels */}
          {labelIdx.map((idx, k) => (
            <SvgText key={`x${k}`} x={Math.min(innerW - PAD_R, Math.max(PAD_L, xOf(idx)))} y={CH_H - 5} fontSize={9} fill={c.textFaint} textAnchor={k === 0 ? 'start' : k === labelIdx.length - 1 ? 'end' : 'middle'}>{shortDate(points[idx].date)}</SvgText>
          ))}
          {showPillars && pillars.map(([k, col]) => (
            <Polyline key={k} points={line(k)} fill="none" stroke={col} strokeWidth={1} opacity={0.5} />
          ))}
          <Polyline points={line('gpi')} fill="none" stroke={GPI_COLOR} strokeWidth={2.5} strokeLinejoin="round" />
          {/* Cursor line + dots */}
          {scrubbing && (
            <>
              <Line x1={xOf(cursorIdx)} y1={PAD_T} x2={xOf(cursorIdx)} y2={PAD_T + plotH} stroke={c.textSub} strokeWidth={1} opacity={0.6} />
              {showPillars && pillars.map(([k, col]) => cur[k] == null ? null : (
                <Line key={`d${k}`} x1={xOf(cursorIdx) - 0.01} y1={yOf(cur[k]!)} x2={xOf(cursorIdx) + 0.01} y2={yOf(cur[k]!)} stroke={col} strokeWidth={5} strokeLinecap="round" />
              ))}
              {cur.gpi != null && <Line x1={xOf(cursorIdx) - 0.01} y1={yOf(cur.gpi)} x2={xOf(cursorIdx) + 0.01} y2={yOf(cur.gpi)} stroke={GPI_COLOR} strokeWidth={7} strokeLinecap="round" />}
            </>
          )}
        </Svg>
      </View>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────
export default function PerformanceScreen() {
  const { c } = useTheme();
  const s = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  const innerW = width - 32;

  const [result, setResult]   = useState<GpiResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod]   = useState<Period>('3M');
  const [showPillars, setShowPillars] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const snap = await loadSnapshotCache();
        // Always compute the full 12-month span so the fixed baseline is stable across period views.
        const res = await computePerformanceIndex(12, undefined, snap?.runs ?? []);
        setResult(res);
      } catch { setResult({ series: [], baselineDays: 0, enoughData: false }); }
      finally { setLoading(false); }
    })();
  }, []);

  const view = useMemo(() => {
    const all = result?.series ?? [];
    const slice = all.slice(-PERIOD_DAYS[period]);
    const withGpi = slice.filter(p => p.gpi != null);
    const latest = [...all].reverse().find(p => p.gpi != null) ?? null;
    const first = withGpi[0] ?? null;
    const delta = latest && first && latest.gpi != null && first.gpi != null ? latest.gpi - first.gpi : null;
    return { slice, latest, delta };
  }, [result, period]);

  const cur = view.latest;

  return (
    <ScrollView style={s.container} contentContainerStyle={{ padding: 16 }}>
      <Stack.Screen options={{ title: 'Performance' }} />

      <Text style={s.intro}>
        One line for your overall trajectory — recovery, sleep and training folded together and measured
        against your own baseline. <Text style={{ fontWeight: '700' }}>50 = your starting point</Text>; above 50 means you've improved since then.
      </Text>

      {loading ? (
        <View style={{ paddingVertical: 60, alignItems: 'center' }}><ActivityIndicator color={c.accent} /><Text style={{ color: c.textFaint, marginTop: 8 }}>Crunching ~12 months…</Text></View>
      ) : !cur ? (
        <Text style={s.empty}>Not enough history yet. Wear the watch overnight and log a few runs, then check back.</Text>
      ) : (
        <>
          {/* Headline */}
          <View style={s.card}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
              <View>
                <Text style={[s.big, { color: GPI_COLOR }]}>{Math.round(cur.gpi!)}</Text>
                <Text style={s.bigSub}>General Performance · {levelWord(cur.gpi!)}</Text>
              </View>
              {view.delta != null && (
                <Text style={[s.delta, { color: view.delta >= 0 ? REC_COLOR : '#ef4444' }]}>
                  {view.delta >= 0 ? '▲' : '▼'} {Math.abs(view.delta).toFixed(1)} <Text style={s.deltaSub}>over {period}</Text>
                </Text>
              )}
            </View>
            <View style={s.pillarRow}>
              {([['Recovery', cur.recovery, REC_COLOR], ['Sleep', cur.sleep, SLP_COLOR], ['Training', cur.training, TRN_COLOR]] as const).map(([lbl, v, col]) => (
                <View key={lbl} style={s.pillar}>
                  <Text style={[s.pillarVal, { color: col }]}>{v == null ? '—' : Math.round(v)}</Text>
                  <Text style={s.pillarLbl}>{lbl}</Text>
                </View>
              ))}
            </View>
          </View>

          {/* Period tabs */}
          <View style={s.periodRow}>
            {(['1M', '3M', '6M', '1Y'] as Period[]).map(p => (
              <TouchableOpacity key={p} style={[s.periodBtn, period === p && { backgroundColor: GPI_COLOR, borderColor: GPI_COLOR }]} onPress={() => setPeriod(p)}>
                <Text style={[s.periodTxt, period === p && { color: '#fff' }]}>{p}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={s.card}>
            <GpiChart points={view.slice} innerW={innerW - 24} showPillars={showPillars} c={c} styles={s} />
            <TouchableOpacity style={s.toggle} onPress={() => setShowPillars(v => !v)}>
              <Text style={s.toggleTxt}>{showPillars ? '✓ Pillar lines' : '＋ Show pillar lines'}</Text>
            </TouchableOpacity>
          </View>

          {!result?.enoughData && (
            <Text style={s.note}>⚠️ Your baseline is still thin ({result?.baselineDays ?? 0} days), so the level is approximate — the shape of the trend is already meaningful, the exact number firms up as history builds.</Text>
          )}
          <Text style={s.note}>
            Recovery = HRV + resting-HR trend · Sleep = sleep score · Training = 60% fitness (CTL) + 40% efficiency (economy).
            Each is a 7-day average vs your first ~8 weeks; missing workouts or watch-off nights don't dent it.
          </Text>
        </>
      )}
    </ScrollView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  intro:     { fontSize: 13, color: c.textSub, lineHeight: 19, marginBottom: 14 },
  empty:     { fontSize: 14, color: c.textSub, textAlign: 'center', paddingVertical: 40, lineHeight: 20 },
  card:      { backgroundColor: c.surface, borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: c.border },
  big:       { fontSize: 44, fontWeight: '800', lineHeight: 48 },
  bigSub:    { fontSize: 13, color: c.textSub, marginTop: 2 },
  delta:     { fontSize: 15, fontWeight: '700' },
  deltaSub:  { fontSize: 11, color: c.textFaint, fontWeight: '500' },
  pillarRow: { flexDirection: 'row', marginTop: 14, gap: 8 },
  pillar:    { flex: 1, alignItems: 'center', paddingVertical: 8, backgroundColor: c.surfaceAlt, borderRadius: 10 },
  pillarVal: { fontSize: 20, fontWeight: '700' },
  pillarLbl: { fontSize: 11, color: c.textSub, marginTop: 2 },
  periodRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  periodBtn: { flex: 1, paddingVertical: 7, borderRadius: 8, alignItems: 'center', backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  periodTxt: { fontSize: 13, fontWeight: '600', color: c.textSub },
  toggle:    { alignSelf: 'center', marginTop: 6, paddingVertical: 4, paddingHorizontal: 12 },
  toggleTxt: { fontSize: 12, color: c.accent, fontWeight: '600' },
  readout:    { marginBottom: 4, minHeight: 34 },
  readoutDate:{ fontSize: 12, color: c.textSub, fontWeight: '600' },
  readoutVal: { fontSize: 13, fontWeight: '700' },
  note:      { fontSize: 11, color: c.textFaint, lineHeight: 16, marginTop: 8 },
});
