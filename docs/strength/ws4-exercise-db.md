# WS4: Exercise database, media and form cues

**Workstream:** WS4 (brief §4). **Date:** 2026-09-29. **Status:** research done, spike run.

**Spike scripts and raw pulls** (throwaway, not in git): `/private/tmp/claude-501/-Users-geertsteyaert-Claude-iphone---mcp-apple-health-integration/483e295a-fc0e-4f46-900f-6ce14d7f5462/scratchpad/strength/`. The main files there:
- `runner20.py`, the hit-rate script;
- `fedb.json`, `wger_exerciseinfo.json`, `wg_manifest.json` and `repdb.json`, the full dataset pulls;
- `wgsample/`, the rendered sample frames.

> **Not legal advice.** The licence readings below come from the primary texts, cited in Sources. If the app is ever distributed beyond TestFlight, get the final attribution screen checked.

---

## 1. TL;DR

| # | Finding |
|---|---|
| 1 | **Don't use free-exercise-db's images.** The data is released under the Unlicense, but the upstream project says its images were *"scrapped off the internet"* and advises against commercial use. Reverse image searches point to bodybuilding.com and ExRx. In Aug 2026 the maintainer said he may swap the images for placeholders. |
| 2 | **Every commercial API fails "keyless + offline".** ExerciseDB/AscendAPI, MuscleWiki and API Ninjas all need a key and a live subscription. MuscleWiki and AscendAPI both **forbid storing their media permanently**. |
| 3 | **wger is the cleanest open source for text**: 912 exercises. The data is CC BY-SA 3/4 or CC0, and each record carries its own licence. The AGPL-3.0 licence covers only wger's **server code**, which we would not use. The catch: only 273 of 912 exercises have images, the images mix photos and line art, and 41 are AI-generated. |
| 4 | **The best image source for runner strength is `bryllim/workout-guide`**: 302 exercises, each with **3 consistent monochrome SVG frames**. The artwork is **CC BY-SA 4.0** and the code is MIT. It covers the runner-specific moves: Copenhagen plank, Nordic curl, single-leg RDL, Bulgarian split squat. The repo is young (created 2026-08-24) and the provenance of 830 of its 906 frames (all frames 2–3, plus the first poses of 226 exercises) is only self-declared. |
| 5 | **RepDB's free tier is a strong runner-up.** It has 601 exercises, 2 flat WebP frames each and **3 short tips per exercise**. It allows commercial use in-app **with a visible credit**. It forbids redistributing the data as a dataset and forbids feeding the images to generative AI. The images are AI-made, commissioned by RepDB. |
| 6 | **Spike result for the "runner core 20":** workout-guide **19/20 with images**; RepDB **19/20 with images**; wger **19/20 present but only 11/20 with an image**; free-exercise-db 17/20. Pogo hops appear in **no** source, and tibialis raises only in wger (no image). Those have to be authored ourselves. |
| 7 | **Bundle size is trivial.** The 20-exercise image set is **1.5 MB** as workout-guide SVG (3 frames) or **0.55 MB** as RepDB WebP (2 frames). The full workout-guide library is 26 MB. |
| 8 | **Video: link out to YouTube, don't embed.** YouTube's API policies forbid caching or storing its audiovisual content, so it can't work offline. Embedding needs a WebView dependency and brings YouTube tracking. The watch has **no WKWebView**. wger's CC videos cover only 4 of the 20 exercises and average about 46 MB each. |
| 9 | **Form cues: write our own**, ≤ 2 per exercise with an external focus (Wulf 2013; Chua et al. 2021). The exercises and ideas themselves are not copyrightable (Bikram, 9th Cir. 2015; US Copyright Office 2012), but the wording is. Don't copy text from ACE, ExRx or NSCA. RepDB tips and wger notes can serve as attributed seeds. |
| 10 | **Recommendation:** a **bundled, curated "RunCoach Strength" catalogue** of about 60 exercises, as JSON with our own IDs, cues and metadata. Images come from workout-guide under CC BY-SA 4.0, with RepDB as a fallback for gaps, plus an in-app **Credits** screen. There are **no runtime third parties**, and it works keyless and offline. |

---

## 2. Source comparison

