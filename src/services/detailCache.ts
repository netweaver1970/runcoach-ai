/**
 * Disk-backed TTL cache for the KPI-detail screens' heavy HealthKit history fetches. Navigating between the
 * Strain/Recovery/Sleep tabs (and day-by-day) remounts screens; without this each mount re-queried ~3 months
 * of HealthKit data, which was very slow. Results are memoised in RAM AND persisted to a JSON file, so:
 *   • repeat navigation within a session is instant,
 *   • the cache survives app restarts (first open after launch is instant too), and
 *   • warmDetailCache() (called from the home screen after a scan) pre-populates it in the background.
 * The per-day values are computed once here and never recomputed while fresh.
 */
import * as FileSystem from 'expo-file-system';
import {
  fetchSleepHistory, fetchOvernightHRHistory, fetchStrainHistory,
  fetchOurDailyComponents, fetchDailyDurationHistory,
} from './healthkit';

// cacheDirectory: NOT included in iCloud/device backups and purgeable by iOS — months of health history
// shouldn't ride along in every backup just to warm a 30-min cache.
const FILE = FileSystem.cacheDirectory + 'runcoach-detail-cache.json';
const DEFAULT_TTL = 30 * 60_000; // 30 min — a home scan / pull-to-refresh warms fresher data over the top

const mem = new Map<string, { at: number; val: unknown }>();
let loadPromise: Promise<void> | null = null;

function ensureLoaded(): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const txt = await FileSystem.readAsStringAsync(FILE);
        const obj = JSON.parse(txt) as Record<string, { at: number; val: unknown }>;
        for (const k in obj) mem.set(k, obj[k]);
      } catch { /* no cache file yet */ }
    })();
  }
  return loadPromise;
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(async () => {
    writeTimer = null;
    try {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of mem) obj[k] = v;
      await FileSystem.writeAsStringAsync(FILE, JSON.stringify(obj));
    } catch { /* ignore */ }
  }, 400);
}

export async function cached<T>(key: string, fn: () => Promise<T>, ttlMs = DEFAULT_TTL): Promise<T> {
  await ensureLoaded();
  const hit = mem.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.val as T;
  const val = await fn();
  mem.set(key, { at: Date.now(), val });
  schedulePersist();
  return val;
}

export function clearDetailCache(): void {
  mem.clear();
  FileSystem.deleteAsync(FILE, { idempotent: true }).catch(() => {});
}

/**
 * Pre-warm every key the detail screens use, in the background. Uses `cached()` so it only actually queries
 * HealthKit for keys that are stale — a no-op when the disk cache is still fresh. Call fire-and-forget from
 * the home screen after its snapshot loads, so tapping into a KPI is instant.
 */
export async function warmDetailCache(): Promise<void> {
  await Promise.allSettled([
    cached('sleep:3',   () => fetchSleepHistory(3)),
    cached('dip:3',     () => fetchOvernightHRHistory(3)),
    cached('strain:3',  () => fetchStrainHistory(3)),
    cached('comps:3',   () => fetchOurDailyComponents(3)),
    cached('comps:0.3', () => fetchOurDailyComponents(0.3)),
    cached('dur',       () => fetchDailyDurationHistory()),
  ]);
}
