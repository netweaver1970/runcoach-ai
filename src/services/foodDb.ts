/**
 * Bundled generic-food table + local search (nutrition Option A — see docs/nutrition/REPORT.md §3.3).
 *
 * Source: CIQUAL 2025 (Anses, Licence Ouverte / Etalab 2.0), built by scripts/food/build-ciqual.py into
 * assets/food/ciqual-2025.json. Values per 100 g, UNCHANGED from the source (column subset only). The table is
 * read-only: user edits live in the food library as custom foods, never in here. NEVO (Dutch names) will be a
 * SEPARATE table once RIVM confirms bundling (decision D6) — never merge sources.
 *
 * CIQUAL has French + English names only, so Dutch queries go through a small NL→FR/EN token dictionary.
 * Search is local, keyless and offline; Open Food Facts is only queried on an explicit tap (foodOff.ts).
 */
import type { FoodItem, Nutr, NutrKey } from './foodLog';
import { servingOverrides } from './foodLog';
import { matchSports, sportsByKey } from './foodSports';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const RAW = require('../../assets/food/ciqual-2025.json') as {
  v: number; src: string; credit: string; cols: string[]; groups: Record<string, string>; foods: (string | number | null)[][];
};

/**
 * CAFFEINE (mg per 100 g / 100 ml) — CIQUAL doesn't measure it. Typical values for the table's caffeine sources:
 * EFSA 2015 (Scientific Opinion on the safety of caffeine, EFSA Journal 13(5):4102 — espresso ≈ 80 mg / 60 ml,
 * filter coffee ≈ 90 mg / 200 ml, cola ≈ 40 mg / 355 ml, energy drink 32 mg / 100 ml) and USDA FoodData Central
 * (instant powder, tea, cocoa, chocolate). Real cups vary ±50 %; your own value per food overrides (food editor).
 */
const CAFFEINE: Record<string, number> = {
  18004: 40, 18071: 133, 18073: 30, 18151: 30, 18003: 1000, 18005: 3100, 18160: 400, 18163: 350,          // coffee
  18070: 1, 18072: 1, 18069: 80,                                                                      // decaf
  18153: 10, 18162: 20, 18150: 800,                                                                   // chicory-coffee mixes
  18020: 20, 18154: 20, 18155: 12, 18076: 2500,                                                       // tea
  18018: 10, 18037: 10, 18063: 10, 18060: 12, 18067: 0, 18068: 0,                                      // cola
  18015: 7, 18062: 7, 18064: 7, 18065: 7, 18075: 7,                                                   // iced tea drinks
  18324: 32, 18352: 32, 18353: 32, 18354: 32,                                                         // energy drinks
  19116: 25, 19117: 25, 19118: 3, 19119: 3, 18104: 3, 18106: 3,                                       // milk drinks
  18100: 230, 18101: 45, 18167: 45, 18168: 45, 42501: 45,                                             // cocoa powders
  31074: 80, 31005: 43, 31085: 50, 31030: 60, 31069: 40, 31070: 40, 31072: 40, 31080: 40,             // dark chocolate
  31004: 20, 31009: 20, 31012: 20, 31018: 20, 31020: 20, 31084: 20, 31120: 30, 31010: 0, 31026: 0,    // milk / white
};

/** Full attribution required by Etalab 2.0 / REPORT.md §3.3 — shown on the Food screen. */
export const CIQUAL_CREDIT = RAW.credit;

// ─── normalisation ────────────────────────────────────────────────────────────────────────────────
export const norm = (s: string): string =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/œ/g, 'oe').replace(/[^a-z0-9]+/g, ' ').trim();
const words = (s: string): string[] => norm(s).split(' ').filter(w => w.length > 0);

/**
 * Dutch (and a few Belgian) food words → CIQUAL French/English tokens. Tokens, not phrases: "volle melk" →
 * volle→entier/whole + melk→lait/milk. Kept deliberately small and common; unknown words still match FR/EN.
 */
