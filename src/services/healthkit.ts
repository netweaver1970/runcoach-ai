import HealthKit from '@kingstinct/react-native-healthkit';
import * as FileSystem from 'expo-file-system';

// In @kingstinct/react-native-healthkit v9, the enums are TypeScript-only types
// (their JS files export {}). The native NitroModules bridge expects the full
// Apple HealthKit identifier strings (e.g. "HKQuantityTypeIdentifierHeartRate").
const HKQuantityTypeIdentifier = {
  heartRate:                   'HKQuantityTypeIdentifierHeartRate',
  heartRateVariabilitySDNN:    'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
  restingHeartRate:            'HKQuantityTypeIdentifierRestingHeartRate',
  oxygenSaturation:            'HKQuantityTypeIdentifierOxygenSaturation',
  respiratoryRate:             'HKQuantityTypeIdentifierRespiratoryRate',
  vo2Max:                      'HKQuantityTypeIdentifierVO2Max',
  distanceWalkingRunning:      'HKQuantityTypeIdentifierDistanceWalkingRunning',
  bodyMass:                    'HKQuantityTypeIdentifierBodyMass',
  runningPower:                'HKQuantityTypeIdentifierRunningPower',
  activeEnergyBurned:          'HKQuantityTypeIdentifierActiveEnergyBurned',
} as const;

const HKCategoryTypeIdentifier = {
  sleepAnalysis: 'HKCategoryTypeIdentifierSleepAnalysis',
} as const;

// HKWorkoutActivityType.running = 37 (Apple HealthKit numeric constant)
const HK_WORKOUT_RUNNING = 37;

import {
  HealthSnapshot,
  RunWorkout,
  WorkoutSegment,
  WeeklyMileage,
  SleepSession,
  SleepSegment,
  SleepStageLabel,
  NightlyHRV,
  DailyRecovery,
  PowerZones,
  WorkoutLabel,
  WorkoutConfidence,
  KmSplit,
  TimelineEvent,
  ActivitySummary,
  DailyLoad,
  DayStrain,
} from '../types';
import { activityName, computeTrainingLoadSeries, computeDayStrain, computeStrainTrimp, strainFromTrimp, STRAIN_KCAL_TO_LOAD } from './trainingLoad';
import { loadRunMeta } from './runMeta';
import { classifyAndCacheRuns, loadWorkoutCache, computeWorkoutTypeStats, PerRunData } from './workoutClassifier';
import {
  getBodyMassKg, saveBodyMassKg, DEFAULT_BODY_MASS_KG,
  getPowerZones, getRunOverrides, isPowerZonesConfigured,
  getLongRunMinutes, getHrUnreliableRuns,
} from './claude';
import { loadEvents } from './timelineEvents';

// ─── Snapshot cache ───────────────────────────────────────────────────────────

const SNAPSHOT_CACHE_FILE = `${FileSystem.documentDirectory}runcoach-snapshot-cache.json`;
export async function saveSnapshotCache(snap: HealthSnapshot): Promise<void> {
  try { await FileSystem.writeAsStringAsync(SNAPSHOT_CACHE_FILE, JSON.stringify(snap)); } catch {}
}
export async function loadSnapshotCache(): Promise<HealthSnapshot | null> {
  try {
    const info = await FileSystem.getInfoAsync(SNAPSHOT_CACHE_FILE);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(SNAPSHOT_CACHE_FILE);
    return JSON.parse(raw) as HealthSnapshot;
  } catch { return null; }
}

// ─── HKCategoryValueSleepAnalysis numeric values ──────────────────────────────
// 0 = inBed, 1 = asleepUnspecified, 2 = awake, 3 = asleepCore, 4 = asleepDeep, 5 = asleepREM
const SLEEP_VALUE_TO_LABEL: Record<number, SleepStageLabel> = {
  0: 'inBed',
  1: 'asleepUnspecified',
  2: 'awake',
  3: 'asleepCore',
  4: 'asleepDeep',
  5: 'asleepREM',
};

const STAGE_WEIGHT: Record<SleepStageLabel, number> = {
  asleepDeep: 3,
  asleepREM: 2,
  asleepCore: 1,
  asleepUnspecified: 1,
  awake: 0,
  inBed: 0,
};

const METERS_PER_KM = 1000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Normalise a value that may be a Date object (v9 NitroModules API) or an
 * ISO string (older versions / mocks) to an ISO string.
 */
function toISOStr(d: Date | string | any): string {
  if (d instanceof Date) return d.toISOString();
  return String(d);
}

/**
 * Wrap every HealthKit call so that BOTH:
 *  - synchronous throws from the NitroModules JSI bridge
 *  - async Promise rejections
 * are silently caught and replaced with `fallback`.
 */
function safeQuery<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return fn().catch(() => fallback);
  } catch {
    return Promise.resolve(fallback);
  }
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

export function formatPace(secsPerKm: number): string {
  if (!secsPerKm || secsPerKm <= 0) return '—';
  const m = Math.floor(secsPerKm / 60);
  const s = Math.floor(secsPerKm % 60);
  return `${m}:${s.toString().padStart(2, '0')} /km`;
}

export function formatDistance(meters: number): string {
  return `${(meters / METERS_PER_KM).toFixed(2)} km`;
}

function minutesBetween(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 60000;
}

function toDateStr(iso: string | Date | any): string {
  // v9 API returns Date objects; older builds / mocks return ISO strings.
  if (iso instanceof Date) return iso.toISOString().split('T')[0];
  return String(iso).split('T')[0];
}

// ─── Workout subscription ─────────────────────────────────────────────────────

export async function subscribeToWorkoutChanges(
  onNewWorkout: () => void
): Promise<() => void> {
  try {
    const unsubscribe = await (HealthKit as any).subscribeToChanges(
      HKQuantityTypeIdentifier.distanceWalkingRunning,
      onNewWorkout
    );
    if (typeof unsubscribe === 'function') return unsubscribe;
  } catch {
    // Observer API unavailable — caller falls back to AppState
  }
  return () => {};
}

// ─── Permissions ──────────────────────────────────────────────────────────────

export async function requestPermissions(): Promise<boolean> {
  try {
    const allTypes = [
      // Quantity types
      'HKQuantityTypeIdentifierHeartRate',
      'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
      'HKQuantityTypeIdentifierRestingHeartRate',
      'HKQuantityTypeIdentifierOxygenSaturation',
      'HKQuantityTypeIdentifierRespiratoryRate',
      'HKQuantityTypeIdentifierVO2Max',
      'HKQuantityTypeIdentifierDistanceWalkingRunning',
      'HKQuantityTypeIdentifierBodyMass',
      'HKQuantityTypeIdentifierRunningPower',
      'HKQuantityTypeIdentifierRunningCadence',
      'HKQuantityTypeIdentifierStepCount',
      'HKQuantityTypeIdentifierActiveEnergyBurned',
      // Category types
      'HKCategoryTypeIdentifierSleepAnalysis',
      // Heartbeat series — raw R-R intervals for HRV quality filtering
      'HKDataTypeIdentifierHeartbeatSeries',
      // Workout type — REQUIRED to read HKWorkout samples via queryWorkoutSamples
      'HKWorkoutTypeIdentifier',
    ] as any[];
    await HealthKit.requestAuthorization([], allTypes);
    return true;
  } catch (err: any) {
    const msg = err?.message ?? err?.toString() ?? 'unknown error';
    console.error('HealthKit auth error:', err);
    throw new Error(`HealthKit auth failed: ${msg}`);
  }
}

// ─── Body mass ────────────────────────────────────────────────────────────────

export async function resolveBodyMassKg(): Promise<number> {
  const stored = await getBodyMassKg();
  if (stored !== DEFAULT_BODY_MASS_KG) return stored;

  try {
    const samples: any[] = await safeQuery(
      () => (HealthKit.queryQuantitySamples as any)(
        HKQuantityTypeIdentifier.bodyMass,
        { limit: 1, ascending: false, unit: 'kg' }
      ),
      [] as any[]
    );
    if (samples.length > 0) {
      const kg = Math.round(samples[0].quantity);
      if (kg >= 30 && kg <= 250) {
        await saveBodyMassKg(kg);
        return kg;
      }
    }
  } catch {
    // HealthKit unavailable or no body mass data
  }
  return DEFAULT_BODY_MASS_KG;
}

// ─── Sleep parsing ────────────────────────────────────────────────────────────

function groupIntoSessions(
  rawSamples: { startDate: string | Date | any; endDate: string | Date | any; value: number }[]
): SleepSession[] {
  if (rawSamples.length === 0) return [];

  // Normalise to ISO strings so downstream code never has to deal with Date objects
  const normalised = rawSamples.map((s) => ({
    startDate: toISOStr(s.startDate),
    endDate:   toISOStr(s.endDate),
    value:     s.value as number,
  }));

  const sorted = [...normalised].sort(
    (a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime()
  );

  const sessions: SleepSession[] = [];
  let current: typeof sorted = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const gap = minutesBetween(current[current.length - 1].endDate, sorted[i].startDate);
    if (gap > 180) {
      sessions.push(buildSession(current));
      current = [sorted[i]];
    } else {
      current.push(sorted[i]);
    }
  }
  sessions.push(buildSession(current));

  return sessions.filter((s) => s.totalMinutes >= 30);
}

function buildSession(
  samples: { startDate: string | Date | any; endDate: string | Date | any; value: number }[]
): SleepSession {
  const segments: SleepSegment[] = samples.map((s) => {
    const stage = SLEEP_VALUE_TO_LABEL[s.value] ?? 'asleepUnspecified';
    const start = toISOStr(s.startDate);
    const end   = toISOStr(s.endDate);
    return {
      startDate: start,
      endDate: end,
      stage,
      durationMinutes: minutesBetween(start, end),
    };
  });

  const totals = { asleepCore: 0, asleepDeep: 0, asleepREM: 0, awake: 0 };
  segments.forEach((seg) => {
    if (seg.stage === 'asleepCore' || seg.stage === 'asleepUnspecified') {
      totals.asleepCore += seg.durationMinutes;
    } else if (seg.stage === 'asleepDeep') {
      totals.asleepDeep += seg.durationMinutes;
    } else if (seg.stage === 'asleepREM') {
      totals.asleepREM += seg.durationMinutes;
    } else if (seg.stage === 'awake') {
      totals.awake += seg.durationMinutes;
    }
  });

  const sleepMinutes = totals.asleepCore + totals.asleepDeep + totals.asleepREM;
  const bedtime  = toISOStr(samples[0].startDate);
  const wakeTime = toISOStr(samples[samples.length - 1].endDate);

  return {
    date: toDateStr(wakeTime),
    bedtime,
    wakeTime,
    totalMinutes: Math.round(sleepMinutes),
    deepMinutes:  Math.round(totals.asleepDeep),
    remMinutes:   Math.round(totals.asleepREM),
    coreMinutes:  Math.round(totals.asleepCore),
    awakeMinutes: Math.round(totals.awake),
    segments,
  };
}

// ─── HRV quality filtering via heartbeat series ───────────────────────────────

/**
 * Build a lookup map: heartbeat-series-startDate (ms) → isGoodQuality.
 *
 * A 1-minute HRV window is "bad" when the Apple Watch lost contact mid-reading
 * (motion, tossing) — visible as a gap in the heart-rate chart within that minute.
 * HealthKit exposes this via `HKHeartbeatSeriesSample` where each beat has
 * `precededByGap: boolean`.  The FIRST beat is always preceded by a gap (no
 * prior measurement), so we only look at beats after index 0.
 */
function buildHeartbeatQualityMap(
  heartbeatSeries: readonly { startDate: Date | string; heartbeats: readonly { precededByGap: boolean }[] }[]
): Map<number, boolean> {
  const map = new Map<number, boolean>();
  for (const s of heartbeatSeries) {
    const ms = new Date(s.startDate as any).getTime();
    const internalGaps = s.heartbeats.slice(1).filter((b) => b.precededByGap).length;
    map.set(ms, internalGaps === 0);
  }
  return map;
}

/**
 * Is the HRV sample at `sampleStartMs` considered good quality?
 * Looks for the nearest heartbeat series within 10 s tolerance.
 * Returns true (include) if no matching series is found (can't assess).
 */
function isGoodHRVSample(sampleStartMs: number, qualityMap: Map<number, boolean>): boolean {
  const TOLERANCE = 10_000; // ms
  for (const [seriesMs, good] of qualityMap) {
    if (Math.abs(seriesMs - sampleStartMs) < TOLERANCE) return good;
  }
  return true; // no matching series → don't exclude
}

// ─── HRV average ──────────────────────────────────────────────────────────────

function computeWeightedRMSSD(
  session: SleepSession,
  hrvSamples: { startDate: string; quantity: number }[],
  qualityMap?: Map<number, boolean>,
): { weightedRMSSD: number; annotatedSamples: NightlyHRV['samples']; excluded: number; total: number } {
  if (hrvSamples.length === 0) return { weightedRMSSD: 0, annotatedSamples: [], excluded: 0, total: 0 };

  // Primary window: bedtime ±90 min → wakeTime +60 min
  // (Apple Watch sometimes records HRV slightly before/after the strict sleep window)
  const PRIMARY_BEFORE = 90 * 60 * 1000;
  const PRIMARY_AFTER  = 60 * 60 * 1000;
  const sessionStart = new Date(session.bedtime).getTime() - PRIMARY_BEFORE;
  const sessionEnd   = new Date(session.wakeTime).getTime() + PRIMARY_AFTER;

  let nightSamples = hrvSamples.filter((s) => {
    const t = new Date(s.startDate).getTime();
    if (t < sessionStart || t > sessionEnd) return false;
    // Quality filter: exclude readings where the 1-min window had mid-reading gaps
    if (qualityMap && qualityMap.size > 0 && !isGoodHRVSample(t, qualityMap)) return false;
    return true;
  });

  // Fallback: if no samples in primary window, try the entire "night" period
  // (noon before bedtime → noon after wakeTime)
  if (nightSamples.length === 0) {
    const bedMs  = new Date(session.bedtime).getTime();
    const wakeMs = new Date(session.wakeTime).getTime();
    const nightStart = bedMs - 6 * 60 * 60 * 1000;  // up to 6h before bed
    const nightEnd   = wakeMs + 3 * 60 * 60 * 1000; // up to 3h after wake
    nightSamples = hrvSamples.filter((s) => {
      const t = new Date(s.startDate).getTime();
      if (t < nightStart || t > nightEnd) return false;
      if (qualityMap && qualityMap.size > 0 && !isGoodHRVSample(t, qualityMap)) return false;
      return true;
    });
  }

  if (nightSamples.length === 0) {
    return { weightedRMSSD: 0, annotatedSamples: [], excluded: 0, total: 0 };
  }

  const annotatedSamples: NightlyHRV['samples'] = nightSamples.map((s) => {
    const sampleTime = new Date(s.startDate).getTime();
    const seg = session.segments.find((sg) => {
      const start = new Date(sg.startDate).getTime();
      const end = new Date(sg.endDate).getTime();
      return sampleTime >= start && sampleTime <= end;
    });
    const stage: SleepStageLabel = seg?.stage ?? 'asleepUnspecified';
    return { timestamp: s.startDate, rmssd: Math.round(s.quantity), stage };
  });

  // ── Match Bevel's algorithm ────────────────────────────────────────────────
  // 1. Exclude awake / inBed samples (Bevel explicitly excludes these)
  // 2. IQR-based outlier removal (approximates Bevel's ectopic-beat / signal-
  //    quality filtering — removes massive spikes caused by non-normal beats)
  // 3. Simple unweighted mean (Bevel: "takes all RMSSD samples and calculates a mean")

  const sleepSamples = annotatedSamples.filter(
    ({ stage }) => stage !== 'awake' && stage !== 'inBed'
  );
  const rawVals = (sleepSamples.length > 0 ? sleepSamples : annotatedSamples)
    .map((s) => s.rmssd);

  // IQR filter: keep samples within [Q1 − 2·IQR, Q3 + 2·IQR]
  // Factor 2 is intentionally gentle — only removes genuine artifact spikes.
  const sorted = [...rawVals].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  const cleanVals = iqr > 0
    ? rawVals.filter((v) => v >= q1 - 2 * iqr && v <= q3 + 2 * iqr)
    : rawVals;
  const useVals = cleanVals.length >= 3 ? cleanVals : rawVals;

  const weightedRMSSD = Math.round(
    (useVals.reduce((a, b) => a + b, 0) / useVals.length) * 10
  ) / 10;

  // Count how many samples were excluded by quality map (for diagnostics)
  const totalInWindow = hrvSamples.filter((s) => {
    const t = new Date(s.startDate).getTime();
    return t >= new Date(session.bedtime).getTime() - 90 * 60_000 &&
           t <= new Date(session.wakeTime).getTime() + 60 * 60_000;
  }).length;
  const excluded = qualityMap && qualityMap.size > 0
    ? Math.max(0, totalInWindow - nightSamples.length)
    : 0;

  return { weightedRMSSD, annotatedSamples, excluded, total: totalInWindow };
}

// ─── Overnight resting HR ─────────────────────────────────────────────────────

