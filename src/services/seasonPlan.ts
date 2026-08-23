/**
 * Season / block plan — the goal-anchored multi-week training plan the app was missing vs TrainingPeaks.
 *
 * Given the athlete's real load history + a target race (date/distance/goal), it lays out EVERY week from
 * now to the race as a periodized block — Base → Build → Peak → Taper → Race — with a weekly LOAD TARGET
 * that ramps CTL toward a peak (respecting the app's per-week ramp cap and build/deload periodization),
 * then tapers to shed fatigue and land a fresh race-day form. It then projects CTL/ATL/TSB forward across
 * the whole block with the SAME EWMA engine as the live Training Load screen (`computeTrainingLoadSeries`),
 * so the forward PMC and the race-day form readout are consistent with everything else in the app.
 *
 * This is the MACRO view; the deterministic 7-Day Plan remains the near-term execution of the current week.
 */
import type { DailyLoad } from '../types';
import { computeTrainingLoadSeries } from './trainingLoad';
import type { RaceConfig } from './racePlan';
import type { Periodization } from './coach';

export type Phase = 'Base' | 'Build' | 'Peak' | 'Taper' | 'Race';
export const PHASE_COLOR: Record<Phase, string> = {
  Base: '#2f6fed', Build: '#27ae60', Peak: '#e67e22', Taper: '#8e44ad', Race: '#e74c3c',
};

export interface SeasonWeek {
  monday: string;        // YYYY-MM-DD (week start)
  weeksToRace: number;   // 0 = race week
  phase: Phase;
  loadTarget: number;    // weekly training-load target (same TRIMP-based units as CTL/ATL)
  deload: boolean;
  ctl: number; atl: number; tsb: number;   // PROJECTED at week end
}

export interface SeasonPlan {
  weeks: SeasonWeek[];
  series: DailyLoad[];   // daily projected CTL/ATL/TSB, today → race (the forward PMC)
  startCtl: number;
  peakCtl: number;       // highest projected CTL across the block
  race: { date: string; km: number; ctl: number; atl: number; tsb: number };
  note: string;
}

const DAY = 86_400_000;
const p2 = (n: number) => String(n).padStart(2, '0');
const dstr = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const at0 = (iso: string) => new Date(iso + 'T00:00:00');
const mondayOf = (d: Date) => { const x = new Date(d); const dow = (x.getDay() + 6) % 7; x.setDate(x.getDate() - dow); x.setHours(0, 0, 0, 0); return x; };

/** CTL/ATL/TSB on/nearest-before a date in a projected series. */
function onDate(series: DailyLoad[], iso: string): { ctl: number; atl: number; tsb: number } {
  let v = { ctl: 0, atl: 0, tsb: 0 };
  for (const d of series) { if (d.date <= iso) v = { ctl: d.ctl, atl: d.atl, tsb: d.tsb }; else break; }
  return v;
}

