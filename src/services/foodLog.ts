/**
 * Local-first food log + food library (nutrition Option A — docs/nutrition/REPORT.md §6.1).
 *
 * Files (documentDirectory, all in backup.ts):
 *   runcoach-food-log-YYYY-MM.json   monthly shard { v, days: { [date]: DayLog } }
 *   runcoach-food-library.json       custom foods, saved meals, favourites, recents (remembered serving + hours)
 * Days use the app's 4 am training-day attribution (a 01:00 snack belongs to the previous day).
 * Writes are MERGE-not-replace: every mutation re-reads the shard, changes one day, writes it back, and all
 * writes go through one serial queue so two quick taps can't clobber each other (the daily-components lesson).
 * Food data never goes to cloud sync or git; debug exports may only carry daily totals.
 */
import * as FileSystem from 'expo-file-system';
import { trainingDayKey } from './trainingLoad';
import { sportsByKey } from './foodSports';
import { markSupplementTaken } from './supplements';

/** Logging a built-in supplement (creatine, whey, electrolytes…) also ticks a matching supplement in the tracker. */
async function linkSupplements(keys: string[], t: string): Promise<void> {
  // the supplement tracker uses CALENDAR dates (todayISO), not the 4 am food day
  const cal = t.slice(0, 10);
  for (const k of keys) {
    const sp = sportsByKey(k)?.supp;
    if (sp) await markSupplementTaken(sp, cal).catch(() => undefined);
  }
}

export type NutrKey =
  | 'kcal' | 'prot' | 'carb' | 'fat' | 'sug' | 'fib' | 'sat' | 'salt' | 'na' | 'k' | 'ca' | 'fe' | 'mg'
  | 'water' | 'alc' | 'vitC' | 'vitD' | 'caf'
  | 'rs'    // resistant starch (g) — PART OF `carb` as labelled; not absorbed (gut-bacteria food), ~2 kcal/g instead of 4
  // minerals + vitamins (CIQUAL 2025 / Open Food Facts) — units in MICROS below
  | 'p' | 'se' | 'zn' | 'cu' | 'mn' | 'iod' | 'vitA' | 'vitE' | 'vitK' | 'b1' | 'b2' | 'b3' | 'b5' | 'b6' | 'b9' | 'b12';
export type Nutr = Partial<Record<NutrKey, number>>;
export type FoodSrc = 'ciqual' | 'off' | 'custom' | 'quick' | 'ai' | 'builtin';
export type EntryVia = 'search' | 'recent' | 'fav' | 'meal' | 'copy' | 'quick' | 'parse' | 'photo' | 'ean' | 'label' | 'suggest';

/** A food as it can be logged: nutrients PER 100 g (quick-add items carry absolute `n` instead). */
export interface FoodItem {
  key: string;            // `${src}:${id}`
  src: FoodSrc;
  id: string;
  name: string;
  nameAlt?: string;       // e.g. the French CIQUAL name
  brand?: string;
  grp?: string;
  per100: Nutr;
  serving?: { g: number; label: string };   // one piece / pack / can, in the item's unit (g or ml)
  unit?: 'g' | 'ml';      // how amounts are entered and shown; per100 then means per 100 ml. Absent = g
}

export interface FoodEntry {
  id: string;
  t: string;              // ISO timestamp (local wall time)
  key: string;
  name: string;
  src: FoodSrc;
  grams?: number;         // absent for quick-add. For a unit:'ml' item this is millilitres
  unit?: 'ml';            // display only: show the amount as ml
  n: Nutr;                // ABSOLUTE amounts for this entry
  via: EntryVia;
  confidence?: number;    // 0..1 for AI-derived entries
  groupId?: string;       // entries logged together (a saved meal, a copied meal, a parsed phrase)
  mealId?: string;        // logged from this SAVED meal (→ a meal edit / replacement can redo the logged instances)
  mealSkip?: string[];    // components of that meal left out when it was logged (the preview's unticked items)
  label?: string;         // the meal it belongs to as CHOSEN when adding ("Lunch") — else derived from the time
}
export const MEAL_LABELS = ['Breakfast', 'Lunch', 'Snack', 'Dinner', 'Evening snack'] as const;
/** The meal heading of a logged group: the label chosen when adding, else from the clock. */
export const entryMealLabel = (e: { t: string; label?: string }) => e.label ?? mealLabel(e.t);
export interface WaterEntry { id: string; t: string; ml: number }
export interface DayLog { date: string; entries: FoodEntry[]; water: WaterEntry[]; complete?: boolean }

export interface Recent {
  key: string; name: string; src: FoodSrc;
  per100?: Nutr;          // snapshot so the item can be re-logged even if it isn't in the bundled table
  n?: Nutr;               // quick-add items
  grams?: number;         // remembered serving
  unit?: 'g' | 'ml';
  serving?: { g: number; label: string };
  count: number;
  last: string;           // ISO
  hrs: number[];          // hours of day it was logged (last 30), for "usually now" chips
}
export interface SavedMealItem { key: string; name: string; src: FoodSrc; grams?: number; per100?: Nutr; n?: Nutr; unit?: 'ml' }
export interface SavedMeal { id: string; name: string; items: SavedMealItem[]; count: number; last?: string; hrs: number[] }
/** A favourite keeps its own snapshot so it survives dropping out of recents and works for OFF/custom foods. */
export interface FavItem { key: string; name: string; src: FoodSrc; per100?: Nutr; n?: Nutr; grams?: number; unit?: 'g' | 'ml'; serving?: { g: number; label: string } }
export interface FoodLibrary { v: 1; custom: FoodItem[]; meals: SavedMeal[]; favs: string[]; favItems?: Record<string, FavItem>; recents: Recent[];
  servings?: Record<string, { g: number; label: string }>;   // YOUR serving size per food key (beats the label/table default)
  tags?: Record<string, MealTag[]>;          // meal types per food key (multi: a yoghurt can be breakfast AND snack)
  kept?: Record<string, FavItem>;            // snapshots of foods you maintain in "My foods" (starred / tagged) without logging
  rs?: Record<string, number>;               // YOUR resistant starch (g / 100) for non-own foods (see netNutr)
  caf?: Record<string, number>;              // YOUR caffeine (mg / 100) for non-own foods (table / product values are typical)
}
/** Meal types a food can be tagged with (several per food). */
export type MealTag = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export const MEAL_TAGS: { id: MealTag; label: string; short: string }[] = [
  { id: 'breakfast', label: 'Breakfast', short: 'B' }, { id: 'lunch', label: 'Lunch', short: 'L' },
  { id: 'dinner', label: 'Dinner', short: 'D' }, { id: 'snack', label: 'Snack', short: 'S' },
];
/** The meal type of a moment (same clock as mealLabel). */
export function mealTagAt(t: string | Date = new Date()): MealTag {
  const h = new Date(t).getHours();   // whole hours, exactly like mealLabel (its 10.5 / 14.5 … compare hours too)
  return h < 4 ? 'snack' : h < 10.5 ? 'breakfast' : h < 14.5 ? 'lunch' : h < 17.5 ? 'snack' : h < 21.5 ? 'dinner' : 'snack';
}
/** In-memory mirror of FoodLibrary.servings so the sync defaultServing() can honour your own serving sizes. */
export const servingOverrides: Record<string, { g: number; label: string }> = {};
const syncServings = (l: FoodLibrary) => {
  for (const k of Object.keys(servingOverrides)) delete servingOverrides[k];
  Object.assign(servingOverrides, l.servings ?? {});
  for (const k of Object.keys(rsOverrides)) delete rsOverrides[k];
  Object.assign(rsOverrides, l.rs ?? {});
  for (const k of Object.keys(cafOverrides)) delete cafOverrides[k];
  Object.assign(cafOverrides, l.caf ?? {});
};