function computeOvernightHR(
  session: SleepSession,
  hrSamples: { startDate: string; quantity: number }[]
): number {
  // Bevel uses Deep + REM + Core (all non-Awake stages), then removes outlier spikes
  // caused by movement, tossing/turning. The primary filter is the sleep stage itself
  // (exclude Awake & InBed); a secondary percentile filter removes the top ~15% of
  // samples which represent brief movement artefacts within each stage.
  const sleepSegments = session.segments.filter(
    (seg) => seg.stage !== 'awake' && seg.stage !== 'inBed'
  );

  const sleepHRValues: number[] = [];
  hrSamples.forEach((s) => {
    const t = new Date(s.startDate).getTime();
    const inSeg = sleepSegments.some((seg) => {
      const segStart = new Date(seg.startDate).getTime();
      const segEnd   = new Date(seg.endDate).getTime();
      return t >= segStart && t <= segEnd;
    });
    if (inSeg) sleepHRValues.push(s.quantity);
  });

  if (sleepHRValues.length === 0) return 0;
  return Math.round(sleepHRValues.reduce((a, b) => a + b, 0) / sleepHRValues.length);
}

// ─── Sleep score ─────────────────────────────────────────────────────────────

const DEFAULT_SLEEP_GOAL_MINUTES = 480; // 8 hours

function computeSleepScore(
  session: SleepSession,
  overnightHR: number,
  daytimeHR: number,
): number {
  // 1. Time asleep score (40%): how close to 8h goal
  const goalRatio = Math.min(1.2, session.totalMinutes / DEFAULT_SLEEP_GOAL_MINUTES);
  const timeScore =
    goalRatio >= 1.0 ? 100
    : goalRatio >= 0.85 ? 70 + (goalRatio - 0.85) / 0.15 * 30
    : goalRatio >= 0.60 ? 30 + (goalRatio - 0.60) / 0.25 * 40
    : goalRatio * 50;

  // 2. Sleep stages score (25%): deep+REM fraction of total sleep
  const deepRemFrac = session.totalMinutes > 0
    ? (session.deepMinutes + session.remMinutes) / session.totalMinutes
    : 0;
  const stagesScore =
    deepRemFrac >= 0.40 ? 100
    : deepRemFrac >= 0.25 ? 60 + (deepRemFrac - 0.25) / 0.15 * 40
    : deepRemFrac >= 0.10 ? 20 + (deepRemFrac - 0.10) / 0.15 * 40
    : deepRemFrac * 200;

  // 3. Sleep efficiency (15%): time asleep / (asleep + awake in bed)
  const totalInBed = session.totalMinutes + session.awakeMinutes;
  const efficiency = totalInBed > 0 ? session.totalMinutes / totalInBed : 1;
  const effScore = Math.min(100, efficiency * 110);

  // 4. HR dip score (10%): overnight HR vs daytime HR
  let hrDipScore = 50;
  if (overnightHR > 0 && daytimeHR > 0) {
    const dip = (daytimeHR - overnightHR) / daytimeHR;
    hrDipScore =
      dip >= 0.25 ? 100
      : dip >= 0.15 ? 70 + (dip - 0.15) / 0.10 * 30
      : dip >= 0.05 ? 20 + (dip - 0.05) / 0.10 * 50
      : Math.max(0, dip * 400);
  }

  // 5. Sleep continuity (10%): less awake time = better
  const awakeFrac = totalInBed > 0 ? session.awakeMinutes / totalInBed : 0;
  const continuityScore =
    awakeFrac <= 0.05 ? 100
    : awakeFrac <= 0.15 ? 100 - (awakeFrac - 0.05) / 0.10 * 50
    : Math.max(0, 50 - (awakeFrac - 0.15) * 300);

  const raw =
    timeScore       * 0.40 +
    stagesScore     * 0.25 +
    effScore        * 0.15 +
    hrDipScore      * 0.10 +
    continuityScore * 0.10;

  return Math.round(Math.min(100, Math.max(0, raw)));
}

// ─── Recovery score ───────────────────────────────────────────────────────────

/**
 * Absolute HRV score based on population norms for Apple Watch overnight RMSSD.
 * Calibrated so RMSSD=43 ms → ~79, which combined with RHR=58 gives ~75 overall —
 * matching what apps like Bevel report for these healthy values.
 */
function absoluteHRVScore(rmssd: number): number {
  return Math.min(98, Math.max(5, 38 + rmssd * 0.95));
}

/**
 * Absolute overnight-HR score: lower HR = better recovery.
 * RHR 58 bpm → ~68; 50 bpm → ~85; 70 bpm → ~43.
 */
function absoluteRHRScore(hr: number): number {
  return Math.min(95, Math.max(5, 190 - hr * 2.1));
}

function computeRecoveryScore(
  todayRMSSD: number,
  todayOvernightHR: number,
  history: NightlyHRV[]
): { score: number; baseline: number; trend: DailyRecovery['trend']; overnightHRBaseline: number } {
  const recent = history.slice(-30).filter((n) => n.weightedRMSSD > 0);

  // ── HRV component ──────────────────────────────────────────────────────────
  // We blend absolute-population score with z-score vs personal baseline.
  // • Day 0:  100 % absolute → healthy RMSSD immediately gives a fair score.
  // • Day 7+:  60 % absolute + 40 % z-score → personal trend matters more.
  const absHRV = absoluteHRVScore(todayRMSSD);

  let mean   = todayRMSSD;
  let stddev = 1;
  let zHRV   = absHRV; // default to absolute when no history

  if (recent.length >= 2) {
    const values = recent.map((n) => n.weightedRMSSD);
    mean   = values.reduce((a, b) => a + b, 0) / values.length;
    stddev = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length) || 1;
    const z = (todayRMSSD - mean) / stddev;
    zHRV    = Math.min(100, Math.max(0, 50 + z * 25));
  }

  const hrvBlend   = Math.min(1, recent.length / 7); // 0 → 1 over first 7 days
  const blendedHRV = (1 - 0.4 * hrvBlend) * absHRV + 0.4 * hrvBlend * zHRV;

  // ── Overnight-HR component ─────────────────────────────────────────────────
  const recentWithHR = recent.filter((n) => n.overnightHR > 0);
  let overnightHRBaseline = todayOvernightHR;
  let blendedRHR = todayOvernightHR > 0 ? absoluteRHRScore(todayOvernightHR) : 50;

  if (recentWithHR.length >= 3 && todayOvernightHR > 0) {
    const hrValues = recentWithHR.map((n) => n.overnightHR);
    const hrMean   = hrValues.reduce((a, b) => a + b, 0) / hrValues.length;
    const hrStddev = Math.sqrt(hrValues.reduce((a, b) => a + (b - hrMean) ** 2, 0) / hrValues.length) || 1;
    overnightHRBaseline = Math.round(hrMean);
    const hrZ      = (todayOvernightHR - hrMean) / hrStddev;
    const zRHR     = Math.min(100, Math.max(0, 50 - hrZ * 25));
    const hrBlend  = Math.min(1, recentWithHR.length / 7);
    blendedRHR = (1 - 0.4 * hrBlend) * absoluteRHRScore(todayOvernightHR) + 0.4 * hrBlend * zRHR;
  }

  // ── Final score ────────────────────────────────────────────────────────────
  const useRHR = todayOvernightHR > 0;
  const rawScore = useRHR ? 0.65 * blendedHRV + 0.35 * blendedRHR : blendedHRV;
  const score    = Math.round(rawScore);

  // ── Trend (vs 7-day rolling average) ──────────────────────────────────────
  const last7 = recent.slice(-7);
  const avg7  = last7.length > 0
    ? last7.reduce((a, b) => a + b.weightedRMSSD, 0) / last7.length
    : todayRMSSD;
  const delta = todayRMSSD - avg7;
  const trend: DailyRecovery['trend'] =
    delta > stddev * 0.3 ? 'rising' : delta < -stddev * 0.3 ? 'falling' : 'stable';

  return { score, baseline: Math.round(mean * 10) / 10, trend, overnightHRBaseline };
}

function scoreToLabel(score: number): DailyRecovery['label'] {
  if (score >= 75) return 'optimal';
  if (score >= 55) return 'good';
  if (score >= 35) return 'moderate';
  return 'poor';
}

function scoreToColor(score: number): string {
  if (score >= 75) return '#27ae60';   // green
  if (score >= 55) return '#2ecc71';   // lighter green
  if (score >= 35) return '#f39c12';   // amber
  return '#e74c3c';                    // red
}

// ─── Per-workout data fetcher ─────────────────────────────────────────────────

/**
 * Fetch raw HR, distance and running-power samples for a single workout.
 * Each query is isolated — failures return empty arrays (never crash the app).
 */
async function fetchWorkoutSamples(w: {
  startDate: string | Date | any;
  endDate:   string | Date | any;
}): Promise<{ hr: any[]; dist: any[]; power: any[] }> {
  // Add a 30-second buffer either side so boundary samples aren't missed.
  // new Date(Date) and new Date(isoString) both work fine.
  const from = new Date(new Date(w.startDate).getTime() - 30_000);
  const to   = new Date(new Date(w.endDate).getTime()   + 30_000);

  // Use filter: { startDate, endDate } per the v9 API spec.
  // from/to are JS Date objects which NitroModules correctly converts via .getTime().
  const [hr, dist, power] = await Promise.all([
    safeQuery(
      () => (HealthKit.queryQuantitySamples as any)(
        HKQuantityTypeIdentifier.heartRate,
        { filter: { startDate: from, endDate: to }, unit: 'count/min', ascending: true, limit: 2000 }
      ),
      []
    ),
    safeQuery(
      () => (HealthKit.queryQuantitySamples as any)(
        HKQuantityTypeIdentifier.distanceWalkingRunning,
        { filter: { startDate: from, endDate: to }, unit: 'm', ascending: true, limit: 500 }
      ),
      []
    ),
    safeQuery(
      () => (HealthKit.queryQuantitySamples as any)(
        HKQuantityTypeIdentifier.runningPower,
        { filter: { startDate: from, endDate: to }, unit: 'W', ascending: true, limit: 1000 }
      ),
      []
    ),
  ]);

  return { hr, dist, power };
}

function toPerRunData(hr: any[], dist: any[], power: any[]): PerRunData {
  return {
    hrValues:       hr.map((s: any) => s.quantity as number),
    hrTimestampsMs: hr.map((s: any) => new Date(s.startDate).getTime()),
    distSegs:       dist.map((s: any) => ({ t: new Date(s.startDate).getTime(), m: s.quantity as number })),
    powerSegs:      power.map((s: any) => ({ t: new Date(s.startDate).getTime(), w: s.quantity as number })),
  };
}

function computeKmSplits(
  distSegs:       { t: number; m: number }[],
  hrValues:       number[],
  hrTimestampsMs: number[],
  powerSegs:      { t: number; w: number }[],
  maxDistM:       number = 0,
): KmSplit[] {
  if (distSegs.length === 0) return [];
  // Filter out zero-distance entries to avoid ghost km splits
  let acc = 0;
  const cum: { t: number; cumM: number }[] = [];
  for (const { t, m } of distSegs) {
    if (m > 0) { acc += m; cum.push({ t, cumM: acc }); }
  }
  if (acc < 1000 || cum.length === 0) return [];
  const hasHR  = hrTimestampsMs.length === hrValues.length && hrValues.length > 0;
  const hasPow = powerSegs.length > 0;
  const splits: KmSplit[] = [];
  let prevT = cum[0].t;
  // Cap to workout total distance to prevent double-counting ghost splits
  const capM = maxDistM > 100 ? Math.min(acc, maxDistM) : acc;
  const nKm  = Math.floor(capM / 1000);
  for (let km = 1; km <= nKm; km++) {
    const idx = cum.findIndex(c => c.cumM >= km * 1000);
    if (idx < 0) break;
    const endT       = cum[idx].t;
    const wallSec    = Math.max(1, (endT - prevT) / 1000);
    const paceSecs   = Math.round(wallSec);
    let avgHR = 0;
    if (hasHR) {
      const hs = hrValues.filter((_, i) => hrTimestampsMs[i] >= prevT && hrTimestampsMs[i] <= endT);
      if (hs.length > 0) avgHR = Math.round(hs.reduce((a, b) => a + b, 0) / hs.length);
    }
    let avgPower = 0;
    if (hasPow) {
      const ps = powerSegs.filter(p => p.t >= prevT && p.t <= endT).map(p => p.w);
      if (ps.length > 0) avgPower = Math.round(ps.reduce((a, b) => a + b, 0) / ps.length);
    }
    splits.push({ km, durationSec: Math.round(wallSec), paceSecs, avgHR, avgCadence: 0, avgPower });
    prevT = endT;
  }
  return splits;
}

function refineWorkStatsFromSegments(segs: WorkoutSegment[]): {
  wHR: number; wPace: number; wPower: number; wDistance: number; wDuration: number;
} | null {
  const w = segs.filter(s => s.label === 'Work');
  if (w.length === 0) return null;
  const totalDur  = w.reduce((a, s) => a + s.durationSec, 0);
  const totalDist = w.reduce((a, s) => a + s.distanceM, 0);
  if (totalDur === 0 || totalDist < 100) return null;
  const withHR  = w.filter(s => s.avgHR > 0);
  const withPwr = w.filter(s => s.avgPower > 0);
  return {
    wHR:       withHR.length  > 0 ? Math.round(withHR.reduce( (a, s) => a + s.avgHR    * s.durationSec, 0) / withHR.reduce( (a, s) => a + s.durationSec, 0)) : 0,
    wPace:     Math.round(totalDur / (totalDist / 1000)),
    wPower:    withPwr.length > 0 ? Math.round(withPwr.reduce((a, s) => a + s.avgPower * s.durationSec, 0) / withPwr.reduce((a, s) => a + s.durationSec, 0)) : 0,
    wDistance: totalDist,
    wDuration: totalDur,
  };
}

/**
 * Read a key from a HealthKit metadata value, which the nitro bridge may expose
 * as a plain object OR a Map-like object (.get). Handles both.
 */
function metaGet(m: any, key: string): any {
  if (m == null) return undefined;
  if (typeof m.get === 'function') { try { const v = m.get(key); if (v !== undefined) return v; } catch {} }
  return m[key];
}

/**
 * Read the weather temperature (°C) Apple Watch records in a workout's metadata
 * (HKWeatherTemperature). Returns undefined when absent (e.g. indoor runs).
 * Converts Fahrenheit → Celsius when the unit string indicates °F.
 */
function extractWeatherTempC(w: any): number | undefined {
  const t = metaGet(w?.metadata, 'HKWeatherTemperature');
  if (t == null) return undefined;
  let value: number;
  let unit = '';
  if (typeof t === 'object') {
    value = Number(t.quantity ?? metaGet(t, 'quantity'));
    unit  = String(t.unit ?? metaGet(t, 'unit') ?? '');
  } else {
    value = Number(t);
  }
  if (!isFinite(value)) return undefined;
  if (/f/i.test(unit) && !/c/i.test(unit)) value = (value - 32) * 5 / 9; // °F → °C
  if (value < -60 || value > 60) return undefined; // sanity clamp
  return Math.round(value);
}

// ─── Activity (all-workout) mapping for training load ─────────────────────────

/** Parse the HK duration field (object {quantity} or number) to seconds. */
function workoutDurationSec(w: any): number {
  return typeof w.duration === 'object' && w.duration !== null
    ? (w.duration.quantity as number) ?? 0
    : (w.duration as number) ?? 0;
}

/**
 * Map ALL raw HKWorkout samples (any activity type) to ActivitySummary[].
 * `runHrByUuid` lets us attach work-HR for runs we've already classified.
 */
function mapWorkoutsToActivities(
  rawWorkouts: any[],
  runHrByUuid?: Map<string, number>,
): ActivitySummary[] {
  return rawWorkouts.map((w: any) => {
    const durSec = workoutDurationSec(w);
    const type   = w.workoutActivityType as number;
    return {
      uuid:         w.uuid,
      date:         toISOStr(w.startDate),
      activityType: type,
      name:         activityName(type),
      durationMin:  Math.round((durSec / 60) * 10) / 10,
      kcal:         Math.round((w.totalEnergyBurned?.quantity ?? 0) as number),
      distanceKm:   Math.round(((w.totalDistance?.quantity ?? 0) as number) / 1000 * 100) / 100,
      avgHR:        runHrByUuid?.get(w.uuid) ?? 0,
    } as ActivitySummary;
  }).filter(a => a.durationMin > 0);
}

// ─── Main fetch ───────────────────────────────────────────────────────────────

export interface FetchOptions {
  /** How many months of history to load (1 | 3 | 6 | 12, default 3) */
  months?: number;
  /** Called with a human-readable step name and 0-100 progress percentage */
  onProgress?: (step: string, pct: number) => void;
}

