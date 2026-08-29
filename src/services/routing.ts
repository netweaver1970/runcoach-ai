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
export interface RouteStep {
  i: number;      // index into `coords` where the maneuver happens (way_points[0])
  text: string;   // ORS instruction, e.g. "Turn left onto Main Street"
  dist: number;   // metres this step covers (≈ distance to the next maneuver)
  type: number;   // ORS maneuver code (0 left, 1 right, 6 continue, 10 arrive, …)
}
export interface RouteLoop {
  distanceKm: number;
  ascentM: number;
  descentM: number;             // total descent (m)
  coords: [number, number][];   // [lon, lat] polyline
  trailPct: number;             // share on paths/tracks/footways
  elev: number[];               // downsampled elevation profile (m) for the mini chart
  steps?: RouteStep[];          // turn-by-turn maneuvers — drives the watch voice/haptic guidance
}

// Equirectangular metres between two points ([lon,lat,…] — extra dims ignored). Accurate at loop scale, cheap.
function distM(a: number[], b: number[]): number {
  const toR = Math.PI / 180, R = 6371000;
  const x = (b[0] - a[0]) * toR * Math.cos(((a[1] + b[1]) / 2) * toR);
  const y = (b[1] - a[1]) * toR;
  return Math.hypot(x, y) * R;
}
const pathKm = (cs: number[][]) => { let m = 0; for (let i = 1; i < cs.length; i++) m += distM(cs[i - 1], cs[i]); return m / 1000; };

// Ascent/descent (from the per-point elevation) + a downsampled profile for the little elevation chart.
function elevStats(ele: number[]): { ascentM: number; descentM: number; elev: number[] } {
  let asc = 0, desc = 0;
  for (let i = 1; i < ele.length; i++) { const d = ele[i] - ele[i - 1]; if (d > 0) asc += d; else desc -= d; }
  const N = 48, out: number[] = [];
  if (ele.length <= N) out.push(...ele);
  else for (let k = 0; k < N; k++) out.push(ele[Math.floor((k / (N - 1)) * (ele.length - 1))]);
  return { ascentM: Math.round(asc), descentM: Math.round(desc), elev: out.map(v => Math.round(v)) };
}

// round_trip sometimes runs OUT to a dead-end waypoint and straight back over the same road — a short
// out-and-back "appendix" hanging off the loop. Detect it as a point the path REVISITS within a short
// excursion, and excise the excursion (keeping the route otherwise intact + step indices remapped). Bounded
// so it only removes small artifacts (<~350 m), never a genuine there-and-back leg you'd actually run.
function trimSpurs(coords: number[][], steps: RouteStep[]): { coords: number[][]; steps: RouteStep[]; trimmed: boolean } {
  const TOL = 18, MAX_SPUR = 900, WINDOW = 160;   // excise out-and-backs up to ~900 m of path (≈450 m out)
  const cs = coords.slice();
  const orig = coords.map((_, i) => i);          // original index living at each current position
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < cs.length - 2 && !changed; i++) {
      const jmax = Math.min(cs.length - 1, i + WINDOW);
      for (let j = i + 2; j <= jmax; j++) {
        if (distM(cs[i], cs[j]) < TOL) {                     // path returned to ~the same point
          let len = 0; for (let k = i; k < j; k++) len += distM(cs[k], cs[k + 1]);
          if (len < MAX_SPUR) { cs.splice(i + 1, j - i); orig.splice(i + 1, j - i); changed = true; break; }
        }
      }
    }
  }
  if (cs.length === coords.length) return { coords, steps, trimmed: false };
  const o2n = new Map<number, number>(); orig.forEach((o, n) => o2n.set(o, n));
  const newSteps = steps.map(s => { const ni = o2n.get(s.i); return ni == null ? null : { ...s, i: ni }; })
    .filter((s): s is RouteStep => s != null);
  return { coords: cs, steps: newSteps, trimmed: true };
}

