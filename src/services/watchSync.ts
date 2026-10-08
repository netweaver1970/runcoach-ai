/**
 * Push KPI data to the RunCoach watchOS app (WatchConnectivity, via the
 * runcoach-watchsync native module). The phone owns all the calibrated models; the watch
 * just displays the latest synced series + the chosen complication KPI.
 */
import * as SecureStore from 'expo-secure-store';
import { requireNativeModule } from 'expo-modules-core';
import { computeBodyBattery } from './bodyBattery';
import { loadSnapshotCache, peekDailyComponents } from './healthkit';

interface WatchSyncNative { isSupported(): Promise<boolean>; isPaired(): Promise<boolean>; sync(json: string): Promise<boolean>; }
let WatchSync: WatchSyncNative | null = null;
try { WatchSync = requireNativeModule('RunCoachWatchSync'); } catch { WatchSync = null; }

const SEL_KEY = 'watch_kpi_v1';

export interface WatchKPIOption { key: string; label: string }
export const WATCH_KPIS: WatchKPIOption[] = [
  { key: 'stress',   label: 'Stress' },
  { key: 'battery',  label: 'Body Battery' },
  { key: 'recovery', label: 'Recovery' },
  { key: 'strain',   label: 'Strain' },
  { key: 'cardio',   label: 'Cardio Load' },
  { key: 'rhr',      label: 'Resting HR' },
  { key: 'hrv',      label: 'HRV' },
  { key: 'vo2',      label: 'VO₂ Max' },
];

export const watchSyncAvailable = (): boolean => WatchSync != null;
export async function getWatchKPI(): Promise<string> {
  try { return (await SecureStore.getItemAsync(SEL_KEY)) || 'stress'; } catch { return 'stress'; }
}
export async function setWatchKPI(key: string): Promise<void> {
  try { await SecureStore.setItemAsync(SEL_KEY, key); } catch { /* ignore */ }
  syncWatch().catch(() => {});
}

const stressColor  = (v: number) => (v >= 70 ? '#EF4444' : v >= 40 ? '#F59E0B' : '#22C55E');
const batteryColor = (v: number) => (v >= 60 ? '#22C55E' : v >= 30 ? '#F59E0B' : '#EF4444');
const ms = (d: string) => Date.parse(d.length <= 10 ? d + 'T12:00:00' : d);

// series points carry optional context flags: a = asleep, g = break-the-line-before (a data
// hole or an excluded workout), w = in a workout (1 strength → dumbbell, 2 cardio → runner on the watch),
// x = not part of the line (a workout excluded from stress: kept only so the watch can draw its band + icon).
// frame tells the watch how to annotate: "day" → sleep/workout shading + icons + gaps; "multi" → vertical week
// dividers (Mondays) at the `marks` indices.
interface CtxPoint { t: number; v: number; a?: number; g?: number; w?: number; x?: number }
interface OutKPI {
  key: string; label: string; unit: string; value: number; color: string;
  grad?: string[]; frame?: 'day' | 'multi'; marks?: number[]; series: CtxPoint[];
}

// Per-KPI colour ramp for the watch graph, ordered TOP→BOTTOM (high value → low value).
// Bevel-style: green = good, red = bad — direction depends on whether high is good or bad.
const HIGH_BAD  = ['#EF4444', '#F59E0B', '#22C55E']; // high = red (stress, resting HR)
const HIGH_GOOD = ['#22C55E', '#F59E0B', '#EF4444']; // high = green (battery, HRV, VO₂)
const GRAD: Record<string, string[]> = { stress: HIGH_BAD, rhr: HIGH_BAD, battery: HIGH_GOOD, hrv: HIGH_GOOD, vo2: HIGH_GOOD };

// Keep series small + clean for WatchConnectivity: drop bad/NaN timestamps (one bad point
// blows up the chart's x-domain → an empty-looking graph), sort by time, and downsample to
// ~80 points so the payload stays tiny and the watch chart renders fast.
function prep(pts: { t: number; v: number }[], n = 80): { t: number; v: number }[] {
  const clean = pts.filter(p => Number.isFinite(p.t) && Number.isFinite(p.v)).sort((a, b) => a.t - b.t);
  if (clean.length <= n) return clean;
  const step = (clean.length - 1) / (n - 1);
  const out: { t: number; v: number }[] = [];
  for (let i = 0; i < n; i++) out.push(clean[Math.round(i * step)]);
  return out;
}

