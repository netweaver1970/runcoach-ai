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
const CHART_H = 180;
const Y_AXIS_W = 34;

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

  const plotW = innerW - Y_AXIS_W;

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

  if (innerW <= 0 || data.length === 0) return <View style={{ height: CHART_H }} />;

  // Downsample to ≤120 points for render performance (CTL/ATL/TSB are smooth)
  const stride = Math.max(1, Math.ceil(data.length / 120));
  const pts = data.filter((_, i) => i % stride === 0 || i === data.length - 1);
  const trendByDate = new Map(data.map((d, i) => [d.date, ratioTrend(data, i)])); // ratio slope per day (full series)

  // Scale across all three series + the optimal-load band top (1.3×CTL); force 0 in so TSB zero shows
  const allVals = pts.flatMap(d => [d.ctl, d.atl, d.tsb, d.ctl * 1.3]);
  const scale = niceScale(Math.min(...allVals, 0), Math.max(...allVals, 1));
  const toY = (v: number) => CHART_H - ((v - scale.min) / (scale.max - scale.min)) * CHART_H;
  const xOf = (i: number) => (i / Math.max(1, pts.length - 1)) * plotW;

  const xAxisH = 22;
  const labelIdxs = new Set<number>();
  const nLabels = Math.min(5, pts.length);
  for (let k = 0; k < nLabels; k++) labelIdxs.add(Math.round((k / (nLabels - 1 || 1)) * (pts.length - 1)));

  const renderLine = (key: 'ctl' | 'atl' | 'tsb', color: string, width = 2.5) => (
    pts.map((d, i) => {
      if (i === 0) return null;
      const a = pts[i - 1], b = d;
      const x1 = xOf(i - 1), y1 = toY(a[key]);
      const x2 = xOf(i),     y2 = toY(b[key]);
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

  // Cursor → nearest point
  const cursorIdx = cursorX == null ? -1
    : Math.max(0, Math.min(pts.length - 1, Math.round((cursorX / plotW) * (pts.length - 1))));
  const cur = cursorIdx >= 0 ? pts[cursorIdx] : null;
  const curX = cursorIdx >= 0 ? xOf(cursorIdx) : 0;
  const tipW = 116;
  const tipLeft = Math.max(0, Math.min(plotW - tipW, curX - tipW / 2));

  return (
    <View style={{ flexDirection: 'row' }}>
      <View style={{ width: Y_AXIS_W, height: CHART_H }}>
        {scale.ticks.map((t, i) => (
          <Text key={i} style={[ch.yLabel, { position: 'absolute', top: toY(t) - 8, right: 4 }]}>{t}</Text>
        ))}
      </View>
      <View ref={plotRef} onLayout={measurePlot} style={{ width: plotW, height: CHART_H + xAxisH, position: 'relative' }} {...pan.panHandlers}>
        {scale.ticks.map((t, i) => (
          <View key={i} style={{
            position: 'absolute', top: toY(t), left: 0, right: 0,
            height: t === 0 ? 1.5 : 1, backgroundColor: t === 0 ? c.textFaint : c.gridline,
          }} />
        ))}
        {/* Optimal-load band: 0.8–1.3×CTL per day (the "calculated range") */}
        {pts.map((d, i) => {
          if (d.ctl <= 0) return null;
          const yTop = toY(d.ctl * 1.3), yBot = toY(d.ctl * 0.8);
          const w = plotW / Math.max(1, pts.length - 1) + 1;
          return (
            <View key={`band-${i}`} style={{
              position: 'absolute', left: xOf(i) - w / 2, width: w,
              top: yTop, height: Math.max(1, yBot - yTop),
              backgroundColor: '#8e7cc326',
            }} />
          );
        })}
        {renderLine('ctl', CTL_COLOR)}
        {renderLine('atl', ATL_COLOR)}
        {renderLine('tsb', TSB_COLOR, 2)}
        {/* Cardio-status dots on the ATL (load) line — trend from the FULL daily series (by date) */}
        {pts.map((d, i) => {
          const st = cardioLoadStatus(d.atl, d.ctl, d.tsb, trendByDate.get(d.date));
          return (
            <View key={`st-${i}`} style={{
              position: 'absolute', left: xOf(i) - 3.5, top: toY(d.atl) - 3.5,
              width: 7, height: 7, borderRadius: 3.5, backgroundColor: st.color,
              borderWidth: 1, borderColor: c.bg,
            }} />
          );
        })}

        {/* Cursor: vertical line, series dots, tooltip */}
        {cur && (
          <>
            <View style={{ position: 'absolute', left: curX, top: 0, width: 1, height: CHART_H, backgroundColor: '#999' }} />
            {([['ctl', CTL_COLOR], ['atl', ATL_COLOR], ['tsb', TSB_COLOR]] as const).map(([k, c]) => (
              <View key={k} style={{
                position: 'absolute', left: curX - 3.5, top: toY(cur[k]) - 3.5,
                width: 7, height: 7, borderRadius: 3.5, backgroundColor: c,
                borderWidth: 1, borderColor: '#fff',
              }} />
            ))}
            <View style={[ch.tip, { left: tipLeft, width: tipW }]}>
              <Text style={ch.tipDate}>{cur.date.slice(5)}</Text>
              <Text style={ch.tipRow}><Text style={{ color: CTL_COLOR }}>CTL </Text>{Math.round(cur.ctl)}   <Text style={{ color: ATL_COLOR }}>ATL </Text>{Math.round(cur.atl)}</Text>
              <Text style={ch.tipRow}><Text style={{ color: TSB_COLOR }}>TSB </Text>{cur.tsb >= 0 ? '+' : ''}{Math.round(cur.tsb)}{cur.load > 0 ? `   load ${Math.round(cur.load)}` : ''}</Text>
            </View>
          </>
        )}

        {pts.map((d, i) => labelIdxs.has(i) ? (
          <Text key={`x-${i}`} style={[ch.xLabel, {
            position: 'absolute', top: CHART_H + 4, left: xOf(i) - 18, width: 36, textAlign: 'center',
          }]} numberOfLines={1}>{fmtDM(d.date)}</Text>
        ) : null)}
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

          {/* Calibration export — daily load/CTL/ATL/TSB + model params → clipboard, for cross-checking vs Bevel / HealthFit */}
          <TouchableOpacity style={s.copyBtn} onPress={copyCalibration} disabled={copyState === 'working'}>
            <Text style={s.copyBtnText}>
              {copyState === 'done' ? '✓ Copied to clipboard' : copyState === 'working' ? 'Preparing…' : '⧉ Copy calibration data'}
            </Text>
          </TouchableOpacity>
          <Text style={s.copyHint}>Copies this period's daily load, CTL/ATL/TSB and model params to compare against Bevel Cardio Load / HealthFit Fitness-Fatigue.</Text>

        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const makeCh = (c: Palette) => StyleSheet.create({
  yLabel: { fontSize: 10, color: c.textSub, textAlign: 'right', fontWeight: '500' },
  xLabel: { fontSize: 10, color: c.textSub, fontWeight: '600' },
  tip: {
    position: 'absolute', top: 2, backgroundColor: 'rgba(20,20,24,0.92)',
    borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5,
  },
  tipDate: { color: '#fff', fontSize: 11, fontWeight: '800', marginBottom: 2 },
  tipRow:  { color: '#eee', fontSize: 11, fontWeight: '600', lineHeight: 15 },
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
