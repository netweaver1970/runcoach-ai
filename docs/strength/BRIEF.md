# Strength / resistance training: overnight research brief (Tue 2026-09-29 → Wed)

**Owner:** Geert. **Output wanted:** Wednesday morning. Findings, 2–3 implementation OPTIONS with effort estimates and a recommendation. Geert decides what gets built. **No production code.** Throwaway spikes (e.g. querying an exercise API, a tiny CoreMotion or rep-count feasibility sketch) are allowed, in the session scratchpad only.

## Geert's request (verbatim)
"do the same market/app analysis for resistance workout building/scheduling/tracking. it has to be very easy, intuitive. preferable with auto exercise detection and duration/frequency tracking. Do again a study on available top apps, good & bad points. Do provide planned strength tracking and integration with the calendar/daily coach screen. provide progressive overload scheduling and feedback options after strength workouts. do check on available exercise movement databases, potential videos sources and coaching/proper form execution hints. allow spoken cues"

"The same" refers to the nutrition study the night before. Geert asked for that one to be run as follows: "Have a Product manager style agent keeping track of the workstreams, divide the work over specific agents where it makes sense. and have -as we have now- a review agent looking over the code to make sure that part is complete and correct." That process applies here too.

## Process
- **Product-manager agent:**
  - owns the plan and a live tracker (`docs/strength/TRACKER.md`: workstreams, status, open questions, decisions needed);
  - assigns the work to specialist agents;
  - integrates their findings into the report.
- **Specialist agents**, one per workstream (below), running in parallel where they're independent.
- **Review agent:** checks completeness and correctness. That means:
  - sources are cited and real;
  - licence, ToS and video/image rights claims are accurate;
  - the technical feasibility claims (Apple Watch sensors, rep counting) are correct;
  - nothing requested is missing.
  - The PM fixes everything it flags before publishing.

