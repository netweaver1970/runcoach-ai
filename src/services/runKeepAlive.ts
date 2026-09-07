/**
 * Run keep-alive. During a run, keep the PHONE app alive via a background-location task so it stays
 * WatchConnectivity-reachable and can speak the watch's coaching cues on the phone's earbuds even with the
 * screen off / phone pocketed (see runcoach-watchsync + RouteView SpeechCue). The task handler is a NO-OP —
 * the only purpose is to keep the process running; we don't consume the fixes.
 *
 * Lifecycle:
 *   • started when a route is sent to the watch (foreground → WhenInUse is enough) AND when the watch signals
 *     a run start (a background wake via WCSession transferUserInfo — needs the Always grant to start there);
 *   • stopped on the watch's run-end signal, or a safety timeout so a forgotten session can't drain the battery.
 *
 * Imported for side effects from app/_layout so defineTask + the run-state listener register at launch.
 */
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as FileSystem from 'expo-file-system';
import { requireNativeModule } from 'expo-modules-core';
import { setRunActive } from './activeRoute';
import { logRunBattery } from './runBatteryLog';
import { logRunSegments } from './runSegmentsLog';

const TASK = 'runcoach-run-keepalive';
const MAX_MS = 3 * 3600 * 1000;   // hard stop after 3h if no run-end ever arrives

// Temporary diagnostic (2026-09-07): the phone suspended ~13 s into a watch-started run and cues went silent —
// prime confirmed but no cues after. Log keep-alive start/permission/stop to a pullable file so the next run
// tells us whether the background-location task actually kept the phone alive. Pull via devicectl appDataContainer
// Documents/runcoach-keepalive-log.txt. Remove once the keep-alive is confirmed reliable.
const KLOG = (FileSystem.documentDirectory ?? '') + 'runcoach-keepalive-log.txt';
async function klog(line: string): Promise<void> {
  try {
    let prev = '';
    try { prev = await FileSystem.readAsStringAsync(KLOG); } catch {}
    const lines = (prev ? prev.split('\n') : []).concat(`${new Date().toISOString()} ${line}`).slice(-60);
    await FileSystem.writeAsStringAsync(KLOG, lines.join('\n'));
  } catch { /* best-effort */ }
}

// Registered at module load so iOS can resolve it on a background relaunch (a no-op body is intentional).
try { TaskManager.defineTask(TASK, async () => { /* keep-alive only — nothing to consume */ }); } catch { /* already defined */ }

let stopTimer: ReturnType<typeof setTimeout> | null = null;

export async function startRunKeepAlive(): Promise<void> {
  try {
    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') { void klog(`start ABORT fg=${fg.status} (no location → phone will suspend, watch speaks)`); return; }
    // Always lets the watch's run-start also kick this off from a background wake; ignore if the user declines
    // (the foreground send-to-watch path still works).
    const bg = await Location.requestBackgroundPermissionsAsync().catch(() => ({ status: 'error' } as any));
    const already = await TaskManager.isTaskRegisteredAsync(TASK);
    if (!already) {
      await Location.startLocationUpdatesAsync(TASK, {
        accuracy: Location.Accuracy.Balanced,
        distanceInterval: 15,
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true,
        activityType: Location.ActivityType.Fitness,
      });
    }
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = setTimeout(() => { void stopRunKeepAlive(); }, MAX_MS);
    void klog(`start OK fg=${fg.status} bg=${bg?.status} taskWasRegistered=${already} → location updates running`);
  } catch (e: any) { void klog(`start FAILED ${String(e?.message ?? e)}`); /* voice falls back to the watch */ }
}

export async function stopRunKeepAlive(): Promise<void> {
  try {
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
    if (await TaskManager.isTaskRegisteredAsync(TASK)) await Location.stopLocationUpdatesAsync(TASK);
    void klog('stop → location updates stopped');
  } catch { /* ignore */ }
}

// Start/stop on the watch's run-state signals (emitted by the runcoach-watchsync native module).
try {
  const sync: any = requireNativeModule('RunCoachWatchSync');
  sync?.addListener?.('onRunState', (e: { state?: string }) => {
    if (e?.state === 'start') void startRunKeepAlive();
    else if (e?.state === 'end') { void stopRunKeepAlive(); void setRunActive(false); }   // run over → Wayfinder stops backing it up
  });
  // Watch battery profiling for the finished run → append to the local log (surfaced in the debug export).
  sync?.addListener?.('onRunBattery', (e: any) => {
    if (e && typeof e.perHr === 'number') {
      void logRunBattery({
        device: String(e.device ?? 'watch'),
        perHr: e.perHr, drainPct: Number(e.drainPct ?? 0), durMin: Number(e.durMin ?? 0),
        startPct: Number(e.startPct ?? 0), endPct: Number(e.endPct ?? 0),
      });
    }
  });
  // Executed run structure → store the phase boundaries so the phone can rebuild the run's bands/segments.
  sync?.addListener?.('onRunSegments', (e: any) => {
    if (e && typeof e.execStart === 'number' && Array.isArray(e.execSegs) && e.execSegs.length) {
      void logRunSegments({
        start: e.execStart, dur: Number(e.execDur ?? 0),
        segs: e.execSegs.map((s: any) => ({
          label: String(s.label ?? ''), kind: String(s.kind ?? ''), zone: String(s.zone ?? ''),
          startSec: Number(s.startSec ?? 0), endSec: Number(s.endSec ?? 0),
        })),
      });
    }
  });
} catch { /* module not in this build */ }
