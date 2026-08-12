// Persistence for the in-app Labs store (Biology → Labs). User-entered medical data → backed up
// (added to backup.ts FILES). The importer (app/labs-import.tsx) parses a spreadsheet with
// parseClinicalGrid, the user de-selects dates/analytes, and the survivors are merged in here.
import * as FileSystem from 'expo-file-system';
import { LabAnalyte } from './labs';

const LABS_FILE = `${FileSystem.documentDirectory}runcoach-labs.json`;

export interface LabStore { analytes: LabAnalyte[]; updatedAt: string }

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

// Merge selected analytes into the store — dedup by analyte key + date (incoming wins on a same-date
// conflict, e.g. a corrected re-import). Metadata (unit / ref range / note) is refreshed from incoming.
export async function mergeLabsImport(incoming: LabAnalyte[]): Promise<LabStore> {
  const store = await loadLabs();
  const byKey = new Map(store.analytes.map(a => [a.key, a]));
  for (const inc of incoming) {
    const ex = byKey.get(inc.key);
    if (!ex) { byKey.set(inc.key, inc); continue; }
    const sv = new Map(ex.series.map(v => [v.date, v.value]));
    for (const v of inc.series) sv.set(v.date, v.value);
    ex.series = [...sv].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));
    if (inc.textSeries?.length || ex.textSeries?.length) {
      const tv = new Map((ex.textSeries ?? []).map(v => [v.date, v.text]));
      for (const v of inc.textSeries ?? []) tv.set(v.date, v.text);
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
  return merged;
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
