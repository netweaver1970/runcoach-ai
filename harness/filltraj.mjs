// Trajectory-aware fill regression. Same athlete, same history, two forms:
//   FRESH   (TSB ~-3, ACWR ~1.05) → fill builds the week toward the +cap% ceiling.
//   FATIGUED (TSB ~-15, ACWR ~1.35, just did a hard long) → the fill FOLLOWS the projected TSB: the fatigued
//            FRONT of the week is held easy, and only the BACK (once projected form recovers) is grown.
// So the fatigued week must prescribe LESS total than the fresh one, and its growth must sit LATER in the week.
// Run: node --import ./harness/register.mjs harness/filltraj.mjs
const p = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;

const today = new Date('2026-08-24T00:00:00');
const recentTimeOnFeet = [];
for (let i = 27; i >= 0; i--) {
  const d = new Date(today); d.setDate(d.getDate() - i);
  const dow = d.getDay();
  // Mon long, Wed tempo, Sat intervals, Tue/Fri/Sun easy, Thu rest → recent weeks ~230min, ceiling well above base
  const min = dow === 1 ? 75 : dow === 3 ? 35 : dow === 6 ? 30 : dow === 2 || dow === 5 || dow === 0 ? 40 : 0;
  recentTimeOnFeet.push({ date: iso(d), min });
}
const recentMax = Math.max(
  recentTimeOnFeet.slice(-7).reduce((a, b) => a + b.min, 0),
  recentTimeOnFeet.slice(-14, -7).reduce((a, b) => a + b.min, 0),
);

globalThis.__HARNESS_SEED = {
  // LEISURE week (periodization off): the trajectory fill HOLDS the fatigued front and grows the recovered
  // back. (On a BUILD week the deeper floor deliberately pushes the front too — covered by buildfloor.mjs.)
  secureStore: { plan_mode_v1: 'leisure', load_cap_pct: '10', min_tsb: '-16', max_run_days: '5',
    periodization_v1: JSON.stringify({ on: false, buildWeeks: 4, deloadWeeks: 1, deloadDropPct: 25, anchor: '2026-06-01' }) },
  files: { 'mem://coach-knowledge/running-schedule.md':
    '# Weekly Schedule\n- Mon: Long run\n- Tue: recovery/easy\n- Wed: Tempo\n- Thu: rest\n- Fri: recovery/easy\n- Sat: Intervals\n- Sun: recovery/easy\n' },
};
const coach = await import('../src/services/coach.ts');
const toDate = new Date('2026-08-24T00:00:00');
const dur = recentTimeOnFeet.map((d) => ({ date: d.date, value: d.min }));
const capCtx = await coach.buildCapContext(dur, toDate, 10, 'tof');
const base = {
  date: '2026-08-24', readiness: 65,
  recentTimeOnFeet: capCtx.tof.series14, recentTof28: capCtx.tof.series28, heatByDate: capCtx.heatCredit,
  tof7d: capCtx.tof.tof7d, tofPrev7d: capCtx.tof.tofPrev7d, loadCapPct: 10, loadUnit: 'min', loadCapBasis: 'trimp',
};
const run = async (label, over) => {
  const week = await coach.getWeekPlan({ ...base, ...over });
  const total = week.reduce((a, d) => a + (d.intensity === 'rest' ? 0 : d.runMinutes), 0);
  const firstTwo = week.slice(0, 2).reduce((a, d) => a + (d.intensity === 'rest' ? 0 : d.runMinutes), 0);  // the fatigued FRONT
  console.log(`\n${label}: total ${total}m (ceiling ${Math.round(recentMax * 1.1)}m) · first-2-days ${firstTwo}m`);
  for (const d of week) console.log(`  ${d.weekday} ${String(d.intensity).padEnd(8)} ${String(d.runMinutes).padStart(3)}m ${d.kind}`);
  return { total, firstTwo };
};
const fresh    = await run('FRESH   ', { acwr: 1.05, tsb: -3,  ctl: 44, atl: 47 });
const fatigued = await run('FATIGUED', { acwr: 1.35, tsb: -15, ctl: 43, atl: 58 });

const lessWhenTired = fatigued.total < fresh.total - 5;            // fatigue holds the week back vs fresh
const frontHeld     = fatigued.firstTwo < fresh.firstTwo;         // the fatigued FRONT is held easy/rest vs fresh (it grows later)
console.log(`\nfatigued ${fatigued.total} < fresh ${fresh.total}? ${lessWhenTired}  ·  front held (${fatigued.firstTwo} < ${fresh.firstTwo})? ${frontHeld}`);
const ok = lessWhenTired && frontHeld;
console.log(ok ? `✅ PASS — fill follows the TSB trajectory (fatigued builds less, and later in the week)`
               : `❌ FAIL — fill ignored the trajectory`);
process.exit(ok ? 0 : 1);
