#!/usr/bin/env node
// Offline stress / Body-Battery calibration harness. Mirrors bodyBattery.ts:
//   • STRESS = z-score index vs the athlete's OWN day/night baselines (mean+SD of HRV & resting HR
//     from trusted reads, split by sleep state): stress = STRESS_BASE + (zHR − zHRV)·STRESS_SCALE,
//     clamped 0..100. Night adds the sleep-stage bump (REM up, deep at the recovery floor).
//   • BATTERY = recovery-capped overnight charge (HRV-ratio ceiling) + stress-driven daytime drain.
// Reads /tmp/bbdata.json (device "Copy calibration data"). Env-override any CFG, re-run:
//   STRESS_SCALE=15 STAGE_REM=18 node scripts/bbtune.mjs   (zsh: use prefix assignments, not `env $cfg`)
import fs from 'node:fs';
const d = JSON.parse(fs.readFileSync(process.argv.find(a => a.endsWith('.json')) || '/tmp/bbdata.json', 'utf8'));
const { restHR, hrvBaseline } = d.meta;
const env = (k, def) => (process.env[k] != null ? +process.env[k] : def);

const CFG = {
  BIN_MIN: env('BIN_MIN', d.meta?.constants?.BIN_MIN ?? 5),
  // z-score stress index
  STRESS_BASE: env('STRESS_BASE', 26), STRESS_SCALE: env('STRESS_SCALE', 13), BASE_SD_MIN: env('BASE_SD_MIN', 3),
  STRESS_SMOOTH: env('STRESS_SMOOTH', 0.11), NIGHT_STAGE_SMOOTH: env('NIGHT_STAGE_SMOOTH', 0.35),
  SESSION_GAP_MIN: env('SESSION_GAP_MIN', 60), HRV_WIN: env('HRV_WIN', 65),
  // battery (recovery-capped charge + stress drain)
  SEED: env('SEED', 42), BASE_DRAIN: env('BASE_DRAIN', 0.012), STRESS_DRAIN: env('STRESS_DRAIN', 0.04),
  CHARGE_K: env('CHARGE_K', 0.045), CHARGE_MAX: env('CHARGE_MAX', 0.12),
  CEIL_LO: env('CEIL_LO', 22), CEIL_HI: env('CEIL_HI', 98), CEIL_RLO: env('CEIL_RLO', 0.58), CEIL_RHI: env('CEIL_RHI', 1.15),
  CEIL_HRV_SMOOTH: env('CEIL_HRV_SMOOTH', 0.012),
};
// Additive sleep-stage bump on top of the night recovery baseline (env-overridable).
const STAGE_BUMP = { 0: env('STAGE_BED', 6), 1: env('STAGE_SLP', 3), 2: env('STAGE_WAKE', 8), 3: env('STAGE_CORE', 2), 4: env('STAGE_DEEP', 0), 5: env('STAGE_REM', 14) };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mean = a => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const stdev = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };

const bins = d.bins ?? [];
// Night per bin: dump's `ses` if present, else derive (within SESSION_GAP of asleep on both sides).
const GAPB = Math.round(CFG.SESSION_GAP_MIN / CFG.BIN_MIN);
const aIdx = bins.map((b, i) => (b.a ? i : -1)).filter(i => i >= 0);
const nightArr = bins.map((b, i) => b.ses != null ? !!b.ses
  : (!!b.a || (aIdx.some(j => j <= i && i - j <= GAPB) && aIdx.some(j => j >= i && j - i <= GAPB))));
const nightAtM = (m) => { let best = 1e9, ni = false; for (let i = 0; i < bins.length; i++) { const dd = Math.abs(bins[i].m - m); if (dd < best) { best = dd; ni = nightArr[i]; } } return ni; };

// Trusted reads (dump's ok flag) carry their resting HR; split day/night → baselines (mean+SD).
const trusted = d.hrv.filter(s => s.ok).map(s => ({ m: s.m, v: s.v, hr: s.hr, night: nightAtM(s.m) }));
const mkBase = (reads, fb) => reads.length >= 6
  ? { hvM: mean(reads.map(r => r.v)), hvS: Math.max(CFG.BASE_SD_MIN, stdev(reads.map(r => r.v))),
      hrM: mean(reads.map(r => r.hr)), hrS: Math.max(CFG.BASE_SD_MIN, stdev(reads.map(r => r.hr))) }
  : fb;
