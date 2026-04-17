/**
 * Workout Detail Screen
 * Shows HR / Power / Pace area charts for a single run,
 * detected work-session highlights, extend left/right controls
 * to fix chest-strap HR gaps, and a type-override button.
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, SafeAreaView, ActivityIndicator,
  useWindowDimensions, ActionSheetIOS, Platform, Alert,
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import {
  fetchWorkoutDetail,
  formatDistance,
  formatDuration,
  formatPace,
  WorkoutDetailData,
  WorkoutActivity,
} from '../../src/services/healthkit';
import { saveRunOverride } from '../../src/services/claude';
import {
  saveWorkHRCorrection,
  getWorkHRCorrectionInfo,
  clearWorkHRCorrection,
} from '../../src/services/workoutClassifier';
import { WorkoutLabel } from '../../src/types';

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = 'hr' | 'power' | 'pace';

interface SurgeRegion {
  startMs: number;
  endMs:   number;
  avgHR:   number;
  peakHR:  number;
}

type SessionType = 'warmup' | 'work' | 'recovery' | 'cooldown' | 'walk';

interface SessionRegion {
  type:    SessionType;
  startMs: number;
  endMs:   number;
  label:   string;
  color:   string;   // background fill colour
  border:  string;   // border/tick colour
}

const SESSION_COLORS: Record<SessionType, { bg: string; border: string }> = {
  warmup:   { bg: '#f39c1240', border: '#f39c12cc' },  // amber
  work:     { bg: '#e74c3c35', border: '#e74c3ccc' },  // red
  recovery: { bg: '#2ecc7140', border: '#2ecc71cc' },  // green
  cooldown: { bg: '#3498db40', border: '#3498dbcc' },  // blue
  walk:     { bg: '#9b59b640', border: '#9b59b6cc' },  // purple
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(ms: number): string {
  const s   = Math.floor(Math.abs(ms) / 1000);
  const min = Math.floor(s / 60);
  const sec = s % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

function fmtPaceSec(spk: number): string {
  if (!spk || spk <= 0) return '—';
  const m = Math.floor(spk / 60);
  const s = Math.round(spk % 60);
  return `${m}:${s.toString().padStart(2, '0')} /km`;
}

function niceScale(rawMin: number, rawMax: number) {
  if (rawMax <= rawMin) rawMax = rawMin + 1;
  const range   = rawMax - rawMin;
  const rawStep = range / 4;
  const mag     = Math.pow(10, Math.floor(Math.log10(rawStep)));
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

function downsample<T>(arr: T[], maxPts: number): T[] {
  if (arr.length <= maxPts) return arr;
  const out: T[] = [];
  const step = (arr.length - 1) / (maxPts - 1);
  for (let i = 0; i < maxPts; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

function detectSurges(hr: { t: number; v: number }[], maxHR: number): SurgeRegion[] {
  if (hr.length < 10 || maxHR <= 0) return [];
  const high = maxHR * 0.80;
  const low  = maxHR * 0.70;
  const surges: SurgeRegion[] = [];
  let inSurge = false;
  let surgeStart = 0;
  let consHigh = 0;
  let consLow  = 0;

  const closeSurge = (endIdx: number) => {
    const w = hr.slice(surgeStart, endIdx + 1);
    if (w.length < 3) return;
    surges.push({
      startMs: hr[surgeStart].t,
      endMs:   hr[endIdx].t,
      avgHR:   Math.round(w.reduce((s, p) => s + p.v, 0) / w.length),
      peakHR:  Math.max(...w.map(p => p.v)),
    });
  };

  for (let i = 0; i < hr.length; i++) {
    const v = hr[i].v;
    if (v >= high) {
      consHigh++; consLow = 0;
      if (consHigh >= 3 && !inSurge) { inSurge = true; surgeStart = Math.max(0, i - 2); }
    } else if (v < low) {
      consLow++; consHigh = 0;
      if (consLow >= 3 && inSurge) { closeSurge(i - consLow); inSurge = false; consLow = 0; }
    } else { consHigh = 0; consLow = 0; }
  }
  if (inSurge) closeSurge(hr.length - 1);
  return surges;
}

/**
 * Build labelled session regions from surge (work) intervals.
 * Warmup: before first work interval.
 * Work: each surge.
 * Recovery: between surges.
 * Cooldown: after last surge.
 */
