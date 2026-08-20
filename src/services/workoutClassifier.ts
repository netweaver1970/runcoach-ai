import * as FileSystem from 'expo-file-system';
import {
  WorkoutLabel,
  WorkoutConfidence,
  WorkoutAnalysis,
  WorkoutCache,
  WorkoutTypeStats,
  ZoneDistribution,
  RunWorkout,
  IntervalRep,
} from '../types';

const CACHE_FILE = `${FileSystem.documentDirectory}runcoach-workout-cache.json`;

// Bump this whenever classifier logic changes (work-HR/pace/power calculation).
// Old caches with a lower version are discarded so all runs get re-analysed.
const CACHE_VERSION = 2;

// ─── Zone boundaries (% of maxHR) ─────────────────────────────────────────────
const Z1 = 0.60;
const Z2 = 0.70;
const Z3 = 0.80;
const Z4 = 0.90;

// ─── Per-run sample data passed in from healthkit ─────────────────────────────

export interface PerRunData {
  hrValues: number[];
  hrTimestampsMs: number[];             // epoch ms, parallel to hrValues
  distSegs: { t: number; m: number }[]; // {startMs, meters for this segment}
  powerSegs: { t: number; w: number }[]; // {startMs, watts}; empty if device lacks power sensor
}

// ─── Cache I/O ────────────────────────────────────────────────────────────────

export async function loadWorkoutCache(): Promise<WorkoutCache | null> {
  try {
    const info = await FileSystem.getInfoAsync(CACHE_FILE);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(CACHE_FILE);
    const cache = JSON.parse(raw) as WorkoutCache;
    // Discard cache if it was built with an older classifier version
    if ((cache.version ?? 1) < CACHE_VERSION) return null;
    return cache;
  } catch {
    return null;
  }
}

export async function saveWorkoutCache(cache: WorkoutCache): Promise<void> {
  await FileSystem.writeAsStringAsync(CACHE_FILE, JSON.stringify(cache));
}

export async function clearWorkoutCache(): Promise<void> {
  try { await FileSystem.deleteAsync(CACHE_FILE, { idempotent: true }); } catch {}
}

// ─── Max HR estimation ─────────────────────────────────────────────────────────

export function estimateMaxHR(allHRValues: number[], cachedMaxHR?: number): number {
  if (allHRValues.length < 20) return cachedMaxHR ?? 185;
  const sorted = [...allHRValues].sort((a, b) => a - b);
  const p98 = sorted[Math.floor(sorted.length * 0.98)];
  const estimated = Math.round(p98 + 5);
  return cachedMaxHR ? Math.max(estimated, cachedMaxHR) : estimated;
}

// ─── Interval surge detection ─────────────────────────────────────────────────

interface SurgeWindow { startIdx: number; endIdx: number; }

/**
 * Detect alternating high/low HR cycles that indicate interval work.
 * Surge  = ≥3 consecutive readings ≥ Z3 (80% maxHR).
 * Recovery = ≥3 consecutive readings < Z2 (70% maxHR).
 * Returns the list of surge windows by sample index.
 */
function detectIntervalSurges(samples: number[], maxHR: number): SurgeWindow[] {
  const high = maxHR * Z3;
  const low  = maxHR * Z2;
  const surges: SurgeWindow[] = [];
  let inSurge = false;
  let surgeStart = 0;
  let consHigh = 0;
  let consLow  = 0;

  for (let i = 0; i < samples.length; i++) {
    const h = samples[i];
    if (h >= high) {
      consHigh++;
      consLow = 0;
      if (consHigh >= 3 && !inSurge) {
        inSurge = true;
        surgeStart = i - 2;
      }
    } else if (h < low) {
      consLow++;
      consHigh = 0;
      if (consLow >= 3 && inSurge) {
        surges.push({ startIdx: surgeStart, endIdx: i - consLow });
        inSurge = false;
        consLow = 0;
      }
    } else {
      consHigh = 0;
      consLow  = 0;
    }
  }
  if (inSurge) surges.push({ startIdx: surgeStart, endIdx: samples.length - 1 });
  return surges;
}

