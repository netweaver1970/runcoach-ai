/**
 * Proves the build-week levers on Geert's real schedule (Mon Long, Wed Tempo, Thu dance, Sat Intervals):
 *   1. a BUILD week earns a 6th run day → Sunday's forced rest becomes an easy recovery jog;
 *   2. the long run still climbs (build step +14/wk backstop);
 *   3. the two-longs / Thu-dance invariants still hold.
 *
 * Run: node --import ./harness/register.mjs harness/sundayjog.mjs
 */
const SCHEDULE_SAVED = `# Weekly Schedule
– Mon: Long run
– Tue: recovery/easy
– Wed: Tempo
– Thu: rest + dancing (evening)
– Fri: recovery/easy
– Sat: Intervals
– Sun: rest`;

// Seed BEFORE importing coach.ts: the saved schedule + a periodization anchored so the plan week is BUILD.
// Aug 17 2026 is a Monday; anchor there → weekIndex 0 → "Build 1/4".
globalThis.__HARNESS_SEED = {
  files: { 'mem://coach-knowledge/running-schedule.md': SCHEDULE_SAVED },
  secureStore: {
    periodization_v1: JSON.stringify({ on: true, buildWeeks: 4, deloadWeeks: 1, deloadDropPct: 25, anchor: '2026-08-17' }),
  },
};

const { getWeekPlan, cyclePhase, getPeriodization } = await import('../src/services/coach.ts');

const TODAY = '2026-08-16';                 // Sunday → plan starts Mon 17th
const day = (n) => { const d = new Date('2026-08-16T00:00:00'); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const recentTimeOnFeet = [], recentRuns = [];
for (let i = 13; i >= 0; i--) {
  const date = day(i), dow = new Date(date + 'T00:00:00').getDay();
  let min = 0, type = null;
  if (dow === 1) { min = 54; type = 'LongRun'; }        // long now on MONDAY (his current schema)
  else if (dow === 3) { min = 30; type = 'Tempo'; }
  else if (dow === 6) { min = 24; type = 'Intervals'; }
  else if (dow === 2 || dow === 5) { min = 28; type = 'Z2'; }
  recentTimeOnFeet.push({ date, min });
  if (type) recentRuns.push({ date, km: min / 6, type });
}
const snap = {
  date: TODAY, readiness: 72, recovery: 70,
  strainReal: 20, advisableLow: 30, advisableHigh: 60,
  ctl: 43, atl: 43, tsb: -1, acwr: 1.0,           // the screenshot state
  recentTimeOnFeet, recentTof28: recentTimeOnFeet, recentRuns,
  recentStrain: [30, 35, 28, 40, 33, 30, 25],
  tof7d: 200, tofPrev7d: 195,
  loadCapPct: 10, loadCapBasis: 'tof', loadUnit: 'min',
  paceMinPerKm: 6, heatByDate: {},
  weather: { tempC: 17, apparentC: 17, humidity: 60, windKmh: 5 },
};

const per = await getPeriodization();
console.log('periodization phase for plan week:', cyclePhase(new Date('2026-08-17T00:00:00'), per).label);

const days = await getWeekPlan(snap);
console.log('\ndate        day  kind        intensity  min   note');
for (const d of days) console.log(`${d.date}  ${d.weekday}  ${String(d.kind).padEnd(10)}  ${String(d.intensity).padEnd(9)}  ${String(d.runMinutes).padStart(3)}   ${d.note}`);

const byDow = (w) => days.find(d => d.weekday === w);
const sun = byDow('Sun');
const runDays = days.filter(d => d.intensity !== 'rest').length;
const longs = days.filter(d => d.kind === 'long');
const long = longs[0];

let fails = 0;
const check = (label, cond, detail) => { if (!cond) fails++; console.log(`${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`); };
console.log('');
check('build week: Sunday is now an easy recovery jog (not rest)', sun && sun.intensity !== 'rest' && sun.kind === 'easy', `Sun=${sun?.intensity}/${sun?.kind} ${sun?.runMinutes}min`);
check('build week: 6 run days', runDays === 6, `got ${runDays}`);
check('still exactly ONE long run', longs.length === 1, `got ${longs.length}`);
check('long climbed above last week (54) toward target', long && long.runMinutes > 54, `long=${long?.runMinutes}min`);
check('no quality on Thu (dance) / Fri (day after)', !['long','tempo','intervals'].includes(byDow('Thu')?.kind) && !['long','tempo','intervals'].includes(byDow('Fri')?.kind), `Thu=${byDow('Thu')?.kind} Fri=${byDow('Fri')?.kind}`);

console.log(`\n${fails === 0 ? '✅ ALL PASS' : `❌ ${fails} FAIL(S)`}`);
process.exit(fails === 0 ? 0 : 1);
