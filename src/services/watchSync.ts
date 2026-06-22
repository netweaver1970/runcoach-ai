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

interface OutKPI { key: string; label: string; unit: string; value: number; color: string; series: { t: number; v: number }[] }

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
      kpis.push({ key: 'stress', label: 'Stress', unit: '', value: bb.currentStress, color: stressColor(bb.currentStress), series: bb.series.map((p: any) => ({ t: p.t, v: p.stress })) });
      kpis.push({ key: 'battery', label: 'Body Battery', unit: '%', value: bb.current, color: batteryColor(bb.current), series: bb.series.map((p: any) => ({ t: p.t, v: p.battery })) });
    }
    if (snap) {
      if (snap.todayRecovery?.recoveryScore != null)
        kpis.push({ key: 'recovery', label: 'Recovery', unit: '', value: snap.todayRecovery.recoveryScore, color: '#22C55E', series: [] });
      if (snap.strain?.real != null)
        kpis.push({ key: 'strain', label: 'Strain', unit: '%', value: Math.round(snap.strain.real), color: '#e67e22', series: [] });
      const tl = (snap.trainingLoad ?? []).slice(-30);
      if (tl.length) kpis.push({ key: 'cardio', label: 'Cardio Load', unit: '', value: Math.round(tl.at(-1)!.atl), color: '#3B82F6', series: tl.map((d: any) => ({ t: ms(d.date), v: Math.round(d.atl) })) });
      const rhr = (snap.restingHR ?? []).slice(-21);
      if (rhr.length) kpis.push({ key: 'rhr', label: 'Resting HR', unit: '', value: rhr.at(-1)!.value, color: '#60A5FA', series: rhr.map((d: any) => ({ t: ms(d.date), v: d.value })) });
      const hrv = (snap.hrv ?? []).slice(-21);
      if (hrv.length) kpis.push({ key: 'hrv', label: 'HRV', unit: 'ms', value: hrv.at(-1)!.value, color: '#A78BFA', series: hrv.map((d: any) => ({ t: ms(d.date), v: d.value })) });
      const vo2 = (snap.vo2max ?? []).slice(-21);
      if (vo2.length) kpis.push({ key: 'vo2', label: 'VO₂ Max', unit: '', value: vo2.at(-1)!.value, color: '#2DD4BF', series: vo2.map((d: any) => ({ t: ms(d.date), v: d.value })) });
    }
    if (!kpis.length) return false;

    // Put the selected KPI first so it's the landing page on the watch.
    const sel = kpis.some(k => k.key === selected) ? selected : kpis[0].key;
    kpis.sort((a, b) => (a.key === sel ? -1 : b.key === sel ? 1 : 0));
    const payload = { selected: sel, updatedAt: Date.now(), kpis };
    return await WatchSync.sync(JSON.stringify(payload));
  } catch { return false; }
}
