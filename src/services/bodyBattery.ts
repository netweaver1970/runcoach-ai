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

const BIN_MIN = 5;            // 5-min bins → finer curve (drain rates are per-minute, so the
                             // battery is unchanged; STRESS_SMOOTH is set to hold the decay time)
const WINDOW_H = 60;          // compute window (2+ nights so the seed washes out)
const BASELINE_DAYS = 14;     // HRV baseline window

// Battery dynamics (per-minute), Bevel "Energy Bank" style: the battery charges ONLY while
// asleep — but, like Bevel, the overnight charge is CAPPED BY RECOVERY: a poor-HRV night
// barely charges, a good night charges fully. Awake it drains, slowly when calm, fast when
// stressed. Calibrated against Bevel via scripts/bbtune.mjs on the 23-Jun device dump:
// our NOW 20% vs Bevel 17%, overnight charge to 40% vs Bevel "last charged 38%".
const REST_STRESS   = 33;     // kept for the debug dump; Bevel sleep-stress ~25
const BASE_DRAIN    = 0.02;   // per-minute awake baseline drain (even when calm)
const STRESS_DRAIN  = 0.075;  // additional per-minute drain at full stress. Bevel DOES drain deep
                              // (Geert's end-of-day ≈ 9%), so keep the deep drain — the old bug was
                              // the weak CHARGE, not the drain (see CHARGE_MAX + ceiling below).
// Recovery-scaled overnight charge: while asleep the battery approaches a CEILING set by how
// good HRV is vs the 14-day baseline (a slow EWMA so the WHOLE night's recovery sets it, not a
// momentary HRV blip). CHARGE_K is the per-minute approach rate toward that ceiling.
const CHARGE_K      = 0.045;  // per-minute approach toward the recovery ceiling while asleep
const CHARGE_MAX    = 0.15;   // cap on the per-minute charge so it ramps LINEARLY (Bevel-like) when far
                              // below the ceiling. Raised 0.12→0.15: Bevel recharges HARD overnight
                              // (Geert: 9%→67% in one night, +58); 0.12 could only claw back ~50.
const CEIL_LO       = 22;     // charge ceiling at the low HRV-ratio anchor (poor recovery)
const CEIL_HI       = 98;     // charge ceiling at the high HRV-ratio anchor (great recovery)
const CEIL_RLO      = 0.58;   // hrvRatio mapped to CEIL_LO (was 0.62/1.35 — ceiling sat at ~55 even at
const CEIL_RHI      = 1.15;   // baseline HRV, capping the charge; now near-baseline → ~70)
const CEIL_HRV_SMOOTH = 0.012;// EWMA weight on hrvRatio → whole-night recovery (slow on purpose)
// Z-SCORE STRESS INDEX (research-aligned, replaces the old HR-reserve + HRV-suppression + gate +
// floor): stress = STRESS_BASE + (zHR − zHRV)·STRESS_SCALE, where z is THIS reading's deviation from
// YOUR baseline — computed SEPARATELY for day vs night (circadian). Higher HR and/or lower HRV than
// your typical → more stress. Self-normalizing, no per-person tuning. The night uses the night
// baseline (so a low-HRV night reads as poor recovery) plus a sleep-stage bump.
const STRESS_BASE   = 26;     // stress at "typical" (z = 0)
const STRESS_SCALE  = 13;     // stress points per unit of (zHR − zHRV)
const BASE_SD_MIN   = 3;      // floor on a baseline's SD so a tight baseline can't explode z-scores
const STRESS_SMOOTH = 0.11;   // awake-day EWMA decay weight (smooth on the way down; rise is instant)
const SESSION_GAP_MS = 60 * 60_000; // merge sleep segments < 1h apart into one night session
// Night stress = a RECOVERY baseline (HRV vs personal baseline) + a stage modulation ADDED on top.
// Research-aligned: night HRV is a recovery-quality signal, shaped by sleep stage. The square wave
// is only crisp on a well-rested (low-baseline) night; on a poor night the bumps drown in the high
// baseline. Stage bump: 0 inBed,1 asleepUnspecified,2 awake-in-bed,3 core,4 deep,5 REM.
const STAGE_BUMP: Record<number, number> = { 0: 6, 1: 3, 2: 8, 3: 2, 4: 0, 5: 14 };
const NIGHT_STAGE_SMOOTH = 0.35; // stress EWMA at night — fast enough that REM bumps form (not smeared)
const SEED          = 42;     // starting level at the window edge
// HRV trust thresholds. The watch R-R "gap" flag over-rejects an AFib-app user's stable
// stress reads, so it is NOT a hard reject — a stable, near-resting HR is the arbiter.
const HRV_VMAX      = 110;    // SDNN above this = artifact (Bevel-style artifact removal)
const HRV_HR_OVER   = 20;     // reject if HR is more than this above resting (= movement)
const HRV_CV_MAX    = 0.18;   // reject if HR is erratic around the read (= movement)
const HRV_WIN_MIN   = 65;     // carry a trusted read this many minutes to fill gaps

