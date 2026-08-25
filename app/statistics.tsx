import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, SafeAreaView, ActivityIndicator, LayoutChangeEvent, PanResponder, Modal, Switch, Animated,
} from 'react-native';
import {
  StatCard, StatCardId, STAT_CARD_TITLES, DEFAULT_STATS_LAYOUT, loadStatsLayout, saveStatsLayout,
} from '../src/services/statsLayout';
import { loadEvents } from '../src/services/timelineEvents';
import { useRouter } from 'expo-router';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import { loadSnapshotCache, fetchHealthSnapshot, saveSnapshotCache, fetchTrainingLoadHistory, fetchBodyMassHistory } from '../src/services/healthkit';
import { loadStatsRuns, saveStatsRuns, mergeRuns } from '../src/services/statsRunsCache';
import { repairWorkStats, clearWorkStatsRepairCache, RepairedWork } from '../src/services/workStatsRepair';
import { clearWorkoutCache } from '../src/services/workoutClassifier';
import { getPowerZones } from '../src/services/claude';
import {
  computePowerCurve, clearPowerCurveCache, fmtDur, PDC_ANCHORS, PowerCurve,
} from '../src/services/powerCurve';
import { predictRaces, medianEcFromRuns, fmtRaceTime, fmtRacePace } from '../src/services/racePredictor';
import { computePerformanceIndex, weightedGpi, WEIGHT_PRESETS, Emphasis, GpiResult } from '../src/services/performanceIndex';
import * as SecureStore from 'expo-secure-store';
import {
  efficiencyTrend, zoneSummary, acwrSeries, decouplingTrend, decouplingBanded, zoneDistributionOverTime,
  EfPoint, ZoneSummary, AcwrPoint, DecouplePoint, ZoneWeek, HEAT_C,
} from '../src/services/runStats';
import { computeCapHistory, computeRolling7d, CapWeek, Rolling7d } from '../src/services/coach';
import type { PowerZones } from '../src/types';

const CHART_H = 160;
const Y_AXIS_W = 38;
const CTL_BLUE = '#3B82F6';
const GPI_COLOR = '#6366f1';   // Performance composite line (matches app/performance.tsx)
const gpiLevelWord = (v: number) => v >= 62 ? 'climbing' : v >= 54 ? 'improving' : v >= 46 ? 'holding steady' : v >= 38 ? 'slipping' : 'declining';
// Runs above HEAT_C: HR is elevated by the weather, so the HR-BASED reads (EF, SE, decoupling) look worse
// than the athlete's actual fitness. Flagged orange on those charts only — EC is HR-independent, so it is
// deliberately never heat-tinted (that's the chart to trust on a hot spell).
const HEAT_ORANGE = '#f97316';

// Run-time temperature as a smoothed secondary trace on the HEAT-AFFECTED charts (EF, SE, decoupling), so
// a dip or a climb can be read against the weather that partly caused it. Smoothed over a small window
// because the cue wanted here is "was this a warm spell", not each run's exact reading — raw per-run temps
// zig-zag enough to obscure that. EC is deliberately excluded: it is HR-independent, so heat doesn't move
// it, and its right axis already carries body weight.
function tempTrace(pts: { date: string; tempC?: number }[], win = 3): TPt[] {
  const withT = pts.filter(p => typeof p.tempC === 'number').map(p => ({ t: tOf(p.date), v: p.tempC as number }));
  if (withT.length < 2) return [];
  return withT.map((p, i) => {
    const a = Math.max(0, i - Math.floor(win / 2)), b = Math.min(withT.length - 1, i + Math.floor(win / 2));
    let sum = 0, n = 0;
    for (let j = a; j <= b; j++) { sum += withT[j].v; n++; }
    return { t: p.t, v: Math.round((sum / n) * 10) / 10 };
  });
}
const EV_COLOR: Record<string, string> = { medical: '#ef4444', life: '#10b981' };
// Ordered shortest→longest to match the other history screens (app/history.tsx '1M','3M','6M','1Y' and
// app/biology.tsx '1M'…'10Y') so the range tabs read the same way everywhere. 'All' closes the row for the
// full-history view these charts support; month lengths match biology's RANGE_MONTHS (30d/month).
type Range = '1M' | '3M' | '6M' | '1Y' | '5Y' | 'All';
const RANGES: Range[] = ['1M', '3M', '6M', '1Y', '5Y', 'All'];
const RANGE_DAYS: Record<Range, number> = { '1M': 30, '3M': 90, '6M': 180, '1Y': 365, '5Y': 1825, All: 0 };
interface Ev { t: number; label: string; category: string }
const tOf = (d: string) => new Date(d.length <= 10 ? d + 'T00:00:00' : d).getTime();
const dLabel = (t: number, yearly: boolean) =>
  new Date(t).toLocaleDateString('en-GB', yearly ? { month: 'short', year: '2-digit' } : { day: 'numeric', month: 'short' });

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
          <Text key={i} style={[ch.yLabel, { position: 'absolute', top: Math.max(0, toY(t) - 8), right: 4 }]}>{t}</Text>
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
        {/* Anchor: a drop-line to the axis, the watts, and the date read vertically alongside the line —
            this replaces the separate reference table below the chart. */}
        {pts.filter(p => PDC_ANCHORS.has(p.sec)).map((p) => {
          const ax = lx(p.sec), ay = toY(p.watts);
          // The topmost anchor's label used to be drawn 24px ABOVE the point, which for the sprint best
          // lands outside the plot and collides with the card title — flip it below when there's no room.
          const above = ay >= 26;
          return (
            <View key={`a-${p.sec}`}>
              <View style={{ position: 'absolute', left: ax, top: ay, width: 1, height: Math.max(0, CHART_H - ay), backgroundColor: c.gridline }} />
              <View style={{
                position: 'absolute', left: ax - 4, top: ay - 4,
                width: 8, height: 8, borderRadius: 4, backgroundColor: CTL_BLUE, borderWidth: 1.5, borderColor: '#fff',
              }} />
              <Text style={[ch.anchor, { position: 'absolute', left: Math.min(plotW - 46, Math.max(0, ax - 16)), top: above ? ay - 22 : ay + 7 }]}>
                {p.watts}W
              </Text>
              {/* date, rotated to run up the drop-line so six of them fit without colliding; the rightmost
                  anchor flips to the left of its line so it doesn't overflow the plot */}
              <Text style={{
                position: 'absolute', left: ax > plotW - 20 ? ax - 33 : ax - 17, top: CHART_H - 40,
                width: 50, height: 12,
                fontSize: 9, color: c.textFaint, textAlign: 'left', transform: [{ rotate: '-90deg' }],
              }} numberOfLines={1}>{p.date.slice(5)}</Text>
            </View>
          );
        })}
        {/* x labels */}
        {xTicks.map((s, i) => (
          <Text key={i} style={[ch.xLabel, { position: 'absolute', top: CHART_H + 4, left: Math.min(plotW - 40, Math.max(0, lx(s) - 20)), width: 40, textAlign: 'center' }]} numberOfLines={1}>
            {fmtDur(s)}
          </Text>
        ))}
      </View>
    </View>
  );
}

// ─── Generic time-series (line + optional dots, band, reference lines) ────────────
const TS_H = 96;
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
        {ticks.map((t, i) => <Text key={i} style={[ch.yLabel, { position: 'absolute', top: Math.max(0, toY(t) - 7), right: 4 }]}>{fmt(t)}</Text>)}
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

// ─── Card header with a collapsible note ──────────────────────────────────────────────────────────
// Both the "what is this chart" blurb and the per-chart footnote are useful the first few times and
// clutter afterwards, so they live together behind one ▸ Notes toggle sitting on the TITLE row — the
// card then costs a single line of chrome and the charts stay dense.
function CardHead({ title, children }: { title: string; children?: React.ReactNode }) {
  const { c } = useTheme();
  const s = useThemedStyles(makeS);
  const [open, setOpen] = useState(false);
  const has = React.Children.toArray(children).length > 0;
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={[s.cardTitle, { flex: 1 }]} numberOfLines={1}>{title}</Text>
        {has && (
          <TouchableOpacity onPress={() => setOpen(o => !o)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={{ color: c.textFaint, fontSize: 11.5, fontWeight: '700' }}>{open ? '▾ Notes' : '▸ Notes'}</Text>
          </TouchableOpacity>
        )}
      </View>
      {has && open && <Text style={{ color: c.textSub, fontSize: 11.5, lineHeight: 16, marginTop: 5 }}>{children}</Text>}
    </View>
  );
}

