# WS1: Market analysis of nutrition trackers

**Date:** 2026-09-28 · **Author:** WS1 market agent · **Status:** research only (no app code)
**Scope:** MyFitnessPal (MFP), Cronometer, MacroFactor (MF), Lose It!, Yazio, Lifesum, FatSecret, Carb Manager, and the AI-first apps Cal AI, SnapCalorie and Foodvisor.

## How this was researched (read this first)

| Evidence | What it is | Caveat |
|---|---|---|
| **App Store metadata** | Ratings, IAP price lists and feature descriptions, pulled on 2026-09-28 from Apple's iTunes Lookup API [S1] and the US and BE App Store pages [S2] | IAP lists show every price variant, including intro, legacy and regional offers, so prices are given as ranges |
| **App Store reviews** | The 100–200 most recent US reviews per app (1,850 in total) from Apple's public customer-review RSS feed [S3]. Themes were counted with keyword regexes; raw data is in the scratchpad (`nutrition/reviews/`) | A "most recent" sample over-weights post-update anger. The FatSecret and Yazio samples are about half Russian-language. SnapCalorie's 195/200 at 4–5★ looks promotion-driven, so treat it with care |
| **Vendor docs** | Help centres, release notes and the MF algorithm articles | Vendor-authored. MF's tap benchmark (FLSI) is run by MF itself |
| **Peer-reviewed studies** | Griffiths 2018 [S20], Evenepoel 2020 (KU Leuven vs the Belgian NUBEL table) [S21], Harvey 2019 [S22], Wang 2026 [S23] | Wang 2026 is part-funded by MFP (the paper discloses this) |
| **Reddit** (r/loseit, r/MacroFactor, r/Cronometer) | **Not accessible.** reddit.com blocks both the research fetcher and scripted access (HTTP 400 "domain not accessible", plus a bot wall) | **Gap against the brief.** App Store reviews and vendor forums [S13][S14] stand in for Reddit. The web is full of SEO "Reddit says…" posts written by competing apps (nutrola.app, nutriscan.app and others). **They are not cited here:** a spot check found fabricated statistics in them |

> **Correction note for the reviewer:** one search summary attributed "23 s per entry" and "2.1× abandonment" to Harvey 2019. The PubMed abstract [S22] contains neither figure, so both were discarded. Only the numbers from the abstract are used below.

---

## 1. Per-app profiles

### MyFitnessPal: the incumbent, now paywall-heavy
- **Scale:** 4.71★ from 2.37M ratings [S1]. The App Store listing claims more than 20.5M foods [S1]. In March 2026 MFP announced it had acquired Cal AI and runs it as a standalone app [S30].
- **Best at:** the biggest (crowd-sourced) database, restaurant coverage, integrations, and saved meals and recipes [S1].
- **Barcode:** **Premium-only since 1 Oct 2022** [S10][S11]. Recent reviews still complain about it ("They charge for everything… even to use the barcode scanner") [S3]. One 2026 article says single-item scanning is free again [S12]. That claim is **unverified and contradicted by the reviews**, so treat barcode as Premium.
- **May 2026 paywall expansion:** Scan-a-meal, recipe-URL import and macro-by-meal goals are now Premium [S12].
- **Copy meal:** yes. In the diary, tap Edit, tick the items, tap Copy and pick a date [S15].
- **Apple Health:** writes meal summaries (calories and nutrients, **no caffeine**) and **does not sync timestamps**. Does **not** read food from Health [S16].
- **Data quality:** in Belgian users, cleaned MFP values correlated well with NUBEL for energy (r = 0.96) and macros (r ≈ 0.90). Sodium and cholesterol correlated weakly (ρ ≈ 0.5), and 2.8% of entries had to be removed as extreme outliers first [S21]. A second study found MFP under-estimated protein, fat, sodium and cholesterol versus the research database NDSR [S20].
- **Users love:** the database, saved meals, and habit longevity ("14 years logging") [S3].
- **Users hate:** paywalls (36 of 70 low-star reviews), the 2026 redesign ("ruined by the app redesign"), and forced AI ("The forced AI is garbage. No way to turn any of it off") [S3].
- **Price:** US $19.99/mo, $79.99/yr (legacy $9.99/mo, $49.99/yr). BE €9.99–21.99/mo, €49.99–87.99/yr [S2].

