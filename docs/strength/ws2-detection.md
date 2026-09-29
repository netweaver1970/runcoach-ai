# WS2: Auto exercise detection and duration/frequency tracking (feasibility)

Research only. No app code was changed. Scope: what is realistic on **Geert's Apple Watch Ultra 1 (watchOS 26 is its last version) with an iPhone on iOS 27**.

## TL;DR

| Question | Answer |
|---|---|
| Does Apple detect strength exercises or count reps? | **No.** The Workout app's Traditional and Functional Strength Training modes record HR, energy and duration only. There is no public rep or set API: the shipping iOS 27.0 / watchOS 27.0 SDK has no strength-set or repetition type (checked locally). watchOS 27 code hints at set-level strength data, but it is unconfirmed, and the Ultra 1 **cannot run watchOS 27** anyway. [1][2][3][4][L1] |
| Can we get the raw motion? | **Yes.** `CMMotionManager` gives up to 100 Hz. `CMBatchedSensorManager` gives 800 Hz accelerometer and 200 Hz device motion, but only during an active HealthKit workout session. Apple names "Series 8 and Ultra" as supported, which covers the Ultra 1. `CMSensorRecorder` records 50 Hz accelerometer in the background and keeps it for 3 days. [5][6][7] |
| Is wrist rep counting good enough? | **In the lab, yes; unproven for Geert's prescription.** Counts come within ±1 rep in about 91–93% of sets (RecoFit used a forearm band, Soro an extra ankle sensor). A 2025 review found wrist IMUs classify exercises with "excellent accuracy, even for lower body exercises", but every model was lab-built at high risk of bias [29]. The default Daily Coach strength block is calf raises, single-leg squats, hip bridges and side planks, where the hands are still, on the hips, or the move is a timed hold; rep counting on such moves is untested. That hands must move with the load for counting to work is **our inference**, not a finding of the cited papers. Garmin's own manuals say "leg exercises may not be counted". [8][9][10][12][L2] |
| What do shipping products achieve? | Garmin: forum users report firmware regressions (0 reps on pull-ups/push-ups, counts dropping mid-set); the manual says leg exercises may not be counted. Motra/Gymatic (Apple Watch auto-detect): App Store reviews split between "game changer" and "count is always off" or "didn't register leg day". SmartGym and Gymaholic **don't auto-count** at all: they win on fast manual logging. WHOOP: manual exercise logging plus a *muscular-load estimate*; the 2026 "Passive MSK" is not publicly validated. [11][13][14][15][16][17][18] |
| Recommendation | **Manual-first, motion-assisted later.** Step 1 reads HealthKit strength workouts for frequency and duration, with no watch change. Step 2 adds a watch strength mode (set/rest timers; Action button or tap = "set done"; crown confirms reps; spoken cues). Set structure is written **at finish** as metadata and segment events, **never** with in-session `beginNewActivity`. Step 3 (optional) records motion during those logged sets so each confirmed set becomes a free labelled training example. Only then consider a personal Create ML classifier, for upper-body and hand-loaded lifts only. |

---

## 1. What watchOS and iOS actually offer

### 1.1 Workout types and Apple's own behaviour

