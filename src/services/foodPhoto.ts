/**
 * PHOTO MEAL LOGGING (nutrition A4; spike S1 on Geert's iPhone 2026-10-09: JPEG accepted at every quality in ~3.5 s,
 * quality 0.25 = 0.52 MB gave the same foods/grams as the 7 MB original; a wrong media-type label is rejected → always
 * send the SNIFFED type). Take / pick a photo → the configured vision model lists the foods with estimated amounts →
 * returned as a meal phrase ("80 g zucchini, 50 g scrambled eggs, …") that goes through the SAME parser + tick-off
 * preview as typing / voice, so every item can be corrected before logging.
 */
import * as ImagePicker from 'expo-image-picker';
import { callLLMWithImage, extractJsonObject, setUsageFeature } from './llm';

const QUALITY = 0.3;   // ≈ 0.5–0.7 MB at full camera resolution — same recognition as the original (S1)

function sniff(b64: string): string | null {
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('iVBORw0KGgo')) return 'image/png';
  if (b64.startsWith('UklGR')) return 'image/webp';
  if (b64.startsWith('R0lGOD')) return 'image/gif';
  return null;   // HEIC etc. → the vision API doesn't take it
}

const PROMPT = `You are a nutrition assistant. Identify every food and drink visible in this meal photo and estimate the amount of each AS SERVED (edible part).
Rules:
- Use plain, common English food names a nutrition table would use ("white rice, cooked", "scrambled eggs", "grilled chicken breast", "avocado", "orange juice"); a recognisable composed dish (e.g. "chicken rice", "lasagne", "nasi lemak") may be ONE item.
- Amounts: grams for food, ml for drinks; judge size from the plate / cutlery / hand; round to 5 g.
- Include visible sauces, oils, butter, dressings and toppings as separate items when they are a meaningful amount.
- Don't invent what isn't visible. If unsure about an item, still give your best guess and set "sure": false.
Return ONLY JSON: {"items":[{"name":"…","amount":number,"unit":"g"|"ml","sure":true|false}],"dish":"short description"}`;

export interface PhotoItem { name: string; amount: number; unit: 'g' | 'ml'; sure: boolean }
export interface PhotoResult { items: PhotoItem[]; dish?: string; phrase: string; ms: number }

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
  setUsageFeature('food-photo');
  const txt = await callLLMWithImage({ prompt: PROMPT, imageBase64: b64, mediaType, maxTokens: 800 });
  const js = extractJsonObject(txt);
  if (!js) throw new Error('The AI didn\'t return a food list — try again, or with the plate fully in view.');
  const o = JSON.parse(js);
  const items: PhotoItem[] = (Array.isArray(o?.items) ? o.items : [])
    .map((x: any) => ({ name: String(x?.name ?? '').trim(), amount: Math.max(1, Math.round(Number(x?.amount) || 0)), unit: x?.unit === 'ml' ? 'ml' as const : 'g' as const, sure: x?.sure !== false }))
    .filter((x: PhotoItem) => x.name && x.amount > 0 && x.amount < 3000);
  if (!items.length) throw new Error('No food recognised in this photo.');
  // the meal phrase the parser understands — commas separate the items, "80 g x" sets the amount
  const phrase = items.map(i => `${i.amount} ${i.unit} ${i.name.replace(/,/g, ' ')}`).join(', ');
  return { items, dish: typeof o?.dish === 'string' ? o.dish : undefined, phrase, ms: Date.now() - t0 };
}