export async function fetchHealthSnapshot(opts: FetchOptions = {}): Promise<HealthSnapshot> {
  const months = Math.max(1, Math.min(24, opts.months ?? 3));
  const progress = (step: string, pct: number) => opts.onProgress?.(step, Math.round(pct));

  const now          = new Date();
  const sinceDate    = daysAgo(months * 30);
  const thirtyDaysAgo  = daysAgo(30);
  const twoWeeksAgo    = daysAgo(14);
  const eightWeeksAgo  = daysAgo(56);

  // ── Step 1: Load cache + workout list in parallel ─────────────────────────
  progress('Loading workouts…', 5);
  const [existingCache, allWorkouts] = await Promise.all([
    loadWorkoutCache(),
    // Use filter: { startDate, endDate } so HealthKit returns only workouts in the
    // requested time window. Without this, users with 500+ total workouts would only
    // get the oldest 500 (or newest 500 depending on sort), missing recent ones.
    (HealthKit.queryWorkoutSamples as any)({
      filter: { startDate: sinceDate, endDate: now },
      limit: 500,
      ascending: false,
      energyUnit: 'kcal',   // HKUnit string — "kilocalorie" crashes on iOS 26
      distanceUnit: 'm',    // HKUnit string — "meter" is invalid; use "m"
    }).catch((e: any) => { throw new Error(`queryWorkoutSamples failed: ${e?.message ?? e}`); }),
  ]);

  // workoutActivityType is a numeric HealthKit constant (running = 37).
  // We also filter by date in JS to honour the user's chosen months range.
  const sinceDateMs = sinceDate.getTime();
  const runWorkouts: any[] = (allWorkouts as any[])
    .filter((w: any) =>
      w.workoutActivityType === HK_WORKOUT_RUNNING &&
      new Date(w.startDate).getTime() >= sinceDateMs
    )
    .slice(0, 500);

  // HK weather temperature (°C) per run, from workout metadata
  const hkTempByUuid = new Map<string, number | undefined>(
    runWorkouts.map((w: any) => [w.uuid, extractWeatherTempC(w)])
  );

  progress(`Found ${runWorkouts.length} runs — checking cache…`, 12);

  // ── Step 2: Identify which workouts need fresh data ───────────────────────
  const cachedAnalyses = existingCache?.analyses ?? {};
  const uncached = runWorkouts.filter((w: any) => !cachedAnalyses[w.uuid]);

  // Pre-populate perRunData for cached runs (classifier will use cache, not raw data)
  const perRunData = new Map<string, PerRunData>();
  runWorkouts.forEach((w: any) => {
    if (cachedAnalyses[w.uuid]) {
      perRunData.set(w.uuid, { hrValues: [], hrTimestampsMs: [], distSegs: [], powerSegs: [] });
    }
  });

  // ── Step 3: Fetch raw samples for uncached workouts (batched, 4 at a time) ──
  let allNewHRValues: number[] = [];
  const BATCH = 4;

  if (uncached.length > 0) {
    for (let i = 0; i < uncached.length; i += BATCH) {
      const batch = uncached.slice(i, i + BATCH);
      const done  = Math.min(i + BATCH, uncached.length);
      progress(
        `Syncing run ${done} of ${uncached.length}…`,
        12 + (done / uncached.length) * 48,
      );

      const results = await Promise.all(batch.map(fetchWorkoutSamples));

      results.forEach(({ hr, dist, power }, idx) => {
        const w = batch[idx];
        const data = toPerRunData(hr, dist, power);
        perRunData.set(w.uuid, data);
        allNewHRValues = allNewHRValues.concat(data.hrValues);
      });
    }
  }

  progress('Processing run data…', 62);

  // ── Step 4: Build rawRuns ─────────────────────────────────────────────────
  const rawRuns: RunWorkout[] = runWorkouts.map((w: any) => {
    const data = perRunData.get(w.uuid);
    const hrValues = data?.hrValues ?? [];

    // Prefer fresh HR avg; fall back to cached avg HR from previous sync
    const avgHR =
      hrValues.length > 0
        ? Math.round(hrValues.reduce((a, b) => a + b, 0) / hrValues.length)
        : (cachedAnalyses[w.uuid]?.avgHR ?? undefined);

    const distanceM = (w.totalDistance?.quantity ?? 0) as number;
    const durationS: number =
      typeof w.duration === 'object' && w.duration !== null
        ? (w.duration.quantity as number) ?? 0
        : (w.duration as number) ?? 0;

    // Parse structured workout segments from the raw HK activities already in w.activities.
    // These carry phase labels + per-segment KPIs via the WorkoutProxy.swift UUID suffix patch.
    const rawActs: any[] = w.activities ?? [];
    const wStartMs = new Date(toISOStr(w.startDate)).getTime();
    const segments: WorkoutSegment[] = rawActs
      .map((act: any) => {
        const uuidStr: string = act.uuid ?? '';
        const firstSep = uuidStr.indexOf('::');
        let title = '', stepName = '', stepType = -1, stepPath = '';
        let distanceM = 0, avgHR = 0, avgPower = 0, steps = 0, stepActType = -1;
        if (firstSep >= 0) {
          const rest     = uuidStr.slice(firstSep + 2);
          const metaSep  = rest.indexOf('::meta::');
          const statSep  = rest.indexOf('::stat::');
          if (metaSep >= 0) {
            const end     = statSep >= 0 && statSep > metaSep ? statSep : rest.length;
            const metaStr = rest.slice(metaSep + 8, end);
            for (const pair of metaStr.split('|')) {
              const eq = pair.indexOf('=');
              if (eq < 0) continue;
              const k = pair.slice(0, eq), v = pair.slice(eq + 1);
              if (k === 'title')                title    = v;
              if (k === 'WorkoutStepName')      stepName = v;
              if (k === 'WorkoutStepType')      stepType = parseInt(v, 10);
              if (k === 'WOIntervalStepKeyPath') stepPath = v;
            }
          }
          if (statSep >= 0) {
            for (const pair of rest.slice(statSep + 8).split(';')) {
              const eq = pair.indexOf('=');
              if (eq < 0) continue;
              const k = pair.slice(0, eq), v = parseFloat(pair.slice(eq + 1));
              if (k === 'dist')    distanceM   = v;
              if (k === 'hr')      avgHR       = v;
              if (k === 'power')   avgPower    = v;
              if (k === 'steps')   steps       = v;
              if (k === 'stepAct') stepActType = v;
            }
          }
        }
        if (distanceM === 0) return null; // skip activities with no data
        // stepActType from workoutConfiguration helps identify Walk/Warmup/Cooldown phases
        let label = title || stepName
          || (['Warmup','Work','Recovery','Cooldown'][stepType] ?? '')
          || (stepActType === HK_COOLDOWN ? 'Cooldown'
              : HK_PREP_REC_SET.has(stepActType) ? 'Warmup'
              : stepActType === HK_WALKING ? 'Walk'
              : stepPath ? `__step:${stepPath.split('.')[0]}` : '');
        const aStart = new Date(toISOStr(act.startDate)).getTime();
        const aEnd   = act.endDate ? new Date(toISOStr(act.endDate)).getTime() : aStart;
        // Use HK net duration (excludes pauses) when available; fall back to wall-clock span
        const durationSec = (act as any).duration > 0
          ? (act as any).duration
          : Math.max(0, (aEnd - aStart) / 1000);
        if (durationSec < 5) return null;
        const cadenceSPM = steps > 0 && durationSec > 0 ? Math.round(steps / (durationSec / 60)) : 0;
        return { label, durationSec: Math.round(durationSec), distanceM: Math.round(distanceM), avgHR: Math.round(avgHR), avgPower: Math.round(avgPower), cadenceSPM } as WorkoutSegment;
      })
      .filter((s): s is WorkoutSegment => s !== null);

    // Resolve any deferred __step: labels using distance heuristic.
    // For structured workouts: Warmup(short) + Work×N + Cooldown(short).
    const hasDeferred = segments.some(s => s.label.startsWith('__step:') || s.label === '');
    if (hasDeferred && segments.length >= 2) {
      const dists = segments.map(s => s.distanceM);
      const validDists = dists.filter(d => d > 0);
      if (validDists.length === segments.length) {
        const sorted = [...validDists].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const threshold = median * 0.65;
        segments.forEach((s, i) => {
          if (!s.label.startsWith('__step:') && s.label !== '') return;
          if (i === 0 && s.distanceM < threshold)                         s.label = 'Warmup';
          else if (i === segments.length - 1 && s.distanceM < threshold)  s.label = 'Cooldown';
          else                                                             s.label = 'Work';
        });
      } else {
        segments.forEach(s => { if (s.label.startsWith('__step:') || s.label === '') s.label = 'Work'; });
      }
    }
    // Legacy: all-unlabeled case
    const allUnlabeled = segments.every(s => !s.label);
    if (allUnlabeled && segments.length >= 3) {
      const dists = segments.map(s => s.distanceM).filter(d => d > 0);
      const sorted = [...dists].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const threshold = median * 0.65; // segment is "short" if < 65% of median
      segments.forEach((s, i) => {
        if (i === 0 && s.distanceM < threshold)                       s.label = 'Warmup';
        else if (i === segments.length - 1 && s.distanceM < threshold) s.label = 'Cooldown';
        else                                                            s.label = 'Work';
      });
    } else {
      // Fill any remaining empty labels as Work
      segments.forEach(s => { if (!s.label) s.label = 'Work'; });
    }

    // ── Intensity-based warmup/cooldown rescue ────────────────────────────────
    // The distance heuristic mislabels a warmup as "Work" when the warmup isn't
    // short (e.g. a full easy km before the first rep). Catch it by intensity:
    // the first/last segment is a warmup/cooldown if it's clearly EASIER than the
    // median Work segment (lower HR, lower power, or slower pace). Conservative —
    // only acts on the edge segments and only when there are ≥2 other Work reps.
    if (segments.length >= 3) {
      const work = segments.filter(s => s.label === 'Work');
      if (work.length >= 3) {
        const med = (arr: number[]) => {
          const v = arr.filter(x => x > 0).sort((a, b) => a - b);
          return v.length ? v[Math.floor(v.length / 2)] : 0;
        };
        const medHR    = med(work.map(s => s.avgHR));
        const medPower = med(work.map(s => s.avgPower));
        const medPace  = med(work.map(s => (s.distanceM > 0 ? s.durationSec / (s.distanceM / 1000) : 0)));
        const isEasier = (s: WorkoutSegment): boolean => {
          if (medHR > 0    && s.avgHR > 0)    return s.avgHR    < medHR - 8;          // ≥8 bpm easier
          if (medPower > 0 && s.avgPower > 0) return s.avgPower < medPower * 0.85;     // ≥15% less power
          const pace = s.distanceM > 0 ? s.durationSec / (s.distanceM / 1000) : 0;
          if (medPace > 0 && pace > 0)        return pace > medPace * 1.12;            // ≥12% slower
          return false;
        };
        const first = segments[0], last = segments[segments.length - 1];
        if (first.label === 'Work' && isEasier(first)) first.label = 'Warmup';
        if (last.label  === 'Work' && isEasier(last))  last.label  = 'Cooldown';
      }
    }

    return {
      uuid:          w.uuid,
      date:          toISOStr(w.startDate),
      duration:      durationS,
      distance:      distanceM,
      calories:      (w.totalEnergyBurned?.quantity ?? 0) as number,
      avgHeartRate:  avgHR,
      pace:          distanceM > 0 ? durationS / (distanceM / METERS_PER_KM) : 0,
      ...(segments.length > 0 && { segments }),
    };
  });

  // ── Step 5: Wellness data + workout classification (parallel) ─────────────
  progress('Fetching wellness data…', 65);

  const [
    vo2maxSamples,
    allHRVSamples,
    allHeartbeatSeries,
    restingHRSamples,
    rawSleepSamples,
    bodyMassKg,
    powerZones,
    runOverrides,
    longRunMinutes,
    events,
    hrUnreliableMap,
    loadWorkoutsRaw,
    runMetaMap,
    dailyKcalMap,
  ] = await Promise.all([
    // v9 API: date range in filter.startDate/endDate
    safeQuery(
      () => (HealthKit.queryQuantitySamples as any)(
        HKQuantityTypeIdentifier.vo2Max,
        { filter: { startDate: eightWeeksAgo, endDate: now }, unit: 'mL/kg·min', ascending: true, limit: 60 }
      ),
      []
    ),
    // HRV: Apple Watch records ~1 sample/min during sleep → ~480/night.
    // 30 nights ≈ 14 400 samples.  Use ascending:false (newest first) so
    // the limit always captures the most recent nights rather than the oldest.
    (HealthKit.queryQuantitySamples as any)(
      HKQuantityTypeIdentifier.heartRateVariabilitySDNN,
      { filter: { startDate: thirtyDaysAgo, endDate: now }, unit: 'ms', ascending: false, limit: 20000 }
    ).catch(() => [] as any[]),
    // Heartbeat series: raw R-R intervals for quality filtering (precededByGap flag)
    safeQuery(
      () => (HealthKit as any).queryHeartbeatSeriesSamples({
        filter: { startDate: thirtyDaysAgo, endDate: now },
        limit: 20000,
      }),
      [] as any[]
    ),
    safeQuery(
      () => (HealthKit.queryQuantitySamples as any)(
        HKQuantityTypeIdentifier.restingHeartRate,
        { filter: { startDate: twoWeeksAgo, endDate: now }, unit: 'count/min', ascending: true, limit: 30 }
      ),
      []
    ),
    safeQuery(
      () => (HealthKit.queryCategorySamples as any)(
        HKCategoryTypeIdentifier.sleepAnalysis,
        { filter: { startDate: thirtyDaysAgo, endDate: now }, ascending: true, limit: 2000 }
      ),
      []
    ),
    resolveBodyMassKg(),
    getPowerZones(),
    getRunOverrides(),
    getLongRunMinutes(),
    loadEvents(),
    getHrUnreliableRuns(),
    // All workouts (ANY type) for the training-load model — wider window (≥150d) so CTL warms up
    safeQuery(
      () => (HealthKit.queryWorkoutSamples as any)({
        filter: { startDate: daysAgo(Math.max(months * 30, 150)), endDate: now },
        limit: 1000,
        ascending: false,
        energyUnit: 'kcal',
        distanceUnit: 'm',
      }),
      [] as any[]
    ),
    loadRunMeta(),
    // Daily active energy (all movement) — basis for strain + CTL/ATL. Wide window for warmup.
    fetchDailyActiveEnergy(daysAgo(Math.max(months * 30, 150)), now),
  ]);

  // Classify runs AFTER we have longRunMinutes
  const { runs: classifiedRuns, maxHR } = await classifyAndCacheRuns(
    rawRuns, perRunData, allNewHRValues, existingCache, longRunMinutes
  );

  // Refine work stats from structured segments + mark HR unreliable + km splits
  // classifyAndCacheRuns returns cached runs without segments — merge them back from rawRuns.
  for (const run of classifiedRuns) {
    if (!run.segments || run.segments.length === 0) {
      const rawRun = rawRuns.find(r => r.uuid === run.uuid);
      if (rawRun?.segments && rawRun.segments.length > 0) {
        run.segments = rawRun.segments;
      }
    }
    if (run.segments && run.segments.length > 0) {
      const refined = refineWorkStatsFromSegments(run.segments);
      if (refined !== null && refined.wPace > 0) {
        if (refined.wHR > 0)  run.workHR       = refined.wHR;
        run.workPace     = refined.wPace;
        run.workDuration = refined.wDuration;
        if (refined.wPower > 0) run.workPower  = refined.wPower;
      }
    }
    if ((hrUnreliableMap as Record<string, boolean>)[run.uuid]) {
      run.hrUnreliable = true;
    }
  }

  if (uncached.length > 0) {
    const firstUncached = uncached[0];
    const data = perRunData.get(firstUncached.uuid);
    if (data && data.distSegs.length > 0) {
      // Pass workout's totalDistance as the cap so ghost splits from double-counted GPS
      // segments are never generated (e.g. a 16 km run can't show 32 km splits).
      const workoutTotalDistM = (firstUncached as any).totalDistance?.quantity ?? 0;
      const kms = computeKmSplits(data.distSegs, data.hrValues, data.hrTimestampsMs, data.powerSegs, workoutTotalDistM);
      if (kms.length > 0) {
        const r = classifiedRuns.find(r => r.uuid === firstUncached.uuid);
        if (r) r.kmSplits = kms;
      }
    }
  }

  // ── Step 6: Sleep analysis ────────────────────────────────────────────────
  progress('Analyzing sleep & recovery…', 80);

  const sleepSessions = groupIntoSessions(
    // Pass raw objects — groupIntoSessions handles Date|string normalisation internally
    (rawSleepSamples as any[]).map((s: any) => ({
      startDate: s.startDate,  // may be Date (v9) or string (older) — handled below
      endDate:   s.endDate,
      value:     s.value as number,
    }))
  );

  // Fetch HR for each sleep session's window individually — much more efficient
  // than pulling all HR for 30 days and filtering.
  let sleepHRSamples: { startDate: string; quantity: number }[] = [];
  if (sleepSessions.length > 0) {
    const nightHRResults = await Promise.all(
      sleepSessions.slice(-30).map((session) =>
        // session.bedtime/wakeTime are already ISO strings after groupIntoSessions normalisation
        safeQuery(
          () => (HealthKit.queryQuantitySamples as any)(
            HKQuantityTypeIdentifier.heartRate,
            {
              filter:    { startDate: new Date(session.bedtime), endDate: new Date(session.wakeTime) },
              unit:      'count/min',
              ascending: true,
              limit:     300,
            }
          ),
          []
        )
      )
    );
    sleepHRSamples = (nightHRResults as any[][]).flat().map((s: any) => ({
      // v9: startDate is a Date object; normalise to ISO string
      startDate: toISOStr(s.startDate),
      quantity:  s.quantity as number,
    }));
  }

  // ── Step 7: Nightly HRV + overnight HR ───────────────────────────────────
  const hrvSamplesForSleep = (allHRVSamples as any[]).map((s: any) => ({
    // v9: startDate is a Date object; normalise to ISO string
    startDate: toISOStr(s.startDate),
    quantity:  s.quantity as number,
  }));
  const globalQualityMap = buildHeartbeatQualityMap(allHeartbeatSeries as any[]);

  const nightlyHRV: NightlyHRV[] = sleepSessions.map((session) => {
    const { weightedRMSSD, annotatedSamples } = computeWeightedRMSSD(session, hrvSamplesForSleep, globalQualityMap);
    const overnightHR = computeOvernightHR(session, sleepHRSamples);
    return { date: session.date, samples: annotatedSamples, weightedRMSSD, overnightHR };
  });

  // ── Step 8: Power estimation + power zone classification + user overrides ──
  progress('Classifying workouts…', 90);

  const usePowerZones = isPowerZonesConfigured(powerZones);

  const runs = classifiedRuns.map((run) => {
    // ── 8a: Estimate power for runs without a native power sensor ────────────
    let r = run;
    const hasNativePower = (r.workPower ?? 0) > 0;
    const pace = r.workPace ?? r.pace;

    if (!hasNativePower && pace && pace > 0) {
      const estimate = (secs: number) =>
        secs > 0 ? Math.round((1000 / secs) * bodyMassKg * 1.04) : 0;
      const intervals = (r.intervals ?? []).map((rep: any) =>
        rep.avgPowerW > 0 ? rep : { ...rep, avgPowerW: estimate(rep.avgPaceSecs) }
      );
      r = { ...r, workPower: estimate(pace), isEstimatedPower: true, intervals };
    }

    // ── 8b: Power zone classification (native power only, not estimated) ─────
    if (usePowerZones && hasNativePower) {
      const wp = r.workPower!;
      const pz = powerZones;
      let powerLabel: WorkoutLabel | null = null;

      if (pz.intervalsMin > 0 && wp >= pz.intervalsMin) {
        powerLabel = 'Intervals';
      } else if (pz.tempoMin > 0 && pz.tempoMax > 0 && wp >= pz.tempoMin && wp <= pz.tempoMax) {
        powerLabel = 'Tempo';
      } else if (pz.z2Max > 0 && wp > (pz.recoveryMax || 0) && wp <= pz.z2Max) {
        powerLabel = 'Z2';
      } else if (pz.recoveryMax > 0 && wp <= pz.recoveryMax) {
        powerLabel = 'Recovery';
      }

      if (powerLabel) {
        r = { ...r, label: powerLabel, confidence: 'high' as WorkoutConfidence };
      }
    }

    // ── 8c: User manual override (highest priority — always wins) ────────────
    const override = runOverrides[r.uuid];
    if (override) {
      r = { ...r, label: override, confidence: 'high' as WorkoutConfidence };
    }

    // ── 8d: Per-run temperature + note ────────────────────────────────────────
    // Temp precedence: manual entry > HK weather metadata > previously captured.
    const meta   = (runMetaMap as Record<string, any>)[r.uuid];
    const hkTemp = hkTempByUuid.get(r.uuid);
    const tempC  = meta?.tempSource === 'manual' ? meta.tempC : (hkTemp ?? meta?.tempC);
    if (tempC != null)   r = { ...r, tempC };
    if (meta?.note)      r = { ...r, note: meta.note };

    return r;
  });

  // ── Step 9: Today's recovery ──────────────────────────────────────────────
  // Look at both today and yesterday: sleep from "last night" is often wakeTime-dated
  // as yesterday if the user checks the app soon after waking.
  const todayStr     = toDateStr(now.toISOString());
  const yesterdayStr = toDateStr(new Date(now.getTime() - 86_400_000).toISOString());

  const recentSession = sleepSessions.findLast(
    (s) => s.date === todayStr || s.date === yesterdayStr
  );
  const recentHRV = nightlyHRV.findLast(
    (n) => n.date === todayStr || n.date === yesterdayStr
  );

  let todayRecovery: DailyRecovery | null = null;

  // Daytime HR: average waking-hours HR, filtered to exclude exercise spikes (>100 bpm).
  // Window = previous sleep session's wakeTime → this session's bedtime − 30 min
  // (the actual waking day, no hardcoded offsets).
  let daytimeHR = 0;
  if (recentSession) {
    const prevSession = sleepSessions
      .filter(s => s.date < recentSession.date)
      .at(-1); // most recent session before tonight
    const dayStart = prevSession
      ? new Date(prevSession.wakeTime)
      : new Date(new Date(recentSession.bedtime).getTime() - 16 * 3_600_000);
    const dayEnd = new Date(new Date(recentSession.bedtime).getTime() - 30 * 60_000);
    const daytimeSamples = await safeQuery(
      () => (HealthKit.queryQuantitySamples as any)(
        HKQuantityTypeIdentifier.heartRate,
        { filter: { startDate: dayStart, endDate: dayEnd }, unit: 'count/min', limit: 600 }
      ),
      [] as any[]
    );
    const vals = (daytimeSamples as any[])
      .map((s: any) => s.quantity as number)
      .filter(v => v >= 40 && v <= 100); // exclude artefacts and exercise
    if (vals.length >= 5) {
      daytimeHR = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    }
  }
  // Fallback: Apple's computed RestingHeartRate
  if (daytimeHR === 0 && (restingHRSamples as any[]).length > 0) {
    daytimeHR = Math.round(
      (restingHRSamples as any[]).reduce((a: number, s: any) => a + (s.quantity as number), 0) /
      (restingHRSamples as any[]).length
    );
  }

  if (recentHRV && recentHRV.weightedRMSSD > 0) {
    // Full recovery score available
    const historyBefore = nightlyHRV.filter((n) => n.date < recentHRV.date);
    const { score, baseline, trend } = computeRecoveryScore(
      recentHRV.weightedRMSSD,
      recentHRV.overnightHR,
      historyBefore
    );
    const sleepScore = recentSession
      ? computeSleepScore(recentSession, recentHRV.overnightHR, daytimeHR)
      : 0;
    todayRecovery = {
      date:                todayStr,
      weightedRMSSD:       recentHRV.weightedRMSSD,
      overnightHR:         recentHRV.overnightHR,
      // Use filtered daytime HR as the baseline for dip display (matches Bevel's approach).
      // Falls back to overnight HR rolling mean if daytime HR unavailable.
      overnightHRBaseline: daytimeHR > 0 ? daytimeHR : recentHRV.overnightHR,
      recoveryScore:       score,
      sleepScore,
      baseline7Day:        baseline,
      trend,
      sleep:               recentSession ?? null,
      label:               scoreToLabel(score),
      color:               scoreToColor(score),
    };
  } else if (recentSession) {
    // Sleep session found but HRV not yet synced — show partial recovery card
    const sleepScore = computeSleepScore(recentSession, 0, daytimeHR);
    todayRecovery = {
      date:                todayStr,
      weightedRMSSD:       0,
      overnightHR:         0,
      overnightHRBaseline: 0,
      recoveryScore:       0,
      sleepScore,
      baseline7Day:        0,
      trend:               'stable',
      sleep:               recentSession,
      label:               'moderate',
      color:               '#f39c12',
    };
  }

  // ── Step 10: Training load (CTL/ATL/TSB) + strain from ALL activity ───────
  // Daily strain volume = total active energy burned that day (all movement),
  // scaled to a familiar load unit. This drives both CTL/ATL and the strain ring.
  const kcalByDay = dailyKcalMap as Map<string, number>;
  const loadByDay = new Map<string, number>();
  for (const [day, kcal] of kcalByDay) loadByDay.set(day, kcal * STRAIN_KCAL_TO_LOAD);
  const trainingLoad: DailyLoad[] = computeTrainingLoadSeries(loadByDay, daysAgo(90), now);

  // ── Today's strain — Bevel-style 24/7 TRIMP + muscular load ────────────────
  // Cardio: integrate Banister TRIMP over ALL of today's heart rate (captures both
  // workout effort and passive background movement). Muscular: a load proxy from
  // today's strength/resistance workouts (HR under-represents lifting).
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const todayHr = await safeQuery(
    () => (HealthKit.queryQuantitySamples as any)(
      HKQuantityTypeIdentifier.heartRate,
      { filter: { startDate: todayStart, endDate: now }, unit: 'count/min', ascending: true, limit: 20000 },
    ),
    [] as any[],
  );
  const restHRForTrimp = (restingHRSamples as any[]).length > 0
    ? Math.round((restingHRSamples as any[]).at(-1).quantity as number)
    : 50;
  // Today's workout windows — HR inside these counts as exercise (full weight).
  const todayWindows = (loadWorkoutsRaw as any[])
    .filter(w => toDateStr(toISOStr(w.startDate)) === todayStr)
    .map(w => {
      const s = new Date(toISOStr(w.startDate)).getTime();
      return { s, e: s + workoutDurationSec(w) * 1000 };
    });
  const cardioTrimp = computeStrainTrimp(
    (todayHr as any[]).map((s: any) => ({ t: new Date(toISOStr(s.startDate)).getTime(), hr: s.quantity as number })),
    restHRForTrimp,
    maxHR,
    todayWindows,
  );
  // Muscular load from today's strength/resistance workouts (HK types 20/50).
  const STRENGTH_TYPES = new Set([20, 50]);
  let muscularLoad = 0;
  for (const w of (loadWorkoutsRaw as any[])) {
    if (!STRENGTH_TYPES.has(w.workoutActivityType)) continue;
    if (toDateStr(toISOStr(w.startDate)) !== todayStr) continue;
    muscularLoad += workoutDurationSec(w) / 60; // ~1 TRIMP-equiv per active minute
  }
  const latestTsb = trainingLoad.length > 0 ? trainingLoad[trainingLoad.length - 1].tsb : 0;
  // Always compute (real may be 0 early in the day) so the ring shows "0%" + the
  // safe range rather than "--". Only null when there's no HR data at all today.
  const strain: DayStrain | null = (todayHr as any[]).length > 0
    ? computeDayStrain(cardioTrimp, muscularLoad, todayRecovery?.recoveryScore ?? 0, latestTsb)
    : null;

  // Recent activities (last 35 days) for the recommendation's cross-training view.
  const runHrByUuid = new Map<string, number>();
  for (const r of runs) {
    const hr = r.workHR ?? r.avgHeartRate ?? 0;
    if (hr > 0) runHrByUuid.set(r.uuid, hr);
  }
  const recentActivities = mapWorkoutsToActivities(loadWorkoutsRaw as any[], runHrByUuid)
    .filter(a => new Date(a.date) >= daysAgo(35))
    .sort((a, b) => b.date.localeCompare(a.date));

  progress('Done', 100);

  return {
    runs,
    activities:    recentActivities,
    trainingLoad,
    strain,
    vo2max: (vo2maxSamples as any[]).map((s: any) => ({
      // v9: startDate is a Date object; normalise to ISO string
      date:  toISOStr(s.startDate),
      value: Math.round(s.quantity * 10) / 10,
    })),
    hrv: (allHRVSamples as any[])
      .filter((s: any) => new Date(s.startDate) >= twoWeeksAgo)
      .map((s: any) => ({ date: toISOStr(s.startDate), value: Math.round(s.quantity) })),
    restingHR: (restingHRSamples as any[]).map((s: any) => ({
      date:  toISOStr(s.startDate),
      value: Math.round(s.quantity),
    })),
    weeklyMileage:    computeWeeklyMileage(runs),
    todayRecovery,
    recentNightlyHRV: nightlyHRV.slice(-14),
    recentSleep:      sleepSessions.slice(-14),
    workoutTypeStats: computeWorkoutTypeStats(runs),
    estimatedMaxHR:   maxHR,
    fetchedAt:        now.toISOString(),
    timelineEvents:   events as TimelineEvent[],
  };
}

