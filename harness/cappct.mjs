/**
 * Point-in-time +cap% switch list: past weeks keep the % in force then; a change applies only forward.
 * Run: node --import ./harness/register.mjs harness/cappct.mjs            (switch-list lookup)
 *      node --import ./harness/register.mjs harness/cappct.mjs --legacy    (migration from old scalar)
 */
const legacy = process.argv.includes('--legacy');
globalThis.__HARNESS_SEED = {
  secureStore: legacy
    ? { load_cap_pct: '12' }                                     // old single scalar, no dated list yet
    : { load_cap_pct_switches: JSON.stringify([
        { since: '1970-01-01', pct: 10 },
        { since: '2026-08-01', pct: 12 },
        { since: '2026-08-15', pct: 15 },
      ]) },
};
const { capPctForDate, getLoadCapPctList, getLoadCapPct, DEFAULT_LOAD_CAP_PCT } = await import('../src/services/coach.ts');

let fails = 0;
const check = (l, c, g) => { if (!c) fails++; console.log(`${c ? '✅' : '❌'} ${l}${g !== undefined ? ` (got ${g})` : ''}`); };
const list = await getLoadCapPctList();
console.log(legacy ? '\n=== migration from legacy scalar 12 ===' : '\n=== dated switch list ===');
console.log('list:', JSON.stringify(list));

if (legacy) {
  check('legacy scalar migrates to a single EPOCH entry', list.length === 1 && list[0].since === '1970-01-01', JSON.stringify(list));
  check('migrated pct = the old scalar (history unchanged on upgrade)', list[0].pct === 12, list[0].pct);
  check('getLoadCapPct returns it', (await getLoadCapPct()) === 12);
  check('every date uses it (nothing dated yet)', capPctForDate('2026-07-01', list) === 12 && capPctForDate('2026-09-01', list) === 12);
} else {
  check('before first change → 10', capPctForDate('2026-07-15', list) === 10, capPctForDate('2026-07-15', list));
  check('on the 2026-08-01 change (inclusive) → 12', capPctForDate('2026-08-01', list) === 12, capPctForDate('2026-08-01', list));
  check('between the two changes → 12', capPctForDate('2026-08-10', list) === 12, capPctForDate('2026-08-10', list));
  check('day before the 2nd change → 12', capPctForDate('2026-08-14', list) === 12, capPctForDate('2026-08-14', list));
  check('on/after the 2026-08-15 change → 15', capPctForDate('2026-08-15', list) === 15 && capPctForDate('2026-08-20', list) === 15, capPctForDate('2026-08-20', list));
  check('getLoadCapPct = the CURRENT (latest) value = 15', (await getLoadCapPct()) === 15, await getLoadCapPct());
  check('unknown/very-old date falls back to the first entry (10)', capPctForDate('1999-01-01', list) === 10, capPctForDate('1999-01-01', list));
}
check('DEFAULT_LOAD_CAP_PCT still 10', DEFAULT_LOAD_CAP_PCT === 10);
console.log(`\n${fails === 0 ? '✅ ALL PASS' : `❌ ${fails} FAIL(S)`}`);
process.exit(fails === 0 ? 0 : 1);
