/**
 * Beat-level HRV signal quality — pure, dependency-free (so it is unit-testable off-device).
 */
/**
 * BEAT-LEVEL HRV QUALITY (2026-07-29). A 1-min HRV value is only trustworthy if the watch actually
 * captured (nearly) every beat in that window: RMSSD is built from SUCCESSIVE R-R differences, so a single
 * MISSED beat merges two intervals into one ~2x-length interval and injects a huge false difference —
 * inflating RMSSD wildly. That is what made this athlete's daytime HRV bounce 18→73 ms within minutes
 * (physiologically impossible), which in turn spiked the stress index while HR plainly showed rest.
 *
 * Apple's `precededByGap` alone is too blunt to gate on: it flags ANY discontinuity, so it condemned 52%
 * of this user's samples (89/172) including clean ones — which is exactly why it was switched off and
 * left as debug-only. So assess the R-R series properly and gradedly instead:
 *   • beats      — too few usable beats ⇒ RMSSD is noise whatever the flags say
 *   • coverage   — captured beats vs the count implied by the window span and the median R-R.
 *                  Dropped beats show up here even when nothing was flagged.
 *   • artifactPct— successive-interval change > ARTIFACT_STEP (Malik's 20% rule): ectopic/missed beats.
 * Returned per series so a caller can reject only genuinely corrupt windows and keep the merely-imperfect.
 */
export interface BeatQuality {
  beats: number; spanSec: number; medianRR: number; coverage: number; artifactPct: number; ok: boolean;
}
const BQ_MIN_BEATS    = 20;   // < this in a ~1-min window ⇒ far too sparse to trust
const BQ_MIN_COVERAGE = 0.80; // captured/expected beats
const BQ_MAX_ARTIFACT = 0.15; // fraction of successive intervals failing the 20% step test
const ARTIFACT_STEP   = 0.20;

export function assessBeatQuality(
  s: { heartbeats: readonly { timeSinceSeriesStart: number; precededByGap: boolean }[] },
): BeatQuality {
  const beats = s.heartbeats ?? [];
  const rrs: number[] = [];
  for (let i = 1; i < beats.length; i++) {
    if (beats[i].precededByGap) continue;                       // chain broken here — not a real interval
    const rr = (beats[i].timeSinceSeriesStart - beats[i - 1].timeSinceSeriesStart) * 1000;
    if (rr >= 300 && rr <= 2000) rrs.push(rr);                  // physiologically possible only
  }
  const spanSec = beats.length > 1
    ? beats[beats.length - 1].timeSinceSeriesStart - beats[0].timeSinceSeriesStart : 0;
  if (rrs.length < 2 || spanSec <= 0) {
    return { beats: rrs.length + 1, spanSec, medianRR: 0, coverage: 0, artifactPct: 1, ok: false };
  }
  const sorted = [...rrs].sort((a, b) => a - b);
  const medianRR = sorted[Math.floor(sorted.length / 2)];
  // Expected beats over the span at the window's own median rate — no external HR needed.
  const expected = medianRR > 0 ? (spanSec * 1000) / medianRR : 0;
  const coverage = expected > 0 ? Math.min(1, (rrs.length + 1) / expected) : 0;
  let artifacts = 0;
  for (let i = 1; i < rrs.length; i++) {
    if (Math.abs(rrs[i] - rrs[i - 1]) / rrs[i - 1] > ARTIFACT_STEP) artifacts++;
  }
  const artifactPct = rrs.length > 1 ? artifacts / (rrs.length - 1) : 1;
  const ok = (rrs.length + 1) >= BQ_MIN_BEATS && coverage >= BQ_MIN_COVERAGE && artifactPct <= BQ_MAX_ARTIFACT;
  return { beats: rrs.length + 1, spanSec: Math.round(spanSec), medianRR: Math.round(medianRR), coverage, artifactPct, ok };
}

/** series-start ms → BeatQuality, for the same nearest-match lookup the gap map uses. */
export function buildBeatQualityMap(
  heartbeatSeries: readonly { startDate: Date | string; heartbeats: readonly { timeSinceSeriesStart: number; precededByGap: boolean }[] }[],
): Map<number, BeatQuality> {
  const m = new Map<number, BeatQuality>();
  for (const s of heartbeatSeries) m.set(new Date(s.startDate as any).getTime(), assessBeatQuality(s));
  return m;
}

/** Nearest series within 10 s, or null when we have no beat data to judge by (then: don't reject). */
export function beatQualityNear(sampleStartMs: number, map: Map<number, BeatQuality>): BeatQuality | null {
  for (const [seriesMs, q] of map) if (Math.abs(seriesMs - sampleStartMs) < 10_000) return q;
  return null;
}
