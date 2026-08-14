import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, SafeAreaView, ActivityIndicator, LayoutChangeEvent, Alert, PanResponder,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { getFullBoundary } from '../src/services/accounting';
import {
  fetchWeeklyMileageHistory,
  fetchDailyMileageHistory,
  fetchWeeklyDurationHistory,
  fetchDailyDurationHistory,
  fetchVO2MaxHistory,
  fetchRestingHRHistory,
  fetchHRVHistory,
  fetchSleepHistory,
  fetchOvernightHRHistory,
  fetchStrainHistory,
  fetchRecoveryHistory,
  fetchOurDailyComponents,
  computeSleepScore,
} from '../src/services/healthkit';
import { WeeklyMileage, TimelineEvent } from '../src/types';
import { cardioLoadStatus, ratioTrend, computeSleepBankSeries } from '../src/services/trainingLoad';
import { loadEvents, saveEvent, deleteEvent } from '../src/services/timelineEvents';
import { useTheme, useThemedStyles, Palette } from '../src/theme';

type HistoryType = 'km' | 'time' | 'vo2' | 'rhr' | 'hrv' | 'timeline' | 'strain' | 'recovery'
  | 'sleep-total' | 'sleep-deep' | 'sleep-rem' | 'sleep-score' | 'sleep-efficiency'
  | 'sleep-hrdip' | 'sleep-bank' | 'sleep-awake'
  // component sub-metrics (sourced from fetchOurDailyComponents)
  | 'exercise-duration' | 'daytime-hr' | 'total-energy' | 'step-count'
  | 'resp-rate' | 'spo2' | 'cardio-load';

// Sub-metric history types → the key inside fetchOurDailyComponents' per-day record.
const COMPONENT_KEY: Partial<Record<HistoryType, string>> = {
  'exercise-duration': 'exerciseDuration',
  'daytime-hr':        'daytimeHR',
  'total-energy':      'totalEnergy',
  'step-count':        'stepCount',
  'resp-rate':         'respiratoryRate',
  'spo2':              'oxygenSaturation',
  'cardio-load':       'cardioLoad',
};
type Period = '1M' | '3M' | '6M' | '1Y';

const PERIOD_MONTHS: Record<Period, number> = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12 };

// chartWrap padding is 12px each side → 24px total subtracted from containerW
const CARD_PADDING = 12;

/**
 * Max bars shown per period.
 * 1M: show ALL daily readings — no aggregation.
 * 3M: weekly bars (~13).
 * 6M: show all weekly bars — no aggregation (up to ~26).
 * 1Y: use groupByMonth() instead of aggregateBuckets().
 */
const PERIOD_BUCKETS: Record<Period, number> = {
  '1M': 999,   // never aggregate for 1-month view (daily)
  '3M': 13,
  '6M': 999,   // never aggregate — show every week
  '1Y': 999,   // not used directly; groupByMonth() handles 1Y
};

interface DataPoint { label: string; value: number; fullDate: string; missing?: boolean; }

const SLEEP_TYPES = new Set(['sleep-total', 'sleep-deep', 'sleep-rem', 'sleep-score', 'sleep-efficiency', 'sleep-hrdip', 'sleep-bank', 'sleep-awake']);

const CONFIGS: Record<Exclude<HistoryType, 'timeline'>, {
  title: string; unit: string; color: string; aggregate: 'sum' | 'avg';
}> = {
  km:               { title: 'Weekly km',       unit: 'km',         color: '#FF6B35', aggregate: 'sum' },
  time:             { title: 'Time on Feet',    unit: 'min',        color: '#2980b9', aggregate: 'sum' },
  vo2:              { title: 'VO₂ Max',        unit: 'ml/kg/min',  color: '#27ae60', aggregate: 'avg' },
  rhr:              { title: 'Resting HR',     unit: 'bpm',         color: '#e74c3c', aggregate: 'avg' },
  hrv:              { title: 'Nightly HRV',    unit: 'ms',          color: '#8e44ad', aggregate: 'avg' },
  strain:           { title: 'Strain',         unit: '%',           color: '#e67e22', aggregate: 'avg' },
  recovery:         { title: 'Recovery',       unit: '/ 100',       color: '#27ae60', aggregate: 'avg' },
  'sleep-total':    { title: 'Time Asleep',    unit: 'min',         color: '#2980b9', aggregate: 'avg' },
  'sleep-deep':     { title: 'Deep Sleep',     unit: 'min',         color: '#3498db', aggregate: 'avg' },
  'sleep-rem':      { title: 'REM Sleep',      unit: 'min',         color: '#9b59b6', aggregate: 'avg' },
  'sleep-score':    { title: 'Sleep Score',    unit: '/ 100',       color: '#8e44ad', aggregate: 'avg' },
  'sleep-efficiency':{ title: 'Sleep Efficiency', unit: '%',        color: '#27ae60', aggregate: 'avg' },
  'sleep-hrdip':    { title: 'HR Dip',           unit: '%',         color: '#e74c3c', aggregate: 'avg' },
  'sleep-bank':     { title: 'Sleep Bank',        unit: 'min',       color: '#27ae60', aggregate: 'avg' },
  'sleep-awake':    { title: 'Time Awake',        unit: 'min',       color: '#e67e22', aggregate: 'avg' },
  'exercise-duration':{ title: 'Exercise Duration', unit: 'min',     color: '#2980b9', aggregate: 'avg' },
  'daytime-hr':     { title: 'Daytime HR',        unit: 'bpm',       color: '#e74c3c', aggregate: 'avg' },
  'total-energy':   { title: 'Total Energy',      unit: 'kcal',      color: '#e67e22', aggregate: 'avg' },
  'step-count':     { title: 'Step Count',        unit: '',          color: '#16a085', aggregate: 'avg' },
  'resp-rate':      { title: 'Respiratory Rate',  unit: 'rpm',       color: '#2980b9', aggregate: 'avg' },
  'spo2':           { title: 'Oxygen Saturation', unit: '%',         color: '#27ae60', aggregate: 'avg' },
  'cardio-load':    { title: 'Cardio Load',       unit: '',          color: '#F97316', aggregate: 'avg' },
};

function fmtInt(v: number): string { return String(Math.round(v)); }

function fmtVal(v: number): string {
  return v % 1 === 0 || v > 10 ? String(Math.round(v)) : v.toFixed(1);
}

function fmtOneDecimal(v: number): string { return v.toFixed(1); }

/** Format signed minutes as ±HH:MM or ±MM (for Sleep Bank) */
function fmtSignedMin(v: number): string {
  const sign = v >= 0 ? '+' : '-';
  const abs  = Math.abs(Math.round(v));
  if (abs >= 60) {
    const h  = Math.floor(abs / 60);
    const mm = abs % 60;
    return `${sign}${h}:${String(mm).padStart(2, '0')}`;
  }
  return `${sign}${abs}`;
}

/** Format signed minutes as plain ±MM (no HH:MM) — clearer for Sleep Bank than a clock-looking value */
function fmtSignedMinPlain(v: number): string {
  return `${v >= 0 ? '+' : '-'}${Math.abs(Math.round(v))}`;
}

/**
 * Aggregate daily data points to one reading per calendar week (Monday = week start).
 * mode 'last'  → latest reading of the week (good for slowly-changing measures like VO2max/RHR)
 * mode 'avg'   → average of all readings in the week (good for HRV)
 * mode 'sum'   → sum (not used here, kept for symmetry)
 */
