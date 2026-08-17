// Validate parseClinicalGrid against Geert's real clinical-tests sheet.
// Run: node --import ./harness/register.mjs harness/labstest.mjs
import { parseClinicalGrid } from '../src/services/labs.ts';
import { readFileSync } from 'node:fs';

const rows = JSON.parse(readFileSync(new URL('./fixture/clinical.json', import.meta.url), 'utf8'));
const rep = parseClinicalGrid(rows);
let fails = 0;
const ok = (c, label, extra = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); if (!c) fails++; };
const find = (labelRe) => rep.analytes.filter(a => labelRe.test(a.label));

console.log(`\ndates: ${rep.dates.length}  (${rep.dates[0]} → ${rep.dates.at(-1)})`);
console.log(`analytes: ${rep.analytes.length}  (numeric ${rep.analytes.filter(a=>a.kind==='numeric').length} · derived ${rep.analytes.filter(a=>a.kind==='derived').length} · categorical ${rep.analytes.filter(a=>a.kind==='categorical').length})`);

ok(rep.dates.length === 43, '43 test dates (year-row corrected + day/month-only recovered)', `got ${rep.dates.length}`);
ok(find(/^Cholesterol Total$/)[0]?.series.some(p => p.date === '2017-02-17'), 'cholesterol 2017-02-17 recovered (was mis-dated 2022)');
ok(rep.dates[0] === '1999-10-01' && rep.dates.at(-1) === '2026-04-22', 'span 1999→2026');

// Cholesterol Total: two same-date unit rows → ONE merged series (union of dates, no duplicates)
const chol = find(/^Cholesterol Total$/);
ok(chol.length === 1, 'Cholesterol Total collapses to ONE analyte', `got ${chol.length}`);
if (chol[0]) {
  const c = chol[0];
  const uniqueDates = new Set(c.series.map(s => s.date));
  ok(c.series.length === uniqueDates.size, 'Cholesterol series has no duplicate dates', `n=${c.series.length}`);
  ok(c.series.length >= 29, 'Cholesterol merged covers ≥29 dates', `n=${c.series.length} unit=${c.unit}`);
  console.log('   Cholesterol sample:', c.unit, c.series.slice(0,2), '…', c.series.slice(-1));
}

// Glucose fasting: keep-flag says mmol/L → canonical mmol/L
const glu = find(/^Glucose \(fasting\)$/);
ok(glu.length === 1 && /mmol/i.test(glu[0]?.unit ?? ''), 'Glucose fasting → canonical mmol/L (honors Keep x)', `unit=${glu[0]?.unit}`);
ok(glu[0]?.hkType?.includes('BloodGlucose'), 'Glucose maps to HK BloodGlucose');

// Neutrophils: %-vs-absolute are DIFFERENT measurements → kept as 2 separate analytes
const neut = find(/Neutrofile segments/);
ok(neut.length === 2, 'Neutrophils kept as 2 separate (%, abs)', `got ${neut.length}: ${neut.map(a=>a.unit).join(',')}`);

// Weight / BP mirror to HK
ok(find(/^Weight$/)[0]?.hkType?.includes('BodyMass'), 'Weight maps to HK BodyMass');
// Blood pressure must NOT be imported at all: HealthKit owns it and the Biology screen charts it at full
// resolution, so a lab copy would be a second, coarser series that disagrees with the first.
ok(find(/Systolic BP/).length === 0 && find(/Diastolic BP/).length === 0, 'blood pressure excluded from the labs import');

// Categorical: blood type stored as text, not a numeric line
const bt = find(/Blood type/);
ok(bt[0]?.kind === 'categorical' && bt[0]?.series.length === 0, 'Blood type is categorical (text, no numeric series)');

// Derived flagged
ok(find(/eGFR/).every(a => a.kind === 'derived'), 'eGFR rows flagged derived');
ok(find(/HOMA2-IR/)[0]?.kind === 'derived', 'HOMA2-IR flagged derived');

// No never-measured analytes leaked in (every analyte has ≥1 reading)
ok(rep.analytes.every(a => a.series.length + (a.textSeries?.length ?? 0) > 0), 'every emitted analyte has ≥1 reading');

console.log(`\nwarnings (${rep.warnings.length}):`); rep.warnings.slice(0,8).forEach(w => console.log('   • ' + w));
console.log(`\nHK-mirrorable analytes:`, rep.analytes.filter(a=>a.hkType).map(a=>`${a.label}[${a.series.length}]`).join(', '));
console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILED'}`);
process.exit(fails === 0 ? 0 : 1);

// #3 glucose conversion: a reading at the mg/dL limit must NOT flag out-of-range after mmol/L conversion
const g = find(/^Glucose \(fasting\)$/)[0];
if (g) {
  const maxV = Math.max(...g.series.map(v => v.value));
  console.log(`\nGlucose: unit=${g.unit} ref=${g.refLow}–${g.refHigh} series max=${maxV}`);
  ok(g.refHigh != null && maxV <= g.refHigh + 1e-9 || maxV <= g.refHigh, 'a fasting-glucose reading at limit stays in-range (union ref)', `max=${maxV} refHigh=${g.refHigh}`);
  ok(String(g.refHigh).replace('.', '').replace(/^0+/, '').length <= 5, 'glucose refHigh ≤ 4 significant digits', `refHigh=${g.refHigh}`);
}
