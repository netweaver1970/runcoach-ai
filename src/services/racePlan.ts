// ── Race-prep mode ──────────────────────────────────────────────────────────────
// A goal race reorganizes the whole coaching hierarchy. When planMode='race' + a valid future race,
// the LLM RE-PLANS THE CURRENT WEEK each week (phase-aware: base→build→peak→taper), assessing goal
// feasibility from current fitness. Overrides the leisure template + cap; the deterministic engine only
// guards safety. Keyless → a minimal deterministic ramp/taper so the daily card is never blank.
//
// Settings/config live HERE (values); only TYPES are imported from coach.ts → no runtime import cycle.
import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system';
import { callLLM, getLLMStatus } from './llm';
import type { CoachSnapshot, WeekPlanDay, CoachIntensity } from './coach';

export type PlanMode = 'leisure' | 'race';
const PLAN_MODE_KEY = 'plan_mode_v1';
export async function getPlanMode(): Promise<PlanMode> {
  try { return (await SecureStore.getItemAsync(PLAN_MODE_KEY)) === 'race' ? 'race' : 'leisure'; } catch { return 'leisure'; }
}
export async function setPlanMode(m: PlanMode): Promise<void> {
  try { await SecureStore.setItemAsync(PLAN_MODE_KEY, m); } catch { /* ignore */ }
}

export interface RaceConfig { date: string; distanceKm: number; goalTimeSec: number; } // date ''=none; goalTimeSec 0=no goal
export const DEFAULT_RACE: RaceConfig = { date: '', distanceKm: 10, goalTimeSec: 0 };
const RACE_KEY = 'race_config_v1';
export async function getRaceConfig(): Promise<RaceConfig> {
  try { const raw = await SecureStore.getItemAsync(RACE_KEY); return raw ? { ...DEFAULT_RACE, ...JSON.parse(raw) } : { ...DEFAULT_RACE }; }
  catch { return { ...DEFAULT_RACE }; }
}
export async function setRaceConfig(r: RaceConfig): Promise<void> {
  try { await SecureStore.setItemAsync(RACE_KEY, JSON.stringify(r)); } catch { /* ignore */ }
}

// Race mode active = mode 'race' AND a race date today-or-later.
export async function raceActive(): Promise<boolean> {
  if ((await getPlanMode()) !== 'race') return false;
  const r = await getRaceConfig();
  if (!r.date) return false;
  const t = new Date(r.date + 'T00:00:00').getTime();
  return !Number.isNaN(t) && t >= Date.now() - 86_400_000; // include race day itself
}

export interface Feasibility { verdict: 'achievable' | 'ambitious' | 'unrealistic' | 'unknown'; note: string; suggestedTimeSec?: number; }
export interface RaceWeek {
  weekMonday: string; phase: string; weeksToRace: number;
  feasibility: Feasibility; weekVolume: string; longRun: string;
  days: WeekPlanDay[]; generatedAt: string; source: 'llm' | 'fallback'; sig: string;
}
const raceSig = (r: RaceConfig) => `${r.date}|${r.distanceKm}|${r.goalTimeSec}`;