const DIR = FileSystem.documentDirectory;
export const FOOD_LOG_PREFIX = 'runcoach-food-log-';
export const FOOD_LIBRARY_FILE = 'runcoach-food-library.json';
const shardFile = (date: string) => `${DIR}${FOOD_LOG_PREFIX}${date.slice(0, 7)}.json`;
const LIB = `${DIR}${FOOD_LIBRARY_FILE}`;
const MAX_RECENTS = 200;

// ─── helpers ──────────────────────────────────────────────────────────────────────────────────────
export const NUTR_KEYS: NutrKey[] = ['kcal', 'prot', 'carb', 'fat', 'sug', 'fib', 'sat', 'salt', 'na', 'k', 'ca', 'fe', 'mg', 'water', 'alc', 'vitC', 'vitD', 'caf', 'rs',
  'p', 'se', 'zn', 'cu', 'mn', 'iod', 'vitA', 'vitE', 'vitK', 'b1', 'b2', 'b3', 'b5', 'b6', 'b9', 'b12'];

/**
 * Minerals & vitamins with the EU daily reference (NRV, Regulation 1169/2011 Annex XIII — the "% RI" on EU labels;
 * sodium has none, the salt RI of 6 g ≈ 2.4 g sodium is used). Values per food come from CIQUAL 2025 (Anses) or
 * Open Food Facts; a food without a measured value contributes nothing (shown as coverage).
 */
export const MICROS: { k: NutrKey; label: string; unit: 'mg' | 'µg'; nrv: number; group: 'mineral' | 'vitamin' }[] = [
  { k: 'na', label: 'Sodium', unit: 'mg', nrv: 2400, group: 'mineral' }, { k: 'k', label: 'Potassium', unit: 'mg', nrv: 2000, group: 'mineral' },
  { k: 'ca', label: 'Calcium', unit: 'mg', nrv: 800, group: 'mineral' }, { k: 'p', label: 'Phosphorus', unit: 'mg', nrv: 700, group: 'mineral' },
  { k: 'mg', label: 'Magnesium', unit: 'mg', nrv: 375, group: 'mineral' }, { k: 'fe', label: 'Iron', unit: 'mg', nrv: 14, group: 'mineral' },
  { k: 'zn', label: 'Zinc', unit: 'mg', nrv: 10, group: 'mineral' }, { k: 'cu', label: 'Copper', unit: 'mg', nrv: 1, group: 'mineral' },
  { k: 'mn', label: 'Manganese', unit: 'mg', nrv: 2, group: 'mineral' }, { k: 'se', label: 'Selenium', unit: 'µg', nrv: 55, group: 'mineral' },
  { k: 'iod', label: 'Iodine', unit: 'µg', nrv: 150, group: 'mineral' },
  { k: 'vitA', label: 'Vitamin A', unit: 'µg', nrv: 800, group: 'vitamin' }, { k: 'vitD', label: 'Vitamin D', unit: 'µg', nrv: 5, group: 'vitamin' },
  { k: 'vitE', label: 'Vitamin E', unit: 'mg', nrv: 12, group: 'vitamin' }, { k: 'vitK', label: 'Vitamin K', unit: 'µg', nrv: 75, group: 'vitamin' },
  { k: 'vitC', label: 'Vitamin C', unit: 'mg', nrv: 80, group: 'vitamin' }, { k: 'b1', label: 'B1 thiamine', unit: 'mg', nrv: 1.1, group: 'vitamin' },
  { k: 'b2', label: 'B2 riboflavin', unit: 'mg', nrv: 1.4, group: 'vitamin' }, { k: 'b3', label: 'B3 niacin', unit: 'mg', nrv: 16, group: 'vitamin' },
  { k: 'b5', label: 'B5 pantothenic acid', unit: 'mg', nrv: 6, group: 'vitamin' }, { k: 'b6', label: 'B6', unit: 'mg', nrv: 1.4, group: 'vitamin' },
  { k: 'b9', label: 'B9 folate', unit: 'µg', nrv: 200, group: 'vitamin' }, { k: 'b12', label: 'B12', unit: 'µg', nrv: 2.5, group: 'vitamin' },
];

/**
 * Resistant starch (Geert 2026-10-08, raw potato starch): it's in the label's carbs but isn't digested in the small
 * intestine — the colon's bacteria ferment it (~2 kcal/g, no glucose). So for the day it comes OFF the available carbs
 * and is counted at 2 instead of 4 kcal/g. Applied wherever amounts are summed or shown; the stored entry keeps the
 * label values + its `rs`.
 */
export function netNutr(n: Nutr): Nutr {
  const rs = n.rs ?? 0;
  if (!rs) return n;
  return { ...n, carb: Math.max(0, (n.carb ?? 0) - rs), ...(n.kcal != null ? { kcal: Math.max(0, n.kcal - 2 * rs) } : {}) };
}
/** YOUR resistant-starch value (g per 100) for a food-table / product food (own foods carry it in per100). */
export const rsOverrides: Record<string, number> = {};
export const cafOverrides: Record<string, number> = {};
/** per100 with YOUR resistant-starch / caffeine values merged in (logging uses this). */
export const withRs = (key: string, per100: Nutr): Nutr => (rsOverrides[key] == null && cafOverrides[key] == null ? per100
  : { ...per100, ...(rsOverrides[key] != null ? { rs: rsOverrides[key] } : {}), ...(cafOverrides[key] != null ? { caf: cafOverrides[key] } : {}) });

