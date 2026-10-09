/**
 * Built-in sports / supplement items that no food composition table carries (CIQUAL has no creatine, whey,
 * gels…). Values are TYPICAL LABEL values per 100 g, clearly marked as estimates in the UI; the user's own label
 * (🏷️ Label) or an Open Food Facts product beats them. `supp` links an item to the supplement tracker: logging it
 * also marks a matching supplement (by name) as taken that day.
 */
import type { FoodItem } from './foodLog';

export interface SportsItem extends FoodItem { aliases: string[]; supp?: RegExp; note: string; powder?: boolean }

const item = (id: string, name: string, per100: FoodItem['per100'], serving: { g: number; label: string }, aliases: string[], note: string, supp?: RegExp, powder = true): SportsItem =>
  ({ key: `builtin:${id}`, src: 'builtin', id, name, per100, serving, aliases, note, powder, ...(supp ? { supp } : {}) });

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
    return queryWords.every(q => aw.some(w => w === q || (q.length >= 4 && w.startsWith(q))));
  }));
}
export const sportsByKey = (key: string) => SPORTS_ITEMS.find(s => s.key === key);