// ─── Work-only HR ─────────────────────────────────────────────────────────────

/**
 * Return the average HR from actual effort segments only.
 *
 * - Intervals : only samples inside detected surge windows.
 * - Tempo     : skip first 10% of samples (warm-up), keep ≥ Z2 threshold.
 * - Z2 / Long / Recovery : steady-state — whole workout is the work.
 */
function computeWorkHR(
  hrSamples: number[],
  label: WorkoutLabel | undefined,
  maxHR: number,
  surges: SurgeWindow[],
): number {
  if (hrSamples.length === 0) return 0;

  let workSamples: number[];

  switch (label) {
    case 'Intervals':
      workSamples = surges.length > 0
        ? surges.flatMap(s => hrSamples.slice(s.startIdx, s.endIdx + 1))
        : hrSamples.filter(h => h >= maxHR * Z3);
      break;
    case 'Threshold':
    case 'Tempo':
      workSamples = hrSamples
        .slice(Math.floor(hrSamples.length * 0.10))  // drop warm-up
        .filter(h => h >= maxHR * Z2);
      break;
    default:
      workSamples = hrSamples;
  }

  if (workSamples.length === 0) workSamples = hrSamples; // fallback
  return Math.round(workSamples.reduce((a, b) => a + b, 0) / workSamples.length);
}

// ─── Per-interval rep data ────────────────────────────────────────────────────

function buildIntervalReps(
  hrSamples: number[],
  hrTimestampsMs: number[],
  distSegs: { t: number; m: number }[],
  powerSegs: { t: number; w: number }[],
  surges: SurgeWindow[],
  totalDurationSecs: number,
): IntervalRep[] {
  if (surges.length === 0) return [];

  const hasTs = hrTimestampsMs.length === hrSamples.length && hrSamples.length > 1;
  const msPerSample = hasTs
    ? (hrTimestampsMs[hrTimestampsMs.length - 1] - hrTimestampsMs[0]) / (hrTimestampsMs.length - 1)
    : (totalDurationSecs * 1000) / Math.max(hrSamples.length - 1, 1);

  const reps: IntervalRep[] = [];

  for (let idx = 0; idx < surges.length; idx++) {
    const surge = surges[idx];
    const repSamples = hrSamples.slice(surge.startIdx, surge.endIdx + 1);
    if (repSamples.length < 2) continue;

    const avgHR  = Math.round(repSamples.reduce((a, b) => a + b, 0) / repSamples.length);
    const peakHR = Math.max(...repSamples);

    let durationSecs: number;
    let startMs = 0;
    let endMs   = 0;

    if (hasTs) {
      startMs = hrTimestampsMs[surge.startIdx];
      endMs   = hrTimestampsMs[Math.min(surge.endIdx, hrTimestampsMs.length - 1)];
      durationSecs = Math.max(1, Math.round((endMs - startMs) / 1000));
    } else {
      durationSecs = Math.round(repSamples.length * msPerSample / 1000);
    }

    let avgPaceSecs = 0;
    if (distSegs.length > 0 && hasTs && startMs > 0) {
      const totalMeters = distSegs
        .filter(d => d.t >= startMs && d.t <= endMs)
        .reduce((a, d) => a + d.m, 0);
      if (totalMeters > 10 && durationSecs > 0) {
        avgPaceSecs = Math.round(durationSecs / (totalMeters / 1000));
      }
    }

    let avgPowerW = 0;
    if (powerSegs.length > 0 && hasTs && startMs > 0) {
      const repPowers = powerSegs
        .filter(p => p.t >= startMs && p.t <= endMs)
        .map(p => p.w);
      if (repPowers.length > 0) {
        avgPowerW = Math.round(repPowers.reduce((a, b) => a + b, 0) / repPowers.length);
      }
    }

    reps.push({ rep: idx + 1, durationSecs, avgHR, peakHR, avgPaceSecs, avgPowerW });
  }

  return reps;
}