export function scaleNutr(per100: Nutr, grams: number): Nutr {
  const out: Nutr = {};
  for (const k of NUTR_KEYS) { const v = per100[k]; if (typeof v === 'number') out[k] = Math.round(v * grams / 100 * 100) / 100; }
  return out;
}
export function sumNutr(list: Nutr[]): Nutr {
  const out: Nutr = {};
  for (const n0 of list) {
    const n = netNutr(n0);   // available carbs / energy (resistant starch out)
    for (const k of NUTR_KEYS) { const v = n[k]; if (typeof v === 'number') out[k] = (out[k] ?? 0) + v; }
  }
  return out;
}
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const hourOf = (iso: string) => new Date(iso).getHours();
/** Local ISO without the Z: what the user sees is what's stored. */
export function localIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
export const foodDayOf = (iso: string) => trainingDayKey(new Date(iso).getTime());
export const todayFoodDay = () => trainingDayKey(Date.now());

/**
 * When logging "now" into a day that isn't today, pick a timestamp that still belongs to that day under the
 * 4 am rule: the current clock time on that date, or 12:00 if the clock is before 04:00.
 */
export function timeForDay(date: string, now = new Date()): string {
  if (date === trainingDayKey(now.getTime())) return localIso(now);
  const [y, m, d] = date.split('-').map(Number);
  const h = now.getHours() < 4 ? 12 : now.getHours();
  return localIso(new Date(y, m - 1, d, h, now.getMinutes(), 0));
}

// ─── serial write queue ───────────────────────────────────────────────────────────────────────────
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);   // a failed op doesn't block the queue; its error still reaches the caller
  chain = next.catch(() => undefined);
  return next;
}

/**
 * The fallback is returned ONLY when the file doesn't exist. A read or parse error THROWS, so a mutation never
 * rewrites a shard/library from a failed read (that would silently wipe a month of log / all saved meals).
 */
async function readJson<T>(path: string, fallback: T): Promise<T> {
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) return fallback;
  return JSON.parse(await FileSystem.readAsStringAsync(path)) as T;
}
async function writeJson(path: string, v: unknown): Promise<void> {
  await FileSystem.writeAsStringAsync(path, JSON.stringify(v));
}

// ─── day log ──────────────────────────────────────────────────────────────────────────────────────
interface Shard { v: 1; days: Record<string, DayLog> }
const emptyDay = (date: string): DayLog => ({ date, entries: [], water: [] });

export async function loadDay(date: string): Promise<DayLog> {
  let sh: Shard;
  try { sh = await readJson<Shard>(shardFile(date), { v: 1, days: {} }); }
  catch { return emptyDay(date); }                      // display only — mutations re-read and throw instead
  const d = sh.days?.[date];
  return d ? { ...emptyDay(date), ...d, entries: [...(d.entries ?? [])].sort((a, b) => a.t.localeCompare(b.t)), water: d.water ?? [] } : emptyDay(date);
}

/** Read-modify-write ONE day inside its shard — UNQUEUED; only call from inside serial(). */
async function rmwDay(date: string, fn: (d: DayLog) => void): Promise<DayLog> {
  const path = shardFile(date);
  const sh = await readJson<Shard>(path, { v: 1, days: {} });
  if (!sh.days) sh.days = {};
  const day = sh.days[date] ? { ...emptyDay(date), ...sh.days[date] } : emptyDay(date);
  day.entries = [...(day.entries ?? [])]; day.water = [...(day.water ?? [])];
  fn(day);
  day.entries.sort((a, b) => a.t.localeCompare(b.t));
  sh.days[date] = day;
  await writeJson(path, sh);
  return day;
}
/** Queued read-modify-write of one day (never rewrites other days from a partial read). */
function mutateDay(date: string, fn: (d: DayLog) => void): Promise<DayLog> {
  return serial(() => rmwDay(date, fn));
}

/** Log a food by grams (per-100 g item) or a quick-add item with absolute nutrients. Returns the new entry. */
export async function logFood(
  item: FoodItem | { key: string; name: string; src: FoodSrc; n: Nutr },
  opts: { grams?: number; t?: string; via: EntryVia; groupId?: string; confidence?: number; date?: string; label?: string },
): Promise<FoodEntry> {
  const t = opts.t ?? (opts.date ? timeForDay(opts.date) : localIso(new Date()));
  const date = foodDayOf(t);
  const n = 'per100' in item && opts.grams != null ? scaleNutr(withRs(item.key, item.per100), opts.grams) : ('n' in item ? item.n : {});
  const e: FoodEntry = {
    id: uid(), t, key: item.key, name: item.name, src: item.src, n, via: opts.via,
    ...(opts.grams != null ? { grams: opts.grams } : {}),
    ...('unit' in item && item.unit === 'ml' ? { unit: 'ml' as const } : {}),
    ...(opts.groupId ? { groupId: opts.groupId } : {}),
    ...(opts.label ? { label: opts.label } : {}),
    ...(opts.confidence != null ? { confidence: opts.confidence } : {}),
  };
  await mutateDay(date, d => { d.entries.push(e); });
  await touchRecent(item, opts.grams, t).catch(() => undefined);   // the entry is saved; recents are a convenience
  await linkSupplements([item.key], t);
  return e;
}

/** Log several items as ONE atomic write (a parsed phrase): all or nothing, one groupId. */
export async function logFoods(items: { item: FoodItem; grams: number }[], opts: { via: EntryVia; date: string; groupId?: string; t?: string; label?: string }): Promise<FoodEntry[]> {
  const t = opts.t ?? timeForDay(opts.date);   // t = add INTO an existing meal (its time)
  const groupId = opts.groupId ?? uid();
  const out: FoodEntry[] = items.map(({ item, grams }) => ({
    id: uid(), t, key: item.key, name: item.name, src: item.src, n: scaleNutr(withRs(item.key, item.per100), grams), grams, via: opts.via, groupId,
    ...(item.unit === 'ml' ? { unit: 'ml' as const } : {}), ...(opts.label ? { label: opts.label } : {}),
  }));
  await mutateDay(foodDayOf(t), d => { d.entries.push(...out); });
  for (const { item, grams } of items) await touchRecent(item, grams, t).catch(() => undefined);
  await linkSupplements(items.map(x => x.item.key), t);
  return out;
}

