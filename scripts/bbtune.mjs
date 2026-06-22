#!/usr/bin/env node
// Offline Body-Battery calibration harness. Reads /tmp/bbdata.json (device "Copy
// calibration data"). Re-derives HRV trust + replays stress/battery so constants tune in
// seconds. Edit CFG, re-run: node scripts/bbtune.mjs
import fs from 'node:fs';
const d = JSON.parse(fs.readFileSync(process.argv.find(a => a.endsWith('.json')) || '/tmp/bbdata.json', 'utf8'));
const { restHR, maxHR, hrvBaseline, now } = d.meta;

const CFG = {
  // HRV trust (rrgap is NO LONGER a hard reject — stable, moderate HR is the arbiter):
  V_MIN: 5, V_MAX: 110, HR_HIGH: 20, CV_MAX: 18,
  W_HR: 0.35, W_HRV: 0.65, SUPP_CAP: 2.6, HRV_WIN: 65,
  REST_STRESS: 33, SLEEP_CHARGE: 0.125, SEED: 42, BIN_MIN: 10,
  BASE_DRAIN:   process.env.BASE_DRAIN   != null ? +process.env.BASE_DRAIN   : 0.012,
  STRESS_DRAIN: process.env.STRESS_DRAIN != null ? +process.env.STRESS_DRAIN : 0.085,
  // awake-but-calm-at-night charge factor × SLEEP_CHARGE (0 = hold/no charge; 0.75 = old
  // over-charging model that read +15 vs Bevel). Override per-run: AWAKE_CHARGE=0.2 node …
  AWAKE_CHARGE: process.env.AWAKE_CHARGE != null ? +process.env.AWAKE_CHARGE : 0,
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const trusted = d.hrv.filter(s =>
  s.v >= CFG.V_MIN && s.v <= CFG.V_MAX &&
  s.hr <= restHR + CFG.HR_HIGH &&
  s.cv <= CFG.CV_MAX
).map(s => ({ m: s.m, v: s.v }));

const nearestHrv = (m) => { let best = null, dt = CFG.HRV_WIN; for (const s of trusted) { const x = Math.abs(s.m - m); if (x <= dt) { dt = x; best = s.v; } } return best; };
const stressAt = (hr, vHrv, a) => {
  const hrr = clamp((hr - restHR) / Math.max(20, maxHR - restHR), 0, 1);
  const base = 100 * clamp((hrr - 0.04) / 0.45, 0, 1);
  let st = base;
  if (vHrv != null) { const supp = clamp(hrvBaseline / Math.max(vHrv, 1), 0.5, CFG.SUPP_CAP); st = clamp(CFG.W_HR * base + CFG.W_HRV * Math.max(base, clamp((supp - 0.85) / 0.9, 0, 1) * 100), 0, 100); }
  return a ? Math.min(st, 14) : st;
};

const bins = d.bins ?? d.bins3.map(([m, hr, a]) => ({ m, hr, a }));
const lastM = bins.at(-1).m;
let battery = CFG.SEED;
const out = [];
for (const { m, hr, a } of bins) {
  const vHrv = nearestHrv(m);
  const stress = stressAt(hr, vHrv, !!a);
  const rate = a
    ? CFG.SLEEP_CHARGE                                          // asleep → charge (Bevel: sleep band only)
    : -(CFG.BASE_DRAIN + (stress / 100) * CFG.STRESS_DRAIN);    // awake → drain (declines all day)
  battery = clamp(battery + rate * CFG.BIN_MIN, 0, 100);
  out.push({ m, hr, a, hrv: vHrv, stress: Math.round(stress), battery: Math.round(battery) });
}
const cut = lastM - 24 * 60, shown = out.filter(p => p.m >= cut);
let charged = 0, drained = 0, peak = 0;
for (let i = 1; i < shown.length; i++) { const dd = shown[i].battery - shown[i - 1].battery; if (dd > 0) charged += dd; else drained += dd; }
for (const p of shown) peak = Math.max(peak, p.battery);
const day = shown.filter(p => !p.a);
const avg = Math.round(day.reduce((a, p) => a + p.stress, 0) / Math.max(1, day.length));
console.log('CFG', JSON.stringify(CFG));
console.log(`HRV: ${d.hrv.length} samples → ${trusted.length} trusted   baseline ${hrvBaseline}ms  rest ${restHR} max ${maxHR}`);
console.log(`NOW   stress ${out.at(-1).stress}   battery ${out.at(-1).battery}%   (hrv@now ${out.at(-1).hrv ?? '-'})`);
console.log(`DAY   avgStress ${avg}   peak ${peak}%   charged +${Math.round(charged)}%   drained ${Math.round(drained)}%`);
console.log(`BEVEL target:  stress~73 now / ~62 avg   battery ~13%   charged +32   drained -33   peak ~47`);
