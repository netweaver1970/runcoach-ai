# WS2: Free food databases, and the Belgian barcode spike

**Date:** 2026-09-28 (overnight research run). **Status:** done. **Author:** WS2 databases specialist.
**Scope:** [BRIEF.md](/Users/geertsteyaert/projects/runcoach-ai/docs/nutrition/BRIEF.md) §Workstreams 2. Research only: no app code was changed. The spike scripts and their raw JSON output are in `/private/tmp/claude-501/-Users-geertsteyaert-Claude-iphone---mcp-apple-health-integration/483e295a-fc0e-4f46-900f-6ce14d7f5462/scratchpad/nutrition/` (`off_spike.py`, `fdc_spike.py`, `ciq2.py`, plus `*_results*.json`). The spike used only public product and food data. No personal data was used.

## TL;DR

- **Branded Belgian products → Open Food Facts (OFF).** OFF was the only free source in the spike that found Belgian barcodes. It found **10 of 12** Belgian-prefixed store-brand barcodes (Colruyt Boni/Everyday, Delhaize) and **17 of 19** overall. Only **14 of 19** could be used without a correction.
  - Every hit had the EU "big 7" nutrients per 100 g.
  - **None had any micronutrient or caffeine.** OFF can only hold what the pack label declares, so this is structural.
  - Only **4 of 10** Belgian hits had a Dutch product name.
- **Generic foods → bundle a national table offline.** The best fit is **NEVO** (Dutch and English names, 2,328 foods, 142 nutrient columns), with **CIQUAL** alongside (French and English names, 3,484 foods, Etalab 2.0 licence, the most permissive).
  - All 10 test foods exist in NEVO, CIQUAL and USDA FDC.
  - **Naive search ranking is poor in all three:** 5 of 10 (CIQUAL), 8 of 10 (NEVO) and 4 of 7 (FDC) correct at the top. The app needs its own local search: token or FTS matching, synonyms, and a "raw / cooked" preference.
- **The commercial "free tiers" do not fit a local-first log.**
  - FatSecret Basic and Premier Free both have US data only (other markets only on paid Premier), and nutrient values may not be cached beyond 24 h.
  - Spoonacular forbids storage beyond 1 h, and even that needs written permission.
  - Edamam has no free plan.
  - Nutritionix closed its public free tier.
  - NUBEL (the Belgian table) is paid, and use in an app needs a separate licence agreement.
- **ODbL in one line:** a per-device cache of OFF lookups is fine (it is not "public use"). Show an OFF attribution notice. Only **bundling** an OFF extract in the app (Publicly Using a Derivative Database) triggers the ODbL §4.4 share-alike and §4.6 offer-the-database duties. A contribution flow (Option C) instead publishes the user's contributed values under ODbL/DbCL and photos under CC-BY-SA per the OFF terms; it adds no share-alike duty on the app's own tables (see §3).

## 1. Comparison matrix