export async function updateEntry(date: string, id: string, patch: { grams?: number; t?: string; per100?: Nutr }): Promise<void> {
  // Read + write(s) in ONE queued step. A time edit can move the entry to another day (4 am rule): ADD to the new
  // day first, then remove from the old one — a kill in between leaves a duplicate, never a lost entry.
  let key: string | undefined;
  await serial(async () => {
    const sh = await readJson<Shard>(shardFile(date), { v: 1, days: {} });
    const e = sh.days?.[date]?.entries?.find(x => x.id === id);
    if (!e) return;                                     // deleted meanwhile (e.g. undo) → don't resurrect
    key = e.key;
    const next: FoodEntry = { ...e };
    if (patch.grams != null && e.grams && e.grams > 0) {
      const per100 = patch.per100 ?? Object.fromEntries(Object.entries(e.n).map(([k, v]) => [k, (v as number) * 100 / e.grams!])) as Nutr;
      next.n = scaleNutr(per100, patch.grams);
      next.grams = patch.grams;
    }
    if (patch.t) next.t = patch.t;
    const newDate = foodDayOf(next.t);
    if (newDate === date) await rmwDay(date, d => { d.entries = d.entries.map(x => (x.id === id ? next : x)); });
    else {
      await rmwDay(newDate, d => { d.entries.push(next); });
      await rmwDay(date, d => { d.entries = d.entries.filter(x => x.id !== id); });
    }
  });
  if (key && patch.grams != null) await rememberServing(key, patch.grams).catch(() => undefined);   // entry saved; bookkeeping only
}

export async function removeEntries(date: string, ids: string[]): Promise<void> {
  const set = new Set(ids);
  await mutateDay(date, d => { d.entries = d.entries.filter(x => !set.has(x.id)); d.water = d.water.filter(x => !set.has(x.id)); });
}

export async function addWater(date: string, ml: number, t?: string): Promise<WaterEntry> {
  const w: WaterEntry = { id: uid(), t: t ?? timeForDay(date), ml };
  await mutateDay(date, d => { d.water.push(w); });
  return w;
}

export async function setDayComplete(date: string, complete: boolean): Promise<void> {
  await mutateDay(date, d => { d.complete = complete; });
}

/** Copy entries (e.g. yesterday's breakfast) into another day, keeping their time of day unless `t` is given. */
export async function copyEntries(entries: FoodEntry[], toDate: string, t?: string): Promise<FoodEntry[]> {
  const groupId = uid();
  const out: FoodEntry[] = entries.map(e => {
    let when = t;
    if (!when) {
      const src = new Date(e.t);
      const [y, m, d] = toDate.split('-').map(Number);
      const day = new Date(y, m - 1, d, src.getHours(), src.getMinutes(), 0);
      if (src.getHours() < 4) day.setDate(day.getDate() + 1);       // keep 4 am attribution
      when = localIso(day);
    }
    return { ...e, id: uid(), t: when, via: 'copy' as EntryVia, groupId };
  });
  await mutateDay(toDate, d => { d.entries.push(...out); });
  return out;
}

export function dayTotals(d: DayLog): Nutr & { waterMl: number } {
  return { ...sumNutr(d.entries.map(e => e.n)), waterMl: d.water.reduce((s, w) => s + w.ml, 0) };
}

/** Group a day's entries into "meals": entries sharing a groupId, or logged within 45 min of each other. */
export function groupMeals(entries: FoodEntry[]): FoodEntry[][] {
  const sorted = [...entries].sort((a, b) => a.t.localeCompare(b.t));
  const out: FoodEntry[][] = [];
  for (const e of sorted) {
    const cur = out[out.length - 1];
    const lastT = cur ? new Date(cur[cur.length - 1].t).getTime() : 0;
    if (cur && ((e.groupId && cur.some(x => x.groupId === e.groupId)) || new Date(e.t).getTime() - lastT <= 45 * 60_000)) cur.push(e);
    else out.push([e]);
  }
  return out;
}
export function mealLabel(t: string): string {
  const h = new Date(t).getHours();
  return h < 4 ? 'Late snack' : h < 10.5 ? 'Breakfast' : h < 14.5 ? 'Lunch' : h < 17.5 ? 'Snack' : h < 21.5 ? 'Dinner' : 'Evening snack';
}

// ─── library ──────────────────────────────────────────────────────────────────────────────────────
const emptyLib = (): FoodLibrary => ({ v: 1, custom: [], meals: [], favs: [], recents: [] });
export async function loadLibrary(): Promise<FoodLibrary> {
  try { const l = { ...emptyLib(), ...(await readJson<FoodLibrary>(LIB, emptyLib())) }; syncServings(l); return l; }
  catch { return emptyLib(); }                          // display only; mutations throw instead of overwriting
}
function mutateLib(fn: (l: FoodLibrary) => void): Promise<FoodLibrary> {
  return serial(async () => {
    const l = { ...emptyLib(), ...(await readJson<FoodLibrary>(LIB, emptyLib())) };
    fn(l);
    await writeJson(LIB, l);
    syncServings(l);
    return l;
  });
}

async function touchRecent(item: FoodItem | { key: string; name: string; src: FoodSrc; n: Nutr }, grams: number | undefined, t: string): Promise<void> {
  await mutateLib(l => {
    const i = l.recents.findIndex(r => r.key === item.key);
    const prev = i >= 0 ? l.recents[i] : undefined;
    const r: Recent = {
      key: item.key, name: item.name, src: item.src,
      ...('per100' in item ? { per100: item.per100 } : { n: item.n }),
      ...('unit' in item && item.unit ? { unit: item.unit } : prev?.unit ? { unit: prev.unit } : {}),
      ...('serving' in item && item.serving ? { serving: item.serving } : prev?.serving ? { serving: prev.serving } : {}),
      grams: grams ?? prev?.grams,
      count: (prev?.count ?? 0) + 1,
      last: t,
      hrs: [...(prev?.hrs ?? []), hourOf(t)].slice(-30),
    };
    if (i >= 0) l.recents.splice(i, 1);
    l.recents.unshift(r);
    l.recents = l.recents.slice(0, MAX_RECENTS);
  });
}
export async function rememberServing(key: string, grams: number): Promise<void> {
  await mutateLib(l => { const r = l.recents.find(x => x.key === key); if (r) r.grams = grams; });
}
/**
 * Set (or clear with null) YOUR serving size for a food — e.g. a 240 g yoghurt drink bottle whose table/label default
 * is 100 g. Stored per food key; defaultServing(), the portion panel and one-tap re-logs use it from then on.
 */
