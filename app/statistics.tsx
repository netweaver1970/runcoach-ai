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
import {
  efficiencyTrend, zoneSummary, acwrSeries, decouplingTrend,
  EfPoint, ZoneSummary, AcwrPoint, DecouplePoint,
} from '../src/services/runStats';
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

// ─── Generic time-series (line + optional dots, band, reference lines) ────────────
const TS_H = 130;
const TS_YW = 34;
function TSChart({ vals, colors, innerW, band, refs, yfmt, dotAt, trend }: {
  vals: number[]; colors?: string[]; innerW: number;
  band?: [number, number]; refs?: { y: number; color: string; dash?: boolean }[];
  yfmt?: (v: number) => string; dotAt?: (i: number) => boolean; trend?: boolean;
}) {
  const ch = useThemedStyles(makeCh);
  const { c } = useTheme();
  if (innerW <= 0 || vals.length < 2) return <View style={{ height: TS_H + 8 }} />;
  const plotW = innerW - TS_YW;
  const lo = Math.min(...vals, band ? band[0] : Infinity, ...(refs?.map(r => r.y) ?? []));
  const hi = Math.max(...vals, band ? band[1] : -Infinity, ...(refs?.map(r => r.y) ?? []));
  const pad = (hi - lo) * 0.12 || 1;
  const yMin = lo - pad, yMax = hi + pad;
  const toY = (v: number) => TS_H - ((v - yMin) / (yMax - yMin)) * TS_H;
  const xOf = (i: number) => (i / (vals.length - 1)) * plotW;
  const fmt = yfmt ?? ((v: number) => String(Math.round(v)));
  const ticks = [yMin + (yMax - yMin) * 0.15, (yMin + yMax) / 2, yMax - (yMax - yMin) * 0.15];
  return (
    <View style={{ flexDirection: 'row' }}>
      <View style={{ width: TS_YW, height: TS_H }}>
        {ticks.map((t, i) => <Text key={i} style={[ch.yLabel, { position: 'absolute', top: toY(t) - 7, right: 4 }]}>{fmt(t)}</Text>)}
      </View>
      <View style={{ width: plotW, height: TS_H, position: 'relative' }}>
        {band && (
          <View style={{ position: 'absolute', left: 0, right: 0, top: toY(band[1]), height: Math.max(1, toY(band[0]) - toY(band[1])), backgroundColor: '#22c55e18' }} />
        )}
        {refs?.map((r, i) => (
          <View key={i} style={{ position: 'absolute', left: 0, right: 0, top: toY(r.y), height: 1, backgroundColor: r.color, opacity: r.dash ? 0.5 : 0.9 }} />
        ))}
        {vals.map((v, i) => {
          if (i === 0) return null;
          const x1 = xOf(i - 1), y1 = toY(vals[i - 1]), x2 = xOf(i), y2 = toY(v);
          const dx = x2 - x1, dy = y2 - y1, len = Math.sqrt(dx * dx + dy * dy), ang = Math.atan2(dy, dx) * 180 / Math.PI;
          return <View key={i} style={{ position: 'absolute', left: (x1 + x2) / 2 - len / 2, top: (y1 + y2) / 2 - 1, width: len, height: 2, backgroundColor: (colors?.[i] ?? CTL_BLUE), borderRadius: 1, transform: [{ rotate: `${ang}deg` }] }} />;
        })}
        {vals.map((v, i) => (dotAt?.(i) ?? (i === vals.length - 1)) ? (
          <View key={`d${i}`} style={{ position: 'absolute', left: xOf(i) - 3, top: toY(v) - 3, width: 6, height: 6, borderRadius: 3, backgroundColor: colors?.[i] ?? CTL_BLUE, borderWidth: 1, borderColor: c.surface }} />
        ) : null)}
        {trend && vals.length >= 3 && (() => {
          // OLS trendline over (index, value)
          const n = vals.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
          for (let i = 0; i < n; i++) { sx += i; sy += vals[i]; sxx += i * i; sxy += i * vals[i]; }
          const den = n * sxx - sx * sx; if (!den) return null;
          const m = (n * sxy - sx * sy) / den, b0 = (sy - m * sx) / n;
          const x1 = xOf(0), y1 = toY(b0), x2 = xOf(n - 1), y2 = toY(b0 + m * (n - 1));
          const dx = x2 - x1, dy = y2 - y1, len = Math.sqrt(dx * dx + dy * dy), ang = Math.atan2(dy, dx) * 180 / Math.PI;
          return <View pointerEvents="none" style={{ position: 'absolute', left: (x1 + x2) / 2 - len / 2, top: (y1 + y2) / 2 - 1, width: len, height: 2, backgroundColor: c.textSub, opacity: 0.75, borderRadius: 1, transform: [{ rotate: `${ang}deg` }] }} />;
        })()}
      </View>
    </View>
  );
}

