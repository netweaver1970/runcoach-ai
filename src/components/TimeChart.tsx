/**
 * Shared time-series chart (moved out of app/statistics.tsx, 2026-10-08) so the cardio statistics and the strength
 * statistics draw with the SAME component: a scrubbable line over a time window, dated x-axis, optional band /
 * reference lines / secondary series / life-event markers, and a grey OLS trend line whose Δ the captions quote.
 */
import React, { useRef, useState } from 'react';
import { View, Text, StyleSheet, PanResponder } from 'react-native';
import { useTheme, useThemedStyles, Palette } from '../theme';

export const EV_COLOR: Record<string, string> = { medical: '#ef4444', life: '#10b981' };
export interface Ev { t: number; label: string; category: string }
export const TS_H = 96;
export const TS_YW = 34;
export const dLabel = (t: number, yearly: boolean) =>
  new Date(t).toLocaleDateString('en-GB', yearly ? { month: 'short', year: '2-digit' } : { day: 'numeric', month: 'short' });

// ─── Time-windowed series chart: cursor + events + date x-axis + optional band/refs/trend ─────────
export const TX_H = 20;
export interface TPt { t: number; v: number; color?: string }
// The points inside the shared window, in draw order — exactly the set TChart plots. Card captions use this
// too, so their "latest"/Δ numbers describe the chart on screen rather than the whole run history.
export function inWin<T extends { t: number }>(pts: T[], t0: number, t1: number): T[] {
  return pts.filter(p => p.t >= t0 && p.t <= t1).sort((a, b) => a.t - b.t);
}
// OLS fit over (index, value) — the SAME fit TChart draws as its grey trend line. Shared so a caption's
// "±d over the window" (= fit(end) − fit(start) = m·(n−1)) always agrees with the line drawn in the card.
export function olsFit(vals: number[]): { m: number; b0: number } | null {
  const n = vals.length; if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += vals[i]; sxx += i * i; sxy += i * vals[i]; }
  const den = n * sxx - sx * sx; if (!den) return null;
  const m = (n * sxy - sx * sy) / den;
  return { m, b0: (sy - m * sx) / n };
}
// ≥3 points, same as TChart's trend line — a caption must never quote a "trend" the chart doesn't draw.
export const trendDelta = (vals: number[]): number | null => {
  if (vals.length < 3) return null;
  const f = olsFit(vals); return f ? f.m * (vals.length - 1) : null;
};
export const signed = (v: number, dp: number) => `${v >= 0 ? '+' : ''}${v.toFixed(dp)}`;
export function TChart({ pts, t0, t1, color, band, refs, trend, events, showEvents, yfmt, innerW, pts2, color2, y2fmt, y2label, bandSeries }: {
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

  const win = inWin(pts, t0, t1);
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
    const n = win.length, fit = olsFit(vals);
    if (fit) { const { m, b0 } = fit;
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
            {has2 && [y2Hi - (y2Hi - y2Lo) * 0.15, (y2Lo + y2Hi) / 2, y2Lo + (y2Hi - y2Lo) * 0.15].map((vv, i) => <Text key={`y2l${i}`} style={{ position: 'absolute', top: toY2(vv) - 7, left: 3, fontSize: 9.5, color: c2, fontWeight: '700', opacity: 0.9 }}>{f2(vv)}</Text>)}
          </View>
        )}
      </View>
    </View>
  );
}


const makeCh = (c: Palette) => StyleSheet.create({
  yLabel: { fontSize: 10, color: c.textSub, textAlign: 'right', fontWeight: '500' },
  xLabel: { fontSize: 10, color: c.textSub, fontWeight: '600' },
});

