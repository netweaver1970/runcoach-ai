# WS5: Integration with RunCoach

**Workstream:** 5 (brief §Workstreams 5) · **Date:** 2026-09-28 · **Status:** research complete, no code changed
**Scope:** HealthKit read/write + de-dup, energy balance, coach hooks, Biology link, supplements/labs, `appModel.ts`, data model + storage + `backup.ts`, `app/food.tsx`.
**Inputs read:** `src/services/healthkit.ts`, `supplements.ts`, `appModel.ts`, `backup.ts`, `biology.ts`, `labsStore.ts`, `coach.ts` (types), `weather.ts`, `cloudSync.ts`, `app/food.tsx`, `app.json`, `node_modules/@kingstinct/react-native-healthkit` **v9.0.11** (specs, types, Swift).

---

## 0. TL;DR

| # | Finding | Consequence |
|---|---|---|
| 1 | The installed HK lib (v9.0.11) already exposes **every `Dietary*` quantity type** plus `DietaryWater` and the `HKCorrelationTypeIdentifierFood` correlation, with `saveQuantitySample`, `saveCorrelationSample`, `deleteObjects`, `querySources`. | Nutrition read/write needs **no new native module**. It is JS only and ships by OTA. The one exception is the `NSHealthUpdateUsageDescription` text in `app.json`, which needs a native build before any App Store or TestFlight review. |
| 2 | The lib's sample filter supports uuid / uuids / metadata-key-exists / date / workout. **It has no source predicate.** `separateBySource` is accepted as an option, but the per-source result is not returned. | Source de-dup = raw `queryQuantitySamples` + client-side grouping on `sourceRevision.source.bundleIdentifier`. That is cheap, because dietary samples number in the tens per day. |
| 3 | Apple docs: statistics queries "automatically merge the data from all of your data sources". MyFitnessPal writes **meal summaries without timestamps**. | Summing HK dietary energy can double-count, and HK cannot show meal *timing* from MFP. **Rule: one intake source per day, never a sum.** |
| 4 | This app **hard-crashed** writing `HKMetadataKeySyncIdentifier/Version` (commit `47d8549`, Labs mirror). Apple forbids correlation types in auth requests. | Tag writes with `HKExternalUUID` = entry id. Edit = delete-by-uuid + rewrite. Authorise only the component quantity types. **Run a 1-sample device spike before building** (native exceptions can't be caught in JS). |
| 5 | Watch energy estimates are imprecise: no wrist device reached <20 % EE error in Shcherbina 2017. MacroFactor-style adaptive TDEE reaches a median error of ~135 kcal after 3–4 weeks (vendor-reported). | Show **both** the watch TDEE (active + basal, already fetched) and an **adaptive TDEE** (intake vs trend weight). The adaptive one takes over once there is enough data. |
| 6 | All fuelling and hydration guidance maps to **deterministic** formulas: ACSM 2016 g/kg tables, sweat-rate weighing, ISSN caffeine, EFSA caps. They key off data the coach already has (`CoachPlan.sessionKind`, `runMinutes`, `secondSession`, `apparentC`, heat sensitivity, body mass). | Coach hooks work **keyless**. The LLM only phrases them. |

**Recommendation:** RunCoach becomes the **logger and source of truth** for intake. Writing to Apple Health is **opt-in**. Reading from HK is a **fallback importer**, used only for days with no local entries. Nutrition stays **advisory**: it never mutates the training plan in v1, only cautions and fuelling cards.

---

## 1. What exists today (code facts)

| Area | Today | Reuse for nutrition |
|---|---|---|
| Energy out | `fetchDailyActiveEnergy()` (`HKQuantityTypeIdentifierActiveEnergyBurned`, daily `cumulativeSum`). Basal comes through `dailyCumulativeSum(basalEnergyBurned)`. `computeDailyComponents` already emits `totalEnergy` per day. | Energy balance needs no new HK expenditure query |
| Per-run energy | `RunWorkout.calories` = `totalEnergyBurned` of the HKWorkout | Exercise energy expenditure (EEE) for energy availability |
| Body comp | `fetchBodyMassHistory / fetchBodyFatHistory / fetchLeanBodyMassHistory` (Biology), `resolveBodyMassKg()`, SecureStore `body_mass_kg` | g/kg targets, trend weight, fat-free mass (FFM) |
| HK writes | `mirrorLabsToHealth()` writes weight, glucose and the BP correlation, with `NO_META` (sync keys removed after the crash) | Same write path and lessons |
| Lazy auth | `requestBiologyPermissions()` asks only when Biology opens, never in the hot `requestPermissions()` path. `requestLabsWriteAuth()` re-affirms **read with write** (an empty read list blanked the Biology charts). | Same pattern: `requestNutritionPermissions()` on first Food-mode use |
| Supplements | `runcoach-supplements.json`: list + per-date log + optional mg doses. `hrOffsetByDay()` adds `COFFEE_BPM = 2` **only on yohimbine days**. `buildSupplementContext()` produces a compact LLM line. | Caffeine mg becomes real data (§7) |
| Labs | `runcoach-labs.json`. `fasting glucose` maps to `HKQuantityTypeIdentifierBloodGlucose` (read in Biology auth, unioned into Labs) | Glucose context (§7) |
| LLM context | `buildAppModelPrompt()` (rules, rides on every call). `buildSupplementContext()` (data, per call site) | Add 2 rule lines + a `buildNutritionContext()` data line (§8) |
| Backup | Allowlisted `FILES` + `FILE_PREFIXES` + `STATIC_SECURE_KEYS`; caches excluded; path-traversal guard | Add food log shards + library + settings (§10) |
| Cloud | `cloudSync.ts` pushes only runs + daily metrics | Food log must **stay out** of cloud sync (privacy rule) |
| Screen | `app/food.tsx`: 44-line static placeholder, reached from ☰ Modes → Food (`app/index.tsx:1029`) | Rebuild (§11) |
| Bundle ids | `com.netweaver1970.runcoachai` (+ `.watch`) | Own-source exclusion on read |

---

## 2. HealthKit mapping (read + write)

Units are HKUnit strings as accepted by the lib (`kcal`, `g`, `mg`, `mcg`, `mL`). All identifiers below are present in `src/types/QuantityTypeIdentifier.ts` of the installed lib. **Tier** = the release that should write it (A = MVP, B = v1, C = ambitious).

| Nutrient | HK identifier | Unit | Write | Read | Tier | Notes |
|---|---|---|---|---|---|---|
| Energy | `HKQuantityTypeIdentifierDietaryEnergyConsumed` | kcal | ✅ | ✅ | A | Apple: every food correlation "should include at least" an energy sample ([HKCorrelation](https://developer.apple.com/documentation/healthkit/hkcorrelation)) |
| Protein | `…DietaryProtein` | g | ✅ | ✅ | A | |
| Carbohydrate | `…DietaryCarbohydrates` | g | ✅ | ✅ | A | **Convention clash:** EU labels declare carbohydrate *excluding* fibre ([EU 1169/2011 Annex I](https://www.legislation.gov.uk/eur/2011/1169/annex/I)). USDA "carbohydrate by difference" *includes* total dietary fibre ([USDA SR28 doc](https://www.ars.usda.gov/arsuserfiles/80400525/data/sr/sr28/sr28_doc.pdf)). Store **available carbs** internally (USDA: total − fibre). Write that value and write fibre separately. |
| Fat (total) | `…DietaryFatTotal` | g | ✅ | ✅ | A | |
| Saturated fat | `…DietaryFatSaturated` | g | ✅ | ✅ | B | On every EU label |
| Fibre | `…DietaryFiber` | g | ✅ | ✅ | B | |
| Sugar | `…DietarySugar` | g | ✅ | ✅ | B | |
| Sodium | `…DietarySodium` | mg | ✅ | ✅ | B (A if heat hooks ship) | EU labels give **salt**; convert sodium = salt ÷ 2.5 ([Annex I](https://www.legislation.gov.uk/eur/2011/1169/annex/I)) |
| Potassium | `…DietaryPotassium` | mg | ✅ | ✅ | C | Rarely on EU labels; mostly from generic tables (WS2) |
| Water | `…DietaryWater` | mL | ✅ | ✅ | B | Written as **standalone** samples (drinks, bottles on runs), not inside food correlations |
| Caffeine | `…DietaryCaffeine` | mg | ✅ | ✅ | B | Sources: coffee/tea entries + caffeine supplements (§7). MFP does **not** sync caffeine ([MFP help](https://support.myfitnesspal.com/hc/en-us/articles/360032271092-Apple-Health-FAQ-and-Troubleshooting)) |
| Mono/poly fat, cholesterol | `…DietaryFatMonounsaturated/Polyunsaturated`, `…DietaryCholesterol` | g / mg | ✅ | ✅ | C | Only when the DB supplies them |
| Vitamins / minerals (Ca, Fe, Mg, Zn, D, B12, folate, …) | `…DietaryIron`, `…DietaryVitaminD`, … (≈30 types in lib) | mg / mcg | ✅ | ✅ | C | Only from micronutrient-complete tables (WS2). Relevant to Labs (ferritin, vit D, B12) |
| Alcohol | `HKQuantityTypeIdentifierNumberOfAlcoholicBeverages` | count | optional | ✅ | C | Energy counted via kcal (7 kcal/g, [Annex XIV](https://www.legislation.gov.uk/eur/2011/1169/annex/XIV)) |
| Meal grouping | `HKCorrelationTypeIdentifierFood` + metadata `HKFoodType` (food name) | n/a | ✅ | via components | A | "Food correlation types combine any number of nutritional samples into a single food object" ([Apple](https://developer.apple.com/documentation/healthkit/hkcorrelationtypeidentifier/food)). Lib: `saveCorrelationSample('HKCorrelationTypeIdentifierFood', samples, start, end, metadata)` |
| Glucose (read only) | `HKQuantityTypeIdentifierBloodGlucose` | mg/dL | (Labs only) | ✅ already | B | Already in `requestBiologyPermissions()` |

### 2.1 Write pattern

1. **One HK food correlation per `FoodEntry`**, stamped at the entry's real time (start = end = `entry.at`). It carries `HKFoodType = entry.name`, and one child quantity sample per nutrient we have (energy always). Water is written as separate `DietaryWater` samples.
2. **Metadata:** `{ HKExternalUUID: entry.id, HKWasUserEntered: true }` on the correlation and on every child. `HKExternalUUID` is documented as "a unique identifier for an HKObject that is set by its source" ([Apple](https://developer.apple.com/documentation/healthkit/hkmetadatakeyexternaluuid)). Apple allows custom keys on correlations too ([HKCorrelation](https://developer.apple.com/documentation/healthkit/hkcorrelation)).
3. **Do NOT use `HKMetadataKeySyncIdentifier/SyncVersion`** until proven on device. Apple requires the pair together ([SyncIdentifier](https://developer.apple.com/documentation/healthkit/hkmetadatakeysyncidentifier), [SyncVersion](https://developer.apple.com/documentation/healthkit/hkmetadatakeysyncversion)). This app already sent the pair once, from JS (as a JS number, so a `Double`), and got an uncatchable `NSException` (commit `47d8549`). That commit changed two things at once, so the root cause is not isolated.
4. **Edit or delete an entry:** `queryQuantitySamples(type, { filter: { AND: [{ startDate, endDate }, { withMetadataKey: 'HKExternalUUID' }] } })`. Keep only samples whose `metadata.HKExternalUUID === entry.id` **and** whose source bundle is ours. Call `deleteObjects(type, { uuids })` per nutrient type, then rewrite. `saveQuantitySample` returns only a boolean, not a UUID, so we cannot store HK uuids at write time.
5. **Queue + retry:** writes are fire-and-forget from the log. Record per-entry `hk.synced`. Retry unsynced entries on Food-mode open (as with the Labs mirror, skipped writes are counted, never thrown).

### 2.2 Authorisation

- New `requestNutritionPermissions()` runs **only** when the user turns on "Sync to Apple Health" or "Import from Apple Health" in Food settings. That mirrors `requestBiologyPermissions()` and keeps it off the run-start path.
- Request **read + write on the same quantity list** (the Labs lesson: an empty read list disturbed existing grants).
- **Never include `HKCorrelationTypeIdentifierFood` in the request.** HealthKit rejects correlation types in auth with *"Authorization to share the following types is disallowed"* ([EddyVerbruggen/HealthKit#106](https://github.com/EddyVerbruggen/HealthKit/issues/106), [Apple forum 694311](https://forums.developer.apple.com/forums/thread/694311)). Authorise the components instead; Apple says correlation types are used to "request permission to read or write matching quantity samples" ([HKCorrelationType](https://developer.apple.com/documentation/healthkit/hkcorrelationtype)).
- Read denial is invisible: "it simply appears as if there is no data" ([Apple](https://developer.apple.com/documentation/healthkit/hkhealthstore/authorizationstatus(for:))). The import UI must say "no nutrition found (or access off)".
- `NSHealthUpdateUsageDescription` currently mentions only workouts and labs. Add "food and drink you log". This is an `app.json` change, so it needs prebuild + a native build. The runtime request itself works without it, but App Review would flag the mismatch.

### 2.3 De-dup strategy (the core rule)

| Case | Risk | Rule |
|---|---|---|
| RunCoach reads back its own writes | Intake counted twice | On every HK dietary read, **drop samples whose `sourceRevision.source.bundleIdentifier` starts with `com.netweaver1970.runcoachai`** |
| Another app (MFP, Cronometer, MacroFactor, Lose It!) also logs | Two logs of the same lunch, at *different* timestamps | **One intake source per day, never a sum.** If the local log has ≥1 entry that day, it wins and HK dietary data for that day is ignored. Otherwise use the user-chosen external source (`querySources()` lists candidates). With several external sources, use the chosen priority, not a total. |
| Relying on `cumulativeSum` statistics | Apple merges sources "automatically" ([HKStatistics](https://developer.apple.com/documentation/healthkit/hkstatistics)), but how that merge treats non-overlapping dietary samples from different apps is undocumented. Health's own priority list is user-ordered ([Apple Support](https://support.apple.com/en-us/108779)). | **Don't use statistics for intake.** Use raw samples and group by source and local day (4 am attribution, as in the rest of the app). |
| Imported data has no meal time | MFP: "Timestamps do not sync" ([MFP help](https://support.myfitnesspal.com/hc/en-us/articles/360032271092-Apple-Health-FAQ-and-Troubleshooting)) | Imported days feed **daily totals only** (energy balance, Biology). Timing hooks (pre-run carbs) need the local log. |
| Water / caffeine | Same double-count risk | Resolve per type with the same per-day source rule |

Setting: `intakeSource: 'runcoach' | 'auto' | { bundleId }`. The default is `'auto'` = local first, then the single external source, else ask.

---

## 3. Energy balance

### 3.1 Two expenditure estimates, shown side by side

| | Watch TDEE | Adaptive TDEE |
|---|---|---|
| Formula | `active + basal` per day (already computed as `totalEnergy`) | `mean(intake) − Δtrend_weight × ρ / days`, over a 21–28-day window |
| Needs | Watch worn | ≥ 21 days, ≥ 80 % of days marked *complete*, ≥ 8 weigh-ins in the window |
| Weakness | Wrist EE error: no device <20 % in the lab ([Shcherbina 2017](https://www.mdpi.com/2075-4426/7/2/3)) | ρ ≈ 7700 kcal/kg is a simplification; the deficit per kg varies with body fat ([Hall 2008](https://pubmed.ncbi.nlm.nih.gov/17848938/)). Logging gaps bias it. |
| Precedent | Apple, Bevel | MacroFactor: TDEE from intake vs weight trend, median error ~135 kcal after 3–4 weeks vs ~335 for formulas (vendor study, [MacroFactor](https://macrofactor.com/algorithm-accuracy/); [help](https://help.macrofactorapp.com/en/articles/20-expenditure)) |

- **Trend weight:** EWMA of HK body mass (daily grid, forward-fill ≤ 7 days, the same staleness idea as `biology.ts`).
- **Calibration factor** `k = adaptive / watch`, clamped 0.8–1.2 and persisted (like `bodybattery-calibration.json`). After calibration, today's budget = `k × (active + basal)`. This keeps a same-day, training-aware number while respecting the long-run truth.
- **Completeness gate:** a day enters the adaptive fit only if the user ticks "day complete" (or, in auto mode, logged kcal ≥ 0.6 × basal). A partial day is never treated as a deficit.

### 3.2 Energy availability (REDs guard)

- `EA = (intake − EEE) / FFM`. EEE = Σ `RunWorkout.calories` (+ other workouts) that day. FFM comes from HK lean body mass or `weight × (1 − BF%)`.
- EA < 30 kcal/kg FFM/day perturbs many body systems. 30–40 is "adaptable" short-term LEA ([IOC REDs 2023](https://stillmed.olympics.com/media/Documents/Athletes/Medical-Scientific/Consensus-Statements/REDs/BJSM-IOC-consensus-statement-on-Relative-Energy-Deficiency-in-Sport-REDs.pdf); [summary](https://pinesnutrition.org/2023-ioc-consensus-statement-on-reds-whats-new/)).
- Hook: EA < 30 on ≥ 3 of the last 7 *complete* days → a coach **caution** ("fuel before adding volume"). It is not a diagnosis and does not auto-change the plan.

### 3.3 Effect on training (advisory, conservative)

| Signal | Coach action (v1 = text only) |
|---|---|
| 7-day balance < −750 kcal/d **and** build week | Caution in `CoachPlan.cautions`; recommend not stacking a deficit on quality days |
| Weight-loss goal (Geert carries central weight) | "Periodise the deficit": target ≈ maintenance on long-run and quality days, deficit on easy and rest days. This is a design choice consistent with the ACSM view that fuel should match the session's demands ([ACSM 2016](https://pubmed.ncbi.nlm.nih.gov/26891166/)); flag it for Geert's decision. |
| Low carbs the day before a quality session | Pre-session card (§4) |

---

## 4. Coach hooks (deterministic; the LLM only phrases them)

Body mass comes from `resolveBodyMassKg()`. Session type comes from `CoachPlan.sessionKind` / `WeekPlanDay.kind`, duration from `runMinutes`, heat from `getMorningForecast()` `apparentC` × `getHeatSensitivity()`.

| Hook | Trigger | Recommendation (numbers) | Source |
|---|---|---|---|
| Daily carb target | Every day, from the planned load | Light/skill: 3–5 g/kg/d · ~1 h/d moderate: 5–7 · 1–3 h/d mod-high: 6–10 | [ACSM 2016](http://drugfreesport.org.za/wp-content/uploads/2018/04/Position-stand-on-Nutrition-Athletic-Performance-ACSM-2016-1.pdf) Table |
| Pre-quality fuel | `sessionKind ∈ {intervals, tempo}` or `long` > 60 min | 1–4 g/kg, 1–4 h before. For Geert's early runs, a practical default of **~1 g/kg 1–2 h before**, low fibre/fat | ACSM 2016 (pre-event > 60 min) |
| Easy/short runs | `easy`/`recovery`, < 45 min | Fuel **not needed**. ACSM also allows deliberate low-carbohydrate-availability training, so no nagging | ACSM 2016 (< 45 min "not needed") |
| During: 45–75 min hard | quality 45–75 min | Small amounts / mouth rinse | ACSM 2016 |
| During: long run | `long` 1–2.5 h | **30–60 g/h**. Tell him at plan time: "take N gels / X g". | ACSM 2016 |
| During: > 2.5 h | race mode / long > 150 min | Up to **90 g/h**, multiple transportable carbs (glucose:fructose) | ACSM 2016 |
| Split long run refuel | `secondSession` present (gap `earliestAfterHrs`) | < 8 h between sessions: **1–1.2 g/kg/h for the first 4 h** | ACSM 2016 ("speedy refuelling") |
| Protein | Daily + post-run | 1.2–2.0 g/kg/d; ~0.3 g/kg per meal/post-session | ACSM 2016 |
| Hydration plan | Every run ≥ 45 min, scaled by heat | Keep the deficit **< 2 % body mass**. Typical intake 0.4–0.8 L/h, **customised by sweat rate**. 1 kg lost ≈ 1 L sweat. | ACSM 2016; [ACSM fluid 2007](https://pubmed.ncbi.nlm.nih.gov/17277604/) |
| Sweat-rate test | Prompt on 2–3 runs at different temps | `(pre_kg − post_kg + fluid_L − urine_L) / hours`. Store per `apparentC` band and fit rate vs temp. Endurance athletes average **1.28 ± 0.57 L/h** ([GSSI normative, n = 1303](https://www.gssiweb.org/research/article/normative-data-for-sweating-rate-sweat-sodium-concentration-and-sweat-sodium-loss-in-athletes-an-update-and-analysis-by-sport)) | ACSM 2016 |
| Electrolytes | Sweat rate > 1.2 L/h, or salty sweat, or > 2 h | Take sodium during exercise. Average sweat Na ≈ 50 mmol/L (~1 g/L) → a heat-day card: "~X mg sodium/h". Methodology caveats: [Baker 2017](https://link.springer.com/article/10.1007/s40279-017-0691-5) | ACSM 2016 |
| Post-run rehydration | Weighed deficit known | **1.25–1.5 L per kg lost**; don't restrict sodium afterwards | ACSM 2016 |
| Over-drinking guard | Planned intake > measured sweat rate | Warn: over-drinking is the primary cause of exercise hyponatraemia | ACSM 2016 |
| Caffeine pre-quality | Optional, user opt-in | 3–6 mg/kg ~60 min before (as low as 2 mg/kg may work) ([ISSN 2021](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7777221/)). **Cap** at 200 mg single / 400 mg day ([EFSA 2015](https://efsa.onlinelibrary.wiley.com/doi/10.2903/j.efsa.2015.4102)). Above ~67 kg body mass, 3 mg/kg already exceeds EFSA's 200 mg single dose (EFSA: no concern up to 200 mg < 2 h before intense exercise), so the app clamps to 200 mg. | ISSN, EFSA |
| Evening caffeine | Caffeine logged in the late afternoon or evening | Flag on Sleep/Recovery: 100 mg near bedtime can lengthen sleep latency (EFSA 2015) | EFSA |

Where hooks surface: the daily-coach card ("Fuel: 70 g carbs by 06:00 · 2 gels · 600 mL + 500 mg Na/h, 24 °C"), the 7-Day Plan (per-day carb band), the post-run analysis (logged vs recommended), and an optional morning notification line. All hooks are deterministic, so they are **keyless**.

---

## 5. Biology link (weight / body composition)

- Add drivers to `BioCorrelation.against`: `'Energy balance (7-day)'` and `'Intake (7-day kcal)'`. Reuse the existing Spearman + **lag scan** + t-significance + staleness cap. Weight is the driven metric, and the expected lag is days to weeks.
- Chart overlay: 7-day mean intake vs trend weight vs CTL on the Biology weight chart. `compositionChange()` can attribute Δweight to fat vs lean over a period against cumulative balance.
- Guard rails (as in `biology.ts`): report `n`, only complete-logged days, and state that correlation ≠ causation. Timeline events (sick, travel) are shown as confounders.
- The adaptive TDEE (§3.1) is itself the most useful Biology output: "expenditure trend" as a new Biology series.

---

## 6. Supplements

Supplements stay **separate** (one-tap adherence is their strength), with an **optional nutrient profile** per supplement:

```ts
// supplements.ts, additive field (backward compatible)
nutrients?: Record<string, Partial<Record<'caffeine'|'sodium'|'potassium'|'magnesium'|'carbs'|'kcal', number>>>; // name → per-dose amounts
```

- Taken-today doses then **count toward daily nutrition totals** (caffeine pill, electrolyte tab, gel). They are not duplicated as food entries.
- **Caffeine data upgrade:** `hrOffsetByDay()` currently assumes `COFFEE_BPM = 2`, and only on yohimbine days. With caffeine logged in mg per day, the offset can use the real caffeine intake. This is a calibration opportunity; the bpm-per-mg mapping needs its own evidence check, so it is not proposed as fact here.
- Performance supplements named in the IOC consensus (caffeine, creatine, nitrate, β-alanine, bicarbonate) get their doses logged. The coach may cite the IOC framing that only safe, legal, evidence-backed supplements should be considered ([IOC 2018](https://stillmed.olympics.com/media/Documents/Athletes/Medical-Scientific/Consensus-Statements/2018_dietary-supplements-high-performance-athlete.pdf)).

## 7. Labs (glucose and nutrition-relevant markers)

- **Fasting glucose / HbA1c** (Labs) and HK `BloodGlucose` are already unioned. Nutrition adds **context, not inference**: the Labs chat and Biology chat get 90-day mean intake, carb g/kg and fibre next to glucose trends.
- If CGM data appears in HK, the Food day view can overlay glucose on meal times (local log only). The copy must be careful: CGM shows blood glucose, not muscle glycogen, and the evidence for non-diabetic athletes is limited ([GSSI](https://www.gssiweb.org/sports-science-exchange/article/continuous-glucose-monitoring-use-in-athletes-without-diabetes); [Performance Nutrition 2025](https://link.springer.com/article/10.1186/s44410-025-00013-7)).
- Micronutrient intake (tier C) can sit next to the related lab markers (ferritin ↔ iron intake, 25-OH-D ↔ vitamin D, B12). This is an LLM-context only feature, never a deterministic claim.

---

## 8. `appModel.ts` facts to add

These are **rules** that belong in `buildAppModelPrompt()`. Add them only when Food mode has been used, to keep the block tight.

```
• NUTRITION: intake source per day = RunCoach food log, else ONE external Apple-Health app (${sourceName}); never summed. Own HK writes are ignored on read. Only days marked complete count toward energy balance.
• ENERGY: watch TDEE = active+basal; adaptive TDEE = intake vs EWMA trend weight (≥21 days). EA = (intake − exercise kcal)/FFM; <30 kcal/kg FFM on ≥3 of 7 days = caution. Nutrition is ADVISORY: it never changes the training plan.
• FUELLING RULES (ACSM 2016): pre-quality 1–4 g/kg 1–4 h before; long run 1–2.5 h 30–60 g/h, >2.5 h up to 90 g/h; <45 min none; protein 1.2–2.0 g/kg/d. Hydration by the athlete's measured sweat rate (${sweatRate} L/h @ ${temp}°C), deficit <2% BW, sodium when >1.2 L/h or >2 h. Caffeine ≤200 mg single / 400 mg day.
```

Plus a **data** line, `buildNutritionContext()` (mirrors `buildSupplementContext()`, injected at the same call sites: `coach.ts`, `runAnalysis.ts`, `claude.ts`; the numbers are illustrative, not real data):

```
NUTRITION (7d): 5/7 days complete · intake 2,310 kcal/d · carbs 4.1 g/kg · protein 1.6 g/kg · balance −290 kcal/d (adaptive TDEE 2,600) · today so far: 1,120 kcal, 140 g carbs · next quality: Thu intervals.
```

---

## 9. Local-first data model

```ts
// src/services/nutrition/types.ts (proposed)
export type NutrientKey =
  | 'kcal' | 'protein' | 'carbs' /* AVAILABLE carbs, EU convention */ | 'sugar' | 'fat' | 'satFat'
  | 'fibre' | 'sodium' | 'potassium' | 'caffeine' | 'water' | 'alcohol';
export type Nutrients = Partial<Record<NutrientKey, number>>;   // kcal · g · mg (sodium/potassium/caffeine) · mL (water)
export type Micros = Record<string, number>;                      // tier C long tail, HK-identifier-keyed, e.g. { DietaryIron: 3.1 }

export type FoodSource = 'off' | 'usda' | 'nevo' | 'ciqual' | 'custom' | 'llm' | 'quick';

export interface FoodItem {                // a food definition (DB hit, custom food, or LLM estimate)
  id: string;                              // 'off:5410041001204' | 'usda:171287' | 'custom:<uuid>'
  name: string; brand?: string; lang?: 'nl' | 'fr' | 'en';
  barcode?: string;
  basis: 'per100g' | 'per100ml';
  n: Nutrients; micros?: Micros;
  servings?: { label: string; grams: number }[];   // "1 slice" = 35 g, "1 gel" = 40 g
  source: FoodSource; sourceRef?: string;
  licence?: 'ODbL' | 'PD' | 'CC-BY' | 'own' | 'other';  // WS2 decides obligations
  fetchedAt?: string;
}

export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'pre-run' | 'during-run' | 'post-run';

export interface FoodEntry {               // one logged item (the unit of HK sync)
  id: string;                              // uuid; = HKExternalUUID on every HK sample written
  at: string;                              // ISO local datetime (TIME matters for pre-run hooks)
  slot: MealSlot;
  foodId?: string;                         // link to FoodItem (may be gone later)
  name: string;                            // denormalised snapshot
  grams: number;                           // or mL for drinks
  n: Nutrients; micros?: Micros;           // ABSOLUTE amounts for this entry (snapshot, survives DB edits)
  via: 'search' | 'barcode' | 'recent' | 'favourite' | 'meal' | 'recipe' | 'photo' | 'text' | 'quick' | 'copy';
  confidence?: number;                     // photo/text (WS3)
  groupId?: string;                        // entries logged together from one saved meal / photo
  runId?: string;                          // during-run fuel linked to a RunWorkout uuid
  hk?: { synced: boolean; at?: string; err?: string };
}

export interface WaterEntry { id: string; at: string; ml: number; sodiumMg?: number; runId?: string; hk?: FoodEntry['hk'] }

export interface DayLog {
  date: string;                            // YYYY-MM-DD, 4 am attribution like the rest of the app
  entries: FoodEntry[];
  water: WaterEntry[];
  complete?: boolean;                      // user ticked "day complete" → counts for adaptive TDEE
}

export interface FoodLogShard { version: 1; month: string /* YYYY-MM */; days: Record<string, DayLog> }

export interface SavedMeal { id: string; name: string; items: Omit<FoodEntry, 'id' | 'at' | 'hk'>[]; uses: number; lastUsed?: string }
export interface Recipe {
  id: string; name: string;
  ingredients: { foodId?: string; name: string; grams: number; n: Nutrients }[];
  cookedWeightG?: number; servings: number;
  per100: Nutrients;                       // derived, cached
}
export interface FoodLibrary {
  version: 1;
  custom: FoodItem[];                      // user-created + pinned DB items (see WS2 licence note)
  meals: SavedMeal[]; recipes: Recipe[];
  favourites: string[];                    // foodId | meal id
  recents: { foodId: string; grams: number; at: string }[];   // capped ~200
}

export interface SweatTest { id: string; date: string; runId?: string; preKg: number; postKg: number; fluidMl: number; urineMl?: number; minutes: number; apparentC: number; lph: number }

export interface NutritionSettings {       // SecureStore 'nutrition_settings_v1'
  hkWrite: boolean; hkRead: boolean;
  intakeSource: 'runcoach' | 'auto' | { bundleId: string; name: string };
  writeNutrients: NutrientKey[];           // default: kcal, protein, carbs, fat, fibre, sugar, satFat, sodium, water, caffeine
  goal: 'maintain' | 'gentle-loss' | 'fuel-only';
  proteinGPerKg: number;                   // default 1.6 (within 1.2–2.0)
  caffeineOptIn: boolean;
  showNumbersOnHome: boolean;
}
```

### Storage

| File (documentDirectory) | Content | Backup? | Why |
|---|---|---|---|
| `runcoach-food-log-YYYY-MM.json` | `FoodLogShard` per month | ✅ via `FILE_PREFIXES` | User-entered, not rebuildable. Monthly shards keep rewrites small: ~15 entries/day × ~0.4 KB ≈ 6 KB/day ≈ 180 KB/month (estimate). |
| `runcoach-food-library.json` | `FoodLibrary` | ✅ `FILES` | Custom foods, meals, recipes, favourites |
| `runcoach-sweat-tests.json` | `SweatTest[]` | ✅ `FILES` | Measured, not rebuildable |
| `food-db-cache.json` | OFF/USDA lookup cache | ❌ | Rebuildable. Also keeps an ODbL-derived DB out of the backup (WS2) |
| `nutrition-daily-cache.json` | Daily totals, adaptive TDEE, calibration `k` | ❌ totals / ✅ `k` optional | Recomputable from the log |

JSON files follow the existing pattern (`supplements.ts`, `labsStore.ts`: read → mutate → write, try/catch). **SQLite is not needed for the log** at these volumes, and `expo-sqlite` would be a new native module (the memory notes SQLite as deferred). **Resolution with WS2 (PM, REPORT.md §7):** the user's log and library stay JSON in every option. The bundled *generic food table* is a slim JSON asset in Option A (OTA) and moves to read-only SQLite + FTS5 only in the Option B prebuild. A merge-not-replace write discipline applies (lesson from the daily-components null bug): mutate one day, never rewrite a shard from a partial read.

---

## 10. `backup.ts` integration

```ts
// FILES: add
'runcoach-food-library.json',   // custom foods, saved meals, recipes, favourites
'runcoach-sweat-tests.json',    // measured sweat-rate tests (hydration hooks)
// FILE_PREFIXES: add
'runcoach-food-log-',           // monthly food-log shards (restore guard already allowlists prefixes + blocks '/' and '..')
// STATIC_SECURE_KEYS: add
'nutrition_settings_v1',
```

- Exclude `food-db-cache.json` and `nutrition-daily-cache.json`, per the file's own rule that "caches … are intentionally excluded".
- After restore, re-sync to HK only if `hkWrite` is on, and **delete-then-write** by `HKExternalUUID` so a restore never duplicates HK samples.
- `debugExport.ts`: include **daily totals and settings only**, never item names (redacted-dump rule).
- `cloudSync.ts`: **no change**. Food data stays on the device.

---

## 11. What to change in `app/food.tsx`

Keep: the theme hooks, the `🏠 Home` button, the Modes routing. Replace the static card with:

| Section | Content | Keyless? |
|---|---|---|
| Header | Today: kcal / carbs / protein rings vs targets; "day complete" toggle | ✅ |
| Fuel card | Today's coach hook(s): pre-run carbs, during-run g/h, fluid + sodium for today's `apparentC` | ✅ |
| Quick log row | Recents / favourites chips (1 tap), + search, barcode, quick-add, **copy yesterday** (WS4 flows) | ✅ (photo/text = key) |
| Timeline | Meals by slot with times; swipe to edit/delete (triggers HK delete + rewrite) | ✅ |
| Water & electrolytes | +250 / +500 mL buttons, sodium tab, "log sweat test" (pre/post weight) | ✅ |
| Energy balance | 7-day intake vs watch TDEE vs adaptive TDEE; EA flag | ✅ |
| Settings (sheet) | HK write/read toggles (→ `requestNutritionPermissions`), intake source picker (`querySources`), nutrients to write, goal, protein g/kg, caffeine opt-in | ✅ |
| Link-outs | Biology (weight vs intake), Labs, Supplements (Home timeline) | ✅ |

New files (proposed): `src/services/nutrition/{types,log,library,hk,energy,hooks,context}.ts`, `app/food-log.tsx` (search/entry), `app/food-settings.tsx`. `hooks.ts` is pure functions (plan + mass + weather → recommendations) and can be tested in the existing `harness/` (Node + sucrase) against fixtures.

---

## 12. Effort (WS5 share only, in build sessions; PM folds into Options A/B/C)

| Piece | A (MVP) | B (v1) | C |
|---|---|---|---|
| Data model + log/library stores + backup entries | 1 | – | – |
| HK write (energy + macros, correlation, delete/rewrite) + device spike | 1 | +0.5 (sodium, water, caffeine, fibre, sugar) | +0.5 micros |
| HK read importer + per-day source rule | – | 1 | – |
| Energy balance (watch TDEE + completeness) | 0.5 | +1 (adaptive TDEE, calibration `k`, EA) | – |
| Coach hooks (pure fns + daily card + appModel lines) | 1 (carbs + long-run g/h) | +1 (hydration, sweat test, electrolytes, caffeine) | +0.5 (notification, 7-Day Plan bands) |
| Biology drivers + overlay | – | 1 | – |
| Supplements nutrient profile, Labs context | – | 0.5 | +0.5 CGM overlay |
| **Total WS5** | **~3.5** | **~+6** | **~+2** |

**PM re-tiering (REPORT.md §7):** HK write moves from A to B. It is JS-only, but it needs the 1-sample device crash spike and the `NSHealthUpdateUsageDescription` text change, which only ship cleanly with B's native build. WS5's share of A is therefore ~2.5 sessions and of B ~+7. The "Tier" column in §2 keeps WS5's original nutrient priorities.

---

## 13. Risks and open questions

1. **Native crash risk** on HK metadata/correlation writes: `NSException`s can't be caught in JS. → Mandatory 1-entry device spike (correlation + `HKExternalUUID` + `HKWasUserEntered`). Include it in the watch-review-style post-build check.
2. **The HK Nutrition view in Health may show RunCoach and another app side by side.** That is the Health app's own priority ([Apple Support](https://support.apple.com/en-us/108779)) and outside our control. Document it in Settings.
3. **Carb convention** (available vs total) differs across DBs (EU vs USDA). → Normalise at import (WS2 must deliver fibre for USDA foods).
4. **Adaptive TDEE is only as good as logging completeness.** → Completeness gate; never show it before 21 days.
5. **Weight-loss framing** for a heat-sensitive, conservative-coaching profile. → The deficit is never applied on quality or long days by default; EA caution. Needs Geert's decision.
6. **Decision for Geert:** RunCoach as the logger (recommended), or read-only importer from an existing app, or both with the per-day rule?
7. **Decision:** HK write **on by default** or opt-in? (Recommended: opt-in, prompted once.)
8. **Decision:** include caffeine in the HR-offset model (§6)? This needs a separate evidence check.

---

## Sources

- Apple Developer: [HKCorrelation](https://developer.apple.com/documentation/healthkit/hkcorrelation) · [HKCorrelationTypeIdentifier.food](https://developer.apple.com/documentation/healthkit/hkcorrelationtypeidentifier/food) · [HKCorrelationType](https://developer.apple.com/documentation/healthkit/hkcorrelationtype) · [HKMetadataKeyFoodType](https://developer.apple.com/documentation/healthkit/hkmetadatakeyfoodtype) · [HKMetadataKeyExternalUUID](https://developer.apple.com/documentation/healthkit/hkmetadatakeyexternaluuid) · [HKMetadataKeySyncIdentifier](https://developer.apple.com/documentation/healthkit/hkmetadatakeysyncidentifier) · [HKMetadataKeySyncVersion](https://developer.apple.com/documentation/healthkit/hkmetadatakeysyncversion) · [HKStatistics](https://developer.apple.com/documentation/healthkit/hkstatistics) · [HKStatisticsQuery](https://developer.apple.com/documentation/healthkit/hkstatisticsquery) · [HKStatisticsOptions](https://developer.apple.com/documentation/healthkit/hkstatisticsoptions) · [HKSourceQuery](https://developer.apple.com/documentation/healthkit/hksourcequery) · [authorizationStatus(for:)](https://developer.apple.com/documentation/healthkit/hkhealthstore/authorizationstatus(for:)) · [requestAuthorization(toShare:read:)](https://developer.apple.com/documentation/healthkit/hkhealthstore/1614152-requestauthorization) · [dietaryEnergyConsumed](https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier/dietaryenergyconsumed)
- Apple Support: [Manage Health data (data-source priority)](https://support.apple.com/en-us/108779)
- Correlation auth disallowed: [EddyVerbruggen/HealthKit #106](https://github.com/EddyVerbruggen/HealthKit/issues/106) · [Apple Developer Forums 694311](https://forums.developer.apple.com/forums/thread/694311)
- Library: `@kingstinct/react-native-healthkit` v9.0.11, local `node_modules` (specs/QuantityTypeModule.nitro.ts, CorrelationTypeModule.nitro.ts, CoreModule.nitro.ts, types/QueryOptions.ts, ios/Helpers.swift)
- MyFitnessPal: [Apple Health connection and syncing](https://support.myfitnesspal.com/hc/en-us/articles/360032271092-Apple-Health-FAQ-and-Troubleshooting) · Cronometer: [Apple Health & Apple Watch](https://support.cronometer.com/hc/en-us/articles/360020734212-Apple-Health-Apple-Watch)
- Thomas, Erdman, Burke. ACSM/AND/DC Joint Position: Nutrition and Athletic Performance, MSSE 2016: [PubMed](https://pubmed.ncbi.nlm.nih.gov/26891166/) · [full text PDF](http://drugfreesport.org.za/wp-content/uploads/2018/04/Position-stand-on-Nutrition-Athletic-Performance-ACSM-2016-1.pdf)
- Sawka et al. ACSM Position Stand: Exercise and Fluid Replacement, 2007: [PubMed](https://pubmed.ncbi.nlm.nih.gov/17277604/)
- Barnes et al. Normative sweat data, J Sports Sci 2019 (GSSI summary): [link](https://www.gssiweb.org/research/article/normative-data-for-sweating-rate-sweat-sodium-concentration-and-sweat-sodium-loss-in-athletes-an-update-and-analysis-by-sport)
- Baker. Sweating rate and sweat sodium concentration in athletes, Sports Med 2017: [link](https://link.springer.com/article/10.1007/s40279-017-0691-5)
- Guest et al. ISSN position stand: caffeine and exercise performance, 2021: [PMC7777221](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7777221/)
- EFSA NDA Panel. Scientific Opinion on the safety of caffeine, 2015: [EFSA Journal](https://efsa.onlinelibrary.wiley.com/doi/10.2903/j.efsa.2015.4102)
- Mountjoy et al. 2023 IOC consensus on REDs, BJSM: [PDF](https://stillmed.olympics.com/media/Documents/Athletes/Medical-Scientific/Consensus-Statements/REDs/BJSM-IOC-consensus-statement-on-Relative-Energy-Deficiency-in-Sport-REDs.pdf) · [PINES summary](https://pinesnutrition.org/2023-ioc-consensus-statement-on-reds-whats-new/)
- Maughan et al. IOC consensus: dietary supplements and the high-performance athlete, 2018: [PDF](https://stillmed.olympics.com/media/Documents/Athletes/Medical-Scientific/Consensus-Statements/2018_dietary-supplements-high-performance-athlete.pdf)
- Shcherbina et al. Accuracy in wrist-worn sensor-based HR and EE, J Pers Med 2017: [MDPI](https://www.mdpi.com/2075-4426/7/2/3)
- Hall. What is the required energy deficit per unit weight loss? IJO 2008: [PubMed](https://pubmed.ncbi.nlm.nih.gov/17848938/)
- MacroFactor: [Algorithm accuracy](https://macrofactor.com/algorithm-accuracy/) · [Expenditure help](https://help.macrofactorapp.com/en/articles/20-expenditure)
- EU Regulation 1169/2011: [Annex I (definitions: carbohydrate, fibre, salt)](https://www.legislation.gov.uk/eur/2011/1169/annex/I) · [Annex XIV (energy conversion factors)](https://www.legislation.gov.uk/eur/2011/1169/annex/XIV)
- USDA SR28 documentation (carbohydrate by difference includes fibre): [PDF](https://www.ars.usda.gov/arsuserfiles/80400525/data/sr/sr28/sr28_doc.pdf)
- CGM in non-diabetic athletes: [GSSI](https://www.gssiweb.org/sports-science-exchange/article/continuous-glucose-monitoring-use-in-athletes-without-diabetes) · [Performance Nutrition 2025](https://link.springer.com/article/10.1186/s44410-025-00013-7)
