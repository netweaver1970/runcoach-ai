/**
 * Per-reading HRV detail. Each Apple `HKHeartbeatSeriesSample` is one ~1-minute HRV reading; from its raw
 * beats we derive the R-R (NN) intervals and the full time-domain + non-linear metric suite (the same set a
 * dedicated HRV app shows). Quality (green/red) reuses assessBeatQuality — a reading is only trustworthy when
 * the watch captured (nearly) every beat, else RMSSD & friends are noise. Pure + deterministic.
 */
import { assessBeatQuality, BeatQuality } from './hrvQuality';

export interface HRVMetrics {
  n: number;            // usable NN intervals
  avnn: number;         // mean NN (ms)
  sdnn: number;         // ms
  rmssd: number;        // ms
  lnRmssd: number;
  nn50: number;
  pnn50: number;        // %
  hrvi: number;         // triangular index (N / tallest 1/128 s bin)
  baevsky: number;      // stress index
  sd1: number; sd2: number; s: number;   // Poincaré: ms, ms, ms² (S = π·SD1·SD2)
  csi: number;          // SD1/SD2 as % (labelled "Cardiac Sympathetic Index (SD1/SD2)")
  hrAvg: number; hrMin: number; hrMax: number;   // bpm
}

export interface HRVReading {
  startMs: number; endMs: number;
  totalSec: number;     // span of captured beats
  elapsedSec: number;   // wall-clock of the series
  gaps: number;         // internal precededByGap breaks
  gapsDurSec: number;   // seconds spanned by those gap intervals
  beats: number;        // captured beats
  quality: BeatQuality;
  ok: boolean;          // green when true, red when false
  rr: number[];         // NN intervals (ms) in order
  hr: { t: number; bpm: number; seg: number }[];   // instantaneous HR (t = sec); `seg` bumps at each gap → don't connect across it
  metrics: HRVMetrics;
}

export type HRVGrade = 'good' | 'fair' | 'poor';
// Display grade — STRICTER than the scoring `ok` flag (which the recovery score depends on, so we don't touch
// it) and, unlike it, penalises how much WALL-CLOCK time is missing: 13 s of gaps in a 1-min reading is not
// "good". good = near-complete + clean; fair = a little missing / minor artifacts; poor = fails the gate or a
// meaningful chunk is missing.
export function hrvGrade(r: { quality: BeatQuality; gapsDurSec: number; elapsedSec: number }): HRVGrade {
  const q = r.quality;
  const gapFrac = r.elapsedSec > 0 ? r.gapsDurSec / r.elapsedSec : 1;
  if (!q.ok || q.coverage < 0.85 || gapFrac > 0.12 || q.artifactPct > 0.12) return 'poor';
  if (q.coverage < 0.95 || gapFrac > 0.05 || q.artifactPct > 0.06) return 'fair';
  return 'good';
}
export function gradeColor(g: HRVGrade): string { return g === 'good' ? '#27ae60' : g === 'fair' ? '#e0a020' : '#c0392b'; }
export function gradeLabel(g: HRVGrade): string { return g === 'good' ? 'good' : g === 'fair' ? 'fair' : 'noisy'; }

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const std = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };

/** All HRV metrics from a clean NN-interval series (ms). */
export function computeHRVMetrics(rr: number[]): HRVMetrics {
  const n = rr.length;
  if (n < 2) return { n, avnn: 0, sdnn: 0, rmssd: 0, lnRmssd: 0, nn50: 0, pnn50: 0, hrvi: 0, baevsky: 0, sd1: 0, sd2: 0, s: 0, csi: 0, hrAvg: 0, hrMin: 0, hrMax: 0 };
  const avnn = mean(rr);
  const sdnn = std(rr);
  const diffs = rr.slice(1).map((v, i) => v - rr[i]);
  const rmssd = Math.sqrt(mean(diffs.map(d => d * d)));
  const nn50 = diffs.filter(d => Math.abs(d) > 50).length;
  const pnn50 = (nn50 / diffs.length) * 100;
  // Poincaré
  const sd1 = rmssd / Math.SQRT2;
  const sd2 = Math.sqrt(Math.max(0, 2 * sdnn * sdnn - sd1 * sd1));
  const sArea = Math.PI * sd1 * sd2;
  const csi = sd2 > 0 ? (sd1 / sd2) * 100 : 0;
  // Triangular index: histogram at 1/128 s (7.8125 ms) bins → N / tallest bin.
  const BIN = 1000 / 128;
  const binsHi: Record<number, number> = {};
  for (const v of rr) { const b = Math.round(v / BIN); binsHi[b] = (binsHi[b] ?? 0) + 1; }
  const maxBin = Math.max(...Object.values(binsHi));
  const hrvi = maxBin > 0 ? n / maxBin : 0;
  // Baevsky SI = AMo / (2·Mo·MxDMn), Mo/MxDMn in seconds, AMo the modal-bin share (%). Uses the SAME 1/128 s
  // (7.8125 ms) bin as Kubios / the reference HRV app — the old 50 ms bin inflated AMo and blew SI up ~8×.
  let modeBin = 0, modeCount = 0;
  for (const [b, cnt] of Object.entries(binsHi)) if (cnt > modeCount) { modeCount = cnt; modeBin = Number(b); }
  const amo = (modeCount / n) * 100;
  const mo = (modeBin * BIN) / 1000;
  const mxdmn = (Math.max(...rr) - Math.min(...rr)) / 1000;
  const baevsky = (mo > 0 && mxdmn > 0) ? amo / (2 * mo * mxdmn) : 0;
  // HR
  const hrs = rr.map(v => 60000 / v);
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    n, avnn: Math.round(avnn), sdnn: Math.round(sdnn), rmssd: Math.round(rmssd), lnRmssd: r1(Math.log(Math.max(1, rmssd))),
    nn50, pnn50: r1(pnn50), hrvi: Math.round(hrvi), baevsky: r1(baevsky),
    sd1: Math.round(sd1), sd2: Math.round(sd2), s: Math.round(sArea), csi: Math.round(csi),
    hrAvg: Math.round(mean(hrs)), hrMin: Math.round(Math.min(...hrs)), hrMax: Math.round(Math.max(...hrs)),
  };
}

interface RawSeries { startDate: Date | string; endDate?: Date | string; heartbeats: readonly { timeSinceSeriesStart: number; precededByGap: boolean }[] }

/** One heartbeat-series sample → a full HRVReading (R-R extraction mirrors assessBeatQuality). */
export function readingFromSeries(s: RawSeries): HRVReading {
  const beats = s.heartbeats ?? [];
  const startMs = new Date(s.startDate as any).getTime();
  const endMs = s.endDate ? new Date(s.endDate as any).getTime() : startMs;
  const rr: number[] = [];
  const hr: { t: number; bpm: number; seg: number }[] = [];
  let gaps = 0, gapsDurSec = 0, seg = 0;
  for (let i = 1; i < beats.length; i++) {
    const dt = beats[i].timeSinceSeriesStart - beats[i - 1].timeSinceSeriesStart;
    if (beats[i].precededByGap) { gaps++; gapsDurSec += Math.max(0, dt); seg++; continue; }   // gap → break the HR line
    const ms = dt * 1000;
    if (ms >= 300 && ms <= 2000) { rr.push(ms); hr.push({ t: beats[i].timeSinceSeriesStart, bpm: 60000 / ms, seg }); }
  }
  const totalSec = beats.length > 1 ? beats[beats.length - 1].timeSinceSeriesStart - beats[0].timeSinceSeriesStart : 0;
  const quality = assessBeatQuality(s);
  return {
    startMs, endMs,
    totalSec: Math.round(totalSec),
    elapsedSec: Math.round(Math.max(totalSec, (endMs - startMs) / 1000)),
    gaps, gapsDurSec: Math.round(gapsDurSec),
    beats: beats.length,
    quality, ok: quality.ok,
    rr, hr,
    metrics: computeHRVMetrics(rr),
  };
}

// Light in-memory cache so the list screen can hand a full reading (with its arrays) to the detail screen
// without re-querying HealthKit or stuffing arrays through route params.
let cache: HRVReading[] = [];
export function setCachedReadings(rs: HRVReading[]) { cache = rs; }
export function getCachedReading(startMs: number): HRVReading | null {
  return cache.find(r => r.startMs === startMs) ?? null;
}