// ─── Time-windowed series chart: cursor + events + date x-axis + optional band/refs/trend ─────────
const TX_H = 20;
interface TPt { t: number; v: number; color?: string }
function TChart({ pts, t0, t1, color, band, refs, trend, events, showEvents, yfmt, innerW, pts2, color2, y2fmt, y2label, bandSeries }: {
  pts: TPt[]; t0: number; t1: number; color: string;
  band?: [number, number]; refs?: { y: number; color: string; dash?: boolean }[];
  trend?: boolean; events: Ev[]; showEvents: boolean; yfmt: (v: number) => string; innerW: number;
  pts2?: TPt[]; color2?: string; y2fmt?: (v: number) => string; y2label?: string;
  bandSeries?: { t: number; lo: number; hi: number }[];
}) {
  const { c } = useTheme();
  const ch = useThemedStyles(makeCh);
  const rightGutter = pts2 && pts2.length >= 2 ? 34 : 0;   // reserve room for the secondary (weight) axis labels
  const plotW = Math.max(1, innerW - TS_YW - rightGutter);
  const span = Math.max(1, t1 - t0);
  const [cur, setCur] = useState<number | null>(null);
  const mapRef = useRef<(lx: number) => number>(() => t0);
  mapRef.current = (lx) => t0 + (Math.max(0, Math.min(plotW, lx - TS_YW)) / plotW) * span;
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    // Claim horizontal drags in the CAPTURE phase so the parent ScrollView can't swallow them first
    // (the cause of the "sometimes unresponsive" scrub), and don't hand the gesture back once grabbed.
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > Math.abs(g.dy) && Math.abs(g.dx) > 4,
    onMoveShouldSetPanResponderCapture: (_e, g) => Math.abs(g.dx) > Math.abs(g.dy) && Math.abs(g.dx) > 4,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => setCur(mapRef.current(e.nativeEvent.locationX)),
    onPanResponderMove: (e) => setCur(mapRef.current(e.nativeEvent.locationX)),
  })).current;

  const win = pts.filter(p => p.t >= t0 && p.t <= t1).sort((a, b) => a.t - b.t);
  if (innerW <= 0) return <View style={{ height: TS_H + TX_H + 20 }} />;
  if (win.length < 2) return <View style={{ height: TS_H + TX_H, justifyContent: 'center', alignItems: 'center' }}><Text style={{ color: c.textFaint, fontSize: 12 }}>Fewer than 2 points in this range.</Text></View>;

  const bandWin = (bandSeries ?? []).filter(b => b.t >= t0 && b.t <= t1).sort((a, b) => a.t - b.t);
  const bandYs = bandWin.flatMap(b => [b.lo, b.hi]);
  const vals = win.map(p => p.v);
  const lo = Math.min(...vals, band ? band[0] : Infinity, ...(refs?.map(r => r.y) ?? []), ...(bandYs.length ? bandYs : [Infinity]));
  const hi = Math.max(...vals, band ? band[1] : -Infinity, ...(refs?.map(r => r.y) ?? []), ...(bandYs.length ? bandYs : [-Infinity]));
  const pad = (hi - lo) * 0.15 || 1, yLo = lo - pad, yHi = hi + pad;
  const x = (t: number) => ((t - t0) / span) * plotW;
  const toY = (v: number) => TS_H * (1 - (v - yLo) / (yHi - yLo));
  const yTicks = [yLo + (yHi - yLo) * 0.15, (yLo + yHi) / 2, yHi - (yHi - yLo) * 0.15];
  // Optional secondary series (e.g. body weight) — own scale, drawn faint, labelled on the right.
  const c2 = color2 ?? '#a855f7';
  const win2 = (pts2 ?? []).filter(p => p.t >= t0 && p.t <= t1).sort((a, b) => a.t - b.t);
  const has2 = win2.length >= 2;
  const v2 = win2.map(p => p.v);
  const lo2 = has2 ? Math.min(...v2) : 0, hi2 = has2 ? Math.max(...v2) : 1;
  const pad2 = (hi2 - lo2) * 0.15 || 1, y2Lo = lo2 - pad2, y2Hi = hi2 + pad2;
  const toY2 = (v: number) => TS_H * (1 - (v - y2Lo) / (y2Hi - y2Lo));
  const f2 = y2fmt ?? ((v: number) => v.toFixed(0));
  const near2 = has2 && cur != null ? win2.reduce((b, p) => Math.abs(p.t - cur) < Math.abs(b.t - cur) ? p : b, win2[0]) : (has2 ? win2[win2.length - 1] : null);
  const yearly = span > 2.2 * 365 * 86400000;
  const evIn = showEvents ? events.filter(e => e.t >= t0 && e.t <= t1) : [];
  const nearest = cur == null ? win[win.length - 1] : win.reduce((b, p) => Math.abs(p.t - cur) < Math.abs(b.t - cur) ? p : b, win[0]);
  const nearEv = cur != null ? evIn.map(e => ({ e, dx: Math.abs(x(e.t) - x(cur)) })).sort((a, b) => a.dx - b.dx)[0] : null;
  const readEv = nearEv && nearEv.dx < 12 ? nearEv.e : null;
  let trendEl: React.ReactNode = null;
  if (trend && win.length >= 3) {
    const n = win.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sx += i; sy += win[i].v; sxx += i * i; sxy += i * win[i].v; }
    const den = n * sxx - sx * sx;
    if (den) { const m = (n * sxy - sx * sy) / den, b0 = (sy - m * sx) / n;
      const x1 = x(win[0].t), y1 = toY(b0), x2 = x(win[n - 1].t), y2 = toY(b0 + m * (n - 1));
      const dx = x2 - x1, dy = y2 - y1, len = Math.sqrt(dx * dx + dy * dy), ang = Math.atan2(dy, dx) * 180 / Math.PI;
      trendEl = <View pointerEvents="none" style={{ position: 'absolute', left: (x1 + x2) / 2 - len / 2, top: (y1 + y2) / 2 - 1, width: len, height: 2, backgroundColor: c.textSub, opacity: 0.7, borderRadius: 1, transform: [{ rotate: `${ang}deg` }] }} />;
    }
  }
  return (
    <View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 2, marginBottom: 2 }}>
        <Text style={{ color: c.textSub, fontSize: 11.5, fontWeight: '700' }}>{dLabel(nearest.t, yearly)}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {readEv ? <Text style={{ color: EV_COLOR[readEv.category] ?? c.textSub, fontSize: 11.5, fontWeight: '700' }} numberOfLines={1}>{readEv.label}</Text>
                  : <Text style={{ color, fontSize: 13, fontWeight: '800' }}>{yfmt(nearest.v)}</Text>}
          {has2 && near2 && !readEv ? <Text style={{ color: c2, fontSize: 12, fontWeight: '700', marginLeft: 8 }}>{f2(near2.v)}{y2label ? ` ${y2label}` : ''}</Text> : null}
        </View>
      </View>
      <View style={{ flexDirection: 'row' }} pointerEvents="box-only" {...pan.panHandlers}>
        <View style={{ width: TS_YW, height: TS_H }}>
          {yTicks.map((t, i) => <Text key={i} style={[ch.yLabel, { position: 'absolute', top: Math.max(0, toY(t) - 7), right: 4 }]}>{yfmt(t)}</Text>)}
        </View>
        <View style={{ width: plotW, height: TS_H + TX_H, position: 'relative' }}>
          {yTicks.map((t, i) => <View key={`g${i}`} style={{ position: 'absolute', top: toY(t), left: 0, right: 0, height: 1, backgroundColor: c.gridline }} />)}
          {band && <View style={{ position: 'absolute', left: 0, right: 0, top: toY(band[1]), height: Math.max(1, toY(band[0]) - toY(band[1])), backgroundColor: '#22c55e18' }} />}
          {refs?.map((r, i) => <View key={`r${i}`} style={{ position: 'absolute', left: 0, right: 0, top: toY(r.y), height: 1, backgroundColor: r.color, opacity: r.dash ? 0.5 : 0.9 }} />)}
          {bandWin.map((b, i) => { const xL = x(b.t); const gap = (i < bandWin.length - 1 ? x(bandWin[i + 1].t) : xL + 3) - xL; const w = Math.min(Math.max(3, gap), plotW * 0.05); const top = toY(b.hi); return <View key={`bd${i}`} pointerEvents="none" style={{ position: 'absolute', left: xL - w / 2, top, width: Math.max(2, w), height: Math.max(1, toY(b.lo) - top), backgroundColor: '#3B82F61f' }} />; })}
          {evIn.map((e, i) => <View key={`e${i}`} pointerEvents="none" style={{ position: 'absolute', top: 0, height: TS_H, left: x(e.t), width: 1, backgroundColor: EV_COLOR[e.category] ?? c.textFaint, opacity: 0.5 }} />)}
          {has2 && win2.map((p, i) => { if (i === 0) return null; const x1 = x(win2[i - 1].t), y1 = toY2(win2[i - 1].v), x2 = x(p.t), y2 = toY2(p.v); const dx = x2 - x1, dy = y2 - y1, len = Math.sqrt(dx * dx + dy * dy), ang = Math.atan2(dy, dx) * 180 / Math.PI; return <View key={`s2${i}`} pointerEvents="none" style={{ position: 'absolute', left: (x1 + x2) / 2 - len / 2, top: (y1 + y2) / 2 - 1, width: len, height: 2, backgroundColor: c2, opacity: 0.5, borderRadius: 1, transform: [{ rotate: `${ang}deg` }] }} />; })}
          {win.map((p, i) => { if (i === 0) return null; const x1 = x(win[i - 1].t), y1 = toY(win[i - 1].v), x2 = x(p.t), y2 = toY(p.v); const dx = x2 - x1, dy = y2 - y1, len = Math.sqrt(dx * dx + dy * dy), ang = Math.atan2(dy, dx) * 180 / Math.PI; return <View key={`s${i}`} style={{ position: 'absolute', left: (x1 + x2) / 2 - len / 2, top: (y1 + y2) / 2 - 1, width: len, height: 2, backgroundColor: color, borderRadius: 1, transform: [{ rotate: `${ang}deg` }] }} />; })}
          {win.map((p, i) => <View key={`d${i}`} style={{ position: 'absolute', left: x(p.t) - 2.5, top: toY(p.v) - 2.5, width: 5, height: 5, borderRadius: 2.5, backgroundColor: p.color ?? color, borderWidth: 1, borderColor: c.surface }} />)}
          {trendEl}
          <View pointerEvents="none" style={{ position: 'absolute', left: x(nearest.t), top: 0, width: 1, height: TS_H, backgroundColor: color, opacity: 0.5 }} />
          <View pointerEvents="none" style={{ position: 'absolute', left: x(nearest.t) - 4, top: toY(nearest.v) - 4, width: 8, height: 8, borderRadius: 4, backgroundColor: color, borderWidth: 1.5, borderColor: c.surface }} />
          {[0, 1, 2, 3].map(i => { const t = t0 + (span * i) / 3; return <Text key={`x${i}`} style={[ch.xLabel, { position: 'absolute', top: TS_H + 4, width: 64, textAlign: i === 0 ? 'left' : i === 3 ? 'right' : 'center', left: i === 0 ? 0 : i === 3 ? plotW - 64 : x(t) - 32 }]} numberOfLines={1}>{dLabel(t, yearly)}</Text>; })}
        </View>
        {rightGutter > 0 && (
          <View style={{ width: rightGutter, height: TS_H }}>
            {has2 && [y2Hi - (y2Hi - y2Lo) * 0.15, (y2Lo + y2Hi) / 2, y2Lo + (y2Hi - y2Lo) * 0.15].map((vv, i) => <Text key={`y2l${i}`} pointerEvents="none" style={{ position: 'absolute', top: toY2(vv) - 7, left: 3, fontSize: 9.5, color: c2, fontWeight: '700', opacity: 0.9 }}>{f2(vv)}</Text>)}
          </View>
        )}
      </View>
    </View>
  );
}

