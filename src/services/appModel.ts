/**
 * APP MODEL — one authoritative, concise, LLM-readable description of how RunCoachAI actually works, plus
 * the athlete's CURRENT customizing settings. Injected into every LLM prompt (chat, run analysis, coach)
 * so the model reasons from the real in-app logic instead of guessing.
 *
 * Why this exists: the run analysis once claimed a longer cool-down "added to time-on-feet" — false; ToF
 * excludes cool-down. Patching that one fact into that one prompt is the wrong fix. The rules live here,
 * once, and any prompt that includes this block gets them all. Keep it TIGHT — it rides on every call.
 */
import { getAccountingMode } from './accounting';
import { getLongRunMinutes } from './claude';
import { getPlanMode } from './racePlan';
import {
  getLoadCapPct, getLoadCapBasis, getMinTSB, getMaxRunDays, getWorkoutStructure,
  getHeatSensitivity, getPeriodization, getCoachingMode,
} from './coach';
import { activeTripSummary } from './travelStore';
import { computeAdherence } from './adherenceRead';
import { adherenceForLLM } from './adherence';

export async function buildAppModelPrompt(): Promise<string> {
  const todayISO = new Date().toISOString().slice(0, 10);
  const [regime, capPct, capBasis, minTSB, maxRunDays, longMin, struct, heatSens, per, coachMode, planMode, tripSummary, adherence] =
    await Promise.all([
      getAccountingMode().catch(() => 'work' as const),
      getLoadCapPct().catch(() => 10),
      getLoadCapBasis().catch(() => 'tof' as const),
      getMinTSB().catch(() => -16),
      getMaxRunDays().catch(() => 5),
      getLongRunMinutes().catch(() => 75),
      getWorkoutStructure().catch(() => ({ warmupMeters: 0, cooldownMeters: 0, drillsMinutes: 4 })),
      getHeatSensitivity().catch(() => 1.5),
      getPeriodization().catch(() => ({ on: true, buildWeeks: 3, deloadWeeks: 1, deloadDropPct: 25, anchor: '' })),
      getCoachingMode().catch(() => 'self' as const),
      getPlanMode().catch(() => 'leisure' as const),
      activeTripSummary(todayISO).catch(() => null),
      computeAdherence(todayISO).then(adherenceForLLM).catch(() => null),
    ]);

  const basisTxt = capBasis === 'distance' ? 'work+drills DISTANCE (km)'
    : capBasis === 'trimp' ? 'prescribed Banister TRIMP' : 'time-on-feet MINUTES';
  const m = (v: number) => (v > 0 ? `${v}m` : 'open');

  return [
    'APP MODEL (authoritative — how THIS app computes things; use it, do not guess):',
    `• TIME-ON-FEET (ToF): the running volume the cap tracks = WORK + DRILLS only. Warm-up, cool-down, recovery jogs and walks are EXCLUDED. A FLOAT between reps (easy running, Z2/Z3) counts as work; a walk/standing rest does NOT. Never say a warm-up or cool-down "added to time-on-feet". (Accounting regime: "${regime}" — 'work'=work+drills, 'full'=whole run.)`,
    `• VOLUME CAP: at most +${capPct}% per rolling 7 days, measured on ${basisTxt}.`,
    `• LOAD: daily Banister TRIMP (HR-reserve). CTL=42-day EWMA (fitness), ATL=7-day EWMA (fatigue), TSB=CTL−ATL same-day (form). Strain = log-scaled daily TRIMP. ACWR=ATL/CTL (sweet spot 0.8–1.3).`,
    `• RECOVERY 1–100 (0 = NO DATA, real scores floor at 1). Readiness composites recovery+sleep+form+ACWR. Sessions are trimmed to hold projected TSB ≥ ${minTSB}; readiness < 35 forces a rest day.`,
    `• ATHLETE SETTINGS: ${planMode} mode · ${coachMode === 'coach' ? 'external-coach' : 'self-coached'} · ≤${maxRunDays} run days/wk · long run ${longMin} min · structure warm-up ${m(struct.warmupMeters)} / drills ${struct.drillsMinutes}min / cool-down ${m(struct.cooldownMeters)} · heat sensitivity ${heatSens} · periodization ${per.on ? `on (build ${per.buildWeeks}/deload ${per.deloadWeeks}wk, −${per.deloadDropPct}%)` : 'off'}.`,
    tripSummary ? `• TRAVEL (athlete's saved trips — plan around these): ${tripSummary}` : '',
    adherence ? `• ${adherence}` : '',
  ].filter(Boolean).join('\n');
}
