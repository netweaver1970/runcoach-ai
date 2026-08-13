/**
 * Scientific run/training statistics for the Statistics screen.
 *
 * Cheap, snapshot-derived series (EF, time-in-zone, HRV, ACWR) are pure functions. Aerobic decoupling
 * needs each run's power+HR sample series, so it fetches run detail (cached by UUID like the power curve)
 * and only for the long, steady, aerobic runs where the metric is meaningful.
 */
import * as FileSystem from 'expo-file-system';
import { fetchWorkoutDetail } from './healthkit';
import { toPerSecond } from './powerCurve';
import type { RunWorkout, DailyLoad } from '../types';

// ── Efficiency Factor: work power ÷ work HR. Rising EF at the same HR = a better aerobic engine — the
// direct read on "am I getting fitter?" even when CTL looks flat. Most meaningful on aerobic runs, so we
// tag each point with its type and let the screen show the aerobic ones prominently. ─────────────────────
// Per-run efficiency ratios (higher = better). EC = speed÷power (HR-INDEPENDENT running economy),
// EF = power÷HR, SE = speed÷HR. speed is metres/min = 60000 ÷ pace(sec/km). ec/se are 0 when pace is
// missing so an EF-only run still contributes to the EF chart.
export interface EfPoint { date: string; ef: number; ec: number; se: number; label: string; aerobic: boolean; }
const AEROBIC = new Set(['Z2', 'Recovery', 'LongRun', 'Tempo']);
export function efficiencyTrend(runs: RunWorkout[]): EfPoint[] {
  return (runs ?? [])
    .filter(r => (r.workPower ?? 0) > 0 && (r.workHR ?? 0) > 0)
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
}

// ── Time-in-zone + polarization over a window. zones are % of each run's time; weight by run minutes. ────
export interface ZoneSummary {
  pct: { z1: number; z2: number; z3: number; z4: number; z5: number };  // % of total running time
  minutes: number;                                                       // total running minutes counted
  easyPct: number; modPct: number; hardPct: number;                      // 3-zone (Z1-2 / Z3 / Z4-5)
  polarizationIndex: number;                                             // log10( (easy%·hard%) / mod%² ), >0 ≈ polarised
}
export function zoneSummary(runs: RunWorkout[], sinceDays = 56): ZoneSummary | null {
  const cut = Date.now() - sinceDays * 86_400_000;
  const acc = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
  let total = 0;
  for (const r of runs ?? []) {
    if (!r.zones || new Date(r.date).getTime() < cut) continue;
    const mins = (r.workDuration ?? r.duration ?? 0) / 60;
    if (mins <= 0) continue;
    const z = r.zones, sum = z.z1 + z.z2 + z.z3 + z.z4 + z.z5;
    if (sum <= 0) continue;
    (['z1', 'z2', 'z3', 'z4', 'z5'] as const).forEach(k => { acc[k] += (z[k] / sum) * mins; });
    total += mins;
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
export interface AcwrPoint { date: string; ratio: number; }
export function acwrSeries(load: DailyLoad[]): AcwrPoint[] {
  return (load ?? [])
    .filter(d => (d.ctl ?? 0) > 1)
    .map(d => ({ date: d.date.slice(0, 10), ratio: Math.round((d.atl / d.ctl) * 100) / 100 }));
}

// ── Aerobic decoupling (Pw:HR) — per run, cached by UUID (fetches detail). ───────────────────────────────
// v2: warm-up excluded from the decoupling window (v1 included it → inflated). Bump discards v1.
const DC_CACHE = `${FileSystem.documentDirectory}decoupling-cache-v2.json`;
const DC_AEROBIC = new Set(['Z2', 'Recovery', 'LongRun']);   // steady aerobic only — decoupling is noise on quality days
export interface DecouplePoint { date: string; pct: number; label: string; }

async function readDc(): Promise<Record<string, number | null>> {
  try { return JSON.parse(await FileSystem.readAsStringAsync(DC_CACHE)); } catch { return {}; }
}
async function writeDc(c: Record<string, number | null>): Promise<void> {
  try { await FileSystem.writeAsStringAsync(DC_CACHE, JSON.stringify(c)); } catch { /* best-effort */ }
}

// Pw:HR drift: mean(power/HR) over the first vs second half of the aerobic effort. Positive % = HR climbed
// relative to power (cardiac drift / aerobic fatigue). Friel's rule of thumb: < 5% = strong aerobic base.
function computeDecouple(power: { t: number; v: number }[], hr: { t: number; v: number }[], pauses: { s: number; e: number }[]): number | null {
  const p = toPerSecond(power, pauses), h = toPerSecond(hr, pauses);
  const n = Math.min(p.length, h.length);
  const act: number[] = [];
  for (let i = 0; i < n; i++) if (p[i] > 0 && h[i] > 0) act.push(i);
  if (act.length < 1500) return null;   // need ~25 min of paired data
  // EXCLUDE THE WARM-UP. Friel's Pw:HR decoupling is defined on the STEADY portion only — early-run HR
  // lags power, so an included warm-up makes the first-half ratio artificially high and inflates the drift.
  // Drop ~the first 10 min (capped at 15% so a short run keeps enough), then split the remainder in half.
  const warm = Math.min(600, Math.floor(act.length * 0.15));
  const steady = act.slice(warm);
  if (steady.length < 1200) return null;   // need ~20 min of steady effort after the warm-up
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
      cache[r.uuid] = computeDecouple(d.power ?? [], d.hr ?? [], d.pauseIntervals ?? []);
    } catch { cache[r.uuid] = null; }
    onProgress?.(++done, toFetch.length);
  }
  if (toFetch.length) await writeDc(cache);
  return candidates
    .filter(r => cache[r.uuid] != null)
    .map(r => ({ date: r.date.slice(0, 10), pct: cache[r.uuid] as number, label: r.label ?? 'Run' }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function clearDecouplingCache(): Promise<void> {
  try { await FileSystem.deleteAsync(DC_CACHE, { idempotent: true }); } catch { /* ignore */ }
}
