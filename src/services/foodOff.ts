/**
 * Open Food Facts (OFF) lookups for branded products — nutrition Option A, REPORT.md §3.3 / §8.
 *
 * Rules:
 * - Only on an EXPLICIT user action (typed barcode, or "Search online"): OFF allows 15 product reads and
 *   10 searches per minute per IP and forbids search-as-you-type.
 * - Sends ONLY the barcode or search words + a User-Agent naming the app (contact = the public repo, no personal
 *   email). Never identity or any health data.
 * - Hits are copied into a PRIVATE on-device cache (`food-db-cache.json`). A per-device cache is not "Publicly
 *   Used" under ODbL, so no share-alike duty; it is excluded from backups and never merged into the CIQUAL table.
 * - Product images are CC-BY-SA 3.0: shown with attribution, never cached by us.
 * - Lidl RCN-8 codes (8 digits starting with 2) are reused across countries → the UI always shows the product
 *   name for the user to confirm before logging.
 */
import * as FileSystem from 'expo-file-system';
import type { FoodItem, Nutr } from './foodLog';

const UA = 'RunCoachAI/1.0 (https://github.com/netweaver1970/runcoach-ai)';
const BASE = 'https://world.openfoodfacts.org';
const CACHE = `${FileSystem.documentDirectory}food-db-cache.json`;
const FIELDS = 'code,product_name,product_name_nl,product_name_fr,product_name_en,generic_name,brands,quantity,serving_size,serving_quantity,nutriments,image_front_small_url,countries_tags';
export const OFF_CREDIT = 'Product data © Open Food Facts contributors, ODbL. Images CC-BY-SA.';
export const OFF_URL = 'https://world.openfoodfacts.org';

export interface OffProduct extends FoodItem { image?: string; quantity?: string; incomplete?: boolean; implausible?: boolean; rcn8?: boolean }

/** Energy vs macros (4/4/9 + 7 for alcohol) more than ±25 % apart, or > 900 kcal/100 g → probably mis-entered on OFF. */
export function implausible(n: Nutr): boolean {
  if (n.kcal == null) return false;
  if (n.kcal > 900) return true;
  if (n.carb == null || n.prot == null || n.fat == null) return false;
  const macro = n.carb * 4 + n.prot * 4 + n.fat * 9 + (n.fib ?? 0) * 2 + (n.alc ?? 0) * 7;
  if (macro < 20 && n.kcal < 20) return false;
  return Math.abs(n.kcal - macro) > 0.25 * Math.max(macro, n.kcal);
}