| Item | Fact | Source |
|---|---|---|
| `HKWorkoutActivityType.traditionalStrengthTraining` | "strength training exercises primarily using machines or free weights". watchOS 2+. | [19] |
| `.functionalStrengthTraining` | "primarily with free weights and body weight"; Apple says HealthKit gives "optimized calorie calculations" for it from watch sensors. | [20] |
| Native Workout app, strength modes | Records HR, active/total energy and duration. **No sets, no reps, no exercise identity.** | [1] |
| Auto-detect "start workout" reminders | Apple documents them for walking, running, swimming "and other workouts"; strength is not listed as auto-detected. Don't rely on it. | [21] |
| watchOS 26 custom Workout builder | Endurance only (time/distance/pace/HR/power targets). No structured strength. | [2] |
| watchOS 26 Workout Buddy | Supports Traditional and Functional Strength, but gives spoken motivation from HR/time, not rep counting. Needs Apple Intelligence iPhone + BT headphones. | [22] |
| watchOS 27 | Press reports code for set-level strength data (reps, weight, equipment, side, duration per set). Not functional at WWDC. **The Ultra 1 is excluded from watchOS 27.** | [3][4][23] |
| iOS 27.0 SDK (local check) | `HealthKit.framework` headers: the only "strength" hits are the two activity-type constants. There is **no** set/repetition type and no new strength API. | [L1] |
| iOS 26+ | Workout sessions now also run on iPhone (WWDC25), so a phone-only strength session is possible when the watch isn't worn. HR would still need a watch or a strap. | [24] |
| Effort (watchOS 11 / iOS 18) | `workoutEffortScore` (user, 0–10 RPE) and `estimatedWorkoutEffortScore` (system) can be attached to a workout via `relateWorkoutEffortSample`. This is a natural home for the **session-RPE** that WS3 needs. | [25] |

### 1.2 CoreMotion on the Ultra 1

| API | Rate | Constraints | Ultra 1 on watchOS 26 |
|---|---|---|---|
| `CMMotionManager` (accel, gyro, device motion) | ≤100 Hz | Low latency, so it's the one for real-time UI. It needs the app running: a live `HKWorkoutSession` keeps a watch app running in the background, but watchOS suspends background apps that use excessive CPU. | Yes [5][24b] |
| `CMBatchedSensorManager` | 800 Hz accel, 200 Hz device motion, delivered as **1 batch per second** | "you need to have an active HealthKit workout session to get data". It's aimed at impact events (golf, tennis, bat swing), not rep counting, and ~100 Hz is plenty for lifting (RecoFit used 50 Hz). watchOS 10+. | **Yes.** Apple: "Series 8 and Ultra support both high rate accelerometer and device motion". The Ultra 1 is S8-based with a high-g accelerometer. [5][6][26] |
| `CMSensorRecorder` | 50 Hz, **accelerometer only** | Records "even if your app is suspended or terminated". Data stays available for 3 days; up to 12 h can be queried at once. Useful for **post-hoc** analysis at finish with zero live CPU cost. | Yes. (Recorded **device motion**, `CMRecordedDeviceMotion`, is watchOS 27+ only, so not on the Ultra 1.) [7][L1] |
| Double Tap gesture (hands-free "next set") | n/a | Needs the S9 SiP. | **Not on the Ultra 1.** Use the **Action button** instead: the app already ships `NextSegmentIntent` for it. [27][L3] |

**New permission:** the watch app has no CoreMotion today (the Info.plist has only HealthKit usage strings) [L3]. Motion capture adds an `NSMotionUsageDescription` and a Motion & Fitness prompt. That is a small one-time cost, but it's separate from the HealthKit re-approval that follows every watch reinstall.

### 1.3 Battery (evidence is thin: flagged)

- Apple gives no public power figures for CoreMotion rates. WWDC23 says only that batched delivery is "higher rate data at a lower overhead" [5].
- LEAN (an Apple Watch wrist-IMU rep counter with real-time inference) reports battery use comparable to the official Apple Workout app [12]. That is one small study, not a benchmark.
- The practical risk is **CPU, not the sensor.** This codebase already had a crash from an un-throttled sensor handler hitting a CPU watchdog (the compass on iPhone), and watchOS suspends background workout apps that use too much CPU [24b]. Any motion work should process in 1 s batches and do heavy analysis at finish.
- **Estimate:** a 45–60 min HR-only strength session on an Ultra 1 is a small fraction of its multi-day battery. Adding 50–100 Hz capture should stay modest if it's batched. **This is unmeasured and needs an on-device spike before any claim.**

---

## 2. Published evidence: IMU exercise recognition and rep counting