| Source | Count | Muscle / equipment metadata | Media | Data / text licence | Media licence | Keyless? | Bundle offline? | Size |
|---|---|---|---|---|---|---|---|---|
| **wger** (wger.de API v2) | 912 (all have EN; FR 583, DE 629, **NL 49**) | Primary and secondary muscles (Latin + EN, with front/back SVG muscle maps), 12 equipment types, 8 categories, variation groups | 374 images across 273 exercises (266 photo, 96 line, 41 AI-flagged); 78 videos across 46 exercises | Per exercise: CC-BY-SA 4 (759), CC-BY-SA 3 (132), CC0 (21) | Per image: CC-BY-SA 4 (286) / CC-BY-SA 3 (88); videos CC-BY-SA 4 | Yes (public GET, no key; verified in spike) | Yes (snapshot the JSON + images, keep the per-item licence and author) | Originals 225 MB; 400 px thumbs ≈ 49 KB each (≈ 18 MB total); videos 3.57 GB |
| **free-exercise-db** (yuhonas) | 876 | primaryMuscles (17), secondary, equipment (13), level, force, mechanic, category | 1,746 JPGs (2 per exercise, 850×567, ≈ 58 KB) | Unlicense (public domain dedication) | **No valid licence.** Upstream: images *"scrapped off the internet"*; possible bodybuilding.com / ExRx sources | Yes | Text yes; **images no** | JSON 1 MB; images ≈ 100 MB |
| **workout-guide** (bryllim) | 302 | primaryMuscle, secondaryMuscles, equipment (17 types incl. Bodyweight 111, Band 19), exerciseType, isStretch | 906 SVG (3 frames per exercise, 512², white line art) + PNG | Metadata MIT | **CC BY-SA 4.0**; per-frame attribution in the manifest: 76 first-pose frames adapted from Everkinetic, the other 830 self-credited to Bryl Lim | Yes | Yes | 26 MB SVG total; about 81 KB per exercise |
| **RepDB free tier** | 601 | primary/secondary muscles (anatomical), equipment, body part, unilateral/bodyweight flags, goals, **tips_en ×3**, instructions EN/DE/ES | 1,138 WebP (start + peak, 512 px flat style, AI-generated) | Custom "Free Tier Licence v1.0" | Same licence: in-app commercial use **with a visible credit**; no dataset redistribution; no genAI derivation | Yes | Yes (in-app use only) | 18 MB total; about 29 KB per exercise |
| **Everkinetic** | 293 | primary, secondary, equipment | 2 images per exercise (PNG/SVG) | CC BY-SA 4.0 (repo) | CC BY-SA 4.0 | Yes | Yes | ≈ 250 MB repo |
| **ExerciseDB / AscendAPI** (RapidAPI, exercisedb.dev) | "11,000+" (V2); 1,500 in the free V1 | Body part, target, secondary, equipment | GIF, MP4, images | Subscription licence, **revocable, ends with the subscription** | Owned by AscendAPI; **no caching beyond "temporary operational limits"** | **No** (key) | **No** | n/a |
| **ExerciseDB.io dataset** (one-time purchase) | 1,394 | As above, plus difficulty and a 17-field movement taxonomy (Pro) | Animated GIF 180²–1080² | Perpetual, platform-neutral commercial licence for "self-hosted data and media files"; whether shipping the GIFs inside a distributed app binary counts as redistribution is **unclear**: read the full licence before buying | Same | Yes, once bought | Yes | $199 Starter / $599 Pro |
| **MuscleWiki API** | 1,943 | Muscles, equipment, 14 languages | 7,766 MP4 (4 per exercise), branded | Commercial on paid plans; text cache ≤ 30 days | **No permanent media storage**; thumbnails cached ≤ 24 h on-device; videos `no-store`; branding must stay | **No** (key; free tier = 500 Playground calls) | **No** | $10 to $199.99/month |
| **API Ninjas Exercises** | "3,000+" | muscle, type, difficulty, equipment, instructions | **None** | Free plan is non-commercial only; paid plans allow commercial use **only while subscribed**; no sharing of output on the free plan | n/a | **No** (key) | Not licensed for it | $0 (non-commercial) to $199/month |
| **hasaneyldrm/exercises-dataset** | 1,324 | Muscles, equipment, 6 languages | 180² GIFs | Text MIT | GIFs **© Gym visual**; its permission covers that repo only, *"cloning this repository does not grant you any license to the media"* | Yes | Text only | n/a |
| NIA (US National Institute on Aging) | Small, older-adult set | n/a | Photos / illustrations | Text **public domain** (credit NIA/NIH) | **Mixed**: some stock photos not licensed for reuse | Yes | Text only | n/a |
| ACE Exercise Library, ExRx.net | Large | Rich | Images / video | **All rights reserved**; ExRx licenses its content for apps at a fee | Same | n/a | Only via a paid licence | n/a |