// ─── Workout detail fetcher (used by workout detail screen) ───────────────────

export interface WorkoutActivity {
  startMs:        number;   // ms from workout start
  endMs:          number;
  activityType:   number;   // HKWorkoutActivityType numeric value
  label:          string;   // Warmup | Work | Recovery | Cooldown | Walk
  netDurationSec: number;   // HK net duration (excludes pauses); falls back to wall-clock
  // Per-segment KPIs (from HK allStatistics — zero means unavailable)
  distanceM:    number;   // metres
  avgHR:        number;   // bpm
  avgPower:     number;   // watts (0 if no power meter)
  cadenceSPM:   number;   // steps/min (0 if unavailable)
  stepActType:  number;   // workoutConfiguration.activityType for THIS step (may differ from parent)
}

export interface WorkoutDetailData {
  hr:             { t: number; v: number }[];  // t = ms from workout start, v = bpm
  power:          { t: number; v: number }[];  // watts
  pace:           { t: number; v: number }[];  // secs/km (rolling per dist segment)
  totalMs:        number;
  activities:     WorkoutActivity[];  // HealthKit structured workout activities (empty if unstructured)
  kmSplits:       KmSplit[];          // per-km splits (pause-adjusted)
  pauseIntervals: { s: number; e: number }[];  // pause periods in ms from workout start
  weatherTempC?:  number;             // HK weather temperature at run time (°C), if recorded
  debugUuids?:    string[];           // DEBUG: raw uuid tails to verify Swift patch
  debugEvents?:   string;            // DEBUG: event types and lap/pause counts
}

// HKWorkoutActivityType values relevant to labelling structured workouts.
// On Apple Watch structured workouts:
//   Warmup and between-rep recovery phases → preparationAndRecovery (82)
//   Actual work intervals                  → running (37)
//   Walk intervals                         → walking (52)
//   Cooldown phase                         → cooldown (80)
// We also accept 33 (observed on some device/OS combinations) as prep/recovery.
const HK_WALKING      = 52;
const HK_COOLDOWN     = 80;
const HK_PREP_REC_SET = new Set([33, 82]); // preparationAndRecovery

/**
 * Derive a human-readable label directly from the HealthKit activityType.
 * No position-based heuristics for running segments — if the Apple Watch
 * structured workout intended something to be a warmup it will have used
 * preparationAndRecovery (82), not running (37).
 *
 * Running (37)            → "Work"
 * Walking (52)            → "Walk" at edges, "Recovery" in between
 * Cooldown (80)           → "Cooldown"
 * PrepAndRecovery (33/82) → "Warm-up" (first half) or "Recovery" (second half)
 * Any other type          → "Work"
 */
function labelActivities(
  acts: Array<{ activityType: number }>
): string[] {
  const total = acts.length;
  if (total === 0) return [];

  const labels: string[] = new Array(total).fill('');

  acts.forEach((a, i) => {
    if (a.activityType === HK_COOLDOWN) {
      labels[i] = 'Cooldown';
      return;
    }
    if (HK_PREP_REC_SET.has(a.activityType)) {
      // Use position to distinguish warmup (early) from recovery (later)
      labels[i] = i < total / 2 ? 'Warmup' : 'Recovery';
      return;
    }
    if (a.activityType === HK_WALKING) {
      const isEdge = i === 0 || i === total - 1;
      labels[i] = isEdge ? 'Walk' : 'Recovery';
      return;
    }
    // Running (37) or any other activity type → Work
    labels[i] = 'Work';
  });

  return labels;
}

/**
 * Downsample high-frequency HR (or power) samples to 1 per second by
 * averaging all samples that fall within the same 1-second bucket.
 * A Polar H10 at 10 Hz would give 36 000 samples for a 60-min run —
 * we compress that to ~3 600, which is still dense enough for any chart.
 */
function downsampleTo1PerSecond(
  samples: { t: number; v: number }[],
): { t: number; v: number }[] {
  if (samples.length === 0) return [];
  const buckets = new Map<number, number[]>();
  for (const { t, v } of samples) {
    const sec = Math.floor(t / 1000);
    if (!buckets.has(sec)) buckets.set(sec, []);
    buckets.get(sec)!.push(v);
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([sec, vals]) => ({
      t: sec * 1000,
      v: Math.round(vals.reduce((s, x) => s + x, 0) / vals.length),
    }));
}

/**
 * Detect "not running" periods within a GPS-tracked run — stops AND sustained
 * shuffling/standing where the pace signal is meaningless.
 *
 * Use case: in the cooldown the runner sits down or walks/shuffles with the watch
 * still on. GPS keeps emitting junk slow pace (13–17 min/km) that pollutes the
 * chart. We find windows where speed stays below a slow-walk floor and clear
 * pace/power there (HR is kept — a recovering heart rate is real and useful).
 *
 * Threshold: < 13 m per 10 s ≈ 1.3 m/s ≈ slower than ~12:50 min/km, sustained for
 * ≥ 20 s. A genuine recovery jog (≥ ~2 m/s) stays well above this and is kept.
 *
 * Guards: requires actual GPS movement, so treadmill/indoor runs (no distance
 * segments) are never flagged — their power data is left intact.
 *
 * @param distSegs {t0, t1 (ms offsets), m (metres covered in that span)}
 * @param seriesEndMs last timestamp that has pace/power data (covers a trailing sit)
 */
function computeStationaryIntervals(
  distSegs: { t0: number; t1: number; m: number }[],
  seriesEndMs: number,
): { s: number; e: number }[] {
  const BUCKET = 10_000;     // 10-second buckets
  const MOVE_M = 13;         // < 13 m in 10 s (~1.3 m/s) = walking/shuffling/stopped
  const MIN_STILL = 20_000;  // only flag stretches lasting ≥ 20 s
  if (distSegs.length < 5) return [];

  // Distribute each segment's distance across every 10 s bucket it spans
  // (proportional to time overlap). Without this, a single sparse GPS segment
  // (e.g. 50 m over 20 s) would dump all its metres into one bucket and leave
  // the neighbouring buckets reading 0 m — falsely "stationary" while moving.
  const distByBucket = new Map<number, number>();
  let maxBucket = 0;
  for (const s of distSegs) {
    if (s.m <= 0) continue;
    const span = Math.max(1, s.t1 - s.t0);
    const bStart = Math.floor(s.t0 / BUCKET);
    const bEnd   = Math.floor(Math.max(s.t0, s.t1) / BUCKET);
    for (let b = bStart; b <= bEnd; b++) {
      const overlap = Math.min(s.t1, (b + 1) * BUCKET) - Math.max(s.t0, b * BUCKET);
      if (overlap <= 0) continue;
      distByBucket.set(b, (distByBucket.get(b) ?? 0) + s.m * (overlap / span));
      if (b > maxBucket) maxBucket = b;
    }
  }
  const movingBuckets = [...distByBucket.entries()]
    .filter(([, m]) => m >= MOVE_M).map(([b]) => b).sort((a, b) => a - b);
  if (movingBuckets.length === 0) return []; // no real GPS movement → treadmill/indoor

  const firstMoving = movingBuckets[0];
  const endBucket = Math.max(maxBucket, Math.ceil(seriesEndMs / BUCKET));

  const intervals: { s: number; e: number }[] = [];
  let runStart = -1;
  for (let b = firstMoving; b <= endBucket; b++) {
    const moved = (distByBucket.get(b) ?? 0) >= MOVE_M;
    if (!moved) {
      if (runStart < 0) runStart = b;
    } else if (runStart >= 0) {
      intervals.push({ s: runStart * BUCKET, e: b * BUCKET });
      runStart = -1;
    }
  }
  if (runStart >= 0) intervals.push({ s: runStart * BUCKET, e: (endBucket + 1) * BUCKET });

  // Merge stretches split by a single brief moving blip (≤ 1 bucket) — e.g. a few
  // shuffling steps between stops shouldn't rescue the meaningless pace around them.
  const merged: { s: number; e: number }[] = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv.s - last.e <= BUCKET) last.e = iv.e;
    else merged.push({ ...iv });
  }

  return merged.filter(iv => iv.e - iv.s >= MIN_STILL);
}

