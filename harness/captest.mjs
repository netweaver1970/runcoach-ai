// Focused numeric test of computeTimeOnFeetPlan's anti-heat-erosion behaviour.
// Run: node --import ./harness/register.mjs harness/captest.mjs
import { computeTimeOnFeetPlan } from '../src/services/coach.ts';

const TODAY = new Date(2026, 7, 10);            // fixed (Aug 10 2026) — no Date.now() in the engine's path
const p = (n) => String(n).padStart(2, '0');
const dstr = (ago) => { const d = new Date(TODAY); d.setDate(d.getDate() - ago); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

// Build a daily {date,value} series from a per-day-ago minutes function (offset 1..27; today=0 rest).
const series = (minsAtAgo) => { const out = []; for (let o = 27; o >= 0; o--) out.push({ date: dstr(o), value: minsAtAgo(o) }); return out; };

// A "week pattern": run 30 (or given) on Mon/Wed/Fri-like cadence — here just 3 run days per 7-block.
const weekVal = (o, perRun) => ([1, 3, 5].includes(o % 7) ? perRun : 0);

const run = (label, daily, opts) => {
  const r = computeTimeOnFeetPlan(daily, TODAY, { capPct: 10, meaningful: 20, reentryBelow: 30, reentryFloor: 20, ...opts });
  console.log(`${label.padEnd(46)} cap7d=${String(r.cap7dMin).padStart(4)}  budgetToday=${String(r.budgetTodayMin).padStart(3)}  nextRun=+${r.nextRunInDays}d  prev7raw=${r.tofPrev7d}`);
  return r;
};

console.log('\n=== A. Steady 90/wk, no heat — new code must equal old ===');
const steady = series((o) => weekVal(o, 30));
run('old  (baseWindows=1, no credit)', steady, { baseWindows: 1 });
run('new  (baseWindows=3, no credit)', steady, { baseWindows: 3 });

console.log('\n=== B. One heat-cut week (60) between normal weeks (90) — erosion test ===');
// prev7 (7-13 ago) = 60; weeks 14-20 & 21-27 = 90.
const dip = series((o) => (o >= 7 && o <= 13) ? weekVal(o, 20) : weekVal(o, 30));
run('baseWindows=1 (OLD → eroded)', dip, { baseWindows: 1 });
run('baseWindows=3 (NEW → holds)', dip, { baseWindows: 3 });

console.log('\n=== C. Heat-credit lifts a hot week (raw 60, factor 1.3 capped 1.15) ===');
const hotWeek = series((o) => (o >= 7 && o <= 13) ? weekVal(o, 20) : weekVal(o, 30));
const heat = {}; for (let o = 7; o <= 13; o++) if (weekVal(o, 20)) heat[dstr(o)] = 1.3;
run('baseWindows=1, no credit', hotWeek, { baseWindows: 1 });
run('baseWindows=1, heat-credit', hotWeek, { baseWindows: 1, heatCredit: heat, heatCreditMax: 1.15 });

console.log('\n=== D. Sustained heat, all weeks raw 60 + factor 1.3 — RUNAWAY guard ===');
const allHot = series((o) => weekVal(o, 20));
const heatAll = {}; for (let o = 1; o <= 27; o++) if (weekVal(o, 20)) heatAll[dstr(o)] = 1.3;
run('baseWindows=3 + credit (bounded?)', allHot, { baseWindows: 3, heatCredit: heatAll, heatCreditMax: 1.15 });
console.log('  → raw week = 60; credited base should be ~69 (60×1.15), cap ~76 — NOT spiralling above ~+15%.');

console.log('\n=== E. Re-entry (near-zero base) still floors a short run ===');
const empty = series(() => 0);
run('baseWindows=3, empty history', empty, { baseWindows: 3 });
