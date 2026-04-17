import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, SafeAreaView, ActivityIndicator, LayoutChangeEvent,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  fetchWeeklyMileageHistory,
  fetchDailyMileageHistory,
  fetchVO2MaxHistory,
  fetchRestingHRHistory,
  fetchHRVHistory,
} from '../src/services/healthkit';
import { WeeklyMileage } from '../src/types';

type HistoryType = 'km' | 'vo2' | 'rhr' | 'hrv';
type Period = '1M' | '3M' | '6M' | '1Y';

const PERIOD_MONTHS: Record<Period, number> = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12 };

// chartWrap padding is 12px each side → 24px total subtracted from containerW
const CARD_PADDING = 12;

/**
 * Max bars shown per period.
 * 1M: show ALL daily readings (no aggregation) — set high so nothing gets merged.
 * 3M / 6M: weekly bars (~13).
 * 1Y: monthly bars (12).
 */
const PERIOD_BUCKETS: Record<Period, number> = {
  '1M': 999,  // never aggregate for 1-month view
  '3M': 13,
  '6M': 13,
  '1Y': 12,
};

interface DataPoint { label: string; value: number; fullDate: string; }

const CONFIGS: Record<HistoryType, {
  title: string; unit: string; color: string; aggregate: 'sum' | 'avg';
}> = {
  km:  { title: 'Weekly km',    unit: 'km',        color: '#FF6B35', aggregate: 'sum' },
  vo2: { title: 'VO₂ Max',     unit: 'ml/kg/min', color: '#27ae60', aggregate: 'avg' },
  rhr: { title: 'Resting HR',  unit: 'bpm',        color: '#e74c3c', aggregate: 'avg' },
  hrv: { title: 'Nightly HRV', unit: 'ms',         color: '#8e44ad', aggregate: 'avg' },
};

function fmtInt(v: number): string { return String(Math.round(v)); }

