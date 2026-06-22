/**
 * Body Energy Battery + stress model (Garmin / Bevel-style), computed on-device from
 * Apple Health. Stress (0–100) is driven by heart rate vs the resting baseline, modulated
 * by HRV (SDNN) when a TRUSTWORTHY reading is available; the battery (0–100) charges when
 * calm/asleep and discharges under stress/activity.
 *
 * HRV SELECTIVITY (important): the athlete runs an AFib-check app that logs many HRV
 * readings, some taken while moving (garbage). We only trust an HRV sample when:
 *   - its value is physiologically plausible (5–200 ms SDNN),
 *   - the Apple Watch heartbeat (R-R) series for that minute has no internal gaps
 *     (buildHeartbeatQualityMap / isGoodHRVSample — i.e. no motion drop-out), and
 *   - the surrounding heart rate looks at-rest (near resting, low variability).
 *
 * Figures are our estimate; calibration vs Bevel is a separate follow-up.
 */
import HealthKit from '@kingstinct/react-native-healthkit';
import { buildHeartbeatQualityMap, isGoodHRVSample, loadSnapshotCache } from './healthkit';

const HR_ID    = 'HKQuantityTypeIdentifierHeartRate';
const HRV_ID   = 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN';
const RHR_ID   = 'HKQuantityTypeIdentifierRestingHeartRate';
const SLEEP_ID = 'HKCategoryTypeIdentifierSleepAnalysis';
const ASLEEP = new Set([1, 3, 4, 5]); // asleepUnspecified/core/deep/REM (0=inBed, 2=awake)

const BIN_MIN = 10;
const WINDOW_H = 60;          // compute window (2+ nights so the seed washes out)
const BASELINE_DAYS = 14;     // HRV baseline window

// Battery dynamics (per-minute), Bevel "Energy Bank" style: the battery charges ONLY while
// asleep (Bevel's curve rises inside the sleep band, then declines monotonically all day) and
// drains whenever awake — slowly when calm, fast when stressed.
// Calibrated against Bevel (see scripts/bbtune.mjs against a device dump): battery now,
// drain and avg daytime stress match Bevel.
const REST_STRESS   = 33;     // kept for the debug dump; Bevel sleep-stress ~25
const SLEEP_CHARGE  = 0.125;  // per-minute while asleep
const BASE_DRAIN    = 0.012;  // per-minute awake baseline drain (even when calm)
const STRESS_DRAIN  = 0.068;  // additional per-minute drain at full stress (we over-drained
                              // ~20%: 22-Jun dump rate 0.072 vs Bevel 0.061 → end 8 not 0)
const SEED          = 42;     // starting level at the window edge
// HRV trust thresholds. The watch R-R "gap" flag over-rejects an AFib-app user's stable
// stress reads, so it is NOT a hard reject — a stable, near-resting HR is the arbiter.
const HRV_VMAX      = 110;    // SDNN above this = artifact (Bevel-style artifact removal)
const HRV_HR_OVER   = 20;     // reject if HR is more than this above resting (= movement)
const HRV_CV_MAX    = 0.18;   // reject if HR is erratic around the read (= movement)
const HRV_WIN_MIN   = 65;     // carry a trusted read this many minutes to fill gaps

const safe = async <T>(fn: () => Promise<T>, fb: T): Promise<T> => { try { return await fn(); } catch { return fb; } };
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface BatteryPoint { t: number; battery: number; stress: number; asleep: boolean; }
export interface BodyBattery {
  current: number;        // 0–100 now
  currentStress: number;  // 0–100 now
  trendPerHour: number;   // battery change over the last hour (+charging / −draining)
  dayLow: number; dayHigh: number;
  totalCharged: number;   // sum of + deltas over last 24h (Bevel "Total Charged")
  totalDrained: number;   // sum of − deltas over last 24h (Bevel "Total Drained")
  series: BatteryPoint[]; // last ~24h, BIN_MIN spacing
  hrvBaseline: number; restHR: number;
  hrvUsed: number; hrvRejected: number; // selectivity transparency
  computedAt: number;
  debug: any;             // raw trace for off-device calibration (Copy debug)
}

