import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, SafeAreaView, ActivityIndicator, LayoutChangeEvent, PanResponder,
} from 'react-native';
import { loadEvents } from '../src/services/timelineEvents';
import { useRouter } from 'expo-router';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import { loadSnapshotCache, fetchHealthSnapshot, saveSnapshotCache, fetchTrainingLoadHistory, fetchBodyMassHistory } from '../src/services/healthkit';
import { loadStatsRuns, saveStatsRuns, mergeRuns } from '../src/services/statsRunsCache';
import { getPowerZones } from '../src/services/claude';
import {
  computePowerCurve, clearPowerCurveCache, fmtDur, PDC_ANCHORS, PowerCurve,
} from '../src/services/powerCurve';
import {
  efficiencyTrend, zoneSummary, acwrSeries, decouplingTrend, decouplingBanded, zoneDistributionOverTime,
  EfPoint, ZoneSummary, AcwrPoint, DecouplePoint, ZoneWeek,
} from '../src/services/runStats';
import type { PowerZones } from '../src/types';

const CHART_H = 210;
const Y_AXIS_W = 38;
const CTL_BLUE = '#3B82F6';
const EV_COLOR: Record<string, string> = { medical: '#ef4444', life: '#10b981' };
type Range = 'All' | '1Y' | '6M' | '3M' | '1M';
const RANGES: Range[] = ['All', '1Y', '6M', '3M', '1M'];
const RANGE_DAYS: Record<Range, number> = { All: 0, '1Y': 365, '6M': 182, '3M': 91, '1M': 31 };
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
      <View style={{ flexDirection: 'row' }} {...pan.panHandlers}>
        <View style={{ width: TS_YW, height: TS_H }}>
          {yTicks.map((t, i) => <Text key={i} style={[ch.yLabel, { position: 'absolute', top: toY(t) - 7, right: 4 }]}>{yfmt(t)}</Text>)}
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
      <View style={{ flexDirection: 'row' }} {...pan.panHandlers}>
        <View style={{ width: TS_YW, height: TS_H }}>
          {[0, 50, 100].map((p, i) => <Text key={i} style={[ch.yLabel, { position: 'absolute', top: TS_H * (1 - p / 100) - 7, right: 4 }]}>{p}%</Text>)}
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
      const snap = await fetchHealthSnapshot({ months: 24, light: false, onProgress: (step, pct) => setStepMsg(`${step} ${pct}%`) });
      await saveSnapshotCache(snap);
      await saveStatsRuns(mergeRuns((snap as any).runs ?? [], await loadStatsRuns()));   // seed durable history
      await clearPowerCurveCache();
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
    return ts.length ? [Math.min(...ts), Math.max(...ts)] : [Date.now() - 365 * 86400000, Date.now()];
  }, [ef, acwr, dc]);
  const days = RANGE_DAYS[range];
  const spanMs = days ? days * 86400000 : Math.max(1, gMax - gMin);
  const t1 = days ? gMax - offset * spanMs : gMax;
  const t0 = days ? t1 - spanMs : gMin;
  const zoneWeeks = useMemo(() => zoneDistributionOverTime(allRuns, 0, gMax + 86400000, maxHR), [allRuns, gMax, maxHR]);
  // Moving "normal aerobic efficiency" band + the runs that survive its cut + a stable recent-median read.
  const { dcClean, dcBand, dcMed } = useMemo(() => {
    const { clean, band } = decouplingBanded(dc ?? []);
    const recent = clean.slice(-8).map(p => p.pct).sort((a, b) => a - b);
    const med = recent.length ? recent[Math.floor(recent.length / 2)] : null;
    return { dcClean: clean, dcBand: band.map(b => ({ t: tOf(b.date), lo: b.lo, hi: b.hi })), dcMed: med };
  }, [dc]);
  const monthYear = (t: number) => new Date(t).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });

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
        <TouchableOpacity onPress={() => router.push('/data-chat?mode=stats')} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={{ fontSize: 22 }}>💬</Text>
        </TouchableOpacity>
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

      <ScrollView contentContainerStyle={s.scroll}>
        <View style={s.card} onLayout={onLayout}>
          <Text style={s.cardTitle}>Power–Duration Curve</Text>
          <Text style={s.cardSub}>Best average running power you've held for each duration, across your runs.</Text>

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
              <TouchableOpacity style={s.rebuild} onPress={rebuildDeep}>
                <Text style={s.rebuildText}>↻ Rebuild + load full history</Text>
              </TouchableOpacity>
            </>
          ) : null}
        </View>

        {/* ── Efficiency Factor ── */}
        {ef.filter(p => p.ef > 0).length >= 2 && (() => { const p = ef.filter(x => x.ef > 0); return (
          <View style={s.card}>
            <Text style={s.cardTitle}>Efficiency Factor</Text>
            <Text style={s.cardSub}>Power ÷ HR per run. Rising = a better aerobic engine, even if CTL looks flat.</Text>
            <TChart innerW={innerW} t0={t0} t1={t1} color={CTL_BLUE} events={events} showEvents={showEvents} trend yfmt={(v) => v.toFixed(2)}
              pts={p.map(x => ({ t: tOf(x.date), v: x.ef, color: x.aerobic ? '#22c55e' : '#cbd5e1' }))} />
            <Text style={s.foot}>
              Grey line = trend. Green = steady aerobic runs. Latest {p[p.length - 1].ef.toFixed(2)}
              {p.filter(x => x.aerobic).length >= 2 ? ((): string => {
                const a = p.filter(x => x.aerobic); const d = a[a.length - 1].ef - a[0].ef;
                return `  ·  aerobic EF ${d >= 0 ? '+' : ''}${(d).toFixed(2)} over the window (${d >= 0 ? 'improving' : 'down'}).`;
              })() : ''}
            </Text>
          </View>
        ); })()}

        {/* ── Running economy (EC = speed ÷ power, HR-independent) ── */}
        {ef.filter(p => p.ec > 0).length >= 2 && (() => { const p = ef.filter(x => x.ec > 0); return (
          <View style={s.card}>
            <Text style={s.cardTitle}>Running Economy (EC)</Text>
            <Text style={s.cardSub}>Speed ÷ power — HR-INDEPENDENT, so it's the most trustworthy. Rising = more speed per watt.</Text>
            <TChart innerW={innerW} t0={t0} t1={t1} color={CTL_BLUE} events={events} showEvents={showEvents} trend yfmt={(v) => v.toFixed(3)}
              pts={p.map(x => ({ t: tOf(x.date), v: x.ec, color: x.aerobic ? '#22c55e' : '#cbd5e1' }))}
              pts2={wt} color2="#a855f7" y2fmt={(v) => v.toFixed(1)} y2label="kg" />
            <Text style={s.foot}>Grey line = trend. Latest {p[p.length - 1].ec.toFixed(3)} ({((p[p.length - 1].ec - p[0].ec) >= 0 ? '+' : '') + (p[p.length - 1].ec - p[0].ec).toFixed(3)} over the window).{wt.length >= 2 ? '  Purple = body weight (right axis) — if EC falls as weight falls, it\'s the power-from-mass estimate, not a real economy loss.' : ''}</Text>
          </View>
        ); })()}

        {/* ── Speed efficiency (SE = speed ÷ HR) ── */}
        {ef.filter(p => p.se > 0).length >= 2 && (() => { const p = ef.filter(x => x.se > 0); return (
          <View style={s.card}>
            <Text style={s.cardTitle}>Speed Efficiency (SE)</Text>
            <Text style={s.cardSub}>Speed ÷ HR per run. Rising = more speed per heartbeat (HR-based, like EF).</Text>
            <TChart innerW={innerW} t0={t0} t1={t1} color={CTL_BLUE} events={events} showEvents={showEvents} trend yfmt={(v) => v.toFixed(2)}
              pts={p.map(x => ({ t: tOf(x.date), v: x.se, color: x.aerobic ? '#22c55e' : '#cbd5e1' }))} />
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

        {/* ── Intensity mix over time (workload distribution) ── */}
        {zoneWeeks.length >= 1 && (
          <View style={s.card}>
            <Text style={s.cardTitle}>Intensity Mix Over Time</Text>
            <Text style={s.cardSub}>Easy / moderate / hard share of each week's running. A mostly-green base with a little red = well polarised.</Text>
            <StackedZoneChart weeks={zoneWeeks} t0={t0} t1={t1} events={events} showEvents={showEvents} innerW={innerW} />
            <View style={s.zone3}>
              <Text style={s.zone3Txt}>🟢 Easy</Text><Text style={s.zone3Txt}>🟠 Moderate</Text><Text style={s.zone3Txt}>🔴 Hard</Text>
            </View>
          </View>
        )}

        {/* ── ACWR ── */}
        {acwr.length >= 3 && (
          <View style={s.card}>
            <Text style={s.cardTitle}>Load Ratio (ACWR)</Text>
            <Text style={s.cardSub}>Acute ÷ chronic load. The 0.8–1.3 band is the injury-risk sweet spot.</Text>
            <TChart innerW={innerW} t0={t0} t1={t1} color={CTL_BLUE} events={events} showEvents={showEvents}
              band={[0.8, 1.3]} refs={[{ y: 1.5, color: '#ef4444', dash: true }]} yfmt={(v) => v.toFixed(1)}
              pts={acwr.map(p => ({ t: tOf(p.date), v: p.ratio }))} />
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
            <View style={{ paddingVertical: 20, alignItems: 'center' }}><ActivityIndicator color={CTL_BLUE} /><Text style={s.loadingText}>Reading long runs…{dcProg && dcProg.total ? ` ${dcProg.done}/${dcProg.total}` : ''}</Text></View>
          ) : dcClean.length >= 2 ? (
            <>
              <TChart innerW={innerW} t0={t0} t1={t1} color={CTL_BLUE} events={events} showEvents={showEvents}
                refs={[{ y: 5, color: '#22c55e' }, { y: 0, color: '#94a3b8', dash: true }]} yfmt={(v) => `${Math.round(v)}%`}
                bandSeries={dcBand} pts={dcClean.map(p => ({ t: tOf(p.date), v: p.pct }))} />
              <Text style={s.foot}>
                One point per steady run ≥30 min. Green line = 5% threshold. {dcMed != null ? `Recent normal ≈ ${dcMed.toFixed(1)}% (median of last ${Math.min(8, dcClean.length)})` : ''}, latest run {dcClean[dcClean.length - 1].pct.toFixed(1)}%.
                {(dcMed ?? dcClean[dcClean.length - 1].pct) < 5 ? ' Well-coupled aerobic base.' : ' Some drift; more Z2 volume helps.'}
                {`  Shaded = your moving "normal" band; single runs are noisy so read the band/median, not one dot. ${dc.length - dcClean.length} run${dc.length - dcClean.length === 1 ? '' : 's'} cut as unusable (stop-and-go, HR dropout, or not steady).`}
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
