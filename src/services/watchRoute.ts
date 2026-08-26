/**
 * Push a Wayfinder loop to the watchOS app for on-wrist guidance. Reuses the KPI WatchConnectivity channel
 * (RunCoachWatchSync.sync) — the watch tries a KPIPayload decode first, then a route. Downsampled so the
 * WCSession message stays small. See targets/watch/RouteView.swift for the receiver.
 */
import { requireNativeModule } from 'expo-modules-core';
import * as SecureStore from 'expo-secure-store';
import { RouteLoop } from './routing';
import type { WatchWorkout } from './coach';

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

// A flat, ordered list of segments the watch engine steps through (Stage 2). Mirrors how RunCoachWorkoutModule
// builds the WorkoutKit intervals: warmup → drills → per block reps×(work[,recover]) with NO trailing recover →
// cooldown. dur (s) OR dist (m) → a goal; neither → an OPEN segment advanced by the lap button.
export interface WorkoutSeg { kind: string; dur?: number; dist?: number; label: string; zone?: string }
export function flattenWorkout(w: WatchWorkout): WorkoutSeg[] {
  const segs: WorkoutSeg[] = [];
  segs.push(w.warmupMeters > 0 ? { kind: 'warmup', dist: w.warmupMeters, label: 'Warm-up' } : { kind: 'warmup', label: 'Warm-up' });
  if (w.drillsMinutes > 0) segs.push({ kind: 'drills', dur: w.drillsMinutes * 60, label: 'Drills' });
  for (const b of w.blocks ?? []) {
    const reps = Math.max(1, b.repeats || 1);
    const work = (): WorkoutSeg => ({ kind: 'work', ...(b.workMinutes > 0 ? { dur: b.workMinutes * 60 } : {}), label: b.label || 'Work', zone: b.hrZone });
    if (b.restMinutes > 0) {
      const rec = (): WorkoutSeg => ({ kind: 'recovery', dur: b.restMinutes * 60, label: 'Recover', zone: b.recoveryZone });
      for (let i = 0; i < reps - 1; i++) { segs.push(work()); segs.push(rec()); }
      segs.push(work());                                    // final rep has no trailing recovery
    } else {
      for (let i = 0; i < reps; i++) segs.push(work());
    }
  }
  segs.push(w.cooldownMeters > 0 ? { kind: 'cooldown', dist: w.cooldownMeters, label: 'Cool-down' } : { kind: 'cooldown', label: 'Cool-down' });
  return segs;
}

/** Send the selected loop to the watch. `coords` are [lon, lat]; the watch expects {lat, lon}. */
export async function sendRouteToWatch(loop: RouteLoop, name = 'Route', sport: 'running' | 'walking' = 'running', workout?: WatchWorkout | null): Promise<boolean> {
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
    workout: workout ? flattenWorkout(workout) : [],       // Stage 2: structured intervals for the run session
  };
  try { return await WatchSync.sync(JSON.stringify(payload)); } catch { return false; }
}
