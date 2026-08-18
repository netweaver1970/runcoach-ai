import { requireNativeModule } from 'expo-modules-core';

export interface ICloudReadResult { contents: string | null; modifiedAt?: string; error?: string }
export interface ICloudWriteResult { ok: boolean; modifiedAt?: string; error?: string }

// Resolve lazily + defensively: on a build that hasn't been prebuilt with this native module yet (e.g. the
// current JS-only iteration), requireNativeModule throws — we swallow it so the whole feature degrades to
// "iCloud unavailable" instead of crashing the app at import time.
let cached: any | null | undefined;
function mod(): any | null {
  if (cached !== undefined) return cached;
  try { cached = requireNativeModule('RunCoachICloud'); } catch { cached = null; }
  return cached;
}

/** True only when the native module is present AND an iCloud container is reachable (user signed in). */
export function iCloudAvailable(): boolean {
  const m = mod(); if (!m) return false;
  try { return !!m.available(); } catch { return false; }
}

export async function writeICloudBackup(name: string, contents: string): Promise<ICloudWriteResult> {
  const m = mod(); if (!m) return { ok: false, error: 'native module unavailable' };
  try { return await m.writeBackup(name, contents); } catch (e: any) { return { ok: false, error: String(e?.message ?? e) }; }
}

export async function readICloudBackup(name: string): Promise<ICloudReadResult> {
  const m = mod(); if (!m) return { contents: null, error: 'native module unavailable' };
  try { return await m.readBackup(name); } catch (e: any) { return { contents: null, error: String(e?.message ?? e) }; }
}
