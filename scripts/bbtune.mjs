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
  REST_STRESS: 33, SEED: 42,
  BIN_MIN: process.env.BIN_MIN != null ? +process.env.BIN_MIN : (d.meta?.constants?.BIN_MIN ?? 10), // from the dump
  BASE_DRAIN:   process.env.BASE_DRAIN   != null ? +process.env.BASE_DRAIN   : 0.02,
  STRESS_DRAIN: process.env.STRESS_DRAIN != null ? +process.env.STRESS_DRAIN : 0.075,
  // Recovery-scaled overnight charge (Bevel-style): asleep → approach a CEILING set by a slow
  // EWMA of HRV/baseline. Poor-HRV night → low ceiling → little charge; good night → full.
  CHARGE_K:    process.env.CHARGE_K    != null ? +process.env.CHARGE_K    : 0.045,
  CHARGE_MAX:  process.env.CHARGE_MAX  != null ? +process.env.CHARGE_MAX  : 0.12,
  CEIL_LO:     process.env.CEIL_LO     != null ? +process.env.CEIL_LO     : 22,
  CEIL_HI:     process.env.CEIL_HI     != null ? +process.env.CEIL_HI     : 98,
  CEIL_RLO:    process.env.CEIL_RLO    != null ? +process.env.CEIL_RLO    : 0.62,
  CEIL_RHI:    process.env.CEIL_RHI    != null ? +process.env.CEIL_RHI    : 1.35,
  CEIL_HRV_SMOOTH: process.env.CEIL_HRV_SMOOTH != null ? +process.env.CEIL_HRV_SMOOTH : 0.012,
  // Stress smoothing (Bevel-style momentum): EWMA per 10-min bin. SMOOTH=1 → raw/instant
  // (twitchy, drops to 0); lower = smoother + stickier. RISE applies a faster attack so
  // stress climbs quickly but decays slowly, like Bevel. FLOOR keeps awake stress off 0.
  // Defaults = SHIPPED production values (bodyBattery.ts).
  SMOOTH: process.env.SMOOTH != null ? +process.env.SMOOTH : 0.11, // production (5-min bins); use 0.20 for old 10-min dumps
  RISE:   process.env.RISE   != null ? +process.env.RISE   : 1,
  FLOOR:  process.env.FLOOR  != null ? +process.env.FLOOR  : 18,
  HR_GATE: process.env.HR_GATE != null ? +process.env.HR_GATE : 12, // bpm above rest for HRV-stress
  HR_GATE_FLOOR: process.env.HR_GATE_FLOOR != null ? +process.env.HR_GATE_FLOOR : 0.15,
  SLEEP_CAP: process.env.SLEEP_CAP != null ? +process.env.SLEEP_CAP : 45,
  SESSION_GAP_MIN: process.env.SESSION_GAP_MIN != null ? +process.env.SESSION_GAP_MIN : 60,
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
  if (vHrv != null) {
    const supp = clamp(hrvBaseline / Math.max(vHrv, 1), 0.5, CFG.SUPP_CAP);
    const gate = clamp(CFG.HR_GATE_FLOOR + (hr - restHR) / CFG.HR_GATE, CFG.HR_GATE_FLOOR, 1); // small floor at rest
    const hrvStress = clamp((supp - 0.85) / 0.9, 0, 1) * 100 * gate;
    st = clamp(CFG.W_HR * base + CFG.W_HRV * Math.max(base, hrvStress), 0, 100);
  }
  return a ? Math.min(st, CFG.SLEEP_CAP) : st;
};

const bins = d.bins ?? d.bins3.map(([m, hr, a]) => ({ m, hr, a }));
const lastM = bins.at(-1).m;
// Night = asleep OR a micro-wake inside the night session. Use the dump's `ses` flag if present
// (new dumps), else derive it: a bin within SESSION_GAP of asleep bins on BOTH sides.
const GAPB = Math.round(CFG.SESSION_GAP_MIN / CFG.BIN_MIN);
const aIdx = bins.map((b, i) => (b.a ? i : -1)).filter(i => i >= 0);
const nightArr = bins.map((b, i) => b.ses != null ? !!b.ses
  : (!!b.a || (aIdx.some(j => j <= i && i - j <= GAPB) && aIdx.some(j => j >= i && j - i <= GAPB))));

let battery = CFG.SEED;
let sm = null, smR = null, lastHrv = hrvBaseline;
const out = [];
for (let i = 0; i < bins.length; i++) {
  const { m, hr, a } = bins[i];
  const night = nightArr[i];
  const vHrv = nearestHrv(m);
  const raw = stressAt(hr, vHrv, night);
  // Fast attack (RISE) only AWAKE-DAY; at night smooth both ways so a brief wake can't spike.
  const alpha = sm == null ? 1 : ((raw > sm && !night) ? CFG.RISE : CFG.SMOOTH);
  sm = sm == null ? raw : alpha * raw + (1 - alpha) * sm;
  const stress = night ? sm : Math.max(sm, CFG.FLOOR);        // floor only awake-day
  // Recovery ceiling: slow EWMA of HRV/baseline → the whole night's recovery caps the charge.
  if (vHrv != null) lastHrv = vHrv;
  const ratio = lastHrv / Math.max(1, hrvBaseline);
  smR = smR == null ? ratio : CFG.CEIL_HRV_SMOOTH * ratio + (1 - CFG.CEIL_HRV_SMOOTH) * smR;
  const ceil = clamp(CFG.CEIL_LO + (CFG.CEIL_HI - CFG.CEIL_LO) * ((smR - CFG.CEIL_RLO) / (CFG.CEIL_RHI - CFG.CEIL_RLO)), 20, 100);
  const rate = a // battery charges only during ACTUAL sleep (not micro-wakes)
    ? Math.max(0, Math.min(CFG.CHARGE_MAX, CFG.CHARGE_K * (ceil - battery)))
    : -(CFG.BASE_DRAIN + (stress / 100) * CFG.STRESS_DRAIN);
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
const sLo = Math.min(...day.map(p => p.stress)), sHi = Math.max(...day.map(p => p.stress)), zeros = day.filter(p => p.stress < 5).length;
console.log(`STRESS day(awake): min ${sLo}  max ${sHi}  drops<5: ${zeros}/${day.length} bins`);
// Time-in-zone over the whole shown window (incl. sleep) like Bevel's High/Med/Low.
const pct = (f) => Math.round(100 * shown.filter(f).length / shown.length);
console.log(`ZONES  Low(<34) ${pct(p => p.stress < 34)}%  Med(34-66) ${pct(p => p.stress >= 34 && p.stress < 67)}%  High(≥67) ${pct(p => p.stress >= 67)}%`);
console.log(`BEVEL  stress ~78 now / ~62 avg, no drops to 0   battery ~8   zones Low 26 / Med 25 / High 49`);
