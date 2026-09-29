# Nutrition tracking for RunCoach: research report and options

| | |
|---|---|
| **Date** | 2026-09-28 (overnight research run), revision 3 after review round 2 |
| **For** | Geert (decides what gets built) |
| **Mode** | Research only. No app code, no commits, no builds |
| **Inputs** | `docs/nutrition/`: BRIEF.md · TRACKER.md · ws1-market.md · ws2-databases.md · ws3-ai-photo.md · ws4-ux.md · ws5-integration.md |

Every number below is cited here or in the workstream file it comes from. "Estimate" marks our own arithmetic, not a measured or published value. The workstream files carry the full source lists.

**Known gaps**

- **Reddit was not accessible.** reddit.com blocked both the research fetcher and scripted access, so r/loseit, r/MacroFactor and r/Cronometer are not covered. App Store reviews and vendor forums stand in (WS1).
- **The review sample is the US storefront's most recent reviews** (1,850 across 11 apps, from Apple's public review RSS feed), coded with keyword regexes. It is recency-biased (post-update anger), and the FatSecret and Yazio samples are about half Russian-language (WS1).
- **Not measured on a device:** the photo upload size and latency, the HealthKit food-correlation write, and label OCR on real (curved, glossy) packs. Each is a named pre-build spike in §7.

---

## 1. Executive summary

- **Build the MacroFactor model, not the Cal AI model, free and local.** The trackers users keep are the ones where a repeat meal is nearly free, the data has visible provenance, and AI is optional and editable. Forced or opaque AI and paywalled core features draw the most anger in reviews (WS1 §4).
- **Free data covers Belgium well enough.**
  - Branded: Open Food Facts (OFF) found 17 of 19 real Belgian/discounter barcodes; 14 of 19 were usable without a fix.
  - Generic: NEVO (NL) and CIQUAL (FR) contain all 10 test foods, with 70–140 nutrients.
  - All four commercial "free tiers" fail on BE coverage, cost, or the right to store nutrient values (WS2).
