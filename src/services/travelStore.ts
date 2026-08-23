/**
 * Persistence for Travel mode: a LIBRARY of named trips (each = dated legs + a return-home date), plus
 * which one is active/being-edited. Backed up via backup.ts (same filename as before). Named trips are
 * also surfaced to the LLM coach (see activeTripSummary / summariseTripForLLM) so it plans around travel.
 */
import * as FileSystem from 'expo-file-system';
import { TravelLeg, climateForPlace, summariseTripForLLM } from './travelProjection';

export const TRAVEL_ITINERARY_FILE = `${FileSystem.documentDirectory}runcoach-travel-itinerary.json`;

export interface SavedTrip { id: string; name: string; legs: TravelLeg[]; returnDate: string; updatedAt: string }
export interface TravelData { trips: SavedTrip[]; activeId: string | null }

const p2 = (n: number) => String(n).padStart(2, '0');
const dstr = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const addDays = (iso: string, n: number) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return dstr(d); };

/** A fresh empty trip anchored ~3 weeks out, one blank flight leg. */
export function newTrip(name = 'New trip', now = new Date()): SavedTrip {
  const id = `t${now.getTime()}`;
  const a1 = addDays(dstr(now), 21);
  return {
    id, name,
    legs: [{ id: `l${now.getTime()}`, mode: 'flight', arrive: a1, place: '', climate: 'warm' }],
    returnDate: addDays(a1, 10),
    updatedAt: dstr(now),
  };
}

/** Seed library = the Singapore + Korea example, dated ~mid-September, so the screen isn't empty. */
function defaultData(now = new Date()): TravelData {
  const base = dstr(now);
  const a1 = addDays(base, 23), a2 = addDays(a1, 6);
  const trip: SavedTrip = {
    id: `t${now.getTime()}`, name: 'Asia trip',
    legs: [
      { id: 'sg', mode: 'flight', arrive: a1, place: 'Singapore', climate: 'tropical' },
      { id: 'kr', mode: 'flight', arrive: a2, place: 'Korea',     climate: 'warm' },
    ],
    returnDate: addDays(a2, 8),
    updatedAt: base,
  };
  return { trips: [trip], activeId: trip.id };
}

/** Migrate the OLD single-itinerary shape { startInDays, legs:[{place,days,climate}] } → one named trip. */
function migrateOld(old: any, now = new Date()): TravelData | null {
  if (!old || !Array.isArray(old.legs)) return null;
  const looksOld = typeof old.startInDays === 'number' && old.legs.some((l: any) => typeof l?.days === 'number' && !l?.arrive);
  if (!looksOld) return null;
  const base = dstr(now);
  let cur = addDays(base, Math.max(1, Math.round(old.startInDays)));
  const legs: TravelLeg[] = [];
  for (const l of old.legs) {
    const place = String(l?.place ?? '');
    legs.push({ id: l?.id ?? `l${legs.length}_${now.getTime()}`, mode: 'flight', arrive: cur, place, climate: l?.climate ?? climateForPlace(place) });
    cur = addDays(cur, Math.max(1, Math.round(l?.days ?? 5)));
  }
  const trip: SavedTrip = { id: `t${now.getTime()}`, name: 'My trip', legs, returnDate: cur, updatedAt: base };
  return { trips: [trip], activeId: trip.id };
}

export async function loadTravelData(): Promise<TravelData> {
  try {
    const info = await FileSystem.getInfoAsync(TRAVEL_ITINERARY_FILE);
    if (!info.exists) return defaultData();
    const parsed = JSON.parse(await FileSystem.readAsStringAsync(TRAVEL_ITINERARY_FILE));
    if (parsed && Array.isArray(parsed.trips) && parsed.trips.length) {
      const activeId = parsed.activeId && parsed.trips.some((t: any) => t.id === parsed.activeId) ? parsed.activeId : parsed.trips[0].id;
      return { trips: parsed.trips as SavedTrip[], activeId };
    }
    const migrated = migrateOld(parsed);
    if (migrated) { await saveTravelData(migrated); return migrated; }
    return defaultData();
  } catch { return defaultData(); }
}

export async function saveTravelData(data: TravelData): Promise<void> {
  try { await FileSystem.writeAsStringAsync(TRAVEL_ITINERARY_FILE, JSON.stringify(data)); } catch { /* ignore */ }
}

/**
 * Concise LLM-facing summary of every not-yet-finished saved trip (nearest first), for injection into the
 * coach context. null if none upcoming. Used so chat / run analysis / the coach all know about travel.
 */
export async function activeTripSummary(todayISO: string): Promise<string | null> {
  try {
    const data = await loadTravelData();
    const lines = data.trips
      .map(t => summariseTripForLLM(t.name, t.legs, t.returnDate, todayISO))
      .filter((x): x is string => !!x);
    return lines.length ? lines.join('\n') : null;
  } catch { return null; }
}
