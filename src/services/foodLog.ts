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
  | 'water' | 'alc' | 'vitC' | 'vitD' | 'caf';
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
}
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
};

const DIR = FileSystem.documentDirectory;
export const FOOD_LOG_PREFIX = 'runcoach-food-log-';
export const FOOD_LIBRARY_FILE = 'runcoach-food-library.json';
const shardFile = (date: string) => `${DIR}${FOOD_LOG_PREFIX}${date.slice(0, 7)}.json`;
const LIB = `${DIR}${FOOD_LIBRARY_FILE}`;
const MAX_RECENTS = 200;

// ─── helpers ──────────────────────────────────────────────────────────────────────────────────────
export const NUTR_KEYS: NutrKey[] = ['kcal', 'prot', 'carb', 'fat', 'sug', 'fib', 'sat', 'salt', 'na', 'k', 'ca', 'fe', 'mg', 'water', 'alc', 'vitC', 'vitD', 'caf'];

export function scaleNutr(per100: Nutr, grams: number): Nutr {
  const out: Nutr = {};
  for (const k of NUTR_KEYS) { const v = per100[k]; if (typeof v === 'number') out[k] = Math.round(v * grams / 100 * 100) / 100; }
  return out;
}
export function sumNutr(list: Nutr[]): Nutr {
  const out: Nutr = {};
  for (const n of list) for (const k of NUTR_KEYS) { const v = n[k]; if (typeof v === 'number') out[k] = (out[k] ?? 0) + v; }
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
  opts: { grams?: number; t?: string; via: EntryVia; groupId?: string; confidence?: number; date?: string },
): Promise<FoodEntry> {
  const t = opts.t ?? (opts.date ? timeForDay(opts.date) : localIso(new Date()));
  const date = foodDayOf(t);
  const n = 'per100' in item && opts.grams != null ? scaleNutr(item.per100, opts.grams) : ('n' in item ? item.n : {});
  const e: FoodEntry = {
    id: uid(), t, key: item.key, name: item.name, src: item.src, n, via: opts.via,
    ...(opts.grams != null ? { grams: opts.grams } : {}),
    ...('unit' in item && item.unit === 'ml' ? { unit: 'ml' as const } : {}),
    ...(opts.groupId ? { groupId: opts.groupId } : {}),
    ...(opts.confidence != null ? { confidence: opts.confidence } : {}),
  };
  await mutateDay(date, d => { d.entries.push(e); });
  await touchRecent(item, opts.grams, t).catch(() => undefined);   // the entry is saved; recents are a convenience
  await linkSupplements([item.key], t);
  return e;
}

/** Log several items as ONE atomic write (a parsed phrase): all or nothing, one groupId. */
export async function logFoods(items: { item: FoodItem; grams: number }[], opts: { via: EntryVia; date: string; groupId?: string }): Promise<FoodEntry[]> {
  const t = timeForDay(opts.date);
  const groupId = opts.groupId ?? uid();
  const out: FoodEntry[] = items.map(({ item, grams }) => ({
    id: uid(), t, key: item.key, name: item.name, src: item.src, n: scaleNutr(item.per100, grams), grams, via: opts.via, groupId,
    ...(item.unit === 'ml' ? { unit: 'ml' as const } : {}),
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

export async function deleteMeal(id: string): Promise<void> { await mutateLib(l => { l.meals = l.meals.filter(m => m.id !== id); }); }

export async function logMeal(meal: SavedMeal, date: string, via: EntryVia = 'meal'): Promise<FoodEntry[]> {
  const t = timeForDay(date);
  const groupId = uid();
  const out: FoodEntry[] = meal.items.map(it => ({
    id: uid(), t, key: it.key, name: it.name, src: it.src, via, groupId,
    n: it.per100 && it.grams != null ? scaleNutr(it.per100, it.grams) : (it.n ?? {}),
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

/** Re-log a recent with its remembered serving (the 1–2 tap path). */
export async function logRecent(r: Recent, date: string, via: EntryVia = 'recent', groupId?: string): Promise<FoodEntry> {
  if (r.per100) return logFood({ key: r.key, name: r.name, src: r.src, per100: r.per100, id: r.key.split(':').slice(1).join(':'), ...(r.unit ? { unit: r.unit } : {}), ...(r.serving ? { serving: r.serving } : {}) }, { grams: r.grams ?? servingOverrides[r.key]?.g ?? r.serving?.g ?? 100, via, date, groupId });
  return logFood({ key: r.key, name: r.name, src: r.src, n: r.n ?? {} }, { via, date, groupId });
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
export async function foodTotalsForExport(days: number): Promise<{ date: string; kcal: number; carb: number; prot: number; fat: number; na: number; waterMl: number; entries: number; complete: boolean }[]> {
  const out = [];
  const now = Date.now();
  for (let i = 0; i < days; i++) {
    const date = trainingDayKey(now - i * 86_400_000);
    const d = await loadDay(date);
    if (!d.entries.length && !d.water.length) continue;
    const t = dayTotals(d);
    out.push({ date, kcal: Math.round(t.kcal ?? 0), carb: Math.round(t.carb ?? 0), prot: Math.round(t.prot ?? 0), fat: Math.round(t.fat ?? 0), na: Math.round(t.na ?? 0), waterMl: t.waterMl, entries: d.entries.length, complete: !!d.complete });
  }
  return out;
}