| Study | Sensor / placement | Exercises | Recognition | Rep counting | Wrist and lower-body note |
|---|---|---|---|---|---|
| **RecoFit**, Morris et al., CHI 2014 [8] | Forearm armband IMU, 50 Hz; 114 participants / 146 sessions (dataset of 200+ people) | Gym + calisthenics circuits | 99 / 98 / 96% on circuits of 4 / 7 / 13 exercises; >95% precision/recall finding exercise periods | ±1 rep in **93%** of sets | Forearm, not wrist. Data is released under **CDLA-Permissive-2.0** (1.5 GB .mat), so usable for pre-training, but placement differs from a watch [8b] |
| **Soro et al.**, Sensors 2019 [9] | Wrist + **ankle** smartwatches; 54 people, 5,461 reps | 10 CrossFit full-body moves | 99.96% | ±1 rep in **91%** of sets | Used an ankle sensor too. The wrist alone is not shown to reach this on leg-dominant moves |
| **StrengthControl** validation, 2021 [10] | Apple Watch Sport (1st gen) on wrist; n=30 | Barbell bench, deadlift, back squat | Bench 96.5%, deadlift 92.2%, **squat 76.5%** (88.4% overall) | Squat and deadlift OK; **bench poor** (p=0.01) | Barbell squat works because the hands ride the bar. 1RM prediction worked in only 8.9% of attempts |
| **LEAN**, 2023 [12] | Apple Watch, wrist | Curl, lateral raise, shoulder press | Form recall 99–100% (curl, raise), 88–92% (press) | 2 miscounts in 90 reps (Gymatic: 3), all on the shoulder press (little wrist rotation) | Rep count: **one side-by-side test**, two Apple Watches on the same wrist, 3 exercises × 3 sets of 8/10/12; wearer count not stated. The 3 volunteers were the separate TestFlight form-analysis survey. Data collected on a **Series 5**; assumes a fixed watch orientation |
| Apple Watch VBT, 2023 [28] | Apple Watch 7, wrist vs barbell-mounted | Back squat | n/a | n/a | Mean bar velocity r≈0.95–0.97 on the wrist (SEE 0.064 m/s). Interesting for later "velocity" cues, but squat only |
| **Systematic review**, Brennan et al., Sports Med 2025 [29] | 44 studies / 49 models | Mixed | A wrist IMU gave "excellent accuracy, even when lower body exercises were included" | 19 studies: mean counting error 0.0–0.59 per rep | **All 49 models at high risk of bias.** Only 7 studies had more than 30 people and only 3 had more than 20 exercises. **No free-living validation reported** (data came from gyms or labs; only 2 studies stated the setting). Similar exercises (bench vs overhead press, squat vs lunge) cause most errors |

**What this means for RunCoach:** the literature supports auto-counting in **controlled, hand-loaded** lifts (barbell/dumbbell squat, deadlift, rows, presses, curls, pull-ups). It does **not** support reliable detection for:

- bodyweight leg work with still hands: calf raises, split squats with hands on hips, step-ups, hip bridges;
- machine leg work: leg press, leg extension;
- isometric holds: planks, side planks, wall sits. There are no reps to count, only a duration.

That list is most of a runner's strength menu, including the app's current `STRENGTH_DEFAULT` ("Calf raises 3×15, single-leg squats 3×8/leg, hip bridges 3×15, side plank 3×30s/side") [L2].

---

## 3. Vendors: what they claim vs what they achieve

