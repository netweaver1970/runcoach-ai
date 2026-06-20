/**
 * Bevel KPI catalogue — the "learned" reference from the 2026-06-20 screenshot round.
 *
 * This is the ground truth the in-app vision extraction uses to interpret Bevel
 * screenshots (units, magnitudes, labels) and the mapping the correlation uses to
 * line each Bevel component up against our own HealthKit-derived metric.
 *
 * Magnitudes were read off Bevel's per-component detail charts (30-day view).
 * They are hints, not hard limits — Bevel's "normal range" is a personalised band.
 */

export type UnitKind =
  | 'percent'        // 94.7  → 94.7
  | 'bpm'            // 59.4  → 59.4
  | 'ms'             // 38.2  → 38.2   (HRV is SDNN-style, not RMSSD)
  | 'rpm'            // 13.7  → 13.7
  | 'kcal'           // 1,436 → 1436
  | 'steps'          // 11,592 → 11592
  | 'duration_min'   // 1h 10m → 70    (minutes)
  | 'clock_time'     // 05:51 → 351    (minutes since midnight; may wrap past midnight)
  | 'signed_min';    // -46m → -46     (signed balance, e.g. Sleep Bank)

export interface ComponentScale {
  key:        string;     // stable id used in the stored dataset
  label:      string;     // Bevel's exact on-screen label (card / tab title)
  unit:       UnitKind;
  suffix:     string;     // unit shown on screen ('%', 'bpm', 'kcal', 'min', 'clock', …)
  /** Magnitude hint for the vision model: observed avg + normal band + chart axis. */
  typical:    string;
  ourField:   string;     // our equivalent metric (for correlation / build reference)
  isScore?:   boolean;    // the composite headline value for the KPI
  signed?:    boolean;    // value can be negative (Sleep Bank)
}

export interface KpiScale {
  key:        'strain' | 'recovery' | 'sleep';
  label:      string;
  /** Band thresholds for the headline score (%, on a 0–100 display). */
  bands:      { label: string; lt?: number; gte?: number }[];
  components: ComponentScale[];
}

// ─── The three KPIs ─────────────────────────────────────────────────────────────

export const BEVEL_KPIS: KpiScale[] = [
  {
    key: 'strain',
    label: 'Strain',
    bands: [
      { label: 'Low',    lt: 34 },
      { label: 'Normal', gte: 34 },
      { label: 'High',   gte: 67 },
    ],
    components: [
      { key: 'strainScore',      label: 'Strain Score',      unit: 'percent',      suffix: '%',    isScore: true, typical: 'avg 26%, normal 3–45%, chart axis 0–117 (uncapped)', ourField: 'snapshot.strain.real' },
      { key: 'exerciseDuration', label: 'Exercise Duration', unit: 'duration_min', suffix: 'min',  typical: 'avg 43m, normal 0m–1h32m, chart 0–5h24m', ourField: 'sum of workout durations that day' },
      { key: 'daytimeHR',        label: 'Daytime HR',        unit: 'bpm',          suffix: 'bpm',  typical: 'avg 67, normal 64–71, chart 59–80', ourField: 'mean awake HR' },
      { key: 'totalEnergy',      label: 'Total Energy',      unit: 'kcal',         suffix: 'kcal', typical: 'avg 2,532, normal 2,036–2,972, chart 823–5,120', ourField: 'activeEnergy + basalEnergy (kcal)' },
      { key: 'stepCount',        label: 'Step Count',        unit: 'steps',        suffix: '',     typical: 'avg 8,590, normal 2,440–13,812, chart 0–35.8k', ourField: 'HealthKit step count' },
    ],
  },
  {
    key: 'recovery',
    label: 'Recovery',
    bands: [
      { label: 'Poor',    lt: 34 },
      { label: 'Normal',  gte: 34 },
      { label: 'Optimal', gte: 67 },
    ],
    components: [
      { key: 'recoveryScore',   label: 'Recovery Score',   unit: 'percent', suffix: '%',   isScore: true, typical: 'avg 55%, normal 35–77%, chart 0–100', ourField: 'snapshot recovery score' },
      { key: 'restingHrv',      label: 'Resting HRV',      unit: 'ms',      suffix: 'ms',  typical: 'avg 34.6, normal 27.4–42.6, chart 8.1–68.5 (SDNN-style)', ourField: 'HealthKit heartRateVariabilitySDNN (overnight)' },
      { key: 'restingHr',       label: 'Resting HR',       unit: 'bpm',     suffix: 'bpm', typical: 'avg 60.2, normal 56.5–63.4, chart 49.3–77.1', ourField: 'overnight resting HR' },
      { key: 'respiratoryRate', label: 'Respiratory Rate', unit: 'rpm',     suffix: 'rpm', typical: 'avg 14.2, normal 13.5–14.8, chart 12.5–16.8', ourField: 'HealthKit respiratoryRate (overnight)' },
      { key: 'oxygenSaturation',label: 'Oxygen Saturation',unit: 'percent', suffix: '%',   typical: 'avg 95.0, normal 94.4–95.7, chart 92.1–96.7', ourField: 'HealthKit oxygenSaturation (overnight)' },
      // Wrist Temperature intentionally excluded — no sensor on Apple Watch Ultra 1.
    ],
  },
  {
    key: 'sleep',
    label: 'Sleep',
    bands: [
      { label: 'Low',     lt: 70 },
      { label: 'Normal',  gte: 70 },
      { label: 'Optimal', gte: 85 },
    ],
    components: [
      { key: 'sleepScore',   label: 'Sleep Score',   unit: 'percent',      suffix: '%',     isScore: true, typical: 'avg 71%, normal 52–91%, chart 0–100', ourField: 'snapshot sleep score' },
      { key: 'timeAsleep',   label: 'Time Asleep',   unit: 'duration_min', suffix: 'min',   typical: 'avg 6h17m, normal 4h39m–7h46m, chart 14m–10h30m', ourField: 'total asleep duration' },
      { key: 'remSleep',     label: 'REM Sleep',     unit: 'duration_min', suffix: 'min',   typical: 'avg 1h38m, normal 1h6m–2h7m, chart 4m–2h46m', ourField: 'HealthKit REM duration' },
      { key: 'deepSleep',    label: 'Deep Sleep',    unit: 'duration_min', suffix: 'min',   typical: 'avg 38m, normal 26m–51m, chart 12m–1h12m', ourField: 'HealthKit deep (core+deep?) duration' },
      { key: 'heartRateDip', label: 'Heart Rate Dip',unit: 'percent',      suffix: '%',     typical: 'avg 10%, normal 6–14%, chart -4–24', ourField: 'overnight HR drop vs daytime' },
      { key: 'sleepBank',    label: 'Sleep Bank',    unit: 'signed_min',   suffix: 'min',   signed: true, typical: 'signed balance, chart -6h…+3h; negative = debt', ourField: 'rolling sleep-debt vs goal' },
      { key: 'sleepTime',    label: 'Sleep Time',    unit: 'clock_time',   suffix: 'clock', typical: 'onset clock time; avg 23:36, normal 21:49–01:35 (wraps midnight)', ourField: 'bedtime / sleep onset clock' },
      { key: 'wakeTime',     label: 'Wake Time',     unit: 'clock_time',   suffix: 'clock', typical: 'wake clock time; avg 06:21, normal 04:32–08:14', ourField: 'wake clock' },
      // Time to Fall Asleep excluded — depends on the manual "sleep now" gesture (rarely used).
    ],
  },
];

export function kpiScale(key: KpiScale['key']): KpiScale {
  return BEVEL_KPIS.find(k => k.key === key)!;
}
