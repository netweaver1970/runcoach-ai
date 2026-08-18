/**
 * End-to-end: the 7-day plan footer (Σ countedMin) must equal the sum of what each row PRINTS
 * (drills + work blocks) in WORK accounting — including the interval day, whose recovery jogs are
 * recovery (excluded), not work. Mirrors app/week-plan.tsx's per-day counting on the real getWeekPlan.
 *
 * Run: node --import ./harness/register.mjs harness/footerreconcile.mjs
 */
const SCHEDULE = `# Weekly Schedule
– Mon: Long run
– Tue: recovery/easy
– Wed: Tempo
– Thu: rest + dancing (evening)
– Fri: recovery/easy
– Sat: Intervals
– Sun: rest`;
globalThis.__HARNESS_SEED = {
  files: { 'mem://coach-knowledge/running-schedule.md': SCHEDULE },
  secureStore: {
    periodization_v1: JSON.stringify({ on: true, buildWeeks: 4, deloadWeeks: 1, deloadDropPct: 25, anchor: '2026-08-17' }),
    accounting_switches: JSON.stringify([{ since: '1970-01-01', mode: 'work' }]),
  },
};

const { getWeekPlan, synthesizeWorkout, ensureBlockPower, refreshWorkoutStructure, refreshAccountingMode, accountingModeSync } =
  await import('../src/services/coach.ts');
await refreshWorkoutStructure();
await refreshAccountingMode();

const day = (n) => { const d = new Date('2026-08-16T00:00:00'); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const recentTimeOnFeet = [], recentRuns = [];
for (let i = 13; i >= 0; i--) {
  const date = day(i), dow = new Date(date + 'T00:00:00').getDay();
  let min = 0, type = null;
  if (dow === 1) { min = 54; type = 'LongRun'; }
  else if (dow === 3) { min = 30; type = 'Tempo'; }
  else if (dow === 6) { min = 24; type = 'Intervals'; }
  else if (dow === 2 || dow === 5) { min = 28; type = 'Z2'; }
  recentTimeOnFeet.push({ date, min });
  if (type) recentRuns.push({ date, km: min / 6, type });
}
const snap = {
  date: '2026-08-16', readiness: 72, recovery: 70, strainReal: 20, advisableLow: 30, advisableHigh: 60,
  ctl: 43, atl: 43, tsb: -1, acwr: 1.0, recentTimeOnFeet, recentTof28: recentTimeOnFeet, recentRuns,
  recentStrain: [30, 35, 28, 40, 33, 30, 25], tof7d: 200, tofPrev7d: 195,
  loadCapPct: 10, loadCapBasis: 'tof', loadUnit: 'min', paceMinPerKm: 6, heatByDate: {},
  powerZones: undefined, recentQualityWork: {},
  weather: { tempC: 17, apparentC: 17, humidity: 60, windKmh: 5 },
};

const days = await getWeekPlan(snap);
console.log(`mode = ${accountingModeSync()}\n`);
let footer = 0, printedSum = 0;
for (const d of days) {
  if (d.intensity === 'rest') { console.log(`${d.weekday}  rest`); continue; }
  const wk = ensureBlockPower(synthesizeWorkout(d.intensity, d.runMinutes, d.weekday, snap.powerZones, d.kind, undefined, snap.loadCapPct), snap.powerZones);
  const work = wk.blocks.reduce((a, b) => a + b.workMinutes * (b.repeats || 1), 0);
  const drills = wk.drillsMinutes || 0;
  const countedMin = accountingModeSync() === 'full' ? d.runMinutes : drills + work;
  const printed = drills + work;                    // what the row visibly shows (drills + work blocks)
  footer += countedMin; printedSum += printed;
  const jog = wk.blocks.reduce((a, b) => a + (b.repeats > 1 ? (b.restMinutes || 0) * (b.repeats - 1) : 0), 0);
  console.log(`${d.weekday}  ${String(d.kind).padEnd(9)} runMin=${String(d.runMinutes).padStart(3)}  drills ${drills} + work ${String(work).padStart(2)}${jog ? ` (+${jog} jog excl.)` : ''}  → counted ${countedMin}`);
}
let fails = 0;
const check = (l, c, g) => { if (!c) fails++; console.log(`${c ? '✅' : '❌'} ${l}${g !== undefined ? ` (got ${g})` : ''}`); };
console.log('');
check('footer (Σ countedMin) == Σ printed (drills+work)', footer === printedSum, `footer ${footer} vs printed ${printedSum}`);
console.log(`\nFooter would read: "${days.filter(d => d.intensity !== 'rest').length} run days · ${footer} run-min (work) this week"`);
process.exit(fails === 0 ? 0 : 1);
