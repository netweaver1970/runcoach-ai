/**
 * Training Load viewer — CTL (Fitness) / ATL (Fatigue) / TSB (Form) over time.
 *
 * Mirrors the history screen's period tabs (1M/3M/6M/1Y) and back-paging, but
 * renders a dual-line chart (CTL + ATL) since the metric is inherently two
 * series. TSB is summarised and listed per day.
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, SafeAreaView, ActivityIndicator, LayoutChangeEvent, PanResponder,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { shareJson } from '../src/shareJson';
import { fetchTrainingLoadHistory, buildTrainingLoadCalibration } from '../src/services/healthkit';
import { tsbStatus, cardioLoadStatus, ratioTrend } from '../src/services/trainingLoad';
import { useTheme, useThemedStyles, Palette } from '../src/theme';
import { DailyLoad } from '../src/types';

type Period = '1M' | '3M' | '6M' | '1Y';
const PERIOD_MONTHS: Record<Period, number> = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12 };

const CTL_COLOR = '#3B82F6'; // fitness (blue)
const ATL_COLOR = '#F97316'; // fatigue (orange)
const TSB_COLOR = '#10B981'; // form (green)
const CARD_PADDING = 12;
// TSB split out below CTL/ATL: the main chart no longer shares its y-scale with form, so CTL/ATL/Load
// get the full height instead of being squashed toward the top by TSB's ±range forcing 0 into the scale.
const MAIN_H = 172;   // CTL / ATL / optimal-load band
const TSB_H  = 58;    // form (TSB) — its own tight, 0-centred axis below
const SUB_GAP = 20;   // vertical gap between the two charts (also clears the TSB axis label)
const Y_AXIS_W = 34;  // left axis (CTL/ATL numbers)
const R_AXIS_W = 30;  // right axis (daily load numbers)

function niceScale(rawMin: number, rawMax: number) {
  if (rawMax <= rawMin) rawMax = rawMin + 1;
  const range = rawMax - rawMin;
  const rawStep = range / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(rawStep, 0.001))));
  const norm = rawStep / mag;
  const step = norm < 1.5 ? mag : norm < 3.5 ? 2 * mag : norm < 7.5 ? 5 * mag : 10 * mag;
  const niceMin = Math.floor(rawMin / step) * step;
  const niceMax = Math.ceil(rawMax / step) * step;
  const ticks: number[] = [];
  for (let t = niceMin; t <= niceMax + 1e-9; t += step) ticks.push(Math.round(t));
  return { min: niceMin, max: niceMax, ticks };
}

function fmtDM(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()}/${d.getMonth() + 1}`;
}
function fmtRange(from: string, to: string): string {
  const f = new Date(from), t = new Date(to);
  const dm = (d: Date) => `${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })}`;
  const yy = (d: Date) => `'${String(d.getFullYear()).slice(2)}`;
  return `${dm(f)} ${yy(f)} – ${dm(t)} ${yy(t)}`;
}

// ─── Triple-line chart (CTL / ATL / TSB) with scrubber cursor ──────────────────

function LoadChart({ data, innerW }: { data: DailyLoad[]; innerW: number }) {
  const ch = useThemedStyles(makeCh);
  const { c } = useTheme();
  const [cursorX, setCursorX] = useState<number | null>(null);
  const plotRef  = useRef<View>(null);
  const plotLeft = useRef(0);
  const measurePlot = () => plotRef.current?.measureInWindow((x) => { plotLeft.current = x; });

  const plotW = innerW - Y_AXIS_W - R_AXIS_W;

  const pan = useRef(
    PanResponder.create({
      // Don't grab on touch-start (lets vertical page scrolls begin on the chart);
      // only capture once the drag is clearly horizontal = a scrub.
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > Math.abs(g.dy) && Math.abs(g.dx) > 3,
      // Use absolute screen X minus the plot's measured left edge. locationX is
      // relative to whatever child view is touched, so it can't be used here.
      onPanResponderGrant: (_e, g) => setCursorX(g.x0 - plotLeft.current),
      onPanResponderMove:  (_e, g) => setCursorX(g.moveX - plotLeft.current),
      onPanResponderTerminationRequest: () => false,
    })
  ).current;

  if (innerW <= 0 || data.length === 0) return <View style={{ height: MAIN_H + TSB_H + SUB_GAP + 40 }} />;

  // Downsample to ≤120 points for render performance (CTL/ATL/TSB are smooth)
  const stride = Math.max(1, Math.ceil(data.length / 120));
  const pts = data.filter((_, i) => i % stride === 0 || i === data.length - 1);
  const trendByDate = new Map(data.map((d, i) => [d.date, ratioTrend(data, i)])); // ratio slope per day (full series)

  // MAIN scale: fit the DATA (CTL/ATL + the optimal band's 0.8–1.3×CTL edges), NOT anchored at 0 — so
  // the lines fill MAIN_H instead of leaving a big empty strip below ~15. TSB lives in its own sub-chart.
  const mainVals = pts.flatMap(d => [d.atl, d.ctl * 0.8, d.ctl * 1.3]);
  const mScale = niceScale(Math.min(...mainVals), Math.max(...mainVals, 1));
  const toYm = (v: number) => MAIN_H - ((v - mScale.min) / (mScale.max - mScale.min)) * MAIN_H;
  // LOAD: daily training impulse, its OWN right-hand axis (from 0 — a bar height is only meaningful from 0),
  // drawn as faint bars behind the lines so the smoothing (CTL/ATL) reads against the raw stimulus.
  const loadScale = niceScale(0, Math.max(1, ...pts.map(d => d.load || 0)));
  const toYload = (v: number) => MAIN_H - (v / (loadScale.max || 1)) * MAIN_H;
  // TSB scale: its OWN range, centred on 0, so a ±10 form swing uses the whole TSB_H instead of a sliver.
  const tAbs = Math.max(10, ...pts.map(d => Math.abs(d.tsb)));
  const tScale = niceScale(-tAbs, tAbs);
  const toYt = (v: number) => TSB_H - ((v - tScale.min) / (tScale.max - tScale.min)) * TSB_H;
  const xOf = (i: number) => (i / Math.max(1, pts.length - 1)) * plotW;

  const xAxisH = 22;
  const labelIdxs = new Set<number>();
  const nLabels = Math.min(5, pts.length);
  for (let k = 0; k < nLabels; k++) labelIdxs.add(Math.round((k / (nLabels - 1 || 1)) * (pts.length - 1)));

  // Segment-line renderer parameterised by the y-mapping, so main + TSB share it.
  const renderLine = (key: 'ctl' | 'atl' | 'tsb', color: string, toY: (v: number) => number, width = 2.5) => (
    pts.map((d, i) => {
      if (i === 0) return null;
      const x1 = xOf(i - 1), y1 = toY(pts[i - 1][key]);
      const x2 = xOf(i),     y2 = toY(d[key]);
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.sqrt(dx * dx + dy * dy);
      const ang = Math.atan2(dy, dx) * 180 / Math.PI;
      return (
        <View key={`${key}-${i}`} style={{
          position: 'absolute', left: (x1 + x2) / 2 - len / 2, top: (y1 + y2) / 2 - width / 2,
          width: len, height: width, backgroundColor: color, borderRadius: width / 2,
          transform: [{ rotate: `${ang}deg` }],
        }} />
      );
    })
  );

  // Cursor → nearest point. Default to the LATEST point when not scrubbing, so the readout line is never
  // empty (shows today's values) and the cursor line simply appears where the finger is once you scrub.
  const cursorIdx = cursorX == null ? -1
    : Math.max(0, Math.min(pts.length - 1, Math.round((cursorX / plotW) * (pts.length - 1))));
  const cur   = cursorIdx >= 0 ? pts[cursorIdx] : pts[pts.length - 1];
  const curX  = cursorIdx >= 0 ? xOf(cursorIdx) : -1;   // <0 = no visible cursor line

  const gridV = c.gridline;
  return (
    <View>
      {/* READOUT LINE — fixed, directly under the date range. Replaces the floating bubble that used to
          cover the graph. Shows the values under the cursor (or the latest point when not scrubbing);
          only the thin cursor line moves over the chart, so nothing is ever hidden. */}
      <View style={ch.readout}>
        <Text style={ch.readoutDate}>{cur.date.slice(5)}{cursorIdx < 0 ? ' · latest' : ''}</Text>
        <Text style={ch.readoutVals}>
          <Text style={{ color: CTL_COLOR }}>CTL </Text><Text style={ch.readoutNum}>{Math.round(cur.ctl)}</Text>
          {'   '}<Text style={{ color: ATL_COLOR }}>ATL </Text><Text style={ch.readoutNum}>{Math.round(cur.atl)}</Text>
          {'   '}<Text style={{ color: TSB_COLOR }}>TSB </Text><Text style={ch.readoutNum}>{cur.tsb >= 0 ? '+' : ''}{Math.round(cur.tsb)}</Text>
          {cur.load > 0 ? <Text style={ch.readoutSub}>{`   load ${Math.round(cur.load)}`}</Text> : null}
        </Text>
      </View>

      {/* ── MAIN chart: CTL / ATL / optimal band ── */}
      <View style={{ flexDirection: 'row' }}>
        <View style={{ width: Y_AXIS_W, height: MAIN_H }}>
          {mScale.ticks.map((t, i) => (
            <Text key={i} style={[ch.yLabel, { position: 'absolute', top: toYm(t) - 8, right: 4 }]}>{t}</Text>
          ))}
        </View>
        <View ref={plotRef} onLayout={measurePlot} style={{ width: plotW, height: MAIN_H, position: 'relative' }} {...pan.panHandlers}>
          {/* daily LOAD bars — drawn FIRST so the lines sit on top; own right-hand scale (toYload). */}
          {pts.map((d, i) => {
            const v = d.load || 0;
            if (v <= 0) return null;
            const bw = Math.max(1.5, plotW / pts.length - 1);
            const y = toYload(v);
            return (
              <View key={`ld-${i}`} style={{
                position: 'absolute', left: xOf(i) - bw / 2, width: bw,
                top: y, height: MAIN_H - y, backgroundColor: '#94a3b833', borderRadius: 1,
              }} />
            );
          })}
          {mScale.ticks.map((t, i) => (
            <View key={i} style={{ position: 'absolute', top: toYm(t), left: 0, right: 0, height: 1, backgroundColor: gridV }} />
          ))}
          {pts.map((d, i) => {
            if (d.ctl <= 0) return null;
            const yTop = toYm(d.ctl * 1.3), yBot = toYm(d.ctl * 0.8);
            const w = plotW / Math.max(1, pts.length - 1) + 1;
            return (
              <View key={`band-${i}`} style={{
                position: 'absolute', left: xOf(i) - w / 2, width: w,
                top: yTop, height: Math.max(1, yBot - yTop), backgroundColor: '#8e7cc326',
              }} />
            );
          })}
          {renderLine('ctl', CTL_COLOR, toYm)}
          {renderLine('atl', ATL_COLOR, toYm)}
          {pts.map((d, i) => {
            const st = cardioLoadStatus(d.atl, d.ctl, d.tsb, trendByDate.get(d.date));
            return (
              <View key={`st-${i}`} style={{
                position: 'absolute', left: xOf(i) - 3.5, top: toYm(d.atl) - 3.5,
                width: 7, height: 7, borderRadius: 3.5, backgroundColor: st.color, borderWidth: 1, borderColor: c.bg,
              }} />
            );
          })}
          {curX >= 0 && (
            <>
              <View style={{ position: 'absolute', left: curX, top: 0, width: 1, height: MAIN_H, backgroundColor: '#999' }} />
              {([['ctl', CTL_COLOR], ['atl', ATL_COLOR]] as const).map(([k, col]) => (
                <View key={k} style={{
                  position: 'absolute', left: curX - 3.5, top: toYm(cur[k]) - 3.5,
                  width: 7, height: 7, borderRadius: 3.5, backgroundColor: col, borderWidth: 1, borderColor: '#fff',
                }} />
              ))}
            </>
          )}
        </View>
        {/* RIGHT axis — daily load scale (matches the faint bars) */}
        <View style={{ width: R_AXIS_W, height: MAIN_H }}>
          {loadScale.ticks.map((t, i) => (
            <Text key={i} style={[ch.yLabelR, { position: 'absolute', top: toYload(t) - 8, left: 4 }]}>{t}</Text>
          ))}
          <Text style={[ch.yLabelR, ch.loadAxisCap, { position: 'absolute', top: -2, left: 4 }]}>load</Text>
        </View>
      </View>

      {/* ── TSB (form) sub-chart: own tight 0-centred axis ── */}
      <View style={{ flexDirection: 'row', marginTop: SUB_GAP }}>
        <View style={{ width: Y_AXIS_W, height: TSB_H + xAxisH }}>
          {tScale.ticks.filter(t => t === tScale.min || t === 0 || t === tScale.max).map((t, i) => (
            <Text key={i} style={[ch.yLabel, { position: 'absolute', top: toYt(t) - 7, right: 4 }]}>{t > 0 ? `+${t}` : t}</Text>
          ))}
        </View>
        <View style={{ width: plotW, height: TSB_H + xAxisH, position: 'relative' }} {...pan.panHandlers}>
          {/* TSB label INSIDE the plot (top-left), so it can't collide with the axis tick numbers. */}
          <Text style={[ch.subAxisLabel, { position: 'absolute', top: 1, left: 2 }]}>TSB</Text>
          {/* zero baseline emphasised; band edges faint */}
          {tScale.ticks.map((t, i) => (
            <View key={i} style={{
              position: 'absolute', top: toYt(t), left: 0, right: 0,
              height: t === 0 ? 1.5 : 1, backgroundColor: t === 0 ? c.textFaint : gridV,
            }} />
          ))}
          {renderLine('tsb', TSB_COLOR, toYt, 2)}
          {curX >= 0 && (
            <>
              <View style={{ position: 'absolute', left: curX, top: 0, width: 1, height: TSB_H, backgroundColor: '#999' }} />
              <View style={{
                position: 'absolute', left: curX - 3.5, top: toYt(cur.tsb) - 3.5,
                width: 7, height: 7, borderRadius: 3.5, backgroundColor: TSB_COLOR, borderWidth: 1, borderColor: '#fff',
              }} />
            </>
          )}
          {pts.map((d, i) => labelIdxs.has(i) ? (
            <Text key={`x-${i}`} style={[ch.xLabel, {
              position: 'absolute', top: TSB_H + 4, left: xOf(i) - 18, width: 36, textAlign: 'center',
            }]} numberOfLines={1}>{fmtDM(d.date)}</Text>
          ) : null)}
        </View>
      </View>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function TrainingLoadScreen() {
  const router = useRouter();
  const s = useThemedStyles(makeS);
  const [period, setPeriod]       = useState<Period>('3M');
  const [pageOffset, setPageOffset] = useState(0);
  const [data, setData]           = useState<DailyLoad[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [innerW, setInnerW]       = useState(0);
  const [copyState, setCopyState] = useState<'idle' | 'working' | 'done'>('idle');

  const periodMs = PERIOD_MONTHS[period] * 30 * 86_400_000;
  const toDate   = new Date(Date.now() - pageOffset * periodMs);
  const fromDate = new Date(toDate.getTime() - periodMs);

  const copyCalibration = useCallback(async () => {
    setCopyState('working');
    try {
      const json = await buildTrainingLoadCalibration(PERIOD_MONTHS[period], toDate);
      await Clipboard.setStringAsync(json);
      setCopyState('done');
      setTimeout(() => setCopyState('idle'), 2000);
    } catch {
      setCopyState('idle');
    }
  }, [period, pageOffset]);

  // Share the same calibration dump as a file (AirDrop / Save to Files) —
  // Universal Clipboard iPhone→Mac is flaky, so a file is the reliable path.
  const shareCalibration = useCallback(async () => {
    const json = await buildTrainingLoadCalibration(PERIOD_MONTHS[period], toDate);
    await shareJson(json, 'training-load-calibration.json', 'Training Load calibration');
  }, [period, pageOffset]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const series = await fetchTrainingLoadHistory(PERIOD_MONTHS[period], toDate);
      setData(series);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setData([]);
    } finally {
      setLoading(false);
    }
  }, [period, pageOffset]);

  useEffect(() => { load(); }, [load]);

  const latest = data.length > 0 ? data[data.length - 1] : null;
  const status = latest ? tsbStatus(latest.tsb) : null;
  const rampWk = data.length >= 8
    ? Math.round((data[data.length - 1].ctl - data[data.length - 8].ctl) * 10) / 10
    : 0;

  // Cardio-status breakdown: days in each training state over the displayed period.
  const cardioBreakdown = (() => {
    const counts = new Map<string, { color: string; days: number }>();
    let total = 0;
    data.forEach((d, i) => {
      const st = cardioLoadStatus(d.atl, d.ctl, d.tsb, ratioTrend(data, i));
      const e = counts.get(st.label) ?? { color: st.color, days: 0 };
      e.days += 1; counts.set(st.label, e); total += 1;
    });
    const ORDER = ['Building', 'Detraining', 'Maintaining', 'Peaking', 'Productive', 'Fatigued', 'Overtraining'];
    return total === 0 ? [] : ORDER.filter(l => counts.has(l)).map(l => ({
      label: l, color: counts.get(l)!.color, days: counts.get(l)!.days,
      pct: Math.round((counts.get(l)!.days / total) * 100),
    }));
  })();

  const onChartLayout = (e: LayoutChangeEvent) => setInnerW(e.nativeEvent.layout.width - CARD_PADDING * 2);

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Text style={s.backText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={s.title}>Training Load</Text>
        <View style={{ width: 70 }} />
      </View>

      <View style={s.periodRow}>
        {(['1M', '3M', '6M', '1Y'] as Period[]).map(p => (
          <TouchableOpacity
            key={p}
            style={[s.periodBtn, period === p && { backgroundColor: CTL_COLOR, borderColor: CTL_COLOR }]}
            onPress={() => { setPageOffset(0); setPeriod(p); }}
          >
            <Text style={[s.periodText, period === p && s.periodTextActive]}>{p}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={s.center}><ActivityIndicator size="large" color={CTL_COLOR} /><Text style={s.loadingText}>Loading…</Text></View>
      ) : error ? (
        <View style={s.center}>
          <Text style={s.errorText}>⚠️ Could not load training load</Text>
          <Text style={s.errorDetail}>{error}</Text>
          <TouchableOpacity style={[s.periodBtn, { marginTop: 16, paddingHorizontal: 20 }]} onPress={load}>
            <Text style={s.periodText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : data.length === 0 ? (
        <View style={s.center}>
          <Text style={s.emptyText}>No activity data for this period.</Text>
          <Text style={s.emptyHint}>Record some workouts and check back.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={s.scroll}>
          {/* Summary */}
          <View style={s.summaryRow}>
            <View style={s.summaryBox}>
              <Text style={[s.summaryVal, { color: CTL_COLOR }]}>{latest ? Math.round(latest.ctl) : '—'}</Text>
              <Text style={s.summaryLbl}>Fitness · CTL</Text>
            </View>
            <View style={s.summaryBox}>
              <Text style={[s.summaryVal, { color: ATL_COLOR }]}>{latest ? Math.round(latest.atl) : '—'}</Text>
              <Text style={s.summaryLbl}>Fatigue · ATL</Text>
            </View>
            <View style={s.summaryBox}>
              <Text style={[s.summaryVal, { color: status?.color ?? '#888' }]}>
                {latest ? `${latest.tsb >= 0 ? '+' : ''}${Math.round(latest.tsb)}` : '—'}
              </Text>
              <Text style={s.summaryLbl}>Form · TSB</Text>
            </View>
            <View style={s.summaryBox}>
              <Text style={[s.summaryVal, { color: rampWk >= 0 ? '#27ae60' : '#c0392b' }]}>
                {rampWk >= 0 ? '+' : ''}{rampWk}
              </Text>
              <Text style={s.summaryLbl}>CTL ramp/wk</Text>
            </View>
          </View>

          {/* Status banner */}
          {status && (
            <View style={[s.statusBanner, { borderLeftColor: status.color }]}>
              <Text style={[s.statusLabel, { color: status.color }]}>{status.label}</Text>
              <Text style={s.statusHint}>{status.hint}</Text>
            </View>
          )}

          {/* Chart */}
          <View style={s.chartWrap} onLayout={onChartLayout}>
            <View style={s.navRow}>
              <TouchableOpacity onPress={() => setPageOffset(o => o + 1)} style={s.navBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <Text style={s.navArrow}>‹</Text>
              </TouchableOpacity>
              <Text style={s.navLabel} numberOfLines={1}>{fmtRange(fromDate.toISOString(), toDate.toISOString())}</Text>
              <TouchableOpacity
                onPress={() => setPageOffset(o => Math.max(0, o - 1))}
                style={[s.navBtn, pageOffset === 0 && s.navBtnDisabled]}
                disabled={pageOffset === 0}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              >
                <Text style={[s.navArrow, pageOffset === 0 && s.navArrowDisabled]}>›</Text>
              </TouchableOpacity>
            </View>

            <LoadChart data={data} innerW={innerW} />

            {/* Legend */}
            <View style={s.legendRow}>
              <View style={s.legendItem}><View style={[s.legendDot, { backgroundColor: CTL_COLOR }]} /><Text style={s.legendText}>Fitness</Text></View>
              <View style={s.legendItem}><View style={[s.legendDot, { backgroundColor: ATL_COLOR }]} /><Text style={s.legendText}>Fatigue</Text></View>
              <View style={s.legendItem}><View style={[s.legendDot, { backgroundColor: TSB_COLOR }]} /><Text style={s.legendText}>Form</Text></View>
            </View>
            <Text style={s.scrubHint}>Shaded band = optimal load (0.8–1.3× fitness) · dot colour = daily status</Text>
          </View>

          {/* Cardio status breakdown over the period */}
          {cardioBreakdown.length > 0 && (
            <View style={s.statusCard}>
              <Text style={s.statusCardTitle}>CARDIO STATUS BREAKDOWN</Text>
              {cardioBreakdown.map((st) => (
                <View key={st.label} style={s.statusRow}>
                  <Text style={s.statusName}>{st.label}</Text>
                  <Text style={s.statusDaysTxt}>{st.days}d</Text>
                  <View style={s.statusBarBg}>
                    <View style={[s.statusBarFill, { width: `${st.pct}%` as `${number}%`, backgroundColor: st.color }]} />
                  </View>
                  <Text style={s.statusPctTxt}>{st.pct}%</Text>
                </View>
              ))}
            </View>
          )}

          {/* Explainer */}
          <View style={s.explainer}>
            <Text style={s.explainerTitle}>What this means</Text>
            <Text style={s.explainerBody}>
              <Text style={{ color: CTL_COLOR, fontWeight: '700' }}>CTL (Fitness)</Text> is your 42-day rolling training load — the bigger it is, the more work you've absorbed.{'\n'}
              <Text style={{ color: ATL_COLOR, fontWeight: '700' }}>ATL (Fatigue)</Text> is the 7-day rolling load — recent tiredness.{'\n'}
              <Text style={{ fontWeight: '700' }}>TSB (Form) = Fitness − Fatigue.</Text> Positive = fresh/tapered; very negative = overreaching. Load comes from ALL your activity, not just runs.
            </Text>
          </View>

          {/* Calibration export — daily load/CTL/ATL/TSB + model params, for cross-checking vs Bevel / HealthFit.
              Copy → clipboard; Share → file (AirDrop / Save to Files), since Universal Clipboard is flaky. */}
          <View style={s.copyRow}>
            <TouchableOpacity style={[s.copyBtn, { flex: 1, marginBottom: 0 }]} onPress={copyCalibration} disabled={copyState === 'working'}>
              <Text style={s.copyBtnText}>
                {copyState === 'done' ? '✓ Copied to clipboard' : copyState === 'working' ? 'Preparing…' : '⧉ Copy calibration data'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.copyBtn, { marginBottom: 0, paddingHorizontal: 16 }]} onPress={shareCalibration}>
              <Text style={s.copyBtnText}>⇪ Share</Text>
            </TouchableOpacity>
          </View>
          <Text style={s.copyHint}>Copies this period's daily load, CTL/ATL/TSB and model params to compare against Bevel Cardio Load / HealthFit Fitness-Fatigue.</Text>

        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const makeCh = (c: Palette) => StyleSheet.create({
  yLabel: { fontSize: 10, color: c.textSub, textAlign: 'right', fontWeight: '500' },
  yLabelR: { fontSize: 10, color: c.textFaint, textAlign: 'left', fontWeight: '500' },
  loadAxisCap: { fontSize: 9, fontWeight: '700' },
  xLabel: { fontSize: 10, color: c.textSub, fontWeight: '600' },
  subAxisLabel: { fontSize: 9, color: c.textFaint, fontWeight: '700' },
  // Fixed readout line under the date range — the under-cursor values live here instead of a bubble
  // over the graph, so the chart is never covered. flexWrap keeps it on one/two lines on narrow phones.
  readout: {
    flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap',
    columnGap: 10, marginBottom: 6, minHeight: 18,
  },
  readoutDate: { fontSize: 11, color: c.textSub, fontWeight: '700' },
  readoutVals: { fontSize: 12, fontWeight: '600' },
  readoutNum:  { color: c.text, fontWeight: '800' },
  readoutSub:  { color: c.textSub, fontWeight: '600' },
});

const makeS = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border,
  },
  backBtn: { paddingHorizontal: 4 },
  backText: { fontSize: 17, color: c.accent, fontWeight: '600' },
  title: { fontSize: 17, fontWeight: '700', color: c.text },
  periodRow: {
    flexDirection: 'row', gap: 8, padding: 12,
    backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border,
  },
  periodBtn: {
    flex: 1, paddingVertical: 7, borderRadius: 8,
    borderWidth: 1, borderColor: c.border, alignItems: 'center', backgroundColor: c.surface,
  },
  periodText: { fontSize: 13, color: c.textSub, fontWeight: '600' },
  periodTextActive: { color: '#fff' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  loadingText: { marginTop: 8, color: c.textSub, fontSize: 14 },
  errorText: { fontSize: 15, color: '#c0392b', fontWeight: '700', marginBottom: 8 },
  errorDetail: { fontSize: 12, color: c.textFaint, textAlign: 'center' },
  emptyText: { fontSize: 15, color: c.textSub, textAlign: 'center', marginBottom: 6, fontWeight: '600' },
  emptyHint: { fontSize: 13, color: c.textFaint, textAlign: 'center' },
  scroll: { padding: 12, paddingBottom: 40 },

  summaryRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  summaryBox: {
    flex: 1, backgroundColor: c.surface, borderRadius: 10, paddingVertical: 10, alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: c.shadowOpacity, shadowRadius: 3, elevation: 2,
  },
  summaryVal: { fontSize: 20, fontWeight: '800' },
  summaryLbl: { fontSize: 10, color: c.textSub, marginTop: 2, fontWeight: '500' },

  statusBanner: {
    backgroundColor: c.surface, borderRadius: 10, padding: 12, marginBottom: 12,
    borderLeftWidth: 4,
  },
  statusLabel: { fontSize: 15, fontWeight: '800', marginBottom: 2 },
  statusHint: { fontSize: 13, color: c.textSub, lineHeight: 18 },

  chartWrap: {
    backgroundColor: c.surface, borderRadius: 12,
    padding: CARD_PADDING, paddingBottom: 10, marginBottom: 12,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: c.shadowOpacity, shadowRadius: 3, elevation: 2,
  },
  navRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  navBtn: { paddingHorizontal: 4, paddingVertical: 4 },
  navBtnDisabled: { opacity: 0.25 },
  navArrow: { fontSize: 28, color: c.text, fontWeight: '600', lineHeight: 32 },
  navArrowDisabled: { color: c.textFaint },
  navLabel: { flex: 1, textAlign: 'center', fontSize: 12, color: c.textSub, fontWeight: '600' },

  legendRow: { flexDirection: 'row', justifyContent: 'center', gap: 20, marginTop: 10 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { fontSize: 12, color: c.textSub, fontWeight: '600' },
  scrubHint: { fontSize: 11, color: c.textFaint, textAlign: 'center', marginTop: 6, fontStyle: 'italic' },
  statusCard: { backgroundColor: c.surface, borderRadius: 14, padding: 14, marginBottom: 14 },
  statusCardTitle: { fontSize: 12, fontWeight: '700', color: c.textSub, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 },
  statusRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7 },
  statusName: { fontSize: 14, fontWeight: '600', color: c.text, width: 104 },
  statusDaysTxt: { fontSize: 13, color: c.textSub, width: 34 },
  statusBarBg: { flex: 1, height: 8, borderRadius: 4, backgroundColor: c.bg, marginHorizontal: 8, overflow: 'hidden' },
  statusBarFill: { height: 8, borderRadius: 4 },
  statusPctTxt: { fontSize: 14, fontWeight: '700', color: c.text, width: 44, textAlign: 'right' },

  explainer: {
    backgroundColor: c.surface, borderRadius: 12, padding: 14, marginBottom: 16,
    borderLeftWidth: 3, borderLeftColor: '#3B82F6',
  },
  explainerTitle: { fontSize: 14, fontWeight: '700', color: c.text, marginBottom: 6 },
  explainerBody: { fontSize: 12, color: c.textSub, lineHeight: 19 },

  copyBtn: {
    backgroundColor: c.surface, borderRadius: 10, paddingVertical: 12, alignItems: 'center',
    borderWidth: 1, borderColor: c.border, marginBottom: 6,
  },
  copyRow: { flexDirection: 'row', gap: 8, alignItems: 'stretch', marginBottom: 6 },
  copyBtnText: { fontSize: 14, fontWeight: '700', color: c.accent },
  copyHint: { fontSize: 11, color: c.textFaint, textAlign: 'center', marginBottom: 16, paddingHorizontal: 8, lineHeight: 15 },

  listHeader: {
    fontSize: 12, fontWeight: '700', color: c.textSub,
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginLeft: 2,
  },
  listRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: c.surface, borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 10, marginBottom: 6,
  },
  listDate: { fontSize: 13, color: c.textSub },
  listVals: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  listVal: { fontSize: 14, fontWeight: '700', width: 30, textAlign: 'right' },
  listLoad: { fontSize: 11, color: c.textFaint, fontWeight: '600' },
});