// ORS GeoJSON carries turn-by-turn under properties.segments[].steps[] (instructions are on by default). Each
// step's way_points index into the geometry, so the maneuver's coordinate = coords[step.way_points[0]].
function stepsFromFeature(f: any): RouteStep[] {
  const out: RouteStep[] = [];
  for (const seg of (f?.properties?.segments ?? [])) {
    for (const st of (seg.steps ?? [])) {
      const text = String(st.instruction ?? '').trim();
      if (!text) continue;
      out.push({ i: st.way_points?.[0] ?? 0, text, dist: Math.round(st.distance ?? 0), type: st.type ?? 0 });
    }
  }
  return out;
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
    elevation: true,
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
    const t = trimSpurs((f.geometry?.coordinates ?? []) as number[][], stepsFromFeature(f));   // [lon,lat,ele]
    const es = elevStats(t.coords.map(c => c[2] ?? 0));
    return {
      distanceKm: t.trimmed ? pathKm(t.coords) : (sm.distance ?? 0) / 1000,
      ascentM: es.ascentM,
      descentM: es.descentM,
      coords: t.coords.map(c => [c[0], c[1]] as [number, number]),
      trailPct: tot > 0 ? Math.round((trail / tot) * 100) : 0,
      elev: es.elev,
      steps: t.steps,
    };
  } catch { return null; }
}

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export interface RouteOption extends RouteLoop { seed: number; headingDeg: number; heading: string; }

/**
 * Generate several loops (one per seed) and LABEL each by the compass direction it heads — the basis for the
 * Garmin-style "pick a heading / explore that way" chooser (the runner usually knows which way the green is).
 * Drops loops whose length is wildly off target (round_trip occasionally overshoots badly). Sequential to stay
 * gentle on the free-tier rate limit.
 */
export async function orsRoundTripOptions(opts: {
  lon: number; lat: number; km: number; count?: number; profile?: RouteProfile;
}): Promise<RouteOption[]> {
  const count = opts.count ?? 6;
  const out: RouteOption[] = [];
  for (let seed = 1; seed <= count; seed++) {
    const loop = await orsRoundTrip({ lon: opts.lon, lat: opts.lat, km: opts.km, seed, profile: opts.profile });
    if (!loop || loop.coords.length < 2) continue;
    if (loop.distanceKm > opts.km * 1.6 || loop.distanceKm < opts.km * 0.6) continue;   // drop gross over/undershoots
    let mx = 0, my = 0; for (const c of loop.coords) { mx += c[0]; my += c[1]; }
    mx /= loop.coords.length; my /= loop.coords.length;
    const dLon = (mx - opts.lon) * Math.cos(opts.lat * Math.PI / 180), dLat = my - opts.lat;
    const brg = ((Math.atan2(dLon, dLat) * 180 / Math.PI) + 360) % 360;
    out.push({ ...loop, seed, headingDeg: Math.round(brg), heading: DIRS[Math.round(brg / 45) % 8] });
  }
  return out;
}

/**
 * The heading chooser: ONE genuinely-directional loop per compass point (N..NW), so all eight directions are
 * offered where routable and picking a heading actually goes that way. round_trip's seed loops are centred on
 * the start (centroid ≈ start → the compass label is noise, and whole directions like W/SW/NW never appear), so
 * we steer a wedge loop toward each of the 8 bearings instead. Sequential to stay gentle on the free tier.
 */
export async function orsHeadingOptions(opts: {
  lon: number; lat: number; km: number; profile?: RouteProfile; hilliness?: 'flat' | 'any' | 'hilly';
}): Promise<RouteOption[]> {
  const hill = opts.hilliness ?? 'any';
  // ORS has no "avoid hills" for foot profiles, so approximate it: for flat/hilly, try two wedge widths per
  // direction and keep the one with least / most ascent. 'any' does a single shape (half the calls).
  const spreads = hill === 'any' ? [86] : [86, 66];
  const out: RouteOption[] = [];
  for (let b = 0; b < 8; b++) {
    const deg = b * 45;
    let best: (RouteLoop & { reachKm: number }) | null = null;
    for (const sp of spreads) {
      const loop = await orsDirectionalLoop({
        lon: opts.lon, lat: opts.lat, headingDeg: deg,
        reachKm: Math.max(1, opts.km * 0.24), spreadDeg: sp, profile: opts.profile,   // COMPACT lean, so Reach can push further
      });
      if (!loop || loop.coords.length < 2 || loop.distanceKm < opts.km * 0.4) continue;
      if (!best || (hill === 'flat' && loop.ascentM < best.ascentM) || (hill === 'hilly' && loop.ascentM > best.ascentM)) best = loop;
    }
    if (best) out.push({ ...best, seed: deg, headingDeg: deg, heading: DIRS[b] });
  }
  return out;
}

