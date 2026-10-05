/**
 * Push a Wayfinder loop to the watchOS app for on-wrist guidance. Reuses the KPI WatchConnectivity channel
 * (RunCoachWatchSync.sync) — the watch tries a KPIPayload decode first, then a route. Downsampled so the
 * WCSession message stays small. See targets/watch/RouteView.swift for the receiver.
 */
import { requireNativeModule } from 'expo-modules-core';
import { startRunKeepAlive } from './runKeepAlive';
import { saveActiveRoute } from './activeRoute';
import * as SecureStore from 'expo-secure-store';
import { RouteLoop } from './routing';
import type { WatchWorkout } from './coach';
import { watchHrZones } from './zones';

// The zone lookup awaits a native HealthKit call; never let it delay or block sending the run to the watch —
// a hang there would mean the route never arrives and the keep-alive never starts. Falls back to [] (watch shows
// no zone readout; everything else unaffected).
const hrZonesForWatch = () => Promise.race([
  watchHrZones(),
  new Promise<{ z: string; lo: number; hi: number }[]>(resolve => setTimeout(() => resolve([]), 2000)),
]);

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

/**
 * The watch line = a SHAPE-PRESERVING simplification of the full route (Douglas–Peucker, ≤ tolM off the true path)
 * that also keeps a vertex at least every MAX_GAP_M (the watch's remaining-distance and off-route maths use the
 * vertices). It used to be every n-th point (≤150), which cut corners: a short zig-zag between houses became a
 * straight chord "over the houses" on the watch while the phone showed the real path (2026-10-05).
 */