| Product | Claim | Evidence of real-world behaviour |
|---|---|---|
| **Garmin** (auto rep/set) | Automatic rep counting and set detection in the strength activity | Manual: a rep counts "when the arm wearing the watch returns to the starting position"; "Leg exercises may not be counted"; don't look at the watch mid-set [13]. Forum: FR945 firmware regression where the watch "couldn't even detect the exercise", with 0 reps on pull-ups and counts dropping from 8 to 2 after a set [14]. Users in another thread "never log sets, reps and exercises" and keep only the duration [15]. |
| **WHOOP Strength Trainer** | First wearable to measure "muscular load" from the wrist accel/gyro plus body mass | Users **log exercises/sets/reps/weight manually** (the 2023 model; "97% repeatability" of the load score). The Feb 2026 "Passive MSK" auto-estimates load with no logging, but "has not been publicly validated", and how it merges with cardio strain is undocumented [16][17]. App Store: "Strength Trainer Broken", "Can't jump between exercises for supersets anymore" [18]. WHOOP's own pages returned 403 to fetches (gap). |
| **Motra** (ex-Train Fitness), Apple Watch | "tracking reps for over 470 unique exercise types, completely hands free" [11] | Reviews (2026): "count is always off and auto detection will pick… a completely different workout"; "had a lot of trouble while doing leg day"; a request to "make the auto detection something you can turn off"; but also "the set counter is a game changer" [11r] |
| **Gymatic**, Apple Watch | "the first and only app to automatically identify your exercises, count your repetitions" [30] | Reviews: "I did 5 squats, but it only logged 3"; "Always 1-3 behind me"; "switches to the next set sometimes… randomly… I would love to turn this off and rely on a tap"; also "Amazingly accurate counting of reps" [30r] |
| **Rep Up**, Apple Watch | Counts any exercise "with prominent hand movements" | Rating 3.4. Reviews: "maybe 4/10 reps", "count resets… more or less randomly" [31] |
| **SmartGym**, Apple Watch App of the Year 2023 | **No auto rep counting.** "Log a set, rest timer starts"; Double Tap = log set / start rest / next exercise; runs standalone on the watch | Wins on logging speed and predictability, not sensing [32] |
| **Gymaholic**, Apple Watch | Log sets/reps/weight on the watch, standalone | Manual logging; no auto rep claim in its current listing [33] |

**Pattern:** the products users praise for *ease* (SmartGym, Gymaholic, Hevy, Strong) are manual and predictable. The auto-detect products have polarised reviews, and the top complaint is the one thing an auto feature must not do: silently log the wrong set or count. Several users explicitly ask for a **manual override or "tap for next set"**.

---

## 4. Create ML activity classifier: feasibility

| Aspect | Detail |
|---|---|
| Tooling | `MLActivityClassifier` (Create ML on macOS) trains on accel/gyro sequences and exports a Core ML model that runs on the watch [34]. |
| Data format | CSV/JSON per recording, with a folder per label and a session id. Keep classes balanced by file count and duration. **Collect an "other / no activity" class**, which Apple calls "especially helpful for your runtime performance". Example window: 2 s = 100 samples at 50 Hz [35][36]. |
| Output | A class label per prediction window. **It does not count reps.** Rep counting is a separate peak/period detector on the dominant axis inside a detected set. |
| Data burden (estimate) | A **personal** model for Geert's ~6–10 hand-loaded exercises plus "rest/other" needs roughly 20–40 labelled sets per exercise across several sessions and both gym and home setups. Geert does 2×/wk strength, so that is **6–10 weeks of normal training** if labels come free from the manual logger (below), versus a burdensome dedicated collection protocol. A general multi-user model is out of scope. |
| Validation trap | The review found split-sample validation inflates accuracy [29]. Validate on **held-out sessions** (the `session_id` split), not random windows. |
| Accuracy expectation | Distinct upper-body lifts: plausibly high. Look-alike pairs (bench vs overhead press, squat vs lunge) and still-hand leg work: poor [10][29]. |

**Key design trick:** a manual watch logger that records the **start and end of every set** plus the exercise id produces perfectly labelled motion segments at no extra effort. Record raw 50 Hz accel via `CMSensorRecorder` (post-hoc, suspension-proof), or 50–100 Hz via `CMMotionManager` in 1 s buffers. At 50 Hz × 3 axes × 60 min that's about 540k samples, roughly 6 MB raw as float32. It can be transferred to the phone as a file after the workout, or trimmed to set windows only.

---

## 5. The codebase lesson (IMPORTANT)

