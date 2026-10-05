// Run: node --import ./harness/register.mjs harness/roundabouttest.mjs
// Synthetic 4-arm roundabout (radius 20 m) + a pavement route around it → the car-style exit cue.
import { roundaboutCues } from '../src/services/junctionCues.ts';
const O = [4.0, 51.0], K = 111320, CL = Math.cos(O[1] * Math.PI / 180);
const ll = (x, y) => [O[0] + x / (CL * K), O[1] + y / K];               // metres east/north → [lon, lat]
const pol = (r, deg) => ll(r * Math.cos(deg * Math.PI / 180), r * Math.sin(deg * Math.PI / 180));
function net(anticlockwise, opts = {}) {
  const nodes = new Map(), ways = [], tags = [];
  const ring = [];
  for (let k = 0; k < 12; k++) { const id = 100 + k; nodes.set(id, pol(20, k * 30)); ring.push(id); }
  const ord = anticlockwise ? ring : [...ring].reverse();
  ways.push([...ord, ord[0]]); tags.push({ highway: 'primary', junction: 'roundabout' });
  const arms = { E: 0, N: 3, W: 6, S: 9 };                              // ring index at 0°, 90°, 180°, 270°
  let id = 1000;
  for (const [nm, ri] of Object.entries(arms)) {
    const ang = ri * 30, ids = [100 + ri];
    for (let r = 40; r <= 140; r += 25) { nodes.set(++id, pol(r, ang)); ids.push(id); }
    ways.push(ids); tags.push({ highway: nm === 'N' && opts.footN ? 'footway' : 'residential', name: `${nm}-straat`,
      ...(nm === 'E' && opts.eEntryOnly ? { oneway: 'yes' } : {}) });
    if (nm === 'E' && opts.eEntryOnly) ways[ways.length - 1].reverse();   // oneway pointing INTO the ring
  }
  return { nodes, ways, tags };
}
// pavement route: come up the S arm (8 m east of it), round the ring at r = 30 m the SHORT way, out along `to`
function route(toDeg) {
  const c = [];
  for (let y = -160; y <= -50; y += 10) c.push(ll(8, y));
  const from = -90 + 15, to = toDeg - 15 * Math.sign(((toDeg - from + 540) % 360) - 180 || 1);
  let d = ((to - from + 540) % 360) - 180;
  for (let s = 0; s <= 12; s++) c.push(pol(30, from + d * s / 12));
  for (let r = 50; r <= 160; r += 10) c.push(pol(r, toDeg).map((v, i) => v + (i === 0 ? 0 : 0)));
  return c;
}
const steps = (c) => [{ i: 0, text: 'Head north', dist: 0, type: 11 }, { i: 14, text: 'Turn right onto crossing', dist: 0, type: 1 }, { i: c.length - 1, text: 'Arrive', dist: 0, type: 10 }];
for (const [label, acw] of [['Belgium (anticlockwise)', true], ['UK (clockwise)', false]]) {
  for (const [to, deg] of [['E', 0], ['N', 90], ['W', 180]]) {
    const c = route(deg);
    const r = roundaboutCues(c, steps(c), net(acw));
    console.log(label.padEnd(24), 'S →', to, '→', r.filter(s => s.syn).map(s => s.text).join(' | ') || '(none)', '| dropped crossing:', !r.some(s => /crossing/.test(s.text)));
  }
}
let c = route(180);
console.log('E arm entry-only (BE, S→W):', roundaboutCues(c, steps(c), net(true, { eEntryOnly: true })).filter(s => s.syn).map(s => s.text).join(' | '), '(expect 2nd)');
console.log('N arm footway   (BE, S→W):', roundaboutCues(c, steps(c), net(true, { footN: true })).filter(s => s.syn).map(s => s.text).join(' | '), '(expect 2nd)');
// a route that passes 60 m away → nothing
const far = []; for (let y = -200; y <= 200; y += 10) far.push(ll(70, y));
console.log('passing by:', roundaboutCues(far, steps(far), net(true)).filter(s => s.syn).length, '(expect 0)');
