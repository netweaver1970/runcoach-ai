# Strength for RunCoach: research report

Published (private): https://claude.ai/artifact/Xk63rhLmaSrqRtT2JZWFCZ

| | |
|---|---|
| **Date** | 2026-09-29 (overnight research run), revision 3, after review rounds 1 (10 fixes) and 2 (4 fixes), see §11 |
| **For** | Geert (decides what gets built) |
| **Mode** | Research only. No app code, no commits, no builds |
| **Inputs** | `docs/strength/`: BRIEF.md · TRACKER.md · ws1-market.md · ws2-detection.md · ws3-coaching.md · ws4-exercise-db.md · ws5-ux-integration.md |

Key sources are cited inline. The workstream files carry the full numbered source lists. "Estimate" marks our own arithmetic, not a measured or published value. Effort is in **build sessions**, estimated by the PM from the workstream estimates.

> **Known gaps**
>
> - **Reddit was not reachable** (reddit.com refuses the fetcher). r/fitness, r/weightroom, r/Hevy and r/running are not covered. App Store reviews (Apple's public review RSS feed, US storefront) and the Garmin forums stand in (WS1, WS2).
> - **Review samples are small and recency-biased.** Hevy and Ladder cover about one week and look inflated by in-app rating prompts. Gymaholic's newest US review is from 2024 (WS1).
> - **Blocked pages:** Fitbod help, Garmin support FAQ, WHOOP pages and Business Wire returned 403; exercisedb.dev had an expired certificate and then HTTP 429; the RapidAPI and NIA pages could not be fetched directly. Those facts come from search-indexed text or third-party write-ups and are labelled in the workstream files. PubMed/PMC/Springer pages were bot-blocked, so WS3 read the abstracts through the Europe PMC API; Taddei 2020 and Eddens 2018 come from search summaries only.
> - **Nothing was tested on a device** (no builds or installs, by rule). Not measured: taps per set in competitor apps, battery and CPU cost of motion capture on the Ultra 1, WorkoutKit strength plans on iOS 27 / watchOS 26 (the spike ran on the macOS 27 SDK), the first JS `saveWorkoutSample` write, and the keep-alive's battery cost in a still gym session.
> - **watchOS 27 set-level strength data** is based on press reports of code, not an Apple announcement, and the Ultra 1 cannot run watchOS 27 anyway.
> - **workout-guide's image provenance is mostly self-declared.** Of its 906 frames, only 76 first-pose frames are adapted from Everkinetic (CC BY-SA 4.0); the other **830 (about 92 %)** are self-credited to Bryl Lim (all frames 2–3, plus the first poses of 226 exercises), and the repo was created on 2026-08-24. **CC BY-SA inside a FairPlay-protected App Store app** is an unsettled legal question (low risk for a personal or TestFlight app).

## 1. Executive summary

- **Build a fast manual logger inside the running plan.** Fast logging is a solved problem: every leader (Strong, Hevy, Boostcamp, Alpha Progression) pre-fills each set from last time, completes it with one tap and starts the rest timer automatically. The gap in the market is that **no app combines Strong-grade logging with a running plan that knows about strength load**. Runna plans strength around runs but keeps it phone-only ([Runna support](https://support.runna.com/en/articles/15624879-adding-strength-training-to-your-runna-plan)). (WS1)
- **Auto-detection is not worth building now.** Apple has no rep or set API (checked in the iOS 27 SDK headers). In the lab, rep counting reaches ±1 rep in about 91–93 % of sets, with a forearm band or an extra ankle sensor ([RecoFit, CHI 2014](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/11/Morris_Workout_CHI_2014.pdf); [Soro 2019](https://doi.org/10.3390/s19030714)). Lab studies classify exercises well from a wrist IMU, lower body included, but all 49 models were lab-built at high risk of bias and none was validated free-living ([Brennan 2025](https://pmc.ncbi.nlm.nih.gov/articles/PMC12513948/)). Rep counting on still-hands moves (calf raises, bridges, planks) is unproven, and Garmin's own manual says "leg exercises may not be counted". The recommendation does not depend on that: RunCoach already prescribes the exercise, so the only friction left is "done, and how many": one tap plus a pre-filled number. (WS2)
- **The coaching case is solid for economy and weaker for injuries.** Strength work improves running economy by 2–8 % ([Blagrove 2018](https://pubmed.ncbi.nlm.nih.gov/29249083/)); heavy plus plyometric work improves time-trial performance most (ES −1.04, [Llanos-Lagos 2024](https://pubmed.ncbi.nlm.nih.gov/38627351/)). In runners, pooled RCTs show no significant injury reduction; supervised programmes did better in a post-hoc analysis, "possibly due to increased compliance" ([Wu 2024](https://pubmed.ncbi.nlm.nih.gov/38261240/)). The 85 % fewer injuries in [Desai 2023](https://pubmed.ncbi.nlm.nih.gov/36630577/) is from a self-selected high-compliance subgroup of an observational study whose overall effect was not significant (p = 0.31), so healthy-adherer bias is possible. **Adherence is the most plausible lever**, which makes logging UX matter. (WS3)
- **Rules, all keyless:** 2 sessions a week, lifted after the run on quality days, no leg work the day before intervals, tempo or the long run, autoregulated double progression at 2 reps in reserve, and strength deloads on the app's existing build/deload weeks. Strength load = session-RPE × minutes × 0.41 into the TRIMP currency, entering CTL/ATL at weight 0.5 through the existing `TrimpRepair` path so nothing is counted twice. Heart-rate TRIMP under-counts a 45-min lift by about 2–3.5× (WS3 spike, estimate).
- **Exercise content: bundle it ourselves.** Every commercial exercise API needs a key and forbids storing its media. Recommended: our own catalogue with images from `bryllim/workout-guide` (CC BY-SA 4.0) and RepDB (free tier, visible credit required), our own form cues, and a Credits screen. No runtime third party. (WS4)
- **Options** (build sessions, estimate):

| Option | What | Sessions | Build type | Watch cost |
|---|---|---|---|---|
| **A · MVP** | Phone logger, presets, catalogue v1, plan placement, sRPE load, 1-tap feedback, HealthKit read + write | **~8–8.5** | All OTA | None |
| **B · Solid v1** | A + phone speech + push to Apple's Workout app + our own manual watch strength mode with spoken cues + calendar | **+5.5–7** (total ~13.5–15.5) | One phone build + one gated watch build | Review gate + Health re-approval |
| **C · Ambitious** | B + motion-assisted set detection (suggestions only) + human-coach prescription + Food/Strength/Biology links | **+6–8** (classifier +3–5 more, not recommended) | Gated watch build + a new Motion permission | Review gate again + Health re-approval |

- **Recommendation:** don't start until Geert gives the go (the roadmap says food and strength are "later"). When he does, build **A**, then the phone-build half of **B** (spoken cues on the phone and the Apple Workout push, no watch gate). Decide on the watch half of **B** after 2–3 weeks of real use. Treat **C** as a menu. The decision list is in §8.

## 2. Market findings

Seventeen named apps plus Gymatic, Nike Training Club, TrainingPeaks and 10W2S were reviewed (WS1 §1). Review statistics come from Apple's public RSS feed, e.g. `https://itunes.apple.com/us/rss/customerreviews/page=1/id=464254577/sortBy=mostRecent/json`.

### 2.1 Feature matrix (condensed; full matrix in WS1 §2)

Taps per set are estimated from documented flows, **not measured on a device**. Prices are US App Store list prices on 2026-09-29.

| App | Model | Taps/set | Pre-fill | Repeat / templates | Auto rest timer | Watch logging | Progression | Spoken cues | Auto reps | Paid (US) |
|---|---|---|---|---|---|---|---|---|---|---|
| **Strong** | Self-log | 1 | ✅ | ✅ (free: 3 routines) | ✅ | ✅ **standalone**, crown edits | ✗ | ✗ | ✗ | $29.99/yr |
| **Hevy** | Self-log | 1 | ✅ | ✅ (free: 4) | ✅ per exercise, ±15 s | ✅ auto-save on reconnect | visual | ✗ | ✗ | $23.99/yr, $74.99 lifetime |
| **Fitbod** | AI generator | 1–2 | ✅ | ✅ | ◐ pauses when screen dims | ◐ companion | AI (disputed) | ✗ | ✗ | $95.99/yr |
| **JEFIT** | Self-log + AI | 1–2 | ✅ | ✅ | ✅ | ✅ (Elite) | Adaptive Plan | ◐ Elite only | ✗ | $69.99/yr |
| **Caliber** | Self-log + coach | ? | ? | ✅ | ? | ✗ | Strength Score | ✗ | ✗ | Plus $6–12/mo |
| **Future** | Human coach | follow-along | n/a | coach | ✅ | ◐ | coach | ✅ | ✗ | $199/mo |
| **Ladder** | Coach programmes | follow-along | ◐ | daily plan | ✅ | ◐ | programme | ✅ ducks music | ✗ | $29.99–49.99/mo |
| **StrengthLog** | Self-log | 1 | ✅ | ✅ | ✅ | ◐ phone needed to save | programmes | ✗ | ✗ | $109/yr (best free tier) |
| **Boostcamp** | Programme library | 1 | ✅ | ✅ 11k programmes | ✅ | ✗ | ✅ RPE/RIR | ✗ | ✗ | $59.99/yr |
| **Alpha Progression** | Self-log + recs | **2** (weight+reps+RIR, vendor claim) | ✅ + next-set target | ✅ | ✅ | ✗ | ✅ RIR, deloads | ✗ | ✗ | $79.99/yr |
| **RP Hypertrophy** | Meso generator | ? | targets | 45+ templates | ✗ | ✗ | ✅ feedback-driven | ✗ | ✗ | $299.99/yr |
| **SmartGym** | Self-log + AI | 1–2 | ✅ | ✅ | ✅ | ✅ **standalone** | AI | ◐ HIIT | ✗ | $59.99/yr |
| **Gymaholic** | Watch-first | 1–2 | ? | ✅ | ✅ | ✅ | charts | ✅ | ✗ | $31.99/yr |
| **Fitness+ strength** | Video | n/a | n/a | Custom Plans | n/a | metrics only | ✗ | ✅ Workout Buddy | ✗ | $79.99/yr |
| **WHOOP Strength Trainer** | Manual log → load | several | ◐ | ✅ | ? | n/a (band) | load only | ✗ | ◐ 2026 passive load estimate | membership |
| **Garmin strength** | Watch-native | 2 buttons | ✗ | ✅ | ✅ | ✅ | ✗ | ✗ | ✅ (legs may not count) | with the watch |
| **Runna strength** | Run plan + strength | phone log | ? | plan-generated | ? | ✗ **no watch sync** | weight log | ? | ✗ | $119.99/yr |
| **TrainingPeaks** | Coach builder | many fields | ◐ | ✅ | ? | ✗ | coach | ✗ | ✗ | Premium |
| **Gymatic** | Auto-detect | 0 if it works | n/a | ✅ | auto | ✅ | ✗ | ✅ rep count | ✅ mixed accuracy | subscription |

### 2.2 What users love and hate (App Store samples)

| Theme | Evidence |
|---|---|
| **Watch sync breaks** is the largest complaint cluster | Strong (46 of 150 sampled reviews mention the watch), SmartGym, Gymaholic, JEFIT, StrengthLog |
| **Paywalled basics** | Routine caps (Strong 3, Hevy 4); card-required "free" trials (Boostcamp, Caliber, Fitbod) |
| **Needs internet in the gym** | JEFIT, RP Hypertrophy |
| **Data loss after updates** | Boostcamp, Strong history |
| **Redesigned logging screen** | JEFIT's new set/weight input drew the harshest reviews |
| **Weak undo / crashes on reorder** | Boostcamp (3 s undo), RP (no undo), WHOOP (crash on reorder mid-workout) |
| **Opaque AI progression** | Fitbod "doesn't learn", jumps ~20 %; RP progression stalls for months |
| **Audio that breaks earbuds or other audio** | Future (AirPods disconnects), SmartGym switches off Apple's Workout Buddy |
| **Loved: a visible next-set target** | Alpha Progression, RP |
| **Loved: an in-ear coach that ducks music** | Ladder |

### 2.3 The 10 things that make strength logging stick (WS1 §4)

1. **One tap per set** that matches the plan (pre-fill + checkmark). RunCoach target: a set ≤ 2 taps, 1 on plan.
2. **"Do it again" is the default**: templates, repeat last, save edits back, no routine caps. Target: repeat ≤ 3 taps.
3. **A rest timer that starts itself** and reaches you (lock screen, watch haptic).
4. **A watch app that works alone and never loses a set.**
5. **Offline-first and data-safe** (in `backup.ts` from day 1).
6. **Visible, explainable progression** ("hit 3×10 last time → +2.5 kg").
7. **Stable, boring UI**; the LLM stays out of the set loop.
8. **Forgiving edits mid-workout**: real undo, skip, swap, reorder.
9. **Audio that coexists with music and earbuds** (reuse SpeechCue and the pending-utterance resume logic).
10. **Honest setup, fitted into the plan**: logging in seconds, strength visible in the running week.

Auto rep counting is **not** on the list: it does not drive loyalty (Garmin forum users keep only the duration; Gymatic reviews range from "amazingly accurate" to "~15 %").

## 3. Auto-detection feasibility on Ultra 1 / watchOS 26

### 3.1 What the platform offers (WS2)

| Item | Fact |
|---|---|
| Apple strength detection or rep counting | **None.** Traditional/Functional Strength record HR, energy and duration only. The iOS 27.0 SDK HealthKit headers contain no set or repetition type (local check). watchOS 27 code hints at set-level data ([AppleInsider](https://appleinsider.com/articles/26/09/07/watchos-27-will-still-have-surprises-even-if-apple-watch-series-12-wont)), unconfirmed, and the **Ultra 1 is excluded from watchOS 27** ([MacRumors](https://www.macrumors.com/2026/06/08/watchos-27-drops-support-for-apple-watch-series-9-ultra-se-2/)) |
| `CMMotionManager` | Up to 100 Hz; the app must be running (a live workout session keeps it running) |
| `CMBatchedSensorManager` | 800 Hz accelerometer, 200 Hz device motion, 1 batch per second, **only during an active HealthKit workout**; Apple: "Series 8 and Ultra" ([WWDC23 10179](https://developer.apple.com/videos/play/wwdc2023/10179/)) (watchOS 10+; the Ultra 1 qualifies, since it was the only Ultra in 2023) |
| `CMSensorRecorder` | 50 Hz accelerometer only, recorded even while suspended, kept 3 days ([docs](https://developer.apple.com/documentation/coremotion/cmsensorrecorder)) |
| Double Tap | Series 9 / Ultra 2 and later only ([Apple Newsroom](https://www.apple.com/newsroom/2023/10/apple-watch-double-tap-gesture-now-available-with-watchos-10-1/)). On the Ultra 1 the **Action Button** can run the existing `NextSegmentIntent` (which calls `lap()`), so "set done" needs no new intent |
| Workout Buddy (watchOS 26) | Speaks AI-generated encouragement from workout data (heart rate, time) during Traditional and Functional Strength, among other types. Needs an Apple Intelligence iPhone and Bluetooth headphones; English (Apple's current page adds Spanish on watchOS 27). **No rep counting and no custom targets** ([Apple Support](https://support.apple.com/en-in/guide/watch/apd65c7938e6/watchos); [Apple Newsroom](https://www.apple.com/newsroom/2025/06/watchos-26-delivers-more-personalized-ways-to-stay-active-and-connected/)) |
| Workout effort | `workoutEffortScore` / `relateWorkoutEffortSample` (iOS 18 / watchOS 11) is the natural home for session-RPE ([Sasquatch Studio](https://sasq.ca/blog/2025/4/28/reading-writing-workout-effort-scores)) |
| New permission for motion | Yes: `NSMotionUsageDescription` + a Motion & Fitness prompt (the watch Info.plist has none today) |

### 3.2 Evidence on wrist rep counting

| Study | Result | Limit |
|---|---|---|
| RecoFit 2014 (forearm, 50 Hz, 114 people) | 96–99 % recognition; ±1 rep in **93 %** of sets | Forearm, not wrist |
| Soro 2019 (wrist + ankle, 10 CrossFit moves) | ±1 rep in **91 %** | Used an ankle sensor too |
| StrengthControl 2021 (Apple Watch) | Recognition: bench 96.5 %, deadlift 92.2 %, **squat 76.5 %**; bench counts poor ([PMC8471343](https://pmc.ncbi.nlm.nih.gov/articles/PMC8471343/)) | n = 30 |
| LEAN 2023 (Apple Watch) | 2 miscounts in 90 reps (Gymatic 3) ([PMC10222347](https://pmc.ncbi.nlm.nih.gov/articles/PMC10222347/)) | One side-by-side test, two watches on one wrist, 3 × 3 sets of 8/10/12; Series 5; 3 arm exercises; misses on the shoulder press (little wrist rotation). Wearer count not stated |
| Brennan 2025 systematic review (44 studies, 49 models) | Wrist IMUs classify exercises with "excellent accuracy, even for lower body exercises"; mean counting error 0.0–0.59 per rep (19 studies) | **All 49 models at high risk of bias**; data from gyms or labs, no free-living validation (full text via [Europe PMC](https://europepmc.org/article/PMC/PMC12513948)) |

Vendor reality: Garmin's manual says a rep counts "when the arm wearing the watch returns to the starting position" and "leg exercises may not be counted" ([Garmin FR265 manual](https://www8.garmin.com/manuals/webhelp/GUID-F41EAFB3-6CC9-42DE-9C6C-9E358DBB0671/EN-US/GUID-7C8D56F5-E9F5-4825-9F66-3CC9124B2979.html)); forum users report firmware regressions (0 reps on pull-ups/push-ups, counts dropping mid-set) ([Garmin forum](https://forums.garmin.com/sports-fitness/running-multisport/f/forerunner-945/226201/strength-activity-rep-count-issues)). Motra and Gymatic reviews are split and ask for auto-detection to be switchable off. WHOOP's 2026 passive mode estimates load and is not publicly validated ([the5krunner](https://the5krunner.com/2026/02/28/new-whoop-strength-trainer-update/)). SmartGym and Gymaholic, the most praised watch loggers, are manual.

**Our inference, not a published finding:** wrist counting works best when the hands move with the load. None of the cited studies tested Geert's still-hands moves; RecoFit used a forearm band and Soro an extra ankle sensor.

### 3.3 The codebase constraint

On 2026-09-25, `HKWorkoutSession.beginNewActivity` inside a live session made HealthKit fail the recording (commit `49f46ac` removed all per-phase activity calls). So: **no `beginNewActivity` per exercise or set.** Sets stay on the watch during the workout and reach the phone over WatchConnectivity (as `sendExecStructure` does for runs). At finish, after `endCollection` and before `finishWorkout`, write one compact metadata string (`RC_sessionId`, `RC_strength_v1`). If that write fails, log it and save the workout anyway. `.segment` workout events per set are possible but untested in this app, so they wait for an on-device spike.

### 3.4 Recommended approach

| Level | What | Watch change | Sessions | In option |
|---|---|---|---|---|
| **D0** | Read strength workouts (types 50, 20, core training) from any app for frequency, minutes, adherence | None | 0.5 | A |
| **D1** | Manual watch strength mode: tap or Action Button = set done; crown confirms pre-filled reps; rest timer; spoken cues; haptics at transitions; HR display; structure as metadata at finish | Gated | 3–4 | B |
| **D2** | Motion assist, **off by default, suggestions only**: movement/rest segmentation proposes "set done?"; rep suggestion only for hand-loaded lifts; each confirmed set saved as labelled motion data | Gated + Motion permission | 2–3 (+0.5 spike first) | C |
| **D3** | Personal Create ML classifier | Gated | 3–5 + 6–10 weeks of data | **Skip** (low value: the exercise is already prescribed) |

Battery cost of motion capture is **unmeasured**; the real risk is CPU (this app has already hit the iOS CPU watchdog once). D2 must start with an on-device spike.

## 4. Planning, overload, load model, feedback

### 4.1 Evidence and dose (WS3)

| Question | Answer | Source |
|---|---|---|
| Running economy | 2–8 % better; mean −3.9 % O₂ cost; heavy ≥80 % 1RM and heavy + plyo work; moderate loads and isometrics don't | [Blagrove 2018](https://pubmed.ncbi.nlm.nih.gov/29249083/), [Denadai 2017](https://pubmed.ncbi.nlm.nih.gov/27497600/), [Llanos-Lagos 2024a](https://pubmed.ncbi.nlm.nih.gov/38165636/) |
| Performance | Time trial: heavy ES −0.47, combined ES −1.04 | [Llanos-Lagos 2024b](https://pubmed.ncbi.nlm.nih.gov/38627351/) |
| Injuries (runners) | Pooled runner RCTs not significant; supervised-only post hoc significant (Wu). Desai: observational; overall NS (p = 0.31); self-selected high-compliance subgroup HR 0.15 | [Wu 2024](https://pubmed.ncbi.nlm.nih.gov/38261240/), [Desai 2023](https://pubmed.ncbi.nlm.nih.gov/36630577/) |
| Body composition | −1.46 %-points body fat, visceral fat SMD −0.49 | [Wewege 2022](https://pubmed.ncbi.nlm.nih.gov/34536199/) |
| Dose | 2×/wk for 6–12+ weeks, 2–3 sets; 1×/wk at the same load maintains for up to 32 weeks | [ACSM 2026](https://acsm.org/resistance-training-guidelines-update-2026/), [Spiering 2021](https://pubmed.ncbi.nlm.nih.gov/33629972/) |
| Ordering | Run first, lift second; ideally ≥3–6 h apart; strength-then-run hurts next-day running more | [Schumann 2022](https://pubmed.ncbi.nlm.nih.gov/34757594/), [Robineau 2016](https://pubmed.ncbi.nlm.nih.gov/25546450/), [Doma & Deakin 2013](https://pubmed.ncbi.nlm.nih.gov/23724883/) |

### 4.2 Scheduling rules (deterministic; WS3 §4)

| # | Rule |
|---|---|
| S1 | Base/Build: 2×/wk. Peak: 1–2×/wk at the same load, fewer sets. Taper: 0–1 light; last heavy lower-body session ≥7 days before a race (heuristic) |
| S2 | **Hard days hard:** heavy/lower-body strength goes on an intervals or tempo day, **after** the run (≥3 h, ideally ≥6 h). **Runna does the opposite** (lower body on "Easy run days or rest days", [Runna support](https://support.runna.com/en/articles/15624879-adding-strength-training-to-your-runna-plan)); we follow hard-days-hard per [Doma & Deakin 2013](https://pubmed.ncbi.nlm.nih.gov/23724883/) and [Schumann 2022](https://pubmed.ncbi.nlm.nih.gov/34757594/). A deliberate choice, covered by D7; a Settings toggle "lower body on easy days" is possible |
| S3 | No lower-body heavy or plyo work the day before intervals, tempo or the long run |
| S4 | No lifting on long-run day (optional ≤15-min core/upper/mobility) |
| S5 | ≥48 h between lower-body sessions (heuristic) |
| S6 | Only one quality day: session 2 on an easy day that satisfies S3 and S5 |
| S7 | Red readiness: maintenance version (1 set, same load, RIR ≥3); never cancelled, for adherence |
| S8 | Sick: none. Injured: physio-prescribed only. Holiday: optional bodyweight preset |
| S9 | Heat day on an **easy** run: offer "indoor strength today, run tomorrow". Never swap quality automatically |
| S10 | **Code conflict:** today `/gym\|strength\|weights\|crossfit/` is a *hard* commitment that blocks quality that day and the next (`coach.ts` l.789). That contradicts S2. Planned strength must be placed by the planner; the text commitment stays only for unplanned classes |
| S11 | Strength never counts toward the running progression (ToF) cap |

Example week: Mon easy · **Tue intervals AM + Strength A PM** · Wed easy · **Thu tempo AM + Strength B PM** · Fri rest · Sat easy · Sun long.

### 4.3 Progressive overload

**Autoregulated double progression** ([ACSM 2009](https://pubmed.ncbi.nlm.nih.gov/19204579/), [Plotkin 2022](https://pubmed.ncbi.nlm.nih.gov/36199287/)): each exercise has a rep range and a target of 2 reps in reserve (people misjudge RIR by about 1 rep, [Halperin 2022](https://pubmed.ncbi.nlm.nih.gov/34542869/), so 2 lands safely at 1–3). Add reps until the top of the range; then add load (barbell lower +2.5–5 kg, DB next pair, bodyweight → next variation in a ladder such as split squat → rear-foot-elevated → loaded). Two consecutive misses → −10 %. Linear and daily-undulating models were rejected (no fit for a busy runner; DUP's edge appears only in trained lifters).

| Phase | Lower-body compound | Plyo | Sets / RIR |
|---|---|---|---|
| **Intro** (start, or ≥14 days off) | 3 weeks, 10–15 reps, light | 0 → 20–30 low contacts | 2 sets, RIR 3–4 |
| **Strength** (build weeks) | 4–6 reps | +10 contacts/wk up to ~60–100 | 3 sets, RIR 2 |
| **App deload week** | same load, **half the sets** | halve | RIR ≥3, no progression |
| **Peak** | 3–5 reps, same load | ≤40 | 1–2 sets |
| After deload | resume at pre-deload loads | resume | — |

Strength rides the app's existing 3 build + 1 deload cycle (`DEFAULT_PERIODIZATION`) and season phases, so there is one fatigue rhythm. Heavier-runner caveat: plyo starts low-amplitude and progresses on contacts before height.

### 4.4 Load model

Today the same strength session is scored three ways: HR-TRIMP in CTL/ATL, `muscularLoad` = 1 per minute in daily strain, and `min × 0.6` in the kcal load list. Lifting averages about 62 % HRmax ([Alcaraz 2008](https://pubmed.ncbi.nlm.nih.gov/18438256/)), where Banister's weighting gives almost nothing.

| Session (generic athlete, WS3 spike) | HR-TRIMP | sRPE × min | sRPE → TRIMP (k = 0.41) |
|---|---|---|---|
| Traditional lifting, 45 min, sRPE 6 | 32 | 270 AU | 111 (~3× more) |
| Circuit, 45 min, sRPE 6 | 52 | 270 AU | 111 (~2×) |
| Easy bodyweight, 30 min, sRPE 4 | 14 | 120 AU | 49 (~3.5×) |

```
strengthEq = k × sRPE × minutes                (Foster AU → TRIMP-equivalent, k ≈ 0.41)
CTL/ATL    : TrimpRepair window → max(HR-TRIMP, w × strengthEq), w = 0.5 (Settings tunable)
strain     : muscularLoad = strengthEq          (replaces "1 per minute")
planned    : estimateDayTrimp += w × k × plannedRPE × plannedMin
no rating  : planned RPE (default 5) until the rating arrives, then recompute
```

k comes from pairing the app's easy/moderate/hard TRIMP rates with CR-10 RPEs of 3/5/7 (an assumption); it can later self-calibrate from HealthKit effort scores on runs. w = 0.5 keeps a 45-min lift (≈55) from counting like a hard interval session (111) in "fitness", while ATL/TSB still see the fatigue. Foster's method: [Foster 2001](https://pubmed.ncbi.nlm.nih.gov/11708692/).

**Implementation notes (from the code; part of A6's scope and tests):**

| # | Gap in today's code | What A6 must add |
|---|---|---|
| a | `TrimpRepair` does not take a max: `computeStrainTrimp` drops all HR inside the window and adds `repair.trimp` (`trainingLoad.ts` l.469+). The repair loop in `healthkit.ts` (l.3521) only runs when `p2h && windows.length` and ≥5 power samples exist, which a strength window never has | A helper that computes the window's HR-TRIMP on its own, so `repair.trimp = max(windowHrTrimp, w × strengthEq)`; a **non-power repair branch** for strength windows |
| b | `cardio-trimp-cache.json` recomputes only a 2-day tail (`TRIMP_RECOMPUTE_TAIL = 2`, `healthkit.ts` l.3546). A rating or late tag after that leaves CTL stale | **Evict that day's cache key** whenever an sRPE rating or tag lands (a global cache bump alone does not cover it) |
| c | `muscularLoad` is computed twice: live strain (`healthkit.ts` l.2266) and `fetchStrainHistory` (l.3919) | Switch **both** to `strengthEq`, or the 14-day strain baseline drifts |

### 4.5 Feedback loop

| Signal | When | Input | Required |
|---|---|---|---|
| Session rating | ~30 min after the end (notification) or next app open | **Too easy / Just right / Too hard** → sRPE 4 / 6 / 8; optional 1–10 refinement | **1 tap** |
| Per-set RIR | During logging | Easy (3+) / Solid (1–2) / Limit (0) | Optional |
| Next-morning soreness | Morning coach page chip | None / Mild / Moderate / Severe, lower/upper | Optional (prompted after leg days) |
| Pain flag | Any time | "Pain, not soreness" + location | Optional |

| # | Trigger | Next strength session | Running |
|---|---|---|---|
| F1 | Too easy + RIR ≥ target | Progress per §4.3 | — |
| F2 | Just right | Per-exercise rule only | — |
| F3 | Too hard, first 2 sessions ever | Hold (expected soreness) | — |
| F4 | Too hard otherwise | No load increase; 2 in a row → −1 set | — |
| F5 | Moderate leg soreness | Hold volume | Quality run moves +1 day or turns easy |
| F6 | Severe leg soreness | Upper/core only; legs −20 % | Today easy or rest |
| F7 | Red readiness | Maintenance version | — |
| F8 | ≥14 days off | Intro block, −10 % | — |
| F9 | Pain flag | Remove exercise, offer same-pattern alternative, "see a physio if it persists" | Injured status offered |
| F10 | 2 missed sessions in a row | 1×/wk short preset for 2 weeks | — |

## 5. Exercise database, media and form cues

### 5.1 Sources and exact licences (WS4)

| Source | Count | Media | Data licence | Media licence | Keyless + offline? | Verdict |
|---|---|---|---|---|---|---|
| **wger** ([README](https://github.com/wger-project/wger/blob/master/README.md)) | 912 | 374 images on 273 exercises (photos + line art, 41 AI-flagged); 78 videos | Per record: CC BY-SA 4 (759), CC BY-SA 3 (132), CC0 (21). AGPL-3.0 covers only the server code, which we don't use | Per image/video CC BY-SA 3 or 4 | Yes (public API, no key) | Good for metadata; images too sparse and mixed |
| **free-exercise-db** ([repo](https://github.com/yuhonas/free-exercise-db)) | 876 | 1,746 JPGs | Unlicense (public domain) | **No valid licence**: upstream says images were "scrapped off the internet" ([CONTRIBUTING](https://github.com/wrkout/exercises.json/blob/master/CONTRIBUTING.md)) | Text only | Don't use images; text as a seed only |
| **workout-guide** ([repo](https://github.com/bryllim/workout-guide), [LICENSES](https://github.com/bryllim/workout-guide/blob/main/LICENSES.md)) | 302 | 3 consistent white line-art SVG frames each | MIT (code, manifest) | **CC BY-SA 4.0**: 906 frames; 76 first-pose frames adapted from Everkinetic (CC BY-SA 4.0), the other 830 self-credited to Bryl Lim (all frames 2–3 + first poses of 226 exercises) | Yes | **Primary image source**; ask the author about the provenance of all 830 first. Risk: provenance self-declared, repo created 2026-08-24 |
| **RepDB free tier** ([licence](https://github.com/RepDB/exercise-dataset/blob/main/LICENSE-DATA.md)) | 601 | 2 AI-made WebP frames + 3 tips each | Custom Free Tier Licence v1.0 | In-app commercial use with a **visible credit**; no republishing as a dataset; no generative-AI use of the images | Yes (in-app only) | Fallback for gaps (box jump) |
| **Everkinetic** ([data](https://github.com/everkinetic/data)) | 293 | 2 images each | CC BY-SA 4.0 | CC BY-SA 4.0 | Yes | Already inside workout-guide |
| **ExerciseDB / AscendAPI** (RapidAPI) | 11,000+ | GIF, MP4 | Subscription; "non-exclusive, non-transferable, and revocable" | No caching beyond "temporary operational limits" | **No** | Incompatible |
| **ExerciseDB.io dataset** ([pricing](https://exercisedb.io/pricing)) | 1,394 | GIFs | Perpetual commercial licence, self-hosted; whether in-app bundling counts as redistribution is unclear, so read the full licence before buying | Same | Yes, once bought ($199 / $599) | Paid option if Geert wants GIFs, pending the licence check |
| **MuscleWiki API** ([terms](https://api.musclewiki.com/api-terms)) | 1,943 | 7,766 branded MP4 | Paid plans; text cache ≤30 days; credit in legal documents + keep in-video branding; streaming-only playback | **No permanent media storage** | **No** | Incompatible |
| **API Ninjas** ([terms](https://api-ninjas.com/terms)) | 3,000+ | None | Free plan non-commercial; paid only while subscribed | n/a | **No** | No value |
| hasaneyldrm/exercises-dataset ([NOTICE](https://github.com/hasaneyldrm/exercises-dataset/blob/main/NOTICE.md)) | 1,324 | GIFs | MIT (text) | GIFs © Gym visual, not licensed to cloners | Text only | No |
| ACE, ExRx ([ExRx legal](https://exrx.net/Notes/Legal)) | large | yes | All rights reserved (ExRx sells licences) | same | n/a | Ideas only, never the wording |

**Spike, "runner core 20":** workout-guide 19/20 with images, RepDB 19/20, wger 19/20 present but only 11 with images, free-exercise-db 17/20. workout-guide + RepDB together cover 20/20. Pogo hops appear nowhere and tibialis raises only in wger without an image, so we author those. Image size for the 20: 1.54 MB (workout-guide SVG) or 0.55 MB (RepDB WebP); ~60 exercises ≈ 5 MB SVG or ~2 MB rasterised; the watch needs ~1 MB of small PNGs.

**CC BY-SA obligations:** attribution in any reasonable manner (Credits screen + per-exercise ⓘ); ShareAlike applies only to adapted material we share (e.g. recoloured frames stay CC BY-SA 4.0) ([legal code](https://creativecommons.org/licenses/by-sa/4.0/legalcode.en)). FairPlay vs CC is an open question ([CC wiki](https://wiki.creativecommons.org/index.php?title=4.0%2FTechnical_protection_measures)); mitigation is a link to the unencumbered source from Credits.

### 5.2 Video

- **YouTube:** the API policies forbid caching or storing audiovisual content (§III.E.1, [policies](https://developers.google.com/youtube/terms/developer-policies)), so no offline video; embedding needs a new WebView dependency and brings YouTube tracking; watchOS has no WKWebView. At most an optional outbound "Watch a demo ↗" link.
- **CC video:** wger's CC BY-SA videos cover 4 of the 20 at ~46 MB each: too heavy to bundle.
- **Recommended:** cross-fade the 2–3 existing frames (RN `Animated`, SwiftUI animation); own stick-figure rig later for gaps and tempo (C).

### 5.3 Form cues

Write our own. Exercises and technique ideas aren't copyrightable ([Bikram v. Evolation, 9th Cir. 2015](https://law.justia.com/cases/federal/appellate-courts/ca9/13-55763/13-55763-2015-10-08.html)); the wording is. Per exercise: **≤2 "Do" cues + ≤2 "Avoid"**, ≤6 words each, with an **external focus** ("push the floor away"), which improves performance and learning ([Wulf 2013](https://gwulf.faculty.unlv.edu/wp-content/uploads/2018/11/Wulf_AF_review_2013.pdf); [Chua 2021](https://www.apa.org/pubs/journals/features/bul-bul0000335.pdf)). Draft at dev time, check by hand, ship as bundled JSON: keyless.

| Surface | Shows | Speaks |
|---|---|---|
| Phone exercise sheet | 3-frame loop, sets × reps/load, 2 Do + 2 Avoid, muscles, equipment, alternatives, ⓘ credit | — |
| Phone in session | Current set, one cue line, rest ring | Same as the watch when the phone owns audio (B) |
| Watch | Short name, "Set 2/3 · 8 ea · 16 kg", one cue line, optional small frame, rest countdown | Set start: name + target + one cue (first set only); rest: "Thirty seconds", "Ten", "Next: set three"; timed holds: one mid-hold reminder |

## 6. UX flows and integration design

### 6.1 Tap budget (WS5)

| Flow | Target | Designed taps |
|---|---|---|
| Repeat last workout, live | ≤3 | **2**: "↻ Same as Tue" → Start |
| Repeat and log afterwards | ≤3 | **3**: "✓ Did it" → Save → rating |
| Set as prescribed (phone) | ≤2 | **1** |
| Set with different reps/kg | ≤2 | **2** (tap value → pick from strip; commits with undo) |
| Set on the watch (B) | ≤2 | **1** (DONE; crown turn first if reps differ) |
| Timed set (plank, hops) | ≤2 | **1** (Go; auto-completes, side switch spoken) |
| Post-workout feedback | — | **1** required (+ optional) |
| Next-morning soreness | — | **1** |
| Tag a workout from Apple Workout / another app | ≤3 | **3** |

### 6.2 Builder (phone)

```
[‹ Back]              Strength Library
Where: (● Home) (○ Gym)     Kit: dumbbells · band · box   ✎
★ PRESETS · for runners
┌ Runner Foundation      bodyweight · 20 min · 5 ex    ▶ ┐
┌ Runner Strength A      dumbbells  · 30 min · 5 ex    ▶ ┐
┌ Runner Strength B      dumbbells  · 30 min · 5 ex    ▶ ┐
┌ Heavy Legs             gym        · 40 min · 4 ex    ▶ ┐  ← greyed at Home, "Auto-swap to home kit"
┌ Plyo Primer / Calves & Achilles / Core & Hips / Quick 4 (= today's STRENGTH_DEFAULT) ┐
MY WORKOUTS
┌ Tue gym (edited A)     gym · 35 min · last 3 d ago   ▶ ┐
                                        [＋ New workout]
＋ New workout (B): Goal → Where → Time → deterministic generator → editable list (↔ swap, long-press = superset)
```

Presets are read-only data; "Edit" makes a copy. The add-exercise sheet reuses the food add-sheet pattern (one search box, filter chips, Recents/★).

### 6.3 Schedule: Daily Coach, 7-Day Plan, season plan, calendar

```
🦵 STRENGTH · Runner Strength A · ~30 min · home
Split squat 3×8/leg @12 kg (+1 rep) · SL-RDL 3×8 · Calf raise 3×12 · Side plank 2×30s
Why today: intervals this morning; 48 h before Sun long run.        ← deterministic rule text
[▶ Start]   [↻ Same as Tue]   [✓ Did it]            ⋯ swap · move · skip   [⌚ Send to watch] (B)
Not a strength day → "No strength today: intervals tomorrow. Optional: Calves & Achilles (10 min)"
```

```
7-Day Plan
Tue  Intervals 5×3min Z4    🏋 A · 30'     strain 61  ATL ▲
Wed  Easy 40min Z2          –              strain 38
Thu  Tempo 20min            🏋 B · 30'     strain 58
Long-press 🏋 → move; rules re-check and warn ("Heavy legs <24 h before Sun long run")
```

- **Season plan:** each phase gets a strength focus and frequency (Base/Build 2×, Peak 1× maintenance, Taper 1× light, none in race week); deload weeks halve the sets.
- **Calendar (`planIcs.ts`, B):** all-day `VEVENT` per planned strength day with a stable UID `runcoach-strength-<date>@runcoachai` (re-import updates, no duplicates, [RFC 5545](https://datatracker.ietf.org/doc/html/rfc5545)); timed event + `VALARM` + `TZID` Europe/Brussels only if Geert sets a preferred time; season banners gain "· strength 2×".

### 6.4 Phone session logger (A)

```
Runner Strength A        12:40 ⏱                                 [End]
1 Split squat (DB)  · cue: drive the floor away           ⓘ
   last: 3×8 @ 10 kg · today +2 kg (double progression)
   ✓ 1   8/leg   12 kg                     ← done (tap = undo)
   ● 2   8/leg   12 kg   [✓]               ← 1 tap | tap "8" → 6 7 [8] 9 10
   ○ 3   8/leg   12 kg
   REST 1:12 ━━━━━━━━━░░░  [+30s] [skip]   ← auto-started; screen kept awake; local notification at 0
[＋ Exercise]                                     [Finish → feedback]
```

Every commit is a merge write of the in-progress session (never a whole-file replace), so a force-quit resumes. **No phone speech in A**: `expo-speech` isn't installed; spoken cues on the phone arrive with B's `speak()` in `runcoach-workout`.

### 6.5 Watch session with spoken cues (B)

```
┌ SPLIT SQUAT     2/3 ┐   ┌ REST        ♥ 128 ┐   ┌ SIDE PLANK 1/2 L ┐
│ 8 / leg  ·  12 kg   │   │      1:05         │   │      0:22        │
│ (crown: reps ↕)     │   │ Next: Split sq 3/3│   │ auto → "Switch   │
│ ♥ 121               │   │ [+30s]  [Skip ▸]  │   │  sides"          │
│ [     DONE ✓     ]  │   └───────────────────┘   └──────────────────┘
└─────────────────────┘
 open segment = set        timed segment = rest    timed work = hold
```

| Moment | Cue |
|---|---|
| Start | "Strength. Runner A. Five exercises, about thirty minutes." |
| First set of an exercise | "Split squat. Three sets of eight per leg, twelve kilos. Drive through the front heel." (one form tip, first set only) |
| Later sets | "Set two of three. Eight per leg." |
| Set done | "Rest ninety seconds." + success haptic |
| Rest | "Thirty seconds" (rests ≥60 s) · "Ten seconds" · "3, 2, 1" (one utterance, existing `countdownEnd`) |
| Timed hold | "Side plank, left, thirty seconds. Go." → "Ten seconds" → "Switch sides." |
| End | "Strength complete. Fourteen sets, thirty-two minutes." |

- All cues go through `SpeechCue.say`: mute toggle and earbud routing come for free (phone speaks only with earbuds; otherwise the watch).
- Haptics only at transitions, because haptics pause HR sampling ([WKInterfaceDevice.play](https://developer.apple.com/documentation/watchkit/wkinterfacedevice/play(_:))) and wrist HR under-reads by about 7 bpm in resistance training (pooled −7.26 bpm, [Zhang et al. 2020, J Sports Sci](https://doi.org/10.1080/02640414.2020.1767348)). HR is display-only; sRPE drives load.
- "Next set" = on-screen DONE or the Action Button assigned to the existing "Next Segment" shortcut. **Rest is not a pause**; pausing would stop recording and fire the "still paused" reminder.
- Keep-alive: start the phone's background-location keep-alive only if earbuds were present at start (it costs battery and needs Always location in a still session).

### 6.6 Post-workout feedback

```
Runner Strength A · 32 min · 14/14 sets · ♥ avg 108 (wrist; under-reads in lifting)
How was it?   (Too easy)  (● Just right)  (Too hard)       ← 1 tap = saved (sRPE 4/6/8)
Refine effort 1–10 ▸   ·   Reps in reserve per exercise ▸  (optional)
Next time (rule): Split squat 3×9/leg @12 kg · Calf raise 3×12 @+4 kg · Side plank 2×35s
Next morning (coach page): Legs after Tue strength: (None) (Mild) (Sore) (Very sore)
```

Sessions recorded elsewhere (Apple Workout, Hevy, Strong) trigger "Strength · 34 min found. Log it? [Runner A] [Other…] [Skip]" → rating (3 taps), linked by HK UUID with no second write.

### 6.7 Data model and storage

```
// src/services/strength.ts (new, separate from workoutLibrary.ts)
ExerciseDef       { id, name, pattern, muscles, equipment[], mode: 'reps'|'time', perSide?, cueShort?, cues?, avoid?, mediaRef?, alternatives? }
StrengthTemplate  { id, name, source: 'preset'|'user'|'coach', goal, place, equipment[], estMinutes, items: TemplateItem[] }
TemplateItem      { exerciseId, sets: SetTarget[], restSec, supersetWith?, progression: double|linear|time|none }
StrengthSession   { id, date (4 am rule), templateId?, planned?, recorder: 'phone'|'rc-watch'|'apple-workout'|'other-app',
                    startMs, endMs, exercises[{ target[], sets: LoggedSet[] }], sRPE?, feel?, soreness?, hk?, load? }
CoachPlan.strengthSession?: StrengthPrescription      // beside the existing strength string, which is generated from it
WeekPlanDay.strength?: { templateId, label, estMinutes, optional? }
```

| File / key | Backup |
|---|---|
| `runcoach-strength-library.json` (user templates, custom exercises, owned kit, last-used) | add to `FILES` |
| `runcoach-strength-log-YYYY-MM.json` (monthly session shards, merge-not-replace) | add prefix to `FILE_PREFIXES` |
| `strength_settings_v1` (SecureStore) | add to `STATIC_SECURE_KEYS` |
| Bundled catalogue + media; presets in code; `strength-load-cache.json` | not backed up (app asset / code / recomputable) |

Why a separate store: `LibraryWorkout` is built on run blocks (minutes, HR zone) that flow into watch run pushes, `prescribedTrimp` and WorkoutKit `.running`. A strength kind there would leak into run-only code. `debugExport.ts` gets counts, minutes, sRPE and HK-write status only.

### 6.8 Hooks

| Hook | File | Change |
|---|---|---|
| Placement | `coach.ts` `getWeekPlan` | Post-pass applies S1–S11; emits `WeekPlanDay.strength`; planned strength no longer triggers the "gym = hard" commitment |
| Daily prescription | `coach.ts` | Fills `strengthSession` from the week slot + progression; `strength` string = `describeStrength()` so today's UI and prompts keep working. The LLM may phrase "why", never pick loads |
| Load | `trainingLoad.ts`, `healthkit.ts` | §4.4: `TrimpRepair` for CTL/ATL via a window HR-TRIMP helper + non-power repair branch; strain `muscularLoad` in **both** the live and history paths; kcal list; one path per session; per-day TRIMP-cache eviction when a rating or tag lands |
| Projection | `week-plan.tsx` | Planned strength TRIMP-eq per day |
| Adherence | `adherence.ts` | Planned vs done strength, separate line |
| Volume cap | ToF | Unchanged |
| LLM facts | `appModel.ts` | Two lines: how strength is logged, that load replaces the HR estimate, placement/progression rules are deterministic; plus a 14-day summary line |
| Human coach | `coach-athlete.tsx` | "Strength" picker setting `strengthSession` (C) |

### 6.9 HealthKit

| Recorder | Who writes | Type | Energy | Structure |
|---|---|---|---|---|
| Phone logger (A) | `saveWorkoutSample` in `@kingstinct/react-native-healthkit` 9.0.11 (installed; OTA). Phone already requests Workouts share (`healthkit.ts` l.284), so **no new Health prompt** | 50 traditional (gym) / 20 functional (home, bodyweight) | Totals only: active kcal ≈ (MET − 1) × kg × h, MET 3.5 or 6.0 ([2024 Compendium](https://pacompendium.com/adult-compendium/)) | Metadata `RC_sessionId`, `RC_strength_v1` (compact JSON, under 1 KB), indoor |
| RunCoach watch (B) | `HKLiveWorkoutBuilder` | same | Watch-measured | `addMetadata` at finish; phone sidecar authoritative |
| Apple Workout via WorkoutKit (B) | Apple | as pushed | Apple | Linked by time overlap + tag prompt |
| Other apps | them | — | — | Tag prompt only |

Rules: link instead of writing when an HK strength workout overlaps more than 50 %; never `beginNewActivity`. `saveWorkoutSample` is **not used anywhere in the app yet**, so A includes a first on-device check of the write.

## 7. Options

### Option A · MVP (all OTA, keyless, no watch change)

| Piece | Source | Sessions |
|---|---|---|
| A1 HealthKit strength read: frequency, minutes, adherence; "log this workout?" tag prompt | WS2 D0, WS5 S5 | 0.5 |
| A2 Catalogue v1 (~26: runner core 20 + extras), own cues, workout-guide/RepDB images rasterised, Credits screen | WS4 §7 (1.75 for 60, scaled) | 1.25 |
| A3 `strength.ts` model, presets, Strength Library, edit-a-copy, swap, kit filter | WS5 S1 without wizard | 1.25 |
| A4 Phone logger: pre-fill, 1-tap sets, value strip + undo, auto rest timer, keep-awake, local notification, crash-safe | WS5 S2 | 1.5 |
| A5 1-tap feedback, soreness chip, next-time progression rules | WS5 S3, WS3 §5/§7 | 1 |
| A6 Plan hooks: placement S1–S11, `strengthSession`, Daily Coach card, 7-Day chips + projection, sRPE load via `TrimpRepair` (window HR-TRIMP helper, non-power repair branch, per-day cache eviction, both `muscularLoad` paths; §4.4 notes a–c), adherence, `appModel` lines, harness tests incl. a late-rating CTL test | WS5 S4, WS3 §6 | 1.5–2 |
| A7 HealthKit workout write + metadata + dedup, incl. first on-device check | WS5 S5 | 0.5 |
| A8 `backup.ts`, debug export, unit tests of pure helpers | WS5 S7 | 0.5 |
| **Total** | | **~8–8.5** |

- **Ships:** all OTA. No native build, no watch change, no new permission.
- **Risks:**
  - The load change moves CTL/ATL/TSB and the replaced "gym = hard" rule moves run placement. Mitigation: harness repro against a fixture, cache bump, w = 0.5.
  - First JS HealthKit workout write in this app (native-crash risk, as nutrition's spike S2 flagged for food writes). Mitigation: on-device check, toggle in settings.
  - No spoken cues in A: the phone only fires a local notification at rest end.
  - Licence: workout-guide provenance of 830 of 906 frames (ask the author, pin a commit); RepDB credit; FairPlay vs CC residual.
  - Adherence is the real intervention; a clunky logger kills the benefit.

### Option B · Solid v1 (A + one phone build + one gated watch build)

| Piece | Source | Build | Sessions |
|---|---|---|---|
| B1a `speak()` in `runcoach-workout` (AVSpeechSynthesizer, ducking) + phone cue script | WS5 P1 | Phone Xcode build, **no watch gate**, no prebuild | 0.5 |
| B1b WorkoutKit strength push to Apple's Workout app (`activity`, `displayName` steps) | WS5 W0 | same phone build | 0.5–1 |
| B1c *(optional)* write sRPE as HealthKit `workoutEffortScore` | WS2 §8, WS3 §6.3 | same phone build | 0.25 (estimate) |
| B2 Catalogue to ~60 + variation ladders + 3-frame cross-fade | WS4 | OTA | 0.5 |
| B3 3-question workout wizard | WS5 S1 | OTA | 0.25 |
| B4 `.ics` strength events + season-plan strength focus | WS5 S6 | OTA | 0.5 |
| B5 RunCoach watch strength mode (manual D1): `sport: "strength"` branches in `WorkoutEngine`, strength screens, rest countdown cues, optional `RouteSeg` keys, metadata at finish, phone payload + ingest, review + on-device smoke test | WS2 D1 (3–4), WS5 W1 (2.5–3.5 + review) | **Gated watch build** | 3–4 |
| **Increment** | | | **+5.5–7** (total ~13.5–15.5) |

- **Ships:** B1 = one phone build (the watch-critical hash is unchanged, so the gate passes and no watch install is needed). B2–B4 OTA. B5 = gated watch build.
- **Risks:**
  - **Watch review gate:** every watch install waits for a `watch-regression-reviewer` SHIP on the exact watch-critical hash, plus a USB install session.
  - **Health re-approval:** every watch reinstall resets the watch's HealthKit grant; Geert must re-approve in the **iPhone Health app** (profile › Apps › RunCoach), since the watch never shows its own sheet. A missed re-approval silently loses HR and saves.
  - Regression surface in the run engine: every branch guarded by `sport == "strength"` so the run path stays byte-identical; `RouteSeg` additions Codable-optional.
  - WorkoutKit strength plans unverified on iOS 27 / watchOS 26 (spike ran on macOS); guard `supportsActivity`. Apple Workout gives no custom speech on the wrist.
  - Phone keep-alive battery and Always location in a still session (start only with earbuds).

### Option C · Ambitious (B + extras; a menu, not a package)

| Piece | Source | Build | Sessions |
|---|---|---|---|
| C1 On-device spike: CPU and battery of 50–100 Hz batched capture over 45 min on the Ultra 1 | WS2 §8 | scratch build | 0.5 |
| C2 Motion assist D2: set/rest segmentation suggestions, rep suggestions for hand-loaded lifts only, labelled-data capture; off by default | WS2 D2 | Gated watch build + Motion permission | 2–3 |
| C3 Human-coach strength prescription (`coach-athlete.tsx` + cloud plan column + Worker deploy) | WS5 C1 | OTA + Worker | 1 |
| C4 Own stick-figure animation rig (pogo hops, tibialis raise, tempo sync) | WS4 §5 | OTA | 1 |
| C5 k self-calibration from HealthKit effort scores + strength-only weekly AU / monotony guardrail | WS3 §6.3–6.4 | OTA | 0.5–1 (estimate) |
| C6 Food + Strength + Biology links (§9) | WS5 §7 | OTA | 1–1.5 (estimate) |
| C7 *(not recommended)* personal Create ML exercise classifier | WS2 D3 | Gated | 3–5 + 6–10 weeks of data |
| **Increment** | | | **+6–8** (C7 excluded) |

- **Risks:** a second gated watch build and Health re-approval; a new Motion permission; CPU watchdog; poor accuracy on leg and bodyweight moves; cloud schema change for C3.

### 7.1 What ships how

| | OTA | Phone native build (no watch gate) | Gated watch build + Health re-approval |
|---|---|---|---|
| A | everything | — | — |
| B | B2, B3, B4 | B1a, B1b, B1c | B5 |
| C | C3–C6 | — | C2, C7 (C1 is a scratch build) |

### 7.2 Workstream conflicts the PM resolved

| Conflict | Resolution |
|---|---|
| WS5 treated the "gym = hard" commitment as a scheduling hook; WS3 says it contradicts "lift after the run on quality days" | WS3 wins: planned strength is placed by the planner; the text rule remains for unplanned classes (D7) |
| WS2: Action Button runs `NextSegmentIntent`; WS5: it's wired to pause | Both intents exist; Geert picks the shortcut in watch Settings. "Next Segment" = DONE needs no code (D14) |
| WS2: `.segment` events at finish; WS5: metadata only | Metadata + phone sidecar in B; segment events only after an on-device spike |
| WS3: 1 required feedback tap; WS5: 2–3 | 1 tap (three buttons → sRPE 4/6/8), optional 1–10 refinement |
| WS5: "replace the flat 0.6"; WS3: three separate load paths | WS3's design covers all three (CTL/ATL, strain, kcal list) |
| Watch mode effort: WS2 3–4, WS5 2.5–3.5 + review | 3–4 including review and install |
| Nutrition moved its HealthKit write to B; strength keeps it in A | Strength needs no new permission (Workouts share is already granted), but gets a first-write on-device check |

## 8. Recommendation and decision list

### Recommendation

1. **Don't start until Geert says go.** The roadmap puts planning/coaching first and food + strength "later". Food A4 (photo) is in progress.
2. When green-lit, **build Option A** (~8–8.5 sessions, all OTA). It gives the coach real strength frequency and load, a 1-tap logger in the running week, and the 1-tap feedback loop.
3. **Add B1** (one phone build, ~1–1.5 sessions): spoken cues on the phone and the Apple Workout push. No watch gate, no Health re-approval.
4. **After 2–3 weeks of real use, decide on B5**, our own watch strength mode. The engine fits (open segment = set, timed = rest, existing cues), but it costs a review round and a Health re-approval.
5. **Treat C as a menu.** Skip the classifier. Motion assist only after the C1 spike, and only if Geert still wants it.

### Decisions for Geert

| # | Decision | Recommended default |
|---|---|---|
| D1 | Go/no-go and timing vs the roadmap | Not before the current coaching work and food A4 land |
| D2 | Scope: A, A + B1, B, C items | A, then B1; B5 after 2–3 weeks of use |
| D3 | Recorder: phone logger, Apple Workout (WorkoutKit), our watch mode, or HealthKit read only | Phone + HK read in A; Apple Workout push in B1; own watch mode in B5 |
| D4 | Auto rep counting / exercise detection | Out of A and B; C2 only after the C1 spike; no classifier |
| D5 | Strength weight **w** in CTL/ATL | 0.5 (Settings tunable); full weight in daily strain; never in the run cap |
| D6 | Write sRPE to Apple Health as a workout effort score (native) | Local only in A; optional in the B1 build |
| D7 | Replace the "gym = hard" text commitment for planned strength, and where lower-body strength goes | Yes: the planner places planned strength after the run on quality days (hard days hard; Runna instead uses easy/rest days, offer as a toggle); text rule kept for unplanned classes |
| D8 | Default place and kit | Both, filterable; home default; one-time kit list |
| D9 | Plyometrics | On after the 3-week intro, low contacts, one-tap off (central-weight caveat) |
| D10 | Media | workout-guide images + RepDB for gaps + own cues + Credits; ask the workout-guide author about the 830 self-credited frames first; no YouTube embed; demo link off |
| D11 | Spoken cue content | Name, set/reps/load, rest countdown; one form tip on the first set, on by default, switchable |
| D12 | Free-text `CoachPlan.strength` | Keep it, generated from the new structured `strengthSession` |
| D13 | HealthKit activity type | 50 traditional for gym, 20 functional for home/bodyweight |
| D14 | Action Button in watch strength mode | Assign "Next Segment" = DONE; rest is never a pause |
| D15 | Calendar | All-day strength events; timed + alarm only if a preferred time is set |
| D16 | Human coach prescribing strength | Out of A/B (C3) |
| D17 | Body composition | Biology read-out + protein target on strength days; no hypertrophy programme |

### Answers to the tracker's open questions

1. Auto-detection: evidence says a fast manual log wins (§3); D4.
2. Recorder: phone + HK read first, Apple Workout push next, own watch mode later (D3).
3. Load: sRPE-derived TRIMP through `TrimpRepair`, replacing the flat and HR estimates, w = 0.5 (D5).
4. Equipment: both, home default (D8).
5. Body composition: a Biology read-out, not a hypertrophy goal (D17).
6. Media: bundled open images + own cues; no video embed (D10).
7. Spoken form reminders: one per exercise on the first set (D11).
8. Human coach: C3.
9. Separate `strength.ts` store, not a new workout-library kind (§6.7).
10. Soreness: one chip on the morning coach page, not a new check-in screen (§6.6).

## 9. Overlaps with the nutrition report

`docs/nutrition/REPORT.md` (A1–A3 and A5 shipped; A4 photo in progress).

| Area | Shared |
|---|---|
| Add sheet | One search box + filter chips + Recents/★: build once, parameterise for foods and exercises |
| Log-on-pick + undo | Same toast and rule (set commit = food log-on-pick) |
| Repeat | Food "copy yesterday" = strength "same as last"; one repeat affordance on home cards |
| Storage | Monthly JSON shards, `FILE_PREFIXES` backup, merge-not-replace, 4 am attribution, totals-only debug export; neither goes to cloud sync by default |
| `appModel.ts` | Same "deterministic rules, LLM phrases" style; strength also **changes load**, so its line says how |
| HealthKit | Food writes dietary samples (nutrition B, new permissions); strength writes a workout (existing permission) |

**Combined "Food + Strength" roadmap (proposal):**

| Step | Food | Strength |
|---|---|---|
| 1 (now) | Finish A4 photo | — |
| 2 | — | Strength A (8–8.5) |
| 3 | Nutrition B native release | Strength B1 in the **same** phone build (one prebuild/regression pass for both) |
| 4 | Protein target raised on strength days; strength markers on the food timeline (C6) | same |
| 5 | Biology drivers: energy balance + weekly strength sets per muscle group vs lean mass, body fat, weight (Spearman + lag scan) | same |
| 6 | — | Strength B5 watch mode, after 2–3 weeks of use |

Body composition belongs in **Biology mode**: resistance training alone lowers body fat by ~1.5 points and visceral fat modestly ([Wewege 2022](https://pubmed.ncbi.nlm.nih.gov/34536199/)); runner trials show little change in mass. It is a read-out, advisory only.

## 10. Third parties and privacy

The brief asks to flag every new third party. None of them receives data at runtime in A or B; C3 is the only cloud path.

| Party | What we use | Runtime calls / data leaving the phone | Obligation or risk |
|---|---|---|---|
| **bryllim/workout-guide** (MIT code, CC BY-SA 4.0 art) | Line-art frames, bundled at build time | None | Credits screen + per-exercise ⓘ; adapted frames stay CC BY-SA 4.0; ask the author about provenance of the 830 self-credited frames (all but the 76 Everkinetic first poses); FairPlay vs CC residual (§5.1) |
| **RepDB** free tier | Fallback images for gaps, bundled | None | **Visible credit** in the app; no republishing as a dataset; no generative-AI use of the images |
| **Everkinetic / wger** (CC BY-SA, CC0) | Metadata seed and, where used, images, bundled | None (wger's public API is used only at dev time) | Attribution per record/image |
| **ExerciseDB.io** (only if bought) | GIFs, self-hosted | None | Licence must be read in full first (bundling vs redistribution unclear) |
| **Apple HealthKit / WorkoutKit** | Read and write strength workouts; push a plan to Apple's Workout app (B1b) | On-device only; Health data syncs via the user's own iCloud as Apple does today | Existing Workouts permission; WorkoutKit needs no new permission in B1 |
| **Motion & Fitness** (C2 only) | Wrist motion for set suggestions | On-device only | New permission prompt |
| **YouTube** (optional "Watch a demo ↗" link, off by default) | Opens YouTube outside the app | Only when the user taps it; YouTube then tracks that visit | No embed, no caching (§5.2) |
| **Cloudflare Worker + D1** (C3 human-coach strength) | Coach prescribes strength sessions; the athlete's strength sessions sync to the coach | **Yes: strength sessions go to the cloud** | Off by default, as with nutrition; only when the external-coach mode is switched on |

No personal data (sessions, loads, sRPE, soreness, body metrics) goes into git or any doc; debug export keeps totals only (§6.7).

## 11. Review notes

Review round 1 (WS7) returned **FIX** with 10 issues (3 MED, 7 LOW), all corrected in revision 2:

| # | Sev | Issue | Correction |
|---|---|---|---|
| 1 | MED | REPORT.md did not exist as a file | Written to `docs/strength/REPORT.md` from this Artifact's markdown |
| 2 | MED | Wrist-HR under-read (−7 bpm in lifting) cited to Ho 2022, a cardiopulmonary-test study | Re-cited to [Zhang et al. 2020](https://doi.org/10.1080/02640414.2020.1767348) (MD −7.26 bpm, 95 % CI −10.46 to −4.07); WS5 fixed too |
| 3 | MED | Brennan 2025 presented one-sidedly; "hands must move with the load" attributed to RecoFit/Soro | §1 and §3.2 now state the review's positive wrist-IMU finding with its limits; figures (49 models, all high risk of bias; 0.0–0.59 counting error) checked in the Europe PMC full text; the hands claim is labelled our inference |
| 4 | LOW | Load pseudo-code skipped three code gaps | §4.4 implementation notes a–c; folded into A6 and §6.8 |
| 5 | LOW | LEAN described as single user | Round 1 said n = 3; round 2 corrected that (see below) |
| 6 | LOW | Garmin forum cited for "zero leg reps" | Reworded to firmware regressions (0 reps on pull-ups/push-ups) |
| 7 | LOW | watchOS 26 Workout Buddy missing; Ultra 1 support implicit | Workout Buddy row added; CMBatchedSensorManager row states the Ultra 1 qualifies |
| 8 | LOW | ExerciseDB.io "bundling allowed" overstated | Licence wording softened to what the pricing page supports; WS4 fixed too |
| 9 | LOW | Divergence from Runna's lower-body placement not flagged | Line under S2 (§4.2); D7 covers it |
| 10 | LOW | No consolidated third-party/privacy list | §10 added |

Review round 2 returned **FIX** with 4 issues (1 MED, 3 LOW), all corrected in revision 3:

| # | Sev | Issue | Correction |
|---|---|---|---|
| 1 | MED | workout-guide provenance scope: "226 non-Everkinetic frames" is an exercise count, not a frame count | Manifest recounted: 302 exercises, 906 frames, 76 with an Everkinetic source (all frame 1). Now "76 Everkinetic first poses; 830 self-credited (all frames 2–3 + 226 first poses)"; ask the author about all 830; repo created 2026-08-24. Known gaps, §5.1, Option A risks (§7), §10, D10 and WS4 fixed |
| 2 | LOW | LEAN "n = 3" conflated the TestFlight survey with the rep benchmark | Now: one side-by-side test, two watches on one wrist, 3 × 3 sets of 8/10/12, Gymatic 3 misses; wearer count not stated (re-read in the full text) |
| 3 | LOW | Desai 2023 design caveat missing; "adherence UX is the intervention" overstated | Marked observational, self-selected subgroup, overall p = 0.31; softened to "adherence is the most plausible lever" with Wu 2024's supervised-only post hoc (both abstracts re-read via Europe PMC) |
| 4 | LOW | MuscleWiki "credit line required" imprecise | Now "credit in legal documents + keep in-video branding; streaming-only playback" (terms re-fetched; in-app credit is encouraged, not required). Verdict unchanged |

Full review record: `docs/strength/TRACKER.md` → Review sign-off.