On 2026-09-25, `HKWorkoutSession.beginNewActivity` inside a live session made HealthKit report "no active session to begin new activity" via `didFailWithError`, **killing the recording**. Commit `49f46ac` removed all per-phase `beginNewActivity`/`endCurrentActivity` calls. `WorkoutEngine.swift` now says: if the watch must carry structure itself, "write it as workout METADATA at finish" [L4].

For strength, that means:

- **No** `HKWorkoutActivity` per exercise or set during the live session. That is exactly the API a naïve "multi-exercise workout" design would reach for.
- Keep sets in memory on the watch and send them to the phone over WatchConnectivity, as `sendExecStructure → runSegmentsLog` already does for runs. **The phone is the source of truth.**
- At finish, after `endCollection` and **before** `finishWorkout`:
  - call `addWorkoutEvents` with one `.segment` event per set. Segments may overlap, carry metadata, and have been available since watchOS 4 [37];
  - call `addMetadata` with one compact JSON string of the sets. Metadata values must be string, number, date or quantity. `addWorkoutEvents` is only an error *after* `finishWorkout` [L5].
- Wrap both calls so a failure **logs and continues**: a label must never cost the recording.
- A sketch of this pattern is in the scratchpad at `…/scratchpad/strength/ws2-finish-metadata-sketch.swift`. It is not compiled.
- Even `addWorkoutEvents` mid-session is untested in this app. Batching at finish is the conservative choice.

---

## 6. Duration and frequency tracking (the cheap, reliable part)

- **Already half-built:** the app reads non-run HealthKit workouts (`query_activities`, the multi-sport filter, `snap.activities`), and strength sessions already feed the coach's non-run load [L2].
- Frequency (sessions per week), minutes, and last-strength-date can be computed from HealthKit workouts with activity type `traditionalStrengthTraining`, `functionalStrengthTraining` or `coreTraining`, from **any source**: Apple's Workout app, Hevy, Strong, SmartGym. **No watch change, no permission change** beyond existing workout read access.
- Adherence ("2 planned, 1 done") can reuse the existing plan-adherence machinery.
- This works even if Geert never uses a RunCoach strength mode.

---

## 7. Realistic scope for Ultra 1 (watchOS 26) + iOS 27

| Level | What | Watch change? | Effort (build sessions) | Risk |
|---|---|---|---|---|
| **D0: HealthKit-only tracking** | Strength frequency, minutes, streak and adherence from HealthKit workouts (any app) | None | 0.5–1 | Very low |
| **D1: Manual watch strength mode** (recommended target) | New strength mode on the existing `WorkoutEngine`. Session type `.traditionalStrengthTraining` or `.functionalStrengthTraining`. Screens: exercise + target, a set timer and an auto-starting rest countdown. **Action button / screen tap = "set done"** (reuses the `NextSegmentIntent`/`lap()` pattern). Crown confirms reps/weight, pre-filled from target or last time, so a set is 1–2 taps. Holds use a countdown instead of reps. **Spoken cues** via the existing SpeechCue plus the phone earbud routing: exercise name, "set 2 of 3, 12 reps", "rest 60… 10, 3-2-1, go", one short form reminder. Haptics on rest end. HR throughout. Structure goes to the phone live, and to HealthKit as metadata/segments **at finish** | Yes (watch gate + Health re-approval once per install) | 3–4 (watch 2–3, phone logging/ingest 1) | Low–medium. The main risk is the watch gate and one Health re-approval per install; no new permissions |
| **D2: Motion-assisted** | a) **Movement vs rest segmentation** (variance of \|a\| over 1 s windows) *suggests* "set done?" and auto-starts rest. It never auto-logs. b) **Rep-count suggestion** only for exercises tagged `handLoaded`, shown as a pre-filled crown value the user confirms. c) Raw motion saved per set = labelled data | Yes + motion permission | +2–3 | Medium: CPU budget, orientation and left/right wrist, false triggers during walking between stations |
| **D3: Personal exercise classifier** | Create ML model trained on D2's labelled sets; auto-suggests the *next exercise* in a free workout. Upper-body and hand-loaded only | Yes | +3–5, plus 6–10 weeks of data | High accuracy uncertainty; low value, because RunCoach **prescribes** the workout, so the exercise is already known |