const NL: Record<string, string[]> = {
  // fruit
  banaan: ['banane', 'banana'], appel: ['apple'], peer: ['poire', 'pear'], sinaasappel: ['orange'],
  appelsien: ['orange'], mandarijn: ['mandarine', 'clementine'], druiven: ['raisin', 'grape'], druif: ['raisin', 'grape'],
  aardbei: ['fraise', 'strawberry'], aardbeien: ['fraise', 'strawberry'], framboos: ['framboise', 'raspberry'],
  bosbes: ['myrtille', 'blueberry'], bosbessen: ['myrtille', 'blueberry'], kiwi: ['kiwi'], ananas: ['ananas', 'pineapple'],
  mango: ['mangue', 'mango'], perzik: ['peche', 'peach'], pruim: ['prune', 'plum'], kers: ['cerise', 'cherry'],
  kersen: ['cerise', 'cherry'], citroen: ['citron', 'lemon'], meloen: ['melon'], watermeloen: ['pasteque', 'watermelon'],
  dadel: ['datte', 'date'], dadels: ['datte', 'date'], rozijnen: ['raisin', 'raisins'], vijg: ['figue', 'fig'],
  // vegetables
  tomaat: ['tomate', 'tomato'], tomaten: ['tomate', 'tomato'], komkommer: ['concombre', 'cucumber'], sla: ['laitue', 'salade', 'lettuce'],
  wortel: ['carotte', 'carrot'], wortelen: ['carotte', 'carrot'], ui: ['oignon', 'onion'], look: ['ail', 'garlic'],
  knoflook: ['ail', 'garlic'], paprika: ['poivron', 'pepper'], broccoli: ['brocoli', 'broccoli'], bloemkool: ['chou', 'cauliflower'],
  spinazie: ['epinard', 'spinach'], prei: ['poireau', 'leek'], champignons: ['champignon', 'mushroom'], erwten: ['pois', 'peas'],
  boontjes: ['haricot', 'bean'], bonen: ['haricot', 'bean'], witloof: ['endive', 'chicory'], courgette: ['courgette'],
  aubergine: ['aubergine'], mais: ['mais', 'corn'], avocado: ['avocat', 'avocado'], spruitjes: ['chou', 'brussels'],
  aardappel: ['potato'], aardappelen: ['potato'], patat: ['french fries'], frieten: ['french fries'], frietjes: ['french fries'], patatjes: ['french fries'], fritten: ['french fries'],
  friet: ['french fries'], zoete: ['douce', 'sweet'], linzen: ['lentille', 'lentil'], kikkererwten: ['pois chiche', 'chickpea'],
  // grains, bread
  brood: ['pain', 'bread'], boterham: ['pain', 'bread'], sneetje: ['pain', 'bread'], toast: ['pain grille', 'toast'],
  volkoren: ['complet', 'wholemeal', 'wholegrain'], bruin: ['complet', 'brown', 'bis'], wit: ['blanc', 'white'], witte: ['blanc', 'white'], stokbrood: ['baguette'],
  pistolet: ['petit pain', 'roll'], croissant: ['croissant'], havermout: ['avoine', 'oat'], haver: ['avoine', 'oat'],
  muesli: ['muesli'], cornflakes: ['corn', 'flakes'], rijst: ['riz', 'rice'], pasta: ['pates', 'pasta'],
  spaghetti: ['pasta dry cooked'], macaroni: ['pasta dry cooked'], penne: ['pasta dry cooked'], noedels: ['nouilles', 'noodles'], couscous: ['couscous'], quinoa: ['quinoa'],
  bloem: ['farine', 'flour'], ontbijtgranen: ['cereales', 'cereal'], beschuit: ['biscotte', 'rusk'], wafel: ['gaufre', 'waffle'],
  pannenkoek: ['crepe', 'pancake'], koek: ['biscuit', 'cake'], koekje: ['biscuit', 'cookie'], taart: ['tarte', 'gateau', 'cake'],
  // dairy, eggs
  melk: ['lait', 'milk'], volle: ['entier', 'whole'], halfvolle: ['demi', 'semi'], magere: ['ecreme', 'skimmed'],
  yoghurt: ['yaourt', 'yogurt', 'yoghurt'], kaas: ['fromage', 'cheese'], boter: ['beurre', 'butter'], room: ['creme', 'cream'],
  plattekaas: ['fromage blanc'], kwark: ['fromage blanc', 'quark'], ei: ['oeuf', 'egg'], eieren: ['oeuf', 'egg'],
  gekookt: ['cuit', 'cooked', 'bouilli', 'boiled'], gebakken: ['frit', 'fried', 'poele'], rauw: ['cru', 'raw'],
  // meat, fish
  kip: ['poulet', 'chicken'], kipfilet: ['chicken breast', 'filet poulet'], rund: ['boeuf', 'beef'], rundvlees: ['boeuf', 'beef'],
  varken: ['porc', 'pork'], varkensvlees: ['porc', 'pork'], ham: ['jambon', 'ham'],
  spek: ['lardon', 'bacon'], worst: ['saucisse', 'sausage'], salami: ['salami'], kalkoen: ['dinde', 'turkey'],
  vis: ['poisson', 'fish'], zalm: ['saumon', 'salmon'], tonijn: ['thon', 'tuna'], kabeljauw: ['cabillaud', 'cod'],
  garnalen: ['crevette', 'shrimp'], mosselen: ['moule', 'mussel'], haring: ['hareng', 'herring'], makreel: ['maquereau', 'mackerel'],
  // fats, spreads, sweets
  olie: ['huile', 'oil'], olijfolie: ['huile olive', 'olive oil'], olijf: ['olive'], margarine: ['margarine'],
  mayonaise: ['mayonnaise'], mayo: ['mayonnaise'], ketchup: ['ketchup'], mosterd: ['moutarde', 'mustard'],
  pindakaas: ['beurre cacahuete', 'peanut butter'], choco: ['pate a tartiner', 'chocolate spread'], confituur: ['confiture', 'jam'],
  jam: ['confiture', 'jam'], honing: ['miel', 'honey'], suiker: ['sucre', 'sugar'], chocolade: ['chocolat', 'chocolate'],
  snoep: ['bonbon', 'confiserie', 'candy'], ijs: ['glace', 'ice cream'], noten: ['mix nuts'], nootjes: ['mix nuts'], gemengde: ['mix', 'melange'],
  amandelen: ['amande', 'almond'], walnoten: ['noix', 'walnut'], pinda: ['cacahuete', 'peanut'], pindas: ['cacahuete', 'peanut'],
  // drinks
  water: ['eau', 'water'], koffie: ['cafe', 'coffee'], sap: ['jus', 'juice'], fruitsap: ['jus', 'juice'],
  appelsiensap: ['jus orange', 'orange juice'], bier: ['biere', 'beer'], wijn: ['vin', 'wine'], frisdrank: ['soda', 'boisson'],
  cola: ['cola'], soep: ['soupe', 'soup'],
  saus: ['sauce'], stoofvlees: ['boeuf', 'carbonade', 'stew'], vol: ['entier', 'whole'], mager: ['maigre', 'lean'],
  // compounds and Belgian words (review round 1)
  hesp: ['cooked ham', 'jambon'], appelsap: ['apple juice'], sinaasappelsap: ['orange juice'], tomatensoep: ['tomato soup'],
  groentesoep: ['soupe legumes', 'vegetable soup'], peperkoek: ['gingerbread'], ontbijtkoek: ['gingerbread'],
  gerookt: ['fume', 'smoked'], gerookte: ['fume', 'smoked'], chocomelk: ['chocolate milk beverage'],
  pils: ['biere', 'beer'], gehakt: ['minced steak', 'minced meat'], speculoos: ['speculoos'], thee: ['tea brewed', 'the'],
  // English words CIQUAL names differently
  rolled: ['flakes'], oatmeal: ['oat flakes'], havervlokken: ['oat flakes'], vlokken: ['flakes'], zout: ['salt', 'sel'], porridge: ['oat flakes boiled'], granola: ['granola'],
  fries: ['french fries'], chips: ['crisps', 'french fries'],
  cappuccino: ['cappuccino'], broodje: ['sandwich'], koekjes: ['biscuit', 'cookie'], zero: ['without added sugars'], light: ['without added sugars', 'allege'], sportdrank: ['sports drink'], isotoon: ['sports drink'],
};

