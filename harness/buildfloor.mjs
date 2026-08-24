// Build-week deeper-fatigue floor + maintenance floor: a fatigued athlete (TSB ~-14.5) on a BUILD week must
// be prescribed MORE than the same athlete on a DELOAD week — the build week peaks (deeper TSB floor + the
// maintenance floor) while the deload eases. Guards against "two easy weeks in a row" (build 4 == deload).
// Run: node --import ./harness/register.mjs harness/buildfloor.mjs
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
    periodization_v1: JSON.stringify({ on: true, buildWeeks: 4, deloadWeeks: 1, deloadDropPct: 25, anchor: '2026-06-29' }) },
  files: { 'mem://coach-knowledge/running-schedule.md':
    '# Weekly Schedule\n- Mon: Long run\n- Tue: recovery/easy\n- Wed: Tempo\n- Thu: rest + dancing (evening)\n- Fri: recovery/easy\n- Sat: Intervals\n- Sun: rest\n' },
};
const coach = await import('../src/services/coach.ts');
const capCtx = await coach.buildCapContext(rt.map(d => ({ date: d.date, value: d.min })), today, 10, 'tof');
const base = {
  readiness: 60, acwr: 1.33, ctl: 43.4, atl: 57.9, tsb: -14.5, loadCapPct: 10, loadUnit: 'min', loadCapBasis: 'trimp',
  recentTimeOnFeet: capCtx.tof.series14, recentTof28: capCtx.tof.series28, heatByDate: capCtx.heatCredit,
  tof7d: capCtx.tof.tof7d, tofPrev7d: capCtx.tof.tofPrev7d,
};
const totalFor = async (date) => {
  const wk = await coach.getWeekPlan({ ...base, date });
  return wk.reduce((a, d) => a + (d.intensity === 'rest' ? 0 : d.runMinutes), 0);
};
// 2026-08-24 = Build 4/4; 2026-08-31 = Deload week (anchor 2026-06-29, 4+1)
const buildTotal  = await totalFor('2026-08-24');
const deloadTotal = await totalFor('2026-08-31');
console.log(`Build 4/4 week: ${buildTotal}m · Deload week: ${deloadTotal}m`);
const ok = buildTotal >= deloadTotal + 25;   // the build week must clearly out-prescribe the deload, not read as a 2nd deload
console.log(ok ? `\n✅ PASS — build week peaks above the deload (${buildTotal} > ${deloadTotal}); not two easy weeks`
               : `\n❌ FAIL — build week (${buildTotal}) ≈ deload (${deloadTotal}); 4-on/1-off collapsed to two easy weeks`);
process.exit(ok ? 0 : 1);