### Cronometer: the micronutrient and data-quality leader
- **Scale:** 4.77★ from 99k ratings [S1].
- **Best at:** data provenance. Foods come from lab-analysed tables: NCCDB (≈17k foods, 70 nutrients), USDA, CNF, NUTTAB, CoFID, **NEVO**, and others. User submissions (CRDB) are staff-checked, and branded label data carries fewer nutrients [S17]. The listing advertises 95+ nutrients [S1].
- **Free tier:** barcode scanning is free ("Scan barcodes for free") [S1]. Custom foods and recipes are also free.
- **Gold:** photo and voice logging, and ad-free [S1]. **AI photo logging** (Gold) launched 8 Sep 2025. It maps the photo to verified database entries [S18].
- **Copy:** *Copy Previous Day*, *Copy Yesterday's Group*, and copy/paste of selected items [S19]. Favourites and custom tabs [S19].
- **Apple Health:** syncs with Apple Health and Watch, and imports workouts and energy expenditure [S1].
- **Users love:** "way better than MyFitnessPal… value it provides for free", barcode, recents [S3].
- **Users hate:** ads in the free tier (including gambling ads), the **Sept-2026 update that lost favourites and recipes**, broken search, and the loss of recent/common items [S3].
- **Price:** Gold US $10.99/mo, $59.99/yr. BE €11.99/mo, €49.99–69.99/yr [S2].

### MacroFactor: the fastest logger, with adaptive coaching
- **Scale:** 4.84★ from 23k ratings [S1]. **No free tier**, only a 7-day trial [S1].
- **Best at:**
  - the **expenditure algorithm** and adherence-neutral coaching (see §3);
  - logging speed: the vendor's FLSI benchmark counts 24 actions across four tasks, against 36 for MFP [S5];
  - a "verified food database" [S1].
- **Uses Open Food Facts under ODbL.** The App Store notice reads "Contains information from Open Food Facts… under the Open Database License (ODbL)" [S1]. This is a direct precedent for WS2: a paid commercial app ships OFF data with attribution.
- **AI logging** (beta since Mar/Apr 2025): photo, or photo plus text, is decomposed into **real database entries** that are fully editable before logging. MF itself says barcode is faster for single branded items [S8].
- **Logging tools:** copy/paste, "smart history", a timeline log with no fixed meal slots [S1].
- **Apple Health:** bidirectional. It writes calories, macros and weight, and **imports calories, macros and micros that other apps logged** [S9].
- **Users love:** speed and ease (42 of 91 high-star reviews), the AI tool, the algorithm, and history and copy [S3].
- **Users hate:** price and the lack of a free tier (23 of 51 low-star reviews), refund refusals, some inaccurate branded entries and barcode drift, frequent UI changes [S3].
- **Price:** US $11.99/mo, $47.99/6 mo, $71.99/yr. BE €11.99/mo, €73.99/yr [S2].

### Lose It!: simple and long-lived, but increasingly gated
- **Scale:** 4.77★ from 779k ratings [S1].
- **Best at:** simplicity. It ranks second-fastest on several FLSI tasks (search 13, multi-add 7, quick-add 5) [S5].
- **Premium** (per the App Store listing): barcode scanner, photo logging ("Snap It"), AI voice ("I had 2 eggs, toast with butter and jam"), vitamins and minerals, and device syncs including HealthKit [S1].
- **Users love:** longevity and habit ("Year 16", "2500 days and counting"), ease [S3].
- **Users hate:** features moved behind the paywall ("Why remove a free feature?", the barcode lock), upsell pop-ups, embedded GLP-1 ads, and clunky editing after an update [S3].
- **Price:** US $39.99–79.99/yr, lifetime $49.99–59.99. BE €38.99–85.99/yr, lifetime €59.99–69.99 [S2].

### Yazio: the EU-centric option (German)
- **Scale:** 4.70★ from 51k ratings [S1].
- **Best at:** coverage of European branded products. The listing claims 4M+ items plus 2,900+ recipes and meal plans [S1].
- **Free tier:** barcode is listed as part of the "free calorie tracker" [S1].
- **PRO:** in-depth food analysis, meal plans, Fitbit/Garmin sync, ad-free [S1].
- **Apple Health:** supported, with active calories imported from Health [S24].
- **Users hate:**
  - a **very long onboarding before any use** ("Fing long onboarding. I just wanna start. Deleted it"), with many Russian-language complaints on the same theme;
  - PRO pop-ups and coaching nags;
  - goals reset after a break [S3].
