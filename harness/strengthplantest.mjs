// Run: node --import ./harness/register.mjs harness/strengthplantest.mjs <strength.json> <coach-plan.json> <week-plan.json> [readiness]
import { readFileSync } from 'node:fs';
const [,, strengthF, planF, weekF, readyArg] = process.argv;
globalThis.__HARNESS_SEED = { files: { 'mem://runcoach-strength.json': readFileSync(strengthF, 'utf8') } };
const S = await import('../src/services/strength.ts');
const P = await import('../src/services/strengthPlan.ts');
const st = await S.loadStrength();
const plan = JSON.parse(readFileSync(planF, 'utf8'));
const week = JSON.parse(readFileSync(weekF, 'utf8'));
const today = S.localDateKey();
const { runLabel, draftPlan, adaptiveTarget, profile } = P.__test;
const tk = plan.intensity === 'rest' ? 'rest' : (plan.sessionKind === 'recovery' ? 'easy' : plan.sessionKind ?? 'easy');
const days = [{ date: today, kind: tk, runMin: plan.runMinutes, label: runLabel(tk, plan.runMinutes) }];
for (const d of week.days.slice(0, 6)) { const k = d.intensity === 'rest' || !d.runMinutes ? 'rest' : d.kind ?? 'easy'; days.push({ date: d.date, kind: k, runMin: d.runMinutes, ...(d.commitment ? { commitment: d.commitment } : {}), label: runLabel(k, d.runMinutes) }); }
const routines = st.routines.filter(r => r.items.length);
const prof = new Map(routines.map(r => [r.id, profile(st, r)]));
for (const [id, p] of prof) console.log('profile', id, 'legShare', p.legShare.toFixed(2), p.primaries.join(','));
const lastDone = new Map(); for (const x of st.sessions) if (x.finishedAt && (!lastDone.get(x.routineId) || lastDone.get(x.routineId) < x.date)) lastDone.set(x.routineId, x.date);
const readiness = readyArg != null ? Number(readyArg) : plan.genReadiness;
const c = { st, today, days, readiness, avgReady: readiness, routines, prof, lastDone, hourNow: 12 };
const t = adaptiveTarget(c, Number(process.env.PREV ?? 200)); if (process.env.T) t.target = Number(process.env.T); c.legCap = t.legCap;
console.log('target', t);
for (const d of draftPlan(c, t.target)) console.log(d.date, (d.kind.padEnd(7)), (d.name ?? '').padEnd(16), '|', d.run, '|', d.why, d.changes?.length ? ' [' + d.changes.join('; ') + ']' : '', d.items ? ' items:' + d.items.map(i => i.exerciseId + ' ' + i.sets + 'x' + (i.weightKg ?? '-')).join(', ') : '');
const dc = P.__test.composeDaily({ ...c, routines: routines.filter(r => r.id !== 'daily_custom') });
console.log('\nDAILY CUSTOM:', dc?.source);
for (const it of dc?.items ?? []) console.log('  ', it.exerciseId, `${it.sets}x${it.repsLo}-${it.repsHi}`, it.weightKg ?? '-');
for (const kit of ['free', 'bw', 'gym']) {
  const st2 = { ...st, here: { place: 'x', name: 'Elsewhere', kit, at: Date.now() } };
  const r2 = P.__test.composeDaily({ ...c, st: st2, routines: routines.filter(r => r.id !== 'daily_custom') });
  console.log(`\nDAILY CUSTOM @${kit}:`, r2?.source);
  for (const it of r2?.items ?? []) console.log('  ', it.exerciseId, `${it.sets}x${it.repsLo}-${it.repsHi}`, it.weightKg ?? '-');
  const push = st.routines.find(r => r.id === 'kd_push');
  const a = S.adaptRoutineToKit(st2, push.items, kit);
  console.log(`  Push adapted @${kit}:`, a.changes.join(' | ') || '(unchanged)');
}