| Source | BE branded coverage | Languages | Nutrients | Barcode | Offline dump / live API | Rate limits (free) | Licence and the obligations for an app |
|---|---|---|---|---|---|---|---|
| **Open Food Facts** | **Strong.** 101,911 products tagged Belgium, 84,933 of them with complete nutrition facts (API count, 2026-09-28). The spike found 10/12 BE store brands | Per-language names (`product_name_nl/fr/en`), but these are crowd-filled and often FR only | EU mandatory 7 (+ fibre when declared). Micros are rare | Yes (EAN-13, EAN-8, UPC) | Both: nightly CSV (0.9 GB gz / 9 GB), JSONL, Parquet, MongoDB dump, and a REST API | 15 product reads/min/IP; 10 searches/min/IP; "don't use it for search-as-you-type" | ODbL (database) + DbCL (contents) + CC-BY-SA (images). Attribution with a link. Share-alike on a *publicly used* derivative database (see §3) |
| **USDA FoodData Central** | None for BE (the Branded set is US) | EN only | Very rich (SR Legacy: 75–133 nutrients per food in the spike; Foundation: fewer, 22 for chicken) | US UPC only (Branded) | Both. Foundation JSON 459 KB zip; SR Legacy CSV 6.7 MB zip / 54 MB. REST API | Key: 1,000 req/h/IP. DEMO_KEY: documented 30/h and 50/day; **observed `x-ratelimit-limit: 10`** | **CC0 / public domain.** Citation requested only |
| **NEVO 2025/9.0** (RIVM, NL) | Generic Dutch diet, which overlaps Flemish eating well (roggebrood, kipfilet, havermout). A few brand items | **NL + EN** names, plus NL synonyms | 142 nutrient columns in the web list. Na present for 2,326/2,328 foods | No | Download (Excel/CSV) after a **web form + agreeing to the conditions**. No public API | n/a (a file) | Free. **Use the data "unchanged"**; additions allowed if clearly marked. Must cite "Based on data from NEVO online version 2025/9.0, RIVM, Bilthoven". **Must not charge end users for use of NEVO data** |
| **CIQUAL 2025** (ANSES, FR) | Generic French diet (close to Walloon and Brussels eating) | **FR + EN** names | 74 constituents; 58–71 populated per food in the spike | No | XML (compo 66 MB) + XLSX (1.5 MB) on Recherche Data Gouv. The website's search backend is not a supported API | n/a (a file) | **Licence Ouverte / Etalab 2.0** (compatible with CC-BY). Attribution only; commercial use allowed |
| **NUBEL** (Belgian table, 7th ed.) | Internubel: ~12,000 foods (~10,000 branded), free to *consult* on the web | NL/FR | Label-level for branded products | No public API | Excel file €39–€121; business + Internubel €242/yr | n/a | **Proprietary.** "Commercial applications (app or other uses)" must contact NUBEL and sign a licence agreement |
| **EFSA** food composition DB (Zenodo) | None (7 countries, not BE) | EN | 15 micronutrients only, FoodEx2-coded | No | One 12.6 MB XLSX (2013 data) | n/a | CC-BY 4.0. It is a research intake dataset, **not a lookup DB**, and it is incomplete |
| **FatSecret Platform** | **Basic and Premier Free: US data only.** Other markets (62) and 26 languages only on paid Premier; Premier Free-eligible organisations can ask for non-US data "at a discount" | EN only on Basic and Premier Free | Macros + micros "where available" | Yes | Live API only | Basic 5,000 calls/day (US data); Premier Free (revenue and funding each < US$1 M, non-profits, students) unlimited calls, still US data only | Attribution required (Basic and Premier Free). **Only IDs may be stored indefinitely; all other data ≤ 24 h** |
| **Edamam** Food DB | Mostly US UPC (~700k UPC/EAN codes) | n/s | Rich | Yes | Live API only | **No free plan** (Enterprise Basic US$14/mo, 100k calls) | Attribution mandatory. Caching only on the Core/Plus plans, and then only id/label/protein/net carbs/fat/kcal |
| **Nutritionix** | US | EN | Rich | Yes | Live API only | **Public free tier discontinued** ("no longer able to maintain a public free-access tier") | Sales-negotiated trial only |
| **Spoonacular** | US-centric grocery | EN | Rich | UPC endpoint | Live API only | Free: 50 points/day, 1 req/s | **No storage, "including any derived … data"**; cache ≤ 1 h and only with written permission. Free plan needs a backlink |

**What this means:** only OFF, NEVO, CIQUAL and FDC are compatible with a keyless, local-first log that stores nutrient values. The four commercial APIs all fail on at least one of: BE coverage, a free tier, or the right to store a logged food's nutrients.

## 2. The spike: real calls, 2026-09-28

### 2a. Where the barcodes came from

- Belgian retailer sites **don't expose GTINs**. I checked Lidl BE product pages, a Colruyt product page, and Delhaize (a 302 to a consent flow).
- The codes therefore came from independent pages:
  - `gtin13` in the JSON-LD on belgicastore.com product pages;
  - FAVV/AFSCA recall notices (the Aldi GTINs);
  - buycott.com (the Lidl Milbona codes).
- None came from OFF, so the hit rate is not biased by sampling OFF itself.
- **Structural finding:** discounters do not use the Belgian 54x prefix for their own brands.
  - Aldi BE uses German GS1 prefixes (`4068261…`, `4068706…`).
  - Lidl uses **8-digit restricted-circulation numbers (RCN-8, prefix 2)**. Their meaning "is only defined within a single company", so the same code can mean different products in different countries.