- Only 56 of the 200 sampled reviews were 4–5★. This is the worst sentiment among the incumbents, apart from Lifesum [S3].
- **Price:** PRO US $23.90–47.90/yr. BE €11.90–47.90/yr [S2].

### Lifesum: design-led diet plans (Swedish)
- **Scale:** 4.65★ from 151k ratings [S1].
- **Best at:** diet-plan UX (keto, high-protein and others), and photo, voice, text and barcode entry [S1].
- **Apple Health:** imports exercise calories, weight and steps, and exports data [S1].
- **Users hate:**
  - AI pushed into the core flow ("AI slop ruined a good thing"), which is the largest theme at 41 of 122 low-star reviews;
  - bugs and freezes;
  - "verified" entries that are wrong and cannot be corrected;
  - the fasting timer being removed;
  - even a custom calorie goal is paywalled [S3].
- This is the worst sample overall: 50 of 200 reviews were 4–5★.
- **Price:** BE €9.99–14.99/mo, €44.99–99.99/yr [S2].

### FatSecret: the most generous free tier
- **Scale:** 4.73★ from 15k ratings [S1].
- **Free tier:** barcode scanning, image recognition, a recipes database and Apple Watch complications [S1].
- **Apple Health:** the fullest integration among the incumbents. It **writes every food with detailed nutrition** to Health, syncs weight, and reads calories burned and steps [S1].
- **Premium:** dietitian meal plans, advanced meal planning, extra meal headings [S1].
- **Users love:** "free and so helpful", ease [S3].
- **Users hate:** a 2026 update broke search and added taps ("It takes so many more taps", "Search engine died with the last update") [S3].
- **Price:** US $14.99/mo, $59.99/yr (with $38.99 variants). BE €13.49/mo, €35.00–53.90/yr [S2].

### Carb Manager: keto and diabetes specialist
- **Scale:** 4.82★ from 735k ratings [S1].
- **Best at:** net-carb maths, 5,000+ recipes, a recipe builder, and diabetes logging of glucose, ketones and insulin (Premium) [S1].
- **Micros:** Premium [S1].
- **Apple Health:** writes calories, carbs, protein, fat and fiber **once a day** and imports exercise [S25].
- **Users love:** accurate, verified data ("unlike AI based apps"), use by type-1 diabetics, the recipe builder [S3].
- **Users hate:** a pay screen on every open, **data export paywalled** ("User data should not be accessible for a fee"), auto-renewal surprises [S3].
- **Price:** BE €9.49/mo, €31.99–60.99/yr [S2].

### AI-first apps

| App | What it is | Evidence on accuracy | Sentiment in sample [S3] | Price [S2] |
|---|---|---|---|---|
| **Cal AI** (MFP-owned since the Mar-2026 announcement [S30]) | 4.80★ from 367k ratings [S1]. Snap a photo and get calories and macros. "FOOD SCANNING ANALYSIS RESULTS REQUIRE A SUBSCRIPTION" [S1] | **No published validation.** Reviews report systematic *under*-counting: "What should be an 800–900 calorie meal says it's 400 every single time" and "said 180 instead of 280" [S3] | Poor: 61 of 100 low-star, dominated by trial/billing traps and a 30-minute onboarding that ends at a paywall | BE €2.99–44.99 variants |
| **SnapCalorie** | 4.73★ from 6.7k ratings. Photo or voice. **LiDAR portion measurement** on Pro iPhones, USDA-verified nutrients, 100+ nutrients, label scanner, HealthKit [S1]. Founded by ex-Google Lens / Cloud Vision researchers [S26] | Uses the Nutrition5k methodology: depth cut mass error from 18.7% to 13.7%, with **16.5% MAE end-to-end for calories** [S27]. The vendor claims ≈15% average error (secondary source, unverified) | 195 of 200 reviews at 4–5★ (suspiciously uniform) | US $9.99–19.99/mo, $39.99–149/yr |
| **Foodvisor** | 4.59★ from 17.6k ratings. A **French** (Paris) company [S28]. Photo, barcode and favourites. Micronutrients are Premium, and Apple Health is supported [S1] | Uses autofocus distance to estimate the area on the plate [S28]. Reviews: "relatively accurate but sometimes needs user intervention" [S3] | Mixed: the main complaints are refunds and billing | BE €11.99–59.99 variants |

