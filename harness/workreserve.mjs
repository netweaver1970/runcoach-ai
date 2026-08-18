/**
 * Verifies the accounting-regime warm/cool reserve in synthesizeWorkout:
 *   • 'work' → the whole runMinutes is delivered as WORK (no reserve) so the 7-day plan's printed work
 *              reconciles with the footer budget, and warm-up/cool-down are open, uncounted additions.
 *   • 'full' → ~6 min is reserved for the (now-counted) warm-up/cool-down; work = runMinutes − 6.
 *
 * Run: node --import ./harness/register.mjs harness/workreserve.mjs         (work)
 *      node --import ./harness/register.mjs harness/workreserve.mjs --full   (full)
 */
const full = process.argv.includes('--full');
globalThis.__HARNESS_SEED = {
  secureStore: {
    accounting_switches: JSON.stringify(
      full ? [{ since: '1970-01-01', mode: 'work' }, { since: '2020-01-01', mode: 'full' }]
           : [{ since: '1970-01-01', mode: 'work' }],
    ),
  },
};

const { synthesizeWorkout, refreshAccountingMode, accountingModeSync, refreshWorkoutStructure } =
  await import('../src/services/coach.ts');
await refreshWorkoutStructure();
await refreshAccountingMode();

const workOf = (wk) => wk.blocks.reduce((a, b) => a + b.workMinutes * (b.repeats || 1), 0);
let fails = 0;
const check = (l, c, g) => { if (!c) fails++; console.log(`${c ? '✅' : '❌'} ${l}${g !== undefined ? ` (got ${g})` : ''}`); };

console.log(`\nmode = ${accountingModeSync()}`);
// The 7-day plan's footer counts runMinutes; each row prints drills + work. They reconcile when
// drills + work == runMinutes  (work regime; warm/cool open + uncounted)  or  == runMinutes − 6  (full).
for (const [kind, run] of [['easy', 30], ['tempo', 40], ['long', 65]]) {
  const wk = synthesizeWorkout(kind === 'easy' ? 'easy' : 'moderate', run, 'test', undefined, kind);
  const work = workOf(wk);
  const printed = (wk.drillsMinutes || 0) + work;   // what a row visibly sums to
  const expected = full ? run - 6 : run;            // what the footer attributes to this day (− hidden warm/cool in full)
  console.log(`  ${kind.padEnd(5)} runMinutes=${run} → drills ${wk.drillsMinutes} + work ${work} = ${printed}`);
  check(`${kind}: printed (drills+work) ${full ? '= runMinutes−6 (warm/cool hidden)' : '= runMinutes (reconciles footer)'}`, printed === expected, printed);
}
console.log(`\n${fails === 0 ? '✅ ALL PASS' : `❌ ${fails} FAIL(S)`}`);
process.exit(fails === 0 ? 0 : 1);
