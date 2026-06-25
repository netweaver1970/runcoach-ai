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

// Each tag carries the run's date too, so the work→full boundary is self-contained (graphs don't
// need to re-join against run data).
type RegimeEntry = { r: AccountingMode; d: string };
export type RegimeMap = Record<string, RegimeEntry>;

let regimeCache: RegimeMap | null = null;
async function loadRegimes(): Promise<RegimeMap> {
  if (regimeCache) return regimeCache;
  try {
    const info = await FileSystem.getInfoAsync(REGIME_FILE);
    regimeCache = info.exists ? JSON.parse(await FileSystem.readAsStringAsync(REGIME_FILE)) : {};
  } catch { regimeCache = {}; }
  return regimeCache!;
}

/** The full uuid→{regime,date} map (a copy). Untagged runs are treated as 'work' via regimeOf(). */
export async function getRunRegimes(): Promise<RegimeMap> {
  return { ...(await loadRegimes()) };
}

/** Tag any UNTAGGED runs with the CURRENT mode + their date (set-once; never overwrites). */
export async function tagRuns(runs: { uuid: string; date: string }[]): Promise<void> {
  const map = await loadRegimes();
  const mode = await getAccountingMode();
  let changed = false;
  for (const { uuid, date } of runs) if (uuid && !map[uuid]) { map[uuid] = { r: mode, d: date.slice(0, 10) }; changed = true; }
  if (changed) {
    try { await FileSystem.writeAsStringAsync(REGIME_FILE, JSON.stringify(map)); } catch { /* ignore */ }
  }
}

export const regimeOf = (map: RegimeMap, uuid: string): AccountingMode => map[uuid]?.r ?? 'work';

/** Date (YYYY-MM-DD) of the earliest run tagged 'full' — the work→full boundary for graphs, or null. */
export async function getFullBoundary(): Promise<string | null> {
  const fulls = Object.values(await loadRegimes()).filter(e => e.r === 'full').map(e => e.d).sort();
  return fulls.length ? fulls[0] : null;
}
