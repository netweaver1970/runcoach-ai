/**
 * Daily Coach → Wayfinder handoff of the EXACT session a route is being planned for (including the runner's
 * ± edits). Wayfinder used to re-derive "today's workout" from the cached plan on its own, so after "+5 min" /
 * "+1 rep" the route was sized for the NEW session but the watch got the OLD, shorter structure with it — the
 * runner ran most of the longer route in the open-ended cool-down (2026-09-28). In-memory only: it lives exactly
 * as long as the planning flow, and Wayfinder only reads it when opened from the Daily Coach (`wk=1` param).
 */
import type { WatchWorkout } from './coach';

let handed: { wk: WatchWorkout; at: number } | null = null;

export function handOffRouteWorkout(wk: WatchWorkout | null): void {
  handed = wk ? { wk, at: Date.now() } : null;
}

/** The handed-off session, if one was set in the last 3 h (a planning flow, not a stale leftover). */
export function getHandedRouteWorkout(): WatchWorkout | null {
  return handed && Date.now() - handed.at < 3 * 3600_000 ? handed.wk : null;
}
