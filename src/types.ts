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

export interface KmSplit {
  km:          number;  // 1-based km number
  durationSec: number;  // wall-clock duration of this km (including pauses)
  paceSecs:    number;  // secs/km net of pauses (excludes paused time)
  avgHR:       number;  // avg HR including pauses; 0 if unavailable
  avgCadence:  number;  // avg cadence spm, pauses excluded; 0 if unavailable
  avgPower:    number;  // avg power watts, pauses excluded; 0 if unavailable
}

export type TimelineEventType = 'status' | 'supplement' | 'event';
// running = "Active" (normal training), holiday = "On a break". Labels live in timelineEvents.ts.
export type HealthStatus = 'running' | 'injured' | 'sick' | 'holiday';

export interface TimelineEvent {
  id:          string;
  date:        string;           // YYYY-MM-DD (start date)
  type:        TimelineEventType;
  status?:     HealthStatus;      // type 'status'
  supplement?: string;            // type 'supplement'
  action?:     'start' | 'stop';
  title?:      string;            // type 'event' — e.g. "Hair transplant", "Dance trip in Portugal"
  endDate?:    string;            // type 'event' (range) or status set "until" — YYYY-MM-DD
  category?:   string;            // type 'event' — e.g. 'medical' | 'holiday' | 'travel' | 'other'
  note?:       string;
}

// The athlete's current overall status, shown on the home screen + fed to the coach.
export interface AthleteStatus {
  status: HealthStatus;
  since:  string;                 // YYYY-MM-DD it was set
  until?: string;                 // YYYY-MM-DD it auto-reverts to Active (optional)
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
  version?: number; // bumped when classifier logic changes to force re-analysis
}

// ─── Runs ────────────────────────────────────────────────────────────────────

/** One structured workout phase from HKWorkoutActivity */
export interface WorkoutSegment {
  label:       string;  // Warmup | Work | Recovery | Cooldown | Walk
  durationSec: number;
  distanceM:   number;
  avgHR:       number;  // 0 if unavailable
  avgPower:    number;  // watts; 0 if unavailable
  cadenceSPM:  number;  // steps/min; 0 if unavailable
}

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
  workDuration?: number;      // total duration of work segments only (seconds)
  isEstimatedPower?: boolean; // true when power is derived from pace, not measured by sensor
  intervals?: IntervalRep[];  // per-rep data (Intervals sessions only)
  segments?: WorkoutSegment[]; // HK structured workout phases (empty for standard runs)
  kmSplits?:     KmSplit[];
  hrUnreliable?: boolean;
  tempC?:        number;       // temperature at run time (°C) — HK weather metadata, live capture, or manual
  note?:         string;       // user note for this run
}

export interface WeeklyMileage {
  week: string;
  km: number;
}

// ─── Activities & training load ───────────────────────────────────────────────

/** One HealthKit workout of ANY type (run, ride, strength, walk…) — used for load */
export interface ActivitySummary {
  uuid:        string;
  date:        string;  // ISO start
  activityType: number; // HKWorkoutActivityType numeric
  name:        string;  // human label e.g. "Run", "Cycling", "Strength"
  durationMin: number;
  kcal:        number;
  distanceKm:  number;  // 0 if not a distance activity
  avgHR:       number;  // 0 if unavailable
}

/** One day of the training-load (CTL/ATL/TSB) model */
export interface DailyLoad {
  date: string;   // YYYY-MM-DD
  load: number;   // raw training load for the day (all active-energy strain)
  atl:  number;   // acute training load — 7-day EWMA (fatigue)
  ctl:  number;   // chronic training load — 42-day EWMA (fitness)
  tsb:  number;   // training-stress balance — yesterday's (ctl − atl) (form)
}

/** Today's strain: real effort done vs the recommended safe range (Bevel-style TRIMP) */
export interface DayStrain {
  real:     number;  // 0-100+ Bevel-style strain (log-scaled daily TRIMP; uncapped)
  safeLow:  number;  // 0-100 recommended-range floor (from recovery + form)
  safeHigh: number;  // 0-100 recommended-range ceiling
  safeMid:  number;  // 0-100 recommended target
  trimp:    number;  // raw daily TRIMP (cardio 24/7 + muscular)
  cardio:   number;  // cardio TRIMP component
  muscular: number;  // muscular-load component
  // Readiness that produced the band — so every surface (ring, hero, detail, coach)
  // reads ONE computation instead of recomputing with divergent inputs.
  readiness?: number;    // 0-100 composite
  drivers?:   string[];  // human-readable factors
  acwr?:      number;    // acute:chronic ratio
  baseline?:  number;    // 14-day mean total strain that anchored the range (Bevel-style)
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

// Transparent breakdown of how the recovery score was built (for the detail screen).
export interface RecoveryBreakdown {
  rmssd: number; hrvMean: number; hrvSD: number; zHRV: number; hrvSub: number;   // HRV: true RMSSD vs 60d
  overnightHR: number; rhrMean: number; rhrSD: number; zRHR: number; rhrSub: number; // RHR: overnight HR vs 60d
  hrvWeight: number;     // HRV share of the core (rest is RHR)
  core: number;          // HRV/RHR-weighted core before sleep + RR
  sleepScore: number; sleepTerm: number;       // + 0.32·(sleep − 72)
  rr: number; rrBaseline: number; rrPenalty: number; // − 3.9·max(0, RR − baseline)
  final: number;
}

export interface DailyRecovery {
  date: string;
  weightedRMSSD: number;
  overnightHR: number;         // avg HR during sleep stages; 0 if no data
  overnightHRBaseline: number; // rolling avg overnight HR for comparison
  recoveryScore: number;
  sleepScore: number;          // 0-100 sleep quality score
  baseline7Day: number;        // HRV 60-day rolling mean (field name kept for compat)
  trend: 'rising' | 'falling' | 'stable';
  sleep: SleepSession | null;
  label: 'optimal' | 'good' | 'moderate' | 'poor';
  color: string;
  breakdown?: RecoveryBreakdown;
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
  nightlyLean?: { d: string; h: number; s: number }[];  // full lean nightly series (debug/calibration)
  recentSleep: SleepSession[];
  // Workout classification
  workoutTypeStats: WorkoutTypeStats[];   // aggregated per type
  estimatedMaxHR: number;
  fetchedAt: string;
  timelineEvents: TimelineEvent[];
  // All-activity training load
  activities: ActivitySummary[];   // ALL HealthKit workouts in window (not just runs)
  trainingLoad: DailyLoad[];       // daily CTL/ATL/TSB series (recent ~90 days)
  strain: DayStrain | null;        // today's strain (real effort vs safe range)
  trimpRates?: { easy: number; moderate: number; hard: number }; // rolling TRIMP/min calibration (per intensity)
  athleteStatus?: AthleteStatus;   // current overall status (Active/Sick/Injured/On a break)
  supplementContext?: string;      // compact supplement-adherence line for the LLM
}

export interface CoachingReport {
  content: string;
  generatedAt: string;
  model: string;
}

// ─── Power zone thresholds (user-configurable) ────────────────────────────────

/**
 * User-defined watt boundaries for automatic run-type classification.
 * A value of 0 means "not configured" — the threshold is ignored.
 *
 *   <= recoveryMax              → Recovery
 *   recoveryMax < w <= z2Max   → Z2
 *   tempoMin <= w <= tempoMax  → Tempo
 *   >= intervalsMin            → Intervals
 */
export interface PowerZones {
  recoveryMax:  number;  // watts
  z2Max:        number;  // watts
  tempoMin:     number;  // watts
  tempoMax:     number;  // watts
  intervalsMin: number;  // watts
}
