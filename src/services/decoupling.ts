// Canonical aerobic-decoupling calculation — ONE source of truth.
//
// Used by the Statistics chart (via runStats.decouplingTrend), the aerobic-base outlook
// (healthkit.analyzeAerobicBase) and zone calibration (zones.ts). Keeping it in one leaf module (it only
// depends on powerCurve.toPerSecond, never on healthkit/runStats) means those paths can't drift apart and
// there's no import cycle. `runDecouple` is what every consumer should call for a run's value.
import { toPerSecond } from './powerCurve';

// |drift| beyond this isn't aerobic decoupling — it's an artifact (HR dropout in a half, a walk-break, or
// coarse km-split noise). Consumers filter their series/median with this.
export const DC_GROSS_MAX = 30;

// Pw:HR (or speed:HR) drift: mean(effort/HR) over the first vs second half of the STEADY portion. Positive
// % = HR climbed relative to effort (cardiac drift / aerobic fatigue). Friel: <5% = strong aerobic base.
// Returns null when the run isn't a valid substrate: too short, or too broken up by stops/pauses.
export function computeDecouple(effort: { t: number; v: number }[], hr: { t: number; v: number }[], pauses: { s: number; e: number }[]): number | null {
  const p = toPerSecond(effort, pauses), h = toPerSecond(hr, pauses);
  const n = Math.min(p.length, h.length);
  const act: number[] = [];
  for (let i = 0; i < n; i++) if (p[i] > 0 && h[i] > 0) act.push(i);
  if (act.length < 1500) return null;   // need ~25 min of paired data
  // EXCLUDE THE WARM-UP. Decoupling is defined on the STEADY portion only — early-run HR lags effort, so an
  // included warm-up inflates the first-half ratio. Drop ~the first 10 min (capped 15%), then split in half.
  const warm = Math.min(600, Math.floor(act.length * 0.15));
  const steady = act.slice(warm);
  if (steady.length < 1200) return null;   // need ~20 min of steady effort after the warm-up
  // STEADINESS GATE — stop-and-go runs (traffic lights / navigation stops) aren't valid: HR recovers at every
  // stop/pause and, on restart, reads low relative to effort, scrambling the halves. Two disruption sources:
  //   (a) MANUAL PAUSES — toPerSecond zeroes BOTH effort and HR, so read them from the pause intervals.
  //   (b) UN-PAUSED STOPS — effort drops to ~0 while HR keeps recording.
  // Judge by disrupted TIME (a few short pauses on a steady run are fine), not raw count.
  const tA = steady[0], tB = steady[steady.length - 1], winSec = tB - tA + 1;
  let pauseCount = 0, pausedSec = 0;
  for (const pz of pauses) {
    const s = Math.max(pz.s / 1000, tA), e = Math.min(pz.e / 1000, tB), d = e - s;
    if (d > 5) { pauseCount++; pausedSec += d; }   // real pauses only (ignore <5s taps)
  }
  let stoppedSec = 0, stopEvents = 0, cur = 0;
  for (let i = tA; i <= tB; i++) {
    if (!(p[i] > 0) && h[i] > 0) { stoppedSec++; if (++cur === 10) stopEvents++; } else cur = 0;   // ≥10s halt = a stop
  }
  const disruptedFrac = (pausedSec + stoppedSec) / Math.max(1, winSec);
  if (disruptedFrac > 0.12 || pauseCount + stopEvents >= 6) return null;   // stop-and-go → not a valid substrate
  const mid = Math.floor(steady.length / 2);
  const ratio = (idx: number[]) => {
    let sp = 0, sh = 0;
    for (const i of idx) { sp += p[i]; sh += h[i]; }
    const mh = sh / idx.length;
    return mh > 0 ? (sp / idx.length) / mh : 0;
  };
  const r1 = ratio(steady.slice(0, mid)), r2 = ratio(steady.slice(mid));
  if (r1 <= 0) return null;
  return Math.round(((r1 - r2) / r1) * 1000) / 10;   // percent, 1 dp
}

// Coarse decoupling from per-km splits (no per-second stream needed) — for older runs that only have km
// splits: drop the warm-up km, split the rest in half, compare mean(effort/HR). Power if every km has it.
export function decoupleFromSplits(splits: { paceSecs: number; avgHR: number; avgPower: number }[]): number | null {
  const s = (splits ?? []).filter(k => k.avgHR > 0 && k.paceSecs > 0);
  if (s.length < 5) return null;
  const usePower = s.every(k => k.avgPower > 0);
  const body = s.slice(1);
  const mid = Math.floor(body.length / 2);
  if (mid < 2) return null;
  const ratio = (arr: typeof body) => {
    let se = 0, sh = 0;
    for (const k of arr) { se += usePower ? k.avgPower : 1000 / k.paceSecs; sh += k.avgHR; }
    const mh = sh / arr.length;
    return mh > 0 ? (se / arr.length) / mh : 0;
  };
  const r1 = ratio(body.slice(0, mid)), r2 = ratio(body.slice(mid));
  if (r1 <= 0) return null;
  return Math.round(((r1 - r2) / r1) * 1000) / 10;
}

// Full per-run decoupling with the fallback chain: Pw:HR → speed:HR (older watches with no power stream)
// → coarse per-km splits. This is the value every feature should quote for a run.
export function runDecouple(detail: {
  power?: { t: number; v: number }[]; hr?: { t: number; v: number }[]; pace?: { t: number; v: number }[];
  pauseIntervals?: { s: number; e: number }[]; kmSplits?: { paceSecs: number; avgHR: number; avgPower: number }[];
}): number | null {
  let dc = computeDecouple(detail.power ?? [], detail.hr ?? [], detail.pauseIntervals ?? []);
  if (dc === null) {
    const speed = (detail.pace ?? []).map(p => ({ t: p.t, v: p.v > 0 ? 1000 / p.v : 0 }));
    dc = computeDecouple(speed, detail.hr ?? [], detail.pauseIntervals ?? []);
  }
  if (dc === null) dc = decoupleFromSplits(detail.kmSplits ?? []);
  return dc;
}
