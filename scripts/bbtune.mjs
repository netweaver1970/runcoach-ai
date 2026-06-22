#!/usr/bin/env node
/**
 * Offline Body-Battery calibration harness.
 *
 * Replays the exact stress + battery model from a device "Copy calibration data" dump,
 * so constants can be tuned in seconds without rebuilding the app.
 *
 *   1. On the phone: Body Battery → "Copy calibration data", paste into /tmp/bbdata.json
 *   2. node scripts/bbtune.mjs                (uses the constants in CFG below)
 *      node scripts/bbtune.mjs --why          (also explains the latest HRV trust decision)
 *
 * The dump shape: { meta:{restHR,maxHR,hrvBaseline,now,fromMin,constants},
 *   hrv:[{m,v,hr,cv,ok,w}], bins:[{m,hr,a,hrv,s,b}] }
 */
import fs from 'node:fs';

const DATA = process.argv.find(a => a.endsWith('.json')) || '/tmp/bbdata.json';
const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const { restHR, maxHR, hrvBaseline } = d.meta;

// ── Tunable constants (edit + re-run) ──────────────────────────────────────────
const CFG = {
  // HRV trust filter (re-derived from the raw hrv samples; rrgap respected from device)
  HR_HIGH: 45, CV_MAX: 18,
  // stress formula
  W_HR: 0.35, W_HRV: 0.65, SUPP_CAP: 2.6,
  // battery dynamics
  BIN_MIN: d.meta.constants.BIN_MIN ?? 10,
  REST_STRESS: 33, SLEEP_CHARGE: 0.085, BASE_DRAIN: 0.008, STRESS_DRAIN: 0.050, SEED: 50,
  HRV_WIN_MIN: 35,
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Re-derive trusted HRV from the raw samples (respect device R-R gap = w 'rrgap').
const trusted = d.hrv.filter(s =>
  s.v >= 5 && s.v <= 200 && s.w !== 'rrgap' &&
  (s.hr === 0 || s.hr <= restHR + CFG.HR_HIGH) &&
  (s.cv < 0 || s.cv <= CFG.CV_MAX)
).map(s => ({ m: s.m, v: s.v }));

const nearestHrv = (m) => {
  let best = null, bestDt = CFG.HRV_WIN_MIN;
  for (const s of trusted) { const dt = Math.abs(s.m - m); if (dt <= bestDt) { bestDt = dt; best = s.v; } }
  return best;
};
const stressAt = (hr, vHrv, asleep) => {
  const hrr = clamp((hr - restHR) / Math.max(20, maxHR - restHR), 0, 1);
  const base = 100 * clamp((hrr - 0.04) / 0.45, 0, 1);
  let st = base;
  if (vHrv != null) {
    const supp = clamp(hrvBaseline / Math.max(vHrv, 1), 0.5, CFG.SUPP_CAP);
    const hrvStress = clamp((supp - 0.85) / 0.9, 0, 1) * 100;
    st = clamp(CFG.W_HR * base + CFG.W_HRV * Math.max(base, hrvStress), 0, 100);
  }
  return asleep ? Math.min(st, 14) : st;
};

// Replay battery over all bins; hour-of-day from m (min from window start) + fromMin offset.
const nowDate = new Date(d.meta.now);
const startMs = d.meta.now - (d.bins.at(-1).m - d.bins[0].m + CFG.BIN_MIN) * 60000; // approx
let battery = CFG.SEED;
const out = [];
for (const bin of d.bins) {
  const vHrv = nearestHrv(bin.m);
  const stress = stressAt(bin.hr, vHrv, !!bin.a);
  const tMs = d.meta.now - (d.bins.at(-1).m - bin.m) * 60000;
  const hour = new Date(tMs).getHours();
  const night = hour >= 22 || hour < 8;
  const recovering = bin.a || (night && stress < CFG.REST_STRESS);
  const rate = recovering ? CFG.SLEEP_CHARGE * (bin.a ? 1 : 0.75) : -(CFG.BASE_DRAIN + (stress / 100) * CFG.STRESS_DRAIN);
  battery = clamp(battery + rate * CFG.BIN_MIN, 0, 100);
  out.push({ m: bin.m, stress: Math.round(stress), battery: Math.round(battery), a: bin.a, hrv: vHrv });
}
// last 24h
const cut = out.at(-1).m - 24 * 60;
const shown = out.filter(p => p.m >= cut);
let charged = 0, drained = 0, peak = 0;
for (let i = 1; i < shown.length; i++) { const dd = shown[i].battery - shown[i-1].battery; if (dd>0) charged+=dd; else drained+=dd; }
for (const p of shown) peak = Math.max(peak, p.battery);
const dayStress = shown.filter(p => !p.a);
const avgStress = Math.round(dayStress.reduce((a,p)=>a+p.stress,0) / Math.max(1,dayStress.length));

console.log('CFG:', JSON.stringify(CFG));
console.log(`HRV samples: ${d.hrv.length}  trusted(now): ${trusted.length}  baseline: ${hrvBaseline}ms  restHR ${restHR} maxHR ${maxHR}`);
console.log(`NOW  stress ${out.at(-1).stress}   battery ${out.at(-1).battery}%   (latest HRV used: ${out.at(-1).hrv ?? 'none'})`);
console.log(`DAY  avg stress ${avgStress}   peak ${peak}%   charged +${Math.round(charged)}%   drained ${Math.round(drained)}%`);

if (process.argv.includes('--why')) {
  console.log('\nLatest 8 HRV samples (m=min-from-start, w=device verdict):');
  for (const s of d.hrv.slice(-8)) console.log('  ', JSON.stringify(s), ' →reTrusted:', (s.v>=5&&s.v<=200&&s.w!=='rrgap'&&(s.hr===0||s.hr<=restHR+CFG.HR_HIGH)&&(s.cv<0||s.cv<=CFG.CV_MAX)));
}