const fb = { hvM: hrvBaseline, hvS: 15, hrM: restHR, hrS: 6 };
const dayBase = mkBase(trusted.filter(r => !r.night), fb);
const nightBase = mkBase(trusted.filter(r => r.night), dayBase);
const nearestHrv = (m) => { let best = null, dt = CFG.HRV_WIN; for (const s of trusted) { const x = Math.abs(s.m - m); if (x <= dt) { dt = x; best = s.v; } } return best; };
const zStress = (hr, vHrv, b) => { const zHR = (hr - b.hrM) / b.hrS; const zHRV = vHrv != null ? (vHrv - b.hvM) / b.hvS : 0; return clamp(CFG.STRESS_BASE + (zHR - zHRV) * CFG.STRESS_SCALE, 0, 100); };

let battery = CFG.SEED, sm = null, smR = null, lastHrv = hrvBaseline;
const out = [];
for (let i = 0; i < bins.length; i++) {
  const { m, hr, a, stg = -1 } = bins[i];
  const night = nightArr[i];
  const vHrv = nearestHrv(m);
  let raw = zStress(hr, vHrv, night ? nightBase : dayBase);
  if (night && stg >= 0) raw = clamp(raw + (STAGE_BUMP[stg] ?? 0), 0, 100);
  const alpha = sm == null ? 1 : (night ? CFG.NIGHT_STAGE_SMOOTH : (raw > sm ? 1 : CFG.STRESS_SMOOTH));
  sm = sm == null ? raw : alpha * raw + (1 - alpha) * sm;
  if (vHrv != null) lastHrv = vHrv;
  const ratio = lastHrv / Math.max(1, hrvBaseline);
  smR = smR == null ? ratio : CFG.CEIL_HRV_SMOOTH * ratio + (1 - CFG.CEIL_HRV_SMOOTH) * smR;
  const ceil = clamp(CFG.CEIL_LO + (CFG.CEIL_HI - CFG.CEIL_LO) * ((smR - CFG.CEIL_RLO) / (CFG.CEIL_RHI - CFG.CEIL_RLO)), 20, 100);
  const rate = a // charge only during ACTUAL sleep (not micro-wakes)
    ? Math.max(0, Math.min(CFG.CHARGE_MAX, CFG.CHARGE_K * (ceil - battery)))
    : -(CFG.BASE_DRAIN + (sm / 100) * CFG.STRESS_DRAIN);
  battery = clamp(battery + rate * CFG.BIN_MIN, 0, 100);
  out.push({ m, a, night, stg, stress: Math.round(sm), battery: Math.round(battery) });
}
const lastM = bins.at(-1).m, cut = lastM - 24 * 60, shown = out.filter(p => p.m >= cut);
let charged = 0, drained = 0, peak = 0;
for (let i = 1; i < shown.length; i++) { const dd = shown[i].battery - shown[i - 1].battery; if (dd > 0) charged += dd; else drained += dd; }
for (const p of shown) peak = Math.max(peak, p.battery);
const avg = arr => Math.round(arr.reduce((s, p) => s + p.stress, 0) / Math.max(1, arr.length));
const day = shown.filter(p => !p.night), nite = shown.filter(p => p.night);
const f = b => `${b.hvM.toFixed(0)}±${b.hvS.toFixed(0)}ms / HR ${b.hrM.toFixed(0)}±${b.hrS.toFixed(0)}`;
console.log('CFG', JSON.stringify(CFG));
console.log(`BASELINE  day HRV ${f(dayBase)}   night HRV ${f(nightBase)}   (${trusted.length} trusted reads)`);
console.log(`NOW    stress ${out.at(-1).stress}   battery ${out.at(-1).battery}%`);
console.log(`STRESS day avg ${avg(day)} (min ${Math.min(...day.map(p=>p.stress))}/max ${Math.max(...day.map(p=>p.stress))})   night avg ${avg(nite)}`);
console.log(`BATTERY peak ${peak}%   charged +${Math.round(charged)}%   drained ${Math.round(drained)}%`);
// REM square-wave check: avg night stress in REM vs deep+core.
const rem = nite.filter(p => p.stg === 5), dc = nite.filter(p => p.stg === 3 || p.stg === 4);
if (rem.length && dc.length) console.log(`REM bump  REM ${avg(rem)}  vs  deep+core ${avg(dc)}  (Δ ${avg(rem) - avg(dc)})`);