// NB: not 'the' — that is French 'thé' (tea) after accent-stripping.
const STOP = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'a', 'au', 'aux', 'et', 'of', 'and', 'en', 'with', 'avec', 'met', 'van', 'een']);

/** A query token → its alternatives, each a PHRASE (list of words that must all match): the token itself plus
 *  its NL→FR/EN translations ("aardappel" → [["aardappel"], ["pomme","terre"], ["potato"]]). */
export interface Phrase { w: string[]; exact: boolean }
export function expandToken(t: string): Phrase[] {
  const out: Phrase[] = [{ w: [t], exact: false }];
  // naive plurals: "oats" → "oat", "lentilles" → "lentille"; Dutch "bananen" → "banaan"-ish, "koekjes" → "koek"
  if (t.length > 3 && t.endsWith('s')) out.push({ w: [t.slice(0, -1)], exact: false });
  const nlBase = t.length > 5 && t.endsWith('jes') ? t.slice(0, -3) : t.length > 5 && t.endsWith('en') ? t.slice(0, -2) : null;
  if (nlBase && NL[nlBase] === undefined) {
    // bananen → banan → banaan (double the vowel back) — only used if that base is in the dictionary
    const dv = nlBase.replace(/([aeou])([^aeiou])$/, '$1$1$2');
    const base = NL[dv] ? dv : NL[nlBase] ? nlBase : null;
    if (base) for (const alt of NL[base]) { const ws = words(alt).filter(w => !STOP.has(w)); if (ws.length) out.push({ w: ws, exact: true }); }
  }
  // translations must hit a WHOLE word (or its plural): "brood"→"bread" must not match "breaded"
  for (const alt of NL[t] ?? []) {
    const ws = words(alt).filter(w => !STOP.has(w));
    if (ws.length && !out.some(o => o.w.join(' ') === ws.join(' '))) out.push({ w: ws, exact: true });
  }
  return out;
}
const wordHit = (w: string, a: string, exact: boolean): number =>
  w === a || (exact && (w === a + 's' || w === a + 'x' || w === a + 'es')) ? 3 : !exact && w.startsWith(a) ? 2 : 0;

