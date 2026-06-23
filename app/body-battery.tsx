import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, SafeAreaView, TouchableOpacity, StyleSheet, ActivityIndicator, RefreshControl, Dimensions } from 'react-native';
import { useRouter } from 'expo-router';
import Svg, { Path, Rect, Line, Circle, Text as SvgText, Defs, LinearGradient, Stop } from 'react-native-svg';
import * as Clipboard from 'expo-clipboard';
import { useThemedStyles, useTheme, Palette } from '../src/theme';
import { computeBodyBattery, BodyBattery, BatteryPoint } from '../src/services/bodyBattery';

const levelColor = (v: number) => (v >= 60 ? '#22C55E' : v >= 30 ? '#F59E0B' : '#EF4444');
const stressColor = (v: number) => (v >= 70 ? '#EF4444' : v >= 40 ? '#F59E0B' : '#22C55E');

// A data gap wider than this (no HR — watch off / charging) breaks the line into a hole,
// instead of papering over it with a straight segment.
const GAP_MS = 25 * 60_000;
function splitRuns<T extends { t: number }>(pts: T[]): T[][] {
  const runs: T[][] = [];
  for (let i = 0; i < pts.length; i++) {
    if (i === 0 || pts[i].t - pts[i - 1].t > GAP_MS) runs.push([]);
    runs[runs.length - 1].push(pts[i]);
  }
  return runs;
}

