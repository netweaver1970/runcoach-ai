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
 * STORAGE = a date-keyed SWITCH LIST, not per-run tags. The list ALWAYS starts with a default
 * { since: 1970, mode: 'work' } entry and gains one entry each time the mode is changed
 * (effective from that day). A run's regime = the mode in force on the run's DATE. Because run
 * dates come back from HealthKit, this is fully reconstructible after a wipe + reinstall — only
 * the (tiny) switch list itself needs to be in the backup. Switching only affects runs dated on/
 * after the switch day; history never moves.
 */
import * as SecureStore from 'expo-secure-store';

export type AccountingMode = 'work' | 'full';
export const DEFAULT_ACCOUNTING: AccountingMode = 'work';

export interface SwitchPoint { since: string; mode: AccountingMode } // since = YYYY-MM-DD, inclusive

const SWITCHES_KEY = 'accounting_switches';
const EPOCH = '1970-01-01';
const DEFAULT_SWITCHES: SwitchPoint[] = [{ since: EPOCH, mode: 'work' }];

const todayKey = (): string => {
  const d = new Date(); const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

let switchCache: SwitchPoint[] | null = null;
async function loadSwitches(): Promise<SwitchPoint[]> {
  if (switchCache) return switchCache;
  try {
    const raw = await SecureStore.getItemAsync(SWITCHES_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      switchCache = Array.isArray(arr) && arr.length ? arr : [...DEFAULT_SWITCHES];
      return switchCache;
    }
    // Migrate the previous single-mode key: if it was 'full', start a switch from today.
    const legacy = await SecureStore.getItemAsync('accounting_mode');
    if (legacy === 'full') {
      switchCache = [{ since: EPOCH, mode: 'work' }, { since: todayKey(), mode: 'full' }];
      await saveSwitches(switchCache);
    } else {
      switchCache = [...DEFAULT_SWITCHES];
    }
  } catch { switchCache = [...DEFAULT_SWITCHES]; }
  return switchCache!;
}
async function saveSwitches(list: SwitchPoint[]): Promise<void> {
  switchCache = list;
  try { await SecureStore.setItemAsync(SWITCHES_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

/** The full switch-point list (always starts with the 1970 'work' default). For the backup. */
export async function getSwitchList(): Promise<SwitchPoint[]> { return [...(await loadSwitches())]; }
/** Invalidate the in-memory cache (call after a restore writes a new switch list). */
export function clearAccountingCache(): void { switchCache = null; }

/** The CURRENT mode = the last switch entry's mode. */
export async function getAccountingMode(): Promise<AccountingMode> {
  const list = await loadSwitches();
  return list[list.length - 1]?.mode ?? 'work';
}

/** Change the mode, effective TODAY. No-op if unchanged. Keeps the list minimal + work-anchored. */
export async function setAccountingMode(mode: AccountingMode): Promise<void> {
  const list = await loadSwitches();
  if ((list[list.length - 1]?.mode ?? 'work') === mode) return;
  const today = todayKey();
  let next = list.filter(sp => sp.since !== today);          // drop a same-day flip-flop
  next.push({ since: today, mode });
  next.sort((a, b) => a.since.localeCompare(b.since));
  if (next[0].since !== EPOCH) next.unshift({ since: EPOCH, mode: 'work' });
  next = next.filter((sp, i) => i === 0 || sp.mode !== next[i - 1].mode); // collapse same-mode runs
  await saveSwitches(next);
}

/** The regime in force on a given run date (latest switch with since ≤ date). */
export function regimeForDate(date: string, list: SwitchPoint[]): AccountingMode {
  const d = date.slice(0, 10);
  let mode: AccountingMode = 'work';
  for (const sp of list) { if (sp.since <= d) mode = sp.mode; else break; }
  return mode;
}

/** Date the regime first became 'full' — the work→full boundary for graphs, or null. */
export async function getFullBoundary(): Promise<string | null> {
  const f = (await loadSwitches()).find(sp => sp.mode === 'full');
  return f && f.since !== EPOCH ? f.since : null;
}