export async function setServing(key: string, serving: { g: number; label: string } | null): Promise<void> {
  await mutateLib(l => {
    const m = { ...(l.servings ?? {}) };
    if (serving && serving.g > 0) m[key] = serving; else delete m[key];
    l.servings = m;   // snapshots (custom/recent/fav) stay untouched → Reset falls back to the label serving
  });
}
/**
 * "My foods" — foods maintained on their own, independent of logging (Geert 2026-10-08: star / tag foods without first
 * adding them to a meal or a day; select one or many at once). The snapshot keeps a food listed and re-loggable.
 */
export interface KeptFood { key: string; snap: Omit<FavItem, 'key'> }
const keep = (l: FoodLibrary, f: KeptFood) => { if (!l.kept?.[f.key]) l.kept = { ...(l.kept ?? {}), [f.key]: { key: f.key, ...f.snap } }; };
/** Star / un-star several foods at once. */
export async function setFavourites(foods: KeptFood[], on: boolean): Promise<FoodLibrary> {
  return mutateLib(l => {
    const keys = new Set(foods.map(f => f.key));
    if (on) {
      l.favs = [...l.favs, ...foods.map(f => f.key).filter(k => !l.favs.includes(k))];
      const items = { ...(l.favItems ?? {}) };
      for (const f of foods) { if (!items[f.key]) items[f.key] = { key: f.key, ...f.snap }; keep(l, f); }
      l.favItems = items;
    } else {
      l.favs = l.favs.filter(k => !keys.has(k));
      const items = { ...(l.favItems ?? {}) };
      for (const k of keys) delete items[k];
      l.favItems = items;
      for (const f of foods) keep(l, f);   // still listed in My foods (re-star it there)
    }
  });
}
/** Meal tags for several foods: add / remove these tags, or set exactly these. */
export async function setMealTags(foods: KeptFood[], tags: MealTag[], mode: 'add' | 'remove' | 'set'): Promise<FoodLibrary> {
  return mutateLib(l => {
    const all = { ...(l.tags ?? {}) };
    for (const f of foods) {
      const cur = new Set(all[f.key] ?? []);
      if (mode === 'set') { cur.clear(); tags.forEach(t => cur.add(t)); }
      else if (mode === 'add') tags.forEach(t => cur.add(t));
      else tags.forEach(t => cur.delete(t));
      const next = MEAL_TAGS.map(m => m.id).filter(id => cur.has(id));
      if (next.length) { all[f.key] = next; keep(l, f); } else delete all[f.key];
    }
    l.tags = all;
  });
}
/** Stop maintaining a food in "My foods" (un-star, untag, drop the snapshot; a custom food stays in its own list). */
export async function forgetFoods(keys: string[]): Promise<FoodLibrary> {
  return mutateLib(l => {
    const ks = new Set(keys);
    l.favs = l.favs.filter(k => !ks.has(k));
    const fi = { ...(l.favItems ?? {}) }, tg = { ...(l.tags ?? {}) }, kp = { ...(l.kept ?? {}) };
    for (const k of ks) { delete fi[k]; delete tg[k]; delete kp[k]; }
    l.favItems = fi; l.tags = tg; l.kept = kp;
    l.recents = l.recents.filter(r => !ks.has(r.key));
  });
}
export async function toggleFav(key: string, snap?: Omit<FavItem, 'key'>): Promise<boolean> {
  let on = false;
  await mutateLib(l => {
    on = !l.favs.includes(key);
    l.favs = on ? [...l.favs, key] : l.favs.filter(k => k !== key);
    const items = { ...(l.favItems ?? {}) };
    if (on && snap) items[key] = { key, ...snap }; else if (!on) delete items[key];
    l.favItems = items;
  });
  return on;
}
/** Favourites as re-loggable items: own snapshot → recent → (caller may fall back to the table by key). */
export function favouriteList(l: FoodLibrary): FavItem[] {
  const out: FavItem[] = [];
  for (const k of l.favs) {
    const snap = l.favItems?.[k];
    const r = l.recents.find(x => x.key === k);
    if (snap) out.push({ ...snap, grams: r?.grams ?? snap.grams });
    else if (r) out.push({ key: r.key, name: r.name, src: r.src, per100: r.per100, n: r.n, grams: r.grams, ...(r.unit ? { unit: r.unit } : {}), ...(r.serving ? { serving: r.serving } : {}) });
  }
  return out;
}

export async function saveMeal(name: string, entries: FoodEntry[]): Promise<SavedMeal> {
  const meal: SavedMeal = {
    id: uid(), name: name.trim() || 'Meal', count: 0, hrs: entries.length ? [hourOf(entries[0].t)] : [],
    items: entries.map(e => (e.grams && e.grams > 0
      ? { key: e.key, name: e.name, src: e.src, grams: e.grams, ...(e.unit ? { unit: e.unit } : {}), per100: Object.fromEntries(Object.entries(e.n).map(([k, v]) => [k, (v as number) * 100 / e.grams!])) as Nutr }
      : { key: e.key, name: e.name, src: e.src, n: e.n })),
  };
  await mutateLib(l => { l.meals.unshift(meal); });
  return meal;
}
/** A food from a pack label (the 7 EU-mandatory values + fibre), saved locally. Returns the new item. */
export async function addCustomFood(f: { name: string; brand?: string; ean?: string; per100: Nutr; unit?: 'g' | 'ml'; serving?: { g: number; label: string } }): Promise<FoodItem> {
  const id = f.ean && /^\d{8,14}$/.test(f.ean) ? `ean${f.ean}` : uid();
  const item: FoodItem = {
    key: `custom:${id}`, src: 'custom', id, name: f.name.trim() || 'My food', ...(f.brand ? { brand: f.brand } : {}), per100: f.per100,
    ...(f.unit === 'ml' ? { unit: 'ml' as const } : {}), ...(f.serving && f.serving.g > 0 ? { serving: f.serving } : {}),
  };
  await mutateLib(l => { l.custom = [item, ...l.custom.filter(c => c.key !== item.key)]; });
  return item;
}
/** Custom foods whose name/brand contains every query word (prefix match). */
export function searchCustom(l: FoodLibrary, query: string, normFn: (s: string) => string): FoodItem[] {
  const q = normFn(query).split(' ').filter(Boolean);
  if (!q.length) return [];
  return l.custom.filter(c => { const w = normFn(`${c.name} ${c.brand ?? ''}`).split(' '); return q.every(t => w.some(x => x.startsWith(t))); }).slice(0, 5);
}

