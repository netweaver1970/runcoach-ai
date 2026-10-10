// Durable run history for the Statistics screen.
//
// The normal HealthSnapshot only keeps ~3 months of runs (a deliberate startup-speed cap), and every
// app launch's light refresh OVERWRITES it back to that window. So the efficiency/decoupling/intensity
// charts kept "reverting" to ~3 months after a deep-load. This cache is the union of every run the stats
// screen has ever seen, persisted separately so a startup scan can't shrink it. The screen merges fresh
// snapshot runs over this cache (snapshot wins per-uuid → picks up re-processed work stats), then writes
// the union back, so history only ever grows.
import * as FileSystem from 'expo-file-system';
import type { RunWorkout } from '../types';

const FILE = `${FileSystem.documentDirectory}stats-runs-cache.json`;

export async function loadStatsRuns(): Promise<RunWorkout[]> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (!info.exists) return [];
    const v = JSON.parse(await FileSystem.readAsStringAsync(FILE));
    return Array.isArray(v) ? applyTempBackfill(v, await loadTempBackfill()) : [];
  } catch { return []; }
}

// ── Temperature backfill ──────────────────────────────────────────────────────────────────────────────
// Runs before ~Oct 2025 carry no weather temperature (Geert 2026-10-10: "can you not backfill temps? They were all
// run in Merelbeke"). Fill tempC from the Open-Meteo HISTORICAL archive (free, no key) at Merelbeke for the run's
// mid-point hour, so hot runs get their 🟠 flag and the heat-aware charts / SE filters work across the full history.
// Results persist per uuid; a run's own (watch / manual) temperature always wins.
const TEMP_FILE = `${FileSystem.documentDirectory}runcoach-temp-backfill.json`;
const HOME = { lat: 50.994, lon: 3.745 };   // Merelbeke
const ARCHIVE_LAG_MS = 6 * 86_400_000;      // the archive trails real time by ~5 days

export async function loadTempBackfill(): Promise<Record<string, number>> {
  try {
    const info = await FileSystem.getInfoAsync(TEMP_FILE);
    if (!info.exists) return {};
    const v = JSON.parse(await FileSystem.readAsStringAsync(TEMP_FILE));
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

/** Runs with no temperature of their own get the backfilled one (estimate: Merelbeke, mid-run hour). */
export function applyTempBackfill(runs: RunWorkout[], map: Record<string, number>): RunWorkout[] {
  return (runs ?? []).map(r => (r.tempC == null && r.uuid && map[r.uuid] != null ? { ...r, tempC: map[r.uuid] } : r));
}

/** Fetch archive temperatures for every run still missing one (one request over the span). Returns how many were
 *  filled; 0 when nothing was missing or the network failed (retried on the next Statistics build). */
export async function backfillTemps(runs: RunWorkout[]): Promise<number> {
  const map = await loadTempBackfill();
  const now = Date.now();
  const todo = (runs ?? []).filter(r => r.tempC == null && r.uuid && map[r.uuid] == null && now - new Date(r.date).getTime() > ARCHIVE_LAG_MS);
  if (!todo.length) return 0;
  const mid = (r: RunWorkout) => new Date(r.date).getTime() + ((r.duration ?? 0) * 1000) / 2;
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const ts = todo.map(mid);
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${HOME.lat}&longitude=${HOME.lon}`
    + `&start_date=${day(Math.min(...ts))}&end_date=${day(Math.max(...ts))}&hourly=temperature_2m&timezone=GMT`;
  try {
    const res = await fetch(url);
    if (!res.ok) return 0;
    const j = await res.json();
    const times: string[] = j?.hourly?.time ?? [], temps: (number | null)[] = j?.hourly?.temperature_2m ?? [];
    const byHour = new Map<string, number>();
    times.forEach((t, i) => { if (typeof temps[i] === 'number') byHour.set(t.slice(0, 13), temps[i] as number); });   // 'YYYY-MM-DDTHH'
    let n = 0;
    todo.forEach((r, i) => {
      const t = byHour.get(new Date(Math.round(ts[i] / 3_600_000) * 3_600_000).toISOString().slice(0, 13));
      if (t != null) { map[r.uuid!] = Math.round(t * 10) / 10; n++; }
    });
    if (n) await FileSystem.writeAsStringAsync(TEMP_FILE, JSON.stringify(map)).catch(() => {});
    return n;
  } catch { return 0; }
}

export async function saveStatsRuns(runs: RunWorkout[]): Promise<void> {
  try { await FileSystem.writeAsStringAsync(FILE, JSON.stringify(runs ?? [])); } catch { /* best-effort */ }
}

/** Merge fresh snapshot runs over the persisted history: snapshot wins per uuid (freshest work stats),
 *  older cached runs beyond the snapshot window are kept. Result is newest-first. */
export function mergeRuns(snapRuns: RunWorkout[], cached: RunWorkout[]): RunWorkout[] {
  const seen = new Set((snapRuns ?? []).map(r => r.uuid));
  const merged = [...(snapRuns ?? []), ...(cached ?? []).filter(r => r.uuid && !seen.has(r.uuid))];
  return merged.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}
