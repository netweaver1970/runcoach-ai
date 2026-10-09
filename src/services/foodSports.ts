/**
 * Built-in sports / supplement items that no food composition table carries (CIQUAL has no creatine, whey,
 * gels…). Values are TYPICAL LABEL values per 100 g, clearly marked as estimates in the UI; the user's own label
 * (🏷️ Label) or an Open Food Facts product beats them. `supp` links an item to the supplement tracker: logging it
 * also marks a matching supplement (by name) as taken that day.
 */
import type { FoodItem } from './foodLog';

export interface SportsItem extends FoodItem { aliases: string[]; supp?: RegExp; note: string; powder?: boolean; drinkCat?: string }

const item = (id: string, name: string, per100: FoodItem['per100'], serving: { g: number; label: string }, aliases: string[], note: string, supp?: RegExp, powder = true): SportsItem =>
  ({ key: `builtin:${id}`, src: 'builtin', id, name, per100, serving, aliases, note, powder, ...(supp ? { supp } : {}) });

/** A built-in DRINK (per 100 ml, unit ml). Cocktails: standard IBA-style recipes, alcohol 0.789 g/ml, mixers from
 *  CIQUAL / USDA (tonic 8.8 g, cola 10.6 g, ginger beer 9 g sugar per 100 ml…), ~15 % meltwater dilution. */
const drink = (id: string, name: string, per100: FoodItem['per100'], ml: number, label: string, aliases: string[], note: string): SportsItem =>
  ({ key: `builtin:${id}`, src: 'builtin', id, name, per100, serving: { g: ml, label }, unit: 'ml', aliases, note, powder: false });