// ─── HR data validation & cleaning ───────────────────────────────────────────

/**
 * Chest straps (and optical sensors) occasionally produce impossible readings:
 * dropout spikes at 0-30 bpm, contact-loss spikes above physiological max,
 * or instantaneous jumps that no human heart can produce.
 *
 * Strategy:
 *   1. Mark a sample invalid if it is outside [30, maxHR*1.15] bpm
 *      OR if it jumps >50 bpm from the previous valid sample within <15 seconds.
 *   2. Replace each invalid run with linear interpolation from the nearest
 *      valid neighbours.  Edge segments use the nearest valid value (clamp).
 *
 * The returned array is the same length as `samples`.
 */
export function cleanHRSamples(
  samples: number[],
  timestampsMs: number[],
  maxHR: number,
): number[] {
  if (samples.length < 3) return samples;

  const hasTs = timestampsMs.length === samples.length && samples.length > 1;
  const minBpm = 30;
  const maxBpm = Math.min(220, Math.round(maxHR * 1.15));
  const maxJump = 50;   // bpm
  const maxJumpSec = 15; // seconds

  // ── Pass 1: range check ───────────────────────────────────────────────────
  const valid: boolean[] = samples.map(h => h >= minBpm && h <= maxBpm);

  // ── Pass 2: rate-of-change check ─────────────────────────────────────────
  let lastValidIdx = -1;
  for (let i = 0; i < samples.length; i++) {
    if (!valid[i]) { lastValidIdx = -1; continue; }
    if (lastValidIdx >= 0) {
      const dt = hasTs
        ? (timestampsMs[i] - timestampsMs[lastValidIdx]) / 1000
        : (i - lastValidIdx) * 5; // assume ~5 s between samples if no timestamps
      const dHR = Math.abs(samples[i] - samples[lastValidIdx]);
      if (dt > 0 && dt <= maxJumpSec && dHR > maxJump) {
        valid[i] = false;
        continue;
      }
    }
    lastValidIdx = i;
  }

  // Count invalids — if < 5% of data, skip (avoids altering clean data)
  const invalidCount = valid.filter(v => !v).length;
  if (invalidCount === 0) return samples;
  if (invalidCount === samples.length) return samples; // all bad — can't fix

  // ── Pass 3: interpolate invalid spans ────────────────────────────────────
  const cleaned = [...samples];

  for (let i = 0; i < cleaned.length; ) {
    if (valid[i]) { i++; continue; }

    // Find end of invalid span
    let spanEnd = i;
    while (spanEnd < cleaned.length && !valid[spanEnd]) spanEnd++;

    // Find valid neighbours
    const lo = i - 1;           // last valid before span (or -1)
    const hi = spanEnd;          // first valid after span (or samples.length)

    for (let j = i; j < spanEnd; j++) {
      if (lo >= 0 && hi < cleaned.length) {
        // Linear interpolation
        const t = (j - lo) / (hi - lo);
        cleaned[j] = Math.round(cleaned[lo] * (1 - t) + cleaned[hi] * t);
      } else if (lo >= 0) {
        cleaned[j] = cleaned[lo];
      } else if (hi < cleaned.length) {
        cleaned[j] = cleaned[hi];
      }
    }
    i = spanEnd;
  }

  return cleaned;
}

// ─── Core classifier ─────────────────────────────────────────────────────────

interface ClassifierInput {
  hrSamples: number[];
  hrTimestampsMs: number[];
  distSegs: { t: number; m: number }[];
  powerSegs: { t: number; w: number }[];
  avgHR: number;
  duration: number;   // seconds
  distance: number;   // metres
  maxHR: number;
  longRunMinutes: number; // threshold for LongRun (default 75)
}

interface ClassificationResult {
  label: WorkoutLabel;
  confidence: WorkoutConfidence;
  zones: ZoneDistribution;
  hrCV: number;
  maxHRObserved: number;
  workHR: number;
  workPace: number;   // secs/km, work segments only
  workPower: number;  // watts, work segments only; 0 if unavailable
  intervals: IntervalRep[];
}