// Catmull-Rom → cubic-Bézier: a smooth curve through the points (no overshoot artefacts),
// so the 10-min samples read as a flowing line like Bevel instead of a jagged polyline.
function smoothPath(cs: { x: number; y: number }[]): string {
  if (cs.length < 2) return cs.length ? `M${cs[0].x.toFixed(1)},${cs[0].y.toFixed(1)}` : '';
  let d = `M${cs[0].x.toFixed(1)},${cs[0].y.toFixed(1)}`;
  for (let i = 0; i < cs.length - 1; i++) {
    const p0 = cs[i - 1] ?? cs[i], p1 = cs[i], p2 = cs[i + 1], p3 = cs[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

export default function BodyBatteryScreen() {
  const router = useRouter();
  const s = useThemedStyles(makeStyles);
  const [data, setData] = useState<BodyBattery | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback((isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    computeBodyBattery()
      .then(setData)
      .catch(() => {})
      .finally(() => { setLoading(false); setRefreshing(false); });
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={{ paddingHorizontal: 4 }}>
          <Text style={s.back}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={s.title}>Body Battery</Text>
        <View style={{ width: 50 }} />
      </View>

      <ScrollView contentContainerStyle={s.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} />}>
        {loading ? (
          <View style={s.center}><ActivityIndicator /><Text style={s.sub}>Reading heart rate + HRV…</Text></View>
        ) : !data ? (
          <View style={s.center}><Text style={s.sub}>Not enough heart-rate data yet today.</Text></View>
        ) : (
          <>
            <View style={s.hero}>
              <Text style={[s.big, { color: levelColor(data.current) }]}>{data.current}<Text style={s.pct}>%</Text></Text>
              <Text style={s.heroSub}>
                {data.trendPerHour >= 0 ? '▲ charging' : '▼ draining'} {Math.abs(data.trendPerHour)}/h
                {'   ·   '}stress <Text style={{ color: stressColor(data.currentStress), fontWeight: '800' }}>{data.currentStress}</Text>
              </Text>
            </View>

            <View style={s.chargeRow}>
              <View style={s.chargeCard}>
                <Text style={[s.chargeVal, { color: '#22C55E' }]}>+{data.totalCharged}%</Text>
                <Text style={s.chargeLbl}>Total Charged</Text>
              </View>
              <View style={s.chargeCard}>
                <Text style={[s.chargeVal, { color: '#EF4444' }]}>{data.totalDrained}%</Text>
                <Text style={s.chargeLbl}>Total Drained</Text>
              </View>
            </View>

            <BatteryGraph data={data} />
            <StressGraph data={data} />

            <View style={s.statsRow}>
              <Stat label="Today low" value={`${data.dayLow}%`} />
              <Stat label="Today high" value={`${data.dayHigh}%`} />
              <Stat label="Resting HR" value={`${data.restHR}`} />
              <Stat label="HRV base" value={`${data.hrvBaseline}ms`} />
            </View>

            <Text style={s.note}>
              Charges when calm or asleep, drains under stress and activity. Stress is heart rate vs your
              resting baseline, sharpened by HRV when a clean reading is available.
            </Text>
            <Text style={s.note}>
              HRV selectivity: <Text style={{ fontWeight: '700' }}>{data.hrvUsed} used</Text> ·{' '}
              {data.hrvRejected} rejected (movement / AFib-app noise filtered out).
            </Text>
            <Text style={[s.note, { fontStyle: 'italic' }]}>Our estimate — being calibrated against Bevel.</Text>

            <TouchableOpacity
              style={s.debugBtn}
              onPress={async () => {
                await Clipboard.setStringAsync(JSON.stringify(data.debug));
                setCopied(true); setTimeout(() => setCopied(false), 2500);
              }}
            >
              <Text style={s.debugBtnText}>{copied ? '✓ Copied — paste it to the coach' : '⧉ Copy calibration data'}</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  const s = useThemedStyles(makeStyles);
  return (
    <View style={s.stat}>
      <Text style={s.statVal}>{value}</Text>
      <Text style={s.statLbl}>{label}</Text>
    </View>
  );
}

function BatteryGraph({ data }: { data: BodyBattery }) {
  const s = useThemedStyles(makeStyles);
  const { c } = useTheme();
  const grid = c.border, axis = c.textSub;
  const W = Math.round(Dimensions.get('window').width) - 32;
  const H = 170;
  const padL = 26, padR = 8, padT = 10, padB = 18;
  const gw = W - padL - padR, gh = H - padT - padB;
  const pts = data.series;
  if (pts.length < 2) return null;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const x = (t: number) => padL + ((t - t0) / Math.max(1, t1 - t0)) * gw;
  const y = (v: number) => padT + (1 - v / 100) * gh;

  // Break line + area across data gaps (watch off) instead of bridging them.
  const runs = splitRuns(pts);
  const lineFor = (run: typeof pts) => smoothPath(run.map(p => ({ x: x(p.t), y: y(p.battery) })));
  const areaFor = (run: typeof pts) => run.length < 2 ? '' : `${lineFor(run)} L${x(run[run.length - 1].t).toFixed(1)},${y(0).toFixed(1)} L${x(run[0].t).toFixed(1)},${y(0).toFixed(1)} Z`;

  // Sleep bands (contiguous asleep runs)
  const bands: { s: number; e: number }[] = [];
  for (const p of pts) {
    if (!p.asleep) continue;
    const last = bands[bands.length - 1];
    if (last && p.t - last.e <= 15 * 60_000) last.e = p.t;
    else bands.push({ s: p.t, e: p.t });
  }

  const cur = pts[pts.length - 1];
  const hourLabels = [0, 6, 12, 18].map(h => {
    const t = t0 + (h / 24) * (t1 - t0);
    return { t, label: new Date(t).getHours() + 'h' };
  });

  return (
    <View style={s.graphCard}>
      <Svg width={W} height={H}>
        {/* gridlines */}
        {[0, 25, 50, 75, 100].map(v => (
          <React.Fragment key={v}>
            <Line x1={padL} y1={y(v)} x2={W - padR} y2={y(v)} stroke={grid} strokeWidth={0.5} />
            <SvgText x={2} y={y(v) + 3} fontSize={8} fill={axis}>{v}</SvgText>
          </React.Fragment>
        ))}
        {/* sleep bands */}
        {bands.map((b, i) => (
          <Rect key={i} x={x(b.s)} y={padT} width={Math.max(1, x(b.e) - x(b.s))} height={gh} fill="#6366F1" opacity={0.12} />
        ))}
        {/* area + line (one path per contiguous run; gaps left as holes) */}
        {runs.map((run, i) => <Path key={`a${i}`} d={areaFor(run)} fill={levelColor(cur.battery)} opacity={0.12} />)}
        {runs.map((run, i) => <Path key={`l${i}`} d={lineFor(run)} stroke={levelColor(cur.battery)} strokeWidth={2} fill="none" />)}
        {/* now marker */}
        <Circle cx={x(cur.t)} cy={y(cur.battery)} r={3.5} fill={levelColor(cur.battery)} />
        {/* hour ticks */}
        {hourLabels.map((h, i) => (
          <SvgText key={i} x={x(h.t)} y={H - 4} fontSize={8} fill={axis} textAnchor="middle">{h.label}</SvgText>
        ))}
      </Svg>
      <Text style={s.graphCaption}>Last 24h · shaded = asleep</Text>
    </View>
  );
}

// Stress over the same 24h, Bevel-style: a line coloured by level (green→amber→red).
function StressGraph({ data }: { data: BodyBattery }) {
  const s = useThemedStyles(makeStyles);
  const { c } = useTheme();
  const grid = c.border, axis = c.textSub;
  const W = Math.round(Dimensions.get('window').width) - 32;
  const H = 150;
  const padL = 26, padR = 8, padT = 10, padB = 18;
  const gw = W - padL - padR, gh = H - padT - padB;
  const pts = data.series;
  if (pts.length < 2) return null;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const x = (t: number) => padL + ((t - t0) / Math.max(1, t1 - t0)) * gw;
  const y = (v: number) => padT + (1 - v / 100) * gh;

  // Sleep bands (contiguous asleep runs)
  const bands: { s: number; e: number }[] = [];
  for (const p of pts) {
    if (!p.asleep) continue;
    const last = bands[bands.length - 1];
    if (last && p.t - last.e <= 15 * 60_000) last.e = p.t;
    else bands.push({ s: p.t, e: p.t });
  }

  const cur = pts[pts.length - 1];

  // Workout (+settle) bands — the stress curve excludes these (exercise HR ≠ stress); show
  // them as a faint marker and BREAK the line across them so the gap is explained, not bridged.
  const wBands: { s: number; e: number }[] = [];
  for (const p of pts) {
    if (!p.workout) continue;
    const last = wBands[wBands.length - 1];
    if (last && p.t - last.e <= 15 * 60_000) last.e = p.t;
    else wBands.push({ s: p.t, e: p.t });
  }
  // Build line runs from non-workout points, breaking on data gaps OR right after a workout.
  const runs: BatteryPoint[][] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.workout) continue;
    const curRun = runs[runs.length - 1];
    const prev = curRun && curRun.length ? curRun[curRun.length - 1] : null;
    if (!prev || p.t - prev.t > GAP_MS || (i > 0 && pts[i - 1].workout)) runs.push([p]);
    else curRun.push(p);
  }

  const hourLabels = [0, 6, 12, 18].map(h => {
    const t = t0 + (h / 24) * (t1 - t0);
    return { t, label: new Date(t).getHours() + 'h' };
  });

  return (
    <View style={s.graphCard}>
      <Text style={s.graphTitle}>Stress  <Text style={{ color: stressColor(cur.stress) }}>{cur.stress}</Text></Text>
      <Svg width={W} height={H}>
        {[0, 25, 50, 75, 100].map(v => (
          <React.Fragment key={v}>
            <Line x1={padL} y1={y(v)} x2={W - padR} y2={y(v)} stroke={grid} strokeWidth={0.5} />
            <SvgText x={2} y={y(v) + 3} fontSize={8} fill={axis}>{v}</SvgText>
          </React.Fragment>
        ))}
        {bands.map((b, i) => (
          <Rect key={i} x={x(b.s)} y={padT} width={Math.max(1, x(b.e) - x(b.s))} height={gh} fill="#6366F1" opacity={0.12} />
        ))}
        {wBands.map((b, i) => (
          <Rect key={`w${i}`} x={x(b.s)} y={padT} width={Math.max(1.5, x(b.e) - x(b.s))} height={gh} fill="#F97316" opacity={0.14} />
        ))}
        {/* smooth stress line with a vertical green→amber→red gradient (gaps left as holes) */}
        <Defs>
          <LinearGradient id="stressGrad" x1="0" y1={padT} x2="0" y2={padT + gh} gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor="#EF4444" />
            <Stop offset="0.45" stopColor="#F59E0B" />
            <Stop offset="0.75" stopColor="#22C55E" />
            <Stop offset="1" stopColor="#22C55E" />
          </LinearGradient>
        </Defs>
        {runs.map((run, i) => (
          <Path key={i} d={smoothPath(run.map(p => ({ x: x(p.t), y: y(p.stress) })))}
            stroke="url(#stressGrad)" strokeWidth={2} fill="none" />
        ))}
        <Circle cx={x(cur.t)} cy={y(cur.stress)} r={3.5} fill={stressColor(cur.stress)} />
        {hourLabels.map((h, i) => (
          <SvgText key={i} x={x(h.t)} y={H - 4} fontSize={8} fill={axis} textAnchor="middle">{h.label}</SvgText>
        ))}
      </Svg>
      <Text style={s.graphCaption}>Stress · last 24h · blue = asleep · orange = workout (excluded +15m)</Text>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  back: { fontSize: 16, color: c.accent, fontWeight: '600', width: 50 },
  title: { fontSize: 17, fontWeight: '700', color: c.text },
  scroll: { padding: 16, paddingBottom: 40 },
  center: { alignItems: 'center', gap: 10, paddingVertical: 60 },
  sub: { color: c.textSub, fontSize: 14 },
  hero: { alignItems: 'center', marginBottom: 8 },
  big: { fontSize: 64, fontWeight: '800' },
  pct: { fontSize: 26, fontWeight: '700' },
  heroSub: { fontSize: 14, color: c.textSub, marginTop: 2 },
  chargeRow: { flexDirection: 'row', gap: 12, marginBottom: 4 },
  chargeCard: { flex: 1, backgroundColor: c.surface, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  chargeVal: { fontSize: 22, fontWeight: '800' },
  chargeLbl: { fontSize: 12, color: c.textSub, marginTop: 2 },
  graphCard: { backgroundColor: c.surface, borderRadius: 14, padding: 8, marginVertical: 10 },
  graphTitle: { fontSize: 13, fontWeight: '700', color: c.text, marginLeft: 4, marginBottom: 2 },
  graphCaption: { fontSize: 11, color: c.textSub, textAlign: 'center', marginTop: 4 },
  gridColor: { color: c.border },
  statsRow: { flexDirection: 'row', justifyContent: 'space-between', backgroundColor: c.surface, borderRadius: 12, padding: 14, marginBottom: 10 },
  stat: { alignItems: 'center', flex: 1 },
  statVal: { fontSize: 18, fontWeight: '800', color: c.text },
  statLbl: { fontSize: 11, color: c.textSub, marginTop: 2 },
  note: { fontSize: 12.5, color: c.textSub, lineHeight: 18, marginBottom: 8 },
  debugBtn: { marginTop: 8, paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: c.border, alignItems: 'center' },
  debugBtnText: { fontSize: 14, fontWeight: '600', color: c.textSub },
});
