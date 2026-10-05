/**
 * Fork cues from the REAL trail network. ORS gives no instruction where a trail splits into two branches of the
 * same kind (an unnamed path forking into two unnamed paths is, to its instruction engine, "the same way
 * continuing"), and our waytype-change heuristic (routing.ts addForkCues) can't see a path→path split either —
 * Geert, 2026-09-28: "in the forest the trail was splitting into 2 and there was no cue".
 *
 * When a route is SENT to the watch, fetch the OpenStreetMap ways within 20 m of it (Overpass — public, no key;
 * the route shape goes there just as it already goes to ORS), find every junction the route passes through, and
 * where another branch leaves within 60° of the one we take — i.e. it could be confused with ours — add
 * "At the fork, keep left / keep right / take the middle path". Clear crossings (≥60° apart) get no cue, so the
 * forest doesn't turn into a chatter of instructions. Best-effort: any failure sends the route unchanged.
 * Privacy: the first/last 150 m (usually home) are left out of the query; a single endpoint (FOSSGIS-run).
 */
import type { RouteLoop, RouteStep } from './routing';
import { bearingDeg, cumDist, distM, mergeCloseTurns, ptAlong } from './routing';

const ENDPOINT = 'https://overpass-api.de/api/interpreter';
const UA = 'RunCoachAI/1.0 (running route guidance)';   // Overpass refuses requests without a User-Agent (406)
const NOT_WALKABLE = '^(motorway|motorway_link|trunk|trunk_link|proposed|construction|raceway|bus_guideway|abandoned)$';

// node coords [lon, lat]; way = node ids; tags[i] = the tags of ways[i] (roundabout detection needs them)
export interface OsmNet { nodes: Map<number, number[]>; ways: number[][]; tags?: Record<string, string>[] }

export function parseOverpass(j: any): OsmNet {
  const nodes = new Map<number, number[]>(), ways: number[][] = [], tags: Record<string, string>[] = [];
  const seen = new Set<number>();
  for (const e of (j?.elements ?? [])) {
    if (e.type === 'node' && typeof e.lon === 'number') nodes.set(e.id, [e.lon, e.lat]);
    else if (e.type === 'way' && Array.isArray(e.nodes) && e.tags?.area !== 'yes' && !seen.has(e.id)) {   // not area outlines
      seen.add(e.id); ways.push(e.nodes); tags.push(e.tags ?? {});
    }
  }
  return { nodes, ways, tags };
}

const PRIVACY_M = 150;   // leave the start/end (home) out of the query — cues skip the first/last 30 m anyway

export async function fetchOsmNet(coords: number[][], timeoutMs = 6_000): Promise<OsmNet | null> {
  if (coords.length < 2) return null;
  const cum = cumDist(coords), total = cum[cum.length - 1];
  const mid = coords.filter((_, i) => cum[i] >= PRIVACY_M && cum[i] <= total - PRIVACY_M);
  if (mid.length < 2) return null;
  // Downsample (the `around` filter follows the LINE between points, so nothing between them is skipped); the
  // spacing widens on very long routes so the whole route fits ≤600 points instead of being cut off.
  const spacing = Math.max(40, total / 600);
  const pts: number[][] = [mid[0]];
  for (const c of mid) if (distM(pts[pts.length - 1], c) >= spacing) pts.push(c);
  if (pts[pts.length - 1] !== mid[mid.length - 1]) pts.push(mid[mid.length - 1]);
  const line = pts.map(c => `${c[1].toFixed(6)},${c[0].toFixed(6)}`).join(',');
  // + every ROUNDABOUT touching those ways, its other ring parts (a ring is often split into several ways) and ALL
  // its arms — arms on the far side of the ring are > 20 m from the route but still count as exits for a car.
  const RB = '["junction"~"^(roundabout|circular)$"]';
  const q = `[out:json][timeout:20];way[highway][highway!~"${NOT_WALKABLE}"](around:20,${line})->.near;` +
    `way.near${RB}->.rb1;node(w.rb1)->.n1;way(bn.n1)[highway]${RB}->.rb2;node(w.rb2)->.n2;way(bn.n2)[highway]->.arms;` +
    `(.near;.arms;);out body;>;out skel qt;`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: 'data=' + encodeURIComponent(q),
    });
    if (!res.ok) return null;
    const net = parseOverpass(await res.json());
    return net.ways.length ? net : null;
  } catch { return null; }   // timeout / offline / busy → the route goes without fork cues
  finally { clearTimeout(t); }
}