// ─── table ────────────────────────────────────────────────────────────────────────────────────────
interface Row { item: FoodItem; w: string[]; first: string[]; nWords: number; generic: boolean }
let TABLE: Row[] | null = null;
const HITS = new Map<string, number>();       // word → number of table foods it matches (the table never changes)
let BY_ID: Map<string, FoodItem> | null = null;

const COOK = /\b(cuit|cooked|bouilli|boiled|grille|grilled|roti|roasted|frit|fried|poele|braise|vapeur|steamed)\b/;
const RAWW = /\b(cru|crue|crus|crues|raw)\b/;

function load(): Row[] {
  if (TABLE) return TABLE;
  const cols = RAW.cols;
  const idx = (k: string) => cols.indexOf(k);
  const nKeys = cols.slice(4) as NutrKey[];
  const rows: Row[] = [];
  BY_ID = new Map();
  for (const f of RAW.foods) {
    const per100: Nutr = {};
    nKeys.forEach((k, i) => { const v = f[4 + i]; if (typeof v === 'number') per100[k] = v; });
    const caf = CAFFEINE[String(f[0])]; if (caf != null) per100.caf = caf;
    const fr = String(f[idx('fr')] ?? ''), en = String(f[idx('en')] ?? '');
    const item: FoodItem = { key: `ciqual:${f[0]}`, src: 'ciqual', id: String(f[0]), name: en || fr, nameAlt: fr, per100, grp: String(f[idx('grp')] ?? '') };
    const wf = words(fr), we = words(en);
    rows.push({ item, w: [...new Set([...wf, ...we])], first: [wf[0] ?? '', we[0] ?? ''], nWords: Math.min(wf.length || 99, we.length || 99), generic: /aliment moyen|average/.test(norm(fr + ' ' + en)) });
    BY_ID.set(item.key, item);
  }
  TABLE = rows;
  return rows;
}

