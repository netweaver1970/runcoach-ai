# Generates src/services/foodPatisserie.ts from scripts/food/patisserie.json — edit the JSON, then run this.
import json, os, re
here = os.path.dirname(__file__)
d = json.load(open(os.path.join(here, 'patisserie.json')))
num = lambda v: '%g' % round(v, 2)
out = []
for x in d:
  p = {k: v for k, v in x['per100'].items() if v is not None}
  if 'na' in p: p['salt'] = round(p['na'] * 2.5 / 1000, 2)
  per = '{ ' + ', '.join(f'{k}: {num(v)}' for k, v in p.items()) + ' }'
  al = []
  for a in x['aliases']:
    a2 = a.lower().strip()
    if a2 not in al: al.append(a2)
  lab = x['serving']['label']; short = re.split(r' \(', lab)[0]
  src = re.sub(r'\s*[—–-]?\s*https?://\S+', '', x['source']).strip().rstrip(';,')
  note = f"{src} · Serving: {lab}."
  out.append(f"  p({json.dumps(x['id'])}, {json.dumps(x['name'], ensure_ascii=False)}, {per}, {x['serving']['g']}, {json.dumps(short, ensure_ascii=False)}, {json.dumps(al, ensure_ascii=False)}, {json.dumps(note, ensure_ascii=False)}),")
hdr = '''/**
 * PATISSERIE (Geert 2026-10-10: "add common patisserie foods, incl. bread pudding") — Belgian / Dutch / French bakery
 * items CIQUAL doesn't carry. GENERATED from scripts/food/patisserie.json (scripts/food/gen-patisserie.py) — edit the
 * JSON, not this file. Display names Dutch / English (French names only as search aliases). Sources: NEVO-Online 2025,
 * USDA SR Legacy, Belgian / Dutch product labels; recipe-based ESTIMATES are marked in each note.
 * Matching is FULL-ALIAS (`full`): "pudding" or "taart" alone never pulls these up — name the pastry.
 */
import type { SportsItem } from './foodSports';
import type { FoodItem } from './foodLog';

const p = (id: string, name: string, per100: FoodItem['per100'], g: number, label: string, aliases: string[], note: string): SportsItem =>
  ({ key: `builtin:pat_${id}`, src: 'builtin', id: `pat_${id}`, name, per100, serving: { g, label }, aliases, note, powder: false, full: true });

export const PATISSERIE_ITEMS: SportsItem[] = [
'''
open(os.path.join(here, '../../src/services/foodPatisserie.ts'), 'w').write(hdr + '\n'.join(out) + '\n];\n')
print(len(out))
