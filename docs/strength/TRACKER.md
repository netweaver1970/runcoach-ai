# Strength training: initiative tracker

| | |
|---|---|
| **Initiative** | Strength / resistance training: build, schedule, track, auto-detect, progressive overload, feedback, exercise DB + form cues, spoken cues, RunCoach integration |
| **Date** | 2026-09-29 (overnight research run; output wanted Wed 2026-09-30 morning) |
| **Owner** | Geert (decides); PM agent (plan, tracker, synthesis) |
| **Mode** | RESEARCH ONLY: no app code, no commits, no builds/installs. Spikes only in the session scratchpad `…/scratchpad/strength` |
| **Spec** | [BRIEF.md](/Users/geertsteyaert/projects/runcoach-ai/docs/strength/BRIEF.md) |
| **Deliverables** | `docs/strength/REPORT.md` + private published Artifact page (same content) + this tracker in final state + reviewer sign-off |
| **Artifact page** | https://claude.ai/artifact/Xk63rhLmaSrqRtT2JZWFCZ (private; rev 3 = version 3 (id 1790718429-97e8), after review round 2). Source HTML with the full report markdown embedded: `/private/tmp/claude-501/-Users-geertsteyaert-Claude-iphone---mcp-apple-health-integration/483e295a-fc0e-4f46-900f-6ce14d7f5462/scratchpad/strength/strength-report.html` |
| **REPORT.md** | Written: [REPORT.md](/Users/geertsteyaert/projects/runcoach-ai/docs/strength/REPORT.md) (rev 3, identical to the Artifact's markdown block plus a title line). Rev 1 existed only inside the Artifact HTML because the harness refused the first write |
| **Sister initiative** | [Nutrition REPORT.md](/Users/geertsteyaert/projects/runcoach-ai/docs/nutrition/REPORT.md) (A1–A3, A5 shipped; roadmap says food + strength "later, don't start unprompted") |

## Workstreams

| WS | Topic | Owner | File | Status | Acceptance criteria (from the brief) |
|---|---|---|---|---|---|
| WS1 | Market analysis | Market agent | `ws1-market.md` | Done | All 17 named apps (Strong, Hevy, Fitbod, JEFIT, Caliber, Future, Ladder, StrengthLog, Boostcamp, Alpha Progression, RP Hypertrophy, SmartGym, Gymaholic, Fitness+ strength, WHOOP Strength Trainer, Garmin strength, Runna strength) + ≥1 other runner-focused programme; feature matrix (taps per set, templates, repeat-last, supersets, rest timer, watch-side logging, auto-detect, pricing/free tier); love/hate from App Store reviews (Apple RSS) + vendor forums with URLs, Reddit labelled as a gap if unreachable; "10 things that make strength logging stick" |
| WS2 | Auto-detection feasibility | Sensors agent | `ws2-detection.md` | Done | What watchOS offers, cited to Apple docs: CMMotionManager rates, CMBatchedSensorManager (watchOS 10+, which models incl. Ultra 1), HKWorkoutActivityType traditional/functional strength, whether Apple auto-detects strength or counts reps; ≥3 peer-reviewed IMU rep-count/recognition papers with per-exercise accuracy + wrist-placement limits; WHOOP/Garmin/SmartGym claims vs evidence; Create ML activity classifier path; realistic scope for Ultra 1 (watchOS 26) + iOS 27; low-tech fallback; `beginNewActivity` risk flagged, structure-as-metadata-at-finish proposed; optional scratchpad spike |
| WS3 | Planning, overload, load, feedback | Coaching agent | `ws3-coaching.md` | Done | Cited evidence: heavy + plyometric work → running economy, injury prevention, frequency, concurrent-training interference; scheduling rules vs run plan (not before quality, hard days hard, ~48 h per muscle group); overload models (linear, double progression, RPE/RIR, undulating) + deloads aligned to the app's build/deload cycle; Foster session-RPE × duration → TRIMP/CTL/ATL mapping with a worked number; feedback loop (sRPE, per-set RIR, next-morning soreness, too easy/just right/too hard → next-session rule); all rules deterministic (keyless) |
| WS4 | Exercise DB, media, form cues | DB agent | `ws4-exercise-db.md` | Done | wger (code vs data licence), yuhonas free-exercise-db, ExerciseDB (RapidAPI, GIF rights), MuscleWiki, API Ninjas + others: coverage, muscle/equipment metadata, media, **exact licence per asset type (commercial use, attribution, share-alike)**, offline bundling; YouTube embed ToS, CC video sources, own illustrations/animations; form-cue sources + phone vs watch presentation; spike: pull a runner-relevant 20-exercise set from ≥1 open source, report hit rate + bundle size |
| WS5 | UX + RunCoach integration | Integration agent | `ws5-ux-integration.md` | Done | Text wireframes: builder (templates, "strength for runners" presets, home/bodyweight/gym filter), schedule into Daily Coach / 7-Day Plan / season plan / `.ics`, watch strength mode (set + rest timers, spoken cues via SpeechCue + phone earbud routing, haptics, HR), post-workout feedback; tap counts **repeat workout ≤3, set ≤2**; local-first data model; HK write (strength workout, duration, energy, metadata at finish); `backup.ts` + `appModel.ts` entries; reuse of `workoutLibrary.ts` + `coach-athlete.tsx`; keyless path for every flow |
| WS6 | PM synthesis | PM agent | `REPORT.md` + Artifact | Done: rev 3 in REPORT.md + Artifact (same URL, version 3) after review round 2 | The 8 brief sections present; Options A/B/C each with scope, effort (build sessions), risks incl. watch-gate + Health re-approval cost; recommendation; decision list; nutrition overlaps section (shared UX, Food + Strength roadmap, body composition in Biology); every factual claim cited |
| WS7 | Review | Review agent | this file, "Review sign-off" | Round 1: FIX, 10 issues, fixed in rev 2. Round 2: FIX, 4 issues (1 MED, 3 LOW), fixed in rev 3. Round 3 re-check pending | Sources real + cited; licence/ToS/video/image rights accurate; watch sensor + rep-count claims correct; nothing requested missing; all flags fixed by PM before publish |

## Key questions per workstream

- **WS1:** Which apps log a set in 1–2 taps, and how (pre-filled from last time, swipe to complete)? Which watch apps log independently of the phone? What do users hate most: paywalled basics, forced AI programmes, sync loss, bad watch UX? Is anything runner-specific actually good?
- **WS2:** Does any Apple API detect strength exercises or count reps (no, as far as known: confirm with Apple docs)? Does the Ultra 1 support CMBatchedSensorManager high-rate data on watchOS 26? Which lifts are realistic on a wrist (upper-body pulls/presses vs squats/deadlifts)? What accuracy do Garmin and WHOOP really achieve? Battery cost of 100 Hz+ capture for 45 min?
- **WS3:** How much strength is enough for a runner (sets/week, 2×/wk)? Where does a strength day go relative to intervals and the long run? How should sRPE load convert into the app's TRIMP currency without double-counting the HR-TRIMP already taken from the HK workout? How do strength deloads line up with the running build/deload weeks?
- **WS4:** Which DB has a data **and** media licence that allows bundling in a TestFlight/App Store app? Can images be bundled offline, and how large? Are wger images mixed-licence per image? Is ExerciseDB GIF use restricted to the API subscription? Where do short, reliable form cues come from without copying copyrighted text?
- **WS5:** New `strength` kind in the existing workout library or a separate store? How does the Daily Coach `strength` text field become a structured, loggable session? Can a watch strength session reuse `WorkoutEngine` (HKWorkoutSession + SpeechCue + `lap()` = next set) without touching the run path? What is the minimum watch change, given the review gate?

## Cross-workstream dependencies

| From | To | What flows |
|---|---|---|
| WS2 | WS5, WS6 | Realistic detection scope → watch UX (manual lap vs auto) and whether Option C is credible |
| WS3 | WS5 | Scheduling + overload + feedback rules → planner hooks, post-workout screen, next-session targets |
| WS4 | WS5 | Chosen DB + media licence → exercise picker, bundle size, what the watch shows/speaks |
| WS1 | WS5, WS6 | "10 things that stick" + tap counts → UX targets and Option scoping |
| WS3 | WS2 | Which exercises matter for runners → which ones detection must cover |
| WS1–5 | WS6 → WS7 | All findings → REPORT.md + Artifact → review |

## What the code skim shows (for the specialists)

| Area | Current state | File |
|---|---|---|
| Coach plan | `CoachPlan.strength` is a free-text string (≤22 words); keyless default = calf raises, single-leg squats, hip bridges, side plank | [coach.ts](/Users/geertsteyaert/projects/runcoach-ai/src/services/coach.ts) (`STRENGTH_DEFAULT`) |
| Load | HK strength workouts (types 20, 50) count at a flat factor 0.6 on the HR-based load; a `muscularLoad` parameter exists in the strain model | [trainingLoad.ts](/Users/geertsteyaert/projects/runcoach-ai/src/services/trainingLoad.ts) |
| Sport filter | Strength falls into the `Other` category | trainingLoad.ts `activityCategory` |
| Workout library | Run-only kinds (`intervals…custom`), `WatchWorkoutBlock` shape (minutes, HR zone), backed up | [workoutLibrary.ts](/Users/geertsteyaert/projects/runcoach-ai/src/services/workoutLibrary.ts) |
| Calendar | `.ics` export covers season-plan weeks only (all-day banners) | [planIcs.ts](/Users/geertsteyaert/projects/runcoach-ai/src/services/planIcs.ts) |
| Watch | `WorkoutEngine` owns an HKWorkoutSession (run types), segments, `lap()`, countdown cues; `SpeechCue` routes watch→phone, falls back to watch speaker | [WorkoutEngine.swift](/Users/geertsteyaert/projects/runcoach-ai/targets/watch/WorkoutEngine.swift), [RouteView.swift](/Users/geertsteyaert/projects/runcoach-ai/targets/watch/RouteView.swift) |
| Structure | No in-session `beginNewActivity` (removed 2026-09-25); executed structure goes to the phone via `sendExecStructure` | WorkoutEngine.swift lines ~57–63 |
| Backup | Flat `FILES` list; a new strength file must be added there | [backup.ts](/Users/geertsteyaert/projects/runcoach-ai/src/services/backup.ts) |
| LLM facts | Single `appModel.ts` block; strength facts go there, not in prompts | [appModel.ts](/Users/geertsteyaert/projects/runcoach-ai/src/services/appModel.ts) |

## Open questions

1. Does Geert want **auto-detection** badly enough to accept "upper-body only, roughly right" accuracy, or is a fast manual log with a lap button enough?
2. Should strength sessions be recorded by **our watch app** (new HKWorkoutSession mode, watch-gate cost) or by Apple's Workout app / another app with RunCoach only **reading** HK strength workouts?
3. Does strength load enter CTL/ATL as **sRPE-derived TRIMP**, replace the flat 0.6 factor, or stay a separate "muscular" channel that only affects scheduling?
4. Is the default equipment **home/bodyweight**, **gym**, or both with a filter? What home kit exists (dumbbells, kettlebell, bands, box)?
5. Is body composition an explicit goal to plan for (volume/hypertrophy), or only a Biology read-out?
6. Media: bundle open images offline, draw our own simple illustrations, or text-only cues first?
7. Should spoken cues include **form reminders** per set, or only name, target, rest countdown?
8. Is there a human coach who would prescribe strength via `coach-athlete.tsx`, or is that out of scope?
9. Does the strength builder extend `workoutLibrary.ts` (new `kind`) or live in its own store and screen?
10. Is next-morning soreness a new daily check-in, or folded into the existing Timeline/Status?

## Decisions needed from Geert (draft; SUPERSEDED by the final list D1–D17 in REPORT.md §8 / Artifact §8)

| # | Decision | Default the PM will assume if unanswered |
|---|---|---|
| D1 | Go/no-go for strength now vs after food (roadmap order) | Research only; no build until Geert says go |
| D2 | Option A / B / C | A (no watch change), then decide on B after 2–3 weeks of use |
| D3 | Recorder: our watch strength mode vs HK read-only | HK read-only in A; watch mode in B |
| D4 | Auto rep counting / exercise detection | Out of A and B; spike-gated in C |
| D5 | Load model for strength | sRPE × duration, mapped to TRIMP units, replacing the flat factor |
| D6 | Equipment set + default location | Both, filterable; home default |
| D7 | Media source + licence posture | Only permissive/open licences, attribution screen; no scraped GIFs |
| D8 | Spoken cue content | Name, sets×reps/load, rest countdown; form cue optional per exercise |

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Watch review gate** blocks every watch install/OTA until the regression reviewer returns SHIP | Each watch-side change costs a review round plus a USB install session | Keep A phone-only; batch all watch work into one B build |
| **Health re-approval** after every watch reinstall (watch shows no Health sheet; approve in the iPhone Health app) | A missed re-approval silently loses HR / workout saves | Checklist step after each install; the existing auth-issue banner in `WorkoutEngine` |
| **`beginNewActivity` killed a live HK session (2026-09-25)** | Per-exercise/per-set activities could fail the whole strength recording | No in-session activity APIs; write exercise/set structure as metadata at finish or send it to the phone like `sendExecStructure` |
| **Licence of GIFs/videos/images** | Takedown or App Store rejection if distributed (TestFlight exists) | WS4 exact per-asset licence table; reviewer checks; attribution screen; no YouTube re-hosting |
| **Rep-counting accuracy on a wrist** | Wrong counts erode trust faster than no counts; lower-body lifts are weak on a wrist sensor | Treat as optional suggestion with one-tap correction; Option C only, after a spike |
| **Scope vs roadmap** | Strength competes with the "better planning/coaching" north star and food | Frame strength as a coaching feature (runner support); small A; Geert decides order (D1) |
| **Double-counting load** | HK strength workouts already add load at factor 0.6 | One load path per workout (WS3 rule) |
| **Keyless constraint** | LLM-generated programmes would break keyless use | Deterministic templates + overload rules; LLM only phrases |
| **CPU watchdog on the watch** | High-rate motion processing can hit the 80 %/60 s CPU limit | Batched sensor capture, throttled processing (WS2) |

## Review sign-off

| Round | Reviewer | Verdict | Findings | PM fixes |
|---|---|---|---|---|
| 1 | Review agent (WS7) | **FIX** (3 MED, 7 LOW) | See the issue table below | All 10 fixed in rev 2 (2026-09-29) |
| 2 | Review agent (WS7) | **FIX** (1 MED, 3 LOW) | See the round 2 table below | All 4 fixed in rev 3 (2026-09-29) |
| 3 | (pending) | | Re-check of rev 3 | |

**Round 1: what the reviewer checked** (report read as the Artifact's markdown block, because REPORT.md did not exist yet; checked against BRIEF, TRACKER and ws1–ws5):

- **Device facts, verified:** WWDC23 10179 (CMBatchedSensorManager 800 Hz accel / 200 Hz device motion, 1 batch/s, active HK workout only, "Series 8 and Ultra"); Apple doc JSON gives watchOS 10.0 minimum; MacRumors on watchOS 27 dropping the Ultra 1; Apple Newsroom limiting Double Tap to Series 9 / Ultra 2; WKInterfaceDevice.play haptics pausing HR; Sasquatch on relateWorkoutEffortSample; AppleInsider on watchOS 27 set-level data.
- **Licence/ToS, verified:** wger (AGPL code, per-entry CC data; 912 records = 759 CC BY-SA 4 / 132 CC BY-SA 3 / 21 CC0; 374 images on 273 exercises; 78 videos); free-exercise-db Unlicense with images "scrapped off the internet"; workout-guide (MIT, CC BY-SA 4.0 art, 302 exercises, 76 Everkinetic frames); RepDB free tier terms; MuscleWiki, API Ninjas, ExerciseDB.io pricing; YouTube §III.E.1.
- **Accuracy/evidence, verified:** RecoFit, Soro 2019, Garmin FR265 manual, Oberhofer 2021 (StrengthControl), LEAN, the5krunner (WHOOP), Runna.
- **Coaching citations, verified via Europe PMC:** Blagrove 2018, Llanos-Lagos 2024a/b, Desai 2023, Wewege 2022, Spiering 2021, Schumann 2022, Alcaraz 2008, Halperin 2022, Denadai 2017, ACSM 2026.
- **Codebase facts, verified:** strength types 20/50 at 0.6; muscularLoad paths l.2266 / l.3919; TrimpRepair / computeStrainTrimp semantics; DEFAULT_TRIMP_RATES (k ≈ 0.41); DEFAULT_PERIODIZATION 3+1; coach.ts l.789 gym regex; Workouts share in healthkit.ts; saveWorkoutSample unused; NextSegmentIntent; beginNewActivity removed in 49f46ac; FILE_PREFIXES / STATIC_SECURE_KEYS; docs/nutrition/REPORT.md.
- **Completeness vs Geert's request:** all asks covered; Reddit gap labelled; beginNewActivity risk flagged.
- **Not verifiable by the reviewer:** Brennan 2025 full text (PMC bot-blocks), StrengthControl per-exercise percentages, MuscleWiki/RepDB media counts.

**Round 1: issues and corrections**

| # | Sev | Where | Issue | Correction (rev 2) |
|---|---|---|---|---|
| 1 | MED | Deliverable | `docs/strength/REPORT.md` did not exist | Written from the Artifact's markdown block with all fixes; header row updated |
| 2 | MED | Report §6.5, WS5 row 5 + source list | "Wrist HR under-reads ~7 bpm in lifting" cited to Ho 2022 (a cardiopulmonary-test study that found Apple Watch HR accurate) | Re-cited to Zhang et al. 2020, J Sports Sci 38(17):2021–2034, https://doi.org/10.1080/02640414.2020.1767348 (MD −7.26 bpm, 95 % CI −10.46 to −4.07; abstract re-read via Europe PMC) in the report and WS5 |
| 3 | MED | Report §1, §3.2; WS2 summary + table | Brennan 2025 one-sided; "hands must move with the load" attributed to RecoFit/Soro | Rewritten: wrist IMUs classify well, lower body included, but all 49 models high risk of bias, gym/lab data, no free-living validation; rep counting on still-hands moves unproven; Garmin says leg reps may not count. "49 models all high risk of bias" and "0.0–0.59 per rep" **confirmed in the Europe PMC full text** (PMC12513948). Hands claim labelled **our inference** |
| 4 | LOW | Report §4.4, §6.8, A6 | Load pseudo-code skipped code gaps | §4.4 notes a–c: window HR-TRIMP helper + non-power repair branch (loop gated on `p2h && windows.length`, l.3521); per-day eviction of `cardio-trimp-cache.json` (`TRIMP_RECOMPUTE_TAIL = 2`, l.3546) when a rating/tag lands; both `muscularLoad` paths (l.2266, l.3919). Folded into A6 scope/tests and §6.8 |
| 5 | LOW | Report §3.2, WS2 table | LEAN "single user" | n = 3 volunteers on an Apple Watch Series 5 (+1 for video validation), 3 arm exercises; both miscounts on the shoulder press (verified in the full text) |
| 6 | LOW | Report §3.2, WS2 summary | Garmin forum cited for "zero leg reps" | Reworded: firmware regressions (0 reps on pull-ups/push-ups, counts dropping mid-set); leg limit attributed to the manual |
| 7 | LOW | Report §3.1 | Workout Buddy missing; Ultra 1 support implicit | Workout Buddy row added (Apple Support + Newsroom; strength types supported, needs Apple Intelligence iPhone + headphones, no rep counting); CMBatchedSensorManager row: "watchOS 10+; the Ultra 1 qualifies, since it was the only Ultra in 2023" |
| 8 | LOW | Report §5.1, WS4 table + section | ExerciseDB.io "bundling allowed" overstated | Pricing page re-fetched: only "self-hosted data and media files", "platform-neutral commercial license". Cell now says in-app bundling vs redistribution is unclear; read the full licence before buying |
| 9 | LOW | Report §4.2 S2, D7 | Runna's opposite placement not flagged | Line under S2 quoting Runna ("Easy run days or rest days", re-fetched) vs hard-days-hard (Doma & Deakin, Schumann); D7 extended; optional toggle offered |
| 10 | LOW | Report (missing) | No consolidated third-party/privacy list | New §10 "Third parties and privacy" (content licensors, Apple HK/WorkoutKit, Motion, YouTube link, C3 cloud sync off by default); restates no personal data in git; review notes moved to §11 |

**Round 2: what the reviewer checked** (REPORT.md rev 2 in full, 619 lines, and the live Artifact version 2, whose markdown matched):

- **Licence/ToS, re-verified:** wger README + spike recount (912 records = 759 CC BY-SA 4 / 132 CC BY-SA 3 / 21 CC0; 374 images on 273 exercises; licence ids 1 = CC BY-SA 3, 2 = CC BY-SA 4 via wger.de/api/v2/license); free-exercise-db Unlicense + upstream "scrapped off the internet"; workout-guide LICENSES.md + ATTRIBUTION.md + **manifest recount (issue 1)**; RepDB LICENSE-DATA.md; MuscleWiki api-terms (issue 4); API Ninjas terms; ExerciseDB.io pricing; AscendAPI caching clause (search-indexed only); hasaneyldrm NOTICE; YouTube §III.E.1; CC wiki on TPMs vs app-store DRM.
- **Device facts, re-verified:** WWDC23 10179 (Ultra 1 qualifies; CMMotionManager max 100 Hz); MacRumors watchOS 27 device drops; Double Tap Series 9 / Ultra 2; Workout Buddy support page; AppleInsider watchOS 27 (unconfirmed, labelled); Sasquatch workoutEffortScore; local grep of the iOS 27.0 / watchOS 27.0 HealthKit headers (no rep/set identifiers).
- **Accuracy/evidence, re-verified:** Garmin FR265 quotes; Runna quote; the5krunner; StrengthControl full text (88.4 % overall, n = 30); Brennan 2025 full text; Zhang 2020 (MD −7.26 bpm); all 16 PubMed IDs against Europe PMC (Blagrove, Llanos-Lagos, Desai, Wu, Wewege, Halperin, ACSM 2026).
- **Codebase facts, re-verified:** trainingLoad.ts 20/50 at 0.6; TrimpRepair / computeStrainTrimp; healthkit.ts l.2266, l.3521, l.3546; DEFAULT_TRIMP_RATES k ≈ 0.41; DEFAULT_PERIODIZATION 3+1; coach.ts l.789; activity floor below HR-TRIMP for a 45-min lift; watch-gate hook paths exclude runcoach-workout (B1 holds); WorkoutKit spike output (macOS SDK, labelled).
- **Completeness vs Geert's request:** all asks present; Reddit gap labelled; beginNewActivity risk flagged.

**Round 2: issues and corrections**

| # | Sev | Where | Issue | Correction (rev 3) |
|---|---|---|---|---|
| 1 | MED | Report Known gaps, §5.1, Option A risks (§7), §10, D10; WS4 key finding 4, table, §workout-guide, credits step (a), gaps | "226 non-Everkinetic frames" is an exercise count, not a frame count; understated unverified provenance ~3.7×; repo age missing from the report | PM recounted `scratchpad/strength/wg_manifest.json`: 302 exercises, 906 frames, 76 frames with a `source` (all frame index 1). Everywhere now: "906 frames: 76 first-pose frames adapted from Everkinetic (CC BY-SA 4.0), the other 830 self-credited to Bryl Lim (all frames 2–3 + first poses of 226 exercises)"; ask the author about all 830; "repo created 2026-08-24" added to the §5.1 risk and Known gaps |
| 2 | LOW | Report §3.2 LEAN row, §11 round-1 row 5; WS2 table | "n = 3" conflated the TestFlight form-analysis survey with the rep-count benchmark | Re-read the full text (`scratchpad/strength/lean.xml`, §4.3 + §4.5): rep count was one side-by-side test, two Apple Watches on the same wrist, 3 exercises × 3 sets of 8/10/12; LEAN 2 misses, Gymatic 3, all −1; wearer count not stated. Row now reads "2 miscounts in 90 reps (Gymatic 3) … Series 5; 3 arm exercises; misses on the shoulder press"; "n = 3" dropped. Round-1 row 5 in the report marked as superseded |
| 3 | LOW | Report §1 bullet 3, §4.1 evidence table (Injuries row); WS3 summary + Desai/Wu rows | Desai 2023 is observational; 85 % is a self-selected subgroup; overall p = 0.31; "adherence UX is the intervention" overstated | Abstracts of Desai 2023 (PMID 36630577) and Wu 2024 (PMID 38261240) re-read via the Europe PMC API. Text now says observational, self-selected high-compliance subgroup, overall not significant (p = 0.31), healthy-adherer bias possible; softened to "adherence is the most plausible lever", citing Wu's supervised-only post hoc ("possibly due to increased compliance") |
| 4 | LOW | Report §5.1 MuscleWiki row | "Credit line required" imprecise | api.musclewiki.com/api-terms re-fetched: the ToS/Privacy Policy must carry "Exercise data and videos provided by MuscleWiki.com"; videos must keep the in-video mark; in-app credit link "appreciated but voluntary"; playback only from API-streamed URLs. Cell now "credit in legal documents + keep in-video branding; streaming-only playback"; verdict (incompatible) unchanged. WS4 already stated this precisely |

## Change log

| Date | Change |
|---|---|
| 2026-09-29 | Tracker created by PM: 7 workstreams, acceptance criteria, key questions, dependencies, code-skim facts, 10 open questions, draft decisions D1–D8, risks |
| 2026-09-29 | WS1–WS5 done (market, detection, coaching, exercise DB, UX/integration files in `docs/strength/`) |
| 2026-09-29 | PM synthesis rev 1: 10-section report (8 brief sections + nutrition overlaps + review notes), Options A ~8–8.5 / B +5.5–7 / C +6–8 sessions, decisions D1–D17, 7 workstream conflicts resolved (§7.2). Published as private Artifact https://claude.ai/artifact/Xk63rhLmaSrqRtT2JZWFCZ. REPORT.md write refused by the harness; content embedded in the Artifact source HTML. Review round 1 pending |
| 2026-09-29 | Review round 1: verdict FIX (3 MED, 7 LOW). PM rev 2 fixed all 10: REPORT.md written, Ho 2022 → Zhang 2020, Brennan balanced (figures confirmed in Europe PMC full text), §4.4 code-gap notes a–c + A6 scope, LEAN n = 3, Garmin forum wording, Workout Buddy + Ultra 1 row, ExerciseDB.io licence softened, Runna divergence under S2/D7, new §10 Third parties and privacy. WS2, WS4, WS5 files corrected. Artifact republished to the same URL (version 2). Round 2 pending |
| 2026-09-29 | Review round 2: verdict FIX (1 MED, 3 LOW). PM rev 3 fixed all 4: workout-guide provenance restated as 76 Everkinetic first poses vs 830 self-credited frames of 906 (manifest recounted; repo created 2026-08-24), LEAN rep test described as one side-by-side two-watch test (n = 3 dropped), Desai caveated as observational/self-selected with Wu 2024 post hoc and "most plausible lever", MuscleWiki credit wording made precise. WS2, WS3, WS4 corrected. Artifact republished to the same URL (version 3, id 1790718429-97e8), markdown identical to REPORT.md from line 5. Round 3 re-check pending |
