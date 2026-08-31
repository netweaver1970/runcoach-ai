/** Persisted HRV-reading-detail card layout: order + enabled, edited via the Customise sheet. Mirrors statsLayout. */
import * as FileSystem from 'expo-file-system';

export type HRVCardId = 'time' | 'hr' | 'timedomain' | 'histogram' | 'nonlinear' | 'poincare';

export interface HRVCard { id: HRVCardId; on: boolean }

export const HRV_CARD_TITLES: Record<HRVCardId, string> = {
  time:       'Time',
  hr:         'Heart Rate',
  timedomain: 'HRV Time-Domain Measures',
  histogram:  'HRV Histogram',
  nonlinear:  'HRV Non-Linear Measures',
  poincare:   'Poincaré Plot',
};

export const DEFAULT_HRV_LAYOUT: HRVCard[] = [
  'time', 'hr', 'timedomain', 'histogram', 'nonlinear', 'poincare',
].map(id => ({ id: id as HRVCardId, on: true }));

const ALL_IDS = DEFAULT_HRV_LAYOUT.map(c => c.id);
const FILE = `${FileSystem.documentDirectory}runcoach-hrv-layout.json`;

function reconcile(saved: HRVCard[]): HRVCard[] {
  const known = saved.filter(c => ALL_IDS.includes(c.id));
  const seen = new Set(known.map(c => c.id));
  const missing = DEFAULT_HRV_LAYOUT.filter(c => !seen.has(c.id));
  return [...known, ...missing];
}

export async function loadHRVLayout(): Promise<HRVCard[]> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (!info.exists) return DEFAULT_HRV_LAYOUT;
    const parsed = JSON.parse(await FileSystem.readAsStringAsync(FILE)) as HRVCard[];
    if (Array.isArray(parsed) && parsed.length) return reconcile(parsed);
    return DEFAULT_HRV_LAYOUT;
  } catch { return DEFAULT_HRV_LAYOUT; }
}

export async function saveHRVLayout(layout: HRVCard[]): Promise<void> {
  try { await FileSystem.writeAsStringAsync(FILE, JSON.stringify(layout)); } catch { /* ignore */ }
}
