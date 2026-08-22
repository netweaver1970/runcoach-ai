import HealthKit, { subscribeToChanges } from '@kingstinct/react-native-healthkit';
import * as FileSystem from 'expo-file-system';
import { requireNativeModule } from 'expo-modules-core';

// Native bridge (modules/runcoach-workout) exposing HKQuantitySeriesSampleQuery to expand
// series-stored workout HR/power that the JS library's sample query returns only sparsely.
// Guarded: null if the native module isn't in this binary (e.g. before a rebuild).
let seriesNative: { queryQuantitySeries(typeId: string, startMs: number, endMs: number): Promise<{ t: number; tEnd: number; v: number }[]> } | null = null;
try { seriesNative = requireNativeModule('RunCoachWorkout') as any; } catch { seriesNative = null; }

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
  basalEnergyBurned:           'HKQuantityTypeIdentifierBasalEnergyBurned',
  stepCount:                   'HKQuantityTypeIdentifierStepCount',
  appleExerciseTime:           'HKQuantityTypeIdentifierAppleExerciseTime',
  // Biology mode — body composition + blood pressure (read-only historical analysis)
  bloodPressureSystolic:       'HKQuantityTypeIdentifierBloodPressureSystolic',
  bloodPressureDiastolic:      'HKQuantityTypeIdentifierBloodPressureDiastolic',
  bodyFatPercentage:           'HKQuantityTypeIdentifierBodyFatPercentage',
  leanBodyMass:                'HKQuantityTypeIdentifierLeanBodyMass',
  bodyMassIndex:               'HKQuantityTypeIdentifierBodyMassIndex',
  waistCircumference:          'HKQuantityTypeIdentifierWaistCircumference',
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
  RecoveryBreakdown,
  PowerZones,
  WorkoutLabel,
  WorkoutConfidence,
  KmSplit,
  TimelineEvent,
  ActivitySummary,
  DailyLoad,
  DayStrain,
} from '../types';
import { activityName, activityFactor, computeTrainingLoadSeries, computeDayStrain, computeStrainTrimp, assessHrReliability, powerTrimp, TrimpRepair, zoneStrainLoad, zoneStrainBreakdown, strainFromLoad, stepStrainLoad, computeSleepBankSeries, advisableStrainRange, heatStrainFactor, calibrateTrimpRates, trainingDayKey, activityFloorTrimp } from './trainingLoad';
import { powerToHrrFrac } from './zones';
import { getForecastPairs } from './forecastLog';
import { getLocalWeather } from './weather';
import { computePersonalSleepGoal, computeAdjustedGoal } from './bevelCalibration';
import { prescribedPhasesAt, relabelByPhases, dateKeyLocal } from './planLog';
import { getSwitchList, regimeForDate, AccountingMode } from './accounting';

// Base sleep goal (minutes) for the Sleep Bank / Sleep Needed model — matches the
// sleep-detail screen's default (6h15m) and Bevel's base. Tunable / calibratable.
const SLEEP_BANK_BASE_GOAL = 375;
import { loadRunMeta } from './runMeta';
import { classifyAndCacheRuns, loadWorkoutCache, computeWorkoutTypeStats, PerRunData } from './workoutClassifier';
import { ftpFromZones } from './powerMetrics';
import { runDecouple, DC_GROSS_MAX } from './decoupling';
import {
  getBodyMassKg, saveBodyMassKg, DEFAULT_BODY_MASS_KG,
  getPowerZones, getRunOverrides, isPowerZonesConfigured,
  getLongRunMinutes, getHrUnreliableRuns, getHrLowResRuns, saveHrLowResBatch, getUserMaxHr, getEffectiveMaxHr, setObservedMaxHr,
  getMaxHrHistory, buildMaxHrResolver,
} from './claude';
import { loadEvents, getAthleteStatus } from './timelineEvents';
import { loadSupplements, buildSupplementContext } from './supplements';
import { loadRecoveryCache, saveRecoveryCache } from './recoveryCache';

// ─── Snapshot cache ───────────────────────────────────────────────────────────

const SNAPSHOT_CACHE_FILE = `${FileSystem.documentDirectory}runcoach-snapshot-cache.json`;
export async function saveSnapshotCache(snap: HealthSnapshot): Promise<void> {
  try { await FileSystem.writeAsStringAsync(SNAPSHOT_CACHE_FILE, JSON.stringify(snap)); } catch {}
}
export async function clearSnapshotCache(): Promise<void> {
  try { await FileSystem.deleteAsync(SNAPSHOT_CACHE_FILE, { idempotent: true }); } catch {}
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
  // LOCAL calendar date. Slicing the ISO string took the UTC date — in UTC+2 everything between
  // 00:00–02:00 local was keyed to the PREVIOUS day (and "today" itself was wrong in that window).
  const d = iso instanceof Date ? iso : new Date(String(iso));
  if (isNaN(d.getTime())) return String(iso).split('T')[0]; // unparseable — old behavior as fallback
  return toLocalDateStr(d);
}

/**
 * LOCAL calendar date (YYYY-MM-DD) of a Date — using local Y/M/D, NOT toISOString()
 * (which is UTC and shifts the day backwards in positive-offset timezones). Used to
 * label daily-total buckets that are anchored at LOCAL midnight.
 */
function toLocalDateStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ─── Workout subscription ─────────────────────────────────────────────────────