**Why D3 is low value here:** auto *exercise recognition* solves "what am I doing?" for free-form gym-goers. RunCoach plans the session: the watch already knows the exercise, set and target. The remaining friction is confirming "done, and how many". The Action button plus a pre-filled crown solves that more reliably than any wrist model can for calf raises and planks.

---

## 8. Recommendation

1. **Ship D0 first**: strength frequency and duration from HealthKit, with no watch change. It immediately gives the coach real strength frequency data.
2. **Build D1 as the core of strength tracking**. It is manual but fast:
   - a prescribed workout on the wrist;
   - the Action button (or a tap) = "set done";
   - the crown confirms pre-filled reps;
   - auto rest timer, spoken cues and haptics.
   Write set structure as `.segment` events plus a metadata JSON **at finish**. **Never** call `beginNewActivity` in a live session.
3. **Treat D2 as an opt-in experiment**, default off, with suggestions only and never auto-logging. Start it only after D1 has been used for a few weeks, and first run a scratchpad on-device spike: measure the battery/CPU cost of 50–100 Hz batched capture over a 45 min session on the Ultra 1. Its main value is as a data flywheel.
4. **Skip D3** unless D2 data shows clear upper-body signal *and* Geert starts doing free-form gym sessions.
5. **Put session-RPE into HealthKit** via `workoutEffortScore` and `relateWorkoutEffortSample` (iOS 18 / watchOS 11+). The load model (WS3) can then read one standard field.
6. **Revisit when Geert upgrades his watch.** watchOS 27 may bring Apple set-level strength data (unconfirmed), plus Double Tap and recorded device motion. None of these reach the Ultra 1.

---

## Gaps and caveats