// ─── Stacked intensity-mix over time: easy/moderate/hard SHARE per week ────────────────────────────
function StackedZoneChart({ weeks, t0, t1, events, showEvents, innerW }: {
  weeks: ZoneWeek[]; t0: number; t1: number; events: Ev[]; showEvents: boolean; innerW: number;
}) {
  const { c } = useTheme();
  const ch = useThemedStyles(makeCh);
  const plotW = Math.max(1, innerW - TS_YW);
  const span = Math.max(1, t1 - t0);
  const [cur, setCur] = useState<number | null>(null);
  const mapRef = useRef<(lx: number) => number>(() => t0);
  mapRef.current = (lx) => t0 + (Math.max(0, Math.min(plotW, lx - TS_YW)) / plotW) * span;
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    // Claim horizontal drags in the CAPTURE phase so the parent ScrollView can't swallow them first
    // (the cause of the "sometimes unresponsive" scrub), and don't hand the gesture back once grabbed.
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > Math.abs(g.dy) && Math.abs(g.dx) > 4,
    onMoveShouldSetPanResponderCapture: (_e, g) => Math.abs(g.dx) > Math.abs(g.dy) && Math.abs(g.dx) > 4,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => setCur(mapRef.current(e.nativeEvent.locationX)),
    onPanResponderMove: (e) => setCur(mapRef.current(e.nativeEvent.locationX)),
  })).current;

  const win = weeks.filter(w => w.total > 0 && w.t >= t0 - 4 * 86400000 && w.t <= t1);
  if (innerW <= 0) return <View style={{ height: TS_H + TX_H + 20 }} />;
  if (win.length < 1) return <View style={{ height: TS_H + TX_H, justifyContent: 'center', alignItems: 'center' }}><Text style={{ color: c.textFaint, fontSize: 12 }}>No zone data in this range.</Text></View>;
  const yearly = span > 2.2 * 365 * 86400000;
  const x = (t: number) => ((t - t0) / span) * plotW;
  const barW = Math.max(3, Math.min(28, (plotW / Math.max(1, win.length)) * 0.7));
  const evIn = showEvents ? events.filter(e => e.t >= t0 && e.t <= t1) : [];
  const nearest = cur == null ? win[win.length - 1] : win.reduce((b, w) => Math.abs(w.t - cur) < Math.abs(b.t - cur) ? w : b, win[0]);
  const pctOf = (w: ZoneWeek) => ({ easy: Math.round(w.easyMin / w.total * 100), mod: Math.round(w.modMin / w.total * 100), hard: Math.round(w.hardMin / w.total * 100) });
  const np = pctOf(nearest);
  return (
    <View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 2, marginBottom: 2 }}>
        <Text style={{ color: c.textSub, fontSize: 11.5, fontWeight: '700' }}>wk {dLabel(nearest.t, yearly)}</Text>
        <Text style={{ fontSize: 12, fontWeight: '800' }}><Text style={{ color: '#22c55e' }}>{np.easy}% </Text><Text style={{ color: '#f59e0b' }}>{np.mod}% </Text><Text style={{ color: '#ef4444' }}>{np.hard}%</Text><Text style={{ color: c.textFaint, fontWeight: '600' }}> · {nearest.total}m</Text></Text>
      </View>
      <View style={{ flexDirection: 'row' }} pointerEvents="box-only" {...pan.panHandlers}>
        <View style={{ width: TS_YW, height: TS_H }}>
          {[0, 50, 100].map((p, i) => <Text key={i} style={[ch.yLabel, { position: 'absolute', top: Math.max(0, TS_H * (1 - p / 100) - 7), right: 4 }]}>{p}%</Text>)}
        </View>
        <View style={{ width: plotW, height: TS_H + TX_H, position: 'relative' }}>
          {evIn.map((e, i) => <View key={`e${i}`} pointerEvents="none" style={{ position: 'absolute', top: 0, height: TS_H, left: x(e.t), width: 1, backgroundColor: EV_COLOR[e.category] ?? c.textFaint, opacity: 0.5 }} />)}
          {win.map((w, i) => {
            const p = pctOf(w); const left = x(w.t) - barW / 2;
            const hH = TS_H * p.hard / 100, mH = TS_H * p.mod / 100, eH = TS_H - hH - mH;
            return (
              <View key={i} style={{ position: 'absolute', left, top: 0, width: barW, height: TS_H }}>
                <View style={{ height: hH, backgroundColor: '#ef4444', opacity: 0.9 }} />
                <View style={{ height: mH, backgroundColor: '#f59e0b', opacity: 0.9 }} />
                <View style={{ height: eH, backgroundColor: '#22c55e', opacity: 0.9 }} />
              </View>
            );
          })}
          <View pointerEvents="none" style={{ position: 'absolute', left: x(nearest.t), top: 0, width: 1, height: TS_H, backgroundColor: c.text, opacity: 0.35 }} />
          {[0, 1, 2, 3].map(i => { const t = t0 + (span * i) / 3; return <Text key={`x${i}`} style={[ch.xLabel, { position: 'absolute', top: TS_H + 4, width: 64, textAlign: i === 0 ? 'left' : i === 3 ? 'right' : 'center', left: i === 0 ? 0 : i === 3 ? plotW - 64 : x(t) - 32 }]} numberOfLines={1}>{dLabel(t, yearly)}</Text>; })}
        </View>
      </View>
    </View>
  );
}

// Weekly VOLUME vs its +cap% CEILING, as a scrubbable bar chart (replaces the old standalone list screen).
// Each week: a faint track up to the ceiling with a cap line on top, and a coloured bar for what was actually
// run (green ≥90% of ceiling / amber ≥70% / red under; grey = the in-progress week). Same scrub + range
// machinery as the other charts, so it moves with the shared time window.
function VolumeBudgetChart({ weeks, t0, t1, innerW }: { weeks: CapWeek[]; t0: number; t1: number; innerW: number }) {
  const { c } = useTheme();
  const ch = useThemedStyles(makeCh);
  const plotW = Math.max(1, innerW - TS_YW);
  const span = Math.max(1, t1 - t0);
  const [cur, setCur] = useState<number | null>(null);
  const mapRef = useRef<(lx: number) => number>(() => t0);
  mapRef.current = (lx) => t0 + (Math.max(0, Math.min(plotW, lx - TS_YW)) / plotW) * span;
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > Math.abs(g.dy) && Math.abs(g.dx) > 4,
    onMoveShouldSetPanResponderCapture: (_e, g) => Math.abs(g.dx) > Math.abs(g.dy) && Math.abs(g.dx) > 4,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => setCur(mapRef.current(e.nativeEvent.locationX)),
    onPanResponderMove: (e) => setCur(mapRef.current(e.nativeEvent.locationX)),
  })).current;

  const win = weeks.map(w => ({ ...w, t: tOf(w.weekStart) }))
    .filter(w => w.t >= t0 - 4 * 86400000 && w.t <= t1 && (w.actualMin > 0 || w.ceilingMin > 0));
  if (innerW <= 0) return <View style={{ height: TS_H + TX_H + 20 }} />;
  if (win.length < 1) return <View style={{ height: TS_H + TX_H, justifyContent: 'center', alignItems: 'center' }}><Text style={{ color: c.textFaint, fontSize: 12 }}>No volume data in this range.</Text></View>;
  const yearly = span > 2.2 * 365 * 86400000;
  const x = (t: number) => ((t - t0) / span) * plotW;
  const barW = Math.max(3, Math.min(26, (plotW / Math.max(1, win.length)) * 0.7));
  const maxV = Math.max(60, ...win.flatMap(w => [w.ceilingMin, w.actualMin]));
  const col = (hit: number, isCur: boolean) => isCur ? c.textFaint : hit >= 90 ? '#22c55e' : hit >= 70 ? '#f59e0b' : '#ef4444';
  const n = cur == null ? win[win.length - 1] : win.reduce((b, w) => Math.abs(w.t - cur) < Math.abs(b.t - cur) ? w : b, win[0]);
  return (
    <View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 2, marginBottom: 2 }}>
        <Text style={{ color: c.textSub, fontSize: 11.5, fontWeight: '700' }} numberOfLines={1}>
          {n.label}{n.isCurrent ? ' • now' : ''}{n.phase ? ` · ${n.phase}` : ''}
        </Text>
        <Text style={{ fontSize: 12, fontWeight: '800', color: c.text }}>
          {n.actualMin}/{n.ceilingMin}m · <Text style={{ color: n.isCurrent ? c.textFaint : col(n.hitPct, false) }}>{n.isCurrent ? 'in progress' : `${n.hitPct}%`}</Text>
          {n.heatTaxPct >= 3 ? <Text style={{ color: '#f59e0b' }}> 🌡+{n.heatTaxPct}%</Text> : null}
        </Text>
      </View>
      <View style={{ flexDirection: 'row' }} pointerEvents="box-only" {...pan.panHandlers}>
        <View style={{ width: TS_YW, height: TS_H }}>
          {[0, maxV / 2, maxV].map((v, i) => <Text key={i} style={[ch.yLabel, { position: 'absolute', top: Math.max(0, TS_H * (1 - v / maxV) - 7), right: 4 }]}>{Math.round(v)}</Text>)}
        </View>
        <View style={{ width: plotW, height: TS_H + TX_H, position: 'relative' }}>
          {win.map((w, i) => {
            const left = x(w.t) - barW / 2;
            const ceilH = TS_H * Math.min(1, w.ceilingMin / maxV);
            const actH = TS_H * Math.min(1, w.actualMin / maxV);
            return (
              <View key={i} style={{ position: 'absolute', left, top: 0, width: barW, height: TS_H }}>
                <View style={{ position: 'absolute', bottom: 0, width: barW, height: ceilH, backgroundColor: c.gridline, borderTopWidth: 1.5, borderTopColor: c.border }} />
                <View style={{ position: 'absolute', bottom: 0, width: barW, height: actH, backgroundColor: col(w.hitPct, w.isCurrent), opacity: w.isCurrent ? 0.55 : 0.95 }} />
              </View>
            );
          })}
          <View pointerEvents="none" style={{ position: 'absolute', left: x(n.t), top: 0, width: 1, height: TS_H, backgroundColor: c.text, opacity: 0.35 }} />
          {[0, 1, 2, 3].map(i => { const t = t0 + (span * i) / 3; return <Text key={`x${i}`} style={[ch.xLabel, { position: 'absolute', top: TS_H + 4, width: 64, textAlign: i === 0 ? 'left' : i === 3 ? 'right' : 'center', left: i === 0 ? 0 : i === 3 ? plotW - 64 : x(t) - 32 }]} numberOfLines={1}>{dLabel(t, yearly)}</Text>; })}
        </View>
      </View>
    </View>
  );
}

