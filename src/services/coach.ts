/**
 * LLM training coach. Feeds the FULL daily picture — recovery, HRV/RHR vs baseline,
 * respiration, SpO₂, sleep & sleep debt, and the training-load history (CTL/ATL/TSB,
 * ACWR, recent strain) — to the configured model and asks for a session
 * recommendation grounded in current endurance-training science. Returns structured
 * JSON so the UI can render it and reconcile the advisable strain band.
 */
import * as FileSystem from 'expo-file-system';
import { callLLM } from './llm';
import { buildKnowledgePrompt } from './coachFiles';
import { fetchOurDailyComponents, fetchDailyDurationHistory } from './healthkit';
import { getLocalWeather } from './weather';
import { DayStrain } from '../types';

export interface CoachSnapshot {
  date:          string;
  recovery?:     number;   recoveryLabel?: string;
  hrv?:          number;   hrvBaseline?:   number;
  rhr?:          number;   rhrBaseline?:   number;
  respRate?:     number;   spO2?:          number;
  sleepScore?:   number;   sleepMin?:      number;   sleepDebtMin?: number;
  ctl?:          number;   atl?:           number;   tsb?: number;   acwr?: number;
  strainReal?:   number;   advisableLow?:  number;   advisableHigh?: number;
  readiness?:    number;   drivers?:       string[];
  recentStrain?: number[];                 // last ~10 days, oldest→newest
  recentRuns?:   { date: string; km: number; type: string }[];
  // Time-on-feet (running minutes) — drives the alternation + rolling-volume rules.
  recentTimeOnFeet?: { date: string; min: number }[]; // last ~14 days (0 = no run)
  tof7d?:            number;   // trailing 7-day running minutes (completed days only)
  tofPrev7d?:        number;   // the 7 days before that
  tofBudgetTodayMin?: number;  // max running minutes TODAY under the +10% rolling cap
  yesterdayTofMin?:  number;   // yesterday's running minutes
  yesterdayStrain?:  number;   // yesterday's strain score
  weather?: {                  // current conditions — heat/humidity raise strain
    tempC: number; apparentC: number; humidity: number; windKmh: number;
    description: string; place?: string;
  };
}

export type CoachIntensity = 'rest' | 'easy' | 'moderate' | 'hard';

export interface CoachPlan {
  headline:   string;        // one-line readiness verdict
  session:    string;        // the recommended session
  strength:   string;        // leg-strength / injury-prevention prescription
  intensity:  CoachIntensity;
  runMinutes: number;        // prescribed running time-on-feet (≤ rolling cap)
  strainLow:  number;
  strainHigh: number;
  rationale:  string;
  cautions?:  string;
  generatedAt: string;
}

// The detailed rules now live in editable knowledge files (coachFiles.ts). The wrapper
// keeps only the role framing and the (non-editable) output contract so a user edit
// can't break JSON parsing.
const ROLE = `You are a running coach. The COACHING KNOWLEDGE below is AUTHORITATIVE — \
follow every rule in it. You receive a JSON snapshot of today's physiology, training load, time-on-feet \
and weather. Today's strain TARGET is fixed and provided as advisableLow–advisableHigh — treat that as THE \
target; do NOT invent a different band. Prescribe a session whose total strain (run + drills, adjusted for \
heat/humidity) lands within it, never more than 10% over the ceiling. In the rationale, ALWAYS state where \
today's actual strain (strainReal) sits relative to the target band — BELOW / WITHIN / ABOVE — and why that \
is appropriate for your call (e.g. "strain 7% is below the 23–47% band, which is right given low recovery — \
rest"). Use the exact strainReal figure; never invent a different number. SpO₂ note: brief overnight dips to \
~92–95% are normal and must NOT reduce load on their own — only treat SpO₂ as a concern if it is below ~92%. \
Produce the runner's DAILY OUTLOOK as the OUTCOME of the rules applied to all the data.`;

const OUTPUT = `Return ONLY minified JSON, no markdown, with EXACTLY these keys: \
{"headline":string,"session":string,"strength":string,"intensity":"rest"|"easy"|"moderate"|"hard","runMinutes":number,"rationale":string,"cautions":string}. \
Be concise and skimmable — no filler. headline ≤ 7 words (the outlook); session ≤ 25 words \
(type, run minutes, run/walk or alternation if relevant); runMinutes = prescribed running time-on-feet \
(≤ tofBudgetTodayMin); strength ≤ 22 words (just the named exercises × sets/reps); rationale ≤ 22 words \
(the 1–2 signals that drove it); cautions ≤ 12 words ("" if none).`;

function clampScore(n: any, fallback: number): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : fallback;
}

export async function getCoachPlan(snap: CoachSnapshot): Promise<CoachPlan> {
  const knowledge = await buildKnowledgePrompt();
  const system = `${ROLE}\n\n===== COACHING KNOWLEDGE =====\n${knowledge}\n===== END COACHING KNOWLEDGE =====\n\n${OUTPUT}`;
  const txt = await callLLM({
    system,
    messages: [{ role: 'user', content: JSON.stringify(snap) }],
    maxTokens: 600,
  });
  const match = txt.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Coach response was not JSON.');
  const o = JSON.parse(match[0]);
  const intensity: CoachIntensity =
    ['rest', 'easy', 'moderate', 'hard'].includes(o.intensity) ? o.intensity : 'easy';
  return {
    headline:   String(o.headline ?? 'Plan ready').slice(0, 120),
    session:    String(o.session ?? '').slice(0, 280),
    strength:   String(o.strength ?? '').slice(0, 240),
    intensity,
    runMinutes: Math.max(0, Math.min(
      snap.tofBudgetTodayMin ?? 999,
      Math.round(Number(o.runMinutes)) || 0,
    )),
    // Target is the single advisable band (synced with the home ring) — not the LLM's own.
    strainLow:  clampScore(snap.advisableLow, 30),
    strainHigh: clampScore(snap.advisableHigh, 60),
    rationale:  String(o.rationale ?? '').slice(0, 400),
    cautions:   o.cautions ? String(o.cautions).slice(0, 200) : undefined,
    generatedAt: new Date().toISOString(),
  };
}

