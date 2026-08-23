// Sanity-check plan adherence parsing + the .ics season-plan export.
// Run: node --import ./harness/register.mjs harness/adherencetest.mjs
import { parseAdherence } from '../src/services/adherence.ts';
import { seasonPlanToIcs } from '../src/services/planIcs.ts';

const log = [
  '# Prescription history',
  '- 2026-08-22 · Intervals 6×2min Z4 · ⬜ planned',   // past, MISSED
  '- 2026-08-21 · Tempo 20min Z3 · ✅ executed',
  '- 2026-08-20 · rest · ⬜ planned',                    // rest — ignored
  '- 2026-08-19 · Long 60min Z2 · ✅ executed',
  '- 2026-08-18 · Intervals reps · ⬜ planned',          // past, MISSED
  '- 2026-08-15 · Recovery 25min · ✅ executed',
  '- 2026-08-23 · Tempo · ⬜ planned',                   // TODAY — excluded (still pending)
].join('\n');

// The athlete actually RAN on 08-22 and 08-18 (log left them ⬜) — should now count as executed.
const ran = new Set(['2026-08-22', '2026-08-18', '2026-08-21', '2026-08-19', '2026-08-15']);
const a = parseAdherence(log, '2026-08-23', ran, 28);
console.log('=== adherence (with actual runs) ===');
console.log(JSON.stringify(a, null, 2));
console.log('expect prescribed=5 executed=5 pct=100 (all 5 run days actually ran)');

const plan = {
  weeks: [
    { monday: '2026-08-17', weeksToRace: 2, phase: 'Build', loadTarget: 308, deload: false, ctl: 40, atl: 41, tsb: -1 },
    { monday: '2026-08-24', weeksToRace: 1, phase: 'Taper', loadTarget: 129, deload: false, ctl: 37, atl: 27, tsb: 10 },
    { monday: '2026-08-31', weeksToRace: 0, phase: 'Race',  loadTarget: 99,  deload: false, ctl: 35, atl: 21, tsb: 14 },
  ],
  series: [], startCtl: 40, peakCtl: 40,
  race: { date: '2026-09-03', km: 10, ctl: 35, atl: 21, tsb: 14 }, note: 'x',
};
console.log('\n=== ics ===');
console.log(seasonPlanToIcs(plan, '10K 3 Sep', '20260823T120000Z'));