### 2b. Open Food Facts: 19 barcodes (`/api/v2/product/<ean>.json`, custom User-Agent, 4.5 s between calls)

| EAN | Store | Expected (source page) | OFF result | Name NL/FR | Nutrients per 100 g | Note |
|---|---|---|---|---|---|---|
| 5400141522921 | Colruyt | Boni couscous | ✅ "Couscous" | –/– (EN) | big 7 | |
| 5400141281514 | Colruyt | Boni witte tonijn olijfolie | ✅ | NL ✓ FR ✓ | big 7 | |
| 5400141873443 | Colruyt | Boni kaaskroketten 600 g | ❌ not found | | | |
| 5400141987812 | Colruyt | Boni erwten en wortelen | ⚠️ "Extra fijne doperwten" | –/– | big 7 + fibre | Identity conflict: one of the two sources is wrong |
| 5400141266825 | Colruyt | Everyday bolognesesaus | ✅ | –/FR | big 7 | |
| 5400141186932 | Colruyt | Everyday kipfilets 1 kg | ✅ | –/FR | big 7 + fibre | |
| 5400141163957 | Colruyt | Everyday rijstpap vanille | ✅ | NL ✓ | big 7 + fibre | |
| 5400111010397 | Delhaize | Ambachtelijke mayonaise | ✅ | NL ✓ FR ✓ | big 7 + fibre | Brand stored as "Taste of Inspirations" |
| 5400113713968 | Delhaize | Appelstroop 450 g | ❌ not found | | | |
| 5400113531951 | Delhaize | Hazelnootchocoladepasta | ✅ | –/FR | big 7 + fibre | Completeness 0.89 |
| 5400601007098 | Delhaize | 365 gecoate pinda's | ✅ | NL ✓ | big 7 + fibre | |
| 5400141049183 | Colruyt | Boni melkchocoladepasta | ✅ | –/FR | big 7 | |
| 4068261043576 | Aldi BE | Grandessa peren-appel-dadelstroop | ⚠️ found | garbled OCR name, brand "Tamara" | big 7 minus sat-fat | No image; 8 quality warnings |
| 4068706491047 | Aldi BE | All Seasons schorseneren | ✅ | –/FR | big 7 + fibre | |
| 4068261077823 | Aldi BE | Délifin jambon artisanal | ✅ | NL ✓ | big 7 + fibre | 10 quality warnings |
| 4068261063925 | Aldi BE | Aiguillettes de poulet | ✅ | –/FR | big 7 + fibre | Completeness 0.30, no image |
| 20614805 | Lidl BE | Favorina mini boterstollen | ✅ | –/– | big 7 + fibre | RCN-8 |
| 20037109 | Lidl | Milbona koffiemelk | ✅ | NL ✓ FR ✓ | big 7 + fibre | RCN-8 |
| 20045197 | Lidl | Milbona Butterkäse | ⚠️ Finnish "Kermajuustoviipale 26%" | –/– | big 7 | **RCN-8 collision across countries** |

| OFF metric | BE 54x store brands (n=12) | Aldi/Lidl (n=7) | All (n=19) |
|---|---|---|---|
| Found | **10 (83%)** | 7 (100%) | **17 (89%)** |
| Usable without correction (correct identity + macros) | 9 | 5 | **14 (74%)** |
| Dutch name present (of hits) | 4/10 | 3/7 | 7/17 |
| French name present (of hits) | 6/10 | 3/7 | 9/17 |
| kcal, protein, carbs, sugars, fat, salt/sodium | 10/10 | 7/7 | 17/17 |
| Saturated fat | 10/10 | 6/7 | 16/17 |
| Fibre | 6/10 | 6/7 | 12/17 |
| Any micro (K, Ca, Fe, vit C) or caffeine | **0** | **0** | **0** |
| Serving size given | 6/10 | 5/7 | 11/17 |
| Mean OFF "completeness" | 0.66 | 0.66 | 0.66 |
| Latency per call | 113–173 ms | | |

