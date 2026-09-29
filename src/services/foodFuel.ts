/**
 * Fuelling advice (nutrition Option A5, docs/nutrition/REPORT.md §6.4) — deterministic, keyless.
 *
 * ATHLETE PREFERENCE (Geert, 2026-09-29): runs FASTED by default. Carbs are suggested ONLY for
 *   • interval sessions, and
 *   • very long runs (≥ FUEL_LONG_MIN, default 90 min).
 * Easy / recovery / tempo / normal-length runs get NO fuel advice, and there are NO daily carb targets.
 *
 * Numbers follow the ACSM/AND/DC 2016 nutrition-and-athletic-performance position stand
 * (https://pubmed.ncbi.nlm.nih.gov/26891166/): 1–4 g/kg in the 1–4 h before sessions > 60 min (a practical
 * ~1 g/kg 1–2 h before); 30–60 g/h during 1–2.5 h, up to 90 g/h (glucose + fructose) beyond 2.5 h. Recovery is kept
 * modest for this athlete: ~1 g/kg carbs + some protein once after Part 1 of a split run (not ACSM's 1–1.2 g/kg/h
 * rapid-refuel protocol, which targets a HARD session < 8 h later), a normal carb + protein meal after a long run.
 */
import * as SecureStore from 'expo-secure-store';
import type { CoachPlan } from './coach';

export const FUEL_LONG_MIN_KEY = 'fuel_long_min_v1';
export const FUEL_LONG_MIN_DEFAULT = 90;

export async function getFuelLongMin(): Promise<number> {
  try {
    const v = parseInt((await SecureStore.getItemAsync(FUEL_LONG_MIN_KEY)) ?? '', 10);
    return isFinite(v) && v >= 45 && v <= 300 ? v : FUEL_LONG_MIN_DEFAULT;
  } catch { return FUEL_LONG_MIN_DEFAULT; }
}
export async function setFuelLongMin(min: number): Promise<void> {
  await SecureStore.setItemAsync(FUEL_LONG_MIN_KEY, String(Math.round(min)));
}

export interface FuelAdvice {
  kind: 'none' | 'intervals' | 'long';
  title: string;
  lines: string[];
}

const g = (perKg: number, kg?: number) => (kg && kg > 30 ? `≈${Math.round(perKg * kg / 5) * 5} g` : `${perKg} g/kg`);
const range = (lo: number, hi: number, kg?: number) =>
  (kg && kg > 30 ? `≈${Math.round(lo * kg / 5) * 5}–${Math.round(hi * kg / 5) * 5} g` : `${lo}–${hi} g/kg`);

/** Total planned minutes of a plan (both parts of a split long run count as ONE long effort for fuelling). */
export function plannedMinutes(plan: CoachPlan | null): number {
  if (!plan) return 0;
  return (plan.runMinutes ?? 0) + (plan.secondSession?.runMinutes ?? 0);
}

/** Interval session? The coach sets `sessionKind`; external-coach prescriptions don't → infer from the workout. */
export function isIntervalPlan(plan: CoachPlan): boolean {
  if (plan.sessionKind) return plan.sessionKind === 'intervals';
  // hard reps of ≥ 1 min — strides (4×20 s at Z5 on an easy day) are not an interval session
  const hardReps = plan.intensity !== 'easy' && (plan.workout?.blocks ?? []).some(b => (b.repeats ?? 1) > 1 && (b.workMinutes ?? 0) >= 1 && /Z[45]/i.test(b.hrZone ?? ''));
  return hardReps || (plan.intensity === 'hard' && (plan.workout?.blocks ?? []).some(b => (b.repeats ?? 1) > 1));
}

const LONG_TITLE: Record<string, string> = { long: 'Long run', tempo: 'Long tempo', easy: 'Long easy run', recovery: 'Long run' };
const duringLine = (min: number, what = ''): string =>
  min < 60 ? `During${what}: nothing needed (${Math.round(min)} min).`
  : min <= 150 ? `During${what}: 30–60 g/h from ~45 min in — e.g. a gel (~25 g) every 25–40 min, or sports drink.`
  : `During${what}: 60–90 g/h from ~45 min in (mix glucose + fructose — train the gut first); gels or sports drink.`;

/**
 * Advice for ONE day's planned session. Returns kind 'none' (and no lines) for everything the athlete wants
 * to run fasted — the UI shows nothing then. The rule is exactly the one in `fuelPreferenceLine`:
 * intervals, or a planned total ≥ longMin (any kind) → advice; everything else → none.
 */
export function fuelAdvice(plan: CoachPlan | null, weightKg: number | undefined, longMin = FUEL_LONG_MIN_DEFAULT): FuelAdvice {
  const none: FuelAdvice = { kind: 'none', title: '', lines: [] };
  if (!plan || !plan.workout || (plan.runMinutes ?? 0) <= 0 || plan.sessionComplete || plan.optional2nd) return none;
  const split = !!plan.secondSession && (plan.secondSession.runMinutes ?? 0) > 0;
  const part = split ? Math.max(plan.runMinutes, plan.secondSession!.runMinutes) : plan.runMinutes;   // longest single effort
  const total = plannedMinutes(plan);

  if (isIntervalPlan(plan)) {
    return {
      kind: 'intervals',
      title: 'Intervals today — carbs help the hard reps',
      lines: [
        `Before: ${range(0.5, 1, weightKg)} carbs 1–2 h before (e.g. bread with honey, a banana). Early start? A small snack 30–60 min before is enough.`,
        plan.runMinutes >= 75 ? `During: ${plan.runMinutes} min planned — 30 g/h (a gel or sports drink) from the second half.` : 'During: nothing needed.',
        'After: a normal meal with carbs + protein within ~1–2 h.',
      ],
    };
  }

  if (total >= longMin) {
    const title = `${split ? 'Split long run' : LONG_TITLE[plan.sessionKind ?? ''] ?? 'Very long run'} (${Math.round(total)} min) — fuel this one`;
    const lines = [
      `Before: ${g(1, weightKg)} carbs 1–3 h before${part < 120 ? ' — or start fasted and begin fuelling early (within 30–45 min)' : ''}.`,
      duringLine(part, split ? ' each part' : ''),
    ];
    if (split) {
      const gap = plan.secondSession?.earliestAfterHrs;
      lines.push(`Between the parts${gap ? ` (≥${gap} h)` : ''}: ${g(1, weightKg)} carbs + some protein soon after Part 1, then normal meals; last food ~1.5 h before Part 2.`);
    } else {
      lines.push(`After: a carb + protein meal (${g(1, weightKg)} carbs, ${g(0.3, weightKg)} protein) within ~1–2 h — normal meals do the rest.`);
    }
    return { kind: 'long', title, lines };
  }
  return none;
}

/** One compact line for the LLM app model: the preference itself (always) — so chat/review never nag. */
export function fuelPreferenceLine(longMin: number): string {
  return `• FUELLING (athlete preference): runs FASTED by default. Suggest carbs ONLY for interval sessions and very long runs (≥ ${longMin} min): before ~0.5–1 g/kg (intervals) or ~1 g/kg (long), during 30–60 g/h beyond ~75–90 min (60–90 g/h past 2.5 h), recovery after those only. Say NOTHING about fuel for easy/recovery/tempo/normal runs; no daily carb targets.`;
}