// The two "right now" gauges (this calendar week Mon→now, and the rolling trailing 7 days) — the old screen's
// top card, moved BELOW the long-term chart per Geert. Compact horizontal actual/ceiling meters.
function RightNowBars({ curWeek, roll }: { curWeek: CapWeek | null; roll: Rolling7d | null }) {
  const ch = useThemedStyles(makeCh);
  const col = (pct: number) => pct >= 90 ? '#22c55e' : pct >= 70 ? '#f59e0b' : '#ef4444';
  if (!curWeek && !roll) return null;
  const Row = ({ label, actual, ceiling, pct }: { label: string; actual: number; ceiling: number; pct: number }) => (
    <View style={ch.rnRow}>
      <Text style={ch.rnLbl}>{label}</Text>
      <View style={ch.rnTrack}><View style={[ch.rnFill, { width: `${Math.min(100, pct)}%`, backgroundColor: col(pct) }]} /></View>
      <Text style={ch.rnNum}>{actual}/{ceiling}m · {pct}%</Text>
    </View>
  );
  return (
    <View style={ch.rnCard}>
      <Text style={ch.rnTitle}>Right now</Text>
      {curWeek && <Row label={'This week\n(Mon→now)'} actual={curWeek.actualMin} ceiling={curWeek.ceilingMin} pct={curWeek.hitPct} />}
      {roll && <Row label={'Rolling\n7 days'} actual={roll.actualMin} ceiling={roll.ceilingMin} pct={roll.hitPct} />}
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
      <Text style={s.zone3Txt} numberOfLines={1}>
        🟢 {z.easyPct}%  ·  🟠 {z.modPct}%  ·  🔴 {z.hardPct}%  ·  {z.minutes} min  ·  PI {z.polarizationIndex.toFixed(2)}
      </Text>
    </View>
  );
}

// ─── Weekly TSS bars (TrainingPeaks training-load view) ──────────────────────────
function WeeklyTssBars({ runs, t0, t1 }: { runs: any[]; t0: number; t1: number }) {
  const { c } = useTheme();
  const weeks = useMemo(() => {
    const monday = (ms: number) => { const d = new Date(ms); const off = (d.getDay() + 6) % 7; d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - off); return d.getTime(); };
    const m = new Map<number, number>();
    for (const r of runs) {
      const t = new Date(r.date).getTime();
      if (t < t0 || t > t1) continue;
      const tss = r.tss ?? 0;
      if (tss > 0) { const wk = monday(t); m.set(wk, (m.get(wk) ?? 0) + tss); }
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]).slice(-16).map(([wk, tss]) => ({ wk, tss: Math.round(tss) }));
  }, [runs, t0, t1]);

  if (!weeks.length) return <Text style={{ color: c.textFaint, fontSize: 12, textAlign: 'center', paddingVertical: 16 }}>No power-based TSS yet — set your power zones, then Rebuild history.</Text>;

  const max = Math.max(...weeks.map(w => w.tss), 1);
  const avg = Math.round(weeks.reduce((a, w) => a + w.tss, 0) / weeks.length);
  const n = weeks.length;
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 116, gap: 3, marginTop: 6 }}>
        {weeks.map((w, i) => (
          <View key={w.wk} style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end' }}>
            {(w.tss >= max * 0.55 || i === n - 1) ? <Text style={{ fontSize: 8, color: c.textSub, marginBottom: 2 }}>{w.tss}</Text> : null}
            <View style={{ width: '72%', height: Math.max(2, (w.tss / max) * 96), backgroundColor: i === n - 1 ? c.accent : c.accent + '99', borderRadius: 2 }} />
          </View>
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: 3, marginTop: 3 }}>
        {weeks.map((w, i) => (
          <Text key={w.wk} style={{ flex: 1, fontSize: 7.5, color: c.textFaint, textAlign: 'center' }} numberOfLines={1}>
            {(i === 0 || i === n - 1 || i === Math.floor(n / 2)) ? new Date(w.wk).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''}
          </Text>
        ))}
      </View>
      <Text style={{ fontSize: 11, color: c.textSub, marginTop: 8 }}>{n}-week avg {avg} TSS/wk · latest {weeks[n - 1].tss}</Text>
    </View>
  );
}

// ─── Race predictor (CP + economy + Riegel) ──────────────────────────────────────
function RacePredictorCard({ curve, runs }: { curve: PowerCurve | null; runs: any[] }) {
  const { c } = useTheme();
  const pred = useMemo(() => (curve ? predictRaces(curve.cp, medianEcFromRuns(runs)) : null), [curve, runs]);

  if (!curve?.cp) return <Text style={{ color: c.textFaint, fontSize: 12, textAlign: 'center', paddingVertical: 14 }}>Do a few hard 3–12 min efforts with power so Critical Power can be estimated first.</Text>;
  if (!pred)      return <Text style={{ color: c.textFaint, fontSize: 12, textAlign: 'center', paddingVertical: 14 }}>Not enough measured-power runs yet to predict paces.</Text>;

  return (
    <View>
      <View style={{ flexDirection: 'row', paddingBottom: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border }}>
        <Text style={{ flex: 1.2, color: c.textSub, fontSize: 11, fontWeight: '700' }}>Distance</Text>
        <Text style={{ flex: 1, color: c.textSub, fontSize: 11, fontWeight: '700', textAlign: 'right' }}>Time</Text>
        <Text style={{ flex: 1, color: c.textSub, fontSize: 11, fontWeight: '700', textAlign: 'right' }}>Pace</Text>
      </View>
      {pred.races.map(r => (
        <View key={r.name} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border }}>
          <Text style={{ flex: 1.2, color: c.text, fontSize: 14, fontWeight: '600' }}>{r.name}</Text>
          <Text style={{ flex: 1, color: c.text, fontSize: 16, fontWeight: '700', textAlign: 'right' }}>{fmtRaceTime(r.timeSec)}</Text>
          <Text style={{ flex: 1, color: c.textSub, fontSize: 13, textAlign: 'right' }}>{fmtRacePace(r.paceSec)}/km</Text>
        </View>
      ))}
      <Text style={{ color: c.textFaint, fontSize: 11, lineHeight: 16, marginTop: 10 }}>
        Anchored on CP {curve.cp} W (≈ threshold pace {fmtRacePace(pred.thresholdPaceSec)}/km). Target paces are
        even splits — run the first km ~2–3 s/km easier and negative-split from there.
      </Text>
    </View>
  );
}

// ─── Drag-to-reorder card list (Customise sheet) ───────────────────────────────
// Self-contained: PanResponder + Animated only (no gesture-handler/reanimated dep). Rows are
// absolutely positioned at index·ROW_H; dragging one drives its `top` from the finger while the
// others animate to their shifted slots. Grip (≡) owns the pan so the Switch stays independently
// tappable. Order is committed to the parent on release; toggles commit immediately.
const REORDER_ROW_H = 54;