- **Why there are no micros:** EU Regulation 1169/2011 Art. 30 makes only energy, fat, saturates, carbohydrate, sugars, protein and salt mandatory, and a crowd database built from pack labels mirrors that. Sodium in OFF is **derived from salt** (salt ÷ 2.5). Potassium, caffeine and water must come from the generic tables.
- **Search:** the legacy `cgi/search.pl` and some `/api/v2/search` store/brand filters returned an HTML "Page temporarily unavailable" during the spike. The Elasticsearch-based `search.openfoodfacts.org` worked. That was a NL query (`appelstroop`), and it returned only Dutch-market products (AH, Hero…), which confirms that online text search is not a reliable Belgian type-ahead.

### 2c. Generic foods: 10 items across USDA FDC, CIQUAL and NEVO

✅ = right food at #1; (n) = the right food exists, at rank n; ✗ = wrong food at #1 (right food exists deeper or by ID). kcal are per 100 g.

| Food | USDA FDC (search, Foundation + SR Legacy) | CIQUAL (FR query) | NEVO (NL name) |
|---|---|---|---|
| Banana | by ID 173944 (89 kcal*) | ✅ Banane crue, 87.6 kcal | ✅ Banaan, 92 kcal |
| Oats | ✗ "Oil, oat" | ✅ Flocons d'avoine, 369 | ✗ at start-of-name ("Vlokken haver-"), 366 |
| White rice, cooked | ✗ glutinous rice | ✗ raw rice at #1; cooked (3), 146 | ✅ Rijst witte gekookt, 146 |
| Chicken breast, raw | ✅ Foundation, 106 kcal, **22 nutrients** | ✗ thigh at #1; "Poulet, filet sans peau cru" exists, 110 | (2) "Kipfilet bereid" ranks before "rauw", 109 |
| Egg, raw | ✅ SR 171287 | ✅ Oeuf cru, 140 | ✅ Ei kippen- rauw gem, 132 |
| Whole milk | ✗ mozzarella | ✅ Lait entier pasteurisé, 61.8 | ✅ Melk volle, 61 |
| Rye bread | ✅ Bread, rye, 259 | ✗ rye flour at #1; rye-wheat bread (10), 260 | ✅ Roggebrood volkoren, 193 |
| Apple | by ID 171688 | ✗ **"Pomme de terre"** (potato) at #1; apple exists deeper, 54 | ✅ Appel z schil gem, 55 |
| Olive oil | by ID 171413 | ✗ anchovies at #1; extra-virgin (5), 899 | ✗ at start-of-name ("Olie olijf-"), 900 |
| Lentils, cooked | ✅ (the "with salt" variant) | ✅ Lentille bouillie, 125 | (2) dried before cooked; cooked 99 |
| **Exists in DB** | 10/10 | 10/10 | 10/10 |
| **Right food at #1** | 4/7 searched | 5/10 | 8/10 (with start-of-name matching) |
| Nutrients populated | SR 75–133; Foundation 22 | 58–71 | 89–136 |
| Names | EN | FR + EN | NL + EN + NL synonyms |
| Latency | 1.0–1.7 s | 0.2–0.3 s | n/a (bundled) |

\* **FDC gotcha:** `foodNutrients` lists "Energy" twice, in kJ and in kcal. A name-prefix parse picked up the kJ value (e.g. 3,699 for olive oil). Key on nutrient number **1008** (kcal), never on the name.

**How CIQUAL and NEVO were reached (spike only):**

- CIQUAL: queried through the Elasticsearch backend its public website calls (`ciqual.anses.fr/esearch/aliments/_search`).
- NEVO: the food list came from the JSON endpoint that the NEVO-online web page calls (`/Home/GetJsonData`, about 12 MB for all 2,328 foods).
- **Neither is a supported API.** The app must bundle the official downloads.
- The NEVO official download sits behind a web form with personal details and an agreement. I did not submit it: Geert must do that, and he becomes the licensee.

**Sanity check on the values:** banana is 87.6–92 kcal in all three sources, and cooked rice 146 kcal in both CIQUAL and NEVO. The values are plausible and consistent.

## 3. ODbL (Open Food Facts): what it means for this app

The mechanism, from the ODbL 1.0 text:

| Scenario | ODbL status | Obligation |
|---|---|---|
| App calls the OFF API per scan, and shows and uses the values | Use of the database; the displayed value and the diary are **Produced Works** (§4.5b: not a Derivative Database) | §4.3: if Publicly Used, a notice that the content came from OFF under ODbL. The OFF terms also want a link to openfoodfacts.org. **Show "Product data: Open Food Facts contributors, ODbL" on the food detail screen and in About** |
| A **per-device cache** of scanned products (SQLite/JSON on the phone), including the user's corrections | Arguably a Derivative Database (modified extract), but it is **not Publicly Used**: "Publicly" means persons other than you. Share-alike (§4.4) applies only to public use | None beyond the notice. Keep the cache out of anything shared |
| Local cache included in `backup.ts` exports that only Geert restores | Still private use | None. Fine |
| **Bundling** an OFF extract (e.g. a "top Belgian products" file) in the IPA/TestFlight | **Conveying** the database to other people. An extract is a Derivative Database (§4.4) | §4.2/4.4: ship it under ODbL with the licence URI. §4.6: offer the extract (or a file of alterations) in machine-readable form. Keep it a **separate, unmodified file**, so the other tables and the user data form a **Collective Database** (§4.5a) and are not pulled under share-alike |
| Merging OFF rows *into* the NEVO/CIQUAL table (one merged DB) and distributing it | Derivative Database, publicly conveyed | The whole merged DB must go out under ODbL. Also conflicts with NEVO's "unchanged" rule. **Don't merge; keep the sources in separate tables** |
| **Contribution flow** (user adds a missing product → POST to OFF) | The user's contribution becomes part of OFF under ODbL/DbCL; photos become CC-BY-SA | Explicit opt-in. Use a **global app account** plus `app_name`/`app_version`/`app_uuid` (a salted random per-user id, so moderators can ban one user without banning the app). Send only the barcode, label values and pack photos: no identity. Adds a third-party write flow |
| Product images from OFF | CC-BY-SA 3.0 | Attribute them if displayed. It is simpler not to cache images at all |

Other OFF terms:

- Send a custom `User-Agent: AppName/Version (ContactEmail)`. The "never identity" rule means using a project alias, not Geert's personal address.
- For more than "a few hundred products", use the dumps instead of the API.
- OFF receives the **barcode + IP** per lookup. No account and no user id is needed for reads.

## 4. Licence obligations for the other candidates (summary)

- **NEVO:**
  - Values must stay "unchanged". Additions are allowed if clearly marked as such.
  - Every calculated output must carry "Based on data from NEVO online version 2025/9.0, RIVM, Bilthoven (and other data sources)".
  - **"The user is not allowed to charge (end)users for the use of NEVO online … data."** That is fine for a free app. A paid distribution would need a check with RIVM.
  - Users are asked to update when a new version comes out.
  - **"Additions" yes, "amendment" no.** The conditions say the user "is not entitled to make amendment" to the dataset. User corrections must therefore live in a separate override table that points at the NEVO row, never edit the NEVO row itself.
  - **The reference goes on every calculated output, not only in About.** The conditions require it on "any output from software for nutritional calculations". In the app that means every totals view that includes a NEVO item: day totals, recipe per-serving values, energy balance.
  - **Redistribution is not addressed.** The conditions grant use and additions and ban charging, but say nothing about passing the dataset file itself to other people. The licensee is whoever submits the RIVM form. Bundling NEVO into a build that reaches anyone else (TestFlight, App Store, an OTA channel with other users) is therefore an open point. **Before that, email nevo@rivm.nl (the contact the conditions give) to confirm bundling is permitted.** CIQUAL (Etalab 2.0, redistribution explicitly allowed) is the no-question fallback.
  - *Open question for RIVM (same email):* does keeping only a column subset (~15 of 142 columns) and converting it to JSON or SQLite count as "unchanged"? It is probably fine, since the values are untouched, but RIVM should confirm.
