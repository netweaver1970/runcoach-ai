/**
 * Bevel dataset — values extracted from Bevel screenshots, stored parallel to ours
 * and keyed by calendar date, so we can correlate Bevel's KPIs against our own.
 *
 * Pipeline:  screenshot → vision LLM (buildBevelExtractionPrompt) → JSON →
 *            parseBevelExtraction → canonical numbers → saveBevelKpi.
 *
 * All numbers are stored in canonical units (see UnitKind in bevelScales):
 * durations & clock times in minutes, energy in kcal, etc. Raw on-screen strings
 * are parsed here (Bevel uses European formatting: '.' thousands, ',' decimal).
 */

import * as FileSystem from 'expo-file-system';
import { BEVEL_KPIS, kpiScale, ComponentScale, UnitKind, KpiScale } from './bevelScales';

export type BevelKpiKey = KpiScale['key'];

export interface BevelKpiRecord {
  score?:     number;                  // headline value (0–100 %)
  components: Record<string, number>;  // canonical value per component key
  partial?:   boolean;                 // intra-day capture (Strain "today") — exclude from correlation
  estimated?: boolean;                 // values read off a chart, not printed exactly
}

/** Exact 30-day average + normal band per component (printed on every detail screen). */
export interface BevelComponentAvg {
  avg:    number;
  bandLo?: number;
  bandHi?: number;
  asOf:   string;   // ISO of capture
  windowDays?: number;
}

export interface BevelDay {
  date:       string;                  // 'YYYY-MM-DD'
  capturedAt: string;                  // ISO timestamp of the import
  strain?:    BevelKpiRecord;
  recovery?:  BevelKpiRecord;
  sleep?:     BevelKpiRecord;
}

const FILE     = `${FileSystem.documentDirectory}runcoach-bevel-data.json`;
const AVG_FILE = `${FileSystem.documentDirectory}runcoach-bevel-averages.json`;

// ─── Storage ────────────────────────────────────────────────────────────────────

export async function loadBevelData(): Promise<Record<string, BevelDay>> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (!info.exists) return {};
    return JSON.parse(await FileSystem.readAsStringAsync(FILE)) as Record<string, BevelDay>;
  } catch {
    return {};
  }
}

async function write(all: Record<string, BevelDay>): Promise<void> {
  try { await FileSystem.writeAsStringAsync(FILE, JSON.stringify(all)); } catch {}
}

/** Merge one KPI's values into the given date (preserves other KPIs already stored). */
export async function saveBevelKpi(
  date: string,
  kpi: BevelKpiKey,
  record: BevelKpiRecord,
): Promise<void> {
  const all = await loadBevelData();
  const day: BevelDay = all[date] ?? { date, capturedAt: new Date().toISOString() };
  // Strain captured for *today* is a partial intra-day reading.
  const todayStr = new Date().toISOString().slice(0, 10);
  if (kpi === 'strain' && date === todayStr) record.partial = true;
  day[kpi] = record;
  day.capturedAt = new Date().toISOString();
  all[date] = day;
  await write(all);
}

export async function deleteBevelDay(date: string): Promise<void> {
  const all = await loadBevelData();
  delete all[date];
  await write(all);
}