export function buildSeasonPlan(
  hist: DailyLoad[],
  race: RaceConfig,
  opts: { capPct: number; periodization: Periodization },
): SeasonPlan | null {
  if (!hist.length || !race.date) return null;
  const today = at0(hist[hist.length - 1].date);   // anchor the projection to the real data's last day
  const raceDate = at0(race.date);
  if (raceDate.getTime() <= today.getTime()) return null;

  const ctl0 = hist[hist.length - 1].ctl;
  const last7 = hist.slice(-7).reduce((a, d) => a + d.load, 0);
  const startLoad = Math.max(Math.round(last7), Math.round(ctl0 * 7), 1);   // don't start below current

  const wkMon0 = mondayOf(today);
  const raceMon = mondayOf(raceDate);
  const W = Math.max(0, Math.round((raceMon.getTime() - wkMon0.getTime()) / (7 * DAY)));

  const rampPct   = Math.min(0.10, Math.max(0.04, opts.capPct / 100));   // safe multi-week weekly ramp
  const taperWeeks = W >= 4 ? 2 : (W >= 2 ? 1 : 0);
  const peakWeeks  = W >= 8 ? 2 : (W >= 5 ? 1 : 0);
  const baseWeeks  = W >= 12 ? Math.max(1, Math.floor((W - taperWeeks - peakWeeks) / 3)) : 0;
  const per = opts.periodization;

  // 1) Phase + weekly load target per week (chronological, ramp compounding through Base/Build).
  type W0 = { monday: string; weeksToRace: number; phase: Phase; loadTarget: number; deload: boolean };
  const raw: W0[] = [];
  let rampLevel = startLoad;   // the "if we kept building" level; deloads dip from it without resetting it
  let sinceDeload = 0;
  for (let i = 0; i <= W; i++) {
    const mon = new Date(wkMon0); mon.setDate(mon.getDate() + 7 * i);
    const weeksLeft = W - i;
    let phase: Phase;
    if (weeksLeft === 0) phase = 'Race';
    else if (weeksLeft <= taperWeeks) phase = 'Taper';
    else if (weeksLeft <= taperWeeks + peakWeeks) phase = 'Peak';
    else if (weeksLeft > W - baseWeeks) phase = 'Base';
    else phase = 'Build';

    let loadTarget = rampLevel;
    let deload = false;
    if (phase === 'Base' || phase === 'Build') {
      if (per?.on && sinceDeload >= per.buildWeeks) {          // scheduled recovery week
        loadTarget = Math.round(rampLevel * (1 - per.deloadDropPct / 100));
        deload = true; sinceDeload = 0;
      } else {
        const r = phase === 'Base' ? rampPct * 0.7 : rampPct;  // base ramps gentler (aerobic foundation)
        rampLevel = Math.round(rampLevel * (1 + r));
        loadTarget = rampLevel; sinceDeload++;
      }
    } else if (phase === 'Peak') {
      loadTarget = rampLevel;                                   // hold the peak
    } else if (phase === 'Taper') {
      loadTarget = weeksLeft >= 2 ? Math.round(rampLevel * 0.60) : Math.round(rampLevel * 0.42);
    } else {                                                    // Race week — minimal legs-fresh load
      loadTarget = Math.round(rampLevel * 0.32);
    }
    raw.push({ monday: dstr(mon), weeksToRace: weeksLeft, phase, loadTarget, deload });
  }

  // 2) Spread each week's load across its 7 days (even split — the weekly TOTAL drives the EWMA), keeping
  //    real history for days up to today, and project the forward PMC with the live load engine.
  const loadByDay = new Map<string, number>(hist.map(d => [d.date, d.load]));
  for (const w of raw) {
    const daily = Math.round(w.loadTarget / 7);
    for (let j = 0; j < 7; j++) {
      const day = new Date(at0(w.monday)); day.setDate(day.getDate() + j);
      if (day.getTime() <= today.getTime()) continue;          // don't overwrite real history / today
      if (day.getTime() > raceDate.getTime()) break;
      loadByDay.set(dstr(day), daily);
    }
  }
  const series = computeTrainingLoadSeries(loadByDay, today, raceDate);

  // 3) Attach projected week-end fitness/form + summary.
  const weeks: SeasonWeek[] = raw.map(w => {
    const sun = new Date(at0(w.monday)); sun.setDate(sun.getDate() + 6);
    const end = sun.getTime() > raceDate.getTime() ? race.date : dstr(sun);
    const v = onDate(series, end);
    return { ...w, ctl: Math.round(v.ctl), atl: Math.round(v.atl), tsb: Math.round(v.tsb) };
  });

  const startCtl = series.length ? series[0].ctl : ctl0;   // series-anchored so the card's deltas match its own chart
  const peakCtl = series.reduce((m, d) => Math.max(m, d.ctl), 0);
  const rd = onDate(series, race.date);
  const raceForm = rd.tsb;
  const formWord = raceForm < 0 ? 'still carrying fatigue — consider a longer taper'
    : raceForm <= 5 ? 'lightly rested'
    : raceForm <= 22 ? 'well tapered'
    : 'very fresh (possibly over-tapered)';
  const gain = Math.round(peakCtl - startCtl);
  let note = `Projected peak fitness CTL ${Math.round(peakCtl)} (${gain >= 0 ? '+' : ''}${gain} vs now) · race-day form TSB ${raceForm >= 0 ? '+' : ''}${Math.round(raceForm)} — ${formWord}.`;
  if (W < 3) note = `Short runway (${W} full week${W === 1 ? '' : 's'}) — little time to build; the block focuses on arriving fresh. ` + note;

  return {
    weeks, series, startCtl: Math.round(startCtl), peakCtl: Math.round(peakCtl),
    race: { date: race.date, km: race.distanceKm, ctl: Math.round(rd.ctl), atl: Math.round(rd.atl), tsb: Math.round(rd.tsb) },
    note,
  };
}

/** "10K" / "half marathon" / "marathon" / "N km". */
export function raceLabel(km: number): string {
  if (Math.abs(km - 42.2) < 0.6) return 'Marathon';
  if (Math.abs(km - 21.1) < 0.4) return 'Half marathon';
  if (Math.abs(km - 10) < 0.3) return '10K';
  if (Math.abs(km - 5) < 0.3) return '5K';
  return `${km} km`;
}
