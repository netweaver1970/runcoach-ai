# WS3: AI photo analysis (research, 2026-09-28)

**Scope:** which of the app's LLM providers can take a food photo today; what the published accuracy evidence says; the hybrid flow; cost, latency and privacy per provider; a label/receipt/menu → text path; a draft JSON schema and prompt; a recommended flow.
**Mode:** research only. No app code changed. The spikes ran in the session scratchpad (`…/scratchpad/nutrition`): the cost math (`cost.py`) and an on-device OCR spike on a label (`label_ocr.swift`, `parse_label.py`).

## TL;DR

1. **Photo-only calorie estimates are rough.** Frontier models land at about **35 % MAPE on energy**, and they **under-estimate large portions** ([Fridolfsson 2025](https://pmc.ncbi.nlm.nih.gov/articles/PMC12513282/)).
   - That bias matters for an energy-balance coach.
   - The error comes from **portion size, not from recognising the food**. In Nutrition5k, per-gram calorie error is 9.5 %, while direct calorie error is 26.1 % ([Thames 2021](https://arxiv.org/pdf/2103.03375)).
   - When Gemini 2.5 Flash is given the true weight, carb MAPE on phone photos falls from 56.6 % to 20.2 % (GPT-4.1: 39.5 % to 26.8 %) ([Mu 2025](https://pmc.ncbi.nlm.nih.gov/articles/PMC13401436/)).
2. **Therefore the flow is: the LLM names the items and proposes grams, the database supplies nutrients per 100 g, and the user confirms the grams.** DietAI24 (an LLM plus a nutrient database) beat plain GPT-Vision and the commercial apps ([Yan 2025](https://pmc.ncbi.nlm.nih.gov/articles/PMC12589391/)).
3. **Provider support today:**

   | Provider | Vision today | Action |
   |---|---|---|
   | Anthropic | Yes | Works as is |
   | DeepSeek | Yes, via the app's `deepseek-v4-flash` alias | Works as is |
   | OpenAI | Yes, but the default `gpt-4o-mini` is the most token-hungry per image | Pick another model |
   | GLM | No: default `glm-4.6` is text-only | Would need a vision model plus the OpenAI-format endpoint |
   | Kimi | No: all Kimi models in `llm.ts` are **discontinued**, which breaks Kimi for text too | Fix the model list |
4. **Cost is negligible.** About **$0.0005–$0.011 per photo**, so under $1/month at 3 photos a day. The table assumes a ~1024 px downscale; without it, providers downscale server-side and the cost barely moves (Haiku ~$0.004). What the missing resize does hurt is **upload size and latency** (§1, "Photo upload rule").
5. **Keyless label path (Option B only):** on-device Apple Vision OCR reads Dutch and French EU nutrition labels. The spike parsed 8/8 fields correctly in about 0.4 s. It needs a small Swift function in an existing native module (Xcode build, **not OTA**), so it belongs to the Option B prebuild. In an OTA-only Option A the photo button is greyed without a key (REPORT.md keyless matrix).

---

## 1. Vision support per configured provider

Source of truth: `src/services/llm.ts` `PROVIDERS` and `callLLMWithImage()`.

- `callLLMWithImage()` already sends an Anthropic `image` block (messages format) or an OpenAI `image_url` data URI (openai format).
- Two screens use it today: `app/bevel-import.tsx` and `app/travel-projection.tsx`.

| `PROVIDERS` id | Wire / base URL in app | Default model in app | Vision on that model? | Vision model to use | Image through the app's current code path? |
|---|---|---|---|---|---|
| `anthropic` | messages · api.anthropic.com | `claude-sonnet-4-6` | **Yes**: all current Claude models accept images ([vision docs](https://platform.claude.com/docs/en/build-with-claude/vision)) | `claude-haiku-4-5-20251001` (cheap, fast) | **Yes.** Already used by the Bevel import |
| `deepseek` | messages · api.deepseek.com/anthropic | `deepseek-v4-flash` | **Yes**: the legacy name is now "served by the DeepSeek-V4.1-Flash model", which lists Vision ✓. `deepseek-v4-pro` lists Vision "Not supported" ([pricing/models](https://api-docs.deepseek.com/quick_start/pricing/)) | `deepseek-flash` | **Yes.** The Anthropic endpoint accepts `image` blocks: base64 jpeg/png/gif/webp, url, or file ([Anthropic API compat](https://api-docs.deepseek.com/guides/anthropic_api)) |
| `glm` | messages · api.z.ai/api/anthropic | `glm-4.6` | **No**: the model page lists input modality "Text" ([GLM-4.6](https://docs.z.ai/guides/llm/glm-4.6)) | `glm-5.3-flash` (native multimodal) or `glm-4.6v-flash` (free) ([GLM-5.3-Flash](https://docs.z.ai/guides/vlm/glm-5.3-flash.md), [pricing](https://docs.z.ai/guides/overview/pricing.md)) | **Unverified.** Z.ai documents images only as `image_url` on the OpenAI-format API `api.z.ai/api/paas/v4` ([API intro](https://docs.z.ai/api-reference/introduction)). For Claude Code users it points to a separate [Vision MCP server](https://docs.z.ai/devpack/mcp/vision-mcp-server.md). Plan on the `custom` (OpenAI-format) route |
| `kimi` | messages · api.moonshot.ai/anthropic | `kimi-k2-turbo-preview` | **Model discontinued.** The whole `kimi-k2` series was discontinued on 25 May 2026, `kimi-latest` on 28 Jan 2026 ([model list](https://platform.kimi.ai/docs/models.md)). **All three suggested Kimi models in `llm.ts` are dead**, for text too | `kimi-k2.6` (text + image + video) or `kimi-k3` | **Yes, once the model is fixed.** The Messages API documents "image input" at `…/anthropic` ([Messages API](https://platform.kimi.ai/docs/api/messages.md)) |
| `openai` | openai · api.openai.com/v1 | `gpt-4o-mini` | Yes, but images cost 2833 base + 5667 per 512-px tile ([vision guide](https://developers.openai.com/api/docs/guides/images-vision)) | `gpt-4.1-mini` or `gpt-5.4-mini` | **Yes** |
| `custom` → Groq | openai · api.groq.com/openai/v1 | n/a | n/a | `qwen/qwen3.8-27b`: **Preview**, 2048 tokens/image, max 3 images ([Groq vision](https://console.groq.com/docs/vision.md)) | **Yes** |
| `custom` → Gemini | openai · generativelanguage.googleapis.com/v1beta/openai ([OpenAI compat](https://ai.google.dev/gemini-api/docs/openai)) | n/a | n/a | `gemini-3.1-flash-lite` / `gemini-3.5-flash-lite` | **Yes** |

**The "planned OpenAI-format route" already exists.** `openai` and `custom` are live entries in `PROVIDERS`, and `callLLMWithImage()` has the `image_url` branch.

### Changes a build would need (not done, research only)

- **Add a per-provider `visionModel` field.** Photo calls would use a cheap vision model independent of the chat model: Haiku for Anthropic, `deepseek-flash`, `kimi-k2.6`, `gpt-4.1-mini`. Grey the photo button when the active provider has no vision model; today that is GLM through the Anthropic endpoint.
- **Replace the Kimi defaults.** `kimi-k2.6` / `kimi-k3` instead of the discontinued models. This is a separate bug, outside nutrition.
- **Photo upload rule (PM, review round 1; the same rule is in REPORT.md §4):**
  - *Problem.* The existing callers pass `quality: 1` and hard-code `mediaType: 'image/png'` (`app/bevel-import.tsx:57/75`, `app/travel-projection.tsx:120/127`; `llm.ts` defaults to `image/png`). Anthropic caps a base64 image at **10 MB** on the direct API (5 MB on Bedrock/Vertex) and bills up to 1568 visual tokens, or 4784 on the high-resolution tier of Claude 4.7+ ([vision docs](https://platform.claude.com/docs/en/build-with-claude/vision)). Recent Pro iPhones save 24 MP photos by default ([Apple](https://support.apple.com/en-gu/guide/iphone/iphb362b394e/ios)), so a `quality: 1` camera JPEG can approach or pass that cap once base64 adds ~33 %. The real size of a `launchCameraAsync` capture is **not measured**.
  - *Option A (OTA, no new native code).* `quality ≈ 0.5`; `mediaType` set from the bytes, not hard-coded: Expo documents the picker's `base64` as the image's JPEG data ([ImagePicker SDK 52](https://docs.expo.dev/versions/v52.0.0/sdk/imagepicker/)), so sniff the prefix (`/9j/` → `image/jpeg`, `iVBORw0KGgo` → `image/png`) and fall back to `asset.mimeType`; a **base64-size guard**: above ~5 MB, re-open the picker at `quality ≈ 0.25` or tell the user to retake. No true resize in A.
  - *Option B (prebuild).* True resize to ~1024 px long edge, JPEG q≈0.7 (~150 KB), via `expo-image-manipulator` (new native dependency) or a resize function in the existing `modules/runcoach-pdf` Swift module, bundled into B's single prebuild.
  - *Mandatory pre-build spike (before any photo code):* capture on Geert's phone at `quality` 1 / 0.5 / 0.25, log base64 length and the first bytes, and send the same image labelled `image/png` and `image/jpeg` to Anthropic, DeepSeek and the OpenAI route. Whether Anthropic rejects a JPEG labelled PNG is **not verified**; DeepSeek detects the format from the bytes ([vision](https://api-docs.deepseek.com/guides/vision/)).
- **Turn thinking off, or budget for it.**
  - DeepSeek Flash thinks by default ([pricing](https://api-docs.deepseek.com/quick_start/pricing/)).
  - GLM-5.3-Flash "thinking cannot be disabled" ([GLM-5.3-Flash](https://docs.z.ai/guides/vlm/glm-5.3-flash.md)).
  - Kimi K2.6 reasons by default ([Artificial Analysis](https://artificialanalysis.ai/models/kimi-k2-6)).
  - `handleMessagesResponse()` already skips `thinking` blocks. `maxTokens` must leave room for thinking, or the call ends in the "hit its output-token limit" error.

## 2. Accuracy: published evaluations vs vendor claims

### Independent / peer-reviewed

| Study | Models | Data | Energy result | Take-away |
|---|---|---|---|---|
| [Fridolfsson et al. 2025, *Curr Dev Nutr*](https://pmc.ncbi.nlm.nih.gov/articles/PMC12513282/) | GPT-4o, Claude 3.5 Sonnet, Gemini 1.5 Pro | 52 weighed photos (16 components + 36 meals × 3 portion sizes) | **MAPE 35.8 %** (GPT-4o and Claude); Gemini 64.2 %. Weight MAPE 36.3 % / 37.3 % | **All models under-estimate, more so as portions grow** (bias slopes −0.23 to −0.50). Protein MAPE is about 61 % |
| [Isobe et al. 2026, *Nutrients*](https://pmc.ncbi.nlm.nih.gov/articles/PMC13029357/) | GPT-4o, Gemini 1.5 Pro, Claude 3.5 Sonnet + 7 Japanese apps | 15 standardized hospital meals | GPT-4o **MAE 38.5 kcal**, 73 % of meals within ±10 %. Registered dietitians: 22.4 kcal, 87 % | Easy setting (plated, standard portions). **Every AI model over-estimated lipids by more than 20 %** |
| [Coburn et al. 2025 (ACETADA), arXiv](https://arxiv.org/html/2507.07048) | GPT-4o, GPT-4.1, Claude 3.7 Sonnet, Gemini 2.5 Pro + 4 open models | 806 real-life meal photos, dietitian-verified | Adding context (time, location, food flags) cut calorie MAE by **about 76 kcal on average**. An expert-persona prompt plus metadata cut it by 75 kcal | **Context in the prompt helps.** Meal time is cheap and privacy-safe; GPS is not needed |
| [Mu, Sun, He 2025, ACM BCB](https://pmc.ncbi.nlm.nih.gov/articles/PMC13401436/) | Gemini 2.5 Flash, GPT-4.1 (+mini/nano), Llama 4 | Nutrition5k (505 test) + 78 phone photos | GPT-4.1 calorie MAPE 34.6 % (Nutrition5k), 42.2 % (phone photos) | **Supplying the weight is the lever.** Gemini 2.5 Flash carb MAPE: no weight 56.6 %, predicted weight 39.5 %, **true weight 20.2 %** |
| [Sterling et al. 2026, bioRxiv preprint](https://www.biorxiv.org/content/10.64898/2026.07.26.740845v1) | 10 incl. Gemini 2.0–3.1 Flash(-Lite), GPT-4o/4o-mini/5-mini, Claude Haiku 4.5, FatSecret API | Nutrition5k, 3,229 images | Best: Gemini 3.0 Flash, **MAE 80.7 kcal**, CCC 0.767. Gemini 3.1 Flash-Lite CCC 0.754 at $0.59 per 1K images | Cheap "lite" models come close to the best. Not yet peer-reviewed |
| [Yan et al. 2025 (DietAI24), *Commun Med*](https://pmc.ncbi.nlm.nih.gov/articles/PMC12589391/) | GPT-4V + FNDDS database (retrieval-augmented) | Nutrition5k, ASA24 | Nutrition5k: DietAI24 **68.2 kcal** vs GPT-Vision alone 81.8 vs Foodvisor 168.5. ASA24: 47.7 vs **SnapCalorie 169** vs Foodvisor 168 | **The hybrid design wins.** The LLM picks the food and a standard portion from the database, and the database supplies the nutrients |
| [Thames et al. 2021 (Nutrition5k), CVPR](https://arxiv.org/pdf/2103.03375) | Purpose-trained CNN (not an LLM) | 5k dishes | 2D direct 26.1 %; with depth-derived volume **16.5 %**; **per-gram only 9.5 %** | Portion size is the hard part. The human baseline was **41 % (nutritionists) / 53 % (lay people) mass error on 10 simple plates** |

### Vendor claims

| Vendor | Claim | Reality check |
|---|---|---|
| **Cal AI** | Its own help text: "CalAI is about 80% accurate" ([calai.app](https://www.calai.app/)). Third-party write-ups quote "90%" ([eesel](https://www.eesel.ai/blog/cal-ai-pricing)) | No published method or peer-reviewed validation found |
| **SnapCalorie** | "2x more accurate than nutritionists" ([snapcalorie.com](https://www.snapcalorie.com/)). "Reduce the caloric error to under 20%" ([TechCrunch 2023](https://techcrunch.com/2023/06/26/snapcalorie-computer-vision-health-app-raises-3m/)) | The "2×" traces back to the Nutrition5k 16.5 % vs a **41 % mass-estimation survey of 4 nutritionists on 10 simple plates**. An independent test put SnapCalorie at **169 kcal MAE** on ASA24 ([DietAI24](https://pmc.ncbi.nlm.nih.gov/articles/PMC12589391/)) |

**What this means for RunCoach:**

- A photo-only estimate is a **±~35 % energy number that is biased low on big plates**. That bias is exactly the failure that makes an energy balance look like a deficit after a long run.
- Fat is error-prone in both directions: under-estimated in one study, over-estimated by more than 20 % in another. Hidden oil and butter should be an explicit, user-toggled line item.
- The fix the literature supports: **confirmed grams plus nutrients per 100 g from a database**.

## 3. Hybrid flow (recommended)

```
[camera / library]
  └─ on-device: Option B = resize to 1024 px long edge, JPEG q≈0.7 (~150 KB)
               Option A = picker quality≈0.5, no resize, byte-sniffed media type, ~5 MB base64 guard (§1)
               both: EXIF not requested; GPS stripping verified in the pre-build spike
      ├─ NO KEY → Option A: 📷 greyed; search / free text / EAN digits / manual label form
      │           Option B: + barcode scan + keyless "Label" mode (Vision OCR, §6)
      └─ KEY    → callLLMWithImage(visionModel, image-first, prompt §5)   (~2–6 s)
                   └─ JSON (schema §4): image_kind, items[name, search terms nl/fr/en, grams + range, confidence]
                        ├─ image_kind = nutrition_label / package → label path (§6)
                        └─ image_kind = meal
                             └─ per item: local DB match (NEVO/CIQUAL generic; OFF if brand/barcode) → per-100 g
                                   (no match → LLM's own per-100 g, tagged "AI estimate")
[confirm screen]  one row per item, prefilled
   name (tap → top-3 DB alternatives) · grams stepper/slider (range shown) · household chips (½ plate, 1 slice…)
   low-confidence rows highlighted · hidden-fat suggestion as toggle ("+1 tbsp olive oil?")
   → Save = 1 tap if everything looks right
[store] per-item entries, provenance {source:'photo-ai', provider, model, confidence, userEditedGrams}
   → portion memory: "your usual muesli bowl = 80 g" reused as a prior next time (local only)
```

- **The ≤10 s photo target (WS4) is borderline, contingent on X ≤ ~4.5 s**, where X = upload + LLM round-trip (WS4 §5 budgets ~5.5 s for the rest). Claude Haiku 4.5 measures 0.70 s to first token and 82.7 tokens/s ([Artificial Analysis](https://artificialanalysis.ai/models/claude-4-5-haiku)), so 350 output tokens take about 5 s with a ~150 KB upload (Option B). With Option A's un-resized multi-MB upload, X will likely exceed 4.5 s: treat ≤10 s as a B target, not an A promise. Groq serves about 450 tokens/s ([model page](https://console.groq.com/docs/model/qwen/qwen3.8-27b)). Reasoning-by-default models (DeepSeek, GLM-5.3-Flash, Kimi K2.6) will often exceed 10 s unless thinking is disabled.
- **The LLM never writes calories straight into the log.** Its numbers are proposals. Totals always come from database nutrients × grams the user saw.
- **Context sent with the photo:** meal slot and local time, the country "Belgium", and the language "nl/fr". This is the ACETADA effect, without GPS.
  - Optional and off by default: the names of the user's 20 most-logged foods, which improves matching.
  - That is food-log data, so it needs explicit opt-in.
- **One request per photo; skip multi-sample self-consistency.** Self-consistency would multiply cost and latency, and the user-confirmed grams already remove most of the error.

## 4. Draft JSON schema (v1)

Kept small so output stays around 350 tokens. Anthropic can enforce it with `output_config.format` structured outputs, which is GA on Haiku 4.5 and Sonnet 4.6 ([structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)). Kimi's Messages API also lists structured output. For the other providers, parse tolerantly: strip code fences, take the first `{…}`, validate, and clamp. The existing `parseFlightExtraction` follows the same pattern.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "FoodPhotoAnalysis",
  "type": "object",
  "required": ["schema_version", "image_kind", "items"],
  "additionalProperties": false,
  "properties": {
    "schema_version": { "const": 1 },
    "image_kind": { "enum": ["meal", "packaged_product", "nutrition_label", "receipt", "menu", "not_food"] },
    "items": {
      "type": "array", "maxItems": 12,
      "items": {
        "type": "object",
        "required": ["name_en", "search", "grams", "grams_low", "grams_high", "confidence"],
        "additionalProperties": false,
        "properties": {
          "name_en":     { "type": "string", "maxLength": 60 },
          "name_local":  { "type": ["string", "null"], "description": "Dutch or French name if obvious" },
          "search":      { "type": "object", "description": "DB lookup terms, generic first",
                           "properties": { "nl": {"type":"string"}, "fr": {"type":"string"}, "en": {"type":"string"} },
                           "required": ["en"] },
          "preparation": { "enum": ["raw", "boiled", "steamed", "baked", "grilled", "fried", "sauce_or_mixed", "unknown"] },
          "brand":       { "type": ["string", "null"] },
          "barcode":     { "type": ["string", "null"], "pattern": "^[0-9]{8,14}$" },
          "grams":       { "type": "number", "minimum": 1, "maximum": 2000 },
          "grams_low":   { "type": "number", "minimum": 1 },
          "grams_high":  { "type": "number", "maximum": 3000 },
          "household":   { "type": ["object", "null"],
                           "properties": { "unit": { "enum": ["piece", "slice", "tbsp", "tsp", "cup", "bowl", "glass", "handful", "plate_fraction"] },
                                           "count": { "type": "number" } } },
          "hidden":      { "type": "boolean", "description": "true = not visible but likely (cooking oil, butter, dressing, sugar in drink)" },
          "confidence":  { "type": "object", "required": ["identity", "portion"],
                           "properties": { "identity": {"type":"number","minimum":0,"maximum":1},
                                           "portion":  {"type":"number","minimum":0,"maximum":1} } },
          "est_per_100g": { "type": ["object", "null"], "description": "fallback only if no DB match",
                            "properties": { "kcal": {"type":"number"}, "protein_g": {"type":"number"},
                                            "carb_g": {"type":"number"}, "fat_g": {"type":"number"} } }
        }
      }
    },
    "scale_reference": { "enum": ["plate", "bowl", "cutlery", "hand", "packaging", "none"] },
    "question": { "type": ["string", "null"], "maxLength": 120, "description": "at most ONE clarifying question" },
    "label": { "type": ["object", "null"], "description": "only when image_kind = nutrition_label",
               "properties": { "basis": {"enum": ["per_100g", "per_100ml", "per_serving"]}, "serving_g": {"type": ["number","null"]},
                               "kcal": {"type":"number"}, "fat_g": {"type":"number"}, "sat_fat_g": {"type":"number"},
                               "carb_g": {"type":"number"}, "sugar_g": {"type":"number"}, "fibre_g": {"type":["number","null"]},
                               "protein_g": {"type":"number"}, "salt_g": {"type":"number"} } }
  }
}
```

**App-side validation:**

- Clamp to `grams_low ≤ grams ≤ grams_high`.
- Items with `identity < 0.4` go to a "maybe" list.
- Hidden items start **unticked**.
- Drop `est_per_100g` whenever a database match exists.
- Salt → sodium = salt ÷ 2.5 (EU definition, [Reg. 1169/2011 Annex I](https://eur-lex.europa.eu/eli/reg/2011/1169/oj)).

## 5. Draft prompt (image first, then this text)

```
You are a dietitian estimating what is on a plate for a food log in Belgium.
Context: meal = {breakfast|lunch|dinner|snack}, local time {HH:MM}, labels may be Dutch or French.

Step 1. Classify the image: meal, packaged_product, nutrition_label, receipt, menu, or not_food.
        If nutrition_label: copy the per-100 g (or per-100 ml) column into "label" exactly as printed; items may be empty.
        If packaged_product: name the product and brand; copy any barcode digits you can read.
Step 2. For a meal, list each distinct food separately (max 12). Do not merge sides into the main dish.
        Give generic database search terms in Dutch, French and English (e.g. nl "gekookte aardappel", fr "pomme de terre bouillie").
Step 3. Estimate grams AS SERVED for each item. Use the plate, cutlery or packaging for scale.
        Give a realistic low/high range. Large portions are commonly under-estimated: do not shrink them.
Step 4. Add likely invisible items (cooking oil, butter, dressing, sauce, sugar in a drink) as separate items with hidden=true
        and a conservative amount.
Step 5. Confidence 0–1 for identity and for portion. If one fact would change the estimate a lot, ask ONE short question.

Return ONLY a JSON object matching this schema, with no prose and no code fences:
{schema}
```

- **Design rationale:**
  - Expert persona plus context: [ACETADA](https://arxiv.org/html/2507.07048).
  - Explicit warning against under-estimating large plates: [Fridolfsson](https://pmc.ncbi.nlm.nih.gov/articles/PMC12513282/).
  - Hidden-fat items kept separate and user-toggled: the lipid bias in [Isobe](https://pmc.ncbi.nlm.nih.gov/articles/PMC13029357/).
  - Per-language search terms feed the WS2 databases.
- **Text/voice reuse:** the same schema without the image serves WS4's free-text parse ("2 eggs, toast with butter"). That is a text-only call, several times cheaper.

## 6. Label / receipt / menu photo → text

| Input | Keyless path (always available) | With key | Value |
|---|---|---|---|
| **EU nutrition label** (NL/FR) | **On-device Apple Vision OCR.** Group lines by bounding box, then a deterministic parser for `Energie/Énergie … kcal`, `Vetten/Matières grasses`, `waarvan verzadigde/dont saturés`, `Koolhydraten/Glucides`, `suikers/sucres`, `Vezels/Fibres`, `Eiwitten/Protéines`, `Zout/Sel`. The EU layout per 100 g is mandatory ([Reg. 1169/2011](https://eur-lex.europa.eu/eli/reg/2011/1169/oj)) | The LLM fills `label{}`. Cross-check against the OCR parse and highlight any disagreeing number | **High.** Fills products that Open Food Facts lacks, and can feed an OFF contribution (licence: WS2) |
| **Receipt** | OCR → line items. Belgian receipts use abbreviated names, so matching is poor | Text-only LLM maps lines to products; the user ticks what was eaten | Low. It records purchases, not intake. Park it |
| **Menu** | OCR → the user picks a dish, then search | The LLM picks the dish and estimates with the §4 schema | Medium for eating out, but accuracy is weakest here (restaurant fats). Tag as "estimate" |

**Spike (scratchpad, macOS 27 Vision framework, same API as iOS):**

- `VNRecognizeTextRequest` lists **`nl-NL` and `fr-FR`** among its supported languages.
- The test image was a synthetic bilingual NL/FR label: JPEG q0.6, rotated 2.5°.
- Row grouping by bounding-box y plus a regex parser extracted **8/8 fields correctly**: kcal 370, fat 9.5, saturates 1.2, carbs 58, sugars 21, fibre 7.4, protein 9.8, salt 0.45 → sodium 180 mg.
- Warm OCR time was **0.41 s**. The first run took 69 s, which was a one-time model load in the Swift interpreter.
- Caveats:
  - The label and value columns come back as **separate observations**, so pairing by bounding box is required.
  - The image was a clean render. Real photos (glare, curved packs) will do worse, so on-device testing is needed.

**iOS 26+ adds `RecognizeDocumentsRequest`.** Apple's docs name "receipts, nutritional labels" as target documents, and it returns tables and lines ([Apple docs](https://developer.apple.com/documentation/vision/recognizedocumentsrequest)). It could replace the manual row grouping; Geert's phone runs iOS 27. The fallback `VNRecognizeTextRequest` goes back to iOS 13 ([Apple docs](https://developer.apple.com/documentation/vision/vnrecognizetextrequest)).

**Implementation:** add a `recognizeText(uri, langs)` function to the existing `modules/runcoach-pdf` Swift module, which already uses Apple frameworks. This needs a local Xcode build and is **not OTA-deliverable**.

## 7. Cost per photo

**Assumptions:**

- Photo downscaled to **1024 × 768**.
- Prompt about **700** text tokens (instructions plus schema).
- Output about **350** tokens (4–5 items).
- Thinking off unless noted.
- Standard (non-batch) list prices as of 2026-09-28.
- Script: `scratchpad/nutrition/cost.py`.

| Provider · model | Image tokens (rule → math) | $/M in · out | Cost / photo | 90 photos/mo |
|---|---|---|---|---|
| Anthropic · Haiku 4.5 | ⌈1024/28⌉×⌈768/28⌉ = 37×28 = **1036** ([rule](https://platform.claude.com/docs/en/build-with-claude/vision)) | 1 · 5 ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)) | 1736×1 + 350×5 → **$0.0035** | $0.31 |
| Anthropic · Sonnet 4.6 (app default) | 1036 | 3 · 15 | 1736×3 + 350×15 → **$0.0105** | $0.94 |
| Anthropic · Sonnet 5 | 1036 (high-res tier; would be up to 4784 if not downscaled). About 30 % more text tokens (new tokenizer) | 2 · 10 | 1946×2 + 455×10 → **$0.0084** | $0.76 |
| DeepSeek · deepseek-flash | **≤1024** (upper bound per image, [vision](https://api-docs.deepseek.com/guides/vision/)) | 0.30 · 1.20 peak / 0.15 · 0.60 off-peak ([pricing](https://api-docs.deepseek.com/quick_start/pricing/)) | 1724×0.30 + 350×1.20 → **$0.0009** (off-peak $0.0005) | $0.04–0.08 |
| GLM · glm-5.3-flash (OpenAI route) | **not documented**; ~1100 assumed. Thinking is always on (+~800 output assumed) | 0.15 · 0.50 ([pricing](https://docs.z.ai/guides/overview/pricing.md)) | 1800×0.15 + 1150×0.50 → **~$0.0008** (`glm-4.6v-flash`: free) | ~$0.08 |
| Kimi · kimi-k2.6 | **not documented** ("higher resolution → more tokens"); ~1000 assumed | 0.95 · 4.00 ([pricing](https://platform.kimi.ai/docs/pricing/chat.md)) | 1700×0.95 + 350×4 → **~$0.0030** | ~$0.27 |
| OpenAI · gpt-4o-mini (app default) | 2×2 tiles: 2833 + 4×5667 = **25,501** ([rule](https://developers.openai.com/api/docs/guides/images-vision)) | 0.15 · 0.60 ([pricing](https://developers.openai.com/api/docs/pricing)) | 26201×0.15 + 350×0.60 → **$0.0041** | $0.37 |
| OpenAI · gpt-4o | 85 + 4×170 = **765** | 2.50 · 10 | 1465×2.5 + 350×10 → **$0.0072** | $0.64 |
| OpenAI · gpt-4.1-mini | 32×24 patches = 768 × 1.62 = **1245** | 0.40 · 1.60 | 1945×0.40 + 350×1.60 → **$0.0013** | $0.12 |
| OpenAI · gpt-5.4-mini | 768 × 1.2 = **922** | 0.75 · 4.50 | 1622×0.75 + 350×4.50 → **$0.0028** (plus any reasoning tokens) | $0.25 |
| Gemini · 3.1 Flash-Lite | **1120** (Gemini 3 default; 280 at `low`) ([media resolution](https://ai.google.dev/gemini-api/docs/media-resolution)) | 0.25 · 1.50 ([pricing](https://ai.google.dev/gemini-api/docs/pricing)) | 1820×0.25 + 350×1.50 → **$0.0010** | $0.09 |
| Gemini · 3.5 Flash-Lite | 1120 | 0.30 · 2.50 | 1820×0.30 + 350×2.50 → **$0.0014** | $0.13 |
| Groq · qwen3.8-27b (preview) | **2048** flat ([vision](https://console.groq.com/docs/vision.md)) | 0.80 · 4.00 ([model](https://console.groq.com/docs/model/qwen/qwen3.8-27b)) | 2748×0.80 + 350×4 → **$0.0036** | $0.32 |

**Notes:**

- Cost is not a decision factor below about $1/month.
- **Changing models saves more than the resize does.** Under OpenAI's rules a full-size 4032×3024 photo is still only 4 tiles, but the app default `gpt-4o-mini` costs about 3× `gpt-4.1-mini`.
- **Resizing matters mostly for upload size and latency.** A base64 photo at `quality: 1` weighs several MB, against about 150 KB after the resize. Without the resize (Option A) Haiku's cost rises only to ~$0.004, because Anthropic downscales server-side and caps the standard tier at 1568 visual tokens ([vision docs](https://platform.claude.com/docs/en/build-with-claude/vision)).
- **DeepSeek peak hours** are 01:00–04:00 and 06:00–10:00 UTC on weekdays. That covers Belgian breakfast.

## 8. Privacy

- **The image goes only to the provider the user configured.** No other third party is added. Before sending:
  - strip EXIF/GPS by re-encoding;
  - send no identity and no health data;
  - send no food-log context unless the user opts in.
  - Claude ignores image metadata anyway ([vision FAQ](https://platform.claude.com/docs/en/build-with-claude/vision)).
- **Do not keep the photo by default.** At most, a local thumbnail. The photo stays out of git, and out of `backup.ts` unless Geert decides otherwise.

| Provider | Where / retention / training (per vendor docs) |
|---|---|
| Anthropic | API inputs and outputs deleted within 30 days ([privacy center](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)). "Anthropic does not use uploaded images to train models" ([vision FAQ](https://platform.claude.com/docs/en/build-with-claude/vision)) |
| OpenAI | API data not used for training by default; abuse logs kept up to 30 days ([your data](https://developers.openai.com/api/docs/guides/your-data)) |
| DeepSeek | The consumer privacy policy says data is stored in the **PRC** and may be used for training, with an opt-out. Its own text excludes open-platform developer apps, whose terms were not reviewed here ([privacy policy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html)). **Flag: PRC jurisdiction** |
| Kimi (Moonshot AI Pte, Singapore) | Servers in Singapore. The policy says inputs, images included, "help us optimize our models" ([privacy](https://platform.kimi.ai/docs/agreement/userprivacy)). **Flag: possible training use** |
| Z.ai (GLM) | Processed in Singapore. The DPA says API content is processed in real time and not stored ([privacy](https://docs.z.ai/legal-agreement/privacy-policy)) |
| Google Gemini | Free tier: "Used to improve our products: Yes" ([pricing](https://ai.google.dev/gemini-api/docs/pricing)). In the EEA the paid-service data terms apply to all usage, and **API clients offered to EEA users must use Paid Services** ([terms](https://ai.google.dev/gemini-api/terms)). For a Belgian user that means a billed key |
| Groq | Not reviewed in depth. The vision model is a **Preview** release; flag it before relying on it |

## 9. Recommendation

1. **Build the hybrid flow (§3):**
   - the LLM identifies items and proposes grams with ranges;
   - the local database (WS2) supplies nutrients per 100 g;
   - the user confirms grams on a single pre-filled screen;
   - LLM nutrient numbers are used only as a tagged fallback.
   - This is the design with the strongest evidence, and it keeps the log deterministic and auditable.
2. **Default vision models:**
   - **Anthropic:** Claude Haiku 4.5. About $0.0035 per photo, around 5 s, schema-enforced JSON, and the clearest privacy terms.
   - **DeepSeek:** `deepseek-flash` with thinking off. The cheapest option.
   - **OpenAI:** switch from `gpt-4o-mini` to `gpt-4.1-mini`.
   - **Kimi:** fix the dead defaults to `kimi-k2.6`.
   - **GLM:** hide the photo feature unless it is set up through the `custom` OpenAI-format endpoint with a GLM vision model.
3. **Ship the keyless label path with the Option B prebuild:** on-device Vision OCR plus the EU label parser, exposed as a "Label" mode of the `expo-camera` Scan screen. It gives the camera a deterministic function without a key, and it is the most accurate "photo" input there is, because it reads printed numbers. It needs native Swift, so it is **not** part of the OTA-only Option A; there, the 📷 button is greyed without a key and the manual 7-field label form covers the same need (REPORT.md keyless matrix).
4. **Leave out** depth/LiDAR volume estimation, multi-sample self-consistency and receipt parsing for now. All three are candidates for the ambitious Option C at most.

**Rough effort (build sessions):**

| Piece | Sessions |
|---|---|
| `visionModel` plumbing, media-type sniff, size guard (A); true resize (B) | 0.5 (A) + 0.25 (B) |
| Photo → JSON → DB match → confirm screen | 2 |
| Native OCR function + label parser + tests on real Delhaize/Colruyt packs | 1–1.5 |
| Portion memory | 0.5 |

**Open questions for Geert:**

- Is Haiku acceptable as the photo model, while chat keeps Sonnet?
- Should photos be kept at all, even as a local thumbnail?
- Should the names of the user's frequent foods be sent to the provider to improve matching (opt-in)?
- Are PRC- and Singapore-based providers acceptable for food photos?

---

## Sources

- RunCoach code: `/Users/geertsteyaert/projects/runcoach-ai/src/services/llm.ts` (`PROVIDERS`, `callLLMWithImage`), `app/bevel-import.tsx`, `app/travel-projection.tsx`, `modules/runcoach-pdf/`
- Anthropic vision: https://platform.claude.com/docs/en/build-with-claude/vision
- Anthropic pricing: https://platform.claude.com/docs/en/about-claude/pricing
- Expo ImagePicker SDK 52 (`quality`, `base64` = JPEG data, `mimeType`, `exif` off by default, no resize option): https://docs.expo.dev/versions/v52.0.0/sdk/imagepicker/
- Apple, camera formats (24 MP default on recent Pro models): https://support.apple.com/en-gu/guide/iphone/iphb362b394e/ios
- Anthropic structured outputs: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- Anthropic data retention: https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data
- DeepSeek Anthropic API compatibility: https://api-docs.deepseek.com/guides/anthropic_api
- DeepSeek vision: https://api-docs.deepseek.com/guides/vision/
- DeepSeek models & pricing: https://api-docs.deepseek.com/quick_start/pricing/
- DeepSeek privacy policy: https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html
- Z.ai GLM-4.6: https://docs.z.ai/guides/llm/glm-4.6
- Z.ai GLM-5.3-Flash: https://docs.z.ai/guides/vlm/glm-5.3-flash.md
- Z.ai pricing: https://docs.z.ai/guides/overview/pricing.md
- Z.ai API intro: https://docs.z.ai/api-reference/introduction
- Z.ai Vision MCP: https://docs.z.ai/devpack/mcp/vision-mcp-server.md
- Z.ai privacy: https://docs.z.ai/legal-agreement/privacy-policy
- Kimi model list: https://platform.kimi.ai/docs/models.md
- Kimi Messages API: https://platform.kimi.ai/docs/api/messages.md
- Kimi pricing: https://platform.kimi.ai/docs/pricing/chat.md
- Kimi K2.6: https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart
- Kimi privacy: https://platform.kimi.ai/docs/agreement/userprivacy
- OpenAI images & vision: https://developers.openai.com/api/docs/guides/images-vision
- OpenAI pricing: https://developers.openai.com/api/docs/pricing
- OpenAI data controls: https://developers.openai.com/api/docs/guides/your-data
- Groq vision: https://console.groq.com/docs/vision.md
- Groq Qwen3.8-27B: https://console.groq.com/docs/model/qwen/qwen3.8-27b
- Gemini media resolution: https://ai.google.dev/gemini-api/docs/media-resolution
- Gemini pricing: https://ai.google.dev/gemini-api/docs/pricing
- Gemini OpenAI compatibility: https://ai.google.dev/gemini-api/docs/openai
- Gemini API terms: https://ai.google.dev/gemini-api/terms
- Artificial Analysis, Claude 4.5 Haiku: https://artificialanalysis.ai/models/claude-4-5-haiku
- Artificial Analysis, Kimi K2.6: https://artificialanalysis.ai/models/kimi-k2-6
- Fridolfsson et al. 2025, *Curr Dev Nutr*: https://pmc.ncbi.nlm.nih.gov/articles/PMC12513282/
- Isobe et al. 2026, *Nutrients*: https://pmc.ncbi.nlm.nih.gov/articles/PMC13029357/
- Coburn et al. 2025, ACETADA: https://arxiv.org/html/2507.07048
- Mu, Sun, He 2025: https://pmc.ncbi.nlm.nih.gov/articles/PMC13401436/
- Sterling et al. 2026 (preprint): https://www.biorxiv.org/content/10.64898/2026.07.26.740845v1
- Yan et al. 2025, DietAI24: https://pmc.ncbi.nlm.nih.gov/articles/PMC12589391/
- Thames et al. 2021, Nutrition5k: https://arxiv.org/pdf/2103.03375
- Cal AI: https://www.calai.app/
- Cal AI pricing/claims write-up: https://www.eesel.ai/blog/cal-ai-pricing
- SnapCalorie: https://www.snapcalorie.com/
- TechCrunch on SnapCalorie (2023): https://techcrunch.com/2023/06/26/snapcalorie-computer-vision-health-app-raises-3m/
- EU Regulation 1169/2011 (food information to consumers): https://eur-lex.europa.eu/eli/reg/2011/1169/oj
- Apple Vision `RecognizeDocumentsRequest`: https://developer.apple.com/documentation/vision/recognizedocumentsrequest
- Apple Vision `VNRecognizeTextRequest`: https://developer.apple.com/documentation/vision/vnrecognizetextrequest
