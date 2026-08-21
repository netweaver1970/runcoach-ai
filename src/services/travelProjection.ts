/**
 * Travel-mode training-load projection.
 *
 * Continues the real CTL/ATL EWMA (the exact same model as the live Training Load screen) forward
 * across a trip, under three training scenarios during the trip window:
 *   • continue — train as if at home (full load)
 *   • maintain — a few short easy runs (~half load)
 *   • rest     — sightseeing / NEAT only (minimal load)
 *
 * Before and after the trip every scenario carries the athlete's current typical daily load, so the
 * lines diverge ONLY during the trip and then re-converge as fitness rebuilds — showing both the dip
 * and how fast it comes back. Detraining is slow (CTL is a 42-day average), which the curves make visible.
 */
import { DailyLoad } from '../types';
import { computeTrainingLoadSeries } from './trainingLoad';

export type TravelScenario = 'continue' | 'maintain' | 'rest';
export const TRAVEL_SCENARIOS: TravelScenario[] = ['continue', 'maintain', 'rest'];

// Fraction of the athlete's normal daily load carried DURING the trip, per scenario.
// rest isn't 0 — travel means lots of walking (NEAT), so a floor applies below.
const TRIP_FACTOR: Record<TravelScenario, number> = { continue: 1.0, maintain: 0.5, rest: 0.18 };
const TRIP_REST_FLOOR = 14;   // ~a sightseeing day's NEAT load, so "rest" never collapses to zero

export interface TravelProjection {
  scenarios:       Record<TravelScenario, DailyLoad[]>;   // projected series [today … horizonEnd] per scenario
  normalDailyLoad: number;    // the sustained daily load used before/after the trip
  today:           DailyLoad;  // current real CTL/ATL/TSB (last real day)
  tripStart:       string;    // YYYY-MM-DD
  tripEnd:         string;    // YYYY-MM-DD (inclusive)
  horizonEnd:      string;    // YYYY-MM-DD
}

const dstr = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const atMidnight = (isoDay: string) => new Date(isoDay + 'T00:00:00');

/**
 * @param hist         real training-load history (warmed), ending at/near today (from fetchTrainingLoadHistory)
 * @param tripStart    first day away
 * @param tripDays     trip length in days (inclusive)
 * @param postTripDays how far PAST the trip to keep projecting (default 21 → shows the rebuild)
 */
export function projectTravel(
  hist: DailyLoad[],
  tripStart: Date,
  tripDays: number,
  postTripDays = 21,
): TravelProjection | null {
  if (!hist.length || tripDays < 1) return null;

  const loadByDay = new Map<string, number>(hist.map(d => [d.date, d.load]));
  const today = hist[hist.length - 1];

  // Normal daily load = mean of the last 21 COMPLETE days (drop the last, possibly-partial, day).
  // This is "keep doing what you're doing" — CTL trends toward it before/after the trip.
  const recent = hist.slice(-22, -1).map(d => d.load).filter(v => v >= 0);
  const normalDailyLoad = recent.length
    ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length)
    : today.load;

  const todayDate  = atMidnight(today.date);
  const tripStart0 = atMidnight(dstr(tripStart));
  const tripEnd0   = new Date(tripStart0.getTime() + (tripDays - 1) * 86_400_000);
  const horizonEnd = new Date(tripEnd0.getTime() + postTripDays * 86_400_000);

  const scenarios = {} as Record<TravelScenario, DailyLoad[]>;
  for (const sc of TRAVEL_SCENARIOS) {
    const m = new Map(loadByDay);
    const cur = new Date(todayDate.getTime() + 86_400_000);   // project from TOMORROW
    while (cur.getTime() <= horizonEnd.getTime()) {
      const inTrip = cur.getTime() >= tripStart0.getTime() && cur.getTime() <= tripEnd0.getTime();
      let load = normalDailyLoad;
      if (inTrip) load = sc === 'rest'
        ? Math.max(TRIP_REST_FLOOR, Math.round(normalDailyLoad * TRIP_FACTOR.rest))
        : Math.round(normalDailyLoad * TRIP_FACTOR[sc]);
      m.set(dstr(cur), load);
      cur.setDate(cur.getDate() + 1);
    }
    // Return from today (inclusive) so every scenario shares the same real starting point.
    scenarios[sc] = computeTrainingLoadSeries(m, todayDate, horizonEnd);
  }

  return {
    scenarios,
    normalDailyLoad,
    today,
    tripStart:  dstr(tripStart0),
    tripEnd:    dstr(tripEnd0),
    horizonEnd: dstr(horizonEnd),
  };
}

/** CTL for a scenario on a given day (nearest ≤ date), for the summary table. */
export function ctlOn(series: DailyLoad[], dayISO: string): number | null {
  let val: number | null = null;
  for (const d of series) { if (d.date <= dayISO) val = d.ctl; else break; }
  return val;
}