export async function subscribeToWorkoutChanges(
  onNewWorkout: () => void
): Promise<() => void> {
  try {
    // v9: subscribeToChanges returns a queryId string; unsubscribe via unsubscribeQueries([id]).
    const queryId = subscribeToChanges(HKQuantityTypeIdentifier.distanceWalkingRunning as any, onNewWorkout);
    if (queryId) return () => { try { (HealthKit as any).unsubscribeQueries([queryId]); } catch { /* ignore */ } };
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
      'HKQuantityTypeIdentifierBasalEnergyBurned',
      'HKQuantityTypeIdentifierAppleExerciseTime',
      // Biology mode — body composition + blood pressure
      'HKQuantityTypeIdentifierBloodPressureSystolic',
      'HKQuantityTypeIdentifierBloodPressureDiastolic',
      'HKQuantityTypeIdentifierBodyFatPercentage',
      'HKQuantityTypeIdentifierLeanBodyMass',
      'HKQuantityTypeIdentifierBodyMassIndex',
      'HKQuantityTypeIdentifierWaistCircumference',
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

// ── Mirror imported labs → Apple Health ───────────────────────────────────────
// Only the HK-writable analytes (Weight, Blood Pressure, Glucose). Writes carry a stable SyncIdentifier so
// re-importing the same reading REPLACES rather than duplicates. Unit fixes from the sheet's own conventions:
// BP is in cmHg (14/8 = 140/80 → ×10 to mmHg); glucose canonical is mmol/L → mg/dL (×18.0156) for HK.
const MMOL_TO_MGDL = 18.0156;
export async function requestLabsWriteAuth(): Promise<boolean> {
  try {
    // Request READ **and** WRITE for the same types. Passing an empty read list here disturbed the existing
    // read grants for Body Mass / Blood Pressure (Biology's weight & BP charts went blank) — re-affirming
    // read alongside write keeps those intact. (Quantity types only; a BP correlation is authorised via its
    // systolic/diastolic components.)
    const rw = ['HKQuantityTypeIdentifierBodyMass', 'HKQuantityTypeIdentifierBloodGlucose',
      'HKQuantityTypeIdentifierBloodPressureSystolic', 'HKQuantityTypeIdentifierBloodPressureDiastolic'];
    await HealthKit.requestAuthorization(rw as any, rw as any);
    return true;
  } catch (e) { console.warn('labs write auth failed', e); return false; }
}

export interface LabMirrorAnalyte { hkType?: string; label: string; series: { date: string; value: number }[] }

export async function mirrorLabsToHealth(analytes: LabMirrorAnalyte[]): Promise<{ written: number; skipped: number }> {
  const eligible = analytes.filter(a => a.hkType);
  const total = eligible.reduce((n, a) => n + a.series.length, 0);
  if (!total) return { written: 0, skipped: 0 };
  if (!(await requestLabsWriteAuth())) return { written: 0, skipped: total };

  const at = (iso: string) => new Date(iso.length <= 10 ? iso + 'T12:00:00' : iso);
  const toMmHg = (v: number) => (v < 30 ? v * 10 : v);           // cmHg → mmHg (guarded, in case some rows already mmHg)
  const NO_META = {} as any;   // NB: HKMetadataKeySync* threw a native NSException (hard crash) — omit it
  let written = 0, skipped = 0;

  // Simple quantities FIRST (weight, glucose) — the most reliable writes, so they land even if the BP
  // correlation below turns out to be problematic on this device.
  for (const a of eligible) {
    const hk = a.hkType!;
    if (hk.includes('BodyMass')) {
      for (const v of a.series) { const t = at(v.date);
        try { (await (HealthKit as any).saveQuantitySample('HKQuantityTypeIdentifierBodyMass', 'kg', v.value, t, t, NO_META)) ? written++ : skipped++; } catch { skipped++; } }
    } else if (hk.includes('BloodGlucose')) {
      for (const v of a.series) { const t = at(v.date);
        try { (await (HealthKit as any).saveQuantitySample('HKQuantityTypeIdentifierBloodGlucose', 'mg/dL', v.value * MMOL_TO_MGDL, t, t, NO_META)) ? written++ : skipped++; } catch { skipped++; } }
    }
  }
  // Blood pressure → correlations (pair systolic+diastolic by date)
  const sys = eligible.find(a => a.hkType!.includes('Systolic'));
  const dia = eligible.find(a => a.hkType!.includes('Diastolic'));
  if (sys && dia) {
    const diaBy = new Map(dia.series.map(v => [v.date, v.value]));
    for (const s of sys.series) {
      const d = diaBy.get(s.date); if (d == null) { skipped++; continue; }
      const t = at(s.date);
      try {
        const ok = await (HealthKit as any).saveCorrelationSample('HKCorrelationTypeIdentifierBloodPressure', [
          { startDate: t, endDate: t, quantityType: 'HKQuantityTypeIdentifierBloodPressureSystolic', quantity: toMmHg(s.value), unit: 'mmHg', metadata: NO_META },
          { startDate: t, endDate: t, quantityType: 'HKQuantityTypeIdentifierBloodPressureDiastolic', quantity: toMmHg(d), unit: 'mmHg', metadata: NO_META },
        ], t, t, NO_META);
        ok ? written++ : skipped++;
      } catch { skipped++; }
    }
  }
  return { written, skipped };
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
  rawSamples: { startDate: string | Date | any; endDate: string | Date | any; value: number; source?: string }[]
): SleepSession[] {
  if (rawSamples.length === 0) return [];

  // Normalise to ISO strings so downstream code never has to deal with Date objects
  const normalised = rawSamples.map((s) => ({
    startDate: toISOStr(s.startDate),
    endDate:   toISOStr(s.endDate),
    value:     s.value as number,
    source:    (s as any).source ?? '',
  }));

  const sorted = [...normalised].sort(
    (a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime()
  );

  const sessions: SleepSession[] = [];
  let current: typeof sorted = [sorted[0]];
  // Gap must be measured against the FURTHEST end seen so far — with overlapping multi-source samples the
  // last-by-start sample can end EARLY, which made a mid-night "gap" appear and split one night in two.
  let currentMaxEnd = new Date(sorted[0].endDate).getTime();

  for (let i = 1; i < sorted.length; i++) {
    const gapMin = (new Date(sorted[i].startDate).getTime() - currentMaxEnd) / 60_000;
    if (gapMin > 180) {
      sessions.push(buildSession(current));
      current = [sorted[i]];
      currentMaxEnd = new Date(sorted[i].endDate).getTime();
    } else {
      current.push(sorted[i]);
      currentMaxEnd = Math.max(currentMaxEnd, new Date(sorted[i].endDate).getTime());
    }
  }
  sessions.push(buildSession(current));

  return sessions.filter((s) => s.totalMinutes >= 30);
}

function buildSession(
  samples: { startDate: string | Date | any; endDate: string | Date | any; value: number; source?: string }[]
): SleepSession {
  const allSegments: SleepSegment[] = samples.map((s) => {
    const stage = SLEEP_VALUE_TO_LABEL[s.value] ?? 'asleepUnspecified';
    const start = toISOStr(s.startDate);
    const end   = toISOStr(s.endDate);
    return {
      startDate: start,
      endDate: end,
      stage,
      durationMinutes: minutesBetween(start, end),
      source: (s as any).source ?? '',
    };
  });

  // Pick ONE authoritative source per night. Several devices/apps (Apple Watch + iPhone + a 3rd-party sleep
  // app) can EACH log the whole night with their OWN staging; merging across sources double-counts (a REM
  // window from one overlapping a Core/awake window from another) and inflates REM/deep even after the
  // per-slice resolution below. Prefer a source with detailed staging (has deep or REM), then Apple's own,
  // then the widest asleep coverage — and use only that source's samples.
  const bySource = new Map<string, SleepSegment[]>();
  for (const seg of allSegments) {
    const k = seg.source ?? '';
    const arr = bySource.get(k); if (arr) arr.push(seg); else bySource.set(k, [seg]);
  }
  let segments = allSegments;
  if (bySource.size > 1) {
    const isAsleep = (st: string) => st === 'asleepCore' || st === 'asleepUnspecified' || st === 'asleepDeep' || st === 'asleepREM';
    const stats = Array.from(bySource.entries()).map(([src, segs]) => ({
      src, segs,
      asleepMin: segs.filter((s) => isAsleep(s.stage)).reduce((a, s) => a + s.durationMinutes, 0),
      hasDetail: segs.some((s) => s.stage === 'asleepDeep' || s.stage === 'asleepREM'),
      isApple:   src.startsWith('com.apple'),
    }));
    const maxAsleep = Math.max(...stats.map((x) => x.asleepMin));
    let best = stats[0], bestScore = -Infinity;
    for (const x of stats) {
      // The detailed-staging bonus only applies when that source actually covered MOST of the night —
      // a Watch that staged 2h of a 7h night must not beat a full-coverage coarse source (short totals).
      const detailOk = x.hasDetail && x.asleepMin >= 0.7 * maxAsleep;
      const score = (detailOk ? 1e6 : 0) + (x.isApple ? 5e5 : 0) + x.asleepMin;
      if (score > bestScore) { bestScore = score; best = x; }
    }
    segments = best.segs;
  }

  // Multiple HealthKit sources (Apple Watch + iPhone + 3rd-party sleep apps) can write OVERLAPPING samples
  // for the same window; naively summing them double-counts and produces impossible spikes (e.g. 13h45
  // "time asleep"). A per-stage union isn't enough because the overlaps are usually CROSS-stage — a coarse
  // whole-night "in bed / unspecified" block from one source sitting over the Watch's detailed core/deep/REM.
  // Resolve it by slicing the night at every sample boundary and letting the most-specific stage win each
  // slice. Each minute is then counted exactly once, and total asleep === core+deep+REM by construction.
  const STAGE_PRIORITY: Record<string, number> = {
    asleepDeep: 5, asleepREM: 4, asleepCore: 3, awake: 2, asleepUnspecified: 1, inBed: 0,
  };
  const ivs = segments
    .map((seg) => ({ s: new Date(seg.startDate).getTime(), e: new Date(seg.endDate).getTime(), stage: seg.stage }))
    .filter((v) => v.e > v.s);
  const bounds = Array.from(new Set(ivs.flatMap((v) => [v.s, v.e]))).sort((a, b) => a - b);
  const totals = { asleepCore: 0, asleepDeep: 0, asleepREM: 0, awake: 0 };
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i], b = bounds[i + 1];
    if (b <= a) continue;
    let winner = '', wp = -1;
    for (const v of ivs) {
      if (v.s <= a && v.e >= b) {
        const p = STAGE_PRIORITY[v.stage] ?? 0;
        if (p > wp) { wp = p; winner = v.stage; }
      }
    }
    const mins = (b - a) / 60_000;
    if (winner === 'asleepDeep')      totals.asleepDeep += mins;
    else if (winner === 'asleepREM')  totals.asleepREM  += mins;
    else if (winner === 'asleepCore' || winner === 'asleepUnspecified') totals.asleepCore += mins;
    else if (winner === 'awake')      totals.awake      += mins;
    // 'inBed' / no cover → not counted as sleep
  }
  const sleepMinutes = totals.asleepCore + totals.asleepDeep + totals.asleepREM;
  const bedtime  = toISOStr(samples[0].startDate);
  // Wake = the FURTHEST end, not the last-by-start sample's end (which can be an early-ending overlap).
  const wakeMs   = samples.reduce((m, s) => Math.max(m, new Date(toISOStr(s.endDate)).getTime()), 0);
  const wakeTime = new Date(wakeMs).toISOString();

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
export function buildHeartbeatQualityMap(
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

// Beat-level HRV quality lives in its own dependency-free module (pure + unit-testable).
export { assessBeatQuality, buildBeatQualityMap, beatQualityNear } from './hrvQuality';
export type { BeatQuality } from './hrvQuality';

/**
 * True RMSSD (ms) from raw R-R intervals in the heartbeat series — the metric Bevel
 * uses for "Resting HRV", which runs lower than Apple's SDNN on variable nights.
 *
 * For each series: R-R interval = Δ(timeSinceSeriesStart) between consecutive beats,
 * skipping gap boundaries (precededByGap) and physiologically-impossible intervals
 * (<300ms / >2000ms). RMSSD = sqrt(mean(ΔRR²)) over successive valid intervals, with
 * large jumps (>200ms = ectopic / sensor artifact) excluded — Bevel's "artifact removal".
 */
function computeRMSSD(
  series: readonly { heartbeats: readonly { timeSinceSeriesStart: number; precededByGap: boolean }[] }[],
): number {
  let sumSq = 0, n = 0;
  for (const s of series) {
    const beats = s.heartbeats;
    let prevRR: number | null = null;
    for (let i = 1; i < beats.length; i++) {
      if (beats[i].precededByGap) { prevRR = null; continue; }          // gap breaks the chain
      const rr = (beats[i].timeSinceSeriesStart - beats[i - 1].timeSinceSeriesStart) * 1000;
      if (rr < 300 || rr > 2000) { prevRR = null; continue; }           // impossible interval
      if (prevRR !== null) {
        const d = rr - prevRR;
        if (Math.abs(d) <= 200) { sumSq += d * d; n++; }                // exclude ectopic spikes
      }
      prevRR = rr;
    }
  }
  return n > 0 ? Math.sqrt(sumSq / n) : 0;
}

// True RMSSD for one night: the global heartbeat series windowed to the sleep session.
// (Recovery is fit to Bevel's RMSSD, which runs ~20% below Apple's SDNN — see computeRMSSD.)
function nightlyTrueRMSSD(session: SleepSession, allSeries: readonly any[]): number {
  if (!allSeries || allSeries.length === 0) return 0;
  const start = new Date(session.bedtime).getTime() - 90 * 60_000;
  const end   = new Date(session.wakeTime).getTime() + 60 * 60_000;
  const series = allSeries.filter((s) => {
    const t = new Date(s.startDate).getTime();
    return t >= start && t <= end;
  });
  return series.length > 0 ? computeRMSSD(series as any) : 0;
}

/**
 * Is the HRV sample at `sampleStartMs` considered good quality?
 * Looks for the nearest heartbeat series within 10 s tolerance.
 * Returns true (include) if no matching series is found (can't assess).
 */
export function isGoodHRVSample(sampleStartMs: number, qualityMap: Map<number, boolean>): boolean {
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

// ─── Daytime HR ──────────────────────────────────────────────────────────────

// Bevel's "Daytime HR" is a *restful* daytime measure (~67, band 64-71) — close to
// resting HR, not a mean of all waking HR (which light activity inflates to ~74).
// We approximate it as a low percentile of waking-hour samples. Tunable.
const DAYTIME_HR_PCTL = 0.30;
function restfulDaytimeHR(vals: number[]): number {
  if (vals.length === 0) return 0;
  const s = [...vals].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * DAYTIME_HR_PCTL))];
}

// ─── Sleep score ─────────────────────────────────────────────────────────────

const DEFAULT_SLEEP_GOAL_MINUTES = 480; // 8 hours

// Bevel's 5-pillar Sleep Score. Weights + mappings reverse-engineered from 30 nights of Bevel data
// (Duration 40 / Efficiency 20 / Stages 20 / HR-dip 10 / Consistency 10): corr 0.88, bias +2.7.
export interface SleepScoreParts { score: number; dur: number; eff: number; stage: number; dip: number; cons: number }
export function computeSleepScore(
  session: SleepSession,
  overnightHR: number,
  daytimeHR: number,
  recentSessions: SleepSession[] = [],
): SleepScoreParts {
  const lin = (x: number, a: number, b: number, c: number, d: number) =>
    x <= a ? c : x >= b ? d : c + (d - c) * (x - a) / (b - a);
  const asleep = session.totalMinutes;

  // 1. Duration (40%): time asleep vs a DYNAMIC Sleep Need (Bevel model), NOT a fixed 7h. Base = 90-day
  // median actual sleep (this athlete ~6h15, matching Bevel's goal) + a debt bump from the 7-night sleep
  // bank. The old fixed 420 over-penalised nights that met the real need (6h25 scored 84, Bevel says 100).
  const baseGoal = computePersonalSleepGoal(recentSessions);
  const bank7 = recentSessions.filter((s) => s.totalMinutes >= 120).slice(-7)
    .reduce((acc, s) => acc + (s.totalMinutes - baseGoal), 0);     // <0 = debt → raises tonight's need
  const need = computeAdjustedGoal(baseGoal, bank7, 0 /* strain not available here */, 85 /* eff-neutral */);
  const r = need > 0 ? asleep / need : 1;
  const durScore = r >= 1 ? 100 : r >= 0.75 ? lin(r, 0.75, 1, 50, 100) : r >= 0.5 ? lin(r, 0.5, 0.75, 0, 50) : 0;

  // 2. Efficiency (20%): asleep / time-in-bed. 0 at <60%, 50 at ~75%, 100 at 95%+.
  const totalInBed = asleep + session.awakeMinutes;
  const eff = totalInBed > 0 ? (asleep / totalInBed) * 100 : 100;
  const effScore = eff >= 95 ? 100 : eff >= 75 ? lin(eff, 75, 95, 50, 100) : eff >= 60 ? lin(eff, 60, 75, 0, 50) : 0;

  // 3. Stages (20%): REM ≥20% of sleep + Deep ≥15%, each worth 50 (full credit at/above target).
  const remPct  = asleep > 0 ? session.remMinutes  / asleep : 0;
  const deepPct = asleep > 0 ? session.deepMinutes / asleep : 0;
  const stageScore = 50 * Math.min(1, remPct / 0.20) + 50 * Math.min(1, deepPct / 0.15);

  // 4. HR dip (10%): overnight HR drop from daytime HR. 0 at no dip, 50 at ~6%, 100 at 15%+.
  let dipScore = 60; // neutral when HR data is missing
  if (overnightHR > 0 && daytimeHR > 0) {
    const dip = (daytimeHR - overnightHR) / daytimeHR * 100;
    dipScore = dip >= 15 ? 100 : dip >= 6 ? lin(dip, 6, 15, 50, 100) : dip >= 0 ? lin(dip, 0, 6, 0, 50) : 0;
  }

  // 5. Consistency (10%): bed/wake timing variability over the last 7 nights (±30 min = full credit).
  let consScore = 75; // neutral until we have a few nights
  const win = recentSessions.filter((s) => s.bedtime && s.wakeTime).slice(-7);
  if (win.length >= 3) {
    const eve = (cm: number) => { let m = cm - 1080; if (m < 0) m += 1440; return m; }; // minutes from 18:00 (wrap)
    const sd  = (a: number[]) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };
    const variability = (sd(win.map((s) => eve(clockMinutes(s.bedtime)))) + sd(win.map((s) => clockMinutes(s.wakeTime)))) / 2;
    consScore = Math.max(0, Math.min(100, 100 - Math.max(0, variability - 30) * 1.4));
  }

  const raw = 0.40 * durScore + 0.20 * effScore + 0.20 * stageScore + 0.10 * dipScore + 0.10 * consScore;
  const R = (v: number) => Math.round(v);
  return {
    score: R(Math.min(100, Math.max(0, raw))),
    dur: R(durScore), eff: R(effScore), stage: R(stageScore), dip: R(dipScore), cons: R(consScore),
  };
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

// ── Recovery model — fit to Bevel recovery using OUR OWN metrics (RHR = overnight sleep-HR, which tracks
// Bevel's resting HR at corr 0.99; HRV = weightedRMSSD, corr 0.97; sleep = our aligned sleep score).
// Fit on 30 days (2026-06-03…07-03) and then VALIDATED over the full 82-day history (04-05…07-03, after
// backfilling overnight-HR): clamped MAE 5.5 pts — BEATS re-fitting on all 82 days (6.1, dragged by
// floor-outliers like 05-23=1) and a robust rec≥12 fit (5.6). So these coefficients generalise; kept.
// recovery = 61.2 + 13.2·zHRV + 8.5·zSleepHR + 7.1·zSleep + 4.4·zRR (z vs 60-day rolling mean, fixed SD).
const REC_BASE = 61.2, REC_W_HRV = 13.2, REC_W_RHR = 8.5, REC_W_SLEEP = 7.1, REC_W_RR = 4.4;
const REC_SD_HRV = 6.3, REC_SD_RHR = 3.3, REC_SD_SLEEP = 16, REC_SD_RR = 0.61, REC_SLEEP_MEAN = 75;

function computeRecoveryScore(
  todayRMSSD: number,
  todayRestingHR: number,          // Apple RESTING HR (HKRestingHeartRate) — NOT overnight sleep-HR
  hrvHistory: NightlyHRV[],        // for the HRV (weightedRMSSD) 60-day baseline
  restingHRHistory: number[],      // Apple resting HR values for the RHR 60-day baseline
  sleepScore = 0,
  todayRR = 0,
  rrBaseline = 0,
): { score: number; baseline: number; trend: DailyRecovery['trend']; overnightHRBaseline: number; breakdown: RecoveryBreakdown } {
  const clamp01 = (v: number) => Math.min(100, Math.max(0, v));
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const std  = (a: number[], m: number) => Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);

  // 60-CALENDAR-day HRV baseline (missing nights don't drag in old outliers).
  const withData = hrvHistory.filter((n) => n.weightedRMSSD > 0);
  const latest = withData.length ? withData[withData.length - 1].date : '';
  const cutoff = latest ? new Date(new Date(latest + 'T00:00:00Z').getTime() - 59 * 86_400_000).toISOString().slice(0, 10) : '';
  const recent = cutoff ? withData.filter((n) => n.date >= cutoff) : withData;

  // HRV z — TREND-CORRECTED 60-day level, Bevel-fixed SD (6.3).
  //
  // WHY (2026-07-14, measured): a flat rolling MEAN of a RISING series sits ~half the window BEHIND. Geert's
  // nightly HRV nearly DOUBLED over the window (25 → 47 ms — fitness returning after PFPS), so the 60-day
  // mean (35.1) sat 4.0 ms BELOW his CURRENT norm (39.0). That handed him ~+0.6 SD of free zHRV every single
  // day (worth ~7 recovery points) and pushed the score into its 100 cap (core 99 + sleep 7.1 − rr 1.1 = 105,
  // clipped). Net: the score was partly measuring "fitter than your OLD self" rather than "recovered TODAY",
  // and it had lost all resolution at the top. It bites hardest at the THRESHOLD — a genuinely mediocre night
  // also collects those ~7 free points, so a true 60 reads ~67, right where the coach's green gate sits.
  //
  // FIX: evaluate the 60-day LINEAR TREND at TODAY instead of taking its mean. Fitness moves the SLOPE; a
  // genuinely bad night still shows up as deviation FROM the slope — which is what a recovery score should
  // say. Regress on DATE (not array index) so missing nights don't distort the slope.
  // (Same correction applied to bodyBattery's HRV baseline. The RHR term below is deliberately LEFT ALONE:
  // measured over the same window, resting HR is flat (slope 0.008 bpm/day) — no lag, so zRHR 1.5 is real.)
  // Guards: enough nights + clamped slope + clamped adjustment, so noise can never run the level away.
  const REC_TREND_MIN_NIGHTS = 20;
  const REC_TREND_MAX_SLOPE  = 0.5;   // ms/day beyond this is noise, not a trend
  const REC_TREND_MAX_ADJ    = 10;    // ms — hard cap on how far the trend may move the level off the flat mean
  let hrvMean = todayRMSSD, zHRV = 0;
  if (recent.length >= 5) {
    const flat = mean(recent.map((n) => n.weightedRMSSD));
    hrvMean = flat;
    if (recent.length >= REC_TREND_MIN_NIGHTS) {
      const t0 = new Date(recent[0].date + 'T00:00:00Z').getTime();
      const xs = recent.map((n) => (new Date(n.date + 'T00:00:00Z').getTime() - t0) / 86_400_000);
      const ys = recent.map((n) => n.weightedRMSSD);
      const mx = mean(xs), my = mean(ys);
      const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
      if (den > 0) {
        const rawSlope = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / den;
        const slope = Math.max(-REC_TREND_MAX_SLOPE, Math.min(REC_TREND_MAX_SLOPE, rawSlope));
        const atToday = (my - slope * mx) + slope * xs[xs.length - 1];   // the trend line AT TODAY, not its mean
        hrvMean = flat + Math.max(-REC_TREND_MAX_ADJ, Math.min(REC_TREND_MAX_ADJ, atToday - flat));
      }
    }
    zHRV = (todayRMSSD - hrvMean) / REC_SD_HRV;
  }

  // RHR z — Apple resting HR, rolling mean, fixed SD (3.3); lower than baseline → positive.
  const rhrVals = restingHRHistory.filter((v) => v > 0).slice(-60);
  let rhrMean = todayRestingHR, zRHR = 0;
  if (rhrVals.length >= 5 && todayRestingHR > 0) { rhrMean = mean(rhrVals); zRHR = (rhrMean - todayRestingHR) / REC_SD_RHR; }

  // Sleep z (fixed baseline 75) + RR z (rolling baseline; lower = better — now symmetric, not a penalty).
  const zSleep = sleepScore > 0 ? (sleepScore - REC_SLEEP_MEAN) / REC_SD_SLEEP : 0;
  const zRR    = (todayRR > 0 && rrBaseline > 0) ? (rrBaseline - todayRR) / REC_SD_RR : 0;

  const cHRV = REC_W_HRV * zHRV, cRHR = REC_W_RHR * zRHR, cSleep = REC_W_SLEEP * zSleep, cRR = REC_W_RR * zRR;
  const linear = clamp01(REC_BASE + cHRV + cRHR + cSleep + cRR);
  // Ease in from an absolute cold-start over the first two weeks of data.
  const warm = Math.min(1, recent.length / 14);
  const cold = clamp01(0.6 * absoluteHRVScore(todayRMSSD) + 0.4 * (todayRestingHR > 0 ? absoluteRHRScore(todayRestingHR) : 50));
  // Floor a REAL computed score at 1 (Bevel's convention). A score is only produced when there IS
  // overnight data, so it should never be 0 — that keeps 0 as an unambiguous sentinel for "no data".
  // Without this a catastrophic night could clamp to 0 and become indistinguishable from a missing night,
  // which is exactly what masked the 2026-07-27 dance morning (recovery read 0, treated as no-data →
  // readiness defaulted to a neutral 55 → the plan prescribed a run). Geert confirmed Bevel floors at 1.
  const score = Math.max(1, Math.round(warm * linear + (1 - warm) * cold));

  // Baseline + trend (raw RMSSD, for display).
  const rmssdMean = recent.length ? hrvMean : todayRMSSD;
  const hrvSD = recent.length >= 5 ? std(recent.map((n) => n.weightedRMSSD), hrvMean) : 0;
  const last7 = recent.slice(-7);
  const avg7  = last7.length > 0 ? mean(last7.map((n) => n.weightedRMSSD)) : todayRMSSD;
  const delta = todayRMSSD - avg7;
  const trend: DailyRecovery['trend'] =
    delta > (hrvSD || 1) * 0.3 ? 'rising' : delta < -(hrvSD || 1) * 0.3 ? 'falling' : 'stable';

  const r1 = (x: number) => Math.round(x * 10) / 10;
  const breakdown: RecoveryBreakdown = {
    rmssd: r1(todayRMSSD), hrvMean: r1(hrvMean), hrvSD: REC_SD_HRV, zHRV: r1(zHRV), hrvSub: Math.round(50 + cHRV),
    overnightHR: Math.round(todayRestingHR), rhrMean: r1(rhrMean), rhrSD: REC_SD_RHR, zRHR: r1(zRHR), rhrSub: Math.round(50 + cRHR),
    hrvWeight: REC_W_HRV / (REC_W_HRV + REC_W_RHR), core: Math.round(REC_BASE + cHRV + cRHR),
    sleepScore, sleepTerm: r1(cSleep),
    rr: r1(todayRR), rrBaseline: r1(rrBaseline), rrPenalty: r1(cRR),
    final: score,
  };
  return { score, baseline: r1(rmssdMean), trend, overnightHRBaseline: Math.round(rhrMean), breakdown };
}

// Bevel-aligned bands: Optimal >67 / Normal 34-67 / Poor <34.
export function scoreToLabel(score: number): DailyRecovery['label'] {
  if (score >= 67) return 'optimal';
  if (score >= 50) return 'good';
  if (score >= 34) return 'moderate';
  return 'poor';
}