function ReorderList({ items, onCommit }: { items: StatCard[]; onCommit: (next: StatCard[]) => void }) {
  const rs = useThemedStyles(makeReorder);
  const [order, setOrder] = useState<StatCard[]>(items);
  // Re-seed only when the incoming set genuinely differs (ignores our own committed round-trips,
  // which are byte-identical to the internal order and would otherwise fight an in-flight drag).
  useEffect(() => {
    setOrder(prev => {
      const same = prev.length === items.length && prev.every((p, i) => p.id === items[i].id && p.on === items[i].on);
      return same ? prev : items;
    });
  }, [items]);

  const orderRef = useRef(order);
  orderRef.current = order;

  const tops = useRef(new Map<StatCardId, Animated.Value>()).current;
  order.forEach((it, i) => { if (!tops.has(it.id)) tops.set(it.id, new Animated.Value(i * REORDER_ROW_H)); });

  const [dragId, setDragId] = useState<StatCardId | null>(null);
  const dragStartY = useRef(0);   // dragged row's slot-Y at grab; its live Y = this + gesture dy (index-independent)

  const settle = (arr: StatCard[], exceptId?: StatCardId) => {
    arr.forEach((it, i) => {
      if (it.id === exceptId) return;
      Animated.timing(tops.get(it.id)!, { toValue: i * REORDER_ROW_H, duration: 140, useNativeDriver: false }).start();
    });
  };
  const drop = (id: StatCardId) => {
    const arr = orderRef.current;
    const idx = arr.findIndex(x => x.id === id);
    if (idx >= 0) Animated.timing(tops.get(id)!, { toValue: idx * REORDER_ROW_H, duration: 140, useNativeDriver: false }).start();
    setDragId(null);
    onCommit(arr);
  };

  // One PanResponder per id, created once and reused across renders.
  const responders = useRef(new Map<StatCardId, ReturnType<typeof PanResponder.create>>()).current;
  order.forEach(it => {
    if (responders.has(it.id)) return;
    const id = it.id;
    responders.set(id, PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,   // win the touch on the grip before any ancestor
      onMoveShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      onPanResponderTerminationRequest: () => false,     // don't yield the drag once it has started
      onPanResponderGrant: () => {
        dragStartY.current = orderRef.current.findIndex(x => x.id === id) * REORDER_ROW_H;
        setDragId(id);
      },
      onPanResponderMove: (_e, g) => {
        // Live Y is anchored to the grab slot + gesture delta — NOT the row's live index, which changes
        // as we reorder. Recomputing from the live index would snap the row a whole slot on each swap.
        const y = dragStartY.current + g.dy;
        tops.get(id)!.setValue(y);
        const arr = orderRef.current;
        const cur = arr.findIndex(x => x.id === id);
        let to = Math.round(y / REORDER_ROW_H);
        to = Math.max(0, Math.min(arr.length - 1, to));
        if (cur >= 0 && to !== cur) {
          const next = arr.slice();
          const [moved] = next.splice(cur, 1);
          next.splice(to, 0, moved);
          orderRef.current = next;
          setOrder(next);
          settle(next, id);  // dragged row stays under the finger; the rest slide
        }
      },
      onPanResponderRelease: () => drop(id),
      onPanResponderTerminate: () => drop(id),
    }));
  });

  const toggle = (id: StatCardId) => {
    const next = orderRef.current.map(x => x.id === id ? { ...x, on: !x.on } : x);
    orderRef.current = next;
    setOrder(next);
    onCommit(next);
  };

  return (
    <View style={{ height: order.length * REORDER_ROW_H }}>
      {order.map(it => {
        const dragging = dragId === it.id;
        return (
          <Animated.View
            key={it.id}
            style={[rs.row, { height: REORDER_ROW_H, transform: [{ translateY: tops.get(it.id)! }], zIndex: dragging ? 10 : 1, elevation: dragging ? 6 : 0 }, dragging && rs.rowDragging]}
          >
            <View {...responders.get(it.id)!.panHandlers} style={rs.grip}>
              <Text style={rs.gripDots}>≡</Text>
            </View>
            <Text style={[rs.label, !it.on && rs.labelOff]} numberOfLines={1}>{STAT_CARD_TITLES[it.id]}</Text>
            <Switch value={it.on} onValueChange={() => toggle(it.id)} />
          </Animated.View>
        );
      })}
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
  const [stepMsg, setStepMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [innerW, setInnerW] = useState(0);
  const [pz, setPz] = useState<PowerZones | undefined>(undefined);
  const [ef, setEf] = useState<EfPoint[]>([]);
  const [zones, setZones] = useState<ZoneSummary | null>(null);
  const [acwr, setAcwr] = useState<AcwrPoint[]>([]);
  const [dc, setDc] = useState<DecouplePoint[] | null>(null);
  const [dcProg, setDcProg] = useState<{ done: number; total: number } | null>(null);
  const [allRuns, setAllRuns] = useState<any[]>([]);
  const [maxHR, setMaxHR] = useState(188);
  const [wt, setWt] = useState<TPt[]>([]);   // body-weight overlay for the EC chart
  const [repairs, setRepairs] = useState<Record<string, RepairedWork | null>>({});
  const [events, setEvents] = useState<Ev[]>([]);
  const [range, setRange] = useState<Range>('1Y');
  const [offset, setOffset] = useState(0);
  const [showEvents, setShowEvents] = useState(false);

  const build = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const snap = await loadSnapshotCache();
      getPowerZones().then(setPz).catch(() => {});
      // The snapshot only holds ~3 months of runs and a startup scan overwrites it back to that window, so
      // merge in the durable stats-runs cache (full history from a past deep-load) and persist the union —
      // snapshot wins per-uuid (fresh work stats), older runs beyond the window are retained. History never shrinks.
      const snapRuns = (snap as any)?.runs ?? [];
      const runs = mergeRuns(snapRuns, await loadStatsRuns());
      if (runs.length) saveStatsRuns(runs);   // persist the union so history survives the next startup scan
      setAllRuns(runs);
      setMaxHR((snap as any)?.estimatedMaxHR || 188);
      if (!runs.length) { setError('No runs found. Record some runs with power, then check back.'); setLoading(false); return; }
      // Cheap snapshot-derived series first (instant).
      setEf(efficiencyTrend(runs));
      // Stationary-time repair (needs a detail fetch per run, cached by uuid) — re-derives work stats over
      // running-only seconds so a phone-call run keeps a CORRECT point instead of being discarded.
      repairWorkStats(runs)
        .then(rep => { setRepairs(rep); setEf(efficiencyTrend(runs, rep)); })
        .catch(() => {});
      setZones(zoneSummary(runs, 56, (snap as any)?.estimatedMaxHR || 188));
      setAcwr(acwrSeries((snap as any)?.trainingLoad ?? []));   // instant, short (~45d) — replaced below
      // Full-history CTL/ATL for ACWR (snapshot only holds ~45d), + body-weight overlay for the EC chart.
      fetchTrainingLoadHistory(24).then(load => setAcwr(acwrSeries(load))).catch(() => {});
      fetchBodyMassHistory(24).then(w => setWt((w ?? []).filter(p => p.value > 0).map(p => ({ t: tOf(p.date), v: p.value })))).catch(() => {});
      // Power curve (fetches run detail with progress).
      const cur = await computePowerCurve(runs, (done, total) => setProgress({ done, total }));
      if (cur.points.length < 2) setError('Not enough running-power data yet to draw a curve.');
      setCurve(cur);
      // Decoupling last (also fetches detail, but only long aerobic runs → fewer).
      decouplingTrend(runs, (done, total) => setDcProg({ done, total }))
        .then(d => { setDc(d); setDcProg(null); })
        .catch(() => { setDc([]); setDcProg(null); });
    } catch (e: any) {
      setError(e?.message ?? 'Could not build the statistics.');
    } finally { setLoading(false); setProgress(null); }
  }, []);

  // Deep rebuild: the normal snapshot only holds ~3 months of runs, so the charts look "cut off" on
  // longer ranges. Pull the full multi-year run history (≤24mo) into the snapshot cache, then rebuild.
  const rebuildDeep = useCallback(async () => {
    setLoading(true); setError(null); setStepMsg('Reading full history…');
    try {
      // Clear the per-run analysis cache so EVERY run is re-fetched — otherwise cached old runs
      // keep their sparse-HR values and never pick up the HKQuantitySeries expansion.
      await clearWorkoutCache();
      const snap = await fetchHealthSnapshot({ months: 24, light: false, onProgress: (step, pct) => setStepMsg(`${step} ${pct}%`) });
      await saveSnapshotCache(snap);
      await saveStatsRuns(mergeRuns((snap as any).runs ?? [], await loadStatsRuns()));   // seed durable history
      await clearPowerCurveCache();
      await clearWorkStatsRepairCache();
    } catch (e: any) {
      setError(e?.message ?? 'Could not load full history.'); setLoading(false); setStepMsg(null); return;
    }
    setStepMsg(null);
    await build();
  }, [build]);

  useEffect(() => { build(); }, [build]);
  useEffect(() => { loadEvents().then(list => setEvents(
    list.filter((e: any) => e.type === 'event' && (e.category === 'medical' || e.category === 'life'))
      .map((e: any) => ({ t: tOf(e.date), label: e.title || e.category, category: e.category })))).catch(() => {}); }, []);
  useEffect(() => { setOffset(0); }, [range]);

  // Shared time window (all charts move together), anchored to the newest data point across the series.
  const [gMin, gMax] = useMemo(() => {
    const ts = [...ef.map(p => tOf(p.date)), ...acwr.map(p => tOf(p.date)), ...(dc ?? []).map(p => tOf(p.date))];
    if (!ts.length) return [Date.now() - 365 * 86400000, Date.now()];
    // Extend the RIGHT edge to the latest body-weight sample too: a weigh-in on a day with no run (today on a
    // rest day) sits past the last-run date, so without this it's clipped off the EC chart's weight overlay.
    const wMax = wt.length ? Math.max(...wt.map(p => p.t)) : 0;
    return [Math.min(...ts), Math.max(Math.max(...ts), wMax)];
  }, [ef, acwr, dc, wt]);
  const days = RANGE_DAYS[range];
  const spanMs = days ? days * 86400000 : Math.max(1, gMax - gMin);
  const t1 = days ? gMax - offset * spanMs : gMax;
  const t0 = days ? t1 - spanMs : gMin;
  const zoneWeeks = useMemo(() => zoneDistributionOverTime(allRuns, 0, gMax + 86400000, maxHR), [allRuns, gMax, maxHR]);
  // Volume-vs-budget weekly history (moved in from the old standalone screen). Fetch enough weeks to fill the
  // window (ending at t1 so it pages with the shared controls); the "right now" gauges are always live.
  const [capWeeks, setCapWeeks] = useState<CapWeek[]>([]);
  const [roll, setRoll] = useState<Rolling7d | null>(null);
  const [nowWeek, setNowWeek] = useState<CapWeek | null>(null);
  // Customise sheet: which cards show, in what order (persisted). Reorder is drag-based (ReorderList).
  const [layout, setLayout] = useState<StatCard[]>(DEFAULT_STATS_LAYOUT);
  const [customising, setCustomising] = useState(false);
  useEffect(() => { loadStatsLayout().then(setLayout); }, []);
  const commitLayout = useCallback((next: StatCard[]) => { setLayout(next); saveStatsLayout(next); }, []);
  // Performance (GPI) — moved here from the home screen as a compact card. Compute the full 12-month series
  // once (fixed baseline) from the loaded runs; the emphasis weighting mirrors the full /performance screen.
  const [gpi, setGpi] = useState<GpiResult | null>(null);
  const [gpiEmphasis, setGpiEmphasis] = useState<Emphasis>('performance');
  useEffect(() => { SecureStore.getItemAsync('gpi_emphasis_v1').then(v => { if (v && v in WEIGHT_PRESETS) setGpiEmphasis(v as Emphasis); }).catch(() => {}); }, []);
  useEffect(() => {
    if (!allRuns.length) return;
    let alive = true;
    computePerformanceIndex(12, undefined, allRuns).then(r => { if (alive) setGpi(r); }).catch(() => {});
    return () => { alive = false; };
  }, [allRuns]);
  const gpiView = useMemo(() => {
    if (!gpi?.series?.length) return null;
    const w = WEIGHT_PRESETS[gpiEmphasis];
    const all = gpi.series.map(p => ({ date: p.date, gpi: weightedGpi(p, w) }));
    const latest = [...all].reverse().find(p => p.gpi != null) ?? null;
    const win = all.filter(p => p.gpi != null && tOf(p.date) >= t0 && tOf(p.date) <= t1);
    const first = win[0] ?? null;
    const delta = latest?.gpi != null && first?.gpi != null ? latest.gpi - first.gpi : null;
    // GPI is a DAILY series (up to 365 pts for 1Y). TChart draws a View per segment+dot, so downsample to
    // ≤60 (it's already a 7-day smoothed line — weekly-ish sampling loses nothing and keeps the card light).
    const raw = win.map(p => ({ t: tOf(p.date), v: p.gpi! }));
    const step = Math.max(1, Math.ceil(raw.length / 60));
    const pts = raw.filter((_, i) => i % step === 0 || i === raw.length - 1);
    return { latest, delta, pts };
  }, [gpi, gpiEmphasis, t0, t1]);
  const capWeeksN = days > 0 ? Math.min(120, Math.ceil(days / 7) + 3) : 104;
  useEffect(() => {
    let alive = true;
    // t1 = the newest CHART-SERIES point (last run WITH power / steady decoupling run / weigh-in), which can
    // lag real "now" when the most recent day only added minutes the series doesn't see (a run without power,
    // a walk). Anchoring the in-progress week to t1 then truncates it there and it under-reports vs the live
    // "This week (Mon→now)" gauge (which counts all activity to now). So on the LIVE view (offset 0) anchor to
    // now; only paged-back windows (offset > 0) anchor to their past end t1.
    const capAnchor = offset === 0 ? new Date() : new Date(t1);
    computeCapHistory(capWeeksN, capAnchor).then(w => { if (alive) setCapWeeks(w); }).catch(() => { if (alive) setCapWeeks([]); });
    return () => { alive = false; };
  }, [capWeeksN, t1, offset]);
  // The two "right now" gauges are always LIVE (independent of the paged/zoomed window above).
  useEffect(() => {
    computeRolling7d().then(setRoll).catch(() => {});
    computeCapHistory(1).then(w => setNowWeek(w.find(x => x.isCurrent) ?? w[w.length - 1] ?? null)).catch(() => {});
  }, []);
  // Moving "normal aerobic efficiency" band + the runs that survive its cut + a stable recent-median read.
  const { dcClean, dcBand, dcMed } = useMemo(() => {
    const { clean, band } = decouplingBanded(dc ?? []);
    const recent = clean.slice(-8).map(p => p.pct).sort((a, b) => a - b);
    const med = recent.length ? recent[Math.floor(recent.length / 2)] : null;
    return { dcClean: clean, dcBand: band.map(b => ({ t: tOf(b.date), lo: b.lo, hi: b.hi })), dcMed: med };
  }, [dc]);
  const monthYear = (t: number) => new Date(t).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });

  // Measured on the ScrollView (stable) rather than a single card, so it survives the user disabling or
  // reordering any card via Customise. Subtract the scroll padding (12·2) AND the card padding (12·2).
  const onLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width - 48;
    if (Math.abs(w - innerW) > 1) setInnerW(w);
  };

  // Each card keyed by id → rendered in the user's chosen order/enabled set (Customise sheet).
  const cardNodes: Record<StatCardId, React.ReactNode> = {
    performance: (
      <View style={s.card}>
        <CardHead title="Performance">
          Your overall trajectory — recovery, sleep &amp; training folded into one line, each vs your own
          baseline (50 = your starting point; above = improved). Tap for the full breakdown.
        </CardHead>
        {gpiView?.latest?.gpi == null ? (
          <View style={s.center}><ActivityIndicator /></View>
        ) : (
          <>
            <TouchableOpacity style={s.perfHead} activeOpacity={0.7} onPress={() => router.push('/performance' as any)}>
              <Text style={[s.perfNum, { color: GPI_COLOR }]}>{Math.round(gpiView.latest.gpi!)}</Text>
              <View style={{ flex: 1 }}>
                <Text style={s.perfWord}>Performance · {gpiLevelWord(gpiView.latest.gpi!)}</Text>
                {gpiView.delta != null && (
                  <Text style={[s.perfDelta, { color: gpiView.delta >= 0 ? '#22c55e' : '#ef4444' }]}>
                    {gpiView.delta >= 0 ? '▲' : '▼'} {Math.abs(gpiView.delta).toFixed(1)} over range
                  </Text>
                )}
              </View>
              <Text style={s.perfChevron}>›</Text>
            </TouchableOpacity>
            {gpiView.pts.length >= 2 && (
              <TChart innerW={innerW} t0={t0} t1={t1} color={GPI_COLOR} events={events} showEvents={showEvents}
                refs={[{ y: 50, color: '#94a3b8', dash: true }]} yfmt={(v) => String(Math.round(v))}
                pts={gpiView.pts} />
            )}
          </>
        )}
      </View>
    ),
    weeklyTss: (
      <View style={s.card}>
        <CardHead title="Weekly TSS">
          Training load per week — TrainingPeaks Training Stress Score (power-based), summed across each
          week's runs. Rising = building; a drop = a recovery/taper week or time off.
        </CardHead>
        {loading ? <View style={s.center}><ActivityIndicator /></View> : <WeeklyTssBars runs={allRuns} t0={t0} t1={t1} />}
      </View>
    ),
    pdc: (
      <View style={s.card}>
        <CardHead title="Power–Duration Curve">
          Best average running power you've held for each duration, across your runs.
          {curve ? ` From ${curve.runsUsed} runs with power. Shaded band = your current threshold zone (Z4). A fed, paced 20-min test refines the long end of this curve.` : ''}
          {curve?.cp != null ? ' Critical Power = estimated sustainable power (3+12-min bests).' : ''}
          {pz && pz.tempoMax > 0 ? ` Your set threshold band is ${pz.tempoMax}–${pz.intervalsMin} W (shaded).` : ''}
        </CardHead>
        {loading ? (
          <View style={s.center}>
            <ActivityIndicator size="large" color={CTL_BLUE} />
            <Text style={s.loadingText}>
              {stepMsg ?? (progress && progress.total > 0 ? `Reading runs… ${progress.done}/${progress.total}` : 'Loading…')}
            </Text>
          </View>
        ) : error ? (
          <Text style={s.errorText}>{error}</Text>
        ) : curve ? (
          <>
            <PdcChart curve={curve} innerW={innerW} pz={pz} />
            {curve.cp != null && (
              <Text style={s.cpLine}>
                Critical Power <Text style={s.cpLineVal}>{curve.cp} W</Text>
                {curve.wPrime ? `   ·   W′ ${(curve.wPrime / 1000).toFixed(1)} kJ` : ''}
              </Text>
            )}
            <TouchableOpacity style={s.rebuild} onPress={rebuildDeep}>
              <Text style={s.rebuildText}>↻ Rebuild + load full history</Text>
            </TouchableOpacity>
          </>
        ) : null}
      </View>
    ),
    race: !loading ? (
      <View style={s.card}>
        <CardHead title="Race Predictor">
          Current fresh-legs race times from your Critical Power + running economy, scaled across
          distances with Riegel. A guide to your fitness — not a goal; TSB, heat, terrain & fueling move it.
        </CardHead>
        <RacePredictorCard curve={curve} runs={allRuns} />
      </View>
    ) : null,
    ef: ef.filter(p => p.ef > 0).length >= 2 ? (() => { const p = ef.filter(x => x.ef > 0); return (
      <View style={s.card}>
        <CardHead title="Efficiency Factor">
          Power ÷ HR per run. Rising = a better aerobic engine, even if CTL looks flat.
          {' '}Grey line = trend. Green = steady aerobic runs. Latest {p[p.length - 1].ef.toFixed(2)}
          {p.filter(x => x.aerobic).length >= 2 ? ((): string => {
            const a = p.filter(x => x.aerobic); const d = a[a.length - 1].ef - a[0].ef;
            return `  ·  aerobic EF ${d >= 0 ? '+' : ''}${(d).toFixed(2)} over the window (${d >= 0 ? 'improving' : 'down'}).`;
          })() : ''}
          {p.some(x => x.hot) ? `  🟠 = run ≥${HEAT_C}°C — heat lifts HR, so those sit LOW for reasons other than fitness.` : ''}
          {tempTrace(p).length >= 2 ? '  The orange line is run-time temperature (right axis, smoothed) — dips here that track it upward are weather, not lost fitness.' : ''}
        </CardHead>
        <TChart innerW={innerW} t0={t0} t1={t1} color={CTL_BLUE} events={events} showEvents={showEvents} trend yfmt={(v) => v.toFixed(2)}
          pts={p.map(x => ({ t: tOf(x.date), v: x.ef, color: x.hot ? HEAT_ORANGE : x.aerobic ? '#22c55e' : '#cbd5e1' }))}
          pts2={tempTrace(p)} color2={HEAT_ORANGE} y2fmt={(v) => `${Math.round(v)}°`} y2label="°C" />
      </View>
    ); })() : null,
    ec: ef.filter(p => p.ec > 0).length >= 2 ? (() => { const p = ef.filter(x => x.ec > 0); return (
      <View style={s.card}>
        <CardHead title="Running Economy (EC)">
          Speed ÷ power — HR-INDEPENDENT, so it's the most trustworthy (and heat-proof: no 🟠 flags needed here). Rising = more speed per watt.
          {' '}Grey line = trend. Latest {p[p.length - 1].ec.toFixed(3)} ({((p[p.length - 1].ec - p[0].ec) >= 0 ? '+' : '') + (p[p.length - 1].ec - p[0].ec).toFixed(3)} over the window).
          {wt.length >= 2 ? '  Purple = body weight (right axis) — if EC falls as weight falls, it\'s the power-from-mass estimate, not a real economy loss.' : ''}
          {p.some(x => x.repaired) ? `  ${p.filter(x => x.repaired).length} run${p.filter(x => x.repaired).length === 1 ? '' : 's'} had stationary time (unpaused stops) removed from the work averages before plotting.` : ''}
        </CardHead>
        <TChart innerW={innerW} t0={t0} t1={t1} color={CTL_BLUE} events={events} showEvents={showEvents} trend yfmt={(v) => v.toFixed(3)}
          pts={p.map(x => ({ t: tOf(x.date), v: x.ec, color: x.aerobic ? '#22c55e' : '#cbd5e1' }))}
          pts2={wt} color2="#a855f7" y2fmt={(v) => v.toFixed(1)} y2label="kg" />
      </View>
    ); })() : null,
    se: ef.filter(p => p.se > 0).length >= 2 ? (() => { const p = ef.filter(x => x.se > 0); return (
      <View style={s.card}>
        <CardHead title="Speed Efficiency (SE)">
          Speed ÷ HR per run. Rising = more speed per heartbeat (HR-based, like EF).
          {' '}Grey line = trend. Latest {p[p.length - 1].se.toFixed(2)} ({((p[p.length - 1].se - p[0].se) >= 0 ? '+' : '') + (p[p.length - 1].se - p[0].se).toFixed(2)} over the window).
          {p.some(x => x.hot) ? `  🟠 = run ≥${HEAT_C}°C — heat-inflated HR drags SE down independently of fitness.` : ''}
          {tempTrace(p).length >= 2 ? '  Orange line = run-time temperature (right axis, smoothed).' : ''}
        </CardHead>
        <TChart innerW={innerW} t0={t0} t1={t1} color={CTL_BLUE} events={events} showEvents={showEvents} trend yfmt={(v) => v.toFixed(2)}
          pts={p.map(x => ({ t: tOf(x.date), v: x.se, color: x.hot ? HEAT_ORANGE : x.aerobic ? '#22c55e' : '#cbd5e1' }))}
          pts2={tempTrace(p)} color2={HEAT_ORANGE} y2fmt={(v) => `${Math.round(v)}°`} y2label="°C" />
      </View>
    ); })() : null,
    intensity: zones ? (
      <View style={s.card}>
        <CardHead title="Intensity Distribution">
          Where your running time goes (last 8 weeks). Most endurance plans want ~80% easy.
          {' '}PI = Seiler polarization index (&gt;0 leans polarised).
          {zones.modPct > 35 ? ' You have a lot of moderate "gray zone" — the classic flat-fitness trap.'
            : zones.easyPct >= 75 ? ' Nicely polarised (lots of easy).' : ''}
        </CardHead>
        <ZoneBar z={zones} />
      </View>
    ) : null,
    mix: zoneWeeks.length >= 1 ? (
      <View style={s.card}>
        <CardHead title="Intensity Mix Over Time">
          Easy / moderate / hard share of each week's running (🟢 easy · 🟠 moderate · 🔴 hard).
          A mostly-green base with a little red = well polarised.
        </CardHead>
        <StackedZoneChart weeks={zoneWeeks} t0={t0} t1={t1} events={events} showEvents={showEvents} innerW={innerW} />
      </View>
    ) : null,
    acwr: acwr.length >= 3 ? (
      <View style={s.card}>
        <CardHead title="Load Ratio (ACWR)">
          Acute ÷ chronic load. The 0.8–1.3 band is the injury-risk sweet spot.
          {' '}Latest {acwr[acwr.length - 1].ratio.toFixed(2)}. Green band = sweet spot; red dashed = 1.5 (spike-risk).
        </CardHead>
        <TChart innerW={innerW} t0={t0} t1={t1} color={CTL_BLUE} events={events} showEvents={showEvents}
          band={[0.8, 1.3]} refs={[{ y: 1.5, color: '#ef4444', dash: true }]} yfmt={(v) => v.toFixed(1)}
          pts={acwr.map(p => ({ t: tOf(p.date), v: p.ratio }))} />
      </View>
    ) : null,
    decoupling: (
      <View style={s.card}>
        <CardHead title="Aerobic Decoupling (Pw:HR)">
          How much HR drifts up relative to power over a steady run. Under 5% = strong aerobic base.
          One point per steady run ≥30 min; green line = 5% threshold.
          {dcClean.length >= 2 ? `  ${dcMed != null ? `Recent normal ≈ ${dcMed.toFixed(1)}% (median of last ${Math.min(8, dcClean.length)}), ` : ''}latest run ${dcClean[dcClean.length - 1].pct.toFixed(1)}%.` : ''}
          {dcClean.length >= 2 ? ((dcMed ?? dcClean[dcClean.length - 1].pct) < 5 ? ' Well-coupled aerobic base.' : ' Some drift; more Z2 volume helps.') : ''}
          {dc ? `  Shaded = your moving "normal" band; single runs are noisy so read the band/median, not one dot. ${dc.length - dcClean.length} run${dc.length - dcClean.length === 1 ? '' : 's'} cut as unusable (stop-and-go, HR dropout, or not steady).` : ''}
          {dcClean.some(p => p.hot) ? `  🟠 = run ≥${HEAT_C}°C — heat drives extra cardiac drift, so those read HIGH.` : ''}
          {tempTrace(dcClean).length >= 2 ? '  Orange line = run-time temperature (right axis, smoothed) — drift rising with it is the weather.' : ''}
        </CardHead>
        {dc == null ? (
          <View style={{ paddingVertical: 20, alignItems: 'center' }}><ActivityIndicator color={CTL_BLUE} /><Text style={s.loadingText}>Reading long runs…{dcProg && dcProg.total ? ` ${dcProg.done}/${dcProg.total}` : ''}</Text></View>
        ) : dcClean.length >= 2 ? (
          <TChart innerW={innerW} t0={t0} t1={t1} color={CTL_BLUE} events={events} showEvents={showEvents}
            refs={[{ y: 5, color: '#22c55e' }, { y: 0, color: '#94a3b8', dash: true }]} yfmt={(v) => `${Math.round(v)}%`}
            bandSeries={dcBand} pts={dcClean.map(p => ({ t: tOf(p.date), v: p.pct, color: p.hot ? HEAT_ORANGE : undefined }))}
            pts2={tempTrace(dcClean)} color2={HEAT_ORANGE} y2fmt={(v) => `${Math.round(v)}°`} y2label="°C" />
        ) : (
          <Text style={s.errorText}>Need a couple of steady runs ≥30 min with power to show decoupling.</Text>
        )}
      </View>
    ),
    volume: (
      <View style={s.card}>
        <CardHead title="Volume vs Budget">
          Each week's running (bar) vs its +cap% ceiling (the line atop the faint track) — heat-credited off the
          best of your recent weeks so a hot week can't drag it down. Reach ~90% to hold volume flat; under that,
          next week's ceiling drifts down. 🟢 ≥90% · 🟠 ≥70% · 🔴 under · grey = the in-progress week · 🌡 = that
          week's heat tax.
        </CardHead>
        {capWeeks.length ? (
          <>
            <VolumeBudgetChart weeks={capWeeks} t0={t0} t1={t1} innerW={innerW} />
            <RightNowBars curWeek={nowWeek} roll={roll} />
          </>
        ) : (
          <View style={{ paddingVertical: 20, alignItems: 'center' }}><ActivityIndicator color={CTL_BLUE} /></View>
        )}
      </View>
    ),
  };

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={s.back}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={s.title}>Statistics</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <TouchableOpacity onPress={() => setCustomising(true)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Text style={{ fontSize: 20 }}>⚙︎</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.push('/data-chat?mode=stats')} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Text style={{ fontSize: 22 }}>💬</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Shared time-window controls — every chart below moves together */}
      <View style={s.ctrlRow}>
        {RANGES.map(r => <TouchableOpacity key={r} onPress={() => setRange(r)} style={[s.tab, range === r && s.tabOn]}><Text style={[s.tabTxt, range === r && s.tabTxtOn]}>{r}</Text></TouchableOpacity>)}
        <View style={{ flex: 1 }} />
        <TouchableOpacity onPress={() => setShowEvents(v => !v)} style={[s.tab, !showEvents && { opacity: 0.5 }]}><Text style={s.tabTxt}>{showEvents ? '👁' : '🚫'}</Text></TouchableOpacity>
      </View>
      {days > 0 && (
        <View style={s.navRow}>
          <TouchableOpacity style={s.navBtn} onPress={() => setOffset(o => o + 1)}><Text style={s.navTxt}>◀</Text></TouchableOpacity>
          <Text style={s.navLabel}>{monthYear(t0)} – {monthYear(t1)}</Text>
          <TouchableOpacity style={[s.navBtn, offset === 0 && { opacity: 0.4 }]} disabled={offset === 0} onPress={() => setOffset(o => Math.max(0, o - 1))}><Text style={s.navTxt}>▶</Text></TouchableOpacity>
        </View>
      )}

      <ScrollView contentContainerStyle={s.scroll} onLayout={onLayout}>
        {/* Fitness/Fatigue/Form (the PMC) has its own dedicated screen — link to it rather than duplicate the chart. */}
        <TouchableOpacity style={s.pmcLink} onPress={() => router.push('/training-load' as any)} activeOpacity={0.7}>
          <View style={{ flex: 1 }}>
            <Text style={s.pmcLinkTitle}>Fitness / Fatigue / Form</Text>
            <Text style={s.pmcLinkSub}>CTL · ATL · TSB over time — the PMC</Text>
          </View>
          <Text style={s.pmcLinkArrow}>›</Text>
        </TouchableOpacity>
        {layout.filter(l => l.on).map(l => <React.Fragment key={l.id}>{cardNodes[l.id]}</React.Fragment>)}
      </ScrollView>

      {/* Customise sheet — toggle + reorder cards */}
      <Modal visible={customising} animationType="slide" transparent onRequestClose={() => setCustomising(false)}>
        <View style={s.sheetBackdrop}>
          <View style={s.sheet}>
            <View style={s.sheetHead}>
              <Text style={s.sheetTitle}>Customise cards</Text>
              <TouchableOpacity onPress={() => setCustomising(false)}><Text style={s.sheetDone}>Done</Text></TouchableOpacity>
            </View>
            <Text style={s.sheetHint}>Drag ≡ to reorder · switch to show or hide</Text>
            {/* No ScrollView here on purpose: a ScrollView captures the vertical pan from the drag
                grip (onMoveShouldSetResponderCapture) and the reorder never starts. 11 rows fit. */}
            <ReorderList items={layout} onCommit={commitLayout} />
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const makeCh = (c: Palette) => StyleSheet.create({
  yLabel: { fontSize: 10, color: c.textSub, textAlign: 'right', fontWeight: '500' },
  xLabel: { fontSize: 10, color: c.textSub, fontWeight: '600' },
  // "Right now" gauges under the Volume-vs-Budget chart
  rnCard:  { marginTop: 12, borderTopWidth: 1, borderTopColor: c.border, paddingTop: 10 },
  rnTitle: { color: c.text, fontSize: 12.5, fontWeight: '800', marginBottom: 8 },
  rnRow:   { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  rnLbl:   { color: c.textSub, fontSize: 11, fontWeight: '600', width: 74 },
  rnTrack: { flex: 1, height: 15, borderRadius: 5, backgroundColor: c.surfaceAlt, overflow: 'hidden', justifyContent: 'center' },
  rnFill:  { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 5 },
  rnNum:   { color: c.text, fontSize: 11, fontWeight: '700', width: 96, textAlign: 'right' },
  anchor: { fontSize: 11, color: c.text, fontWeight: '800' },
});

const makeS = (c: Palette) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 14, minHeight: 52 },
  back: { color: c.accent, fontSize: 16, fontWeight: '600', width: 60 },
  title: { fontSize: 17, fontWeight: '700', color: c.text },
  scroll: { padding: 12, paddingBottom: 40 },
  ctrlRow:  { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingBottom: 6 },
  tab:      { paddingVertical: 5, paddingHorizontal: 11, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  tabOn:    { backgroundColor: c.accent, borderColor: c.accent },
  tabTxt:   { color: c.textSub, fontSize: 12.5, fontWeight: '700' },
  tabTxtOn: { color: c.onAccent },
  navRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingBottom: 8 },
  navBtn:   { paddingVertical: 4, paddingHorizontal: 16, borderRadius: 8, backgroundColor: c.surfaceAlt, borderWidth: 1, borderColor: c.border },
  navTxt:   { color: c.text, fontSize: 14, fontWeight: '800' },
  navLabel: { color: c.textSub, fontSize: 12.5, fontWeight: '600' },
  card: { backgroundColor: c.surface, borderRadius: 16, padding: 12, marginBottom: 12 },
  pmcLink: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.surface, borderRadius: 16, padding: 14, marginBottom: 12, borderLeftWidth: 3, borderLeftColor: '#3B82F6' },
  pmcLinkTitle: { fontSize: 15, fontWeight: '700', color: c.text },
  pmcLinkSub: { fontSize: 12, color: c.textSub, marginTop: 2 },
  pmcLinkArrow: { fontSize: 24, color: c.textFaint, fontWeight: '300', marginLeft: 8 },
  zoneBar: { flexDirection: 'row', height: 16, borderRadius: 4, overflow: 'hidden', marginTop: 8 },
  zoneBarTxt: { fontSize: 9, color: '#fff', fontWeight: '700' },
  zone3Txt: { fontSize: 11.5, color: c.text, fontWeight: '600', marginTop: 6 },
  cardTitle: { fontSize: 16, fontWeight: '800', color: c.text },
  center: { height: CHART_H, alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: c.textSub, marginTop: 10, fontSize: 13 },
  errorText: { color: c.textSub, fontSize: 13, paddingVertical: 20, textAlign: 'center' },
  // Derived Critical Power — the per-duration bests are drawn on the chart itself now.
  cpLine:    { marginTop: 10, fontSize: 12, color: c.textSub, fontWeight: '600' },
  cpLineVal: { fontSize: 14, fontWeight: '800', color: CTL_BLUE },
  // Compact Performance (GPI) headline
  perfHead:    { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 4 },
  perfNum:     { fontSize: 34, fontWeight: '800', lineHeight: 38, minWidth: 52 },
  perfWord:    { fontSize: 13.5, fontWeight: '700', color: c.text },
  perfDelta:   { fontSize: 12, fontWeight: '700', marginTop: 2 },
  perfChevron: { fontSize: 24, color: c.textFaint, fontWeight: '400', paddingLeft: 4 },
  rebuild: { marginTop: 12, alignSelf: 'flex-start' },
  rebuildText: { fontSize: 12, color: c.accent, fontWeight: '600' },
  // ── Customise sheet ──
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: c.surface, borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 34, maxHeight: '92%' },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  sheetTitle: { fontSize: 17, fontWeight: '800', color: c.text },
  sheetDone: { fontSize: 16, fontWeight: '700', color: c.accent },
  sheetHint: { fontSize: 12, color: c.textSub, marginBottom: 10 },
});

const makeReorder = (c: Palette) => StyleSheet.create({
  row: {
    position: 'absolute', left: 0, right: 0, flexDirection: 'row', alignItems: 'center', paddingRight: 4,
    backgroundColor: c.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.gridline,
  },
  rowDragging: {
    borderBottomWidth: 0, borderRadius: 12, backgroundColor: c.surfaceAlt,
    shadowColor: '#000', shadowOpacity: 0.28, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
  },
  grip: { paddingHorizontal: 12, paddingVertical: 16, alignItems: 'center', justifyContent: 'center' },
  gripDots: { fontSize: 22, color: c.textFaint, fontWeight: '800' },
  label: { flex: 1, fontSize: 15, color: c.text, marginLeft: 2 },
  labelOff: { color: c.textSub },
});
