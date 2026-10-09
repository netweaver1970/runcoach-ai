/**
 * Keyless free-text meal parser (nutrition Option A, REPORT.md §5 F10): "2 eieren, toast met boter" →
 * [2 × egg, 1 × toast, 1 knob butter], each matched in the local table with grams the user confirms.
 * EN / NL / FR number words and household units. Deterministic, offline — works with iOS keyboard dictation.
 * With an LLM key the same review list can be filled by the model instead (A4), but this path always exists.
 */
import { searchFoodsEx, defaultServing, norm } from './foodDb';
import type { FoodItem } from './foodLog';

export interface ParsedItem {
  text: string;            // the fragment as typed
  query: string;           // the food words used for matching
  qty: number;
  unit?: string;           // canonical unit key, if one was given
  food?: FoodItem;
  alternatives: FoodItem[];
  grams: number;
  sure: boolean;           // false = no unit/qty given or weak match → highlight for review
}

// Split on list separators and "with/and" in all three languages. "met" is kept as a split so
// "toast met boter" → toast · boter (the spread is its own item, like MacroFactor/Cronometer do it).
const SPLIT = /\s*(?:,|;|\+|\n|\ben\b|\bmet\b|\band\b|\bwith\b|\bet\b|\bavec\b|\bplus\b)\s*/i;

const WORD_NUM: Record<string, number> = {
  een: 1, 'één': 1, eén: 1, one: 1, a: 1, an: 1, un: 1, une: 1,
  twee: 2, two: 2, deux: 2, drie: 3, three: 3, trois: 3, vier: 4, four: 4, quatre: 4,
  vijf: 5, five: 5, cinq: 5, zes: 6, six: 6, half: 0.5, halve: 0.5, demi: 0.5, 'demie': 0.5,
  anderhalf: 1.5, anderhalve: 1.5, paar: 2, couple: 2,
};

/** unit → grams per unit (null = use the food's own default serving) */
const UNITS: { re: RegExp; key: string; g: number | null }[] = [
  { re: /^(kg|kilo)$/, key: 'kg', g: 1000 },
  { re: /^(g|gr|gram|grams|gramme|grammes)$/, key: 'g', g: 1 },
  { re: /^(ml|milliliter|millilitre)$/, key: 'ml', g: 1 },
  { re: /^(cl|centiliter|centilitre)$/, key: 'cl', g: 10 },
  { re: /^(l|liter|litre|liters|litres)$/, key: 'l', g: 1000 },
  { re: /^(el|eetlepel|eetlepels|tbsp|tablespoons?|cs|cuilleres? a soupe)$/, key: 'tbsp', g: 15 },
  { re: /^(tl|theelepel|theelepels|tsp|teaspoons?|cc|cuilleres? a cafe)$/, key: 'tsp', g: 5 },
  { re: /^(sneetje|sneetjes|snee|sneden|boterham|boterhammen|slice|slices|tranche|tranches)$/, key: 'slice', g: null },
  { re: /^(stuk|stuks|stukje|stukjes|piece|pieces|pc|pcs|morceau|morceaux)$/, key: 'piece', g: null },
  { re: /^(glas|glazen|glass|glasses|verre|verres)$/, key: 'glass', g: 250 },
  { re: /^(tas|tassen|kopje|kopjes|cup|cups|mug|tasse|tasses)$/, key: 'cup', g: 200 },
  { re: /^(kom|kommen|kommetje|kommetjes|bowl|bowls|bol|bols)$/, key: 'bowl', g: null },
  { re: /^(blik|blikje|blikjes|can|cans|canette|canettes)$/, key: 'can', g: 330 },
  { re: /^(flesje|flesjes|bottle|bottles)$/, key: 'bottle', g: 330 },
  { re: /^(fles|flessen|bouteille|bouteilles)$/, key: 'wine-bottle', g: 750 },
  { re: /^(pak|pakken|brik|brikken|carton|litre)$/, key: 'carton', g: 1000 },
  { re: /^(pakje|pakjes|brikje|brikjes|briquette)$/, key: 'juicebox', g: 200 },
  { re: /^(portie|porties|portion|portions|bord|plate|assiette)$/, key: 'portion', g: null },
  { re: /^(handje|handvol|handful|poignee)$/, key: 'handful', g: 30 },
  { re: /^(scoop|scoops|schep|scheppen|schepje|schepjes|maatschep|maatschepje|dose|doses)$/, key: 'scoop', g: null },
  { re: /^(scheut|dash|trait)$/, key: 'dash', g: 5 },
];

function parseNumber(tok: string): number | undefined {
  const t = tok.replace(',', '.');
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  if (t === '½') return 0.5;
  if (t === '¼') return 0.25;
  if (/^\d+\/\d+$/.test(t)) { const [a, b] = t.split('/').map(Number); return b ? a / b : undefined; }
  return WORD_NUM[norm(t)];
}

/** Parse ONE fragment: [qty] [unit] food words. Also handles "120g banaan" and "banaan 120 g". */
/** Grams above this are almost certainly a misparse (or a typo) — never logged without the user seeing it. */
export const MAX_ITEM_GRAMS = 1500;

