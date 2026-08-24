// "Not dancing this week" override: marking the forward Thursday's date frees it — on a BUILD week Thursday
// becomes an easy run (the extra run-day the block needs), and the following Friday is no longer day-after-dance.
// Run: node --import ./harness/register.mjs harness/dancefree.mjs
const p = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
const today = new Date('2026-08-24T00:00:00');
const rt = [];
for (let i = 27; i >= 0; i--) {
  const d = new Date(today); d.setDate(d.getDate() - i); const dow = d.getDay();
  const min = dow === 1 ? 45 : dow === 3 ? 25 : dow === 6 ? 25 : (dow === 2 || dow === 5) ? 30 : 0;
  rt.push({ date: iso(d), min });
}
globalThis.__HARNESS_SEED = {
  secureStore: { plan_mode_v1: 'leisure', load_cap_pct: '10', min_tsb: '-16',
    periodization_v1: JSON.stringify({ on: true, buildWeeks: 4, deloadWeeks: 1, deloadDropPct: 25, anchor: '2026-06-29' }),
    dance_off_dates_v1: JSON.stringify(['2026-08-27']) },   // Thursday marked "not dancing"
  files: { 'mem://coach-knowledge/running-schedule.md':
    '# Weekly Schedule\n- Mon: Long run\n- Tue: recovery/easy\n- Wed: Tempo\n- Thu: rest + dancing (evening)\n- Fri: recovery/easy\n- Sat: Intervals\n- Sun: rest\n' },
};
const coach = await import('../src/services/coach.ts');
const capCtx = await coach.buildCapContext(rt.map(d => ({ date: d.date, value: d.min })), today, 10, 'tof');
const snap = {
  date: '2026-08-24', readiness: 60, acwr: 1.33, ctl: 43.4, atl: 57.9, tsb: -14.5, loadCapPct: 10, loadUnit: 'min', loadCapBasis: 'trimp',
  recentTimeOnFeet: capCtx.tof.series14, recentTof28: capCtx.tof.series28, heatByDate: capCtx.heatCredit,
  tof7d: capCtx.tof.tof7d, tofPrev7d: capCtx.tof.tofPrev7d,
};
const wk = await coach.getWeekPlan(snap);
const thu = wk.find(d => d.weekday === 'Thu');
const fri = wk.find(d => d.weekday === 'Fri');
console.log(`With Thu 08-27 marked no-dance: Thu = ${thu.intensity} ${thu.runMinutes}m · Fri = ${fri.intensity} ${fri.runMinutes}m`);
// Thu (normally rest+dance) becomes a run; Fri stays a run (no longer day-after-dance).
const ok = thu.intensity !== 'rest' && thu.runMinutes > 0 && fri.intensity !== 'rest';
console.log(ok ? `\n✅ PASS — no-dance freed Thursday to a ${thu.runMinutes}m run; Friday still trains`
               : `\n❌ FAIL — dance-off override didn't free Thursday (Thu ${thu.intensity})`);
process.exit(ok ? 0 : 1);
