/**
 * Scientific run/training statistics for the Statistics screen.
 *
 * Cheap, snapshot-derived series (EF, time-in-zone, HRV, ACWR) are pure functions. Aerobic decoupling
 * needs each run's power+HR sample series, so it fetches run detail (cached by UUID like the power curve)
 * and only for the long, steady, aerobic runs where the metric is meaningful.
 */
import * as FileSystem from 'expo-file-system';
import { fetchWorkoutDetail } from './healthkit';
import { runDecouple, DC_GROSS_MAX } from './decoupling';
import type { RunWorkout, DailyLoad } from '../types';

// ── Efficiency Factor: work power ÷ work HR. Rising EF at the same HR = a better aerobic engine — the
// direct read on "am I getting fitter?" even when CTL looks flat. Most meaningful on aerobic runs, so we
// tag each point with its type and let the screen show the aerobic ones prominently. ─────────────────────
// Per-run efficiency ratios (higher = better). EC = speed÷power (HR-INDEPENDENT running economy),
// EF = power÷HR, SE = speed÷HR. speed is metres/min = 60000 ÷ pace(sec/km). ec/se are 0 when pace is
// missing so an EF-only run still contributes to the EF chart.
export interface EfPoint { date: string; ef: number; ec: number; se: number; label: string; aerobic: boolean; }
const AEROBIC = new Set(['Z2', 'Recovery', 'LongRun', 'Tempo']);

