// ─── Workout classification ───────────────────────────────────────────────────

export type WorkoutLabel =
  | 'Intervals'   // multiple hard efforts, high HR variability
  | 'Tempo'       // sustained threshold effort, steady Z3-Z4
  | 'Z2'          // aerobic base, steady zone 2
  | 'LongRun'     // extended duration, Z2-Z3 mix
  | 'Recovery'    // very easy, Z1
  | 'Unknown';    // insufficient HR data

export type WorkoutConfidence = 'high' | 'medium' | 'low';

/** % of run time spent in each HR zone */
export interface ZoneDistribution {
  z1: number; // < 60% maxHR
  z2: number; // 60–70%
  z3: number; // 70–80%
  z4: number; // 80–90%
  z5: number; // > 90%
}

/** One detected work rep within an interval session */
export interface IntervalRep {
  rep: number;           // 1-based index
  durationSecs: number;
  avgHR: number;         // avg HR during this rep only
  peakHR: number;
  avgPaceSecs: number;   // secs/km; 0 if distance data unavailable
  avgPowerW: number;     // watts; 0 if power data unavailable
}

export interface WorkoutAnalysis {
  uuid: string;
  date: string;
  label: WorkoutLabel;
  confidence: WorkoutConfidence;
  zones: ZoneDistribution;
  avgHR: number;           // raw avg HR (whole workout incl. warm-up)
  workHR: number;          // avg HR during work segments only
  workPace: number;        // avg pace during work segments only (secs/km)
  workPower: number;       // avg power during work segments (watts; 0 if unavailable)
  intervals: IntervalRep[]; // per-rep data for Intervals sessions
  maxHRObserved: number;
  hrCV: number;
  distance: number;        // metres
  duration: number;        // seconds
  pace: number;            // seconds per km (whole workout)
  calories: number;
  classifiedAt: string;
}

export interface WorkoutCache {
  analyses: Record<string, WorkoutAnalysis>; // uuid → analysis
  estimatedMaxHR: number;
  lastUpdated: string;
}

// ─── Runs ────────────────────────────────────────────────────────────────────

export interface RunWorkout {
  uuid: string;
  date: string;
  duration: number;      // seconds
  distance: number;      // metres
  calories: number;
  avgHeartRate?: number; // raw avg HR (whole workout)
  pace: number;          // seconds per km
  // Populated after classification
  label?: WorkoutLabel;
  confidence?: WorkoutConfidence;
  zones?: ZoneDistribution;
  hrCV?: number;
  workHR?: number;            // avg HR during work segments only
  workPace?: number;          // avg pace during work segments only (secs/km)
  workPower?: number;         // avg power during work segments (watts)
  isEstimatedPower?: boolean; // true when power is derived from pace, not measured by sensor
  intervals?: IntervalRep[];  // per-rep data (Intervals sessions only)
}

export interface WeeklyMileage {
  week: string;
  km: number;
}

// ─── Sleep ───────────────────────────────────────────────────────────────────

export type SleepStageLabel =
  | 'inBed'
  | 'asleepCore'
  | 'asleepDeep'
  | 'asleepREM'
  | 'asleepUnspecified'
  | 'awake';

export interface SleepSegment {
  startDate: string;
  endDate: string;
  stage: SleepStageLabel;
  durationMinutes: number;
}

export interface SleepSession {
  date: string;
  bedtime: string;
  wakeTime: string;
  totalMinutes: number;
  deepMinutes: number;
  remMinutes: number;
  coreMinutes: number;
  awakeMinutes: number;
  segments: SleepSegment[];
}

// ─── Recovery ────────────────────────────────────────────────────────────────

export interface NightlyHRV {
  date: string;
  samples: { timestamp: string; rmssd: number; stage: SleepStageLabel }[];
  weightedRMSSD: number;
  overnightHR: number; // avg HR during actual sleep stages (excl awake/inBed); 0 if unavailable
}

export interface DailyRecovery {
  date: string;
  weightedRMSSD: number;
  overnightHR: number;         // avg HR during sleep stages; 0 if no data
  overnightHRBaseline: number; // rolling avg overnight HR for comparison
  recoveryScore: number;
  baseline7Day: number;        // HRV 30-day rolling mean
  trend: 'rising' | 'falling' | 'stable';
  sleep: SleepSession | null;
  label: 'optimal' | 'good' | 'moderate' | 'poor';
  color: string;
}

// ─── Snapshot ────────────────────────────────────────────────────────────────

/** Per-type grouped statistics — precomputed for chat context */
export interface WorkoutTypeStats {
  label: WorkoutLabel;
  count: number;
  avgHR: number;
  avgPace: number;        // seconds per km
  avgDistance: number;    // metres
  avgDuration: number;    // seconds
  hrTrend: number[];      // avgHR per session, oldest → newest (for "improving/declining" queries)
  paceTrend: number[];    // avgPace per session
  lastDate: string;
}

export interface HealthSnapshot {
  runs: RunWorkout[];
  vo2max: { date: string; value: number }[];
  hrv: { date: string; value: number }[];
  restingHR: { date: string; value: number }[];
  weeklyMileage: WeeklyMileage[];
  todayRecovery: DailyRecovery | null;
  recentNightlyHRV: NightlyHRV[];
  recentSleep: SleepSession[];
  // Workout classification
  workoutTypeStats: WorkoutTypeStats[];   // aggregated per type
  estimatedMaxHR: number;
  fetchedAt: string;
}

export interface CoachingReport {
  content: string;
  generatedAt: string;
  model: string;
}