function fmtVal(v: number): string {
  return v % 1 === 0 || v > 10 ? String(Math.round(v)) : v.toFixed(1);
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

// ─── Chart ────────────────────────────────────────────────────────────────────

const CHART_H = 200;
const Y_AXIS_W = 34;

function Chart({
  data, color, innerW,
}: {
  data: DataPoint[]; color: string; innerW: number;
}) {
  if (data.length === 0 || innerW <= 0) return null;

  const values = data.map(d => d.value);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const padTop = (rawMax - rawMin) * 0.12 || 2;
  const scale  = niceScale(Math.max(0, rawMin * 0.9 - 1), rawMax + padTop);
  const yRange = scale.niceMax - scale.niceMin || 1;

  // innerW is the full usable width inside the card (chartWrap content width)
  const plotW  = innerW - Y_AXIS_W;
  const barGap = Math.max(1, Math.min(3, plotW / data.length / 6));
  const barW   = Math.max(5, (plotW - barGap * data.length) / data.length);

  const toY = (v: number) =>
    CHART_H * (1 - Math.max(0, Math.min(1, (v - scale.niceMin) / yRange)));

  // Up to 5 evenly spaced x-axis labels
  const labelIdxs = new Set<number>();
  const maxL = Math.min(5, data.length);
  if (maxL === 1) {
    labelIdxs.add(0);
  } else {
    for (let i = 0; i < maxL; i++) {
      labelIdxs.add(Math.round((i / (maxL - 1)) * (data.length - 1)));
    }
  }

  // Always two-line x-label (D/M on top, 'YY below)
  const xAxisH = 34;

  return (
    <View style={{ flexDirection: 'row' }}>
      {/* Y-axis */}
      <View style={{ width: Y_AXIS_W, height: CHART_H }}>
        {scale.ticks.map((tick, i) => (
          <Text key={i} style={[ch.yLabel, { position: 'absolute', top: toY(tick) - 8, right: 4 }]}>
            {fmtInt(tick)}
          </Text>
        ))}
      </View>

      {/* Plot area — explicitly sized to plotW so it never overflows */}
      <View style={{ width: plotW, height: CHART_H + xAxisH, position: 'relative' }}>
        {/* Gridlines */}
        {scale.ticks.map((tick, i) => (
          <View key={i} style={{
            position: 'absolute', top: toY(tick), left: 0, right: 0,
            height: tick === 0 ? 1.5 : 1,
            backgroundColor: tick === 0 ? '#ccc' : '#e8e8e8',
          }} />
        ))}

        {/* Bars + labels */}
        {data.map((d, i) => {
          const x    = i * (barW + barGap);
          const barH = Math.max(2, CHART_H - toY(d.value));
          const show = labelIdxs.has(i);
          const mon  = getMondayOf(d.fullDate);

          return (
            <View key={i}>
              {/* Bar */}
              <View style={{
                position: 'absolute', left: x, top: CHART_H - barH,
                width: barW, height: barH,
                backgroundColor: color, borderRadius: 3, opacity: 0.88,
              }} />

              {/* Value label above bar — always black, bigger */}
              {show && (
                <Text style={{
                  position: 'absolute',
                  top: CHART_H - barH - 15,
                  left: x - 10, width: barW + 20,
                  fontSize: 11, color: '#111', textAlign: 'center', fontWeight: '700',
                }} numberOfLines={1}>
                  {fmtInt(d.value)}
                </Text>
              )}

              {/* X-axis label: D/M line + 'YY line */}
              {show && (
                <View style={{
                  position: 'absolute', top: CHART_H + 3,
                  left: x - 12, width: barW + 24,
                  alignItems: 'center',
                }}>
                  <Text style={ch.xLabel} numberOfLines={1}>{formatDM(mon)}</Text>
                  <Text style={ch.xLabelYear} numberOfLines={1}>{formatYY(mon)}</Text>
                </View>
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function HistoryScreen() {
  const { type } = useLocalSearchParams<{ type: string }>();
  const router   = useRouter();

  const [period, setPeriod]         = useState<Period>('3M');
  const [pageOffset, setPageOffset] = useState(0);
  const [rawData, setRawData]       = useState<DataPoint[]>([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);
  const [innerW, setInnerW]         = useState(0); // width INSIDE chartWrap (padding subtracted)

  const histType = (type ?? 'km') as HistoryType;
  const cfg      = CONFIGS[histType] ?? CONFIGS.km;

  const periodMs = PERIOD_MONTHS[period] * 30 * 86_400_000;
  const toDate   = new Date(Date.now() - pageOffset * periodMs);
  const fromDate = new Date(toDate.getTime() - periodMs);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const months  = PERIOD_MONTHS[period];
      const endDate = new Date(Date.now() - pageOffset * periodMs);
      let raw: DataPoint[] = [];

      if (histType === 'km') {
        if (period === '1M') {
          // 1M: daily values — one bar per run day
          const dm = await fetchDailyMileageHistory(endDate);
          raw = dm.map(d => ({ label: d.date, fullDate: d.date, value: d.value }));
        } else {
          const wm: WeeklyMileage[] = await fetchWeeklyMileageHistory(months, endDate);
          raw = wm.map(w => ({ label: w.week, fullDate: w.week, value: w.km }));
        }
      } else if (histType === 'vo2') {
        const v = await fetchVO2MaxHistory(months, endDate);
        raw = v.map(s => ({ label: s.date, fullDate: s.date, value: s.value }));
      } else if (histType === 'rhr') {
        const r = await fetchRestingHRHistory(months, endDate);
        raw = r.map(s => ({ label: s.date, fullDate: s.date, value: s.value }));
      } else {
        const h = await fetchHRVHistory(months, endDate);
        raw = h.map(s => ({ label: s.date, fullDate: s.date, value: s.value }));
      }

      setRawData(raw);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setRawData([]);
    } finally {
      setLoading(false);
    }
  }, [histType, period, pageOffset]);

  useEffect(() => { load(); }, [load]);

  const handlePeriodChange = (p: Period) => {
    setPageOffset(0);
    setPeriod(p);
  };

  const data = aggregateBuckets(rawData, PERIOD_BUCKETS[period], cfg.aggregate);

  const values = rawData.map(d => d.value);
  const avg    = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const trend  = values.length >= 2 ? values[values.length - 1] - values[0] : 0;
  const latest = values.length > 0 ? values[values.length - 1] : 0;

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
        <Text style={s.title}>{cfg.title}</Text>
        <View style={{ width: 70 }} />
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
      ) : data.length === 0 ? (
        <View style={s.center}>
          <Text style={s.emptyText}>No data for this period.</Text>
          <Text style={s.emptyHint}>Make sure Apple Health has data for the selected range.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={s.scroll}>

          {/* Summary boxes */}
          <View style={s.summaryRow}>
            <View style={s.summaryBox}>
              <Text style={[s.summaryVal, { color: cfg.color }]}>{fmtVal(avg)}</Text>
              <Text style={s.summaryLbl}>{histType === 'km' ? 'avg/wk' : 'avg'}</Text>
            </View>
            <View style={s.summaryBox}>
              <Text style={[s.summaryVal, { color: cfg.color }]}>{fmtVal(latest)}</Text>
              <Text style={s.summaryLbl}>latest</Text>
            </View>
            <View style={s.summaryBox}>
              <Text style={[s.summaryVal, {
                color: histType === 'rhr'
                  ? (trend < 0 ? '#27ae60' : trend > 0 ? '#c0392b' : '#888')
                  : (trend > 0 ? '#27ae60' : trend < 0 ? '#c0392b' : '#888'),
              }]}>
                {trend >= 0 ? '+' : ''}{fmtVal(trend)}
              </Text>
              <Text style={s.summaryLbl}>period Δ</Text>
            </View>
            <View style={s.summaryBox}>
              <Text style={[s.summaryVal, { color: cfg.color }]}>{rawData.length}</Text>
              <Text style={s.summaryLbl}>
                {histType === 'km' ? 'weeks' : histType === 'hrv' ? 'nights' : 'readings'}
              </Text>
            </View>
          </View>

          {/* Chart card */}
          <View style={s.chartWrap} onLayout={onChartLayout}>
            {/* Navigation row */}
            <View style={s.navRow}>
              <TouchableOpacity onPress={() => setPageOffset(o => o + 1)} style={s.navBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <Text style={s.navArrow}>‹</Text>
              </TouchableOpacity>
              <Text style={s.navLabel} numberOfLines={1}>{formatDateRange(fromDate, toDate)}</Text>
              <TouchableOpacity
                onPress={() => setPageOffset(o => Math.max(0, o - 1))}
                style={[s.navBtn, pageOffset === 0 && s.navBtnDisabled]}
                disabled={pageOffset === 0}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              >
                <Text style={[s.navArrow, pageOffset === 0 && s.navArrowDisabled]}>›</Text>
              </TouchableOpacity>
            </View>

            <Chart data={data} color={cfg.color} innerW={innerW} />

            <Text style={s.chartUnit}>
              {cfg.unit}
              {data.length < rawData.length
                ? ` · aggregated ${data.length} of ${rawData.length}`
                : ''}
            </Text>
          </View>

          {/* Raw list */}
          <Text style={s.listHeader}>All readings</Text>
          {[...rawData].reverse().map((d, i) => (
            <View key={i} style={s.listRow}>
              <Text style={s.listDate}>{d.fullDate.slice(0, 10)}</Text>
              <Text style={[s.listVal, { color: cfg.color }]}>
                {fmtVal(d.value)} {cfg.unit}
              </Text>
            </View>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// ─── Chart styles ─────────────────────────────────────────────────────────────

const ch = StyleSheet.create({
  yLabel:     { fontSize: 10, color: '#555', textAlign: 'right', fontWeight: '500' },
  xLabel:     { fontSize: 10, color: '#666', fontWeight: '600' },
  xLabelYear: { fontSize: 9,  color: '#666', fontWeight: '600' },
});

// ─── Screen styles ────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F5F5F5' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#eee',
  },
  backBtn:  { paddingHorizontal: 4 },
  backText: { fontSize: 17, color: '#FF6B35', fontWeight: '600' },
  title:    { fontSize: 17, fontWeight: '700', color: '#222' },
  periodRow: {
    flexDirection: 'row', gap: 8, padding: 12,
    backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#eee',
  },
  periodBtn: {
    flex: 1, paddingVertical: 7, borderRadius: 8,
    borderWidth: 1, borderColor: '#ddd', alignItems: 'center', backgroundColor: '#fff',
  },
  periodText:       { fontSize: 13, color: '#555', fontWeight: '600' },
  periodTextActive: { color: '#fff' },
  center:      { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  loadingText: { marginTop: 8, color: '#888', fontSize: 14 },
  errorText:   { fontSize: 15, color: '#c0392b', fontWeight: '700', marginBottom: 8 },
  errorDetail: { fontSize: 12, color: '#999', textAlign: 'center' },
  emptyText:   { fontSize: 15, color: '#666', textAlign: 'center', marginBottom: 6, fontWeight: '600' },
  emptyHint:   { fontSize: 13, color: '#aaa', textAlign: 'center' },
  scroll:      { padding: 12, paddingBottom: 40 },

  summaryRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  summaryBox: {
    flex: 1, backgroundColor: '#fff', borderRadius: 10, paddingVertical: 10, alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 3, elevation: 2,
  },
  summaryVal: { fontSize: 18, fontWeight: '800' },
  summaryLbl: { fontSize: 11, color: '#888', marginTop: 2, fontWeight: '500' },

  chartWrap: {
    backgroundColor: '#fff', borderRadius: 12,
    padding: CARD_PADDING, paddingBottom: 10, marginBottom: 16,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 3, elevation: 2,
  },

  navRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  navBtn:           { paddingHorizontal: 4, paddingVertical: 4 },
  navBtnDisabled:   { opacity: 0.25 },
  navArrow:         { fontSize: 28, color: '#333', fontWeight: '600', lineHeight: 32 },
  navArrowDisabled: { color: '#ccc' },
  navLabel:         { fontSize: 12, color: '#555', fontWeight: '600', flex: 1, textAlign: 'center' },

  chartUnit: { fontSize: 11, color: '#aaa', textAlign: 'right', marginTop: 6, fontWeight: '500' },

  listHeader: {
    fontSize: 12, fontWeight: '700', color: '#666',
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginLeft: 2,
  },
  listRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: '#fff', borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 10, marginBottom: 6,
  },
  listDate: { fontSize: 13, color: '#555' },
  listVal:  { fontSize: 14, fontWeight: '700' },
});