/** EAN-8 / UPC-A (12) / EAN-13 check digit. */
export function validBarcode(code: string): boolean {
  const d = code.replace(/\D/g, '');
  if (![8, 12, 13].includes(d.length)) return false;
  const digits = d.split('').map(Number);
  const check = digits.pop()!;
  let sum = 0;
  digits.reverse().forEach((n, i) => { sum += n * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}
export const isRcn8 = (code: string) => /^2\d{7}$/.test(code);

function num(v: unknown): number | undefined {
  const x = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return isFinite(x) && x >= 0 ? x : undefined;
}

/** OFF nutriments (per 100 g / 100 mL) → our Nutr per 100. Sodium/potassium/caffeine arrive in g → mg. */
export function mapNutriments(nm: Record<string, unknown> = {}): Nutr {
  const out: Nutr = {};
  let kcal = num(nm['energy-kcal_100g']);
  if (kcal == null) { const kj = num(nm['energy-kj_100g'] ?? nm['energy_100g']); if (kj != null) kcal = Math.round(kj / 4.184 * 10) / 10; }
  if (kcal != null) out.kcal = kcal;
  const g = (k: string) => num(nm[`${k}_100g`]);
  const set = (key: keyof Nutr, v: number | undefined) => { if (v != null) out[key] = Math.round(v * 1000) / 1000; };
  set('prot', g('proteins')); set('carb', g('carbohydrates')); set('fat', g('fat'));
  set('sug', g('sugars')); set('fib', g('fiber')); set('sat', g('saturated-fat')); set('salt', g('salt'));
  const na = g('sodium'); set('na', na != null ? na * 1000 : (out.salt != null ? out.salt / 2.5 * 1000 : undefined));
  const k = g('potassium'); set('k', k != null ? k * 1000 : undefined);
  const caf = g('caffeine'); set('caf', caf != null ? caf * 1000 : undefined);
  const alc = g('alcohol'); set('alc', alc);
  // minerals + vitamins: OFF stores every *_100g in GRAMS → mg (×1e3) / µg (×1e6) as in MICROS
  const mgOf = (k: string, key: keyof Nutr) => { const v = g(k); if (v != null) set(key, v * 1000); };
  const ugOf = (k: string, key: keyof Nutr) => { const v = g(k); if (v != null) set(key, v * 1e6); };
  mgOf('calcium', 'ca'); mgOf('iron', 'fe'); mgOf('magnesium', 'mg'); mgOf('phosphorus', 'p'); mgOf('zinc', 'zn');
  mgOf('copper', 'cu'); mgOf('manganese', 'mn'); ugOf('selenium', 'se'); ugOf('iodine', 'iod');
  ugOf('vitamin-a', 'vitA'); ugOf('vitamin-d', 'vitD'); mgOf('vitamin-e', 'vitE'); ugOf('vitamin-k', 'vitK'); mgOf('vitamin-c', 'vitC');
  mgOf('vitamin-b1', 'b1'); mgOf('vitamin-b2', 'b2'); mgOf('vitamin-pp', 'b3'); mgOf('pantothenic-acid', 'b5'); mgOf('vitamin-b6', 'b6');
  ugOf('vitamin-b9', 'b9'); ugOf('vitamin-b12', 'b12');
  return out;
}

/** "240 g" · "1 bouteille (25 cl)" · "0,25 l" · "200 gr" · "2 x 15 g" (→ 30) · "30g (2 biscuits)" → grams/ml. */
export function servingFromText(t: unknown): number | undefined {
  if (typeof t !== 'string') return undefined;
  const m = /(?:(\d+)\s*[x×]\s*)?(\d+(?:[.,]\d+)?)\s*(gr?|ml|cl|l)\b/i.exec(t);
  if (!m) return undefined;
  const v = parseFloat(m[2].replace(',', '.')) * ({ g: 1, gr: 1, ml: 1, cl: 10, l: 1000 } as Record<string, number>)[m[3].toLowerCase()] * (m[1] ? parseInt(m[1], 10) : 1);
  return isFinite(v) && v > 0 ? v : undefined;
}

/**
 * OFF's "serving 100 g" with nothing else ("100 g") is usually just the per-100 figure echoed into the serving field,
 * not a real portion (Boni high-protein yoghurt drink: no pack size, serving_size "100 g" — it's a 240 g bottle).
 * Treat it as UNKNOWN so the app asks for the real size instead of offering "1 serving = 100 g".
 */
export function isEcho100(g: number | undefined, text?: unknown): boolean {
  return g === 100 && (typeof text !== 'string' || /^\s*100\s*(g|gr|ml)\s*$/i.test(text));
}
/** Names of drinks (also those sold by weight: yoghurt drinks, shakes, kefir). */
export const DRINK_NAME = /drink|drank|boisson|à boire|a boire|trinkjoghurt|shake|smoothie|k[eé]fir|lassi|ayran|actimel|yakult/i;

function toItem(p: any): OffProduct | null {
  if (!p) return null;
  const code = String(p.code ?? '');
  const name = String(p.product_name_nl || p.product_name_en || p.product_name || p.product_name_fr || p.generic_name || '').trim();
  const per100 = mapNutriments(p.nutriments);
  // serving_quantity is often missing while the text serving_size ("240 g", "1 bouteille (240 ml)") is there
  const sq = num(p.serving_quantity) ?? servingFromText(p.serving_size);
  // Pack size "330ml" / "33 cl" / "1 l" / "250 g" → the unit and ONE PACK as the piece (single-serve packs only).
  const qm = typeof p.quantity === 'string' ? /^\s*(\d+(?:[.,]\d+)?)\s*(ml|cl|l|g|kg)\s*[e℮]?\s*$/i.exec(p.quantity) : null;
  const qUnit = qm ? qm[2].toLowerCase() : '';
  const qAmt = qm ? parseFloat(qm[1].replace(',', '.')) * ({ ml: 1, cl: 10, l: 1000, g: 1, kg: 1000 } as Record<string, number>)[qUnit] : 0;
  const liquid = qUnit === 'ml' || qUnit === 'cl' || qUnit === 'l';
  // A drink up to 750 ml is one bottle/can. A SOLID pack is a piece only when it's plausibly single-serve (≤ 150 g:
  // a bar, a pot) — a 500 g muesli box must not pre-fill the portion with the whole pack.
  // DRINKS sold by weight (yoghurt drinks, protein shakes, kefir: "240 g") are one bottle too — Geert's 240 g Boni
  // high-protein yoghurt drink fell through to OFF's "serving 100 g" (often just the per-100 figure echoed back).
  const nameAll = `${p.product_name ?? ''} ${p.product_name_nl ?? ''} ${p.product_name_fr ?? ''} ${p.product_name_en ?? ''} ${p.generic_name ?? ''}`;
  const drinkish = liquid || DRINK_NAME.test(nameAll);
  const sq100 = sq === 100;   // a "100 g serving" next to a small pack is the per-100 echo, not a real serving
  const pack = qAmt > 0 && (drinkish ? qAmt <= 750 : qAmt <= 150 || (sq100 && qAmt <= 400))
    ? { g: qAmt, label: drinkish ? '1 bottle' : '1 pack' } : null;
  return {
    key: `off:${code}`, src: 'off', id: code,
    name: name || `Product ${code}`,
    nameAlt: [p.product_name_fr, p.product_name].find((x: unknown) => typeof x === 'string' && x && x !== name) as string | undefined,
    brand: typeof p.brands === 'string' ? p.brands.split(',')[0].trim() : Array.isArray(p.brands) && p.brands.length ? String(p.brands[0]).trim() : undefined,
    per100,
    ...(pack ? { serving: pack } : sq && sq > 0 && sq < 2000 && !isEcho100(sq, p.serving_size) ? { serving: { g: sq, label: '1 serving' } } : {}),
    ...(liquid ? { unit: 'ml' as const } : {}),
    image: typeof p.image_front_small_url === 'string' ? p.image_front_small_url : undefined,
    quantity: typeof p.quantity === 'string' ? p.quantity : undefined,
    incomplete: per100.kcal == null || per100.carb == null || per100.prot == null || per100.fat == null,
    implausible: implausible(per100),
    rcn8: isRcn8(code),
  };
}

// ─── private cache ────────────────────────────────────────────────────────────────────────────────
type Cache = Record<string, { at: string; item: OffProduct | null }>;
async function readCache(): Promise<Cache> {
  try { const i = await FileSystem.getInfoAsync(CACHE); if (!i.exists) return {}; return JSON.parse(await FileSystem.readAsStringAsync(CACHE)); } catch { return {}; }
}
async function writeCache(c: Cache): Promise<void> { try { await FileSystem.writeAsStringAsync(CACHE, JSON.stringify(c)); } catch { /* ignore */ } }
export async function cachedProducts(): Promise<OffProduct[]> {
  const c = await readCache();
  const byKey = new Map<string, OffProduct>();
  for (const x of Object.values(c)) if (x.item) byKey.set(x.item.key, x.item);   // UPC-12 vs EAN-13 aliases → one product
  return [...byKey.values()];
}

async function get(url: string, timeoutMs = 8000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal });
    if (r.status === 404) return { status: 0 };
    if (r.status === 429) throw new Error('Open Food Facts is rate-limiting — try again in a minute.');
    if (r.status >= 500) throw new Error('Open Food Facts is busy right now — try the barcode, or again later.');
    if (!r.ok) throw new Error(`Open Food Facts error ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

/**
 * Barcode → product. Cached hits return instantly (no network). A miss is cached for 7 days so a re-scan of an
 * unknown product doesn't hammer OFF; `refresh` bypasses the cache.
 */
export async function lookupBarcode(code: string, refresh = false): Promise<{ item: OffProduct | null; cached: boolean }> {
  const ean = code.replace(/\D/g, '');
  const c = await readCache();
  const hit = c[ean];
  if (!refresh && hit && (hit.item || Date.now() - new Date(hit.at).getTime() < 7 * 86_400_000)) return { item: hit.item, cached: true };
  const j = await get(`${BASE}/api/v2/product/${ean}.json?fields=${FIELDS}`);
  const item = j?.status === 1 ? toItem(j.product) : null;
  c[ean] = { at: new Date().toISOString(), item };
  await writeCache(c);
  return { item, cached: false };
}

/** Explicit "Search online": OFF full-text search, Belgian products first. */
export async function searchOff(query: string): Promise<OffProduct[]> {
  // OFF only returns products matching EVERY word, so one extra word ("vanilla" when only the choc variant is
  // listed) gives nothing. Retry with the last word dropped, down to 2 words (≤ 3 rounds → within 10 searches/min).
  const ws = query.trim().split(/\s+/).filter(Boolean);
  try { const hit = await searchNew(query); if (hit.length) return hit; } catch { /* fall back to the legacy word-dropping loop */ }
  let err: unknown = null;
  for (let n = ws.length, round = 0; n >= Math.min(2, ws.length) && round < 3; n--, round++) {
    try {
      const hit = await searchOffOnce(ws.slice(0, n).join(' '));
      if (hit.length) return hit;
      err = null;                                         // a clean "nothing found" beats an earlier error
    } catch (e) { err = e; }                              // search.pl is often 503 — still try the shorter query
  }
  if (err) throw err;
  return [];
}

// OFF allows 10 searches/min per IP — keep our own budget below it (8/min) so a burst can't get the IP blocked,
// which would also break barcode lookups.
let searchTimes: number[] = [];
function takeSearchBudget(): boolean {
  const now = Date.now();
  searchTimes = searchTimes.filter(t => now - t < 60_000);
  if (searchTimes.length >= 8) return false;
  searchTimes.push(now); return true;
}

/**
 * Product search on OFF's NEW search service (search-a-licious, search.openfoodfacts.org — Elasticsearch, ~0.2 s, no
 * 10/min cap). Geert 2026-10-09: the old cgi/search.pl kept answering 503 → "Open Food Facts is busy". Belgian products
 * first (a filtered query in parallel with the open one). Falls back to search.pl only if the new service fails.
 */
async function searchNew(query: string): Promise<OffProduct[]> {
  const base = 'https://search.openfoodfacts.org/search';
  const words = query.trim().split(/\s+/).filter(w => w.length > 1).map(w => w.replace(/["():]/g, ''));
  // every word must match (like the old search) — the service's default is ANY word, which ranks junk first
  const q = (terms: string, extra: string) => `${base}?q=${encodeURIComponent(terms + extra)}&page_size=20&fields=${FIELDS}`;
  const run = async (terms: string) => Promise.all([
    get(q(terms, ' AND countries_tags:"en:belgium"'), 8000).then(j => (j?.hits ?? []) as any[]).catch(() => null),
    get(q(terms, ''), 8000).then(j => (j?.hits ?? []) as any[]).catch(() => null),
  ]);
  // all words; nothing → drop the LAST word (down to 2 words, like the old search); nothing → any word
  let be: any[] | null = null, all: any[] | null = null, reached = false;
  for (let n = words.length; n >= Math.min(2, words.length); n--) {
    [be, all] = await run(words.slice(0, n).join(' AND '));
    if (be != null || all != null) reached = true;
    if (be?.length || all?.length) break;
  }
  if (!reached) throw new Error('search service unreachable');
  if (!(be?.length) && !(all?.length) && words.length > 1) [be, all] = await run(words.join(' '));
  const seen = new Set<string>(), out: OffProduct[] = [];
  for (const p of [...(be ?? []), ...(all ?? [])]) {
    const it = toItem(p);
    if (!it || seen.has(it.id) || it.per100.kcal == null) continue;
    seen.add(it.id); out.push(it);
  }
  // most of YOUR words in the product's own name / brand first (Belgian order kept within a tie)
  const lw = words.map(w => w.toLowerCase());
  const hits = (it: OffProduct) => { const t = `${it.name} ${it.nameAlt ?? ''} ${it.brand ?? ''}`.toLowerCase(); return lw.filter(w => t.includes(w)).length; };
  return out.map((it, i) => ({ it, i, h: hits(it) })).sort((a, b) => b.h - a.h || a.i - b.i).map(x => x.it);
}

async function searchOffOnce(query: string): Promise<OffProduct[]> {
  const q = encodeURIComponent(query.trim());
  if (!q) return [];
  try { return await searchNew(query); } catch { /* new service down → the legacy endpoint below */ }
  const url = (extra: string) => `${BASE}/cgi/search.pl?search_terms=${q}&search_simple=1&action=process&json=1&page_size=20&fields=${FIELDS}${extra}`;
  // Belgium first, then worldwide; one failing call (search.pl often 503s) must not sink the other
  let prods: any[] = [];
  let lastErr: unknown = null;
  if (!takeSearchBudget()) throw new Error('Too many product searches in a minute — wait a moment, or scan the barcode.');
  try { prods = (await get(url('&tagtype_0=countries&tag_contains_0=contains&tag_0=belgium'), 12000))?.products ?? []; } catch (e) { lastErr = e; }
  if (prods.length < 5 && takeSearchBudget()) {
    try { prods = [...prods, ...((await get(url(''), 12000))?.products ?? [])]; } catch (e) { lastErr = e; }
  }
  if (!prods.length && lastErr) throw lastErr;
  const seen = new Set<string>();
  const out: OffProduct[] = [];
  for (const p of prods) {
    const it = toItem(p);
    if (!it || seen.has(it.id) || it.per100.kcal == null) continue;
    seen.add(it.id); out.push(it);
  }
  return out;
}

/** Remember a product the user picked from an online search, so it's offline next time. */
export async function rememberProduct(p: OffProduct): Promise<void> {
  const c = await readCache();
  const id = p.key.slice(p.key.indexOf(':') + 1);      // the barcode, whatever `id` a re-opened item carries
  c[id] = { at: new Date().toISOString(), item: { ...p, id } };
  await writeCache(c);
}