**What this means for RunCoach:** only wger, workout-guide, Everkinetic and RepDB (with a credit) can be **bundled offline, keyless, and legally distributed** on TestFlight or the App Store. The paid APIs contradict both the "keyless" and the "local-first" constraints. They would also be **new runtime third parties** that receive the device's IP and request patterns.

---

## 3. Licence obligations per source, exactly

### wger
- **The code is AGPL-3.0-or-later; the data isn't.** The repo README says: *"Application Code: AGPL-3.0-or-later; Exercise/Ingredient Data: Creative Commons (see individual entries)"*. We would use neither the code nor a modified wger server, so **AGPL creates no obligation for RunCoach**.
- **The data is licensed per record.** Each exercise has `license` + `license_author`. Each translation has its own `license_author` and `author_history`. Each image and video has its own `license`, `license_author` and `is_ai_generated`. Licence IDs: 1 = CC-BY-SA 3, 2 = CC-BY-SA 4, 3 = CC0, 4 = CC-BY 4, 5 = ODbL. So a bundled snapshot **must carry these fields through** and show them.
- **CC BY-SA obligations:**
  - **Attribution** (creator, notice, licence link). This "may be satisfied in any reasonable manner based on the medium", so a Credits screen plus a per-exercise "ⓘ" works.
  - **ShareAlike** applies **only to Adapted Material** that we share, e.g. edited descriptions or recoloured images. Those must stay CC BY-SA. Placing unmodified items in the app doesn't relicense the app.

### free-exercise-db
- **The JSON is fine:** the Unlicense dedicates it to the public domain.
- **The images are not.** Upstream `wrkout/exercises.json` CONTRIBUTING.md: *"these have been scrapped off the internet, therefore l do not own the copy right … advise against using them in comercial projects"*. Issue #13 on yuhonas (2026-08) points to ExRx as a source, and the maintainer is considering placeholders.
- **The instruction text's provenance is unverified.** No match was found in the spike's single phrase search, but the text is a derivative of the same scrape. Treat it as **low-confidence**. It's fine as a *seed* for rewording, not for verbatim bundling.

### workout-guide
- **The code and manifest are MIT.** The assets are **CC BY-SA 4.0** (LICENSES.md).
- **76 first-pose frames are adaptations of Everkinetic** (CC BY-SA 4.0). The other **830 of 906 frames** (all frames 2 and 3, plus the first poses of the 226 exercises without an Everkinetic source) are credited to Bryl Lim with no upstream source (manifest recount: 302 exercises × 3 frames; only frame 1 of 76 exercises carries a `source`). The manifest carries per-frame `attribution` objects, so we can generate credits automatically.
- **Recolouring for light mode is an adaptation.** The art is white-on-transparent. Recoloured files must be shared under CC BY-SA 4.0, which is fine because we'd publish them unchanged in spirit.
- **Risks:**
  - The repo is only about 5 weeks old (1.3k stars).
  - The provenance of the non-Everkinetic frames is only self-declared ("regenerate them from a compatible source export"). Before shipping, ask the author what that source is.

### RepDB free tier
- **Obligations:**
  1. A visible **"Exercise data by RepDB (repdb.co)"** link in About/Credits.
  2. **No republishing** of the dataset, or of a derived dataset, as a dataset or API. In-app use only.
  3. Images may be resized, cropped or recoloured.
  4. **No generative-AI use** of the images.
  5. The `premium-samples/` animations are evaluation-only.
- **Fit with our model:** a bundled catalogue inside the app counts as in-app use. We must not publish our merged JSON (e.g. in a public repo) as a dataset. That's fine, since RunCoach's repo isn't public.

### ExerciseDB / AscendAPI (RapidAPI)
- The licence is *"non-exclusive, non-transferable, and revocable"* and limited to the subscription period.
- *"Any storage or caching of content beyond the permitted temporary operational limits is a violation."*
- MuscleWiki also claims that ExerciseDB V2 media URLs rotate weekly and that free-tier videos are watermarked. That's a competitor's claim, not verified.
- **Verdict: incompatible** with offline use.