/**
 * Compute km splits from GPS distance samples.
 *
 * Timing  — GPS cumulative with a speed cap (> 12 m/s = catch-up batch = skip).
 *           Apple Watch "catch-up" entries dump 100–1000 m in < 1 s at activity
 *           boundaries; filtering by implied speed reliably removes them while
 *           keeping every realistic running entry (world-record pace ≈ 5.7 m/s).
 *           tEnd of each GPS sample is used so cumM[N] = "reached N m at time t".
 *
 * Pace    — GPS segment ratio: Σ(overlap_time) / Σ(overlap_dist) for samples
 *           within [startT, endT] that have speed 0.5–12 m/s.  This naturally
 *           excludes paused / stationary time without any event-type parsing.
 *
 * Cadence — HKQuantityTypeIdentifierRunningCadence (iOS 16+, often empty)
 *           → HKStepCount (~60 s resolution, per-km variation)
 *           → activity-level cadenceSPM weighted by distance overlap.
 *
 * pauseIntervs: [{s, e}] ms relative to workout start (used for power only).
 * maxDistM:     workout.totalDistance — authoritative km count source.
 */
function computeKmSplitsDetail(
  distRaw:      any[],
  hrRaw2:       { t: number; v: number }[],
  powerRaw2:    { t: number; v: number }[],
  cadenceRaw2:  { t: number; v: number }[],
  stepSegs:     { t: number; tEnd: number; steps: number }[],
  startMs:      number,
  durationSec:  number,
  pauseIntervs: { s: number; e: number }[],
  maxDistM:     number,
  activities:   WorkoutActivity[],
  lapTimesMs:   number[],  // ms rel. to start; one entry per completed km
): KmSplit[] {
  const workoutEndMs = durationSec * 1000;

  // ── Activity timeline (for cadence fallback only) ──────────────────────────
  interface ActSeg { startMs: number; endMs: number; startDistM: number; endDistM: number; cadenceSPM: number; }
  const actTimeline: ActSeg[] = [];
  {
    let cd = 0;
    for (const a of activities) {
      if (a.distanceM <= 0) continue;
      actTimeline.push({ startMs: a.startMs, endMs: a.endMs, startDistM: cd, endDistM: cd + a.distanceM, cadenceSPM: a.cadenceSPM });
      cd += a.distanceM;
    }
  }

  // ── Lap-event timing (preferred) ──────────────────────────────────────────
  // Apple Watch records a lap event at the exact moment each km is crossed.
  // These timestamps come from the Watch's own motion tracking and are far
  // more reliable than GPS distance-sample cumulation.
  const useLaps = lapTimesMs.length >= 1;
  const nKm     = useLaps
    ? lapTimesMs.length
    : Math.floor((maxDistM > 100 ? maxDistM : 0) / 1000);

  // ── GPS cumulative (speed-filtered) — used for pace ratio & lap fallback ──
  const MAX_SPEED_MS = 12;   // m/s — faster = GPS catch-up batch
  const cum: { t: number; cumM: number }[] = [];
  {
    let accM = 0;
    for (const s of distRaw) {
      const tS = new Date(toISOStr(s.startDate)).getTime() - startMs;
      const tE = new Date(toISOStr(s.endDate)).getTime()   - startMs;
      const m  = s.quantity as number;
      if (tS < -5_000 || tS > workoutEndMs + 5_000) continue;
      if (m <= 0) continue;
      const durMs = tE - tS;
      if (durMs > 0 && m / (durMs / 1000) > MAX_SPEED_MS) continue;
      accM += m;
      cum.push({ t: tE, cumM: accM });
    }
  }

  if (nKm === 0) return [];
  if (!useLaps && cum.length === 0) return [];

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Distance-weighted cadence from activity segments overlapping [fromT, toT] */
  const actCadence = (fromT: number, toT: number): number => {
    let td = 0, wc = 0;
    for (const seg of actTimeline) {
      if (seg.endMs <= fromT || seg.startMs >= toT || seg.cadenceSPM <= 0) continue;
      const ovMs = Math.min(toT, seg.endMs) - Math.max(fromT, seg.startMs);
      const segMs = seg.endMs - seg.startMs;
      const ovDist = segMs > 0 ? (ovMs / segMs) * (seg.endDistM - seg.startDistM) : 0;
      wc += seg.cadenceSPM * ovDist; td += ovDist;
    }
    return td > 0 ? Math.round(wc / td) : 0;
  };

  /** Running cadence from HKStepCount segments overlapping [fromT, toT].
   *
   *  Problem: HealthKit returns step counts from ALL sources (Apple Watch AND iPhone).
   *  Both cover the same time windows, so naively summing gives a blended average that
   *  is too low (Watch ~168 spm, iPhone in backpack ~80-158 spm → blended ~124-163).
   *
   *  Fix: filter stepSegs to 150–185 spm at construction time (eliminates iPhone
   *  noise and Watch arm-swing outliers), then do a simple pause-corrected sum.
   *  No source deduplication needed — the cadence filter does the heavy lifting.
   *
   *  Step allocation proportional to running overlap so paused kms are correct.
   */
  const stepCadence = (fromT: number, toT: number): number => {
    let steps = 0, runMs = 0;
    for (const seg of stepSegs) {
      if (seg.tEnd <= fromT || seg.t >= toT) continue;
      const ovStart = Math.max(fromT, seg.t);
      const ovEnd   = Math.min(toT,   seg.tEnd);
      const pauseOvMs = pauseIntervs.reduce((acc, p) => {
        const ps = Math.max(p.s, ovStart);
        const pe = Math.min(p.e, ovEnd);
        return acc + Math.max(0, pe - ps);
      }, 0);
      const runOvMs = ovEnd - ovStart - pauseOvMs;
      if (runOvMs <= 0) continue;
      // Proportion of the segment's steps that fall in the running overlap
      steps += seg.steps * (runOvMs / (seg.tEnd - seg.t));
      runMs += runOvMs;
    }
    return runMs > 0 ? Math.round(steps / (runMs / 60_000)) : 0;
  };

  /** true when t is inside a detected pause window */
  const inPause = (t: number) => pauseIntervs.some(({ s, e }) => t >= s && t <= e);

  // ── Build splits ───────────────────────────────────────────────────────────
  const splits: KmSplit[] = [];
  let prevT = 0; // km 1 starts at workout t=0

  for (let kmN = 1; kmN <= nKm; kmN++) {
    let startT: number, endT: number;

    if (useLaps) {
      // Lap timestamps: lapTimesMs[N-1] = wall-clock ms when km N was completed
      startT = kmN === 1 ? 0 : lapTimesMs[kmN - 2];
      endT   = lapTimesMs[kmN - 1];
    } else {
      // GPS fallback
      const ei = cum.findIndex(c => c.cumM >= kmN * 1000);
      if (ei < 0) break;
      startT = prevT;
      endT   = cum[ei].t;
    }

    if (endT <= startT) { prevT = endT; continue; }

    const wallSec = Math.max(1, (endT - startT) / 1000);
    // Net running time: subtract any pause intervals that fall within this km window
    const pauseMs = pauseIntervs.reduce((acc, p) => {
      const ovStart = Math.max(p.s, startT);
      const ovEnd   = Math.min(p.e, endT);
      return acc + Math.max(0, ovEnd - ovStart);
    }, 0);
    const netSec = Math.max(1, wallSec - pauseMs / 1000);

    // Pace = GPS segment ratio within [startT, endT].
    // Only count samples moving at realistic running speed (0.5–12 m/s).
    // This excludes catch-up batches (too fast) AND standing-still time
    // (too slow / paused), giving true running pace without event parsing.
    let gpsMs = 0, gpsMtrs = 0;
    for (const s of distRaw) {
      const tS = new Date(toISOStr(s.startDate)).getTime() - startMs;
      const tE = new Date(toISOStr(s.endDate)).getTime()   - startMs;
      const m  = s.quantity as number;
      if (tE <= startT || tS >= endT || m <= 0) continue;
      const durMs = tE - tS;
      if (durMs <= 0) continue;
      const speed = m / (durMs / 1000);
      if (speed > MAX_SPEED_MS || speed < 0.5) continue; // catch-up or stationary
      const ovMs = Math.min(tE, endT) - Math.max(tS, startT);
      const frac = ovMs / durMs;
      gpsMs   += ovMs;
      gpsMtrs += m * frac;
    }
    // Pace = net time / km.
    // For partial final km, scale by GPS metres so pace = net time / (gpsMtrs/1000).
    // For full kms, just use netSec (= time per km) — GPS-ratio pace inflates values
    // during kms that contain pauses because GPS only captures moving time.
    const isPartial = gpsMtrs > 10 && gpsMtrs < 950;
    const paceSecs = isPartial
      ? Math.round(netSec / (gpsMtrs / 1000))
      : Math.round(netSec);

    // HR: all samples in window (Watch always records HR, even during pauses)
    const hrs   = hrRaw2.filter(p => p.t >= startT && p.t <= endT);
    const avgHR = hrs.length > 0
      ? Math.round(hrs.reduce((a, b) => a + b.v, 0) / hrs.length) : 0;

    // Cadence: prefer HKQuantityTypeIdentifierRunningCadence (Apple's filtered 1 Hz sensor
    // data — already corrected for arm swings, matches Fitness app exactly).
    // Fall back to step-count bucketing if RunningCadence is unavailable (older OS / no perm).
    let avgCadence = 0;
    if (cadenceRaw2.length > 0) {
      // RunningCadence: exclude pause windows, then average running-only samples
      const cads = cadenceRaw2.filter(p => p.t >= startT && p.t <= endT && !inPause(p.t));
      if (cads.length > 0)
        avgCadence = Math.round(cads.reduce((a, b) => a + b.v, 0) / cads.length);
    }
    if (avgCadence === 0) avgCadence = stepCadence(startT, endT);
    if (avgCadence === 0) avgCadence = actCadence(startT, endT);

    // Power: exclude detected pause windows
    const pwrs     = powerRaw2.filter(p => p.t >= startT && p.t <= endT && !inPause(p.t));
    const avgPower = pwrs.length > 0
      ? Math.round(pwrs.reduce((a, b) => a + b.v, 0) / pwrs.length) : 0;

    splits.push({ km: kmN, durationSec: Math.round(netSec), paceSecs, avgHR, avgCadence, avgPower });
    prevT = endT;
  }
  return splits;
}