// Hampel despike: zero any point that deviates from its LOCAL (temporal-neighbour) median by more than
// k robust-σ. Unlike a fixed physiological cap, this tracks a slowly-drifting or genuinely-different
// historical baseline (e.g. a past power meter reading lower), so it only removes ISOLATED sensor/label
// glitches (an HR-dropout EF spike, a GPS-distance EC spike) — not a legitimate cluster of history.
// `floor` is an absolute noise tolerance: these ratios cluster VERY tightly (EC run-to-run σ ≈ 0.01),
// so without a floor the robust-σ collapses and normal variation (a real economy dip) looks like a
// spike. floor = the smallest run-to-run swing we still treat as real, keeping honest dips in.
// Input/output are index-aligned; 0 means "skip" and never participates in a neighbour window.
function despikeLocal(vals: number[], floor: number, radius = 3, k = 3.5): number[] {
  const n = vals.length;
  if (n < 5) return vals.slice();
  const med = (a: number[]): number => {
    const s = [...a].sort((x, y) => x - y); const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const out = vals.slice();
  for (let i = 0; i < n; i++) {
    if (!(vals[i] > 0)) continue;
    const win: number[] = [];
    for (let j = Math.max(0, i - radius); j <= Math.min(n - 1, i + radius); j++) if (vals[j] > 0) win.push(vals[j]);
    if (win.length < 4) continue;                          // too few neighbours to judge — keep it
    const m = med(win);
    const sigma = Math.max(floor, 1.4826 * med(win.map(v => Math.abs(v - m))));
    if (Math.abs(vals[i] - m) > k * sigma) out[i] = 0;     // isolated spike beyond noise floor → drop
  }
  return out;
}

export function efficiencyTrend(runs: RunWorkout[]): EfPoint[] {
  const base = (runs ?? [])
    // Genuine RUNNING efforts only — exclude walk-pace / very-low-power / estimated-power / mislabeled-tiny-work
    // runs whose work stats aren't a real run (they otherwise plot as huge false dips, e.g. a 26:51/km "recovery").
    .filter(r => (r.workPower ?? 0) >= 140 && (r.workHR ?? 0) > 0
      && (r.workPace ?? 0) >= 200 && (r.workPace ?? 0) <= 600
      && !r.isEstimatedPower)
    .map(r => {
      const speed = (r.workPace ?? 0) > 0 ? 60000 / r.workPace! : 0;   // m/min
      const r3 = (x: number) => Math.round(x * 1000) / 1000;
      return {
        date: r.date.slice(0, 10),
        ef: r3(r.workPower! / r.workHR!),
        ec: speed > 0 ? r3(speed / r.workPower!) : 0,
        se: speed > 0 ? r3(speed / r.workHR!) : 0,
        label: r.label ?? 'Run',
        aerobic: AEROBIC.has(r.label ?? ''),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  // Despike each ratio against its LOCAL trend (removes lone sensor/label glitches, keeps honest dips
  // and any drifting historical baseline). We deliberately DON'T drop by the binary `hrUnreliable` flag:
  // it fires both too often (blanked whole months of EF/SE while HR-independent EC stayed) and too rarely
  // (missed a clear HR-dropout run), so it made the charts look "cut off" and still spiky.
  const ef = despikeLocal(base.map(p => p.ef), 0.20);
  const ec = despikeLocal(base.map(p => p.ec), 0.03);
  const seRaw = despikeLocal(base.map(p => p.se), 0.15);
  // SE = EF × EC exactly (speed÷HR = power÷HR · speed÷power). So if EITHER factor was rejected as a
  // glitch, SE is untrustworthy too — drop it even when SE alone didn't look extreme (e.g. a run whose
  // pace over-read inflated EC also inflates SE, but by less than SE's own noise floor).
  const se = seRaw.map((v, i) => (ef[i] > 0 && ec[i] > 0) ? v : 0);
  return base.map((p, i) => ({ ...p, ef: ef[i], ec: ec[i], se: se[i] }));
}

// ── Time-in-zone + polarization over a window. zones are % of each run's time; weight by run minutes. ────
export interface ZoneSummary {
  pct: { z1: number; z2: number; z3: number; z4: number; z5: number };  // % of total running time
  minutes: number;                                                       // total running minutes counted
  easyPct: number; modPct: number; hardPct: number;                      // 3-zone (Z1-2 / Z3 / Z4-5)
  polarizationIndex: number;                                             // log10( (easy%·hard%) / mod%² ), >0 ≈ polarised
}
export function zoneSummary(runs: RunWorkout[], sinceDays = 56, maxHR = 188): ZoneSummary | null {
  const cut = Date.now() - sinceDays * 86_400_000;
  const acc = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
  let total = 0;
  // Same %-maxHR zone edges as the classifier (Z1<60, Z2<70, Z3<80, Z4<90, Z5≥90).
  const bucket = (frac: number): keyof typeof acc => frac < 0.60 ? 'z1' : frac < 0.70 ? 'z2' : frac < 0.80 ? 'z3' : frac < 0.90 ? 'z4' : 'z5';
  for (const r of runs ?? []) {
    if (new Date(r.date).getTime() < cut) continue;
    const z = r.zones, sum = z ? z.z1 + z.z2 + z.z3 + z.z4 + z.z5 : 0;
    if (z && sum > 0) {
      const mins = (r.workDuration ?? r.duration ?? 0) / 60;
      if (mins <= 0) continue;
      (['z1', 'z2', 'z3', 'z4', 'z5'] as const).forEach(k => { acc[k] += (z[k] / sum) * mins; });
      total += mins;
    } else if (r.segments && r.segments.length && maxHR > 0) {
      // Fallback (same as the Intensity-Mix chart): bucket each segment's minutes by its avg HR, so runs
      // without a computed time-in-zone still count — otherwise this card undercounts and skews hard.
      for (const s of r.segments) {
        const segMin = (s.durationSec ?? 0) / 60;
        if (segMin <= 0 || !(((s.avgHR ?? 0)) > 0)) continue;
        acc[bucket(s.avgHR! / maxHR)] += segMin; total += segMin;
      }
    }
  }
  if (total <= 0) return null;
  const pct = { z1: acc.z1 / total * 100, z2: acc.z2 / total * 100, z3: acc.z3 / total * 100, z4: acc.z4 / total * 100, z5: acc.z5 / total * 100 };
  const easy = pct.z1 + pct.z2, mod = pct.z3, hard = pct.z4 + pct.z5;
  // Seiler polarization index — >0 leans polarised (lots of easy + some hard, little middle).
  const pi = mod > 0.5 && easy > 0 && hard > 0 ? Math.log10((easy * hard) / (mod * mod)) : 0;
  return {
    pct, minutes: Math.round(total),
    easyPct: Math.round(easy), modPct: Math.round(mod), hardPct: Math.round(hard),
    polarizationIndex: Math.round(pi * 100) / 100,
  };
}

// ── HRV trend: lnRMSSD nightly + 7-night rolling mean + a normal-range band (mean ± SD), the Plews/
// Buchheit way — a rising mean with a tight band = adapting well; a dropping mean or a widening band =
// accumulating strain. Input is the nightly {date, weightedRMSSD} series. ───────────────────────────────
export interface HrvPoint { date: string; ln: number; mean7: number; sd7: number; }
export function hrvTrend(nightly: { date: string; rmssd: number }[]): HrvPoint[] {
  const pts = (nightly ?? []).filter(n => n.rmssd > 0).sort((a, b) => a.date.localeCompare(b.date));
  const out: HrvPoint[] = [];
  for (let i = 0; i < pts.length; i++) {
    const ln = Math.log(pts[i].rmssd);
    const win = pts.slice(Math.max(0, i - 6), i + 1).map(p => Math.log(p.rmssd));
    const mean = win.reduce((s, x) => s + x, 0) / win.length;
    const sd = win.length > 1 ? Math.sqrt(win.reduce((s, x) => s + (x - mean) ** 2, 0) / win.length) : 0;
    out.push({ date: pts[i].date.slice(0, 10), ln: Math.round(ln * 1000) / 1000, mean7: Math.round(mean * 1000) / 1000, sd7: Math.round(sd * 1000) / 1000 });
  }
  return out;
}

// ── ACWR: acute (ATL) ÷ chronic (CTL) load ratio per day. The 0.8–1.3 band is the injury-risk sweet spot;
// above ~1.5 is the danger zone. Straight from the CTL/ATL series. ──────────────────────────────────────
// Intensity mix per WEEK over a window — easy/moderate/hard minutes, for the "distribution over time" chart.
export interface ZoneWeek { weekStart: string; t: number; easyMin: number; modMin: number; hardMin: number; total: number; }
// Zone split by % of maxHR (matches the classifier: easy = Z1-2 <70%, moderate = Z3 70-80%, hard = Z4-5 ≥80%).
const ZONE_MOD = 0.70, ZONE_HARD = 0.80;
export function zoneDistributionOverTime(runs: RunWorkout[], t0: number, t1: number, maxHR = 188): ZoneWeek[] {
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const mondayOf = (ms: number) => { const d = new Date(ms); const day = (d.getDay() + 6) % 7; d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - day); return d; };
  const byWeek = new Map<string, { t: number; easy: number; mod: number; hard: number }>();
  for (const r of runs ?? []) {
    const ms = new Date(r.date).getTime();
    if (ms < t0 || ms > t1) continue;
    const z = r.zones, zSum = z ? z.z1 + z.z2 + z.z3 + z.z4 + z.z5 : 0;
    let easy = 0, mod = 0, hard = 0;
    if (z && zSum > 0) {
      // Preferred: full time-in-zone distribution from the HR sample stream, weighted by run minutes.
      const mins = (r.workDuration ?? r.duration ?? 0) / 60; if (mins <= 0) continue;
      easy = ((z.z1 + z.z2) / zSum) * mins; mod = (z.z3 / zSum) * mins; hard = ((z.z4 + z.z5) / zSum) * mins;
    } else if (r.segments && r.segments.length && maxHR > 0) {
      // Fallback for runs that have segment averages but no continuous HR stream (→ blank zones):
      // bucket each segment's minutes by its average HR so the week still shows instead of vanishing.
      for (const s of r.segments) {
        const segMin = (s.durationSec ?? 0) / 60;
        if (segMin <= 0 || !(((s.avgHR ?? 0)) > 0)) continue;
        const frac = s.avgHR! / maxHR;
        if (frac < ZONE_MOD) easy += segMin; else if (frac < ZONE_HARD) mod += segMin; else hard += segMin;
      }
    }
    if (easy + mod + hard <= 0) continue;
    const mon = mondayOf(ms), key = iso(mon);
    const e = byWeek.get(key) ?? { t: mon.getTime(), easy: 0, mod: 0, hard: 0 };
    e.easy += easy; e.mod += mod; e.hard += hard;
    byWeek.set(key, e);
  }
  return [...byWeek.entries()]
    .map(([weekStart, v]) => ({ weekStart, t: v.t, easyMin: Math.round(v.easy), modMin: Math.round(v.mod), hardMin: Math.round(v.hard), total: Math.round(v.easy + v.mod + v.hard) }))
    .sort((a, b) => a.t - b.t);
}

export interface AcwrPoint { date: string; ratio: number; }
export function acwrSeries(load: DailyLoad[]): AcwrPoint[] {
  return (load ?? [])
    .filter(d => (d.ctl ?? 0) > 1)
    .map(d => ({ date: d.date.slice(0, 10), ratio: Math.round((d.atl / d.ctl) * 100) / 100 }));
}

// ── Aerobic decoupling (Pw:HR) — per run, cached by UUID (fetches detail). ───────────────────────────────
// v2: warm-up excluded from the decoupling window (v1 included it → inflated). Bump discards v1.
// v5: adds a STEADINESS gate — stop-and-go runs (traffic lights / navigation stops) are rejected because
// HR recovers at each stop and scrambles the drift. Bump discards v4 (which trusted those broken runs).
const DC_CACHE = `${FileSystem.documentDirectory}decoupling-cache-v5.json`;
const DC_AEROBIC = new Set(['Z2', 'Recovery', 'LongRun']);   // steady aerobic only — decoupling is noise on quality days
export interface DecouplePoint { date: string; pct: number; label: string; }

async function readDc(): Promise<Record<string, number | null>> {
  try { return JSON.parse(await FileSystem.readAsStringAsync(DC_CACHE)); } catch { return {}; }
}
async function writeDc(c: Record<string, number | null>): Promise<void> {
  try { await FileSystem.writeAsStringAsync(DC_CACHE, JSON.stringify(c)); } catch { /* best-effort */ }
}

export async function decouplingTrend(
  runs: RunWorkout[],
  onProgress?: (done: number, total: number) => void,
): Promise<DecouplePoint[]> {
  const cache = await readDc();
  const candidates = (runs ?? []).filter(r =>
    DC_AEROBIC.has(r.label ?? '') && (r.duration ?? 0) >= 1800 && (r.workPower ?? 0) > 0);
  const toFetch = candidates.filter(r => !(r.uuid in cache));
  let done = 0;
  onProgress?.(0, toFetch.length);
  for (const r of toFetch) {
    try {
      const d = await fetchWorkoutDetail(r.date, r.duration);
      cache[r.uuid] = runDecouple(d);   // canonical calc (Pw:HR → speed:HR → km-splits), shared by every consumer
    } catch { cache[r.uuid] = null; }
    onProgress?.(++done, toFetch.length);
  }
  if (toFetch.length) await writeDc(cache);
  return candidates
    .filter(r => cache[r.uuid] != null)
    .map(r => ({ date: r.date.slice(0, 10), pct: cache[r.uuid] as number, label: r.label ?? 'Run' }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// A MOVING "normal aerobic efficiency" band: for each run, a robust local centre (median of the ±R
// neighbouring runs) and spread (MAD), so the band tracks a drifting baseline instead of a fixed line.
// Because centre/spread are robust, artifacts don't inflate the band that judges them. Runs whose
// decoupling sits more than cutK robust-σ from the local centre (or beyond an absolute artifact ceiling)
// are dropped as "unusable" — HR dropout in a half, a walk-break, or coarse km-split noise. `band` is
// returned for ALL runs (the shaded envelope), `clean` is the runs that survive the cut.
export interface DcBand { date: string; lo: number; hi: number; }
export function decouplingBanded(
  pts: DecouplePoint[],
  opts: { radius?: number; floor?: number; bandK?: number; grossMax?: number } = {},
): { clean: DecouplePoint[]; band: DcBand[] } {
  const { radius = 7, floor = 3, bandK = 2, grossMax = DC_GROSS_MAX } = opts;
  // Cut only IMPLAUSIBLE ARTIFACTS by an absolute margin (>30% within-run drift isn't a real steady effort —
  // it's HR dropout in a half, a walk-break, or coarse km-split noise). Crucially we do NOT cut on the
  // statistical band: a run far BELOW the recent norm is a GREAT run (low drift), not "unusable" — cutting it
  // would drop today's best effort and make "latest" jump to an older, worse run. The moving band is
  // DISPLAY-ONLY: it shows "your normal range right now" so single dots are read in context.
  const clean = [...(pts ?? [])].filter(p => Math.abs(p.pct) <= grossMax).sort((a, b) => a.date.localeCompare(b.date));
  const n = clean.length;
  const med = (a: number[]): number => { const x = [...a].sort((p, q) => p - q); const m = x.length >> 1; return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2; };
  const band: DcBand[] = [];
  for (let i = 0; i < n; i++) {
    const w = clean.slice(Math.max(0, i - radius), Math.min(n - 1, i + radius) + 1).map(p => p.pct);
    const m = med(w);
    const sigma = Math.max(floor, 1.4826 * med(w.map(v => Math.abs(v - m))));
    band.push({ date: clean[i].date, lo: m - bandK * sigma, hi: m + bandK * sigma });
  }
  return { clean, band };
}

export async function clearDecouplingCache(): Promise<void> {
  try { await FileSystem.deleteAsync(DC_CACHE, { idempotent: true }); } catch { /* ignore */ }
}
