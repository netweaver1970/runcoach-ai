import HealthKit from '@kingstinct/react-native-healthkit';
import * as FileSystem from 'expo-file-system';

// In @kingstinct/react-native-healthkit v9, the enums are TypeScript-only types
// (their JS files export {}). The native NitroModules bridge expects the full
// Apple HealthKit identifier strings (e.g. "HKQuantityTypeIdentifierHeartRate").
const HKQuantityTypeIdentifier = {
  heartRate:                   'HKQuantityTypeIdentifierHeartRate',
  heartRateVariabilitySDNN:    'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
  restingHeartRate:            'HKQuantityTypeIdentifierRestingHeartRate',
  vo2Max:                      'HKQuantityTypeIdentifierVO2Max',
  distanceWalkingRunning:      'HKQuantityTypeIdentifierDistanceWalkingRunning',
  bodyMass:                    'HKQuantityTypeIdentifierBodyMass',
  runningPower:                'HKQuantityTypeIdentifierRunningPower',
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
} from '../types';
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
      'HKQuantityTypeIdentifierVO2Max',
      'HKQuantityTypeIdentifierDistanceWalkingRunning',
      'HKQuantityTypeIdentifierBodyMass',
      'HKQuantityTypeIdentifierRunningPower',
      // Category types
      'HKCategoryTypeIdentifierSleepAnalysis',
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

// ─── HRV weighted average ─────────────────────────────────────────────────────

function computeWeightedRMSSD(
  session: SleepSession,
  hrvSamples: { startDate: string; quantity: number }[]
): { weightedRMSSD: number; annotatedSamples: NightlyHRV['samples'] } {
  if (hrvSamples.length === 0) return { weightedRMSSD: 0, annotatedSamples: [] };

  // Primary window: bedtime ±90 min → wakeTime +60 min
  // (Apple Watch sometimes records HRV slightly before/after the strict sleep window)
  const PRIMARY_BEFORE = 90 * 60 * 1000;
  const PRIMARY_AFTER  = 60 * 60 * 1000;
  const sessionStart = new Date(session.bedtime).getTime() - PRIMARY_BEFORE;
  const sessionEnd   = new Date(session.wakeTime).getTime() + PRIMARY_AFTER;

  let nightSamples = hrvSamples.filter((s) => {
    const t = new Date(s.startDate).getTime();
    return t >= sessionStart && t <= sessionEnd;
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
      return t >= nightStart && t <= nightEnd;
    });
  }

  if (nightSamples.length === 0) {
    return { weightedRMSSD: 0, annotatedSamples: [] };
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

  let weightedSum = 0;
  let totalWeight = 0;
  let unweightedSum = 0;
  annotatedSamples.forEach(({ rmssd, stage }) => {
    const w = STAGE_WEIGHT[stage];
    unweightedSum += rmssd;
    if (w > 0) {
      weightedSum += rmssd * w;
      totalWeight += w;
    }
  });

  // If all samples have weight 0 (e.g. all marked as awake/inBed), use simple average
  const weightedRMSSD = totalWeight > 0
    ? Math.round((weightedSum / totalWeight) * 10) / 10
    : Math.round((unweightedSum / annotatedSamples.length) * 10) / 10;

  return { weightedRMSSD, annotatedSamples };
}

// ─── Overnight resting HR ─────────────────────────────────────────────────────

