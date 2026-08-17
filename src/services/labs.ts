// ── Clinical-labs import (Biology → Labs) ─────────────────────────────────────
// Parses Geert's "clinical tests" spreadsheet (a TRANSPOSED layout: rows = analytes, columns = dates)
// into clean per-analyte time-series in ONE canonical unit each. Pure + deterministic → unit-tested in
// harness/labstest.mjs against the real file before any UI touches it. SheetJS feeds it `rows` in-app;
// the harness feeds the same shape from a JSON dump, so this exact code is what runs on device.
//
// Layout (0-based col indices), discovered by inspection:
//   A0 category (carries forward) · B1 "Keep" flag (x = canonical unit) · C2 unit · D3 ref-min · E4 ref-max
//   F5 analyte name · (G6 LT · H7 ST) · I8… one column per test date; the date header is ROW INDEX 3.

export type Cell = string | number | boolean | { __date: string } | Date | null | undefined;

export type LabKind = 'numeric' | 'categorical' | 'derived';

export interface LabValue { date: string; value: number }        // date = ISO yyyy-mm-dd; value in canonical unit
export interface LabTextValue { date: string; text: string }

export interface LabAnalyte {
  key: string;                 // stable slug (category + name + unit-qualifier)
  label: string;               // display name (unit qualifier appended when a same-name pair was kept apart)
  category: string;
  unit: string;                // canonical unit ('' if unitless)
  kind: LabKind;
  refLow: number | null;
  refHigh: number | null;
  hkType?: string;             // HealthKit quantity identifier when this analyte is mirrorable
  series: LabValue[];          // numeric readings, canonical unit, sorted ascending by date
  textSeries?: LabTextValue[]; // qualitative results (kind === 'categorical')
  mergedUnits?: string[];      // the source units that were converted into `unit`
  note?: string;               // parser note (merge / kept-apart / conversion), surfaced in the review UI
}

export interface ParsedLabs {
  dates: string[];             // every distinct test date found (ISO), ascending
  analytes: LabAnalyte[];
  warnings: string[];
}

const CAT = 0, KEEP = 1, UNIT = 2, MIN = 3, MAX = 4, NAME = 5, DATA_C0 = 8, YEAR_ROW = 1, DATE_ROW = 3;