export async function allBevelDays(): Promise<BevelDay[]> {
  const all = await loadBevelData();
  return Object.values(all).sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Component averages (exact 30-day numbers printed on detail screens) ──────────

export async function loadBevelAverages(): Promise<Record<string, BevelComponentAvg>> {
  try {
    const info = await FileSystem.getInfoAsync(AVG_FILE);
    if (!info.exists) return {};
    return JSON.parse(await FileSystem.readAsStringAsync(AVG_FILE)) as Record<string, BevelComponentAvg>;
  } catch {
    return {};
  }
}

export async function saveBevelAverages(next: Record<string, BevelComponentAvg>): Promise<void> {
  const all = await loadBevelAverages();
  Object.assign(all, next);
  try { await FileSystem.writeAsStringAsync(AVG_FILE, JSON.stringify(all)); } catch {}
}

// Exact 30-day averages + bands read off the 2026-06-20 detail screens (canonical units).
const SEED_AVERAGES: Record<string, BevelComponentAvg> = {
  // Strain
  strainScore:      { avg: 26,   bandLo: 3,    bandHi: 45,   asOf: '2026-06-20', windowDays: 30 },
  exerciseDuration: { avg: 43,   bandLo: 0,    bandHi: 92,   asOf: '2026-06-20', windowDays: 30 },
  daytimeHR:        { avg: 67,   bandLo: 64,   bandHi: 71,   asOf: '2026-06-20', windowDays: 30 },
  totalEnergy:      { avg: 2532, bandLo: 2036, bandHi: 2972, asOf: '2026-06-20', windowDays: 30 },
  stepCount:        { avg: 8590, bandLo: 2440, bandHi: 13812,asOf: '2026-06-20', windowDays: 30 },
  // Recovery
  recoveryScore:    { avg: 55,   bandLo: 35,   bandHi: 77,   asOf: '2026-06-20', windowDays: 30 },
  restingHrv:       { avg: 34.6, bandLo: 27.4, bandHi: 42.6, asOf: '2026-06-20', windowDays: 30 },
  restingHr:        { avg: 60.2, bandLo: 56.5, bandHi: 63.4, asOf: '2026-06-20', windowDays: 30 },
  respiratoryRate:  { avg: 14.2, bandLo: 13.5, bandHi: 14.8, asOf: '2026-06-20', windowDays: 30 },
  oxygenSaturation: { avg: 95.0, bandLo: 94.4, bandHi: 95.7, asOf: '2026-06-20', windowDays: 30 },
  // Sleep
  sleepScore:       { avg: 71,   bandLo: 52,   bandHi: 91,   asOf: '2026-06-20', windowDays: 30 },
  timeAsleep:       { avg: 377,  bandLo: 279,  bandHi: 466,  asOf: '2026-06-20', windowDays: 30 }, // 6h17m
  remSleep:         { avg: 98,   bandLo: 66,   bandHi: 127,  asOf: '2026-06-20', windowDays: 30 }, // 1h38m
  deepSleep:        { avg: 38,   bandLo: 26,   bandHi: 51,   asOf: '2026-06-20', windowDays: 30 },
  heartRateDip:     { avg: 10,   bandLo: 6,    bandHi: 14,   asOf: '2026-06-20', windowDays: 30 },
  sleepTime:        { avg: 1416, bandLo: 1309, bandHi: 95,   asOf: '2026-06-20', windowDays: 30 }, // 23:36 (band wraps midnight)
  wakeTime:         { avg: 381,  bandLo: 272,  bandHi: 494,  asOf: '2026-06-20', windowDays: 30 }, // 06:21
};

/**
 * Seed the dataset with the 2026-06-20 values read from the calibration screenshots:
 * exact "today" values (one day) + exact 30-day averages/bands (whole month), so the
 * analysis has real component-level content before the user imports anything.
 * No-op if data already exists.
 */
export async function seedBevelDataIfEmpty(): Promise<boolean> {
  const existing = await loadBevelData();
  const existingAvg = await loadBevelAverages();
  if (Object.keys(existing).length > 0 || Object.keys(existingAvg).length > 0) return false;
  const date = '2026-06-20';
  await saveBevelKpi(date, 'strain',   { score: 42, components: { strainScore: 42, exerciseDuration: 70, daytimeHR: 68, totalEnergy: 1436, stepCount: 11592 } });
  await saveBevelKpi(date, 'recovery', { score: 64, components: { recoveryScore: 64, restingHrv: 38.2, restingHr: 59.4, respiratoryRate: 13.7, oxygenSaturation: 94.7 } });
  await saveBevelKpi(date, 'sleep',    { score: 59, components: { sleepScore: 59, timeAsleep: 302, remSleep: 69, deepSleep: 25, heartRateDip: 11, sleepBank: -46, sleepTime: 40, wakeTime: 351 } });
  await saveBevelAverages(SEED_AVERAGES);
  return true;
}

/** A single JSON blob of both datasets, for export/offline analysis. */
export function buildExportPayload(
  days: BevelDay[],
  ours: Record<string, Record<string, number>>,
  bevelAverages: Record<string, BevelComponentAvg>,
): string {
  // Compact (no indentation) — smallest payload to copy/paste. ours[date] also carries
  // cardioLoad (ATL) / ctl / tsb for cross-model verification.
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    app: 'RunCoachAI',
    note: 'Canonical units: durations & clock in min; energy kcal; % as number. ours[date] also has cardioLoad(ATL)/ctl/tsb.',
    bevelAverages,
    bevelDays: days,
    ours,
  });
}

// ─── Value parsing (raw on-screen string → canonical number) ──────────────────────

/**
 * Parse a number that may be in European (',' decimal, '.' thousands) OR plain
 * dot-decimal form — the vision model emits both. A bare '.' is treated as thousands
 * ONLY when it groups exactly 3 trailing digits (11.592 → 11592); otherwise it's a
 * decimal point (94.1 → 94.1, 35.9 → 35.9) so we don't 10× biometrics like SpO₂/HRV.
 */
