/**
 * Per-run metadata — user notes + recorded temperature, keyed by workout UUID.
 *
 * Temperature precedence (resolved in healthkit.ts):
 *   manual (user typed) > HealthKit weather metadata > live capture at sync time
 *
 * Stored in a JSON file (notes can be long — SecureStore is size-limited).
 */

import * as FileSystem from 'expo-file-system';

export type TempSource = 'manual' | 'hk' | 'live';

export interface RunMeta {
  note?:       string;
  tempC?:      number;
  tempSource?: TempSource;
}

const FILE = `${FileSystem.documentDirectory}runcoach-run-meta.json`;

export async function loadRunMeta(): Promise<Record<string, RunMeta>> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (!info.exists) return {};
    return JSON.parse(await FileSystem.readAsStringAsync(FILE)) as Record<string, RunMeta>;
  } catch {
    return {};
  }
}

async function write(all: Record<string, RunMeta>): Promise<void> {
  try { await FileSystem.writeAsStringAsync(FILE, JSON.stringify(all)); } catch {}
}

export async function getRunMeta(uuid: string): Promise<RunMeta> {
  const all = await loadRunMeta();
  return all[uuid] ?? {};
}

/** Merge a partial patch into a run's metadata. Returns the updated full map. */
export async function setRunMeta(uuid: string, patch: RunMeta): Promise<Record<string, RunMeta>> {
  const all = await loadRunMeta();
  const next = { ...(all[uuid] ?? {}), ...patch };
  // Drop empty fields to keep the file tidy
  if (next.note != null && next.note.trim() === '') delete next.note;
  if (next.tempC == null || Number.isNaN(next.tempC)) { delete next.tempC; delete next.tempSource; }
  if (Object.keys(next).length === 0) delete all[uuid];
  else all[uuid] = next;
  await write(all);
  return all;
}

export async function saveRunNote(uuid: string, note: string): Promise<void> {
  await setRunMeta(uuid, { note });
}

export async function saveRunTemp(uuid: string, tempC: number, source: TempSource): Promise<void> {
  await setRunMeta(uuid, { tempC: Math.round(tempC), tempSource: source });
}
