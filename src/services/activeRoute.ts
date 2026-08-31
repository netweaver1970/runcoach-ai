/**
 * The route currently sent to the watch for an in-progress run, persisted so the phone's Wayfinder can act as
 * a LIVE BACKUP for the tiny watch screen: reopen it mid-run and it shows the same route + your live position,
 * instead of forgetting the run and opening blank. `active` spans from "sent to watch" until the watch signals
 * the run ended (runKeepAlive) or it's cleared.
 */
import * as FileSystem from 'expo-file-system';
import { RouteLoop } from './routing';

const FILE = `${FileSystem.documentDirectory}runcoach-active-route.json`;

export interface ActiveRoute { loop: RouteLoop; name: string; active: boolean; savedAt: number }

export async function saveActiveRoute(loop: RouteLoop, name: string): Promise<void> {
  try {
    if (!loop?.coords || loop.coords.length < 2) return;
    await FileSystem.writeAsStringAsync(FILE, JSON.stringify({ loop, name, active: true, savedAt: Date.now() }));
  } catch { /* ignore */ }
}

export async function setRunActive(active: boolean): Promise<void> {
  try {
    const cur = await loadActiveRoute();
    if (!cur) return;
    await FileSystem.writeAsStringAsync(FILE, JSON.stringify({ ...cur, active }));
  } catch { /* ignore */ }
}

export async function loadActiveRoute(): Promise<ActiveRoute | null> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (!info.exists) return null;
    const r = JSON.parse(await FileSystem.readAsStringAsync(FILE)) as ActiveRoute;
    return r?.loop?.coords?.length ? r : null;
  } catch { return null; }
}

export async function clearActiveRoute(): Promise<void> {
  try { await FileSystem.deleteAsync(FILE, { idempotent: true }); } catch { /* ignore */ }
}