const norm = (d: number) => { while (d > 180) d -= 360; while (d < -180) d += 360; return d; };

/** Add fork cues at confusable junctions on the route. Pure (net passed in) so it can be tested offline. */
export function junctionCues(coords: number[][], steps: RouteStep[], net: OsmNet): RouteStep[] {
  if (coords.length < 3 || !net.ways.length) return steps;
  // Node degree: interior node of a way = 2 edges, endpoint = 1 (a closed way has no endpoints). ≥3 = junction.
  const deg = new Map<number, number>(), where = new Map<number, [number, number][]>();   // node → (way, pos)[]
  net.ways.forEach((w, wi) => {
    const closed = w.length > 2 && w[0] === w[w.length - 1];
    w.forEach((n, k) => {
      const end = !closed && (k === 0 || k === w.length - 1);
      deg.set(n, (deg.get(n) ?? 0) + (end ? 1 : 2));
      (where.get(n) ?? where.set(n, []).get(n)!).push([wi, k]);
    });
  });
  // Bearing from junction J along a way, ~15 m out (walk the nodes so short first segments don't mislead).
  // A STUB — the way dead-ends (its end node has no other connection) within 15 m, e.g. a spur to a bench or
  // a viewpoint — isn't a real choice, so it doesn't count as a branch (no "keep left" for it).
  const branchBearing = (wi: number, k: number, dir: 1 | -1): number | null => {
    const w = net.ways[wi], j = net.nodes.get(w[k]); if (!j) return null;
    let acc = 0, idx = k, last = j;
    while (idx + dir >= 0 && idx + dir < w.length) {
      const p = net.nodes.get(w[idx + dir]); if (!p) break;
      acc += distM(last, p); last = p; idx += dir;
      if (acc >= 15) break;
    }
    if (last === j) return null;
    if (acc < 15 && (idx === 0 || idx === w.length - 1) && (deg.get(w[idx]) ?? 0) <= 1) return null;   // dead-end stub
    return bearingDeg(j, last);
  };

  const cum = cumDist(coords);
  // ~11 m grid of route vertices → a junction only checks its own and neighbouring cells, not the whole route.
  const cell = (c: number[]) => `${Math.round(c[0] * 1e4)}:${Math.round(c[1] * 1e4)}`;
  const grid = new Map<string, number[]>();
  for (let i = 1; i < coords.length - 1; i++) { const k = cell(coords[i]); (grid.get(k) ?? grid.set(k, []).get(k)!).push(i); }
  const out = steps.map(s => ({ ...s }));
  const added: RouteStep[] = [];
  // Route vertices AT a junction (ORS geometry uses the OSM nodes, so the match is near-exact), split into separate
  // PASSES — a lollipop / figure-8 goes through the same junction on the way out AND back, and each needs its cue.
  const passesAt = (jc: number[]): number[] => {
    const hits: { i: number; d: number }[] = [];
    const cx = Math.round(jc[0] * 1e4), cy = Math.round(jc[1] * 1e4);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const i of grid.get(`${cx + dx}:${cy + dy}`) ?? []) { const dd = distM(coords[i], jc); if (dd < 3) hits.push({ i, d: dd }); }
    }
    hits.sort((a, b) => a.i - b.i);
    const out: number[] = [];
    let group: { i: number; d: number }[] = [];
    const flush = () => { if (group.length) out.push(group.reduce((a, b) => (b.d < a.d ? b : a)).i); group = []; };
    for (const h of hits) { if (group.length && cum[h.i] - cum[group[group.length - 1].i] > 50) flush(); group.push(h); }
    flush();
    return out;
  };
  for (const [node, d] of deg) {
    if (d < 3) continue;
    const jc = net.nodes.get(node); if (!jc) continue;
    for (const r of passesAt(jc)) {
      if (cum[r] < 30 || cum[cum.length - 1] - cum[r] < 30) continue;
      const inB = bearingDeg(ptAlong(coords, r, -1, 15), coords[r]), outB = bearingDeg(coords[r], ptAlong(coords, r, 1, 15));
      const branches: number[] = [];
      for (const [wi, k] of where.get(node) ?? []) {
        for (const dir of [-1, 1] as const) { const b = branchBearing(wi, k, dir); if (b != null) branches.push(b); }
      }
      // Drop the branch we arrive on and the one we take; what's left are the alternatives.
      const take = (target: number) => {
        let bi = -1, bd = 40;
        branches.forEach((b, i) => { const x = Math.abs(norm(b - target)); if (x < bd) { bd = x; bi = i; } });
        if (bi >= 0) branches.splice(bi, 1);
        return bi >= 0;
      };
      if (!take((inB + 180) % 360) || !take(outB)) continue;       // route doesn't follow this junction's ways
      const close = branches.map(b => norm(b - outB)).filter(x => Math.abs(x) < 60);
      if (!close.length) continue;                                   // clear crossing / side path → no cue needed
      const hasLeft = close.some(x => x < 0), hasRight = close.some(x => x > 0);
      const text = hasLeft && hasRight ? 'At the fork, take the middle path'
        : hasRight ? 'At the fork, keep left' : 'At the fork, keep right';   // the alternative is right of us → we keep left
      const type = hasLeft && hasRight ? 6 : hasRight ? 12 : 13;
      // An ORS instruction within 25 m already guides this spot — but upgrade OUR synthetic waytype cue.
      const near = out.filter(s => s.type !== 11 && s.type !== 10 && Math.abs(cum[Math.min(s.i, cum.length - 1)] - cum[r]) <= 25);
      if (near.some(s => !s.syn)) continue;
      if (added.some(s => Math.abs(cum[s.i] - cum[r]) <= 25)) continue;
      const syn = near.find(s => s.syn);
      const onto = syn ? /\bonto (.+)$/i.exec(syn.text)?.[1] : undefined;
      if (syn) { syn.text = `${text}${onto ? ` onto ${onto}` : ''}`; syn.type = type; continue; }
      added.push({ i: r, text, dist: 0, type, syn: true });
    }
  }
  if (!added.length) return out;
  // Re-merge: a fork 30 m after a turn becomes "Turn right, then at the fork, keep left".
  return mergeCloseTurns([...out, ...added].sort((a, b) => a.i - b.i), coords);
}

