# WS1: Market analysis of strength apps

*RunCoach strength research, WS1. Researched 2026-09-29. Prices are the **US App Store** list prices on that date; EU/BE prices differ. Review statistics come from Apple's public customer-review RSS feed (US storefront, up to 3 pages of "most recent" reviews per app). The raw review dump is in the session scratchpad (`strength/reviews.json`). It is not in git.*

## TL;DR

- **The market splits into three kinds of app:**
  - **self-loggers** (Strong, Hevy, StrengthLog, JEFIT, Boostcamp, Alpha Progression, SmartGym, Gymaholic);
  - **programme/AI generators** (Fitbod, RP Hypertrophy, Caliber, JEFIT's Adaptive Plan);
  - **coach-led follow-along** (Ladder, Future, Fitness+, Runna strength).
- **Fast logging is solved, and every leader does it the same way.**
  - Each set is pre-filled from last time (a "Previous" column).
  - One checkmark tap completes the set.
  - That tap auto-starts a rest timer, set per exercise, which also shows on the lock screen or watch.
  - A set that matches the plan therefore costs **1 tap**. Alpha Progression advertises weight + reps + RIR in two taps.
- **The Apple Watch causes the most complaints.**
  - In the samples, Strong (46 of 150 reviews mention the watch), Gymaholic, SmartGym and JEFIT all draw watch/phone sync failures and "the watch app stopped working after an update".
  - Only Strong and SmartGym document a watch app that is truly **standalone**. Fitbod's is a companion: the phone must start and save the workout, and its rest timer pauses when the screen dims.
- **Auto rep counting exists but does not drive loyalty.**
  - Garmin counts reps but its own manual warns about leg exercises.
  - Garmin forum users log only the total time.
  - Gymatic, the only auto-detect app for Apple Watch, has mixed reviews: sometimes accurate, sometimes it jumps sets at random.
  - WHOOP's newer passive estimate gives muscular *load*, not a structured log.
- **Runner-focused strength is weak on execution.**
  - Runna schedules strength around the run plan (lower body on easy or rest days), but strength sessions are **phone-only** and do not sync to watches.
  - TrainingPeaks has a coach-side strength builder, and its reviews complain that lifting logging is clunky.
  - **No app combines a fast logger that works on the watch with a running plan that knows about strength load.** That gap is RunCoach's opening.

---

## 1. App-by-app

The sample columns come from Apple's RSS feed: "n" is the number of recent reviews pulled, "avg" is the average stars in that sample, "≤2★" is the share of 1–2 star reviews, and "window" is the sample's date span. The feed is a recency sample, not the store average. Store average and rating count are from the iTunes lookup API.

| App (App Store id) | Store ★ (count) | Sample n / avg / ≤2★ | Window | What users love | What users hate (recurring themes in the sample) |
|---|---|---|---|---|---|
| **Strong** (464254577) | 4.86 (108.5k) | 150 / 3.70 / 24% | 2026-03 → 09 | Very simple keystrokes, fine for progressive overload, lifetime licence | Watch sync broken after updates (46/150 mention the watch); free tier capped at 3 routines; custom exercises can't have images; history went missing |
| **Hevy** (1458862350) | 4.92 (95.1k) | 100 / 4.91 / 0% | 5 days in 2026-09 | Easy setup, cheap, progressive overload visible, custom routines | The 100 reviews span only 5 days and 93% are 5★, which suggests an in-app rating prompt. Treat as a **positive-biased sample**. Paywall comments concern the 4-routine cap |
| **Fitbod** (1041517543) | 4.81 (286k) | 50 / 3.82 / 22% | 2026-09 | Removes "what do I do today", good for beginners | Billing and refund complaints; "doesn't learn", jumps of about 20% or no progression; ignores the equipment you selected; must pay before the first workout |
| **JEFIT** (449810000) | 4.76 (46.9k) | 100 / 3.45 / 33% | 2026-02 → 09 | Big exercise library, long-time users | **Redesigned set/weight input** that users hate; "AI bloat"; forgets the rest timer and weights; needs internet on open; watch loses sync; free features moved behind the paywall |
| **Caliber** (1482405410) | 4.84 (6.0k) | 150 / 4.05 / 21% | 2025-05 → 2026-09 | Human coach quality | Ads say "free" but it's a trial; 15+ onboarding questions before you can browse exercises; "strength score" drops seen as an upsell; video contradicts the written cue |
| **Future** (1288178982) | 4.87 (10.7k) | 150 / 3.78 / 27% | 2024-01 → 2026-09 | Real coach, accountability | **AirPods/Bluetooth disconnects when phone and watch are used together**; slow HR on the watch; asks for voice commands for "next exercise"; $199/mo |
| **Ladder** (1502936453) | 4.95 (201.7k) | 100 / 4.85 / 3% | 1 week in 2026-09 | Just open and follow; in-ear coach you can mute; music integration | A few say it's "admin work" mid-workout. Sample is short and positive |
| **StrengthLog** (1434229662) | 4.86 (3.6k) | 100 / 4.53 / 9% | 2024-01 → 2026-02 | Generous free tier, intuitive, videos, plate/1RM tools | Watch app crashed or couldn't save (2024–25); premium ($16.90/mo) seen as steep |
| **Boostcamp** (1529354455) | 4.85 (10.3k) | 100 / 3.44 / 33% | 2024-08 → 2026-09 | Huge free programme library | Crashes; **data loss after an update**; deleting an exercise mid-workout has only a 3 s undo; timer resets when you switch apps; card-required "free" trial |
| **Alpha Progression** (1462277793) | 4.92 (2.2k) | 150 / 4.65 / 4% | 2024-07 → 2026-09 | Shows last time + a recommendation for every set; 14-day trial | No watch app (users ask for one); some basics hit a paywall; manual plan entry is tedious |
| **RP Hypertrophy** (1555614554) | 4.30 (233) | 149 / 4.33 / 9% | 2025-12 → 2026-09 | Auto-regulated mesocycles and deloads from pump/soreness/workload feedback; technique videos | No rest timer; no undo for skipped sets; progression can stall for months; **won't work without a good connection**; $34.99/mo |
| **SmartGym** (922744883) | 4.70 (34.1k) | 150 / 4.17 / 16% | 2026-05 → 09 | Easy, standalone watch, edit on the fly, Siri start | Watch/phone sync after a watch upgrade; closes between sets; **Apple's Workout Buddy switches off when SmartGym starts a workout**; dark mode only |
| **Gymaholic** (648518560) | 4.58 (3.5k) | 100 / 3.14 / 39% | 2020-07 → 2024-02 | Watch-first logging, 3D animations | Paid lifetime features moved to a subscription; watch broke after a watchOS update. The feed's newest review is from 2024 even though the app updated in 2026-09, so the sample is **stale** |
| **Runna** (1594204443) | 4.85 (34.4k) | 150 / 3.52 / 33% | 2026-07 → 09 | Strength + mobility planned *inside* the run plan; strength workouts praised by marathoners | Watch sync of runs (Ultra 2 mention); strength workouts shown with "distance"; injury plans can't repeat a workout; billing |
| **WHOOP** (933944389) | 4.81 (82.2k) | 100 / 3.53 / 34% | 2026-08 → 09 | First wearable to put strength into Strain | Strength Trainer **crashes when you reorder exercises mid-workout** (you lose half the workout); can't switch between two active strength activities; support complaints |
| **Gymatic** (1036069872, extra: auto-detect) | 4.31 (1.9k) | 200 / 3.52 / n/a | 2017 → 2026-08 | Auto exercise detection + rep counting that "just works" for some | Some users find it very inaccurate ("~15%"); jumps to the next set at random; can't undo auto-counted sets; misses the first and last reps |
| **Nike Training Club** (301521403, extra) | 4.85 (282k) | strength-related reviews only | 2025–26 | Free, filters for equipment and length | Mostly video-only; can't see the list of exercises up front |
| **TrainingPeaks** (408047715, extra: runner/endurance) | 4.70 (12.7k) | strength-related reviews only | 2024–26 | Coach can put strength into the same calendar as endurance | Lifting UI is weak; no comments on lift workouts; iPad video layout is broken |

Apps without a sample:

- **Apple Fitness+ strength** is part of the Apple Fitness app, not a standalone listing.
- **Garmin strength** has no app of its own; the App Store has Garmin Connect only. Strength complaints in Connect reviews concern the random ordering of the exercise list.
- **Reddit** (r/fitness, r/weightroom, r/Hevy, r/running) could not be fetched: WebFetch refuses reddit.com. **This is a gap.** Vendor forums (Garmin) and App Store reviews were used instead.

---

## 2. Feature matrix

**Key:**

- ✅ = yes, documented.
- ◐ = partial or companion only.
- ✗ = no.
- ? = not documented / not verified.

**Taps per set** is estimated from the documented flow for a set that matches the pre-fill. It was **not measured on device**.

| App | Model | Taps / set | Prefill "previous" | Templates / repeat | Supersets | Rest timer (auto on set done) | Watch app | Watch-side logging | Progression engine | Form media | Spoken cues | Auto-detect / reps | Free tier | Paid (US) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Strong** | Self-log | 1 (checkbox) | ✅ | ✅ (free: 3 routines) | ✅ | ✅ auto countdown; crown edits it on the watch | ✅ watchOS 10+ | ✅ **standalone**, crown pickers, live sync | Warm-up/plate calc; no auto-progression | Animated demos | ✗ | ✗ | Unlimited logs, 3 routines | $4.99/mo, $29.99/yr |
| **Hevy** | Self-log | 1 | ✅ (last time any workout, or same routine) | ✅ routines, duplicate | ✅ (+ circuits) | ✅ per exercise 5 s–5 min, ±15 s, Live Activity | ✅ | ✅ routines on the watch, set tracking, live sync, auto-save on reconnect | Visual only | Free videos | ✗ | ✗ | 4 routines, 7 custom exercises, 3 mo history (third-party) | $2.99/mo, $23.99/yr, $74.99 lifetime |
| **Fitbod** | AI generator | 1–2 | ✅ (generated) | ✅ | ? | ◐ watch timer pauses when the screen dims | ◐ **companion** | ◐ log sets + rest; phone must start and save | ✅ AI (users dispute it) | Videos | ✗ | ✗ | Trial only | $15.99/mo, $95.99/yr |
| **JEFIT** | Self-log + AI plan | 1–2 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ live sync, set count + rest on the watch; "unlimited smartwatch workouts" = Elite | ✅ Adaptive Plan | 1,400+ videos/animations | ◐ "audio cues" (Elite) | ✗ | Yes, shrinking | $12.99/mo, $69.99/yr |
| **Caliber** | Self-log + coach | ? | ? | ✅ | ✅ | ? | ✗ (HealthKit sync only) | ✗ | Strength Score | 500+ videos | ✗ | ✗ | Self-guided app | Plus $6–12/mo; coaching tiers |
| **Future** | Human coach | Follow-along | n/a | Coach-built | ✅ | ✅ | ✅ watchOS 10+ | ◐ follow-along + HR | Coach | Videos + **voice cues** | ✅ | ✗ | ✗ | $199/mo |
| **Ladder** | Coach programmes | Follow-along + log | ◐ | Daily plan | n/a | ✅ built-in timer | ✅ watchOS 10+ | ◐ stats on the watch | ✅ programme | Videos | ✅ in-ear coach, ducks music | ✗ | 7-day trial | $29.99–49.99/mo |
| **StrengthLog** | Self-log + programmes | 1 | ✅ | ✅ many free programmes | ✅ | ✅ | ✅ (2025) | ◐ start from scratch on the watch; programmes need the phone; phone needed to save | Programmes | Videos | ✗ | ✗ | **Most generous free tier** | $16.90/mo, $109/yr |
| **Boostcamp** | Programme library + log | 1 | ✅ auto-populate | ✅ 11k programmes | ✅ | ✅ Live Activity | ✗ | ✗ | ✅ auto-progression, RPE/RIR, e1RM | Form videos | ✗ | ✗ | Full library free | $11.99/mo … $59.99/yr, $199.99 lifetime (site) |
| **Alpha Progression** | Self-log + recommendations | **2 (weight+reps+RIR, vendor claim)** | ✅ + **next-set recommendation** | ✅ | ✅ | ✅ Live Activity | ✗ (roadmap) | ✗ | ✅ RIR ramps, periodisation, deloads (Pro) | 795 videos | ✗ | ✗ | Unlimited logging | $12.99/mo, $79.99/yr |
| **RP Hypertrophy** | Meso generator | ? | ✅ targets | 45+ templates | ? | ✗ (users ask for one) | ✗ | ✗ | ✅ **feedback-driven** (pump/soreness/workload) | 250+ videos | ✗ | ✗ | ✗ | $34.99/mo, $299.99/yr |
| **SmartGym** | Self-log + AI | 1–2 | ✅ | ✅ | ? | ✅ | ✅ **App of the Year 2023** | ✅ **standalone**, Siri start, edit on the watch, NL workout creation | AI Smart Trainer | 730+ animations | ◐ HIIT voice guidance | ✗ | Yes | $9.99/mo, $59.99/yr (+ tiers) |
| **Gymaholic** | Watch-first self-log | 1–2 | ? | ✅ | ? | ✅ + HIIT timers | ✅ | ✅ "log every set from your Watch" | Charts | 3D animations | ✅ voice guidance | ✗ | Limited | $3.99/mo, $31.99/yr |
| **Fitness+ strength** | Follow-along video | n/a | n/a | Custom Plans | n/a | n/a | ✅ metrics | ✗ no weight/rep log | ✗ | Trainer video | ✅ trainer; **Workout Buddy** (watchOS 26) speaks during Traditional/Functional Strength | ✗ | ✗ | $9.99/mo, $79.99/yr |
| **WHOOP Strength Trainer** | Manual log → muscular load | several | ◐ | ✅ 200 workouts | ? | ? | n/a (WHOOP band) | Log on the phone | ✗ (load, not progression) | ? | ✗ | ◐ 2026 "Passive MSK" estimates load, no set log | Requires membership | $199–359/yr (third-party) |
| **Garmin strength** | Watch-native | 2 buttons (start/end set) + optional edit | ✗ | ✅ workouts from Connect | ✗ ("one move per set") | ✅ | Garmin watch | ✅ | ✗ | ? | ✗ | ✅ **auto rep count** (≥4 reps; leg exercises may not count); optional auto set detection | Free with the watch | n/a |
| **Runna strength** | Run plan + strength sessions | Log tab (phone) | ? | Plan-generated, 30/45/60 min, ≤4/wk | ? | ? | ✅ for runs | ✗ **"strength workouts don't sync to smartwatches"** | Weight log for tracking | Videos | ? | ✗ | Trial | $19.99/mo, $119.99/yr |
| **TrainingPeaks Strength** | Coach builder → athlete log | "two grey hyphens" to fill per parameter | ◐ history | ✅ | ✅ supersets, warm-ups | ? | ✗ (iOS app) | ✗ | Coach | 1,000+ videos | ✗ | ✗ | Basic | Premium (athlete) |
| **Gymatic** | Auto-detect | **0 if detection works** | n/a | ✅ | ? | Auto rest | ✅ | ✅ auto-log | ✗ | Videos (paid) | ✅ rep count spoken | ✅ exercise + reps (mixed accuracy) | Limited | Subscription |

---

## 3. What makes logging easy: patterns across the leaders

| Pattern | Who does it best | Evidence |
|---|---|---|
| **Pre-filled set + one-tap complete** | Hevy (Previous column, configurable "same routine" or "any workout"), Strong (checkbox), Boostcamp (auto-populate) | Hevy help and feature pages; Strong help; Boostcamp listing |
| **Next-set recommendation** shown before the set | Alpha Progression ("weight and reps to go for, based on previous workouts and today"), RP (weekly targets) | App Store descriptions |
| **Rest timer that starts itself**, with per-exercise duration, ±15 s nudge, lock screen or Dynamic Island | Hevy, Alpha, Boostcamp | Hevy rest-timer page; Alpha/Boostcamp listings |
| **Watch: one set on screen at a time, crown to adjust** | Strong | Strong help ("focus on a single set or timer at a time"; crown pickers) |
| **Standalone watch** (phone in the locker) | Strong, SmartGym | Strong help; SmartGym listing ("no need to use the iPhone") |
| **Templates you can save back after a workout** | Strong ("update template when completing a workout"), Hevy (duplicate a routine) | Strong help 177; Hevy routines page |
| **Supersets without friction** | Hevy (⋯ → Add To Superset; chains become circuits; "smart superset scrolling") | Hevy supersets page |
| **Voice/in-ear coach that plays nicely with music** | Ladder (lowers music volume when the coach speaks, mutable) | Ladder listing, search summary |
| **Strength scheduled around runs** | Runna (lower body on easy or rest days; upper body flexible; 1–2/wk recommended; max 4) | Runna support |

---

## 4. The 10 things that make strength logging stick

Each point is derived from the love/hate evidence above. Where a point has a RunCoach implication, it is given at the end of the point.

1. **One tap per set that matches the plan.**
   - Pre-fill from the last session or the prescription, and complete with a single tap. Editing is the exception, done with the crown or a stepper.
   - This is the core of Strong and Hevy's loyalty, and of "simple keystrokes so you're not messing with it mid-workout".
   - *RunCoach target: a set ≤ 2 taps, 1 when on plan.*
2. **"Do it again" is the default.**
   - Offer templates and routines plus "repeat last". Save edits back to the template at the end.
   - Don't cap routines: the routine caps (Strong 3, Hevy 4) are the #1 paywall grievance.
   - *RunCoach target: repeating a workout ≤ 3 taps.*
3. **A rest timer that starts itself and reaches you.**
   - Start it automatically on set completion, with a per-exercise duration and a ±15 s nudge.
   - Surface it on the lock screen, the Dynamic Island and a watch haptic.
   - Failures users hate: a timer that pauses when the watch screen dims (Fitbod), resets on app switch (Boostcamp) or forgets its setting (JEFIT).
4. **A watch app that works alone and never loses a set.**
   - Watch sync is the largest complaint cluster (Strong, SmartGym, Gymaholic, JEFIT, StrengthLog, Runna runs).
   - Local-first on the watch, idempotent merge on the phone, and save on reconnect (Hevy's "auto-save when reconnecting").
5. **Offline-first and data-safe.**
   - "Needs internet in a gym without service" (JEFIT, RP) and "lost all my data after an update" (Boostcamp, Strong history) are one-star triggers.
   - RunCoach's local-first plus `backup.ts` model is already right; strength data must be in the backup from day 1.
6. **Visible, explainable progression.**
   - Users love "shows me what to lift today" (Alpha, RP).
   - They hate opaque AI that "doesn't learn", jumps by about 20%, or stalls for months (Fitbod, RP).
   - Show the target *and* the reason ("hit 3×10 last time → +2.5 kg"). A deterministic rule (double progression, RIR) fits the keyless requirement.
7. **Stable, boring UI; no AI bloat.**
   - JEFIT's redesign of set input and its AI pushes drew the harshest reviews from long-time users.
   - Keep the logger minimal, and keep the LLM optional and out of the set loop.
8. **Forgiving edits mid-workout.**
   - Offer real undo, skip or unskip of sets, swapping an exercise while keeping the numbers, and reordering without crashing.
   - Counter-examples: Boostcamp's 3 s undo, RP's missing undo, WHOOP crashing on reorder.
9. **Audio that coexists with music and earbuds.**
   - Spoken cues should duck, not stop, the music, and must not break Bluetooth. Future's AirPods disconnects and SmartGym killing Workout Buddy are churn reasons. Ladder's ducking and mute is praised.
   - *RunCoach already has SpeechCue plus watch→phone earbud routing and the pending-utterance resume logic, so reuse it.*
10. **Honest setup: start logging in seconds, and fit it into the plan.**
    - No 15-question interrogation (Caliber), no card-required "free" trial (Boostcamp, Caliber, Fitbod) and no equipment choices that get ignored (Fitbod, RP).
    - Strength should appear *in* the running week, as Runna does, so it is done rather than forgotten.

**Not on the list: auto rep counting.**

- Garmin's own manual warns that leg exercises may not register, and forum users simply log total time.
- Gymatic reviews swing from "amazingly accurate" to "~15%", and users can't undo auto-counted sets.
- Auto-detect is a nice extra, not what makes people stick. WS2 covers feasibility.

---

## 5. Implications for RunCoach (input to WS5 / WS6)

- **The whitespace is a runner's app with Strong-grade logging on the watch.**
  - Runna, the strongest runner-focused competitor, leaves strength phone-only.
  - The loggers know nothing about the run plan.
  - TrainingPeaks has the calendar but a weak lifting UX.
- **Copy the proven micro-patterns, not the business models:**
  - Previous/prescription pre-fill;
  - one-tap complete;
  - an auto rest timer with ±15 s;
  - one set per watch screen with crown edits;
  - repeat last / save back to the template.
- **Scheduling rule already validated in market:** lower-body strength on easy or rest days, upper body flexible, and 1–2 sessions a week recommended (Runna). WS3 should back this with evidence.
- **Spoken cues are a real differentiator for self-logging.**
  - Strong, Hevy, Alpha, Boostcamp and StrengthLog document no spoken cues. JEFIT offers "audio cues" only in the paid Elite tier. Voice comes mainly from coach-led apps (Ladder, Future, Fitness+ Workout Buddy) and from Gymaholic/Gymatic.
  - RunCoach's existing audio path makes this cheap.
- **Watch risk is also where competitors fail.** Each watch release is a churn risk, so keep the watch strength mode small: set and rest timers, lap = next set, cues. Write the structure as metadata at finish (see the WS2 `beginNewActivity` warning).
- **Load accounting is a trend:**
  - WHOOP moved from manual Strength Trainer logging (2023) to "Passive MSK" load estimates (2026), which raises Strain and makes Recovery more conservative.
  - Folding strength into load is expected. WS3 covers the sRPE → TRIMP mapping.

## Recommendation (WS1 view)

Build a **minimal self-logger in the style of Strong and Hevy, embedded in the RunCoach plan**:

- templates with "strength for runners" presets;
- pre-filled sets with one-tap complete and a deterministic next-set target;
- an auto rest timer;
- optional spoken cues through the existing earbud routing;
- scheduling via Daily Coach / 7-Day Plan.

On the watch:

- Start with **set and rest timers plus "lap = next set"**, a standalone session and cues.
- Treat full watch-side weight/rep editing as a second step, given the review gate and the Health re-approval cost per reinstall.
- Do **not** make auto rep counting or auto exercise detection part of the MVP. Market evidence says it neither retains users nor works reliably for lower-body lifts, which matter most for runners.

---

## Gaps and caveats

- **Reddit was not reachable** ("Claude Code is unable to fetch from www.reddit.com"), so r/fitness, r/weightroom, r/Hevy and r/running were not sampled. App Store reviews and the Garmin forum were used instead.
- **The RSS samples are small and recency-biased.**
  - Hevy's and Ladder's samples cover about a week and look prompt-inflated.
  - Gymaholic's newest US review is from 2024-02, so its feed is stale even though the app updated in 2026-09.
  - The WHOOP and Runna samples are not strength-specific.
- **Several vendor help pages returned HTTP 403** (Fitbod help, Garmin support FAQ, WHOOP Locker, WHOOP pricing, Business Wire). For those, facts come from search-result summaries of the same pages or from third-party write-ups, labelled "(via search)" or "(third-party)" in Sources.
- **Taps per set are estimates** from documented flows, not device measurements.
- **Watch-app presence** comes from the iTunes lookup `supportedDevices` field ("Watch4" entries present = watch app bundled), cross-checked against vendor pages. It was not verified on a device.
- **Third-party review sites** (sensai.fit, push-pull.app, arvo.guru, findyouredge.app, riven.fit and similar) are often competitor SEO pages. They were used only for prices or features not on a primary page, and are marked as such.

## Sources

**App Store data (primary)**
- Apple RSS customer reviews, pattern `https://itunes.apple.com/us/rss/customerreviews/page={1..3}/id={appId}/sortBy=mostRecent/json`, pulled 2026-09-29 for all ids listed in §1. Gymatic, TrainingPeaks, Garmin Connect and NTC used pages 1–5.
- iTunes Lookup/Search API: https://itunes.apple.com/lookup?id=464254577 (and the same for each id in §1): ratings, versions, `supportedDevices`, descriptions.
- Strong: https://apps.apple.com/us/app/strong-workout-tracker-gym-log/id464254577
- Hevy (IAPs, watch features): https://apps.apple.com/us/app/hevy-workout-tracker-gym-log/id1458862350
- StrengthLog (IAPs): https://apps.apple.com/us/app/strengthlog-workout-tracker/id1434229662
- RP Hypertrophy (IAPs, features): https://apps.apple.com/us/app/rp-hypertrophy/id1555614554
- SmartGym (IAPs, watch): https://apps.apple.com/us/app/smartgym-gym-home-workouts/id922744883
- Gymaholic (IAPs, watch): https://apps.apple.com/us/app/gymaholic-workout-tracker/id648518560
- Ladder (IAPs): https://apps.apple.com/us/app/ladder-strength-training-plans/id1502936453
- Runna (IAPs): https://apps.apple.com/us/app/runna-running-plans-coach/id1594204443
- Caliber (IAPs, no watch app): https://apps.apple.com/us/app/caliber-strength-training/id1482405410
- Boostcamp (IAPs, no watch app): https://apps.apple.com/us/app/boostcamp-workout-programs/id1529354455
- Alpha Progression (IAPs, no watch app): https://apps.apple.com/us/app/alpha-progression-gym-tracker/id1462277793
- Future (price): https://apps.apple.com/us/app/future-pro-personal-training/id1288178982
- WHOOP listing: https://apps.apple.com/us/app/whoop/id933944389
- Gymatic: https://apps.apple.com/us/app/gymatic-workout-tracker/id1036069872
- 10W2S: https://apps.apple.com/us/app/10w2s-strength-for-running/id1535607096

**Vendor documentation (primary)**
- Strong for Apple Watch: https://help.strongapp.io/article/222-strong-for-apple-watch
- Strong watch workout flow: https://help.strongapp.io/article/224-workout-on-apple-watch
- Strong first workout: https://help.strongapp.io/article/229-my-first-workout
- Strong update template: https://help.strongapp.io/article/177-update-template-or-routine
- Hevy rest timer: https://www.hevyapp.com/features/workout-rest-timer/
- Hevy previous values: https://help.hevyapp.com/hc/en-us/articles/36011896355479-How-to-Use-Previous-Workout-Values-to-Improve-Performance-in-Hevy (via search)
- Hevy supersets: https://www.hevyapp.com/features/what-are-supersets/ (via search)
- Hevy routines: https://www.hevyapp.com/features/gym-routines/ (via search)
- Fitbod Apple Watch help: https://help.fitbod.me/hc/en-us/articles/360006499194-Apple-Watch (403; via search)
- JEFIT Elite: https://www.jefit.com/elite (via search)
- StrengthLog watch app: https://www.strengthlog.com/the-best-gym-app-for-apple-watch-is-here/
- Boostcamp Pro: https://www.boostcamp.app/pro (via search)
- SmartGym: https://smartgymapp.com/watch (via search)
- Ladder pricing: https://www.joinladder.com/pricing (via search)
- Runna strength: https://support.runna.com/en/articles/15624879-adding-strength-training-to-your-runna-plan
- Garmin strength recording (vívoactive 6 manual): https://www8.garmin.com/manuals/webhelp/GUID-8C2C402F-55AC-431F-9CF2-1442B89CE149/EN-US/GUID-49D892BF-429E-454D-B0C6-D4AE07E9D4A0.html
- Garmin rep-count accuracy FAQ: https://support.garmin.com/en-US/?faq=ziQyOH7oYa2MrsQFReusJ6 (403; not read)
- Garmin forum thread on auto sets/reps: https://forums.garmin.com/apps-software/mobile-apps-web/f/garmin-connect-mobile-ios/287125/automatically-track-sets-reps-and-rests-for-strength-training
- Apple Fitness+: https://www.apple.com/apple-fitness-plus/
- Apple watchOS 26 / Workout Buddy: https://www.apple.com/newsroom/2025/06/watchos-26-delivers-more-personalized-ways-to-stay-active-and-connected/ (via search)
- Apple workout types: https://support.apple.com/en-us/105089 (lists Traditional/Functional Strength; no rep/set tracking documented)
- WHOOP muscular load: https://www.whoop.com/us/en/thelocker/how-whoop-measures-muscular-load/ (403; via search)
- TrainingPeaks Strength: https://www.trainingpeaks.com/strength-athlete/ and https://help.trainingpeaks.com/hc/en-us/articles/21397126893581-Using-the-Strength-Workout-Builder (via search)

**Third-party (secondary; used only where no primary page was reachable)**
- WHOOP 2026 Passive MSK update: https://the5krunner.com/2026/02/28/new-whoop-strength-trainer-update/
- WHOOP tier prices: https://trackervs.com/pricing/whoop-pricing/ (via search)
- Hevy free-tier limits: https://www.sensai.fit/blog/hevy-review-2026 (via search)
- Fitbod price and trial: https://www.sensai.fit/blog/fitbod-review-2026 (via search); cross-check https://help.fitbod.me/hc/en-us/articles/360004904714-How-to-Subscribe-to-Fitbod
- Alpha Progression watch roadmap: https://www.compareworkoutapps.com/reviews/alpha-progression-app-review/ (via search; the App Store listing confirms "no watch")
- Gymatic accuracy summary: https://riven.fit/blog/best-automatic-rep-counter-apps-apple-watch (via search)
- Runner-strength roundup (identified 10W2S, Edge, None to Run): https://www.findyouredge.app/news/best-hybrid-training-apps-2026 (via search; competitor-authored)
