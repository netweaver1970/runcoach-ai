import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, SafeAreaView, ActivityIndicator, LayoutChangeEvent,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import { loadSnapshotCache } from '../src/services/healthkit';
import { getPowerZones } from '../src/services/claude';
import {
  computePowerCurve, clearPowerCurveCache, fmtDur, PDC_ANCHORS, PowerCurve,
} from '../src/services/powerCurve';
import type { PowerZones } from '../src/types';

const CHART_H = 210;
const Y_AXIS_W = 38;
const CTL_BLUE = '#3B82F6';

// ─── Power-Duration chart ───────────────────────────────────────────────────────
function PdcChart({ curve, innerW, pz }: { curve: PowerCurve; innerW: number; pz?: PowerZones }) {
  const ch = useThemedStyles(makeCh);
  const { c } = useTheme();
  const pts = curve.points;
  if (innerW <= 0 || pts.length < 2) return <View style={{ height: CHART_H + 30 }} />;

  const plotW = innerW - Y_AXIS_W;
  const minSec = pts[0].sec, maxSec = pts[pts.length - 1].sec;
  const lx = (sec: number) => (Math.log(sec) - Math.log(minSec)) / (Math.log(maxSec) - Math.log(minSec)) * plotW;

  const maxW = Math.max(...pts.map(p => p.watts));
  const yMax = Math.ceil(maxW / 25) * 25 + 25;
  const yMin = 0;
  const toY = (w: number) => CHART_H - ((w - yMin) / (yMax - yMin)) * CHART_H;

  const yTicks: number[] = [];
  for (let t = 0; t <= yMax; t += Math.max(25, Math.round(yMax / 4 / 25) * 25)) yTicks.push(t);

  // x-axis tick durations (log-spaced, the reference points)
  const xTicks = [5, 30, 60, 300, 1200, 3600].filter(s => s >= minSec && s <= maxSec);

  const seg = (i: number, color: string, width = 2.5) => {
    const a = pts[i - 1], b = pts[i];
    const x1 = lx(a.sec), y1 = toY(a.watts), x2 = lx(b.sec), y2 = toY(b.watts);
    const dx = x2 - x1, dy = y2 - y1, len = Math.sqrt(dx * dx + dy * dy);
    const ang = Math.atan2(dy, dx) * 180 / Math.PI;
    return (
      <View key={`s-${i}`} style={{
        position: 'absolute', left: (x1 + x2) / 2 - len / 2, top: (y1 + y2) / 2 - width / 2,
        width: len, height: width, backgroundColor: color, borderRadius: width / 2,
        transform: [{ rotate: `${ang}deg` }],
      }} />
    );
  };

  return (
    <View style={{ flexDirection: 'row' }}>
      <View style={{ width: Y_AXIS_W, height: CHART_H + 22 }}>
        {yTicks.map((t, i) => (
          <Text key={i} style={[ch.yLabel, { position: 'absolute', top: toY(t) - 8, right: 4 }]}>{t}</Text>
        ))}
      </View>
      <View style={{ width: plotW, height: CHART_H + 22, position: 'relative' }}>
        {yTicks.map((t, i) => (
          <View key={i} style={{ position: 'absolute', top: toY(t), left: 0, right: 0, height: 1, backgroundColor: c.gridline }} />
        ))}
        {/* Threshold-power reference from the current zones (Z4 = tempoMax..intervalsMin), if set */}
        {pz && pz.tempoMax > 0 && pz.intervalsMin > pz.tempoMax && (
          <View style={{
            position: 'absolute', left: 0, right: 0, top: toY(pz.intervalsMin),
            height: toY(pz.tempoMax) - toY(pz.intervalsMin), backgroundColor: '#8e7cc322',
          }} />
        )}
        {pts.map((_, i) => i === 0 ? null : seg(i, CTL_BLUE)).filter(Boolean)}
        {/* anchor dots + labels */}
        {pts.filter(p => PDC_ANCHORS.has(p.sec)).map((p) => (
          <View key={`a-${p.sec}`}>
            <View style={{
              position: 'absolute', left: lx(p.sec) - 4, top: toY(p.watts) - 4,
              width: 8, height: 8, borderRadius: 4, backgroundColor: CTL_BLUE, borderWidth: 1.5, borderColor: '#fff',
            }} />
            <Text style={[ch.anchor, { position: 'absolute', left: Math.min(plotW - 46, Math.max(0, lx(p.sec) - 16)), top: toY(p.watts) - 24 }]}>
              {p.watts}W
            </Text>
          </View>
        ))}
        {/* x labels */}
        {xTicks.map((s, i) => (
          <Text key={i} style={[ch.xLabel, { position: 'absolute', top: CHART_H + 4, left: Math.min(plotW - 30, Math.max(0, lx(s) - 15)), width: 30, textAlign: 'center' }]}>
            {fmtDur(s)}
          </Text>
        ))}
      </View>
    </View>
  );
}

