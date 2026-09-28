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
  type: number;   // ORS maneuver code (0 left, 1 right, 6 continue, 10 arrive, 12/13 keep left/right, …)
  wt?: number;    // ORS waytype at the maneuver (internal, for cue post-processing — not sent to the watch)
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

// ── Turn-direction sanity check ────────────────────────────────────────────────
// ORS occasionally reports the wrong turn WORD — a clear single turn where the path bends RIGHT but the
// instruction reads "Turn left" (and vice-versa). Since the watch speaks the instruction verbatim, that hands
// the runner a wrong left/right. Cross-check each clear turn against the GEOMETRY (bearing in vs bearing out at
// the maneuver, sampled ~20 m either side) and flip the direction word only when they clearly disagree.
function bearingDeg(a: number[], b: number[]): number {
  const toR = Math.PI / 180;
  const dLon = (b[0] - a[0]) * toR, la = a[1] * toR, lb = b[1] * toR;
  const y = Math.sin(dLon) * Math.cos(lb);
  const x = Math.cos(la) * Math.sin(lb) - Math.sin(la) * Math.cos(lb) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
// Walk ~wantM metres from index i in the given direction and return that point (for stable bearings on dense geometry).
function ptAlong(coords: number[][], i: number, dir: 1 | -1, wantM: number): number[] {
  let acc = 0, k = i;
  while (k + dir >= 0 && k + dir < coords.length) { acc += distM(coords[k], coords[k + dir]); k += dir; if (acc >= wantM) break; }
  return coords[k];
}
const TURN_TYPES = new Set([0, 1, 2, 3, 4, 5]);   // ORS maneuver types: turn / sharp / slight, left & right
function swapLR(text: string, to: 'left' | 'right'): string {
  const from = to === 'left' ? /\bright\b/gi : /\bleft\b/gi;
  return text.replace(from, m => (m[0] === m[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to));
}
function correctTurnDirections(steps: RouteStep[], coords: number[][]): RouteStep[] {
  if (coords.length < 3) return steps;
  return steps.map(s => {
    if (!TURN_TYPES.has(s.type)) return s;
    const p = coords[s.i]; if (!p) return s;
    const before = ptAlong(coords, s.i, -1, 20), after = ptAlong(coords, s.i, 1, 20);
    if (before === p || after === p) return s;
    let delta = bearingDeg(p, after) - bearingDeg(before, p);
    while (delta > 180) delta -= 360; while (delta < -180) delta += 360;
    if (Math.abs(delta) < 30) return s;                          // too gentle to be sure → trust ORS
    const geomRight = delta > 0;                                 // clockwise bearing change = right turn
    const hasLeft = /\bleft\b/i.test(s.text), hasRight = /\bright\b/i.test(s.text);
    if (geomRight && hasLeft && !hasRight)  return { ...s, text: swapLR(s.text, 'right') };
    if (!geomRight && hasRight && !hasLeft) return { ...s, text: swapLR(s.text, 'left') };
    return s;                                                    // agrees, or ambiguous (both words) → leave it
  });
}

// ── Spoken-cue post-processing (2026-09-28, Geert's run feedback) ──────────────────────────────────────────────
// The watch speaks every step verbatim from 40 m out, so (1) a ROAD CROSSING — ORS: "turn left" onto the road,
// then 15 m later "turn right" off it — came out as two rapid-fire turns, and (2) at a FORK between unnamed paths
// ORS often emits NO step at all (same-name continuation), leaving "straight on while the main track bends left"
// unguided. ORS waytype (1 state road, 2 road, 3 street, 4 path, 5 track, 6 cycleway, 7 footway, 8 steps)
// marks where the route moves onto a different kind of way — a fork/junction when no step is already there.
const WT_NAME: Record<number, string> = { 1: 'road', 2: 'road', 3: 'street', 4: 'path', 5: 'track', 6: 'cycle path', 7: 'footpath', 8: 'steps' };
const ROADISH = new Set([1, 2, 3]);
const SIDE_TYPES = new Set([0, 1, 2, 3, 4, 5, 12, 13]);   // maneuvers that carry a left/right
function cumDist(coords: number[][]): number[] {
  const c = [0]; for (let k = 1; k < coords.length; k++) c.push(c[k - 1] + distM(coords[k - 1], coords[k])); return c;
}
function turnDelta(coords: number[][], iIn: number, iOut: number): number | null {
  const before = ptAlong(coords, iIn, -1, 20), after = ptAlong(coords, iOut, 1, 20);
  if (before === coords[iIn] || after === coords[iOut]) return null;
  let d = bearingDeg(coords[iOut], after) - bearingDeg(before, coords[iIn]);
  while (d > 180) d -= 360; while (d < -180) d += 360;
  return d;                                                     // + = clockwise = right
}
function wtAt(i: number, wt: number[][]): number | undefined {
  for (const [a, b, v] of wt) if (i >= a && i < b) return v;
  return undefined;
}
/** Tag each step with the waytype it leads onto, and add Keep/Continue cues at unguided waytype changes. */
function addForkCues(steps: RouteStep[], coords: number[][], wt: number[][]): RouteStep[] {
  const out = steps.map(s => ({ ...s, wt: wtAt(s.i, wt) }));
  if (coords.length < 3 || wt.length < 2) return out;
  const cum = cumDist(coords), total = cum[cum.length - 1];
  const added: RouteStep[] = [];
  for (let k = 0; k + 1 < wt.length; k++) {
    const from = wt[k][2], to = wt[k + 1][2], i = wt[k + 1][0];
    if (from === to || !WT_NAME[from] || !WT_NAME[to]) continue;
    if (ROADISH.has(from) && ROADISH.has(to)) continue;        // road re-classification, not a fork
    if (i <= 0 || i >= coords.length - 1 || cum[i] < 30 || total - cum[i] < 30) continue;
    const near = (x: RouteStep) => Math.abs(cum[Math.min(x.i, cum.length - 1)] - cum[i]) < 30;
    if (out.some(near) || added.some(x => Math.abs(cum[x.i] - cum[i]) < 60)) continue;   // ORS already guides it
    const d = turnDelta(coords, i, i);
    if (d == null) continue;
    const onto = ` onto the ${WT_NAME[to]}`;
    const [text, type] = Math.abs(d) < 20 ? [`Continue straight${onto}`, 6]
      : Math.abs(d) < 60 ? [`Keep ${d > 0 ? 'right' : 'left'}${onto}`, d > 0 ? 13 : 12]
      : [`Turn ${d > 0 ? 'right' : 'left'}${onto}`, d > 0 ? 1 : 0];
    added.push({ i, text, dist: 0, type, wt: to });
  }
  return [...out, ...added].sort((a, b) => a.i - b.i);
}
/** Merge two maneuvers ≤40 m apart into ONE cue: a road crossing (net heading ≈ unchanged) or one net turn. */
function mergeCloseTurns(steps: RouteStep[], coords: number[][]): RouteStep[] {
  if (coords.length < 3) return steps;
  const cum = cumDist(coords);
  const out: RouteStep[] = [];
  for (let k = 0; k < steps.length; k++) {
    const a = steps[k], b = steps[k + 1];
    if (!b || !SIDE_TYPES.has(a.type) || !SIDE_TYPES.has(b.type) || Math.abs(cum[b.i] - cum[a.i]) > 40) { out.push(a); continue; }
    const net = turnDelta(coords, a.i, b.i);
    if (net == null) { out.push(a); continue; }
    const sideOf = (t: string) => /\bleft\b/i.test(t) ? 'left' : /\bright\b/i.test(t) ? 'right' : null;
    const aSide = sideOf(a.text), bSide = sideOf(b.text);
    const bKeep = b.type === 12 || b.type === 13;               // b is a FORK decision — never fold it away
    const onto = (/\bonto (.+)$/i.exec(b.text)?.[1]) ?? '';
    // Both decisions in one utterance: "Turn right, then keep left onto Bospad".
    const compound = () => `${a.text.replace(/\s+onto\s.+$/i, '')}, then ${b.text.charAt(0).toLowerCase()}${b.text.slice(1)}`;
    let text: string, type: number;
    if (aSide && bSide && aSide !== bSide) {
      if (Math.abs(net) < 35 && !bKeep) {                       // off one way and straight onto the next: a crossing
        const road = a.wt == null || ROADISH.has(a.wt);         // what you walk along between the two turns
        text = road ? `Cross the road slightly to the ${aSide}` : `Jog ${aSide}, then continue straight`;
        type = 6;
      } else { text = compound(); type = b.type; }              // opposite sides + a real change / a fork: say both
    } else if (Math.abs(net) >= 35) {                           // same side (or one unsided): ONE net turn
      const side = net > 0 ? 'right' : 'left';
      text = `${Math.abs(net) > 120 ? 'Turn sharp' : 'Turn'} ${side}${onto ? ` onto ${onto}` : ''}`;
      type = net > 0 ? (Math.abs(net) > 120 ? 3 : 1) : (Math.abs(net) > 120 ? 2 : 0);
    } else { text = compound(); type = b.type; }
    out.push({ ...a, text, type, dist: a.dist + b.dist, wt: b.wt });
    k++;                                                        // b is folded into a
  }
  return out;
}

// Metres from point p to segment a→b (local equirectangular — fine at these few-hundred-metre scales).
function segDistM(p: number[], a: number[], b: number[]): number {
  const k = 111320, cl = Math.cos(a[1] * Math.PI / 180);
  const bx = (b[0] - a[0]) * cl * k, by = (b[1] - a[1]) * k, px = (p[0] - a[0]) * cl * k, py = (p[1] - a[1]) * k;
  const L = bx * bx + by * by;
  const t = L > 0 ? Math.max(0, Math.min(1, (px * bx + py * by) / L)) : 0;
  return Math.hypot(px - t * bx, py - t * by);
}

// round_trip sometimes runs OUT to a dead-end waypoint and straight back over the same road — a short
// out-and-back "appendix" hanging off the loop. Detect it as a point the path REVISITS within a short
// excursion, and excise the excursion (keeping the route otherwise intact + step indices remapped). Bounded
// so it only removes small artifacts (<~350 m), never a genuine there-and-back leg you'd actually run.
function trimSpurs(coords: number[][], stepsIn: RouteStep[], wt: number[][] = []): { coords: number[][]; steps: RouteStep[]; trimmed: boolean } {
  const TOL = 18, MAX_SPUR = 900, WINDOW = 160;   // excise out-and-backs up to ~900 m of path (≈450 m out)
  const steps = addForkCues(stepsIn, coords, wt);   // on the ORIGINAL indices (waytype runs index these)
  const cs = coords.slice();
  const orig = coords.map((_, i) => i);          // original index living at each current position
  const spurs: { entry: number; exit: number }[] = [];   // ORIGINAL indices of each excised excursion's ends
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < cs.length - 2 && !changed; i++) {
      const jmax = Math.min(cs.length - 1, i + WINDOW);
      for (let j = i + 2; j <= jmax; j++) {
        if (distM(cs[i], cs[j]) < TOL) {                     // path returned to ~the same point
          let len = 0, out = 0, tip = i;
          for (let k = i; k < j; k++) {
            len += distM(cs[k], cs[k + 1]);
            const o = distM(cs[i], cs[k + 1]); if (o > out) { out = o; tip = k + 1; }
          }
          // A real spur goes OUT (≥30 m) and comes BACK THE SAME WAY. Without the first test, DENSE geometry
          // (vertices a few metres apart, at junctions and road crossings) passed the 18 m check and got cut —
          // dropping the turn steps on it. Without the second, an out-and-back that returns on a PARALLEL path
          // (the other canal bank, a cycle path beside the road) was cut out of the route entirely.
          let retraced = 0;
          for (let k = tip; k <= j; k++) {
            for (let q = i; q < tip; q++) if (segDistM(cs[k], cs[q], cs[q + 1]) < 8) { retraced++; break; }
          }
          if (len < MAX_SPUR && out >= 30 && retraced >= 0.7 * (j - tip + 1)) {
            spurs.push({ entry: orig[i], exit: orig[j] });
            cs.splice(i + 1, j - i); orig.splice(i + 1, j - i); changed = true; break;
          }
        }
      }
    }
  }
  if (cs.length === coords.length) return { coords, steps: mergeCloseTurns(correctTurnDirections(steps, coords), coords), trimmed: false };
  const o2n = new Map<number, number>(); orig.forEach((o, n) => o2n.set(o, n));
  // A step at a spur's EXIT (removed) lands on its entry; follow chains of nested spurs.
  const exitTo = new Map(spurs.map(x => [x.exit, x.entry]));
  const resolve = (o: number): number | undefined => {
    let x = o; for (let g = 0; g < 50 && !o2n.has(x) && exitTo.has(x); g++) x = exitTo.get(x)!;
    return o2n.get(x);
  };
  const entryIdx = new Set(spurs.map(x => resolve(x.entry)).filter((n): n is number => n != null));
  const remapped = steps.map(s => { const ni = resolve(s.i); return ni == null ? null : { ...s, i: ni }; })
    .filter((s): s is RouteStep => s != null);
  // Around a spur's entry the old steps described turning INTO the dead end / back out of it — both wrong once it's
  // cut (the exit vertex can survive a few metres on). Rebuild ONE cue per entry from the trimmed geometry
  // (keeping the exit step's "onto …"), or none if the route now runs straight through.
  const cumT = cumDist(cs);
  const entryOf = (st: RouteStep): number | undefined => {
    if (st.type === 11 || st.type === 10) return undefined;                             // depart / arrive stay
    for (const e of entryIdx) if (Math.abs(cumT[st.i] - cumT[e]) <= 25) return e;
    return undefined;
  };
  const newSteps: RouteStep[] = remapped.filter(st => entryOf(st) === undefined);
  for (const e of entryIdx) {
    const group = remapped.filter(st => entryOf(st) === e);
    if (!group.length) continue;
    const d = turnDelta(cs, e, e);
    if (d == null || Math.abs(d) < 30) continue;                                        // straight through → no cue
    const last = group[group.length - 1];
    const onto = /\bonto (.+)$/i.exec(last.text)?.[1];
    newSteps.push({ ...last, i: e, text: `Turn ${d > 0 ? 'right' : 'left'}${onto ? ` onto ${onto}` : ''}`, type: d > 0 ? 1 : 0,
      dist: group.reduce((a, x) => a + x.dist, 0) });
  }
  newSteps.sort((a, b) => a.i - b.i);
  return { coords: cs, steps: mergeCloseTurns(correctTurnDirections(newSteps, cs), cs), trimmed: true };
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
    options: { round_trip: { length: Math.round(opts.km * LOOP_UNDERSHOOT * 1000), points: opts.points ?? 5, seed: opts.seed ?? 1 } },
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
    const t = trimSpurs((f.geometry?.coordinates ?? []) as number[][], stepsFromFeature(f), f.properties?.extras?.waytype?.values ?? []);   // [lon,lat,ele]
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

// ORS round-trip / wedge loops OVERSHOOT the requested length (~15–25%), and the coach's target is already the
// full session (warm-up + drills + work + cool-down). So aim the loop sizing a bit UNDER target — better to
// land slightly short (finish with a lap near home) than to run long. Tunable; the ± control still lets the
// runner nudge, and point-to-point is unaffected (its distance is fixed by the endpoints).
const LOOP_UNDERSHOOT = 0.82;

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
  const km = opts.km * LOOP_UNDERSHOOT;   // aim under target so the overshoot lands the loop at/just-under the prescribed distance
  const out: RouteOption[] = [];
  for (let b = 0; b < 8; b++) {
    const deg = b * 45;
    let best: (RouteLoop & { reachKm: number }) | null = null;
    for (const sp of spreads) {
      const loop = await orsDirectionalLoop({
        lon: opts.lon, lat: opts.lat, headingDeg: deg,
        reachKm: Math.max(1, km * 0.24), spreadDeg: sp, profile: opts.profile,   // COMPACT lean, so Reach can push further
      });
      if (!loop || loop.coords.length < 2 || loop.distanceKm < km * 0.4) continue;
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
    const t = trimSpurs((f.geometry?.coordinates ?? []) as number[][], stepsFromFeature(f), f.properties?.extras?.waytype?.values ?? []);   // [lon,lat,ele]
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

/**
 * A point-to-point route from → to, optionally bowed out through a `via` waypoint so a short direct path can be
 * padded toward a target length. Same RouteLoop shape as a loop, so the UI treats both identically. The via
 * point is snapped to a nearby path (radiuses) to dodge ORS 2099 "no route" when it lands in a field/forest.
 */
export async function orsRouteVia(opts: {
  from: [number, number]; to: [number, number]; via?: [number, number]; profile?: RouteProfile;
}): Promise<RouteLoop | null> {
  const key = await getOrsApiKey();
  if (!key) return null;
  const profile = opts.profile ?? 'foot-hiking';
  const coordinates = opts.via ? [opts.from, opts.via, opts.to] : [opts.from, opts.to];
  const body: any = { coordinates, elevation: true, extra_info: ['waytype'] };
  if (opts.via) body.radiuses = [-1, 1500, -1];   // snap only the invented mid point; keep from/to exact
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
    for (const x of wt) { tot += x.distance; if (x.value === 4 || x.value === 5 || x.value === 7) trail += x.distance; }
    const t = trimSpurs((f.geometry?.coordinates ?? []) as number[][], stepsFromFeature(f), f.properties?.extras?.waytype?.values ?? []);
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

/**
 * Point-to-point options MATCHED to a target distance. Always offers the DIRECT route (its length is also the
 * shortest A→B possible). When the target is longer than direct, it also bows the route out through a point set
 * perpendicular to the A→B line — both sides × two magnitudes — to pad the length up toward the target. The
 * straight-bow height for a target T is h=√((T/2)²−(chord/2)²); real roads overshoot, so we aim a little under
 * and keep whatever actually comes back. Sorted by closeness to the target, so the first option is the best
 * match. Sequential (≤5 calls) to stay gentle on the free tier.
 */
export async function orsPointToPointOptions(opts: {
  from: [number, number]; to: [number, number]; km: number; profile?: RouteProfile;
}): Promise<RouteOption[]> {
  const [lonA, latA] = opts.from, [lonB, latB] = opts.to;
  const latMid = (latA + latB) / 2, cosL = Math.cos(latMid * Math.PI / 180);
  const kmPerLon = 111.32 * cosL, kmPerLat = 111.32;
  const bx = (lonB - lonA) * kmPerLon, by = (latB - latA) * kmPerLat;   // B relative to A, in km
  const chord = Math.hypot(bx, by) || 0.001;
  const brgAB = ((Math.atan2(bx, by) * 180 / Math.PI) + 360) % 360;     // travel bearing A→B
  const dir = DIRS[Math.round(brgAB / 45) % 8];

  const out: RouteOption[] = [];
  const direct = await orsRouteVia({ from: opts.from, to: opts.to, profile: opts.profile });
  if (direct && direct.coords.length >= 2) {
    out.push({ ...direct, seed: 0, headingDeg: Math.round(brgAB), heading: `${dir} · direct` });
  }
  const directKm = direct?.distanceKm ?? chord;
  if (opts.km > directKm * 1.1) {
    const mx = bx / 2, my = by / 2;                     // A→B midpoint (km, relative to A)
    const ux = -by / chord, uy = bx / chord;            // unit vector perpendicular to A→B
    const hFor = (T: number) => Math.sqrt(Math.max(0, (T / 2) ** 2 - (chord / 2) ** 2));
    const mags = [hFor(opts.km * 0.82), hFor(opts.km)];
    let seed = 1;
    for (const side of [-1, 1]) for (const h of mags) {
      if (h < 0.1) continue;
      const vx = mx + side * h * ux, vy = my + side * h * uy;
      const via: [number, number] = [lonA + vx / kmPerLon, latA + vy / kmPerLat];
      const r = await orsRouteVia({ from: opts.from, to: opts.to, via, profile: opts.profile });
      if (!r || r.coords.length < 2 || r.distanceKm < directKm * 1.02) continue;   // detour that added nothing → skip
      out.push({ ...r, seed, headingDeg: Math.round(brgAB), heading: `${side < 0 ? '↰' : '↱'} detour` });
      seed++;
    }
  }
  out.sort((p, q) => Math.abs(p.distanceKm - opts.km) - Math.abs(q.distanceKm - opts.km));
  return out;
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
