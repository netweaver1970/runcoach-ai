/**
 * One-time migration: re-write the startup-critical SecureStore items with AFTER_FIRST_UNLOCK accessibility.
 *
 * WHY: SecureStore defaults to WHEN_UNLOCKED — an item is unreadable while the phone is locked. After a mid-run
 * crash, iOS relaunched the app in the BACKGROUND while the phone was still locked, so `theme_mode_v1` and
 * `onboarding_done_v1` read as null → the app looked brand-new (default theme + full onboarding). Nothing was
 * deleted (the file-backed DBs, which use a laxer file-protection class, were fine). Re-writing these keys with
 * AFTER_FIRST_UNLOCK makes them readable once the phone has been unlocked at least once since boot — which is
 * always true by the time a run is underway — so a locked relaunch reads them correctly.
 *
 * Runs when the app is foreground (unlocked), so the reads here succeed and the re-write sticks. Idempotent.
 */
import * as SecureStore from 'expo-secure-store';

const KEYS = [
  'theme_mode_v1', 'font_scale_v1', 'accent_color_v1',   // appearance
  'onboarding_done_v1', 'user_profile_v1',               // setup state (age/sex)
  'user_max_hr', 'observed_max_hr', 'long_run_minutes', 'sync_months',   // profile-ish settings
];

const OPT = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK } as const;
let done = false;

export async function migrateSecureStoreAccessibility(): Promise<void> {
  if (done) return;
  done = true;
  for (const k of KEYS) {
    try {
      const v = await SecureStore.getItemAsync(k);
      if (v != null) await SecureStore.setItemAsync(k, v, OPT);
    } catch { /* locked or absent — skip; next foreground launch retries via a fresh process */ }
  }
}