export async function fetchWorkoutDetail(
  startDate: string | Date,
  durationSec: number,
): Promise<WorkoutDetailData> {
  const startMs = new Date(toISOStr(startDate)).getTime();
  const endMs   = startMs + durationSec * 1000;
  const from    = new Date(startMs - 30_000);
  const to      = new Date(endMs   + 1_200_000); // 20 min extra — covers elapsed time past net duration (pauses)

  // Limits are deliberately large: a Polar H10 at 10 Hz produces up to
  // 54 000 HR samples in a 90-min run; distance GPS segments can reach
  // 10 000+.  We downsample to 1 Hz after fetching.
  const [hrRaw, distRaw, powerRaw, cadenceRaw, workoutRaw, stepCountRaw] = await Promise.all([
    safeQuery(() => (HealthKit.queryQuantitySamples as any)(
      HKQuantityTypeIdentifier.heartRate,
      { filter: { startDate: from, endDate: to }, unit: 'count/min', ascending: true, limit: 100_000 }
    ), [] as any[]),
    safeQuery(() => (HealthKit.queryQuantitySamples as any)(
      HKQuantityTypeIdentifier.distanceWalkingRunning,
      { filter: { startDate: from, endDate: to }, unit: 'm', ascending: true, limit: 20_000 }
    ), [] as any[]),
    safeQuery(() => (HealthKit.queryQuantitySamples as any)(
      HKQuantityTypeIdentifier.runningPower,
      { filter: { startDate: from, endDate: to }, unit: 'W', ascending: true, limit: 100_000 }
    ), [] as any[]),
    // Running cadence (steps/min) — iOS 16+; returns [] on older OS
    safeQuery(() => (HealthKit.queryQuantitySamples as any)(
      'HKQuantityTypeIdentifierRunningCadence',
      { filter: { startDate: from, endDate: to }, unit: 'count/min', ascending: true, limit: 20_000 }
    ), [] as any[]),
    // Fetch the workout itself to extract lap events and totalDistance
    safeQuery(() => (HealthKit.queryWorkoutSamples as any)({
      filter: { startDate: new Date(startMs - 5_000), endDate: new Date(startMs + 5_000) },
      limit: 5,
      ascending: true,
      energyUnit: 'kcal',
      distanceUnit: 'm',
    }), [] as any[]),
    // Step count — available since iOS 8, gives per-minute cadence resolution
    safeQuery(() => (HealthKit.queryQuantitySamples as any)(
      'HKQuantityTypeIdentifierStepCount',
      { filter: { startDate: from, endDate: to }, unit: 'count', ascending: true, limit: 5_000 }
    ), [] as any[]),
  ]);

  // Upper bound: use the actual query window end (to), not net duration.
  // Samples in the elapsed-time portion past net duration (e.g. km after a long pause) must be kept.
  const clipMax = to.getTime() - startMs;
  const clip = (t: number) => t >= -60_000 && t <= clipMax;

  // Collect raw HR points, then downsample to 1/s
  const hrRaw2 = (hrRaw as any[])
    .map((s: any) => ({ t: new Date(toISOStr(s.startDate)).getTime() - startMs, v: Math.round(s.quantity as number) }))
    .filter(p => clip(p.t));
  const hr = downsampleTo1PerSecond(hrRaw2);

  // Same for power
  const powerRaw2 = (powerRaw as any[])
    .map((s: any) => ({ t: new Date(toISOStr(s.startDate)).getTime() - startMs, v: Math.round(s.quantity as number) }))
    .filter(p => clip(p.t));
  const power = downsampleTo1PerSecond(powerRaw2);

  // Running cadence (steps/min) — iOS 16+ sensor data; usually empty
  const cadenceRaw2 = (cadenceRaw as any[])
    .map((s: any) => ({ t: new Date(toISOStr(s.startDate)).getTime() - startMs, v: Math.round(s.quantity as number) }))
    .filter(p => clip(p.t));

  // Step count segments — used to derive per-km cadence when sensor data unavailable.
  // Apple Watch records step counts roughly every 60 s during a workout, so this gives
  // better per-km resolution than a single activity-level average.
  // Step count segments — used to derive per-km cadence.
  // Keep all valid segments; source deduplication (Watch vs iPhone) is handled
  // inside computeKmSplitsDetail where pause intervals are available for
  // pause-adjusted cadence comparison.
  const allStepSegs = (stepCountRaw as any[]).map((s: any) => {
    const t    = new Date(toISOStr(s.startDate)).getTime() - startMs;
    const tEnd = new Date(toISOStr(s.endDate)).getTime()   - startMs;
    return { t, tEnd, steps: s.quantity as number, productType: (s.sourceRevision?.productType ?? '') as string };
  }).filter(p => clip(p.t) && p.steps > 0 && p.tEnd > p.t);

  // Prefer Watch-only segments (productType "Watch…") to avoid iPhone contamination.
  // If no Watch segments exist (Watch not worn, or older SDK without productType),
  // fall back to all available sources.
  const watchSegs = allStepSegs.filter(p => p.productType.startsWith('Watch'));
  const stepSegs = watchSegs.length > 0 ? watchSegs : allStepSegs;

  // Pace: derived from distance segments (each segment = GPS track point)
  // Apply a 10-second rolling average to smooth GPS noise.
  const rawPace: { t: number; v: number }[] = [];
  (distRaw as any[]).forEach((s: any) => {
    const t0 = new Date(toISOStr(s.startDate)).getTime() - startMs;
    const t1 = new Date(toISOStr(s.endDate)).getTime()   - startMs;
    const m  = s.quantity as number;
    const durSec = (t1 - t0) / 1000;
    if (m > 0.5 && durSec > 0) {
      const spk = durSec / (m / 1000);
      if (spk > 120 && spk < 1200) rawPace.push({ t: t0 + (t1 - t0) / 2, v: Math.round(spk) });
    }
  });
  // Smooth pace with a 10-second window
  const PACE_SMOOTH_MS = 10_000;
  const pace: { t: number; v: number }[] = rawPace.map((p, i, arr) => {
    const window = arr.filter(q => Math.abs(q.t - p.t) <= PACE_SMOOTH_MS / 2);
    const avg = window.reduce((s, q) => s + q.v, 0) / window.length;
    return { t: p.t, v: Math.round(avg) };
  });

  // Extract structured workout activities from the workout object.
  // The library (WorkoutProxy.swift) exposes them as `workout.activities`.
  // Note: activityType is NOT serialized by the library — use position-based
  // labeling (first=Warm-up, last=Cooldown, middle alternates Work/Recovery).
  const activities: WorkoutActivity[] = [];
  const workout = (workoutRaw as any[]).find(
    (w: any) => Math.abs(new Date(toISOStr(w.startDate)).getTime() - startMs) < 10_000
  );
  const rawActs: any[] = workout?.activities ?? [];

  // Parse uuid suffix added by WorkoutProxy.swift patch.
  // Format: "{uuid}::{actTypeRaw}[::meta::{key=val|...}][::stat::{key=val;...}]"
  const typed = rawActs.map((act: any) => {
    const uuidStr: string = act.uuid ?? '';
    const firstSep = uuidStr.indexOf('::');
    let activityType = 37;
    let actMeta: Record<string, string> = {};
    let actStat: Record<string, number> = {};

    if (firstSep >= 0) {
      const rest = uuidStr.slice(firstSep + 2);

      const metaSep  = rest.indexOf('::meta::');
      const statSep  = rest.indexOf('::stat::');

      // actType is everything before the first tag
      const firstTag = [metaSep, statSep].filter(i => i >= 0).reduce((a, b) => Math.min(a, b), rest.length);
      activityType   = parseInt(rest.slice(0, firstTag), 10) || 37;

      if (metaSep >= 0) {
        const end     = statSep >= 0 && statSep > metaSep ? statSep : rest.length;
        const metaStr = rest.slice(metaSep + 8, end);
        for (const pair of metaStr.split('|')) {
          const eqIdx = pair.indexOf('=');
          if (eqIdx >= 0) actMeta[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
        }
      }

      if (statSep >= 0) {
        const statStr = rest.slice(statSep + 8);
        for (const pair of statStr.split(';')) {
          const eqIdx = pair.indexOf('=');
          if (eqIdx >= 0) actStat[pair.slice(0, eqIdx)] = parseFloat(pair.slice(eqIdx + 1)) || 0;
        }
      }
    }
    return { act, activityType, actMeta, actStat };
  });

  if (typed.length > 0) {
    // Fallback labels based on activityType (used when metadata key is absent)
    const fallbackLabels = labelActivities(typed.map(t => ({ activityType: t.activityType })));

    typed.forEach(({ act, activityType, actMeta, actStat }, idx) => {
      const actStart = act.startDate;
      const actEnd   = act.endDate;
      if (!actStart || !actEnd) return;
      const aStartMs = new Date(toISOStr(actStart)).getTime() - startMs;
      const aEndMs   = new Date(toISOStr(actEnd)).getTime()   - startMs;
      if (aEndMs - aStartMs < 5_000) return;

      // Label priority:
      //   1. Custom step name
      //   2. WorkoutStepType numeric (0=Warmup,1=Work,2=Recovery,3=Cooldown)
      //   3. stepActType from workoutConfiguration (if different from parent's 37=running)
      //   4. WOIntervalStepKeyPath index → mark for post-loop heuristic
      let label: string;
      const stepPath = actMeta['WOIntervalStepKeyPath'] ?? '';   // e.g. "0.0.0"
      const stepIdx  = stepPath ? parseInt(stepPath.split('.')[0], 10) : -1;

      if (actMeta['WorkoutStepName']) {
        label = actMeta['WorkoutStepName'];
      } else if (actMeta['WorkoutStepType'] !== undefined) {
        switch (parseInt(actMeta['WorkoutStepType'], 10)) {
          case 0:  label = 'Warmup';   break;
          case 1:  label = 'Work';     break;
          case 2:  label = 'Recovery'; break;
          case 3:  label = 'Cooldown'; break;
          default: label = fallbackLabels[idx];
        }
      } else {
        // stepActType from workoutConfiguration (if non-running, tells us the phase)
        const sAt = actStat['stepAct'] ?? activityType;
        if (sAt === HK_COOLDOWN)              label = 'Cooldown';
        else if (HK_PREP_REC_SET.has(sAt))    label = 'Warmup';
        else if (sAt === HK_WALKING)          label = 'Walk';
        else if (stepPath)                    label = `__step:${stepIdx}`;  // deferred
        else                                  label = fallbackLabels[idx];
      }

      // HK net duration (excludes pauses); `act.duration` is set from HKWorkoutActivity.duration
      const netDurationSec = (act as any).duration > 0
        ? (act as any).duration
        : Math.max(1, (aEndMs - aStartMs) / 1000);
      const steps       = actStat['steps'] ?? 0;
      // Prefer direct cadence from allStatistics (HK engine averages only running
      // samples, excluding pauses). Fall back to step-count / net-duration derivation.
      const cadenceSPM  = (actStat['cad'] ?? 0) > 0
        ? Math.round(actStat['cad'])
        : (steps > 0 && netDurationSec > 0 ? Math.round(steps / (netDurationSec / 60)) : 0);
      activities.push({
        startMs:        aStartMs,
        endMs:          aEndMs,
        activityType,
        label,
        netDurationSec: Math.round(netDurationSec),
        distanceM:      actStat['dist']    ?? 0,
        avgHR:          actStat['hr']      ?? 0,
        avgPower:       actStat['power']   ?? 0,
        cadenceSPM,
        stepActType:    actStat['stepAct'] ?? activityType,
      });
    });

    // Post-loop: resolve __step: deferred labels using distance + position heuristic.
    // WOIntervalStepKeyPath gives us relative position but not phase type.
    // Pattern: first/last activities that are significantly shorter = Warmup/Cooldown.
    const hasStepPaths = activities.some(a => a.label.startsWith('__step:'));
    if (hasStepPaths || activities.every(a => a.label === 'Work')) {
      const dists = activities.map(a => a.distanceM);
      const validDists = dists.filter(d => d > 0);
      if (validDists.length === activities.length && activities.length >= 2) {
        const sorted = [...validDists].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const threshold = median * 0.65;
        activities.forEach((a, i) => {
          if (a.label.startsWith('__step:') || a.label === 'Work') {
            if (i === 0 && a.distanceM < threshold)                            a.label = 'Warmup';
            else if (i === activities.length - 1 && a.distanceM < threshold)   a.label = 'Cooldown';
            else                                                                a.label = 'Work';
          }
        });
      } else {
        // No distance data — just strip the __step: prefix
        activities.forEach(a => { if (a.label.startsWith('__step:')) a.label = 'Work'; });
      }
    }

    // ── Intensity-based warmup/cooldown rescue ────────────────────────────────
    // Mirror of the snapshot-segment logic: a non-short first/last activity that's
    // clearly easier than the median Work rep (lower HR/power, slower pace) is a
    // warmup/cooldown, not Work — so it's labelled (and excluded) correctly.
    if (activities.length >= 3) {
      const work = activities.filter(a => a.label === 'Work');
      if (work.length >= 3) {
        const med = (arr: number[]) => {
          const v = arr.filter(x => x > 0).sort((a, b) => a - b);
          return v.length ? v[Math.floor(v.length / 2)] : 0;
        };
        const medHR    = med(work.map(a => a.avgHR));
        const medPower = med(work.map(a => a.avgPower));
        const medPace  = med(work.map(a => (a.distanceM > 0 ? a.netDurationSec / (a.distanceM / 1000) : 0)));
        const easier = (a: WorkoutActivity): boolean => {
          if (medHR > 0    && a.avgHR > 0)    return a.avgHR    < medHR - 8;
          if (medPower > 0 && a.avgPower > 0) return a.avgPower < medPower * 0.85;
          const pace = a.distanceM > 0 ? a.netDurationSec / (a.distanceM / 1000) : 0;
          if (medPace > 0 && pace > 0)        return pace > medPace * 1.12;
          return false;
        };
        const f = activities[0], l = activities[activities.length - 1];
        if (f.label === 'Work' && easier(f)) f.label = 'Warmup';
        if (l.label === 'Work' && easier(l)) l.label = 'Cooldown';
      }
    }
  }

  // DEBUG: dump all metadata keys + stat KPIs to discover real key names
  const debugUuids = typed.map(({ activityType, actMeta, actStat }) => {
    const metaKeys = Object.keys(actMeta).length > 0
      ? Object.entries(actMeta).map(([k,v]) => `${k}=${v}`).join(' ')
      : 'no-meta';
    const dist  = actStat['dist']  ? ` ${Math.round(actStat['dist'])}m` : '';
    const hr    = actStat['hr']    ? ` HR${Math.round(actStat['hr'])}` : '';
    const power = actStat['power'] ? ` ${Math.round(actStat['power'])}W` : '';
    return `t=${activityType} [${metaKeys}]${dist}${hr}${power}`;
  });

  // ── Extract pause intervals + lap crossing times from workout events ────────
  // HKWorkoutEventType: pause=1, resume=2, lap=3, marker=4, motionPaused=5, motionResumed=6, segment=7
  // Apple Watch structured workouts use type=7 (segment) for km auto-laps, NOT type=3 (lap).
  // Two parallel chains of type=7 events coexist:
  //   A) km-split chain: 0→km1, km1→km2, ... (one per completed km, 16+ segments)
  //   B) activity-phase chain: 0→warmup_end, warmup_end→work_end (2-3 segments)
  // We pick the LONGEST consecutive chain as km boundaries.
  const pauseIntervs: { s: number; e: number }[] = [];
  const lapTimesMs:   number[] = [];   // ms rel. to workout start, one per completed km
  let debugEvents = '';
  {
    const wEvents: any[] = workout?.events ?? [];
    let pStart: number | null = null;
    const seg7: { s: number; e: number }[] = [];  // type=7 segment events
    const evSummary: string[] = [];

    for (const ev of wEvents) {
      const evType = typeof ev.type === 'number' ? ev.type : String(ev.type);
      const rawS   = ev.startDate ?? ev.date ?? null;
      const rawE   = ev.endDate   ?? null;
      const sMs    = rawS ? new Date(toISOStr(rawS)).getTime() - startMs : null;
      const eMs    = rawE ? new Date(toISOStr(rawE)).getTime() - startMs : null;
      evSummary.push(`t${evType}@${sMs !== null ? Math.round(sMs/1000) : '?'}s→${eMs !== null ? Math.round(eMs/1000) : '?'}s`);

      if (typeof evType !== 'number' || sMs === null || isNaN(sMs)) continue;

      if (evType === 3) {
        // Lap event (older Watch OS / non-structured workouts): endDate = km crossing time
        const lapMs = eMs !== null && !isNaN(eMs) ? eMs : sMs;
        if (lapMs > 0 && lapMs < durationSec * 1000 + 1_800_000) lapTimesMs.push(lapMs);
      } else if (evType === 7) {
        // Segment event — Apple Watch structured workouts record km auto-laps as type=7.
        // Use a generous cutoff: elapsed time can exceed net duration by the total pause time
        // (typically 5–15 min). 30 min extra headroom covers any realistic workout.
        if (eMs !== null && !isNaN(eMs) && eMs > sMs && eMs < durationSec * 1000 + 1_800_000) {
          seg7.push({ s: sMs, e: eMs });
        }
      } else if (evType === 1 || evType === 5) {
        // Pause / motionPaused — Apple encodes the full pause interval in one event
        if (eMs !== null && !isNaN(eMs) && eMs > sMs) {
          pauseIntervs.push({ s: sMs, e: eMs });
        } else if (pStart === null) {
          pStart = sMs;   // fallback: wait for separate resume event
        }
      } else if ((evType === 2 || evType === 6) && pStart !== null) {
        pauseIntervs.push({ s: pStart, e: sMs });
        pStart = null;
      }
    }

    // If no type=3 lap events, extract km boundaries from the longest type=7 chain.
    // Two chains start at t≈0: the km-split chain (16+ segments) and the activity-phase
    // chain (2-3 segments). Trying all seeds and picking the longest chain gets it right.
    if (lapTimesMs.length === 0 && seg7.length > 0) {
      const TOLERANCE = 3000; // ms — match tolerance for chaining consecutive segments
      const seeds = seg7.filter(s => s.s < TOLERANCE);
      let bestChain: number[] = [];

      for (const seed of seeds) {
        const chain: number[] = [seed.e];
        let cur = seed.e;
        for (let iter = 0; iter < 60; iter++) {
          // Find all type=7 segments starting near cur
          const nexts = seg7.filter(s => Math.abs(s.s - cur) < TOLERANCE && s.e > cur);
          if (nexts.length === 0) break;
          // Pick shortest-duration next segment (km splits are shorter than activity phases)
          nexts.sort((a, b) => (a.e - a.s) - (b.e - b.s));
          cur = nexts[0].e;
          chain.push(cur);
        }
        if (chain.length > bestChain.length) bestChain = chain;
      }

      for (const t of bestChain) {
        if (t > 0 && t < durationSec * 1000 + 1_800_000) lapTimesMs.push(t);
      }
    }

    lapTimesMs.sort((a, b) => a - b);
    // Deduplicate consecutive entries within 2 s
    for (let i = lapTimesMs.length - 1; i > 0; i--) {
      if (lapTimesMs[i] - lapTimesMs[i - 1] < 2000) lapTimesMs.splice(i, 1);
    }

    debugEvents = `evts:${wEvents.length} seg7:${seg7.length} laps:${lapTimesMs.length}(${lapTimesMs.slice(0,3).map(t=>Math.round(t/1000)+'s').join(',')}) pauses:${pauseIntervs.length}(${pauseIntervs.map(p=>Math.round((p.e-p.s)/1000)+'s').join(',')}) | ${evSummary.slice(0,6).join(' ')}`;
  }

  // ── Compute km splits ─────────────────────────────────────────────────────
  const workoutDistM = (workout as any)?.totalDistance?.quantity ?? 0;
  const kmSplits = computeKmSplitsDetail(
    distRaw as any[], hrRaw2, powerRaw2, cadenceRaw2, stepSegs,
    startMs, durationSec, pauseIntervs, workoutDistM, activities, lapTimesMs,
  );

  // ── Clean stationary periods from pace & power (keep HR) ───────────────────
  // If the runner stops moving but leaves the watch on, pace/power flatline at
  // meaningless values. Detect no-movement windows from GPS and drop pace/power
  // there. HR is kept (a recovering heart rate is real data).
  const distSegsForStill = (distRaw as any[]).map((s: any) => ({
    t0: new Date(toISOStr(s.startDate)).getTime() - startMs,
    t1: new Date(toISOStr(s.endDate)).getTime()   - startMs,
    m:  s.quantity as number,
  }));
  const seriesEndMs = Math.max(
    0,
    ...power.map(p => p.t),
    ...pace.map(p => p.t),
  );
  const stationary = computeStationaryIntervals(distSegsForStill, seriesEndMs);
  const inStill = (t: number) => stationary.some(iv => t >= iv.s && t <= iv.e);
  const paceClean  = stationary.length > 0 ? pace.filter(p => !inStill(p.t))  : pace;
  const powerClean = stationary.length > 0 ? power.filter(p => !inStill(p.t)) : power;

  return { hr, power: powerClean, pace: paceClean, totalMs: durationSec * 1000, activities, kmSplits, pauseIntervals: pauseIntervs, weatherTempC: extractWeatherTempC(workout), debugUuids, debugEvents };
}

// ─── Daily active energy (the basis for strain + training load) ───────────────

/**
 * Daily total active energy burned (kcal) — captures ALL movement (walking,
 * running, every workout, general activity), which is what we use as the daily
 * "strain volume" feeding both the strain rings and the CTL/ATL model.
 * Returns a Map of YYYY-MM-DD → kcal.
 */
async function fetchDailyActiveEnergy(fromDate: Date, toDate: Date): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const anchor = new Date(fromDate); anchor.setHours(0, 0, 0, 0);
  // Native side uses ISO8601DateFormatter, which REJECTS fractional seconds.
  // Date.toISOString() emits ".000Z" → strip the milliseconds or the call throws.
  const anchorStr = anchor.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const buckets = await safeQuery(
    () => (HealthKit as any).queryStatisticsCollectionForQuantity(
      HKQuantityTypeIdentifier.activeEnergyBurned,
      ['cumulativeSum'],
      anchorStr,
      { day: 1 },
      { filter: { startDate: fromDate, endDate: toDate }, unit: 'kcal' },
    ),
    [] as any[],
  );
  // The cumulativeSum response carries no date field, but enumerateStatistics
  // returns one bucket per day in chronological order starting at the anchor
  // (= fromDate midnight). So date each bucket by its index.
  (buckets as any[]).forEach((b, i) => {
    const kcal = b?.sumQuantity?.quantity ?? 0;
    if (kcal > 0) {
      const d = new Date(anchor);
      d.setDate(d.getDate() + i);
      map.set(toDateStr(d.toISOString()), Math.round(kcal));
    }
  });
  return map;
}

// ─── History query helpers (used by history screen) ───────────────────────────

/**
 * Training-load history (CTL/ATL/TSB) for the dedicated viewer.
 * Fetches ALL workouts in [from − 42d warmup, to] so CTL is accurate, then
 * returns the daily series for the requested visible window only.
 */
export async function fetchTrainingLoadHistory(
  months: number,
  toDate?: Date,
): Promise<DailyLoad[]> {
  const end      = toDate ?? new Date();
  const fromDate = new Date(end.getTime() - months * 30 * 86_400_000);
  const warmFrom = new Date(fromDate.getTime() - 42 * 86_400_000); // 42d CTL warmup

  // Daily active energy → load (× scale). Captures ALL movement, not just runs.
  const kcalByDay = await fetchDailyActiveEnergy(warmFrom, end);
  const loadByDay = new Map<string, number>();
  for (const [day, kcal] of kcalByDay) loadByDay.set(day, kcal * STRAIN_KCAL_TO_LOAD);
  return computeTrainingLoadSeries(loadByDay, fromDate, end);
}

