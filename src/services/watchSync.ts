/**
 * Push KPI data to the RunCoach watchOS app (WatchConnectivity, via the
 * runcoach-watchsync native module). The phone owns all the calibrated models; the watch
 * just displays the latest synced series + the chosen complication KPI.
 */
import * as SecureStore from 'expo-secure-store';
import { requireNativeModule } from 'expo-modules-core';
import { computeBodyBattery } from './bodyBattery';
import { loadSnapshotCache } from './healthkit';

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
// hole or an excluded workout). frame tells the watch how to annotate: "day" → sleep shading +
// gaps; "multi" → vertical week dividers (Mondays) at the `marks` indices.
interface CtxPoint { t: number; v: number; a?: number; g?: number }
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
  src: { t: number; v: number; asleep: boolean; workout: boolean }[],
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
    if (excludeWorkout && p.workout) { pendingBreak = true; continue; }
    const gap = pendingBreak || (prevT != null && p.t - prevT > HOLE_MS);
    res.push({ t: p.t, v: Math.round(p.v), ...(p.asleep ? { a: 1 } : {}), ...(gap ? { g: 1 } : {}) });
    prevT = p.t; pendingBreak = false;
  }
  return res;
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
      const stressSrc = bb.series.map((p: any) => ({ t: p.t, v: p.stress, asleep: p.asleep, workout: p.workout }));
      const batterySrc = bb.series.map((p: any) => ({ t: p.t, v: p.battery, asleep: p.asleep, workout: p.workout }));
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
      const hrv = (snap.hrv ?? []).slice(-21);
      if (hrv.length) { const s = prep(hrv.map((d: any) => ({ t: ms(d.date), v: d.value }))); kpis.push({ key: 'hrv', label: 'HRV', unit: 'ms', value: hrv.at(-1)!.value, color: '#A78BFA', frame: 'multi', marks: weekMarks(s), series: s }); }
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
