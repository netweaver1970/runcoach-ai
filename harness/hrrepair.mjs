// HR-reliability detection + power-derived TRIMP repair.
// Run: node --import ./harness/register.mjs harness/hrrepair.mjs
import { assessHrReliability, powerTrimp, computeStrainTrimp } from '../src/services/trainingLoad.ts';
import { powerToHrrFrac } from '../src/services/zones.ts';

const T0 = new Date(2026, 7, 12, 6, 15, 0).getTime();     // fixed base time
const min = (m) => T0 + m * 60_000;
let fails = 0;
const ok = (cond, label, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); if (!cond) fails++; };

// A realistic clean 17-min threshold effort: HR ramps 110→158 over the first 3 min then holds ~158
// (threshold HR) for the remaining 14 min, with normal beat-to-beat jitter, ~1 sample / 5 s.
const clean = [];
for (let s = 0; s <= 17 * 60; s += 5) {
  const ramp = Math.min(1, s / (3 * 60));       // 0→1 over first 3 min
  const base = 110 + ramp * 48;                 // 110 → 158, then flat 158
  const jitter = ((s / 5) % 5) - 2;             // deterministic ±2 wobble (no Math.random in harness)
  clean.push({ t: T0 + s * 1000, hr: Math.round(base + jitter) });
}
const winS = T0, winE = min(17);

// A flat-lined series: same window but HR HOLDS 138 for a 6-min plateau in the middle (sensor stuck).
const flat = clean.map(p => {
  const s = (p.t - T0) / 1000;
  return (s >= 6 * 60 && s <= 12 * 60) ? { t: p.t, hr: 138 } : p;
});

// A gappy series: drop every sample between minute 7 and 13 (dropout).
const gappy = clean.filter(p => { const s = (p.t - T0) / 1000; return !(s > 7 * 60 && s < 13 * 60); });

console.log('\n=== assessHrReliability ===');
const rc = assessHrReliability(clean, winS, winE);
ok(!rc.unreliable, 'clean series is reliable', `flatFrac=${rc.flatFrac.toFixed(2)} gapFrac=${rc.gapFrac.toFixed(2)}`);
const rf = assessHrReliability(flat, winS, winE);
ok(rf.unreliable, 'flat plateau is UNreliable', `flatFrac=${rf.flatFrac.toFixed(2)}`);
const rg = assessHrReliability(gappy, winS, winE);
ok(rg.unreliable, 'gappy series is UNreliable', `gapFrac=${rg.gapFrac.toFixed(2)}`);
ok(assessHrReliability([{ t: winS, hr: 120 }], winS, winE).unreliable, 'too-few-samples is UNreliable');

console.log('\n=== computeStrainTrimp: repairs are backward-compatible ===');
const restHR = 59, maxHR = 188, win = [{ s: winS, e: winE }];
const tClean = computeStrainTrimp(clean, restHR, maxHR, win);
const tCleanNoRepair = computeStrainTrimp(clean, restHR, maxHR, win, []);
ok(tClean === tCleanNoRepair && tClean > 0, 'empty repairs == no repairs', `trimp=${tClean}`);

console.log('\n=== power repair raises a flat-lined run back toward the clean value ===');
// Zones ~ Geert: threshold power ≈ 279 → work power series around 279 W.
const pz = { recoveryMax: 195, z2Max: 250, tempoMin: 260, tempoMax: 288, intervalsMin: 305 };
const p2h = powerToHrrFrac(pz);
const power = [];
for (let s = 0; s <= 17 * 60; s += 1) power.push({ t: T0 + s * 1000, w: 279 });   // steady 279 W work
const pTrimp = powerTrimp(power, winS, winE, p2h);

const tFlatRaw    = computeStrainTrimp(flat, restHR, maxHR, win);                                  // flat HR, no repair
const tFlatFixed  = computeStrainTrimp(flat, restHR, maxHR, win, [{ s: winS, e: winE, trimp: pTrimp }]);
ok(pTrimp > 0, 'powerTrimp(279W, 17min) > 0', `= ${pTrimp.toFixed(0)}`);
ok(tFlatRaw < tClean, 'flat-lined run under-counts vs a clean threshold trace', `flatRaw=${tFlatRaw} clean=${tClean}`);
ok(tFlatFixed > tFlatRaw, 'repaired flat run > raw flat run', `raw=${tFlatRaw} fixed=${tFlatFixed}`);
ok(Math.abs(tFlatFixed - tClean) <= tClean * 0.20, 'repaired ≈ clean threshold trace (±20%)', `clean=${tClean} fixed=${tFlatFixed}`);
ok(Math.abs(p2h(279) - 0.768) < 0.01, 'powerToHrrFrac(279W) ≈ 0.77 (Z3/Z4 edge)', `= ${p2h(279).toFixed(3)}`);
ok(p2h(100) === 0.50 || Math.abs(p2h(100) - (0.50 + 0.10 * (100 / 195))) < 0.01, 'powerToHrrFrac low end sane', `p2h(100)=${p2h(100).toFixed(3)}`);

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