/**
 * Daily Strain history (Bevel 0-10 scale) — per-day TRIMP from 24/7 heart rate +
 * muscular load from strength workouts, log-scaled. On-demand (can be slow for 1Y
 * since it integrates raw HR across the whole period).
 */
export async function fetchStrainHistory(
  months: number,
  toDate?: Date,
): Promise<{ date: string; value: number }[]> {
  const end   = toDate ?? new Date();
  const since = new Date(end.getTime() - months * 30 * 86_400_000);

  const [hrRaw, restingRaw, workouts] = await Promise.all([
    safeQuery(() => (HealthKit.queryQuantitySamples as any)(
      HKQuantityTypeIdentifier.heartRate,
      { filter: { startDate: since, endDate: end }, unit: 'count/min', ascending: true, limit: 200_000 },
    ), [] as any[]),
    safeQuery(() => (HealthKit.queryQuantitySamples as any)(
      HKQuantityTypeIdentifier.restingHeartRate,
      { filter: { startDate: since, endDate: end }, unit: 'count/min', ascending: true, limit: 400 },
    ), [] as any[]),
    safeQuery(() => (HealthKit.queryWorkoutSamples as any)({
      filter: { startDate: since, endDate: end }, limit: 1500, ascending: true, energyUnit: 'kcal', distanceUnit: 'm',
    }), [] as any[]),
  ]);

  const hr = (hrRaw as any[]).map((s: any) => ({
    t:  new Date(toISOStr(s.startDate)).getTime(),
    hr: s.quantity as number,
    day: toDateStr(toISOStr(s.startDate)),
  }));
  if (hr.length === 0) return [];

  // restHR = median resting HR; maxHR = observed peak (looped, NOT Math.max(...spread)
  // which throws "Maximum call stack size" on the 50k–200k samples of a multi-month
  // window — that was the error on every view except 1M). Floor of 185 prevents a
  // low-activity window from clamping maxHR down and inflating the HR-reserve.
  const restVals = (restingRaw as any[]).map((s: any) => s.quantity as number).filter(v => v > 0).sort((a, b) => a - b);
  const restHR = restVals.length > 0 ? Math.round(restVals[Math.floor(restVals.length / 2)]) : 50;
  let peak = 0;
  for (const sm of hr) if (sm.hr > peak) peak = sm.hr;
  const maxHR = Math.max(185, Math.min(205, Math.round(peak)));

  // Bucket HR by day; workout windows per day (HR inside = exercise, full weight)
  const byDay = new Map<string, { t: number; hr: number }[]>();
  for (const s of hr) {
    if (!byDay.has(s.day)) byDay.set(s.day, []);
    byDay.get(s.day)!.push({ t: s.t, hr: s.hr });
  }
  const STRENGTH = new Set([20, 50]);
  const muscularByDay = new Map<string, number>();
  const windowsByDay  = new Map<string, { s: number; e: number }[]>();
  for (const w of (workouts as any[])) {
    const day = toDateStr(toISOStr(w.startDate));
    const ws  = new Date(toISOStr(w.startDate)).getTime();
    const win = { s: ws, e: ws + workoutDurationSec(w) * 1000 };
    if (!windowsByDay.has(day)) windowsByDay.set(day, []);
    windowsByDay.get(day)!.push(win);
    if (STRENGTH.has(w.workoutActivityType)) {
      muscularByDay.set(day, (muscularByDay.get(day) ?? 0) + workoutDurationSec(w) / 60);
    }
  }

  const out: { date: string; value: number }[] = [];
  for (const [day, samples] of byDay) {
    const cardio = computeStrainTrimp(samples, restHR, maxHR, windowsByDay.get(day) ?? []);
    const trimp  = cardio + (muscularByDay.get(day) ?? 0);
    const strainPct = strainFromTrimp(trimp); // 0-100 (Bevel %)
    if (strainPct > 0) out.push({ date: day, value: strainPct });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Daily Recovery-score history (0-100). Recomputes the recovery score per night
 * from nightly (sleep-weighted) RMSSD + resting HR, using the same scoring
 * function as the live card. Fetches an extra month for the rolling baseline.
 */
export async function fetchRecoveryHistory(
  months: number,
  toDate?: Date,
): Promise<{ date: string; value: number }[]> {
  const end       = toDate ?? new Date();
  const fromKey   = toDateStr(new Date(end.getTime() - months * 30 * 86_400_000).toISOString());

  const [hrv, rhr] = await Promise.all([
    fetchHRVHistory(months + 1, end),        // nightly weighted RMSSD
    fetchRestingHRHistory(months + 1, end),  // Apple resting HR (overnight proxy)
  ]);
  if (hrv.length === 0) return [];

  const rhrByDate = new Map<string, number>();
  for (const r of rhr) rhrByDate.set(r.date, r.value);

  const nightly: NightlyHRV[] = hrv
    .map(h => ({ date: h.date, weightedRMSSD: h.value, overnightHR: rhrByDate.get(h.date) ?? 0, samples: [] }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const out: { date: string; value: number }[] = [];
  for (let i = 0; i < nightly.length; i++) {
    if (nightly[i].date < fromKey) continue;
    const { score } = computeRecoveryScore(nightly[i].weightedRMSSD, nightly[i].overnightHR, nightly.slice(0, i));
    if (score > 0) out.push({ date: nightly[i].date, value: score });
  }
  return out;
}

export async function fetchWeeklyMileageHistory(months: number, toDate?: Date): Promise<WeeklyMileage[]> {
  const endDate = toDate ?? new Date();
  const since   = new Date(endDate.getTime() - months * 30 * 86_400_000);
  const sinceMs = since.getTime();
  const endMs   = endDate.getTime();
  const allWorkouts: any[] = await (HealthKit.queryWorkoutSamples as any)({
    filter: { startDate: since, endDate: endDate },
    limit: 1000,
    ascending: false,
    energyUnit: 'kcal',
    distanceUnit: 'm',
  });
  const runs = allWorkouts
    .filter((w: any) => {
      const t = new Date(toISOStr(w.startDate)).getTime();
      return w.workoutActivityType === HK_WORKOUT_RUNNING && t >= sinceMs && t <= endMs;
    })
    .map((w: any) => ({
      uuid:     w.uuid,
      date:     toISOStr(w.startDate),
      distance: (w.totalDistance?.quantity ?? 0) as number,
      duration: 0, pace: 0, calories: 0,
    })) as RunWorkout[];
  return computeWeeklyMileage(runs);
}

/**
 * Daily running distance for the 1M view — one entry per day that has a run.
 */
export async function fetchDailyMileageHistory(toDate?: Date): Promise<{ date: string; value: number }[]> {
  const endDate = toDate ?? new Date();
  const since   = new Date(endDate.getTime() - 31 * 86_400_000);
  const allWorkouts: any[] = await (HealthKit.queryWorkoutSamples as any)({
    filter: { startDate: since, endDate: endDate },
    limit: 1000,
    ascending: true,
    energyUnit: 'kcal',
    distanceUnit: 'm',
  });
  // Sum distance per calendar day
  const byDay: Record<string, number> = {};
  allWorkouts
    .filter((w: any) => w.workoutActivityType === HK_WORKOUT_RUNNING)
    .forEach((w: any) => {
      const day = toISOStr(w.startDate).slice(0, 10);
      byDay[day] = (byDay[day] ?? 0) + ((w.totalDistance?.quantity ?? 0) as number);
    });
  return Object.entries(byDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, metres]) => ({ date, value: Math.round(metres / 10) / 100 })); // km, 2dp
}

/**
 * Weekly total time-on-feet (minutes) for N months.
 * Mirrors fetchWeeklyMileageHistory but sums workout duration instead of distance.
 */
export async function fetchWeeklyDurationHistory(months: number, toDate?: Date): Promise<{ date: string; value: number }[]> {
  const endDate = toDate ?? new Date();
  const since   = new Date(endDate.getTime() - months * 30 * 86_400_000);
  const sinceMs = since.getTime();
  const endMs   = endDate.getTime();
  const allWorkouts: any[] = await (HealthKit.queryWorkoutSamples as any)({
    filter: { startDate: since, endDate: endDate },
    limit: 1000, ascending: true, energyUnit: 'kcal', distanceUnit: 'm',
  });
  const runs = (allWorkouts as any[]).filter((w: any) => {
    const t = new Date(toISOStr(w.startDate)).getTime();
    return w.workoutActivityType === HK_WORKOUT_RUNNING && t >= sinceMs && t <= endMs;
  });
  // Group by Monday of week
  const byWeek: Record<string, number> = {};
  runs.forEach((w: any) => {
    const d    = new Date(toISOStr(w.startDate));
    const diff = (d.getDay() + 6) % 7;
    const mon  = new Date(d);
    mon.setDate(d.getDate() - diff);
    mon.setHours(0, 0, 0, 0);
    // Use local date components to avoid UTC midnight shift (toISOString is always UTC)
    const padW = (n: number) => String(n).padStart(2, '0');
    const key  = `${mon.getFullYear()}-${padW(mon.getMonth() + 1)}-${padW(mon.getDate())}`;
    const dur = typeof w.duration === 'object' && w.duration !== null
      ? (w.duration.quantity as number) ?? 0 : (w.duration as number) ?? 0;
    byWeek[key] = (byWeek[key] ?? 0) + dur;
  });
  return Object.entries(byWeek)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, secs]) => ({ date, value: Math.round(secs / 60) })); // → minutes
}

/**
 * Daily time-on-feet (minutes) for the last ~31 days.
 * Mirrors fetchDailyMileageHistory but returns duration.
 */
export async function fetchDailyDurationHistory(toDate?: Date): Promise<{ date: string; value: number }[]> {
  const endDate = toDate ?? new Date();
  const since   = new Date(endDate.getTime() - 31 * 86_400_000);
  const allWorkouts: any[] = await (HealthKit.queryWorkoutSamples as any)({
    filter: { startDate: since, endDate: endDate },
    limit: 1000, ascending: true, energyUnit: 'kcal', distanceUnit: 'm',
  });
  const byDay: Record<string, number> = {};
  (allWorkouts as any[])
    .filter((w: any) => w.workoutActivityType === HK_WORKOUT_RUNNING)
    .forEach((w: any) => {
      const day = toISOStr(w.startDate).slice(0, 10);
      const dur = typeof w.duration === 'object' && w.duration !== null
        ? (w.duration.quantity as number) ?? 0 : (w.duration as number) ?? 0;
      byDay[day] = (byDay[day] ?? 0) + dur;
    });
  return Object.entries(byDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, secs]) => ({ date, value: Math.round(secs / 60) })); // → minutes
}

export async function fetchVO2MaxHistory(months: number, toDate?: Date): Promise<{ date: string; value: number }[]> {
  const endDate = toDate ?? new Date();
  const since   = new Date(endDate.getTime() - months * 30 * 86_400_000);
  const samples = await safeQuery(
    () => (HealthKit.queryQuantitySamples as any)(
      HKQuantityTypeIdentifier.vo2Max,
      { filter: { startDate: since, endDate: endDate }, unit: 'mL/kg·min', ascending: true, limit: 200 }
    ),
    [] as any[]
  );
  return (samples as any[]).map((s: any) => ({
    date:  toISOStr(s.startDate),
    value: Math.round(s.quantity * 10) / 10,
  }));
}

export async function fetchRestingHRHistory(months: number, toDate?: Date): Promise<{ date: string; value: number }[]> {
  const endDate = toDate ?? new Date();
  const since   = new Date(endDate.getTime() - months * 30 * 86_400_000);
  const samples = await safeQuery(
    () => (HealthKit.queryQuantitySamples as any)(
      HKQuantityTypeIdentifier.restingHeartRate,
      { filter: { startDate: since, endDate: endDate }, unit: 'count/min', ascending: true, limit: 500 }
    ),
    [] as any[]
  );
  return (samples as any[]).map((s: any) => ({
    date:  toISOStr(s.startDate),
    value: Math.round(s.quantity),
  }));
}

/**
 * Nightly HRV history using sleep-session-based averaging.
 * Mirrors the main snapshot logic: groups sleep samples into sessions,
 * then applies computeWeightedRMSSD per session with heartbeat quality filtering.
 */
