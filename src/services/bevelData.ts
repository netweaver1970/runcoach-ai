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
}

export interface BevelDay {
  date:       string;                  // 'YYYY-MM-DD'
  capturedAt: string;                  // ISO timestamp of the import
  strain?:    BevelKpiRecord;
  recovery?:  BevelKpiRecord;
  sleep?:     BevelKpiRecord;
}

const FILE = `${FileSystem.documentDirectory}runcoach-bevel-data.json`;

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

/**
 * Seed the dataset with the 2026-06-20 values read from the calibration
 * screenshots, so the analysis has something to show before the user imports.
 * No-op if any Bevel data already exists.
 */
export async function seedBevelDataIfEmpty(): Promise<boolean> {
  const existing = await loadBevelData();
  if (Object.keys(existing).length > 0) return false;
  const date = '2026-06-20';
  await saveBevelKpi(date, 'strain',   { score: 42, components: { strainScore: 42, exerciseDuration: 70, daytimeHR: 68, totalEnergy: 1436, stepCount: 11592 } });
  await saveBevelKpi(date, 'recovery', { score: 64, components: { recoveryScore: 64, restingHrv: 38.2, restingHr: 59.4, respiratoryRate: 13.7, oxygenSaturation: 94.7 } });
  await saveBevelKpi(date, 'sleep',    { score: 59, components: { sleepScore: 59, timeAsleep: 302, remSleep: 69, deepSleep: 25, heartRateDip: 11, sleepBank: -46, sleepTime: 40, wakeTime: 351 } });
  return true;
}

/** A single JSON blob of both datasets, for export/offline analysis. */
export function buildExportPayload(
  days: BevelDay[],
  ours: Record<string, Record<string, number>>,
): string {
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    app: 'RunCoachAI',
    note: 'Canonical units: durations & clock times in minutes; energy kcal; % as number.',
    bevel: days,
    ours,
  }, null, 2);
}

// ─── Value parsing (raw on-screen string → canonical number) ──────────────────────

/** European number format: '.' = thousands separator, ',' = decimal. */
export function parseEuroNumber(s: string): number | null {
  const cleaned = s.replace(/[^\d.,-]/g, '');
  if (!cleaned || cleaned === '-') return null;
  const norm = cleaned.replace(/\./g, '').replace(',', '.');
  const n = Number(norm);
  return Number.isFinite(n) ? n : null;
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
    'Return ONLY a JSON object, no prose, no code fences:',
    '{',
    '  "date": "YYYY-MM-DD",            // the calendar date shown beside the headline value; if a range is shown use the END date; null if none',
    '  "kpi": "strain|recovery|sleep",  // which KPI this screen belongs to; "unknown" if unclear',
    '  "components": { "<key>": "<raw on-screen string>", ... }  // include every component value you can read',
    '}',
    'Use the exact keys listed above. Omit components you cannot read. Do not invent values.',
  ].join('\n');
}

export interface BevelExtraction {
  date:   string | null;
  kpi:    BevelKpiKey | 'unknown';
  record: BevelKpiRecord;
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

  if (Object.keys(components).length === 0) {
    throw new Error('No readable component values in the screenshot.');
  }

  const date = typeof obj.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(obj.date) ? obj.date : null;
  return { date, kpi, record: { score, components }, raw };
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
