/**
 * Volume-accounting regime.
 *
 * 'work'  — count only WORK + DRILLS minutes/distance toward volume (the progression cap,
 *           time-on-feet, 7-day plan). Warm-up / cool-down / recovery are excluded.
 * 'full'  — count the WHOLE run (every minute/metre). For when warm-ups/cool-downs become
 *           real running, not walks.
 *
 * This ONLY governs volume (minutes/distance). Strain and CTL/ATL are HR-based over the full
 * workout already, so they're unaffected.
 *
 * GUARDRAIL: every run is tagged with the regime it was recorded under, set ONCE and never
 * changed. Switching the mode only affects runs seen afterwards; history never moves. The tag
 * lives in a durable FileSystem file (SecureStore is too small for a big map, and the workout
 * cache is wiped on re-scans — which would lose the tags and break the guarantee).
 */
import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system';

export type AccountingMode = 'work' | 'full';
export const DEFAULT_ACCOUNTING: AccountingMode = 'work';

const MODE_KEY     = 'accounting_mode';
const REGIME_FILE  = `${FileSystem.documentDirectory}run-regimes.json`;

export async function getAccountingMode(): Promise<AccountingMode> {
  try { return (await SecureStore.getItemAsync(MODE_KEY)) === 'full' ? 'full' : 'work'; }
  catch { return DEFAULT_ACCOUNTING; }
}
export async function setAccountingMode(m: AccountingMode): Promise<void> {
  try { await SecureStore.setItemAsync(MODE_KEY, m); } catch { /* ignore */ }
}

let regimeCache: Record<string, AccountingMode> | null = null;
async function loadRegimes(): Promise<Record<string, AccountingMode>> {
  if (regimeCache) return regimeCache;
  try {
    const info = await FileSystem.getInfoAsync(REGIME_FILE);
    regimeCache = info.exists ? JSON.parse(await FileSystem.readAsStringAsync(REGIME_FILE)) : {};
  } catch { regimeCache = {}; }
  return regimeCache!;
}

/** The full uuid→regime map (a copy). Untagged runs are treated as 'work' via regimeOf(). */
export async function getRunRegimes(): Promise<Record<string, AccountingMode>> {
  return { ...(await loadRegimes()) };
}

/** Tag any UNTAGGED uuids with the CURRENT mode (set-once; never overwrites). Returns the map. */
export async function tagRuns(uuids: string[]): Promise<Record<string, AccountingMode>> {
  const map = await loadRegimes();
  const mode = await getAccountingMode();
  let changed = false;
  for (const u of uuids) if (u && !map[u]) { map[u] = mode; changed = true; }
  if (changed) {
    try { await FileSystem.writeAsStringAsync(REGIME_FILE, JSON.stringify(map)); } catch { /* ignore */ }
  }
  return { ...map };
}

export const regimeOf = (map: Record<string, AccountingMode>, uuid: string): AccountingMode =>
  map[uuid] ?? 'work';

/** Date (YYYY-MM-DD) of the earliest run tagged 'full' — the work→full boundary for graphs, or null. */
export async function fullRegimeSince(runDates: { uuid: string; date: string }[]): Promise<string | null> {
  const map = await loadRegimes();
  const fulls = runDates.filter(r => map[r.uuid] === 'full').map(r => r.date.slice(0, 10)).sort();
  return fulls.length ? fulls[0] : null;
}