// ─── Screen ─────────────────────────────────────────────────────────────────────
export default function StatisticsScreen() {
  const router = useRouter();
  const s = useThemedStyles(makeS);
  const [curve, setCurve] = useState<PowerCurve | null>(null);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [innerW, setInnerW] = useState(0);
  const [pz, setPz] = useState<PowerZones | undefined>(undefined);

  const build = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const snap = await loadSnapshotCache();
      getPowerZones().then(setPz).catch(() => {});
      const runs = (snap as any)?.runs ?? [];
      if (!runs.length) { setError('No runs found. Record some runs with power, then check back.'); setLoading(false); return; }
      const cur = await computePowerCurve(runs, (done, total) => setProgress({ done, total }));
      if (cur.points.length < 2) setError('Not enough running-power data yet to draw a curve.');
      setCurve(cur);
    } catch (e: any) {
      setError(e?.message ?? 'Could not build the power curve.');
    } finally { setLoading(false); setProgress(null); }
  }, []);

  useEffect(() => { build(); }, [build]);

  const onLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width - 24;   // minus card padding
    if (Math.abs(w - innerW) > 1) setInnerW(w);
  };

  const anchorFor = (sec: number) => curve?.points.find(p => p.sec === sec);

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={s.back}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={s.title}>Statistics</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView contentContainerStyle={s.scroll}>
        <View style={s.card} onLayout={onLayout}>
          <Text style={s.cardTitle}>Power–Duration Curve</Text>
          <Text style={s.cardSub}>Best average running power you've held for each duration, across your runs.</Text>

          {loading ? (
            <View style={s.center}>
              <ActivityIndicator size="large" color={CTL_BLUE} />
              <Text style={s.loadingText}>
                {progress && progress.total > 0 ? `Reading runs… ${progress.done}/${progress.total}` : 'Loading…'}
              </Text>
            </View>
          ) : error ? (
            <Text style={s.errorText}>{error}</Text>
          ) : curve ? (
            <>
              <PdcChart curve={curve} innerW={innerW} pz={pz} />

              {/* Reference points */}
              <View style={s.grid}>
                {([[5, 'Sprint'], [60, '1-min'], [300, 'VO₂ (5-min)'], [1200, 'Threshold (20-min)'], [3600, 'Aerobic (60-min)']] as const).map(([sec, lbl]) => {
                  const a = anchorFor(sec);
                  return (
                    <View key={sec} style={s.gridCell}>
                      <Text style={s.gridVal}>{a ? `${a.watts} W` : '—'}</Text>
                      <Text style={s.gridLbl}>{lbl}</Text>
                      {a ? <Text style={s.gridDate}>{a.date.slice(5)}</Text> : null}
                    </View>
                  );
                })}
              </View>

              {curve.cp != null && (
                <View style={s.cpBox}>
                  <Text style={s.cpVal}>Critical Power ≈ {curve.cp} W</Text>
                  <Text style={s.cpSub}>
                    Estimated sustainable power (3+12-min bests){curve.wPrime ? ` · W′ ${(curve.wPrime / 1000).toFixed(1)} kJ` : ''}.
                    {pz && pz.tempoMax > 0 ? `  Your set threshold band is ${pz.tempoMax}–${pz.intervalsMin} W (shaded).` : ''}
                  </Text>
                </View>
              )}

              <Text style={s.foot}>
                From {curve.runsUsed} runs with power. Shaded band = your current threshold zone (Z4).
                A fed, paced 20-min test refines the long end of this curve.
              </Text>
              <TouchableOpacity style={s.rebuild} onPress={() => { clearPowerCurveCache().then(build); }}>
                <Text style={s.rebuildText}>↻ Rebuild from scratch</Text>
              </TouchableOpacity>
            </>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const makeCh = (c: Palette) => StyleSheet.create({
  yLabel: { fontSize: 10, color: c.textSub, textAlign: 'right', fontWeight: '500' },
  xLabel: { fontSize: 10, color: c.textSub, fontWeight: '600' },
  anchor: { fontSize: 11, color: c.text, fontWeight: '800' },
});

const makeS = (c: Palette) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10 },
  back: { color: c.accent, fontSize: 16, fontWeight: '600', width: 60 },
  title: { fontSize: 17, fontWeight: '700', color: c.text },
  scroll: { padding: 12, paddingBottom: 40 },
  card: { backgroundColor: c.surface, borderRadius: 16, padding: 12 },
  cardTitle: { fontSize: 16, fontWeight: '800', color: c.text },
  cardSub: { fontSize: 12, color: c.textSub, marginTop: 2, marginBottom: 12 },
  center: { height: CHART_H, alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: c.textSub, marginTop: 10, fontSize: 13 },
  errorText: { color: c.textSub, fontSize: 13, paddingVertical: 20, textAlign: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 16, gap: 8 },
  gridCell: { flexGrow: 1, flexBasis: '30%', backgroundColor: c.bg, borderRadius: 10, paddingVertical: 8, alignItems: 'center' },
  gridVal: { fontSize: 16, fontWeight: '800', color: c.text },
  gridLbl: { fontSize: 10, color: c.textSub, marginTop: 1, fontWeight: '600' },
  gridDate: { fontSize: 9, color: c.textFaint, marginTop: 1 },
  cpBox: { marginTop: 14, backgroundColor: c.bg, borderRadius: 10, padding: 10 },
  cpVal: { fontSize: 15, fontWeight: '800', color: c.text },
  cpSub: { fontSize: 11, color: c.textSub, marginTop: 3, lineHeight: 15 },
  foot: { fontSize: 11, color: c.textFaint, marginTop: 12, lineHeight: 15 },
  rebuild: { marginTop: 12, alignSelf: 'flex-start' },
  rebuildText: { fontSize: 12, color: c.accent, fontWeight: '600' },
});