/** Cocktails CIQUAL doesn't have (it has rum- / whisky-based averages, sangria, kir, punch, shandy). */
export const COCKTAILS: SportsItem[] = [
  drink('gin_tonic', 'Gin tonic', { kcal: 81, carb: 6.6, sug: 6.6, alc: 7.9, prot: 0, fat: 0 }, 200, '1 glass', ['gin tonic', 'gin and tonic', 'gin & tonic', 'g&t', 'gintonic'], '50 ml gin + 150 ml tonic.'),
  drink('aperol_spritz', 'Aperol spritz', { kcal: 81, carb: 7.4, sug: 7.2, alc: 7.2, prot: 0, fat: 0 }, 180, '1 glass', ['aperol spritz', 'spritz', 'aperol'], '60 ml Aperol + 90 ml prosecco + 30 ml soda.'),
  drink('hugo', 'Hugo (prosecco, elderflower)', { kcal: 69, carb: 8.2, sug: 8, alc: 5.1, prot: 0, fat: 0 }, 170, '1 glass', ['hugo', 'hugo spritz'], '100 ml prosecco + 20 ml elderflower syrup + soda, mint, lime.'),
  drink('mojito', 'Mojito', { kcal: 98, carb: 8.2, sug: 8, alc: 9.3, prot: 0, fat: 0 }, 170, '1 glass', ['mojito'], '50 ml white rum, lime, ~13 g sugar, mint, soda.'),
  drink('caipirinha', 'Caipirinha', { kcal: 171, carb: 12.2, sug: 12, alc: 17.6, prot: 0, fat: 0 }, 90, '1 glass', ['caipirinha', 'caipiroska'], '50 ml cachaça, ½ lime, 2 tsp sugar.'),
  drink('margarita', 'Margarita', { kcal: 180, carb: 7.3, sug: 7, alc: 21.5, prot: 0, fat: 0 }, 110, '1 glass', ['margarita'], '50 ml tequila + 25 ml triple sec + 25 ml lime.'),
  drink('daiquiri', 'Daiquiri', { kcal: 139, carb: 9.6, sug: 9.4, alc: 14.4, prot: 0, fat: 0 }, 110, '1 glass', ['daiquiri'], '50 ml rum, 25 ml lime, 15 ml sugar syrup.'),
  drink('pina_colada', 'Piña colada', { kcal: 147, carb: 14.7, sug: 14, fat: 2.6, alc: 9.3, prot: 0.3 }, 200, '1 glass', ['pina colada', 'piña colada'], '50 ml rum, 90 ml pineapple juice, 30 ml coconut cream.'),
  drink('cosmopolitan', 'Cosmopolitan', { kcal: 128, carb: 6.8, sug: 6.5, alc: 14.4, prot: 0, fat: 0 }, 120, '1 glass', ['cosmopolitan', 'cosmo'], '40 ml vodka, 15 ml Cointreau, 30 ml cranberry, lime.'),
  drink('negroni', 'Negroni', { kcal: 180, carb: 11.7, sug: 11.5, alc: 19, prot: 0, fat: 0 }, 100, '1 glass', ['negroni'], '30 ml each gin, Campari, sweet vermouth.'),
  drink('espresso_martini', 'Espresso martini', { kcal: 157, carb: 12.7, sug: 12.5, alc: 15.2, caf: 31, prot: 0, fat: 0 }, 130, '1 glass', ['espresso martini'], '50 ml vodka, 25 ml coffee liqueur, 30 ml espresso, syrup — ~40 mg caffeine.'),
  drink('cuba_libre', 'Rum & cola (Cuba libre)', { kcal: 87, carb: 8, sug: 8, alc: 7.9, caf: 5, prot: 0, fat: 0 }, 200, '1 glass', ['cuba libre', 'rum cola', 'rum coke', 'bacardi cola'], '50 ml rum + 150 ml cola.'),
  drink('whisky_cola', 'Whisky & cola', { kcal: 87, carb: 8, sug: 8, alc: 7.9, caf: 5, prot: 0, fat: 0 }, 200, '1 glass', ['whisky cola', 'whiskey cola', 'whisky coke', 'jack coke'], '50 ml whisky + 150 ml cola.'),
  drink('vodka_mix', 'Vodka with soft drink / juice', { kcal: 85, carb: 8, sug: 8, alc: 7.9, prot: 0, fat: 0 }, 200, '1 glass', ['vodka orange', 'vodka sprite', 'vodka juice', 'screwdriver'], '50 ml vodka + 150 ml juice / soft drink.'),
  // Geert (dancing): vodka + a 250 ml can of Red Bull (11 g sugar, 32 mg caffeine per 100 ml) — mind the caffeine late at night
  drink('vodka_redbull', 'Vodka Red Bull', { kcal: 68, carb: 9.5, sug: 9.5, alc: 4.3, caf: 27.6, prot: 0, fat: 0 }, 290, '1 glass (40 ml + 1 can)', ['vodka red bull', 'vodka redbull', 'vodka energy', 'vodka energy drink', 'vodka rb', 'vodka bull'], '40 ml vodka + 250 ml Red Bull: ~12.6 g alcohol, 27.5 g sugar, 80 mg caffeine, ~200 kcal.'),
  drink('vodka_redbull_sf', 'Vodka Red Bull sugarfree', { kcal: 31, carb: 0.4, sug: 0, alc: 4.3, caf: 27.6, prot: 0, fat: 0 }, 290, '1 glass (40 ml + 1 can)', ['vodka red bull sugarfree', 'vodka red bull sugar free', 'vodka redbull zero', 'vodka red bull zero', 'vodka bull light'], '40 ml vodka + 250 ml Red Bull Sugarfree: ~12.6 g alcohol, 80 mg caffeine, ~90 kcal.'),
  drink('moscow_mule', 'Moscow mule', { kcal: 87, carb: 6.4, sug: 6.2, alc: 8.8, prot: 0, fat: 0 }, 180, '1 glass', ['moscow mule', 'mule'], '50 ml vodka + 120 ml ginger beer + lime.'),
  drink('bloody_mary', 'Bloody Mary', { kcal: 71, carb: 2.3, sug: 2, alc: 8.8, prot: 0.5, fat: 0, na: 400, salt: 1 }, 180, '1 glass', ['bloody mary'], '50 ml vodka + 120 ml tomato juice, seasoning.'),
  drink('mimosa', 'Mimosa', { kcal: 51, carb: 5.2, sug: 5, alc: 4.3, prot: 0.3, fat: 0 }, 150, '1 glass', ['mimosa', 'bucks fizz'], 'Prosecco + orange juice 1:1.'),
  drink('old_fashioned', 'Old fashioned', { kcal: 197, carb: 5.3, sug: 5.3, alc: 25.2, prot: 0, fat: 0 }, 75, '1 glass', ['old fashioned'], '60 ml bourbon, sugar cube, bitters.'),
  drink('irish_coffee', 'Irish coffee', { kcal: 88, carb: 5.3, sug: 5.3, fat: 2.5, alc: 6.3, caf: 25, prot: 0.3 }, 200, '1 glass', ['irish coffee'], '40 ml whiskey, coffee, brown sugar, cream — ~50 mg caffeine.'),
];