/** Edit one of your own foods (name / brand / unit / per-100 values / serving). */
export async function updateCustomFood(key: string, patch: { name?: string; brand?: string; per100?: Nutr; unit?: 'g' | 'ml'; serving?: { g: number; label: string } | null }): Promise<FoodLibrary> {
  return mutateLib(l => {
    l.custom = l.custom.map(c => {
      if (c.key !== key) return c;
      const n: FoodItem = { ...c, ...(patch.name != null ? { name: patch.name.trim() || c.name } : {}), ...(patch.per100 ? { per100: patch.per100 } : {}) };
      if (patch.brand !== undefined) { if (patch.brand.trim()) n.brand = patch.brand.trim(); else delete n.brand; }
      if (patch.unit) { if (patch.unit === 'ml') n.unit = 'ml'; else delete n.unit; }
      if (patch.serving !== undefined) { if (patch.serving && patch.serving.g > 0) n.serving = patch.serving; else delete n.serving; }
      return n;
    });
    // keep the snapshots that list / re-log it in step
    const c = l.custom.find(x => x.key === key);
    if (c) {
      const snap = { name: c.name, per100: c.per100, ...(c.unit ? { unit: c.unit } : {}), ...(c.serving ? { serving: c.serving } : {}) };
      if (l.favItems?.[key]) l.favItems = { ...l.favItems, [key]: { ...l.favItems[key], ...snap } };
      if (l.kept?.[key]) l.kept = { ...l.kept, [key]: { ...l.kept[key], ...snap } };
      l.recents = l.recents.map(r => (r.key === key ? { ...r, ...snap } : r));
    }
  });
}
/** Delete one of your own foods everywhere in the library (logged days keep their copies). */
export async function deleteCustomFood(key: string): Promise<FoodLibrary> {
  return mutateLib(l => {
    l.custom = l.custom.filter(c => c.key !== key);
    l.favs = l.favs.filter(k => k !== key);
    const fi = { ...(l.favItems ?? {}) }, tg = { ...(l.tags ?? {}), }, kp = { ...(l.kept ?? {}) };
    delete fi[key]; delete tg[key]; delete kp[key];
    l.favItems = fi; l.tags = tg; l.kept = kp;
    l.recents = l.recents.filter(r => r.key !== key);
    if (l.servings?.[key]) { const sv = { ...l.servings }; delete sv[key]; l.servings = sv; }
  });
}
/** Set (null = clear) your resistant-starch value (g per 100) for a food-table / product food. */
export async function setResistantStarch(key: string, g: number | null): Promise<void> {
  await mutateLib(l => { const m = { ...(l.rs ?? {}) }; if (g != null && g > 0) m[key] = g; else delete m[key]; l.rs = m; });
}
// ─── one-for-one replacement / rename across the logged days (Geert 2026-10-08) ───────────────────────────────────
async function shardPaths(): Promise<string[]> {
  if (!DIR) return [];
  const files = await FileSystem.readDirectoryAsync(DIR).catch(() => [] as string[]);
  return files.filter(f => f.startsWith(FOOD_LOG_PREFIX) && f.endsWith('.json')).map(f => `${DIR}${f}`);
}
/** Where a food is used: logged entries (and on how many days) + saved meals containing it. */
export async function foodUsage(key: string): Promise<{ entries: number; days: number; meals: string[] }> {
  let entries = 0; const days = new Set<string>();
  for (const p of await shardPaths()) {
    const sh = await readJson<Shard>(p, { v: 1, days: {} }).catch(() => ({ v: 1 as const, days: {} }));
    for (const [d, day] of Object.entries(sh.days ?? {})) for (const e of day.entries ?? []) if (e.key === key) { entries++; days.add(d); }
  }
  const lib = await loadLibrary();
  return { entries, days: days.size, meals: lib.meals.filter(m => m.items.some(i => i.key === key)).map(m => m.name) };
}
/**
 * Re-point every use of a food to another one: logged entries keep their NUMBERS (what was eaten stays correct) and
 * take the new food's key + name; saved meals take the new food (its values from now on); star / tags / serving /
 * resistant-starch settings move over when the new food has none. Used for "delete, but replace by …".
 */
export async function replaceFoodEverywhere(oldKey: string, to: { key: string; name: string; src: FoodSrc; per100?: Nutr; unit?: 'g' | 'ml' }): Promise<number> {
  let n = 0;
  await serial(async () => {
    for (const p of await shardPaths()) {
      const sh = await readJson<Shard>(p, { v: 1, days: {} });
      let changed = false;
      for (const day of Object.values(sh.days ?? {})) for (const e of day.entries ?? []) {
        if (e.key !== oldKey) continue;
        // FULL replacement (Geert 2026-10-08): the new food's values, recalculated for the logged amount
        e.key = to.key; e.name = to.name; e.src = to.src;
        if (to.per100 && e.grams != null) e.n = scaleNutr(withRs(to.key, to.per100), e.grams);
        if (to.unit === 'ml') e.unit = 'ml'; else delete e.unit;
        n++; changed = true;
      }
      if (changed) await writeJson(p, sh);
    }
  });
  await mutateLib(l => {
    l.meals = l.meals.map(m => ({ ...m, items: m.items.map(i => (i.key !== oldKey ? i
      : { ...i, key: to.key, name: to.name, src: to.src, ...(to.per100 ? { per100: to.per100 } : {}), ...(to.unit === 'ml' ? { unit: 'ml' as const } : {}) })) }));
    if (to.key === oldKey) return;   // a value correction of the SAME food: nothing to move (keep its tags / recents)
    const move = <T,>(rec: Record<string, T> | undefined): Record<string, T> | undefined => {
      if (!rec || rec[oldKey] === undefined) return rec;
      const r = { ...rec }; if (r[to.key] === undefined) r[to.key] = r[oldKey]; delete r[oldKey]; return r;
    };
    if (l.favs.includes(oldKey)) l.favs = [...l.favs.filter(k => k !== oldKey && k !== to.key), to.key];
    l.tags = move(l.tags); l.servings = move(l.servings); l.rs = move(l.rs); l.caf = move(l.caf);
    l.recents = l.recents.filter(r => r.key !== oldKey);
  });
  return n;
}
// ─── saved meals on the logged days: find the logged instances, redo them from a (new / edited) meal ──────────────
interface MealInstance { path: string; date: string; groupId: string; t: string; ids: string[]; skip: string[] }
/** Logged instances of a saved meal: entries carrying its id, or (logged before ids were kept) a meal-logged group
 *  whose foods are all components of it (≥ 2, ≥ half of them). */