- **AI photo works only as an accelerator.** Photo-only energy estimates are off by ~35 % and biased low on big plates ([Fridolfsson 2025](https://pmc.ncbi.nlm.nih.gov/articles/PMC12513282/)). The design is: the LLM names items and proposes grams, the local database supplies nutrients, and the user confirms the grams. Cost is under $0.011 a photo (WS3).
- **The app stays fully usable keyless.** Search, recents, copy-yesterday, quick-add, a deterministic EN/NL/FR free-text parser and all coach fuelling hooks need no key. Only the photo *meal* button needs one (§7.1 keyless matrix).
- **RunCoach's edge is running.** No incumbent links intake to training. Deterministic ACSM-based hooks cover carbs before quality sessions and g/h on long runs in Option A; sweat-rate-based fluid and sodium on hot days follow in Option B (WS5).
- **Options (build sessions, estimate):**

| Option | Scope in one line | Sessions | Ships as |
|---|---|---|---|
| **A — MVP** | Logger + bundled generic table + OFF by typed EAN + keyless text parser + key-gated photo + fuelling hooks | **~7–8** | OTA only |
| **B — Solid v1** | A + one prebuild: barcode camera, keyless label OCR, photo resize, SQLite search, HealthKit write/read, adaptive TDEE, hydration/sweat test, Biology link, recipes | **+~11–13** | One local Xcode build |
| **C — Ambitious** | B + OFF contributions, Siri/widget, micros, CGM overlay, goal targets | **+~7–8** | Further native builds |

- **Recommendation:** when Geert green-lights food (the roadmap says "later, don't start unprompted"), build **Option A**, run the two spikes first, and decide on B after 2–3 weeks of real logging. **Geert's decisions are in §9.**

---

## 2. Market findings

Full profiles, pricing and review coding: ws1-market.md.

### 2.1 Feature matrix (condensed)

✅ free · 💰 paid tier only · ⚠️ partial or caveat · ❌ none · ? not verified. Ratings are from the [iTunes Lookup API](https://itunes.apple.com/lookup?id=341232718) and recent-review sentiment from the [App Store review RSS](https://itunes.apple.com/us/rss/customerreviews/page=1/id=341232718/sortby=mostrecent/json), both pulled 2026-09-28.

| | MFP | Cronometer | MacroFactor | Lose It! | Yazio | Lifesum | FatSecret | Carb Mgr | Cal AI | SnapCalorie | Foodvisor |
|---|---|---|---|---|---|---|---|---|---|---|---|
| DB model | Crowd, 20.5M | Lab tables | Verified + OFF | Crowd | Crowd, EU | Curated | Curated | Crowd + verified | AI estimate | AI + USDA | AI + DB |
| Barcode | 💰 since 2022 | ✅ | 💰 (paid app) | 💰 | ✅ | ✅ | ✅ | ✅ | ? | ✅ | ✅ |
| Copy yesterday / meal | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ✅ | ? | ? | ? |
| Micronutrients | ⚠️ | ✅ 80+ free | ✅ | 💰 | 💰 | ⚠️ | ⚠️ | 💰 | ❌ | ✅ | 💰 |
| Adaptive targets (TDEE) | ❌ | ❌ | ✅ core | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ | ⚠️ | ❌ |
| AI photo | 💰 | 💰 | ✅ DB-mapped | 💰 | 💰 | ✅ | ✅/💰 | ✅ | 💰 core | ✅ core | 💰 core |
| Apple Health: write food | ✅ no timestamps, no caffeine | ✅ | ✅ | 💰 | ✅ | ✅ | ✅ full | ✅ daily | ? | ✅ | ✅ |
| Apple Health: read others' food | ❌ | ? | ✅ | ? | ? | ? | ? | ? | ? | ? | ? |
| Free tier | ⚠️ shrinking | ✅ ads | ❌ trial | ⚠️ | ⚠️ | ⚠️ | ✅ strongest | ✅ | ❌ | ⚠️ | ⚠️ |
| Rating (count) | 4.71 (2.4M) | 4.77 (99k) | 4.84 (23k) | 4.77 (779k) | 4.70 (51k) | 4.65 (151k) | 4.73 (15k) | 4.82 (735k) | 4.80 (367k) | 4.73 (6.7k) | 4.59 (17.6k) |
| Recent reviews 4–5★ | 41 % | 71 % | 61 % | 60 % | 28 % | 25 % | 47 % | 73 % | 31 % | 98 % ⚠️ | 68 % |

- **Speed.** MacroFactor's own benchmark counts 6 actions for a repeat multi-add and 24 across four tasks, against 36 for MFP ([FLSI 2025](https://macrofactorapp.com/fastest-food-logger-2025/); vendor-run). **Nobody benchmarked reaches ≤3 taps for a repeat meal**, so RunCoach's target is a real differentiator.
- **MacroFactor ships OFF data under ODbL** in a paid app, with an App Store attribution notice ([iTunes lookup](https://itunes.apple.com/lookup?id=1553503471)). That is a direct precedent for WS2.
- **Adaptive TDEE** = mean intake − ρ·Δ(trend weight)/Δt over ~21 days. Empty days are excluded, partial days are flagged, and there is no shame UI ([MacroFactor V3](https://macrofactor.com/expenditure-v3/), [Stronger By Science](https://www.strongerbyscience.com/macrofactor-algorithms-philosophy/)).
- **Crowd data needs guard rails.** In Belgian users, MFP matched the NUBEL table well for energy (r = 0.96) but weakly for sodium (ρ ≈ 0.53); 2.8 % of entries were extreme outliers ([Evenepoel 2020](https://pubmed.ncbi.nlm.nih.gov/33084583/)).

### 2.2 The 10 things that make logging stick

1. **Repeat meals nearly free.** Logging frequency predicts success: 2.4–2.7 logins/day in those who lost ≥5–10 %, against 1.6–1.7 in the rest ([Harvey 2019](https://pubmed.ncbi.nlm.nih.gov/30801989/)). Daily engagement was the top predictor in 1,359 MFP users ([Wang 2026](https://pubmed.ncbi.nlm.nih.gov/42280408/); part-funded by MFP).
2. **Never paywall or break the core loop.** Paywall/price is the #1 low-star theme in 8 of 11 apps.
3. **Visible data provenance**, with local corrections.
4. **AI accelerates, never replaces:** map to DB items, keep grams editable, allow skipping.
5. **No shame:** neutral colours, no streak guilt.
6. **Tolerate imperfect logging:** quick-add, "day complete" flag, and empty days excluded rather than counted as zero.
7. **Pay the user back:** for RunCoach, that is fuelling and hydration coaching.
8. **Stability and data safety:** favourites and recipes are precious, so back them up.
9. **Zero-friction start:** no onboarding quiz. HealthKit already knows weight and activity.
10. **Local relevance and one source of truth:** BE/EU foods, Apple Health with timestamps, no double counting.

---

## 3. Food databases and the recommended stack

Full matrix, spike tables and licence text: ws2-databases.md.

### 3.1 Comparison (condensed)

| Source | BE coverage | Languages | Nutrients | Delivery | Licence obligations in an app | Fit |
|---|---|---|---|---|---|---|
| **Open Food Facts** | Strong: 101,911 products tagged Belgium (API count, 2026-09-28) | Per-language, crowd-filled | EU "big 7" (+ fibre); micros rare | API (15 reads/min/IP, 10 searches/min/IP, no search-as-you-type) + dumps ([OFF API](https://openfoodfacts.github.io/openfoodfacts-server/api/)) | ODbL + DbCL; attribution with link; share-alike only on a *publicly used* derivative DB ([ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)) | ✅ barcodes |
| **NEVO 2025/9.0** (RIVM) | Generic Dutch diet | NL + EN + synonyms | 142 columns | File after a web form | Use "unchanged"; additions allowed, amendments not; mandatory reference on every calculated output; no charging end users; **redistribution not addressed** ([conditions](https://www.rivm.nl/sites/default/files/2025-11/Conditions-of-use-NEVO-online-2025-dataset.pdf)) | ✅ generics, pending RIVM answer |
| **CIQUAL 2025** (ANSES) | Generic French diet | FR + EN | 74 constituents | XLSX/XML download | Etalab 2.0: attribution only, commercial use and redistribution allowed ([dataset](https://entrepot.recherche.data.gouv.fr/dataset.xhtml?persistentId=doi:10.57745/RDMHWY)) | ✅ generics, no-question |
| **USDA FDC** | None for BE | EN | Very rich | API (1,000 req/h/IP) + dumps | CC0; citation requested ([API guide](https://fdc.nal.usda.gov/api-guide/)) | Optional gap-filler |
| **NUBEL** (BE) | ~12,000 foods | NL/FR | Label-level | Paid Excel (€39–242) | Apps need a signed licence ([order page](https://www.nubel.be/orders/)) | ❌ |
| **EFSA** | None | EN | 15 micros | 12.6 MB XLSX (2013) | CC-BY 4.0; not a lookup DB ([Zenodo](https://zenodo.org/records/438313)) | ❌ |
| **FatSecret** | **Basic and Premier Free: US data only**; other markets only on paid Premier ([editions](https://platform.fatsecret.com/api-editions)) | EN on free tiers | Macros + micros | Live API | Only IDs storable indefinitely, other data ≤24 h ([storable data](https://platform.fatsecret.com/docs/guides/storable-data)) | ❌ |
| **Edamam** | Mostly US | n/s | Rich | Live API | No free plan; caching limited to a few fields ([plans](https://developer.edamam.com/food-database-api)) | ❌ |
| **Nutritionix** | US | EN | Rich | Live API | Public free tier discontinued ([portal](https://developer.nutritionix.com/)) | ❌ |
| **Spoonacular** | US | EN | Rich | Live API | No storage; ≤1 h cache only with written permission ([terms](https://spoonacular.com/food-api/terms)) | ❌ |

### 3.2 Spike results (2026-09-28, public data only)

| Test | Result |
|---|---|
| OFF, 19 real barcodes (12 Belgian 54x store brands from Colruyt/Delhaize + 7 Aldi/Lidl) | Found **17/19 (89 %)**; BE 54x **10/12 (83 %)**; usable without correction **14/19 (74 %)** |
| OFF data quality | Big 7 on 17/17 hits; **0** hits with any micro or caffeine; Dutch name on 7/17, French on 9/17; ~113–173 ms per call |
| OFF failure modes | 2 not found; 1 identity conflict; 1 garbled OCR name; **Lidl RCN-8 codes collide across countries** (a Lidl code returned a Finnish cheese) |
| 10 generic foods | All exist in NEVO, CIQUAL and FDC. Right food at #1 by naive search: NEVO 8/10, CIQUAL 5/10, FDC 4/7. **The app needs its own local ranking** (tokens, synonyms, raw/cooked preference) |
| Sanity | Banana 87.6–92 kcal/100 g across all three; cooked rice 146 in NEVO and CIQUAL |

### 3.3 Recommended stack

| Layer | Source | Delivery |
|---|---|---|
| 1. Generic foods (keyless, offline, type-ahead) | **CIQUAL 2025** always; **NEVO 2025** once RIVM confirms bundling (decision D6) | **A:** slim JSON asset (~15 nutrient columns, est. ~1 MB) + JS token search, OTA. **B:** read-only SQLite + FTS5 (`expo-sqlite`) in the prebuild. Separate tables per source, never merged |
| 2. Branded barcodes | **OFF live API**, one read per scan or typed EAN | Hit → copied into a private on-device "my products" cache. OFF attribution on the food detail screen and in About |
| 3. Misses and bad records | Manual 7-field EU label form (+ fibre) → local custom food | Always shows name and photo to confirm on RCN-8 (Lidl `2…`) codes and on conflicts |
| 4. Micros/caffeine for branded items | Optional "similar to" link to a NEVO/CIQUAL generic | Flagged as an estimate |
| Not used | FatSecret, Edamam, Nutritionix, Spoonacular, NUBEL, EFSA; bundled OFF extracts | Licence, coverage or cost conflicts |

**Licence rules the build must follow**

- **ODbL (OFF).** A per-device cache is not "Publicly Used", so share-alike does not apply; show the notice. Only *bundling* an OFF extract in the app (Publicly Using a Derivative Database) triggers the §4.4 share-alike and §4.6 offer-the-database duties ([ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)). A contribution flow (C) instead publishes the user's contributed values under ODbL/DbCL and photos under CC-BY-SA per the [OFF terms](https://world.openfoodfacts.org/terms-of-use); it adds no share-alike duty on the app's own tables. Never merge OFF rows into the NEVO/CIQUAL tables.
- **OFF product images** are CC-BY-SA 3.0: attribute them (licence + link to Open Food Facts) when displayed on the confirm screen, and don't cache them ([OFF terms](https://world.openfoodfacts.org/terms-of-use)).
- **NEVO.**
    - Show "Based on data from NEVO online version 2025/9.0, RIVM, Bilthoven and other data sources" on **every calculated output** that includes a NEVO item (day totals, recipe per serving, energy balance), not only in About ([conditions](https://www.rivm.nl/sites/default/files/2025-11/Conditions-of-use-NEVO-online-2025-dataset.pdf)).
    - Keep user corrections in a separate override table; the conditions forbid amending the dataset.
    - **Before NEVO ships in any build that reaches other people** (TestFlight, App Store, a shared OTA channel), email **nevo@rivm.nl** to confirm bundling, and ask whether a column subset (~15 of 142 columns) re-encoded as JSON still counts as using the data "unchanged". The conditions do not address redistribution, and the licensee is whoever submits the RIVM form. **CIQUAL (Etalab 2.0) is the no-question fallback.**
- **CIQUAL.** Credit "Anses. 2025. Table de composition nutritionnelle des aliments Ciqual 2025", DOI 10.57745/RDMHWY.

---

## 4. AI photo: feasibility, accuracy, cost and flow

Full provider table, prompt and schema: ws3-ai-photo.md.

### 4.1 Which configured providers can take a photo today (`src/services/llm.ts` `PROVIDERS`)

| Provider | Vision today | Recommended photo model |
|---|---|---|
| `anthropic` | ✅ all current Claude models ([vision docs](https://platform.claude.com/docs/en/build-with-claude/vision)) | Claude Haiku 4.5 (~$0.0035/photo) |
| `deepseek` | ✅ the `deepseek-v4-flash` alias is served by V4.1-Flash with vision; `v4-pro` has none ([models](https://api-docs.deepseek.com/quick_start/pricing/)) | `deepseek-flash`, thinking off |
| `openai` | ✅, but the default `gpt-4o-mini` bills ~25k tokens per image ([vision guide](https://developers.openai.com/api/docs/guides/images-vision)) | `gpt-4.1-mini` |
| `glm` | ❌ `glm-4.6` is text-only ([GLM-4.6](https://docs.z.ai/guides/llm/glm-4.6)) | Only through `custom` (OpenAI format) with a GLM vision model |
| `kimi` | ❌ **all three Kimi models in `llm.ts` were discontinued** (k2 series 25 May 2026; `kimi-latest` 28 Jan 2026), breaking Kimi for text too ([model list](https://platform.kimi.ai/docs/models.md)) | `kimi-k2.6`, after fixing the defaults (a separate bug) |
| `custom` (Groq, Gemini) | ✅ via `image_url` | Gemini 3.1 Flash-Lite; Groq's vision model is a Preview |

### 4.2 Accuracy

| Evidence | Energy result | Lesson |
|---|---|---|
| [Fridolfsson 2025](https://pmc.ncbi.nlm.nih.gov/articles/PMC12513282/): GPT-4o, Claude 3.5 Sonnet, Gemini 1.5 Pro, 52 weighed photos | MAPE 35.8 % (GPT-4o, Claude), 64.2 % (Gemini); bias slopes −0.23 to −0.50 | **Under-estimation grows with portion size** |
| [Mu, Sun, He 2025](https://pmc.ncbi.nlm.nih.gov/articles/PMC13401436/) | Gemini 2.5 Flash, phone photos: carb MAPE 56.6 % (no weight) → 39.5 % (predicted) → **20.2 % (true weight)**. GPT-4.1 gained less: 39.5 → 35.4 → 26.8 % | Supplying the grams is the lever |
| [DietAI24, Yan 2025](https://pmc.ncbi.nlm.nih.gov/articles/PMC12589391/) | LLM + nutrient DB: 68.2 kcal MAE vs GPT-Vision 81.8 vs Foodvisor 168.5 | **The hybrid design wins** |
| [Sterling 2026 (preprint)](https://www.biorxiv.org/content/10.64898/2026.07.26.740845v1) | Best MAE 80.7 kcal (Gemini 3.0 Flash); Flash-Lite nearly as good at $0.59/1K images | Cheap models come close |
| Vendor claims | Cal AI "about 80 % accurate" (no method); SnapCalorie "2× nutritionists" traces to a 4-nutritionist survey | Treat as marketing |

### 4.3 Recommended flow (hybrid)

`photo → LLM returns items + search terms (nl/fr/en) + grams with a low/high range + confidence (JSON schema in WS3 §4) → each item matched in the local DB (per 100 g) → one pre-filled review list where the user confirms grams → log`

- The LLM's own kcal is used only when no DB match exists, tagged "AI estimate". Hidden fats (oil, butter) are separate items that start unticked.
- The same schema without the image serves the text/voice parse when a key exists. The review list is shared with the keyless parser.

### 4.4 Photo upload rule (one rule for all workstreams)

**Today's code:** the existing image callers use `quality: 1` and a hard-coded `mediaType: 'image/png'` (`app/bevel-import.tsx:57/75`, `app/travel-projection.tsx:120/127`; `callLLMWithImage` in `llm.ts` defaults to `image/png`).

**Why that fails for food photos:**

- Anthropic rejects base64 images over **10 MB** on the direct API (5 MB on Bedrock/Vertex) ([vision docs](https://platform.claude.com/docs/en/build-with-claude/vision)).
- Recent Pro iPhones save **24 MP** photos by default ([Apple](https://support.apple.com/en-gu/guide/iphone/iphb362b394e/ios)), and base64 adds ~33 %. A `quality: 1` capture can therefore approach or pass the cap.
- A camera JPEG labelled `image/png` may be rejected.

| | Option A (OTA) | Option B (prebuild) |
|---|---|---|
| Compression | `launchCameraAsync({ quality: ≈0.5, base64: true })`. No resize is possible without native code ([ImagePicker SDK 52](https://docs.expo.dev/versions/v52.0.0/sdk/imagepicker/)) | True resize to ~1024 px long edge, JPEG q≈0.7 (~150 KB), via `expo-image-manipulator` or a Swift resize in `modules/runcoach-pdf` |
| Media type | **From the bytes, never hard-coded.** Expo documents `base64` as the image's JPEG data, so sniff the prefix (`/9j/` → `image/jpeg`, `iVBORw0KGgo` → `image/png`) and fall back to `asset.mimeType` | Always `image/jpeg` (the app encodes it) |
| Size guard | If base64 > ~5 MB: re-open the picker at `quality ≈ 0.25`, or ask for a retake. Never send over the cap | Not needed (~150 KB) |
| Cost impact | Small: Haiku ~$0.004 instead of $0.0035, since Anthropic downscales server-side (estimate) | Baseline in the WS3 cost table |
| ≤10 s target | **Likely missed:** a multi-MB upload on mobile data adds seconds | **Borderline:** UI ~5 s + upload/LLM ~5 s |

- **The ≤10 s photo target is borderline, contingent on X ≤ ~4.5 s**, where X = upload + LLM round-trip. The rest of the flow costs ~5.5 s and 5 taps (WS4 §5). Haiku 4.5 needs ~5 s with a small upload ([Artificial Analysis](https://artificialanalysis.ai/models/claude-4-5-haiku)). Promise ≤10 s only after B's resize, and only if the spike measures it.
- **Mandatory pre-build spike S1 (before any photo code, ~0.25 session):**
    - capture on Geert's iPhone at `quality` 1 / 0.5 / 0.25, and log the base64 length and first bytes;
    - send the same image labelled `image/png` and `image/jpeg` to Anthropic, DeepSeek and the OpenAI route, and record accept/reject and latency;
    - confirm that no GPS/EXIF survives in the picker's base64.
    - Whether Anthropic rejects a JPEG labelled PNG is **not verified**. DeepSeek detects the format from the bytes ([vision](https://api-docs.deepseek.com/guides/vision/)).

### 4.5 Cost per photo (1024×768, ~700 prompt + ~350 output tokens; WS3 §7)

| Model | $/photo | 90 photos/month |
|---|---|---|
| DeepSeek `deepseek-flash` | $0.0005–0.0009 | $0.04–0.08 |
| Gemini 3.1 Flash-Lite | $0.0010 | $0.09 |
| OpenAI `gpt-4.1-mini` | $0.0013 | $0.12 |
| **Claude Haiku 4.5** | **$0.0035** | **$0.31** |
| OpenAI `gpt-4o-mini` (app default) | $0.0041 | $0.37 |
| Claude Sonnet 4.6 (app default) | $0.0105 | $0.94 |

Cost is not a decision factor. Latency, privacy (§8) and structured-output support are.

### 4.6 Label, receipt and menu photos

| Input | Keyless | With key | Verdict |
|---|---|---|---|
| EU nutrition label (NL/FR) | **Option B only:** on-device Vision OCR + deterministic parser. Spike: 8/8 fields on a synthetic label in 0.41 s ([VNRecognizeTextRequest](https://developer.apple.com/documentation/vision/vnrecognizetextrequest); iOS 26+ also has [RecognizeDocumentsRequest](https://developer.apple.com/documentation/vision/recognizedocumentsrequest)). Option A: the manual 7-field form | LLM fills the label fields; cross-checked against OCR in B | **High value** (fills OFF misses) |
| Receipt | OCR → poor matches | LLM maps lines | Park: it records purchases, not intake |
| Menu | OCR → pick → search | LLM estimate, tagged | Option C |

---

## 5. Fast-entry UX

Full wireframes and tap-count rules: ws4-ux.md.

**Principles:**

- Log on pick with a 4 s undo toast, and remember the last serving per food.
- Show time-of-day suggestion chips.
- One input box handles search, phrases and EAN digits.
- Search is local-first; OFF is searched only on an explicit tap.
- Use a 24 h timeline with **run markers**, not fixed meal slots.
- Default to Belgian household units (sneetje/tranche, el/cs).

| Flow | Taps | Keyless | Native build |
|---|---|---|---|
| F1 Repeat meal from a suggestion chip | **1** | ✅ | – |
| F2 Saved meal via add sheet | **3** | ✅ | – |
| F3 Recent food, remembered serving | **2** | ✅ | – |
| F4 Copy yesterday's meal or day | **2** | ✅ | – |
| F6/F7 Barcode scan (known / first time) | 3 / 4 | ✅ | **B** (`expo-camera`) |
| F8 Search generic food | 5 | ✅ | – |
| F9 Quick-add kcal (+ macros) | 4 (6) | ✅ | – |
| F10 Free text or dictation, parsed | 4 | ✅ deterministic parser (21/24 test phrases fully right, on a toy vocabulary) | – |
| F11 Photo meal | 5 (4 in B) | ❌ needs a key | – (A) / in-app shutter (B) |
| EAN typed as digits | 3–4 | ✅ | – |
| F14 Home-screen / Siri "log usual breakfast" | 1 / 0 | ✅ | Tier 0 none; Tiers 1–3 native |

**Day view sketch (A):**

```
[🏠 Home]                          ‹ Today ›
🍽️ Food
┌ 1 840 kcal · C 210 g · P 96 g · F 61 g · 💧 1.4 L · Na 1.9 g ┐   ← no red "over budget"
Usually now: (☕ Usual breakfast ＋) (🍌 Banana ＋)                  ← F1: 1 tap + Undo
07:40 Breakfast ······· 420 kcal ⋯
09:30 🏃 Run · 12 km · Z2 ─ during: Gel 1 ······ 90 kcal          ← run marker from HealthKit
11:15 Post-run ········ 510 kcal ⋯
13:00 Lunch  (Copy yesterday's lunch ＋)                            ← F4 inline
Fuel today: 70 g carbs by 06:00 · 2 gels · 600 mL + sodium/h       ← deterministic coach hook
                                                        [＋]  (long-press = Quick add)
```

(The numbers are illustrative, not real data.)

**Add sheet:** `🔎 [2 eieren, toast met boter] 🎤` → `Parse →` · `(📷 Photo: greyed if keyless) (▥ Scan: B) (⚡ Quick) (💧 Water)` · tabs Recents / ★ / Meals / Recipes · bundled generic results · `[Search online (Open Food Facts)]`.

**Shortcuts:**

- Tier 0 works with no native code: `runcoach://food/log?meal=<id>` deep links already reach JS through the SceneDelegate.
- Tier 1 (long-press quick actions) needs a `withSceneDelegate.js` patch, so it goes into B's prebuild.
- Tier 2 (App Intents, [Apple](https://developer.apple.com/documentation/appintents/app-shortcuts)) and Tier 3 (widget) are C.

---

## 6. Integration design

Full HK mapping, formulas and types: ws5-integration.md.

### 6.1 Data model and storage (local-first)

| File (documentDirectory) | Content | In `backup.ts`? |
|---|---|---|
| `runcoach-food-log-YYYY-MM.json` | Monthly shard: `DayLog { date (4 am attribution), entries: FoodEntry[], water[], complete? }`. Each `FoodEntry` stores absolute nutrient amounts, time, slot, `via`, `confidence`, `groupId`, `runId`, `hk.synced` | ✅ via `FILE_PREFIXES` |
| `runcoach-food-library.json` | Custom foods, saved meals, recipes, favourites, recents (~200) | ✅ `FILES` |
| `runcoach-sweat-tests.json` (B) | Pre/post weight, fluid, minutes, `apparentC` → L/h | ✅ `FILES` |
| `nutrition_settings_v1` (SecureStore) | HK toggles, intake source, goal, protein g/kg, caffeine opt-in | ✅ `STATIC_SECURE_KEYS` |
| `food-db-cache.json` | OFF lookup cache (ODbL-derived) | ❌ cache, rebuildable, keeps ODbL data out of backups |
| `nutrition-daily-cache.json` | Totals, adaptive TDEE, calibration `k` | ❌ (recomputable) |
| Bundled generic table | A: JSON asset. B: read-only SQLite | n/a (app asset) |

Rules:

- Merge-not-replace writes: mutate one day and never rewrite a shard from a partial read (the daily-components lesson).
- **Food data never enters `cloudSync.ts`.**
- Build note (A1/A2): the OFF cache file stays out of backups, but the name and per-100 g *snapshot* of an OFF product you log lands in recents, favourites and saved meals inside `runcoach-food-library.json`, which **is** backed up (and synced to iCloud). That is private use and allowed by ODbL; it is a deliberate exception to "keep ODbL data out of backups".
- `debugExport.ts` carries daily totals and settings only, never item names.
- **The log and library stay JSON in every option.** Only the generic table moves to SQLite, in B.

### 6.2 HealthKit mapping (Option B)

The installed `@kingstinct/react-native-healthkit` v9.0.11 already exposes every `Dietary*` type and the food correlation, so this is JS-only.

| Nutrient | HK identifier | Unit |
|---|---|---|
| Energy, protein, carbs (*available*, EU convention), fat | `DietaryEnergyConsumed`, `DietaryProtein`, `DietaryCarbohydrates`, `DietaryFatTotal` | kcal, g |
| Sat fat, fibre, sugar, sodium (= salt ÷ 2.5) | `DietaryFatSaturated`, `DietaryFiber`, `DietarySugar`, `DietarySodium` | g, mg |
| Water, caffeine | `DietaryWater` (standalone samples), `DietaryCaffeine` | mL, mg |
| Micros (C) | `DietaryIron`, `DietaryVitaminD`, … | mg, mcg |

- **Write.** One `HKCorrelationTypeIdentifierFood` per entry, tagged with `HKExternalUUID = entry.id` and `HKWasUserEntered`. Edit = delete-by-uuid, then rewrite. Do **not** use `SyncIdentifier/SyncVersion`: this app once hard-crashed on that pair (commit `47d8549`).
    - Never put the correlation type in the auth request; HealthKit disallows it ([Apple forum](https://forums.developer.apple.com/forums/thread/694311)).
    - **Mandatory 1-sample device spike S2 before building** (native exceptions can't be caught in JS).
- **Read and de-dup.**
    - Drop our own bundle id.
    - **One intake source per day, never a sum.** The local log wins; otherwise use the single chosen external app.
    - Use raw samples, not statistics, because Apple merges sources automatically ([HKStatistics](https://developer.apple.com/documentation/healthkit/hkstatistics)). MFP writes no timestamps ([MFP help](https://support.myfitnesspal.com/hc/en-us/articles/360032271092-Apple-Health-FAQ-and-Troubleshooting)), so imported days feed daily totals only.
- **Auth.** Lazy `requestNutritionPermissions()` when the toggle is turned on, with read + write on the same list (the Labs lesson). `NSHealthUpdateUsageDescription` needs "food and drink you log", which is an `app.json` change and needs a native build.

### 6.3 Energy balance

- **A:** intake vs watch TDEE (active + basal, already fetched as `totalEnergy`). Only days marked complete count.
- **B:** adds an adaptive TDEE (intake vs EWMA trend weight, ≥21 days, ≥80 % complete days) and a calibration factor `k` = adaptive ÷ watch, clamped 0.8–1.2.
    - Wrist energy estimates are imprecise: no device reached <20 % error in [Shcherbina 2017](https://www.mdpi.com/2075-4426/7/2/3).
    - Energy availability: `EA = (intake − exercise kcal) / FFM`. EA < 30 kcal/kg FFM on ≥3 of 7 complete days → a caution only ([IOC REDs 2023](https://stillmed.olympics.com/media/Documents/Athletes/Medical-Scientific/Consensus-Statements/REDs/BJSM-IOC-consensus-statement-on-Relative-Energy-Deficiency-in-Sport-REDs.pdf)).
- **Nutrition is advisory. It never changes the training plan.**

### 6.4 Coach hooks (deterministic, keyless; the LLM only phrases them)

| Hook | Rule | Option |
|---|---|---|
| Daily carb band | 3–5 / 5–7 / 6–10 g/kg/day by planned load ([ACSM 2016](https://pubmed.ncbi.nlm.nih.gov/26891166/)) | A |
| Pre-quality or long > 60 min | 1–4 g/kg 1–4 h before; practical default ~1 g/kg 1–2 h before | A |
| During long run | 30–60 g/h for 1–2.5 h; up to 90 g/h above 2.5 h | A |
| Easy < 45 min | No fuel needed, no nagging | A |
| Split long run refuel | 1–1.2 g/kg/h for the first 4 h when the gap is < 8 h | A |
| Hydration + sodium | Deficit < 2 % body mass; intake by **measured sweat rate** per temperature band; sodium when > 1.2 L/h or > 2 h ([ACSM fluid 2007](https://pubmed.ncbi.nlm.nih.gov/17277604/), [GSSI normative data](https://www.gssiweb.org/research/article/normative-data-for-sweating-rate-sweat-sodium-concentration-and-sweat-sodium-loss-in-athletes-an-update-and-analysis-by-sport)) | B |
| Caffeine (opt-in) | 3–6 mg/kg ~60 min before, clamped to 200 mg single / 400 mg/day ([ISSN 2021](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7777221/), [EFSA 2015](https://efsa.onlinelibrary.wiley.com/doi/10.2903/j.efsa.2015.4102)) | B |
| Over-drinking guard | Warn when planned intake > sweat rate | B |

**`appModel.ts`:** add three compact rule lines (NUTRITION source rule, ENERGY, FUELLING) only after Food mode is used. Add a `buildNutritionContext()` data line at the `buildSupplementContext()` call sites.

**Biology (B):** "Energy balance (7-day)" and "Intake (7-day kcal)" become correlation drivers, reusing the Spearman + lag-scan machinery, plus an "expenditure trend" series.

**Supplements (B):** an optional per-dose nutrient profile (caffeine, sodium, carbs), so pills, tabs and gels count toward totals without duplicate food entries.

**Labs:** context only, never inference.

---

## 7. Options

Effort is in build sessions, as estimated by the PM from the workstream estimates (WS2 §5, WS3 §9, WS4 §11, WS5 §12). It is an estimate, not a measurement.

### Option A — MVP (all OTA, keyless-first)

| Piece | Sessions |
|---|---|
| S1 photo upload spike (§4.4) | 0.25 |
| Data model, log/library stores, `backup.ts` + `debugExport` entries | 1 |
| Generic table: CIQUAL (+ NEVO when cleared) → slim JSON asset; JS token search with synonyms and raw/cooked ranking; NEVO reference on totals | 1 |
| OFF lookup by typed EAN (User-Agent, 404, RCN-8 confirm), private cache, attribution; manual 7-field label form | 0.75 |
| Food screen: timeline + run markers, add sheet, recents/★, log-on-pick + undo, copy yesterday/from, quick-add, water, save-as-meal, Tier 0 deep link | 1.5 |
| Keyless EN/NL/FR free-text parser (+ keyboard dictation) | 0.5 |
| With a key: `visionModel` per provider, media-type sniff, size guard, photo/text → JSON → DB match → shared review list | 1.25 |
| Coach hooks v0 (carb band, pre-quality, long-run g/h) + fuel card + `appModel` lines + watch-TDEE balance | 1 |
| **Total** | **~7–8** |

- **Risks.**
    - The photo flow likely misses ≤10 s without a resize.
    - The JSON search may feel slow on ~5,800 foods (mitigated by B's SQLite).
    - NEVO may be unavailable until RIVM answers.
    - Scope creep against the coaching roadmap.
- **Dependencies.** CIQUAL download (free); the NEVO form and RIVM email (D6); an OFF contact alias (D8); an LLM key (optional); spike S1. **No native build.**

### Option B — Solid v1 (A + one prebuild)

| Piece | Sessions |
|---|---|
| Prebuild + regression checks (Liquid Glass opt-out in Info.plist, scene manifest/SceneDelegate plugin, watch review gate) | 0.75 |
| `expo-camera` 16.0.x Scan screen: barcode + in-app shutter | 1 |
| Keyless **Label** mode: Swift `recognizeText` in `modules/runcoach-pdf` + EU label parser + tests on real packs | 1.25 |
| Photo resize to ~1024 px (`expo-image-manipulator` or Swift) | 0.25 |
| Generic table → read-only SQLite + FTS5 (`expo-sqlite`), full nutrient columns | 0.75 |
| S2 HK write spike, then HK write (correlation, `HKExternalUUID`, delete/rewrite, retry queue) + usage text | 1.5 |
| HK read importer + per-day source rule | 1 |
| Adaptive TDEE, calibration `k`, EA caution, completeness gate | 1 |
| Hydration, sweat test, electrolytes, caffeine hooks | 1 |
| Biology drivers + overlay | 1 |
| Recipe builder (OTA-able) + portion memory | 1.5 |
| Supplement nutrient profile + Labs context | 0.5 |
| Tier 1 home-screen quick actions | 0.25 |
| **Total** | **+~11–13** |

- **Risks.**
    - A prebuild can drop Info.plist tweaks (Liquid Glass opt-out, scene manifest).
    - The HK write can crash natively (hence S2).
    - HK permission prompts reappear.
    - Label OCR on glossy, curved packs is untested.
    - There is no EAS until next month, so all builds are local Xcode builds.
- **Dependencies.** A done and in real use; a USB-connected device for installs; the repo's watch-review gate before installs; Geert's HK decisions (D14).

### Option C — Ambitious (B + extras)

| Piece | Sessions |
|---|---|
| OFF contribution flow (opt-in, global app account + `app_uuid`, ODbL/CC-BY-SA notices) | 1.5 |
| App Intents (Tier 2) + home-screen widget (Tier 3, via `@bacons/apple-targets`) | 2 |
| Micros: HK micro writes, micro views, Labs link (ferritin ↔ iron, 25-OH-D ↔ vitamin D) | 1 |
| CGM overlay on meal times | 0.5 |
| 7-Day Plan carb bands + morning notification line | 0.5 |
| Menu photo path | 0.5 |
| Push-to-talk (`expo-speech-recognition`) | 0.5 |
| Goal-based targets / periodised deficit (after D13) | 1 |
| **Total** | **+~7–8** |

- **Risks.**
    - The contribution flow makes Geert's contributions public under ODbL.
    - apple-targets officially lists SDK 53+ (it works here on SDK 52, but that is unsupported).
    - Weight-loss framing conflicts with conservative coaching.
- **Dependencies.** B shipped; an OFF app account under a project alias; decisions D8, D13.

### 7.1 Keyless matrix per option (hard constraint: the app works with no key)

| Capability | A (OTA) | B (prebuild) | C |
|---|---|---|---|
| Generic search | ✅ JSON asset + JS token search | ✅ SQLite FTS5 | ✅ |
| Recents, ★, meals, copy yesterday, quick-add, water | ✅ | ✅ | ✅ |
| Free text / dictation | ✅ deterministic parser + iOS keyboard dictation | ✅ | ✅ + push-to-talk |
| Barcode | ✅ typed EAN digits → OFF (online) | ✅ camera scan | ✅ |
| Product missing in OFF | ✅ manual 7-field label form | ✅ + **Label camera mode** (Vision OCR + parser) | ✅ + contribute to OFF |
| 📷 Photo meal | ❌ **greyed**: "Add an LLM key in Settings" | ❌ greyed (meal); Label mode works keyless | same |
| Coach fuelling hooks, energy balance | ✅ deterministic | ✅ | ✅ |
| Apple Health write/read | – | ✅ | ✅ + micros |
| **With a key, additionally** | Photo meal + LLM text parse | + LLM label cross-check | + menu photos |

### 7.2 Delivery decisions that resolve workstream conflicts

| Conflict | Resolution |
|---|---|
| SQLite (WS2) vs no native (WS5) | Log and library are JSON everywhere. Generic table: JSON asset in A, SQLite in B |
| Photo resize "needs rebuild" (WS3) vs "photo is OTA" (WS4) | A = OTA with `quality ≈ 0.5` + byte-sniffed media type + ~5 MB guard; true resize is in B (§4.4) |
| Label OCR "keyless photo function" (WS3) vs "📷 greyed keyless" (WS4) | Label OCR is native, so it goes in B. In A the photo button is greyed without a key (§7.1) |
| HK write in A (WS5) | Moved to B: needs spike S2 + usage-string build |

---

## 8. Third parties and what each receives

| Third party | When | Receives | Never receives | Flags |
|---|---|---|---|---|
| **Open Food Facts** (Open Food Facts association, FR) | Barcode or typed-EAN lookup; explicit "Search online" | Barcode or search term, device IP, `User-Agent: RunCoachAI/<version> (<contact alias>)` ([OFF API](https://openfoodfacts.github.io/openfoodfacts-server/api/)) | Identity, food log, health data | Needs a **contact alias**, not a personal address (D8). ODbL attribution. C only: contributions are published under ODbL/CC-BY-SA |
| **USDA FoodData Central** (optional) | Only if chosen to fill missing nutrients by API; **bundling the CC0 dump instead adds no third party** | Food term, IP, API key (registration needs an email → project alias) ([API guide](https://fdc.nal.usda.gov/api-guide/)) | Identity, log | Recommended: bundle offline, not the API |
| **User-chosen LLM provider** (only with a key) | Photo meal, text parse, (B) label cross-check | The photo (EXIF not requested; GPS stripping verified in S1), prompt with meal slot, local time, "Belgium", nl/fr. Optional opt-in: the names of the 20 most-logged foods (D11). The API key identifies the account holder to the provider | Health data, labs, weight, identity fields | **Anthropic:** API data deleted within 30 days, images not used for training ([privacy](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data), [vision FAQ](https://platform.claude.com/docs/en/build-with-claude/vision)). **OpenAI:** no training by default, 30-day abuse logs ([data](https://developers.openai.com/api/docs/guides/your-data)). **DeepSeek: PRC jurisdiction** ([policy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html)). **Kimi: Singapore, inputs may "optimize our models"** ([policy](https://platform.kimi.ai/docs/agreement/userprivacy)). **Z.ai/GLM: Singapore**, API content not stored ([policy](https://docs.z.ai/legal-agreement/privacy-policy)). **Gemini: EEA users must use Paid Services**, so a billed key ([terms](https://ai.google.dev/gemini-api/terms)). **Groq:** vision is a Preview; terms not reviewed |
| **RIVM (NEVO)** | One-time download form (+ the bundling email) | The licensee's details on the form | Anything at runtime | Geert becomes the licensee (D6) |
| **ANSES (CIQUAL)** | One-time download | Nothing personal | Anything at runtime | – |
| **Apple HealthKit** (B, on-device) | Only if HK write/read is toggled on | Food entries as HK samples | – | Not a new vendor, but other apps with Health read access (and Health's iCloud sync) can then see the entries. Opt-in (D14) |
| **Apple dictation** | Keyboard mic in the add sheet | Spoken text | – | On-device in many languages ([Apple](https://support.apple.com/guide/iphone/dictate-text-iph2c0651d2/ios)) |

**Not added:** FatSecret, Edamam, Nutritionix, Spoonacular, NUBEL. **Never:** food data in `cloudSync.ts`, git, or unredacted debug exports.

---

## 9. Recommendation and decision list

### Recommendation

1. **Don't start before Geert says so.** The roadmap puts food "later"; planning and coaching remain the north star.
2. When green-lit, **build Option A**:
    - run spike S1 first;
    - ship CIQUAL immediately, and NEVO once RIVM confirms (or for Geert's own device only, where he is the licensee using it);
    - fix the dead Kimi defaults as a separate bug fix, because they break Kimi for text today.
3. After **2–3 weeks of real logging**, decide on **Option B** as a single native release. Spike S2 goes first, and the prebuild regression checklist applies.
4. Treat **Option C** as a menu of individual items, each pulled in only on demand.

### Decisions for Geert (answer before building)

| # | Decision | Recommended default |
|---|---|---|
| D1 | Go/no-go and timing, given the roadmap | Not before the current coaching work lands |
| D2 | Scope: A only, A then B, or A+B+C | A, then B after 2–3 weeks of use |
| D3 | RunCoach as the logger, a reader of another app's HK data, or both | Logger; HK import as fallback (B) |
| D4 | Nutrient depth: kcal + macros only, or also sodium, water, caffeine, fibre, micros | Macros + sodium + water in A; caffeine and fibre in B; micros in C |
| D5 | Barcode camera in B's native build, or typed EAN only | Typed EAN in A, camera in B |
| D6 | NEVO: submit the RIVM form (becoming the licensee), and **email nevo@rivm.nl to confirm bundling before NEVO ships in any build distributed to others (TestFlight)**; in the same email ask whether a column subset re-encoded as JSON counts as "unchanged" | Yes; CIQUAL alone until RIVM confirms |
| D7 | Will RunCoach ever be sold or charged for? (NEVO forbids charging end users) | Stays free |
| D8 | OFF: read-only + private cache; contribution flow (C) yes/no; which **contact alias** for the User-Agent | Read-only + cache; project alias; no contributions yet |
| D9 | Which providers/models may receive food photos? Are PRC- or Singapore-based providers acceptable? | Haiku 4.5 for photos (chat keeps its model); flag DeepSeek/Kimi in the UI |
| D10 | Keep photos? | No; a local thumbnail at most |
| D11 | Send the names of the 20 most-logged foods to the LLM to improve matching? | Off by default (opt-in) |
| D12 | Coaching: deterministic rules only, or LLM phrasing when a key exists | Deterministic numbers; LLM phrasing only |
| D13 | Targets: show kcal targets and a balance number, or fuelling-only? Goal = maintain / gentle-loss / fuel-only? Periodised deficit? | Fuelling-first; balance shown neutrally; no deficit on quality/long days |
| D14 | Apple Health write: opt-in or on by default; import from other apps | Opt-in, prompted once (B) |
| D15 | Timeline with run markers or classic meal slots; log-on-pick with undo or a confirm screen | Timeline + log-on-pick |
| D16 | Shortcuts: Tier 0/1 enough, or zero-setup Siri (Tier 2, C)? | Tier 0 in A, Tier 1 in B |
| D17 | Use logged caffeine in the HR-offset model? | Not until a separate evidence check |

### Answers to the tracker's open questions (from the code skim)

1. `app/food.tsx` is rebuilt from scratch; only the theme and Modes routing are reused (§5, §6).
2. `expo-camera` is absent, so barcode scanning goes to B's prebuild; typed EAN covers A (§7.1).
3. The OpenAI-format route (`openai`, `custom`) already exists and carries images (§4.1).
4. Vision works on Anthropic, DeepSeek and OpenAI defaults; not on GLM; Kimi's defaults are dead (§4.1).
5. HK dietary writes need new permissions; they are lazy and opt-in, in B (§6.2).
6. The food log shards + library go into the backup; the DB cache is excluded (§6.1).
7. Supplements stay separate, with an optional nutrient profile (B) (§6.4).
8. `appModel.ts` gets 3 rule lines + 1 data line, only after Food mode is used (§6.4).
9. The OFF User-Agent uses a project contact alias (D8).
10. Search-as-you-type is local only (bundled table); OFF search is an explicit tap (§3.3, §5).

---

## 10. Review notes

Round 1 (reviewer verdict FIX) found that this report was missing, and flagged five more issues. All of them are corrected in this revision and in the workstream files (ws2, ws3, ws4, ws5). The details, and the reviewer's round 2, are in TRACKER.md → Review sign-off.
