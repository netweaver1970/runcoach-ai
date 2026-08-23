// Sanity-check the season/block plan: phases, load ramp, deloads, taper, and the forward PMC.
// Run: node --import ./harness/register.mjs harness/seasontest.mjs
import { buildSeasonPlan } from '../src/services/seasonPlan.ts';

// Build a synthetic ~4-month history that has converged CTL ~40 (daily load ~40).
function hist(days, dailyLoad) {
  const out = [];
  const start = new Date('2026-04-25T00:00:00');
  let atl = dailyLoad, ctl = dailyLoad;
  const La = 1 - Math.exp(-1 / 7), Lc = 1 - Math.exp(-1 / 42);
  for (let i = 0; i < days; i++) {
    const d = new Date(start); d.setDate(d.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    atl += La * (dailyLoad - atl); ctl += Lc * (dailyLoad - ctl);
    out.push({ date: iso, load: dailyLoad, atl, ctl, tsb: ctl - atl });
  }
  return out;
}

const per = { on: true, buildWeeks: 3, deloadWeeks: 1, deloadDropPct: 25, anchor: '' };

for (const [label, weeks, km, goal] of [['12wk half', 12, 21.1, 0], ['6wk 10K', 6, 10, 0], ['2wk 10K', 2, 10, 0]]) {
  const h = hist(120, 40);
  const last = new Date(h[h.length - 1].date + 'T00:00:00');
  const race = new Date(last); race.setDate(race.getDate() + weeks * 7);
  const raceISO = race.toISOString().slice(0, 10);
  const plan = buildSeasonPlan(h, { date: raceISO, distanceKm: km, goalTimeSec: goal }, { capPct: 10, periodization: per });
  console.log(`\n=== ${label} — race ${raceISO} ===`);
  if (!plan) { console.log('  NULL'); continue; }
  console.log(`  startCTL ${plan.startCtl} · peakCTL ${plan.peakCtl} · race CTL ${plan.race.ctl} TSB ${plan.race.tsb >= 0 ? '+' : ''}${plan.race.tsb}`);
  console.log('  ' + plan.note);
  for (const w of plan.weeks) {
    console.log(`   ${w.monday}  wl${w.weeksToRace}  ${w.phase.padEnd(6)}${w.deload ? '↓' : ' '}  load ${String(w.loadTarget).padStart(4)}  CTL ${String(w.ctl).padStart(3)}  TSB ${w.tsb >= 0 ? '+' : ''}${w.tsb}`);
  }
}
