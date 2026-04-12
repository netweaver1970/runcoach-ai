import HealthKit from '@kingstinct/react-native-healthkit';

// In @kingstinct/react-native-healthkit v9, the enums are TypeScript-only types
// (their JS files export {}). Use string/numeric literals at runtime.
const HKQuantityTypeIdentifier = {
  heartRate:                   'heartRate',
  heartRateVariabilitySDNN:    'heartRateVariabilitySDNN',
  restingHeartRate:            'restingHeartRate',
  vo2Max:                      'vo2Max',
  distanceWalkingRunning:      'distanceWalkingRunning',
  bodyMass:                    'bodyMass',
} as const;

const HKCategoryTypeIdentifier = {
  sleepAnalysis: 'sleepAnalysis',
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
import { classifyAndCacheRuns, computeWorkoutTypeStats, PerRunData } from './workoutClassifier';
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

/**
 * Weights used for the HRV weighted average.
 * Deep sleep is the most reliable window for parasympathetic HRV.
 * Awake and inBed segments are excluded (weight 0).
 */
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

/**
 * Subscribe to new running workout data in HealthKit.
 * Returns a cleanup function — call it on component unmount.
 * Falls back silently if the package version doesn't support observers.
 */
export async function subscribeToWorkoutChanges(
  onNewWorkout: () => void
): Promise<() => void> {
  try {
    // @kingstinct/react-native-healthkit v9 exposes subscribeToChanges
    // which returns a Promise<() => void> (the unsubscribe fn)
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
    // In v9, HKQuantityTypeIdentifier/HKCategoryTypeIdentifier are TypeScript-only
    // types — at runtime they are empty objects. Use string literals directly.
    const baseTypes = [
      'heartRate',
      'heartRateVariabilitySDNN',
      'restingHeartRate',
      'vo2Max',
      'distanceWalkingRunning',
      'bodyMass',
      'sleepAnalysis',
    ] as any[];
    await HealthKit.requestAuthorization([], baseTypes);
    try {
      await HealthKit.requestAuthorization([], ['HKQuantityTypeIdentifierRunningPower'] as any);
    } catch {
      // Device doesn't support running power — continue without it
    }
    return true;
  } catch (err: any) {
    const msg = err?.message ?? err?.toString() ?? 'unknown error';
    console.error('HealthKit auth error:', err);
    throw new Error(`HealthKit auth failed: ${msg}`);
  }
}

/**
 * Resolve body mass: SecureStore (user preference) → HealthKit → default.
 * If HealthKit provides a value not yet stored, it is cached in SecureStore.
 */
export async function resolveBodyMassKg(): Promise<number> {
  const stored = await getBodyMassKg();
  if (stored !== DEFAULT_BODY_MASS_KG) return stored; // user explicitly set a value

  try {
    const samples = await HealthKit.queryQuantitySamples(
      HKQuantityTypeIdentifier.bodyMass,
      { unit: 'kg', limit: 1, ascending: false }
    );
    if (samples.length > 0) {
      const kg = Math.round(samples[0].quantity);
      if (kg >= 30 && kg <= 250) {
        await saveBodyMassKg(kg); // cache for future use
        return kg;
      }
    }
  } catch {
    // HealthKit unavailable or no body mass data
  }
  return DEFAULT_BODY_MASS_KG;
}

// ─── Sleep parsing ────────────────────────────────────────────────────────────

/**
 * Given raw sleep category samples, group them into nightly sessions.
 * A new session starts when there is a gap of >3 hours between samples.
 */
function groupIntoSessions(
  rawSamples: { startDate: string; endDate: string; value: number }[]
): SleepSession[] {
  if (rawSamples.length === 0) return [];

  // Sort chronologically
  const sorted = [...rawSamples].sort(
    (a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime()
  );

  const sessions: SleepSession[] = [];
  let current: typeof sorted = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const gap = minutesBetween(current[current.length - 1].endDate, sorted[i].startDate);
    if (gap > 180) {
      // >3 hour gap → new session
      sessions.push(buildSession(current));
      current = [sorted[i]];
    } else {
      current.push(sorted[i]);
    }
  }
  sessions.push(buildSession(current));

  // Only keep sessions that include actual sleep (not just inBed)
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
    date: toDateStr(wakeTime), // date the person woke up
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

/**
 * Compute the stage-weighted RMSSD average for one night.
 *
 * Apple Watch stores HRV under HKQuantityTypeIdentifierHeartRateVariabilitySDNN,
 * but the values are computed using RMSSD (root mean square of successive
 * differences). We take all HRV readings that fall within the sleep window
 * and weight each by the sleep stage it lands in.
 */
function computeWeightedRMSSD(
  session: SleepSession,
  hrvSamples: { startDate: string; quantity: number }[]
): { weightedRMSSD: number; annotatedSamples: NightlyHRV['samples'] } {
  const sessionStart = new Date(session.bedtime).getTime();
  const sessionEnd = new Date(session.wakeTime).getTime();

  // Filter HRV samples to this sleep window
  const nightSamples = hrvSamples.filter((s) => {
    const t = new Date(s.startDate).getTime();
    return t >= sessionStart && t <= sessionEnd;
  });

  if (nightSamples.length === 0) {
    return { weightedRMSSD: 0, annotatedSamples: [] };
  }

  // Assign each HRV sample to a sleep stage
  const annotatedSamples: NightlyHRV['samples'] = nightSamples.map((s) => {
    const sampleTime = new Date(s.startDate).getTime();
    // Find which segment this sample falls in
    const seg = session.segments.find((sg) => {
      const start = new Date(sg.startDate).getTime();
      const end = new Date(sg.endDate).getTime();
      return sampleTime >= start && sampleTime <= end;
    });
    const stage: SleepStageLabel = seg?.stage ?? 'asleepUnspecified';
    return { timestamp: s.startDate, rmssd: Math.round(s.quantity), stage };
  });

  // Weighted average: sum(rmssd * stageWeight) / sum(stageWeight)
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

/**
 * Average heart rate during actual sleep stages (excludes awake/inBed).
 * Elevated overnight HR relative to baseline is a recovery stress signal.
 */
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

/**
 * Blended recovery score: 65% HRV (weighted RMSSD) + 35% overnight resting HR.
 * Both signals use z-score normalization against 30-day rolling history.
 * RHR contribution is inverted (higher HR = lower score).
 * Falls back to HRV-only if overnight HR history is insufficient (<3 nights).
 */
function computeRecoveryScore(
  todayRMSSD: number,
  todayOvernightHR: number,
  history: NightlyHRV[] // sorted oldest → newest, NOT including today
): { score: number; baseline: number; trend: DailyRecovery['trend']; overnightHRBaseline: number } {
  const recent = history.slice(-30).filter((n) => n.weightedRMSSD > 0);

  // ── HRV component ────────────────────────────────────────────────────────
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

  // ── Overnight HR component (inverted: high HR → low score) ───────────────
  const recentWithHR = recent.filter((n) => n.overnightHR > 0);
  let overnightHRBaseline = todayOvernightHR;
  let rhrScore = 50; // neutral default

  if (recentWithHR.length >= 3 && todayOvernightHR > 0) {
    const hrValues = recentWithHR.map((n) => n.overnightHR);
    const hrMean = hrValues.reduce((a, b) => a + b, 0) / hrValues.length;
    const hrStddev =
      Math.sqrt(hrValues.reduce((a, b) => a + (b - hrMean) ** 2, 0) / hrValues.length) || 1;
    overnightHRBaseline = Math.round(hrMean);
    const hrZ = (todayOvernightHR - hrMean) / hrStddev; // positive = elevated = bad
    rhrScore = Math.min(100, Math.max(0, 50 - hrZ * 25));
  }

  // ── Blend ────────────────────────────────────────────────────────────────
  const useRHR = todayOvernightHR > 0 && recentWithHR.length >= 3;
  const rawScore = useRHR ? 0.65 * hrvScore + 0.35 * rhrScore : hrvScore;
  const score = Math.round(rawScore);

  // ── Trend (based on HRV 7-day) ───────────────────────────────────────────
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
  if (score >= 80) return '#27ae60'; // green
  if (score >= 60) return '#f39c12'; // amber
  if (score >= 40) return '#e67e22'; // orange
  return '#c0392b';                  // red
}

// ─── Main fetch ───────────────────────────────────────────────────────────────

export async function fetchHealthSnapshot(): Promise<HealthSnapshot> {
  const now = new Date();
  const fourWeeksAgo = daysAgo(28);
  const eightWeeksAgo = daysAgo(56);
  const twoWeeksAgo = daysAgo(14);
  const thirtyDaysAgo = daysAgo(30);

  // ── Running workouts ──────────────────────────────────────────────────────
  const allWorkouts = await HealthKit.queryWorkoutSamples({
    from: fourWeeksAgo,
    to: now,
    limit: 40,
    ascending: false,
    energyUnit: 'kilocalorie',
    distanceUnit: 'meter',
  });
  const runWorkouts = allWorkouts
    .filter((w) => w.workoutActivityType === HK_WORKOUT_RUNNING)
    .slice(0, 15);

  // ── Heart rate, distance, and running power (fetched in parallel) ───────────
  const [hrSamples, distanceSamples, powerSamplesRaw] = await Promise.all([
    HealthKit.queryQuantitySamples(
      HKQuantityTypeIdentifier.heartRate,
      { from: fourWeeksAgo, to: now, unit: 'count/min', ascending: true, limit: 3000 }
    ),
    HealthKit.queryQuantitySamples(
      HKQuantityTypeIdentifier.distanceWalkingRunning,
      { from: fourWeeksAgo, to: now, unit: 'meter', ascending: true, limit: 8000 }
    ),
    // runningPower: watchOS 9+ / iOS 16+. Returns [] silently on older devices.
    HealthKit.queryQuantitySamples(
      'HKQuantityTypeIdentifierRunningPower' as any,
      { from: fourWeeksAgo, to: now, unit: 'W', ascending: true, limit: 8000 }
    ).catch(() => [] as any[]),
  ]);

  // Build per-run PerRunData (HR values + timestamps + distance segments)
  const perRunData = new Map<string, PerRunData>();
  const rawRuns: RunWorkout[] = runWorkouts.map((w) => {
    const startMs = new Date(w.startDate).getTime();
    const endMs   = new Date(w.endDate).getTime();

    const runHR = hrSamples.filter(s => {
      const t = new Date(s.startDate).getTime();
      return t >= startMs && t <= endMs;
    });
    const hrValues       = runHR.map(s => s.quantity);
    const hrTimestampsMs = runHR.map(s => new Date(s.startDate).getTime());

    const distSegs = distanceSamples
      .filter(s => {
        const t = new Date(s.startDate).getTime();
        return t >= startMs && t <= endMs;
      })
      .map(s => ({ t: new Date(s.startDate).getTime(), m: s.quantity }));

    const powerSegs = (powerSamplesRaw as any[])
      .filter(s => {
        const t = new Date(s.startDate).getTime();
        return t >= startMs && t <= endMs;
      })
      .map(s => ({ t: new Date(s.startDate).getTime(), w: s.quantity as number }));

    perRunData.set(w.uuid, { hrValues, hrTimestampsMs, distSegs, powerSegs });

    const avgHR = hrValues.length > 0
      ? Math.round(hrValues.reduce((a, b) => a + b, 0) / hrValues.length)
      : undefined;
    const distanceM = w.totalDistance?.quantity ?? 0;
    const durationS = w.duration;
    return {
      uuid: w.uuid,
      date: w.startDate,
      duration: durationS,
      distance: distanceM,
      calories: w.totalEnergyBurned?.quantity ?? 0,
      avgHeartRate: avgHR,
      pace: distanceM > 0 ? durationS / (distanceM / METERS_PER_KM) : 0,
    };
  });

  const allHRValues = hrSamples.map(s => s.quantity);
  const [{ runs: classifiedRuns, maxHR }, bodyMassKg] = await Promise.all([
    classifyAndCacheRuns(rawRuns, perRunData, allHRValues),
    resolveBodyMassKg(),
  ]);

  // Fill in estimated power for any run without native sensor power.
  // Formula: P = speed(m/s) × mass(kg) × 1.04  (flat-ground metabolic approximation)
  const runs = classifiedRuns.map(run => {
    const hasNativePower = (run.workPower ?? 0) > 0;
    const pace = run.workPace ?? run.pace;
    if (hasNativePower || !pace || pace <= 0) return run;

    const estimate = (secs: number) =>
      secs > 0 ? Math.round((1000 / secs) * bodyMassKg * 1.04) : 0;

    const workPower = estimate(pace);

    // Also back-fill per-interval power from per-rep pace
    const intervals = (run.intervals ?? []).map(rep =>
      rep.avgPowerW > 0 ? rep
        : { ...rep, avgPowerW: estimate(rep.avgPaceSecs) }
    );

    return { ...run, workPower, isEstimatedPower: true, intervals };
  });

  // ── VO2 Max ───────────────────────────────────────────────────────────────
  const vo2maxSamples = await HealthKit.queryQuantitySamples(
    HKQuantityTypeIdentifier.vo2Max,
    { from: eightWeeksAgo, to: now, unit: 'ml/kg·min', ascending: true, limit: 60 }
  );

  // ── All HRV samples (RMSSD via SDNN key) — 30 days for baseline ───────────
  const allHRVSamples = await HealthKit.queryQuantitySamples(
    HKQuantityTypeIdentifier.heartRateVariabilitySDNN,
    { from: thirtyDaysAgo, to: now, unit: 'ms', ascending: true, limit: 500 }
  );

  // ── Resting HR ────────────────────────────────────────────────────────────
  const restingHRSamples = await HealthKit.queryQuantitySamples(
    HKQuantityTypeIdentifier.restingHeartRate,
    { from: twoWeeksAgo, to: now, unit: 'count/min', ascending: true, limit: 30 }
  );

  // ── Sleep (30 days) ───────────────────────────────────────────────────────
  const rawSleepSamples = await HealthKit.queryCategorySamples(
    HKCategoryTypeIdentifier.sleepAnalysis,
    { from: thirtyDaysAgo, to: now, ascending: true, limit: 2000 }
  );

  const sleepSessions = groupIntoSessions(
    rawSleepSamples.map((s) => ({
      startDate: s.startDate,
      endDate: s.endDate,
      value: s.value as number,
    }))
  );

  // ── Nightly weighted RMSSD + overnight HR ────────────────────────────────
  const rawHRForSleep = hrSamples.map((s) => ({ startDate: s.startDate, quantity: s.quantity }));
  const nightlyHRV: NightlyHRV[] = sleepSessions.map((session) => {
    const { weightedRMSSD, annotatedSamples } = computeWeightedRMSSD(
      session,
      allHRVSamples.map((s) => ({ startDate: s.startDate, quantity: s.quantity }))
    );
    const overnightHR = computeOvernightHR(session, rawHRForSleep);
    return {
      date: session.date,
      samples: annotatedSamples,
      weightedRMSSD,
      overnightHR,
    };
  });

  // ── Today's recovery ──────────────────────────────────────────────────────
  const todayStr = toDateStr(now.toISOString());
  const tonightSession = sleepSessions.findLast((s) => s.date === todayStr);
  const tonightHRV = nightlyHRV.findLast((n) => n.date === todayStr);

  let todayRecovery: DailyRecovery | null = null;
  if (tonightHRV && tonightHRV.weightedRMSSD > 0) {
    const historyBeforeToday = nightlyHRV.filter((n) => n.date < todayStr);
    const { score, baseline, trend, overnightHRBaseline } = computeRecoveryScore(
      tonightHRV.weightedRMSSD,
      tonightHRV.overnightHR,
      historyBeforeToday
    );
    todayRecovery = {
      date: todayStr,
      weightedRMSSD: tonightHRV.weightedRMSSD,
      overnightHR: tonightHRV.overnightHR,
      overnightHRBaseline,
      recoveryScore: score,
      baseline7Day: baseline,
      trend,
      sleep: tonightSession ?? null,
      label: scoreToLabel(score),
      color: scoreToColor(score),
    };
  }

  return {
    runs,
    vo2max: vo2maxSamples.map((s) => ({
      date: s.startDate,
      value: Math.round(s.quantity * 10) / 10,
    })),
    hrv: allHRVSamples
      .filter((s) => new Date(s.startDate) >= twoWeeksAgo)
      .map((s) => ({ date: s.startDate, value: Math.round(s.quantity) })),
    restingHR: restingHRSamples.map((s) => ({
      date: s.startDate,
      value: Math.round(s.quantity),
    })),
    weeklyMileage: computeWeeklyMileage(runs),
    todayRecovery,
    recentNightlyHRV: nightlyHRV.slice(-14),
    recentSleep: sleepSessions.slice(-14),
    workoutTypeStats: computeWorkoutTypeStats(runs),
    estimatedMaxHR: maxHR,
    fetchedAt: now.toISOString(),
  };
}

function computeWeeklyMileage(runs: RunWorkout[]): WeeklyMileage[] {
  const weeks: Record<string, number> = {};
  runs.forEach((run) => {
    const date = new Date(run.date);
    const monday = new Date(date);
    monday.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    const key = monday.toISOString().split('T')[0];
    weeks[key] = (weeks[key] ?? 0) + run.distance / METERS_PER_KM;
  });
  return Object.entries(weeks)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, km]) => ({ week, km: Math.round(km * 10) / 10 }));
}
