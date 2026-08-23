/**
 * Real flight-number lookup via AeroDataBox (RapidAPI): flight number + date → arrival city + arrival date.
 * The API key is USER-supplied (Settings → Flight Lookup), stored in the Keychain — never hard-coded here.
 * Free tier is enough for occasional trip planning. When no key is set (or the flight isn't found), the
 * Travel screen falls back to the LLM's best guess.
 *
 * Get a key: https://rapidapi.com/aedbx-aedbx/api/aerodatabox  → subscribe (free Basic) → copy the key.
 */
import * as SecureStore from 'expo-secure-store';
import { Climate, climateForPlace } from './travelProjection';

const KEY_STORE = 'flight_api_key_v1';
const HOST = 'aerodatabox.p.rapidapi.com';

export async function getFlightApiKey(): Promise<string> {
  try { return (await SecureStore.getItemAsync(KEY_STORE)) ?? ''; } catch { return ''; }
}
export async function setFlightApiKey(v: string): Promise<void> {
  try { if (v.trim()) await SecureStore.setItemAsync(KEY_STORE, v.trim()); else await SecureStore.deleteItemAsync(KEY_STORE); } catch { /* ignore */ }
}

export interface FlightResult { place: string; arrive: string; climate: Climate }
export type FlightLookup =
  | { ok: true; result: FlightResult }
  | { ok: false; reason: 'no-key' | 'not-found' | 'error'; message?: string };

const isDate = (v: any): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v);

/**
 * Look up one flight (e.g. "SQ337") on a given date. Returns the ARRIVAL city + local arrival date.
 * Never throws — always resolves to a FlightLookup so the caller can decide whether to fall back.
 */
export async function lookupFlightReal(flightNo: string, dateISO: string): Promise<FlightLookup> {
  const key = await getFlightApiKey();
  if (!key) return { ok: false, reason: 'no-key' };
  const num = flightNo.replace(/\s/g, '').toUpperCase();
  if (!num) return { ok: false, reason: 'not-found' };
  try {
    const url = `https://${HOST}/flights/number/${encodeURIComponent(num)}/${dateISO}?withAircraftImage=false&withLocation=false`;
    const res = await fetch(url, { headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': HOST } });
    if (res.status === 204 || res.status === 404) return { ok: false, reason: 'not-found' };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'error', message: 'Flight API key rejected (401/403). Check the key in Settings.' };
    if (res.status === 429) return { ok: false, reason: 'error', message: 'Flight API rate limit reached — try again later.' };
    if (!res.ok) return { ok: false, reason: 'error', message: `Flight API error (HTTP ${res.status}).` };
    const data = await res.json();
    // AeroDataBox returns an array of matching flight segments (codeshares/legs); take the first with arrival.
    const flights: any[] = Array.isArray(data) ? data : (Array.isArray(data?.flights) ? data.flights : (data ? [data] : []));
    const f = flights.find(x => x?.arrival?.airport);
    const arr = f?.arrival;
    const city: string = arr?.airport?.municipalityName || arr?.airport?.shortName || arr?.airport?.name || '';
    if (!city) return { ok: false, reason: 'not-found' };
    const t = arr?.scheduledTime?.local || arr?.revisedTime?.local || arr?.predictedTime?.local || arr?.actualTime?.local || '';
    const arrive = isDate(t) ? t.slice(0, 10) : dateISO;
    return { ok: true, result: { place: city, arrive, climate: climateForPlace(city) } };
  } catch (e: any) {
    return { ok: false, reason: 'error', message: e?.message ?? 'Network error reaching the flight API.' };
  }
}