export function foodByKey(key: string): FoodItem | undefined { load(); return BY_ID!.get(key) ?? sportsByKey(key); }
export const tableSize = () => load().length;

/**
 * Local search: every query token (or one of its NL expansions) must PREFIX-match a word of the FR or EN name.
 * Ranking: exact-word hits > prefix hits; first-word match; shorter (more generic) names; CIQUAL "average"
 * items; raw vs cooked follows the query (no cooking word → prefer raw/plain for produce, cooked for grains).
 * `boost` lets the caller lift foods the user logs often (key → weight).
 */
export function searchFoods(query: string, limit = 30, boost?: Record<string, number>): FoodItem[] {
  return searchFoodsEx(query, limit, boost, { fallback: false }).items;
}

export interface SearchResult { items: FoodItem[]; ignored: string[]; notCombined: string[] }

/**
 * Search + the words it had to set aside:
 *  - `ignored`: no food contains the word at all (typo, brand, filler) → "not in the food table"
 *  - `notCombined`: each word matches something, but no single food matches them together
 *    ("stoofvlees frietjes") → one word is set aside so the rest still finds something. Only for short queries
 *    (≤ 4 words); longer text is a meal phrase and belongs to the parser, not to search.
 */
export function searchFoodsEx(query: string, limit = 30, boost?: Record<string, number>, opts?: { fallback?: boolean }): SearchResult {
  const r = searchCore(query, limit, boost);
  if (r.items.length || opts?.fallback === false) return { ...r, notCombined: [] };
  const ws = words(query).filter(w => !STOP.has(w) && !/^\d+$/.test(w) && !r.ignored.includes(w));
  if (ws.length < 2 || ws.length > 4) return { ...r, notCombined: [] };
  // drop ONE word: the one fewest foods contain goes first (a modifier like "rolled" matches 2 foods, the food
  // itself — "oats" — matches many); dictionary words are kept longest; ties drop the LAST word (Dutch puts the
  // base food first: "yoghurt aardbei").
  const rows = load();
  const hits = (w: string) => HITS.get(w) ?? (HITS.set(w, countHits(rows, w)), HITS.get(w)!);
  const countHits = (rs: Row[], w: string) => rs.reduce((a, r) => a + (expandToken(w).some(ph => ph.w.every(x => r.w.some(y => wordHit(y, x, ph.exact) > 0))) ? 1 : 0), 0);
  const order = [...ws].reverse().map(w => ({ w, h: hits(w), nl: NL[w] ? 1 : 0 }))
    .sort((a, b) => a.nl - b.nl || a.h - b.h).map(x => x.w);
  for (const drop of order) {
    const rr = searchCore(ws.filter(w => w !== drop).join(' '), limit, boost);
    if (rr.items.length) return { items: rr.items, ignored: r.ignored, notCombined: [drop] };
  }
  return { ...r, notCombined: [] };
}

function searchCore(query: string, limit: number, boost?: Record<string, number>): { items: FoodItem[]; ignored: string[] } {
  // built-in sports/supplement items (creatine, whey, gels…) — no composition table carries them — come first
  const sports = matchSports(words(query).filter(t => !/^\d+$/.test(t)));
  const core = searchTable(query, limit, boost);
  if (!sports.length) return core;
  const qw = words(query).filter(t => !/^\d+$/.test(t));
  // words the built-in items matched are not "ignored"
  return { items: [...sports, ...core.items].slice(0, limit), ignored: core.ignored.filter(w => !qw.includes(w) || !matchSports([w]).length) };
}