function buildSessionRegions(
  surges: SurgeRegion[],
  totalMs: number,
  extL: number[],
  extR: number[],
): SessionRegion[] {
  if (surges.length === 0) return [];
  const regions: SessionRegion[] = [];

  const first = surges[0];
  const last  = surges[surges.length - 1];
  const firstStart = first.startMs - (extL[0] ?? 0);
  const lastEnd    = last.endMs    + (extR[surges.length - 1] ?? 0);

  // Warmup
  if (firstStart > 30_000) {
    regions.push({ type: 'warmup', startMs: 0, endMs: firstStart,
      label: 'Warmup', ...SESSION_COLORS.warmup, color: SESSION_COLORS.warmup.bg, border: SESSION_COLORS.warmup.border });
  }

  surges.forEach((sg, i) => {
    const s = sg.startMs - (extL[i] ?? 0);
    const e = sg.endMs   + (extR[i] ?? 0);

    // Recovery between previous and this work segment
    if (i > 0) {
      const prevEnd = surges[i - 1].endMs + (extR[i - 1] ?? 0);
      if (s > prevEnd + 5_000) {
        regions.push({ type: 'recovery', startMs: prevEnd, endMs: s,
          label: 'Recovery', color: SESSION_COLORS.recovery.bg, border: SESSION_COLORS.recovery.border });
      }
    }

    // Work
    regions.push({ type: 'work', startMs: s, endMs: e,
      label: surges.length === 1 ? 'Work' : `Rep ${i + 1}`,
      color: SESSION_COLORS.work.bg, border: SESSION_COLORS.work.border });
  });

  // Cooldown
  if (totalMs - lastEnd > 30_000) {
    regions.push({ type: 'cooldown', startMs: lastEnd, endMs: totalMs,
      label: 'Cooldown', color: SESSION_COLORS.cooldown.bg, border: SESSION_COLORS.cooldown.border });
  }

  return regions;
}

/**
 * Build session regions directly from HealthKit workoutActivities.
 * Used whenever the workout has structured activities (regardless of label).
 */
function buildActivitiesSessionRegions(activities: WorkoutActivity[]): SessionRegion[] {
  const labelToType = (label: string): SessionType => {
    switch (label.toLowerCase()) {
      case 'warmup':
      case 'warm-up': return 'warmup';
      case 'recovery': return 'recovery';
      case 'cooldown': return 'cooldown';
      case 'walk':     return 'walk';
      default:         return 'work';  // 'Work' and anything else
    }
  };
  return activities.map(act => {
    const type = labelToType(act.label);
    return {
      type,
      startMs: act.startMs,
      endMs:   act.endMs,
      label:   act.label,
      color:   SESSION_COLORS[type].bg,
      border:  SESSION_COLORS[type].border,
    };
  });
}

// ─── Area chart ───────────────────────────────────────────────────────────────

const CHART_H  = 165;   // 75% of original 220
const Y_AXIS_W = 56;    // wide enough for M:SS pace labels

interface CorrectionLine {
  value: number;
  color: string;
  label?: string;
}

