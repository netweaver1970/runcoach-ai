# Nutrition tracking: overnight research brief (2026-09-28)

**Owner:** Geert. **Scheduled:** after the weekly token reset (22:00 local, 2026-09-28).
**Output wanted:** the next morning. Findings, 2–3 implementation OPTIONS with effort estimates and a recommendation. Geert decides what gets built. **No production code tonight.** Throwaway spikes (e.g. hitting a food API to check coverage) are allowed, in the session scratchpad only.

## Goal (Geert's words, condensed)
"Proper nutrition tracking/reporting, also including AI photo analysis (if LLM API key provided) and easy food/meal creation/entry. Analyse the most used tools/iOS programs, investigate what's working best. Look for free food databases."

## Process (Geert's request)
- **Product-manager agent:**
  - owns the plan and a live tracker (`docs/nutrition/TRACKER.md`: workstreams, status, open questions, decisions needed);
  - assigns the work to specialist agents;
  - integrates their findings into the final report.
- **Specialist agents**, one per workstream (below).
- **Review agent** (as with the watch code today): checks the findings for completeness and correctness. That means:
  - sources are cited and real;
  - licence and terms claims are accurate (ODbL share-alike, API ToS, rate limits, commercial clauses);
  - the numbers are plausible;
  - nothing is left out of the options.
  - The PM fixes everything it flags before the report is published.

## Workstreams
1. **Market analysis: the most used nutrition trackers.**
   - Apps: MyFitnessPal, Cronometer, MacroFactor, Lose It!, Yazio, Lifesum, FatSecret, Carb Manager, plus the AI-first apps (Cal AI, SnapCalorie, Foodvisor, and similar).
   - For each: what they do best, what users love or hate (App Store reviews, r/loseit, r/MacroFactor, r/Cronometer), and speed of entry (taps per meal).
   - Also: database quality, barcode, recipes and meals, "copy yesterday", recents and favourites, micronutrients, adaptive targets (MacroFactor's expenditure algorithm), Apple Health sync, and pricing and free tiers.
   - Output: a feature matrix, and "the 10 things that make logging stick".
2. **Free food databases.**
   - Sources:
     - Open Food Facts (branded products, barcodes, very strong for BE/FR/NL, ODbL);
     - USDA FoodData Central (generic foods, public domain);
     - NEVO (the Dutch table), CIQUAL (the French ANSES table), Belgian sources (NUBEL / Belgian food composition table);
     - EFSA;
     - free API tiers (FatSecret Platform, Edamam, Nutritionix, Spoonacular).
   - For each: coverage of Belgian supermarket products (Delhaize, Colruyt, Aldi/Lidl BE), languages (NL/FR/EN), nutrient completeness (macros vs micros), barcode support, an offline dump vs a live API, rate limits, and the exact licence obligations for use in an app.
   - Spike: look up 10 real Belgian barcodes and 10 generic foods, and report the hit rate and data quality.
3. **AI photo analysis (only when an LLM key is configured).**
   - Which of the app's providers support vision today: Anthropic (native), DeepSeek, GLM, Kimi (see `src/services/llm.ts` `PROVIDERS`). The app also plans an OpenAI-format route (Groq/Gemini).
   - Prompting for structured JSON (items, portion grams, confidence), portion-estimation accuracy (published evaluations of GPT-4V/Claude/Gemini on food images, plus what Cal AI/SnapCalorie claim), and hybrid approaches:
     - the LLM identifies the items, and a database gives the nutrients per 100 g;
     - the user confirms the portions.
   - Cost per photo per provider, latency, and privacy.
   - Also a label/receipt/menu photo → text path.
4. **Fast entry and meal creation (UX).**
   - Barcode scan (the expo-camera barcode scanner on SDK 52), search with recents and favourites, saved meals, recipe builder (ingredients → per-serving), "copy yesterday / last Tuesday", quick-add calories and macros, voice/text free-form ("2 eggs, toast with butter" → LLM parse → DB match), and home-screen / Siri shortcuts.
   - Target: ≤3 taps for a repeat meal, ≤10 s for a new photo meal.
5. **Integration with RunCoach.**
   - Write to Apple Health: dietary energy, macros, micros, water, caffeine. Read too: another app may already log there, so avoid double counting.
   - Energy balance: intake vs active energy + basal (already fetched), and the effect on training.
   - Coaching hooks: fuelling around long runs and intervals, carbs before quality sessions, hydration and electrolytes (Geert sweats heavily and is heat-sensitive).
   - Weight and body-composition trends: Biology mode already charts weight, body fat and lean mass. Link intake to those.
   - Supplements already tracked (`src/services/supplements.ts`, timeline); relation to Labs (glucose).
   - The LLM app model block (`src/services/appModel.ts`: add app facts there).
   - Data model and storage (local-first, like the rest of the app).
   - Backup/restore (`backup.ts`).
   - The existing placeholder screen `app/food.tsx` (☰ Modes → Food).

## Constraints
- **The app:** React Native / Expo SDK 52, iOS, TypeScript; local Xcode builds (no EAS until next month). **It must work KEYLESS:** the AI features are optional, with a deterministic path always available.
- **Privacy:** local-first. Never commit personal health, labs or food logs to git. Any cloud food API gets queried with food terms or barcodes only, never identity. Flag every new third party.
- **Geert:** a Belgian runner. Dutch/French product labels; metric units; heat-sensitive; carries central weight; conservative coaching.
- **Licences:**
  - ODbL (Open Food Facts) imposes share-alike on a derived database. Explain exactly what that means for a local cache or a contribution flow.
  - Check API terms for caching and for commercial use (in case the app is ever distributed; TestFlight is already set up).

## Deliverable (PM integrates, reviewer signs off)
- `docs/nutrition/REPORT.md` plus a published, private Artifact page containing:
  1. an executive summary (1 screen);
  2. the market findings and feature matrix;
  3. the database comparison and a recommended DB stack (with the spike results);
  4. AI photo: feasibility, accuracy, cost, and a recommended flow;
  5. the UX flows for fast entry (sketches or wireframes in text);
  6. the integration design: data model, HealthKit mapping, coach hooks;
  7. **OPTIONS:**
     - **A** MVP;
     - **B** solid v1;
     - **C** ambitious.
     For each: scope, effort (build sessions), risks, dependencies;
  8. a recommendation and a **decision list for Geert** (the questions he must answer before building).
- `docs/nutrition/TRACKER.md` with the final state of every workstream.
- The reviewer's sign-off notes (what was checked, what was corrected).