The incumbents are converging on AI too:
- MFP Meal Scan (Premium);
- Cronometer Photo Logging (Gold, Sep 2025) [S18];
- MacroFactor AI (Apr 2025) [S8];
- Lose It Snap It (Premium);
- Lifesum, FatSecret and Carb Manager photo features [S1].

**Where the reviews split:**
- AI that **maps to database entries and stays editable** (MF, Cronometer) earns praise.
- AI that is **forced or opaque** (MFP "forced AI", Lifesum "AI slop") earns the most anger [S3].

---

## 2. Feature matrix

**Legend:** ✅ free · 💰 paid tier only · ⚠️ partial or caveat · ❌ none · ? not verified

| | MFP | Cronometer | MacroFactor | Lose It! | Yazio | Lifesum | FatSecret | Carb Mgr | Cal AI | SnapCalorie | Foodvisor |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **DB model** | Crowd, 20.5M | Lab tables + staff-checked | Verified + OFF | Crowd/curated | Crowd, EU-strong, 4M+ | Curated | Curated | Crowd + verified | AI estimate | AI + USDA | AI + DB |
| **DB quality evidence** | ⚠️ good energy, weak Na/chol [S21]; under-estimates [S20] | ✅ best provenance [S17] | ✅ verified; some branded errors [S3] | ⚠️ under-estimates [S20] | ? | ⚠️ "verified" but wrong [S3] | ? | ⚠️ "database is a mess" (1 review) | ❌ under-counts [S3] | ⚠️ Nutrition5k-style 16.5% [S27] | ⚠️ |
| **Barcode** | 💰 since 2022 [S10] | ✅ | 💰 (app is paid) | 💰 [S1] | ✅ [S1] | ✅ [S1] | ✅ [S1] | ✅ [S1] | ? | ✅ label scan [S1] | ✅ |
| **Saved meals / recipes** | ✅ / URL import 💰 [S12] | ✅ / URL import 💰 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ builder | ⚠️ | ⚠️ learns habits | ✅ favourites |
| **Copy yesterday / meal** | ✅ copy to date [S15] | ✅ Copy Previous Day / Group [S19] | ✅ copy-paste [S1] | ✅ | ✅ | ⚠️ reported bugs | ⚠️ | ✅ | ? | ? | ? |
| **Recents / favourites** | ✅ | ✅ | ✅ smart history | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ |
| **Quick-add kcal/macros** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ? |
| **Micronutrients** | ⚠️ limited | ✅ 80+ free, 95+ listed | ✅ | 💰 | 💰 | ⚠️ | ⚠️ | 💰 | ❌ | ✅ 100+ | 💰 |
| **Adaptive targets (TDEE)** | ❌ | ❌ | ✅ core | ❌ | ❌ | ❌ | ❌ | ❌ (prediction only) | ⚠️ adjusts from Health (1 review) | ⚠️ | ❌ |
| **AI photo** | 💰 | 💰 (2025) | ✅ (DB-mapped) | 💰 | 💰 | ✅ | ✅ / 💰 | ✅ | 💰 core | ✅ core | 💰 core |
| **Voice / free text** | 💰 | 💰 | ✅ text + photo | 💰 | ? | ✅ | ? | 💰 | ? | ✅ | ? |
| **Apple Health: write food** | ✅ no caffeine, no timestamps [S16] | ✅ | ✅ | 💰 listed | ✅ [S24] | ✅ | ✅ full detail | ✅ daily, 5 fields [S25] | ? | ✅ | ✅ |
| **Apple Health: read food from others** | ❌ [S16] | ? | ✅ [S9] | ? | ? | ? | ? | ? | ? | ? | ? |
| **Free tier** | ⚠️ shrinking | ✅ strong, with ads | ❌ 7-day trial | ⚠️ shrinking | ⚠️ ads, nags | ⚠️ | ✅ strongest | ✅ | ❌ | ⚠️ | ⚠️ |
| **Paid, per year (US)** | $79.99 | $59.99 | $71.99 | $39.99–79.99 | $23.90–47.90 | €44.99–99.99 (BE) | $59.99 | €31.99–60.99 (BE) | ? | $39.99–149 | €? (BE) |
| **Rating (count)** | 4.71 (2.4M) | 4.77 (99k) | 4.84 (23k) | 4.77 (779k) | 4.70 (51k) | 4.65 (151k) | 4.73 (15k) | 4.82 (735k) | 4.80 (367k) | 4.73 (6.7k) | 4.59 (17.6k) |
| **Recent-review sentiment, % 4–5★** [S3] | 41% | 71% | 61% | 60% | 28% | 25% | 47% | 73% | 31% | 98%⚠️ | 68% |

