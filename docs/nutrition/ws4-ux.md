# WS4: Fast entry and meal creation (UX)

**Workstream:** 4 of [BRIEF.md](/Users/geertsteyaert/projects/runcoach-ai/docs/nutrition/BRIEF.md). **Status:** research done, 2026-09-28. **Scope:** UX flows, tap counts, wireframes, native/OTA footprint. No app code was changed.
**Depends on:** WS2 (which DB answers search and barcode), WS3 (photo latency and JSON schema), WS5 (data model). Where a number depends on them, this doc says so.

---

## 1. Summary

- **A repeat meal takes ≤3 taps**, and 1 tap when the day view offers it as a suggestion. It never needs the network or an LLM. The fastest trackers use the same patterns ([MacroFactor FLSI](https://macrofactor.com/fastest-food-logger-2025/)): the item is logged the moment it is picked, with no confirmation screen, and the last serving is remembered.
- **Everything except barcode scanning ships as JS (OTA-able).** Photo capture can use `expo-image-picker`'s `launchCameraAsync`, which is already installed and whose `NSCameraUsageDescription` is already in `ios/RunCoachAI/Info.plist`. Barcode scanning needs `expo-camera` (16.0.x on SDK 52), which is not installed, so it needs a prebuild and an Xcode build.
- **Keyless free text works.** A throwaway deterministic parser handled EN/NL/FR phrases ("2 sneetjes brood met kaas", "deux oeufs et une tartine avec du beurre") and got 21 of 24 phrases fully right against a toy vocabulary (§7). The LLM is an upgrade path, not a requirement.
- **Voice costs nothing:** the iOS keyboard mic dictates into the same free-text box, on-device in many languages ([Apple](https://support.apple.com/guide/iphone/dictate-text-iph2c0651d2/ios)). A speech-recognition module isn't needed for v1.
- **Siri and home-screen shortcuts come in 4 tiers.** Tier 0 needs no native code: `runcoach://food/...` deep links already reach JS through the app's custom SceneDelegate (`openURLContexts`), so a Shortcuts-app "Open URL" shortcut works today. Native App Intents (zero-setup Siri phrases) are feasible but need Swift in the main target through a config plugin.
- **The ≤10 s photo target is borderline**, contingent on upload + LLM round-trip ≤ ~4.5 s (WS3). The rest of the flow costs ~5.5 s and 4–5 taps. Realistic only with the Option B resize; Option A (OTA, no resize) will likely miss it.
- **Native footprint beyond barcode:** the photo resize and the keyless label OCR also need native code; both go into the same Option B prebuild as `expo-camera` (§11).

---

## 2. What the codebase already gives us (and doesn't)

| Fact (from the repo) | UX consequence |
|---|---|
| `app/food.tsx` is a 44-line placeholder: 🏠 Home pill, emoji + h1, `c.surface` cards, `useThemedStyles` | New screens reuse that visual language (see wireframes) |
| `app/workout-library.tsx` pattern: list of cards + `＋ New …` button + bottom-sheet `Modal` with **Done** in the header, chips (`borderRadius: 999`) | The add sheet and the meal builder use the same sheet and chip idiom |
| `expo-image-picker ~16.0.6` installed, used for Bevel OCR; `NSCameraUsageDescription` present in Info.plist | Photo meal = OTA-able via `launchCameraAsync` ([Expo docs](https://docs.expo.dev/versions/v52.0.0/sdk/imagepicker/)) |
| `expo-camera` **absent**; `expo-barcode-scanner` was removed in SDK 52 ([Expo SDK 52 changelog](https://expo.dev/changelog/2024-11-12-sdk-52)) | Barcode = new native module → prebuild + local Xcode build, not OTA |
| No `expo-image-manipulator` | Photos can't be resized client-side without a rebuild. **Option A rule (REPORT.md §4):** `quality ≈ 0.5`, media type sniffed from the bytes (never the hard-coded `image/png` of the existing callers), and a ~5 MB base64 guard, because Anthropic rejects base64 images over 10 MB ([Claude vision docs](https://platform.claude.com/docs/en/build-with-claude/vision)). True resize moves to the Option B prebuild |
| `scheme: "runcoach"`; `plugins/withSceneDelegate.js` forwards `openURLContexts` + `continueUserActivity`, **not** `performActionForShortcutItem` | Deep-link shortcuts work now; home-screen quick actions need a SceneDelegate patch |
| `@bacons/apple-targets ^4.0.7` already builds `targets/watch` + `targets/watchwidget`; App Group `group.com.netweaver1970.runcoachai` exists | A phone widget / App Intent extension is the same machinery (see §8 caveat on SDK version) |
| Known RN bug class: TextInput screens freeze with the keyboard up (fixed in chat/workout notes via `Keyboard.dismiss()` on every exit path) | The add sheet is TextInput-heavy: apply the same guardrails from day one |

---

## 3. Design principles (what makes entry fast)

1. **Log on pick, undo instead of confirm.** Tapping a known food or meal logs it with the remembered serving and shows a 4 s "Logged · Undo" toast. MacroFactor's speed mode returns you "to the food logging workflow immediately after adding food" and wins every FLSI case ([MacroFactor FLSI 2025](https://macrofactor.com/fastest-food-logger-2025/)).
2. **Remember the last serving per food**, so a repeat is one tap ([MacroFactor logger](https://macrofactor.com/new-food-logger/)).
3. **Suggest by time of day.** Put the 3 foods or meals most often logged in this 2-hour window as chips at the top of the day view. MacroFactor learns "your go-to foods at the times you tend to eat them" ([same](https://macrofactor.com/new-food-logger/)).
4. **One input box does everything.** Typing searches local items. Typing a phrase with quantities ("2 eggs, toast") offers **Parse**. A 13-digit number is treated as a barcode. There's no mode picking.
5. **Local-first search, network on request.** Open Food Facts allows 10 searches/min/IP and warns that search-as-you-type "would be blocked very quickly" ([OFF API](https://openfoodfacts.github.io/openfoodfacts-server/api/)). As-you-type searches only local data: recents, favourites, meals, recipes and the bundled generic table (WS2). **Search online** is an explicit tap.
6. **Timeline, not meal slots, with run markers.** A 24-hour timeline removes the "which meal?" choice ([MacroFactor](https://macrofactor.com/new-food-logger/)). RunCoach adds its own twist: today's runs appear in the timeline, so pre-run, during-run and post-run fuelling is visible by position. That is the hook for WS5's coaching. Slot labels (Breakfast/Lunch/…) are derived from the clock for display only.
7. **Metric and Belgian household units first:** g, ml, piece/stuk, sneetje/tranche, el/cs, kl/cc, glas/verre, portie.
8. **Every flow has a keyless path;** AI only shortens it.

---

## 4. Flow inventory with tap counts

**Counting rule** (same idea as FLSI: every discrete tap, selection or submit counts; typing a query or a number counts as **1** action). The start is the Food day view unless stated. Getting to Food from the RunCoach home adds 2 taps (☰ Modes → Food). An iPhone-home-screen shortcut replaces all of that (§8).

| # | Flow | Taps | Keyless? | Network? | Native rebuild? |
|---|---|---|---|---|---|
| F1 | **Repeat meal from a suggestion chip** | **1** | yes | no | no |
| F2 | Repeat saved meal via add sheet (＋ → Meals → row) | **3** | yes | no | no |
| F3 | Recent single food, remembered serving (＋ → row) | **2** | yes | no | no |
| F4 | Copy yesterday's meal (group ⋯ → "Copy to today") or whole day (day ⋯ → "Copy yesterday") | **2** | yes | no | no |
| F5 | Copy from a specific day, e.g. last Tuesday (day ⋯ → Copy from… → pick day → All / pick group) | **4** | yes | no | no |
| F6 | Barcode, product known locally (＋ → Scan → auto-detect → Log) | **3** | yes | no | **yes** (`expo-camera`) |
| F7 | Barcode, first time (＋ → Scan → auto → pick portion → Log) | **4** | yes | OFF lookup (1 read) | **yes** |
| F8 | Search generic food (＋ → type → result → portion chip → Log) | **5** | yes | no (bundled table) | no |
| F9 | Quick-add kcal/macros (＋ → Quick → kcal [→ C/P/F] → Log) | **4** (6 with macros) | yes | no | no |
| F10 | Free text / dictation, all matched (＋ → type or 🎤 → Parse → Log all) | **4** | **yes** (deterministic parser) | no | no |
| F11 | Photo meal (＋ → 📷 → shutter → Use Photo → review → Log all) | **5** (4 with `expo-camera`) | no (needs key) | LLM | no (image-picker) |
| F12 | Save the logged group as a meal (group ⋯ → Save as meal → name → Save) | **4** | yes | no | no |
| F13 | New recipe (see §6.3) | one-off, ~10–20 | yes | optional | no |
| F14 | Home-screen / Siri "log usual breakfast" | **1** (icon) or 0 (voice) | yes | no | Tier 0 no; Tier 2+ yes |

**Targets:**
- **≤3 taps for a repeat meal:** met by F1 (1), F2 (3), F3 (2) and F4 (2). From the RunCoach home, F1 costs 3 (☰, Food, chip). F14 costs 1 from the iPhone home screen.
- **≤10 s for a new photo meal:** see the §5 time budget.

**Benchmarks:** FLSI counts for the same kinds of task are barcode 5 (MacroFactor) vs 7 (MyFitnessPal, Cronometer), quick-add 3 (MacroFactor) vs 5 (Lose It!), and multi-add of 2 remembered foods 6 (MacroFactor) ([FLSI 2025](https://macrofactor.com/fastest-food-logger-2025/)). The FLSI counts start on the app's own home screen, so compare with care. WS1 owns the full cross-app matrix.

---

## 5. Photo meal: the ≤10 s budget

| Step | Taps | Time (estimate) |
|---|---|---|
| ＋ → 📷 opens the system camera (`launchCameraAsync`) | 2 | ~1.5 s |
| Frame + shutter | 1 | ~1.5 s |
| "Use Photo" (system picker confirm step; skipped with an `expo-camera` in-app shutter) | 1 | ~0.5 s |
| Upload + LLM → JSON items, grams, confidence. A: JPEG `quality ≈ 0.5`, byte-sniffed media type, ~5 MB base64 guard (multi-MB upload). B: resized to ~1024 px (~150 KB) | 0 | **X s (WS3)** |
| Review list: grams pre-filled, low-confidence rows amber; **Log all** | 1 | ~2 s |
| **Total** | **5** (4) | **≈ 5.5 s + X** |

- **The ≤10 s target is borderline, contingent on X ≤ ~4.5 s.** Haiku 4.5 needs ~5 s with a ~150 KB upload (WS3), so even Option B sits right at the line. Option A's un-resized upload adds seconds on mobile data, so A will likely miss it: treat ≤10 s as a B target. To keep X small, send one image, keep the output schema short, and use a fast non-thinking vision model.
- **Keyless (both options):** the 📷 *meal* button is greyed out with "Add an LLM key in Settings to use photo logging". This follows the existing reachability-greyed pattern (LLM dependency map). Option A keyless alternatives: F10 free text, search, EAN digits, the manual 7-field label form. Option B adds the barcode scan and a keyless **Label** mode (on-device Vision OCR, WS3 §6).
- **Hybrid (from WS3):** the LLM returns item names and grams. Names are matched against the local DB for per-100 g values, and the LLM's own kcal is used only as a fallback marked "AI estimate".
- **After `expo-camera` lands:** one **Scan** screen handles all three modes. A barcode auto-logs; the shutter takes a food photo; "Label" photographs a nutrition panel for WS3's text path. This removes the "Use Photo" tap.

---

## 6. Text wireframes

The style follows `app/food.tsx` and `app/workout-library.tsx`: a 🏠 Home pill, emoji + bold h1, rounded `c.surface` cards with a 1 px `c.border`, pill chips, `＋` action buttons, and bottom-sheet `Modal`s with **Done**.

### 6.1 Log day view (`app/food.tsx`, evolved)

```
┌──────────────────────────────────────────┐
│ [🏠 Home]                        ‹ Today ›│  ← swipe or ‹ › = day; tap = date picker
│ 🍽️ Food                                   │
│ ┌──────────────────────────────────────┐ │
│ │ 1 840 / 2 650 kcal   ▓▓▓▓▓▓▓░░░░      │ │  ← target from WS5 (intake vs
│ │ C 210 g · P 96 g · F 61 g · 💧 1.4 L  │ │    active + basal)
│ │ 🧂 Na 1.9 g   ☕ 180 mg                │ │  ← sodium/caffeine: heat + sweat hooks
│ └──────────────────────────────────────┘ │
│ Usually now:                              │
│ (☕ Usual breakfast 420 ＋) (🍌 Banana ＋)  │  ← F1: one tap logs, toast "Logged · Undo"
│                                           │
│ 07:40 ─ Breakfast ·········· 420 kcal  ⋯ │  ← ⋯ = Save as meal / Copy to… / Delete
│   Havermout 60 g · Halfvolle melk 200 ml  │
│   Banaan 1 st                             │
│ 09:30 ─ 🏃 Run · 12 km · Z2 ··········    │  ← run marker from HealthKit (WS5)
│   └ during: Gel 1 st ··········· 90 kcal  │    fuelling snaps to the run by time
│ 11:15 ─ Post-run ··········· 510 kcal  ⋯ │
│   2 sneetjes brood · Kaas 40 g · Ei 2 st  │
│ 13:00 ─ Lunch ················ 0 kcal    │
│   (Copy yesterday's lunch ＋)              │  ← F4 inline, when the slot is empty
│                                           │
│ Day ⋯ : Copy yesterday · Copy from… ·    │  ← F4/F5
│         Quick add · Water +250 ml         │
│                                    ┌────┐ │
│                                    │ ＋ │ │  ← opens the add sheet; long-press =
│                                    └────┘ │    Quick add (F9)
└──────────────────────────────────────────┘
```

### 6.2 Add sheet (bottom sheet, opens with the keyboard up)

```
┌──────────────────────────────────────────┐
│ Add · 11:15  (Post-run ▾)          Done │  ← time/slot defaults to now; tap to change
│ ┌──────────────────────────────────────┐ │
│ │ 🔎 2 eieren, toast met boter    🎤 ⌫ │ │  ← one box: search / phrase / EAN digits
│ └──────────────────────────────────────┘ │    🎤 = iOS keyboard dictation (no module)
│ [ Parse "2 eieren, toast met boter" → ]  │  ← appears when the text has qty/connector
│ (📷 Photo) (▥ Scan) (⚡ Quick) (💧 Water) │  ← 📷 greyed if keyless; ▥ after expo-camera
│ ─ Recents · Favourites ★ · Meals · Recipes│  ← tabs; default = Recents
│ ★ Havermout            60 g  228 kcal  ＋ │  ← ＋ = log with remembered serving (F3)
│   Halfvolle melk      200 ml  92 kcal  ＋ │    tap row body = portion picker
│   Banaan               1 st  105 kcal  ＋ │
│   Colruyt Boni yoghurt 125 g  … kcal   ＋ │  ← barcode-origin items land in recents
│ ─ Generic (bundled table)                 │
│   Ei, gekookt          …               ＋ │
│ [ Search online (Open Food Facts) ]       │  ← explicit; never as-you-type
└──────────────────────────────────────────┘
```

**Parse result (F10), inline in the same sheet:**

```
│ Parsed · review                     Log all│
│ ✓ Ei            2 st  → 100 g   [−][+]   │  ← stepper moves in the unit, not grams
│ ✓ Toast/brood   1 sn  →  35 g   [−][+]   │
│ ✓ Boter         1 portie → 10 g [−][+]   │
│ ? "honing 1 el"  → tap to search          │  ← unmatched chunk = prefilled search
```

**Portion picker** (tapping a row body):

```
│ Havermout · per 100 g: 379 kcal C66 P13 F7│  ← illustrative (≈USDA oats)
│ (40 g) (60 g ✓last) (80 g) (1 kom) (½ kom)│  ← chips: last, DB servings, household
│ [   60   ] g   ⌨ numeric                  │
│ = 227 kcal · C40 P8 F4          [ Log ]   │
```

### 6.3 Meal / recipe builder (sheet from Meals or Recipes tab → ＋ New)

```
┌──────────────────────────────────────────┐
│ New recipe                         Done │
│ [ Pasta bolognese (thuis)              ] │
│ Type:  (Meal = log items)  (Recipe ✓)    │  ← Meal: a bundle of foods logged together
│                                           │    Recipe: becomes ONE food, per serving
│ Ingredients                    ＋ Add ▾   │  ← ▾ Search · Scan · Paste text · Photo(AI)
│   Spaghetti (droog)      500 g   1 790    │
│   Rundergehakt            400 g     …     │
│   Tomatensaus           680 g       …     │
│   Olijfolie               2 el      …     │
│   ? "1 ui"  → tap to match                │  ← from "Paste text" through the same parser
│                                           │
│ Yield:  (Servings [ 5 ])  (Cooked weight  │  ← cooked weight lets you log "320 g"
│          [ 1 850 ] g)                     │    of the pot; servings = "1 portie"
│ Per serving: 780 kcal · C98 P41 F22      │  ← live
│ Per 100 g:   211 kcal                     │
│ ★ Favourite   Default portion: 1 serving  │
│                        [ Save recipe ]    │
└──────────────────────────────────────────┘
```

- **Saved meals are harvested, not built:** group ⋯ → *Save as meal* (F12), whose portions can then be scaled ×½/×1/×1½ when logged.
- **The builder is for recipes** (home cooking, batch cooking). Its **Paste text** option feeds a recipe's ingredient list through the §7 parser.

---

## 7. Keyless free-text parser: spike

**Throwaway spike:** `scratchpad/nutrition/parse.mjs` (not in the repo). It splits on `, ; + and with en met et avec`, reads the leading quantity (digits, `½`, number words in EN/NL/FR), reads the unit (g/ml/kg, slice/sneetje/tranche, tbsp/el/cs, tsp/kl/cc, cup/kom/bol, glass/glas/verre, piece/stuk), and matches a food by its longest multilingual alias. Grams come from the unit → gram table per food, or from a default portion. The food list was a 16-item toy vocabulary standing in for recents plus the generic table.

| Result on 24 EN/NL/FR phrases | |
|---|---|
| Items recalled | 40/41 (98%) |
| Phrases fully right | 21/24 |
| Misses | "spaghetti bolognese" → pasta only (composite dish); "2 beers" (plural alias missing); "chicken curry with naan" → chicken, naan unknown |

**Caveat:** the vocabulary and the test phrases were written together, so this is a best case. In real use, recall is bounded by the alias vocabulary.

What the spike shows for the design:
- The grammar is the easy part. Recall comes from the **alias list**, so aliases should grow from the user's own recents and favourites (each logged food adds its name as an alias) plus the NL/FR names in the generic table (WS2: NEVO is NL, CIQUAL is FR).
- **Composite dishes must match before splitting.** Match the whole phrase against saved meals and recipes first ("spaghetti bolognese" → the user's recipe), and split on connectors only when there is no whole match.
- **Unmatched chunks are never dropped.** They become a pre-filled search row (the `?` rows in §6.2).
- **Size adjectives** ("big bowl") are ignored today. A later refinement is ×1.5 / ×0.5 multipliers for groot/grand/big and klein/petit/small.
- **With an LLM key:** send the same text to the LLM for structure, then run the *same* DB matcher on its output. The review UI is identical, and the keyless and AI paths differ only in the parse step.

---

## 8. Home-screen and Siri shortcuts: feasibility

| Tier | What the user gets | How | Native work | OTA? |
|---|---|---|---|---|
| **0** | Shortcuts-app icon on the home screen, or a Siri phrase they name ("Log usual breakfast") | In-app "Copy shortcut link" → `runcoach://food/log?meal=<id>`; the user builds a Shortcuts "Open URLs" shortcut. The SceneDelegate already forwards `openURLContexts` to RN | none (expo-router route + handler) | **yes** |
| **1** | Long-press the app icon → "Log usual breakfast / Quick add / Scan" | `UIApplicationShortcutItems` (static) or dynamic items; iOS shows up to 4 ([Apple archive](https://developer.apple.com/library/archive/documentation/UserExperience/Conceptual/Adopting3DTouchOniPhone/3DTouchAPIs.html)). Scene-based apps receive them in `windowScene(_:performActionFor:)` and in `connectionOptions.shortcutItem` on cold launch ([Jake Hao](https://www.jakehao.com/scene-delegate-open-url)), which `withSceneDelegate.js` does **not** forward today | patch `withSceneDelegate.js` to turn shortcut items into `runcoach://` URLs | no |
| **2** | Zero-setup Siri/Spotlight: "Log breakfast in RunCoach" works right after install | App Intents + `AppShortcutsProvider`. Shortcuts are "available as soon as someone installs your app" ([Apple](https://developer.apple.com/documentation/appintents/app-shortcuts)); iOS 16+; max **10** App Shortcuts per app ([Apple forums](https://developer.apple.com/forums/thread/710816)). Intents must compile in the **main app target**, so a config plugin copies the Swift in during prebuild ([dev.to walkthrough](https://dev.to/cross19xx/ios-app-intents-in-an-expo-app-38od)), the same technique `withSceneDelegate.js` uses. Simplest hand-off: `openAppWhenRun` + deep link | Swift intents + plugin | no |
| **3** | Home-screen widget with "＋ Usual breakfast" buttons and today's kcal ring | Widget target via `@bacons/apple-targets` (already used for watch targets); logs are written to an App Group queue that JS ingests on next foreground ([apple-targets](https://github.com/EvanBacon/expo-apple-targets)) | widget target + App Group queue + JS ingest | no |

**Notes:**
- The apple-targets README lists "Expo SDK +53" as a requirement ([repo](https://github.com/EvanBacon/expo-apple-targets)), yet v4.0.7 already builds the watch targets on SDK 52 here. Treat Tier 3 as "works in this repo, not officially supported".
- An official `expo-app-intents` module is in progress upstream ([expo PR #47207](https://github.com/expo/expo/pull/47207)). It is not usable on SDK 52.
- **Recommendation:** Tier 0 in v1 (free), Tier 1 alongside the `expo-camera` rebuild (same prebuild), and Tier 2/3 only if Geert actually uses the shortcuts.

---

## 9. Voice

| Option | Effort | Offline / privacy | Verdict |
|---|---|---|---|
| **iOS keyboard dictation** into the add-sheet box | 0 | processed on-device in many languages, no internet needed ([Apple](https://support.apple.com/guide/iphone/dictate-text-iph2c0651d2/ios)) | **Use in v1.** Works with NL/FR keyboards |
| `expo-speech-recognition` (`sdk-52` tag = 1.1.1 on npm); `requiresOnDeviceRecognition`, `contextualStrings` for food vocabulary ([repo](https://github.com/jamsch/expo-speech-recognition)) | new native module + mic/speech permission strings + rebuild | on-device optional | Only for a hands-free "hold to talk" button; defer |
| Siri via App Intents with a spoken food string parameter | Tier 2 above | Siri | Later |

---

## 10. Barcode: SDK 52 specifics

- **Package:** `npx expo install expo-camera` (resolves to 16.0.x for SDK 52). Scanning uses `<CameraView barcodeScannerSettings={{ barcodeTypes: ['ean13','ean8','upc_a','upc_e'] }} onBarcodeScanned={…} />`. iOS also offers `launchScanner()`, a modal built on `DataScannerViewController` (iOS 16+), with `onModernBarcodeScanned` ([Expo camera v52](https://docs.expo.dev/versions/v52.0.0/sdk/camera/)).
- **Permissions:** the `useCameraPermissions()` hook. The config plugin option `cameraPermission` sets `NSCameraUsageDescription`, and `microphonePermission` should be disabled because no video is recorded ([same](https://docs.expo.dev/versions/v52.0.0/sdk/camera/)).
- **UX details:**
  - Debounce `onBarcodeScanned`, because it fires repeatedly. Stop scanning after the first hit and give haptic feedback.
  - Look up the local cache first. Then do one OFF read (limit 15 reads/min/IP; custom `User-Agent` required, per [OFF API](https://openfoodfacts.github.io/openfoodfacts-server/api/)).
  - Offline, queue the EAN as a pending item ("Boni yoghurt? — resolve when online").
- **Miss path:**
  - "Not found": 📷 Label (AI, WS3), or enter per-100 g values manually (a 7-field form mirroring the mandatory EU declaration: energy, fat, saturates, carbohydrate, sugars, protein, salt, per [Reg. (EU) 1169/2011 Art. 30](https://eur-lex.europa.eu/eli/reg/2011/1169/oj)), or Quick add.
  - A manual entry is saved locally against the EAN. A contribution flow back to OFF is a WS2 licensing decision.
- **Keyless fallback without a rebuild:** typing the 13 EAN digits into the add-sheet box triggers the same lookup.

---

## 11. Build footprint per flow

| Bucket | Flows | Ships as |
|---|---|---|
| **Pure JS / OTA** | F1–F5, F8–F10, F12, F13, F14 Tier 0, photo via image-picker (F11), EAN digit entry | OTA |
| **One prebuild** (bundle together = Option B) | `expo-camera` scan screen (F6/F7 + in-app shutter + keyless Label mode), Tier 1 quick actions (SceneDelegate patch), photo resize (`expo-image-manipulator` or Swift in `modules/runcoach-pdf`), label OCR Swift function, `expo-sqlite` for the generic table | local Xcode build |
| **Optional later prebuilds** | App Intents (Tier 2), widget (Tier 3), `expo-speech-recognition` | local Xcode build |

---

## 12. Recommendation

Ship the UX in two steps. They map onto the report's Options.

1. **v1, all OTA (fits Option A/B):**
   - timeline day view with run markers and time-of-day suggestion chips;
   - the one-box add sheet (recents/★/meals/recipes + bundled generic table);
   - log-on-pick with undo and remembered servings;
   - copy yesterday / copy from…, quick-add, water;
   - the keyless free-text parser, with keyboard dictation for voice;
   - save-as-meal, the recipe builder;
   - photo via image-picker when a key exists;
   - EAN digit entry;
   - Tier 0 deep-link shortcuts.

   Repeat meals take 1–3 taps. The photo flow takes 5 taps and ≈ 5.5 s + upload + LLM (quality ≈ 0.5, no resize: likely over 10 s).
2. **v1.1, one prebuild:**
   - `expo-camera` Scan screen (barcode + photo + keyless label OCR in one place, 4-tap photo);
   - photo resize to ~1024 px (the ≤10 s target becomes reachable, still borderline);
   - Tier 1 home-screen quick actions in the same build.
3. **Later, only if used:** App Intents / widget (Tier 2–3) and push-to-talk speech.

**Guardrails for the build:**
- Apply the keyboard-freeze rules to the add sheet: `Keyboard.dismiss()` on every exit path, no `automaticallyAdjustKeyboardInsets` with multiline.
- Never search OFF as the user types.
- Keep every AI result behind the same review list the keyless parser uses.

## 13. Open UX questions for Geert

1. Timeline with run markers (recommended) or classic Breakfast/Lunch/Dinner/Snacks slots?
2. Log on pick with undo (fast) or a confirm screen (safer)?
3. Is the barcode rebuild worth it in v1, or is EAN digit entry plus photo enough at first?
4. Should water and electrolytes get dedicated one-tap buttons on the day view (heat and sweat hooks)?
5. Shortcuts: are Tier 0 (you build the Shortcut once) and Tier 1 (long-press icon) enough, or do you want zero-setup Siri phrases (Tier 2)?

---

## Sources

- MacroFactor: Food Logging Speed Index 2025 results: https://macrofactor.com/fastest-food-logger-2025/
- MacroFactor: new food logger (speed mode, multi-add, time-based suggestions, timeline): https://macrofactor.com/new-food-logger/
- MyFitnessPal Help: copy a meal between days: https://support.myfitnesspal.com/hc/en-us/articles/360032622131-How-do-I-copy-a-meal-from-one-day-to-another
- MyFitnessPal Help: Quick Add: https://support.myfitnesspal.com/hc/en-us/articles/360032621971-What-is-Quick-Add
- Expo SDK 52 camera docs (CameraView barcode props, launchScanner, permissions, config plugin): https://docs.expo.dev/versions/v52.0.0/sdk/camera/
- Expo SDK 52 ImagePicker docs (launchCameraAsync, camera permission): https://docs.expo.dev/versions/v52.0.0/sdk/imagepicker/
- Expo SDK 52 changelog (expo-barcode-scanner removed): https://expo.dev/changelog/2024-11-12-sdk-52
- Expo issue: BarCodeScanner deprecated: https://github.com/expo/expo/issues/27015
- Open Food Facts API docs (rate limits, no search-as-you-type, User-Agent): https://openfoodfacts.github.io/openfoodfacts-server/api/
- Claude vision docs (image sizing, pre-resize to reduce latency): https://platform.claude.com/docs/en/build-with-claude/vision
- Apple Support: Dictate text on iPhone (on-device dictation): https://support.apple.com/guide/iphone/dictate-text-iph2c0651d2/ios
- expo-speech-recognition (on-device option, contextual strings, dev build): https://github.com/jamsch/expo-speech-recognition
- Apple: App Shortcuts overview (available at install): https://developer.apple.com/documentation/appintents/app-shortcuts
- Apple: AppShortcutsProvider (iOS 16+): https://developer.apple.com/documentation/appintents/appshortcutsprovider
- Apple Developer Forums: App Shortcuts limit of 10: https://developer.apple.com/forums/thread/710816
- iOS App Intents in an Expo app (main-target requirement, config-plugin copy, deep-link hand-off): https://dev.to/cross19xx/ios-app-intents-in-an-expo-app-38od
- Expo PR: expo-app-intents module (upstream, in progress): https://github.com/expo/expo/pull/47207
- expo-apple-targets (widget / App Intent targets, App Groups, SDK note): https://github.com/EvanBacon/expo-apple-targets
- Apple archive: Home Screen quick actions (up to four; static/dynamic): https://developer.apple.com/library/archive/documentation/UserExperience/Conceptual/Adopting3DTouchOniPhone/3DTouchAPIs.html
- EU Regulation 1169/2011 (food information to consumers; Art. 30 mandatory nutrition declaration): https://eur-lex.europa.eu/eli/reg/2011/1169/oj
- Jake Hao: deep links and shortcut items with SceneDelegate: https://www.jakehao.com/scene-delegate-open-url
- npm registry: `npm view expo-speech-recognition dist-tags` (sdk-52 → 1.1.1), `npm view expo-camera@~16.0 version` (16.0.x): https://www.npmjs.com/package/expo-speech-recognition , https://www.npmjs.com/package/expo-camera
