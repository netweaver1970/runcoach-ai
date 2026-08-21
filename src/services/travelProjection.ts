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

// ── Heat / climate penalty ──────────────────────────────────────────────────
// In real heat you simply can't train as much — HR runs high, pace craters, sessions get cut. So a
// destination's climate DAMPENS the achievable load on top of the training-intent scenario. Tuned on
// the harsher side because Geert is heat-sensitive: a tropical leg (Singapore/Bali) caps effort hard.
export type Climate = 'cool' | 'mild' | 'warm' | 'hot' | 'tropical';
export const CLIMATES: Climate[] = ['cool', 'mild', 'warm', 'hot', 'tropical'];
export const CLIMATE_LOAD_FACTOR: Record<Climate, number> = { cool: 1.0, mild: 1.0, warm: 0.85, hot: 0.68, tropical: 0.5 };
export const CLIMATE_LABEL: Record<Climate, string> = {
  cool: 'Cool', mild: 'Mild', warm: 'Warm', hot: 'Hot', tropical: 'Tropical',
};

/** One leg of a trip: a place, its length in days (contiguous), and its climate. */
export interface TravelLeg { id: string; place: string; days: number; climate: Climate }

/** Best-guess climate from a place name — a small hint table the user can override. */
export function climateForPlace(place: string): Climate {
  const p = place.toLowerCase();
  const has = (...ks: string[]) => ks.some(k => p.includes(k));
  if (has('singapore', 'bali', 'denpasar', 'cambodia', 'phnom', 'siem reap', 'bangkok', 'thailand',
          'jakarta', 'manila', 'saigon', 'ho chi minh', 'hanoi', 'kuala lumpur', 'malaysia',
          'dubai', 'india', 'mumbai', 'delhi', 'darwin')) return 'tropical';
  if (has('korea', 'seoul', 'busan', 'tokyo', 'japan', 'shanghai', 'hong kong', 'taipei',
          'sydney', 'lisbon', 'madrid', 'rome', 'athens')) return 'warm';
  if (has('reykjavik', 'oslo', 'stockholm', 'helsinki', 'anchorage')) return 'cool';
  return 'mild';
}

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

// ── Import legs from a flight-itinerary screenshot (LLM vision) ──────────────
export function buildFlightExtractionPrompt(todayISO: string): string {
  return `You are reading a flight itinerary / travel-booking screenshot. Extract the trip as the ordered sequence of PLACES the traveller STAYS IN (cities / destinations), each with its local arrival and departure date. Ignore pure layover / connection airports (a short stop with no overnight).
Return ONLY compact JSON, no prose, no code fences:
{"legs":[{"place":"Singapore","arrive":"2026-09-13","depart":"2026-09-19"}]}
Rules: dates STRICTLY YYYY-MM-DD; order chronologically; if a year is missing assume the next occurrence on/after ${todayISO}; if you cannot read a real itinerary return {"legs":[]}.`;
}

/** Parse the vision reply into an itinerary (start offset + contiguous legs). null if unreadable. */
export function parseFlightExtraction(reply: string, todayISO: string): { startInDays: number; legs: TravelLeg[] } | null {
  const m = reply.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj: any;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  const isDate = (v: any) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const parsed = (Array.isArray(obj?.legs) ? obj.legs : [])
    .map((l: any) => ({ place: String(l?.place ?? '').trim(), arrive: String(l?.arrive ?? ''), depart: String(l?.depart ?? '') }))
    .filter((l: any) => l.place && isDate(l.arrive) && isDate(l.depart))
    .sort((a: any, b: any) => a.arrive.localeCompare(b.arrive));
  if (!parsed.length) return null;

  const ms = (d: string) => new Date(d + 'T00:00:00').getTime();
  const between = (a: string, b: string) => Math.max(1, Math.round((ms(b) - ms(a)) / 86_400_000));
  // Each leg's length = time until the NEXT leg arrives, so the contiguous projection reproduces every
  // arrival date even when there are small gaps; the last leg uses its own depart date.
  const legs: TravelLeg[] = parsed.map((l: any, i: number) => ({
    id: `imp${i}_${Date.now()}`,
    place: l.place,
    days: i < parsed.length - 1 ? between(l.arrive, parsed[i + 1].arrive) : between(l.arrive, l.depart),
    climate: climateForPlace(l.place),
  }));
  const startInDays = Math.max(1, Math.round((ms(parsed[0].arrive) - ms(todayISO)) / 86_400_000));
  return { startInDays, legs };
}

export interface ResolvedLeg { place: string; from: string; to: string; climate: Climate; days: number }
export interface ItineraryProjection extends TravelProjection { legs: ResolvedLeg[] }

/**
 * Project across a MULTI-LEG itinerary with per-leg CLIMATE. Legs are contiguous from `startDate`.
 * During a leg the achievable load = normal × scenario × climate factor (heat penalty); days outside
 * every leg (before/after, or home gaps) carry the normal load. This is the travel-mode projection.
 */
export function projectTravelItinerary(
  hist: DailyLoad[],
  startDate: Date,
  legs: TravelLeg[],
  postTripDays = 21,
): ItineraryProjection | null {
  if (!hist.length || !legs.length) return null;

  const loadByDay = new Map<string, number>(hist.map(d => [d.date, d.load]));
  const today = hist[hist.length - 1];
  const recent = hist.slice(-22, -1).map(d => d.load).filter(v => v >= 0);
  const normalDailyLoad = recent.length ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length) : today.load;

  // Resolve contiguous leg date ranges from the start date.
  const resolved: ResolvedLeg[] = [];
  let cur = atMidnight(dstr(startDate));
  for (const lg of legs) {
    const d = Math.max(1, Math.round(lg.days));
    const from = new Date(cur);
    const to = new Date(cur.getTime() + (d - 1) * 86_400_000);
    resolved.push({ place: lg.place || 'Leg', from: dstr(from), to: dstr(to), climate: lg.climate, days: d });
    cur = new Date(to.getTime() + 86_400_000);
  }
  const tripStart  = resolved[0].from;
  const tripEnd    = resolved[resolved.length - 1].to;
  const horizonEnd = dstr(new Date(atMidnight(tripEnd).getTime() + postTripDays * 86_400_000));

  const climateOf = (isoDay: string): Climate | null => {
    for (const r of resolved) if (isoDay >= r.from && isoDay <= r.to) return r.climate;
    return null;
  };

  const todayDate = atMidnight(today.date);
  const horizonMs = atMidnight(horizonEnd).getTime();
  const scenarios = {} as Record<TravelScenario, DailyLoad[]>;
  for (const sc of TRAVEL_SCENARIOS) {
    const m = new Map(loadByDay);
    const d = new Date(todayDate.getTime() + 86_400_000);
    while (d.getTime() <= horizonMs) {
      const clim = climateOf(dstr(d));
      let load = normalDailyLoad;
      if (clim) {
        const heat = CLIMATE_LOAD_FACTOR[clim];
        load = sc === 'rest'
          ? Math.max(TRIP_REST_FLOOR, Math.round(normalDailyLoad * TRIP_FACTOR.rest * heat))
          : Math.round(normalDailyLoad * TRIP_FACTOR[sc] * heat);
      }
      m.set(dstr(d), load);
      d.setDate(d.getDate() + 1);
    }
    scenarios[sc] = computeTrainingLoadSeries(m, todayDate, atMidnight(horizonEnd));
  }

  return { scenarios, normalDailyLoad, today, tripStart, tripEnd, horizonEnd, legs: resolved };
}