## Workstreams
1. **Market analysis: top strength apps.**
   - Apps: Strong, Hevy, Fitbod, JEFIT, Caliber, Future, Ladder, StrengthLog, Boostcamp, Alpha Progression, RP Hypertrophy, SmartGym, Gymaholic (Apple Watch), Apple Fitness+ strength, WHOOP Strength Trainer, Garmin strength (auto rep counting), and any runner-focused strength apps (e.g. Runna's strength plans, "strength for runners" programmes).
   - For each:
     - what makes them easy and intuitive (taps per set, templates, "repeat last workout", superset UX, rest timer), and what users hate (App Store reviews, Reddit r/fitness, r/weightroom, r/Hevy, r/running);
     - Apple Watch apps and their watch-side logging;
     - pricing and free tiers.
   - Output: a feature matrix and "the 10 things that make strength logging stick".
2. **Auto exercise detection and duration/frequency tracking (feasibility).**
   - What Apple Watch and watchOS actually offer:
     - CoreMotion (CMMotionManager, and CMBatchedSensorManager for high-rate accelerometer/device motion on watchOS 10+);
     - HKWorkoutActivityType traditional/functional strength;
     - whether Apple auto-detects strength or counts reps at all.
   - Published research on IMU-based exercise recognition and rep counting: accuracy per exercise, wrist placement limits (e.g. lower-body lifts on a wrist sensor).
   - What WHOOP, Garmin and SmartGym claim and actually achieve.
   - Create ML activity classifiers and on-device models.
   - Realistic scope for Geert's **Apple Watch Ultra 1 (watchOS 26 max)** and iPhone (iOS 27).
   - A lower-tech fallback: set/rest timers, lap = next set, and duration and frequency from HealthKit workouts.
   - **IMPORTANT lesson from this codebase:** per-phase `HKWorkoutSession.beginNewActivity` inside a live session made HealthKit FAIL the session (2026-09-25). Don't propose in-session activity APIs without flagging that risk; exercise and set structure can be written as metadata at finish instead.
3. **Planning, progressive overload and feedback (the coaching logic).**
   - Strength for runners: evidence on heavy/plyometric work for running economy and injury prevention, frequency (e.g. 2×/wk), and the concurrent-training interference effect. Scheduling rules versus the running plan: not before key quality sessions, hard days hard, ~48 h between sessions for the same muscle groups.
   - Progressive overload models: linear, double progression, RPE/RIR autoregulation, undulating, and deloads aligned with the app's existing running build/deload cycles.
   - Load accounting for strength: session-RPE × duration (Foster), and how to fold it into the app's training load (Banister TRIMP currency, CTL/ATL). HR-TRIMP under-counts strength.
   - Post-workout feedback: session RPE, per-set RIR/RPE, soreness next morning, "too easy / just right / too hard" → next-session adjustment.
4. **Exercise database, media and form coaching.**
   - Databases: wger (API, licence of code vs data), yuhonas free-exercise-db (licence, images), ExerciseDB (RapidAPI, GIF licensing), MuscleWiki, API Ninjas exercises, others.
   - For each: coverage, muscle/equipment metadata, images/GIFs/videos, licence obligations for use in an app, and offline bundling.
   - Video sources: YouTube embedding ToS, Creative Commons sources, and generating our own simple animations or illustrations.
   - Form-execution hints: sources of per-exercise cues and common mistakes, and how to present them concisely (on the phone vs on the watch).
5. **UX and integration with RunCoach.**
   - A very easy workout builder (templates, "strength for runners" presets, equipment filter: home, bodyweight, gym).
   - Scheduling into the existing 7-Day Plan / season plan / Daily Coach screen, and the calendar (.ics export exists: `src/services/planIcs.ts`).
   - The watch-side strength mode: set and rest timers, **spoken cues** (existing SpeechCue + watch→phone earbud routing: exercise name, set/rep targets, rest countdown, form reminders), haptics, HR during sets.
   - Logging speed targets: repeating a workout ≤3 taps, a set ≤2 taps.
   - The data model (local-first), HealthKit writes (a strength workout with duration and energy), and backup/restore (`backup.ts`).
   - The LLM app model block (`src/services/appModel.ts`) for the coach, and the existing workout library (`src/services/workoutLibrary.ts`) and human-coach prescription (`app/coach-athlete.tsx`).

## Constraints
- **The app:** React Native / Expo SDK 52, iOS, TypeScript; a SwiftUI watch app in `targets/watch/`; local Xcode builds.
  - Watch changes are hard-gated by a review hook.
  - Every watch reinstall resets the watch's HealthKit grant: Geert must re-approve in the iPhone Health app. The watch never shows its own Health sheet.
- **It must work KEYLESS:** the LLM features are optional.
- **Local-first privacy:** no personal data in git; flag every new third party.
- **Geert:** a Belgian runner, heat-sensitive, carries central weight, conservative coaching. Strength goal: support running (economy, injury resilience) and body composition. Assume home and gym options.
- **Licences:** be exact about images, GIFs and videos (commercial-use and attribution requirements), in case the app is ever distributed (TestFlight exists).

## Deliverable (PM integrates, reviewer signs off)
- `docs/strength/REPORT.md` plus a published, private Artifact page containing:
  1. an executive summary;
  2. the market findings and feature matrix;
  3. auto-detection feasibility (what's realistic on an Ultra 1 / watchOS 26), with a recommended approach;
  4. planning, progressive overload, the load model and the feedback loop;
  5. the exercise DB, media and form-cue options, with licences;
  6. the UX flows (builder, schedule, watch session with spoken cues, post-workout feedback), and the integration design (data model, Daily Coach / calendar / 7-Day Plan hooks, HealthKit);
  7. **OPTIONS:**
     - **A** MVP;
     - **B** solid v1;
     - **C** ambitious.
     For each: scope, effort (build sessions), risks (incl. watch-gate and Health re-approval costs);
  8. a recommendation and a **decision list for Geert**.
- `docs/strength/TRACKER.md` (final state), plus the reviewer's sign-off notes.
- If the nutrition report (`docs/nutrition/REPORT.md`) exists, note the overlaps: shared UX patterns, a combined "Food + Strength" roadmap, body composition in Biology mode.