function searchTable(query: string, limit: number, boost?: Record<string, number>): { items: FoodItem[]; ignored: string[] } {
  const q = words(query).filter(t => !/^\d+$/.test(t));      // numbers are portions, not food words
  if (!q.length) return { items: [], ignored: [] };
  const rows = load();
  const qCook = COOK.test(norm(query)) || q.some(t => (NL[t] ?? []).some(a => COOK.test(norm(a))));
  const qRaw = RAWW.test(norm(query)) || q.some(t => (NL[t] ?? []).some(a => RAWW.test(norm(a))));
  const qt = q.filter(t => !STOP.has(t));
  // A word no food contains (a typo, a brand, "lekker") would otherwise veto every result: drop it, and say so.
  const anyHit = (alts: Phrase[]) => rows.some(r => alts.some(ph => ph.w.every(a => a.length >= 2 && r.w.some(w => wordHit(w, a, ph.exact) > 0))));
  const ignored: string[] = [];
  const exp: Phrase[][] = [];
  for (const t of qt) { const e = expandToken(t); if (anyHit(e)) exp.push(e); else ignored.push(t); }
  if (!exp.length) return { items: [], ignored };
  const scored: { item: FoodItem; s: number }[] = [];
  for (const r of rows) {
    let s = 0, ok = true;
    for (const alts of exp) {
      let best = 0;
      for (const phrase of alts) {
        // a phrase scores its WEAKEST word; every word must match (single letters don't count)
        let ph = 3;
        for (const a of phrase.w) {
          if (a.length < 2) { ph = 0; break; }
          let wb = 0;
          for (const w of r.w) { wb = Math.max(wb, wordHit(w, a, phrase.exact)); if (wb === 3) break; }
          ph = Math.min(ph, wb);
          if (!ph) break;
        }
        best = Math.max(best, ph);
        if (best === 3) break;
      }
      if (!best) { ok = false; break; }
      s += best;
    }
    if (!ok) continue;
    // first word of the FR and/or EN name = what the food IS ("Butter, …" beats "Butter bean")
    for (const f of r.first) if (f && exp.some(alts => alts.some(ph => ph.w[0] === f || (!ph.exact && ph.w[0].length >= 3 && f.startsWith(ph.w[0]))))) s += 1.5;
    s -= Math.min(r.nWords, 14) * 0.18;
    if (r.generic) s += 0.6;
    const name = norm((r.item.nameAlt ?? '') + ' ' + r.item.name);
    const qn = norm(query);
    if (/\b(preemballe|preemballee|preemballes|preemballees|prepacked)\b/.test(name) && !/prepack|preemball/.test(qn)) s -= 0.5;
    // drinks: the ready-to-drink item, not the powder/ground product, unless asked for
    // "boter"/"butter" means the normal product; light versions only when asked
    if (/\b(allege|allegee|reduced fat|light|reduite)\b/.test(name) && !/light|allege|halvarine|minder vet|reduced/.test(qn)) s -= 0.7;
    if (/\b(moulu|poudre|powder|ground|soluble|lyophilise|feuille|feuilles|leaf|leaves)\b/.test(name) && !/poudre|powder|ground|moulu|soluble|leaf|feuille/.test(qn)) s -= 1.5;
    if (qCook) s += COOK.test(name) ? 1.5 : 0;
    else if (qRaw) s += RAWW.test(name) ? 1.5 : 0;
    else {
      // grains/pasta/rice (grp 0301) are eaten cooked; produce/meat/fish default to raw/plain
      const g = r.item.grp ?? '';
      // grains, pasta, potatoes, meat and fish are weighed as eaten = cooked; vegetables and fruit default to raw
      // …except flakes (oats, muesli): those are weighed DRY — "80 g rolled oats" is 300 kcal, not 55
      if ((g === '0301' || g === '0202' || g === '0203' || g.startsWith('04')) && !/\b(flocons|flakes)\b/.test(name)) s += COOK.test(name) || g === '0401' || g === '0405' || g === '0407' ? 1 : 0;
      if (g === '0301' && /\b(blanc|white)\b/.test(name)) s += 0.3;   // plain "rijst"/"pasta" = the white one
      else if (g.startsWith('02') && g !== '0205') s += RAWW.test(name) ? 0.8 : 0;
    }
    if (boost?.[r.item.key]) s += boost[r.item.key];
    scored.push({ item: r.item, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return { items: scored.slice(0, limit).map(x => x.item), ignored };
}

/** A sensible default serving by CIQUAL group — only a starting point; the app remembers the user's own. */
const GROUP_SERVING: Record<string, { g: number; label: string }> = {
  '0204': { g: 120, label: '1 piece' }, '0205': { g: 30, label: 'handful' }, '0201': { g: 100, label: 'portion' },
  '0202': { g: 200, label: 'portion' }, '0203': { g: 150, label: 'portion' }, '0301': { g: 180, label: 'cooked portion' },
  '0302': { g: 35, label: '1 slice' }, '0705': { g: 55, label: '1 piece' }, '0706': { g: 25, label: '2 biscuits' },
  '0707': { g: 40, label: 'bowl' }, '0708': { g: 25, label: '1 bar' }, '0709': { g: 90, label: '1 slice' },
  '0401': { g: 120, label: 'portion' }, '0402': { g: 120, label: 'portion' }, '0403': { g: 25, label: '1 slice' },
  '0405': { g: 130, label: 'portion' }, '0406': { g: 130, label: 'portion' }, '0410': { g: 55, label: '1 egg' },
  '0501': { g: 250, label: 'glass' }, '0502': { g: 125, label: '1 pot' }, '0503': { g: 30, label: '1 slice' },
  '0504': { g: 20, label: 'spoon' }, '0601': { g: 250, label: 'glass' }, '0602': { g: 250, label: 'glass' },
  '0603': { g: 250, label: 'glass' }, '0701': { g: 10, label: '2 tsp' }, '0702': { g: 20, label: '2 squares' },
  '0703': { g: 20, label: 'portion' }, '0704': { g: 15, label: '1 tbsp' }, '0801': { g: 70, label: '1 scoop' },
  '0901': { g: 10, label: 'knob' }, '0902': { g: 10, label: '1 tbsp' }, '0903': { g: 10, label: 'knob' },
  '1001': { g: 20, label: '1 tbsp' }, '1002': { g: 10, label: '1 tsp' }, '1004': { g: 1, label: 'pinch' },
  '1005': { g: 1, label: 'pinch' }, '1006': { g: 2, label: 'pinch' }, '0102': { g: 250, label: 'bowl' },
  '0103': { g: 300, label: 'plate' }, '0104': { g: 150, label: 'slice' }, '0105': { g: 200, label: '1 sandwich' },
};
export function defaultServing(f: FoodItem): { g: number; label: string } {
  const own = servingOverrides[f.key];   // the serving size YOU set for this food wins
  if (own && own.g > 0) return own;
  if (f.serving) return f.serving;
  // dry grains / flakes / dry pasta are weighed dry: 180 g "cooked portion" of raw oats would be ~680 kcal
  if ((f.grp === '0301' || f.grp === '0707') && /\b(raw|cru|crue|crus|dry|sec|seche|seches|flakes|flocons)\b/.test(norm(`${f.name} ${f.nameAlt ?? ''}`))
    && !COOK.test(norm(`${f.name} ${f.nameAlt ?? ''}`))) return { g: 60, label: 'dry portion' };
  return GROUP_SERVING[f.grp ?? ''] ?? { g: 100, label: '100 g' };
}