// Intraday (last-24h) series for stress/battery: downsample but keep the asleep flag, then
// mark a break (g=1) before any real data hole (watch off) or excluded workout.
const HOLE_MS = 30 * 60_000;
function prepIntraday(
  src: { t: number; v: number; asleep: boolean; workout: boolean; rec?: boolean; wt?: 'strength' | 'cardio' | 'other' }[],
  excludeWorkout: boolean,
  n = 150,
): CtxPoint[] {
  let clean = src.filter(p => Number.isFinite(p.t) && Number.isFinite(p.v)).sort((a, b) => a.t - b.t);
  if (clean.length > n) {
    const step = (clean.length - 1) / (n - 1);
    const out: typeof clean = [];
    for (let i = 0; i < n; i++) out.push(clean[Math.round(i * step)]);
    clean = out;
  }
  const res: CtxPoint[] = [];
  let prevT: number | null = null, pendingBreak = false;
  for (const p of clean) {
    const w = p.workout && !p.rec ? { w: p.wt === 'strength' ? 1 : p.wt === 'other' ? 3 : 2 } : {};   // recovery tail: no band   // 3 = no icon on the watch
    // an excluded workout stays in the series (for its band + icon) but is flagged out of the line
    if (excludeWorkout && p.workout) { res.push({ t: p.t, v: Math.round(p.v), ...w, x: 1 }); pendingBreak = true; continue; }
    const gap = pendingBreak || (prevT != null && p.t - prevT > HOLE_MS);
    res.push({ t: p.t, v: Math.round(p.v), ...(p.asleep ? { a: 1 } : {}), ...(gap ? { g: 1 } : {}), ...w });
    prevT = p.t; pendingBreak = false;
  }
  return res;
}

