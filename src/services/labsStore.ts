// Persistence for the in-app Labs store (Biology → Labs). User-entered medical data → backed up
// (added to backup.ts FILES). The importer (app/labs-import.tsx) parses a spreadsheet with
// parseClinicalGrid, the user de-selects dates/analytes, and the survivors are merged in here.
import * as FileSystem from 'expo-file-system';
import { LabAnalyte, LabValue } from './labs';

const LABS_FILE = `${FileSystem.documentDirectory}runcoach-labs.json`;

export interface LabStore { analytes: LabAnalyte[]; updatedAt: string }

// ── Union Apple-Health readings into a Labs analyte (display-only, NOT persisted) ─────────────────
// The user sometimes logs a value straight into Health rather than importing a blood test; fold those in
// so the chart shows the full picture. Pure + deterministic. Dedup is by DAY: we mirror imported labs INTO
// Health (same reading, at that day's midnight), so a matching day is a duplicate and is dropped — only
// Health-only days are added. `toCanonical(hkValue, analyteUnit)` converts the HK reading (in its fixed read
// unit) into the analyte's stored unit. Returns a fresh store (touched analyte re-sorted, note annotated)
// plus how many readings were folded in. Called at load time; never written back to disk.
export function unionHkIntoLabs(
  store: LabStore, hkType: string,
  hkReadings: { date: string; value: number }[],
  toCanonical: (hkValue: number, analyteUnit: string) => number,
): { store: LabStore; added: number } {
  if (!hkReadings?.length) return { store, added: 0 };
  let added = 0;
  const analytes = store.analytes.map(a => {
    if (a.hkType !== hkType) return a;
    const days = new Set(a.series.map(v => v.date.slice(0, 10)));
    const extra: LabValue[] = [];
    for (const r of hkReadings) {
      const day = (r.date || '').slice(0, 10);
      if (day.length !== 10 || days.has(day)) continue;   // malformed, or a mirrored/already-imported day
      days.add(day);
      const value = toCanonical(r.value, a.unit);
      if (Number.isFinite(value)) { extra.push({ date: day, value }); added++; }
    }
    if (!extra.length) return a;
    const series = [...a.series, ...extra].sort((x, y) => x.date.localeCompare(y.date));
    const base = (a.note ?? '').replace(/\s*·?\s*\+\d+ from Apple Health$/, '');   // don't stack the note
    return { ...a, series, note: `${base ? base + ' · ' : ''}+${extra.length} from Apple Health` };
  });
  return { store: { ...store, analytes }, added };
}

export async function loadLabs(): Promise<LabStore> {
  try {
    const info = await FileSystem.getInfoAsync(LABS_FILE);
    if (!info.exists) return { analytes: [], updatedAt: '' };
    const s = JSON.parse(await FileSystem.readAsStringAsync(LABS_FILE)) as LabStore;
    return { analytes: s.analytes ?? [], updatedAt: s.updatedAt ?? '' };
  } catch { return { analytes: [], updatedAt: '' }; }
}

async function saveLabs(store: LabStore): Promise<void> {
  try { await FileSystem.writeAsStringAsync(LABS_FILE, JSON.stringify(store)); } catch { /* ignore */ }
}

export interface MergeStats { store: LabStore; added: number; existing: number }

// Merge selected analytes into the store, keyed by analyte + date. A reading whose (analyte, date) is
// already present is LEFT UNTOUCHED — only genuinely new readings are added, so a re-import never
// duplicates. (To replace/correct values, import with the "Wipe existing labs first" option.) Analyte
// metadata (unit / ref range / note) is refreshed from incoming.
export async function mergeLabsImport(incoming: LabAnalyte[]): Promise<MergeStats> {
  const store = await loadLabs();
  const byKey = new Map(store.analytes.map(a => [a.key, a]));
  let added = 0, existing = 0;
  for (const inc of incoming) {
    const ex = byKey.get(inc.key);
    if (!ex) { byKey.set(inc.key, inc); added += inc.series.length + (inc.textSeries?.length ?? 0); continue; }
    const sv = new Map(ex.series.map(v => [v.date, v.value]));
    for (const v of inc.series) { if (sv.has(v.date)) existing++; else { sv.set(v.date, v.value); added++; } }
    ex.series = [...sv].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));
    if (inc.textSeries?.length || ex.textSeries?.length) {
      const tv = new Map((ex.textSeries ?? []).map(v => [v.date, v.text]));
      for (const v of inc.textSeries ?? []) { if (tv.has(v.date)) existing++; else { tv.set(v.date, v.text); added++; } }
      ex.textSeries = [...tv].map(([date, text]) => ({ date, text })).sort((a, b) => a.date.localeCompare(b.date));
    }
    Object.assign(ex, { label: inc.label, category: inc.category, unit: inc.unit, kind: inc.kind,
      refLow: inc.refLow, refHigh: inc.refHigh, hkType: inc.hkType, note: inc.note });
  }
  const merged: LabStore = {
    analytes: [...byKey.values()].sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label)),
    updatedAt: new Date().toISOString(),
  };
  await saveLabs(merged);
  return { store: merged, added, existing };
}

// Last-used Google Drive import link — remembered so a re-upload just re-fetches the same file.
const DRIVE_URL_FILE = `${FileSystem.documentDirectory}runcoach-labs-driveurl.json`;
export async function loadDriveUrl(): Promise<string> {
  try {
    const info = await FileSystem.getInfoAsync(DRIVE_URL_FILE);
    if (!info.exists) return '';
    return (JSON.parse(await FileSystem.readAsStringAsync(DRIVE_URL_FILE)).url as string) ?? '';
  } catch { return ''; }
}
export async function saveDriveUrl(url: string): Promise<void> {
  try { await FileSystem.writeAsStringAsync(DRIVE_URL_FILE, JSON.stringify({ url })); } catch { /* ignore */ }
}

export async function clearLabs(): Promise<void> {
  try { await FileSystem.deleteAsync(LABS_FILE, { idempotent: true }); } catch { /* ignore */ }
}

// ── Named marker templates (a saved set of analytes to recall as a selection) ──
const TPL_FILE = `${FileSystem.documentDirectory}runcoach-lab-templates.json`;
export interface LabTemplate { name: string; keys: string[] }

export async function loadTemplates(): Promise<LabTemplate[]> {
  try {
    const info = await FileSystem.getInfoAsync(TPL_FILE);
    if (!info.exists) return [];
    const t = JSON.parse(await FileSystem.readAsStringAsync(TPL_FILE)) as LabTemplate[];
    return Array.isArray(t) ? t : [];
  } catch { return []; }
}
export async function saveTemplate(name: string, keys: string[]): Promise<LabTemplate[]> {
  const list = (await loadTemplates()).filter(t => t.name.toLowerCase() !== name.trim().toLowerCase());
  list.push({ name: name.trim(), keys });
  list.sort((a, b) => a.name.localeCompare(b.name));
  try { await FileSystem.writeAsStringAsync(TPL_FILE, JSON.stringify(list)); } catch { /* ignore */ }
  return list;
}
export async function deleteTemplate(name: string): Promise<LabTemplate[]> {
  const list = (await loadTemplates()).filter(t => t.name !== name);
  try { await FileSystem.writeAsStringAsync(TPL_FILE, JSON.stringify(list)); } catch { /* ignore */ }
  return list;
}
