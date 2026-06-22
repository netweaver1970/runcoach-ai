import { requireNativeModule } from 'expo-modules-core';

export interface RunCoachWatchSyncNative {
  isSupported(): Promise<boolean>;
  isPaired(): Promise<boolean>;
  sync(json: string): Promise<boolean>;
}

// Resolves to null if the native module isn't built into this binary.
let native: RunCoachWatchSyncNative | null = null;
try { native = requireNativeModule('RunCoachWatchSync'); } catch { native = null; }

export default native;