export function scoreToColor(score: number): string {
  if (score >= 67) return '#27ae60';   // green
  if (score >= 50) return '#2ecc71';   // lighter green
  if (score >= 34) return '#f39c12';   // amber
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

  // Older Apple-Watch runs store dense workout HR/power as a HKQuantitySeries the plain sample
  // query returns only SPARSELY (~10 stray points, avg biased LOW) → their avg HR / TRIMP / EF /
  // zones / hrLowRes were all wrong. When the discrete stream is sparse (< 4 samples/min — recent
  // H10 runs are 12-60/min and skip this, keeping the deep rebuild fast), expand the series via the
  // native module and use it if denser. Same [start-30s, end+30s] window as the discrete query.
  let hrOut = hr as any[];
  let powerOut = power as any[];
  if (seriesNative) {
    const durMin = Math.max(1, (new Date(w.endDate).getTime() - new Date(w.startDate).getTime()) / 60_000);
    const startMs = from.getTime(), endMs = to.getTime();
    if (hrOut.length / durMin < 4) {
      try {
        const s = await seriesNative.queryQuantitySeries('HKQuantityTypeIdentifierHeartRate', startMs, endMs);
        if (s.length > hrOut.length) hrOut = s.map(p => ({ startDate: new Date(p.t), quantity: p.v }));
      } catch { /* keep discrete */ }
    }
    if (powerOut.length / durMin < 4) {
      try {
        const s = await seriesNative.queryQuantitySeries('HKQuantityTypeIdentifierRunningPower', startMs, endMs);
        if (s.length > powerOut.length) powerOut = s.map(p => ({ startDate: new Date(p.t), quantity: p.v }));
      } catch { /* keep discrete */ }
    }
  }

  return { hr: hrOut, dist, power: powerOut };
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
export function extractWeatherTempC(w: any): number | undefined {
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
  /**
   * Fast incremental refresh: shrink the CTL/ATL warm-up windows (365→180d active energy,
   * 150→120d workouts). Still well-converged (~1.4% residual) but much quicker. Used on a
   * normal app start; a full refresh (pull-down / new version) recomputes the long window.
   */
  light?: boolean;
  /**
   * ONE-TIME calibration backfill: fetch heartbeat/HRV/sleep back ~90 days AND run a per-night HR query
   * for 95 nights to fill the overnight sleep-HR history (for the Bevel recovery re-fit). SLOW (~6.5 min,
   * 95 HK queries) — must NEVER run on a normal/automatic scan. Only the manual "Refresh all history"
   * button sets it. Everything else (home, morning observer, run-analysis) leaves it off → light path.
   */
  deepBackfill?: boolean;
}

export async function fetchHealthSnapshot(opts: FetchOptions = {}): Promise<HealthSnapshot> {
  const months = Math.max(1, Math.min(24, opts.months ?? 3));
  const progress = (step: string, pct: number) => opts.onProgress?.(step, Math.round(pct));
  // Warm-up windows for the CTL/ATL EWMAs — trimmed in light (incremental) refresh.
  const aeWarmupDays = opts.light ? 180 : Math.max(months * 30, 365);
  const woWarmupDays = opts.light ? 120 : Math.max(months * 30, 150);

  const now          = new Date();
  const sinceDate    = daysAgo(months * 30);
  const thirtyDaysAgo  = daysAgo(30);
  const sixtyDaysAgo   = daysAgo(60); // recovery baselines (HRV/RHR/RR) use a 60-day window (Bevel's)
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
  const rawRuns: RunWorkout[] = await Promise.all(runWorkouts.map(async (w: any) => {
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
        // Skip only SPURIOUS no-data activities — but KEEP a real prescribed phase that legitimately
        // covers 0 m (e.g. standing drills). Dropping it desynchronised relabelByPhases (which order-
        // matches the full [Warmup, Drills, Work, Cooldown] sequence), shifting Drills→the real work and
        // Work→the cooldown, so work-stats latched onto the 99 W cooldown. A real phase has a step keypath.
        if (distanceM === 0 && !stepPath) return null; // no data AND not a prescribed phase → drop
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

    // Resolve any deferred __step: labels. Workout metadata frequently carries ONLY the
    // WOIntervalStepKeyPath BLOCK INDEX (no StepType/StepName), so label by POSITION: the first
    // prescribed block is the warm-up, the last is the cool-down, the rest are work. The old
    // distance heuristic tagged a LONG warm-up as Work (e.g. a 640 m warm-up ≈ the median, so not
    // "< 65% of median" → mislabelled), which then poisoned the work-stat averages (wHR/wW/EF/SE).
    const hasDeferred = segments.some(s => s.label.startsWith('__step:') || s.label === '');
    if (hasDeferred && segments.length >= 2) {
      const stepIdxOf = (s: WorkoutSegment) => s.label.startsWith('__step:') ? parseInt(s.label.slice(7), 10) : NaN;
      const idxs = segments.map(stepIdxOf).filter(n => !Number.isNaN(n));
      if (idxs.length >= 2) {
        const minI = Math.min(...idxs), maxI = Math.max(...idxs);
        segments.forEach(s => {
          if (!s.label.startsWith('__step:') && s.label !== '') return;
          const n = stepIdxOf(s);
          if (n === minI)      s.label = 'Warmup';
          else if (n === maxI) s.label = 'Cooldown';
          else                 s.label = 'Work';
        });
      } else {
        // No usable positions → fall back to the distance heuristic (short first/last = warmup/cooldown).
        const validDists = segments.map(s => s.distanceM).filter(d => d > 0);
        const sorted = [...validDists].sort((a, b) => a - b);
        const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
        const threshold = median * 0.65;
        segments.forEach((s, i) => {
          if (!s.label.startsWith('__step:') && s.label !== '') return;
          if (i === 0 && s.distanceM < threshold)                         s.label = 'Warmup';
          else if (i === segments.length - 1 && s.distanceM < threshold)  s.label = 'Cooldown';
          else                                                             s.label = 'Work';
        });
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

    // ── Recovery rescue ───────────────────────────────────────────────────────
    // Between-rep recoveries (short easy jogs) frequently arrive labelled "Work":
    // HK metadata doesn't always carry the .recovery purpose, and the heuristics
    // above only split off the first/last segment. Relabel a "Work" as "Recovery"
    // when it's far shorter than the typical rep, sits AFTER a Work, and still has a
    // later Work — i.e. it's a between-reps jog, not the drills, cooldown, or a rep.
    {
      const workDurs = segments.filter(s => s.label === 'Work').map(s => s.durationSec)
        .filter(d => d > 0).sort((a, b) => a - b);
      const medWorkDur = workDurs.length ? workDurs[Math.floor(workDurs.length / 2)] : 0;
      if (medWorkDur > 0) {
        segments.forEach((s, i) => {
          if (s.label !== 'Work' || s.durationSec >= medWorkDur * 0.5) return;
          const afterWork = segments[i - 1]?.label === 'Work';
          const laterWork = segments.slice(i + 1).some(n => n.label === 'Work');
          if (afterWork && laterWork) s.label = 'Recovery';
        });
      }
    }

    // App-pushed runs: label the segments from the prescribed phase sequence that was live at run
    // start (HK's own per-step labels aren't reliable enough to trust alone). This is SAFE because
    // every push site saves the EXACT workout it pushes, so the logged structure == what the watch
    // ran (phase sequence identical — only the per-segment DURATION may differ). Order-matched within
    // ±2; trailing free running → "Open". When no plan is found (a run the app didn't push), the HK +
    // heuristic labels above stand.
    if (segments.length > 0) {
      const startISO = toISOStr(w.startDate);
      const phases = await prescribedPhasesAt(dateKeyLocal(new Date(startISO)), startISO);
      if (phases) relabelByPhases(segments, phases);
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
  }));

  // ── Step 5: Wellness data + workout classification (parallel) ─────────────
  progress('Fetching wellness data…', 65);

  // Incremental recovery cache: on a WARM cache (≥50 scored nights, newest within 5 days) we only fetch the
  // heaviest query — heartbeat series — for the recent window and reuse cached nightly recovery for the
  // ≤60-day baseline. Cold/first-run/version-change → full 60-day fetch + recompute.
  const recoveryCache = await loadRecoveryCache();
  const cachedNightByDate = new Map((recoveryCache ?? []).map(n => [n.date, n]));
  const newestCachedMs = (recoveryCache ?? []).reduce((m, n) => Math.max(m, new Date(n.date + 'T00:00:00').getTime()), 0);
  const cacheWarm = !!recoveryCache && recoveryCache.length >= 50 && newestCachedMs >= daysAgo(5).getTime();
  // Deep scan ("Refresh all history", light=false) reaches ~90d back for HRV + heartbeat and recomputes
  // EVERY night — this backfills the overnight sleep-HR history (the recovery-cache bottleneck: warm scans
  // only fetch 21d, so older nights never got overnight-HR) and re-caches it for the Bevel calibration fit.
  const deepBackfill  = opts.deepBackfill === true;   // EXPLICIT only — never on an omitted/normal scan
  const freshFromMs   = deepBackfill ? 0 : (cacheWarm ? daysAgo(21).getTime() : 0);   // 0 → recompute every night
  const heartbeatSince = deepBackfill ? daysAgo(90) : (cacheWarm ? daysAgo(21) : sixtyDaysAgo);
  const hrvSince       = deepBackfill ? daysAgo(90) : sixtyDaysAgo;

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
    hrLowResMap,
    loadWorkoutsRaw,
    runMetaMap,
    dailyKcalMap,
    rrSamples,
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
      { filter: { startDate: hrvSince, endDate: now }, unit: 'ms', ascending: false, limit: deepBackfill ? 60000 : 40000 }
    ).catch(() => [] as any[]),
    // Heartbeat series: raw R-R intervals → true RMSSD (recovery) + quality filtering (precededByGap).
    // The heaviest query — on a warm recovery cache we fetch only the recent window (older nights reused).
    safeQuery(
      () => (HealthKit as any).queryHeartbeatSeriesSamples({
        filter: { startDate: heartbeatSince, endDate: now },
        limit: deepBackfill ? 45000 : 20000,
      }),
      [] as any[]
    ),
    safeQuery(
      () => (HealthKit.queryQuantitySamples as any)(
        HKQuantityTypeIdentifier.restingHeartRate,
        // 60-day window: Apple Resting HR is the recovery RHR baseline (Bevel's metric), ~1 sample/day.
        { filter: { startDate: sixtyDaysAgo, endDate: now }, unit: 'count/min', ascending: true, limit: 70 }
      ),
      []
    ),
    safeQuery(
      () => (HealthKit.queryCategorySamples as any)(
        HKCategoryTypeIdentifier.sleepAnalysis,
        { filter: { startDate: hrvSince, endDate: now }, ascending: true, limit: deepBackfill ? 7000 : 4000 }
      ),
      []
    ),
    resolveBodyMassKg(),
    getPowerZones(),
    getRunOverrides(),
    getLongRunMinutes(),
    loadEvents(),
    getHrUnreliableRuns(),
    getHrLowResRuns(),
    // All workouts (ANY type) for the training-load model — wider window (≥150d) so CTL warms up
    safeQuery(
      () => (HealthKit.queryWorkoutSamples as any)({
        filter: { startDate: daysAgo(woWarmupDays), endDate: now },
        limit: 1000,
        ascending: false,
        energyUnit: 'kcal',
        distanceUnit: 'm',
      }),
      [] as any[]
    ),
    loadRunMeta(),
    // Daily active energy (all movement) — basis for strain + CTL/ATL. A full year
    // (~8.7× the 42-day CTL time-constant) makes today's CTL/ATL/TSB fully converged;
    // a light refresh uses 180d (~1.4% residual) for speed.
    fetchDailyActiveEnergy(daysAgo(aeWarmupDays), now),
    // Respiratory rate (60d) → recovery's illness penalty (elevated RR drags the score down).
    safeQuery(
      () => (HealthKit.queryQuantitySamples as any)(
        HKQuantityTypeIdentifier.respiratoryRate,
        { filter: { startDate: sixtyDaysAgo, endDate: now }, unit: 'count/min', ascending: false, limit: 40000 }
      ),
      [] as any[]
    ),
  ]);

  // Classify runs AFTER we have longRunMinutes
  const { runs: classifiedRuns, maxHR } = await classifyAndCacheRuns(
    rawRuns, perRunData, allNewHRValues, existingCache, longRunMinutes, await getEffectiveMaxHr(), ftpFromZones(powerZones)
  );

  // Refine work stats from structured segments + mark HR unreliable + km splits
  // classifyAndCacheRuns returns cached runs without segments — merge them back from rawRuns.
  const hrLowResUpdates: Record<string, boolean> = {};   // fresh low-res determinations to PERSIST after the loop
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
    // Manual tag OR auto-detected flat-lining/dropout (when the raw HR series is on hand for this run).
    let autoBadHr = false;
    const prd = perRunData.get(run.uuid);
    if (prd && prd.hrValues.length >= 3 && prd.hrTimestampsMs.length === prd.hrValues.length) {
      const ws = new Date(run.date).getTime();
      const we = ws + (run.duration ?? 0) * 1000;
      const series = prd.hrValues.map((hr, i) => ({ t: prd.hrTimestampsMs[i], hr }));
      autoBadHr = assessHrReliability(series, ws, we).unreliable;
    }
    // LOW-RESOLUTION HR: an old optical / summary-synced run carries very few HR samples. Density is
    // UNAMBIGUOUS, so this flag DOES exclude the run from HR-based stats (EF/SE/decoupling/zone mix). It is
    // computed the first time a run's samples are fetched and then PERSISTED (hrLowResMap), so a CACHED run —
    // whose perRunData is pre-populated EMPTY (length 0) and must NOT be re-judged as "0 samples/min" — keeps
    // its determination across scans rather than being wrongly (un)flagged.
    let low = !!(hrLowResMap as Record<string, boolean>)[run.uuid];
    if (prd && prd.hrValues.length > 0 && (run.duration ?? 0) >= 300) {
      // < 1 sample/min (gaps > 60 s) = a genuinely BROKEN trace (e.g. the April-8 optical run, ~0.1/min).
      // A chest-strap run stored every 15–30 s is 2–4/min and stays valid — the old < 4 caught those wrongly.
      low = (prd.hrValues.length / ((run.duration ?? 1) / 60)) < 1;
      hrLowResUpdates[run.uuid] = low;                                 // persist this fresh determination
    }
    run.hrLowRes = low;
    const manualBad = !!(hrUnreliableMap as Record<string, boolean>)[run.uuid];
    if (autoBadHr || manualBad) run.hrUnreliable = true;
    // Track the MANUAL flag separately: the auto-detector over-fires on older/sparser HR recordings, so
    // dropping every auto-flagged run would blank months of EF/SE. A run the user flagged by hand is a
    // definite "this HR is wrong" — the HR-based charts (EF/SE) must exclude it, while EC (speed÷power,
    // HR-independent) stays valid and is kept.
    if (manualBad) run.hrUnreliableManual = true;
  }
  // Persist the fresh low-res determinations so cached runs keep their flag on later scans (fire-and-forget).
  if (Object.keys(hrLowResUpdates).length) saveHrLowResBatch(hrLowResUpdates).catch(() => {});

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
      source:    s.sourceRevision?.source?.bundleIdentifier ?? s.sourceRevision?.source?.name ?? '',
    }))
  );

  // Fetch HR for each sleep session's window individually — much more efficient
  // than pulling all HR for 30 days and filtering.
  let sleepHRSamples: { startDate: string; quantity: number }[] = [];
  if (sleepSessions.length > 0) {
    // Overnight-HR needs a per-night HR query. Light scans do the recent 30 (fast); the deep backfill
    // does 95 so the recovery cache fills its full overnight sleep-HR history (Bevel calibration fit).
    const nightHRResults = await Promise.all(
      sleepSessions.slice(deepBackfill ? -95 : -30).map((session) =>
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
  // PERF: only the RECENT nights are consumed — recentNightlyHRV.slice(-14) + the ≤60-day recovery
  // baseline. Computing RMSSD for ALL ~730 nights of a 24-month history, each re-scanning the full
  // heartbeat/HRV series (with per-element Date parsing), was the ~9-minute scan stall. Window BOTH the
  // nights and the series to the recent range → the same output, orders of magnitude faster.
  const recentSessions = sleepSessions.slice(-95);                   // 60-day baseline + margin
  const winCutMs = recentSessions.length ? new Date(recentSessions[0].bedtime).getTime() - 2 * 3600_000 : 0;
  const recentHeartbeat = (allHeartbeatSeries as any[]).filter((s) => new Date(s.startDate).getTime() >= winCutMs);
  const hrvSamplesForSleep = (allHRVSamples as any[])
    .map((s: any) => ({ startDate: toISOStr(s.startDate), quantity: s.quantity as number }))
    .filter((s) => new Date(s.startDate).getTime() >= winCutMs);
  const globalQualityMap = buildHeartbeatQualityMap(recentHeartbeat);

  const nightlyHRV: NightlyHRV[] = recentSessions.map((session) => {
    // WARM CACHE: reuse a previously-scored older night verbatim (its RMSSD can't change) — no heartbeat
    // fetch/recompute. Recent nights (≥ freshFromMs, incl. today) are always recomputed with live data.
    if (cacheWarm && new Date(session.bedtime).getTime() < freshFromMs) {
      const c = cachedNightByDate.get(session.date);
      if (c) return { date: c.date, samples: [], weightedRMSSD: c.weightedRMSSD, overnightHR: c.overnightHR };
      // cache gap for an old night → fall through and compute (heartbeat may be absent → SDNN fallback)
    }
    const { weightedRMSSD: sdnnRMSSD, annotatedSamples } = computeWeightedRMSSD(session, hrvSamplesForSleep, globalQualityMap);
    // Recovery is fit to Bevel's TRUE RMSSD (R-R intervals), ~20% below Apple's SDNN. Prefer it;
    // fall back to the SDNN-weighted value on nights without a heartbeat series.
    const trueRMSSD = nightlyTrueRMSSD(session, recentHeartbeat);
    const weightedRMSSD = trueRMSSD > 0 ? trueRMSSD : sdnnRMSSD;
    // RHR = avg HR during sleep stages. (Apple's Resting HR ran LOWER + noisier here, not Bevel's
    // metric; sleep HR's SD matches Bevel's. The remaining baseline gap is under investigation.)
    const overnightHR = computeOvernightHR(session, sleepHRSamples);
    return { date: session.date, samples: annotatedSamples, weightedRMSSD, overnightHR };
  });
  // Persist the complete nights for next launch's warm cache (samples stripped; version-marked).
  saveRecoveryCache(nightlyHRV, dateKeyLocal(new Date())).catch(() => {});

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
      } else if (pz.tempoMax > 0 && pz.intervalsMin > 0 && wp > pz.tempoMax && wp < pz.intervalsMin) {
        // Z4: above tempo, below intervals — a sustained THRESHOLD effort. This band used to fall through
        // (no power label → kept the HR classifier's coarser guess), which is part of why the 2026-07-27
        // threshold test at 288 W mislabelled. Now the realistic zones make it a first-class label.
        powerLabel = 'Threshold';
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

  // Only surface recovery/sleep when LAST NIGHT's data has actually been delivered by
  // Apple Health — like Bevel, never fall back to a previous night or a partial set.
  //   • Fresh:    the session's wake time is recent (this morning, ≤22h ago), so it's
  //               genuinely last night and not a stale prior night that's still the
  //               newest because last night hasn't synced from the watch yet.
  //   • Complete: a real full night, not a fragment that's still syncing.
  const FRESH_WAKE_WINDOW_MS = 22 * 3_600_000;
  const MIN_NIGHT_MINUTES    = 120;
  const isFreshNight = (s: SleepSession) =>
    (s.date === todayStr || s.date === yesterdayStr) &&
    s.totalMinutes >= MIN_NIGHT_MINUTES &&
    (now.getTime() - new Date(s.wakeTime).getTime()) <= FRESH_WAKE_WINDOW_MS;

  const recentSession = sleepSessions.findLast(isFreshNight) ?? null;
  // HRV must belong to the SAME night (not an independently-latest night).
  const recentHRV = recentSession
    ? (nightlyHRV.findLast((n) => n.date === recentSession.date && n.weightedRMSSD > 0) ?? null)
    : null;

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
      daytimeHR = Math.round(restfulDaytimeHR(vals)); // restful daytime level (≈ Bevel)
    }
  }
  // Fallback: Apple's computed RestingHeartRate
  if (daytimeHR === 0 && (restingHRSamples as any[]).length > 0) {
    daytimeHR = Math.round(
      (restingHRSamples as any[]).reduce((a: number, s: any) => a + (s.quantity as number), 0) /
      (restingHRSamples as any[]).length
    );
  }

  // Respiratory rate for recovery's illness penalty: 60-day median baseline + the recent night's mean.
  const rrAll = (rrSamples as any[]).map((s: any) => s.quantity as number).filter((v) => v > 0).sort((a, b) => a - b);
  const rrBaseline = rrAll.length >= 10 ? rrAll[Math.floor(rrAll.length / 2)] : 0;
  let recentNightRR = 0;
  if (recentSession) {
    const bedMs = new Date(recentSession.bedtime).getTime(), wakeMs = new Date(recentSession.wakeTime).getTime();
    const nightRR = (rrSamples as any[])
      .filter((s: any) => { const t = new Date(s.startDate).getTime(); return t >= bedMs && t <= wakeMs; })
      .map((s: any) => s.quantity as number).filter((v) => v > 0);
    if (nightRR.length > 0) recentNightRR = nightRR.reduce((a, b) => a + b, 0) / nightRR.length;
  }

  if (recentHRV && recentHRV.weightedRMSSD > 0) {
    // Full recovery score available — sleep score first, so it can feed recovery's sleep term.
    const historyBefore = nightlyHRV.filter((n) => n.date < recentHRV.date);
    const sleepScore = recentSession
      ? computeSleepScore(recentSession, recentHRV.overnightHR, daytimeHR, sleepSessions).score
      : 0;
    // RHR term uses our overnight SLEEP HR — Apple's HKRestingHeartRate LAGS a day and doesn't correlate
    // with Bevel's resting HR (see debug 2026-07-03). The linear model's coefficients will be re-fit to
    // OUR metrics once the 60-day nightly series is regressed against Bevel's recovery.
    const sleepHRVals = historyBefore.map((n) => n.overnightHR).filter((v) => v > 0);
    const { score, baseline, trend, breakdown } = computeRecoveryScore(
      recentHRV.weightedRMSSD,
      recentHRV.overnightHR,
      historyBefore,
      sleepHRVals,
      sleepScore,
      recentNightRR,
      rrBaseline,
    );
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
      breakdown,
    };
  } else if (recentSession) {
    // Sleep session found but HRV not yet synced — show partial recovery card
    const sleepScore = computeSleepScore(recentSession, 0, daytimeHR, sleepSessions).score;
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

  // ── Step 10: Training load (CTL/ATL/TSB) ──────────────────────────────────
  // Cardio Load = HR-based Banister TRIMP per day (Bevel-style) — only elevated-HR
  // effort counts, so rest/easy days read low instead of being propped up by
  // everyday-movement energy. Warm the EWMAs CARDIO_WARM_DAYS days before the visible window.
  // Display ~45 days (card shows the latest value + a 30-day sparkline); warm CARDIO_WARM_DAYS days
  // before that so today's CTL/ATL is converged without querying a whole year of HR.
  const clWarm = daysAgo(45 + CARDIO_WARM_DAYS);
  const [loadByDay, floorByDay] = await Promise.all([
    fetchDailyCardioTrimp(clWarm, now, await getEffectiveMaxHr()),
    fetchActivityFloorByDay(clWarm, now),
  ]);
  const trainingLoad: DailyLoad[] = computeTrainingLoadSeries(loadByDay, daysAgo(45), now, floorByDay);
  // Refresh the cached robust observed max HR so getEffectiveMaxHr can auto-anchor (fire-and-forget).
  computeRobustObservedMaxHr().then((v) => { if (v > 0) setObservedMaxHr(v); }).catch(() => {});

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
    .filter(w => trainingDayKey(toISOStr(w.startDate)) === trainingDayKey(now))
    .map(w => {
      const s = new Date(toISOStr(w.startDate)).getTime();
      return { s, e: s + workoutDurationSec(w) * 1000 };
    });
  // %max-HR strain zones need the TRUE max HR — the set value, else the robust observed peak (auto-anchor).
  const strainMaxHR = await getEffectiveMaxHr();
  // Zone-weighted active+passive strain load (workout HR full weight, background HR ×fraction).
  const activeZoneLoad = zoneStrainLoad(
    (todayHr as any[]).map((s: any) => ({ t: new Date(toISOStr(s.startDate)).getTime(), hr: s.quantity as number })),
    restHRForTrimp,
    strainMaxHR,
    todayWindows,
  );
  // NO-HR WORKOUT FALLBACK (2026-07-19). zoneStrainLoad integrates HR samples INSIDE each workout window,
  // so a logged workout with no heart-rate data contributes exactly ZERO — a 68-min / 224-kcal walk read as
  // no strain at all, while the Strain Buildup list showed it at 22 (that list uses the kcal-based
  // computeWorkoutLoad). Geert: "the main strain number only contains the runs, not the walks, while it was
  // calculated and shown." That's a DATA-AVAILABILITY artifact, not physiology — the walk was real work.
  // The same reasoning already drives activityFloorTrimp for the CTL/ATL path; strain never got it.
  // Fallback = durationMin × activityFactor(type), the SAME per-activity-type intensity constant
  // computeWorkoutLoad uses when kcal is missing — no new magic number. Scale check: for a Z2 run the
  // fallback (min × 1.0) equals what the HR path yields (min × Z2 weight 1), so the two agree.
  // Strength types are EXCLUDED here — they're already counted in muscularLoad below (no double-count).
  const STRENGTH_TYPES = new Set([20, 50]);
  const hrPts = (todayHr as any[]).map((s: any) => ({ t: new Date(toISOStr(s.startDate)).getTime(), hr: s.quantity as number }));
  // PER-ACTIVITY loads — strain is now summed per activity (see computeDayStrain), so each workout needs
  // its OWN zone load rather than one lumped total. Falls back to duration × activityFactor when the
  // workout carries no HR at all.
  const activityLoads: number[] = [];
  let noHrWorkoutLoad = 0;
  for (const w of (loadWorkoutsRaw as any[])) {
    if (trainingDayKey(toISOStr(w.startDate)) !== trainingDayKey(now)) continue;
    if (STRENGTH_TYPES.has(w.workoutActivityType)) continue;
    const ws = new Date(toISOStr(w.startDate)).getTime();
    const we = ws + workoutDurationSec(w) * 1000;
    const hasHr = hrPts.some(p => p.t >= ws && p.t <= we && p.hr > restHRForTrimp);
    if (hasHr) {
      activityLoads.push(zoneStrainLoad(hrPts, restHRForTrimp, strainMaxHR, [{ s: ws, e: we }]));
    } else {
      const fb = (workoutDurationSec(w) / 60) * activityFactor(w.workoutActivityType);
      noHrWorkoutLoad += fb;
      activityLoads.push(fb);
    }
  }

  let muscularLoad = 0;
  for (const w of (loadWorkoutsRaw as any[])) {
    if (!STRENGTH_TYPES.has(w.workoutActivityType)) continue;
    if (trainingDayKey(toISOStr(w.startDate)) !== trainingDayKey(now)) continue;
    muscularLoad += workoutDurationSec(w) / 60; // ~1 TRIMP-equiv per active minute
  }
  const latestLoad = trainingLoad.length > 0 ? trainingLoad[trainingLoad.length - 1] : null;
  const latestTsb = latestLoad?.tsb ?? 0;
  // 14-day strain BASELINE (mean of completed days) — personalizes the target range to the athlete's
  // own volume, Bevel-style. Best-effort; degrades to the fixed conservative map if unavailable.
  const strainBaseline = await fetchStrainHistory(0.5, now)
    .then((h) => {
      const vals = h.filter((s) => s.date < todayStr).map((s) => s.value).slice(-14);
      return vals.length >= 4 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    })
    .catch(() => 0);
  // Advisable strain band from the full picture — baseline + recovery + sleep + form + ACWR —
  // not recovery alone.
  const advisable = advisableStrainRange({
    recovery:   todayRecovery?.recoveryScore,
    sleepScore: todayRecovery?.sleepScore,
    tsb:        latestTsb,
    ctl:        latestLoad?.ctl,
    atl:        latestLoad?.atl,
    baseline:   strainBaseline,
  });
  // Heat inflates the day's strain (a given effort costs more in the heat) — apply the same
  // factor the coach uses to scale sessions. Best-effort + cached; no weather → factor 1.
  const heatFactor = heatStrainFactor(await getLocalWeather().catch(() => null));
  // Passive strain = NON-WORKOUT steps (workout steps count as active via HR). ≈ Bevel's steps/470.
  // Raw step samples double-count iPhone+Watch, so take the non-workout fraction × de-duped total.
  const [todayStepSamples, todayStepsDedup] = await Promise.all([
    fetchStepSamples(todayStart, now),
    dailyCumulativeSum(HKQuantityTypeIdentifier.stepCount, 'count', todayStart, now),
  ]);
  const inTodayWin = (t: number) => todayWindows.some((w) => t >= w.s && t <= w.e);
  const rawTot = todayStepSamples.reduce((s, x) => s + x.steps, 0);
  const rawNw  = todayStepSamples.reduce((s, x) => s + (inTodayWin(x.t) ? 0 : x.steps), 0);
  const dedupTot = [...todayStepsDedup.values()][0] ?? 0;
  const todayNwSteps = rawTot > 0 ? dedupTot * (rawNw / rawTot) : dedupTot;
  // Always compute (real may be 0 early in the day) so the ring shows "0%" + the
  // safe range rather than "--". Only null when there's no HR data at all today.
  // recoveryScore is now floored at 1 for any real night (see computeRecoveryScore), so 0 = no data:
  // `?? 0` cleanly passes a genuine low score through and only a missing night lands on 0 → neutral 55.
  const strain: DayStrain | null = (todayHr as any[]).length > 0
    ? computeDayStrain(activeZoneLoad + noHrWorkoutLoad, muscularLoad, todayRecovery?.recoveryScore ?? 0, latestTsb, stepStrainLoad(todayNwSteps), advisable, heatFactor, activityLoads)
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

  // Rolling, recency-weighted per-intensity TRIMP/min calibration from the runner's OWN runs
  // (day cardio-TRIMP ÷ run minutes). Recomputed every sync so it tracks changing fitness.
  const trimpLoadByDate = new Map(trainingLoad.map(d => [d.date, d.load]));
  // Threshold (sustained Z4) is a HARD per-minute dose — grouping it with intervals keeps it from
  // inflating the 'moderate' (tempo) rate, which was the reason to split it out from Tempo.
  const runIntensity = (label?: string): 'easy' | 'moderate' | 'hard' =>
    (label === 'Intervals' || label === 'Threshold') ? 'hard'
      : (label === 'Tempo' || label === 'LongRun') ? 'moderate' : 'easy';
  const trimpRates = calibrateTrimpRates(runs.map(r => ({
    intensity: runIntensity(r.label),
    // TOTAL run minutes, NOT workDuration: the 7-day-plan projection prescribes in run-minutes (time-on-feet),
    // so the rate must be dayLoad ÷ those same minutes. Dividing by work-only minutes (~0.6× the run) inflated
    // the rate ~1.8× → the projection over-stated every run's load → phantom deep-negative TSB days (it trimmed
    // a full long to fit a −16 floor it would never actually reach). Fixed 2026-07-10 from Geert's paired data
    // (runs load ~1.0 TRIMP/run-min, but the rate read 1.77/min).
    minutes:   r.duration / 60,
    dayLoad:   trimpLoadByDate.get(r.date.slice(0, 10)) ?? 0,
    daysAgo:   (now.getTime() - new Date(r.date).getTime()) / 86_400_000,
  })));

  progress('Done', 100);

  const athleteStatus = await getAthleteStatus();
  const supplementContext = buildSupplementContext(await loadSupplements());
  return {
    runs,
    activities:    recentActivities,
    trainingLoad,
    trimpRates,
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
    // Lean FULL nightly series (every night with HRV) — for the Bevel recovery re-fit over 60-90 days
    // (the -14 copy above is just for display). date / weightedRMSSD / overnight sleep-HR.
    nightlyLean: nightlyHRV
      .filter((n) => n.weightedRMSSD > 0)
      .map((n) => ({ d: n.date, h: Math.round(n.weightedRMSSD * 10) / 10, s: Math.round(n.overnightHR * 10) / 10 })),
    recentSleep:      sleepSessions.slice(-14),
    workoutTypeStats: computeWorkoutTypeStats(runs),
    // A USER-SET max HR must govern the whole app — zones/body-battery/strain-detail all read this
    // field. So the set value wins here too; only when unset do we fall back to the classifier's
    // observed run estimate. (This is what made a set max HR not reach the prescribed HR zones.)
    estimatedMaxHR:   (await getUserMaxHr()) || maxHR,
    fetchedAt:        now.toISOString(),
    timelineEvents:   events as TimelineEvent[],
    athleteStatus,
    supplementContext,
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
  hrDiag?:        string;            // DEBUG: raw HR sample count · avg · span · per-source breakdown
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
    // For the partial FINAL km, prefer the AUTHORITATIVE distance = total − full km's already
    // counted (lap km's are exactly 1 km each). The old code divided by GPS-filtered metres,
    // which over-counted (catch-up/cooldown segments) → an impossibly fast final km (e.g. 4:07
    // with easy HR/power). Fall back to gpsMtrs only when the total isn't known.
    const remainderM = (kmN === nKm && maxDistM > 100) ? maxDistM - (nKm - 1) * 1000 : 0;
    const partialKmM = (remainderM > 10 && remainderM < 1000) ? remainderM
                     : (gpsMtrs > 10 && gpsMtrs < 950)       ? gpsMtrs
                     : 0;
    const paceSecs = partialKmM > 0
      ? Math.round(netSec / (partialKmM / 1000))
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

  // Upper bound for keeping samples: the workout's ACTUAL elapsed end (startDate→endDate,
  // which already includes any pause time), plus a small buffer. The fetch window over-reaches
  // by +20 min on purpose (to be safe), but KEEPING all of it dragged 10–20 min of POST-RUN
  // recovery HR into the average and the chart tail — e.g. avg 91 vs the workout's true ~130,
  // with a long drooping tail — because older runs have sparse HR so the recovery samples
  // dominate. Clip to the real run end so the trace + avg reflect the workout only.
  const workoutForEnd = (workoutRaw as any[]).find(
    (w: any) => Math.abs(new Date(toISOStr(w.startDate)).getTime() - startMs) < 10_000
  );
  const workoutEndMs = workoutForEnd?.endDate
    ? new Date(toISOStr(workoutForEnd.endDate)).getTime() - startMs
    : durationSec * 1000;
  // Never clip TIGHTER than net duration (guards a bogus/short endDate), never LOOSER than the
  // fetched window. +30 s buffer catches a boundary sample written just after the last lap.
  const clipMax = Math.min(to.getTime() - startMs, Math.max(durationSec * 1000, workoutEndMs) + 30_000);
  const clip = (t: number) => t >= -60_000 && t <= clipMax;

  // NOTE: the workout-predicate query (filter:{workout}) does NOT scope with a bridged workout
  // object — it dumps the whole history (hits the limit) → reverted. Use the time-window query.
  const hrSrcSamples = hrRaw as any[];
  const powerSrcSamples = powerRaw as any[];

  // Collect raw HR points, then downsample to 1/s
  const hrRaw2 = hrSrcSamples
    .map((s: any) => ({ t: new Date(toISOStr(s.startDate)).getTime() - startMs, v: Math.round(s.quantity as number) }))
    .filter(p => clip(p.t));
  const hrDiscrete = downsampleTo1PerSecond(hrRaw2);
  const powerRaw2 = powerSrcSamples
    .map((s: any) => ({ t: new Date(toISOStr(s.startDate)).getTime() - startMs, v: Math.round(s.quantity as number) }))
    .filter(p => clip(p.t));
  const powerDiscrete = downsampleTo1PerSecond(powerRaw2);

  // ── Dense fallback via HKQuantitySeriesSampleQuery (native) ─────────────────
  // Older Apple-Watch runs store dense workout HR / power as a HKQuantitySeries the JS
  // library's sample query can't expand — we get only sparse stray samples (~10 across a
  // 42-min run) while Apple draws the full curve. Our native module expands the series
  // (the same HKQuantitySeriesSampleQuery Apple uses). Query the full window, clip, 1-Hz.
  const expandSeries = async (typeId: string): Promise<{ t: number; v: number }[]> => {
    if (!seriesNative) return [];
    try {
      const raw = await seriesNative.queryQuantitySeries(typeId, from.getTime(), to.getTime());
      const pts = (raw ?? [])
        .map(p => ({ t: p.t - startMs, v: Math.round(p.v) }))
        .filter(p => clip(p.t));
      return downsampleTo1PerSecond(pts);
    } catch { return []; }
  };
  const [hrSeries, powerSeries] = await Promise.all([
    expandSeries('HKQuantityTypeIdentifierHeartRate'),
    expandSeries('HKQuantityTypeIdentifierRunningPower'),
  ]);

  // Use whichever source is densest (series wins for old runs; discrete stays for recent H10 runs).
  const hr    = hrSeries.length    > hrDiscrete.length    ? hrSeries    : hrDiscrete;
  const power = powerSeries.length > powerDiscrete.length ? powerSeries : powerDiscrete;

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

  // Pace: derived from distance segments (each = GPS track point). Older runs store distance
  // as a HKQuantitySeries too, so the plain samples are coarse (~25 points) — expand the series
  // for a smooth curve when it's denser, then bucket into fixed windows (also removes GPS jitter).
  let distSegsForPace: { t0: number; t1: number; m: number }[] = (distRaw as any[]).map((s: any) => ({
    t0: new Date(toISOStr(s.startDate)).getTime() - startMs,
    t1: new Date(toISOStr(s.endDate)).getTime()   - startMs,
    m:  s.quantity as number,
  }));
  if (seriesNative) {
    try {
      const draw = await seriesNative.queryQuantitySeries('HKQuantityTypeIdentifierDistanceWalkingRunning', from.getTime(), to.getTime());
      if ((draw?.length ?? 0) > distSegsForPace.length) {
        distSegsForPace = draw.map(s => ({ t0: s.t - startMs, t1: s.tEnd - startMs, m: s.v }));
      }
    } catch { /* keep GPS segments */ }
  }
  // Bucket distance into fixed windows → pace = the bucket's ACTUAL summed duration ÷ its summed km.
  // (Using a FIXED window duration as the numerator was wrong: buckets rarely hold exactly one window
  // of running time, so pace combed between impossibly fast and slow. Summing both dur & dist keeps
  // the ratio correct regardless of how many measurements land in the bucket.)
  const denseDist = distSegsForPace.length > 60;
  const PBUCKET = denseDist ? 5_000 : 0;    // 5-s buckets for a dense series; keep per-segment otherwise
  const rawPace: { t: number; v: number }[] = [];
  if (denseDist) {
    const byBucket = new Map<number, { dist: number; durMs: number }>();
    for (const seg of distSegsForPace) {
      const mid = (seg.t0 + seg.t1) / 2;
      if (!clip(mid) || seg.m <= 0 || seg.t1 <= seg.t0) continue;
      const b = Math.floor(mid / PBUCKET);
      const e = byBucket.get(b) ?? { dist: 0, durMs: 0 };
      e.dist += seg.m; e.durMs += (seg.t1 - seg.t0);
      byBucket.set(b, e);
    }
    for (const [b, e] of [...byBucket.entries()].sort((a, c) => a[0] - c[0])) {
      const spk = (e.durMs / 1000) / (e.dist / 1000);   // actual s per km over the bucket
      if (e.dist > 0.5 && e.durMs > 0 && spk > 120 && spk < 1200) rawPace.push({ t: b * PBUCKET + PBUCKET / 2, v: Math.round(spk) });
    }
  } else {
    for (const seg of distSegsForPace) {
      const durSec = (seg.t1 - seg.t0) / 1000;
      const mid    = (seg.t0 + seg.t1) / 2;
      if (!clip(mid) || !(seg.m > 0.5 && durSec > 0)) continue;
      const spk = durSec / (seg.m / 1000);
      if (spk > 120 && spk < 1200) rawPace.push({ t: mid, v: Math.round(spk) });
    }
  }
  // Light rolling smoothing (skip for the dense/bucketed path — already smooth, and O(n²) would bite).
  const PACE_SMOOTH_MS = 10_000;
  const pace: { t: number; v: number }[] = denseDist ? rawPace : rawPace.map((p, i, arr) => {
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
  // Pass the DENSE (series-expanded) hr/power so per-km + segment averages aren't blank on
  // older runs — the sparse discrete hrRaw2 left most km's with no HR sample ("—").
  const kmSplits = computeKmSplitsDetail(
    distRaw as any[], hr, power, cadenceRaw2, stepSegs,
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

  // ── HR source diagnostic (why does our trace look flat/low vs the Apple app?) ──
  // A raw time-window HR query returns EVERY source that wrote a sample in the
  // window; downsampleTo1PerSecond then AVERAGES overlapping sources within each
  // 1-second bucket. So a duplicate low/optical series (or a phone "resting" series)
  // drags the trace toward its value and flattens it — exactly the ~100/avg-89 shape.
  // This one-liner shows raw-vs-downsampled avg, the sample span, and the per-source
  // counts so we can see whether >1 source is being merged.
  let hrDiag: string | undefined;
  {
    // Split the time-window HR into in-run (kept) vs recovery-tail (clipped). Sparse in-run +
    // dense recovery = the workout's real HR is stored as a series our sample query can't expand.
    const arr = hrRaw as any[];
    let inRun = 0, inRunSum = 0;
    for (const s of arr) {
      const t = new Date(toISOStr(s.startDate)).getTime() - startMs;
      if (t >= -60_000 && t <= clipMax) { inRun++; inRunSum += (s.quantity as number); }
    }
    const inRunAvg  = inRun ? Math.round(inRunSum / inRun) : 0;
    const runMin    = Math.round(clipMax / 60_000);
    const usedSeries = hr === hrSeries && hrSeries.length > 0;
    const hrFinalAvg = hr.length ? Math.round(hr.reduce((a, p) => a + p.v, 0) / hr.length) : 0;
    const nativeOn  = seriesNative ? 'y' : 'n';
    hrDiag = `discrete inRun ${inRun}(avg ${inRunAvg}) + recov ${arr.length - inRun} · series[native:${nativeOn}] hr ${hrSeries.length}/pwr ${powerSeries.length} · using ${usedSeries ? 'SERIES' : 'discrete'} → ${hr.length}pts (avg ${hrFinalAvg}, ${runMin}min)`;
  }

  return { hr, power: powerClean, pace: paceClean, totalMs: durationSec * 1000, activities, kmSplits, pauseIntervals: pauseIntervs, weatherTempC: extractWeatherTempC(workout), debugUuids, debugEvents, hrDiag };
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
      map.set(toLocalDateStr(d), Math.round(kcal)); // LOCAL date — buckets are local-midnight anchored
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
// Warm-up window for the CTL/ATL EWMAs when the load basis is HR-TRIMP. The recent value (today's cardio
// load, what the card shows) is always exact because we query newest-first.
// The 42-day CTL EWMA is seeded at the first warm-up day, so it must warm ENOUGH days before the display
// window to forget that seed — otherwise CTL depends on the selected range (Geert saw 1M 40 / 3M 42 / 6M 41
// because the shorter ranges warmed less far back). 120 (~2.9τ) left ~6% seed error; 240 (~5.7τ) drives it
// to ~0.3% so CTL is range-INVARIANT and matches HealthFit. (Per-day TRIMP is cached, so the extra warm-up
// days are mostly cache reads — see harness/ctlrange.mjs.)
const CARDIO_WARM_DAYS = 240;

/**
 * Compute daily cardio TRIMP for one window by querying HR. Day keys are LOCAL dates.
 * Used by the cached wrapper below in bounded chunks so a single query never exceeds the
 * sample cap (which would truncate and corrupt long windows).
 */
async function computeCardioTrimpWindow(fromDate: Date, toDate: Date, maxForDay?: (day: string) => number): Promise<Map<string, number>> {
  const [hrRaw, restingRaw, workouts, powerRaw, pz] = await Promise.all([
    safeQuery(() => (HealthKit.queryQuantitySamples as any)(
      HKQuantityTypeIdentifier.heartRate,
      { filter: { startDate: fromDate, endDate: toDate }, unit: 'count/min', ascending: false, limit: 200_000 },
    ), [] as any[]),
    safeQuery(() => (HealthKit.queryQuantitySamples as any)(
      HKQuantityTypeIdentifier.restingHeartRate,
      { filter: { startDate: fromDate, endDate: toDate }, unit: 'count/min', ascending: true, limit: 400 },
    ), [] as any[]),
    safeQuery(() => (HealthKit.queryWorkoutSamples as any)({
      filter: { startDate: fromDate, endDate: toDate }, limit: 1500, ascending: true, energyUnit: 'kcal', distanceUnit: 'm',
    }), [] as any[]),
    // Running power — used to REPAIR TRIMP on run windows whose measured HR is unreliable (flat/dropped).
    safeQuery(() => (HealthKit.queryQuantitySamples as any)(
      HKQuantityTypeIdentifier.runningPower,
      { filter: { startDate: fromDate, endDate: toDate }, unit: 'W', ascending: true, limit: 200_000 },
    ), [] as any[]),
    getPowerZones().catch(() => null),
  ]);

  const out = new Map<string, number>();
  if ((hrRaw as any[]).length === 0) return out;

  const restVals = (restingRaw as any[]).map((s: any) => s.quantity as number).filter(v => v > 0).sort((a, b) => a - b);
  const restHR = restVals.length > 0 ? Math.round(restVals[Math.floor(restVals.length / 2)]) : 50;

  let peak = 0;
  const byDay = new Map<string, { t: number; hr: number }[]>();
  for (const s of (hrRaw as any[])) {
    const hr = s.quantity as number;
    if (hr > peak) peak = hr;
    const d   = new Date(toISOStr(s.startDate));
    const day = trainingDayKey(d); // 4am training-day boundary — overnight HR belongs to the previous day
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push({ t: d.getTime(), hr });
  }
  // Max HR drives the %HRR the Banister TRIMP is exponential in. Per-day via the resolver (honours a
  // date-keyed "from now" change); a peak-based estimate (clamped) covers days the resolver can't.
  const fallbackMax = Math.max(185, Math.min(205, Math.round(peak)));

  // Runs the USER manually flagged "HR monitor unreliable" — the auto-detector only catches flat-lined /
  // dropped-beat patterns above its threshold, so a partially-bad strap can slip through it. Honour the
  // manual flag too, else that run's HR-TRIMP under-counts and the whole DAY reads low (a multi-run day
  // silently loses one run's load).
  const manualBadHr = await getHrUnreliableRuns().catch(() => ({} as Record<string, boolean>));
  const windowsByDay = new Map<string, { s: number; e: number; uuid?: string }[]>();
  for (const w of (workouts as any[])) {
    const wd  = new Date(toISOStr(w.startDate));
    const day = toLocalDateStr(wd);
    if (!windowsByDay.has(day)) windowsByDay.set(day, []);
    windowsByDay.get(day)!.push({ s: wd.getTime(), e: wd.getTime() + workoutDurationSec(w) * 1000, uuid: w.uuid });
  }

  // Power samples grouped by local day (only runs have power) → used to repair unreliable-HR run windows.
  const powerByDay = new Map<string, { t: number; w: number }[]>();
  for (const s of (powerRaw as any[])) {
    const day = toLocalDateStr(new Date(toISOStr(s.startDate)));
    if (!powerByDay.has(day)) powerByDay.set(day, []);
    powerByDay.get(day)!.push({ t: new Date(toISOStr(s.startDate)).getTime(), w: s.quantity as number });
  }
  const p2h = pz && isPowerZonesConfigured(pz) ? powerToHrrFrac(pz) : null;

  // ── Series-HR backfill for sparse run windows ──────────────────────────────
  // Old Apple-Watch runs store dense workout HR as a HKQuantitySeries the bulk query returns
  // only sparsely (~10 stray points) → their daily TRIMP (→ CTL) under-counts. Expand the series
  // per SPARSE run window (< 4 samples/min; recent dense runs skip it) and merge the dense HR into
  // that day's samples so the load is counted correctly. Gated + cached-per-day → one-time cost.
  if (seriesNative) {
    for (const wins of windowsByDay.values()) {
      for (const win of wins) {
        const dayKey = trainingDayKey(new Date(win.s));
        const dayHr  = byDay.get(dayKey);
        if (!dayHr) continue;
        const durMin = Math.max(1, (win.e - win.s) / 60_000);
        const inWin  = dayHr.reduce((n, p) => n + (p.t >= win.s && p.t <= win.e ? 1 : 0), 0);
        if (inWin / durMin >= 4) continue;                 // already dense → skip
        let dense: { t: number; v: number }[] = [];
        try {
          dense = await seriesNative.queryQuantitySeries('HKQuantityTypeIdentifierHeartRate', win.s - 30_000, win.e + 30_000);
        } catch { continue; }
        if (dense.length <= inWin) continue;               // series no denser → keep discrete
        const kept = dayHr.filter(p => p.t < win.s || p.t > win.e);
        for (const p of dense) kept.push({ t: p.t, hr: Math.round(p.v) });
        byDay.set(dayKey, kept);
      }
    }
  }

  for (const [day, samples] of byDay) {
    samples.sort((a, b) => a.t - b.t); // TRIMP integration needs time order
    const dm = maxForDay?.(day);
    const maxHR = dm && dm > 0 ? dm : fallbackMax;
    const windows = windowsByDay.get(day) ?? [];
    // Repair: for each workout window whose measured HR is untrustworthy AND has running power, swap the
    // HR-integrated TRIMP for a power-derived one (keeps flat-lined / dropped-beat runs from under-counting).
    const repairs: TrimpRepair[] = [];
    if (p2h && windows.length) {
      const dayPower = powerByDay.get(day) ?? [];
      for (const win of windows) {
        // Repair if EITHER the auto-detector fires OR the user flagged this run by hand.
        const flagged = !!(win.uuid && (manualBadHr as Record<string, boolean>)[win.uuid]);
        if (!flagged && !assessHrReliability(samples, win.s, win.e).unreliable) continue;
        const winPow = dayPower.filter(p => p.t >= win.s && p.t <= win.e);
        if (winPow.length < 5) continue;               // no/too-little power (not a run) → can't repair
        const tr = powerTrimp(winPow, win.s, win.e, p2h);
        if (tr > 0) repairs.push({ s: win.s, e: win.e, trimp: tr });
      }
    }
    out.set(day, computeStrainTrimp(samples, restHR, maxHR, windows, repairs));
  }
  return out;
}

// ─── Cached daily cardio TRIMP ────────────────────────────────────────────────
// Per-day TRIMP is expensive (HR query). We persist each day's value once and only
// recompute the recent tail (today is intra-day; yesterday can still receive watch
// data). Missing older days are filled in bounded chunks so each HR query stays under
// the sample cap — which keeps 6M/1Y views accurate and makes the home load fast after
// the first run. It's a derived cache, so it's intentionally excluded from backups.
const TRIMP_CACHE_FILE      = `${FileSystem.documentDirectory}cardio-trimp-cache.json`;
const TRIMP_CHUNK_DAYS      = 45;
const TRIMP_RECOMPUTE_TAIL  = 2;

// TRIMP-per-day depends on each session's classified intensity, so a reclassification must drop this.
export async function clearTrimpCache(): Promise<void> {
  try { await FileSystem.deleteAsync(TRIMP_CACHE_FILE, { idempotent: true }); } catch {}
}

async function loadTrimpCache(): Promise<Record<string, number>> {
  try {
    const info = await FileSystem.getInfoAsync(TRIMP_CACHE_FILE);
    if (!info.exists) return {};
    return JSON.parse(await FileSystem.readAsStringAsync(TRIMP_CACHE_FILE)) as Record<string, number>;
  } catch { return {}; }
}
async function saveTrimpCache(obj: Record<string, number>): Promise<void> {
  try { await FileSystem.writeAsStringAsync(TRIMP_CACHE_FILE, JSON.stringify(obj)); } catch { /* ignore */ }
}
function listDayKeys(from: Date, to: Date): string[] {
  const out: string[] = [];
  const cur = new Date(from); cur.setHours(0, 0, 0, 0);
  const end = new Date(to);   end.setHours(0, 0, 0, 0);
  while (cur.getTime() <= end.getTime()) { out.push(toLocalDateStr(cur)); cur.setDate(cur.getDate() + 1); }
  return out;
}

/**
 * Daily CARDIO load = HR-based Banister TRIMP per day (Bevel-style), cached. Returns the
 * map for [fromDate, toDate]; recomputes only today + yesterday each call, fills any
 * uncached older days in chunks, and persists the result.
 */
export async function fetchDailyCardioTrimp(fromDate: Date, toDate: Date, userMaxHr?: number): Promise<Map<string, number>> {
  const fallback  = userMaxHr && userMaxHr > 0 ? userMaxHr : 0;
  const history   = await getMaxHrHistory();
  const maxForDay = buildMaxHrResolver(history, fallback);
  let cache = await loadTrimpCache();
  // TRIMP depends (non-linearly) on max HR, so if the effective max HR (or its date-keyed segments)
  // changed, drop the whole cache and recompute — otherwise old days keep stale, differently-scaled
  // values. `__maxHr` is a sentinel (not a date key, so it's never iterated as a day).
  const tag = history.length ? 'k:' + history.map((h) => `${h.from}@${h.maxHR}`).join(',') : `s:${fallback}`;
  const TRIMP_CACHE_VER = 7; // v7: daily-TRIMP path also expands the HR series for sparse run windows → old-period CTL (2026-08-20)
  if ((cache as any)['__maxHr'] !== tag || cache['__ver'] !== TRIMP_CACHE_VER) cache = { '__maxHr': tag, '__ver': TRIMP_CACHE_VER } as any;
  let changed = false;

  // 1) Recent tail — always fresh (today partial, yesterday may have synced more).
  const tailStart = daysAgo(TRIMP_RECOMPUTE_TAIL);
  const tailFrom  = tailStart.getTime() > fromDate.getTime() ? tailStart : fromDate;
  const tail = await computeCardioTrimpWindow(tailFrom, toDate, maxForDay);
  for (const d of listDayKeys(tailFrom, toDate)) { cache[d] = tail.get(d) ?? 0; changed = true; }

  // 2) Fill still-missing older days in bounded chunks (skip fully-cached chunks).
  const fillEnd = new Date(tailStart); fillEnd.setHours(0, 0, 0, 0);
  let cursor = new Date(fromDate); cursor.setHours(0, 0, 0, 0);
  while (cursor.getTime() < fillEnd.getTime()) {
    const chunkEnd  = new Date(Math.min(cursor.getTime() + TRIMP_CHUNK_DAYS * 86_400_000, fillEnd.getTime()));
    const chunkDays = listDayKeys(cursor, new Date(chunkEnd.getTime() - 86_400_000));
    if (chunkDays.some(d => !(d in cache))) {
      const m = await computeCardioTrimpWindow(cursor, chunkEnd, maxForDay);
      for (const d of chunkDays) cache[d] = m.get(d) ?? 0;
      changed = true;
    }
    cursor = chunkEnd;
  }
  if (changed) await saveTrimpCache(cache);

  const out = new Map<string, number>();
  for (const d of listDayKeys(fromDate, toDate)) if (d in cache) out.set(d, cache[d]);
  return out;
}

/**
 * Per-day NEAT/activity floor over [from,to] (LOCAL keys) — feeds computeTrainingLoadSeries so rest /
 * unlogged-walk days don't collapse to ~0 (Bevel scores them via energy/steps). Must span the CTL
 * warm-up window, else zeroed rest days there still drag the 42-day EWMA down.
 */
async function fetchActivityFloorByDay(from: Date, to: Date): Promise<Map<string, number>> {
  const [active, exercise] = await Promise.all([
    fetchDailyActiveEnergy(from, to),
    dailyCumulativeSum(HKQuantityTypeIdentifier.appleExerciseTime, 'min', from, to),
  ]);
  const out = new Map<string, number>();
  for (const d of new Set<string>([...active.keys(), ...exercise.keys()])) {
    out.set(d, activityFloorTrimp(active.get(d) ?? 0, exercise.get(d) ?? 0));
  }
  return out;
}

export async function fetchTrainingLoadHistory(
  months: number,
  toDate?: Date,
): Promise<DailyLoad[]> {
  const end      = toDate ?? new Date();
  const fromDate = new Date(end.getTime() - months * 30 * 86_400_000);
  const warmFrom = new Date(fromDate.getTime() - CARDIO_WARM_DAYS * 86_400_000);
  // Cardio Load = HR-TRIMP per day (Bevel-style), floored by NEAT/activity so rest days aren't ~0.
  const [loadByDay, floorByDay] = await Promise.all([
    fetchDailyCardioTrimp(warmFrom, end, await getEffectiveMaxHr()),
    fetchActivityFloorByDay(warmFrom, end),
  ]);
  return computeTrainingLoadSeries(loadByDay, fromDate, end, floorByDay);
}

/**
 * CTL/ATL calibration export — copied to the clipboard from the Training Load screen so the daily
 * load / CTL / ATL / TSB series + the model params can be correlated OFF-DEVICE against Bevel's
 * "Cardio Load" and HealthFit's Fitness/Fatigue, to back out any scale/bias correction. Per-day
 * kcal / exercise-min / steps are included so a low day can be traced to missing workout coverage
 * vs a genuine easy day.
 */
/**
 * Aerobic-base outlook via DECOUPLING (Pw:HR, else speed:HR) — how much efficiency drifts across a
 * steady long run. Median <5% over recent steady runs = base solid → aerobically ready for a quality
 * dose; higher = keep building easy time-on-feet. Hot runs (HR-inflated) and interval/variable runs
 * (high HR CV) are flagged so the median is over clean, steady long efforts only. Computed from each
 * run's per-km splits (avgHR + avgPower + pace), first-half vs second-half, warm-up km dropped.
 */
export async function analyzeAerobicBase(): Promise<any> {
  const snap = await loadSnapshotCache();
  const HEAT_C = 19;          // heat-sensitive athlete — HR drifts by ~19°C, so warmer runs confound decoupling
  const MIN_DUR_MIN = 45;     // decoupling only develops over a genuinely long steady effort
  const MIN_KM = 5;
  const allRuns = (snap?.runs ?? []);
  // Candidates: recent runs long enough to develop drift. kmSplits live in the per-run detail
  // (computed lazily, one run/scan on snap.runs), so fetch each candidate's detail.
  const candidates = allRuns
    .filter((r) => (r.distance ?? 0) >= 4000 && (r.duration ?? 0) >= 1500)
    .slice(0, 8);

  const rows: any[] = [];
  const diagnostics: any[] = [];
  for (const r of candidates) {
    let detail: any = null;
    try { detail = await fetchWorkoutDetail(r.date, r.duration); } catch { /* skip */ }
    const splits = ((detail?.kmSplits ?? []) as any[]).filter((s) => s.avgHR > 0 && s.paceSecs > 0);
    const durMin = Math.round((r.duration ?? 0) / 60);
    diagnostics.push({ date: String(r.date).slice(0, 10), distKm: Math.round((r.distance ?? 0) / 100) / 10, durMin, label: r.label ?? null, splitCount: splits.length });
    if (splits.length < 5 || !detail) continue;
    // Canonical decoupling — the SAME calc as the Statistics chart (Pw:HR → speed:HR → km-splits, with the
    // steadiness gate), so this outlook and the chart can never quote different numbers for the same run.
    const dc = runDecouple(detail);
    if (dc == null) continue;
    const usable = splits.slice(1);
    const hrs = usable.map((s) => s.avgHR);
    const hrMean = hrs.length ? hrs.reduce((a, b) => a + b, 0) / hrs.length : 0;
    const hrSd = hrs.length ? Math.sqrt(hrs.reduce((a, h) => a + (h - hrMean) ** 2, 0) / hrs.length) : 0;
    const cv = hrMean ? Math.round((hrSd / hrMean) * 1000) / 10 : 0;          // HR variability across kms → steadiness
    const tempC = detail?.weatherTempC ?? r.tempC ?? null;
    rows.push({
      date: String(r.date).slice(0, 10), km: usable.length + 1, durMin, avgHR: Math.round(hrMean),
      decouplePct: dc, hrCVpct: cv, tempC,
      hot: tempC != null && tempC >= HEAT_C, steady: cv < 8, longEnough: durMin >= MIN_DUR_MIN && (usable.length + 1) >= MIN_KM,
    });
  }

  const clean = rows.filter((r) => r.steady && !r.hot && r.longEnough && r.decouplePct != null && Math.abs(r.decouplePct) <= DC_GROSS_MAX);
  const median = (a: number[]) => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
  const med = median(clean.map((r) => r.decouplePct));
  const confidence = clean.length >= 3 ? 'ok' : clean.length >= 1 ? 'provisional (few clean long runs — confirm with more)' : 'none';
  const verdict = med == null ? `no clean steady run ≥${MIN_DUR_MIN} min & <${HEAT_C}°C yet — do one to read it`
    : med < 5   ? 'base SOLID (<5%) — aerobically ready to add a small quality dose'
    : med < 7.5 ? 'base DEVELOPING (5–7.5%) — mostly hold; ease intensity in cautiously'
    :             'base BUILDING (>7.5%) — prioritise easy time-on-feet before adding power';
  return {
    method: `decoupling via shared runDecouple() (same as Statistics chart: Pw:HR→speed:HR→km-splits, warm-up excluded, steadiness gate); clean = HR CV <8% AND ≥${MIN_DUR_MIN} min AND ≥${MIN_KM} km AND <${HEAT_C}°C AND |drift|≤${DC_GROSS_MAX}%`,
    totalRuns: allRuns.length, candidatesChecked: candidates.length,
    qualifyingRuns: rows.length, steadyCleanRuns: clean.length, confidence, medianDecouplePct: med, verdict,
    runs: rows, diagnostics,
  };
}

export async function buildTrainingLoadCalibration(months: number, toDate?: Date): Promise<string> {
  const end   = toDate ?? new Date();
  const since = new Date(end.getTime() - months * 30 * 86_400_000);
  const maxHR = await getEffectiveMaxHr();

  const [series, restRaw, active, exercise, steps] = await Promise.all([
    fetchTrainingLoadHistory(months, end),
    safeQuery(() => (HealthKit.queryQuantitySamples as any)(
      HKQuantityTypeIdentifier.restingHeartRate,
      { filter: { startDate: since, endDate: end }, unit: 'count/min', ascending: false, limit: 400 }), [] as any[]),
    fetchDailyActiveEnergy(since, end),
    dailyCumulativeSum(HKQuantityTypeIdentifier.appleExerciseTime, 'min', since, end),
    dailyCumulativeSum(HKQuantityTypeIdentifier.stepCount, 'count', since, end),
  ]);

  const restVals = (restRaw as any[]).map((s: any) => s.quantity as number).filter((v) => v > 0).sort((a, b) => a - b);
  const restHR   = restVals.length ? Math.round(restVals[Math.floor(restVals.length / 2)]) : 0;

  // Per-day: the activity floor now BAKED INTO load (load = max(cardioTrimp, floor)); shown so the
  // rest/easy-day lift is auditable against Bevel/HealthFit.
  const days = series.map((d) => {
    const kcal  = Math.round(active.get(d.date) ?? 0);
    const exMin = Math.round(exercise.get(d.date) ?? 0);
    return {
      d: d.date, load: Math.round(d.load), atl: d.atl, ctl: d.ctl, tsb: d.tsb,
      kcal, exMin, steps: Math.round(steps.get(d.date) ?? 0),
      floor: Math.round(activityFloorTrimp(kcal, exMin)),
    };
  });

  const latest = series[series.length - 1];
  let maxLoad = 0, peakCtl = 0, sumLoad = 0, floorLifted = 0;
  for (const x of days) { if (x.load > maxLoad) maxLoad = x.load; sumLoad += x.load; if (x.load <= x.floor && x.floor > 0) floorLifted++; }
  for (const d of series) if (d.ctl > peakCtl) peakCtl = d.ctl;

  const dump = {
    app: 'RunCoachAI', metric: 'training-load-calibration',
    generatedAt: end.toISOString(), periodMonths: months,
    model: {
      basis: 'Banister HR-TRIMP; workout HR full-weight, NON-workout HR discounted to 10% and only above 40% HRr',
      perSampleTrimp: 'dtMin * HRr * 0.64 * exp(1.92*HRr)  (men Banister)',
      HRr: '(HR - restHR) / (maxHR - restHR), clamped 0..1',
      nonWorkoutDiscount: { passiveFactor: 0.10, onlyAboveHRr: 0.40 },
      gapCapMin: 8,
      neatFloor: {
        trimpPerActiveKcal: 0.030, trimpPerExerciseMin: 0.30,
        note: 'WIRED: daily load = max(cardioTrimp, kcal*0.030, exMin*0.30) — lifts rest/unlogged days off ~0 (fit to Bevel 07-08)',
      },
      ctlTauDays: 42, atlTauDays: 7, warmupDays: 120,
    },
    params: {
      maxHR, maxHrSource: 'getEffectiveMaxHr (user-set, else robust observed peak, else Tanaka)', hrReserve: maxHR - restHR,
      restHR, restHrMin: restVals[0] ?? 0, restHr10thPct: restVals[Math.floor(restVals.length * 0.1)] ?? 0, restHrSamples: restVals.length,
      passiveFactor: 0.10, passiveMinHrr: 0.40, gapCapMin: 8,
      thresholdHourTrimp: Math.round(0.85 * 0.64 * Math.exp(1.92 * 0.85) * 60), // one hour @ ~85% HRr, for TRIMP↔TSS sanity
    },
    summary: {
      days: days.length,
      latestCTL: latest ? Math.round(latest.ctl) : null,
      latestATL: latest ? Math.round(latest.atl) : null,
      latestTSB: latest ? Math.round(latest.tsb) : null,
      meanDailyLoad: days.length ? Math.round(sumLoad / days.length) : 0,
      maxDailyLoad: maxLoad, peakCTL: Math.round(peakCtl),
      daysFloorSetTheLoad: floorLifted, // days where the NEAT floor (not cardio TRIMP) determined load
    },
    days,
    // Projected-vs-realised TSB pairs (accumulates as the 7-day plan is viewed) — for calibrating the
    // −10 form gate: projTSB is what the plan forecast, actTSB is what materialised.
    forecastAccuracy: await getForecastPairs(),
    // Observed max-HR across ~24 months of daily peaks (robust vs single-sample glitches).
    maxHrAnalysis: await analyzeMaxHr(24),
    // Aerobic-base outlook (decoupling per recent long steady run → ready for intensity or keep building ToF).
    aerobicBase: await analyzeAerobicBase(),
  };
  return JSON.stringify(dump);
}

// HealthKit caps a query at `limit` samples; with ascending:true an overflow silently drops the
// NEWEST samples — exactly the data a history chart most needs on long (6M/1Y) windows. So the
// high-volume history queries below run DESCENDING (overflow drops the OLDEST instead) and restore
// ascending order with this helper, keeping the most-recent `limit` samples while every downstream
// consumer still sees oldest→newest.
function sortByStartAsc<T extends { startDate: unknown }>(samples: T[]): T[] {
  return samples.sort(
    (a, b) => new Date(toISOStr(a.startDate as any)).getTime() - new Date(toISOStr(b.startDate as any)).getTime(),
  );
}

// Time-stamped step buckets → lets us split workout vs non-workout steps (only the latter is passive).
async function fetchStepSamples(since: Date, end: Date): Promise<{ t: number; steps: number; day: string }[]> {
  const raw = await safeQuery(() => (HealthKit.queryQuantitySamples as any)(
    HKQuantityTypeIdentifier.stepCount,
    // descending → an overflow of the 50k cap drops the oldest days, not the newest (dailyNonWorkoutSteps buckets by day, order-independent)
    { filter: { startDate: since, endDate: end }, unit: 'count', ascending: false, limit: 50_000 }), [] as any[]);
  return (raw as any[]).map((s: any) => {
    const t0 = new Date(toISOStr(s.startDate)).getTime();
    const t1 = s.endDate ? new Date(toISOStr(s.endDate)).getTime() : t0;
    return { t: (t0 + t1) / 2, steps: s.quantity as number, day: trainingDayKey(toISOStr(s.startDate)) };
  });
}

// Per-day NON-workout steps. Raw step SAMPLES double-count overlapping sources (iPhone + Watch), so
// we take the non-workout FRACTION of raw samples and scale it by the de-duplicated daily total.
function dailyNonWorkoutSteps(
  samples: { t: number; steps: number; day: string }[],
  windowsByDay: Map<string, { s: number; e: number }[]>,
  dedupedTotal: Map<string, number>,
): Map<string, number> {
  const rawTotal = new Map<string, number>(), rawNw = new Map<string, number>();
  for (const s of samples) {
    rawTotal.set(s.day, (rawTotal.get(s.day) ?? 0) + s.steps);
    const wins = windowsByDay.get(s.day) ?? [];
    if (!wins.some((w) => s.t >= w.s && s.t <= w.e)) rawNw.set(s.day, (rawNw.get(s.day) ?? 0) + s.steps);
  }
  const out = new Map<string, number>();
  for (const [day, total] of dedupedTotal) {
    const rt = rawTotal.get(day) ?? 0, rn = rawNw.get(day) ?? 0;
    out.set(day, rt > 0 ? Math.round(total * (rn / rt)) : total);
  }
  return out;
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
  since.setHours(0, 0, 0, 0); // whole boundary day (else its morning workouts get sliced off)

  const [hrRaw, restingRaw, workouts] = await Promise.all([
    safeQuery(() => (HealthKit.queryQuantitySamples as any)(
      HKQuantityTypeIdentifier.heartRate,
      // descending → the 200k cap drops the oldest days on 6M/1Y windows, not the newest; re-sorted ascending below
      { filter: { startDate: since, endDate: end }, unit: 'count/min', ascending: false, limit: 200_000 },
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
    day: trainingDayKey(toISOStr(s.startDate)),
  })).sort((a, b) => a.t - b.t); // query ran descending (to keep newest on overflow) — restore ascending for per-day integration
  if (hr.length === 0) return [];

  // restHR = median resting HR; maxHR = the effective max (set value, else robust observed peak) —
  // one source of truth across strain/TRIMP/zones, glitch-filtered (the old per-window raw peak
  // could latch onto a single sensor spike).
  const restVals = (restingRaw as any[]).map((s: any) => s.quantity as number).filter(v => v > 0).sort((a, b) => a - b);
  const restHR = restVals.length > 0 ? Math.round(restVals[Math.floor(restVals.length / 2)]) : 50;
  const maxForDay = buildMaxHrResolver(await getMaxHrHistory(), await getEffectiveMaxHr()); // per-day (date-keyed "from now")

  // Bucket HR by day; workout windows per day (HR inside = exercise, full weight)
  const byDay = new Map<string, { t: number; hr: number }[]>();
  for (const s of hr) {
    if (!byDay.has(s.day)) byDay.set(s.day, []);
    byDay.get(s.day)!.push({ t: s.t, hr: s.hr });
  }
  const STRENGTH = new Set([20, 50]);
  const muscularByDay = new Map<string, number>();
  const windowsByDay  = new Map<string, { s: number; e: number }[]>();
  // Same windows, but keeping TYPE + duration so a no-HR workout can fall back to duration × activityFactor
  // (see the no-HR fallback on the live path). History MUST use the identical model, or the 14-day strain
  // BASELINE (built from this series) would sit below today's corrected value and skew the advisable band.
  const actWinsByDay = new Map<string, { s: number; e: number; min: number; type: number }[]>();
  for (const w of (workouts as any[])) {
    const day = trainingDayKey(toISOStr(w.startDate));
    const ws  = new Date(toISOStr(w.startDate)).getTime();
    const win = { s: ws, e: ws + workoutDurationSec(w) * 1000 };
    if (!windowsByDay.has(day)) windowsByDay.set(day, []);
    windowsByDay.get(day)!.push(win);
    if (!STRENGTH.has(w.workoutActivityType)) {   // strength is counted via muscularByDay — no double-count
      if (!actWinsByDay.has(day)) actWinsByDay.set(day, []);
      actWinsByDay.get(day)!.push({ ...win, min: workoutDurationSec(w) / 60, type: w.workoutActivityType });
    }
    if (STRENGTH.has(w.workoutActivityType)) {
      muscularByDay.set(day, (muscularByDay.get(day) ?? 0) + workoutDurationSec(w) / 60);
    }
  }

  const [stepSamples, stepsDedup] = await Promise.all([
    fetchStepSamples(since, end),
    dailyCumulativeSum(HKQuantityTypeIdentifier.stepCount, 'count', since, end),
  ]);
  const nwStepsByDay = dailyNonWorkoutSteps(stepSamples, windowsByDay, stepsDedup);

  // One entry per day that has HR data — including rest days — so the chart shows a
  // continuous daily series (and the clear run-day vs rest-day pattern).
  const out: { date: string; value: number }[] = [];
  for (const [day, samples] of byDay) {
    // Same model as today's live strain: workout HR-zone load (active) + non-workout steps (passive).
    const dayMax = maxForDay(day) || 190;
    // PER-ACTIVITY loads, identical to the live path: strain is summed per activity, not curved on the
    // total (Bevel-verified additive). No-HR workouts fall back to duration × activityFactor.
    const actLoads: number[] = [];
    for (const w of (actWinsByDay.get(day) ?? [])) {
      const hasHr = samples.some(p => p.t >= w.s && p.t <= w.e && p.hr > restHR);
      actLoads.push(hasHr ? zoneStrainLoad(samples, restHR, dayMax, [{ s: w.s, e: w.e }])
                          : w.min * activityFactor(w.type));
    }
    const musc = muscularByDay.get(day) ?? 0;
    const actStrain = actLoads.reduce((s, L) => s + strainFromLoad(Math.max(0, L)), 0)
                    + (musc > 0 ? strainFromLoad(musc) : 0);
    const passiveStrain = strainFromLoad(stepStrainLoad(nwStepsByDay.get(day) ?? 0));
    out.push({ date: day, value: Math.round(Math.max(actStrain, passiveStrain)) }); // Bevel % — UNCAPPED (a huge day may exceed 100)
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}


/**
 * Daily Recovery-score history (0-100). Recomputes each night with the FULL model — weighted RMSSD +
 * overnight sleep HR + sleep score + respiratory rate — identical to the live card / snapshot, so the
 * store, detail view, history and trends all read one number per day. Fetches extra for the baselines.
 */
export async function fetchRecoveryHistory(
  months: number,
  toDate?: Date,
): Promise<{ date: string; value: number }[]> {
  const end       = toDate ?? new Date();
  const fromKey   = toDateStr(new Date(end.getTime() - months * 30 * 86_400_000).toISOString());

  // FULL recovery model — identical to the live card / snapshot (was HRV + Apple-resting-HR only, which
  // dropped the sleep + respiratory-rate terms and used the wrong HR source, so the store's recovery
  // disagreed with the home's for the same day). Fetch the same overnight biometrics + sleep the store
  // uses so every consumer (home, detail, history, trends) reads ONE number per day.
  const [hrv, bio, sessions] = await Promise.all([
    fetchHRVHistory(months + 1, end),          // nightly weighted RMSSD
    fetchSleepBiometrics(months + 1, end),     // per-night overnight SLEEP HR + respiratory rate
    fetchSleepHistory(months + 1, end),        // sleep sessions → per-night sleep score
  ]);
  if (hrv.length === 0) return [];

  const bioByDate = new Map(bio.map((b) => [b.date, b]));
  // Overnight SLEEP HR (matches the live card — Apple's resting HR lags a day and mis-correlates).
  const nightly: NightlyHRV[] = hrv
    .map((h) => ({ date: h.date, weightedRMSSD: h.value, overnightHR: bioByDate.get(h.date)?.overnightHR ?? 0, samples: [] }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const out: { date: string; value: number }[] = [];
  const rrSoFar: number[] = [];   // rolling RR history → per-night baseline (window-invariant)
  for (let i = 0; i < nightly.length; i++) {
    const d  = nightly[i].date;
    const bd = bioByDate.get(d);
    const rr = bd?.respiratoryRate ?? 0;
    if (rr > 0) rrSoFar.push(rr);
    const rrBaseline = rrSoFar.length >= 10 ? [...rrSoFar].sort((a, b) => a - b)[Math.floor(rrSoFar.length / 2)] : 0;
    if (d < fromKey) continue;
    const sess = sessions.find((x) => x.date === d);
    const sleepScore = sess
      ? computeSleepScore(sess, bd?.overnightHR ?? 0, bd?.daytimeHR ?? 0, sessions.filter((x) => x.date <= d)).score
      : 0;
    const restVals = nightly.slice(0, i).map((n) => n.overnightHR).filter((v) => v > 0); // history BEFORE today, like the snapshot
    const { score } = computeRecoveryScore(
      nightly[i].weightedRMSSD, nightly[i].overnightHR, nightly.slice(0, i), restVals,
      sleepScore, rr, rrBaseline,
    );
    if (score > 0) out.push({ date: d, value: score });
  }
  return out;
}

/**
 * ALL workouts (any type) over the last N months as ActivitySummary[], newest first. Unlike the main
 * snapshot's 35-day `activities`, this reaches the full synced window — for the coach's activity-impact
 * analysis (per-session strain vs next-day recovery). Not HR-nudged (kcal drives the load for non-runs).
 */
export async function fetchActivityHistory(months: number, toDate?: Date): Promise<ActivitySummary[]> {
  const endDate = toDate ?? new Date();
  const since   = new Date(endDate.getTime() - Math.max(1, months) * 30 * 86_400_000);
  const raw: any[] = await (HealthKit.queryWorkoutSamples as any)({
    filter: { startDate: since, endDate: endDate },
    limit: 1000,
    ascending: false,
    energyUnit: 'kcal',
    distanceUnit: 'm',
  }).catch(() => []);
  return mapWorkoutsToActivities(raw).sort((a, b) => b.date.localeCompare(a.date));
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
// Phases that DON'T count toward time-on-feet: warmup, cooldown, recovery, and any walk segment.
const TOF_EXCLUDE_PHASE = /warm|cool|recover|rest|walk|prep/i;

/**
 * "Real" running WORK + DRILLS for one workout — both SECONDS and METERS — EXCLUDING warmup,
 * cooldown, recovery (inter-rep rest) and walk segments (and pauses, since segment duration/distance
 * are net of pauses). Reads the structured-workout segment labels from w.activities (WorkoutProxy
 * UUID-suffix patch); a segment counts unless it's an explicit warmup/cooldown/recovery/walk phase.
 * Falls back to the workout's total duration/distance for an unstructured run (no segments).
 */
function workDrillsTotals(w: any, regime: AccountingMode = 'work'): { seconds: number; meters: number } {
  const totalSec = typeof w.duration === 'object' && w.duration !== null
    ? (w.duration.quantity as number) ?? 0 : (w.duration as number) ?? 0;
  const totalM = (w.totalDistance?.quantity as number) ?? 0;
  if (regime === 'full') return { seconds: totalSec, meters: totalM }; // count the WHOLE run
  const acts: any[] = w.activities ?? [];

  const segs = acts.map((act: any) => {
    const uuidStr: string = act.uuid ?? '';
    const sep = uuidStr.indexOf('::');
    let stepType = -1, stepActType = -1, title = '', stepName = '', distanceM = 0;
    if (sep >= 0) {
      const restS   = uuidStr.slice(sep + 2);
      const metaSep = restS.indexOf('::meta::');
      const statSep = restS.indexOf('::stat::');
      if (metaSep >= 0) {
        const end = statSep >= 0 && statSep > metaSep ? statSep : restS.length;
        for (const pair of restS.slice(metaSep + 8, end).split('|')) {
          const eq = pair.indexOf('='); if (eq < 0) continue;
          const k = pair.slice(0, eq), v = pair.slice(eq + 1);
          if (k === 'title')           title    = v;
          if (k === 'WorkoutStepName') stepName = v;
          if (k === 'WorkoutStepType') stepType = parseInt(v, 10);
        }
      }
      if (statSep >= 0) {
        for (const pair of restS.slice(statSep + 8).split(';')) {
          const eq = pair.indexOf('='); if (eq < 0) continue;
          const k = pair.slice(0, eq);
          if (k === 'dist')    distanceM   = parseFloat(pair.slice(eq + 1));
          if (k === 'stepAct') stepActType = parseFloat(pair.slice(eq + 1));
        }
      }
    }
    const aStart = new Date(toISOStr(act.startDate)).getTime();
    const aEnd   = act.endDate ? new Date(toISOStr(act.endDate)).getTime() : aStart;
    const durationSec = (act as any).duration > 0 ? (act as any).duration : Math.max(0, (aEnd - aStart) / 1000);
    // Phase authority MUST match fetchWorkoutDetail (the detail screen): the WorkoutStep NAME/TYPE is the
    // truth, NOT the generic step `title`. Prioritising `title` here made an open-target Cooldown (real
    // WorkoutStepType=3) get mislabelled by its title and COUNTED into time-on-feet, while the detail
    // screen correctly showed "Cooldown". A labelled warm-up/cool-down/recovery must be excluded on its
    // LABEL alone — never gated on segment length. `title` is a last-resort display fallback only.
    let label = stepName
      || (['Warmup', 'Work', 'Recovery', 'Cooldown'][stepType] ?? '')
      || (stepActType === HK_COOLDOWN ? 'Cooldown'
          : HK_PREP_REC_SET.has(stepActType) ? 'Warmup'
          : stepActType === HK_WALKING ? 'Walk' : '')
      || title;
    return { label, durationSec, distanceM };
  }).filter((s) => s.durationSec >= 5);

  if (segs.length === 0) return { seconds: totalSec, meters: totalM }; // unstructured → count it all

  // Resolve deferred/empty labels the same way the run classifier does: a SHORT first/last segment
  // is the warmup/cooldown, the middle is work — so we don't accidentally count warmup/cooldown.
  if (segs.some((s) => !s.label) && segs.length >= 2) {
    const valid = segs.map((s) => s.distanceM).filter((d) => d > 0);
    if (valid.length >= 2) {
      const threshold = [...valid].sort((a, b) => a - b)[Math.floor(valid.length / 2)] * 0.65;
      segs.forEach((s, i) => {
        if (s.label) return;
        if (i === 0 && s.distanceM > 0 && s.distanceM < threshold)                    s.label = 'Warmup';
        else if (i === segs.length - 1 && s.distanceM > 0 && s.distanceM < threshold)  s.label = 'Cooldown';
        else                                                                          s.label = 'Work';
      });
    } else {
      segs.forEach((s) => { if (!s.label) s.label = 'Work'; }); // no distances → treat unlabeled as work
    }
  }
  const inc = (s: { label: string }) => !TOF_EXCLUDE_PHASE.test(s.label);
  let workSec = segs.reduce((sum, s) => sum + (inc(s) ? s.durationSec : 0), 0);
  let workM   = segs.reduce((sum, s) => sum + (inc(s) ? s.distanceM  : 0), 0);
  // A structured prescribed run (e.g. a tempo) whose raw HK step labels ALL resolve to excluded phases sums
  // to 0 here — the run-list/home path fixes this via the prescribed-phase relabel, but that means a per-run
  // plan-log read (slow on the hot ToF path → laggy navigation). Recover work CHEAPLY by POSITION instead:
  // short first/last = warm-up/cool-down (excluded), everything else = work. No I/O. Then the budget counts
  // the ~same work minutes the run list shows, without the file reads.
  if (workSec === 0 && segs.length >= 2) {
    const valid = segs.map((s) => s.distanceM).filter((d) => d > 0);
    const threshold = valid.length >= 2 ? [...valid].sort((a, b) => a - b)[Math.floor(valid.length / 2)] * 0.65 : 0;
    const isEnd = (s: { distanceM: number }, i: number) =>
      threshold > 0 && s.distanceM > 0 && s.distanceM < threshold && (i === 0 || i === segs.length - 1);
    workSec = segs.reduce((sum, s, i) => sum + (isEnd(s, i) ? 0 : s.durationSec), 0);
    workM   = segs.reduce((sum, s, i) => sum + (isEnd(s, i) ? 0 : s.distanceM),  0);
  }
  // Last resort: still 0 → count the total rather than dropping the run's time-on-feet entirely.
  if (workSec === 0) return { seconds: totalSec, meters: totalM };
  return { seconds: workSec, meters: workM };
}

// Per-day running WORK+DRILLS totals (runs only). `pick` selects minutes or km.
async function fetchDailyWorkHistory(
  pick: (t: { seconds: number; meters: number }) => number, toDate?: Date, days = 31,
): Promise<{ date: string; value: number }[]> {
  const endDate = toDate ?? new Date();
  const since   = new Date(endDate.getTime() - days * 86_400_000);
  const allWorkouts: any[] = await (HealthKit.queryWorkoutSamples as any)({
    filter: { startDate: since, endDate: endDate },
    limit: 1000, ascending: true, energyUnit: 'kcal', distanceUnit: 'm',
  });
  const switches = await getSwitchList(); // each run counts under the regime in force on its date
  // The cached runs carry SEGMENTS computed by the detail path. Prefer those: workDrillsTotals decodes
  // phases out of the workout uuid metadata and silently falls back to the FULL duration when that decode
  // yields nothing, so in 'work' accounting a run whose metadata didn't decode counted its warm-up and
  // cool-down (17 Aug: 90min counted against a 54min work block; 13 Aug: 44 vs a 28.6min ToF), while runs
  // that did decode were correct — an inconsistent series that then inflates the rolling ceiling.
  const cachedRuns: RunWorkout[] = await loadSnapshotCache().then(sn => (sn as any)?.runs ?? []).catch(() => []);
  const segByUuid = new Map<string, { seconds: number; meters: number }>();
  for (const r of cachedRuns) {
    if (!r.uuid || !r.segments?.length) continue;
    const keep = r.segments.filter(sg => !TOF_EXCLUDE_PHASE.test(sg.label ?? ''));
    if (!keep.length) continue;
    segByUuid.set(r.uuid, {
      seconds: keep.reduce((a, sg) => a + (sg.durationSec ?? 0), 0),
      meters:  keep.reduce((a, sg) => a + (sg.distanceM ?? 0), 0),
    });
  }
  const byDay: Record<string, number> = {};
  (allWorkouts as any[])
    .filter((w: any) => w.workoutActivityType === HK_WORKOUT_RUNNING) // runs only — never walk workouts
    .forEach((w: any) => {
      const day = toISOStr(w.startDate).slice(0, 10);
      const regime = regimeForDate(toISOStr(w.startDate), switches);
      const seg = regime === 'full' ? undefined : segByUuid.get(w.uuid);
      byDay[day] = (byDay[day] ?? 0) + pick(seg ?? workDrillsTotals(w, regime));
    });
  return Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }));
}

// Time-on-feet basis: work+drills MINUTES per day.
export function fetchDailyDurationHistory(toDate?: Date, days = 31): Promise<{ date: string; value: number }[]> {
  return fetchDailyWorkHistory((t) => t.seconds, toDate, days).then((rows) =>
    rows.map((r) => ({ date: r.date, value: Math.round(r.value / 60) })));
}

// Distance basis: work+drills KM per day (one decimal).
export function fetchDailyWorkDistanceHistory(toDate?: Date): Promise<{ date: string; value: number }[]> {
  return fetchDailyWorkHistory((t) => t.meters, toDate).then((rows) =>
    rows.map((r) => ({ date: r.date, value: Math.round(r.value / 100) / 10 })));
}

/**
 * Read the relative humidity Apple Watch records in a workout's metadata (HKWeatherHumidity).
 * HK stores it as a 0–1 ratio (sometimes already a %); returns 0–100 or undefined when absent.
 */
export function extractWeatherHumidity(w: any): number | undefined {
  const h = metaGet(w?.metadata, 'HKWeatherHumidity');
  if (h == null) return undefined;
  let value = typeof h === 'object' ? Number(h.quantity ?? metaGet(h, 'quantity')) : Number(h);
  if (!isFinite(value)) return undefined;
  if (value > 0 && value <= 1) value *= 100;  // ratio → %
  if (value < 0 || value > 100) return undefined;
  return Math.round(value);
}

/**
 * Per-day OUTDOOR run weather (the HOTTEST run of each day), reconstructed from workout weather
 * metadata → date → {tempC, humidity}. Feeds the rolling-cap HEAT-CREDIT (so a heat-shortened run
 * doesn't permanently erode next week's volume ceiling). Days with no recorded weather (indoor /
 * old runs) are simply absent → the cap treats them as neutral (factor 1).
 */
export async function fetchDailyRunWeatherHistory(toDate?: Date, days = 31): Promise<Record<string, { tempC: number; humidity?: number }>> {
  const endDate = toDate ?? new Date();
  const since   = new Date(endDate.getTime() - days * 86_400_000);
  const allWorkouts: any[] = await (HealthKit.queryWorkoutSamples as any)({
    filter: { startDate: since, endDate: endDate }, limit: 1000, ascending: true, energyUnit: 'kcal', distanceUnit: 'm',
  }).catch(() => []);
  const byDay: Record<string, { tempC: number; humidity?: number }> = {};
  (allWorkouts as any[])
    .filter((w: any) => w.workoutActivityType === HK_WORKOUT_RUNNING) // runs only
    .forEach((w: any) => {
      const tempC = extractWeatherTempC(w);
      if (tempC == null) return;
      const day = toISOStr(w.startDate).slice(0, 10);
      // Keep the hottest run of the day (the conditions that most limited the session).
      if (!byDay[day] || tempC > byDay[day].tempC) byDay[day] = { tempC, humidity: extractWeatherHumidity(w) };
    });
  return byDay;
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

// ─── Biology mode: body composition + blood pressure (read-only history) ───────
// All return an ascending [{date, value}] series (BP returns paired sys/dia). `since` = months back.
async function fetchQuantitySeries(id: string, unit: string, months: number, toDate?: Date, round = 1): Promise<{ date: string; value: number }[]> {
  const endDate = toDate ?? new Date();
  const since   = new Date(endDate.getTime() - months * 30 * 86_400_000);
  const samples = await safeQuery(
    () => (HealthKit.queryQuantitySamples as any)(id, { filter: { startDate: since, endDate: endDate }, unit, ascending: true, limit: 100000 }),
    [] as any[]
  );
  const f = Math.pow(10, round);
  return (samples as any[])
    .map((s: any) => ({ date: toISOStr(s.startDate), value: Math.round((s.quantity as number) * f) / f }))
    .filter(p => Number.isFinite(p.value));
}

export function fetchBodyMassHistory(months: number, toDate?: Date) {
  return fetchQuantitySeries(HKQuantityTypeIdentifier.bodyMass, 'kg', months, toDate, 1);
}
export function fetchLeanBodyMassHistory(months: number, toDate?: Date) {
  return fetchQuantitySeries(HKQuantityTypeIdentifier.leanBodyMass, 'kg', months, toDate, 1);
}
// Body-fat is stored as a ratio (0–1) under the percent unit; normalise to a 0–100 percentage.
export async function fetchBodyFatHistory(months: number, toDate?: Date): Promise<{ date: string; value: number }[]> {
  const raw = await fetchQuantitySeries(HKQuantityTypeIdentifier.bodyFatPercentage, '%', months, toDate, 4);
  return raw.map(p => ({ date: p.date, value: Math.round((p.value <= 1 ? p.value * 100 : p.value) * 10) / 10 }));
}
// Blood pressure is a correlation of two samples sharing a timestamp; query each and pair by minute.
export async function fetchBloodPressureHistory(months: number, toDate?: Date): Promise<{ date: string; systolic: number; diastolic: number }[]> {
  const [sys, dia] = await Promise.all([
    fetchQuantitySeries(HKQuantityTypeIdentifier.bloodPressureSystolic, 'mmHg', months, toDate, 0),
    fetchQuantitySeries(HKQuantityTypeIdentifier.bloodPressureDiastolic, 'mmHg', months, toDate, 0),
  ]);
  const key = (iso: string) => iso.slice(0, 16); // to the minute — a BP reading writes sys+dia together
  const dMap = new Map(dia.map(d => [key(d.date), d.value]));
  return sys
    .map(s => ({ date: s.date, systolic: s.value, diastolic: dMap.get(key(s.date)) ?? NaN }))
    .filter(r => Number.isFinite(r.diastolic));
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
        // descending → the 5k cap drops the oldest nights on long windows, not the newest; re-sorted ascending below
        { filter: { startDate: since, endDate: endDate }, ascending: false, limit: 5000 }
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
    sortByStartAsc(sleepSamples as any[]).map((s: any) => ({
      startDate: s.startDate,
      endDate:   s.endDate,
      value:     s.value as number,
      source:    s.sourceRevision?.source?.bundleIdentifier ?? s.sourceRevision?.source?.name ?? '',
    }))
  );

  const normHRV = (hrvRaw as any[]).map((s: any) => ({
    startDate: toISOStr(s.startDate),
    quantity:  s.quantity as number,
  }));
  const qualityMap = buildHeartbeatQualityMap(hbsRaw as any[]);

  const results: { date: string; value: number }[] = [];
  for (const session of sessions) {
    // Prefer Bevel's true RMSSD (R-R intervals); fall back to the SDNN-weighted value.
    const trueRMSSD = nightlyTrueRMSSD(session, hbsRaw as any[]);
    const value = trueRMSSD > 0 ? trueRMSSD : computeWeightedRMSSD(session, normHRV, qualityMap).weightedRMSSD;
    if (value > 0) {
      results.push({ date: session.date, value: Math.round(value) });
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
      source: s.sourceRevision?.source?.bundleIdentifier ?? s.sourceRevision?.source?.name ?? '',
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
      // Restful daytime level (low percentile), to match Bevel's "Daytime HR".
      const daytimeHR  = restfulDaytimeHR(daytimeVals);
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
      // descending → the 10k cap drops the oldest nights on long windows, not the newest; re-sorted ascending below
      { filter: { startDate: since, endDate: endDate }, ascending: false, limit: 10000 }
    ),
    [] as any[]
  );

  const sessions = groupIntoSessions(
    sortByStartAsc(rawSamples as any[]).map((s: any) => ({
      startDate: s.startDate,
      endDate:   s.endDate,
      value:     s.value as number,
      source:    s.sourceRevision?.source?.bundleIdentifier ?? s.sourceRevision?.source?.name ?? '',
    }))
  );

  return sessions.sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Our daily components (for Bevel comparison) ──────────────────────────────

/** Generic daily cumulative-sum statistics → Map<YYYY-MM-DD, value>. */
async function dailyCumulativeSum(
  identifier: string, unit: string, fromDate: Date, toDate: Date,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const anchor = new Date(fromDate); anchor.setHours(0, 0, 0, 0);
  const anchorStr = anchor.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const buckets = await safeQuery(
    () => (HealthKit as any).queryStatisticsCollectionForQuantity(
      identifier, ['cumulativeSum'], anchorStr, { day: 1 },
      { filter: { startDate: fromDate, endDate: toDate }, unit },
    ),
    [] as any[],
  );
  (buckets as any[]).forEach((b, i) => {
    const v = b?.sumQuantity?.quantity ?? 0;
    if (v > 0) {
      const d = new Date(anchor); d.setDate(d.getDate() + i);
      map.set(toLocalDateStr(d), v); // LOCAL date — buckets are local-midnight anchored
    }
  });
  return map;
}

const clockMinutes = (iso: string): number => {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
};

/**
 * Observed max-HR analysis over a long window. Uses the DAILY max HR (discreteMax per day, cheap
 * statistics query) rather than raw samples: a max reached on MANY days is a true physiological
 * ceiling, whereas a single high day is almost always a sensor glitch (cadence lock-on / motion).
 * Glitch-filtered at >220. The robust estimate is the value your daily peaks actually cluster at.
 */
/** Daily max HR (discreteMax per day), descending, glitch-filtered >220. Cheap statistics query. */
async function dailyMaxHrPeaks(months: number): Promise<number[]> {
  const end    = new Date();
  const since  = new Date(end.getTime() - months * 30 * 86_400_000);
  const anchor = new Date(since); anchor.setHours(0, 0, 0, 0);
  const anchorStr = anchor.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const buckets = await safeQuery(
    () => (HealthKit as any).queryStatisticsCollectionForQuantity(
      HKQuantityTypeIdentifier.heartRate, ['discreteMax'], anchorStr, { day: 1 },
      { filter: { startDate: since, endDate: end }, unit: 'count/min' },
    ),
    [] as any[],
  );
  const daily: number[] = [];
  for (const b of (buckets as any[])) {
    const v = b?.maximumQuantity?.quantity ?? b?.maxQuantity?.quantity ?? 0;
    if (v > 0 && v <= 220) daily.push(Math.round(v)); // >220 = obvious glitch
  }
  return daily.sort((a, b) => b - a); // descending
}

/** Robust observed max = highest daily peak reached on ≥2 separate days → drops lone sensor spikes. */
function robustPeak(peaksDesc: number[]): number {
  const n = peaksDesc.length;
  if (n === 0) return 0;
  if (n === 1) return peaksDesc[0];
  for (const v of peaksDesc) if (peaksDesc.filter((x) => x >= v).length >= 2) return v;
  return peaksDesc[0];
}

/** Robust observed max HR (bpm) from the athlete's own data, 0 if none — feeds getEffectiveMaxHr's auto-anchor. */
export async function computeRobustObservedMaxHr(months = 24): Promise<number> {
  return robustPeak(await dailyMaxHrPeaks(months));
}

export async function analyzeMaxHr(months = 24): Promise<any> {
  const daily = await dailyMaxHrPeaks(months);
  const n = daily.length;
  if (n === 0) return { error: 'no heart-rate data found', monthsScanned: months };
  const atLeast = (t: number) => daily.filter((v) => v >= t).length;
  return {
    monthsScanned: months,
    daysWithHrData: n,
    currentSetMaxHr: await getUserMaxHr(),
    singleHighestDailyPeak: daily[0],          // likely a glitch if far above the rest
    top12DailyPeaks: daily.slice(0, 12),       // eyeball outliers vs the cluster
    robustObservedMaxHr: robustPeak(daily),    // the auto-anchor value (reached ≥2 days)
    daysReaching: { '>=180': atLeast(180), '>=185': atLeast(185), '>=190': atLeast(190), '>=195': atLeast(195), '>=200': atLeast(200), '>=205': atLeast(205) },
    note: 'daily discreteMax, glitch-filtered >220. A peak hit on ≥2 days is real; a lone high day is a spike. Wrist HR can UNDER-read at true max, so this is a floor.',
  };
}

/**
 * Our own metric per day, keyed to the same component keys as the Bevel catalogue
 * (bevelScales). Values are in the SAME canonical units the Bevel store uses
 * (durations & clock times in minutes, energy kcal, etc.) so they line up 1:1.
 * Components we don't compute (e.g. sleepBank) are simply absent.
 */
// RAW compute — expensive (HealthKit queries + baseline z-scores over a padded window). Call the cached
// `fetchOurDailyComponents` below instead; this is the miss-path it delegates to.
async function computeDailyComponents(
  months: number,
  toDate?: Date,
): Promise<Record<string, Record<string, number>>> {
  const end  = toDate ?? new Date();
  const from = new Date(end.getTime() - months * 30 * 86_400_000);

  // Baseline-dependent metrics (recovery's 60-day z-scores, sleep's ~90-day personal goal + 7-night
  // bank) must see a FIXED lookback, else the SAME date scores a point or two differently on a 9-day
  // screen vs a 3-month screen (the baseline is truncated to the fetched window). Compute sleep +
  // recovery + strain over a padded window and slice back to [from,end] below, so a given day's
  // recovery/sleep/bank is window-INVARIANT. (Steps/energy are per-day sums → already invariant;
  // CTL/ATL already warm CARDIO_WARM_DAYS days independent of the window.)
  const BASELINE_PAD_MONTHS = 3;
  const effMonths = months + BASELINE_PAD_MONTHS;

  const [bio, sessions, strain, recovery, steps, active, basal, exercise] = await Promise.all([
    fetchSleepBiometrics(effMonths, end),
    fetchSleepHistory(effMonths, end),
    fetchStrainHistory(effMonths, end),
    fetchRecoveryHistory(effMonths, end),
    dailyCumulativeSum(HKQuantityTypeIdentifier.stepCount, 'count', from, end),
    fetchDailyActiveEnergy(from, end),
    dailyCumulativeSum(HKQuantityTypeIdentifier.basalEnergyBurned, 'kcal', from, end),
    dailyCumulativeSum(HKQuantityTypeIdentifier.appleExerciseTime, 'min', from, end),
  ]);

  const out: Record<string, Record<string, number>> = {};
  const day = (d: string) => (out[d] ??= {});

  const bioByDate = new Map(bio.map(b => [b.date, b]));
  for (const b of bio) {
    const r = day(b.date);
    // Prefer true RMSSD (Bevel's metric); fall back to median SDNN, then stage-weighted.
    const hrvForCmp = b.rmssd > 0 ? b.rmssd : b.hrvMedian > 0 ? b.hrvMedian : b.hrv;
    if (hrvForCmp > 0)         r.restingHrv = Math.round(hrvForCmp * 10) / 10;
    if (b.overnightHR > 0)     r.restingHr = Math.round(b.overnightHR * 10) / 10;
    if (b.respiratoryRate > 0) r.respiratoryRate = Math.round(b.respiratoryRate * 10) / 10;
    if (b.spO2 > 0)            r.oxygenSaturation = Math.round((b.spO2 <= 1 ? b.spO2 * 100 : b.spO2) * 10) / 10;
    if (b.daytimeHR > 0)       r.daytimeHR = Math.round(b.daytimeHR);
    if (b.hrDipPct !== 0)      r.heartRateDip = Math.round(b.hrDipPct * 10) / 10;
  }
  for (const s of sessions) {
    const r = day(s.date);
    const asleep = s.deepMinutes + s.remMinutes + s.coreMinutes;
    if (asleep > 0)         r.timeAsleep = Math.round(asleep);
    if (s.remMinutes > 0)   r.remSleep = Math.round(s.remMinutes);
    if (s.deepMinutes > 0)  r.deepSleep = Math.round(s.deepMinutes);
    if (s.bedtime)          r.sleepTime = clockMinutes(s.bedtime);
    if (s.wakeTime)         r.wakeTime = clockMinutes(s.wakeTime);
    const b = bioByDate.get(s.date);
    const score = computeSleepScore(s, b?.overnightHR ?? 0, b?.daytimeHR ?? 0, sessions.filter((x) => x.date <= s.date)).score;
    if (score > 0)          r.sleepScore = score;
  }
  for (const s of strain)   day(s.date).strainScore = s.value;
  for (const r of recovery) day(r.date).recoveryScore = r.value;
  for (const [d, v] of steps)    day(d).stepCount = Math.round(v);
  for (const [d, v] of exercise) day(d).exerciseDuration = Math.round(v);
  for (const [d, a] of active) {
    const total = a + (basal.get(d) ?? 0);
    if (total > 0) day(d).totalEnergy = Math.round(total);
  }

  // Sleep Bank: rolling 7-night balance of (asleep − personal median need) — oscillates ±~3h around 0 like Bevel.
  const strainByDate = new Map(strain.map(s => [s.date, s.value]));
  const nights = [...sessions]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(s => {
      const asleep = s.deepMinutes + s.remMinutes + s.coreMinutes;
      const inBed  = asleep + s.awakeMinutes;
      return {
        date:       s.date,
        asleepMin:  asleep,
        dayStrain:  strainByDate.get(s.date) ?? 0,
        efficiency: inBed > 0 ? asleep / inBed : 1,
      };
    });
  for (const b of computeSleepBankSeries(nights, SLEEP_BANK_BASE_GOAL)) {
    day(b.date).sleepBank = b.bank;
  }

  // Cardio Load (ATL) + CTL + TSB per day — HR-TRIMP basis (Bevel-style), for the
  // history viewer + export / cross-model verification. Warm CARDIO_WARM_DAYS days before the window.
  const clWarmFrom = new Date(from.getTime() - CARDIO_WARM_DAYS * 86_400_000);
  const [clLoad, clFloor] = await Promise.all([
    fetchDailyCardioTrimp(clWarmFrom, end, await getEffectiveMaxHr()),
    fetchActivityFloorByDay(clWarmFrom, end),
  ]);
  for (const dl of computeTrainingLoadSeries(clLoad, from, end, clFloor)) {
    const r = day(dl.date);
    r.cardioLoad = Math.round(dl.atl * 10) / 10;
    r.ctl = Math.round(dl.ctl * 10) / 10;
    r.tsb = Math.round(dl.tsb * 10) / 10;
  }

  // Drop the baseline-pad days that sat BEFORE the requested window — they only existed to give
  // recovery/sleep a full fixed-length lookback; the caller asked for [from, end].
  const fromKey = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-${String(from.getDate()).padStart(2, '0')}`;
  for (const d of Object.keys(out)) if (d < fromKey) delete out[d];

  return out;
}

// ─── Persistent, incrementally-updated per-day store ──────────────────────────
// Every day's components are WINDOW-INVARIANT (computeDailyComponents pads the baseline), so a given date
// scores the same regardless of the requested window. That lets us compute each day ONCE, keep it on disk,
// and serve any timeframe by SLICING — instead of re-querying months of HealthKit on every KPI view /
// timeframe switch (the "regenerating the graphs" lag). Coverage EXPANDS as larger windows are requested;
// once/day the recent ~15 days are recomputed (only very-recent days shift as new data lands — older days'
// baselines/EWMAs are fixed). Repeat views + already-covered timeframe switches on the same day = instant.
interface DcStore { updatedAt: number; coveredFrom: string; days: Record<string, Record<string, number>> }
// v3 (2026-07-14): the HRV baseline is now TREND-CORRECTED (regression at today, not a flat 60d mean) — the
// flat mean lagged a rising HRV by ~4 ms and handed out ~7 free recovery points a day. Cached v2 scores were
// computed with the old lagging baseline, so they MUST be discarded or the fix would be invisible.
// v2: recovery model unified (full sleep+RR) → discarded v1's old-model cached scores.
// v4 (2026-07-19): the strain model now counts NO-HR workouts (a phone-tracked walk used to score 0 because
// zoneStrainLoad integrates HR inside the window). Cached v3 strainScores were computed WITHOUT them, so
// they must be discarded — otherwise the history chart and the 14-day baseline would sit below today's
// corrected value and skew the advisable band. (v3 was the recovery trend-baseline fix.)
// v5 (2026-07-20): strain aggregation changed from "log of the summed load" to "sum of per-activity
// strains" (Bevel's own breakdown proved it additive: 14+29+10 = its exact 53). Every cached v4 strain
// was computed the old, multi-activity-compressing way, so they must be discarded.
const DC_FILE = FileSystem.documentDirectory + 'daily-components-v5.json';
const DC_EMPTY = (): DcStore => ({ updatedAt: 0, coveredFrom: '9999-99-99', days: {} });
let dcMem: DcStore | null = null;
let dcLoadP: Promise<DcStore> | null = null;
let dcRefreshing: Promise<void> | null = null;
async function dcLoad(): Promise<DcStore> {
  if (dcMem) return dcMem;
  if (!dcLoadP) dcLoadP = (async () => {
    try { dcMem = JSON.parse(await FileSystem.readAsStringAsync(DC_FILE)) as DcStore; }
    catch { dcMem = DC_EMPTY(); }
    if (!dcMem.days) dcMem = DC_EMPTY();
    if (typeof dcMem.updatedAt !== 'number') dcMem.updatedAt = 0;  // migrate the old {updatedDay} shape → force a refresh
    return dcMem;
  })();
  return dcLoadP;
}
let dcWriteTimer: ReturnType<typeof setTimeout> | null = null;
function dcPersist(): void {
  if (dcWriteTimer) return;
  dcWriteTimer = setTimeout(() => {
    dcWriteTimer = null;
    if (dcMem) FileSystem.writeAsStringAsync(DC_FILE, JSON.stringify(dcMem)).catch(() => {});
  }, 600);
}
const dcKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Cache-first per-day components: serve from the disk store, computing only a missing window or the recent
 *  days (once/day). Same signature + return shape as the raw compute, so every caller benefits unchanged. */
export async function fetchOurDailyComponents(
  months: number,
  toDate?: Date,
  force = false,   // user-initiated (pull-to-refresh): recompute the recent window NOW, ignoring the age gate
): Promise<Record<string, Record<string, number>>> {
  const end     = toDate ?? new Date();
  const fromKey = dcKey(new Date(end.getTime() - months * 30 * 86_400_000));
  const endKey  = dcKey(end);
  const store   = await dcLoad();
  const nowMs   = Date.now();
  const todayK  = dcKey(new Date());
  const gap     = Object.keys(store.days).length === 0 || store.coveredFrom > fromKey;
  const ageStale = nowMs - store.updatedAt > 10 * 60_000;   // >10 min old → refresh recent (intraday drift)
  // TODAY is the one day that is NOT window-invariant — its recovery/sleep land only after the night
  // completes. If the requested range includes today and today's recovery hasn't been computed yet, the
  // stored row is a pre-sleep PLACEHOLDER (e.g. a scan ran just after midnight). Serving that froze the
  // coach/detail at "no data" → false watch-not-worn + gutted plan. So while today is incomplete we RECOMPUTE
  // and BLOCK, never serve the placeholder. (ageStale-gated so a genuine watch-off day only recomputes ~once
  // per 10 min instead of on every read.)
  const wantsToday      = endKey >= todayK;
  const todayIncomplete = wantsToday && (store.days[todayK]?.recoveryScore == null);
  const refreshRecent = async () => {
    const fresh = await computeDailyComponents(0.5, end);
    const s = dcMem!;
    for (const d in fresh) s.days[d] = fresh[d];
    s.updatedAt = Date.now();
    dcPersist();
  };
  if (gap) {
    // Data is MISSING for the requested window → must compute it before slicing (blocks once per new,
    // larger timeframe). Computing the whole window fills the gap AND refreshes the recent days.
    const fresh = await computeDailyComponents(months, end);
    for (const d in fresh) store.days[d] = fresh[d];
    if (fromKey < store.coveredFrom) store.coveredFrom = fromKey;
    store.updatedAt = nowMs;
    dcPersist();
  } else if (force || (todayIncomplete && ageStale)) {
    // BLOCK on the recompute: either the user pulled to refresh (force), or today's recovery must reflect
    // the completed night before we return it. Recomputes the recent window (~15 days) so a gap on
    // yesterday (e.g. its overnight data synced after the last scan) fills in. Single-flighted.
    if (!dcRefreshing) dcRefreshing = refreshRecent().catch(() => {}).finally(() => { dcRefreshing = null; });
    await dcRefreshing;
  } else if (ageStale && !dcRefreshing) {
    // Today already complete (or not requested); refresh the recent window in the BACKGROUND to catch
    // intraday strain/step drift (recovery won't change — the night's done), so reads stay instant.
    dcRefreshing = refreshRecent().catch(() => {}).finally(() => { dcRefreshing = null; });
  }
  const out: Record<string, Record<string, number>> = {};
  for (const d in store.days) if (d >= fromKey && d <= endKey) out[d] = store.days[d];
  return out;
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
  hrvMedian:       number;   // median overnight SDNN (NOT stage-weighted)
  rmssd:           number;   // TRUE RMSSD from raw R-R intervals — matches Bevel "Resting HRV"; 0 if no beat data
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
      // descending → the 10k cap drops the oldest nights on long windows, not the newest; re-sorted ascending below
      { filter: { startDate: since, endDate: endDate }, ascending: false, limit: 10_000 }
    ),
    [] as any[]
  );
  const sessions = groupIntoSessions(
    sortByStartAsc(rawSleep as any[]).map((s: any) => ({
      startDate: s.startDate, endDate: s.endDate, value: s.value as number,
      source: s.sourceRevision?.source?.bundleIdentifier ?? s.sourceRevision?.source?.name ?? '',
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

      const daytimeHR   = restfulDaytimeHR(daytimeVals); // restful daytime level (≈ Bevel)
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
      // Median overnight SDNN (not stage-weighted) — robust to the deep-sleep inflation
      // that makes the weighted RMSSD run high/noisy vs Bevel's Resting HRV.
      const hrvSorted = hrvNorm.map(s => s.quantity).filter(v => v > 0).sort((a, b) => a - b);
      const hrvMedian = hrvSorted.length > 0
        ? (hrvSorted.length % 2 ? hrvSorted[(hrvSorted.length - 1) / 2]
            : (hrvSorted[hrvSorted.length / 2 - 1] + hrvSorted[hrvSorted.length / 2]) / 2)
        : 0;
      // True RMSSD from raw R-R intervals (Bevel's metric) — runs lower than SDNN.
      const rmssd = computeRMSSD(hbsResults[j] as any[]);

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
        hrvMedian:       Math.round(hrvMedian * 10) / 10,
        rmssd:           Math.round(rmssd * 10) / 10,
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
