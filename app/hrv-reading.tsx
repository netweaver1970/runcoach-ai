import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, SafeAreaView, ActivityIndicator, TouchableOpacity } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import Svg, { Polyline, Line, Rect, Circle, Ellipse } from 'react-native-svg';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import { HRVReading, getCachedReading } from '../src/services/hrvDetail';
import { fetchHRVReadings } from '../src/services/healthkit';

const HR_RED = '#e5484d';

function MRow({ label, value, unit }: { label: string; value: string | number; unit?: string }) {
  const s = useThemedStyles(makeStyles);
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={s.rowValue}>{value}{unit ? <Text style={s.rowUnit}> {unit}</Text> : null}</Text>
    </View>
  );
}

export default function HRVReadingScreen() {
  const { ts } = useLocalSearchParams<{ ts?: string }>();
  const router = useRouter();
  const s = useThemedStyles(makeStyles);
  const { c } = useTheme();
  const startMs = Number(ts);
  const [reading, setReading] = useState<HRVReading | null>(() => (startMs ? getCachedReading(startMs) : null));
  const [loading, setLoading] = useState(!reading);
  const [w, setW] = useState(0);

  // Cold open / deep link: the cache is empty → re-query the day around this reading and pick it out.
  useEffect(() => {
    if (reading || !startMs) return;
    const from = new Date(startMs - 12 * 3600_000), to = new Date(startMs + 12 * 3600_000);
    fetchHRVReadings(from, to)
      .then(rs => setReading(rs.find(r => r.startMs === startMs) ?? rs.reduce<HRVReading | null>((b, r) => (!b || Math.abs(r.startMs - startMs) < Math.abs(b.startMs - startMs)) ? r : b, null)))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [startMs]);

  const dateLbl = startMs ? new Date(startMs).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) : '';
  const timeRange = reading ? `${new Date(reading.startMs).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}–${new Date(reading.endMs).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : '';

  const m = reading?.metrics;
  const innerW = Math.max(0, w - 24);

  // Histogram of R-R (display bins), for the "HRV Histogram" card.
  const hist = useMemo(() => {
    if (!reading?.rr.length) return null;
    const rr = reading.rr, lo = Math.min(...rr), hi = Math.max(...rr);
    const BIN = 1000 / 128;                                  // 7.8125 ms — the triangular-index bin
    const b0 = Math.floor(lo / BIN), b1 = Math.ceil(hi / BIN);
    const counts = new Array(Math.max(1, b1 - b0 + 1)).fill(0);
    for (const v of rr) counts[Math.min(counts.length - 1, Math.round(v / BIN) - b0)]++;
    return { counts, b0, BIN, lo, hi, max: Math.max(...counts) };
  }, [reading]);

  return (
    <SafeAreaView style={s.container}>
      <Stack.Screen options={{ title: 'HRV reading' }} />
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}><Text style={s.back}>‹ Back</Text></TouchableOpacity>
        <Text style={s.title}>{dateLbl}</Text>
        <View style={{ width: 44 }} />
      </View>

      {loading && !reading ? (
        <View style={s.loading}><ActivityIndicator color={c.accent} /></View>
      ) : !reading || !m ? (
        <View style={s.loading}><Text style={s.empty}>Reading not found.</Text></View>
      ) : (
        <ScrollView contentContainerStyle={s.scroll} onLayout={e => setW(e.nativeEvent.layout.width)}>
          {/* Headline: quality + Baevsky "HRV Stress" (as the reference app shows). */}
          <View style={s.hero}>
            <View style={s.qRow}>
              <View style={[s.qDot, { backgroundColor: reading.ok ? '#27ae60' : '#c0392b' }]} />
              <Text style={[s.qTxt, { color: reading.ok ? '#27ae60' : '#c0392b' }]}>{reading.ok ? 'Good reading' : 'Noisy — treat with caution'}</Text>
            </View>
            <Text style={s.heroSub}>HRV · {timeRange}</Text>
            <Text style={[s.heroVal, { color: HR_RED }]}>{m.baevsky.toString().replace('.', ',')}</Text>
            <Text style={s.heroLbl}>HRV Stress (Baevsky)</Text>
          </View>

          <Text style={s.sectionTitle}>Time</Text>
          <View style={s.card}>
            <MRow label="Total Time" value={reading.totalSec} unit="sec" />
            <MRow label="Elapsed Time" value={reading.elapsedSec} unit="sec" />
            <MRow label="Gaps" value={reading.gaps} />
            <MRow label="Gaps Duration" value={reading.gapsDurSec} unit="sec" />
          </View>

          {/* Heart rate over the reading */}
          <Text style={s.sectionTitle}>Heart Rate</Text>
          <View style={s.card}>
            <Text style={s.big}>{m.hrAvg}<Text style={s.bigUnit}> bpm avg</Text></Text>
            {innerW > 40 && reading.hr.length > 1 && (() => {
              const H = 120, PT = 8, PB = 16, PL = 4, PR = 4;
              const pw = innerW - PL - PR, ph = H - PT - PB;
              const t1 = reading.hr[reading.hr.length - 1].t || 1;
              const lo = m.hrMin, hi = Math.max(m.hrMax, lo + 1);
              const x = (t: number) => PL + (t / t1) * pw;
              const y = (b: number) => PT + (1 - (b - lo) / (hi - lo)) * ph;
              const pts = reading.hr.map(p => `${x(p.t).toFixed(1)},${y(p.bpm).toFixed(1)}`).join(' ');
              return (
                <Svg width={innerW} height={H}>
                  <Line x1={PL} y1={y(m.hrAvg)} x2={PL + pw} y2={y(m.hrAvg)} stroke={c.textFaint} strokeWidth={0.5} strokeDasharray="3 3" />
                  <Polyline points={pts} fill="none" stroke={HR_RED} strokeWidth={1.6} />
                </Svg>
              );
            })()}
            <View style={s.hrLegend}><Text style={s.hrLegendT}>{m.hrMin}–{m.hrMax} bpm</Text></View>
          </View>

          <Text style={s.sectionTitle}>HRV Time-Domain Measures</Text>
          <View style={s.card}>
            <MRow label="R-R intervals" value={m.n} />
            <MRow label="AVNN" value={m.avnn} unit="ms" />
            <MRow label="SDNN" value={m.sdnn} unit="ms" />
            <MRow label="rMSSD" value={m.rmssd} unit="ms" />
            <MRow label="Ln rMSSD" value={m.lnRmssd.toString().replace('.', ',')} />
            <MRow label="NN50" value={m.nn50} />
            <MRow label="pNN50" value={m.pnn50.toString().replace('.', ',')} unit="%" />
            <MRow label="HRV Triangular Index (HRVI)" value={m.hrvi} />
            <MRow label="Baevsky's Stress Index" value={m.baevsky.toString().replace('.', ',')} />
          </View>

          {/* Histogram */}
          <Text style={s.sectionTitle}>HRV Histogram</Text>
          <View style={s.card}>
            <Text style={s.big}>{m.hrvi}<Text style={s.bigUnit}> triangular index</Text></Text>
            {innerW > 40 && hist && (() => {
              const H = 130, PB = 18, PT = 6, PL = 4, PR = 4;
              const pw = innerW - PL - PR, ph = H - PT - PB;
              const bw = pw / hist.counts.length;
              return (
                <Svg width={innerW} height={H}>
                  {hist.counts.map((cnt, i) => {
                    const bh = (cnt / hist.max) * ph;
                    return <Rect key={i} x={PL + i * bw} y={PT + (ph - bh)} width={Math.max(1, bw - 0.5)} height={bh} fill={HR_RED} opacity={0.85} />;
                  })}
                  <Line x1={PL} y1={PT + ph} x2={PL + pw} y2={PT + ph} stroke={c.gridline} strokeWidth={0.5} />
                </Svg>
              );
            })()}
            <View style={s.hrLegend}><Text style={s.hrLegendT}>{hist ? `${Math.round(hist.lo)}` : ''}</Text><Text style={s.hrLegendT}>R-R (ms)</Text><Text style={s.hrLegendT}>{hist ? `${Math.round(hist.hi)}` : ''}</Text></View>
          </View>

          <Text style={s.sectionTitle}>HRV Non-Linear Measures</Text>
          <View style={s.card}>
            <MRow label="S" value={m.s.toLocaleString('en-US').replace(',', '.')} unit="ms²" />
            <MRow label="SD1" value={m.sd1} unit="ms" />
            <MRow label="SD2" value={m.sd2} unit="ms" />
            <MRow label="Cardiac Sympathetic Index (SD1/SD2)" value={m.csi} unit="%" />
          </View>

          {/* Poincaré */}
          <Text style={s.sectionTitle}>Poincaré Plot</Text>
          <View style={s.card}>
            <Text style={s.big}>{m.csi}<Text style={s.bigUnit}> % SD1/SD2</Text></Text>
            {innerW > 40 && reading.rr.length > 2 && (() => {
              const SZ = Math.min(innerW, 240), PAD = 10;
              const rr = reading.rr, lo = Math.min(...rr), hi = Math.max(...rr), span = Math.max(1, hi - lo);
              const map = (v: number) => PAD + ((v - lo) / span) * (SZ - 2 * PAD);
              const cx = map(m.avnn), cy = SZ - map(m.avnn);
              const pts = rr.slice(1).map((v, i) => ({ x: map(rr[i]), y: SZ - map(v) }));
              return (
                <Svg width={SZ} height={SZ} style={{ alignSelf: 'center' }}>
                  <Line x1={PAD} y1={SZ - PAD} x2={SZ - PAD} y2={PAD} stroke={c.gridline} strokeWidth={0.5} strokeDasharray="3 3" />
                  <Ellipse cx={cx} cy={cy} rx={Math.max(2, m.sd2 / span * (SZ - 2 * PAD))} ry={Math.max(2, m.sd1 / span * (SZ - 2 * PAD))} transform={`rotate(-45 ${cx} ${cy})`} fill="none" stroke={c.accent} strokeWidth={1.2} />
                  {pts.map((p, i) => <Circle key={i} cx={p.x} cy={p.y} r={1.4} fill={HR_RED} opacity={0.7} />)}
                </Svg>
              );
            })()}
            <Text style={s.hint}>Each point plots one R-R against the next (RRₙ vs RRₙ₊₁). SD1 = short-term (beat-to-beat) spread, SD2 = long-term; the ellipse is drawn from them.</Text>
          </View>

          <Text style={s.foot}>Computed on-device from the reading's raw R-R (NN) intervals. A reading is flagged red when gaps or artifacts make the beat-to-beat metrics (rMSSD, SD1, stress) unreliable.</Text>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.border },
  back: { fontSize: 16, color: c.accent, fontWeight: '600' },
  title: { fontSize: 15, fontWeight: '800', color: c.text },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { color: c.textSub, fontSize: 14 },
  scroll: { padding: 12, paddingBottom: 40 },
  hero: { alignItems: 'center', paddingVertical: 10 },
  qRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  qDot: { width: 10, height: 10, borderRadius: 5 },
  qTxt: { fontSize: 13, fontWeight: '700' },
  heroSub: { fontSize: 12, color: c.textFaint },
  heroVal: { fontSize: 44, fontWeight: '800', marginTop: 2 },
  heroLbl: { fontSize: 12, color: c.textSub, marginTop: -2 },
  sectionTitle: { fontSize: 13, fontWeight: '800', color: HR_RED, marginTop: 16, marginBottom: 6, marginLeft: 2 },
  card: { backgroundColor: c.surface, borderRadius: 14, borderWidth: 1, borderColor: c.border, overflow: 'hidden', paddingHorizontal: 2 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  rowLabel: { fontSize: 13.5, color: c.textSub, flex: 1 },
  rowValue: { fontSize: 15, fontWeight: '800', color: c.text },
  rowUnit: { fontSize: 11, fontWeight: '600', color: c.textFaint },
  big: { fontSize: 22, fontWeight: '800', color: c.text, textAlign: 'center', paddingTop: 10 },
  bigUnit: { fontSize: 12, fontWeight: '600', color: c.textFaint },
  hrLegend: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 14, paddingBottom: 8 },
  hrLegendT: { fontSize: 10, color: c.textFaint },
  hint: { fontSize: 11, color: c.textFaint, lineHeight: 16, paddingHorizontal: 14, paddingBottom: 12, paddingTop: 4 },
  foot: { fontSize: 11, color: c.textFaint, lineHeight: 16, marginTop: 16, paddingHorizontal: 4 },
});
