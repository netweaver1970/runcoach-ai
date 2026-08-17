/**
 * Import a lab report from a PDF (text-layer only).
 *
 * The xlsx importer expects ONE known layout (transposed grid, year row, keep flags). A lab report is the
 * opposite: every lab, country and language lays it out differently, so there is no grammar to parse. The
 * text goes to the LLM and comes back as rows — that's the part an LLM is genuinely good at.
 *
 * The hard part is NOT extraction, it's MAPPING. "Hb", "Hgb", "Hemoglobine", "Hémoglobine" must all land on
 * the analyte key the 27-year history already uses, or the import silently forks that history into a second
 * series. So every extracted row is matched against the existing store first, and anything unmatched is
 * surfaced as NEW for confirmation rather than written blind.
 *
 * Scanned/photographed reports have no text layer — extractPdfText reports hasTextLayer=false and this
 * refuses rather than guessing. Vision/OCR is a separate path.
 */
import { extractPdfText } from '../../modules/runcoach-pdf';
import { callLLM, extractJsonObject, setUsageFeature } from './llm';
import { loadLabs } from './labsStore';
import type { LabAnalyte } from './labs';

// Blood pressure is a first-class biological (HealthKit + the Biology screen own it) — same exclusion the
// xlsx path applies, repeated here so a PDF can't sneak a duplicate, coarser copy in.
const BP_RE = /\b(systol|diastol|bloed ?druk|tension ?art|blutdruck|pressione)|blood\s*pressure|\bbps?\b/i;

export interface PdfLabRow {
  label: string;          // as printed on the report
  value: number;
  unit: string;
  date: string;           // ISO yyyy-mm-dd
  refLow?: number | null;
  refHigh?: number | null;
  matchedKey?: string;    // existing analyte key when we could map it
  matchedLabel?: string;  // that analyte's label, for the review screen
  isNew?: boolean;        // no confident match → user confirms before it creates a new series
}
export interface PdfImportResult {
  rows: PdfLabRow[];
  dates: string[];
  pageCount: number;
  warnings: string[];
}

const SYSTEM =
  'You extract laboratory results from the raw text of a lab report. Return STRICT JSON only, no prose:\n' +
  '{"rows":[{"label":"...","value":0,"unit":"...","date":"YYYY-MM-DD","refLow":null,"refHigh":null}],"warnings":["..."]}\n' +
  'Rules: one row per measured analyte per date. The report may be in ANY language — keep the analyte label ' +
  'exactly as printed, do NOT translate it. A report may contain SEVERAL dates (a history table): emit a row ' +
  'per analyte per date, and never guess a date you cannot see — if a value has no determinable date, omit it ' +
  'and add a warning. Parse decimal commas as decimal points. Reference ranges: fill refLow/refHigh only when ' +
  'the report prints them, else null; for one-sided ranges ("<5.0") set the other side null. Ignore blood ' +
  'pressure, and ignore anything that is not a measured value (comments, addresses, method notes, page ' +
  'numbers). If a value is qualitative (e.g. "negative"), omit it and note it in warnings.';

/** Normalised form for matching an incoming label against an existing analyte. */
const norm = (s: string) => s.toLowerCase()
  .replace(/[éèê]/g, 'e').replace(/[áàâ]/g, 'a').replace(/[íì]/g, 'i')
  .replace(/[óòô]/g, 'o').replace(/[úù]/g, 'u')
  .replace(/[^a-z0-9]+/g, '');

/** A few clinically-standard aliases that pure string matching cannot bridge. */
const ALIAS: Record<string, string[]> = {
  hemoglobine: ['hb', 'hgb', 'haemoglobin', 'hemoglobin'],
  hematocriet: ['ht', 'hct', 'hematocrit', 'haematocrit'],
  leukocyten: ['wbc', 'leukocytes', 'whiteblood'],
  trombocyten: ['plt', 'platelets', 'thrombocytes'],
  erytrocyten: ['rbc', 'redblood', 'erythrocytes'],
  creatinine: ['crea', 'kreatinin'],
  cholesterol: ['chol', 'totalcholesterol'],
  triglyceriden: ['tg', 'triglycerides', 'trig'],
};

function matchAnalyte(label: string, unit: string, existing: LabAnalyte[]): LabAnalyte | undefined {
  const n = norm(label);
  if (!n) return undefined;
  // 1. exact normalised label, preferring the same unit (a %-vs-absolute pair must not collapse)
  const exact = existing.filter(a => norm(a.label) === n);
  if (exact.length) return exact.find(a => norm(a.unit) === norm(unit)) ?? exact[0];
  // 2. alias table both ways
  for (const [canon, aliases] of Object.entries(ALIAS)) {
    const hit = [canon, ...aliases];
    if (hit.some(h => h === n)) {
      const m = existing.find(a => hit.some(h => norm(a.label) === h) || norm(a.label) === canon);
      if (m) return m;
    }
  }
  // 3. containment, but only when it's unambiguous — one candidate. A partial match that hits several
  //    analytes is exactly how a history gets merged into the wrong series, so bail instead of picking.
  const part = existing.filter(a => { const an = norm(a.label); return an.length > 3 && (an.includes(n) || n.includes(an)); });
  return part.length === 1 ? part[0] : undefined;
}

/** Parse a lab-report PDF into reviewable rows, mapped onto the existing analytes where possible. */
export async function importLabPdf(uri: string): Promise<PdfImportResult> {
  const { text, pageCount, hasTextLayer } = await extractPdfText(uri);
  if (!hasTextLayer) {
    throw new Error('This PDF has no text layer — it looks scanned or photographed. Text-layer PDFs only for now.');
  }
  setUsageFeature('labs-pdf-import');
  // Very long reports: keep the head, where the result tables almost always are, within a sane token budget.
  const body = text.length > 24000 ? text.slice(0, 24000) : text;
  const raw = await callLLM({ system: SYSTEM, messages: [{ role: 'user', content: body }], maxTokens: 4000, temperature: 0 });
  const json = extractJsonObject(raw);                    // balanced-brace extractor → string | null
  let parsed: { rows?: any[]; warnings?: string[] } | null = null;
  try { parsed = json ? JSON.parse(json) : null; } catch { parsed = null; }
  if (!parsed?.rows?.length) throw new Error('No lab values could be read from this PDF.');

  const store = await loadLabs().catch(() => ({ analytes: [] as LabAnalyte[] } as any));
  const existing: LabAnalyte[] = store?.analytes ?? [];
  const warnings = [...(parsed.warnings ?? [])];
  const rows: PdfLabRow[] = [];
  for (const r of parsed.rows) {
    const label = String(r?.label ?? '').trim();
    const value = Number(r?.value);
    const date = String(r?.date ?? '').slice(0, 10);
    if (!label || !Number.isFinite(value) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (BP_RE.test(label)) continue;                      // biology owns blood pressure
    const unit = String(r?.unit ?? '').trim();
    const m = matchAnalyte(label, unit, existing);
    rows.push({
      label, value, unit, date,
      refLow: r?.refLow ?? null, refHigh: r?.refHigh ?? null,
      matchedKey: m?.key, matchedLabel: m?.label, isNew: !m,
    });
  }
  if (!rows.length) throw new Error('The PDF was read but no usable lab values were found.');
  const newCount = rows.filter(r => r.isNew).length;
  if (newCount) warnings.push(`${newCount} value${newCount === 1 ? '' : 's'} did not match an existing marker — confirm before importing so a duplicate series isn't created.`);
  const dates = [...new Set(rows.map(r => r.date))].sort();
  return { rows, dates, pageCount, warnings };
}
