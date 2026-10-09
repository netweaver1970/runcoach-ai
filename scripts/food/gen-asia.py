import json, re
d = json.load(open(__import__('os').path.join(__import__('os').path.dirname(__file__), 'sgmy-foods.json')))
# generic words that would hijack everyday (Belgian) searches → dropped
DROP = {'rice','white rice','steamed rice','egg','soft boiled egg','crab','curry','curry gravy','dhal','beer','lager','bir','cocktail',
  'milk tea','black coffee','black coffee sugar','fried rice','coconut rice','isotonic','sports drink','barley','carrot cake','fish soup',
  'peanut sauce','iced lemon tea','lime tea','tiger','layer cake','no sugar','0% sugar','less sugar','50% sugar','half sugar','chocolate malt',
  'dried meat','sliced pork','sliced chicken','fresh spring roll','fish noodle soup','local coffee','local tea','medallion','fragrance',
  'kopitiam breakfast','toast set','set a','abc','king of fruits','sambal goreng','malay rice','chicken wing nasi lemak','bbq pork jerky','pork jerky','barbecued pork slice'}
CJK = re.compile(r'[　-鿿]')
CAT = {'kopi':'Coffee & tea','kopi_o':'Coffee & tea','kopi_c':'Coffee & tea','kopi_o_kosong':'Coffee & tea','teh':'Coffee & tea','teh_c':'Coffee & tea',
  'teh_tarik':'Coffee & tea','teh_o_ice_limau':'Coffee & tea','bubble_milk_tea_full':'Coffee & tea','bubble_milk_tea_less_sugar':'Coffee & tea',
  'bubble_milk_tea_no_sugar':'Coffee & tea','milo_hawker':'Milk drinks','milo_iced':'Milk drinks','milo_dinosaur':'Milk drinks','bandung':'Milk drinks',
  'sugarcane_juice':'Juices & smoothies','barley_drink':'Soft drinks','100plus_original':'Soft drinks','tiger_beer':'Beer & cider','singapore_sling':'Cocktails'}
BRAND = [('ock','Old Chang Kee'),('ya_kun','Ya Kun'),('bch','Bee Cheng Hiang'),('lim_chee_guan','Lim Chee Guan'),('fragrance','Fragrance'),('kim_joo_guan','Kim Joo Guan'),('kim_hock_guan','Kim Hock Guan'),('100plus','100PLUS'),('tiger','Tiger')]
def num(v): return ('%g' % round(v, 2))
out = []
for x in d:
  p = {k: v for k, v in x['per100'].items() if v is not None}
  if 'na' in p: p['salt'] = round(p['na'] * 2.5 / 1000, 2)
  per = '{ ' + ', '.join(f'{k}: {num(v)}' for k, v in p.items()) + ' }'
  al = []
  for a in x['aliases']:
    a2 = a.lower().strip()
    if a2 in DROP or CJK.search(a2) or a2 in al: continue
    al.append(a2)
  lab = x['serving']['label']; short = re.split(r' \(', lab)[0]
  src = re.sub(r'\s*[—–-]?\s*https?://\S+', '', x['source']).strip().rstrip(';,')   # URLs stay in the JSON
  note = f"{src} · Serving: {lab}."
  brand = next((b for k, b in BRAND if x['id'].startswith(('bak_kwa_' + k, k))), None)
  extra = []
  if brand: extra.append(f"brand: {json.dumps(brand)}")
  if x['unit'] == 'ml': extra.append(f"drinkCat: {json.dumps(CAT[x['id']])}")
  out.append(f"  a({json.dumps(x['id'])}, {json.dumps(x['name'], ensure_ascii=False)}, {json.dumps(x['category'])}, {per}, {x['serving']['g']}, {json.dumps(short, ensure_ascii=False)}, {json.dumps(al, ensure_ascii=False)}, {json.dumps(note, ensure_ascii=False)}, {json.dumps(x['unit'])}{', { ' + ', '.join(extra) + ' }' if extra else ''}),")
hdr = '''/**
 * SINGAPORE / MALAYSIA foods (Geert travels there often, 2026-10-09): bak kwa by brand and size (square slices vs
 * gold-coin medallions), hawker dishes, kopitiam breakfast, kueh, fruit and kopi / teh / Milo drinks. GENERATED from
 * scripts/food/sgmy-foods.json (scripts/food/gen-asia.py) — edit the JSON, not this file.
 * Sources: mostly HPB Singapore FoodID (lab-analysed, ex-FOCOS) per 100 g with HPB portion sizes; Malaysian MyFCD for a
 * few MY dishes; brand labels for Bee Cheng Hiang. ESTIMATES (said in each note): the other bak kwa brands (no label
 * online → HPB generic), all caffeine values (kopi ≈ 50–60 mg / 100 ml), satay / ondeh portions, "less sugar" bubble tea.
 * Matching is FULL-ALIAS (`full`): "chicken" alone never pulls up chicken rice, "pork" never bak kwa — name the dish.
 */
import type { SportsItem } from './foodSports';
import type { FoodItem } from './foodLog';

export type AsiaCat = 'Bak kwa' | 'Rice' | 'Noodles' | 'Hawker mains' | 'Breakfast' | 'Snacks & kueh' | 'Desserts' | 'Fruit' | 'Drinks';
export const ASIA_CATS: AsiaCat[] = ['Bak kwa', 'Rice', 'Noodles', 'Hawker mains', 'Breakfast', 'Snacks & kueh', 'Desserts', 'Fruit', 'Drinks'];
export interface AsiaItem extends SportsItem { asiaCat: AsiaCat }

const a = (id: string, name: string, asiaCat: AsiaCat, per100: FoodItem['per100'], g: number, label: string, aliases: string[], note: string,
  unit: 'g' | 'ml', extra: { brand?: string; drinkCat?: string } = {}): AsiaItem =>
  ({ key: `builtin:sgmy_${id}`, src: 'builtin', id: `sgmy_${id}`, name, per100, serving: { g, label }, ...(unit === 'ml' ? { unit } : {}),
    aliases, note, powder: false, full: true, asiaCat, ...extra });

export const ASIA_ITEMS: AsiaItem[] = [
'''
open(__import__('os').path.join(__import__('os').path.dirname(__file__), '../../src/services/foodAsia.ts'), 'w').write(hdr + '\n'.join(out) + '\n];\n')
print(len(out))
