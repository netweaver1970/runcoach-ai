/**
 * Historic "time travel". The home screen can show any past day's wellness by
 * reconstructing the rich DailyRecovery / DayStrain / training-load objects from the
 * per-day components we already compute (fetchOurDailyComponents). Today always uses
 * the live snapshot (intra-day, full fidelity); past days come from the cached
 * components so we don't re-run the whole snapshot per swipe.
 */
import { HealthSnapshot, DailyRecovery, DayStrain, DailyLoad, SleepSession } from '../types';
import { scoreToLabel, scoreToColor } from './healthkit';
import { advisableStrainRange, trainingDayKey } from './trainingLoad';

export interface DayView {
  date:    string;            // YYYY-MM-DD
  isToday: boolean;
  hasData: boolean;
  recovery: DailyRecovery | null;
  strain:   DayStrain | null;
  trainingLoad: DailyLoad[];
}

export function toDateKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

type Comp = Record<string, number>;

// Anchor a clock-minute value (minutes since local midnight) to a date → ISO string.
function clockToISO(clockMin: number, base: Date): string {
  const d = new Date(base); d.setHours(0, 0, 0, 0); d.setMinutes(clockMin);
  return d.toISOString();
}

/** Reconstruct a SleepSession from a day's components (awake time isn't stored → 0). */
function sleepFromComp(dateKey: string, viewDate: Date, c: Comp): SleepSession | null {
  if (c.timeAsleep == null) return null;
  const total = c.timeAsleep;
  const deep  = c.deepSleep ?? 0;
  const rem   = c.remSleep ?? 0;
  const core  = Math.max(0, total - deep - rem);
  const wake  = c.wakeTime != null ? clockToISO(c.wakeTime, viewDate) : '';
  // Bedtime ≥ noon → previous evening; < noon → early-morning of the view day.
  const bed = c.sleepTime != null
    ? clockToISO(c.sleepTime, c.sleepTime >= 720 ? new Date(viewDate.getTime() - 86_400_000) : viewDate)
    : '';
  return {
    date: dateKey,
    bedtime: bed || wake,
    wakeTime: wake || bed,
    totalMinutes: total, deepMinutes: deep, remMinutes: rem, coreMinutes: core,
    awakeMinutes: 0, segments: [],
  };
}

function recoveryFromComp(date: string, viewDate: Date, c: Comp): DailyRecovery {
  const score = Math.round(c.recoveryScore ?? 0);
  return {
    date,
    weightedRMSSD:       c.restingHrv ?? 0,
    overnightHR:         c.restingHr ?? 0,
    overnightHRBaseline: 0,
    recoveryScore:       score,
    sleepScore:          Math.round(c.sleepScore ?? 0),
    baseline7Day:        0,
    trend:               'stable',
    sleep:               sleepFromComp(date, viewDate, c),
    label:               scoreToLabel(score),
    color:               scoreToColor(score),
  };
}

function strainFromComp(c: Comp): DayStrain {
  const range = advisableStrainRange({
    recovery:     c.recoveryScore,
    sleepScore:   c.sleepScore,
    sleepDebtMin: c.sleepBank,
    tsb:          c.tsb,
    ctl:          c.ctl,
    atl:          c.cardioLoad,
  });
  return {
    real:     Math.round(c.strainScore ?? 0),
    safeLow:  range.safeLow,
    safeHigh: range.safeHigh,
    safeMid:  range.safeMid,
    readiness: range.readiness,
    drivers:   range.drivers,
    acwr:      range.acwr,
    trimp: 0, cardio: 0, muscular: 0,
  };
}

/** Build the load series (CTL/ATL/TSB) up to and including `dateKey` from components. */
function loadSeriesUpTo(dateKey: string, comps: Record<string, Comp>): DailyLoad[] {
  return Object.keys(comps)
    .filter(d => d <= dateKey && comps[d].ctl != null)
    .sort()
    .map(d => ({ date: d, load: 0, atl: comps[d].cardioLoad ?? 0, ctl: comps[d].ctl ?? 0, tsb: comps[d].tsb ?? 0 }));
}

export function buildDayView(
  viewDate: Date,
  snapshot: HealthSnapshot | null,
  comps: Record<string, Comp>,
): DayView {
  const key = toDateKey(viewDate);
  const isToday = key === toDateKey(new Date());

  if (isToday && snapshot) {
    // STALE-CACHE GUARD. The home renders the cached snapshot INSTANTLY on launch and refreshes in the
    // background, but the cache may have been written on a PREVIOUS training day — and its day-scoped
    // values (today's accumulated strain, and the recovery/sleep computed from "last night") then describe
    // YESTERDAY. Presenting them under today's date is simply wrong: at 05:22 the ring read strain 37,
    // impossible ~80 min into a new day. Show "no data yet" until the refresh lands rather than a
    // confident lie. Uses the same 4am trainingDayKey boundary strain is attributed by, so a pre-4am
    // launch still sees the still-accumulating day rather than being blanked.
    // trainingLoad is NOT suppressed: CTL/ATL/TSB are multi-day EWMAs carrying their own dates, so
    // "as of yesterday" is a fair reading of a trailing average, not a false statement about today.
    const fetchedAt = (snapshot as { fetchedAt?: string }).fetchedAt;
    const staleDay = fetchedAt != null
      && trainingDayKey(new Date(fetchedAt).getTime()) !== trainingDayKey(Date.now());
    if (staleDay) {
      return {
        date: key, isToday: true, hasData: false,
        recovery: null, strain: null,
        trainingLoad: snapshot.trainingLoad ?? [],
      };
    }
    return {
      date: key, isToday: true,
      hasData: !!(snapshot.todayRecovery || snapshot.strain),
      recovery: snapshot.todayRecovery ?? null,
      strain:   snapshot.strain ?? null,
      trainingLoad: snapshot.trainingLoad ?? [],
    };
  }

  const c = comps[key];
  if (!c) {
    return { date: key, isToday, hasData: false, recovery: null, strain: null, trainingLoad: loadSeriesUpTo(key, comps) };
  }
  return {
    date: key, isToday, hasData: true,
    recovery: c.recoveryScore != null ? recoveryFromComp(key, viewDate, c) : null,
    strain:   c.strainScore  != null ? strainFromComp(c) : null,
    trainingLoad: loadSeriesUpTo(key, comps),
  };
}
