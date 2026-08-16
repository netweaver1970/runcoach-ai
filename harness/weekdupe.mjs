/**
 * Reproduces the "two long runs in one week" bug against the REAL getWeekPlan.
 *
 * Geert's schedule has exactly ONE long (Mon) yet the 7-day plan produced a Long on Tuesday AND a Long on
 * Friday. Seeds the actual schedule file + a snapshot shaped like his state (ATL just above CTL, so the
 * rolling cap starves the first day and the Monday long gets deferred).
 *
 * Run: node --import ./harness/register.mjs harness/weekdupe.mjs
 */
const USE_DEFAULT = process.argv.includes('--default');
const SCHEDULE_DEFAULT = `# Preferred Weekly Structure
- Mon: Intervals (harder quality) — only if readiness allows
- Tue: Recovery run or rest
- Wed: Tempo run — only if readiness allows
- Thu: Recovery run or rest
- Fri: Long run
- Sat: Recovery run or rest
- Sun: Recovery run or rest`;
const SCHEDULE_SAVED = `# Weekly Schedule
– Mon: Long run
– Tue: recovery/easy
– Wed: Tempo
– Thu: rest + dancing (evening)
– Fri: recovery/easy
– Sat: Intervals
– Sun: rest`;
const SCHEDULE = USE_DEFAULT ? SCHEDULE_DEFAULT : SCHEDULE_SAVED;

// Seed BEFORE importing coach.ts (module-level reads pick this up).
globalThis.__HARNESS_SEED = { files: { 'mem://coach-knowledge/running-schedule.md': SCHEDULE } };

const { getWeekPlan } = await import('../src/services/coach.ts');

// Sunday 2026-08-16 → the plan starts Monday 17th, matching the screenshot.
const TODAY = '2026-08-16';
const day = (n) => { const d = new Date('2026-08-16T00:00:00'); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

// ~14 days of running minutes with the long runs on FRIDAYS (his old schema) so the ramp has real history.
const recentTimeOnFeet = [], recentRuns = [];
for (let i = 13; i >= 0; i--) {
  const date = day(i), dow = new Date(date + 'T00:00:00').getDay();
  let min = 0, type = null;
  if (dow === 1) { min = 24; type = 'Intervals'; }
  else if (dow === 3) { min = 30; type = 'Tempo'; }
  else if (dow === 5) { min = 54; type = 'LongRun'; }
  else if (dow === 2 || dow === 6) { min = 28; type = 'Z2'; }
  recentTimeOnFeet.push({ date, min });
  if (type) recentRuns.push({ date, km: min / 6, type });
}
const recentTof28 = recentTimeOnFeet;

const snap = {
  date: TODAY,
  readiness: 72, recovery: 70,            // green — quality is allowed
  strainReal: 20, advisableLow: 30, advisableHigh: 60,
  ctl: 40, atl: 41, tsb: -1,              // fatigue just above fitness, like the screenshot
  recentTimeOnFeet, recentTof28, recentRuns,
  recentStrain: [30, 35, 28, 40, 33, 30, 25],
  tof7d: 190, tofPrev7d: 180,
  loadCapPct: 10, loadCapBasis: 'tof', loadUnit: 'min',
  paceMinPerKm: 6, heatByDate: {},
  weather: { tempC: 17, apparentC: 17, humidity: 60, windKmh: 5 },
};

const days = await getWeekPlan(snap);
console.log('date        day  kind        intensity  min   note');
for (const d of days) {
  console.log(`${d.date}  ${d.weekday}  ${String(d.kind).padEnd(10)}  ${String(d.intensity).padEnd(9)}  ${String(d.runMinutes).padStart(3)}   ${d.note}`);
}
const longs = days.filter(d => d.kind === 'long');
const quality = days.filter(d => ['long', 'tempo', 'intervals'].includes(d.kind));
console.log(`\nlong days: ${longs.length} (${longs.map(l => l.weekday).join(', ') || '—'})`);
console.log(`quality:   ${quality.map(q => `${q.weekday}=${q.kind}`).join(', ')}`);

let fails = 0;
const check = (label, cond, detail) => { if (!cond) fails++; console.log(`${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`); };
console.log('');
check('exactly ONE long run in the week', longs.length === 1, `got ${longs.length}`);
check('no quality on Thu (dance night)', !['long', 'tempo', 'intervals'].includes(days.find(d => d.weekday === 'Thu')?.kind), days.find(d => d.weekday === 'Thu')?.kind);
check('no quality on Fri (day after dancing)', !['long', 'tempo', 'intervals'].includes(days.find(d => d.weekday === 'Fri')?.kind), days.find(d => d.weekday === 'Fri')?.kind);
console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nAll checks passed.');
process.exit(0);
