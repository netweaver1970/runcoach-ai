/**
 * CTL must be RANGE-INVARIANT: the value for a given day can't depend on whether you're viewing 1M/3M/6M/1Y.
 * The screen warms the 42-day EWMA `warmDays` before the RANGE START, so a short range reaches less far back
 * and under-converges (Geert saw 40 / 42 / 41 / 41). This shows a deeper warm-up removes the spread.
 * Run: node --import ./harness/register.mjs harness/ctlrange.mjs
 */
import { computeTrainingLoadSeries } from '../src/services/trainingLoad.ts';

const p = (n) => String(n).padStart(2, '0');
const iso = (ago) => { const d = new Date(2026, 7, 18); d.setDate(d.getDate() - ago); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
// Geert's actual shape: high fitness in winter (deep past), a spring trough, building now. The warm-up seed
// (first day of the map = rangeStart − warmDays) lands on a WILDLY different load for each range, which is
// what makes a shallow warm-up give range-dependent CTL (his 40 / 42 / 41 / 41).
const loadAt = (ago) =>
  ago <= 60  ? 48 :   // building now
  ago <= 150 ? 28 :   // spring/summer trough
  ago <= 260 ? 46 :   // late-winter
  ago <= 400 ? 60 :   // winter peak (high fitness)
               34;    // last autumn

// One caller = one (range, warmDays): builds the load map from (rangeStart − warmDays) to today, then reads
// CTL at today. Mirrors fetchTrainingLoadHistory(months) with warmFrom = fromDate − CARDIO_WARM_DAYS.
const ctlAtToday = (rangeDays, warmDays) => {
  const map = new Map();
  for (let ago = rangeDays + warmDays; ago >= 0; ago--) map.set(iso(ago), loadAt(ago));
  const from = new Date(2026, 7, 18); from.setDate(from.getDate() - rangeDays);
  const end  = new Date(2026, 7, 18);
  const s = computeTrainingLoadSeries(map, from, end);
  return s[s.length - 1].ctl;
};

const ranges = [[30, '1M'], [90, '3M'], [180, '6M'], [365, '1Y']];
const run = (warmDays) => ranges.map(([d]) => ctlAtToday(d, warmDays));
const spread = (a) => Math.round((Math.max(...a) - Math.min(...a)) * 10) / 10;

const cur = run(120), fixed = run(240);
let fails = 0;
const check = (l, c, g) => { if (!c) fails++; console.log(`${c ? '✅' : '❌'} ${l}${g !== undefined ? ` (got ${g})` : ''}`); };

console.log('\nCTL at today by range:');
console.log('  warm 120 (current):', ranges.map((r, i) => `${r[1]} ${cur[i]}`).join('  '), ` spread ${spread(cur)}`);
console.log('  warm 240 (fixed):  ', ranges.map((r, i) => `${r[1]} ${fixed[i]}`).join('  '), ` spread ${spread(fixed)}`);

check('current 120-day warm-up IS range-dependent (the bug)', spread(cur) >= 0.4, `spread ${spread(cur)}`);
check('240-day warm-up is range-INVARIANT (≤0.3)', spread(fixed) <= 0.3, `spread ${spread(fixed)}`);
console.log(`\n${fails === 0 ? '✅ ALL PASS' : `❌ ${fails} FAIL(S)`}`);
process.exit(fails === 0 ? 0 : 1);