export async function fetchHRVHistory(months: number, toDate?: Date): Promise<{ date: string; value: number }[]> {
  const endDate = toDate ?? new Date();
  const since   = new Date(endDate.getTime() - months * 30 * 86_400_000);

  const [sleepSamples, hrvRaw, hbsRaw] = await Promise.all([
    safeQuery(
      () => (HealthKit.queryCategorySamples as any)(
        HKCategoryTypeIdentifier.sleepAnalysis,
        { filter: { startDate: since, endDate: endDate }, ascending: true, limit: 5000 }
      ),
      [] as any[]
    ),
    (HealthKit.queryQuantitySamples as any)(
      HKQuantityTypeIdentifier.heartRateVariabilitySDNN,
      { filter: { startDate: since, endDate: endDate }, unit: 'ms', ascending: true, limit: 100_000 }
    ).catch(() => [] as any[]),
    safeQuery(
      () => (HealthKit as any).queryHeartbeatSeriesSamples({
        filter: { startDate: since, endDate: endDate },
        limit: 100_000,
      }),
      [] as any[]
    ),
  ]);

  const sessions = groupIntoSessions(
    (sleepSamples as any[]).map((s: any) => ({
      startDate: s.startDate,
      endDate:   s.endDate,
      value:     s.value as number,
    }))
  );

  const normHRV = (hrvRaw as any[]).map((s: any) => ({
    startDate: toISOStr(s.startDate),
    quantity:  s.quantity as number,
  }));
  const qualityMap = buildHeartbeatQualityMap(hbsRaw as any[]);

  const results: { date: string; value: number }[] = [];
  for (const session of sessions) {
    const { weightedRMSSD } = computeWeightedRMSSD(session, normHRV, qualityMap);
    if (weightedRMSSD > 0) {
      results.push({ date: session.date, value: Math.round(weightedRMSSD) });
    }
  }

  return results.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Overnight HR dip history.
 * For each night, computes: (filteredDaytimeHR - overnightHR) / filteredDaytimeHR × 100
 *
 * "Filtered daytime HR" = average HR from the previous night's wake time to 30 min
 * before this night's bedtime (the actual waking day), excluding samples > 100 bpm.
 * "Overnight HR" = average HR during actual sleep segments (excluding awake periods).
 *
 * Each session query covers bedtime-14h → wakeTime so a single fetch gets both
 * daytime and overnight samples without an extra API call per night.
 *
 * Returns one reading per night (oldest → newest), only when both HR sets are available.
 */
export interface HRStageStats {
  stage:  string;
  n:      number;
  min:    number;
  max:    number;
  mean:   number;
  p25:    number;
  median: number;
  p75:    number;
}

export interface OvernightHRDebug {
  // Per-stage breakdown
  stageStats:   HRStageStats[];
  // All overnight-HR computation variants (bpm)
  rawMean:      number;   // all non-awake, plain mean
  rawMedian:    number;   // all non-awake, median
  rawP75:       number;   // all non-awake, trim top 25%
  deepRemMean:  number;   // deep+REM only, plain mean
  perStageTrim: number;   // per-stage 75th-pct trim then pool
  appleRHR:     number | null;
  // Daytime detail
  daytimeMin:   number;
  daytimeMax:   number;
  // Sleep session summary
  bedtime:      string;
  wakeTime:     string;
  totalMin:     number;
  deepMin:      number;
  remMin:       number;
  coreMin:      number;
  awakeMin:     number;
}

export interface OvernightHREntry {
  date:            string;
  value:           number;  // dip % using current algorithm
  daytimeHR:       number;  // filtered avg bpm (waking hours, ≤100 bpm)
  overnightHR:     number;  // avg bpm during sleep segments
  daytimeSamples:  number;  // # samples used for daytime avg
  overnightSamples:number;  // # samples used for overnight avg
  dayWindowStart:  string;  // ISO — start of daytime query window
  dayWindowEnd:    string;  // ISO — end of daytime query window (= bedtime − 1h)
  debug:           OvernightHRDebug;
}

export async function fetchOvernightHRHistory(
  months: number,
  toDate?: Date,
): Promise<OvernightHREntry[]> {
  const endDate = toDate ?? new Date();
  const since   = new Date(endDate.getTime() - months * 30 * 86_400_000);

  // 1. Fetch sleep sessions
  const rawSleep = await safeQuery(
    () => (HealthKit.queryCategorySamples as any)(
      HKCategoryTypeIdentifier.sleepAnalysis,
      { filter: { startDate: since, endDate: endDate }, ascending: true, limit: 10_000 }
    ),
    [] as any[]
  );

  const sessions = groupIntoSessions(
    (rawSleep as any[]).map((s: any) => ({
      startDate: s.startDate, endDate: s.endDate, value: s.value as number,
    }))
  );

  if (sessions.length === 0) return [];

  // 2. Fetch Apple's computed daily Resting Heart Rate for the whole range.
  //    Apple's RHR algorithm selects the lowest sustained stillness periods (mostly
  //    during sleep), giving a value 2–5 bpm lower than a raw overnight average.
  //    Bevel appears to use this metric for its "Sleeping HR" figure.
  const rhrRaw = await safeQuery(
    () => (HealthKit.queryQuantitySamples as any)(
      HKQuantityTypeIdentifier.restingHeartRate,
      { filter: { startDate: since, endDate: endDate }, unit: 'count/min', ascending: true, limit: 1000 }
    ),
    [] as any[]
  );
  // Index by calendar date (YYYY-MM-DD).  A sleep session dated "2026-04-18" woke on
  // that date, so we look for an RHR reading on either the wake date or the next day
  // (Apple sometimes logs it a day ahead).
  const rhrByDate = new Map<string, number>();
  (rhrRaw as any[]).forEach((s: any) => {
    const date = toISOStr(s.startDate).substring(0, 10);
    const val  = s.quantity as number;
    if (!rhrByDate.has(date) || val < rhrByDate.get(date)!) {
      rhrByDate.set(date, val);
    }
  });

  // 3. Per-session HR queries (daytime only now), batched 10 at a time.
  //    Daytime window = previous session's wakeTime → this session's bedtime − 30 min.
  //    (Actual waking hours — no hardcoded offsets needed.)
  //    Fallback for the first session (no previous): bedtime − 16 h.
  const results: OvernightHREntry[] = [];
  const BATCH = 10;

  for (let i = 0; i < sessions.length; i += BATCH) {
    const batch = sessions.slice(i, i + BATCH);
    const hrResults = await Promise.all(
      batch.map((session, j) => {
        const globalIdx  = i + j;
        const prevWake   = globalIdx > 0
          ? new Date(sessions[globalIdx - 1].wakeTime)
          : new Date(new Date(session.bedtime).getTime() - 16 * 3_600_000);
        const queryStart = prevWake;
        const queryEnd   = new Date(session.wakeTime);
        return safeQuery(
          () => (HealthKit.queryQuantitySamples as any)(
            HKQuantityTypeIdentifier.heartRate,
            { filter: { startDate: queryStart, endDate: queryEnd }, unit: 'count/min', limit: 1000 }
          ),
          [] as any[]
        );
      })
    );

    batch.forEach((session, j) => {
      const globalIdx    = i + j;
      const prevWake     = globalIdx > 0
        ? new Date(sessions[globalIdx - 1].wakeTime)
        : new Date(new Date(session.bedtime).getTime() - 16 * 3_600_000);
      const bedtimeMs    = new Date(session.bedtime).getTime();
      const daytimeStartMs = prevWake.getTime();
      const daytimeEndMs   = bedtimeMs - 30 * 60_000; // 30 min before sleep onset

      const allSamples = (hrResults[j] as any[]).map((s: any) => ({
        t:        new Date(toISOStr(s.startDate)).getTime(),
        quantity: s.quantity as number,
      }));

      // Daytime: from (bedtime − 14h) to (bedtime − 1h), filter out exercise (>100 bpm)
      const daytimeVals = allSamples
        .filter(s => s.t >= daytimeStartMs && s.t < daytimeEndMs && s.quantity >= 40 && s.quantity <= 100)
        .map(s => s.quantity);

      if (daytimeVals.length < 3) return;

      // ── Daytime ──────────────────────────────────────────────────────────────
      const daytimeHR  = daytimeVals.reduce((a, b) => a + b, 0) / daytimeVals.length;
      const daytimeSorted = [...daytimeVals].sort((a, b) => a - b);
      const daytimeMin = daytimeSorted[0];
      const daytimeMax = daytimeSorted[daytimeSorted.length - 1];

      // ── Overnight: group samples by sleep stage ───────────────────────────────
      const allStages = ['deep', 'rem', 'core', 'asleepUnspecified', 'asleepREM',
                         'asleepCore', 'asleepDeep'] as const;
      const stageBuckets: Record<string, number[]> = {};
      const sleepSegs = session.segments.filter(
        (seg: any) => seg.stage !== 'awake' && seg.stage !== 'inBed'
      );
      allSamples.forEach(s => {
        const seg = sleepSegs.find((sg: any) => {
          const ss = new Date(sg.startDate).getTime();
          const se = new Date(sg.endDate).getTime();
          return s.t >= ss && s.t <= se;
        });
        if (!seg) return;
        const st = (seg as any).stage as string;
        if (!stageBuckets[st]) stageBuckets[st] = [];
        stageBuckets[st].push(s.quantity);
      });

      const allOvernightVals = Object.values(stageBuckets).flat();
      if (allOvernightVals.length === 0) return;

      // Helper: percentile of a SORTED array
      const pct = (sorted: number[], p: number) => {
        const idx = Math.floor(sorted.length * p);
        return sorted[Math.min(idx, sorted.length - 1)];
      };
      const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

      // ── Compute all overnight HR variants ─────────────────────────────────────
      const allSorted = [...allOvernightVals].sort((a, b) => a - b);
      const midIdx    = Math.floor(allSorted.length / 2);

      const rawMean   = mean(allOvernightVals);
      const rawMedian = allSorted.length % 2 === 1
        ? allSorted[midIdx]
        : (allSorted[midIdx - 1] + allSorted[midIdx]) / 2;
      const rawP75    = mean(allSorted.slice(0, Math.ceil(allSorted.length * 0.75)));

      const deepRemVals = [
        ...(stageBuckets['deep'] ?? []),
        ...(stageBuckets['rem']  ?? []),
        ...(stageBuckets['asleepDeep'] ?? []),
        ...(stageBuckets['asleepREM']  ?? []),
      ];
      const deepRemMean = deepRemVals.length > 0 ? mean(deepRemVals) : rawMean;

      const pool: number[] = [];
      Object.values(stageBuckets).forEach(vals => {
        const s = [...vals].sort((a, b) => a - b);
        pool.push(...s.slice(0, Math.ceil(s.length * 0.75)));
      });
      const perStageTrim = mean(pool);

      // ── Apple RHR ────────────────────────────────────────────────────────────
      const wakeDate  = new Date(session.wakeTime).toISOString().substring(0, 10);
      const appleRHR  = rhrByDate.get(wakeDate) ?? rhrByDate.get(session.date) ?? null;

      // ── Current algorithm: plain mean of all non-awake stages ─────────────────
      // (best approximation until we confirm Bevel's exact formula)
      const overnightHR      = rawMean;
      const overnightSamples = allOvernightVals.length;

      // ── Per-stage stats for debug screen ─────────────────────────────────────
      const stageStats: HRStageStats[] = Object.entries(stageBuckets).map(([stage, vals]) => {
        const s  = [...vals].sort((a, b) => a - b);
        const n  = s.length;
        const midI = Math.floor(n / 2);
        return {
          stage,
          n,
          min:    Math.round(s[0] * 10) / 10,
          max:    Math.round(s[n - 1] * 10) / 10,
          mean:   Math.round(mean(s) * 10) / 10,
          p25:    Math.round(pct(s, 0.25) * 10) / 10,
          median: Math.round((n % 2 === 1 ? s[midI] : (s[midI - 1] + s[midI]) / 2) * 10) / 10,
          p75:    Math.round(pct(s, 0.75) * 10) / 10,
        };
      });

      const r = (n: number) => Math.round(n * 10) / 10;
      const dipPct = r(((daytimeHR - overnightHR) / daytimeHR) * 100);

      results.push({
        date:             session.date,
        value:            dipPct,
        daytimeHR:        r(daytimeHR),
        overnightHR:      r(overnightHR),
        daytimeSamples:   daytimeVals.length,
        overnightSamples,
        dayWindowStart:   new Date(daytimeStartMs).toISOString(),
        dayWindowEnd:     new Date(daytimeEndMs).toISOString(),
        debug: {
          stageStats,
          rawMean:      r(rawMean),
          rawMedian:    r(rawMedian),
          rawP75:       r(rawP75),
          deepRemMean:  r(deepRemMean),
          perStageTrim: r(perStageTrim),
          appleRHR:     appleRHR !== null ? r(appleRHR) : null,
          daytimeMin,
          daytimeMax,
          bedtime:   session.bedtime,
          wakeTime:  session.wakeTime,
          totalMin:  session.totalMinutes,
          deepMin:   session.deepMinutes,
          remMin:    session.remMinutes,
          coreMin:   session.totalMinutes - session.deepMinutes - session.remMinutes,
          awakeMin:  session.awakeMinutes,
        },
      });
    });
  }

  return results.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Fetch sleep sessions for a historical range.
 * Reuses the same groupIntoSessions() logic as the main snapshot.
 * Returns one SleepSession per night (sorted oldest → newest).
 */
export async function fetchSleepHistory(months: number, toDate?: Date): Promise<SleepSession[]> {
  const endDate = toDate ?? new Date();
  const since   = new Date(endDate.getTime() - months * 30 * 86_400_000);

  const rawSamples = await safeQuery(
    () => (HealthKit.queryCategorySamples as any)(
      HKCategoryTypeIdentifier.sleepAnalysis,
      { filter: { startDate: since, endDate: endDate }, ascending: true, limit: 10000 }
    ),
    [] as any[]
  );

  const sessions = groupIntoSessions(
    (rawSamples as any[]).map((s: any) => ({
      startDate: s.startDate,
      endDate:   s.endDate,
      value:     s.value as number,
    }))
  );

  return sessions.sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Sleep biometrics (for recovery calibration) ──────────────────────────────

/**
 * Per-night biometrics captured during the sleep window only:
 * HRV (weighted RMSSD), HR (mean non-awake), SpO2 (mean), and HR dip.
 * Used by the calibration screen to validate the recovery score.
 */
export interface SleepBiometrics {
  date:            string;
  hrv:             number;   // simple mean RMSSD ms (non-awake, quality-filtered) — 0 if unavailable
  overnightHR:     number;   // mean HR during non-awake sleep stages
  spO2:            number;   // mean blood oxygen % during sleep — 0 if unavailable
  respiratoryRate: number;   // mean breaths/min during sleep — 0 if unavailable
  hrDipPct:        number;   // (daytimeHR − overnightHR) / daytimeHR × 100
  daytimeHR:       number;   // filtered mean HR during waking hours
  // debug
  hrvRaw:          number;   // HRV before quality filtering
  hrvSeriesCount:  number;   // number of heartbeat series found (0 = quality filter inactive)
  hrvExcluded:     number;   // number of HRV samples excluded by quality filter
}

export async function fetchSleepBiometrics(
  months: number,
  toDate?: Date,
): Promise<SleepBiometrics[]> {
  const endDate = toDate ?? new Date();
  const since   = new Date(endDate.getTime() - months * 30 * 86_400_000);

  // 1. Sleep sessions
  const rawSleep = await safeQuery(
    () => (HealthKit.queryCategorySamples as any)(
      HKCategoryTypeIdentifier.sleepAnalysis,
      { filter: { startDate: since, endDate: endDate }, ascending: true, limit: 10_000 }
    ),
    [] as any[]
  );
  const sessions = groupIntoSessions(
    (rawSleep as any[]).map((s: any) => ({
      startDate: s.startDate, endDate: s.endDate, value: s.value as number,
    }))
  );
  if (sessions.length === 0) return [];

  // 2. Fetch HRV, HR, SpO2, and respiratory rate for each session — batched 10 at a time
  const BATCH = 10;
  const results: SleepBiometrics[] = [];

  for (let i = 0; i < sessions.length; i += BATCH) {
    const batch = sessions.slice(i, i + BATCH);

    const [hrResults, hrvResults, spo2Results, rrResults, hbsResults] = await Promise.all([
      Promise.all(batch.map((session, j) => {
        const globalIdx  = i + j;
        const prevWake   = globalIdx > 0
          ? new Date(sessions[globalIdx - 1].wakeTime)
          : new Date(new Date(session.bedtime).getTime() - 16 * 3_600_000);
        return safeQuery(
          () => (HealthKit.queryQuantitySamples as any)(
            HKQuantityTypeIdentifier.heartRate,
            { filter: { startDate: prevWake, endDate: new Date(session.wakeTime) }, unit: 'count/min', limit: 1000 }
          ),
          [] as any[]
        );
      })),
      Promise.all(batch.map(session =>
        safeQuery(
          () => (HealthKit.queryQuantitySamples as any)(
            HKQuantityTypeIdentifier.heartRateVariabilitySDNN,
            { filter: { startDate: new Date(session.bedtime), endDate: new Date(session.wakeTime) }, unit: 'ms', limit: 500 }
          ),
          [] as any[]
        )
      )),
      Promise.all(batch.map(session =>
        safeQuery(
          () => (HealthKit.queryQuantitySamples as any)(
            HKQuantityTypeIdentifier.oxygenSaturation,
            { filter: { startDate: new Date(session.bedtime), endDate: new Date(session.wakeTime) }, unit: '%', limit: 500 }
          ),
          [] as any[]
        )
      )),
      Promise.all(batch.map(session =>
        safeQuery(
          () => (HealthKit.queryQuantitySamples as any)(
            HKQuantityTypeIdentifier.respiratoryRate,
            { filter: { startDate: new Date(session.bedtime), endDate: new Date(session.wakeTime) }, unit: 'count/min', limit: 500 }
          ),
          [] as any[]
        )
      )),
      // Heartbeat series: raw R-R intervals for HRV quality filtering
      Promise.all(batch.map(session =>
        safeQuery(
          () => (HealthKit as any).queryHeartbeatSeriesSamples({
            filter: { startDate: new Date(session.bedtime), endDate: new Date(session.wakeTime) },
            limit: 500,
          }),
          [] as any[]
        )
      )),
    ]);

    batch.forEach((session, j) => {
      const globalIdx    = i + j;
      const prevWake     = globalIdx > 0
        ? new Date(sessions[globalIdx - 1].wakeTime)
        : new Date(new Date(session.bedtime).getTime() - 16 * 3_600_000);
      const bedtimeMs    = new Date(session.bedtime).getTime();
      const daytimeEndMs = bedtimeMs - 30 * 60_000;

      // ── HR: split into daytime and overnight ─────────────────────────────────
      const allHR = (hrResults[j] as any[]).map((s: any) => ({
        t:  new Date(toISOStr(s.startDate)).getTime(),
        bpm: s.quantity as number,
      }));

      const daytimeVals = allHR
        .filter(s => s.t >= prevWake.getTime() && s.t < daytimeEndMs && s.bpm >= 40 && s.bpm <= 100)
        .map(s => s.bpm);

      const sleepSegs = session.segments.filter(
        (seg: any) => seg.stage !== 'awake' && seg.stage !== 'inBed'
      );
      const nightVals = allHR
        .filter(s => sleepSegs.some((seg: any) => {
          const ss = new Date(seg.startDate).getTime();
          const se = new Date(seg.endDate).getTime();
          return s.t >= ss && s.t <= se;
        }))
        .map(s => s.bpm);

      const daytimeHR   = daytimeVals.length > 0
        ? daytimeVals.reduce((a, b) => a + b, 0) / daytimeVals.length : 0;
      const overnightHR = nightVals.length > 0
        ? nightVals.reduce((a, b) => a + b, 0) / nightVals.length : 0;
      const hrDipPct    = daytimeHR > 0 && overnightHR > 0
        ? Math.round(((daytimeHR - overnightHR) / daytimeHR) * 1000) / 10 : 0;

      // ── HRV: simple mean during sleep, quality-filtered via heartbeat series ──
      const hrvNorm = (hrvResults[j] as any[]).map((s: any) => ({
        startDate: toISOStr(s.startDate),
        quantity:  s.quantity as number,
      }));
      const sessionQualityMap = buildHeartbeatQualityMap(hbsResults[j] as any[]);
      const { weightedRMSSD, excluded: hrvExcluded, total: hrvTotal } = computeWeightedRMSSD(session, hrvNorm, sessionQualityMap);
      const hrvSeriesCount = (hbsResults[j] as any[]).length;

      // ── SpO2: mean during sleep ───────────────────────────────────────────────
      const spo2Vals = (spo2Results[j] as any[]).map((s: any) => s.quantity as number);
      // HealthKit returns SpO2 as a fraction (0-1) or percent — normalise to %
      const spo2Raw  = spo2Vals.length > 0
        ? spo2Vals.reduce((a, b) => a + b, 0) / spo2Vals.length : 0;
      const spO2     = spo2Raw > 1 ? Math.round(spo2Raw * 10) / 10  // already %
                     : spo2Raw > 0 ? Math.round(spo2Raw * 1000) / 10 // fraction → %
                     : 0;

      // ── Respiratory rate: mean during sleep ──────────────────────────────────
      const rrVals = (rrResults[j] as any[]).map((s: any) => s.quantity as number);
      const respiratoryRate = rrVals.length > 0
        ? Math.round((rrVals.reduce((a, b) => a + b, 0) / rrVals.length) * 10) / 10 : 0;

      if (daytimeVals.length < 3 && nightVals.length === 0 && weightedRMSSD === 0 && spO2 === 0) return;

      // HRV without quality filter (for comparison in debug)
      const { weightedRMSSD: rawHRV } = computeWeightedRMSSD(session, hrvNorm);

      results.push({
        date:            session.date,
        hrv:             Math.round(weightedRMSSD * 10) / 10,
        overnightHR:     Math.round(overnightHR * 10) / 10,
        spO2,
        respiratoryRate,
        hrDipPct,
        daytimeHR:       Math.round(daytimeHR * 10) / 10,
        hrvRaw:          Math.round(rawHRV * 10) / 10,
        hrvSeriesCount,
        hrvExcluded,
      });
    });
  }

  return results.sort((a, b) => a.date.localeCompare(b.date));
}

function computeWeeklyMileage(runs: RunWorkout[]): WeeklyMileage[] {
  const weeks: Record<string, number> = {};
  runs.forEach((run) => {
    const date   = new Date(run.date);
    const monday = new Date(date);
    monday.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    const key = monday.toISOString().split('T')[0];
    weeks[key] = (weeks[key] ?? 0) + run.distance / METERS_PER_KM;
  });
  return Object.entries(weeks)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, km]) => ({ week, km: Math.round(km * 10) / 10 }));
}