function computeOvernightHR(
  session: SleepSession,
  hrSamples: { startDate: string; quantity: number }[]
): number {
  const sessionStart = new Date(session.bedtime).getTime();
  const sessionEnd = new Date(session.wakeTime).getTime();

  const sleepSegments = session.segments.filter(
    (seg) => seg.stage !== 'awake' && seg.stage !== 'inBed'
  );

  const sleepHRValues: number[] = [];
  hrSamples.forEach((s) => {
    const t = new Date(s.startDate).getTime();
    if (t < sessionStart || t > sessionEnd) return;
    const inSleepSeg = sleepSegments.some((seg) => {
      const segStart = new Date(seg.startDate).getTime();
      const segEnd = new Date(seg.endDate).getTime();
      return t >= segStart && t <= segEnd;
    });
    if (inSleepSeg) sleepHRValues.push(s.quantity);
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
): KmSplit[] {
  if (distSegs.length === 0) return [];
  let acc = 0;
  const cum = distSegs.map(({ t, m }) => { acc += m; return { t, cumM: acc }; });
  if (acc < 1000) return [];
  const hasHR  = hrTimestampsMs.length === hrValues.length && hrValues.length > 0;
  const hasPow = powerSegs.length > 0;
  const splits: KmSplit[] = [];
  let prevT = cum[0].t;
  const nKm = Math.floor(acc / 1000);
  for (let km = 1; km <= nKm; km++) {
    const idx = cum.findIndex(c => c.cumM >= km * 1000);
    if (idx < 0) break;
    const endT = cum[idx].t;
    const durationSec = Math.max(1, (endT - prevT) / 1000);
    const paceSecs = Math.round(durationSec);
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
    splits.push({ km, paceSecs, avgHR, avgPower });
    prevT = endT;
  }
  return splits;
}

function refineWorkStatsFromSegments(segs: WorkoutSegment[]): {
  wHR: number; wPace: number; wPower: number; wDistance: number;
} | null {
  const w = segs.filter(s => s.label === 'Work');
  if (w.length === 0) return null;
  const totalDur  = w.reduce((a, s) => a + s.durationSec, 0);
  const totalDist = w.reduce((a, s) => a + s.distanceM, 0);
  if (totalDur === 0 || totalDist < 100) return null;
  const withHR  = w.filter(s => s.avgHR > 0);
  const withPwr = w.filter(s => s.avgPower > 0);
  return {
    wHR:      withHR.length  > 0 ? Math.round(withHR.reduce( (a, s) => a + s.avgHR    * s.durationSec, 0) / withHR.reduce( (a, s) => a + s.durationSec, 0)) : 0,
    wPace:    Math.round(totalDur / (totalDist / 1000)),
    wPower:   withPwr.length > 0 ? Math.round(withPwr.reduce((a, s) => a + s.avgPower * s.durationSec, 0) / withPwr.reduce((a, s) => a + s.durationSec, 0)) : 0,
    wDistance: totalDist,
  };
}

// ─── Main fetch ───────────────────────────────────────────────────────────────

export interface FetchOptions {
  /** How many months of history to load (1 | 3 | 6 | 12, default 3) */
  months?: number;
  /** Called with a human-readable step name and 0-100 progress percentage */
  onProgress?: (step: string, pct: number) => void;
}

export async function fetchHealthSnapshot(opts: FetchOptions = {}): Promise<HealthSnapshot> {
  const months = Math.max(1, Math.min(12, opts.months ?? 3));
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
    .slice(0, 80);

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
        const durationSec = Math.max(0, (aEnd - aStart) / 1000);
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
    restingHRSamples,
    rawSleepSamples,
    bodyMassKg,
    powerZones,
    runOverrides,
    longRunMinutes,
    events,
    hrUnreliableMap,
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
  ]);

  // Classify runs AFTER we have longRunMinutes
  const { runs: classifiedRuns, maxHR } = await classifyAndCacheRuns(
    rawRuns, perRunData, allNewHRValues, existingCache, longRunMinutes
  );

  // Refine work stats from structured segments + mark HR unreliable + km splits
  for (const run of classifiedRuns) {
    if (run.segments && run.segments.length > 0) {
      const refined = refineWorkStatsFromSegments(run.segments);
      if (refined !== null && refined.wHR > 0 && refined.wPace > 0) {
        run.workHR    = refined.wHR;
        run.workPace  = refined.wPace;
        if (refined.wPower > 0) run.workPower = refined.wPower;
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
      const kms = computeKmSplits(data.distSegs, data.hrValues, data.hrTimestampsMs, data.powerSegs);
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

  const nightlyHRV: NightlyHRV[] = sleepSessions.map((session) => {
    const { weightedRMSSD, annotatedSamples } = computeWeightedRMSSD(session, hrvSamplesForSleep);
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

  // Daytime HR: average of recent resting HR samples (proxy for daytime baseline)
  const daytimeHR = restingHRSamples.length > 0
    ? Math.round(
        (restingHRSamples as any[]).reduce((a: number, s: any) => a + (s.quantity as number), 0) /
        restingHRSamples.length
      )
    : 0;

  if (recentHRV && recentHRV.weightedRMSSD > 0) {
    // Full recovery score available
    const historyBefore = nightlyHRV.filter((n) => n.date < recentHRV.date);
    const { score, baseline, trend, overnightHRBaseline } = computeRecoveryScore(
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
      overnightHRBaseline,
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

  progress('Done', 100);

  return {
    runs,
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
  startMs:      number;   // ms from workout start
  endMs:        number;
  activityType: number;   // HKWorkoutActivityType numeric value
  label:        string;   // Warmup | Work | Recovery | Cooldown | Walk
  // Per-segment KPIs (from HK allStatistics — zero means unavailable)
  distanceM:    number;   // metres
  avgHR:        number;   // bpm
  avgPower:     number;   // watts (0 if no power meter)
  cadenceSPM:   number;   // steps/min (0 if unavailable)
  stepActType:  number;   // workoutConfiguration.activityType for THIS step (may differ from parent)
}

export interface WorkoutDetailData {
  hr:         { t: number; v: number }[];  // t = ms from workout start, v = bpm
  power:      { t: number; v: number }[];  // watts
  pace:       { t: number; v: number }[];  // secs/km (rolling per dist segment)
  totalMs:    number;
  activities: WorkoutActivity[];  // HealthKit structured workout activities (empty if unstructured)
  debugUuids?: string[];           // DEBUG: raw uuid tails to verify Swift patch
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

export async function fetchWorkoutDetail(
  startDate: string | Date,
  durationSec: number,
): Promise<WorkoutDetailData> {
  const startMs = new Date(toISOStr(startDate)).getTime();
  const endMs   = startMs + durationSec * 1000;
  const from    = new Date(startMs - 30_000);
  const to      = new Date(endMs   + 30_000);

  // Limits are deliberately large: a Polar H10 at 10 Hz produces up to
  // 54 000 HR samples in a 90-min run; distance GPS segments can reach
  // 10 000+.  We downsample to 1 Hz after fetching.
  const [hrRaw, distRaw, powerRaw, workoutRaw] = await Promise.all([
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
    // Fetch the workout itself to extract lap events
    safeQuery(() => (HealthKit.queryWorkoutSamples as any)({
      filter: { startDate: new Date(startMs - 5_000), endDate: new Date(startMs + 5_000) },
      limit: 5,
      ascending: true,
      energyUnit: 'kcal',
      distanceUnit: 'm',
    }), [] as any[]),
  ]);

  const clip = (t: number) => t >= -60_000 && t <= durationSec * 1000 + 60_000;

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

      const durationSec = (aEndMs - aStartMs) / 1000;
      const steps       = actStat['steps'] ?? 0;
      const cadenceSPM  = steps > 0 && durationSec > 0 ? Math.round(steps / (durationSec / 60)) : 0;
      activities.push({
        startMs:      aStartMs,
        endMs:        aEndMs,
        activityType,
        label,
        distanceM:    actStat['dist']    ?? 0,
        avgHR:        actStat['hr']      ?? 0,
        avgPower:     actStat['power']   ?? 0,
        cadenceSPM,
        stepActType:  actStat['stepAct'] ?? activityType,
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

  return { hr, power, pace, totalMs: durationSec * 1000, activities, debugUuids };
}

// ─── History query helpers (used by history screen) ───────────────────────────

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
 * Nightly HRV history using sleep-session-based weighted averaging.
 * Mirrors the main snapshot logic: groups sleep samples into sessions,
 * then applies computeWeightedRMSSD per session (deep×3, REM×2, core×1).
 */
export async function fetchHRVHistory(months: number, toDate?: Date): Promise<{ date: string; value: number }[]> {
  const endDate = toDate ?? new Date();
  const since   = new Date(endDate.getTime() - months * 30 * 86_400_000);

  const [sleepSamples, hrvRaw] = await Promise.all([
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

  const results: { date: string; value: number }[] = [];
  for (const session of sessions) {
    const { weightedRMSSD } = computeWeightedRMSSD(session, normHRV);
    if (weightedRMSSD > 0) {
      results.push({ date: session.date, value: Math.round(weightedRMSSD) });
    }
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