export interface TofPlan {
  series14:       { date: string; min: number }[];
  tof7d:          number;   // rolling 7-day total ending today (today so far)
  tofPrev7d:      number;   // the 7 days before that
  cap7dMin:       number;   // 1.10 × prior-7 (the rolling ceiling)
  budgetTodayMin: number;   // running minutes still allowed today
  yesterdayMin:   number;
}

/**
 * Rolling time-on-feet model for the +10% rule: the 7-day total ending today must not
 * exceed 1.10× the 7-day total ending a week ago. Returns today's remaining running
 * budget plus a 14-day series for the alternation check. A small floor keeps a short
 * easy run available when returning from a near-zero base.
 */
export function computeTimeOnFeetPlan(
  daily: { date: string; value: number }[], today = new Date(),
): TofPlan {
  const map = new Map(daily.map(d => [d.date, d.value]));
  const p = (n: number) => String(n).padStart(2, '0');
  const dayStr = (offset: number) => {
    const d = new Date(today); d.setDate(d.getDate() - offset);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const minsAt = (offset: number) => map.get(dayStr(offset)) ?? 0;

  let tofLast6 = 0; for (let o = 1; o <= 6;  o++) tofLast6 += minsAt(o);
  let tofPrev7 = 0; for (let o = 7; o <= 13; o++) tofPrev7 += minsAt(o);
  const cap = Math.round(1.10 * tofPrev7);
  let budget = Math.max(0, cap - tofLast6);
  if (tofPrev7 < 30) budget = Math.max(budget, 20); // re-entry / very low base

  const series14: { date: string; min: number }[] = [];
  for (let o = 13; o >= 0; o--) series14.push({ date: dayStr(o), min: minsAt(o) });

  return {
    series14,
    tof7d: tofLast6 + minsAt(0),
    tofPrev7d: tofPrev7,
    cap7dMin: cap,
    budgetTodayMin: budget,
    yesterdayMin: minsAt(1),
  };
}

/**
 * Build the full coach snapshot from HealthKit + weather for a given day's strain.
 * Single source used by both the Strain screen and the background day-view updater, so
 * the on-demand plan and the auto-prepared plan are identical.
 */
export async function assembleCoachSnapshot(strain: DayStrain | null): Promise<CoachSnapshot> {
  const [comps, dur, weather] = await Promise.all([
    fetchOurDailyComponents(1),
    fetchDailyDurationHistory(),
    getLocalWeather().catch(() => null),
  ]);
  const dates  = Object.keys(comps).sort();
  const latest = dates.length ? comps[dates[dates.length - 1]] : {};
  const date   = dates.length ? dates[dates.length - 1] : new Date().toISOString().slice(0, 10);
  const tof    = computeTimeOnFeetPlan(dur);
  const strainHist = dates.map(d => comps[d].strainScore).filter((v): v is number => v !== undefined);
  return {
    date,
    recovery:     latest.recoveryScore,
    hrv:          latest.restingHrv,
    rhr:          latest.restingHr,
    respRate:     latest.respiratoryRate,
    spO2:         latest.oxygenSaturation,
    sleepScore:   latest.sleepScore,
    sleepMin:     latest.timeAsleep,
    sleepDebtMin: latest.sleepBank,
    ctl:          latest.ctl,
    atl:          latest.cardioLoad,
    tsb:          latest.tsb,
    acwr:         strain?.acwr || undefined,
    strainReal:   strain?.real,
    advisableLow:  strain?.safeLow,
    advisableHigh: strain?.safeHigh,
    readiness:    strain?.readiness,
    drivers:      strain?.drivers,
    recentStrain: strainHist.slice(-10),
    recentTimeOnFeet:  tof.series14,
    tof7d:             tof.tof7d,
    tofPrev7d:         tof.tofPrev7d,
    tofBudgetTodayMin: tof.budgetTodayMin,
    yesterdayTofMin:   tof.yesterdayMin,
    yesterdayStrain:   strainHist.length >= 2 ? strainHist[strainHist.length - 2] : undefined,
    weather: weather ? {
      tempC: weather.tempC, apparentC: weather.apparentC, humidity: weather.humidity,
      windKmh: weather.windKmh, description: weather.description, place: weather.place,
    } : undefined,
  };
}

// Cache one plan per calendar day (never serve a previous day's plan).
const planFile = (date: string) => `${FileSystem.documentDirectory}coach-plan-${date}.json`;

export async function loadCachedPlan(date: string): Promise<CoachPlan | null> {
  try {
    const f = planFile(date);
    const info = await FileSystem.getInfoAsync(f);
    if (!info.exists) return null;
    return JSON.parse(await FileSystem.readAsStringAsync(f)) as CoachPlan;
  } catch { return null; }
}

export async function saveCachedPlan(date: string, plan: CoachPlan): Promise<void> {
  try { await FileSystem.writeAsStringAsync(planFile(date), JSON.stringify(plan)); } catch { /* ignore */ }
}