function groupByWeek(data: DataPoint[], mode: 'sum' | 'avg' | 'last'): DataPoint[] {
  const map = new Map<string, DataPoint[]>();
  for (const d of data) {
    const mon = getMondayOf(d.fullDate);
    const key = mon.toISOString().slice(0, 10);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(d);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, pts]) => {
      const sorted = [...pts].sort((a, b) => a.fullDate.localeCompare(b.fullDate));
      let value: number;
      if (mode === 'last') value = sorted[sorted.length - 1].value;
      else if (mode === 'sum') value = pts.reduce((s, p) => s + p.value, 0);
      else value = pts.reduce((s, p) => s + p.value, 0) / pts.length;
      return { label: key, value, fullDate: key };
    });
}

/**
 * Format minutes as HH:MM when ≥ 60 min, otherwise just MM.
 * e.g. 83 → "1:23",  45 → "45"
 */
function fmtMin(min: number): string {
  const m = Math.round(min);
  if (m >= 60) {
    const h  = Math.floor(m / 60);
    const mm = m % 60;
    return `${h}:${String(mm).padStart(2, '0')}`;
  }
  return String(m);
}

/** Get the Monday of the week containing the given ISO date */
function getMondayOf(iso: string): Date {
  const d = new Date(iso);
  const diff = (d.getDay() + 6) % 7;
  const mon = new Date(d);
  mon.setDate(d.getDate() - diff);
  mon.setHours(0, 0, 0, 0);
  return mon;
}

/** D/M with no leading zeros */
function formatDM(d: Date): string {
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

/** 'YY */
function formatYY(d: Date): string {
  return `'${String(d.getFullYear()).slice(2)}`;
}

/** Compact date range including year for both ends: "3 Apr '25 – 3 Jul '25" */
function formatDateRange(from: Date, to: Date): string {
  const dm  = (d: Date) => `${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })}`;
  const yy  = (d: Date) => `'${String(d.getFullYear()).slice(2)}`;
  return `${dm(from)} ${yy(from)} – ${dm(to)} ${yy(to)}`;
}

function niceScale(rawMin: number, rawMax: number) {
  if (rawMax <= rawMin) rawMax = rawMin + 1;
  const range   = rawMax - rawMin;
  const rawStep = range / 4;
  const mag     = Math.pow(10, Math.floor(Math.log10(Math.max(rawStep, 0.001))));
  const norm    = rawStep / mag;
  const step    = norm < 1.5 ? mag : norm < 3.5 ? 2 * mag : norm < 7.5 ? 5 * mag : 10 * mag;
  const niceMin = Math.floor(rawMin / step) * step;
  const niceMax = Math.ceil(rawMax / step) * step;
  const ticks: number[] = [];
  for (let t = niceMin; t <= niceMax + step * 0.01; t += step) {
    ticks.push(Math.round(t * 1000) / 1000);
  }
  return { niceMin, niceMax, ticks };
}

function aggregateBuckets(
  data: DataPoint[], maxBuckets: number, mode: 'sum' | 'avg',
): DataPoint[] {
  if (data.length <= maxBuckets) return data;
  const bucketSize = data.length / maxBuckets;
  const result: DataPoint[] = [];
  for (let b = 0; b < maxBuckets; b++) {
    const start = Math.round(b * bucketSize);
    const end   = Math.round((b + 1) * bucketSize);
    const slice = data.slice(start, end);
    if (slice.length === 0) continue;
    const value = mode === 'sum'
      ? slice.reduce((s, d) => s + d.value, 0)
      : slice.reduce((s, d) => s + d.value, 0) / slice.length;
    result.push({ value, label: slice[0].label, fullDate: slice[0].fullDate });
  }
  return result;
}

/**
 * Aggregate data points by calendar month.
 * Used for the 1Y km view so each bar = one calendar month.
 */
function groupByMonth(data: DataPoint[], mode: 'sum' | 'avg'): DataPoint[] {
  const map = new Map<string, number[]>(); // 'YYYY-MM' → values
  for (const d of data) {
    const dt  = new Date(d.fullDate);
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(d.value);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, vals]) => {
      const value = mode === 'sum'
        ? vals.reduce((s, v) => s + v, 0)
        : vals.reduce((s, v) => s + v, 0) / vals.length;
      return { label: key, value, fullDate: key + '-01' };
    });
}

/** Running total of data points — used for cumulative mode. */
function toCumulative(data: DataPoint[]): DataPoint[] {
  let acc = 0;
  // Cumulative is a continuous running total — carry through no-data days (flat), so clear `missing`.
  return data.map(d => { acc += d.value; return { ...d, value: acc, missing: false }; });
}

// Fill a sorted daily series with EVERY calendar day in [from, to]; days with no datapoint become
// `missing` placeholders. The chart then spans the whole window (gaps where there's no data) instead
// of collapsing the x-axis to only the days that have values. Used for the 1-month (daily) view.
function fillDailyGaps(data: DataPoint[], from: Date, to: Date): DataPoint[] {
  const byDate = new Map(data.map(d => [d.fullDate.slice(0, 10), d]));
  const out: DataPoint[] = [];
  const p = (n: number) => String(n).padStart(2, '0');
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  while (d <= end) {
    const key = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    out.push(byDate.get(key) ?? { label: key, fullDate: key, value: 0, missing: true });
    d.setDate(d.getDate() + 1);
  }
  return out;
}

// ─── Chart ────────────────────────────────────────────────────────────────────

const CHART_H = 200;
const Y_AXIS_W = 34;

// xMode controls how x-axis labels are formatted.
// 'daily'   → D/M for each bar (1M view)
// 'weekly'  → D/M every few bars (3M / 6M view)
// 'monthly' → "Jan '25" for each bar (1Y view)
type XMode = 'daily' | 'weekly' | 'monthly';