// Last 21 nights of HRV: the stored daily components' nightly value; if that store is still empty (e.g. right after
// a recompute), the median of each night's raw readings (18:00 → 10:00, attributed to the wake-up day).
async function nightlyHrv(raw: { date: string; value: number }[]): Promise<{ t: number; v: number }[]> {
  const dc = await peekDailyComponents().catch(() => null);
  const fromDc = Object.entries(dc?.days ?? {}).filter(([, d]) => (d.restingHrv ?? 0) > 0)
    .sort(([a], [b]) => a.localeCompare(b)).slice(-21).map(([day, d]) => ({ t: ms(day), v: Math.round(d.restingHrv * 10) / 10 }));
  if (fromDc.length >= 3) return fromDc;
  const byNight = new Map<string, number[]>();
  for (const r of raw) {
    const d = new Date(r.date), h = d.getHours();
    if (!(r.value > 0) || (h >= 10 && h < 18)) continue;   // daytime spot readings aren't the night's HRV
    if (h >= 18) d.setDate(d.getDate() + 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    (byNight.get(key) ?? byNight.set(key, []).get(key)!).push(r.value);
  }
  const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  return [...byNight.entries()].filter(([, v]) => v.length >= 3).sort(([a], [b]) => a.localeCompare(b)).slice(-21)
    .map(([day, v]) => ({ t: ms(day), v: med(v) }));
}

// Indices where a new ISO week (Monday-start) begins — vertical dividers on long charts.
function weekMarks(pts: { t: number }[]): number[] {
  const monday = (t: number) => { const d = new Date(t); const off = (d.getDay() + 6) % 7; d.setDate(d.getDate() - off); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const marks: number[] = [];
  for (let i = 1; i < pts.length; i++) if (monday(pts[i].t) !== monday(pts[i - 1].t)) marks.push(i);
  return marks;
}

export async function syncWatch(bbIn?: any, snapIn?: any): Promise<boolean> {
  if (!WatchSync) return false;
  try {
    const [bb, snap, selected] = await Promise.all([
      bbIn !== undefined ? Promise.resolve(bbIn) : computeBodyBattery().catch(() => null),
      snapIn !== undefined ? Promise.resolve(snapIn) : loadSnapshotCache(),
      getWatchKPI(),
    ]);
    const kpis: OutKPI[] = [];

    if (bb) {
      // Intraday: stress excludes workouts (gap); battery keeps them (it really drains).
      const stressSrc = bb.series.map((p: any) => ({ t: p.t, v: p.stress, asleep: p.asleep, workout: p.workout, rec: p.rec, wt: p.wt }));
      const batterySrc = bb.series.map((p: any) => ({ t: p.t, v: p.battery, asleep: p.asleep, workout: p.workout, rec: p.rec, wt: p.wt }));
      kpis.push({ key: 'stress', label: 'Stress', unit: '', value: bb.currentStress, color: stressColor(bb.currentStress), frame: 'day', series: prepIntraday(stressSrc, true) });
      kpis.push({ key: 'battery', label: 'Body Battery', unit: '%', value: bb.current, color: batteryColor(bb.current), frame: 'day', series: prepIntraday(batterySrc, false) });
    }
    if (snap) {
      if (snap.todayRecovery?.recoveryScore != null)
        kpis.push({ key: 'recovery', label: 'Recovery', unit: '', value: snap.todayRecovery.recoveryScore, color: '#22C55E', series: [] });
      if (snap.strain?.real != null)
        kpis.push({ key: 'strain', label: 'Strain', unit: '%', value: Math.round(snap.strain.real), color: '#e67e22', series: [] });
      const tl = (snap.trainingLoad ?? []).slice(-30);
      if (tl.length) { const s = prep(tl.map((d: any) => ({ t: ms(d.date), v: Math.round(d.atl) }))); kpis.push({ key: 'cardio', label: 'Cardio Load', unit: '', value: Math.round(tl.at(-1)!.atl), color: '#3B82F6', frame: 'multi', marks: weekMarks(s), series: s }); }
      const rhr = (snap.restingHR ?? []).slice(-21);
      if (rhr.length) { const s = prep(rhr.map((d: any) => ({ t: ms(d.date), v: d.value }))); kpis.push({ key: 'rhr', label: 'Resting HR', unit: '', value: rhr.at(-1)!.value, color: '#60A5FA', frame: 'multi', marks: weekMarks(s), series: s }); }
      // HRV = the NIGHTLY value (the one recovery uses), one point per night over the last 3 weeks. snap.hrv is the
      // RAW 15-min readings NEWEST-FIRST — `.slice(-21)` sent 21 single readings of one night 2 weeks old, and its
      // `.at(-1)` showed an old reading as "today" (2026-10-08: the graph peaked at 73 while the value said 33).
      const hrvNights = await nightlyHrv(snap.hrv ?? []);
      if (hrvNights.length) { const s = prep(hrvNights); kpis.push({ key: 'hrv', label: 'HRV', unit: 'ms', value: Math.round(s.at(-1)!.v), color: '#A78BFA', frame: 'multi', marks: weekMarks(s), series: s }); }
      const vo2 = (snap.vo2max ?? []).slice(-21);
      if (vo2.length) { const s = prep(vo2.map((d: any) => ({ t: ms(d.date), v: d.value }))); kpis.push({ key: 'vo2', label: 'VO₂ Max', unit: '', value: vo2.at(-1)!.value, color: '#2DD4BF', frame: 'multi', marks: weekMarks(s), series: s }); }
    }
    if (!kpis.length) return false;
    for (const k of kpis) if (GRAD[k.key] && k.series.length > 1) k.grad = GRAD[k.key];

    // Put the selected KPI first so it's the landing page on the watch.
    const sel = kpis.some(k => k.key === selected) ? selected : kpis[0].key;
    kpis.sort((a, b) => (a.key === sel ? -1 : b.key === sel ? 1 : 0));
    const payload = { selected: sel, updatedAt: Date.now(), kpis };
    return await WatchSync.sync(JSON.stringify(payload));
  } catch { return false; }
}
