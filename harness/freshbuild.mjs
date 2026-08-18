// Focused test: build-week freshness relaxation + faster long-run step.
// Run: node --import ./harness/register.mjs harness/freshbuild.mjs
import { freshnessCapFactor, buildTypeRamp } from '../src/services/coach.ts';

let fails = 0;
const approx = (a, b, eps = 0.001) => Math.abs(a - b) <= eps;
const ok = (cond, label, got) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${got !== undefined ? `  (got ${got})` : ''}`); if (!cond) fails++; };

console.log('\n=== 1. Non-build MUST equal the 2-arg call (no regression) ===');
for (const tsb of [-30, -18, -15, -8, -1, 0, 5, 13, 20]) {
  for (const acwr of [0.8, 1.0, 1.2, 1.3, 1.4, 1.5, 1.6, null]) {
    const a = freshnessCapFactor(tsb, acwr);
    const b = freshnessCapFactor(tsb, acwr, false);
    ok(a === b, `identical @ tsb=${tsb} acwr=${acwr}`, `${a} vs ${b}`);
  }
}

console.log('\n=== 2. Current state (ACWR 1.0, TSB -1): build nudges up, deload neutral ===');
ok(approx(freshnessCapFactor(-1, 1.0, false), 1.0), 'deload neutral', freshnessCapFactor(-1, 1.0, false));
ok(approx(freshnessCapFactor(-1, 1.0, true), 1.067), 'build +6.7%', freshnessCapFactor(-1, 1.0, true));

console.log('\n=== 3. Build DEFERS the mild ACWR cut (1.3<acwr<=1.45) ===');
ok(approx(freshnessCapFactor(2, 1.4, false), 0.90), 'deload cuts at 1.4', freshnessCapFactor(2, 1.4, false));
ok(freshnessCapFactor(2, 1.4, true) >= 1.0, 'build no cut at 1.4', freshnessCapFactor(2, 1.4, true));

console.log('\n=== 4. Build DEFERS the deep-fatigue cut (-22<tsb<=-15) ===');
ok(approx(freshnessCapFactor(-18, 1.0, false), 0.90), 'deload cuts at tsb -18', freshnessCapFactor(-18, 1.0, false));
ok(approx(freshnessCapFactor(-18, 1.0, true), 1.0), 'build neutral at tsb -18', freshnessCapFactor(-18, 1.0, true));

console.log('\n=== 5. Safety floor: a real spike (ACWR>1.5) hard-tightens on BOTH ===');
ok(approx(freshnessCapFactor(0, 1.6, false), 0.75), 'deload hard cut', freshnessCapFactor(0, 1.6, false));
ok(approx(freshnessCapFactor(0, 1.6, true), 0.75), 'build STILL hard cut', freshnessCapFactor(0, 1.6, true));

console.log('\n=== 6. Bounds never exceeded [0.75, 1.20] on build ===');
let boundOk = true;
for (const tsb of [-40, -8, 0, 13, 40]) for (const acwr of [0.7, 1.0, 1.45, 2.0]) {
  const f = freshnessCapFactor(tsb, acwr, true);
  if (f < 0.75 - 1e-9 || f > 1.20 + 1e-9) { boundOk = false; console.log(`  OUT OF BOUNDS tsb=${tsb} acwr=${acwr} -> ${f}`); }
}
ok(boundOk, 'all build factors within [0.75,1.20]');

console.log('\n=== 7. Long-run step: build allows +14/wk, deload +10/wk ===');
// recentTof: last long was 45 min on a Monday (getDay()==1); recentRuns labels it "Long run".
const recentTof = [{ date: '2026-08-10', min: 45 }];               // Aug 10 2026 is a Monday
const recentRuns = [{ date: '2026-08-10', type: 'Long run' }];
const ramp = buildTypeRamp(recentTof, recentRuns, 10);
// fullBase huge so the STEP backstop (recent+step), not the %-cap, binds. recent=45 → +cap%=49.5.
const longDeload = ramp(1, 999, true, 'long', false);   // min(49.5, 45+10=55) => 50 (rounded 49.5→50)
const longBuild  = ramp(1, 999, true, 'long', true);    // min(49.5, 45+14=59) => 50  (%-cap still binds here)
ok(longDeload === 50, 'deload long = %-capped 50', longDeload);
ok(longBuild  === 50, 'build long = %-capped 50 (step is a backstop, not a target)', longBuild);
// Now make the %-cap loose (capPct 40) so the STEP backstop is the binding constraint and the two diverge.
const rampLoose = buildTypeRamp(recentTof, recentRuns, 40);
const dLoose = rampLoose(1, 999, true, 'long', false);  // min(63, 45+10=55) => 55
const bLoose = rampLoose(1, 999, true, 'long', true);   // min(63, 45+14=59) => 59
ok(dLoose === 55, 'deload long step-capped at +10 => 55', dLoose);
ok(bLoose === 59, 'build long step-capped at +14 => 59', bLoose);

console.log(`\n${fails === 0 ? '✅ ALL PASS' : `❌ ${fails} FAIL(S)`}`);
process.exit(fails === 0 ? 0 : 1);
