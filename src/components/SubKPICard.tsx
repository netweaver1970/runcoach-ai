/**
 * Shared sub-metric card + sparkline — the display/reporting pattern from the sleep
 * detail screen, reused by the recovery and strain detail screens.
 *
 * A row showing: label + auto status badge (z-score vs the metric's own mean/SD),
 * a 30-ish-day sparkline with the normal band shaded, and the current value. Tappable
 * to open the full history viewer.
 */
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useThemedStyles, Palette } from '../theme';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Per-metric history arrays (oldest→newest) from fetchOurDailyComponents output. */
export function buildHistories(
  comps: Record<string, Record<string, number>>, keys: string[],
): Record<string, number[]> {
  const dates = Object.keys(comps).sort();
  const out: Record<string, number[]> = {};
  for (const k of keys) out[k] = dates.map(d => comps[d][k]).filter((v): v is number => v !== undefined);
  return out;
}

export function stats(arr: number[]): { mean: number; sd: number } {
  if (arr.length === 0) return { mean: 0, sd: 0 };
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const sd   = Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length);
  return { mean, sd };
}

type StatusTag = 'Below normal' | 'Normal range' | 'Above normal';

function getStatus(value: number, mean: number, sd: number, higherIsBetter = true): StatusTag {
  if (sd === 0) return 'Normal range';
  const z = (value - mean) / sd;
  if (higherIsBetter) {
    if (z < -1.0) return 'Below normal';
    if (z >  1.0) return 'Above normal';
  } else {
    if (z >  1.0) return 'Below normal';
    if (z < -1.0) return 'Above normal';
  }
  return 'Normal range';
}

const STATUS_COLOR: Record<StatusTag, string> = {
  'Normal range': '#27ae60',
  'Below normal': '#e67e22',
  'Above normal': '#2980b9',
};

const SPARK_H = 36;
const SPARK_W = 120;

function Sparkline({ values, mean, sd, color }: { values: number[]; mean: number; sd: number; color: string }) {
  if (values.length < 2) return <View style={{ width: SPARK_W, height: SPARK_H }} />;
  const lo = Math.min(...values, mean - sd * 1.5);
  const hi = Math.max(...values, mean + sd * 1.5);
  const range = hi - lo || 1;
  const toX = (i: number) => (i / (values.length - 1)) * SPARK_W;
  const toY = (v: number) => SPARK_H - ((v - lo) / range) * SPARK_H;
  const bandLo = clamp((mean - sd - lo) / range * SPARK_H, 0, SPARK_H);
  const bandHi = clamp((mean + sd - lo) / range * SPARK_H, 0, SPARK_H);
  const bandY  = SPARK_H - bandHi;
  const bandH  = bandHi - bandLo;

  return (
    <View style={{ width: SPARK_W, height: SPARK_H, position: 'relative' }}>
      <View style={{ position: 'absolute', left: 0, right: 0, top: bandY, height: Math.max(2, bandH), backgroundColor: color + '22' }} />
      <View style={{ position: 'absolute', left: 0, right: 0, top: toY(mean) - 0.5, height: 1, backgroundColor: color + '55' }} />
      {values.map((v, i) => {
        if (i === 0) return null;
        const x1 = toX(i - 1), y1 = toY(values[i - 1]);
        const x2 = toX(i),     y2 = toY(v);
        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx) * 180 / Math.PI;
        return (
          <View key={i} style={{
            position: 'absolute', width: len, height: 1.5,
            left: (x1 + x2) / 2 - len / 2, top: (y1 + y2) / 2 - 0.75,
            backgroundColor: color, transform: [{ rotate: `${angle}deg` }],
          }} />
        );
      })}
      <View style={{
        position: 'absolute', width: 5, height: 5, borderRadius: 3,
        left: toX(values.length - 1) - 2.5, top: toY(values[values.length - 1]) - 2.5,
        backgroundColor: color,
      }} />
    </View>
  );
}

export function SubKPICard({
  label, value, unit, history, higherIsBetter = true, color, onPress,
}: {
  label: string;
  value: string;
  unit: string;
  history: number[];
  higherIsBetter?: boolean;
  color: string;
  onPress?: () => void;
}) {
  const kpi = useThemedStyles(makeKpi);
  const { mean, sd } = stats(history);
  const current = history.length > 0 ? history[history.length - 1] : 0;
  const status  = history.length > 5 ? getStatus(current, mean, sd, higherIsBetter) : 'Normal range';
  const statusColor = STATUS_COLOR[status];

  const content = (
    <View style={kpi.card}>
      <View style={kpi.left}>
        <Text style={kpi.label}>{label}</Text>
        <View style={[kpi.badge, { backgroundColor: statusColor + '22' }]}>
          <Text style={[kpi.badgeText, { color: statusColor }]}>{status}</Text>
        </View>
      </View>
      {history.length > 1
        ? <Sparkline values={history} mean={mean} sd={sd} color={color} />
        : <View style={{ width: SPARK_W }} />}
      <View style={kpi.right}>
        <Text style={[kpi.value, { color }]}>{value}</Text>
        <Text style={kpi.unit}>{unit}</Text>
        {onPress && <Text style={kpi.arrow}>›</Text>}
      </View>
    </View>
  );

  return onPress
    ? <TouchableOpacity onPress={onPress} activeOpacity={0.75}>{content}</TouchableOpacity>
    : content;
}

const makeKpi = (c: Palette) => StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.border, gap: 10 },
  left: { width: 110, gap: 4 },
  label: { fontSize: 13, fontWeight: '600', color: c.text },
  badge: { borderRadius: 5, paddingHorizontal: 5, paddingVertical: 2, alignSelf: 'flex-start' },
  badgeText: { fontSize: 9, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.2 },
  right: { alignItems: 'flex-end', flex: 1 },
  value: { fontSize: 20, fontWeight: '800' },
  unit: { fontSize: 10, color: c.textFaint, marginTop: 1 },
  arrow: { fontSize: 16, color: c.textFaint, marginTop: 2 },
});