async function mealInstances(meal: SavedMeal): Promise<MealInstance[]> {
  const keys = new Set(meal.items.map(i => i.key));
  const out: MealInstance[] = [];
  for (const p of await shardPaths()) {
    const sh = await readJson<Shard>(p, { v: 1, days: {} }).catch(() => ({ v: 1 as const, days: {} }));
    for (const [date, day] of Object.entries(sh.days ?? {})) {
      const groups = new Map<string, FoodEntry[]>();
      for (const e of day.entries ?? []) if (e.groupId) groups.set(e.groupId, [...(groups.get(e.groupId) ?? []), e]);
      for (const [gid, es] of groups) {
        const tagged = es.some(e => e.mealId === meal.id);
        const legacy = !es.some(e => e.mealId) && es.every(e => (e.via === 'meal' || e.via === 'suggest') && keys.has(e.key))
          && es.length >= Math.min(2, keys.size) && es.length * 2 >= keys.size;
        if (!tagged && !legacy) continue;
        const own = tagged ? es.filter(e => e.mealId === meal.id) : es;
        const skip = tagged ? (own[0].mealSkip ?? []) : [...keys].filter(k => !es.some(e => e.key === k));
        out.push({ path: p, date, groupId: gid, t: own[0].t, ids: own.map(e => e.id), skip });
      }
    }
  }
  return out;
}
export async function mealUsage(meal: SavedMeal): Promise<{ instances: number; days: number }> {
  const ins = await mealInstances(meal);
  return { instances: ins.length, days: new Set(ins.map(i => i.date)).size };
}
/**
 * Redo every logged instance of `oldMeal` from `newMeal` (a replacement, or the same meal after an edit): its entries
 * are removed and the new meal's components are logged in their place (same time + group), values RECALCULATED; a
 * component left out at the time (unticked) stays out. Returns the number of instances redone.
 */
export async function relogMealEverywhere(oldMeal: SavedMeal, newMeal: SavedMeal): Promise<number> {
  const ins = await mealInstances(oldMeal);
  if (!ins.length) return 0;
  await serial(async () => {
    const byPath = new Map<string, MealInstance[]>();
    for (const i of ins) byPath.set(i.path, [...(byPath.get(i.path) ?? []), i]);
    for (const [p, list] of byPath) {
      const sh = await readJson<Shard>(p, { v: 1, days: {} });
      for (const i of list) {
        const day = sh.days[i.date];
        if (!day) continue;
        const drop = new Set(i.ids);
        const fresh: FoodEntry[] = newMeal.items.filter(it => !i.skip.includes(it.key)).map(it => ({
          id: uid(), t: i.t, key: it.key, name: it.name, src: it.src, via: 'meal' as EntryVia, groupId: i.groupId, mealId: newMeal.id,
          ...(i.skip.length ? { mealSkip: i.skip } : {}),
          n: it.per100 && it.grams != null ? scaleNutr(withRs(it.key, it.per100), it.grams) : (it.n ?? {}),
          ...(it.grams != null ? { grams: it.grams } : {}), ...(it.unit ? { unit: it.unit } : {}),
        }));
        day.entries = [...day.entries.filter(e => !drop.has(e.id)), ...fresh];
      }
      await writeJson(p, sh);
    }
  });
  return ins.length;
}
/** Your own food was renamed → the logged entries show the new name too (values untouched). */
export async function renameInLogs(key: string, name: string): Promise<void> {
  await serial(async () => {
    for (const p of await shardPaths()) {
      const sh = await readJson<Shard>(p, { v: 1, days: {} });
      let changed = false;
      for (const day of Object.values(sh.days ?? {})) for (const e of day.entries ?? []) if (e.key === key && e.name !== name) { e.name = name; changed = true; }
      if (changed) await writeJson(p, sh);
    }
  });
  await mutateLib(l => { l.meals = l.meals.map(m => ({ ...m, items: m.items.map(i => (i.key === key ? { ...i, name } : i)) })); });
}
/** Set (null = clear) your caffeine value (mg per 100) for a food-table / product food. */
export async function setCaffeine(key: string, mg: number | null): Promise<void> {
  await mutateLib(l => { const m = { ...(l.caf ?? {}) }; if (mg != null && mg >= 0) m[key] = mg; else delete m[key]; l.caf = m; });
}
/** Drop a food from the recents list only (swipe in Add food → Recents). */
export async function removeRecent(key: string): Promise<void> {
  await mutateLib(l => { l.recents = l.recents.filter(r => r.key !== key); });
}
/** A new saved meal from components (Food database → Meals → ＋). */
export async function addMeal(name: string, items: SavedMealItem[]): Promise<SavedMeal> {
  const meal: SavedMeal = { id: uid(), name: name.trim() || 'Meal', items, count: 0, hrs: [] };
  await mutateLib(l => { l.meals.unshift(meal); });
  return meal;
}
/** Rename a saved meal. */
export async function renameMeal(id: string, name: string): Promise<void> {
  await mutateLib(l => { l.meals = l.meals.map(m => (m.id === id ? { ...m, name: name.trim() || m.name } : m)); });
}
/** Replace a saved meal's items (the meal preview's "Save changes": removed / added / re-weighed components). */
export async function updateMealItems(id: string, items: SavedMealItem[]): Promise<void> {
  await mutateLib(l => { l.meals = l.meals.map(m => (m.id === id ? { ...m, items } : m)); });
}
export async function deleteMeal(id: string): Promise<void> { await mutateLib(l => { l.meals = l.meals.filter(m => m.id !== id); }); }

