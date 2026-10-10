/**
 * SELF-LEARNING food matching (Geert 2026-10-10: "make the app self learning on missing food scanned via photos").
 * A phrase → food memory, used by the meal parser BEFORE the table search, for photos, typing and voice alike:
 *   • 'user' — you chose it: found a "still to find" part, or picked another match in the review list (strongest)
 *   • 'ai'   — the AI picked it from the app's own candidates for a photo item the search couldn't match; becomes
 *              'user' once you log it unchanged, is replaced as soon as you pick something else.
 * Kept in memory for the synchronous parser (loadLearned() on the Food screen) and persisted to
 * runcoach-food-learned.json. Snapshots let products / own foods resolve even when they're not in the bundled table.
 */
import * as FileSystem from 'expo-file-system';
import type { FoodItem } from './foodLog';
import { norm, foodByKey } from './foodDb';

export interface Learned { key: string; snap: FoodItem; by: 'user' | 'ai'; n: number; at: string }
const FILE = `${FileSystem.documentDirectory}runcoach-food-learned.json`;
let MEM: Record<string, Learned> = {};
let loaded = false;
let loading: Promise<void> | null = null;
let saving: Promise<void> = Promise.resolve();
/** Your own foods resolve LIVE (an edited own food logs its new values; a deleted one is no longer learned).
 *  Set by the Food screen from the library; returns null when the key no longer exists. */
let ownResolver: ((key: string) => FoodItem | null) | null = null;
export function setOwnResolver(fn: (key: string) => FoodItem | null): void { ownResolver = fn; }

/** The lookup key for a phrase: normalised, without articles / filler, singular-ish. */
export function learnKey(phrase: string): string {
  return norm(phrase).split(' ').filter(w => w && !/^(a|an|the|een|de|het|of|van|with|met)$/.test(w))
    .map(w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)).join(' ');
}

export function loadLearned(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!loading) loading = (async () => {
    try {
      const i = await FileSystem.getInfoAsync(FILE);
      if (i.exists) {
        const txt = await FileSystem.readAsStringAsync(FILE);
        try { MEM = JSON.parse(txt) ?? {}; }
        catch { await FileSystem.writeAsStringAsync(`${FILE}.bad`, txt).catch(() => {}); MEM = {}; }   // keep a corrupt file aside
      }
    } catch { MEM = {}; }
    loaded = true;
  })();
  return loading;
}
/** Saves run one after another (each writes the CURRENT memory), so an older copy can never land last. */
function save(): Promise<void> {
  saving = saving.then(() => FileSystem.writeAsStringAsync(FILE, JSON.stringify(MEM))).catch(() => {});
  return saving;
}

/** Synchronous lookup for the parser (empty until loadLearned() ran). The live table item wins over the snapshot. */
export function learnedFor(phrase: string): { item: FoodItem; by: 'user' | 'ai'; weak: boolean } | null {
  if (!loaded) return null;
  const k = learnKey(phrase);
  const e = MEM[k];
  if (!e) return null;
  let item: FoodItem | undefined = e.key.startsWith('ciqual:') || e.key.startsWith('builtin:') ? foodByKey(e.key) : undefined;
  if (!item && e.key.startsWith('custom:') && ownResolver) { const own = ownResolver(e.key); if (!own) return null; item = own; }
  // a ONE-word phrase ("rice", "milk") taught only once doesn't take over the table yet — it's offered, not assumed
  const weak = !k.includes(' ') && e.n < 2;
  return { item: item ?? e.snap, by: e.by, weak };
}

/** Remember phrase → food. A 'user' entry is never overwritten by an 'ai' one. */
export async function learn(phrase: string, item: FoodItem, by: 'user' | 'ai'): Promise<void> {
  const k = learnKey(phrase);
  if (!k || !item?.key) return;
  if (!loaded) await loadLearned();
  const cur = MEM[k];
  if (cur && cur.by === 'user' && by === 'ai') return;
  if (cur && cur.key === item.key && cur.by === by) { cur.n += 1; cur.at = new Date().toISOString(); }
  else {
    const snap: FoodItem = { key: item.key, src: item.src, id: item.id, name: item.name, per100: item.per100,
      ...(item.serving ? { serving: item.serving } : {}), ...(item.unit ? { unit: item.unit } : {}), ...(item.brand ? { brand: item.brand } : {}) };
    MEM[k] = { key: item.key, snap, by, n: (cur?.key === item.key ? cur.n : 0) + 1, at: new Date().toISOString() };
  }
  await save();
}

/** An AI-picked match that was logged unchanged → it's now a confirmed one. */
export async function confirmLearned(phrase: string, key: string): Promise<void> {
  const e = MEM[learnKey(phrase)];
  if (e && e.by === 'ai' && e.key === key) { e.by = 'user'; e.n += 1; await save(); }
}

export const learnedCount = () => Object.keys(MEM).length;
