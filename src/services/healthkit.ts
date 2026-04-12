import HealthKit from '@kingstinct/react-native-healthkit';

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
  WeeklyMileage,
  SleepSession,
  SleepSegment,
  SleepStageLabel,
  NightlyHRV,
  DailyRecovery,
} from '../types';
import { classifyAndCacheRuns, loadWorkoutCache, computeWorkoutTypeStats, PerRunData } from './workoutClassifier';
import { getBodyMassKg, saveBodyMassKg, DEFAULT_BODY_MASS_KG } from './claude';

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

function toDateStr(iso: string): string {
  return iso.split('T')[0];
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
      'HKQuantityTypeIdentifierHeartRate',
      'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
      'HKQuantityTypeIdentifierRestingHeartRate',
      'HKQuantityTypeIdentifierVO2Max',
      'HKQuantityTypeIdentifierDistanceWalkingRunning',
      'HKQuantityTypeIdentifierBodyMass',
      'HKQuantityTypeIdentifierRunningPower',
      'HKCategoryTypeIdentifierSleepAnalysis',
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
    const samples = await (HealthKit.queryQuantitySamples as any)(
      HKQuantityTypeIdentifier.bodyMass,
      { unit: 'kg', limit: 1, ascending: false }
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
  rawSamples: { startDate: string; endDate: string; value: number }[]
): SleepSession[] {
  if (rawSamples.length === 0) return [];

  const sorted = [...rawSamples].sort(
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
  samples: { startDate: string; endDate: string; value: number }[]
): SleepSession {
  const segments: SleepSegment[] = samples.map((s) => {
    const stage = SLEEP_VALUE_TO_LABEL[s.value] ?? 'asleepUnspecified';
    return {
      startDate: s.startDate,
      endDate: s.endDate,
      stage,
      durationMinutes: minutesBetween(s.startDate, s.endDate),
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
  const bedtime = samples[0].startDate;
  const wakeTime = samples[samples.length - 1].endDate;

  return {
    date: toDateStr(wakeTime),
    bedtime,
    wakeTime,
    totalMinutes: sleepMinutes,
    deepMinutes: totals.asleepDeep,
    remMinutes: totals.asleepREM,
    coreMinutes: totals.asleepCore,
    awakeMinutes: totals.awake,
    segments,
  };
}

// ─── HRV weighted average ─────────────────────────────────────────────────────

function computeWeightedRMSSD(
  session: SleepSession,
  hrvSamples: { startDate: string; quantity: number }[]
): { weightedRMSSD: number; annotatedSamples: NightlyHRV['samples'] } {
  const sessionStart = new Date(session.bedtime).getTime();
  const sessionEnd = new Date(session.wakeTime).getTime();

  const nightSamples = hrvSamples.filter((s) => {
    const t = new Date(s.startDate).getTime();
    return t >= sessionStart && t <= sessionEnd;
  });

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
  annotatedSamples.forEach(({ rmssd, stage }) => {
    const w = STAGE_WEIGHT[stage];
    weightedSum += rmssd * w;
    totalWeight += w;
  });

  const weightedRMSSD =
    totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 10) / 10 : 0;

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

// ─── Recovery score ───────────────────────────────────────────────────────────

function computeRecoveryScore(
  todayRMSSD: number,
  todayOvernightHR: number,
  history: NightlyHRV[]
): { score: number; baseline: number; trend: DailyRecovery['trend']; overnightHRBaseline: number } {
  const recent = history.slice(-30).filter((n) => n.weightedRMSSD > 0);

  let hrvScore = 70;
  let mean = todayRMSSD;
  let stddev = 1;

  if (recent.length > 0) {
    const values = recent.map((n) => n.weightedRMSSD);
    mean = values.reduce((a, b) => a + b, 0) / values.length;
    stddev = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length) || 1;
    const z = (todayRMSSD - mean) / stddev;
    hrvScore = Math.min(100, Math.max(0, 50 + z * 25));
  }

  const recentWithHR = recent.filter((n) => n.overnightHR > 0);
  let overnightHRBaseline = todayOvernightHR;
  let rhrScore = 50;

  if (recentWithHR.length >= 3 && todayOvernightHR > 0) {
    const hrValues = recentWithHR.map((n) => n.overnightHR);
    const hrMean = hrValues.reduce((a, b) => a + b, 0) / hrValues.length;
    const hrStddev =
      Math.sqrt(hrValues.reduce((a, b) => a + (b - hrMean) ** 2, 0) / hrValues.length) || 1;
    overnightHRBaseline = Math.round(hrMean);
    const hrZ = (todayOvernightHR - hrMean) / hrStddev;
    rhrScore = Math.min(100, Math.max(0, 50 - hrZ * 25));
  }

  const useRHR = todayOvernightHR > 0 && recentWithHR.length >= 3;
  const rawScore = useRHR ? 0.65 * hrvScore + 0.35 * rhrScore : hrvScore;
  const score = Math.round(rawScore);

  const last7 = recent.slice(-7);
  const avg7 =
    last7.length > 0
      ? last7.reduce((a, b) => a + b.weightedRMSSD, 0) / last7.length
      : todayRMSSD;
  const delta = todayRMSSD - avg7;
  const trend: DailyRecovery['trend'] =
    delta > stddev * 0.3 ? 'rising' : delta < -stddev * 0.3 ? 'falling' : 'stable';

  return { score, baseline: Math.round(mean * 10) / 10, trend, overnightHRBaseline };
}

function scoreToLabel(score: number): DailyRecovery['label'] {
  if (score >= 80) return 'optimal';
  if (score >= 60) return 'good';
  if (score >= 40) return 'moderate';
  return 'poor';
}

function scoreToColor(score: number): string {
  if (score >= 80) return '#27ae60';
  if (score >= 60) return '#f39c12';
  if (score >= 40) return '#e67e22';
  return '#c0392b';
}

// ─── Per-workout data fetcher ─────────────────────────────────────────────────

/**
 * Fetch raw HR, distance and running-power samples for a single workout.
 * Each query is isolated — failures return empty arrays (never crash the app).
 */
async function fetchWorkoutSamples(w: {
  startDate: string;
  endDate: string;
}): Promise<{ hr: any[]; dist: any[]; power: any[] }> {
  // Add a 30-second buffer either side so boundary samples aren't missed
  const from = new Date(new Date(w.startDate).getTime() - 30_000);
  const to   = new Date(new Date(w.endDate).getTime()   + 30_000);

  const [hr, dist, power] = await Promise.all([
    (HealthKit.queryQuantitySamples as any)(
      HKQuantityTypeIdentifier.heartRate,
      { from, to, unit: 'count/min', ascending: true, limit: 2000 }
    ).catch(() => []),
    (HealthKit.queryQuantitySamples as any)(
      HKQuantityTypeIdentifier.distanceWalkingRunning,
      { from, to, unit: 'meter', ascending: true, limit: 500 }
    ).catch(() => []),
    (HealthKit.queryQuantitySamples as any)(
      HKQuantityTypeIdentifier.runningPower,
      { from, to, unit: 'W', ascending: true, limit: 1000 }
    ).catch(() => []),  // running power is optional; silently missing on older hardware
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
    (HealthKit.queryWorkoutSamples as any)({
      from: sinceDate,
      to: now,
      limit: 500,
      ascending: false,
      energyUnit: 'kilocalorie',
      distanceUnit: 'meter',
    }).catch(() => []),
  ]);

  const runWorkouts: any[] = (allWorkouts as any[])
    .filter((w: any) => w.workoutActivityType === HK_WORKOUT_RUNNING)
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
    const durationS = w.duration as number;

    return {
      uuid:          w.uuid,
      date:          w.startDate,
      duration:      durationS,
      distance:      distanceM,
      calories:      (w.totalEnergyBurned?.quantity ?? 0) as number,
      avgHeartRate:  avgHR,
      pace:          distanceM > 0 ? durationS / (distanceM / METERS_PER_KM) : 0,
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
    { runs: classifiedRuns, maxHR },
  ] = await Promise.all([
    (HealthKit.queryQuantitySamples as any)(
      HKQuantityTypeIdentifier.vo2Max,
      { from: eightWeeksAgo, to: now, unit: 'ml/kg·min', ascending: true, limit: 60 }
    ).catch(() => []),
    (HealthKit.queryQuantitySamples as any)(
      HKQuantityTypeIdentifier.heartRateVariabilitySDNN,
      { from: thirtyDaysAgo, to: now, unit: 'ms', ascending: true, limit: 500 }
    ).catch(() => []),
    (HealthKit.queryQuantitySamples as any)(
      HKQuantityTypeIdentifier.restingHeartRate,
      { from: twoWeeksAgo, to: now, unit: 'count/min', ascending: true, limit: 30 }
    ).catch(() => []),
    (HealthKit.queryCategorySamples as any)(
      HKCategoryTypeIdentifier.sleepAnalysis,
      { from: thirtyDaysAgo, to: now, ascending: true, limit: 2000 }
    ).catch(() => []),
    resolveBodyMassKg(),
    classifyAndCacheRuns(rawRuns, perRunData, allNewHRValues, existingCache),
  ]);

  // ── Step 6: Sleep analysis ────────────────────────────────────────────────
  progress('Analyzing sleep & recovery…', 80);

  const sleepSessions = groupIntoSessions(
    (rawSleepSamples as any[]).map((s: any) => ({
      startDate: s.startDate,
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
        (HealthKit.queryQuantitySamples as any)(
          HKQuantityTypeIdentifier.heartRate,
          {
            from:      new Date(session.bedtime),
            to:        new Date(session.wakeTime),
            unit:      'count/min',
            ascending: true,
            limit:     300,
          }
        ).catch(() => [])
      )
    );
    sleepHRSamples = (nightHRResults as any[][]).flat().map((s: any) => ({
      startDate: s.startDate as string,
      quantity:  s.quantity as number,
    }));
  }

  // ── Step 7: Nightly HRV + overnight HR ───────────────────────────────────
  const hrvSamplesForSleep = (allHRVSamples as any[]).map((s: any) => ({
    startDate: s.startDate as string,
    quantity:  s.quantity as number,
  }));

  const nightlyHRV: NightlyHRV[] = sleepSessions.map((session) => {
    const { weightedRMSSD, annotatedSamples } = computeWeightedRMSSD(session, hrvSamplesForSleep);
    const overnightHR = computeOvernightHR(session, sleepHRSamples);
    return { date: session.date, samples: annotatedSamples, weightedRMSSD, overnightHR };
  });

  // ── Step 8: Power estimation for runs without native sensor ──────────────
  progress('Classifying workouts…', 90);

  const runs = classifiedRuns.map((run) => {
    const hasNativePower = (run.workPower ?? 0) > 0;
    const pace = run.workPace ?? run.pace;
    if (hasNativePower || !pace || pace <= 0) return run;

    const estimate = (secs: number) =>
      secs > 0 ? Math.round((1000 / secs) * bodyMassKg * 1.04) : 0;

    const workPower = estimate(pace);
    const intervals = (run.intervals ?? []).map((rep: any) =>
      rep.avgPowerW > 0 ? rep : { ...rep, avgPowerW: estimate(rep.avgPaceSecs) }
    );

    return { ...run, workPower, isEstimatedPower: true, intervals };
  });

  // ── Step 9: Today's recovery ──────────────────────────────────────────────
  const todayStr = toDateStr(now.toISOString());
  const tonightSession = sleepSessions.findLast((s) => s.date === todayStr);
  const tonightHRV     = nightlyHRV.findLast((n) => n.date === todayStr);

  let todayRecovery: DailyRecovery | null = null;
  if (tonightHRV && tonightHRV.weightedRMSSD > 0) {
    const historyBeforeToday = nightlyHRV.filter((n) => n.date < todayStr);
    const { score, baseline, trend, overnightHRBaseline } = computeRecoveryScore(
      tonightHRV.weightedRMSSD,
      tonightHRV.overnightHR,
      historyBeforeToday
    );
    todayRecovery = {
      date:                todayStr,
      weightedRMSSD:       tonightHRV.weightedRMSSD,
      overnightHR:         tonightHRV.overnightHR,
      overnightHRBaseline,
      recoveryScore:       score,
      baseline7Day:        baseline,
      trend,
      sleep:               tonightSession ?? null,
      label:               scoreToLabel(score),
      color:               scoreToColor(score),
    };
  }

  progress('Done', 100);

  return {
    runs,
    vo2max: (vo2maxSamples as any[]).map((s: any) => ({
      date:  s.startDate,
      value: Math.round(s.quantity * 10) / 10,
    })),
    hrv: (allHRVSamples as any[])
      .filter((s: any) => new Date(s.startDate) >= twoWeeksAgo)
      .map((s: any) => ({ date: s.startDate, value: Math.round(s.quantity) })),
    restingHR: (restingHRSamples as any[]).map((s: any) => ({
      date:  s.startDate,
      value: Math.round(s.quantity),
    })),
    weeklyMileage:    computeWeeklyMileage(runs),
    todayRecovery,
    recentNightlyHRV: nightlyHRV.slice(-14),
    recentSleep:      sleepSessions.slice(-14),
    workoutTypeStats: computeWorkoutTypeStats(runs),
    estimatedMaxHR:   maxHR,
    fetchedAt:        now.toISOString(),
  };
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
