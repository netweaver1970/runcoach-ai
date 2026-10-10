/**
 * PHOTO MEAL LOGGING (nutrition A4; spike S1 on Geert's iPhone 2026-10-09: JPEG accepted at every quality in ~3.5 s,
 * quality 0.25 = 0.52 MB gave the same foods/grams as the 7 MB original; a wrong media-type label is rejected → always
 * send the SNIFFED type). Take / pick a photo → the configured vision model lists the foods with estimated amounts →
 * returned as a meal phrase ("80 g zucchini, 50 g scrambled eggs, …") that goes through the SAME parser + tick-off
 * preview as typing / voice, so every item can be corrected before logging.
 */
import * as ImagePicker from 'expo-image-picker';
import { callLLM, callLLMWithImage, extractJsonObject, setUsageFeature } from './llm';
import { searchFoodsEx, norm } from './foodDb';
import { learnedFor, learn, loadLearned } from './foodLearn';
import type { FoodItem } from './foodLog';

const QUALITY = 0.3;   // ≈ 0.5–0.7 MB at full camera resolution — same recognition as the original (S1)

function sniff(b64: string): string | null {
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('iVBORw0KGgo')) return 'image/png';
  if (b64.startsWith('UklGR')) return 'image/webp';
  if (b64.startsWith('R0lGOD')) return 'image/gif';
  return null;   // HEIC etc. → the vision API doesn't take it
}

const PROMPT = `You are a nutrition assistant. Identify every food and drink visible in this meal photo and estimate the amount of each AS SERVED (edible part).
NAMING — every name is looked up in a food-composition table (CIQUAL / USDA style), so name it the way such a table does:
- The plain, generic ENGLISH name of the food, main word first: "salmon", "smoked salmon", "white rice cooked", "boiled potatoes", "french beans" (= green beans), "scrambled eggs", "bread", "butter", "mayonnaise", "orange juice", "red wine".
- NO brands, NO serving words ("slice of", "portion of", "bowl of", "piece of", "plate of"), NO adjectives that don't change the nutrition ("fresh", "homemade", "delicious", "golden", "crispy", "sliced", "chopped", colours of garnish).
- Never use the words "and", "with", "en", "met" inside a name, and no commas (they split the list).
- One food per item; sauces, dressings, oils, butter and toppings are separate items when they're a meaningful amount.
- A composed dish is ONE item only when a nutrition table lists it as one ("lasagne", "pizza margherita", "chicken curry", "spaghetti bolognese", "nasi lemak"); otherwise split it into its components.
- Singular nouns. Always give the cooking method for potatoes, rice, pasta, vegetables, meat and fish (raw / cooked / boiled / fried / grilled / baked / steamed) — the table lists them that way.
- "alt": 1–3 SIMPLER or more generic names to try if the first isn't in the table (e.g. "smoked salmon" → ["salmon", "fish"]; "ciabatta" → ["white bread", "bread"]).
Amounts: grams for food, ml for drinks; judge size from the plate / cutlery / hand; round to 5 g. Don't invent what isn't visible; if unsure of an item, still give your best guess with "sure": false.
Return ONLY JSON: {"items":[{"name":"…","alt":["…"],"amount":number,"unit":"g"|"ml","sure":true|false}],"dish":"short description"}`;

export interface PhotoItem { name: string; alt: string[]; amount: number; unit: 'g' | 'ml'; sure: boolean; resolved?: 'table' | 'alt' | 'ai' | 'none' }
export interface PhotoResult { items: PhotoItem[]; dish?: string; phrase: string; ms: number; unresolved: number }

/** A confident table / learned hit for a name: every word used, nothing left out. */
function tableHit(q: string): FoodItem | undefined {
  const lr = learnedFor(q);
  if (lr) return lr.item;
  const r = searchFoodsEx(q, 3) as { items: FoodItem[]; ignored: string[]; notCombined?: string[] };
  return r.items.length && !r.ignored.length && !(r.notCombined?.length) ? r.items[0] : undefined;
}

/** Candidates from the app's own table for a name the search couldn't match: the name, its alts, and its words. */
function candidatesFor(it: PhotoItem): FoodItem[] {
  const seen = new Set<string>(), out: FoodItem[] = [];
  const add = (xs: FoodItem[]) => { for (const f of xs) if (!seen.has(f.key) && out.length < 12) { seen.add(f.key); out.push(f); } };
  for (const q of [it.name, ...it.alt]) add(searchFoodsEx(q, 5).items);
  for (const w of norm(it.name).split(' ').filter(w => w.length >= 4)) add(searchFoodsEx(w, 3).items);
  return out;
}

