/** Persisted Statistics-screen card layout: order + enabled, edited via the Customise sheet. */
import * as FileSystem from 'expo-file-system';

export type StatCardId =
  | 'performance' | 'pmc' | 'weeklyTss' | 'pdc' | 'race' | 'ef' | 'ec' | 'ecn' | 'se' | 'efftrend'
  | 'intensity' | 'mix' | 'acwr' | 'decoupling' | 'volume';

export interface StatCard { id: StatCardId; on: boolean }

export const STAT_CARD_TITLES: Record<StatCardId, string> = {
  performance: 'Performance',
  pmc:        'Fitness / Fatigue / Form',
  weeklyTss:  'Weekly TSS',
  pdc:        'Power–Duration Curve',
  race:       'Race Predictor',
  ef:         'Efficiency Factor',
  ec:         'Running Economy (EC)',
  ecn:        'Economy (weight-adjusted)',
  se:         'Speed Efficiency (SE)',
  efftrend:   'Efficiency Trends',
  intensity:  'Intensity Distribution',
  mix:        'Intensity Mix Over Time',
  acwr:       'Load Ratio (ACWR)',
  decoupling: 'Aerobic Decoupling',
  volume:     'Volume vs Budget',
};

// EC (speed÷power) + its weight-adjusted twin: ≈ constant by construction with Apple Watch's MODELLED power
// (2026-10-10) → hidden by default (still in Customise as a data check).
const OFF_BY_DEFAULT = new Set<StatCardId>(['ec', 'ecn']);
// Default order = the historical top-to-bottom order; everything enabled except OFF_BY_DEFAULT. (Performance leads — it's the
// headline overall-trajectory metric, moved here from the home screen.)
export const DEFAULT_STATS_LAYOUT: StatCard[] = [
  'performance', 'pmc', 'weeklyTss', 'pdc', 'race', 'ef', 'ec', 'ecn', 'se', 'efftrend', 'intensity', 'mix', 'acwr', 'decoupling', 'volume',
].map(id => ({ id: id as StatCardId, on: !OFF_BY_DEFAULT.has(id as StatCardId) }));

const ALL_IDS = DEFAULT_STATS_LAYOUT.map(c => c.id);
const FILE = `${FileSystem.documentDirectory}runcoach-stats-layout.json`;
const MIG_FILE = `${FileSystem.documentDirectory}runcoach-stats-layout-ec-off.flag`;

/** Merge a saved layout with the defaults: drop unknown ids, slot any NEW card (enabled) in after its default predecessor. */
function reconcile(saved: StatCard[]): StatCard[] {
  const known = saved.filter(c => ALL_IDS.includes(c.id));
  const seen = new Set(known.map(c => c.id));
  // Cards added since the layout was saved go in right after their default predecessor (e.g. Efficiency Trends
  // under SE; a new FIRST card goes on top), or at the end if the predecessor is gone — enabled, so a new card is
  // never silently hidden.
  const out = [...known];
  DEFAULT_STATS_LAYOUT.forEach((c, i) => {
    if (seen.has(c.id)) return;
    const prev = i > 0 ? out.findIndex(x => x.id === DEFAULT_STATS_LAYOUT[i - 1].id) : -1;
    out.splice(i === 0 ? 0 : prev >= 0 ? prev + 1 : out.length, 0, c);
    seen.add(c.id);
  });
  return out;
}

export async function loadStatsLayout(): Promise<StatCard[]> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (!info.exists) { await FileSystem.writeAsStringAsync(MIG_FILE, '1').catch(() => {}); return DEFAULT_STATS_LAYOUT; }   // defaults already have EC off
    const parsed = JSON.parse(await FileSystem.readAsStringAsync(FILE)) as StatCard[];
    if (Array.isArray(parsed) && parsed.length) {
      // one-time: switch the EC cards off in an existing layout (the user can switch them back on in Customise)
      const mig = await FileSystem.getInfoAsync(MIG_FILE).catch(() => ({ exists: true }));
      if (!mig.exists) {
        const out = reconcile(parsed).map(c => (OFF_BY_DEFAULT.has(c.id) ? { ...c, on: false } : c));
        await saveStatsLayout(out);
        await FileSystem.writeAsStringAsync(MIG_FILE, '1').catch(() => {});
        return out;
      }
      return reconcile(parsed);
    }
    return DEFAULT_STATS_LAYOUT;
  } catch { return DEFAULT_STATS_LAYOUT; }
}

export async function saveStatsLayout(layout: StatCard[]): Promise<void> {
  try { await FileSystem.writeAsStringAsync(FILE, JSON.stringify(layout)); } catch { /* ignore */ }
  // a layout the user saved is their choice → the one-time "EC off" migration must never revert it
  await FileSystem.writeAsStringAsync(MIG_FILE, '1').catch(() => {});
}
