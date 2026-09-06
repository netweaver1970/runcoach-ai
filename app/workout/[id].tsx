/**
 * Workout Detail Screen
 * Shows HR / Power / Pace area charts for a single run,
 * detected work-session highlights, extend left/right controls
 * to fix chest-strap HR gaps, and a type-override button.
 */

import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, SafeAreaView, ActivityIndicator,
  useWindowDimensions, ActionSheetIOS, Platform, Alert, PanResponder, TextInput, Keyboard,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, Stack, useNavigation } from 'expo-router';
import {
  fetchWorkoutDetail,
  formatDistance,
  formatDuration,
  formatPace,
  WorkoutDetailData,
  WorkoutActivity,
} from '../../src/services/healthkit';
import { saveRunOverride, saveHrUnreliable, getHrUnreliableRuns, getPowerZones } from '../../src/services/claude';
import { computePowerMetrics, ftpFromZones, PowerMetrics } from '../../src/services/powerMetrics';
// Reclassifying a run ripples through every type-derived cache — clear them all on a type change.
import { clearWorkoutCache } from '../../src/services/workoutClassifier';
import { clearSnapshotCache, clearTrimpCache } from '../../src/services/healthkit';
import { clearTodayPlanCache } from '../../src/services/coach';
import { getRunWorkOverride, setRunWorkOverride } from '../../src/services/runWorkOverride';
import { clearRunAnalysisCache } from '../../src/services/runAnalysis';
import { clearBodyBatteryCache } from '../../src/services/bodyBattery';
import { clearAccountingCache } from '../../src/services/accounting';
import { getRunMeta, saveRunNote, saveRunTemp, TempSource } from '../../src/services/runMeta';
import { prescribedPhasesAt, relabelByPhases } from '../../src/services/planLog';
import { toDateKey } from '../../src/services/dayView';
import { getLocalWeather } from '../../src/services/weather';
import { useTheme, useThemedStyles, Palette } from '../../src/theme';
import { useLLMReady } from '../../src/hooks/useLLMReady';
import { WorkoutLabel, KmSplit } from '../../src/types';

// ─── Types ────────────────────────────────────────────────────────────────────

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

