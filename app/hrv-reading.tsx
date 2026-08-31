import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, SafeAreaView, ActivityIndicator, TouchableOpacity, Modal } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import Svg, { Polyline, Line, Rect, Circle, Ellipse } from 'react-native-svg';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import { HRVReading, getCachedReading, hrvGrade, gradeColor, gradeLabel } from '../src/services/hrvDetail';
import { fetchHRVReadings } from '../src/services/healthkit';
import { ReorderList } from '../src/ReorderList';
import { HRVCard, HRVCardId, HRV_CARD_TITLES, DEFAULT_HRV_LAYOUT, loadHRVLayout, saveHRVLayout } from '../src/services/hrvLayout';

const HR_RED = '#e5484d';

// One metric row. The NUMBER is right-aligned in a fixed column and the unit sits in its own fixed column,
// so numbers line up vertically whether or not a row has a unit.
function MRow({ label, value, unit }: { label: string; value: string | number; unit?: string }) {
  const s = useThemedStyles(makeStyles);
  return (
    <View style={s.row}>
      <Text style={s.rowLabel} numberOfLines={1}>{label}</Text>
      <Text style={s.rowValue}>{value}</Text>
      <Text style={s.rowUnit}>{unit ?? ''}</Text>
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
  const [layout, setLayout] = useState<HRVCard[]>(DEFAULT_HRV_LAYOUT);
  const [customising, setCustomising] = useState(false);
  useEffect(() => { loadHRVLayout().then(setLayout); }, []);
  const commitLayout = useCallback((next: HRVCard[]) => { setLayout(next); saveHRVLayout(next); }, []);

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
  const grade = reading ? hrvGrade(reading) : 'poor';

  // Histogram of R-R (7.8125 ms bins → the triangular-index bin).
  const hist = useMemo(() => {
    if (!reading?.rr.length) return null;
    const rr = reading.rr, lo = Math.min(...rr), hi = Math.max(...rr), BIN = 1000 / 128;
    const b0 = Math.floor(lo / BIN), b1 = Math.ceil(hi / BIN);
    const counts = new Array(Math.max(1, b1 - b0 + 1)).fill(0);
    for (const v of rr) counts[Math.min(counts.length - 1, Math.round(v / BIN) - b0)]++;
    return { counts, lo, hi, max: Math.max(...counts) };
  }, [reading]);

  // Cards, keyed by id → rendered in the user's chosen order/enabled set (Customise sheet).
  const cardNodes: Record<HRVCardId, React.ReactNode> = {
    time: (
      <View style={s.card} key="time">
        <MRow label="Total Time" value={reading?.totalSec ?? 0} unit="sec" />
        <MRow label="Elapsed Time" value={reading?.elapsedSec ?? 0} unit="sec" />
        <MRow label="Gaps" value={reading?.gaps ?? 0} />
        <MRow label="Gaps Duration" value={reading?.gapsDurSec ?? 0} unit="sec" />
      </View>
    ),
    hr: (
      <View style={s.card} key="hr">
        <Text style={s.big}>{m?.hrAvg ?? 0}<Text style={s.bigUnit}> bpm avg</Text></Text>
        {innerW > 40 && reading && reading.hr.length > 1 && (() => {
          const H = 92, PT = 6, PB = 14, PL = 4, PR = 4;
          const pw = innerW - PL - PR, ph = H - PT - PB;
          const t1 = reading.hr[reading.hr.length - 1].t || 1;
          const lo = m!.hrMin, hi = Math.max(m!.hrMax, lo + 1);
          const x = (t: number) => PL + (t / t1) * pw;
          const y = (b: number) => PT + (1 - (b - lo) / (hi - lo)) * ph;
          // One polyline PER gap-free segment → the line breaks at gaps instead of jumping across them.
          const segs = new Map<number, string[]>();
          for (const p of reading.hr) { const a = segs.get(p.seg) ?? []; a.push(`${x(p.t).toFixed(1)},${y(p.bpm).toFixed(1)}`); segs.set(p.seg, a); }
          return (
            <Svg width={innerW} height={H}>
              <Line x1={PL} y1={y(m!.hrAvg)} x2={PL + pw} y2={y(m!.hrAvg)} stroke={c.textFaint} strokeWidth={0.5} strokeDasharray="3 3" />
              {[...segs.values()].map((pts, i) => <Polyline key={i} points={pts.join(' ')} fill="none" stroke={HR_RED} strokeWidth={1.6} />)}
            </Svg>
          );
        })()}
        <View style={s.legend}><Text style={s.legendT}>{m?.hrMin}–{m?.hrMax} bpm</Text></View>
      </View>
    ),
    timedomain: (
      <View style={s.card} key="td">
        <MRow label="R-R intervals" value={m?.n ?? 0} />
        <MRow label="AVNN" value={m?.avnn ?? 0} unit="ms" />
        <MRow label="SDNN" value={m?.sdnn ?? 0} unit="ms" />
        <MRow label="rMSSD" value={m?.rmssd ?? 0} unit="ms" />
        <MRow label="Ln rMSSD" value={(m?.lnRmssd ?? 0).toString().replace('.', ',')} />
        <MRow label="NN50" value={m?.nn50 ?? 0} />
        <MRow label="pNN50" value={(m?.pnn50 ?? 0).toString().replace('.', ',')} unit="%" />
        <MRow label="HRV Triangular Index" value={m?.hrvi ?? 0} />
        <MRow label="Baevsky's Stress Index" value={(m?.baevsky ?? 0).toString().replace('.', ',')} />
      </View>
    ),
    histogram: (
      <View style={s.card} key="hg">
        <Text style={s.big}>{m?.hrvi ?? 0}<Text style={s.bigUnit}> triangular index</Text></Text>
        {innerW > 40 && hist && (() => {
          const H = 100, PB = 14, PT = 4, PL = 4, PR = 4;
          const pw = innerW - PL - PR, ph = H - PT - PB, bw = pw / hist.counts.length;
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
        <View style={s.legend}><Text style={s.legendT}>{hist ? Math.round(hist.lo) : ''}</Text><Text style={s.legendT}>R-R (ms)</Text><Text style={s.legendT}>{hist ? Math.round(hist.hi) : ''}</Text></View>
      </View>
    ),
    nonlinear: (
      <View style={s.card} key="nl">
        <MRow label="S" value={(m?.s ?? 0).toLocaleString('en-US').replace(',', '.')} unit="ms²" />
        <MRow label="SD1" value={m?.sd1 ?? 0} unit="ms" />
        <MRow label="SD2" value={m?.sd2 ?? 0} unit="ms" />
        <MRow label="Cardiac Sympathetic Index" value={m?.csi ?? 0} unit="%" />
      </View>
    ),
    poincare: (
      <View style={s.card} key="pc">
        <Text style={s.big}>{m?.csi ?? 0}<Text style={s.bigUnit}> % SD1/SD2</Text></Text>
        {innerW > 40 && reading && reading.rr.length > 2 && (() => {
          const SZ = Math.min(innerW, 200), PAD = 8;
          const rr = reading.rr, lo = Math.min(...rr), hi = Math.max(...rr), span = Math.max(1, hi - lo);
          const map = (v: number) => PAD + ((v - lo) / span) * (SZ - 2 * PAD);
          const cx = map(m!.avnn), cy = SZ - map(m!.avnn);
          const pts = rr.slice(1).map((v, i) => ({ x: map(rr[i]), y: SZ - map(v) }));
          return (
            <Svg width={SZ} height={SZ} style={{ alignSelf: 'center' }}>
              <Line x1={PAD} y1={SZ - PAD} x2={SZ - PAD} y2={PAD} stroke={c.gridline} strokeWidth={0.5} strokeDasharray="3 3" />
              <Ellipse cx={cx} cy={cy} rx={Math.max(2, m!.sd2 / span * (SZ - 2 * PAD))} ry={Math.max(2, m!.sd1 / span * (SZ - 2 * PAD))} transform={`rotate(-45 ${cx} ${cy})`} fill="none" stroke={c.accent} strokeWidth={1.2} />
              {pts.map((p, i) => <Circle key={i} cx={p.x} cy={p.y} r={1.4} fill={HR_RED} opacity={0.7} />)}
            </Svg>
          );
        })()}
        <Text style={s.hint}>RRₙ vs RRₙ₊₁. SD1 = beat-to-beat spread, SD2 = long-term; the ellipse is drawn from them.</Text>
      </View>
    ),
  };

  return (
    <SafeAreaView style={s.container}>
      <Stack.Screen options={{ title: 'HRV reading' }} />
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}><Text style={s.back}>‹ Back</Text></TouchableOpacity>
        <Text style={s.title} numberOfLines={1}>{dateLbl}</Text>
        <TouchableOpacity onPress={() => setCustomising(true)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}><Text style={{ fontSize: 20 }}>⚙︎</Text></TouchableOpacity>
      </View>

      {loading && !reading ? (
        <View style={s.loading}><ActivityIndicator color={c.accent} /></View>
      ) : !reading || !m ? (
        <View style={s.loading}><Text style={s.empty}>Reading not found.</Text></View>
      ) : (
        <ScrollView contentContainerStyle={s.scroll} onLayout={e => setW(e.nativeEvent.layout.width)}>
          <View style={s.hero}>
            <View style={s.qRow}>
              <View style={[s.qDot, { backgroundColor: gradeColor(grade) }]} />
              <Text style={[s.qTxt, { color: gradeColor(grade) }]}>
                {grade === 'good' ? 'Good reading' : grade === 'fair' ? 'Fair — some data missing' : 'Noisy — treat with caution'}
              </Text>
            </View>
            <Text style={s.heroSub}>{timeRange} · {reading.gapsDurSec}s of {reading.elapsedSec}s missing</Text>
            <Text style={[s.heroVal, { color: HR_RED }]}>{m.baevsky.toString().replace('.', ',')}</Text>
            <Text style={s.heroLbl}>HRV Stress (Baevsky)</Text>
          </View>

          {layout.filter(l => l.on).map(l => (
            <React.Fragment key={l.id}>
              <Text style={s.sectionTitle}>{HRV_CARD_TITLES[l.id]}</Text>
              {cardNodes[l.id]}
            </React.Fragment>
          ))}

          <Text style={s.foot}>Computed on-device from the reading's raw R-R (NN) intervals. Grade weighs coverage, missing time and artifacts — a chunk of gaps drops it from “good”.</Text>
        </ScrollView>
      )}

      <Modal visible={customising} animationType="slide" transparent onRequestClose={() => setCustomising(false)}>
        <View style={s.sheetBackdrop}>
          <View style={s.sheet}>
            <View style={s.sheetHead}>
              <Text style={s.sheetTitle}>Customise cards</Text>
              <TouchableOpacity onPress={() => setCustomising(false)}><Text style={s.sheetDone}>Done</Text></TouchableOpacity>
            </View>
            <Text style={s.sheetHint}>Drag ≡ to reorder · switch to show or hide</Text>
            <ScrollView style={{ flexShrink: 1 }} scrollEnabled showsVerticalScrollIndicator>
              <ReorderList items={layout} titleOf={(id) => HRV_CARD_TITLES[id as HRVCardId]} onCommit={commitLayout} />
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.border, gap: 8 },
  back: { fontSize: 16, color: c.accent, fontWeight: '600' },
  title: { flex: 1, textAlign: 'center', fontSize: 14, fontWeight: '800', color: c.text },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { color: c.textSub, fontSize: 14 },
  scroll: { padding: 12, paddingBottom: 36 },
  hero: { alignItems: 'center', paddingVertical: 4 },
  qRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  qDot: { width: 10, height: 10, borderRadius: 5 },
  qTxt: { fontSize: 13, fontWeight: '700' },
  heroSub: { fontSize: 11.5, color: c.textFaint },
  heroVal: { fontSize: 34, fontWeight: '800', marginTop: 0 },
  heroLbl: { fontSize: 11.5, color: c.textSub, marginTop: -2 },
  sectionTitle: { fontSize: 12.5, fontWeight: '800', color: HR_RED, marginTop: 12, marginBottom: 5, marginLeft: 2 },
  card: { backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.border, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'baseline', paddingHorizontal: 14, paddingVertical: 7, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  rowLabel: { flex: 1, fontSize: 13, color: c.textSub },
  rowValue: { fontSize: 14.5, fontWeight: '800', color: c.text, minWidth: 62, textAlign: 'right', fontVariant: ['tabular-nums'] },
  rowUnit: { width: 34, marginLeft: 5, fontSize: 11, fontWeight: '600', color: c.textFaint },
  big: { fontSize: 20, fontWeight: '800', color: c.text, textAlign: 'center', paddingTop: 8 },
  bigUnit: { fontSize: 12, fontWeight: '600', color: c.textFaint },
  legend: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 14, paddingBottom: 6 },
  legendT: { fontSize: 10, color: c.textFaint },
  hint: { fontSize: 11, color: c.textFaint, lineHeight: 15, paddingHorizontal: 14, paddingBottom: 10, paddingTop: 2 },
  foot: { fontSize: 11, color: c.textFaint, lineHeight: 15, marginTop: 14, paddingHorizontal: 4 },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: c.surface, borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 34, maxHeight: '92%' },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  sheetTitle: { fontSize: 17, fontWeight: '800', color: c.text },
  sheetDone: { fontSize: 16, fontWeight: '700', color: c.accent },
  sheetHint: { fontSize: 12, color: c.textSub, marginBottom: 10 },
});