const MAX_GAP_M = 60, MAX_WATCH_PTS = 450;   // the gap widens on very long routes (≥ total/400) so the cap holds
function segOffM(p: number[], a: number[], b: number[]): number {
  const k = 111320, cl = Math.cos(a[1] * Math.PI / 180);
  const bx = (b[0] - a[0]) * cl * k, by = (b[1] - a[1]) * k, px = (p[0] - a[0]) * cl * k, py = (p[1] - a[1]) * k;
  const L = bx * bx + by * by;
  const t = L > 0 ? Math.max(0, Math.min(1, (px * bx + py * by) / L)) : 0;
  return Math.hypot(px - t * bx, py - t * by);
}
const gapM = (a: number[], b: number[]) => {
  const k = 111320, cl = Math.cos(a[1] * Math.PI / 180);
  return Math.hypot((b[0] - a[0]) * cl * k, (b[1] - a[1]) * k);
};
export function simplifyForWatch(co: number[][]): number[][] {
  if (co.length <= 2) return co;
  let totalM = 0; for (let i = 1; i < co.length; i++) totalM += gapM(co[i - 1], co[i]);
  const maxGap = Math.max(MAX_GAP_M, totalM / 400);
  const run = (tolM: number): number[] => {
    const keep = new Uint8Array(co.length); keep[0] = keep[co.length - 1] = 1;
    const stack: [number, number][] = [[0, co.length - 1]];
    while (stack.length) {                                  // iterative DP (no recursion depth issues on long routes)
      const [a, b] = stack.pop()!;
      let worst = -1, wd = tolM;
      for (let i = a + 1; i < b; i++) { const d = segOffM(co[i], co[a], co[b]); if (d > wd) { wd = d; worst = i; } }
      if (worst > 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
    }
    const idx: number[] = [];
    let walked = 0;
    for (let i = 0; i < co.length; i++) {
      if (i > 0) walked += gapM(co[i - 1], co[i]);
      // keep the vertex BEFORE the gap would exceed MAX_GAP_M (original vertices only — never invented points)
      const nextGap = i + 1 < co.length ? walked + gapM(co[i], co[i + 1]) : 0;
      if (keep[i] || nextGap > maxGap) { idx.push(i); walked = 0; }
    }
    return idx;
  };
  let tol = 3, idx = run(tol);
  while (idx.length > MAX_WATCH_PTS && tol < 40) { tol *= 1.6; idx = run(tol); }
  return idx.map(i => co[i]);
}

// A flat, ordered list of segments the watch engine steps through (Stage 2). Mirrors how RunCoachWorkoutModule
// builds the WorkoutKit intervals: warmup → drills → per block reps×(work[,recover]) with NO trailing recover →
// cooldown. dur (s) OR dist (m) → a goal; neither → an OPEN segment advanced by the lap button.
export interface WorkoutSeg { kind: string; dur?: number; dist?: number; toEndM?: number; label: string; zone?: string; pLo?: number; pHi?: number; paceLo?: number; paceHi?: number }
/** Metres the route's work step is SHORT of the route (Geert, 2026-10-03: "route distance −200 m"). */
export const ROUTE_WORK_MARGIN_M = 200;

/**
 * True when the workout is ONE continuous work block (an easy/steady/long run) — the only shape whose work step
 * can be measured by the route's distance. Interval sessions (reps, recoveries, several blocks) stay on time.
 */
export function isContinuousWork(w: WatchWorkout): boolean {
  const bs = w.blocks ?? [];
  if (bs.length !== 1 || Math.max(1, bs[0].repeats || 1) !== 1 || bs[0].restMinutes > 0) return false;
  // easy, long AND tempo (Geert's choice) — but the threshold TEST stays a true 20-minute test
  return !/threshold test/i.test(`${bs[0].label ?? ''} ${w.name ?? ''}`);
}

/**
 * `opts.workDistM`: ROUTE runs only — the continuous work step targets this DISTANCE (route length − 200 m) instead
 * of the prescribed minutes, so the whole route counts as work however long it takes. Time-based otherwise
 * (non-route pushes, track/indoor workouts, Apple Workout) — those never pass it.
 */
export function flattenWorkout(w: WatchWorkout, opts?: { workDistM?: number }): WorkoutSeg[] {
  const segs: WorkoutSeg[] = [];
  const byDistance = !!opts?.workDistM && opts.workDistM > 0 && isContinuousWork(w);
  segs.push(w.warmupMeters > 0 ? { kind: 'warmup', dist: w.warmupMeters, label: 'Warm-up' } : { kind: 'warmup', label: 'Warm-up' });
  if (w.drillsMinutes > 0) segs.push({ kind: 'drills', dur: w.drillsMinutes * 60, label: 'Drills' });
  for (const b of w.blocks ?? []) {
    const reps = Math.max(1, b.repeats || 1);
    // Route run: the watch ends the work step when the ROUTE's remaining distance drops to 200 m (toEndM) — exact
    // whatever the warm-up/drills already covered. `dist` (route − 200 m) is only a backstop for a watch without GPS
    // or an older watch build that ignores toEndM.
    const goal = byDistance ? { dist: Math.round(opts!.workDistM!), toEndM: ROUTE_WORK_MARGIN_M } : b.workMinutes > 0 ? { dur: b.workMinutes * 60 } : {};
    const work = (): WorkoutSeg => ({ kind: 'work', ...goal, label: b.label || 'Work', zone: b.hrZone,
      ...(b.powerLowWatts && b.powerHighWatts ? { pLo: b.powerLowWatts, pHi: b.powerHighWatts } : {}),         // watch reports under/over power (outdoor)
      ...(b.paceLoSec && b.paceHiSec ? { paceLo: b.paceLoSec, paceHi: b.paceHiSec } : {}) });                 // …or under/over pace (indoor/treadmill)
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
  const pts = simplifyForWatch(co).map(([lon, lat]) => ({ lat: r5(lat), lon: r5(lon) }));   // ≤450 pts, true shape
  // Turn points carry their own lat/lon (from the FULL-res geometry), so downsampling `pts` doesn't shift them.
  // backstop for routes saved before the via-point fix: an "Arrive" cue that isn't at the END is a via point
  const left: number[] = new Array(co.length).fill(0);
  for (let i = co.length - 2; i >= 0; i--) left[i] = left[i + 1] + gapM(co[i], co[i + 1]);
  const turns = (loop.steps ?? [])
    .filter(st => st.type !== 10 || (left[Math.min(st.i, co.length - 1)] ?? 0) <= 150)
    .map(st => { const c = co[st.i]; return c ? { lat: r5(c[1]), lon: r5(c[0]), text: st.text.slice(0, 90), dist: st.dist } : null; })
    .filter((t): t is { lat: number; lon: number; text: string; dist: number } => t != null);
  const payload = {
    type: 'route', name, distanceKm: Math.round(loop.distanceKm * 10) / 10, pts, turns,
    voice: await getVoiceNav(), sport,
    // ROUTE run: a continuous work step targets the ROUTE's distance (−200 m) instead of minutes — the real
    // distance counts as work whatever the pace. Cool-down stays open. (Too-short/stub routes keep the time goal.)
    workout: workout ? flattenWorkout(workout, loop.distanceKm >= 1 ? { workDistM: loop.distanceKm * 1000 - ROUTE_WORK_MARGIN_M } : undefined) : [],
    hrZones: await hrZonesForWatch(),                         // Z1–Z5 bpm bands → on-wrist live zone (Apple-unified on iOS 27)
  };
  // Sending a route = the user is about to run → start the keep-alive NOW (foreground, so WhenInUse suffices)
  // and it continues in the background, keeping the phone reachable to speak cues on the earbuds.
  startRunKeepAlive().catch(() => {});
  saveActiveRoute(loop, name).catch(() => {});   // persist so Wayfinder can back up the run if reopened
  try { return await WatchSync.sync(JSON.stringify(payload)); } catch { return false; }
}

/**
 * Send a structured workout to OUR RunCoach watch app WITHOUT a route — for track intervals, which need no map
 * guidance. Same channel as a route, just empty pts/turns, so the watch shows Start + the interval engine (with
 * the spoken 3-2-1 countdown) and simply skips the map/off-route tracking. Use this for interval sessions the
 * runner does on a track; the Apple-Workout push (pushWorkoutToWatch) stays for the visual-countdown path.
 */
export async function sendWorkoutToWatch(workout: WatchWorkout, name = 'Intervals', sport: 'running' | 'walking' = 'running', indoor = false): Promise<boolean> {
  if (!WatchSync) return false;
  const payload = {
    type: 'route', name, distanceKm: 0, pts: [], turns: [],
    voice: await getVoiceNav(), sport, indoor,   // indoor → watch records .indoor (no GPS) + speaks PACE cues
    workout: flattenWorkout(workout),
    hrZones: await hrZonesForWatch(),               // Z1–Z5 bpm bands → on-wrist live zone (Apple-unified on iOS 27)
  };
  startRunKeepAlive().catch(() => {});   // about to run → keep the phone reachable to speak cues on the earbuds
  try { return await WatchSync.sync(JSON.stringify(payload)); } catch { return false; }
}