Ratings are from [S1]; prices are from [S2].

### Taps per repeat meal
The source is MF's Food Logging Speed Index (FLSI) 2025 [S5]. It is vendor-run, so apply a bias caveat. Lower is better.

| Task | MF | Lose It | MyNetDiary | MFP | Cronometer | Lifesum | FatSecret | Yazio |
|---|---|---|---|---|---|---|---|---|
| Search-log a food with a custom serving | 10 | 13 | 11 | 15 | not in "strong" tier | — | — | 16 |
| **Multi-add previously logged foods** (the repeat meal) | **6** | 7 | 7 | "weak" tier | not in "strong" tier | 8 | 8 | — |
| Barcode with a custom portion | 5 | 7 | 7 | 7 | 7 | — | 8 | — |
| Quick-add calories | 3 | 5 | 5 | 5 | 7 | 7 | — | — |
| **Total** | **24** | | | 36 [S6] | 40 [S7] | | | |

Two estimates of our own (not measured on devices):
- a **copy-yesterday** action is 2–3 taps in Cronometer (diary menu → Copy Previous Day) [S19];
- in MFP it is 4+ taps (Edit → tick items → Copy → pick date) [S15].

**Nobody in the market reaches ≤3 taps for a repeat meal from a cold open.** The best benchmarked repeat flow is 6 actions. That makes the RunCoach target of ≤3 taps (WS4) a real differentiator.

---

## 3. MacroFactor's expenditure algorithm: how it works

**Principle:** energy balance, solved backwards.

> Calories in − change in stored energy = calories out [S4].

Expenditure is **measured from the user's own data, not predicted from formulas or wearables**. The listing and the articles describe only intake and weight as inputs [S4][S29].

| Step | What MF does | Source |
|---|---|---|
| 1. Cold start | An initial estimate from the **Cunningham equation** (lean-mass based BMR), with separate multipliers for daily-life activity and purposeful exercise. MF says openly that this first guess is imprecise | [S29] |
| 2. Weight trend | Scale weight is smoothed into a **trend weight** that weights recent weigh-ins more heavily. The goal is to ignore water, sodium and gut-content noise without lagging on real trends | [S29] |
| 3. Solve for TDEE | TDEE ≈ mean(logged intake) − ρ·Δ(trend weight)/Δt over a **21-day nutrition window**. ρ is the energy density of the tissue gained or lost. V3 made ρ **symmetric for gain and loss**, which lowered estimates by about 0–130 kcal/day for most users. MF does not publish the constant | [S4][S31] |
| 4. Missing data | **Empty days are excluded.** V3 tolerates about 3× more missing data than V2. Updates pause only when **more than 3 of 7 days** lack nutrition data. Unlogged days are imputed to within about 15–20% | [S4][S32] |
| 5. Partial days (the real enemy) | A day with only part of the food logged looks like under-eating and biases TDEE downward for about 3 weeks. A "Partial Logging" coaching module flags suspect days so they can be excluded. MF recommends quick-adding a rough estimate, and says ±30% is good enough (for example, 2,100–3,900 kcal when the truth was 3,000) | [S31][S33] |
| 6. Weekly check-in | Targets are recomputed from **what actually happened, not what was prescribed.** If you ate 2,600 kcal against a 2,500 target and still hit your rate of change, the new target is about 2,600. Stabilisation takes around 14–30 days | [S29] |
| 7. V3 vs V2 | Picks up trend reversals 1–5 days earlier, about 35% smaller day-to-day swings, about 10% more accurate, more robust to "whoosh" water shifts | [S4] |
| 8. Philosophy | **Adherence-neutral:** no red numbers, no warnings, and going over target is not "bad". The rationale is that shame drives under-reporting, which corrupts the algorithm | [S29] |

