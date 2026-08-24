// Deload week trims QUALITY too: on a deload week the long/tempo/intervals are shortened (× 1-deloadDrop%),
// not just the easy volume — else the block never actually deloads. (Regression for "Monday long shows full
// length on the deload week".) Run: node --import ./harness/register.mjs harness/deloadq.mjs
const p = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
// today = Sun 2026-08-30 (last build day) ⇒ the whole forward week (Mon 08-31 …) is the DELOAD week.
const today = new Date('2026-08-30T00:00:00');
const rt = [];
for (let i = 27; i >= 0; i--) { const d = new Date(today); d.setDate(d.getDate() - i); const dow = d.getDay();
  rt.push({ date: iso(d), min: dow === 1 ? 60 : dow === 3 ? 30 : dow === 6 ? 25 : (dow === 2 || dow === 5) ? 35 : 0 }); }
globalThis.__HARNESS_SEED = {
  secureStore: { plan_mode_v1: 'leisure', load_cap_pct: '10', min_tsb: '-16', long_run_minutes: '70',
    periodization_v1: JSON.stringify({ on: true, buildWeeks: 4, deloadWeeks: 1, deloadDropPct: 25, anchor: '2026-06-29' }) },
  files: { 'mem://coach-knowledge/running-schedule.md':
    '# Weekly Schedule\n- Mon: Long run\n- Tue: recovery/easy\n- Wed: Tempo\n- Thu: recovery/easy\n- Fri: recovery/easy\n- Sat: Intervals\n- Sun: rest\n' },
};
const coach = await import('../src/services/coach.ts');
const capCtx = await coach.buildCapContext(rt.map(d => ({ date: d.date, value: d.min })), today, 10, 'tof');
const wk = await coach.getWeekPlan({
  date: '2026-08-30', readiness: 70, acwr: 1.0, ctl: 42, atl: 40, tsb: 2, loadCapPct: 10, loadUnit: 'min', loadCapBasis: 'trimp',
  recentTimeOnFeet: capCtx.tof.series14, recentTof28: capCtx.tof.series28, heatByDate: capCtx.heatCredit,
  tof7d: capCtx.tof.tof7d, tofPrev7d: capCtx.tof.tofPrev7d,
});
const long = wk.find(d => d.kind === 'long');
console.log('Deload-week phase check:', JSON.stringify(coach.cyclePhase(new Date('2026-08-31'), { on: true, buildWeeks: 4, deloadWeeks: 1, deloadDropPct: 25, anchor: '2026-06-29' })));
for (const d of wk) console.log(`  ${d.weekday} ${String(d.intensity).padEnd(8)} ${String(d.runMinutes).padStart(3)}m ${d.kind}`);
console.log(`\nconfigured long 70m · deload long = ${long?.runMinutes}m`);
// A 70-min long at 25% deload should land ~52m; assert it's clearly shortened (< 60), not full-length.
const ok = !!long && long.runMinutes > 0 && long.runMinutes < 60;
console.log(ok ? `✅ PASS — deload week shortened the long to ${long.runMinutes}m (< 60, was full 70)`
               : `❌ FAIL — deload didn't shorten the long (${long?.runMinutes}m)`);
process.exit(ok ? 0 : 1);