/**
 * Actively STEER a loop toward a bearing (not a random seed): two waypoints in a wedge around `headingDeg` at
 * `reachKm` out, routed as a loop. A narrower wedge + bigger reach pushes the far point FURTHER from home in
 * that direction — the "amplify / explore further" control. `radiuses` snaps a waypoint that lands in a field
 * or forest to the nearest path (avoids ORS 2099 "no route"). Returns the loop + how far it actually reaches.
 */
export async function orsDirectionalLoop(opts: {
  lon: number; lat: number; headingDeg: number; reachKm: number; spreadDeg?: number; profile?: RouteProfile;
}): Promise<(RouteLoop & { reachKm: number }) | null> {
  const key = await getOrsApiKey();
  if (!key) return null;
  const spread = opts.spreadDeg ?? 60;
  const kmLat = 1 / 111.32, kmLon = 1 / (111.32 * Math.cos(opts.lat * Math.PI / 180));
  const proj = (brg: number, d: number): [number, number] => {
    const r = (brg * Math.PI) / 180;
    return [opts.lon + d * kmLon * Math.sin(r), opts.lat + d * kmLat * Math.cos(r)];
  };
  const v1 = proj(opts.headingDeg - spread / 2, opts.reachKm);
  const v2 = proj(opts.headingDeg + spread / 2, opts.reachKm);
  const profile = opts.profile ?? 'foot-hiking';
  try {
    const res = await fetch(`${ORS_BASE}/${profile}/geojson`, {
      method: 'POST',
      headers: { Authorization: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinates: [[opts.lon, opts.lat], v1, v2, [opts.lon, opts.lat]], radiuses: [-1, 1500, 1500, -1], elevation: true, extra_info: ['waytype'] }),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    const f = j?.features?.[0];
    if (!f) return null;
    const sm = f.properties?.summary ?? {};
    const wt: any[] = f.properties?.extras?.waytype?.summary ?? [];
    let trail = 0, tot = 0;
    for (const x of wt) { tot += x.distance; if (x.value === 4 || x.value === 5 || x.value === 7) trail += x.distance; }
    const t = trimSpurs((f.geometry?.coordinates ?? []) as number[][], stepsFromFeature(f));   // [lon,lat,ele]
    const coords = t.coords.map(c => [c[0], c[1]] as [number, number]);
    const es = elevStats(t.coords.map(c => c[2] ?? 0));
    let maxD = 0;
    for (const cc of coords) { const dx = (cc[0] - opts.lon) * 111.32 * Math.cos(opts.lat * Math.PI / 180), dy = (cc[1] - opts.lat) * 111.32; maxD = Math.max(maxD, Math.hypot(dx, dy)); }
    return {
      distanceKm: t.trimmed ? pathKm(t.coords) : (sm.distance ?? 0) / 1000,
      ascentM: es.ascentM,
      descentM: es.descentM,
      coords,
      trailPct: tot > 0 ? Math.round((trail / tot) * 100) : 0,
      elev: es.elev,
      steps: t.steps,
      reachKm: Math.round(maxD * 10) / 10,
    };
  } catch { return null; }
}

// Type-ahead place search via Photon (Komoot's free, keyless OSM autocomplete). Biased toward `near` so local
// hits rank first. Returns a clean label + coords for the Wayfinder address box.
export interface GeoHit { label: string; lon: number; lat: number }
export async function geocodeSearch(text: string, near?: { lon: number; lat: number }): Promise<GeoHit[]> {
  const q = text.trim(); if (q.length < 3) return [];
  const bias = near ? `&lat=${near.lat}&lon=${near.lon}` : '';
  try {
    const res = await fetch(`https://photon.komoot.io/api?q=${encodeURIComponent(q)}&limit=6&lang=en${bias}`);
    if (!res.ok) return [];
    const j: any = await res.json();
    const seen = new Set<string>(); const out: GeoHit[] = [];
    for (const f of (j.features ?? [])) {
      const p = f.properties ?? {}, cc = f.geometry?.coordinates;
      if (!cc || cc.length < 2) continue;
      const label = [p.name, p.street && p.street !== p.name ? p.street : null, p.city || p.county || p.state,
        String(p.country || '').split('/')[0].trim()].filter(Boolean).join(', ');
      if (!label || seen.has(label)) continue;
      seen.add(label); out.push({ label, lon: cc[0], lat: cc[1] });
    }
    return out;
  } catch { return []; }
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