// ─── Work-only pace ───────────────────────────────────────────────────────────

function computeWorkPace(
  label: WorkoutLabel,
  hrTimestampsMs: number[],
  distSegs: { t: number; m: number }[],
  intervals: IntervalRep[],
  overallPace: number,
): number {
  switch (label) {
    case 'Intervals': {
      // Duration-weighted avg of reps that have pace data
      const withPace = intervals.filter(r => r.avgPaceSecs > 0);
      if (withPace.length === 0) return overallPace;
      const totalDur = withPace.reduce((a, r) => a + r.durationSecs, 0);
      return totalDur > 0
        ? Math.round(withPace.reduce((a, r) => a + r.avgPaceSecs * r.durationSecs, 0) / totalDur)
        : overallPace;
    }
    case 'Threshold':
    case 'Tempo': {
      // Skip first 10% of the run (warm-up) then compute pace from dist segments
      if (hrTimestampsMs.length < 10 || distSegs.length === 0) return overallPace;
      const skip = Math.floor(hrTimestampsMs.length * 0.10);
      const workStart = hrTimestampsMs[skip];
      const workEnd   = hrTimestampsMs[hrTimestampsMs.length - 1];
      const workDist  = distSegs
        .filter(d => d.t >= workStart && d.t <= workEnd)
        .reduce((a, d) => a + d.m, 0);
      const workSecs  = (workEnd - workStart) / 1000;
      return workDist > 200 && workSecs > 0
        ? Math.round(workSecs / (workDist / 1000))
        : overallPace;
    }
    default:
      // Z2, LongRun, Recovery: steady-state — overall pace IS the work pace
      return overallPace;
  }
}

// ─── Work-only power ──────────────────────────────────────────────────────────

function computeWorkPower(
  label: WorkoutLabel,
  hrTimestampsMs: number[],
  powerSegs: { t: number; w: number }[],
  intervals: IntervalRep[],
): number {
  if (powerSegs.length === 0) return 0;

  const avgFromSegs = (segs: { t: number; w: number }[]) =>
    segs.length > 0 ? Math.round(segs.reduce((a, s) => a + s.w, 0) / segs.length) : 0;

  switch (label) {
    case 'Intervals': {
      // Duration-weighted avg of per-rep power
      const withPower = intervals.filter(r => r.avgPowerW > 0);
      if (withPower.length === 0) return avgFromSegs(powerSegs);
      const totalDur = withPower.reduce((a, r) => a + r.durationSecs, 0);
      return totalDur > 0
        ? Math.round(withPower.reduce((a, r) => a + r.avgPowerW * r.durationSecs, 0) / totalDur)
        : avgFromSegs(powerSegs);
    }
    case 'Threshold':
    case 'Tempo': {
      // Skip warm-up — match same window as computeWorkPace
      if (hrTimestampsMs.length < 10) return avgFromSegs(powerSegs);
      const skip = Math.floor(hrTimestampsMs.length * 0.10);
      const workStart = hrTimestampsMs[skip];
      const workEnd   = hrTimestampsMs[hrTimestampsMs.length - 1];
      return avgFromSegs(powerSegs.filter(p => p.t >= workStart && p.t <= workEnd));
    }
    default:
      return avgFromSegs(powerSegs);
  }
}