### ExerciseDB.io (one-time dataset)
- A perpetual, platform-neutral commercial licence for "self-hosted data and media files" ([pricing](https://exercisedb.io/pricing), re-checked 2026-09-29). The pricing page does **not** clearly say that bundling the GIFs inside a distributed app binary is allowed rather than counted as redistribution.
- **A viable paid option** ($199 / $599) if Geert wants GIF animations.
- Note: the FAQ didn't state any attribution rules. Check the full licence before buying.

### MuscleWiki
- Commercial use is allowed on paid plans.
- The legal docs **must** include *"Exercise data and videos provided by MuscleWiki.com"*.
- **No permanent media storage**: videos may only be buffered transiently. **Verdict: incompatible** with offline watch/phone use.

### API Ninjas
- **The free plan is non-commercial only.** Paid plans allow commercial use only while subscribed, and you must *"immediately cease all commercial use"* after cancelling.
- There's **no media**. **Verdict: no value** over wger.

### App Store FairPlay and CC BY-SA
- **CC's own 4.0 discussion archive flags a possible conflict:** distributing CC content inside FairPlay-protected iOS apps may count as an "effective technological measure".
- **CC 4.0 didn't resolve this with a parallel-distribution rule.** Instead the licensor waives the right to forbid circumvention.
- **This is an open, untested question.** The mitigation is common practice: link to the unencumbered source repo from the Credits screen. **Flag for the reviewer** as a residual risk, low for a personal or TestFlight app.

---

## 4. Spike: the "runner core 20" against four open sources

**Method.**
- Pulled the full datasets:
  - free-exercise-db `dist/exercises.json`;
  - the wger `/api/v2/exerciseinfo/` (5 pages × 200, **no key needed**);
  - the workout-guide `manifest.json`;
  - the RepDB `exercises.json`.
- Matched names with curated regexes (`runner20.py`).
- "Img" means the matched exercise has at least one image.

| Runner core 20 | free-exercise-db | wger | workout-guide | RepDB free |
|---|---|---|---|---|
| Goblet squat | ✔ | ✔ | ✔ | ✔ |
| Bulgarian / RFE split squat | ✘ (only generic/jump "Split Squats") | ✔ | ✔ | ✔ |
| Reverse lunge | ✔ | ✔ | ✔ | ✔ |
| Step-up | ✔ | ✔ | ✔ | ✔ |
| Single-leg squat / pistol | ✔ | ✔ | ✔ | ✔ |
| Romanian deadlift | ✔ | ✔ | ✔ | ✔ |
| Single-leg RDL | ✔ | ✔ | ✔ | ✔ |
| Trap/hex-bar deadlift | ✔ | ✘ | ✔ | ✔ |
| Hip thrust | ✔ | ✔ | ✔ | ✔ |
| Single-leg glute bridge | ✔ | ✔ no img | ✔ | ✔ |
| Standing calf raise | ✔ | ✔ | ✔ | ✔ |
| Single-leg calf raise | ✘ | ✔ no img | ✔ | ✔ |
| Seated calf raise (soleus) | ✔ | ✔ no img | ✔ | ✔ |
| Nordic hamstring curl | ✔ (as "Natural Glute Ham Raise") | ✔ no img | ✔ | ✔ |
| **Copenhagen plank** | ✘ | ✔ no img | ✔ | ✘ |
| Front plank | ✔ | ✔ | ✔ | ✔ |
| Side plank | ✔ | ✔ no img | ✔ | ✔ |
| Dead bug | ✔ | ✔ no img | ✔ | ✔ |
| Pallof press | ✔ | ✔ | ✔ | ✔ |
| Box jump | ✔ | ✔ no img | ✘ | ✔ |
| **Present / with image** | **17 / 17** (images unusable) | **19 / 11** | **19 / 19** | **19 / 19** |

**Extras** (runner prehab and plyos):

| Extra | free-exercise-db | wger | workout-guide | RepDB free |
|---|---|---|---|---|
| Pogo / ankle hops | ✘ | ✘ | ✘ | ✘ |
| Tibialis raise | ✘ | ✔ no img | ✘ | ✘ |
| Clamshell | ✘ | ✔ no img | ✔ | ✔ |
| Lateral / monster band walk | ✔ | ✔ no img | ✔ | ✔ |
| Bird dog | ✘ | ✔ | ✔ | ✔ |
| Wall sit | ✘ | ✔ no img | ✔ | ✔ |

- **Union coverage:**
  - workout-guide + RepDB together cover **20/20** core exercises with images: Box jump comes from RepDB, Copenhagen from workout-guide.
  - Pogo hops and tibialis raises need our own entry, text-only at first.
- **Bundle size for the 20-exercise image set:**
  - workout-guide: **1.54 MB** (19 × 3 SVG; largest is the trap-bar deadlift at 218 KB);
  - RepDB: **0.55 MB** (19 × 2 WebP).
  - A 60-exercise catalogue would be **about 5 MB** of SVG, or **about 2 MB** if pre-rasterised to WebP/PNG. The watch needs only one small PNG per exercise, about 10–20 KB at 150 px, so **about 1 MB**.
- **wger's 11 runner images, by licence:**
  - all are **CC-BY-SA 4**;
  - 3 of 11 are flagged `is_ai_generated` with an empty author (Step-ups, Romanian Deadlift, Pallof Press);
  - the rest are "Photo" style, so the visual style is **inconsistent** next to line art.
- **Data-quality notes:**
  - **free-exercise-db:** "Split Squats" is really a *jumping* split squat, categorised as `stretching` with primary muscle = hamstrings. Its metadata needs curation.
  - **wger** has left/right duplicates ("Bulgarian split squats left/right"). Descriptions vary in quality; the Nordic Curl description is marketing copy, not instructions. Only **113 of 912** exercises have `notes` (cue-like tips).
- **Visual check:** rendered frames are in `wgsample/`. The workout-guide Copenhagen plank and Nordic curl are clean white line art that reads well on dark backgrounds, which suits the watch. The RepDB Nordic curl (peak frame) is a clean flat-colour illustration.

---

## 5. Video

### YouTube
- **What the policies forbid.** The YouTube API Services Developer Policies, **§III.E.1**, say you *"must not … download, import, backup, cache, or store copies of YouTube audiovisual content"* without written approval. So **offline or pre-cached videos are impossible**.
  - §III.I forbids modifying or obscuring the player and separating audio from video.
  - It also forbids **background playback**.
  - API data may be stored for no more than 30 days.
- **Player requirements.** The IFrame player needs a viewport **≥ 200 × 200 px**; the recommendation is 480 × 270 for 16:9. Inline play on iOS needs `playsinline`.
- **Integration cost.** Embedding in RN needs `react-native-webview`, which isn't in `package.json`. It's a new third party: YouTube can collect playback data on load. Privacy-enhanced mode (`youtube-nocookie.com`) only delays cookies until play.
- **The watch can't play YouTube:** there's no WKWebView on watchOS.
- **Recommendation:** at most, an optional **"Watch a demo ↗" link** that opens the YouTube app or Safari with a curated video ID. That's a plain link, not an embed, so there's no player compliance burden, and it's off the offline path. Curate the IDs by hand, e.g. from reputable physio or S&C channels. The app never plays or stores them.

### Creative Commons video
- **wger videos** are CC-BY-SA 4, but they cover only **4 of the 20** runner exercises (RDL, hip thrust, standing and seated calf raise). They're 1080p HEVC/H.264 averaging **about 46 MB**, which is too heavy to bundle. They could be streamed on demand from wger with credit, but that adds a runtime third party.
- **Wikimedia Commons** is sparse and inconsistent: "Weight training animations" holds 5 files and "Fitness animations" 59, in mixed styles and licences. It's useful ad hoc, not as a library.
- **Pexels** stock video can be used commercially with no attribution; you just can't resell unaltered copies. But the clips aren't instructional or consistent. **Not recommended.**

### Our own animations and illustrations
| Option | Effort | Licence | Notes |
|---|---|---|---|
| **Cross-fade the 2–3 existing frames** (workout-guide 3 frames; RepDB start/peak) | Very low: an `Animated` opacity loop in RN, a SwiftUI `.animation` on the watch (watchOS 6+) | Inherits CC BY-SA / RepDB terms | **Recommended for v1.** Gives a "movement" feel at near-zero cost and is offline. `react-native-svg` 15.8 is already a dependency. |
| SwiftUI/RN **stick-figure keyframes** (Canvas/Path, joint angles per phase) | Medium: about 1 session for a rig, then minutes per exercise | **Ours** | Tiny, themeable, can sync to spoken tempo ("down 3, up 1"). Good for the watch and for the gaps (pogo hops, tibialis raise). |
| **Mixamo** 3D clips → render to MP4/WebP | Medium–high (Blender pipeline) | Royalty-free, commercial use allowed, no attribution; can't redistribute raw files | The fitness catalogue is limited and exercises need retargeting. Overkill for now. |
| Lottie (`lottie-react-native`) | Medium (needs an animator) | Ours, if we author it | Only worth it with a designer. |
| AI-generated video | Low–medium | Unsettled; provider ToS vary | Avoid for now. **Never** use RepDB images as input (their licence term 5). |
| Film ourselves | Medium | Fully ours | Contains personal likeness: **keep out of git** (local-first rule) and bundle via the release build only. |

---

## 6. Form cues and common mistakes

### Sources and whether we can reuse the text
| Source | What it gives | Reuse? |
|---|---|---|
| wger `description` + `notes` | Steps; notes on 113 exercises (e.g. Hip Thrust: "Hold for a second at the top") | Yes, under CC BY-SA with per-exercise credit. Rewording counts as adaptation, so it stays CC BY-SA. |
| RepDB `tips_en` (3 per exercise) | Short, cue-like tips (e.g. "Brace the core before each rep…") | Yes, in-app with the RepDB credit; not as a republished dataset |
| free-exercise-db `instructions` | Long step lists | Unlicense, but the provenance is doubtful. Use as a seed only. |
| NIA exercise guide | Safety-oriented text for basic moves | Public domain text (credit NIA/NIH); images are mixed, so no |
| ACE, ExRx, NSCA, NHS | Expert cues | Read for ideas only. **Don't copy the wording** (ACE and ExRx forbid reproduction; ExRx sells licences). |
| **Our own authoring** | ≤ 2 cues + ≤ 2 "avoid" per exercise | **Recommended.** Exercises, sequences and technique *ideas* aren't copyrightable: Bikram v. Evolation (9th Cir. 2015); US Copyright Office 2012 policy statement that exercise compilations aren't registrable. Only the expression is. Draft at dev time with LLM help, have a human check it, and ship it as bundled JSON. There's no runtime LLM, so it stays keyless. |

### How to write the cues (evidence)
- **Use an external focus.** Direct attention to the *effect* on the environment or implement ("push the floor away", "drive the bar to the ceiling"), not to body parts ("contract your quads"). This improves performance and learning across tasks, including force production and efficiency (Wulf 2013 review; Chua et al. 2021 meta-analysis, *Psychological Bulletin*).
- **Keep them short and single.** ≤ 2 cues per exercise, ≤ 6 words each, which works spoken. **This is a design heuristic** that follows the brief and the constrained-action logic, not a trial-derived number.
- **Pick "avoid" items for runner relevance:** knee caving on single-leg work, hips dropping on side and Copenhagen planks, bouncing on calf raises, lumbar extension on hip thrusts.

### Presentation: phone vs watch
| Surface | Show | Speak |
|---|---|---|
| **Phone: exercise sheet** | 3-frame loop; name; sets × reps / load; **2 "Do" cues + 2 "Avoid"**; muscles (chips); equipment; alternatives (home/gym swap); "Watch a demo ↗" (optional link); ⓘ credit | n/a |
| **Phone: in-session** | Big current set, one cue line, rest ring | Same as watch, when the phone owns audio |
| **Watch** | Name (≤ 18 chars, abbreviated), "Set 2/3 · 8 ea · 16 kg", **one** cue line, single static PNG frame (optional, 100–150 px), rest countdown | **At set start:** "Set two of three. Bulgarian split squat, eight each leg. Drive through the front heel." **In rest:** "Thirty seconds", then "Ten", then "Next: set three." **Timed holds only:** one mid-hold reminder ("Hips level"). Rotate cue 1 and cue 2 across sets instead of saying both every set. |

- **Audio routing:** speech uses the existing watch → phone cue path (`RunCoachWatchSyncModule`, `WorkoutEngine.swift`). `AVSpeechSynthesizer` is also available on watchOS 2+ as a fallback. It follows the existing rule that **the phone owns cues when audio is audible**.
- **Data shape** for WS5: `cues: [string, string]`, `avoid: [string, string]`, `spokenName: string`, `watchShortName: string`, `media: {frames: [path], credit: CreditRef}`, `unilateral: bool`, `timed: bool`, `equipment: [...]`, `muscles: [...]`, `sourceRefs: [{src: 'wger'|'workout-guide'|'repdb'|'own', id, licence, author}]`.

---

## 7. Recommendation

**Build a bundled "RunCoach Strength catalogue". Take no runtime dependency on any exercise API.**

1. **Curate about 60 exercises:**
   - the runner core 20;
   - the extras (pogo hops, tibialis raise, clamshell, band walk, bird dog, wall sit);
   - regressions and progressions for each (e.g. split squat → Bulgarian → weighted Bulgarian);
   - a few upper-body and pull moves for balance.
   Tag each one home, bodyweight or gym.
2. **Use our own IDs and schema**, and map from wger UUIDs where useful for metadata. Muscle and equipment are simple facts; we write them ourselves or take them from the MIT/CC0 metadata.
3. **Images: workout-guide (CC BY-SA 4.0) first**, with 3 frames cross-faded. **Fall back to RepDB** (Box jump, and anything else missing) with its credit. Use our own stick-figure for pogo hops and tibialis raises. Pre-rasterise one PNG per exercise for the watch.
4. **Cues: author our own** (2 Do + 2 Avoid, external focus), reviewed once. Store them in the catalogue JSON.
5. **Credits screen** (Settings → About → Exercise media):
   - per-source lines, generated from the `sourceRefs` fields;
   - "Illustrations: Bryl Lim / workout-guide, incl. Everkinetic, CC BY-SA 4.0 (link)";
   - "Exercise data by RepDB (repdb.co)";
   - the wger authors, if any wger text is used.
   Also a per-exercise ⓘ.
6. **Video:** an optional outbound "Watch a demo ↗" link only; no embed.
7. **Before shipping:**
   - (a) ask the workout-guide author about the source of the 830 self-credited frames (all but the 76 Everkinetic first poses);
   - (b) pin a commit hash and vendor the assets, since both workout-guide and RepDB are months old;
   - (c) have the reviewer note the CC-vs-FairPlay residual risk.

- **Effort:** curating and authoring the catalogue takes about **1 session**. The asset import script plus rasterising takes about **0.5 session**. The credits screen takes about **0.25 session**. A stick-figure rig would be about 1 extra session and is optional.
- **Alternative if budget allows:** buy ExerciseDB.io Starter ($199, perpetual) for GIF animations of about 1,400 exercises. It's a better "animation" feel, but a paid third-party asset, and it needs its licence read in full first.

**Open questions for Geert:**
1. Are line art on dark (workout-guide) and flat colour (RepDB) acceptable mixed together, or should we stick to one style? One style means filling the Box jump gap with our own art.
2. Is the optional YouTube link wanted at all?
3. Is filming his own demos off the table, given the privacy rule?

---

## Sources

**Spike data (fetched 2026-09-29)**
- free-exercise-db dataset: https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json
- free-exercise-db repo + Unlicense: https://github.com/yuhonas/free-exercise-db · https://github.com/yuhonas/free-exercise-db/blob/main/LICENSE.md
- free-exercise-db image licence issues: https://github.com/yuhonas/free-exercise-db/issues/2 · https://github.com/yuhonas/free-exercise-db/issues/13
- wrkout/exercises.json CONTRIBUTING ("scrapped off the internet"): https://github.com/wrkout/exercises.json/blob/master/CONTRIBUTING.md
- wrkout image licence issue (bodybuilding.com reverse search): https://github.com/wrkout/exercises.json/issues/305
- wger API (exerciseinfo, license, language endpoints): https://wger.de/api/v2/exerciseinfo/ · https://wger.de/api/v2/license/ · https://wger.de/api/v2/language/
- wger README licence section (AGPL code vs CC data): https://github.com/wger-project/wger/blob/master/README.md
- wger image model (style enum, `is_ai_generated`): https://github.com/wger-project/wger/blob/master/wger/exercises/models/image.py
- workout-guide repo, licences, attribution, manifest: https://github.com/bryllim/workout-guide · https://github.com/bryllim/workout-guide/blob/main/LICENSES.md · https://github.com/bryllim/workout-guide/blob/main/ATTRIBUTION.md · https://raw.githubusercontent.com/bryllim/workout-guide/main/packages/workout-guide/manifest.json
- Everkinetic data (CC BY-SA 4.0): https://github.com/everkinetic/data
- RepDB free dataset + licence: https://github.com/RepDB/exercise-dataset · https://github.com/RepDB/exercise-dataset/blob/main/LICENSE-DATA.md
- hasaneyldrm/exercises-dataset licence and media exception: https://github.com/hasaneyldrm/exercises-dataset/blob/main/LICENSE · https://github.com/hasaneyldrm/exercises-dataset/blob/main/NOTICE.md
- zohar-ui/open-exercise-db (roadmap only, merges free-exercise-db, so it inherits the provenance issue): https://github.com/zohar-ui/open-exercise-db

**Commercial APIs**
- ExerciseDB / AscendAPI on RapidAPI. The page body wasn't retrievable by fetch; the licence and caching quotes come from search-indexed text of this page: https://rapidapi.com/ascendapi/api/edb-with-videos-and-images-by-ascendapi
- ExerciseDB GitHub (AGPL-3.0 API code): https://github.com/ExerciseDB/exercisedb-api
- ExerciseDB.io FAQ and pricing: https://exercisedb.io/faq · https://exercisedb.io/pricing
- exercisedb.dev docs: **not reachable** (expired TLS certificate; v1 docs returned HTTP 429). This is a gap. https://www.exercisedb.dev/docs · https://v1.exercisedb.dev/docs
- MuscleWiki API FAQ, terms, ExerciseDB comparison: https://api.musclewiki.com/faq · https://api.musclewiki.com/api-terms · https://api.musclewiki.com/compare/exercisedb
- API Ninjas Exercises, terms, pricing: https://api-ninjas.com/api/exercises · https://api-ninjas.com/terms · https://api-ninjas.com/pricing
- ExRx terms and licensing: https://exrx.net/Notes/Legal · https://exrx.net/Store/Other/Licensing
- ACE terms of use: https://www.acefitness.org/legal/terms-of-use/
- NIA reuse policy. Fetching it failed (HTTP 405); the summary comes from search-indexed text of this page, so it's a gap to re-check: https://www.nia.nih.gov/about/policies

**Licences and legal**
- CC BY-SA 4.0 legal code (Adapted Material, §3 attribution, ShareAlike): https://creativecommons.org/licenses/by-sa/4.0/legalcode.en
- CC FAQ: https://creativecommons.org/faq/
- CC 4.0 TPM discussion (App Store / FairPlay): https://wiki.creativecommons.org/index.php?title=4.0%2FTechnical_protection_measures
- Bikram's Yoga College v. Evolation Yoga (9th Cir. 2015): https://law.justia.com/cases/federal/appellate-courts/ca9/13-55763/13-55763-2015-10-08.html
- Summary incl. the 2012 Copyright Office policy statement: https://en.wikipedia.org/wiki/Copyright_claims_on_Bikram_Yoga
- Mixamo FAQ: https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html
- Pexels licence: https://www.pexels.com/license/

**Video and platform**
- YouTube API Services Developer Policies: https://developers.google.com/youtube/terms/developer-policies
- YouTube IFrame Player API (200 × 200 minimum, playsinline): https://developers.google.com/youtube/iframe_api_reference
- YouTube embed and privacy-enhanced mode: https://support.google.com/youtube/answer/171780
- Wikimedia Commons categories: https://commons.wikimedia.org/wiki/Category:Fitness_animations · https://commons.wikimedia.org/wiki/Category:Weight_training_animations
- Apple VideoPlayer (watchOS 7+): https://developer.apple.com/documentation/avkit/videoplayer
- AVSpeechSynthesizer (watchOS 2+): https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer
- WKWebView (no watchOS): https://developer.apple.com/documentation/webkit/wkwebview

**Cueing evidence**
- Wulf G. (2013), *Attentional focus and motor learning: a review of 15 years*, Int Rev Sport Exerc Psychol 6:77–104: https://gwulf.faculty.unlv.edu/wp-content/uploads/2018/11/Wulf_AF_review_2013.pdf
- Chua L-K, Jimenez-Diaz J, Lewthwaite R, Kim T, Wulf G. (2021), *Superiority of external attentional focus for motor performance and learning*, Psychological Bulletin: https://www.apa.org/pubs/journals/features/bul-bul0000335.pdf

**Gaps**
- **Reddit** wasn't used; no community sentiment was needed for WS4.
- **exercisedb.dev docs** couldn't be fetched (TLS error / HTTP 429).
- **The RapidAPI page body and NIA policy page** couldn't be fetched directly; their quotes come from search-indexed text.
- **workout-guide's 830 self-credited frames** (of 906; all frames 2–3 plus 226 first poses) have unverified upstream provenance; repo created 2026-08-24.