export function parseFragment(frag: string, boost?: Record<string, number>, findOwn?: (q: string) => FoodItem | undefined): ParsedItem | null {
  const text = frag.trim();
  if (!text) return null;
  // times are not amounts: "koffie om 8u", "om 12:30", "at 7h"
  const clean = text.replace(/\b(om|at|a|à|vers)\s+\d{1,2}([:.h]\d{2})?\s*(u|uur|h)?\b/gi, ' ').replace(/\b\d{1,2}[:h]\d{2}\b|\b\d{1,2}\s?(u|uur)\b/gi, ' ');
  let toks = clean.split(/\s+/).filter(Boolean);
  // "a 200 g steak": an article in front of a real number is not the amount
  if (toks.length > 1 && /^(a|an|een|un|une)$/i.test(toks[0]) && /^\d/.test(toks[1])) toks.shift();
  // "een halve banaan" / "anderhalve": adjacent number words multiply (1 × 0.5)
  for (let i = 0; i + 1 < toks.length; i++) {
    const a = parseNumber(toks[i]), b = parseNumber(toks[i + 1]);
    if (a != null && b != null && !/^\d/.test(toks[i + 1])) { toks.splice(i, 2, String(a * b)); i--; }
  }
  // glue "120g" / "250ml" into number + unit
  toks = toks.flatMap(t => { const m = t.match(/^(\d+(?:[.,]\d+)?)([a-zA-Z]+)$/); return m ? [m[1], m[2]] : [t]; });
  let qty: number | undefined, unit: typeof UNITS[number] | undefined, unitTok: string | undefined;
  const take = (i: number) => {
    const n = parseNumber(toks[i]);
    if (n == null) return false;
    const u = toks[i + 1] ? UNITS.find(x => x.re.test(norm(toks[i + 1]))) : undefined;
    qty = n; unit = u; unitTok = u ? toks[i + 1] : undefined;
    toks.splice(i, u ? 2 : 1);
    return true;
  };
  if (!take(0) && toks.length >= 2) take(toks.length - 2) || take(toks.length - 1);
  // a unit with no number in front ("sneetje brood") = 1 of it
  if (!unit && toks.length > 1) { const u = UNITS.find(x => x.re.test(norm(toks[0]))); if (u) { unit = u; unitTok = toks.shift(); } }
  let query = toks.join(' ').replace(/^(van|de|het|of|du|de la|des)\s+/i, '').trim();
  // "3 boterhammen" / "2 slices": the unit word IS the food
  if (!query && unit && unitTok) query = /^(boterham|sneetje|snee|sneden|slice|tranche)/.test(norm(unitTok)) ? 'brood' : unitTok;
  if (!query) return null;
  const own = findOwn?.(query);
  // with the one-word fallback: a fragment is short, and "rolled oats" must still find oats
  const found = searchFoodsEx(query, 4, boost).items;
  const food = own ?? found[0];
  const alternatives = own ? found.slice(0, 3) : found.slice(1);
  const n = qty ?? 1;
  let grams: number;
  // a food whose own serving IS that spoon ("1 heaped tbsp" psyllium ≈ 7 g) uses its weight, not the generic 15 g
  const ownSpoon = !!food && !!unit && (unit.key === 'tbsp' || unit.key === 'tsp') && new RegExp(`\\b${unit.key}\\b`).test(defaultServing(food).label);
  if (ownSpoon && food) grams = n * defaultServing(food).g;
  else if (unit && unit.g != null) grams = n * unit.g;
  // a bare number ≥ 10 with no unit is grams ("200 rijst", "kip 150"), not 200 servings
  else if (!unit && qty != null && qty >= 10) grams = qty;   // (but see `countable` below)
  else if (food) grams = n * defaultServing(food).g;
  else grams = n * 100;
  // a built-in POWDER (whey, creatine, malto…) with a volume unit ("300 ml whey") is a shake: the ml is the liquid,
  // not the powder → use one scoop and make the user look
  const volume = !!unit && ['ml', 'cl', 'l', 'glass', 'cup', 'can', 'bottle', 'wine-bottle', 'carton', 'juicebox'].includes(unit.key);
  const powderInLiquid = food?.src === 'builtin' && volume && (food as { powder?: boolean }).powder === true;
  if (powderInLiquid && food) grams = defaultServing(food).g;
  grams = Math.round(grams);
  // "12 eieren" / "15 druiven": ≥10 read as grams, but it could be a count → don't mark it sure, make the user look
  const countable = !unit && qty != null && qty >= 10 && qty <= 24 && !!food && qty * defaultServing(food).g <= MAX_ITEM_GRAMS;
  return {
    text, query, qty: n, unit: unit?.key ?? (!unit && qty != null && qty >= 10 ? 'g' : undefined), food, alternatives, grams,
    sure: !!food && (qty != null || unit != null) && grams <= MAX_ITEM_GRAMS && !countable && !powderInLiquid,
  };
}

export function parseMeal(text: string, boost?: Record<string, number>, findOwn?: (q: string) => FoodItem | undefined): ParsedItem[] {
  // "1,5 banaan": a decimal comma is not a list separator
  return text.replace(/(\d),(\d)/g, '$1.$2').split(SPLIT).map(f => parseFragment(f, boost, findOwn)).filter((x): x is ParsedItem => !!x);
}

/** Heuristic: does this search-box text look like a phrase to parse rather than a single food to search? */
export function looksLikeMeal(text: string): boolean {
  const t = text.trim();
  if (t.length < 4) return false;
  if (SPLIT.test(` ${t} `) && t.split(SPLIT).filter(Boolean).length >= 2) return true;
  return /^(\d+([.,]\d+)?|½|een|twee|drie|one|two|three|un|une|deux|trois)\s+\S/i.test(t) || /\d\s*(g|gr|ml|cl|el|tl)\b/i.test(t);
}
