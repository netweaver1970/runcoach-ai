/**
 * Caffeine for the day (Geert 2026-10-08): total vs the EFSA limits, the last intake, and how much is still active at
 * your USUAL bedtime. EFSA 2015 (EFSA Journal 13(5):4102): ≤ 400 mg/day and ≤ 200 mg in one go are of no safety
 * concern for healthy adults; ~100 mg near bedtime can already lengthen sleep onset and reduce deep sleep. Half-life
 * ≈ 5 h (2–10 h between people) → the default cut-off is 8 h before bed (Drake et al. 2013: 400 mg even 6 h before bed
 * cost > 1 h of sleep). Late caffeine also lowers overnight HRV — what recovery / readiness read the next morning.
 */
import type { FoodEntry } from './foodLog';

export const CAF_DAY_MAX = 400;
export const CAF_DOSE_MAX = 200;
export const CAF_HALF_LIFE_H = 5;
export const CAF_CUTOFF_H = 8;

/** Usual bedtime (minutes after midnight, may be > 1440 for after-midnight) = the median of recent nights. */
export function usualBedtimeMin(sessions: { bedtime: string }[]): number | null {
  const mins = sessions.map(s => new Date(s.bedtime)).filter(d => !isNaN(d.getTime()))
    .map(d => { const m = d.getHours() * 60 + d.getMinutes(); return m < 12 * 60 ? m + 1440 : m; })   // 00:30 → 24:30
    .sort((a, b) => a - b);
  if (mins.length < 3) return null;
  return mins[Math.floor(mins.length / 2)];
}
export const fmtClock = (min: number) => { const m = ((Math.round(min) % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

export interface CaffeineDay { total: number; last?: string; maxDose: number; atBed?: number; bed?: number; late: FoodEntry[]; cutoff?: number }
/** The day's caffeine from its entries; `bed` = usual bedtime (min after the day's midnight). */
export function caffeineDay(entries: FoodEntry[], bed: number | null): CaffeineDay {
  const caf = entries.filter(e => (e.n.caf ?? 0) > 0).sort((a, b) => a.t.localeCompare(b.t));
  const total = caf.reduce((a, e) => a + (e.n.caf ?? 0), 0);
  // a "dose" = what's taken within 1 h (two espressos back to back = one dose)
  let maxDose = 0;
  for (const e of caf) {
    const t0 = new Date(e.t).getTime();
    maxDose = Math.max(maxDose, caf.filter(x => { const t = new Date(x.t).getTime(); return t >= t0 && t - t0 <= 3_600_000; }).reduce((a, x) => a + (x.n.caf ?? 0), 0));
  }
  if (!caf.length) return { total: 0, maxDose: 0, late: [] };
  const last = caf[caf.length - 1].t;
  if (bed == null) return { total, last, maxDose, late: [] };
  const day0 = new Date(caf[0].t); day0.setHours(0, 0, 0, 0);
  const bedMs = day0.getTime() + bed * 60_000;
  const atBed = caf.reduce((a, e) => { const h = (bedMs - new Date(e.t).getTime()) / 3_600_000; return h >= 0 ? a + (e.n.caf ?? 0) * Math.pow(0.5, h / CAF_HALF_LIFE_H) : a; }, 0);
  const cutoff = bed - CAF_CUTOFF_H * 60;
  const late = caf.filter(e => { const d = new Date(e.t); return (d.getTime() - day0.getTime()) / 60_000 > cutoff; });
  return { total, last, maxDose, atBed, bed, late, cutoff };
}