- **CIQUAL:** Etalab 2.0. Attribution ("Anses. 2025. Table de composition nutritionnelle des aliments Ciqual 2025", DOI 10.57745/RDMHWY). Commercial use and redistribution allowed. **The cleanest licence of the set.**
- **USDA FDC:** CC0. A citation is requested. No restrictions.
- **FatSecret, Spoonacular, Edamam:** their caching clauses (24 h / 1 h / limited fields on paid plans) contradict a diary that stores nutrient values per entry. Using them would mean re-fetching every logged food, which breaks both keyless and offline use.

## 5. Recommended DB stack

| Layer | Source | Why | Delivery |
|---|---|---|---|
| **1. Generic foods (keyless, offline, type-ahead)** | **NEVO 2025** (primary: NL + EN + synonyms) + **CIQUAL 2025** (FR + EN, fills gaps). NEVO in any build that reaches other people only after RIVM confirms bundling (§4); until then CIQUAL alone | NL search for Geert, FR for Belgian French labels, 70–140 nutrients including Na/K. Both are free for an app | **Per option (PM decision, REPORT.md):** Option A = a slim JSON asset (≈15 nutrient columns, est. ~1 MB) with JS token search, OTA. Option B = read-only SQLite with FTS5 via `expo-sqlite`, in B's single prebuild. Separate tables per source in both (no merge). Full-column SQLite size estimate: < 10 MB (2,328 × 142 + 3,484 × 74 numeric cells) |
| **2. Branded barcodes** | **OFF live API**, one call per scan | Only free source with real Belgian store-brand coverage (83% of BE-prefix codes, 89% overall) | On a hit, copy the per-100 g values into a local "my products" table (private cache, ODbL notice). Never use OFF search as type-ahead |
| **3. Misses and bad records** | Manual label entry (the EU-mandatory 7 fields + fibre, per 100 g) → local custom food. With a key: label photo → LLM → the same form | 26% of scans needed a fix or found nothing | Local only. RCN-8 (Lidl `2…`) and conflicting hits → always show the name and photo for the user to confirm |
| **4. Micros and caffeine for branded items** | Optional: link a branded product to its NEVO/CIQUAL generic ("similar to…") for K, Mg and caffeine estimates | OFF has none | Deterministic mapping by category; flagged as an estimate |
| **Later (Option C)** | OFF contribution (global app account + `app_uuid`, opt-in) | Gives back and fixes BE gaps | New third-party write path; ODbL/CC-BY-SA on contributed data and photos |
| **Not recommended** | FatSecret, Edamam, Nutritionix, Spoonacular, NUBEL, EFSA, and bundling the OFF BE extract | Licence/caching conflicts, US-only data, no free tier, paid licence, not a lookup DB; bundling triggers §4.2/4.6 duties for a small offline gain | |

**USDA FDC** is optional. It is CC0 and very rich, but English-only with weak search. It is only worth adding if a nutrient is missing from NEVO/CIQUAL (for example caffeine for specific drinks).

**Effort hints for the PM:**

| Piece | Build sessions |
|---|---|
| Layer 1: import script (NEVO/CIQUAL → SQLite) + FTS search with raw/cooked ranking | ~1–1.5 |
| Layer 2: OFF client with UA, 404 handling, local product cache, attribution line | ~0.5–1 |
| Layer 3: manual label form | ~0.5 |
| Barcode camera | See WS4 (needs `expo-camera`, a native rebuild) |

**Decisions for Geert:**

1. Will he fill in the RIVM form to download NEVO (he becomes the licensee), and email nevo@rivm.nl to confirm bundling before NEVO ships in any build distributed to others (TestFlight)?
2. Will RunCoach ever be sold? The NEVO "no charge" clause, and FatSecret-style APIs, depend on the answer.
3. Is an OFF contribution flow wanted (Option C), and under which contact alias for the User-Agent and the global account?

## Sources