export function classifyRun(input: ClassifierInput): ClassificationResult {
  const { hrSamples: rawHR, hrTimestampsMs, distSegs, powerSegs,
          avgHR, duration, distance, maxHR, longRunMinutes } = input;

  const durationMin  = duration / 60;
  const avgPct       = maxHR > 0 ? avgHR / maxHR : 0;
  const overallPace  = distance > 0 ? Math.round(duration / (distance / 1000)) : 0;

  // ── Clean HR samples to remove chest-strap artifacts ─────────────────────
  const hrSamples = rawHR.length >= 3
    ? cleanHRSamples(rawHR, hrTimestampsMs, maxHR)
    : rawHR;

  if (hrSamples.length < 5) {
    const base = classifyWithoutSamples(avgPct, durationMin, distance, longRunMinutes);
    return { ...base, workHR: avgHR, workPace: overallPace, workPower: 0, intervals: [] };
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  const mean    = hrSamples.reduce((a, b) => a + b, 0) / hrSamples.length;
  const variance = hrSamples.reduce((a, b) => a + (b - mean) ** 2, 0) / hrSamples.length;
  const stddev  = Math.sqrt(variance);
  const cv      = stddev / mean;
  const maxObs  = Math.max(...hrSamples);

  // ── Zone distribution ──────────────────────────────────────────────────────
  const n = hrSamples.length;
  const zones: ZoneDistribution = {
    z1: hrSamples.filter(h => h < maxHR * Z1).length / n,
    z2: hrSamples.filter(h => h >= maxHR * Z1 && h < maxHR * Z2).length / n,
    z3: hrSamples.filter(h => h >= maxHR * Z2 && h < maxHR * Z3).length / n,
    z4: hrSamples.filter(h => h >= maxHR * Z3 && h < maxHR * Z4).length / n,
    z5: hrSamples.filter(h => h >= maxHR * Z4).length / n,
  };

  // ── Interval detection ────────────────────────────────────────────────────
  const surges = detectIntervalSurges(hrSamples, maxHR);

  // ── Classification — structural first, then effort, then duration ─────────
  //
  // Priority:
  //   1. Intervals  — structural: ≥2 detected work/rest cycles
  //   2. LongRun    — duration-based: durationMin ≥ threshold (NOT intervals)
  //   3. Tempo      — sustained sub-threshold effort (not long, not intervals)
  //   4. Recovery   — very easy effort
  //   5. Z2         — default aerobic
  //   6. Unknown    — fallback (no HR data or ambiguous)
  //
  // Deliberately NOT using tight power-zone boundaries here because the zones
  // aren't well-separated in practice.  Power-zone override is applied in
  // healthkit.ts AFTER classification.
  // ─────────────────────────────────────────────────────────────────────────

  let label: WorkoutLabel;
  let rawConfidence: number;

  if (surges.length >= 2) {
    // Clear structural evidence of alternating high/low efforts
    label = 'Intervals';
    rawConfidence = Math.min(1, 0.55 + surges.length * 0.10 + cv * 1.5);
  } else if (durationMin >= longRunMinutes) {
    // Long run purely by duration — no HR conditions (power/temp/terrain vary too much)
    label = 'LongRun';
    rawConfidence = Math.min(1, 0.60 + (durationMin - longRunMinutes) / 60 * 0.15);
  } else if (avgPct >= 0.77 && cv < 0.10 && durationMin >= 15) {
    // Sustained higher-effort run — tempo or threshold
    label = 'Tempo';
    rawConfidence = Math.min(1, 0.60 + (avgPct - 0.77) * 2.5 + (0.10 - cv) * 3);
  } else if (avgPct < 0.64) {
    // Very easy — recovery or warm-down
    label = 'Recovery';
    rawConfidence = Math.min(1, 0.60 + (0.64 - avgPct) * 4);
  } else {
    // Default: aerobic base / zone 2
    label = 'Z2';
    rawConfidence = Math.min(1, 0.55 + (0.77 - Math.min(avgPct, 0.77)) * 2 + (0.10 - Math.min(cv, 0.10)) * 3);
  }

  // ── Per-interval reps ─────────────────────────────────────────────────────
  const intervals = label === 'Intervals'
    ? buildIntervalReps(hrSamples, hrTimestampsMs, distSegs, powerSegs, surges, duration)
    : [];

  // ── Work HR ───────────────────────────────────────────────────────────────
  let workHR = computeWorkHR(hrSamples, label, maxHR, surges);
  if (label === 'Intervals' && intervals.length > 0) {
    const totalRepDur = intervals.reduce((a, r) => a + r.durationSecs, 0);
    workHR = totalRepDur > 0
      ? Math.round(intervals.reduce((a, r) => a + r.avgHR * r.durationSecs, 0) / totalRepDur)
      : Math.round(intervals.reduce((a, r) => a + r.avgHR, 0) / intervals.length);
  }

  const workPace  = computeWorkPace(label, hrTimestampsMs, distSegs, intervals, overallPace);
  const workPower = computeWorkPower(label, hrTimestampsMs, powerSegs, intervals);

  return {
    label,
    confidence: rawConfidence >= 0.70 ? 'high' : rawConfidence >= 0.45 ? 'medium' : 'low',
    zones,
    hrCV: Math.round(cv * 1000) / 1000,
    maxHRObserved: maxObs,
    workHR,
    workPace,
    workPower,
    intervals,
  };
}

function classifyWithoutSamples(
  avgPct: number,
  durationMin: number,
  distance: number,
  longRunMinutes: number,
): Omit<ClassificationResult, 'workHR' | 'intervals'> {
  const blankZones: ZoneDistribution = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
  let label: WorkoutLabel;
  if (durationMin >= longRunMinutes && distance >= 8000) label = 'LongRun';
  else if (avgPct >= 0.77) label = 'Tempo';
  else if (avgPct < 0.64) label = 'Recovery';
  else label = 'Z2';
  return { label, confidence: 'low', zones: blankZones, hrCV: 0, maxHRObserved: 0, workPace: 0, workPower: 0 };
}

// ─── Batch classify with caching ──────────────────────────────────────────────

export async function classifyAndCacheRuns(
  runs: RunWorkout[],
  perRunData: Map<string, PerRunData>,
  /** HR values from newly-fetched (uncached) workouts only — used to update maxHR */
  newHRValues: number[],
  /** Pre-fetched cache from the caller (avoids a second disk read) */
  preFetchedCache?: WorkoutCache | null,
  longRunMinutes: number = 75,
  /** The athlete's effective max HR (user-set, else robust observed). Governs zone boundaries. */
  effectiveMaxHr: number = 0,
): Promise<{ runs: RunWorkout[]; maxHR: number }> {
  const existing = preFetchedCache !== undefined ? preFetchedCache : await loadWorkoutCache();
  const cachedMaxHR = existing?.estimatedMaxHR;
  const allHRValues = newHRValues;
  // Zones MUST use the athlete's EFFECTIVE max HR (user-set 188, else robust observed) so they're
  // stable + correct. estimateMaxHR (p98+5 of the fetched HR) is only a last-resort fallback: when
  // the workout cache was cleared, cachedMaxHR vanished and it collapsed to ~160 (you rarely hit max
  // on easy runs) → Z4 started at 128 bpm → easy runs mis-zoned into red ("46% red" intensity mix).
  const maxHR = effectiveMaxHr > 0 ? effectiveMaxHr : estimateMaxHR(allHRValues, cachedMaxHR);

  const analyses: Record<string, WorkoutAnalysis> = existing?.analyses ?? {};
  let dirty = false;

  const classifiedRuns: RunWorkout[] = runs.map((run) => {
    const cached = analyses[run.uuid];
    const maxHRShift = cached ? Math.abs(maxHR - (existing?.estimatedMaxHR ?? maxHR)) : Infinity;
    const data = perRunData.get(run.uuid) ?? { hrValues: [], hrTimestampsMs: [], distSegs: [], powerSegs: [] };
    const hasHrData = data.hrValues.length > 0;

    // Reuse the cache when maxHR is stable — OR when there's no fresh HR to re-classify from (a normal
    // scan pre-populates EMPTY perRunData for cached runs, so re-classifying on a maxHR shift would
    // blank the zones). Only a rebuild (which re-fetches HR) actually re-zones on a maxHR change.
    if (cached && cached.workHR !== undefined && cached.workPace !== undefined && (maxHRShift < 3 || !hasHrData)) {
      return {
        ...run,
        label:      cached.label,
        confidence: cached.confidence,
        zones:      cached.zones,
        hrCV:       cached.hrCV,
        workHR:     cached.workHR,
        workPace:   cached.workPace,
        workPower:  cached.workPower ?? 0,
        intervals:  cached.intervals ?? [],
      };
    }

    const result = classifyRun({
      hrSamples:      data.hrValues,
      hrTimestampsMs: data.hrTimestampsMs,
      distSegs:       data.distSegs,
      powerSegs:      data.powerSegs,
      avgHR:          run.avgHeartRate ?? 0,
      duration:       run.duration,
      distance:       run.distance,
      maxHR,
      longRunMinutes,
    });

    analyses[run.uuid] = {
      uuid:          run.uuid,
      date:          run.date,
      label:         result.label,
      confidence:    result.confidence,
      zones:         result.zones,
      avgHR:         run.avgHeartRate ?? 0,
      workHR:        result.workHR,
      workPace:      result.workPace,
      workPower:     result.workPower,
      intervals:     result.intervals,
      maxHRObserved: result.maxHRObserved,
      hrCV:          result.hrCV,
      distance:      run.distance,
      duration:      run.duration,
      pace:          run.pace,
      calories:      run.calories,
      classifiedAt:  new Date().toISOString(),
    };
    dirty = true;

    return {
      ...run,
      label:      result.label,
      confidence: result.confidence,
      zones:      result.zones,
      hrCV:       result.hrCV,
      workHR:     result.workHR,
      workPace:   result.workPace,
      workPower:  result.workPower,
      intervals:  result.intervals,
    };
  });

  if (dirty || !existing || existing.estimatedMaxHR !== maxHR) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const cutoffStr = cutoff.toISOString();
    Object.keys(analyses).forEach(uuid => {
      if (analyses[uuid].date < cutoffStr) delete analyses[uuid];
    });
    await saveWorkoutCache({
      analyses,
      estimatedMaxHR: maxHR,
      lastUpdated: new Date().toISOString(),
      version: CACHE_VERSION,
    });
  }

  return { runs: classifiedRuns, maxHR };
}