const raceWeekFile = (monday: string) => `${FileSystem.documentDirectory}race-week-${monday}.json`;
const p2 = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
function mondayOf(d: Date): Date { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function weeksToRace(raceISO: string, from = new Date()): number {
  const race = new Date(raceISO + 'T00:00:00').getTime();
  return Math.max(0, Math.ceil((race - mondayOf(from).getTime()) / (7 * 86_400_000)));
}
export function fmtTime(sec: number): string {
  if (!sec) return '';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h}:${p2(m)}:${p2(s)}` : `${m}:${p2(s)}`;
}
function raceName(km: number): string {
  if (Math.abs(km - 42.2) < 0.6) return 'marathon';
  if (Math.abs(km - 21.1) < 0.4) return 'half marathon';
  if (Math.abs(km - 10) < 0.3) return '10K';
  if (Math.abs(km - 5) < 0.3) return '5K';
  return `${km} km`;
}

const KIND_INTENSITY: Record<string, CoachIntensity> = { intervals: 'hard', tempo: 'moderate', long: 'moderate', easy: 'easy', recovery: 'easy', rest: 'rest' };

// Map an LLM/fallback day (weekday-keyed) onto THIS calendar week's real dates.
function mapDays(raw: any[], weekMonday: Date, snap: CoachSnapshot): WeekPlanDay[] {
  const pace = snap.paceMinPerKm && snap.paceMinPerKm > 0 ? snap.paceMinPerKm : 6;
  const byWd = new Map<string, any>();
  for (const d of raw ?? []) { const wd = String(d.weekday ?? '').slice(0, 3); if (wd) byWd.set(wd, d); }
  const out: WeekPlanDay[] = [];
  for (let i = 0; i < 7; i++) {
    const dt = new Date(weekMonday); dt.setDate(dt.getDate() + i);
    const wd = WD[dt.getDay()];
    const d = byWd.get(wd) ?? { kind: 'rest' };
    const kind = ['intervals', 'tempo', 'long', 'easy', 'recovery', 'rest'].includes(d.kind) ? d.kind : 'rest';
    const intensity = (d.intensity && ['rest', 'easy', 'moderate', 'hard'].includes(d.intensity)) ? d.intensity as CoachIntensity : (KIND_INTENSITY[kind] ?? 'easy');
    const runMinutes = intensity === 'rest' ? 0 : Math.max(8, Math.min(240, Math.round(Number(d.runMinutes) || 35)));
    const runKm = intensity !== 'rest' && snap.loadUnit === 'km' ? Math.round((runMinutes / pace) * 10) / 10 : undefined;
    out.push({
      date: iso(dt), weekday: wd, intensity, runMinutes,
      structure: String(d.structure ?? (intensity === 'rest' ? 'Rest' : `${runMinutes}min`)).slice(0, 80),
      note: String(d.note ?? '').slice(0, 80), kind, runKm,
    });
  }
  return out;
}

// Deterministic keyless fallback: a simple phase-appropriate week (base/build → 2-week taper into race).
function fallbackWeek(snap: CoachSnapshot, race: RaceConfig, weekMonday: Date, wks: number): RaceWeek {
  const taper = wks <= 2;
  const longKm = Math.min(race.distanceKm * (taper ? 0.5 : 0.85), race.distanceKm <= 10 ? 14 : 32);
  // Template: Mon rest, Tue quality, Wed easy, Thu quality(easy in taper), Fri rest, Sat long, Sun easy/rest.
  const raw = taper
    ? [{ weekday: 'Tue', kind: 'tempo', runMinutes: 30 }, { weekday: 'Thu', kind: 'easy', runMinutes: 30 }, { weekday: 'Sat', kind: 'long', runMinutes: Math.round(longKm * (snap.paceMinPerKm || 6)) }, { weekday: 'Sun', kind: 'easy', runMinutes: 25 }]
    : [{ weekday: 'Tue', kind: 'intervals', runMinutes: 45 }, { weekday: 'Wed', kind: 'easy', runMinutes: 40 }, { weekday: 'Thu', kind: 'tempo', runMinutes: 45 }, { weekday: 'Sat', kind: 'long', runMinutes: Math.round(longKm * (snap.paceMinPerKm || 6)) }, { weekday: 'Sun', kind: 'easy', runMinutes: 35 }];
  return {
    weekMonday: iso(weekMonday), phase: taper ? 'Taper' : 'Build', weeksToRace: wks,
    feasibility: { verdict: 'unknown', note: 'Add a working API key for a fitness-tailored, periodized race plan.' },
    weekVolume: '—', longRun: `${Math.round(longKm)} km`,
    days: mapDays(raw, weekMonday, snap), generatedAt: new Date().toISOString(), source: 'fallback', sig: raceSig(race),
  };
}

async function generateRaceWeekPlan(snap: CoachSnapshot, race: RaceConfig, weekMonday: Date, wks: number): Promise<RaceWeek | null> {
  const km = race.distanceKm;
  const pace = snap.paceMinPerKm && snap.paceMinPerKm > 0 ? snap.paceMinPerKm : 6;
  const recent = (snap.recentRuns ?? []).slice(-8).map(r => `${r.date} ${r.km}km ${r.type}`).join('; ') || 'none logged';
  const goal = race.goalTimeSec ? `${fmtTime(race.goalTimeSec)} (${fmtTime(Math.round(race.goalTimeSec / km))}/km)` : 'no explicit time goal — build fitness';
  const system =
    `You are an expert running coach applying PERIODIZATION science. Design ONLY the CURRENT training week (7 days, ` +
    `Mon–Sun) for an athlete ${wks} week(s) out from a ${raceName(km)}. Choose the phase from weeks-to-race: ` +
    `BASE (far out, aerobic + strides), BUILD (race-specific quality: intervals/threshold + a long run), PEAK ` +
    `(sharpen ~3–4 wks out), TAPER (final 2–3 wks: cut volume ~40–60%, keep a little intensity, freshen up). ` +
    `Follow 80/20 easy/hard, ONE long run, key quality spaced ≥2 days, respect the athlete's recent volume (don't ` +
    `jump >~10%/wk except tapering down). ASSESS FEASIBILITY of the goal time vs current fitness/pace honestly. ` +
    `On race week, the race day itself is the race (kind "rest" with a note "RACE DAY"). Return ONLY minified JSON: ` +
    `{"phase":"Build","feasibility":{"verdict":"achievable|ambitious|unrealistic","note":"<=20 words","suggestedTimeSec":0},` +
    `"weekVolume":"~45 km","longRun":"18 km","days":[{"weekday":"Mon","kind":"intervals|tempo|long|easy|recovery|rest",` +
    `"intensity":"hard|moderate|easy|rest","runMinutes":45,"structure":"<=10 words","note":"<=8 words"}, ... 7 days]}`;
  const user = JSON.stringify({
    race: { distanceKm: km, date: race.date, goal }, weeksToRace: wks, unit: snap.loadUnit ?? 'min',
    fitness: {
      recentRuns: recent, trailing7dMinutes: snap.tof7d ?? 0, avgPaceMinPerKm: Math.round(pace * 10) / 10,
      estimatedMaxHR: (snap as any).estimatedMaxHR, readiness: snap.readiness, weeklyLongRunKmRecent: undefined,
    },
    todayISO: snap.date,
  });
  try {
    const txt = await callLLM({ system, messages: [{ role: 'user', content: user }], maxTokens: 1400, temperature: 0.3 });
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const o = JSON.parse(m[0]);
    const v = ['achievable', 'ambitious', 'unrealistic'].includes(o?.feasibility?.verdict) ? o.feasibility.verdict : 'unknown';
    return {
      weekMonday: iso(weekMonday), phase: String(o.phase ?? 'Build').slice(0, 24), weeksToRace: wks,
      feasibility: { verdict: v, note: String(o?.feasibility?.note ?? '').slice(0, 160), suggestedTimeSec: Number(o?.feasibility?.suggestedTimeSec) || undefined },
      weekVolume: String(o.weekVolume ?? '—').slice(0, 24), longRun: String(o.longRun ?? '—').slice(0, 24),
      days: mapDays(Array.isArray(o.days) ? o.days : [], weekMonday, snap), generatedAt: new Date().toISOString(), source: 'llm', sig: raceSig(race),
    };
  } catch { return null; }
}

async function loadRaceWeek(monday: string): Promise<RaceWeek | null> {
  try {
    const f = raceWeekFile(monday);
    const info = await FileSystem.getInfoAsync(f);
    if (!info.exists) return null;
    const c = JSON.parse(await FileSystem.readAsStringAsync(f));
    return c && Array.isArray(c.days) ? c as RaceWeek : null;
  } catch { return null; }
}
async function saveRaceWeek(rw: RaceWeek): Promise<void> {
  try { await FileSystem.writeAsStringAsync(raceWeekFile(rw.weekMonday), JSON.stringify(rw)); } catch { /* ignore */ }
}

// THE current week's race plan (cached; LLM re-plans WEEKLY on a new Monday; keyless → fallback).
export async function getRaceWeekPlan(snap: CoachSnapshot, forceRegen = false): Promise<RaceWeek | null> {
  if (!(await raceActive())) return null;
  const race = await getRaceConfig();
  const wm = mondayOf(new Date(snap.date + 'T00:00:00'));
  const key = iso(wm);
  const wks = weeksToRace(race.date, new Date(snap.date + 'T00:00:00'));
  const sig = raceSig(race);
  if (!forceRegen) { const cached = await loadRaceWeek(key); if (cached && cached.sig === sig) return cached; }
  const status = await getLLMStatus();
  const rw = (status.hasKey && status.reachable) ? await generateRaceWeekPlan(snap, race, wm, wks) : null;
  const out = rw ?? fallbackWeek(snap, race, wm, wks);
  await saveRaceWeek(out);
  return out;
}

// Today's session slot from the current race week (for the daily plan basis).
export async function raceSlotForToday(snap: CoachSnapshot): Promise<WeekPlanDay | null> {
  const rw = await getRaceWeekPlan(snap);
  return rw?.days.find(d => d.date === snap.date) ?? null;
}