function AreaChart({
  data, totalMs, color, unit, sessions = [], correctionLines = [],
}: {
  data:             { t: number; v: number }[];
  totalMs:          number;
  color:            string;
  unit:             string;
  sessions?:        SessionRegion[];
  correctionLines?: CorrectionLine[];
}) {
  const { width: screenW } = useWindowDimensions();

  if (data.length === 0) {
    return (
      <View style={{ height: CHART_H, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: '#aaa', fontSize: 14 }}>No data available</Text>
      </View>
    );
  }

  const isPace  = unit === 'min/km';
  const isPower = unit === 'W';

  // Remove zero / negative values and extreme outlier spikes that produce
  // full-height rectangular artefacts in the area-chart rendering.
  // Strategy: drop invalid values (≤ 0) then cap at 1.5× the p95 of the
  // remaining data — relative to the actual distribution so it works across
  // all pace ranges, power levels, etc.
  const cleanData = (() => {
    if (!isPace && !isPower) return data;
    const valid = data.filter(p => p.v > 0);
    if (valid.length === 0) return data;
    const sorted = [...valid.map(p => p.v)].sort((a, b) => a - b);
    const p95    = sorted[Math.floor(sorted.length * 0.95)];
    const cap    = p95 * 1.5;
    return valid.filter(p => p.v <= cap);
  })();

  const pts    = downsample(cleanData, 600);
  const values = pts.map(p => p.v);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const pad    = (rawMax - rawMin) * 0.10 || 2;
  const scale  = niceScale(Math.max(0, rawMin - pad), rawMax + pad);
  const yRange = scale.niceMax - scale.niceMin || 1;

  // chartW must subtract all horizontal padding:
  //   scroll contentContainerStyle padding: 12px each side = 24px
  //   chartCard padding:                   12px each side = 24px
  //   total:                                                48px
  const chartW = screenW - Y_AXIS_W - 48;

  // Format Y-axis ticks as M:SS for pace charts
  const fmtTick = (tick: number): string => {
    if (isPace) {
      const m = Math.floor(tick / 60);
      const s = Math.round(tick % 60);
      return `${m}:${s.toString().padStart(2, '0')}`;
    }
    return Math.round(tick) === tick ? String(Math.round(tick)) : tick.toFixed(1);
  };

  const toX = (ms: number) => Math.max(0, Math.min(chartW, (ms / totalMs) * chartW));
  const toY = (v: number)  => CHART_H * (1 - Math.max(0, Math.min(1, (v - scale.niceMin) / yRange)));

  const xLabels = [0, 0.25, 0.5, 0.75, 1];

  // Label height above chart for session type tags
  const LABEL_H = sessions.length > 0 ? 18 : 0;

  const UNIT_W = 14;

  return (
    <View>
      <View style={{ flexDirection: 'row' }}>
        {/* Unit label — rotated on Y-axis */}
        <View style={{ width: UNIT_W, height: CHART_H + LABEL_H, justifyContent: 'center', alignItems: 'center' }}>
          <Text style={[ac.unitLabel, { transform: [{ rotate: '-90deg' }], width: CHART_H }]} numberOfLines={1}>
            {unit}
          </Text>
        </View>
        {/* Y-axis tick values */}
        <View style={{ width: Y_AXIS_W - UNIT_W, height: CHART_H + LABEL_H }}>
          {scale.ticks.map((tick, i) => (
            <Text key={i} style={[ac.yLabel, { position: 'absolute', top: LABEL_H + toY(tick) - 9, right: 4 }]}>
              {fmtTick(tick)}
            </Text>
          ))}
        </View>

        {/* Plot area */}
        <View style={{ width: chartW, height: CHART_H + LABEL_H, position: 'relative' }}>

          {/* Session region overlays (behind data) */}
          {sessions.map((sr, i) => {
            const x0 = toX(sr.startMs);
            const x1 = toX(sr.endMs);
            const w  = Math.max(2, x1 - x0);
            return (
              <View key={i}>
                {/* Coloured background band */}
                <View style={{
                  position: 'absolute',
                  left: x0, top: LABEL_H,
                  width: w, height: CHART_H,
                  backgroundColor: sr.color,
                  borderLeftWidth: 1.5, borderRightWidth: 1.5,
                  borderColor: sr.border,
                }} />
                {/* Session label above chart */}
                <View style={{
                  position: 'absolute',
                  left: x0, top: 0,
                  width: w, height: LABEL_H,
                  alignItems: 'center', justifyContent: 'center',
                  overflow: 'hidden',
                }}>
                  {w > 28 && (
                    <Text style={[ac.sessionLabel, { color: sr.border.replace('aa', 'ff') }]} numberOfLines={1}>
                      {sr.label}
                    </Text>
                  )}
                </View>
              </View>
            );
          })}

          {/* Gridlines */}
          {scale.ticks.map((tick, i) => (
            <View key={i} style={{
              position: 'absolute',
              top: LABEL_H + toY(tick), left: 0, right: 0,
              height: 1, backgroundColor: '#e0e0e0',
            }} />
          ))}

          {/* HR correction lines — horizontal dashed rule at corrected value */}
          {correctionLines.map((cl, i) => {
            const y = toY(cl.value);
            if (y < 0 || y > CHART_H) return null;
            return (
              <View key={`cl-${i}`} style={{ position: 'absolute', top: LABEL_H + y, left: 0, right: 0 }}>
                <View style={{
                  position: 'absolute', left: 0, right: 0,
                  borderBottomWidth: 2, borderColor: cl.color, borderStyle: 'dashed',
                }} />
                {cl.label ? (
                  <Text style={{
                    position: 'absolute', right: 4, top: -14,
                    color: cl.color, fontSize: 10, fontWeight: '700',
                    backgroundColor: 'rgba(255,255,255,0.85)', paddingHorizontal: 3, borderRadius: 3,
                  }}>
                    {cl.label}
                  </Text>
                ) : null}
              </View>
            );
          })}

          {/* Area fill */}
          {pts.map((pt, i) => {
            const nextPt = pts[i + 1];
            const x     = toX(pt.t);
            const nextX = nextPt ? toX(nextPt.t) : chartW;
            const w     = Math.max(1, nextX - x);
            const barH  = Math.max(2, CHART_H - toY(pt.v));
            return (
              <View key={i} style={{
                position: 'absolute',
                left: x, top: LABEL_H + toY(pt.v),
                width: w, height: barH,
                backgroundColor: color + 'B0',
              }} />
            );
          })}
        </View>
      </View>

      {/* X-axis */}
      <View style={{ marginLeft: Y_AXIS_W, flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
        {xLabels.map(frac => (
          <Text key={frac} style={ac.xLabel}>{fmtTime(frac * totalMs)}</Text>
        ))}
      </View>
    </View>
  );
}

// ─── Label styles ─────────────────────────────────────────────────────────────

const LABEL_STYLE: Record<string, { color: string; bg: string; emoji: string }> = {
  Intervals: { color: '#c0392b', bg: '#fdedec', emoji: '🔴' },
  Tempo:     { color: '#d35400', bg: '#fef0e7', emoji: '🟠' },
  LongRun:   { color: '#2980b9', bg: '#eaf4fd', emoji: '🔵' },
  Z2:        { color: '#27ae60', bg: '#eafaf1', emoji: '🟢' },
  Recovery:  { color: '#8e44ad', bg: '#f5eef8', emoji: '🟣' },
  Unknown:   { color: '#888',    bg: '#f5f5f5', emoji: '⚪' },
};

const OVERRIDE_LABELS: WorkoutLabel[] = ['Z2', 'Tempo', 'Intervals', 'LongRun', 'Recovery'];
const LABEL_DISPLAY: Record<WorkoutLabel, string> = {
  Z2: '🟢 Z2', Tempo: '🟠 Tempo', Intervals: '🔴 Intervals',
  LongRun: '🔵 Long Run', Recovery: '🟣 Recovery', Unknown: '⚪ Unknown',
};

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function WorkoutDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    id:        string;
    startDate: string;
    duration:  string;
    label:     string;
    date:      string;
    distance:  string;
  }>();

  const [tab,       setTab]       = useState<Tab>('hr');
  const [detail,    setDetail]    = useState<WorkoutDetailData | null>(null);
  const [surges,    setSurges]    = useState<SurgeRegion[]>([]);
  const [extL,      setExtL]      = useState<number[]>([]);
  const [extR,      setExtR]      = useState<number[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);
  const [currentLabel, setCurrentLabel] = useState(params.label ?? '');

  // Saved HR correction info (loaded from cache)
  const [hrCorrectionInfo, setHrCorrectionInfo] = useState<{
    correctedHR: number;
    originalHR:  number;
    hasCorrection: boolean;
  } | null>(null);

  const duration = parseInt(params.duration ?? '0', 10);
  const distance = parseFloat(params.distance ?? '0');

  // ── Load ────────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await fetchWorkoutDetail(params.startDate, duration);
      setDetail(d);

      const hrVals = d.hr.map(p => p.v);
      const maxHR  = hrVals.length > 0
        ? Math.round(Math.max(...hrVals) * 1.05)
        : 185;
      const detected = detectSurges(d.hr, maxHR);
      setSurges(detected);
      setExtL(detected.map(() => 0));
      setExtR(detected.map(() => 0));

      // Load any saved HR correction from cache (for visual line + undo button)
      const info = await getWorkHRCorrectionInfo(params.id);
      setHrCorrectionInfo(info);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load workout data');
    } finally {
      setLoading(false);
    }
  }, [params.startDate, duration, params.id]);

  useEffect(() => { load(); }, [load]);

  // ── Override handler ─────────────────────────────────────────────────────

  const handleOverride = useCallback(() => {
    const sheetOptions = [...OVERRIDE_LABELS.map(l => LABEL_DISPLAY[l]), '✕ Remove override'];
    const allOptions   = ['Cancel', ...sheetOptions];

    const apply = async (buttonIndex: number) => {
      if (buttonIndex === 0) return;
      const selected = sheetOptions[buttonIndex - 1];
      const isRemove = selected === '✕ Remove override';

      try {
        await saveRunOverride(params.id, isRemove ? null : OVERRIDE_LABELS[buttonIndex - 1]);
        const newLabel = isRemove ? '' : OVERRIDE_LABELS[buttonIndex - 1];
        setCurrentLabel(newLabel);
        Alert.alert(
          isRemove ? 'Override removed' : 'Type updated',
          isRemove
            ? 'The auto-detected type will show on the next reload.'
            : `Set to ${LABEL_DISPLAY[OVERRIDE_LABELS[buttonIndex - 1]]}.`,
        );
      } catch (err: any) {
        Alert.alert('Override failed', err.message);
      }
    };

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: 'Set run type',
          message: 'Override the auto-detected classification',
          options: allOptions,
          cancelButtonIndex: 0,
          destructiveButtonIndex: allOptions.length - 1,
        },
        apply,
      );
    } else {
      Alert.alert('Set run type', 'Choose a classification', [
        ...OVERRIDE_LABELS.map((l, i) => ({ text: LABEL_DISPLAY[l], onPress: () => apply(i + 1) })),
        { text: '✕ Remove override', onPress: () => apply(allOptions.length - 1), style: 'destructive' as const },
        { text: 'Cancel', style: 'cancel' as const },
      ]);
    }
  }, [params.id]);

  // ── Extend ────────────────────────────────────────────────────────────────

  const extendSurge = (idx: number, dir: 'left' | 'right', delta: number) => {
    if (dir === 'left')  setExtL(prev => prev.map((v, i) => i === idx ? Math.max(0, v + delta) : v));
    else                 setExtR(prev => prev.map((v, i) => i === idx ? Math.max(0, v + delta) : v));
  };

  const extendedAvgHR = (surge: SurgeRegion, idx: number): number => {
    if (!detail || detail.hr.length === 0) return surge.avgHR;
    const s = surge.startMs - (extL[idx] ?? 0);
    const e = surge.endMs   + (extR[idx] ?? 0);
    // Use peakHR as the reference — it's always a genuine reading (strap was
    // working at that moment). avgHR can be corrupted by drop-out zeros.
    // Any reading < 80 % of peak is treated as a chest-strap artefact and
    // excluded. The corrected average is then the mean of the valid readings
    // only — effectively "faking" the gap period with that valid average.
    const minValid = Math.round(surge.peakHR * 0.80);
    const w = detail.hr.filter(p => p.t >= s && p.t <= e && p.v >= minValid);
    if (w.length === 0) return surge.avgHR;
    return Math.round(w.reduce((acc, p) => acc + p.v, 0) / w.length);
  };

  // ── Stats ─────────────────────────────────────────────────────────────────

  const avgHR    = detail?.hr.length    ? Math.round(detail.hr.reduce((s, p) => s + p.v, 0)    / detail.hr.length)    : null;
  const avgPower = detail?.power.length ? Math.round(detail.power.reduce((s, p) => s + p.v, 0) / detail.power.length) : null;
  const avgPace  = detail?.pace.length  ? Math.round(detail.pace.reduce((s, p) => s + p.v, 0)  / detail.pace.length)  : null;

  const dateObj   = new Date(params.date ?? params.startDate ?? '');
  const dateLabel = dateObj.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const timeLabel = dateObj.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  const ls = LABEL_STYLE[currentLabel] ?? LABEL_STYLE.Unknown;

  const tabColor   = tab === 'hr' ? '#e74c3c' : tab === 'power' ? '#8e44ad' : '#2980b9';
  const tabData    = !detail ? [] : tab === 'hr' ? detail.hr : tab === 'power' ? detail.power : detail.pace;
  const tabUnit    = tab === 'hr' ? 'bpm' : tab === 'power' ? 'W' : 'min/km';

  // ── HR correction lines for the graph ─────────────────────────────────────
  // Only shown on the HR tab.
  // • While the user is actively extending: a live orange preview line per surge.
  // • When a correction has been saved: a persistent magenta dashed line.
  const isExtending = extL.some(v => v > 0) || extR.some(v => v > 0);
  const hrCorrectionLines: CorrectionLine[] = [];
  if (tab === 'hr' && detail) {
    if (isExtending && surges.length > 0) {
      // Live preview: one line per surge showing the corrected avg for that rep
      surges.forEach((sg, i) => {
        const avg = extendedAvgHR(sg, i);
        hrCorrectionLines.push({
          value: avg,
          color: '#FF6B35',
          label: surges.length === 1 ? `~${avg} bpm` : `Rep ${i + 1}: ~${avg} bpm`,
        });
      });
    } else if (hrCorrectionInfo?.hasCorrection) {
      // Saved correction: single line at the stored value
      hrCorrectionLines.push({
        value: hrCorrectionInfo.correctedHR,
        color: '#8e44ad',
        label: `saved ${hrCorrectionInfo.correctedHR} bpm`,
      });
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={st.container}>
      <Stack.Screen options={{ title: 'Workout Details' }} />
      {/* Header */}
      <View style={st.header}>
        <TouchableOpacity onPress={() => router.back()} style={st.backBtn}>
          <Text style={st.backText}>‹ Back</Text>
        </TouchableOpacity>
        <View style={{ alignItems: 'center', flex: 1 }}>
          <Text style={st.headerDate}>{dateLabel}</Text>
          <Text style={st.headerTime}>{timeLabel}</Text>
        </View>
        <TouchableOpacity
          style={[st.labelBadge, { backgroundColor: currentLabel ? ls.bg : '#f5f5f5' }]}
          onPress={handleOverride}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={[st.labelBadgeText, { color: currentLabel ? ls.color : '#aaa' }]}>
            {currentLabel ? `${ls.emoji} ${currentLabel} ✎` : '✎ type'}
          </Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={st.center}>
          <ActivityIndicator size="large" color="#FF6B35" />
          <Text style={st.loadingText}>Loading workout data…</Text>
        </View>
      ) : error ? (
        <View style={st.center}>
          <Text style={st.errorText}>{error}</Text>
          <TouchableOpacity style={st.retryBtn} onPress={load}>
            <Text style={st.retryBtnText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView contentContainerStyle={st.scroll}>

          {/* Summary row */}
          <View style={st.summaryRow}>
            <SummaryBox label="Distance" value={formatDistance(distance)} />
            <SummaryBox label="Time"     value={formatDuration(duration)} />
            {avgPace  != null && <SummaryBox label="Avg pace"  value={formatPace(avgPace)}  />}
            {avgHR    != null && <SummaryBox label="Avg HR"    value={`${avgHR} bpm`}   color="#e74c3c" />}
            {avgPower != null && <SummaryBox label="Avg power" value={`${avgPower} W`}  color="#8e44ad" />}
          </View>

          {/* Tab bar */}
          <View style={st.tabBar}>
            {([
              { key: 'hr'    as Tab, label: '♥ HR'    },
              { key: 'power' as Tab, label: '⚡ Power' },
              { key: 'pace'  as Tab, label: '⏱ Pace'  },
            ]).map(t => (
              <TouchableOpacity
                key={t.key}
                style={[st.tabBtn, tab === t.key && { backgroundColor: tabColor, borderColor: tabColor }]}
                onPress={() => setTab(t.key)}
              >
                <Text style={[st.tabText, tab === t.key && st.tabTextActive]}>{t.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Chart — HealthKit activities only; never modified by user actions */}
          <View style={st.chartCard}>
            <AreaChart
              data={tabData}
              totalMs={detail!.totalMs}
              color={tabColor}
              unit={tabUnit}
              sessions={
                detail!.activities.length > 0
                  ? buildActivitiesSessionRegions(detail!.activities)
                  : (currentLabel === 'Intervals' && surges.length > 0
                      ? buildSessionRegions(surges, detail!.totalMs, extL, extR)
                      : [])
              }
              correctionLines={hrCorrectionLines}
            />
          </View>

          {/* Sample count */}
          {detail && (
            <Text style={st.sampleNote}>
              {detail.hr.length.toLocaleString()} HR · {detail.power.length.toLocaleString()} power · {detail.pace.length.toLocaleString()} pace samples
            </Text>
          )}

          {/* Segment KPI table — shown when HK structured workout activities exist */}
          {detail && detail.activities.length > 0 && (
            <SegmentTable activities={detail.activities} />
          )}

          {/* Work sessions */}
          {surges.length >= 1 && (
            <View style={st.surgesCard}>
              <Text style={st.sectionTitle}>Work Sessions</Text>
              <Text style={st.sectionHint}>
                Tap ← 30s / 30s → to extend a session window left or right, capturing HR before/after a chest-strap gap.
              </Text>

              {/* Save HR correction — only shown once any window has been adjusted */}
              {extL.some(v => v > 0) || extR.some(v => v > 0) ? (
                <TouchableOpacity
                  style={st.saveHRBtn}
                  onPress={async () => {
                    if (!detail) return;
                    // Average of valid readings across all extended windows.
                    // Use peakHR as threshold reference (never corrupted by
                    // drop-out zeros). Weight by sample count, not duration —
                    // extending into a gap adds no valid samples so duration
                    // weighting would still distort the result.
                    // The corrected value "fakes" the gap period: the valid
                    // average IS the corrected HR for the full work zone.
                    let totalHR = 0, totalSamples = 0;
                    surges.forEach((sg, i) => {
                      const s = sg.startMs - (extL[i] ?? 0);
                      const e = sg.endMs   + (extR[i] ?? 0);
                      const minValid = Math.round(sg.peakHR * 0.80);
                      const pts = detail.hr.filter(p => p.t >= s && p.t <= e && p.v >= minValid);
                      pts.forEach(p => { totalHR += p.v; totalSamples++; });
                    });
                    const corrected = totalSamples > 0 ? Math.round(totalHR / totalSamples) : 0;
                    if (corrected <= 0) return;
                    await saveWorkHRCorrection(params.id, corrected);
                    // Refresh correction info so the graph line updates immediately
                    const info = await getWorkHRCorrectionInfo(params.id);
                    setHrCorrectionInfo(info);
                    // Reset extend windows now that the correction is saved
                    setExtL(surges.map(() => 0));
                    setExtR(surges.map(() => 0));
                    Alert.alert(
                      'HR correction saved',
                      `Work HR updated to ${corrected} bpm. The main screen will reflect this on next load.`,
                    );
                  }}
                >
                  <Text style={st.saveHRBtnText}>💾 Save HR correction</Text>
                </TouchableOpacity>
              ) : null}

              {/* Undo HR correction — shown when a saved correction exists */}
              {hrCorrectionInfo?.hasCorrection && !isExtending ? (
                <TouchableOpacity
                  style={st.undoHRBtn}
                  onPress={() => {
                    Alert.alert(
                      'Undo HR correction',
                      `This will restore the original classifier value (${hrCorrectionInfo.originalHR} bpm) and remove the ${hrCorrectionInfo.correctedHR} bpm override.`,
                      [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Undo correction',
                          style: 'destructive',
                          onPress: async () => {
                            await clearWorkHRCorrection(params.id);
                            setHrCorrectionInfo(prev => prev
                              ? { ...prev, hasCorrection: false, correctedHR: prev.originalHR }
                              : null
                            );
                            Alert.alert('Undone', `Work HR restored to ${hrCorrectionInfo.originalHR} bpm.`);
                          },
                        },
                      ],
                    );
                  }}
                >
                  <Text style={st.undoHRBtnText}>↩ Undo HR correction ({hrCorrectionInfo.correctedHR} → {hrCorrectionInfo.originalHR} bpm)</Text>
                </TouchableOpacity>
              ) : null}

              {surges.map((sg, i) => {
                const lExt  = extL[i] ?? 0;
                const rExt  = extR[i] ?? 0;
                const computedAvg = extendedAvgHR(sg, i);
                const extended    = lExt > 0 || rExt > 0;

                return (
                  <View key={i} style={st.repRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={st.repNum}>Rep {i + 1}</Text>
                      <Text style={st.repTimes}>
                        {fmtTime(sg.startMs - lExt)} → {fmtTime(sg.endMs + rExt)}
                        {'  ·  '}
                        <Text style={st.repDur}>{fmtTime(sg.endMs - sg.startMs + lExt + rExt)}</Text>
                      </Text>
                    </View>

                    <View style={st.repStats}>
                      <Text style={[st.repHR, extended && { color: '#FF6B35' }]}>
                        {computedAvg} bpm
                      </Text>
                      <Text style={st.repPeak}>peak {sg.peakHR}</Text>
                    </View>

                    <View style={st.extendBtns}>
                      <View style={st.extendRow}>
                        <TouchableOpacity style={st.extBtn} onPress={() => extendSurge(i, 'left', 30_000)}>
                          <Text style={st.extBtnText}>← 30s</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[st.extBtn, lExt === 0 && st.extBtnOff]}
                          onPress={() => extendSurge(i, 'left', -30_000)}
                          disabled={lExt === 0}
                        >
                          <Text style={[st.extBtnText, lExt === 0 && { color: '#ccc' }]}>↩</Text>
                        </TouchableOpacity>
                      </View>
                      <View style={st.extendRow}>
                        <TouchableOpacity
                          style={[st.extBtn, rExt === 0 && st.extBtnOff]}
                          onPress={() => extendSurge(i, 'right', -30_000)}
                          disabled={rExt === 0}
                        >
                          <Text style={[st.extBtnText, rExt === 0 && { color: '#ccc' }]}>↩</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={st.extBtn} onPress={() => extendSurge(i, 'right', 30_000)}>
                          <Text style={st.extBtnText}>30s →</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  </View>
                );
              })}
            </View>
          )}

        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// ─── Segment KPI table ────────────────────────────────────────────────────────

const SEG_COLORS: Record<string, string> = {
  Warmup:   '#f39c12',
  Work:     '#e74c3c',
  Recovery: '#2ecc71',
  Cooldown: '#3498db',
  Walk:     '#9b59b6',
};

function SegmentTable({ activities }: { activities: WorkoutActivity[] }) {
  const hasHR      = activities.some(a => a.avgHR > 0);
  const hasPower   = activities.some(a => a.avgPower > 0);
  const hasCadence = activities.some(a => a.cadenceSPM > 0);

  return (
    <View style={seg.card}>
      {/* Header */}
      <View style={seg.headerRow}>
        <Text style={[seg.labelCol, seg.hdr]}>Segment</Text>
        <Text style={[seg.col,      seg.hdr]}>Dist</Text>
        <Text style={[seg.col,      seg.hdr]}>Time</Text>
        <Text style={[seg.col,      seg.hdr]}>Pace</Text>
        {hasHR      && <Text style={[seg.col, seg.hdr]}>HR</Text>}
        {hasCadence && <Text style={[seg.col, seg.hdr]}>Cad</Text>}
        {hasPower   && <Text style={[seg.col, seg.hdr]}>Pwr</Text>}
      </View>

      {activities.map((a, i) => {
        const durationSec = (a.endMs - a.startMs) / 1000;
        const distKm      = a.distanceM / 1000;
        const distStr     = a.distanceM >= 950
          ? `${distKm.toFixed(2)}k`
          : `${Math.round(a.distanceM)}m`;
        const timeStr     = fmtTime(a.endMs - a.startMs);
        const paceSecPkm  = distKm > 0 ? durationSec / distKm : 0;
        const paceStr     = fmtPaceSec(paceSecPkm).replace(' /km', '');
        const color       = SEG_COLORS[a.label] ?? '#888';

        return (
          <View key={i} style={[seg.row, i % 2 === 1 && seg.rowAlt]}>
            <View style={[seg.labelCol, seg.badge, { borderLeftColor: color }]}>
              <Text style={[seg.labelTxt, { color }]}>{a.label}</Text>
            </View>
            <Text style={[seg.col, seg.num]}>{distStr}</Text>
            <Text style={[seg.col, seg.num]}>{timeStr}</Text>
            <Text style={[seg.col, seg.num]}>{paceStr}</Text>
            {hasHR      && <Text style={[seg.col, seg.num]}>{a.avgHR > 0 ? `${a.avgHR}` : '—'}</Text>}
            {hasCadence && <Text style={[seg.col, seg.num]}>{a.cadenceSPM > 0 ? `${a.cadenceSPM}` : '—'}</Text>}
            {hasPower   && <Text style={[seg.col, seg.num]}>{a.avgPower > 0 ? `${a.avgPower}` : '—'}</Text>}
          </View>
        );
      })}
    </View>
  );
}

const seg = StyleSheet.create({
  card:      { backgroundColor: '#fff', borderRadius: 14, marginHorizontal: 12, marginBottom: 12,
               shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06,
               shadowRadius: 4, elevation: 2, overflow: 'hidden' },
  headerRow: { flexDirection: 'row', backgroundColor: '#f8f8f8', paddingVertical: 6,
               borderBottomWidth: 1, borderBottomColor: '#eee' },
  row:       { flexDirection: 'row', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  rowAlt:    { backgroundColor: '#fafafa' },
  hdr:       { color: '#999', fontWeight: '600', fontSize: 10, textTransform: 'uppercase', textAlign: 'right' },
  labelCol:  { flex: 2.2, paddingLeft: 0 },
  col:       { flex: 1, paddingHorizontal: 3 },
  num:       { textAlign: 'right', fontSize: 12, color: '#333' },
  badge:     { borderLeftWidth: 3, paddingLeft: 8 },
  labelTxt:  { fontWeight: '600', fontSize: 12 },
});

// ─── Helper component ─────────────────────────────────────────────────────────

function SummaryBox({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={st.summaryBox}>
      <Text style={[st.summaryVal, color ? { color } : null]}>{value}</Text>
      <Text style={st.summaryLbl}>{label}</Text>
    </View>
  );
}

// ─── Chart styles ─────────────────────────────────────────────────────────────

const ac = StyleSheet.create({
  yLabel:       { fontSize: 11, color: '#555', textAlign: 'right', fontWeight: '500' },
  xLabel:       { fontSize: 11, color: '#666', fontWeight: '500' },
  unitLabel:    { fontSize: 10, color: '#888', textAlign: 'center', fontWeight: '500' },
  sessionLabel: { fontSize: 9, fontWeight: '700', textAlign: 'center' },
});

// ─── Screen styles ────────────────────────────────────────────────────────────

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F5F5F5' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  backBtn:        { paddingRight: 8, minWidth: 52 },
  backText:       { fontSize: 17, color: '#FF6B35', fontWeight: '600' },
  headerDate:     { fontSize: 14, fontWeight: '700', color: '#222' },
  headerTime:     { fontSize: 12, color: '#888', marginTop: 1 },
  labelBadge:     { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, minWidth: 70, alignItems: 'center' },
  labelBadgeText: { fontSize: 12, fontWeight: '700' },

  center:       { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  loadingText:  { marginTop: 8, color: '#888', fontSize: 14 },
  errorText:    { fontSize: 15, color: '#c0392b', textAlign: 'center', marginBottom: 16, fontWeight: '600' },
  retryBtn:     { backgroundColor: '#FF6B35', borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
  retryBtnText: { color: '#fff', fontWeight: '700' },

  scroll: { padding: 12, paddingBottom: 40 },

  summaryRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12,
  },
  summaryBox: {
    flex: 1, minWidth: 72,
    backgroundColor: '#fff', borderRadius: 10,
    paddingVertical: 9, alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 3, elevation: 2,
  },
  summaryVal: { fontSize: 14, fontWeight: '800', color: '#333' },
  summaryLbl: { fontSize: 10, color: '#888', marginTop: 2, fontWeight: '500' },

  tabBar: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  tabBtn: {
    flex: 1, paddingVertical: 9, borderRadius: 8,
    borderWidth: 1.5, borderColor: '#ddd',
    alignItems: 'center', backgroundColor: '#fff',
  },
  tabText:       { fontSize: 13, color: '#555', fontWeight: '600' },
  tabTextActive: { color: '#fff', fontWeight: '700' },

  chartCard: {
    backgroundColor: '#fff', borderRadius: 12,
    padding: 12, marginBottom: 8,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 3, elevation: 2,
  },

  sampleNote: {
    fontSize: 11, color: '#bbb', textAlign: 'center', marginBottom: 12,
  },

  surgesCard: {
    backgroundColor: '#fff', borderRadius: 12,
    padding: 14, marginBottom: 12,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 3, elevation: 2,
  },
  sectionTitle: {
    fontSize: 12, fontWeight: '700', color: '#666',
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4,
  },
  sectionHint: { fontSize: 12, color: '#aaa', marginBottom: 12, lineHeight: 18 },

  repRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, borderTopWidth: 1, borderTopColor: '#f0f0f0', gap: 8,
  },
  repNum:    { fontSize: 13, fontWeight: '700', color: '#333', marginBottom: 2 },
  repTimes:  { fontSize: 12, color: '#888' },
  repDur:    { fontSize: 12, color: '#FF6B35', fontWeight: '600' },
  repStats:  { alignItems: 'flex-end', minWidth: 66 },
  repHR:     { fontSize: 15, fontWeight: '800', color: '#e74c3c' },
  repPeak:   { fontSize: 11, color: '#aaa', marginTop: 1 },

  saveHRBtn: {
    backgroundColor: '#FF6B35', borderRadius: 8,
    paddingVertical: 10, alignItems: 'center', marginBottom: 10,
  },
  saveHRBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },

  undoHRBtn: {
    borderWidth: 1.5, borderColor: '#8e44ad', borderRadius: 8,
    paddingVertical: 8, alignItems: 'center', marginBottom: 10,
    backgroundColor: '#f5eef8',
  },
  undoHRBtnText: { color: '#8e44ad', fontWeight: '600', fontSize: 13 },

  extendBtns: { alignItems: 'flex-end', gap: 4 },
  extendRow:  { flexDirection: 'row', gap: 4 },
  extBtn: {
    borderWidth: 1.5, borderColor: '#FF6B35', borderRadius: 6,
    paddingHorizontal: 7, paddingVertical: 4,
    backgroundColor: '#FFF3EE',
  },
  extBtnOff:  { borderColor: '#eee', backgroundColor: '#fafafa' },
  extBtnText: { fontSize: 11, color: '#FF6B35', fontWeight: '700' },
});
