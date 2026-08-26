/**
 * Push a Wayfinder loop to the watchOS app for on-wrist guidance. Reuses the KPI WatchConnectivity channel
 * (RunCoachWatchSync.sync) — the watch tries a KPIPayload decode first, then a route. Downsampled so the
 * WCSession message stays small. See targets/watch/RouteView.swift for the receiver.
 */
import { requireNativeModule } from 'expo-modules-core';
import * as SecureStore from 'expo-secure-store';
import { RouteLoop } from './routing';

interface WatchSyncNative { isSupported(): Promise<boolean>; isPaired(): Promise<boolean>; sync(json: string): Promise<boolean>; }
let WatchSync: WatchSyncNative | null = null;
try { WatchSync = requireNativeModule('RunCoachWatchSync'); } catch { WatchSync = null; }

export const watchRouteAvailable = (): boolean => WatchSync != null;
export async function watchPaired(): Promise<boolean> {
  try { return WatchSync ? await WatchSync.isPaired() : false; } catch { return false; }
}

// Spoken turn-by-turn on the watch (default ON). The value is sent with each route push and is the watch's
// initial state; the runner can still mute live from the wrist. Stored in SecureStore for simplicity.
const VOICE_STORE = 'route_voice_v1';
export async function getVoiceNav(): Promise<boolean> {
  try { return (await SecureStore.getItemAsync(VOICE_STORE)) !== '0'; } catch { return true; }
}
export async function setVoiceNav(on: boolean): Promise<void> {
  try { await SecureStore.setItemAsync(VOICE_STORE, on ? '1' : '0'); } catch { /* ignore */ }
}

const r5 = (n: number) => Math.round(n * 1e5) / 1e5;

/** Send the selected loop to the watch. `coords` are [lon, lat]; the watch expects {lat, lon}. */
export async function sendRouteToWatch(loop: RouteLoop, name = 'Route', sport: 'running' | 'walking' = 'running'): Promise<boolean> {
  if (!WatchSync) return false;
  const co = loop.coords ?? [];
  if (co.length < 2) return false;
  const step = Math.max(1, Math.ceil(co.length / 150));                       // ≤150 pts → small WC payload
  const pts = co.filter((_, i) => i % step === 0 || i === co.length - 1)
    .map(([lon, lat]) => ({ lat: r5(lat), lon: r5(lon) }));
  // Turn points carry their own lat/lon (from the FULL-res geometry), so downsampling `pts` doesn't shift them.
  const turns = (loop.steps ?? [])
    .map(st => { const c = co[st.i]; return c ? { lat: r5(c[1]), lon: r5(c[0]), text: st.text.slice(0, 90), dist: st.dist } : null; })
    .filter((t): t is { lat: number; lon: number; text: string; dist: number } => t != null);
  const payload = {
    type: 'route', name, distanceKm: Math.round(loop.distanceKm * 10) / 10, pts, turns,
    voice: await getVoiceNav(), sport,
  };
  try { return await WatchSync.sync(JSON.stringify(payload)); } catch { return false; }
}