/**
 * Items the table still can't match → ONE text call: the AI picks, for each, the closest candidate from the app's
 * own table (or none). Picks are LEARNED ('ai'), so the parser resolves the same name from now on — and every later
 * photo / typed / spoken mention of it too. You confirm (log it) or correct (pick another) → that's learned as yours.
 */
async function aiResolve(items: PhotoItem[]): Promise<void> {
  const todo = items.map(it => ({ it, cands: candidatesFor(it) })).filter(x => x.cands.length);
  if (!todo.length) return;
  const list = todo.map((x, i) => `${i}. "${x.it.name}" (${x.it.amount} ${x.it.unit})\n` + x.cands.map((c, j) => `   ${j}: ${c.name}`).join('\n')).join('\n');
  setUsageFeature('food-photo-match');
  const txt = await callLLM({ maxTokens: 300, temperature: 0, messages: [{ role: 'user', content:
    `Each numbered item below is a food seen in a meal photo, followed by candidate foods from a food-composition table. For each item pick the candidate that is the SAME food (or the nutritionally closest stand-in: same food type, similar fat / sugar / protein). Use -1 only when no candidate is a reasonable stand-in.\nReturn ONLY JSON: {"picks":[{"item":<item number>,"pick":<candidate number or -1>}]}\n\n${list}` }] });
  const js = extractJsonObject(txt);
  const raw: unknown[] = js ? (JSON.parse(js)?.picks ?? []) : [];
  const byItem = new Map<number, number>();
  for (const p of raw) { const o = p as { item?: unknown; pick?: unknown }; if (typeof o?.item === 'number' && typeof o?.pick === 'number') byItem.set(o.item, o.pick); }
  for (let i = 0; i < todo.length; i++) {
    const j = byItem.get(i);
    const c = typeof j === 'number' && Number.isInteger(j) && j >= 0 ? todo[i].cands[j] : undefined;
    if (c) { await learn(todo[i].it.name, c, 'ai'); todo[i].it.resolved = 'ai'; }
  }
}

/** Ask for the camera or the library, then recognise. null = cancelled. */
export async function photoMeal(source: 'camera' | 'library'): Promise<PhotoResult | null> {
  if (source === 'camera') {
    const p = await ImagePicker.requestCameraPermissionsAsync();
    if (!p.granted) throw new Error('Camera access is off — allow it for RunCoachAI in iOS Settings.');
  }
  const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: QUALITY, base64: true, exif: false };
  const res = source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
  if (res.canceled || !res.assets?.[0]?.base64) return null;
  const b64 = res.assets[0].base64!;
  const mediaType = sniff(b64);
  if (!mediaType) throw new Error('This photo format isn\'t supported — take a new photo, or set the camera to "Most Compatible" (JPEG).');
  const t0 = Date.now();
  await loadLearned();
  setUsageFeature('food-photo');
  const txt = await callLLMWithImage({ prompt: PROMPT, imageBase64: b64, mediaType, maxTokens: 900 });
  const js = extractJsonObject(txt);
  if (!js) throw new Error('The AI didn\'t return a food list — try again, or with the plate fully in view.');
  const o = JSON.parse(js);
  const clean = (v: unknown) => String(v ?? '').replace(/[,;+\n]/g, ' ').replace(/\b(and|with|en|met|et|avec|plus)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  const items: PhotoItem[] = (Array.isArray(o?.items) ? o.items : [])
    .map((x: any) => ({ name: clean(x?.name), alt: (Array.isArray(x?.alt) ? x.alt : []).map(clean).filter(Boolean).slice(0, 3),
      amount: Math.max(1, Math.round(Number(x?.amount) || 0)), unit: x?.unit === 'ml' ? 'ml' as const : 'g' as const, sure: x?.sure !== false }))
    .filter((x: PhotoItem) => x.name && x.amount > 0 && x.amount < 3000);
  if (!items.length) throw new Error('No food recognised in this photo.');
  // 1) the name or one of its simpler alternatives that the table (or the learned memory) matches outright
  for (const it of items) {
    if (tableHit(it.name)) { it.resolved = 'table'; continue; }
    const a = it.alt.find(x => tableHit(x));
    if (a) { it.name = a; it.resolved = 'alt'; }
  }
  // 2) the rest: the AI picks from the app's own candidates (learned, so it's instant next time)
  const miss = items.filter(it => !it.resolved);
  if (miss.length) await aiResolve(miss).catch(() => {});
  for (const it of items) if (!it.resolved) it.resolved = 'none';
  // the meal phrase the parser understands — commas separate the items, "80 g x" sets the amount
  const phrase = items.map(i => `${i.amount} ${i.unit} ${i.name}`).join(', ');
  return { items, dish: typeof o?.dish === 'string' ? o.dish : undefined, phrase, ms: Date.now() - t0, unresolved: items.filter(i => i.resolved === 'none').length };
}