- Open Food Facts API introduction (rate limits, User-Agent, licences, dumps for heavy use, global app account and `app_uuid`): https://openfoodfacts.github.io/openfoodfacts-server/api/
- OFF API tutorial (write endpoint, authentication): https://openfoodfacts.github.io/openfoodfacts-server/api/tutorial-off-api/
- OFF terms of use (ODbL/DbCL/CC-BY-SA, attribution with a link): https://world.openfoodfacts.org/terms-of-use
- OFF data exports (CSV 0.9 GB/9 GB, JSONL, Parquet, nightly): https://world.openfoodfacts.org/data
- ODbL 1.0 full text (definitions, §4.2–4.6): https://opendatacommons.org/licenses/odbl/1-0/
- USDA FDC API guide (rate limits, DEMO_KEY 30/h and 50/day, CC0, citation): https://fdc.nal.usda.gov/api-guide/
- USDA FDC downloads (Foundation/SR Legacy/Branded sizes, 04/2026): https://fdc.nal.usda.gov/download-datasets/
- NEVO conditions of use 2025/9.0 (unchanged, citation, no charging end users): https://www.rivm.nl/sites/default/files/2025-11/Conditions-of-use-NEVO-online-2025-dataset.pdf
- NEVO overview (>2,300 foods, >130 nutrients): https://www.rivm.nl/en/dutch-food-composition-database
- NEVO download page (form + agreement): https://www.rivm.nl/nederlands-voedingsstoffenbestand/gebruik-nevo-online/download-bestand
- NEVO-online web app (spike list source): https://nevo-online.rivm.nl/
- NEVO manual (Excel/CSV export): https://www.rivm.nl/en/dutch-food-composition-database/use-of-nevo-online/manual
- CIQUAL 2025 dataset (Etalab 2.0, files, DOI 10.57745/RDMHWY): https://entrepot.recherche.data.gouv.fr/dataset.xhtml?persistentId=doi:10.57745/RDMHWY
- ANSES CIQUAL overview (3,484 foods): https://www.anses.fr/en/content/ciqual-nutritional-composition-table
- CIQUAL website (spike search backend): https://ciqual.anses.fr/
- NUBEL order page (prices; apps need a licence agreement): https://www.nubel.be/orders/
- FPS Public Health on NUBEL/Internubel (~12,000 foods, free to consult): https://www.health.belgium.be/en/professionals/enterprises/food/food-policy/food-health/nubel
- EFSA food composition DB for nutrient intake (CC-BY 4.0, 7 countries, 15 micros): https://zenodo.org/records/438313
- FatSecret API editions (Basic 5,000/day, US only; Premier Free eligibility; attribution): https://platform.fatsecret.com/api-editions
- FatSecret storable data (≤ 24 h, IDs indefinitely): https://platform.fatsecret.com/docs/guides/storable-data
- FatSecret attribution policy: https://platform.fatsecret.com/attribution
- Edamam Food Database API plans (no free plan, caching limits, attribution): https://developer.edamam.com/food-database-api
- Nutritionix developer portal (public free tier discontinued): https://developer.nutritionix.com/
- Spoonacular pricing (free 50 points/day, 1 req/s, backlink): https://spoonacular.com/food-api/pricing
- Spoonacular terms (no storage, 1 h cache with permission): https://spoonacular.com/food-api/terms
- Spoonacular docs (UPC endpoint): https://spoonacular.com/food-api/docs
- EU Regulation 1169/2011 (Art. 30 mandatory nutrition declaration): https://eur-lex.europa.eu/eli/reg/2011/1169/oj
- EAN-8 / RCN-8 (prefix 0/2 = internal, company-defined): https://en.wikipedia.org/wiki/EAN-8 and https://biip.readthedocs.io/stable/reference/rcn/
- GS1 company prefixes (540–549 = Belgium & Luxembourg): https://www.gs1.org/standards/id-keys/company-prefix
- Barcode sources used in the spike: belgicastore.com product JSON-LD (e.g. https://belgicastore.com/nl/merk/boni-selection, https://belgicastore.com/nl/merk/everyday, https://belgicastore.com/nl/merk/delhaize, https://belgicastore.com/nl/merk/aldi, https://belgicastore.com/nl/merk/lidl); FoodFactor Delhaize 365 page: https://world.foodfactor.net/produits/5400601007098/delhaize+365+gecoate+pinda's+met+paprikasmaak.php; FAVV/AFSCA Aldi recalls: https://favv-afsca.be/fr/produits/rappel-de-aldi-5 and https://favv-afsca.be/fr/produits/rappel-de-aldi-7; Buycott Milbona (Lidl): https://www.buycott.com/brand/84870/milbona-lidl-upc
