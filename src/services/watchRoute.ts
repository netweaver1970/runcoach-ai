/**
 * Push a Wayfinder loop to the watchOS app for on-wrist guidance. Reuses the KPI WatchConnectivity channel
 * (RunCoachWatchSync.sync) — the watch tries a KPIPayload decode first, then a route. Downsampled so the
 * WCSession message stays small. See targets/watch/RouteView.swift for the receiver.
 */
import { requireNativeModule } from 'expo-modules-core';
import { RouteLoop } from './routing';

interface WatchSyncNative { isSupported(): Promise<boolean>; isPaired(): Promise<boolean>; sync(json: string): Promise<boolean>; }
let WatchSync: WatchSyncNative | null = null;
try { WatchSync = requireNativeModule('RunCoachWatchSync'); } catch { WatchSync = null; }

export const watchRouteAvailable = (): boolean => WatchSync != null;
export async function watchPaired(): Promise<boolean> {
  try { return WatchSync ? await WatchSync.isPaired() : false; } catch { return false; }
}

/** Send the selected loop to the watch. `coords` are [lon, lat]; the watch expects {lat, lon}. */
export async function sendRouteToWatch(loop: RouteLoop, name = 'Route'): Promise<boolean> {
  if (!WatchSync) return false;
  const co = loop.coords ?? [];
  if (co.length < 2) return false;
  const step = Math.max(1, Math.ceil(co.length / 150));                       // ≤150 pts → small WC payload
  const pts = co.filter((_, i) => i % step === 0 || i === co.length - 1)
    .map(([lon, lat]) => ({ lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5 }));
  const payload = { type: 'route', name, distanceKm: Math.round(loop.distanceKm * 10) / 10, pts };
  try { return await WatchSync.sync(JSON.stringify(payload)); } catch { return false; }
}
