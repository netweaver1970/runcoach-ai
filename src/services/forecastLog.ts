/**
 * Forecast-accuracy log — captures the 7-day plan's PROJECTED per-day TSB/load against what
 * ACTUALLY materialised, so the projection (estimateDayTrimp) can be calibrated: the coach trims
 * sessions to hold projected TSB ≥ the −10 floor, but realised TSB comes in far shallower (~−4),
 * i.e. the forecast over-projects fatigue. Pairing predicted vs realised quantifies that bias.
 *
 * Prediction-centric + disk-backed (documentDirectory, survives restarts, tiny). recordForecast
 * writes the projection for each FUTURE date (freshest/shortest-horizon wins); recordActuals fills
 * the realised side only for dates we predicted. Everything is fail-safe — never throws into a scan
 * or the plan UI.
 */
import * as FileSystem from 'expo-file-system';

const FILE = `${FileSystem.documentDirectory}forecast-accuracy.json`;
const PRUNE_DAYS = 120;

export interface ForecastPoint {
  date: string;            // target date, YYYY-MM-DD (local)
  madeOn?: string;         // date the prediction was generated
  horizon?: number;        // days ahead at prediction time (1 = next day)
  projTSB?: number; projLoad?: number; projCTL?: number; projATL?: number;
  projIntensity?: string; projMinutes?: number;
  actTSB?: number; actLoad?: number; actCTL?: number; actATL?: number;
}
type Log = Record<string, ForecastPoint>;

const dayDiff = (a: string, b: string): number =>
  Math.round((new Date(b + 'T00:00:00').getTime() - new Date(a + 'T00:00:00').getTime()) / 86_400_000);

async function read(): Promise<Log> {
  try { return JSON.parse(await FileSystem.readAsStringAsync(FILE)) || {}; }
  catch { return {}; }
}
async function write(log: Log): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - PRUNE_DAYS * 86_400_000).toISOString().slice(0, 10);
    for (const k of Object.keys(log)) if (k < cutoff) delete log[k];
    await FileSystem.writeAsStringAsync(FILE, JSON.stringify(log));
  } catch { /* disk full / sandbox — drop silently */ }
}

// ── Serialized read-modify-write ─────────────────────────────────────────────
// EVERY mutation funnels through ONE promise chain. The 7-day plan fires recordForecast and
// recordActuals without awaiting either, and the home scan fires recordActuals again — each used
// to run its own read→mutate→write, so both read the SAME stale log before either wrote and the
// later write silently dropped the other's changes. Classic lost update.
//
// It froze this log at its very first capture (2026-07-08, 7 points, nothing for the two weeks
// after): once the file had entries, recordActuals always found a date to fill, so it always wrote,
// so it always clobbered the predictions recordForecast had just made. The first capture survived
// ONLY because an empty log left `touched` false and recordActuals skipped its write entirely —
// which is exactly why the breakage looked like "it worked once, then stopped".
//
// Serializing here (not at the call site) keeps any future caller safe too. Errors are swallowed
// per-op and the chain is never left rejected, so one bad write can't wedge the queue.
let chain: Promise<void> = Promise.resolve();
function mutate(apply: (log: Log) => boolean): Promise<void> {
  const next = chain.then(async () => {
    try {
      const log = await read();
      if (apply(log)) await write(log);
    } catch { /* never break a scan or the plan build */ }
  });
  chain = next.catch(() => {});
  return next;
}

/** Record the plan's projected trajectory. Only future days; freshest (shortest-horizon) wins. */
export function recordForecast(
  rows: { date: string; intensity: string; adjMin: number; trimp: number; ctl: number; atl: number; tsb: number }[],
  madeOn: string,
): Promise<void> {
  return mutate((log) => {
    let touched = false;
    for (const r of rows) {
      if (!r?.date || r.date <= madeOn) continue;                 // only genuine future days
      const prev = log[r.date];
      if (prev?.madeOn && prev.madeOn > madeOn) continue;         // keep the fresher existing prediction
      log[r.date] = {
        ...(prev ?? { date: r.date }),
        date: r.date, madeOn, horizon: dayDiff(madeOn, r.date),
        projTSB: r.tsb, projLoad: Math.round(r.trimp), projCTL: r.ctl, projATL: r.atl,
        projIntensity: r.intensity, projMinutes: r.adjMin,
      };
      touched = true;
    }
    return touched;
  });
}

/** Fill the realised side, but only for dates we actually predicted (keeps the log paired + small). */
export function recordActuals(
  series: { date: string; ctl: number; atl: number; tsb: number; load: number }[],
): Promise<void> {
  return mutate((log) => {
    let touched = false;
    for (const d of series) {
      const prev = log[d?.date];
      if (!prev) continue;
      log[d.date] = { ...prev, actTSB: d.tsb, actCTL: d.ctl, actATL: d.atl, actLoad: Math.round(d.load) };
      touched = true;
    }
    return touched;
  });
}

/** Paired points (both projected and realised present), oldest first — for the calibration dump. Excludes
 *  the current (still-elapsing) day: its "actual" is only the partial day-so-far, so pairing it against a
 *  full-day projection reads as a huge spurious miss (e.g. projLoad 12 vs actLoad 1 at 07:00). */
export async function getForecastPairs(): Promise<ForecastPoint[]> {
  try {
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return Object.values(await read())
      .filter((p) => p.projTSB != null && p.actTSB != null && p.date < todayKey)
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch { return []; }
}