export function parseEuroNumber(s: string): number | null {
  let cleaned = s.replace(/[^\d.,-]/g, '');
  if (!cleaned || cleaned === '-') return null;
  const neg = cleaned.startsWith('-');
  cleaned = cleaned.replace(/-/g, '');

  const hasDot = cleaned.includes('.');
  const hasComma = cleaned.includes(',');
  let norm: string;
  if (hasDot && hasComma) {
    // The rightmost separator is the decimal; the other groups thousands.
    norm = cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')
      ? cleaned.replace(/\./g, '').replace(',', '.')
      : cleaned.replace(/,/g, '');
  } else if (hasComma) {
    norm = cleaned.replace(',', '.');                 // comma = decimal
  } else if (hasDot) {
    const dots = cleaned.split('.').length - 1;
    const lastGroup = cleaned.slice(cleaned.lastIndexOf('.') + 1);
    norm = (dots === 1 && lastGroup.length !== 3)
      ? cleaned                                        // single '.' + 1–2 (or 4+) digits = decimal
      : cleaned.replace(/\./g, '');                    // 3-digit group(s) = thousands
  } else {
    norm = cleaned;
  }
  const n = Number(norm);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

/** '1h 10m' → 70, '43m' → 43, '5h 2m' → 302, '2h' → 120. */
export function parseDurationMin(s: string): number | null {
  const h = s.match(/(\d+)\s*h/i);
  const m = s.match(/(\d+)\s*m/i);
  if (!h && !m) return null;
  return (h ? parseInt(h[1], 10) * 60 : 0) + (m ? parseInt(m[1], 10) : 0);
}

/** Like duration but keeps a leading sign / 'debt'. '-46m' → -46, '-1h 12m' → -72. */
export function parseSignedMin(s: string): number | null {
  const mag = parseDurationMin(s.replace('-', ''));
  if (mag === null) return null;
  const neg = /^\s*-/.test(s) || /debt/i.test(s);
  return neg ? -mag : mag;
}

/** 'HH:MM' → minutes since midnight. '05:51' → 351, '00:40' → 40. */
export function parseClockMin(s: string): number | null {
  const m = s.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

export function toCanonical(unit: UnitKind, raw: string): number | null {
  const s = (raw ?? '').toString().trim();
  if (!s) return null;
  switch (unit) {
    case 'duration_min': return parseDurationMin(s);
    case 'signed_min':   return parseSignedMin(s);
    case 'clock_time':   return parseClockMin(s);
    default:             return parseEuroNumber(s);
  }
}

/** Canonical value → display string (used by the review screen). */
export function formatCanonical(unit: UnitKind, v: number): string {
  switch (unit) {
    case 'duration_min':
    case 'signed_min': {
      const sign = v < 0 ? '-' : '';
      const a = Math.abs(v);
      const h = Math.floor(a / 60), m = a % 60;
      return h > 0 ? `${sign}${h}h ${m}m` : `${sign}${m}m`;
    }
    case 'clock_time': {
      const h = Math.floor(v / 60), m = v % 60;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
    case 'percent': return `${v}%`;
    case 'kcal':    return `${v} kcal`;
    case 'steps':   return `${v}`;
    default:        return `${v} ${unitSuffix(unit)}`;
  }
}

function unitSuffix(unit: UnitKind): string {
  return ({ bpm: 'bpm', ms: 'ms', rpm: 'rpm' } as Record<string, string>)[unit] ?? '';
}

// ─── Extraction prompt + parser ───────────────────────────────────────────────────

export function buildBevelExtractionPrompt(): string {
  const kpiBlocks = BEVEL_KPIS.map(k => {
    const rows = k.components
      .map(c => `    • "${c.label}" → key "${c.key}" (${c.suffix || c.unit}; ${c.typical})`)
      .join('\n');
    return `  ${k.label.toUpperCase()} (kpi="${k.key}"):\n${rows}`;
  }).join('\n\n');

  return [
    'You are extracting values from a screenshot of the Bevel health app (dark UI).',
    'A screenshot is either a KPI OVERVIEW (one headline score on top + several component cards below)',
    'or a single COMPONENT DETAIL (one big number + a 30-day chart). Read whatever is visible.',
    '',
    'CRITICAL: ONLY read PRINTED NUMERIC FIGURES — the large headline value, the card values, the',
    '"Avg." pill text, and the normal-range band text. NEVER estimate, infer, or read values from the',
    'chart line, dots, sparklines, or axis — those are unreliable. If a number is not printed as text,',
    'do not report it. A figure is real; a graph position is not.',
    '',
    'IMPORTANT — Bevel uses European number formatting:',
    '  • "." is the THOUSANDS separator and "," is the DECIMAL separator.',
    '  • e.g. "11.592" = 11592 steps, "1.436" = 1436 kcal, "94,7" = 94.7%.',
    '  • Return the RAW on-screen text for each value; do NOT convert numbers yourself.',
    '  • Durations look like "1h 10m"/"43m"; clock times like "05:51"; Sleep Bank may be negative ("-46m").',
    '',
    'The three KPIs and their components (Bevel label → key → unit/magnitude hint):',
    '',
    kpiBlocks,
    '',
    'A single-component DETAIL screen also prints an exact 30-day AVERAGE (the "Avg." pill text on the',
    'chart) and a NORMAL RANGE band (top-right). Capture those printed figures too when visible — but',
    'again, ONLY the printed text, never a value read off the chart curve.',
    '',
    'Return ONLY a JSON object, no prose, no code fences:',
    '{',
    '  "date": "YYYY-MM-DD",            // the calendar date shown beside the headline value; if a range is shown use the END date; null if none',
    '  "kpi": "strain|recovery|sleep",  // which KPI this screen belongs to; "unknown" if unclear',
    '  "components": { "<key>": "<raw on-screen string>", ... },  // today/headline value per component you can read',
    '  "averages":   { "<key>": { "avg": "<raw>", "low": "<raw>", "high": "<raw>" }, ... }  // 30-day avg + normal band, when printed',
    '}',
    'Use the exact keys listed above. Omit anything you cannot read. Do not invent values.',
  ].join('\n');
}

export interface BevelExtraction {
  date:   string | null;
  kpi:    BevelKpiKey | 'unknown';
  record: BevelKpiRecord;
  /** Exact 30-day averages + bands the model read off detail screens. */
  averages: Record<string, BevelComponentAvg>;
  /** Per-component raw strings the model returned, for the review UI. */
  raw:    Record<string, string>;
}

/** Parse the vision model's JSON response into canonical values. Throws on bad JSON / unknown KPI. */
export function parseBevelExtraction(text: string): BevelExtraction {
  const jsonStr = extractJsonObject(text);
  if (!jsonStr) throw new Error('No JSON found in the model response.');

  let obj: any;
  try { obj = JSON.parse(jsonStr); }
  catch { throw new Error('Model returned malformed JSON.'); }

  const kpi: BevelExtraction['kpi'] =
    (['strain', 'recovery', 'sleep'] as const).includes(obj.kpi) ? obj.kpi : 'unknown';
  if (kpi === 'unknown') throw new Error('Could not identify which KPI the screenshot shows.');

  const scale = kpiScale(kpi);
  const byKey = new Map<string, ComponentScale>(scale.components.map(c => [c.key, c]));

  const components: Record<string, number> = {};
  const raw: Record<string, string> = {};
  let score: number | undefined;

  const rawComps = (obj.components && typeof obj.components === 'object') ? obj.components : {};
  for (const [key, val] of Object.entries(rawComps)) {
    const comp = byKey.get(key);
    if (!comp || val == null) continue;
    raw[key] = String(val);
    const canon = toCanonical(comp.unit, String(val));
    if (canon == null) continue;
    components[key] = canon;
    if (comp.isScore) score = canon;
  }

  // Optional exact 30-day averages + bands (detail screens)
  const averages: Record<string, BevelComponentAvg> = {};
  const rawAvgs = (obj.averages && typeof obj.averages === 'object') ? obj.averages : {};
  for (const [key, val] of Object.entries(rawAvgs)) {
    const comp = byKey.get(key);
    if (!comp || val == null || typeof val !== 'object') continue;
    const v = val as any;
    const avg = toCanonical(comp.unit, String(v.avg ?? ''));
    if (avg == null) continue;
    const lo = v.low  != null ? toCanonical(comp.unit, String(v.low))  : undefined;
    const hi = v.high != null ? toCanonical(comp.unit, String(v.high)) : undefined;
    averages[key] = { avg, bandLo: lo ?? undefined, bandHi: hi ?? undefined, asOf: new Date().toISOString(), windowDays: 30 };
  }

  if (Object.keys(components).length === 0 && Object.keys(averages).length === 0) {
    throw new Error('No readable values in the screenshot.');
  }

  const date = typeof obj.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(obj.date) ? obj.date : null;
  return { date, kpi, record: { score, components }, averages, raw };
}

/** Pull the first balanced {…} block out of a possibly-fenced model response. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}