/** Build pause session regions from the pause intervals returned by fetchWorkoutDetail */
function buildPauseRegions(pauseIntervals: { s: number; e: number }[]): SessionRegion[] {
  return pauseIntervals.map(({ s, e }) => ({
    type:   'recovery' as SessionType,  // re-use style slot; colour overridden below
    startMs: s,
    endMs:   e,
    label:   'Pause',
    color:   '#88888828',   // very light grey
    border:  '#88888888',   // grey border
  }));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(ms: number): string {
  const s   = Math.floor(Math.abs(ms) / 1000);
  const h   = Math.floor(s / 3600);
  const min = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
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
      case 'open':     return 'cooldown';  // free running past the planned cooldown
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

/**
 * Sort session regions by start time and clip overlapping non-pause ones.
 * Pause regions are kept separate and appended last so they paint on top of
 * activity backgrounds via React Native's z-order (later Views = higher layer).
 * This means a Work band spanning the whole run stays intact; pauses are simply
 * overlaid as grey bands on top wherever they occur.
 */
function deduplicateRegions(regions: SessionRegion[]): SessionRegion[] {
  const pauses    = regions.filter(r => r.label === 'Pause');
  const nonPauses = regions.filter(r => r.label !== 'Pause');

  if (nonPauses.length > 1) {
    const sorted = [...nonPauses].sort((a, b) => a.startMs - b.startMs);
    const result: SessionRegion[] = [];
    for (const curr of sorted) {
      if (result.length === 0) { result.push({ ...curr }); continue; }
      const prev = result[result.length - 1];
      if (curr.startMs < prev.endMs) {
        // Clip earlier region so it ends where the later one starts
        result[result.length - 1] = { ...prev, endMs: curr.startMs };
        if (curr.endMs > curr.startMs) result.push({ ...curr });
      } else {
        result.push({ ...curr });
      }
    }
    // Pauses appended last → rendered on top of activity bands
    return [...result.filter(r => r.endMs > r.startMs), ...pauses];
  }

  // Pauses appended last → rendered on top of activity bands
  return [...nonPauses.filter(r => r.endMs > r.startMs), ...pauses];
}

// ─── Area chart ───────────────────────────────────────────────────────────────

const CHART_H  = 95;
const Y_AXIS_W = 56;    // wide enough for M:SS pace labels

interface CorrectionLine {
  value: number;
  color: string;
  label?: string;
}

function AreaChart({
  data, totalMs, color, unit, sessions = [], correctionLines = [], pauseIntervals = [],
}: {
  data:             { t: number; v: number }[];
  totalMs:          number;
  color:            string;
  unit:             string;
  sessions?:        SessionRegion[];
  correctionLines?: CorrectionLine[];
  pauseIntervals?:  { s: number; e: number }[];
}) {
  const { width: screenW } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const ac = useThemedStyles(makeAc);
  const { c: pal } = useTheme();

  // Scrubber cursor (hooks before any early return)
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

  const isPace  = unit === 'min/km';
  const isPower = unit === 'W';

  // Wall-clock total = net active time + all pause durations.
  // totalMs from HealthKit is the NET (active) duration; data timestamps are
  // wall-clock offsets from workout start.  Data recorded AFTER a pause has
  // a wall-clock t > totalMs, which previously caused toX() to clip it to
  // chartW — making those bars render INSIDE the grey pause band.
  // Using wall-clock total fixes the mapping for all three regions.
  const pauseTotalMs = pauseIntervals.reduce((sum, p) => sum + Math.max(0, p.e - p.s), 0);
  const wallTotalMs  = totalMs + pauseTotalMs || 1;

  // Remove zero / negative values, data inside pause intervals, and extreme
  // outlier spikes that produce full-height rectangular artefacts.
  // When all values are zero/invalid (e.g. no GPS during pauses), return []
  // so the chart renders "No data" instead of a flat rectangle.
  const cleanData = (() => {
    if (!isPace && !isPower) return data;
    const valid = data.filter(p => {
      if (p.v <= 0) return false;
      // Drop samples that fall inside any pause interval (Watch shouldn't
      // record pace/power during pauses, but belt-and-suspenders here).
      if (pauseIntervals.some(pi => p.t >= pi.s && p.t <= pi.e)) return false;
      return true;
    });
    if (valid.length === 0) return [];
    const sorted = [...valid.map(p => p.v)].sort((a, b) => a - b);
    const p95    = sorted[Math.floor(sorted.length * 0.95)];
    const cap    = p95 * 1.5;
    return valid.filter(p => p.v <= cap);
  })();

  if (data.length === 0 || cleanData.length === 0) {
    return (
      <View style={{ height: CHART_H, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: '#aaa', fontSize: 14 }}>No data available</Text>
      </View>
    );
  }

  // Sort by wall-clock time before downsampling.
  // HealthKit can return overlapping GPS distance samples (e.g. a large cumulative
  // segment alongside individual 5-second GPS points covering the same period).
  // Without sorting, the cumulative sample's midpoint lands out of order in the array
  // and its bar extends to the next array entry — which may be far away — producing
  // a wide rectangular artefact. After sorting, it falls between its chronological
  // neighbours and gets a normal narrow bar.
  const chronological = (isPace || isPower)
    ? [...cleanData].sort((a, b) => a.t - b.t)
    : cleanData;
  const pts    = downsample(chronological, 600);
  const values = pts.map(p => p.v);
  // Globally-SPARSE run (an old optical-HR / estimated-power recording): samples are far apart, so the
  // baseline bars below turn into disconnected islands. Detect it from the typical gap and instead draw a
  // connected line through the points, which reads as a real (low-res) trace rather than a broken chart.
  const gapsMs: number[] = [];
  for (let i = 1; i < pts.length; i++) gapsMs.push(pts[i].t - pts[i - 1].t);
  gapsMs.sort((a, b) => a - b);
  const medGapMs = gapsMs.length ? gapsMs[Math.floor(gapsMs.length / 2)] : 1000;
  const sparse   = medGapMs > 30_000;   // typical gap > 30 s → genuinely low-resolution (draw a line, not bars)
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const pad    = (rawMax - rawMin) * 0.10 || 2;
  const scale  = niceScale(Math.max(0, rawMin - pad), rawMax + pad);
  const yRange = scale.niceMax - scale.niceMin || 1;

  // chartW must subtract all horizontal padding:
  //   scroll contentContainerStyle padding: 12px each side = 24px
  //   chartCard padding:                   12px each side = 24px
  //   total:                                                48px
  // PLUS the safe-area left/right insets — zero in portrait, but in LANDSCAPE the SafeAreaView pads the
  // notch/home-indicator sides, so using the raw window width overran the card's right border.
  const chartW = screenW - insets.left - insets.right - Y_AXIS_W - 48;

  // Format Y-axis ticks as M:SS for pace charts
  const fmtTick = (tick: number): string => {
    if (isPace) {
      const m = Math.floor(tick / 60);
      const s = Math.round(tick % 60);
      return `${m}:${s.toString().padStart(2, '0')}`;
    }
    return Math.round(tick) === tick ? String(Math.round(tick)) : tick.toFixed(1);
  };

  const toX = (ms: number) => Math.max(0, Math.min(chartW, (ms / wallTotalMs) * chartW));
  // For PACE, REVERSE the axis (Garmin-style): a FASTER pace (lower min/km) draws a TALLER bar and the
  // slowest / standstill end sits at ~0 height. Reflect the value around the range-adjusted scale so the
  // bars, the y-axis ticks AND the cursor all invert together. HR / power charts are unchanged.
  const plotV = (v: number) => (isPace ? scale.niceMin + scale.niceMax - v : v);
  const toY = (v: number)  => CHART_H * (1 - Math.max(0, Math.min(1, (plotV(v) - scale.niceMin) / yRange)));

  const xLabels = [0, 0.25, 0.5, 0.75, 1];

  // Cursor → nearest point (by wall-clock time)
  const cursorMs = cursorX == null ? -1 : (cursorX / chartW) * wallTotalMs;
  let curPt: { t: number; v: number } | null = null;
  if (cursorMs >= 0 && pts.length > 0) {
    let best = pts[0], bestD = Math.abs(pts[0].t - cursorMs);
    for (const p of pts) { const d = Math.abs(p.t - cursorMs); if (d < bestD) { bestD = d; best = p; } }
    curPt = best;
  }
  const curValStr = curPt ? (isPace ? `${fmtTick(curPt.v)} /km` : isPower ? `${Math.round(curPt.v)} W` : `${Math.round(curPt.v)} ${unit}`) : '';
  const curCx = curPt ? toX(curPt.t) : 0;
  const TIP_W = 96;
  const curTipLeft = Math.max(0, Math.min(chartW - TIP_W, curCx - TIP_W / 2));

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
        <View ref={plotRef} onLayout={measurePlot} style={{ width: chartW, height: CHART_H + LABEL_H, position: 'relative' }} {...pan.panHandlers}>

          {/* Session region overlays (behind data) */}
          {(() => {
            // Extend the first non-pause region back to 0 so there's no uncovered
            // gap at the chart start (HealthKit activities sometimes start slightly
            // after the workout began, leaving a visually jarring un-tinted strip).
            const extSessions = sessions.map((sr, i) => {
              if (i === 0 && sr.label !== 'Pause' && sr.startMs > 0 && sr.startMs < 180_000) {
                return { ...sr, startMs: 0 };
              }
              return sr;
            });
            return extSessions.map((sr, i) => {
              const x0 = toX(sr.startMs);
              const x1 = toX(sr.endMs);
              const w  = Math.max(2, x1 - x0);
              // Only draw a divider line between adjacent non-pause regions, not
              // as full-height left/right borders (which create a visible rectangle
              // outline when a region doesn't start at x=0).
              const showDivider = i > 0 && sr.label !== 'Pause' && extSessions[i - 1]?.label !== 'Pause';
              return (
                <View key={i}>
                  {/* Coloured background band */}
                  <View style={{
                    position: 'absolute',
                    left: x0, top: LABEL_H,
                    width: w, height: CHART_H,
                    backgroundColor: sr.color,
                  }} />
                  {/* Thin divider line between adjacent non-pause phases */}
                  {showDivider && (
                    <View style={{
                      position: 'absolute',
                      left: x0, top: LABEL_H,
                      width: 1.5, height: CHART_H,
                      backgroundColor: sr.border,
                    }} />
                  )}
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
            });
          })()}

          {/* Gridlines */}
          {scale.ticks.map((tick, i) => (
            <View key={i} style={{
              position: 'absolute',
              top: LABEL_H + toY(tick), left: 0, right: 0,
              height: 1, backgroundColor: pal.gridline,
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

          {/* Data — a connected line for a sparse/low-res run, baseline bars for a dense recording */}
          {sparse ? (
            pts.map((pt, i) => {
              const x = toX(pt.t), y = LABEL_H + toY(pt.v);
              let line = null;
              if (i > 0) {
                const x1 = toX(pts[i - 1].t), y1 = LABEL_H + toY(pts[i - 1].v);
                const overPause = pauseIntervals.some(pi => pts[i - 1].t < pi.e && pt.t > pi.s);
                if (!overPause) {
                  const dx = x - x1, dy = y - y1, len = Math.hypot(dx, dy), ang = Math.atan2(dy, dx) * 180 / Math.PI;
                  line = <View style={{ position: 'absolute', left: (x1 + x) / 2 - len / 2, top: (y1 + y) / 2 - 1, width: len, height: 2, backgroundColor: color, borderRadius: 1, transform: [{ rotate: `${ang}deg` }] }} />;
                }
              }
              return (
                <React.Fragment key={i}>
                  {line}
                  <View style={{ position: 'absolute', left: x - 2, top: y - 2, width: 4, height: 4, borderRadius: 2, backgroundColor: color }} />
                </React.Fragment>
              );
            })
          ) : (
            pts.map((pt, i) => {
              const nextPt = pts[i + 1];
              const x = toX(pt.t);
              let rawNextX = nextPt ? toX(nextPt.t) : chartW;
              // Cap at nearest pause boundary (prevents bar stretching over pause).
              for (const pi of pauseIntervals) {
                const pauseStartX = toX(pi.s);
                if (pauseStartX > x && pauseStartX < rawNextX) rawNextX = pauseStartX;
              }
              // Pace/power: cap bar width so a stationary gap (e.g. you stop moving but
              // leave the watch running) renders as an empty gap, not a flat block.
              if (isPace || isPower) {
                const maxBarW = (18_000 / wallTotalMs) * chartW; // ~18 s of data
                if (rawNextX - x > maxBarW) rawNextX = x + maxBarW;
              }
              const nextX = rawNextX;
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
            })
          )}

          {/* Scrubber cursor */}
          {curPt && (
            <>
              <View style={{ position: 'absolute', left: curCx, top: LABEL_H, width: 1, height: CHART_H, backgroundColor: '#555' }} />
              <View style={{
                position: 'absolute', left: curCx - 4, top: LABEL_H + toY(curPt.v) - 4,
                width: 8, height: 8, borderRadius: 4, backgroundColor: color, borderWidth: 1, borderColor: '#fff',
              }} />
              <View style={[ac.tip, { left: curTipLeft, width: TIP_W }]}>
                <Text style={ac.tipTime}>{fmtTime(curPt.t)}</Text>
                <Text style={ac.tipVal}>{curValStr}</Text>
              </View>
            </>
          )}
        </View>
      </View>

      {/* X-axis — labels in wall-clock time (includes pause durations) */}
      <View style={{ marginLeft: Y_AXIS_W, flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
        {xLabels.map(frac => (
          <Text key={frac} style={ac.xLabel}>{fmtTime(frac * wallTotalMs)}</Text>
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

const OVERRIDE_LABELS: WorkoutLabel[] = ['Z2', 'Tempo', 'Threshold', 'Intervals', 'LongRun', 'Recovery'];
const LABEL_DISPLAY: Record<WorkoutLabel, string> = {
  Z2: '🟢 Z2', Tempo: '🟠 Tempo', Threshold: '🟡 Threshold', Intervals: '🔴 Intervals',
  LongRun: '🔵 Long Run', Recovery: '🟣 Recovery', Unknown: '⚪ Unknown',
};

// ─── Main screen ──────────────────────────────────────────────────────────────

/** Compact sibling run, passed from the main screen so we can page prev/next. */
type Sib = { i: string; s: string; du: number; di: number; c: number; l: string };

export default function WorkoutDetailScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const st = useThemedStyles(makeSt);
  const { c: pal } = useTheme();
  const llm = useLLMReady();
  // Dismiss the keyboard on ANY navigation-away (the iOS swipe-back gesture bypasses the Back button's
  // handler) — a focused notes field whose keyboard lingers over the previous screen freezes the app.
  useEffect(() => navigation.addListener('beforeRemove', () => { Keyboard.dismiss(); }), [navigation]);
  const params = useLocalSearchParams<{
    id:        string;
    startDate: string;
    duration:  string;
    label:     string;
    date:      string;
    distance:  string;
    calories:  string;
    siblings?: string;
  }>();

  const [detail,    setDetail]    = useState<WorkoutDetailData | null>(null);
  const [surges,    setSurges]    = useState<SurgeRegion[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);
  const [currentLabel, setCurrentLabel] = useState(params.label ?? '');
  const [hrUnreliable, setHrUnreliable] = useState(false);
  const [note,       setNote]       = useState('');
  const [workOverride, setWorkOverrideState] = useState<number | null>(null);   // manual counted-work-minutes (null = auto)
  useEffect(() => { getRunWorkOverride(params.id).then(v => setWorkOverrideState(v ?? null)).catch(() => {}); }, [params.id]);
  const [tempC,      setTempC]      = useState<number | null>(null);
  const [tempSource, setTempSource] = useState<TempSource | null>(null);
  const [ftp,        setFtp]        = useState(0);

  useEffect(() => { getPowerZones().then(pz => setFtp(ftpFromZones(pz))).catch(() => {}); }, []);
  // TrainingPeaks-style power stress (NP/IF/VI/TSS) from the dense running-power stream.
  const powerMetrics: PowerMetrics | null = useMemo(
    () => (detail?.power?.length ? computePowerMetrics(detail.power, ftp, Math.round((detail.totalMs || 0) / 1000)) : null),
    [detail, ftp],
  );

  const duration = parseInt(params.duration ?? '0', 10);
  const distance = parseFloat(params.distance ?? '0');

  // ── Load ────────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await fetchWorkoutDetail(params.startDate, duration);

      // Label the segments from the prescribed phase sequence live at run start (HK's per-step labels
      // aren't reliable enough alone). Safe because every push site saves the EXACT workout it pushes,
      // so the logged structure == what the watch ran — only per-segment duration can differ. Trailing
      // free running past the cooldown → "Open". Falls back to HK's own labels if no plan is found.
      try {
        const phases = await prescribedPhasesAt(toDateKey(new Date(params.startDate)), params.startDate);
        if (phases) relabelByPhases([...d.activities].sort((a, b) => a.startMs - b.startMs), phases);
      } catch { /* fall back to HealthKit's own labels */ }

      // Refine any segments STILL generically labelled 'work'/'rep' by SPEED — HK lumps drills + the
      // recovery jogs between reps into "work", and relabelByPhases bails when the actual segment count
      // differs from the prescription by >2. A rep much slower than the true work pace is a Recovery jog;
      // an extremely slow one is Drills/strides. Warmup/Cooldown (already labelled) are left alone.
      const durOf = (a: any) => a.netDurationSec > 0 ? a.netDurationSec : (a.endMs - a.startMs) / 1000;
      const paceOf = (a: any) => a.distanceM > 30 && durOf(a) > 0 ? durOf(a) / (a.distanceM / 1000) : 0;
      const workSegs = d.activities.filter((a: any) => /^(work|rep)/i.test(a.label) && paceOf(a) > 0);
      if (workSegs.length >= 2) {
        const paces = workSegs.map(paceOf).sort((x, y) => x - y);
        const fast = paces.slice(0, Math.max(1, Math.ceil(paces.length / 2)));      // the true HARD reps
        const workPace = fast.reduce((s, p) => s + p, 0) / fast.length;
        for (const a of workSegs) {
          const p = paceOf(a);
          if (p > Math.max(840, workPace * 2.2)) (a as any).label = 'Drills';        // ≥14:00/km or ≥2.2× → drills
          else if (p > workPace * 1.35) (a as any).label = 'Recovery';               // ≥1.35× the rep pace → recovery
        }
      }

      setDetail(d);

      const hrVals = d.hr.map(p => p.v);
      const maxHR  = hrVals.length > 0
        ? Math.round(Math.max(...hrVals) * 1.05)
        : 185;
      const detected = detectSurges(d.hr, maxHR);
      setSurges(detected);

      const map = await getHrUnreliableRuns();
      setHrUnreliable(map[params.id] ?? false);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load workout data');
    } finally {
      setLoading(false);
    }
  }, [params.startDate, duration, params.id]);

  useEffect(() => { load(); }, [load]);

  // ── Prev/next navigation within the main-screen filter ────────────────────
  const siblings: Sib[] = useMemo(() => {
    try { return params.siblings ? (JSON.parse(params.siblings) as Sib[]) : []; }
    catch { return []; }
  }, [params.siblings]);
  const curIdx = siblings.findIndex(s => s.i === params.id);

  const goTo = useCallback((idx: number) => {
    if (idx < 0 || idx >= siblings.length) return;
    // Paging changes params.id, which remounts the ScrollView (key={params.id}). If the notes field is
    // focused, remounting it out from under a live keyboard wedges the screen — dismiss first.
    Keyboard.dismiss();
    const s = siblings[idx];
    router.setParams({
      id: s.i, startDate: s.s, duration: String(s.du), label: s.l,
      date: s.s, distance: String(s.di), calories: String(s.c),
      siblings: params.siblings ?? '',
    });
  }, [siblings, router, params.siblings]);
  const goPrev = useCallback(() => goTo(curIdx - 1), [goTo, curIdx]); // newer (up the list)
  const goNext = useCallback(() => goTo(curIdx + 1), [goTo, curIdx]); // older (down the list)

  // Latest nav fns for the once-created swipe responder
  const goPrevRef = useRef(goPrev); goPrevRef.current = goPrev;
  const goNextRef = useRef(goNext); goNextRef.current = goNext;
  const noteFocusedRef = useRef(false);   // don't let a horizontal drag page (and remount) while editing the note
  const swipe = useRef(
    PanResponder.create({
      // Claim only clear horizontal swipes; charts (deeper) keep their scrub, and
      // vertical scrolling passes through to the ScrollView. Never while the note field is focused.
      onMoveShouldSetPanResponder: (_e, g) => !noteFocusedRef.current && Math.abs(g.dx) > 28 && Math.abs(g.dx) > Math.abs(g.dy) * 1.8,
      onPanResponderRelease: (_e, g) => {
        if (g.dx <= -55)     goNextRef.current(); // swipe left  → next (older)
        else if (g.dx >= 55) goPrevRef.current(); // swipe right → prev (newer)
      },
    })
  ).current;

  // Sync the editable label badge when paging to a sibling (setParams won't
  // re-run the useState initialiser).
  useEffect(() => { setCurrentLabel(params.label ?? ''); }, [params.id, params.label]);

  // ── Load note + resolve temperature (manual > HK weather > live capture) ──────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const meta = await getRunMeta(params.id);
      if (cancelled) return;
      setNote(meta.note ?? '');

      const hk = detail?.weatherTempC;
      let t: number | null = null;
      let src: TempSource | null = null;
      if (meta.tempSource === 'manual' && meta.tempC != null) { t = meta.tempC; src = 'manual'; }
      else if (hk != null)                                     { t = hk;        src = 'hk'; }
      else if (meta.tempC != null)                             { t = meta.tempC; src = meta.tempSource ?? 'live'; }
      setTempC(t);
      setTempSource(src);

      // No temperature anywhere → for a recent run, record the current temp once.
      if (t == null && !loading) {
        const ageH = (Date.now() - new Date(params.startDate).getTime()) / 3.6e6;
        if (ageH <= 36) {
          const w = await getLocalWeather();
          if (!cancelled && w) {
            setTempC(w.tempC); setTempSource('live');
            saveRunTemp(params.id, w.tempC, 'live');
          }
        }
      }
    })();
    return () => { cancelled = true; };
  }, [params.id, params.startDate, detail?.weatherTempC, loading]);

  const handleEditTemp = useCallback(() => {
    Alert.prompt?.(
      'Temperature',
      'Enter the temperature in °C for this run',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Save',
          onPress: (val?: string) => {
            const n = parseFloat((val ?? '').replace(',', '.'));
            if (isNaN(n)) return;
            setTempC(Math.round(n)); setTempSource('manual');
            saveRunTemp(params.id, n, 'manual');
          },
        },
      ],
      'plain-text',
      tempC != null ? String(tempC) : '',
      'numbers-and-punctuation',
    );
  }, [params.id, tempC]);

  const handleNoteBlur = useCallback(() => {
    saveRunNote(params.id, note);
  }, [params.id, note]);

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
        // A type change ripples through TRIMP → strain → CTL/ATL/TSB → bands → daily/week plan →
        // run analysis, so drop EVERY type-derived cache. The home screen then does a full recompute
        // on focus (it detects the label change) so nothing stays tied to the old type.
        await Promise.all([
          clearWorkoutCache(), clearSnapshotCache(), clearTrimpCache(),
          clearTodayPlanCache(), clearRunAnalysisCache(), clearBodyBatteryCache(),
        ]);
        clearAccountingCache();
        const newLabel = isRemove ? '' : OVERRIDE_LABELS[buttonIndex - 1];
        setCurrentLabel(newLabel);
        Alert.alert(
          isRemove ? 'Override removed' : 'Type updated',
          isRemove
            ? 'Reverted to the auto-detected type — load, strain and plan are recalculating.'
            : `Set to ${LABEL_DISPLAY[OVERRIDE_LABELS[buttonIndex - 1]]} — load, strain and plan are recalculating.`,
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

  // ── Analyze handler ──────────────────────────────────────────────────────

  const handleAnalyze = useCallback(() => {
    Keyboard.dismiss();   // don't push /chat with the notes keyboard still up
    const compact = {
      cal: Math.round(parseFloat(params.calories ?? '0')),
      hrUnreliable: hrUnreliable || undefined,
      segs: (detail?.activities ?? []).map(a => ({
        l:   a.label,
        d:   Math.round(a.distanceM),
        t:   Math.round(a.netDurationSec > 0 ? a.netDurationSec : (a.endMs - a.startMs) / 1000),
        hr:  a.avgHR     || 0,
        cad: a.cadenceSPM || 0,
        pwr: a.avgPower   || 0,
      })).filter(s => s.d > 0),
      kms: (detail?.kmSplits ?? []).map(k => ({
        km:  k.km,
        t:   Math.round(k.durationSec),
        p:   Math.round(k.paceSecs),
        hr:  k.avgHR       || 0,
        cad: k.avgCadence  || 0,
        pwr: k.avgPower    || 0,
      })),
    };
    router.push({
      pathname: '/chat',
      params: {
        focusRunUUID:  params.id,
        runDetailJson: JSON.stringify(compact),
      },
    } as any);
  }, [detail, params.id, params.calories]);

  // ── Stats ─────────────────────────────────────────────────────────────────

  const avgHR    = detail?.hr.length    ? Math.round(detail.hr.reduce((s, p) => s + p.v, 0)    / detail.hr.length)    : null;
  const avgPower = detail?.power.length ? Math.round(detail.power.reduce((s, p) => s + p.v, 0) / detail.power.length) : null;
  const avgPace  = detail?.pace.length  ? Math.round(detail.pace.reduce((s, p) => s + p.v, 0)  / detail.pace.length)  : null;
  // Low-resolution HR (old optical / summary run): too few samples for the HR trace to be trustworthy. Same
  // threshold the scan uses to flag the run (< 1 sample/min, i.e. gaps > 60 s — a genuinely broken trace;
  // a chest-strap run stored every 15–30 s stays valid) — HR-based stats already exclude flagged runs.
  const hrLowRes = !!detail && detail.hr.length > 0 && detail.totalMs > 300_000 && (detail.hr.length / (detail.totalMs / 60_000)) < 1;
  const calories = Math.round(parseFloat(params.calories ?? '0'));

  const dateObj   = new Date(params.date ?? params.startDate ?? '');
  const dateLabel = dateObj.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const timeLabel = dateObj.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  const ls = LABEL_STYLE[currentLabel] ?? LABEL_STYLE.Unknown;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={st.container} {...swipe.panHandlers}>
      <Stack.Screen options={{ headerShown: false }} />
      {/* Header */}
      <View style={st.header}>
        <TouchableOpacity onPress={() => { Keyboard.dismiss(); router.back(); }} hitSlop={{ top: 14, bottom: 14, left: 16, right: 16 }} style={st.backBtn}>
          <Text style={st.backText}>‹ Back</Text>
        </TouchableOpacity>
        <View style={{ alignItems: 'center', flex: 1 }}>
          <Text style={st.headerDate}>{dateLabel}</Text>
          <Text style={st.headerTime}>{timeLabel}</Text>
          {siblings.length > 1 && curIdx >= 0 && (
            <View style={st.navRow}>
              <TouchableOpacity onPress={goPrev} disabled={curIdx === 0} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={[st.navArrow, curIdx === 0 && st.navArrowOff]}>‹</Text>
              </TouchableOpacity>
              <Text style={st.navCount}>{curIdx + 1} / {siblings.length}</Text>
              <TouchableOpacity onPress={goNext} disabled={curIdx === siblings.length - 1} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={[st.navArrow, curIdx === siblings.length - 1 && st.navArrowOff]}>›</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
        <View style={{ gap: 4, alignItems: 'flex-end' }}>
          <TouchableOpacity
            style={[st.labelBadge, { backgroundColor: currentLabel ? (pal.mode === 'dark' ? ls.color + '2e' : ls.bg) : pal.surfaceAlt }]}
            onPress={handleOverride}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={[st.labelBadgeText, { color: currentLabel ? ls.color : '#aaa' }]}>
              {currentLabel ? `${ls.emoji} ${currentLabel} ✎` : '✎ type'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[st.hrFlagBtn, (hrUnreliable || hrLowRes) && st.hrFlagBtnActive]}
            onPress={() => {
              const next = !hrUnreliable;
              setHrUnreliable(next);
              saveHrUnreliable(params.id, next);
            }}
          >
            <Text style={[st.hrFlagText, (hrUnreliable || hrLowRes) && { color: '#c0392b' }]}>
              {hrUnreliable ? '⚠️ HR unreliable' : hrLowRes ? '📉 HR low-res' : '✓ HR ok'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {loading ? (
        <View style={st.center}>
          <ActivityIndicator size="large" color={pal.accent} />
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
        // NOTE: no `automaticallyAdjustKeyboardInsets` + no `interactive` dismiss here on purpose — that
        // combo with the multiline notes field wedges the ScrollView's content inset on iOS (keyboard
        // hides but the screen freezes, force-quit only). The note sits near the top, so the keyboard
        // never covers it; `on-drag` dismiss is the safe replacement.
        <ScrollView key={params.id} contentContainerStyle={st.scroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">

          {/* Summary row */}
          <View style={st.summaryRow}>
            <SummaryBox label="Distance" value={formatDistance(distance)} />
            <SummaryBox label="Time"     value={formatDuration(duration)} />
            {avgPace  != null && <SummaryBox label="Avg pace"  value={formatPace(avgPace)}  />}
            {avgHR    != null && <SummaryBox label="Avg HR"    value={`${avgHR} bpm`}   color="#e74c3c" />}
            {avgPower != null && <SummaryBox label="Avg power" value={`${avgPower} W`}  color="#8e44ad" />}
            {calories > 0 && <SummaryBox label="Calories" value={`${calories} kcal`} />}
            {/* Analyze button — compact tile next to calories */}
            <TouchableOpacity style={[st.summaryBox, st.analyzeBox, !llm.ready && st.analyzeBoxDisabled]} onPress={handleAnalyze} disabled={!llm.ready}>
              <Text style={st.analyzeText}>Analyze</Text>
            </TouchableOpacity>
          </View>

          {/* Conditions & Notes */}
          <View style={st.notesCard}>
            <View style={st.notesHeaderRow}>
              <Text style={st.notesTitle}>Conditions &amp; Notes</Text>
              <TouchableOpacity onPress={handleEditTemp} style={st.tempChip} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={st.tempChipText}>
                  🌡 {tempC != null ? `${tempC}°C` : 'add temp'}
                  {tempSource === 'hk' ? '  ·  Watch' : tempSource === 'live' ? '  ·  now' : tempSource === 'manual' ? '  ·  ✎' : ''}
                </Text>
              </TouchableOpacity>
            </View>
            <TextInput
              style={st.noteInput}
              value={note}
              onChangeText={setNote}
              onFocus={() => { noteFocusedRef.current = true; }}
              onBlur={() => { noteFocusedRef.current = false; handleNoteBlur(); }}
              placeholder="Add a note for this run (how it felt, terrain, injuries…)"
              placeholderTextColor="#aaa"
              multiline
              maxLength={500}
            />
            <Text style={st.noteHint}>Tap away to save · used by the AI coach when analysing this run</Text>
          </View>

          {/* Counted work time — hand-correct a badly-structured run so its time-on-feet doesn't skew cap/schedule */}
          {(() => {
            const EXCL = /warm|cool|recover|rest|walk|prep/i;
            const acts = detail?.activities ?? [];
            const autoMin = acts.length
              ? Math.round(acts.filter(a => !EXCL.test(a.label)).reduce((s, a) => s + (a.netDurationSec || 0), 0) / 60)
              : Math.round(duration / 60);
            const shown = workOverride ?? autoMin;
            const apply = (m: number | null) => {
              setWorkOverrideState(m);
              setRunWorkOverride(params.id, m).then(() => clearTodayPlanCache()).catch(() => {});
            };
            return (
              <View style={st.notesCard}>
                <Text style={st.notesTitle}>Counted work time</Text>
                <View style={st.workRow}>
                  <TouchableOpacity style={st.workStep} onPress={() => apply(Math.max(0, shown - 1))} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}><Text style={st.workStepT}>−</Text></TouchableOpacity>
                  <View style={st.workVal}>
                    <Text style={st.workValNum}>{shown} min</Text>
                    <Text style={st.workValSub}>{workOverride == null ? 'auto' : `auto ${autoMin} · manual`}</Text>
                  </View>
                  <TouchableOpacity style={st.workStep} onPress={() => apply(shown + 1)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}><Text style={st.workStepT}>+</Text></TouchableOpacity>
                  {workOverride != null && (
                    <TouchableOpacity style={st.workAuto} onPress={() => apply(null)}><Text style={st.workAutoT}>Use auto</Text></TouchableOpacity>
                  )}
                </View>
                <Text style={st.noteHint}>Work minutes counted toward your time-on-feet, rolling cap &amp; schedule — adjust if a badly-structured run mis-counted it.</Text>
              </View>
            );
          })()}

          {/* Charts — HR, Power, Pace stacked */}
          {(() => {
            const pauses = detail!.pauseIntervals ?? [];
            const rawSessions: SessionRegion[] = [
              ...(detail!.activities.length > 0
                ? buildActivitiesSessionRegions(detail!.activities)
                : (currentLabel === 'Intervals' && surges.length > 0
                    ? buildSessionRegions(surges, detail!.totalMs, [], [])
                    : [])),
              ...buildPauseRegions(pauses),
            ];
            // Deduplicate overlapping regions (HealthKit can report activities with
            // overlapping wall-clock spans; double-painting causes visible rectangles).
            const sessions = deduplicateRegions(rawSessions);
            return (
              <>
                <View style={st.chartCard}>
                  <Text style={st.chartLabel}>♥ Heart Rate</Text>
                  <AreaChart data={detail!.hr}    totalMs={detail!.totalMs} color="#e74c3c" unit="bpm"     sessions={sessions} correctionLines={[]} pauseIntervals={pauses} />
                </View>
                <View style={st.chartCard}>
                  <Text style={st.chartLabel}>⚡ Power</Text>
                  <AreaChart data={detail!.power} totalMs={detail!.totalMs} color="#8e44ad" unit="W"       sessions={sessions} correctionLines={[]} pauseIntervals={pauses} />
                </View>
                <View style={st.chartCard}>
                  <Text style={st.chartLabel}>⏱ Pace</Text>
                  <AreaChart data={detail!.pace}  totalMs={detail!.totalMs} color="#2980b9" unit="min/km"  sessions={sessions} correctionLines={[]} pauseIntervals={pauses} />
                </View>
              </>
            );
          })()}

          {/* Sample count */}
          {detail && (
            <Text style={st.sampleNote}>
              {detail.hr.length.toLocaleString()} HR · {detail.power.length.toLocaleString()} power · {detail.pace.length.toLocaleString()} pace samples
            </Text>
          )}

          {/* HR source diagnostic — reveals multi-source merging / wrong-window flattening */}
          {detail?.hrDiag && (
            <Text style={[st.sampleNote, { fontFamily: 'Menlo', fontSize: 10, opacity: 0.7 }]} selectable>
              🔬 {detail.hrDiag}
            </Text>
          )}

          {/* TrainingPeaks-style power stress metrics */}
          {powerMetrics && powerMetrics.np > 0 && (
            <View style={st.pmCard}>
              <Text style={st.pmTitle}>⚡ Power stress</Text>
              <View style={st.pmRow}>
                <View style={st.pmCell}><Text style={st.pmVal}>{powerMetrics.np}<Text style={st.pmUnit}>W</Text></Text><Text style={st.pmLbl}>NP</Text></View>
                <View style={st.pmCell}><Text style={st.pmVal}>{powerMetrics.if != null ? powerMetrics.if.toFixed(2) : '—'}</Text><Text style={st.pmLbl}>IF</Text></View>
                <View style={st.pmCell}><Text style={st.pmVal}>{powerMetrics.vi.toFixed(2)}</Text><Text style={st.pmLbl}>VI</Text></View>
                <View style={st.pmCell}><Text style={st.pmVal}>{powerMetrics.tss != null ? powerMetrics.tss : '—'}</Text><Text style={st.pmLbl}>TSS</Text></View>
              </View>
              <Text style={st.pmNote}>
                {powerMetrics.ftp > 0
                  ? `NP normalises for surges; IF = NP÷FTP (${powerMetrics.ftp}W); VI ${powerMetrics.vi.toFixed(2)} = ${powerMetrics.vi < 1.05 ? 'steady' : 'variable'}; TSS = session load.`
                  : `Set your power zones (Settings → Zones) to unlock IF & TSS — NP & VI shown from the power stream.`}
              </Text>
            </View>
          )}

          {/* Segment KPI table — shown when HK structured workout activities exist */}
          {detail && detail.activities.length > 0 && (
            <SegmentTable activities={detail.activities} />
          )}

          {/* Per-km splits — always shown when available */}
          {detail && detail.kmSplits.length > 0 && (
            <KmSplitTable splits={detail.kmSplits} />
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
  const seg = useThemedStyles(makeSeg);
  const hasHR      = activities.some(a => a.avgHR > 0);
  const hasPower   = activities.some(a => a.avgPower > 0);
  const hasCadence = activities.some(a => a.cadenceSPM > 0);

  return (
    <View style={seg.card}>
      {/* Header */}
      <View style={seg.headerRow}>
        <Text style={[seg.labelCol, seg.hdr]}>Segment</Text>
        <Text style={[seg.col,      seg.hdr]}>Dist</Text>
        <Text style={[seg.timeCol,  seg.hdr]}>Time</Text>
        <Text style={[seg.col,      seg.hdr]}>Pace</Text>
        {hasHR      && <Text style={[seg.col, seg.hdr]}>HR</Text>}
        {hasCadence && <Text style={[seg.col, seg.hdr]}>Cad</Text>}
        {hasPower   && <Text style={[seg.col, seg.hdr]}>Pwr</Text>}
      </View>

      {activities.map((a, i) => {
        // Use HK net duration (excludes pauses); fall back to wall-clock span
        const netSec      = a.netDurationSec > 0 ? a.netDurationSec : (a.endMs - a.startMs) / 1000;
        const distKm      = a.distanceM / 1000;
        const distStr     = a.distanceM >= 950
          ? `${distKm.toFixed(2)}k`
          : `${Math.round(a.distanceM)}m`;
        const timeStr     = fmtTime(netSec * 1000);
        const paceSecPkm  = distKm > 0 ? netSec / distKm : 0;
        const paceStr     = fmtPaceSec(paceSecPkm).replace(' /km', '');
        const color       = SEG_COLORS[a.label] ?? '#888';

        return (
          <View key={i} style={[seg.row, i % 2 === 1 && seg.rowAlt]}>
            <View style={[seg.labelCol, seg.badge, { borderLeftColor: color }]}>
              <Text style={[seg.labelTxt, { color }]}>{a.label}</Text>
            </View>
            <Text style={[seg.col,     seg.num]}>{distStr}</Text>
            <Text style={[seg.timeCol, seg.num]}>{timeStr}</Text>
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

const makeSeg = (c: Palette) => StyleSheet.create({
  card:      { backgroundColor: c.surface, borderRadius: 14, marginHorizontal: 12, marginBottom: 12,
               shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: c.shadowOpacity,
               shadowRadius: 4, elevation: 2, overflow: 'hidden' },
  headerRow: { flexDirection: 'row', backgroundColor: c.surfaceAlt, paddingVertical: 6,
               borderBottomWidth: 1, borderBottomColor: c.border },
  row:       { flexDirection: 'row', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.border },
  rowAlt:    { backgroundColor: c.surfaceAlt },
  hdr:       { color: c.textFaint, fontWeight: '600', fontSize: 10, textTransform: 'uppercase', textAlign: 'right' },
  labelCol:  { flex: 2.2, paddingLeft: 0 },
  col:       { flex: 1, paddingHorizontal: 3 },
  timeCol:   { flex: 1.4, paddingHorizontal: 3 },
  num:       { textAlign: 'right', fontSize: 12, color: c.text },
  badge:     { borderLeftWidth: 3, paddingLeft: 8 },
  labelTxt:  { fontWeight: '600', fontSize: 12 },
});

// ─── Km splits table ──────────────────────────────────────────────────────────

function KmSplitTable({ splits }: { splits: KmSplit[] }) {
  const km = useThemedStyles(makeKm);
  if (splits.length === 0) return null;
  const hasHR      = splits.some(s => s.avgHR > 0);
  const hasCadence = splits.some(s => s.avgCadence > 0);
  const hasPower   = splits.some(s => s.avgPower > 0);

  // Fastest and slowest pace for colour coding
  const paces    = splits.map(s => s.paceSecs).filter(p => p > 0);
  const minPace  = paces.length > 0 ? Math.min(...paces) : 0;
  const maxPace  = paces.length > 0 ? Math.max(...paces) : 0;
  const paceRange = maxPace - minPace || 1;

  // Lerp: fastest=green, slowest=orange
  const paceColor = (p: number) => {
    const t = (p - minPace) / paceRange;
    const r = Math.round(46  + (243 - 46)  * t);
    const g = Math.round(204 + (156 - 204) * t);
    const b = Math.round(113 + (18  - 113) * t);
    return `rgb(${r},${g},${b})`;
  };

  // Format wall-clock duration for a km (M:SS)
  const fmtDur = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <View style={km.card}>
      <Text style={km.title}>Per-km splits</Text>
      {/* Header */}
      <View style={km.headerRow}>
        <Text style={[km.kmCol,   km.hdr]}>Km</Text>
        <Text style={[km.timeCol, km.hdr]}>Time</Text>
        <Text style={[km.col,   km.hdr]}>Pace</Text>
        {hasHR      && <Text style={[km.col, km.hdr]}>HR</Text>}
        {hasCadence && <Text style={[km.col, km.hdr]}>Cad</Text>}
        {hasPower   && <Text style={[km.col, km.hdr]}>Pwr</Text>}
      </View>
      {splits.map((s, i) => (
        <View key={i} style={[km.row, i % 2 === 1 && km.rowAlt]}>
          <Text style={[km.kmCol,   km.num]}>{s.km}</Text>
          <Text style={[km.timeCol, km.num]}>{s.durationSec > 0 ? fmtDur(s.durationSec) : '—'}</Text>
          <Text style={[km.col, km.num, { color: paceColor(s.paceSecs), fontWeight: '700' }]}>
            {fmtPaceSec(s.paceSecs).replace(' /km', '')}
          </Text>
          {hasHR      && <Text style={[km.col, km.num]}>{s.avgHR      > 0 ? `${s.avgHR}`      : '—'}</Text>}
          {hasCadence && <Text style={[km.col, km.num]}>{s.avgCadence > 0 ? `${s.avgCadence}` : '—'}</Text>}
          {hasPower   && <Text style={[km.col, km.num]}>{s.avgPower   > 0 ? `${s.avgPower}`   : '—'}</Text>}
        </View>
      ))}
    </View>
  );
}

const makeKm = (c: Palette) => StyleSheet.create({
  card:      { backgroundColor: c.surface, borderRadius: 14, marginHorizontal: 12, marginBottom: 12,
               shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: c.shadowOpacity,
               shadowRadius: 4, elevation: 2, overflow: 'hidden' },
  title:     { fontSize: 13, fontWeight: '700', color: c.textSub, paddingHorizontal: 12,
               paddingTop: 10, paddingBottom: 6 },
  headerRow: { flexDirection: 'row', backgroundColor: c.surfaceAlt, paddingVertical: 6,
               borderBottomWidth: 1, borderBottomColor: c.border },
  row:       { flexDirection: 'row', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.border },
  rowAlt:    { backgroundColor: c.surfaceAlt },
  hdr:       { color: c.textFaint, fontWeight: '600', fontSize: 10, textTransform: 'uppercase', textAlign: 'right' },
  kmCol:     { flex: 0.55, paddingLeft: 12 },
  col:       { flex: 1, paddingHorizontal: 3 },
  timeCol:   { flex: 1.4, paddingHorizontal: 3 },
  num:       { textAlign: 'right', fontSize: 12, color: c.text },
});

// ─── Helper component ─────────────────────────────────────────────────────────

function SummaryBox({ label, value, color }: { label: string; value: string; color?: string }) {
  const st = useThemedStyles(makeSt);
  return (
    <View style={st.summaryBox}>
      <Text style={[st.summaryVal, color ? { color } : null]}>{value}</Text>
      <Text style={st.summaryLbl}>{label}</Text>
    </View>
  );
}

// ─── Chart styles ─────────────────────────────────────────────────────────────

const makeAc = (c: Palette) => StyleSheet.create({
  yLabel:       { fontSize: 11, color: c.textSub, textAlign: 'right', fontWeight: '500' },
  xLabel:       { fontSize: 11, color: c.textSub, fontWeight: '500' },
  unitLabel:    { fontSize: 10, color: c.textSub, textAlign: 'center', fontWeight: '500' },
  sessionLabel: { fontSize: 9, fontWeight: '700', textAlign: 'center' },
  tip:          { position: 'absolute', top: 0, backgroundColor: 'rgba(20,20,24,0.92)', borderRadius: 7, paddingHorizontal: 7, paddingVertical: 3, alignItems: 'center' },
  tipTime:      { color: '#ddd', fontSize: 10, fontWeight: '700' },
  tipVal:       { color: '#fff', fontSize: 12, fontWeight: '800', marginTop: 1 },
});

// ─── Screen styles ────────────────────────────────────────────────────────────

const makeSt = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: c.surface,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  backBtn:        { paddingRight: 8, minWidth: 52 },
  backText:       { fontSize: 17, color: c.accent, fontWeight: '600' },
  headerDate:     { fontSize: 14, fontWeight: '700', color: c.text },
  headerTime:     { fontSize: 12, color: c.textSub, marginTop: 1 },
  navRow:         { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 3 },
  navArrow:       { fontSize: 20, color: c.accent, fontWeight: '800', lineHeight: 22 },
  navArrowOff:    { color: c.textFaint },
  navCount:       { fontSize: 11, color: c.textSub, fontWeight: '600', minWidth: 42, textAlign: 'center' },

  notesCard:      { backgroundColor: c.surface, borderRadius: 12, padding: 12, marginBottom: 12,
                    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: c.shadowOpacity, shadowRadius: 3, elevation: 2 },
  notesHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  notesTitle:     { fontSize: 13, fontWeight: '700', color: c.textSub },
  tempChip:       { backgroundColor: c.mode === 'dark' ? '#3a2218' : '#FFF3EE', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: c.accent + '40' },
  tempChipText:   { fontSize: 13, fontWeight: '700', color: c.accent },
  noteInput:      { backgroundColor: c.surfaceAlt, borderRadius: 8, padding: 10, fontSize: 14, color: c.text,
                    minHeight: 44, maxHeight: 120, textAlignVertical: 'top' },
  noteHint:       { fontSize: 10, color: c.textFaint, marginTop: 5 },
  workRow:        { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8 },
  workStep:       { width: 40, height: 40, borderRadius: 20, backgroundColor: c.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
  workStepT:      { fontSize: 22, fontWeight: '700', color: c.text, lineHeight: 24 },
  workVal:        { flex: 1, alignItems: 'center' },
  workValNum:     { fontSize: 20, fontWeight: '800', color: c.text, fontVariant: ['tabular-nums'] },
  workValSub:     { fontSize: 10, color: c.textFaint, marginTop: 1 },
  workAuto:       { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, backgroundColor: c.surfaceAlt },
  workAutoT:      { fontSize: 12, fontWeight: '700', color: c.accent },
  labelBadge:     { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, minWidth: 70, alignItems: 'center' },
  labelBadgeText: { fontSize: 12, fontWeight: '700' },

  center:       { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  loadingText:  { marginTop: 8, color: c.textSub, fontSize: 14 },
  errorText:    { fontSize: 15, color: '#c0392b', textAlign: 'center', marginBottom: 16, fontWeight: '600' },
  retryBtn:     { backgroundColor: c.accent, borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
  retryBtnText: { color: '#fff', fontWeight: '700' },

  scroll: { padding: 12, paddingBottom: 40 },

  summaryRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12,
  },
  summaryBox: {
    flex: 1, minWidth: 72,
    backgroundColor: c.surface, borderRadius: 10,
    paddingVertical: 9, alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: c.shadowOpacity, shadowRadius: 3, elevation: 2,
  },
  summaryVal: { fontSize: 14, fontWeight: '800', color: c.text },
  summaryLbl: { fontSize: 10, color: c.textSub, marginTop: 2, fontWeight: '500' },

  chartLabel: { fontSize: 12, fontWeight: '700', color: c.textSub, marginBottom: 4, paddingHorizontal: 2 },

  chartCard: {
    backgroundColor: c.surface, borderRadius: 12,
    padding: 12, marginBottom: 8,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: c.shadowOpacity, shadowRadius: 3, elevation: 2,
  },

  sampleNote: {
    fontSize: 11, color: c.textFaint, textAlign: 'center', marginBottom: 12,
  },

  pmCard:  { backgroundColor: c.surface, borderRadius: 14, padding: 14, marginBottom: 12 },
  pmTitle: { color: c.text, fontSize: 14, fontWeight: '700', marginBottom: 10 },
  pmRow:   { flexDirection: 'row', justifyContent: 'space-between' },
  pmCell:  { flex: 1, alignItems: 'center' },
  pmVal:   { color: c.text, fontSize: 20, fontWeight: '800' },
  pmUnit:  { color: c.textSub, fontSize: 12, fontWeight: '600' },
  pmLbl:   { color: c.textSub, fontSize: 11, fontWeight: '600', marginTop: 2 },
  pmNote:  { color: c.textFaint, fontSize: 10.5, lineHeight: 15, marginTop: 10, textAlign: 'center' },

  hrFlagBtn:       { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceAlt },
  hrFlagBtnActive: { borderColor: '#c0392b', backgroundColor: c.mode === 'dark' ? '#3a1d1d' : '#fdedec' },
  hrFlagText:      { fontSize: 11, color: c.textSub, fontWeight: '600' },

  analyzeBox:   { backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center', paddingVertical: 0, minHeight: 44 },
  analyzeBoxDisabled: { opacity: 0.4 },
  analyzeText:  { fontSize: 13, fontWeight: '700', color: '#fff' },
});