- **Reddit** (r/fitness, r/weightroom, r/Garmin, r/AppleWatch) was not fetched because reddit blocks automated fetches. App Store reviews (Apple's public RSS) and Garmin forums were used instead.
- **Blocked pages:**
  - WHOOP's own pages (whoop.com) returned 403. WHOOP facts come from the5krunner, search snippets and App Store reviews.
  - Garmin's support FAQ pages returned 403. Garmin's owner manuals (www8.garmin.com) were used instead.
  - Springer redirected to a login; the PMC copy of the systematic review was used.
- **Not tested:**
  - No on-device spike was run (no builds or installs, by rule). The battery and CPU figures are unmeasured.
  - The RecoFit dataset (1.5 GB) was not downloaded or analysed.
- **Evidence quality:**
  - The watchOS 27 strength-set feature is based on code sightings reported by the press, not an Apple announcement.
  - Vendor accuracy claims (Motra "470 exercises", Gymatic) have no published validation that I could find.

## Sources

1. Riven, "Does the Apple Watch Count Reps?" (native strength = HR, calories, duration; no reps/sets): https://riven.fit/blog/does-apple-watch-count-reps
2. DC Rainmaker, "Apple's Secret New Custom Workout Builder in iOS26/WatchOS26" (endurance only; no strength): https://www.dcrainmaker.com/2025/09/apple-watch-workout-builder-ios26-watchos26.html
3. AppleInsider, "watchOS 27 will still have surprises…" (strength set granularity in code; unconfirmed): https://appleinsider.com/articles/26/09/07/watchos-27-will-still-have-surprises-even-if-apple-watch-series-12-wont
4. Gotechtor summary of watchOS 27 strength set data (reps, weight, equipment, body side; not functional in beta): https://www.gotechtor.com/apple-watch-series-12-ultra-4-new-features-readiness-app-128gb-storage/
5. Apple WWDC23, "What's new in Core Motion" (800 Hz / 200 Hz; 1 batch/s; needs an active HealthKit workout session; "Series 8 and Ultra"): https://developer.apple.com/videos/play/wwdc2023/10179/
6. Apple Developer Documentation, CMBatchedSensorManager (watchOS 10.0+): https://developer.apple.com/documentation/coremotion/cmbatchedsensormanager
7. Apple Developer Documentation, CMSensorRecorder / `recordAccelerometer(forDuration:)` (50 Hz; records while suspended; 3 days): https://developer.apple.com/documentation/coremotion/cmsensorrecorder
8. Morris et al., "RecoFit", CHI 2014 (forearm IMU, 50 Hz; 99/98/96%; ±1 rep 93%): https://www.microsoft.com/en-us/research/wp-content/uploads/2016/11/Morris_Workout_CHI_2014.pdf
8b. RecoFit dataset repo (CDLA-Permissive-2.0; 1.5 GB LFS): https://github.com/microsoft/Exercise-Recognition-from-Wearable-Sensors
9. Soro et al., "Recognition and Repetition Counting for Complex Physical Exercises with Deep Learning", Sensors 2019: https://doi.org/10.3390/s19030714
10. Validation of a smartwatch workout app (StrengthControl, Apple Watch; bench/deadlift/squat): https://pmc.ncbi.nlm.nih.gov/articles/PMC8471343/
11. Motra App Store listing (claims): https://apps.apple.com/us/app/train-fitness-workout-tracker/id1548577496
11r. Motra App Store reviews (Apple RSS): https://itunes.apple.com/us/rss/customerreviews/id=1548577496/sortby=mostrecent/json
12. LEAN: Real-Time Analysis of Resistance Training Using Wearable Computing (Apple Watch wrist): https://pmc.ncbi.nlm.nih.gov/articles/PMC10222347/
13. Garmin Forerunner 265 manual, "Tips for Recording Strength Training Activities": https://www8.garmin.com/manuals/webhelp/GUID-F41EAFB3-6CC9-42DE-9C6C-9E358DBB0671/EN-US/GUID-7C8D56F5-E9F5-4825-9F66-3CC9124B2979.html
14. Garmin Forums, "Strength Activity Rep Count issues? (Forerunner 945)": https://forums.garmin.com/sports-fitness/running-multisport/f/forerunner-945/226201/strength-activity-rep-count-issues
15. Garmin Forums, "Automatically track sets, reps, and rests for strength training?": https://forums.garmin.com/apps-software/mobile-apps-web/f/garmin-connect-mobile-ios/287125/automatically-track-sets-reps-and-rests-for-strength-training
16. the5krunner, "WHOOP's New Strength Trainer Update…" (Passive MSK; not publicly validated): https://the5krunner.com/2026/02/28/new-whoop-strength-trainer-update/
17. WHOOP, "Strength Trainer: Muscular Load and Validation" (403 to fetch; cited via search snippet only): https://www.whoop.com/us/en/thelocker/the-research-and-development-behind-strength-trainer/
18. WHOOP App Store reviews (Apple RSS, GB): https://itunes.apple.com/gb/rss/customerreviews/id=933944389/sortby=mostrecent/json
19. Apple Developer Documentation, `HKWorkoutActivityType.traditionalStrengthTraining`: https://developer.apple.com/documentation/healthkit/hkworkoutactivitytype/traditionalstrengthtraining
20. Apple Developer Documentation, `HKWorkoutActivityType.functionalStrengthTraining`: https://developer.apple.com/documentation/healthkit/hkworkoutactivitytype/functionalstrengthtraining
21. Apple Support, "Start a workout on Apple Watch" (reminders for walking, running, swimming and other workouts): https://support.apple.com/en-us/HT204523
22. Apple Support, "Use Workout Buddy in Workout on Apple Watch" (supported types incl. strength): https://support.apple.com/en-in/guide/watch/apd65c7938e6/watchos
23. DC Rainmaker, "Apple New watchOS 27 Features" (Ultra 1 not supported by watchOS 27): https://www.dcrainmaker.com/2026/06/apple-watchos27-new-features-detailed.html (and MacRumors: https://www.macrumors.com/2026/06/08/watchos-27-drops-support-for-apple-watch-series-9-ultra-se-2/)
24. Apple WWDC25, "Track workouts with HealthKit on iOS and iPadOS": https://developer.apple.com/videos/play/wwdc2025/322/
24b. Apple Developer Documentation, "Running workout sessions" (background running; workout processing mode): https://developer.apple.com/documentation/healthkit/running-workout-sessions
25. Sasquatch Studio, "Reading from, and Saving Workout Effort to, HealthKit" (`workoutEffortScore`, `relateWorkoutEffortSample`): https://sasq.ca/blog/2025/4/28/reading-writing-workout-effort-scores
26. Apple Support, Apple Watch Ultra technical specifications (high-g accelerometer): https://support.apple.com/en-us/111852
27. Apple Newsroom, "Apple Watch double tap gesture now available with watchOS 10.1" (Series 9 / Ultra 2): https://www.apple.com/newsroom/2023/10/apple-watch-double-tap-gesture-now-available-with-watchos-10-1/
28. "Velocity-Based Strength Training: The Validity and Personal Monitoring of Barbell Velocity with the Apple Watch": https://pmc.ncbi.nlm.nih.gov/articles/PMC10383699/
29. Brennan et al., "Exercise Classification in Resistance Training: A Systematic Review of Technological Approaches", Sports Medicine 2025: https://pmc.ncbi.nlm.nih.gov/articles/PMC12513948/
30. Gymatic App Store listing: https://apps.apple.com/us/app/gymatic-workout-tracker/id1036069872
30r. Gymatic App Store reviews (Apple RSS, US+GB): https://itunes.apple.com/us/rss/customerreviews/id=1036069872/sortby=mostrecent/json
31. Rep Up for Watch, App Store listing and reviews: https://apps.apple.com/us/app/rep-up-for-watch/id1441746257
32. SmartGym for Apple Watch: https://smartgymapp.com/watch
33. Gymaholic App Store listing: https://apps.apple.com/us/app/id648518560
34. Apple Developer Documentation, `MLActivityClassifier`: https://developer.apple.com/documentation/createml/mlactivityclassifier
35. Apple WWDC19 session 426, "Building Activity Classification Models in Create ML": https://developer.apple.com/videos/play/wwdc2019/426
36. Turi Create user guide, Activity Classification (session id, prediction window at 50 Hz): https://apple.github.io/turicreate/docs/userguide/activity_classifier/
37. Apple Developer Documentation, `HKWorkoutEventType.segment`: https://developer.apple.com/documentation/healthkit/hkworkouteventtype/segment

**Local evidence (not URLs):**
- L1. Xcode 27.0 SDK headers, inspected 2026-09-29:
  - `iPhoneOS27.0.sdk/.../HealthKit.framework/Headers/*`: "strength" appears only in `HKWorkoutActivityType.h`; no repetition or set API.
  - `WatchOS27.0.sdk/.../CoreMotion.framework/Headers`: `CMBatchedSensorManager` is `API_AVAILABLE(watchos(10.0))`; `CMSensorRecorder` records accelerometer "at 50hz", with data "up to 3 days"; `CMRecordedDeviceMotion` and `CMBody` are `watchos(27)`.
- L2. `src/services/coach.ts` (`STRENGTH_DEFAULT`, non-run load); `src/services/agent.ts` (`query_activities`).
- L3. `targets/watch/Info.plist` (no motion usage string); `targets/watch/NextSegmentIntent.swift` (Action button intents).
- L4. Commit `49f46ac` (2026-09-25), "watch: remove per-phase HKWorkoutActivity calls from the live session"; `targets/watch/WorkoutEngine.swift` lines 57–61.
- L5. `WatchOS27.0.sdk/.../HealthKit.framework/Headers/HKWorkoutBuilder.h` (`addWorkoutEvents` / `addMetadata` semantics).