// ─── Per-type statistics (uses workHR, not raw avgHR) ────────────────────────

export function computeWorkoutTypeStats(runs: RunWorkout[]): WorkoutTypeStats[] {
  const groups: Record<string, RunWorkout[]> = {};
  runs.forEach(r => {
    const key = r.label ?? 'Unknown';
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  });

  return Object.entries(groups)
    .filter(([, rs]) => rs.length > 0)
    .map(([label, rs]) => {
      const sorted = [...rs].sort((a, b) => a.date.localeCompare(b.date));
      const withHR = sorted.filter(r => (r.workHR ?? r.avgHeartRate ?? 0) > 0);

      return {
        label: label as WorkoutLabel,
        count: rs.length,
        avgHR: withHR.length > 0
          ? Math.round(withHR.reduce((a, r) => a + (r.workHR ?? r.avgHeartRate ?? 0), 0) / withHR.length)
          : 0,
        avgPace:     Math.round(sorted.reduce((a, r) => a + r.pace, 0) / sorted.length),
        avgDistance: Math.round(sorted.reduce((a, r) => a + r.distance, 0) / sorted.length),
        avgDuration: Math.round(sorted.reduce((a, r) => a + r.duration, 0) / sorted.length),
        hrTrend:   withHR.map(r => r.workHR ?? r.avgHeartRate ?? 0),
        paceTrend: sorted.map(r => r.pace),
        lastDate:  sorted[sorted.length - 1].date,
      };
    })
    .sort((a, b) => {
      const order: WorkoutLabel[] = ['Intervals', 'Threshold', 'Tempo', 'LongRun', 'Z2', 'Recovery', 'Unknown'];
      return order.indexOf(a.label) - order.indexOf(b.label);
    });
}