function ZoneBar({ z }: { z: ZoneSummary }) {
  const s = useThemedStyles(makeS);
  const segs = [
    { p: z.pct.z1, c: '#60a5fa', l: 'Z1' }, { p: z.pct.z2, c: '#22c55e', l: 'Z2' },
    { p: z.pct.z3, c: '#f59e0b', l: 'Z3' }, { p: z.pct.z4, c: '#f97316', l: 'Z4' }, { p: z.pct.z5, c: '#ef4444', l: 'Z5' },
  ];
  return (
    <View>
      <View style={s.zoneBar}>
        {segs.map((g, i) => g.p > 0.5 ? (
          <View key={i} style={{ width: `${g.p}%`, backgroundColor: g.c, alignItems: 'center', justifyContent: 'center' }}>
            {g.p > 8 ? <Text style={s.zoneBarTxt}>{Math.round(g.p)}%</Text> : null}
          </View>
        ) : null)}
      </View>
      <View style={s.zone3}>
        <Text style={s.zone3Txt}>🟢 Easy {z.easyPct}%</Text>
        <Text style={s.zone3Txt}>🟠 Moderate {z.modPct}%</Text>
        <Text style={s.zone3Txt}>🔴 Hard {z.hardPct}%</Text>
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
  const [ef, setEf] = useState<EfPoint[]>([]);
  const [zones, setZones] = useState<ZoneSummary | null>(null);
  const [acwr, setAcwr] = useState<AcwrPoint[]>([]);
  const [dc, setDc] = useState<DecouplePoint[] | null>(null);

  const build = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const snap = await loadSnapshotCache();
      getPowerZones().then(setPz).catch(() => {});
      const runs = (snap as any)?.runs ?? [];
      if (!runs.length) { setError('No runs found. Record some runs with power, then check back.'); setLoading(false); return; }
      // Cheap snapshot-derived series first (instant).
      setEf(efficiencyTrend(runs));
      setZones(zoneSummary(runs));
      setAcwr(acwrSeries((snap as any)?.trainingLoad ?? []));
      // Power curve (fetches run detail with progress).
      const cur = await computePowerCurve(runs, (done, total) => setProgress({ done, total }));
      if (cur.points.length < 2) setError('Not enough running-power data yet to draw a curve.');
      setCurve(cur);
      // Decoupling last (also fetches detail, but only long aerobic runs → fewer).
      decouplingTrend(runs).then(setDc).catch(() => setDc([]));
    } catch (e: any) {
      setError(e?.message ?? 'Could not build the statistics.');
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

        {/* ── Efficiency Factor ── */}
        {ef.length >= 2 && (
          <View style={s.card}>
            <Text style={s.cardTitle}>Efficiency Factor</Text>
            <Text style={s.cardSub}>Power ÷ HR per run. Rising = a better aerobic engine, even if CTL looks flat.</Text>
            <TSChart
              innerW={innerW} vals={ef.map(p => p.ef)}
              colors={ef.map(p => p.aerobic ? '#22c55e' : '#cbd5e1')}
              dotAt={(i) => ef[i].aerobic}
              yfmt={(v) => v.toFixed(2)} trend
            />
            <Text style={s.foot}>
              Grey line = trend. Green = steady aerobic runs. Latest {ef[ef.length - 1].ef.toFixed(2)}
              {ef.filter(p => p.aerobic).length >= 2 ? ((): string => {
                const a = ef.filter(p => p.aerobic); const d = a[a.length - 1].ef - a[0].ef;
                return `  ·  aerobic EF ${d >= 0 ? '+' : ''}${(d).toFixed(2)} over the window (${d >= 0 ? 'improving' : 'down'}).`;
              })() : ''}
            </Text>
          </View>
        )}

        {/* ── Running economy (EC = speed ÷ power, HR-independent) ── */}
        {ef.filter(p => p.ec > 0).length >= 2 && (() => { const p = ef.filter(x => x.ec > 0); return (
          <View style={s.card}>
            <Text style={s.cardTitle}>Running Economy (EC)</Text>
            <Text style={s.cardSub}>Speed ÷ power — HR-INDEPENDENT, so it's the most trustworthy. Rising = more speed per watt.</Text>
            <TSChart innerW={innerW} vals={p.map(x => x.ec)} colors={p.map(x => x.aerobic ? '#22c55e' : '#cbd5e1')} dotAt={(i) => p[i].aerobic} yfmt={(v) => v.toFixed(3)} trend />
            <Text style={s.foot}>Grey line = trend. Latest {p[p.length - 1].ec.toFixed(3)} ({((p[p.length - 1].ec - p[0].ec) >= 0 ? '+' : '') + (p[p.length - 1].ec - p[0].ec).toFixed(3)} over the window).</Text>
          </View>
        ); })()}

        {/* ── Speed efficiency (SE = speed ÷ HR) ── */}
        {ef.filter(p => p.se > 0).length >= 2 && (() => { const p = ef.filter(x => x.se > 0); return (
          <View style={s.card}>
            <Text style={s.cardTitle}>Speed Efficiency (SE)</Text>
            <Text style={s.cardSub}>Speed ÷ HR per run. Rising = more speed per heartbeat (HR-based, like EF).</Text>
            <TSChart innerW={innerW} vals={p.map(x => x.se)} colors={p.map(x => x.aerobic ? '#22c55e' : '#cbd5e1')} dotAt={(i) => p[i].aerobic} yfmt={(v) => v.toFixed(2)} trend />
            <Text style={s.foot}>Grey line = trend. Latest {p[p.length - 1].se.toFixed(2)} ({((p[p.length - 1].se - p[0].se) >= 0 ? '+' : '') + (p[p.length - 1].se - p[0].se).toFixed(2)} over the window).</Text>
          </View>
        ); })()}

        {/* ── Time-in-zone / polarization ── */}
        {zones && (
          <View style={s.card}>
            <Text style={s.cardTitle}>Intensity Distribution</Text>
            <Text style={s.cardSub}>Where your running time goes (last 8 weeks). Most endurance plans want ~80% easy.</Text>
            <ZoneBar z={zones} />
            <Text style={s.foot}>
              {zones.minutes} min · polarization index {zones.polarizationIndex.toFixed(2)}
              {zones.modPct > 35 ? '  ·  a lot of moderate "gray zone" — the classic flat-fitness trap.'
                : zones.easyPct >= 75 ? '  ·  nicely polarised (lots of easy).' : ''}
            </Text>
          </View>
        )}

        {/* ── ACWR ── */}
        {acwr.length >= 3 && (
          <View style={s.card}>
            <Text style={s.cardTitle}>Load Ratio (ACWR)</Text>
            <Text style={s.cardSub}>Acute ÷ chronic load. The 0.8–1.3 band is the injury-risk sweet spot.</Text>
            <TSChart
              innerW={innerW} vals={acwr.map(p => p.ratio)}
              band={[0.8, 1.3]}
              refs={[{ y: 1.5, color: '#ef4444', dash: true }]}
              yfmt={(v) => v.toFixed(1)}
            />
            <Text style={s.foot}>
              Latest {acwr[acwr.length - 1].ratio.toFixed(2)}. Green band = sweet spot; red dashed = 1.5 (spike-risk).
            </Text>
          </View>
        )}

        {/* ── Aerobic decoupling ── */}
        <View style={s.card}>
          <Text style={s.cardTitle}>Aerobic Decoupling (Pw:HR)</Text>
          <Text style={s.cardSub}>How much HR drifts up relative to power over a steady run. Under 5% = strong aerobic base.</Text>
          {dc == null ? (
            <View style={{ paddingVertical: 20, alignItems: 'center' }}><ActivityIndicator color={CTL_BLUE} /><Text style={s.loadingText}>Reading long runs…</Text></View>
          ) : dc.length >= 2 ? (
            <>
              <TSChart innerW={innerW} vals={dc.map(p => p.pct)} refs={[{ y: 5, color: '#22c55e' }, { y: 0, color: '#94a3b8', dash: true }]} dotAt={() => true} yfmt={(v) => `${Math.round(v)}%`} />
              <Text style={s.foot}>
                One point per steady run ≥30 min. Green line = 5% threshold. Latest {dc[dc.length - 1].pct.toFixed(1)}%
                {dc[dc.length - 1].pct < 5 ? ' — well-coupled aerobic base.' : ' — some drift; more Z2 volume helps.'}
              </Text>
            </>
          ) : (
            <Text style={s.errorText}>Need a couple of steady runs ≥30 min with power to show decoupling.</Text>
          )}
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
  card: { backgroundColor: c.surface, borderRadius: 16, padding: 12, marginBottom: 12 },
  zoneBar: { flexDirection: 'row', height: 26, borderRadius: 6, overflow: 'hidden', marginTop: 12 },
  zoneBarTxt: { fontSize: 10, color: '#fff', fontWeight: '700' },
  zone3: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  zone3Txt: { fontSize: 12, color: c.text, fontWeight: '600' },
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