export const SPORTS_ITEMS: SportsItem[] = [
  item('creatine', 'Creatine monohydrate', { kcal: 0, prot: 0, carb: 0, fat: 0 }, { g: 5, label: '1 scoop' },
    ['creatine', 'creatin', 'creatine monohydrate', 'kreatine', 'creatine monohydraat'], 'Creatine provides no usable energy (0 kcal).', /creatin/i),
  // no "shake" aliases: a shake is powder + liquid — "proteine shake 300ml" must not become 300 g of powder
  item('whey', 'Whey protein powder (typical)', { kcal: 395, prot: 78, carb: 9, fat: 5.5, sug: 6, salt: 0.5, na: 200 }, { g: 30, label: '1 scoop' },
    ['whey', 'whey protein', 'protein powder', 'eiwitpoeder', 'proteine poeder', 'proteinepoeder'], 'Typical whey concentrate label; use your tub\'s label for exact values.', /whey|prote|eiwit/i),
  // a made-up shake (1 scoop whey + ~300 mL water), logged as the LIQUID: "proteine shake 300ml" ≈ 110 kcal
  item('shake', 'Protein shake (1 scoop whey in water)', { kcal: 36, prot: 7.1, carb: 0.8, fat: 0.5, na: 18 }, { g: 330, label: '1 shake' },
    ['protein shake', 'proteine shake', 'proteineshake', 'eiwitshake', 'whey shake'], '1 scoop (30 g) of typical whey in ~300 mL water; made with milk it is roughly double.', /whey|prote|eiwit/i, false),
  item('casein', 'Casein protein powder (typical)', { kcal: 360, prot: 80, carb: 5, fat: 1.5, salt: 0.6 }, { g: 30, label: '1 scoop' },
    ['casein', 'caseine', 'caseïne'], 'Typical micellar casein label.', /casein|caseine/i),
  item('gel', 'Energy gel (typical, ~25 g carbs)', { kcal: 250, prot: 0, carb: 62, fat: 0, sug: 30, na: 150, salt: 0.375 }, { g: 40, label: '1 gel' },
    ['gel', 'gels', 'energy gel', 'energiegel', 'sportgel', 'sport gel', 'running gel'], 'Typical 40 g gel with ~25 g carbs; brands vary a lot (isotonic gels are ~22 g per 60 g).', undefined, false),
  item('malto', 'Maltodextrin', { kcal: 380, prot: 0, carb: 95, fat: 0, sug: 5 }, { g: 30, label: '1 scoop' },
    ['maltodextrin', 'maltodextrine', 'malto'], 'Pure carbohydrate powder.'),
  item('electrolyte', 'Electrolyte tablet (typical)', { kcal: 50, carb: 10, prot: 0, fat: 0, na: 7500, salt: 18.75, k: 1500 }, { g: 4, label: '1 tablet' },
    ['electrolyte', 'electrolytes', 'elektrolyten', 'electrolyte tablet', 'hydration tablet', 'nuun'], 'Typical 4 g effervescent tablet: ~300 mg sodium, ~2 kcal.', /electro|elektro|nuun/i),
  item('collagen', 'Collagen peptides', { kcal: 360, prot: 90, carb: 0, fat: 0 }, { g: 10, label: '1 scoop' },
    ['collagen', 'collageen', 'collagene'], 'Typical hydrolysed collagen label.', /collag/i),
  // CIQUAL has no psyllium (Geert 2026-10-09). EU label convention: fibre is NOT in the carbs and counts 2 kcal/g →
  // ~88 g fibre ≈ 176 kcal of the 194 (Kruidvat / Holland & Barrett psyllium labels on Open Food Facts).
  item('psyllium', 'Psyllium husk (whole husks)', { kcal: 194, prot: 1.4, carb: 2.5, fat: 0.25, sug: 0, fib: 88 }, { g: 7, label: '1 heaped tbsp' },
    ['psyllium', 'psyllium husk', 'psyllium husks', 'psylliumvezels', 'psyllium vezels', 'vlozaad', 'vlozaadvezels', 'vlozaad vezels', 'vlozaadvlies', 'ispaghula', 'ispaghul', 'metamucil', 'psyllium powder'],
    'Typical label: ~88 % fibre. 1 heaped tbsp of WHOLE husks ≈ 7 g (a level one ≈ 4–5 g); powder is denser — 1 tbsp ≈ 10 g. Take it with plenty of water.', /psyll|vlozaad|ispaghul/i),
];

const n = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Built-in items whose alias contains all query words. Words under 4 letters must match a WHOLE alias word
 * ("ei" = egg must never hit "eiwitpoeder", "ma" must not hit maltodextrin); longer words may prefix-match.
 */
export function matchSports(queryWords: string[]): SportsItem[] {
  if (!queryWords.length) return [];
  return SPORTS_ITEMS.filter(it => it.aliases.some(a => {
    const aw = n(a).split(' ');
    const all = queryWords.every(q => aw.some(w => w === q || (q.length >= 4 && w.startsWith(q))));
    // a DRINK alias of several words ('whiskey cola') must be named in full — 'whiskey' alone is the spirit, not the mix
    return all && (!it.unit || aw.every(w => queryWords.some(q => q === w || (q.length >= 4 && w.startsWith(q)))));
  }));
}
/** Liqueurs CIQUAL doesn't have. */
export const LIQUEURS: SportsItem[] = [
  // Geert: advocaat, served by the tablespoon. Warninks-type label per 100 ml: 17.2 % vol (13.6 g alcohol), 28.5 g
  // sugar, 6.9 g fat, 4.4 g protein → ~290 kcal
  { ...drink('advocaat', 'Advocaat (egg liqueur)', { kcal: 290, carb: 28.5, sug: 28.4, fat: 6.9, sat: 2, prot: 4.4, alc: 13.6 }, 15, '1 tbsp',
    ['advocaat', 'advokaat', 'eierlikeur', 'eierlikör', 'egg liqueur', 'warninks'], 'Egg liqueur ~17 % vol; 1 tbsp ≈ 15 ml ≈ 2 g alcohol, 44 kcal.'), drinkCat: 'Spirits & liqueurs' },
];
SPORTS_ITEMS.push(...COCKTAILS, ...LIQUEURS);   // drinks are searched / logged like the other built-ins
export const sportsByKey = (key: string) => SPORTS_ITEMS.find(s => s.key === key);