// ─── Weekly bars (same look as the cardio Weekly-TSS card): one bar per Monday-week, latest COMPLETED week in the
// accent, the in-progress week grey, value labels when there's room, dated labels under first / middle / last bar ───
export interface WeekBar { wk: number; v: number; inProgress: boolean }
const monday = (ms: number) => { const d = new Date(ms); const off = (d.getDay() + 6) % 7; d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - off); return d.getTime(); };
/** Sum dated values per Monday-week over [t0, t1] (zero-filled weeks; none before the first data point). */
export function weeklySum(pts: { t: number; v: number }[], t0: number, t1: number): WeekBar[] {
  if (!pts.length) return [];
  const by = new Map<number, number>();
  let first = Infinity;
  for (const p of pts) { const w = monday(p.t); by.set(w, (by.get(w) ?? 0) + p.v); first = Math.min(first, w); }
  const from = Math.max(t0, first);
  const d = new Date(monday(from));
  const now = Date.now(), out: WeekBar[] = [];
  for (; d.getTime() <= t1; d.setDate(d.getDate() + 7)) {   // setDate keeps local midnight across DST
    const wk = d.getTime(), end = new Date(wk); end.setDate(end.getDate() + 7);
    out.push({ wk, v: by.get(wk) ?? 0, inProgress: end.getTime() > now });
  }
  return out;
}
export function WeeklyBars({ weeks, innerW, fmt, unit }: { weeks: WeekBar[]; innerW: number; fmt: (v: number) => string; unit: string }) {
  const { c } = useTheme();
  if (!weeks.length || !weeks.some(w => w.v > 0)) return <Text style={{ color: c.textFaint, fontSize: 12, textAlign: 'center', paddingVertical: 16 }}>Nothing logged in this range.</Text>;
  const n = weeks.length, max = Math.max(...weeks.map(w => w.v), 1);
  const done = weeks.filter(w => !w.inProgress);
  const avg = done.length ? done.reduce((a, w) => a + w.v, 0) / done.length : null;
  const lastDone = done[done.length - 1] ?? null, cur = weeks[n - 1].inProgress ? weeks[n - 1] : null;
  const dense = n > 20, gap = n > 60 ? 0 : dense ? 1 : 3;
  const cellW = innerW > 0 ? (innerW - gap * (n - 1)) / n : 0, LBL_W = 56;
  const labelIdx = [...new Set([0, Math.floor(n / 2), n - 1])];
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 116, gap, marginTop: 6 }}>
        {weeks.map(w => {
          const hl = w === lastDone;
          return (
            <View key={w.wk} style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end' }}>
              {!dense && (w.v >= max * 0.55 || hl || w.inProgress) && w.v > 0 ? <Text style={{ fontSize: 8, color: c.textSub, marginBottom: 2 }}>{fmt(w.v)}</Text> : null}
              <View style={{ width: '72%', height: Math.max(2, (w.v / max) * 96), backgroundColor: w.inProgress ? c.textFaint : hl ? c.accent : c.accent + '99', opacity: w.inProgress ? 0.6 : 1, borderRadius: 2 }} />
            </View>
          );
        })}
      </View>
      <View style={{ height: 12, marginTop: 3 }}>
        {cellW > 0 && labelIdx.map(i => {
          const cx = i * (cellW + gap) + cellW / 2;
          const atL = cx - LBL_W / 2 < 0, atR = cx + LBL_W / 2 > innerW;
          return (
            <Text key={i} numberOfLines={1} style={{ position: 'absolute', width: LBL_W, fontSize: 7.5, color: c.textFaint,
              left: atL ? 0 : atR ? innerW - LBL_W : cx - LBL_W / 2, textAlign: atL ? 'left' : atR ? 'right' : 'center' }}>
              {new Date(weeks[i].wk).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
            </Text>
          );
        })}
      </View>
      <Text style={{ fontSize: 11, color: c.textSub, marginTop: 8 }}>
        {avg != null ? `${done.length}-week avg ${fmt(avg)} ${unit}/wk` : 'No completed week in this range yet'}
        {lastDone ? ` · last full week ${fmt(lastDone.v)}` : ''}{cur ? ` · this week so far ${fmt(cur.v)}` : ''}
      </Text>
    </View>
  );
}