function Chart({
  data, color, innerW, xMode = 'weekly', showAllValues = false, prevData,
  cumulative = false, isTime = false, valueLabelStep = 1, fmtFn, zeroBase = true,
  hideValueLabels = false, lineMode = false, bandData, pointColors, boundaryDate,
}: {
  data:            DataPoint[];
  color:           string;
  innerW:          number;
  xMode?:          XMode;
  showAllValues?:  boolean;
  prevData?:       DataPoint[]; // previous period (cumulative), shown as grey line overlay
  cumulative?:     boolean;     // when true: render as line chart instead of bars
  isTime?:         boolean;     // when true: format values as HH:MM / MM
  valueLabelStep?: number;      // show every Nth value label (default 1 = every label)
  fmtFn?:          (v: number) => string; // override value formatter (e.g. 1-decimal for VO2max)
  zeroBase?:       boolean;     // when false: y-axis zooms in around data range (default true)
  hideValueLabels?: boolean;    // suppress all per-bar value labels
  lineMode?:       boolean;     // force line rendering (cardio-load: line + band + status dots)
  bandData?:       ({ lo: number; hi: number } | null)[]; // per-point optimal-load band (aligned to data)
  pointColors?:    (string | null)[]; // per-point dot colour (cardio status), aligned to data
  boundaryDate?:   string;            // work→full accounting boundary (YYYY-MM-DD) → vertical marker
}) {
  const ch = useThemedStyles(makeCh);
  const { c: theme } = useTheme();
  // Scrubber cursor (hooks must precede any early return)
  const [cursorX, setCursorX] = useState<number | null>(null);
  const plotRef  = useRef<View>(null);
  const plotLeft = useRef(0);
  const measurePlot = () => plotRef.current?.measureInWindow((x) => { plotLeft.current = x; });
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > Math.abs(g.dy) && Math.abs(g.dx) > 3,
      // Absolute screen X minus the plot's measured left (locationX is relative to
      // the touched child, so it's unusable for positioning).
      onPanResponderGrant: (_e, g) => setCursorX(g.x0 - plotLeft.current),
      onPanResponderMove:  (_e, g) => setCursorX(g.moveX - plotLeft.current),
      onPanResponderTerminationRequest: () => false,
    })
  ).current;

  if (data.length === 0 || innerW <= 0) return null;

  // Value formatter: custom override, then minutes → HH:MM / MM, or plain integer
  const fmt = fmtFn ?? (isTime ? fmtMin : fmtInt);

  // Use the longer dataset to compute slot width so all points fit
  const allSets   = [data, ...(prevData ? [prevData] : [])];
  const maxLen    = Math.max(...allSets.map(s => s.length)) || 1;
  // y-scale spans both datasets + the optimal-load band (so the band is always visible)
  const bandVals = bandData ? bandData.flatMap(b => (b ? [b.lo, b.hi] : [])) : [];
  // Exclude `missing` (no-data) days so a padded 0 can't drag the y-scale down to zero.
  const allValues = [...allSets.flatMap(s => s.filter(d => !d.missing).map(d => d.value)), ...bandVals];
  const rawMin = allValues.length ? Math.min(...allValues) : 0;
  const rawMax = allValues.length ? Math.max(...allValues) : 1;
  const padTop = (rawMax - rawMin) * 0.15 || 2;
  // Y-axis lower bound: NEVER go negative for non-negative data (energy, duration, distance, HR…). Only
  // allow a negative axis when the data itself genuinely dips below 0 (e.g. TSB/form). Otherwise zoom
  // dynamically around the data but clamp the floor to 0. zeroBase=true anchors at 0 (bars/km/time).
  const lowerBound = rawMin < 0
    ? rawMin - padTop * 1.5
    : zeroBase ? Math.max(0, rawMin * 0.9 - 1)
               : Math.max(0, rawMin - padTop * 1.5);
  const scale  = niceScale(lowerBound, rawMax + padTop);
  const yRange = scale.niceMax - scale.niceMin || 1;

  const plotW  = innerW - Y_AXIS_W;
  const barGap = Math.max(1, Math.min(3, plotW / maxLen / 6));
  const barW   = Math.max(5, (plotW - barGap * maxLen) / maxLen);
  // Center x for a given slot index (used for line chart points)
  const cxOf   = (i: number) => i * (barW + barGap) + barW / 2;

  const toY = (v: number) =>
    CHART_H * (1 - Math.max(0, Math.min(1, (v - scale.niceMin) / yRange)));

  // Volume accounting work→full boundary: first slot at/after the switch date.
  const boundaryIdx = boundaryDate ? data.findIndex(d => d.fullDate >= boundaryDate) : -1;

  // Decide which indices get x-axis labels.
  const xLabelIdxs = new Set<number>();
  const maxXLabels = xMode === 'monthly' ? data.length
    : xMode === 'daily'   ? Math.min(8, data.length)
    : Math.min(8, data.length);
  if (maxXLabels === 1) {
    xLabelIdxs.add(0);
  } else {
    for (let i = 0; i < maxXLabels; i++) {
      xLabelIdxs.add(Math.round((i / (maxXLabels - 1)) * (data.length - 1)));
    }
  }

  // Decide which indices get value labels.
  const valueLabelIdxs = new Set<number>();
  if (hideValueLabels) {
    // none — cleaner chart (e.g. strain)
  } else if (showAllValues || xMode === 'monthly') {
    for (let i = 0; i < data.length; i++) {
      if (i % valueLabelStep === 0) valueLabelIdxs.add(i);
    }
    // Always label the last point so users can see the period total
    if (data.length > 0) valueLabelIdxs.add(data.length - 1);
  } else {
    xLabelIdxs.forEach(i => valueLabelIdxs.add(i));
  }

  // X-axis label formatter
  const fmtXLabel = (d: DataPoint): { line1: string; line2: string } => {
    if (xMode === 'monthly') {
      const dt = new Date(d.fullDate);
      return {
        line1: dt.toLocaleString('en-GB', { month: 'short' }),
        line2: `'${String(dt.getFullYear()).slice(2)}`,
      };
    }
    const mon = xMode === 'daily' ? new Date(d.fullDate) : getMondayOf(d.fullDate);
    return { line1: formatDM(mon), line2: formatYY(mon) };
  };

  // Comparing two periods → dodge the bars side-by-side (slight overlap) so BOTH heights are visible
  // instead of the current bar hiding the previous one. Also drives coloured x-labels + a 2nd date row.
  const hasPrev  = !!(prevData && prevData.length);
  const dodgeW   = hasPrev ? Math.max(3, barW * 0.72) : barW;   // sub-bar width when both periods are shown
  const fmtRange = (pts: DataPoint[]) => {
    if (!pts.length) return '';
    const f = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    return `${f(pts[0].fullDate)} – ${f(pts[pts.length - 1].fullDate)}`;
  };
  const xAxisH = hasPrev ? 50 : 34;
  // Font size: reduce by 1pt vs previous (was 8/11); dense daily view uses smaller
  const valueFontSize = showAllValues && data.length > 20 ? 7 : 10;
  const valueOffset   = showAllValues && data.length > 20 ? 11 : 15;
  // Line chart geometry
  const lineW     = 2.5;
  const prevLineW = 2;
  const dotR      = data.length > 20 ? 2 : 3;

  // Cursor → nearest data index. `cur` defaults to the LATEST point when not scrubbing, so the fixed
  // readout line above the chart always shows a value; the cursor line only appears once you scrub.
  const cursorIdx = cursorX == null ? -1
    : Math.max(0, Math.min(data.length - 1, Math.round((cursorX - barW / 2) / (barW + barGap))));
  const cur   = cursorIdx >= 0 ? data[cursorIdx] : data[data.length - 1];
  const curCx = cursorIdx >= 0 ? cxOf(cursorIdx) : -1;   // <0 → no visible cursor line

  return (
   <View>
    {/* READOUT LINE — under-cursor (or latest) value shown here instead of a bubble over the graph. */}
    <View style={ch.readout}>
      <Text style={ch.readoutDate}>{cur ? cur.fullDate.slice(0, 10) : ''}{cursorIdx < 0 ? ' · latest' : ''}</Text>
      <Text style={[ch.readoutVal, { color }]}>{cur ? (cur.missing ? '—' : fmt(cur.value)) : ''}</Text>
    </View>
    <View style={{ flexDirection: 'row' }}>
      {/* Y-axis */}
      <View style={{ width: Y_AXIS_W, height: CHART_H }}>
        {scale.ticks.map((tick, i) => (
          <Text key={i} style={[ch.yLabel, { position: 'absolute', top: toY(tick) - 8, right: 4 }]}>
            {fmt(tick)}
          </Text>
        ))}
      </View>

      {/* Plot area */}
      <View ref={plotRef} onLayout={measurePlot} style={{ width: plotW, height: CHART_H + xAxisH, position: 'relative' }} {...pan.panHandlers}>
        {/* Gridlines */}
        {scale.ticks.map((tick, i) => (
          <View key={i} style={{
            position: 'absolute', top: toY(tick), left: 0, right: 0,
            height: tick === 0 ? 1.5 : 1,
            backgroundColor: tick === 0 ? theme.textFaint : theme.gridline,
          }} />
        ))}

        {/* Volume accounting regime boundary: vertical divider + "full →" label */}
        {boundaryIdx >= 0 && (
          <>
            <View pointerEvents="none" style={{
              position: 'absolute', top: 0, height: CHART_H, left: cxOf(boundaryIdx),
              borderLeftWidth: 1, borderColor: theme.accent, borderStyle: 'dashed', opacity: 0.8,
            }} />
            <Text style={{
              position: 'absolute', top: 1, left: cxOf(boundaryIdx) + 3,
              fontSize: 8, fontWeight: '700', color: theme.accent,
            }}>full →</Text>
          </>
        )}

        {(cumulative || lineMode) ? (
          // ── LINE CHART (cumulative mode, or cardio-load with band) ──────────
          <>
            {/* Optimal-load band (cardio-load): translucent column per point, bandLo→bandHi */}
            {bandData && data.map((d, i) => {
              const b = bandData[i];
              if (!b || b.hi <= b.lo) return null;
              const yTop = toY(b.hi), yBot = toY(b.lo);
              return (
                <View key={`band-${i}`} style={{
                  position: 'absolute',
                  left: cxOf(i) - (barW + barGap) / 2, width: barW + barGap,
                  top: yTop, height: Math.max(1, yBot - yTop),
                  backgroundColor: '#8e7cc333', // translucent violet — the optimal-load zone
                }} />
              );
            })}
            {/* Previous period: grey line segments */}
            {prevData && prevData.length > 1 && prevData.map((d, i) => {
              if (i === 0 || d.missing || prevData[i - 1].missing) return null;
              const x1 = cxOf(i - 1), y1 = toY(prevData[i - 1].value);
              const x2 = cxOf(i),     y2 = toY(d.value);
              const dx = x2 - x1,     dy = y2 - y1;
              const length = Math.sqrt(dx * dx + dy * dy);
              const angle  = Math.atan2(dy, dx) * 180 / Math.PI;
              return (
                <View key={`prev-seg-${i}`} style={{
                  position: 'absolute',
                  width: length, height: prevLineW,
                  left: (x1 + x2) / 2 - length / 2,
                  top:  (y1 + y2) / 2 - prevLineW / 2,
                  backgroundColor: '#999',
                  transform: [{ rotate: `${angle}deg` }],
                }} />
              );
            })}
            {/* Previous period: grey dots */}
            {prevData && prevData.map((d, i) => d.missing ? null : (
              <View key={`prev-dot-${i}`} style={{
                position: 'absolute',
                width: 4, height: 4, borderRadius: 2,
                left: cxOf(i) - 2, top: toY(d.value) - 2,
                backgroundColor: '#999',
              }} />
            ))}

            {/* Current period: colored line segments */}
            {data.length > 1 && data.map((d, i) => {
              if (i === 0 || d.missing || data[i - 1].missing) return null;
              const x1 = cxOf(i - 1), y1 = toY(data[i - 1].value);
              const x2 = cxOf(i),     y2 = toY(d.value);
              const dx = x2 - x1,     dy = y2 - y1;
              const length = Math.sqrt(dx * dx + dy * dy);
              const angle  = Math.atan2(dy, dx) * 180 / Math.PI;
              return (
                <View key={`seg-${i}`} style={{
                  position: 'absolute',
                  width: length, height: lineW,
                  left: (x1 + x2) / 2 - length / 2,
                  top:  (y1 + y2) / 2 - lineW / 2,
                  backgroundColor: color,
                  transform: [{ rotate: `${angle}deg` }],
                }} />
              );
            })}
            {/* Current period: dots — coloured by status when pointColors supplied (cardio-load) */}
            {data.map((d, i) => {
              if (d.missing) return null;
              const r = pointColors ? dotR + 1.5 : dotR; // status dots a touch bigger
              return (
                <View key={`dot-${i}`} style={{
                  position: 'absolute',
                  width: r * 2, height: r * 2, borderRadius: r,
                  left: cxOf(i) - r, top: toY(d.value) - r,
                  backgroundColor: pointColors?.[i] ?? color,
                  ...(pointColors ? { borderWidth: 1, borderColor: theme.bg } : {}),
                }} />
              );
            })}

            {/* Value labels above each labeled point */}
            {data.map((d, i) => {
              if (!valueLabelIdxs.has(i) || d.missing) return null;
              const cx = cxOf(i), cy = toY(d.value);
              return (
                <Text key={`vl-${i}`} style={{
                  position: 'absolute',
                  top: cy - valueOffset - dotR,
                  left: cx - 20, width: 40,
                  fontSize: valueFontSize, color: theme.text, textAlign: 'center', fontWeight: '700',
                }} numberOfLines={1}>
                  {fmt(d.value)}
                </Text>
              );
            })}

            {/* X-axis labels below chart */}
            {data.map((d, i) => {
              if (!xLabelIdxs.has(i)) return null;
              const xl = fmtXLabel(d);
              return (
                <View key={`xl-${i}`} style={{
                  position: 'absolute', top: CHART_H + 3,
                  left: cxOf(i) - 16, width: 32,
                  alignItems: 'center',
                }}>
                  <Text style={[ch.xLabel, hasPrev && { color, fontWeight: '700' as const }]} numberOfLines={1}>{xl.line1}</Text>
                  <Text style={ch.xLabelYear} numberOfLines={1}>{xl.line2}</Text>
                </View>
              );
            })}
          </>
        ) : (
          // ── BAR CHART (absolute mode) ───────────────────────────────────────
          <>
            {/* Previous-period grey bars — LEFT-dodged so both heights read */}
            {prevData && prevData.map((d, i) => {
              const x    = i * (barW + barGap);
              const barH = Math.max(2, CHART_H - toY(d.value));
              return (
                <View key={`prev-${i}`} style={{
                  position: 'absolute', left: x, top: CHART_H - barH,
                  width: dodgeW, height: barH,
                  backgroundColor: '#9aa0a6', borderRadius: 3, opacity: 0.55,
                }} />
              );
            })}

            {/* Current-period bars + labels */}
            {data.map((d, i) => {
              const x    = i * (barW + barGap);
              const barH = Math.max(2, CHART_H - toY(d.value));
              const showV = valueLabelIdxs.has(i);
              const showX = xLabelIdxs.has(i);
              const xl    = showX ? fmtXLabel(d) : null;

              return (
                <View key={i}>
                  {/* Bar — RIGHT-dodged over the previous bar (slight overlap) so both heights read.
                      When there's no previous period it fills the whole slot as before. */}
                  {!d.missing && (
                  <View style={{
                    position: 'absolute', left: x + (barW - dodgeW), top: CHART_H - barH,
                    width: dodgeW, height: barH,
                    backgroundColor: color, borderRadius: 3, opacity: 0.9,
                  }} />
                  )}

                  {/* Value label above bar */}
                  {showV && !d.missing && (
                    <Text style={{
                      position: 'absolute',
                      top: CHART_H - barH - valueOffset,
                      left: x - 10, width: barW + 20,
                      fontSize: valueFontSize, color: theme.text, textAlign: 'center', fontWeight: '700',
                    }} numberOfLines={1}>
                      {fmt(d.value)}
                    </Text>
                  )}

                  {/* X-axis label */}
                  {xl && (
                    <View style={{
                      position: 'absolute', top: CHART_H + 3,
                      left: x - 12, width: barW + 24,
                      alignItems: 'center',
                    }}>
                      <Text style={ch.xLabel} numberOfLines={1}>{xl.line1}</Text>
                      <Text style={ch.xLabelYear} numberOfLines={1}>{xl.line2}</Text>
                    </View>
                  )}
                </View>
              );
            })}
          </>
        )}

        {/* 2nd x-axis row: the PREVIOUS period's date range (grey), so the grey series is dated too. */}
        {hasPrev && (
          <View pointerEvents="none" style={{ position: 'absolute', top: CHART_H + 34, left: 0, width: plotW, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 5 }}>
            <View style={{ width: 12, height: 4, borderRadius: 2, backgroundColor: '#9aa0a6' }} />
            <Text style={ch.prevRange} numberOfLines={1}>prev: {fmtRange(prevData!)}</Text>
          </View>
        )}

        {/* Scrubber cursor — only the thin line + dot; the value is shown in the readout line above. */}
        {curCx >= 0 && cur && (
          <>
            <View style={{ position: 'absolute', left: curCx, top: 0, width: 1, height: CHART_H, backgroundColor: '#999' }} />
            {!cur.missing && (
            <View style={{
              position: 'absolute', left: curCx - 4, top: toY(cur.value) - 4,
              width: 8, height: 8, borderRadius: 4, backgroundColor: color, borderWidth: 1, borderColor: '#fff',
            }} />
            )}
          </>
        )}
      </View>
    </View>
   </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function HistoryScreen() {
  const { type } = useLocalSearchParams<{ type: string }>();
  const router   = useRouter();
  const s = useThemedStyles(makeS);
  const { c } = useTheme();

  // Default to the 1-month view for strain/sleep/recovery + their sub-components;
  // keep 3M for running mileage/time/VO₂ where a longer trend reads better.
  const RUNNING_TYPES = new Set(['km', 'time', 'vo2']);
  const [period, setPeriod]             = useState<Period>(RUNNING_TYPES.has(type as string) ? '3M' : '1M');
  const [pageOffset, setPageOffset]     = useState(0);
  const [rawData, setRawData]           = useState<DataPoint[]>([]);
  const [prevRawData, setPrevRawData]   = useState<DataPoint[]>([]);
  // Cardio-load only: per-day training-status breakdown over the loaded period.
  const [cardioStatus, setCardioStatus] = useState<{ label: string; color: string; days: number; pct: number }[]>([]);
  const [cardioByDate, setCardioByDate] = useState<Record<string, { lo: number; hi: number; color: string }>>({});
  const [fullBoundary, setFullBoundary] = useState<string | null>(null);
  const [cumulativeMode, setCumulative] = useState(false);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState<string | null>(null);
  const [innerW, setInnerW]             = useState(0);

  const histType = (type ?? 'km') as HistoryType;
  // Volume-accounting work→full boundary, marked on the time-on-feet (exercise duration) chart.
  useEffect(() => {
    if (histType === 'exercise-duration') getFullBoundary().then(setFullBoundary).catch(() => {});
  }, [histType]);
  const rawCfg   = (histType !== 'timeline' && histType in CONFIGS)
    ? (CONFIGS[histType as Exclude<HistoryType,'timeline'>] ?? CONFIGS.km)
    : CONFIGS.km;
  // The km/distance KPI used the brand orange as its colour — resolve it to the live accent so its
  // period tabs, chart line, totals and spinner follow the user's chosen accent. Other KPIs keep
  // their intentional semantic colours (strain orange, VO₂ green, RHR red, …).
  const cfg      = rawCfg.color === '#FF6B35' ? { ...rawCfg, color: c.accent } : rawCfg;
  const supportsOverlay = histType === 'km' || histType === 'time';
  const isSleepType = SLEEP_TYPES.has(histType);

  const periodMs = PERIOD_MONTHS[period] * 30 * 86_400_000;
  const toDate   = new Date(Date.now() - pageOffset * periodMs);
  const fromDate = new Date(toDate.getTime() - periodMs);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const months    = PERIOD_MONTHS[period];
      const endDate   = new Date(Date.now() - pageOffset * periodMs);
      const prevEnd   = new Date(endDate.getTime() - months * 30 * 86_400_000); // start of current = end of previous

      const fetchKm = async (toDate: Date): Promise<DataPoint[]> => {
        if (period === '1M') {
          const dm = await fetchDailyMileageHistory(toDate);
          return dm.map(d => ({ label: d.date, fullDate: d.date, value: d.value }));
        }
        const wm = await fetchWeeklyMileageHistory(months, toDate);
        return wm.map(w => ({ label: w.week, fullDate: w.week, value: w.km }));
      };

      const fetchTime = async (toDate: Date): Promise<DataPoint[]> => {
        if (period === '1M') {
          const dm = await fetchDailyDurationHistory(toDate);
          return dm.map(d => ({ label: d.date, fullDate: d.date, value: d.value }));
        }
        const wm = await fetchWeeklyDurationHistory(months, toDate);
        return wm.map(d => ({ label: d.date, fullDate: d.date, value: d.value }));
      };

      let raw: DataPoint[] = [];
      let prevRaw: DataPoint[] = [];

      if (histType === 'km') {
        [raw, prevRaw] = await Promise.all([fetchKm(endDate), fetchKm(prevEnd)]);
      } else if (histType === 'time') {
        [raw, prevRaw] = await Promise.all([fetchTime(endDate), fetchTime(prevEnd)]);
      } else if (histType === 'vo2') {
        const v = await fetchVO2MaxHistory(months, endDate);
        const daily = v.map(s => ({ label: s.date, fullDate: s.date, value: s.value }));
        // 1M: show daily readings; 3M/6M/1Y: aggregate to one data point per week (latest)
        raw = period === '1M' ? daily : groupByWeek(daily, 'last');
      } else if (histType === 'rhr') {
        const r = await fetchRestingHRHistory(months, endDate);
        const daily = r.map(s => ({ label: s.date, fullDate: s.date, value: s.value }));
        raw = period === '1M' ? daily : groupByWeek(daily, 'avg');
      } else if (histType === 'strain' || histType === 'recovery') {
        // Strain / recovery are the SAME values the per-day components store holds (strainScore /
        // recoveryScore) — read the store (instant, cached, incremental) instead of recomputing the whole
        // window from HealthKit on every timeframe switch.
        const comps = await fetchOurDailyComponents(months, endDate);
        const key = histType === 'strain' ? 'strainScore' : 'recoveryScore';
        const daily = Object.entries(comps)
          .filter(([, c]) => c[key] !== undefined)
          .map(([date, c]) => ({ label: date, fullDate: date, value: c[key] }))
          .sort((a, b) => a.fullDate.localeCompare(b.fullDate));
        raw = period === '1M' ? daily : groupByWeek(daily, 'avg');
      } else if (histType in COMPONENT_KEY) {
        // Sub-metric (exercise duration, daytime HR, energy, steps, resp rate, SpO₂, cardio load)
        const comps = await fetchOurDailyComponents(months, endDate);
        const key = COMPONENT_KEY[histType]!;
        const daily = Object.entries(comps)
          .filter(([, c]) => c[key] !== undefined)
          .map(([date, c]) => ({ label: date, fullDate: date, value: c[key] }))
          .sort((a, b) => a.fullDate.localeCompare(b.fullDate));
        raw = period === '1M' ? daily : groupByWeek(daily, 'avg');
        // Cardio status breakdown (per-day ATL/CTL/TSB → status) over the loaded period.
        if (histType === 'cardio-load') {
          const counts = new Map<string, { color: string; days: number }>();
          const byDate: Record<string, { lo: number; hi: number; color: string }> = {};
          // Date-ordered so the ratio trend (direction) is well-defined per day.
          const ordered = Object.entries(comps)
            .filter(([, c]) => c.cardioLoad !== undefined)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, c]) => ({ date, atl: c.cardioLoad as number, ctl: c.ctl ?? 0, tsb: c.tsb ?? 0 }));
          let total = 0;
          ordered.forEach((row, i) => {
            const st = cardioLoadStatus(row.atl, row.ctl, row.tsb, ratioTrend(ordered, i));
            byDate[row.date] = { lo: st.bandLo, hi: st.bandHi, color: st.color };
            const e = counts.get(st.label) ?? { color: st.color, days: 0 };
            e.days += 1; counts.set(st.label, e); total += 1;
          });
          setCardioByDate(byDate);
          const ORDER = ['Building', 'Detraining', 'Maintaining', 'Peaking', 'Productive', 'Fatigued', 'Overtraining'];
          setCardioStatus(total === 0 ? [] : ORDER.filter(l => counts.has(l)).map(l => ({
            label: l, color: counts.get(l)!.color, days: counts.get(l)!.days,
            pct: Math.round((counts.get(l)!.days / total) * 100),
          })));
        } else { setCardioStatus([]); setCardioByDate({}); }
      } else if (histType !== 'timeline' && !SLEEP_TYPES.has(histType)) {
        const h = await fetchHRVHistory(months, endDate);
        const daily = h.map(s => ({ label: s.date, fullDate: s.date, value: s.value }));
        raw = period === '1M' ? daily : groupByWeek(daily, 'avg');
      } else if (histType === 'sleep-hrdip') {
        const v = await fetchOvernightHRHistory(months, endDate);
        const daily = v.map(s => ({ label: s.date, fullDate: s.date, value: s.value }));
        raw = period === '1M' ? daily : groupByWeek(daily, 'avg');
      } else if (SLEEP_TYPES.has(histType)) {
        const sessions = await fetchSleepHistory(months, endDate);
        // Sleep Score + Sleep Bank use the SAME calibrated engine the coach + recovery use
        // (computeSleepScore / computeSleepBankSeries), so every surface agrees. The score history is
        // HR-neutral (dip component neutral) — exactly like the sleep-detail sparkline; per-night overnight
        // HR isn't loaded here, and today's detail card shows the HR-aware score.
        const bankSeries = histType === 'sleep-bank'
          ? computeSleepBankSeries(sessions.map(s => ({ date: s.date, asleepMin: s.totalMinutes, dayStrain: 0, efficiency: 1 })), 420)
          : null;
        const daily = sessions.map((s, i, arr) => {
          let value = 0;
          if (histType === 'sleep-total') value = s.totalMinutes;
          else if (histType === 'sleep-awake') value = s.awakeMinutes;
          else if (histType === 'sleep-deep') value = s.deepMinutes;
          else if (histType === 'sleep-rem') value = s.remMinutes;
          else if (histType === 'sleep-efficiency') {
            const inBed = s.totalMinutes + s.awakeMinutes;
            value = inBed > 0 ? Math.round(s.totalMinutes / inBed * 100) : 0;
          } else if (histType === 'sleep-score') {
            value = computeSleepScore(s, 0, 0, arr.slice(0, i + 1)).score;
          } else if (histType === 'sleep-bank') {
            value = bankSeries![i].bank;
          }
          return { label: s.date, fullDate: s.date, value };
        });
        // sleep-bank: keep daily for 1M, weekly avg otherwise
        raw = period === '1M' ? daily : groupByWeek(daily, 'avg');
      }

      // 1-MONTH view: show every calendar day, not just days with data → pad the daily series across
      // the window. (3M/6M/1Y aggregate to continuous weeks/months already.)
      if (period === '1M') {
        const winMs    = months * 30 * 86_400_000;
        const curStart = new Date(endDate.getTime() - winMs);
        raw = fillDailyGaps(raw, curStart, endDate);
        if (prevRaw.length) prevRaw = fillDailyGaps(prevRaw, new Date(curStart.getTime() - winMs), curStart);
      }

      setRawData(raw);
      setPrevRawData(prevRaw);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setRawData([]);
      setPrevRawData([]);
    } finally {
      setLoading(false);
    }
  }, [histType, period, pageOffset]);

  useEffect(() => { load(); }, [load]);

  const handlePeriodChange = (p: Period) => {
    setPageOffset(0);
    setPeriod(p);
  };

  // ── Period-aware data & labels ────────────────────────────────────────────
  const isKm   = histType === 'km';
  const isTime = histType === 'time';
  const isSummable = isKm || isTime;
  // Sleep time fields displayed as HH:MM (minutes values)
  const isSleepMin  = histType === 'sleep-total' || histType === 'sleep-deep' || histType === 'sleep-rem' || histType === 'sleep-awake';
  // Sleep Bank chart also uses isTime-style formatting (signed minutes)
  const isSleepBank = histType === 'sleep-bank';

  // Aggregate current + previous period
  const aggData = (isSummable && period === '1Y')
    ? groupByMonth(rawData, 'sum')
    : aggregateBuckets(rawData, PERIOD_BUCKETS[period], cfg.aggregate);

  const prevAggData = (isSummable && period === '1Y')
    ? groupByMonth(prevRawData, 'sum')
    : aggregateBuckets(prevRawData, PERIOD_BUCKETS[period], cfg.aggregate);

  // Apply cumulative transform when mode is active (only for km / time)
  const chartData     = (cumulativeMode && isSummable) ? toCumulative(aggData) : aggData;
  // Cardio-load: optimal-load band + status colour per chart point (aligned by date).
  const isCardio = histType === 'cardio-load';
  const cardioBand   = isCardio ? chartData.map(d => { const x = cardioByDate[d.fullDate.slice(0, 10)]; return x ? { lo: x.lo, hi: x.hi } : null; }) : undefined;
  const cardioColors = isCardio ? chartData.map(d => cardioByDate[d.fullDate.slice(0, 10)]?.color ?? null) : undefined;
  // Show previous period in BOTH abs (grey bars) and cumulative (grey line) modes
  const chartPrevData = supportsOverlay
    ? (cumulativeMode ? toCumulative(prevAggData) : prevAggData)
    : undefined;

  // Previous period date range (start of previous = start of current - periodMs)
  const prevToDate   = fromDate;
  const prevFromDate = new Date(fromDate.getTime() - periodMs);

  // Stat formatter
  const fmtStat = (v: number) => {
    if (isTime) return fmtMin(v);
    if (histType === 'vo2') return period !== '1M' ? v.toFixed(1) : fmtVal(v);
    if (histType === 'sleep-total') return fmtMin(v);          // Time Asleep stays HH:MM (naturally hours)
    if (isSleepMin) return fmtInt(v);                          // Deep / REM / Awake → plain minutes (less confusing)
    if (histType === 'sleep-bank') return fmtSignedMinPlain(v);// Sleep Bank → plain signed minutes
    if (histType === 'sleep-hrdip') return v.toFixed(1);
    return fmtVal(v);
  };

  // Dynamic display title
  const displayTitle = isKm
    ? (period === '1M' ? 'Daily km' : period === '1Y' ? 'Monthly km' : 'Weekly km')
    : isTime
      ? (period === '1M' ? 'Daily time' : period === '1Y' ? 'Monthly time' : 'Weekly time')
      : cfg.title;

  // Dynamic avg / count labels (absolute mode)
  const avgLabel = isSummable
    ? (period === '1M' ? `avg/day` : period === '1Y' ? `avg/mo` : `avg/wk`)
    : isSleepType
      ? (period === '1M' ? `avg/night` : `avg/wk`)
      : 'avg';
  const countLabel = isSummable
    ? (period === '1M' ? 'days' : period === '1Y' ? 'months' : 'weeks')
    : isSleepType
      ? (period === '1M' ? 'nights' : 'weeks')
      : (histType === 'hrv' ? 'nights' : 'readings');

  // Chart x-axis mode
  const xMode: XMode = period === '1M' ? 'daily' : (period === '1Y' && isSummable) ? 'monthly' : 'weekly';

  // Show value on every bar for 1M and 1Y
  const showAllValues = period === '1M' || (period === '1Y' && isSummable);

  // In cumulative 1M view, label every 5th point instead of every point (30 daily labels is too dense)
  const valueLabelStep = (cumulativeMode && period === '1M') ? 5 : 1;

  // Summary stats — in cumulative mode show period totals; otherwise normal stats
  const periodTotal = chartData.length > 0 ? chartData[chartData.length - 1].value : 0;
  // prevTotal always from the cumulative-transformed previous data (for comparison box)
  const cumPrevData = cumulativeMode ? chartPrevData : (supportsOverlay ? toCumulative(prevAggData) : undefined);
  const prevTotal   = cumPrevData && cumPrevData.length > 0 ? cumPrevData[cumPrevData.length - 1].value : 0;
  const absVals        = aggData.map(d => d.value);
  const avg    = absVals.length > 0 ? absVals.reduce((a, b) => a + b, 0) / absVals.length : 0;
  const trend  = absVals.length >= 2 ? absVals[absVals.length - 1] - absVals[0] : 0;
  const latest = absVals.length > 0 ? absVals[absVals.length - 1] : 0;
  const countValue = aggData.length;

  // onLayout fires on chartWrap (which has padding: 12).
  // Subtract padding*2 to get the usable inner width for the chart.
  const onChartLayout = (e: LayoutChangeEvent) => {
    setInnerW(e.nativeEvent.layout.width - CARD_PADDING * 2);
  };

  return (
    <SafeAreaView style={s.container}>
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Text style={s.backText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={s.title}>{displayTitle}</Text>
        {supportsOverlay ? (
          <View style={s.modeSwitch}>
            <TouchableOpacity
              style={[s.modePill, !cumulativeMode && { backgroundColor: cfg.color, borderColor: cfg.color }]}
              onPress={() => setCumulative(false)}
            >
              <Text style={[s.modePillText, !cumulativeMode && { color: '#fff' }]}>Abs</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.modePill, cumulativeMode && { backgroundColor: cfg.color, borderColor: cfg.color }]}
              onPress={() => setCumulative(true)}
            >
              <Text style={[s.modePillText, cumulativeMode && { color: '#fff' }]}>Cum</Text>
            </TouchableOpacity>
          </View>
        ) : <View style={{ width: 70 }} />}
      </View>

      {/* Period tabs */}
      <View style={s.periodRow}>
        {(['1M', '3M', '6M', '1Y'] as Period[]).map(p => (
          <TouchableOpacity
            key={p}
            style={[s.periodBtn, period === p && { backgroundColor: cfg.color }]}
            onPress={() => handlePeriodChange(p)}
          >
            <Text style={[s.periodText, period === p && s.periodTextActive]}>{p}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={s.center}>
          <ActivityIndicator size="large" color={cfg.color} />
          <Text style={s.loadingText}>Loading…</Text>
        </View>
      ) : error ? (
        <View style={s.center}>
          <Text style={s.errorText}>⚠️ Could not load data</Text>
          <Text style={s.errorDetail}>{error}</Text>
          <TouchableOpacity style={[s.periodBtn, { marginTop: 16, paddingHorizontal: 20 }]} onPress={load}>
            <Text style={s.periodText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : aggData.length === 0 ? (
        <View style={s.center}>
          <Text style={s.emptyText}>No data for this period.</Text>
          <Text style={s.emptyHint}>Make sure Apple Health has data for the selected range.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={s.scroll}>

          {/* Summary boxes */}
          <View style={s.summaryRow}>
            {cumulativeMode && isSummable ? (
              // Cumulative mode: show period totals + comparison
              <>
                <View style={s.summaryBox}>
                  <Text style={[s.summaryVal, { color: cfg.color }]}>{fmtStat(periodTotal)}</Text>
                  <Text style={s.summaryLbl}>this period</Text>
                </View>
                <View style={s.summaryBox}>
                  <Text style={[s.summaryVal, { color: '#888' }]}>{fmtStat(prevTotal)}</Text>
                  <Text style={s.summaryLbl}>prev period</Text>
                </View>
                <View style={s.summaryBox}>
                  <Text style={[s.summaryVal, {
                    color: periodTotal >= prevTotal ? '#27ae60' : '#c0392b',
                  }]}>
                    {periodTotal >= prevTotal ? '+' : ''}{fmtStat(Math.round(periodTotal - prevTotal))}
                  </Text>
                  <Text style={s.summaryLbl}>vs prev</Text>
                </View>
                <View style={s.summaryBox}>
                  <Text style={[s.summaryVal, { color: cfg.color }]}>{countValue}</Text>
                  <Text style={s.summaryLbl}>{countLabel}</Text>
                </View>
              </>
            ) : (
              // Absolute mode: normal avg / latest / trend
              <>
                <View style={s.summaryBox}>
                  <Text style={[s.summaryVal, { color: cfg.color }]}>{fmtStat(avg)}</Text>
                  <Text style={s.summaryLbl}>{avgLabel}</Text>
                </View>
                <View style={s.summaryBox}>
                  <Text style={[s.summaryVal, { color: cfg.color }]}>{fmtStat(latest)}</Text>
                  <Text style={s.summaryLbl}>latest</Text>
                </View>
                <View style={s.summaryBox}>
                  <Text style={[s.summaryVal, {
                    color: histType === 'rhr'
                      ? (trend < 0 ? '#27ae60' : trend > 0 ? '#c0392b' : '#888')
                      : (trend > 0 ? '#27ae60' : trend < 0 ? '#c0392b' : '#888'),
                  }]}>
                    {trend >= 0 ? '+' : ''}{fmtStat(trend)}
                  </Text>
                  <Text style={s.summaryLbl}>period Δ</Text>
                </View>
                <View style={s.summaryBox}>
                  <Text style={[s.summaryVal, { color: cfg.color }]}>{countValue}</Text>
                  <Text style={s.summaryLbl}>{countLabel}</Text>
                </View>
              </>
            )}
          </View>

          {/* Chart card */}
          <View style={s.chartWrap} onLayout={onChartLayout}>
            {/* Navigation row */}
            <View style={s.navRow}>
              <TouchableOpacity onPress={() => setPageOffset(o => o + 1)} style={s.navBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <Text style={s.navArrow}>‹</Text>
              </TouchableOpacity>
              <View style={{ flex: 1, alignItems: 'center' }}>
                <Text style={s.navLabel} numberOfLines={1}>
                  <Text style={{ color: cfg.color }}>● </Text>{formatDateRange(fromDate, toDate)}
                </Text>
                {supportsOverlay && (
                  <Text style={s.navLabelPrev} numberOfLines={1}>
                    <Text style={{ color: '#999' }}>● </Text>{formatDateRange(prevFromDate, prevToDate)}
                  </Text>
                )}
              </View>
              <TouchableOpacity
                onPress={() => setPageOffset(o => Math.max(0, o - 1))}
                style={[s.navBtn, pageOffset === 0 && s.navBtnDisabled]}
                disabled={pageOffset === 0}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              >
                <Text style={[s.navArrow, pageOffset === 0 && s.navArrowDisabled]}>›</Text>
              </TouchableOpacity>
            </View>

            <Chart
              data={chartData}
              color={cfg.color}
              innerW={innerW}
              xMode={xMode}
              showAllValues={showAllValues}
              prevData={chartPrevData}
              cumulative={cumulativeMode && isSummable}
              isTime={isTime || histType === 'sleep-total'}
              valueLabelStep={valueLabelStep}
              fmtFn={
                histType === 'vo2' && period !== '1M' ? fmtOneDecimal :
                histType === 'sleep-bank'             ? fmtSignedMinPlain :
                histType === 'sleep-hrdip'            ? fmtOneDecimal :
                undefined
              }
              zeroBase={isSummable || histType === 'strain'}
              hideValueLabels={histType === 'strain' || isCardio}
              lineMode={isCardio}
              bandData={cardioBand}
              pointColors={cardioColors}
              boundaryDate={histType === 'exercise-duration' ? (fullBoundary ?? undefined) : undefined}
            />

            <Text style={s.chartUnit}>
              {cfg.unit}
              {cumulativeMode ? ' · cumulative' :
                (isSummable && period === '1Y')
                  ? ` · ${aggData.length} months`
                  : aggData.length < rawData.length
                    ? ` · ${aggData.length} of ${rawData.length} ${countLabel}`
                    : ''}
            </Text>
          </View>

          {/* Cardio status breakdown — days in each training state over the period */}
          {histType === 'cardio-load' && cardioStatus.length > 0 && (
            <View style={s.statusCard}>
              <Text style={s.statusTitle}>CARDIO STATUS BREAKDOWN</Text>
              {cardioStatus.map((st) => (
                <View key={st.label} style={s.statusRow}>
                  <Text style={s.statusLabel}>{st.label}</Text>
                  <Text style={s.statusDays}>{st.days}d</Text>
                  <View style={s.statusBarBg}>
                    <View style={[s.statusBarFill, { width: `${st.pct}%` as `${number}%`, backgroundColor: st.color }]} />
                  </View>
                  <Text style={s.statusPct}>{st.pct}%</Text>
                </View>
              ))}
            </View>
          )}

          {/* Readings list — hide in cumulative mode; for 1Y summable use monthly totals */}
          {!cumulativeMode && (
          <>
          <Text style={s.listHeader}>
            {isSummable
              ? (period === '1Y' ? 'Monthly totals' : period === '1M' ? 'Daily readings' : 'Weekly totals')
              : (period === '1M' ? 'Daily readings' : 'Weekly readings')}
          </Text>
          {[...(isSummable && period === '1Y' ? aggData : rawData)].reverse().map((d, i) => (
            <View key={i} style={s.listRow}>
              <Text style={s.listDate}>{d.fullDate.slice(0, 10)}</Text>
              <Text style={[s.listVal, { color: cfg.color }]}>
                {fmtStat(d.value)} {cfg.unit}
              </Text>
            </View>
          ))}
          </>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// ─── Chart styles ─────────────────────────────────────────────────────────────

const makeCh = (c: Palette) => StyleSheet.create({
  yLabel:     { fontSize: 10, color: c.textSub, textAlign: 'right', fontWeight: '500' },
  xLabel:     { fontSize: 10, color: c.textSub, fontWeight: '600' },
  xLabelYear: { fontSize: 9,  color: c.textSub, fontWeight: '600' },
  prevRange:  { fontSize: 10, color: '#9aa0a6', fontWeight: '700' },
  // Fixed readout line above the chart — replaces the floating bubble so nothing covers the bars.
  readout:     { flexDirection: 'row', alignItems: 'baseline', columnGap: 8, marginBottom: 6, minHeight: 18 },
  readoutDate: { fontSize: 11, color: c.textSub, fontWeight: '700' },
  readoutVal:  { fontSize: 14, fontWeight: '800' },
});

// ─── Screen styles ────────────────────────────────────────────────────────────

const makeS = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border,
  },
  backBtn:  { paddingHorizontal: 4 },
  backText: { fontSize: 17, color: c.accent, fontWeight: '600' },
  title:    { fontSize: 17, fontWeight: '700', color: c.text },
  periodRow: {
    flexDirection: 'row', gap: 8, padding: 12,
    backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.border,
  },
  periodBtn: {
    flex: 1, paddingVertical: 7, borderRadius: 8,
    borderWidth: 1, borderColor: c.border, alignItems: 'center', backgroundColor: c.surface,
  },
  periodText:       { fontSize: 13, color: c.textSub, fontWeight: '600' },
  periodTextActive: { color: '#fff' },
  center:      { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  loadingText: { marginTop: 8, color: c.textSub, fontSize: 14 },
  errorText:   { fontSize: 15, color: '#c0392b', fontWeight: '700', marginBottom: 8 },
  errorDetail: { fontSize: 12, color: c.textFaint, textAlign: 'center' },
  emptyText:   { fontSize: 15, color: c.textSub, textAlign: 'center', marginBottom: 6, fontWeight: '600' },
  emptyHint:   { fontSize: 13, color: c.textFaint, textAlign: 'center' },
  scroll:      { padding: 12, paddingBottom: 40 },

  summaryRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  summaryBox: {
    flex: 1, backgroundColor: c.surface, borderRadius: 10, paddingVertical: 10, alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: c.shadowOpacity, shadowRadius: 3, elevation: 2,
  },
  summaryVal: { fontSize: 18, fontWeight: '800' },
  summaryLbl: { fontSize: 11, color: c.textSub, marginTop: 2, fontWeight: '500' },

  chartWrap: {
    backgroundColor: c.surface, borderRadius: 12,
    padding: CARD_PADDING, paddingBottom: 10, marginBottom: 16,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: c.shadowOpacity, shadowRadius: 3, elevation: 2,
  },

  navRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  navBtn:           { paddingHorizontal: 4, paddingVertical: 4 },
  navBtnDisabled:   { opacity: 0.25 },
  navArrow:         { fontSize: 28, color: c.text, fontWeight: '600', lineHeight: 32 },
  navArrowDisabled: { color: c.textFaint },
  navLabel:         { fontSize: 12, color: c.textSub, fontWeight: '600', textAlign: 'center' },
  navLabelPrev:     { fontSize: 10, color: c.textFaint, fontWeight: '500', textAlign: 'center', marginTop: 1 },

  chartUnit: { fontSize: 11, color: c.textFaint, textAlign: 'right', marginTop: 6, fontWeight: '500' },

  modeSwitch:    { flexDirection: 'row', gap: 4 },
  modePill:      { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8,
                   borderWidth: 1.5, borderColor: c.border, backgroundColor: c.surface },
  modePillText:  { fontSize: 11, fontWeight: '700', color: c.textSub },

  listHeader: {
    fontSize: 12, fontWeight: '700', color: c.textSub,
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginLeft: 2,
  },
  statusCard: { backgroundColor: c.surface, borderRadius: 12, padding: 14, marginBottom: 16 },
  statusTitle: { fontSize: 12, fontWeight: '700', color: c.textSub, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 },
  statusRow:   { flexDirection: 'row', alignItems: 'center', paddingVertical: 7 },
  statusLabel: { fontSize: 14, fontWeight: '600', color: c.text, width: 104 },
  statusDays:  { fontSize: 13, color: c.textSub, width: 34 },
  statusBarBg: { flex: 1, height: 8, borderRadius: 4, backgroundColor: c.bg, marginHorizontal: 8, overflow: 'hidden' },
  statusBarFill: { height: 8, borderRadius: 4 },
  statusPct:   { fontSize: 14, fontWeight: '700', color: c.text, width: 44, textAlign: 'right' },
  listRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: c.surface, borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 10, marginBottom: 6,
  },
  listDate: { fontSize: 13, color: c.textSub },
  listVal:  { fontSize: 14, fontWeight: '700' },
});
