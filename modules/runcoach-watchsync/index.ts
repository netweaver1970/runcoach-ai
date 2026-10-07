import { requireNativeModule } from 'expo-modules-core';

export interface RunCoachWatchSyncNative {
  isSupported(): Promise<boolean>;
  isPaired(): Promise<boolean>;
  sync(json: string): Promise<boolean>;
  queue?(json: string): Promise<boolean>;                 // builds ≥ 2026-10-07 (strength on the watch)
  pendingStrengthLogs?(): Promise<string>;
  ackStrengthLogs?(ids: string[]): Promise<void>;
}

// Resolves to null if the native module isn't built into this binary.
let native: RunCoachWatchSyncNative | null = null;
try { native = requireNativeModule('RunCoachWatchSync'); } catch { native = null; }

export default native;