const safe = async <T>(fn: () => Promise<T>, fb: T): Promise<T> => { try { return await fn(); } catch { return fb; } };
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface BatteryPoint { t: number; battery: number; stress: number; asleep: boolean; workout: boolean; }
const WORKOUT_SETTLE_MS = 15 * 60_000; // exclude exercise + this settle window from the stress curve
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
  correlation: any;       // last-night stage timeline + per-bin series (Copy correlation data)
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
  const validHrv: { t: number; v: number; hr: number }[] = [];  // trusted reads carry their resting HR
  const hrvDebug: any[] = [];
  for (const s of (hrvRaw as any[])) {
    const t = new Date(s.startDate).getTime(), v = s.quantity as number;
    const ctx = hrStatsNear(t);
    const res = trustHRV(t, v, true);
    if (res.ok) { validHrv.push({ t, v, hr: ctx ? ctx.mean : restHR }); hrvUsed++; } else hrvRejected++;
    hrvDebug.push({ m: relMin(t), v: Math.round(v), hr: ctx ? Math.round(ctx.mean) : 0, cv: ctx ? Math.round(ctx.cv * 100) : -1, rr: isGoodHRVSample(t, qmap) ? 1 : 0, ok: res.ok ? 1 : 0, w: res.why });
  }
  validHrv.sort((a, b) => a.t - b.t);
  const nearestHrv = (t: number, win = HRV_WIN_MIN * 60_000): number | null => {
    let best: number | null = null, bestDt = win;
    for (const s of validHrv) { const dt = Math.abs(s.t - t); if (dt <= bestDt) { bestDt = dt; best = s.v; } }
    return best;
  };

  // ── Sleep windows + sessions ──────────────────────────────────────────────────
  const sleepWins = (sleepRaw as any[])
    .filter(s => ASLEEP.has(s.value))
    .map(s => ({ s: new Date(s.startDate).getTime(), e: new Date(s.endDate).getTime() }));
  const isAsleep = (t: number) => sleepWins.some(w => t >= w.s && t <= w.e);

  // Merge asleep windows separated by < SESSION_GAP into overnight "sessions". A brief
  // awakening INSIDE a session is a micro-wake (still night), not awake-daytime — so we
  // interpret HRV there as sleep, not stress (HK sleep state gating, per the user). The HR
  // gate is the general daytime safeguard; this is the night-specific one.
  const sessions = (() => {
    const sorted = [...sleepWins].sort((a, b) => a.s - b.s);
    const out: { s: number; e: number }[] = [];
    for (const w of sorted) {
      const last = out[out.length - 1];
      if (last && w.s - last.e <= SESSION_GAP_MS) last.e = Math.max(last.e, w.e);
      else out.push({ s: w.s, e: w.e });
    }
    return out;
  })();
  const inSleepSession = (t: number) => sessions.some(w => t >= w.s && t <= w.e);

  // HK sleep STAGE at t (0 inBed, 1 asleep, 2 awake, 3 core, 4 deep, 5 REM; -1 none) — emitted
  // in the debug dump so a future capture can calibrate stage-specific stress ceilings.
  const stageWins = (sleepRaw as any[]).map(s => ({ s: new Date(s.startDate).getTime(), e: new Date(s.endDate).getTime(), v: s.value }));
  const stageAt = (t: number) => { for (const w of stageWins) if (t >= w.s && t <= w.e) return w.v; return -1; };

  // ── Day/night stress baselines (z-score) ──────────────────────────────────────
  // Build mean+SD of HRV and resting HR for DAY vs NIGHT from the trusted reads, so stress is each
  // reading's deviation from the athlete's OWN circadian-appropriate baseline (research-aligned).
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const stdev = (xs: number[]) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1)); };
  const nightRead = (rt: number) => isAsleep(rt) || inSleepSession(rt);
  const dayReads = validHrv.filter(r => !nightRead(r.t));
  const nightReads = validHrv.filter(r => nightRead(r.t));
  const mkBase = (reads: typeof validHrv, fb: { hvM: number; hvS: number; hrM: number; hrS: number }) =>
    reads.length >= 6
      ? { hvM: mean(reads.map(r => r.v)), hvS: Math.max(BASE_SD_MIN, stdev(reads.map(r => r.v))),
          hrM: mean(reads.map(r => r.hr)), hrS: Math.max(BASE_SD_MIN, stdev(reads.map(r => r.hr))) }
      : fb;
  const fbBase = { hvM: hrvBaseline, hvS: 15, hrM: restHR, hrS: 6 };
  const dayBase = mkBase(dayReads, fbBase);
  const nightBase = mkBase(nightReads, dayBase); // too few night reads → fall back to the day baseline

  // ── Workout windows (+ settle) ───────────────────────────────────────────────
  // During a workout and for ~15 min after, HR is exercise-driven (and still settling),
  // not psychological/physiological stress — exclude that span from the stress curve so a
  // run doesn't read as a stress spike. Built from the snapshot's workouts (runs included).
  const workoutWins = (((snap as any)?.activities ?? []) as any[])
    .map(a => { const s = new Date(a.date).getTime(); return { s, e: s + (a.durationMin ?? 0) * 60_000 + WORKOUT_SETTLE_MS }; })
    .filter(w => Number.isFinite(w.s) && w.e > fromMs);
  const inWorkout = (t: number) => workoutWins.some(w => t >= w.s && t <= w.e);

  // ── Bin + integrate ──────────────────────────────────────────────────────────
  const binMs = BIN_MIN * 60_000;
  const start = Math.floor(from.getTime() / binMs) * binMs;
  let hi = 0;
  // Stress = personal z-score index: STRESS_BASE + (zHR − zHRV)·STRESS_SCALE, against the day or
  // night baseline. Missing HRV → zHRV 0 (HR-only). Capped 0..100.
  const zStress = (avgHR: number, vHrv: number | null, b: { hvM: number; hvS: number; hrM: number; hrS: number }): number => {
    const zHR  = (avgHR - b.hrM) / b.hrS;
    const zHRV = vHrv != null ? (vHrv - b.hvM) / b.hvS : 0;
    return clamp(STRESS_BASE + (zHR - zHRV) * STRESS_SCALE, 0, 100);
  };

  let battery = SEED; // washed out by the two nights inside the 60h window
  let smStress: number | null = null; // EWMA-smoothed stress (momentum)
  let smHrvRatio: number | null = null; // slow EWMA of HRV/baseline → whole-night recovery (charge)
  let lastHrvForCeil = hrvBaseline;     // carry the last trusted HRV across gaps
  const series: BatteryPoint[] = [];
  const binDebug: any[] = [];
  const corrBins: { t: number; s: number; hr: number; hrv: number; stg: number; a: number; b: number }[] = [];
  for (let t = start; t <= now; t += binMs) {
    // mean HR in [t, t+bin)
    let sum = 0, n = 0;
    while (hi < hr.length && hr[hi].t < t) hi++;
    for (let j = hi; j < hr.length && hr[j].t < t + binMs; j++) { sum += hr[j].v; n++; }
    const mid = t + binMs / 2;
    const asleep = isAsleep(mid);
    const night = asleep || inSleepSession(mid); // asleep OR a micro-wake inside the night
    const stage = stageAt(mid);                  // HK stage 0..5 (-1 none)
    const workout = inWorkout(mid);
    if (n === 0 && !asleep) continue; // no data, awake → skip (gap)
    const avgHR = n > 0 ? sum / n : restHR;
    const vHrv = nearestHrv(t);
    // HRV vs personal baseline → the overnight CHARGE ceiling (very slow EWMA = whole-night recovery).
    if (vHrv != null) lastHrvForCeil = vHrv;
    const hrvRatio = lastHrvForCeil / Math.max(1, hrvBaseline);
    smHrvRatio = smHrvRatio == null ? hrvRatio : CEIL_HRV_SMOOTH * hrvRatio + (1 - CEIL_HRV_SMOOTH) * smHrvRatio;
    const chargeCeiling = clamp(CEIL_LO + (CEIL_HI - CEIL_LO) * ((smHrvRatio - CEIL_RLO) / (CEIL_RHI - CEIL_RLO)), 20, 100);
    // Stress = z-score index vs the day/night baseline (zHR − zHRV). At night add the sleep-stage
    // bump on top (REM bumps; deep sits at the recovery baseline). A low-HRV night → high baseline,
    // so the REM bumps drown; a rested night → low baseline, crisp square wave.
    const base = night ? nightBase : dayBase;
    const rawStress = night
      ? clamp(zStress(avgHR, vHrv, base) + (stage >= 0 ? STAGE_BUMP[stage] : 0), 0, 100)
      : zStress(avgHR, vHrv, base);
    // EWMA momentum: fast attack only AWAKE-DAY (a real stressor). At night use a faster weight so
    // REM/stage transitions actually show (a slow weight smears the square wave flat). Workout +
    // settle FREEZES the EWMA (bin → gap).
    if (!workout) {
      if (smStress == null) {
        smStress = rawStress;
      } else {
        const alpha: number = night ? NIGHT_STAGE_SMOOTH : (rawStress > smStress ? 1 : STRESS_SMOOTH);
        smStress = alpha * rawStress + (1 - alpha) * smStress;
      }
    } else if (smStress == null) {
      smStress = STRESS_BASE;
    }
    const stress = smStress;
    // Asleep → charge toward the recovery ceiling (never drain in sleep); awake → drain, gently
    // when calm, fast when stressed. The battery still drains for the REAL effort of a workout.
    const drainStress = workout ? Math.max(rawStress, stress) : stress;
    const rate = asleep
      ? Math.max(0, Math.min(CHARGE_MAX, CHARGE_K * (chargeCeiling - battery)))
      : -(BASE_DRAIN + (drainStress / 100) * STRESS_DRAIN);
    battery = clamp(battery + rate * BIN_MIN, 0, 100);
    series.push({ t, battery: Math.round(battery), stress: Math.round(stress), asleep, workout });
    binDebug.push({ m: relMin(t), hr: Math.round(avgHR), a: asleep ? 1 : 0, ses: night ? 1 : 0, stg: stage, wo: workout ? 1 : 0, hrv: vHrv ? Math.round(vHrv) : 0, s: Math.round(stress), b: Math.round(battery) });
    corrBins.push({ t, s: Math.round(stress), hr: Math.round(avgHR), hrv: vHrv ? Math.round(vHrv) : 0, stg: stage, a: night ? 1 : 0, b: Math.round(battery) });
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

  // ── Correlation dump: the most recent night + the morning after, for fitting the recovery model
  // ΔE_bucket = w(stage)·(a − b·stress) (sleep charges, wake drains, no ceiling). Pair each bin's
  // stress + HK stage with Bevel's energy reading at that clock time.
  const STG_LABEL: Record<number, string> = { 0: 'inBed', 1: 'asleep', 2: 'awake', 3: 'core', 4: 'deep', 5: 'REM' };
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const hhmm = (t: number) => { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
  let nEnd = -1;
  for (let i = corrBins.length - 1; i >= 0; i--) { if (corrBins[i].a) { nEnd = i; break; } }
  let nStart = nEnd;
  while (nStart > 0 && corrBins[nStart - 1].a) nStart--;
  let correlation: any = null;
  if (nEnd >= 0) {
    const stages: { stage: string; from: string; to: string; min: number }[] = [];
    let lastStg = NaN;
    for (let i = nStart; i <= nEnd; i++) {
      const b = corrBins[i];
      if (b.stg === lastStg && stages.length) {
        const cur = stages[stages.length - 1];
        cur.to = hhmm(b.t + binMs); cur.min += BIN_MIN;
      } else {
        stages.push({ stage: STG_LABEL[b.stg] ?? '—', from: hhmm(b.t), to: hhmm(b.t + binMs), min: BIN_MIN });
        lastStg = b.stg;
      }
    }
    const from = Math.max(0, nStart - 3);               // a little pre-sleep context (charge onset)
    const bins = corrBins.slice(from).map((b) => ({
      t: hhmm(b.t), stress: b.s, hr: b.hr, hrv: b.hrv || undefined,
      stage: STG_LABEL[b.stg] ?? '—', asleep: b.a, ourBattery: b.b,
    }));
    correlation = {
      note: 'Per-bin OURS/HK over the last night + the morning after. To fit the recovery model, pair each bin (or 6-min bucket) stress + stage with Bevel\'s ENERGY reading at that clock time, then regress ΔE = w(stage)·(a − b·stress). Sleep charges, wake drains, no ceiling.',
      binMin: BIN_MIN, restHR, hrvBaseline: Math.round(hrvBaseline),
      night: `${hhmm(corrBins[nStart].t)}→${hhmm(corrBins[nEnd].t + binMs)}`,
      stages,   // HK sleep-stage timeline (distinct blocks)
      bins,     // {t, stress, hr, hrv, stage, asleep, ourBattery}
    };
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
        constants: { BIN_MIN, REST_STRESS, BASE_DRAIN, STRESS_DRAIN, CHARGE_K, CHARGE_MAX, CEIL_LO, CEIL_HI, CEIL_RLO, CEIL_RHI, CEIL_HRV_SMOOTH, STRESS_SMOOTH, STRESS_BASE, STRESS_SCALE, BASE_SD_MIN, NIGHT_STAGE_SMOOTH, SEED, WINDOW_H },
        baselines: { dayBase, nightBase } },
      hrv: hrvDebug,   // every HRV sample: m=min-from-start, v=ms, hr/cv context, ok, why
      bins: binDebug,  // per 10-min bin: m, hr, a=asleep, hrv=nearest-trusted, s=stress, b=battery
    },
    correlation,       // last-night stage timeline + per-bin series for the recovery-model fit
  };
}
