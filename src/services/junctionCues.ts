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

export interface OsmNet { nodes: Map<number, number[]>; ways: number[][] }   // node coords [lon, lat]; way = node ids

export function parseOverpass(j: any): OsmNet {
  const nodes = new Map<number, number[]>(), ways: number[][] = [];
  for (const e of (j?.elements ?? [])) {
    if (e.type === 'node' && typeof e.lon === 'number') nodes.set(e.id, [e.lon, e.lat]);
    else if (e.type === 'way' && Array.isArray(e.nodes) && e.tags?.area !== 'yes') ways.push(e.nodes);   // not area outlines
  }
  return { nodes, ways };
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
  const q = `[out:json][timeout:20];way[highway][highway!~"${NOT_WALKABLE}"](around:20,${line});out body;>;out skel qt;`;
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

/** Best-effort enrichment of a route with real-network fork cues (unchanged route on any failure). */
export async function addJunctionCues(loop: RouteLoop): Promise<RouteLoop> {
  try {
    const coords = loop.coords as number[][];
    const net = await fetchOsmNet(coords);
    if (!net) return loop;
    return { ...loop, steps: junctionCues(coords, loop.steps ?? [], net) };
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
