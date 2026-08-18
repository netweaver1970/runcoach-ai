/**
 * Automatic iCloud backup/restore — so moving to a new phone (or a fresh reinstall) needs no manual export.
 *
 * Reuses the SAME blob exportAllSettings/restoreAllSettings already produce, written to the user's private
 * iCloud Documents container (one file). No CloudKit, no server, no account — it's the user's own encrypted
 * iCloud. Everything degrades to a no-op when the native module isn't built in yet or the user isn't signed
 * into iCloud, so it's safe to ship before the prebuild that activates it.
 *
 * ACTIVATION (one-time, needs the Apple Developer account — see the migration notes):
 *   1. Xcode → target → Signing & Capabilities → + iCloud → tick iCloud Documents, container
 *      `iCloud.com.netweaver1970.runcoachai` (also declared in app.json's ios.entitlements).
 *   2. `npm run prebuild:ios` (+ the locale pod install) then a device build. Until then this is inert.
 */
import { AppState, AppStateStatus } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { exportAllSettings, restoreAllSettings } from './backup';
import { iCloudAvailable, readICloudBackup, writeICloudBackup } from '../../modules/runcoach-icloud';

const BACKUP_NAME  = 'runcoach-icloud-backup.json';
const LAST_SYNC_KEY = 'icloud_last_sync_at';   // not backed up — it's per-device telemetry

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let wired = false;

/** Whether auto-sync can run right now (module present + signed into iCloud). */
export function iCloudSyncAvailable(): boolean { return iCloudAvailable(); }

export async function iCloudLastSync(): Promise<string | null> {
  try { return await SecureStore.getItemAsync(LAST_SYNC_KEY); } catch { return null; }
}

/** Push the full settings blob to iCloud now. Includes API keys — it's the user's OWN encrypted container. */
export async function syncToICloud(): Promise<boolean> {
  if (!iCloudAvailable()) return false;
  try {
    const blob = await exportAllSettings(true);
    const res = await writeICloudBackup(BACKUP_NAME, blob);
    if (res.ok) { try { await SecureStore.setItemAsync(LAST_SYNC_KEY, res.modifiedAt || new Date().toISOString()); } catch { /* ignore */ } }
    return !!res.ok;
  } catch { return false; }
}

/** Debounced push — call after any settings change; coalesces a burst of edits into one write. */
export function scheduleICloudSync(delayMs = 4000): void {
  if (!iCloudAvailable()) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void syncToICloud(); }, delayMs);
}

/**
 * On a FRESH install only, pull the iCloud backup if one exists. Guarded so it can NEVER clobber a populated
 * install: it bails the moment the app looks set up (onboarding done or a profile/zones present). Returns
 * true if a restore actually happened (caller can then re-read state / skip onboarding).
 */
export async function maybeRestoreFromICloud(): Promise<boolean> {
  if (!iCloudAvailable()) return false;
  try {
    const [onboarded, profile, zones] = await Promise.all([
      SecureStore.getItemAsync('onboarding_done_v1'),
      SecureStore.getItemAsync('user_profile_v1'),
      SecureStore.getItemAsync('power_zones'),
    ]);
    if (onboarded || profile || zones) return false;   // already set up → leave it alone
    const { contents } = await readICloudBackup(BACKUP_NAME);
    if (!contents) return false;
    await restoreAllSettings(contents);
    return true;
  } catch { return false; }
}

/** Wire once at app root: auto-save whenever the app leaves the foreground. Idempotent. */
export function initICloudAutoSave(): void {
  if (wired) return;
  wired = true;
  const onChange = (s: AppStateStatus) => { if (s === 'background' || s === 'inactive') void syncToICloud(); };
  AppState.addEventListener('change', onChange);
}
