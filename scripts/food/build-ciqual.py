#!/usr/bin/env python3
"""
Build the bundled generic-food table (assets/food/ciqual-2025.json) from the official CIQUAL 2025 release.

Source: Anses. 2025. Table de composition nutritionnelle des aliments Ciqual 2025. DOI 10.57745/RDMHWY.
Licence: Licence Ouverte / Etalab 2.0 (redistribution + commercial use allowed, attribution required).
Download (Recherche Data Gouv, dataverse file ids):
  666260  Table Ciqual 2025_FR_2025_11_03.xlsx   → values (FR names)
  666252  alim_2025_11_03.xml                     → English names
  https://entrepot.recherche.data.gouv.fr/api/access/datafile/<id>

Usage: build-ciqual.py <ciqual.xlsx> <alim.xml> <out.json>

Values are copied UNCHANGED per 100 g, only a column subset is kept. Conventions from the CIQUAL docs:
  '-'            → not measured  → null
  'traces'       → trace amount  → 0
  '< x'          → below the limit of quantification → 0 (conservative for totals)
"""
import json, re, sys, html
import openpyxl

XLSX, ALIM_XML, OUT = sys.argv[1:4]

# key → xlsx column index (see the header row of the 2025 file)
COLS = {
    'kcal': 10,   # Energie, Règlement UE 1169/2011 (kcal/100 g)
    'prot': 14,   # Protéines, N x facteur de Jones
    'carb': 16,   # Glucides (available carbohydrate, EU convention)
    'fat': 17,    # Lipides
    'sug': 18,    # Sucres
    'fib': 26,    # Fibres alimentaires
    'sat': 31,    # AG saturés
    'salt': 49,   # Sel chlorure de sodium (g)
    'na': 60,     # Sodium (mg)
    'k': 58,      # Potassium (mg)
    'ca': 50,     # Calcium (mg)
    'fe': 53,     # Fer (mg)
    'mg': 55,     # Magnésium (mg)
    'water': 13,  # Eau (g)
    'alc': 29,    # Alcool (g)
    'vitC': 72,   # Vitamine C (mg)
    'vitD': 65,   # Vitamine D (µg)
}
KEYS = list(COLS)

def num(v):
    if v is None: return None
    s = str(v).strip().replace(',', '.')
    if s in ('', '-'): return None
    if s.lower().startswith('traces') or s.startswith('<'): return 0
    try: x = float(s)
    except ValueError: return None
    # CIQUAL publishes ≤ 3–4 significant digits; 4 keeps every value exactly as published. Whole numbers as ints.
    y = float(f'{x:.4g}')
    return int(y) if y == int(y) else y

en = {}
xml = open(ALIM_XML, encoding='utf-8-sig').read()
for m in re.finditer(r'<alim_code>\s*(\d+)\s*</alim_code>.*?<alim_nom_eng>(.*?)</alim_nom_eng>', xml, re.S):
    en[m.group(1)] = html.unescape(m.group(2).strip())

wb = openpyxl.load_workbook(XLSX, read_only=True)
rows = wb.active.iter_rows(values_only=True)
next(rows)
foods, groups = [], {}
for r in rows:
    code = str(r[6]).strip()
    if not code or code == 'None': continue
    grp = str(r[1] or r[0] or '').strip()
    grp_name = (r[4] or r[3] or '').replace('\n', ' ').strip()
    if grp and grp_name: groups[grp] = grp_name
    vals = [num(r[COLS[k]]) for k in KEYS]
    if vals[0] is None: continue           # no energy value → useless for a log
    foods.append([code, ' '.join((r[7] or '').split()), en.get(code, ''), grp] + vals)

out = {
    'v': 1,
    'src': 'ciqual-2025',
    'credit': 'Anses. 2025. Table de composition nutritionnelle des aliments Ciqual 2025. DOI 10.57745/RDMHWY (Etalab 2.0)',
    'per': '100 g',
    'cols': ['id', 'fr', 'en', 'grp'] + KEYS,
    'groups': groups,
    'foods': foods,
}
json.dump(out, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print(f'{len(foods)} foods, {len(groups)} groups → {OUT}')
