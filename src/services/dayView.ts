/**
 * Historic "time travel". The home screen can show any past day's wellness by
 * reconstructing the rich DailyRecovery / DayStrain / training-load objects from the
 * per-day components we already compute (fetchOurDailyComponents). Today always uses
 * the live snapshot (intra-day, full fidelity); past days come from the cached
 * components so we don't re-run the whole snapshot per swipe.
 */
import { HealthSnapshot, DailyRecovery, DayStrain, DailyLoad } from '../types';
import { scoreToLabel, scoreToColor } from './healthkit';
import { advisableStrainRange } from './trainingLoad';

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

function recoveryFromComp(date: string, c: Comp): DailyRecovery {
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
    sleep:               null,
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
    recovery: c.recoveryScore != null ? recoveryFromComp(key, c) : null,
    strain:   c.strainScore  != null ? strainFromComp(c) : null,
    trainingLoad: loadSeriesUpTo(key, comps),
  };
}