export async function logMeal(meal: SavedMeal, date: string, via: EntryVia = 'meal', skip?: string[], at?: { t: string; groupId?: string; label?: string }): Promise<FoodEntry[]> {
  const t = at?.t ?? timeForDay(date);
  const groupId = at?.groupId ?? uid();
  const out: FoodEntry[] = meal.items.map(it => ({
    id: uid(), t, key: it.key, name: it.name, src: it.src, via, groupId, mealId: meal.id, ...(skip?.length ? { mealSkip: skip } : {}), ...(at?.label ? { label: at.label } : {}),
    n: it.per100 && it.grams != null ? scaleNutr(withRs(it.key, it.per100), it.grams) : (it.n ?? {}),
    ...(it.grams != null ? { grams: it.grams } : {}),
    ...(it.unit ? { unit: it.unit } : {}),
  }));
  await mutateDay(foodDayOf(t), d => { d.entries.push(...out); });
  await mutateLib(l => {                                // entries are saved; usage stats are bookkeeping only
    const m = l.meals.find(x => x.id === meal.id);
    if (m) { m.count += 1; m.last = t; m.hrs = [...m.hrs, hourOf(t)].slice(-30); }
  }).catch(() => undefined);
  return out;
}

/**
 * Move a logged meal (its entries) to another clock time on the SAME food day — "dinner wasn't at that time".
 * hhmm "19:30"; 00:00–03:59 = after midnight (still that food day under the 4 am rule).
 */
/** Re-label a logged meal ("it was lunch, not a snack"). */
export async function relabelEntries(date: string, ids: string[], label: string): Promise<void> {
  const keep = new Set(ids);
  await mutateDay(date, day => { day.entries = day.entries.map(e => (keep.has(e.id) ? { ...e, label } : e)); });
}
/** "19:30" → the ISO time on that FOOD day (00:00–03:59 = after midnight, next calendar day). null = not a time. */
export function timeOnDay(date: string, hhmm: string): string | null {
  const m = /^(\d{1,2})[:.h]?(\d{2})$/.exec(hhmm.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  const d = new Date(date + 'T12:00:00');
  if (Number(m[1]) < 4) d.setDate(d.getDate() + 1);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return localIso(d);
}
export async function retimeEntries(date: string, ids: string[], hhmm: string): Promise<void> {
  const m = /^(\d{1,2})[:.h]?(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new Error('Use a time like 19:30');
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) throw new Error('Use a time like 19:30');
  const d = new Date(date + 'T12:00:00');
  if (h < 4) d.setDate(d.getDate() + 1);   // after midnight → the next calendar day, same food day
  d.setHours(h, mi, 0, 0);
  const t = localIso(d);
  const keep = new Set(ids);
  await mutateDay(date, day => { day.entries = day.entries.map(e => (keep.has(e.id) ? { ...e, t } : e)); });
}
/** Re-log a recent with its remembered serving (the 1–2 tap path). */
export async function logRecent(r: Recent, date: string, via: EntryVia = 'recent', groupId?: string, t?: string, label?: string): Promise<FoodEntry> {
  if (r.per100) return logFood({ key: r.key, name: r.name, src: r.src, per100: r.per100, id: r.key.split(':').slice(1).join(':'), ...(r.unit ? { unit: r.unit } : {}), ...(r.serving ? { serving: r.serving } : {}) }, { grams: r.grams ?? servingOverrides[r.key]?.g ?? r.serving?.g ?? 100, via, date, groupId, ...(t ? { t } : {}), ...(label ? { label } : {}) });
  return logFood({ key: r.key, name: r.name, src: r.src, n: r.n ?? {} }, { via, date, groupId, ...(t ? { t } : {}), ...(label ? { label } : {}) });
}

/**
 * "Usually now" suggestions: saved meals and recents the user has logged ≥2 times within ±90 min of the
 * current hour. Meals first, then foods, by how often.
 */
export function usualNow(l: FoodLibrary, hour = new Date().getHours()): ({ kind: 'meal'; meal: SavedMeal } | { kind: 'food'; recent: Recent })[] {
  // hrs are whole hours, so this is "the same hour or the one either side"
  const near = (hrs: number[]) => hrs.filter(h => Math.min(Math.abs(h - hour), 24 - Math.abs(h - hour)) <= 1).length;
  const meals = l.meals.map(m => ({ m, c: near(m.hrs) })).filter(x => x.c >= 2).sort((a, b) => b.c - a.c).slice(0, 2);
  const foods = l.recents.map(r => ({ r, c: near(r.hrs) })).filter(x => x.c >= 2).sort((a, b) => b.c - a.c).slice(0, 4 - meals.length);
  return [...meals.map(x => ({ kind: 'meal' as const, meal: x.m })), ...foods.map(x => ({ kind: 'food' as const, recent: x.r }))];
}

/** Quick-add: calories (+ optional macros) without a food. */
export function quickItem(label: string, n: Nutr): { key: string; name: string; src: FoodSrc; n: Nutr } {
  const name = label.trim() || "Quick add";
  // keyed by label so a repeated "Gel" / "Sports drink" collapses into ONE recent with its remembered values
  return { key: `quick:${name.toLowerCase()}`, name, src: "quick", n };
}

/** Debug export: daily TOTALS only (never item names/times) — REPORT.md §6.1. */
export async function foodTotalsForExport(days: number): Promise<{ date: string; kcal: number; carb: number; prot: number; fat: number; na: number; waterMl: number; entries: number; complete: boolean; caf: number; cafLast?: string }[]> {
  const out = [];
  const now = Date.now();
  for (let i = 0; i < days; i++) {
    const date = trainingDayKey(now - i * 86_400_000);
    const d = await loadDay(date);
    if (!d.entries.length && !d.water.length) continue;
    const t = dayTotals(d);
    out.push({ date, kcal: Math.round(t.kcal ?? 0), carb: Math.round(t.carb ?? 0), prot: Math.round(t.prot ?? 0), fat: Math.round(t.fat ?? 0), na: Math.round(t.na ?? 0), waterMl: t.waterMl, entries: d.entries.length, complete: !!d.complete,
      // caffeine total + the clock time of the last intake → correlate with that night's HRV / sleep later
      caf: Math.round(t.caf ?? 0), ...(d.entries.some(e => (e.n.caf ?? 0) > 0) ? { cafLast: d.entries.filter(e => (e.n.caf ?? 0) > 0).map(e => e.t.slice(11, 16)).sort().pop() } : {}) });
  }
  return out;
}
