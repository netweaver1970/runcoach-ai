/**
 * Caffeine → overnight HRV, PERSONAL (Geert 2026-10-08: "add the caffeine–HRV link to the coach").
 * Each logged food day D is paired with the night that follows (wake-up day D+1 in the daily-components store):
 *   exposure = caffeine still active at THAT night's real bedtime (half-life 5 h, caffeine.ts)
 *   outcome  = resting HRV that night as a z-score of ln(HRV) vs the 30 nights before (+ deep-sleep minutes)
 * Late nights (≥ 25 mg active at bed — an afternoon coffee) vs clean nights (< 12 mg — a morning coffee leaves ~10); a verdict only from ≥ 5 nights in each group.
 * Days with < 3 logged items are skipped (an unlogged coffee would read as "clean").
 */
import { CAF_HALF_LIFE_H } from './caffeine';

export const LATE_MG = 25, CLEAN_MG = 12, MIN_NIGHTS = 5;   // 25 mg ≈ an 80 mg coffee 5–6 h before bed

export interface CafNight { day: string; night: string; atBed: number; total: number; hrv: number; z: number; deep?: number }
export interface CafHrv {
  nights: CafNight[]; late: CafNight[]; clean: CafNight[];
  ready: boolean;                      // enough nights in both groups for a verdict
  hrvPct?: number;                     // late vs clean, mean HRV difference in % (negative = lower after late caffeine)
  zDiff?: number;                      // same in personal SD units
  deepDiff?: number;                   // minutes of deep sleep, late − clean
  rho?: number;                        // Spearman: mg at bedtime vs HRV z, all nights
  lastNight?: CafNight;                // the most recent night with data
}

const addDays = (k: string, n: number) => { const d = new Date(k + 'T12:00:00'); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
function spearman(x: number[], y: number[]): number | undefined {
  if (x.length < 8) return undefined;
  const rank = (a: number[]) => { const o = a.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); o.forEach(([, i], k) => { r[i] = k; }); return r as number[]; };
  const rx = rank(x), ry = rank(y), mx = mean(rx), my = mean(ry);
  let n = 0, dx = 0, dy = 0;
  for (let i = 0; i < x.length; i++) { n += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return dx && dy ? Math.round((n / Math.sqrt(dx * dy)) * 100) / 100 : undefined;
}

let memo: { at: number; v: Promise<CafHrv> } | null = null;
/** Cached ~30 min (every LLM call + two screens ask; the inputs change at most a few times a day). */
export function caffeineHrv(daysBack = 120): Promise<CafHrv> {
  if (memo && Date.now() - memo.at < 30 * 60_000) return memo.v;
  const v = computeCafHrv(daysBack).catch(e => { memo = null; throw e; });
  memo = { at: Date.now(), v };
  return v;
}
async function computeCafHrv(daysBack: number): Promise<CafHrv> {
  const L = require('./foodLog') as typeof import('./foodLog');
  const H = require('./healthkit') as typeof import('./healthkit');
  const D = require('./foodDb') as typeof import('./foodDb');   // entries logged before caffeine was stored → table value
  const dc = (await H.peekDailyComponents().catch(() => ({ days: {} as Record<string, Record<string, number>> }))).days;
  const hrvByNight = Object.entries(dc).filter(([, d]) => (d.restingHrv ?? 0) > 0).sort(([a], [b]) => a.localeCompare(b));
  const nights: CafNight[] = [];
  const today = new Date();
  for (let k = daysBack; k >= 1; k--) {
    const d = new Date(today); d.setDate(d.getDate() - k);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const night = addDays(day, 1);
    const n = dc[night];
    if (!n || !(n.restingHrv > 0) || n.sleepTime == null) continue;
    const log = await L.loadDay(day).catch(() => null);
    if (!log || log.entries.length < 3) continue;
    // personal baseline: ln(HRV) over the 30 nights before this one
    const prev = hrvByNight.filter(([k2]) => k2 < night).slice(-30).map(([, v]) => Math.log(v.restingHrv));
    if (prev.length < 10) continue;
    const m = mean(prev), sd = Math.sqrt(mean(prev.map(v => (v - m) ** 2))) || 0.1;
    // real bedtime that night (clock minutes; before noon = after midnight)
    const bedClock = n.sleepTime < 12 * 60 ? n.sleepTime + 1440 : n.sleepTime;
    const day0 = new Date(day + 'T00:00:00').getTime(), bedMs = day0 + bedClock * 60_000;
    let atBed = 0, total = 0;
    for (const e of log.entries) {
      const mg = e.n.caf ?? (e.grams ? (D.foodByKey(e.key)?.per100.caf ?? 0) * e.grams / 100 : 0);
      if (!(mg > 0)) continue;
      total += mg;
      const h = (bedMs - new Date(e.t).getTime()) / 3_600_000;
      if (h >= 0) atBed += mg * Math.pow(0.5, h / CAF_HALF_LIFE_H);
    }
    nights.push({ day, night, atBed: Math.round(atBed), total: Math.round(total), hrv: n.restingHrv, z: Math.round(((Math.log(n.restingHrv) - m) / sd) * 100) / 100, ...(n.deepSleep ? { deep: n.deepSleep } : {}) });
  }
  const late = nights.filter(x => x.atBed >= LATE_MG), clean = nights.filter(x => x.atBed < CLEAN_MG);
  const ready = late.length >= MIN_NIGHTS && clean.length >= MIN_NIGHTS;
  const out: CafHrv = { nights, late, clean, ready, lastNight: nights[nights.length - 1], rho: spearman(nights.map(x => x.atBed), nights.map(x => x.z)) };
  if (late.length && clean.length) {
    out.hrvPct = Math.round((Math.exp(mean(late.map(x => Math.log(x.hrv))) - mean(clean.map(x => Math.log(x.hrv)))) - 1) * 1000) / 10;
    out.zDiff = Math.round((mean(late.map(x => x.z)) - mean(clean.map(x => x.z))) * 100) / 100;
    const ld = late.filter(x => x.deep != null), cd = clean.filter(x => x.deep != null);
    if (ld.length && cd.length) out.deepDiff = Math.round(mean(ld.map(x => x.deep!)) - mean(cd.map(x => x.deep!)));
  }
  return out;
}

/** One line of the personal finding (Food caffeine card, Daily Coach, LLM). */
export function cafHrvSummary(r: CafHrv): string {
  if (!r.ready) return `Caffeine → HRV: collecting (${r.late.length}/${MIN_NIGHTS} late-caffeine nights, ${r.clean.length}/${MIN_NIGHTS} clean nights with HRV + a logged day).`;
  const dir = (r.hrvPct ?? 0) <= -3 ? 'LOWER' : (r.hrvPct ?? 0) >= 3 ? 'higher' : 'about the same';
  return `Caffeine → HRV (personal): nights with ≥ ${LATE_MG} mg caffeine still active at bedtime show ${dir} overnight HRV — ${r.hrvPct! > 0 ? '+' : ''}${r.hrvPct}% (${r.zDiff! > 0 ? '+' : ''}${r.zDiff} SD; ${r.late.length} late vs ${r.clean.length} clean nights)${r.deepDiff != null ? `, deep sleep ${r.deepDiff > 0 ? '+' : ''}${r.deepDiff} min` : ''}${r.rho != null ? `; dose–response ρ ${r.rho}` : ''}.`;
}
