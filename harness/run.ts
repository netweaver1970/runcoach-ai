// Coach engine repro harness. Runs the REAL src/services/coach.ts against a scenario fixture — no device,
// no LLM — so a "wrong plan" can be reproduced and fixed deterministically.
//   node --import ./harness/register.mjs harness/run.ts [path/to/scenario.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const scenarioPath = process.argv[2] || path.join(dir, 'fixture/scenario.json');
const scn: any = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));

// Seed the mocks BEFORE importing the engine (static mock modules read this global at load).
(globalThis as any).__HARNESS_SEED = {
  secureStore: {
    plan_mode_v1: scn.planMode ?? 'leisure',
    ...(scn.shrinkToFit != null ? { shrink_to_fit_v1: scn.shrinkToFit ? '1' : '0' } : {}),
    ...(scn.periodization ? { periodization_v1: JSON.stringify(scn.periodization) } : {}),
    ...(scn.capPct != null ? { load_cap_pct: String(scn.capPct) } : {}),
    ...(scn.minTSB != null ? { min_tsb: String(scn.minTSB) } : {}),
    ...(scn.secureStore ?? {}),               // raw key/value escape hatch
  },
  files: {
    'mem://coach-knowledge/running-schedule.md': scn.schedule ?? '',
    ...(scn.files ?? {}),                      // raw uri→content escape hatch
  },
};

// Dynamic import so the seed above is in place when the engine + mocks load.
const coach: any = await import('../src/services/coach.ts');

const toDate = new Date(scn.date + 'T00:00:00');
const capPct = scn.capPct ?? 10;
const dur = (scn.recentTimeOnFeet ?? []).map((d: any) => ({ date: d.date, value: d.min }));

// Cap context from the duration series (tof basis) — deterministic, no HealthKit.
const capCtx = await coach.buildCapContext(dur, toDate, capPct, 'tof');

const snap: any = {
  date: scn.date,
  readiness: scn.readiness,
  strainReal: scn.strainReal,
  advisableLow: scn.advisableLow,
  advisableHigh: scn.advisableHigh,
  acwr: scn.acwr,
  recentTimeOnFeet: capCtx.tof.series14,
  recentTof28: capCtx.tof.series28,
  heatByDate: capCtx.heatCredit,
  tof7d: capCtx.tof.tof7d,
  tofPrev7d: capCtx.tof.tofPrev7d,
  tofBudgetTodayMin: capCtx.budgetMin,
  tofNextRunLabel: capCtx.cap.nextRunLabel,
  tofNextRunInDays: capCtx.cap.nextRunInDays,
  loadCapPct: capPct,
  loadUnit: 'min',
  weather: scn.weather,
  athleteStatus: scn.athleteStatus,
  athleteStatusUntil: scn.athleteStatusUntil,
  ...(scn.snapOverrides ?? {}),
};

const line = (s: string) => console.log(s);
line(`\n=== SCENARIO  ${scn.date}  (cap +${capPct}%, shrink ${scn.shrinkToFit ? 'ON' : 'off'}, readiness ${scn.readiness}) ===`);
line(`7-day ToF ${capCtx.tof.tof7d}m · cap ${capCtx.tof.cap7dMin}m · budget today ${capCtx.budgetMin}m · next meaningful run ${capCtx.cap.nextRunLabel} (in ${capCtx.cap.nextRunInDays}d)`);

line('\n=== DAILY PLAN — deterministicCoachPlan ===');
const plan = await coach.deterministicCoachPlan(snap);
line(JSON.stringify({
  headline: plan.headline,
  intensity: plan.intensity,
  runMinutes: plan.runMinutes,
  session: plan.session,
  nextRunLabel: plan.nextRunLabel,
  nextRunInDays: plan.nextRunInDays,
  shrinkForced: plan.shrinkForced ?? false,
  sessionKind: plan.sessionKind,
  prescribedLoad: plan.prescribedLoad,
  variantSeed: coach.variantSeedFor(scn.date),
  workout: plan.workout ? coach.formatWorkoutStructure(plan.workout) : null,
  blocks: plan.workout?.blocks?.map((b: any) => `${b.repeats}×${b.workMinutes}m work@${b.hrZone ?? ''} / ${b.restMinutes}m reco@${b.recoveryZone ?? 'Z1'}`),
}, null, 2));

line('\n=== 7-DAY PLAN — getWeekPlan ===');
const week = await coach.getWeekPlan(snap);
for (const d of week) {
  line(`${d.weekday} ${d.date.slice(5)}  ${String(d.intensity).padEnd(8)} ${String(d.runMinutes).padStart(3)}min  ${(d.kind ?? '').padEnd(9)} ${d.structure}`);
}
line('');
