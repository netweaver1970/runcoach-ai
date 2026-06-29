#!/usr/bin/env node
/**
 * Body-Battery JOINT fit — fits the charge/drain model so OUR per-bin stress reproduces
 * BEVEL's exported Energy-Bank curve over the same window (no proxy).
 *
 * Inputs (defaults shown; override via argv):
 *   1. The app "Copy calibration data" dump (JSON) → /tmp/calib.json
 *      (paste the dump into that file). We read its debug `bins`: each has
 *      m=relMin-from-window-start, s=our stress, a=asleep, wo=workout, stg=HK stage.
 *   2. Bevel "Energy Bank" export .md  → ~/Downloads/Energy Bank Data*.md (markdown table | HH:MM | value |)
 *   3. Bevel "Stress" export .md (optional, for reference) → ~/Downloads/Stress Data*.md
 *
 * Usage:  node scripts/bbjointfit.mjs [calib.json] [energy.md] [stress.md]
 *
 * It anchors our battery to Bevel's first energy value (so we compare pure dynamics — the
 * seed is removed, exactly like the in-app calibration anchor) and grid-searches
 * charge = CB − CK·S  (asleep, REM capped at REM_CAP) and drain = DB − DK·S (awake, workout
 * stress capped at WO_CAP) to minimise RMSE vs Bevel's energy. Prints the best constants +
 * a trajectory comparison so you can paste the winners into src/services/bodyBattery.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REM_CAP = 13;     // REM_STRESS_CAP in the app
const WO_CAP_DEFAULT = 65;

const arg = (i, d) => process.argv[i] || d;
const calibPath = arg(2, '/tmp/calib.json');
const home = os.homedir();
// Energy target: the standalone "Energy Bank Data*.md" OR the combined "Stress And Energy*.md"
// (parseMd grabs the first numeric column after the time = the energy in both layouts).
const energyPath = arg(3, findDownload('Stress And Energy') || findDownload('Energy Bank'));
const stressPath = arg(4, findDownload('Stress Data'));

function findDownload(prefix) {
  const dir = path.join(home, 'Downloads');
  try {
    const f = fs.readdirSync(dir).filter(n => n.startsWith(prefix) && n.endsWith('.md')).sort().pop();
    return f ? path.join(dir, f) : '';
  } catch { return ''; }
}

// ── parse a Bevel markdown table: rows of | HH:MM | value | ──────────────────────
function parseMd(file) {
  const out = [];
  if (!file || !fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\|\s*(\d{2}:\d{2})\s*\|\s*([\d.]+|NaN)\s*\|/);
    if (m) out.push({ t: m[1], v: m[2] === 'NaN' ? NaN : parseFloat(m[2]) });
  }
  return out;
}

// Map HH:MM in an overnight window to a monotonic minute index (22:00 → 1320 … 11:xx → 2100).
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return (h < 22 ? h + 24 : h) * 60 + m; };

// ── load Bevel energy ───────────────────────────────────────────────────────────
const E = parseMd(energyPath).filter(r => !Number.isNaN(r.v)).map(r => ({ min: toMin(r.t), e: r.v }));
if (!E.length) { console.error('No Bevel energy rows — check', energyPath); process.exit(1); }
E.sort((a, b) => a.min - b.min);
const energyAt = (min) => { // linear interp
  if (min <= E[0].min) return E[0].e;
  if (min >= E[E.length - 1].min) return E[E.length - 1].e;
  for (let i = 1; i < E.length; i++) if (E[i].min >= min) {
    const a = E[i - 1], b = E[i], f = (min - a.min) / (b.min - a.min); return a.e + f * (b.e - a.e);
  }
  return E[E.length - 1].e;
};
const eStart = E[0].min, eEnd = E[E.length - 1].min;

// ── load our calibration dump → per-bin clock minute + stress + asleep + workout ──
const dump = JSON.parse(fs.readFileSync(calibPath, 'utf8'));
const now = dump.meta?.now; const WINDOW_H = dump.meta?.constants?.WINDOW_H ?? 60;
if (!now || !Array.isArray(dump.bins)) { console.error('calib dump missing meta.now / bins'); process.exit(1); }
const startMs = now - WINDOW_H * 3600_000;
const ours = dump.bins.map(b => {
  const d = new Date(startMs + b.m * 60_000);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return { min: toMin(hhmm), s: b.s, s0: b.s0 ?? b.s, asleep: b.a === 1, workout: b.wo === 1, stg: b.stg };
}).filter(o => o.min >= eStart && o.min <= eEnd) // only the window Bevel covers
  .sort((a, b) => a.min - b.min);
if (ours.length < 10) { console.error('Too few overlapping bins with Bevel window'); process.exit(1); }

// ── integrate + score ─────────────────────────────────────────────────────────────
function sim(CB, CK, DB, DK, WO_CAP, useS0 = false) {
  let bat = energyAt(ours[0].min); // anchor to Bevel start
  const out = [];
  for (let i = 0; i < ours.length; i++) {
    const o = ours[i];
    const S = useS0 ? o.s0 : o.s; // raw (A) vs day-corrected (B) stress
    const dtH = i === 0 ? 0 : (ours[i].min - ours[i - 1].min) / 60;
    let rate;
    if (o.asleep) { const s = o.stg === 5 ? Math.min(S, REM_CAP) : S; rate = Math.max(0, CB - CK * s); }
    else { const ds = o.workout ? Math.min(WO_CAP, Math.max(S, 80)) : S; rate = DB - DK * ds; }
    bat = Math.max(0, Math.min(100, bat + rate * dtH));
    out.push({ min: o.min, bat });
  }
  return out;
}
function rmse(simOut) {
  let e = 0, n = 0;
  for (const p of simOut) { const target = energyAt(p.min); e += (p.bat - target) ** 2; n++; }
  return Math.sqrt(e / n);
}

let best = null;
for (let CB = 14; CB <= 24; CB += 1)
  for (let CK = 0.3; CK <= 0.75; CK += 0.05)
    for (let DB = 0.25; DB <= 1.75; DB += 0.25)
      for (let DK = 0.08; DK <= 0.2; DK += 0.01) {
        const r = rmse(sim(CB, CK, DB, DK, WO_CAP_DEFAULT));
        if (!best || r < best.r) best = { CB, CK: +CK.toFixed(2), DB, DK: +DK.toFixed(3), r: +r.toFixed(2) };
      }

console.log('Bevel window:', E[0].e, '→ peak', Math.max(...E.map(r => r.e)), '(', E.length, 'pts )');
console.log('overlapping our-bins:', ours.length);
// A vs B head-to-head, charge held at Bevel's native fit (17 / 0.45):
const A = rmse(sim(17, 0.45, 0.75, 0.13, WO_CAP_DEFAULT, true));  // raw stress (s0) + steeper drain
const B = rmse(sim(17, 0.45, 0.75, 0.11, WO_CAP_DEFAULT, false)); // day-corrected stress (s) + native drain
console.log('\n=== A vs B (energy RMSE vs Bevel; lower is better) ===');
console.log('  (A) raw stress  + drain 0.75−0.13·s :', A.toFixed(2));
console.log('  (B) corrected s + drain 0.75−0.11·s :', B.toFixed(2), B < A ? '  ← B wins' : '');
console.log('\nBEST free-fit (on corrected s):', JSON.stringify(best));
console.log('\n  → paste into bodyBattery.ts: CHARGE_BASE', best.CB, 'CHARGE_STRESS_K', best.CK, 'DRAIN_BASE', best.DB, 'DRAIN_STRESS_K', best.DK);

// trajectory at a few clock points
const fitSim = sim(best.CB, best.CK, best.DB, best.DK, WO_CAP_DEFAULT);
const showAt = (label, min) => {
  const p = fitSim.reduce((a, b) => Math.abs(b.min - min) < Math.abs(a.min - min) ? b : a);
  console.log(`  ${label}: bevel ${Math.round(energyAt(min))}  fit ${Math.round(p.bat)}`);
};
console.log('\ntrajectory (bevel vs fit):');
[['bedtime', eStart], ['+3h', eStart + 180], ['wake~', 360 + 22 * 60 + 12], ['+later', eEnd]].forEach(([l, m]) => showAt(l, m));