// ── Roundabouts, the way a car would take them (Geert, 2026-10-05: the cues at a roundabout were confusing) ─────
// A foot route goes AROUND a roundabout on the pavement, so ORS gives a string of turns/crossings there. Instead,
// say what a driver hears: "At the roundabout, take the 2nd exit onto X". Exits are counted in the DRIVING
// direction, read from the ring's own OSM node order (roundabouts are mapped one-way in the direction of traffic),
// so it's right for the country's side of the road without a country table: anticlockwise in Belgium, clockwise
// in the UK. Only car-drivable arms count, an entry-only one-way slip isn't an exit, and a split carriageway
// (separate in/out ways) is ONE arm. Any doubt (route doesn't enter AND leave along two different arms) → no cue.
const CAR = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road)(_link)?$/;
const ORD = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];

export function roundaboutCues(coords: number[][], steps: RouteStep[], net: OsmNet): RouteStep[] {
  const tags = net.tags;
  if (!tags || coords.length < 3) return steps;
  const isRb = (wi: number) => /^(roundabout|circular)$/.test(tags[wi]?.junction ?? '');
  // 1. rings = roundabout ways joined by shared nodes
  const rbWays = net.ways.map((_, wi) => wi).filter(isRb);
  if (!rbWays.length) return steps;
  const parent = new Map<number, number>(rbWays.map(w => [w, w]));
  const find = (x: number): number => { while (parent.get(x) !== x) x = parent.get(x)!; return x; };
  const nodeWay = new Map<number, number>();
  for (const wi of rbWays) for (const n of net.ways[wi]) {
    const o = nodeWay.get(n);
    if (o != null) parent.set(find(wi), find(o)); else nodeWay.set(n, wi);
  }
  const rings = new Map<number, number[]>();
  for (const wi of rbWays) { const r = find(wi); (rings.get(r) ?? rings.set(r, []).get(r)!).push(wi); }

  const cum = cumDist(coords), total = cum[cum.length - 1];
  const k = 111320;
  const xy = (c: number[], o: number[]) => [(c[0] - o[0]) * Math.cos(o[1] * Math.PI / 180) * k, (c[1] - o[1]) * k];
  const angDiff = (a: number, b: number) => Math.abs(((a - b) % 360 + 540) % 360 - 180);
  let out = steps.map(s => ({ ...s }));
  const added: RouteStep[] = [];

  for (const ws of rings.values()) {
    const ringNodes = new Set<number>(ws.flatMap(wi => net.ways[wi]));
    const pts = [...ringNodes].map(n => net.nodes.get(n)).filter((c): c is number[] => !!c);
    if (pts.length < 3) continue;
    const ctr = [pts.reduce((a, c) => a + c[0], 0) / pts.length, pts.reduce((a, c) => a + c[1], 0) / pts.length];
    const radius = pts.reduce((a, c) => a + distM(c, ctr), 0) / pts.length;
    if (radius < 4 || radius > 120) continue;                                   // not a usable roundabout ring
    // 2. driving direction from the mapped node order: signed turning around the centre (+ = anticlockwise)
    let turn = 0;
    for (const wi of ws) {
      const w = net.ways[wi];
      for (let i = 1; i < w.length; i++) {
        const a = net.nodes.get(w[i - 1]), b = net.nodes.get(w[i]); if (!a || !b) continue;
        const [ax, ay] = xy(a, ctr), [bx, by] = xy(b, ctr);
        turn += ax * by - ay * bx;
      }
    }
    if (!turn) continue;
    const anticlockwise = turn > 0;
    // 3. arms: non-ring highway ways touching a ring node; their bearing from the centre ~40 m out along the arm
    //    (split carriageways converge there → one cluster)
    const arms: { b: number; exit: boolean; car: boolean; name?: string }[] = [];
    net.ways.forEach((w, wi) => {
      if (isRb(wi)) return;
      w.forEach((n, pos) => {
        if (!ringNodes.has(n)) return;
        const t = tags[wi] ?? {};
        for (const dir of [1, -1] as const) {
          if (pos + dir < 0 || pos + dir >= w.length) continue;
          let acc = 0, idx = pos, last = net.nodes.get(n);
          if (!last) return;
          while (idx + dir >= 0 && idx + dir < w.length && acc < 40) {
            const p = net.nodes.get(w[idx + dir]); if (!p) break;
            if (ringNodes.has(w[idx + dir])) break;                              // a chord back onto the ring
            acc += distM(last, p); last = p; idx += dir;
          }
          if (acc < 3) continue;
          const ow = t.oneway, intoRing = (ow === 'yes' || ow === '1' || ow === 'true') ? dir === -1 : ow === '-1' ? dir === 1 : false;
          arms.push({ b: bearingDeg(ctr, last), exit: !intoRing, car: CAR.test(t.highway ?? '') && t.service !== 'parking_aisle' && t.access !== 'no' && t.motor_vehicle !== 'no', name: t.name });
        }
      });
    });
    // cluster arms within 25° (split carriageway halves, a road + its parallel footway)
    arms.sort((a, b) => a.b - b.b);
    const clusters: { b: number; exit: boolean; car: boolean; name?: string; members: number[] }[] = [];
    for (const a of arms) {
      const c = clusters.find(x => angDiff(x.b, a.b) < 25);
      if (c) { c.members.push(a.b); c.exit ||= a.exit && a.car; c.car ||= a.car; c.name ??= a.car ? a.name : undefined; }
      else clusters.push({ b: a.b, exit: a.exit && a.car, car: a.car, name: a.car ? a.name : undefined, members: [a.b] });
    }
    if (clusters.filter(c => c.car).length < 3) continue;                       // a ring with < 3 roads isn't a junction
    // 4. route passes through the zone (ring + pavement + crossings set back from it)
    const zone = radius + 25;
    const inZone = coords.map(c => distM(c, ctr) <= zone);
    for (let i = 0; i < coords.length; i++) {
      if (!inZone[i]) continue;
      let j = i; while (j + 1 < coords.length && inZone[j + 1]) j++;
      const a = i, b = j; i = j;
      if (cum[a] < 30 || total - cum[b] < 30 || cum[b] - cum[a] < 8) continue;
      // which arm do we come in on / leave by: where the route is just outside the zone
      const inB = bearingDeg(ctr, ptAlong(coords, a, -1, 15)), outB = bearingDeg(ctr, ptAlong(coords, b, 1, 15));
      const near = (bb: number) => clusters.filter(c => c.car).reduce<{ c?: typeof clusters[number]; d: number }>((m, c) => {
        const d = Math.min(...c.members.map(x => angDiff(x, bb))); return d < m.d ? { c, d } : m; }, { d: 35 }).c;
      const cin = near(inB), cout = near(outB);
      if (!cin || !cout || cin === cout || !cout.exit) continue;
      // count exits passed in the driving direction, entry arm excluded, our exit included
      const rel = (bb: number) => { const d = anticlockwise ? cin.b - bb : bb - cin.b; return ((d % 360) + 360) % 360; };
      const relOut = rel(cout.b);
      const nth = clusters.filter(c => c !== cin && c.exit && rel(c.b) > 0 && rel(c.b) <= relOut).length;
      if (nth < 1 || nth > ORD.length) continue;
      const onto = cout.name ? ` onto ${cout.name}` : '';
      // the roundabout cue replaces whatever was said inside it (ORS turns, crossings, our fork cues)
      out = out.filter(s => s.type === 11 || s.type === 10 || cum[Math.min(s.i, cum.length - 1)] < cum[a] - 20 || cum[Math.min(s.i, cum.length - 1)] > cum[b] + 10);
      added.push({ i: a, text: `At the roundabout, take the ${ORD[nth - 1]} exit${onto}`, dist: Math.round(cum[b] - cum[a]), type: 7, syn: true });
      // a long way round on the pavement → also mark where to leave it (only if it's well clear of the entry,
      // else the watch's 40 m trigger would speak both back to back)
      if (cum[b] - cum[a] >= 50 && distM(coords[a], coords[b]) >= 60) added.push({ i: b, text: `Take the exit${onto}`, dist: 0, type: 8, syn: true });
    }
  }
  if (!added.length) return steps;
  return [...out, ...added].sort((x, y) => x.i - y.i);
}

/** Best-effort enrichment of a route with real-network fork + roundabout cues (unchanged route on any failure). */
export async function addJunctionCues(loop: RouteLoop): Promise<RouteLoop> {
  try {
    const coords = loop.coords as number[][];
    const net = await fetchOsmNet(coords);
    if (!net) return loop;
    return { ...loop, steps: roundaboutCues(coords, junctionCues(coords, loop.steps ?? [], net), net) };
  } catch { return loop; }
}

// One lookup per route object, started as soon as the runner settles on a route (Wayfinder) so "Send to watch"
// doesn't wait on the network; flipping back to a route reuses its result.
const cache = new WeakMap<RouteLoop, Promise<RouteLoop>>();
export function prefetchJunctionCues(loop: RouteLoop): Promise<RouteLoop> {
  let p = cache.get(loop);
  if (!p) {
    p = addJunctionCues(loop);
    cache.set(loop, p);
    // addJunctionCues hands back the SAME object only on failure (busy / timeout / offline) — don't cache that,
    // so a later Send retries instead of this route never getting its fork cues.
    p.then(r => { if (r === loop) cache.delete(loop); }).catch(() => cache.delete(loop));
  }
  return p;
}
