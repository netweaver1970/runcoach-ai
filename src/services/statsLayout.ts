/** Persisted Statistics-screen card layout: order + enabled, edited via the Customise sheet. */
import * as FileSystem from 'expo-file-system';

export type StatCardId =
  | 'weeklyTss' | 'pdc' | 'race' | 'ef' | 'ec' | 'se'
  | 'intensity' | 'mix' | 'acwr' | 'decoupling' | 'volume';

export interface StatCard { id: StatCardId; on: boolean }

export const STAT_CARD_TITLES: Record<StatCardId, string> = {
  weeklyTss:  'Weekly TSS',
  pdc:        'Power–Duration Curve',
  race:       'Race Predictor',
  ef:         'Efficiency Factor',
  ec:         'Running Economy (EC)',
  se:         'Speed Efficiency (SE)',
  intensity:  'Intensity Distribution',
  mix:        'Intensity Mix Over Time',
  acwr:       'Load Ratio (ACWR)',
  decoupling: 'Aerobic Decoupling',
  volume:     'Volume vs Budget',
};

// Default order = the historical top-to-bottom order; everything enabled.
export const DEFAULT_STATS_LAYOUT: StatCard[] = [
  'weeklyTss', 'pdc', 'race', 'ef', 'ec', 'se', 'intensity', 'mix', 'acwr', 'decoupling', 'volume',
].map(id => ({ id: id as StatCardId, on: true }));

const ALL_IDS = DEFAULT_STATS_LAYOUT.map(c => c.id);
const FILE = `${FileSystem.documentDirectory}runcoach-stats-layout.json`;

/** Merge a saved layout with the defaults: drop unknown ids, append any NEW card (enabled) at the end. */
function reconcile(saved: StatCard[]): StatCard[] {
  const known = saved.filter(c => ALL_IDS.includes(c.id));
  const seen = new Set(known.map(c => c.id));
  const missing = DEFAULT_STATS_LAYOUT.filter(c => !seen.has(c.id));  // cards added since the layout was saved
  return [...known, ...missing];
}

export async function loadStatsLayout(): Promise<StatCard[]> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (!info.exists) return DEFAULT_STATS_LAYOUT;
    const parsed = JSON.parse(await FileSystem.readAsStringAsync(FILE)) as StatCard[];
    if (Array.isArray(parsed) && parsed.length) return reconcile(parsed);
    return DEFAULT_STATS_LAYOUT;
  } catch { return DEFAULT_STATS_LAYOUT; }
}

export async function saveStatsLayout(layout: StatCard[]): Promise<void> {
  try { await FileSystem.writeAsStringAsync(FILE, JSON.stringify(layout)); } catch { /* ignore */ }
}