// ── cell helpers ──────────────────────────────────────────────────────────────
function isoOf(c: Cell): string | null {
  if (c == null) return null;
  if (typeof c === 'object' && '__date' in (c as any)) return (c as any).__date;
  if (c instanceof Date && !isNaN(c.getTime())) {
    const y = c.getFullYear(), m = String(c.getMonth() + 1).padStart(2, '0'), d = String(c.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof c === 'number') {                       // Excel serial date (days since 1899-12-30)
    if (c > 20000 && c < 90000) { const ms = (c - 25569) * 86400_000; const dt = new Date(ms);
      return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`; }
    return null;
  }
  if (typeof c === 'string') { const m = c.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; }
  return null;
}
function numOf(c: Cell): number | null {
  if (c == null || typeof c === 'boolean') return null;
  if (typeof c === 'number') return Number.isFinite(c) ? c : null;
  if (typeof c === 'string') {
    const m = c.replace(',', '.').match(/-?\d+(\.\d+)?/);   // first number; tolerates "<102", "0.8 (11)", "4,69"
    return m ? parseFloat(m[0]) : null;
  }
  return null;
}
function textOf(c: Cell): string { return c == null ? '' : String(c).replace(/\s+/g, ' ').trim(); }
// Month+day from a header cell — a full date (ISO/Date/serial) OR a European "d/m", "d-m", "d.m" string.
function monthDayOf(c: Cell): { m: number; d: number } | null {
  const iso = isoOf(c);
  if (iso) { const m = +iso.slice(5, 7), d = +iso.slice(8, 10); if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return { m, d }; }
  if (typeof c === 'string') { const mm = c.trim().match(/^(\d{1,2})[\/\-.](\d{1,2})$/); if (mm) { const d = +mm[1], m = +mm[2]; if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return { m, d }; } }
  return null;
}
function yearCellOf(c: Cell): number | null {
  if (typeof c === 'number' && c > 1900 && c < 2100) return Math.round(c);
  if (typeof c === 'string') { const m = c.trim().match(/^(\d{4})$/); if (m) { const y = +m[1]; if (y > 1900 && y < 2100) return y; } }
  return null;
}
const sig4 = (x: number): number => (Number.isFinite(x) ? Number(x.toPrecision(4)) : x);   // 4 significant digits
const sig4n = (x: number | null): number | null => (x == null ? null : sig4(x));
function cleanUnit(u: Cell): string {
  let s = textOf(u); if (!s) return '';
  s = s.split('\n')[0];                                    // drop trailing note lines ("ng/mL\n(sec…")
  s = s.replace(/\((?:sec|[^)]*\d[^)]*)\)/g, '').trim();   // drop parenthetical qualifiers
  return s.replace(/^[(\s]+|[)\s]+$/g, '').trim();
}
function normUnit(u: string): string { return u.toLowerCase().replace(/[µμ]/g, 'u').replace(/\s+/g, '').replace(/\.$/, ''); }
function baseName(name: string): string {
  const n = name.toLowerCase().replace(/\s+/g, ' ').trim();
  const aliases: Record<string, string> = { 'triglyceriden': 'triglycerides' };  // Dutch↔English same analyte
  return aliases[n] ?? n;
}

// ── classification ────────────────────────────────────────────────────────────
const CATEGORICAL_CATS = new Set(['serology', 'urine', 'immunohematology']);
const CATEGORICAL_RE = /blood type|rhesus|kell|hepatit|\bhiv\b|herpes|vdrl|treponema|chlamidia|gonorrho|\bpcr\b/i;
const DERIVED_RE = /\bratio\b|\bindex\b|egfr|homa|quicki|fti|non-hdl|fibrosis|saturation|\/|\(calc\)|%b\b|%s\b/i;
function kindOf(category: string, name: string): LabKind {
  if (CATEGORICAL_CATS.has(category.toLowerCase()) || CATEGORICAL_RE.test(name)) return 'categorical';
  if (DERIVED_RE.test(name)) return 'derived';
  return 'numeric';
}

// True unit-VARIANTS (same physical quantity, convertible) → collapse to one canonical line. valueA = valueB * aPerB.
// Everything NOT listed here that shares a name (e.g. Neutrophils %-vs-absolute, globulins %-vs-g/L) is a DIFFERENT
// measurement and is kept as separate analytes (unit appended to the label).
interface Convertible { unitA: string; unitB: string; aPerB: number; hint?: string }
const CONVERTIBLE: Record<string, Convertible> = {
  'cholesterol total':  { unitA: 'mg/dl', unitB: 'mmol/l', aPerB: 38.67 },
  'hdl-c':              { unitA: 'mg/dl', unitB: 'mmol/l', aPerB: 38.67 },
  'eldl-c':             { unitA: 'mg/dl', unitB: 'mmol/l', aPerB: 38.67 },
  'glucose (fasting)':  { unitA: 'mg/dl', unitB: 'mmol/l', aPerB: 18.02 },
  'triglycerides':      { unitA: 'mg/dl', unitB: 'mmol/l', aPerB: 88.57 },
  'calcium':            { unitA: 'mg/dl', unitB: 'mmol/l', aPerB: 4.008 },
  'transferrin':        { unitA: 'mg/dl', unitB: 'g/l',    aPerB: 100 },
  'total testosterone': { unitA: 'ng/dl', unitB: 'nmol/l', aPerB: 28.84 },
  'vit. e':             { unitA: 'ug/dl', unitB: 'umol/l', aPerB: 43.06 },
};
// Analytes Apple Health can store — mirrored on import (extends the existing Biology charts backward).
const HK_TYPE: Record<string, string> = {
  'weight': 'HKQuantityTypeIdentifierBodyMass',
  // (blood pressure intentionally absent — excluded at parse time, see BP_RE)
  'glucose (fasting)': 'HKQuantityTypeIdentifierBloodGlucose',
};

// Systolic/diastolic/blood-pressure in the common spellings + languages this sheet may use.
const BP_RE = /\b(systol|diastol|bloed ?druk|tension ?art|blutdruck|pressione)|blood\s*pressure|\bbps?\b|\bRR\b/i;

function slug(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }

interface RawRow { category: string; keep: boolean; unit: string; min: number | null; max: number | null;
  name: string; values: { date: string; raw: Cell }[] }

export function parseClinicalGrid(rows: Cell[][]): ParsedLabs {
  const warnings: string[] = [];
  // 1) date columns. The full-date row (DATE_ROW) is unreliable in this sheet — some cells carry the wrong
  //    YEAR (2017/18/19 stored as 2022) and some carry only a day/month with no year at all. The dedicated
  //    YEAR row (row index 1, "Jaar") is the athlete's authoritative year, so: year ← year-row (carried
  //    forward), month/day ← date cell. Fall back to the date cell's own year only when no year-row exists
  //    (keeps other layouts working).
  const yearRow = rows[YEAR_ROW] ?? [];
  const hdr = rows[DATE_ROW] ?? [];
  const dateCols: { col: number; iso: string }[] = [];
  let carryYear: number | null = null; let fixedYears = 0;
  for (let ci = DATA_C0; ci < hdr.length; ci++) {
    const yv = yearCellOf(yearRow[ci]); if (yv) carryYear = yv;
    const md = monthDayOf(hdr[ci]); if (!md) continue;
    const isoYear = (() => { const iso = isoOf(hdr[ci]); return iso ? +iso.slice(0, 4) : null; })();
    const year = carryYear ?? isoYear;
    if (!year) continue;
    if (isoYear && carryYear && isoYear !== carryYear) fixedYears++;   // year-row corrected a bad date-cell year
    dateCols.push({ col: ci, iso: `${year}-${String(md.m).padStart(2, '0')}-${String(md.d).padStart(2, '0')}` });
  }
  const dates = [...new Set(dateCols.map(d => d.iso))].sort();
  if (!dateCols.length) warnings.push('No date columns found on the header row — is this the clinical-tests layout?');
  if (fixedYears) warnings.push(`${fixedYears} test date(s) had a wrong year in the date row — corrected from the year row.`);

  // 2) raw analyte rows (category carries forward; skip nameless / all-empty rows)
  const raws: RawRow[] = [];
  let curCat = '';
  for (let ri = DATE_ROW + 1; ri < rows.length; ri++) {
    const row = rows[ri]; if (!row) continue;
    const c = textOf(row[CAT]); if (c) curCat = c;
    const name = textOf(row[NAME]); if (!name) continue;
    const values = dateCols.map(d => ({ date: d.iso, raw: row[d.col] })).filter(v => v.raw != null && v.raw !== '');
    if (!values.length) continue;                          // never-measured row → skip
    const keep = /^x$/i.test(textOf(row[KEEP]));
    raws.push({ category: curCat, keep, unit: cleanUnit(row[UNIT]), min: numOf(row[MIN]), max: numOf(row[MAX]), name, values });
  }

  // 3) group by base-name, then emit analytes
  const groups = new Map<string, RawRow[]>();
  for (const r of raws) { const b = baseName(r.name); if (!groups.has(b)) groups.set(b, []); groups.get(b)!.push(r); }

  const analytes: LabAnalyte[] = [];
  for (const [base, group] of groups) {
    // Blood pressure is a FIRST-CLASS biological: HealthKit owns it and the Biology screen charts it at
    // full resolution. Importing it as a lab analyte would create a second, coarser copy of the same
    // measurement that then disagrees with the Biology series — so it's dropped at parse time, not merely
    // skipped for the HK mirror.
    if (BP_RE.test(base) || group.some(r => BP_RE.test(r.name))) continue;
    const kind = kindOf(group[0].category, group[0].name);
    const conv = CONVERTIBLE[base];
    const unitsInGroup = [...new Set(group.map(r => normUnit(r.unit)))];

    if (group.length > 1 && conv && kind === 'numeric') {
      // collapse convertible unit-variants → one canonical unit
      const keepRow = group.find(r => r.keep);
      const canonical = keepRow ? normUnit(keepRow.unit)
        : normUnit([...group].flatMap(r => r.values.map(v => ({ iso: v.date, u: r.unit })))
            .sort((a, b) => a.iso.localeCompare(b.iso)).pop()?.u ?? group[0].unit);   // else most-recent-used unit
      const factorTo = (from: string): number => {
        const f = normUnit(from);
        if (f === canonical) return 1;
        if (f === conv.unitB && canonical === conv.unitA) return conv.aPerB;
        if (f === conv.unitA && canonical === conv.unitB) return 1 / conv.aPerB;
        return 1;                                            // unknown unit in a convertible group → assume canonical
      };
      const byDate = new Map<string, number>();
      for (const r of group) {
        const isCanon = normUnit(r.unit) === canonical;
        for (const v of r.values) {
          const n = numOf(v.raw); if (n == null) continue;
          const conv2 = sig4(n * factorTo(r.unit));
          if (isCanon || !byDate.has(v.date)) byDate.set(v.date, conv2);   // canonical row wins ties
        }
      }
      // Ref range in the canonical unit = the OUTER union of every row's (converted) bounds. The two unit
      // rows were hand-entered and rounded independently (mg/dL 70–99 vs mmol/L 3.85–5.44), so converting a
      // value with the exact factor could push it just past the other row's tighter bound; the union prevents
      // a reading that's in-range in its own unit from flagging out-of-range after conversion.
      let refLow: number | null = null, refHigh: number | null = null;
      for (const r of group) {
        const f = factorTo(r.unit);
        if (r.min != null) refLow  = refLow  == null ? r.min * f : Math.min(refLow,  r.min * f);
        if (r.max != null) refHigh = refHigh == null ? r.max * f : Math.max(refHigh, r.max * f);
      }
      analytes.push(finish({
        base, category: group[0].category, label: group[0].name, unit: displayUnit(canonical, group), kind,
        refLow: sig4n(refLow), refHigh: sig4n(refHigh), series: toSeries(byDate),
        mergedUnits: unitsInGroup, note: `merged ${unitsInGroup.join(' + ')} → ${displayUnit(canonical, group)}`,
      }));
    } else if (group.length > 1) {
      // same name, NOT convertible (e.g. % vs absolute count) → keep each as its own analyte
      for (const r of group) analytes.push(emitSingle(r, kind, `${r.name} (${r.unit})`, warnings));
      warnings.push(`"${group[0].name}" has ${group.length} different measurements (${unitsInGroup.join(', ')}) — kept separate.`);
    } else {
      analytes.push(emitSingle(group[0], kind, group[0].name, warnings));
    }
  }
  analytes.sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label));
  return { dates, analytes, warnings };
}

function displayUnit(normalized: string, group: RawRow[]): string {
  const orig = group.map(r => r.unit).find(u => normUnit(u) === normalized);
  return orig ?? normalized;
}
function toSeries(byDate: Map<string, number>): LabValue[] {
  return [...byDate.entries()].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));
}
function emitSingle(r: RawRow, kind: LabKind, label: string, warnings: string[]): LabAnalyte {
  if (kind === 'categorical') {
    const textSeries = r.values.map(v => ({ date: v.date, text: textOf(v.raw) })).filter(t => t.text)
      .sort((a, b) => a.date.localeCompare(b.date));
    return finish({ base: baseName(r.name), category: r.category, label, unit: r.unit, kind,
      refLow: r.min, refHigh: r.max, series: [], textSeries });
  }
  const byDate = new Map<string, number>();
  for (const v of r.values) { const n = numOf(v.raw); if (n != null) byDate.set(v.date, n); }
  return finish({ base: baseName(r.name), category: r.category, label, unit: r.unit, kind,
    refLow: r.min, refHigh: r.max, series: toSeries(byDate) });
}
function finish(a: Omit<LabAnalyte, 'key' | 'hkType'> & { base: string }): LabAnalyte {
  const { base, ...rest } = a;
  const key = slug(`${rest.category}-${rest.label}-${rest.unit}`);
  const hkType = HK_TYPE[base] ?? HK_TYPE[rest.label.toLowerCase()];
  return { key, hkType, ...rest };
}