interface Sample { t: number; v: number; }

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export async function computeBodyBattery(): Promise<BodyBattery | null> {
  const now = Date.now();
  const from = new Date(now - WINDOW_H * 3_600_000);
  const baseFrom = new Date(now - BASELINE_DAYS * 86_400_000);

  const q = (id: string, start: Date, unit: string, limit = 100_000) =>
    safe(() => (HealthKit.queryQuantitySamples as any)(id, { filter: { startDate: start, endDate: new Date(now) }, unit, ascending: true, limit }), [] as any[]);

  const [hrRaw, hrvRaw, beatsRaw, rhrRaw, sleepRaw, hrvBaseRaw, snap] = await Promise.all([
    q(HR_ID, from, 'count/min'),
    q(HRV_ID, from, 'ms', 20_000),
    safe(() => (HealthKit as any).queryHeartbeatSeriesSamples({ filter: { startDate: from, endDate: new Date(now) }, ascending: true, limit: 5_000 }), [] as any[]),
    q(RHR_ID, baseFrom, 'count/min', 5_000),
    safe(() => (HealthKit.queryCategorySamples as any)(SLEEP_ID, { filter: { startDate: from, endDate: new Date(now) }, ascending: true, limit: 10_000 }), [] as any[]),
    q(HRV_ID, baseFrom, 'ms', 50_000),
    loadSnapshotCache(),
  ]);

  const hr: Sample[] = (hrRaw as any[]).map(s => ({ t: new Date(s.startDate).getTime(), v: s.quantity })).sort((a, b) => a.t - b.t);
  if (hr.length < 5) return null;

  const restHR = (rhrRaw as any[]).length ? Math.round((rhrRaw as any[]).at(-1).quantity) : 55;
  const maxHR  = (snap as any)?.estimatedMaxHR && (snap as any).estimatedMaxHR > 0 ? (snap as any).estimatedMaxHR : 190;

  // ── HR helpers ──────────────────────────────────────────────────────────────
  const hrStatsNear = (t: number, win = 90_000): { mean: number; cv: number } | null => {
    // hr is sorted; gather samples within ±win
    const xs: number[] = [];
    for (const h of hr) { if (h.t < t - win) continue; if (h.t > t + win) break; xs.push(h.v); }
    if (!xs.length) return null;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    return { mean, cv: mean > 0 ? sd / mean : 1 };
  };

  // ── HRV trust filter ──────────────────────────────────────────────────────────
  const qmap = buildHeartbeatQualityMap(beatsRaw as any[]);
  const trustHRV = (t: number, v: number, useHrContext: boolean): { ok: boolean; why: string } => {
    if (!(v >= 5 && v <= HRV_VMAX)) return { ok: false, why: 'value' }; // implausible / artifact SDNN
    if (useHrContext) {
      // The arbiter is the surrounding HR: heat/stress raises HR while STILL (real low-HRV
      // signal — keep it), whereas movement raises HR a lot and/or makes it erratic (reject).
      // The watch R-R "gap" flag over-rejects this user's stable reads, so it is NOT a reject.
      const s = hrStatsNear(t);
      if (s && s.mean > restHR + HRV_HR_OVER) return { ok: false, why: 'hr-high' };
      if (s && s.cv > HRV_CV_MAX)             return { ok: false, why: 'hr-erratic' };
    }
    return { ok: true, why: 'ok' };
  };

  // Baseline HRV from trusted readings over 14d (HR context not needed for plausibility-only baseline).
  const baseVals = (hrvBaseRaw as any[])
    .map(s => ({ t: new Date(s.startDate).getTime(), v: s.quantity as number }))
    .filter(s => trustHRV(s.t, s.v, false).ok)
    .map(s => s.v);
  const hrvBaseline = median(baseVals) || 45;

  // Trusted HRV inside the compute window (with HR-movement context). Capture per-sample
  // debug so the calibration can be replayed/diagnosed off-device.
  const fromMs = from.getTime();
  const relMin = (t: number) => Math.round((t - fromMs) / 60_000);
  let hrvUsed = 0, hrvRejected = 0;
  const validHrv: Sample[] = [];
  const hrvDebug: any[] = [];
  for (const s of (hrvRaw as any[])) {
    const t = new Date(s.startDate).getTime(), v = s.quantity as number;
    const ctx = hrStatsNear(t);
    const res = trustHRV(t, v, true);
    if (res.ok) { validHrv.push({ t, v }); hrvUsed++; } else hrvRejected++;
    hrvDebug.push({ m: relMin(t), v: Math.round(v), hr: ctx ? Math.round(ctx.mean) : 0, cv: ctx ? Math.round(ctx.cv * 100) : -1, rr: isGoodHRVSample(t, qmap) ? 1 : 0, ok: res.ok ? 1 : 0, w: res.why });
  }
  validHrv.sort((a, b) => a.t - b.t);
  const nearestHrv = (t: number, win = HRV_WIN_MIN * 60_000): number | null => {
    let best: number | null = null, bestDt = win;
    for (const s of validHrv) { const dt = Math.abs(s.t - t); if (dt <= bestDt) { bestDt = dt; best = s.v; } }
    return best;
  };

  // ── Sleep windows ──────────────────────────────────────────────────────────────
  const sleepWins = (sleepRaw as any[])
    .filter(s => ASLEEP.has(s.value))
    .map(s => ({ s: new Date(s.startDate).getTime(), e: new Date(s.endDate).getTime() }));
  const isAsleep = (t: number) => sleepWins.some(w => t >= w.s && t <= w.e);

  // ── Bin + integrate ──────────────────────────────────────────────────────────
  const binMs = BIN_MIN * 60_000;
  const start = Math.floor(from.getTime() / binMs) * binMs;
  let hi = 0;
  const stressAt = (avgHR: number, vHrv: number | null): number => {
    const hrr = clamp((avgHR - restHR) / Math.max(20, maxHR - restHR), 0, 1);
    const base = 100 * clamp((hrr - 0.04) / 0.45, 0, 1);
    if (vHrv == null) return base;
    const supp = clamp(hrvBaseline / Math.max(vHrv, 1), 0.5, 2.6);     // >1 = HRV suppressed
    const hrvStress = clamp((supp - 0.85) / 0.9, 0, 1) * 100;
    // HRV-dominant (Bevel-like): suppressed HRV reads high stress even at a modest HR.
    return clamp(0.35 * base + 0.65 * Math.max(base, hrvStress), 0, 100);
  };

  let battery = SEED; // washed out by the two nights inside the 60h window
  const series: BatteryPoint[] = [];
  const binDebug: any[] = [];
  for (let t = start; t <= now; t += binMs) {
    // mean HR in [t, t+bin)
    let sum = 0, n = 0;
    while (hi < hr.length && hr[hi].t < t) hi++;
    for (let j = hi; j < hr.length && hr[j].t < t + binMs; j++) { sum += hr[j].v; n++; }
    const asleep = isAsleep(t + binMs / 2);
    if (n === 0 && !asleep) continue; // no data, awake → skip (gap)
    const avgHR = n > 0 ? sum / n : restHR;
    const vHrv = nearestHrv(t);
    let stress = asleep ? Math.min(stressAt(avgHR, vHrv), 14) : stressAt(avgHR, vHrv);
    // Bevel only charges inside the sleep band — the Energy Bank then declines all day.
    // Charging while merely calm-and-awake (our battery kept climbing for ~an hour AFTER
    // waking) over-filled it ~15 pts above Bevel, so charge ONLY while actually asleep;
    // awake always drains — gently when calm, fast when stressed.
    const rate = asleep
      ? SLEEP_CHARGE
      : -(BASE_DRAIN + (stress / 100) * STRESS_DRAIN);
    battery = clamp(battery + rate * BIN_MIN, 0, 100);
    series.push({ t, battery: Math.round(battery), stress: Math.round(stress), asleep });
    binDebug.push({ m: relMin(t), hr: Math.round(avgHR), a: asleep ? 1 : 0, hrv: vHrv ? Math.round(vHrv) : 0, s: Math.round(stress), b: Math.round(battery) });
  }
  if (!series.length) return null;

  // Keep last 24h for display.
  const cut = now - 24 * 3_600_000;
  const shown = series.filter(p => p.t >= cut);
  const last = series[series.length - 1];
  const hourAgo = series.find(p => p.t >= now - 3_600_000) ?? last;
  const bats = shown.map(p => p.battery);

  // Cumulative charge/drain over the shown window (Bevel's "Total Charged/Drained").
  let totalCharged = 0, totalDrained = 0;
  for (let i = 1; i < shown.length; i++) {
    const d = shown[i].battery - shown[i - 1].battery;
    if (d > 0) totalCharged += d; else totalDrained += d;
  }

  return {
    current: last.battery,
    currentStress: last.stress,
    trendPerHour: Math.round(last.battery - hourAgo.battery),
    dayLow: bats.length ? Math.min(...bats) : last.battery,
    dayHigh: bats.length ? Math.max(...bats) : last.battery,
    totalCharged: Math.round(totalCharged),
    totalDrained: Math.round(totalDrained),
    series: shown,
    hrvBaseline: Math.round(hrvBaseline),
    restHR,
    hrvUsed, hrvRejected,
    computedAt: now,
    debug: {
      meta: { restHR, maxHR, hrvBaseline: Math.round(hrvBaseline), now, fromMin: relMin(from.getTime()),
        constants: { BIN_MIN, REST_STRESS, SLEEP_CHARGE, BASE_DRAIN, STRESS_DRAIN, SEED, WINDOW_H } },
      hrv: hrvDebug,   // every HRV sample: m=min-from-start, v=ms, hr/cv context, ok, why
      bins: binDebug,  // per 10-min bin: m, hr, a=asleep, hrv=nearest-trusted, s=stress, b=battery
    },
  };
}
