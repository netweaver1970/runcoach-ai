// Progressive-fill regression: a HEALTHY build week that would park below its +cap% ceiling must be grown
// with easy volume up to ~recentMax × (1+cap%), so a compliant week actually builds CTL.
// Run: node --import ./harness/register.mjs harness/fillbuild.mjs
const p = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;

// 28 days of ToF ending "today": recent two weeks ~200 min (base), older weeks similar.
const today = new Date('2026-08-23T00:00:00');
const recentTimeOnFeet = [];
for (let i = 27; i >= 0; i--) {
  const d = new Date(today); d.setDate(d.getDate() - i);
  const dow = d.getDay();
  // Mon long 60, Wed tempo 25, Sat intervals 20, a couple easy 30, rest 0 → ~200/wk
  const min = dow === 1 ? 60 : dow === 3 ? 25 : dow === 6 ? 20 : dow === 2 || dow === 5 ? 30 : 0;
  recentTimeOnFeet.push({ date: iso(d), min });
}
const recentMax = Math.max(
  recentTimeOnFeet.slice(-7).reduce((a, b) => a + b.min, 0),
  recentTimeOnFeet.slice(-14, -7).reduce((a, b) => a + b.min, 0),
);

globalThis.__HARNESS_SEED = {
  secureStore: { plan_mode_v1: 'leisure', load_cap_pct: '10', min_tsb: '-16',
    periodization_v1: JSON.stringify({ on: true, buildWeeks: 4, deloadWeeks: 1, deloadDropPct: 25, anchor: '2026-06-01' }) },
  files: { 'mem://coach-knowledge/running-schedule.md':
    '# Weekly Schedule\n- Mon: Long run\n- Tue: recovery/easy\n- Wed: Tempo\n- Thu: rest\n- Fri: recovery/easy\n- Sat: Intervals\n- Sun: recovery/easy\n' },
};
const coach = await import('../src/services/coach.ts');
const toDate = new Date('2026-08-23T00:00:00');
const dur = recentTimeOnFeet.map((d) => ({ date: d.date, value: d.min }));
const capCtx = await coach.buildCapContext(dur, toDate, 10, 'tof');
const snap = {
  date: '2026-08-23', readiness: 65, acwr: 1.1, tsb: -6,
  recentTimeOnFeet: capCtx.tof.series14, recentTof28: capCtx.tof.series28, heatByDate: capCtx.heatCredit,
  tof7d: capCtx.tof.tof7d, tofPrev7d: capCtx.tof.tofPrev7d, loadCapPct: 10, loadUnit: 'min',
  ctl: 40, atl: 46, loadCapBasis: 'trimp',
};
const week = await coach.getWeekPlan(snap);
const total = week.reduce((a, d) => a + (d.intensity === 'rest' ? 0 : d.runMinutes), 0);
const ceiling = Math.round(recentMax * 1.10);
// A BUILD week is now floored at MAINTENANCE (CTL×7 in ToF-min) so it can't be prescribed below what holds
// fitness — bounded to +25%/wk over the recent base. So the fill target is max(+10% ceiling, maintenance).
const maintMin = Math.round((40 * 7) / 1.38);                 // ctl 40, easy ~1.38 TRIMP/min
const target = Math.min(Math.max(ceiling, maintMin), Math.round(recentMax * 1.25));
console.log(`recentMax ${recentMax}m · +10% ceiling ${ceiling}m · maintenance ${maintMin}m · target ${target}m · prescribed ${total}m`);
for (const d of week) console.log(`  ${d.weekday} ${String(d.intensity).padEnd(8)} ${String(d.runMinutes).padStart(3)}m ${d.kind}`);
const ok = total >= target - 12 && total <= target + 12;
console.log(ok ? `\n✅ PASS — build week filled to its target (${total} ≈ ${target}, maintenance-floored)`
                : `\n❌ FAIL — week off target (${total} vs ${target}); fill/maintenance-floor not working`);
process.exit(ok ? 0 : 1);
