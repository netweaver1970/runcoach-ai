/**
 * Wayfinder routing — OpenRouteService round-trip loop generation. See the design doc: the coach's prescribed
 * distance seeds a loop from the runner's location, weighted toward their surface/scenery preferences.
 * v0: key storage + a working round_trip call. Map screen + preference UI + coach hook come next.
 */
import * as SecureStore from 'expo-secure-store';

const ORS_KEY_STORE = 'ors_api_key_v1';
// api.openrouteservice.org is DEPRECATED (HeiGIT unified all APIs under api.heigit.org). Service name is
// "openrouteservice", not "ors"; round_trip rides on the directions endpoint.
export const ORS_BASE = 'https://api.heigit.org/openrouteservice/v2/directions';

export async function getOrsApiKey(): Promise<string> {
  try { return (await SecureStore.getItemAsync(ORS_KEY_STORE)) ?? ''; } catch { return ''; }
}
export async function setOrsApiKey(v: string): Promise<void> {
  try {
    if (v.trim()) await SecureStore.setItemAsync(ORS_KEY_STORE, v.trim());
    else await SecureStore.deleteItemAsync(ORS_KEY_STORE);
  } catch { /* ignore */ }
}
export async function hasOrsApiKey(): Promise<boolean> { return !!(await getOrsApiKey()); }

export type RouteProfile = 'foot-hiking' | 'foot-walking';
export interface RouteLoop {
  distanceKm: number;
  ascentM: number;
  coords: [number, number][];   // [lon, lat] polyline
  trailPct: number;             // share on paths/tracks/footways
}

/**
 * A round-trip loop from a start point toward a target distance. `foot-hiking` favours paths/tracks (trails);
 * `foot-walking` leans to roads. round_trip length is APPROXIMATE (it overshoots ~10–30%), so callers should
 * request a bit under target or generate a few seeds and show the real lengths. Returns null on error / no key.
 */
export async function orsRoundTrip(opts: {
  lon: number; lat: number; km: number;
  seed?: number; points?: number; profile?: RouteProfile;
}): Promise<RouteLoop | null> {
  const key = await getOrsApiKey();
  if (!key) return null;
  const profile = opts.profile ?? 'foot-hiking';   // trails matter → hike profile by default
  const body = {
    coordinates: [[opts.lon, opts.lat]],
    options: { round_trip: { length: Math.round(opts.km * 1000), points: opts.points ?? 5, seed: opts.seed ?? 1 } },
    extra_info: ['waytype'],
  };
  try {
    const res = await fetch(`${ORS_BASE}/${profile}/geojson`, {
      method: 'POST',
      headers: { Authorization: key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    const f = j?.features?.[0];
    if (!f) return null;
    const sm = f.properties?.summary ?? {};
    const wt: any[] = f.properties?.extras?.waytype?.summary ?? [];
    let trail = 0, tot = 0;
    for (const x of wt) { tot += x.distance; if (x.value === 4 || x.value === 5 || x.value === 7) trail += x.distance; } // path/track/footway
    return {
      distanceKm: (sm.distance ?? 0) / 1000,
      ascentM: Math.round(sm.ascent ?? 0),
      coords: (f.geometry?.coordinates ?? []).map((c: number[]) => [c[0], c[1]] as [number, number]),
      trailPct: tot > 0 ? Math.round((trail / tot) * 100) : 0,
    };
  } catch { return null; }
}

/** Quick validity check for the Settings "Save" flow — a tiny round_trip against a fixed point. */
export async function validateOrsKey(key: string): Promise<{ ok: boolean; error?: string }> {
  if (!key.trim()) return { ok: false, error: 'Enter a key first.' };
  try {
    const res = await fetch(`${ORS_BASE}/foot-walking/geojson`, {
      method: 'POST',
      headers: { Authorization: key.trim(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinates: [[3.7436, 50.9767]], options: { round_trip: { length: 2000, points: 3, seed: 1 } } }),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'Key rejected (401/403) — check you copied it fully.' };
    return { ok: false, error: `Server returned ${res.status}.` };
  } catch (e: any) { return { ok: false, error: e?.message ?? 'Network error.' }; }
}
