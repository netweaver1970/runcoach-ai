// Run: node --import ./harness/register.mjs harness/roundaboutlive.mjs [lon lat]
// LIVE: ONE request to the OSM map API (bbox ±~250 m) around a real roundabout → the same element shape Overpass
// returns → parseOverpass + roundaboutCues for a pavement-ish route in along every car arm and out along every other.
import { parseOverpass, roundaboutCues } from '../src/services/junctionCues.ts';
import { distM, bearingDeg } from '../src/services/routing.ts';
const lon = +(process.argv[2] ?? 3.73593), lat = +(process.argv[3] ?? 51.03616);
const r = await fetch(`https://api.openstreetmap.org/api/0.6/map.json?bbox=${lon - 0.0035},${lat - 0.0022},${lon + 0.0035},${lat + 0.0022}`, { headers: { 'User-Agent': 'RunCoachAI/1.0 (test)' } });
const j = await r.json();
const net = parseOverpass({ elements: j.elements.filter(e => e.type === 'node' || (e.type === 'way' && e.tags?.highway)) });
const rbIdx = net.ways.map((_, i) => i).filter(i => /^(roundabout|circular)$/.test(net.tags[i].junction ?? ''));
const rn = new Set(rbIdx.flatMap(i => net.ways[i]));
const near = [...rn].map(n => net.nodes.get(n)).filter(p => p && distM(p, [lon, lat]) < 80);
const ctr = near.reduce((a, p, _, A) => [a[0] + p[0] / A.length, a[1] + p[1] / A.length], [0, 0]);
const ringNodes = new Set([...rn].filter(n => net.nodes.get(n) && distM(net.nodes.get(n), ctr) < 80));
const arms = [];
net.ways.forEach((w, wi) => {
  if (rbIdx.includes(wi) || !/^(primary|secondary|tertiary|residential|unclassified|service|trunk)(_link)?$/.test(net.tags[wi].highway)) return;
  const at = w.findIndex(n => ringNodes.has(n)); if (at < 0) return;
  for (const dir of [1, -1]) {
    const line = []; for (let i = at; i >= 0 && i < w.length; i += dir) line.push(net.nodes.get(w[i]));
    if (line.length < 2 || line.some(p => !p)) continue;
    arms.push({ name: net.tags[wi].name ?? net.tags[wi].highway, ow: net.tags[wi].oneway ?? '', b: Math.round(bearingDeg(ctr, line[Math.min(line.length - 1, 2)])), line, node: w[at] });
  }
});
console.log('ring nodes', ringNodes.size, 'arms:', arms.map(a => `${a.name}@${a.b}°${a.ow ? '(ow ' + a.ow + ')' : ''}`).join(', '));
// route: 200 m straight in along arm A's direction, round the ring 12 m outside it (shorter way), out along B
const ext = (line) => { const out = [line[0]]; let m = 0; for (let i = 1; i < line.length && m < 60; i++) { m += distM(line[i - 1], line[i]); out.push(line[i]); }
  const a = out[out.length - 2], b = out[out.length - 1], L = distM(a, b) || 1; for (let d = 20; m + d <= 220; d += 20) out.push([b[0] + (b[0] - a[0]) * d / L, b[1] + (b[1] - a[1]) * d / L]); return out; };
const K = 111320, CL = Math.cos(lat * Math.PI / 180);
const rad = [...ringNodes].reduce((a, n) => a + distM(net.nodes.get(n), ctr), 0) / ringNodes.size;
const pol = (rr, deg) => [ctr[0] + rr * Math.sin(deg * Math.PI / 180) / (CL * K), ctr[1] + rr * Math.cos(deg * Math.PI / 180) / K];  // bearing-based
const seen = new Set();
for (const A of arms) for (const B of arms) {
  if (A === B || A.name === B.name || seen.has(A.name + '>' + B.name)) continue;
  seen.add(A.name + '>' + B.name);
  let d = ((B.b - A.b + 540) % 360) - 180; const arc = []; for (let s = 0; s <= 12; s++) arc.push(pol(rad + 12, A.b + d * s / 12));
  const coords = [...ext(A.line).reverse(), ...arc, ...ext(B.line)];
  const out = roundaboutCues(coords, [], net);
  console.log(`${A.name}@${A.b}° → ${B.name}@${B.b}°:`, out.map(s => s.text).join(' | ') || '(none)');
}
