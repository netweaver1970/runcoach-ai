/** Persisted Biology-screen card layout: order + enabled, edited via the Customise sheet. Mirrors statsLayout. */
import * as FileSystem from 'expo-file-system';

export type BioCardId = 'weight' | 'bodyfat' | 'lean' | 'bp' | 'composition';

export interface BioCard { id: BioCardId; on: boolean }

export const BIO_CARD_TITLES: Record<BioCardId, string> = {
  weight:      'Weight',
  bodyfat:     'Body fat %',
  lean:        'Lean mass',
  bp:          'Blood pressure',
  composition: 'Fat vs lean change',
};

// Default order = the historical top-to-bottom order; everything enabled.
export const DEFAULT_BIO_LAYOUT: BioCard[] = [
  'weight', 'bodyfat', 'lean', 'bp', 'composition',
].map(id => ({ id: id as BioCardId, on: true }));

const ALL_IDS = DEFAULT_BIO_LAYOUT.map(c => c.id);
const FILE = `${FileSystem.documentDirectory}runcoach-bio-layout.json`;

/** Merge a saved layout with the defaults: drop unknown ids, append any NEW card (enabled) at the end. */
function reconcile(saved: BioCard[]): BioCard[] {
  const known = saved.filter(c => ALL_IDS.includes(c.id));
  const seen = new Set(known.map(c => c.id));
  const missing = DEFAULT_BIO_LAYOUT.filter(c => !seen.has(c.id));   // cards added since the layout was saved
  return [...known, ...missing];
}

export async function loadBioLayout(): Promise<BioCard[]> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (!info.exists) return DEFAULT_BIO_LAYOUT;
    const parsed = JSON.parse(await FileSystem.readAsStringAsync(FILE)) as BioCard[];
    if (Array.isArray(parsed) && parsed.length) return reconcile(parsed);
    return DEFAULT_BIO_LAYOUT;
  } catch { return DEFAULT_BIO_LAYOUT; }
}

export async function saveBioLayout(layout: BioCard[]): Promise<void> {
  try { await FileSystem.writeAsStringAsync(FILE, JSON.stringify(layout)); } catch { /* ignore */ }
}