**What this means for RunCoach:**
- RunCoach already has *measured* expenditure: Apple active plus basal energy.
- An MF-style intake-and-trend estimate is therefore an **independent cross-check** rather than the only source.
- A persistent gap between the two reveals either **under-logging** (MF's partial-day problem) or **watch over- or under-estimation**.
- Minimum inputs are intake plus regular weigh-ins. Biology mode already has weight.
- Import MF's partial-day handling (flag or exclude, or quick-add an estimate) and its no-shame UI.

---

## 4. The 10 things that make logging stick

1. **Repeat meals must be nearly free.** Frequency of logging, not time spent, predicts success.
   - Participants who lost ≥5% or ≥10% opened their journal 2.4–2.7 times a day, versus 1.6–1.7 for the rest.
   - Time spent fell from 23.2 to 14.6 min/day between months 1 and 6 [S22].
   - Daily engagement was the top predictor of ≥5% weight loss in 1,359 MFP users [S23].
   - For RunCoach: recents, one-tap "same as yesterday's breakfast" and multi-add (FLSI repeat benchmark: 6–8 actions [S5]).
2. **Never paywall or break the core loop** (search, barcode, recents, copy). Paywall and price is the #1 low-star theme in 8 of 11 apps: MFP 36/70, Lifesum 60/122, Cal AI 35/61 [S3]. The barcode lock-ins at MFP and Lose It are still being reviewed years later [S3][S10].
3. **Trustworthy, visible data provenance.**
   - Crowd databases under-estimate by 7–41% on some nutrients [S20] and need outlier cleaning [S21].
   - Cronometer's and MF's verified sources are their most-praised traits.
   - Users are furious when a wrong "verified" entry cannot be fixed (Lifesum, MF) [S3].
   - For RunCoach: show the source badge (NEVO, CIQUAL, USDA, OFF) and let users correct entries locally.
4. **AI should accelerate, not replace.** Map photo or text to real database items, show them, make grams editable, and let users skip AI entirely.
   - MF and Cronometer do this [S8][S18].
   - Opaque or forced AI is the most-hated pattern: MFP "forced AI", Lifesum "AI slop", Cal AI under-counting [S3].
   - This matches RunCoach's rule that the app must work keyless.
5. **No shame.** Use neutral colours, no streak-guilt and no "over budget" red [S29]. Complaint in the sample: "Don't like being notified of breaking streaks… makes me not want to use the program" (Cal AI) [S3].
6. **Tolerate imperfect logging.** Provide quick-add calories and macros, a "partial day" flag, and empty days that are excluded rather than counted as zero [S31][S33]. Otherwise one lazy dinner corrupts three weeks of energy-balance maths.
7. **Pay the user back.** Logging has to feed something they care about: MF's adaptive expenditure is its most-cited reason to pay [S3]. For RunCoach the payback is coach hooks: fuelling for long runs, carbs before quality sessions, sodium and fluids for a heavy sweater, and energy availability.
8. **Stability and data safety.** The sharpest single-review anger comes from updates:
   - Cronometer's Sept-2026 update lost favourites and recipes;
   - FatSecret's search broke;
   - MFP's redesign drew "ruined by the app redesign" [S3].
   - For RunCoach: local-first storage covered by `backup.ts`, with favourites and recipes treated as precious user data.
9. **Zero-friction start.** Long onboarding quizzes before first use drive deletion: Yazio's "just wanna start. Deleted it" and Cal AI's 30-minute setup that ends at a paywall [S3]. RunCoach already knows weight, activity and goals from HealthKit, so it should skip the quiz.
10. **Local relevance and one source of truth.**
    - Belgian and EU products and generics are the main gap for US-built databases. Yazio's EU strength and Evenepoel's NUBEL comparison both show this [S21][S1].
    - Write to Apple Health with timestamps (MFP does not [S16]) and avoid double counting when another app also writes food. MF is the only incumbent that reads other apps' food from Health [S9].

---

## 5. Recommendation (WS1 view)

**Build the MacroFactor model, not the Cal AI model, and make it free and local.**

1. **Logger first.** Target ≤3 taps for a repeat meal: suggestion chips for "same as yesterday or last <weekday>", recents and favourites, multi-add, and quick-add. That already beats the best benchmarked 6 actions [S5].
2. **Database-backed truth.**
   - Lab tables (NEVO, CIQUAL, USDA) for generics.
   - Open Food Facts for Belgian barcodes, with ODbL attribution exactly as MF does [S1]. The licence details are WS2's.
   - Show the source on every entry.
3. **Optional AI** only when a key is present. The LLM names items and grams, the database supplies nutrients, and the user confirms, following MF and Cronometer. Never forced, never opaque.
4. **Adherence-neutral energy balance.** Compare Apple-measured TDEE with an MF-style intake-and-trend-weight estimate. Handle partial days and exclude empty ones. Use no red or shame UI.
5. **Differentiate on running.** No incumbent links intake to training load. Fuelling and sodium hooks for long, hot, interval sessions are the "pay the user back" loop (item 7 above).

**Avoid:**
- paywall-style gating;
- long onboarding;
- AI-only portion estimates for energy balance (Cal AI-style under-counting would bias the TDEE cross-check);
- a crowd-sourced database without outlier limits (Evenepoel's per-portion caps, e.g. 1,500 kcal and 3,600 mg sodium, are a ready-made sanity filter [S21]).

---

## Sources

- **[S1]** Apple iTunes Lookup/Search API, app metadata and descriptions (pulled 2026-09-28): https://itunes.apple.com/lookup?id=341232718 (MFP) · 1145935738 (Cronometer) · 1553503471 (MacroFactor) · 297368629 (Lose It) · 946099227 (Yazio) · 286906691 (Lifesum) · 347184248 (FatSecret) · 410089731 (Carb Manager) · 6480417616 (Cal AI) · 1574239307 (SnapCalorie) · 1064020872 (Foodvisor)
- **[S2]** App Store product pages, IAP price lists for the US and BE storefronts, e.g. https://apps.apple.com/us/app/id341232718 and https://apps.apple.com/be/app/id1553503471 (same pattern for each ID in S1)
- **[S3]** Apple customer-review RSS feed, most recent, US storefront, e.g. https://itunes.apple.com/us/rss/customerreviews/page=1/id=341232718/sortby=mostrecent/json (pages 1–5 per app ID; 1,850 reviews; raw data in the session scratchpad `nutrition/reviews/`)
- **[S4]** MacroFactor, "An In-Depth Look at MacroFactor's New V3 Expenditure Algorithm": https://macrofactor.com/expenditure-v3/
- **[S5]** MacroFactor, "Is MacroFactor Still the Fastest Food Logger? (2025 FLSI Update)": https://macrofactorapp.com/fastest-food-logger-2025/
- **[S6]** MacroFactor, "MacroFactor vs. MyFitnessPal (2025)": https://macrofactor.com/macrofactor-vs-myfitnesspal-2025/
- **[S7]** MacroFactor, "MacroFactor vs Cronometer": https://macrofactor.com/macrofactor-vs-cronometer/
- **[S8]** MacroFactor, "AI-Powered Food Logging Comes to MacroFactor": https://macrofactor.com/ai-food-logging/ · Help: https://help.macrofactorapp.com/en/articles/258-ai-food-logging
- **[S9]** MacroFactor, "Bidirectional integrations…" (Aug 2024): https://macrofactor.com/mm-august-2024/ · Help: https://help.macrofactorapp.com/en/articles/102-integrations
- **[S10]** XDA Developers, "MyFitnessPal's barcode scanner will only be available to Premium users": https://www.xda-developers.com/myfitnesspals-barcode-scanner-behind-a-paywall/
- **[S11]** MyFitnessPal Help, "What are the features of MyFitnessPal Premium?": https://support.myfitnesspal.com/hc/en-us/articles/360032625951-What-are-the-features-of-MyFitnessPal-Premium
- **[S12]** The Nutrition Magazine, "The MyFitnessPal Paywall Changes, Explained" (May-2026 changes): https://thenutritionmagazine.com/articles/myfitnesspal-paywall-changes-explained/
- **[S13]** MyFitnessPal Community, "Why is the barcode scan behind premium?": https://community.myfitnesspal.com/en/discussion/10939125/why-is-the-barcode-scan-behind-premium
- **[S14]** Cronometer Community forum, "copying one day to another": https://forums.cronometer.com/discussion/1855/copying-one-day-to-another
- **[S15]** MyFitnessPal Help, "How do I copy a meal from one day to another?": https://support.myfitnesspal.com/hc/en-us/articles/360032622131-How-do-I-copy-a-meal-from-one-day-to-another
- **[S16]** MyFitnessPal Help, "Apple Health connection and syncing": https://support.myfitnesspal.com/hc/en-us/articles/360032271092-Apple-Health-FAQ-and-Troubleshooting
- **[S17]** Cronometer Support, "Data Sources": https://support.cronometer.com/hc/en-us/articles/360018239472-Data-Sources
- **[S18]** PR Newswire, "Cronometer Launches Premium Photo Logging" (Sep 2025): https://www.prnewswire.com/news-releases/cronometer-launches-premium-photo-logging-fast-verified-nutrition-tracking-for-real-life-302549752.html · Help: https://support.cronometer.com/hc/en-us/articles/39013533811092-Mobile-Photo-Logging
- **[S19]** Cronometer Support, "Mobile – Copy & Paste": https://support.cronometer.com/hc/en-us/articles/360018695932-Mobile-Copy-Paste
- **[S20]** Griffiths C, Harnack L, Pereira MA. "Assessment of the accuracy of nutrient calculations of five popular nutrition tracking applications." *Public Health Nutr* 2018: https://www.cambridge.org/core/journals/public-health-nutrition/article/assessment-of-the-accuracy-of-nutrient-calculations-of-five-popular-nutrition-tracking-applications/456D6CB0961D86CBEA2E868C52DF7ABF
- **[S21]** Evenepoel C et al. (KU Leuven). "Accuracy of Nutrient Calculations Using the Consumer-Focused Online App MyFitnessPal: Validation Study." *JMIR* 2020;22(10):e18237: https://pubmed.ncbi.nlm.nih.gov/33084583/
- **[S22]** Harvey J et al. "Log Often, Lose More: Electronic Dietary Self-Monitoring for Weight Loss." *Obesity* 2019;27(3):380-384: https://pubmed.ncbi.nlm.nih.gov/30801989/
- **[S23]** Wang B et al. "Weight Loss Outcomes Among MyFitnessPal Users: Behavioral and Dietary Predictors of Success." *Nutrients* 2026;18(11):1766 (part-funded by MFP): https://pubmed.ncbi.nlm.nih.gov/42280408/
- **[S24]** Yazio Help Center, "Yazio and Apple Health": https://help.yazio.com/hc/en-us/articles/360018833998-Yazio-and-Apple-Health
- **[S25]** Carb Manager Help, "Sync wellness data between Apple Health/Apple Watch and Carb Manager": https://help.carbmanager.com/docs/sync-wellness-data-between-apple-healthapple-watch-and-carb-manager
- **[S26]** TechCrunch, "SnapCalorie taps AI to estimate the caloric content of food from photos" (2023): https://techcrunch.com/2023/06/26/snapcalorie-computer-vision-health-app-raises-3m/
- **[S27]** Thames Q et al. "Nutrition5k: Towards Automatic Nutritional Understanding of Generic Food." CVPR 2021: https://arxiv.org/abs/2103.03375
- **[S28]** TechCrunch, "Foodvisor raises $4.5 million to track what you eat using AI" (2019): https://techcrunch.com/2019/11/28/foodvisor-raises-4-5-million-to-track-what-you-eat-using-ai
- **[S29]** Stronger By Science, "MacroFactor's Algorithms and Core Philosophy": https://www.strongerbyscience.com/macrofactor-algorithms-philosophy/
- **[S30]** TechCrunch, "MyFitnessPal has acquired Cal AI…" (2026-03-02): https://techcrunch.com/2026/03/02/myfitnesspal-has-acquired-cal-ai-the-viral-calorie-app-built-by-teens/ · GlobeNewswire: https://www.globenewswire.com/news-release/2026/03/02/3247439/0/en/MyFitnessPal-Acquires-Cal-AI-Expanding-on-its-Position-as-the-Leading-Player-in-Digital-Nutrition-Tracking.html
- **[S31]** MacroFactor Help, "What Is Partial Logging?": https://help.macrofactorapp.com/en/articles/241-what-is-partial-logging · "How Do MacroFactor's Coaching Algorithms Deal with Partially Logged Days?": https://help.macrofactorapp.com/en/articles/29-how-do-macrofactor-s-coaching-algorithms-deal-with-partially-logged-days
- **[S32]** MacroFactor Help, "Expenditure": https://help.macrofactorapp.com/en/articles/20-expenditure
- **[S33]** MacroFactor Help, "Coaching Module: Partial Logging": https://help.macrofactorapp.com/en/articles/248-coaching-module-partial-logging
