# WS5: UX flows and RunCoach integration (strength)

**Workstream:** 5 of the strength research brief (BRIEF.md §5). **Owner:** integration agent. **Date:** 2026-09-29.
**Mode:** research only. No app code was changed. Two throwaway Swift spikes ran in the session scratchpad (`…/scratchpad/strength/ws5/wk.swift`, `wk2.swift`).
**Inputs used:** a code read of `workoutLibrary.ts`, `app/workout-library.tsx`, `planIcs.ts`, `week-plan.tsx` (skim), `daily-coach.tsx` (skim), `appModel.ts`, `backup.ts`, `coach.ts` (types, prescription, commitments), `coach-athlete.tsx`, `runKeepAlive.ts`, `targets/watch/WorkoutEngine.swift` + `RouteView.swift`, `modules/runcoach-watchsync/ios/RunCoachWatchSyncModule.swift`, `modules/runcoach-workout/ios/RunCoachWorkoutModule.swift`, the watch review gate hook, and `docs/nutrition/REPORT.md`.
**Depends on:**
- WS3 supplies the placement, overload and load-conversion rules. This file only defines where those rules plug in.
- WS4 supplies the exercise DB, media and cue text.
- WS2 supplies the detection scope. This design assumes **manual set logging** (tap = next set) and no rep counting.

All numbers in wireframes are illustrative, not Geert's data.

---

## 1. Key findings

| # | Finding | Why it matters | Evidence |
|---|---|---|---|
| 1 | **The phone can already write a strength workout to Health over OTA.** The installed `@kingstinct/react-native-healthkit` 9.0.11 exposes `saveWorkoutSample(activityType, quantities, start, end, totals, metadata)`, and the phone already requests **Workouts share** (`healthkit.ts` `watchShareTypes`). | A phone-logged session can land in Health as `traditionalStrengthTraining` (50) or `functionalStrengthTraining` (20), with duration, energy and our set structure in metadata. It needs no native build, no new permission and no watch change. | `node_modules/@kingstinct/react-native-healthkit/lib/typescript/healthkit.ios.d.ts`; `src/services/healthkit.ts` l.284 |
| 2 | **WorkoutKit accepts strength custom workouts with named steps.** Spike on the macOS 27 SDK: `CustomWorkout.supportsActivity(.traditionalStrengthTraining / .functionalStrengthTraining) == true`, with time and open goals indoors. A 3× (open "Split squat 3×8/leg @ 12 kg" + 90 s "Rest") block built and wrapped in a `WorkoutPlan` without error. `WorkoutStep.displayName` is watchOS 11+ / iOS 18+. | Our **existing** `runcoach-workout` module (currently hardcoded `activity: .running`) could push a strength session to **Apple's Workout app**. That module is **outside the watch review gate** (the gate covers only `targets/watch`, `modules/runcoach-watchsync`, `watchRoute.ts`). So it needs one local Xcode build, and no watch reinstall or Health re-approval. | Spike output in §9; [WWDC24 10084](https://developer.apple.com/videos/play/wwdc2024/10084/) ("customize step names for all workout types"); [supportsActivity](https://developer.apple.com/documentation/workoutkit/customworkout/supportsactivity(_:)); `~/.claude/hooks/watch-review-gate.sh` l.10 |
| 3 | **Our watch engine already has 80% of a strength mode.** `WorkoutEngine` steps through `RouteSeg`s: an **open** segment advances on `lap()` (= "set done"), a timed segment auto-advances (= rest), `announceSegment` speaks the label, `countdownEnd` speaks "10 seconds / 3, 2, 1" as one utterance, `segLog` + `sendExecStructure` send actual start/end seconds per phase to the phone, and there's a no-HR watchdog and a mute toggle. | A strength session maps to `[work(open, "Split squat, set 1 of 3, 8 per leg"), recovery(90 s), …]` with `sport: "strength"`. The minimum watch change is small, but it is still **gated**, needs a watch install and resets the watch's Health grant. | `WorkoutEngine.swift` `lap()`, `tickSegments`, `countdownEnd`, `sendExecStructure`; `RouteView.swift` `RouteSeg`, `SpeechCue` |
| 4 | **Spoken cues on earbuds reuse the existing path unchanged.** `SpeechCue.say` → WCSession `cue` → the phone speaks it only if it has an **external output** (earbuds/BT), and otherwise the watch speaks. | Strength mode inherits earbud routing for free. Two caveats: the phone's warm-up line is hardcoded to "Starting run", and the phone keep-alive uses **background location** to stay reachable. In a stationary gym session the latter costs battery and needs the Always grant (§5.4). | `RunCoachWatchSyncModule.swift` `primeAudio`, `session(_:didReceiveMessage:replyHandler:)`; `runKeepAlive.ts` |
| 5 | **Haptics pause HR sampling**, per Apple: "When you engage the haptic engine, HealthKit stops gathering heart rate data until after the haptic engine finishes." Wrist HR also under-reads in resistance exercise (pooled mean difference −7.26 bpm, 95% CI −10.46 to −4.07, vs reference in a 2020 meta-analysis). | Keep haptics to set/rest transitions only, never a per-second tick. Show HR during sets as **display-only**, and never use it as the strength load driver (WS3's sRPE is). | [WKInterfaceDevice.play](https://developer.apple.com/documentation/watchkit/wkinterfacedevice/play(_:)); [Zhang et al. 2020, J Sports Sci 38(17)](https://doi.org/10.1080/02640414.2020.1767348) |
| 6 | **The Ultra 1 has no double-tap gesture** (Series 9 / Ultra 2 and later only). The Digital Crown **press** belongs to the system; apps get crown **rotation** only. | "Next set" on the watch = one big on-screen tap, or optionally the **Action Button** (today it's wired to `TogglePauseIntent`). Crown rotation adjusts reps/kg. | [Apple Newsroom, double tap](https://www.apple.com/newsroom/2023/10/apple-watch-double-tap-gesture-now-available-with-watchos-10-1/); [digitalCrownRotation](https://developer.apple.com/documentation/swiftui/view/digitalcrownrotation(_:)) |
| 7 | **Set structure goes in workout metadata at finish, never in-session activities.** HK metadata keys are strings; values are NSString/NSNumber/NSDate; custom keys are "encouraged". `HKWorkoutBuilder.addMetadata` exists on iOS 12+/watchOS 5+. | One compact JSON string key (`RC_strength_v1`) + `RC_sessionId` is written at finish. The phone JSON sidecar stays authoritative. No `beginNewActivity` (which failed the session on 2026-09-25). | [HKObject.metadata](https://developer.apple.com/documentation/healthkit/hkobject/metadata); [addMetadata](https://developer.apple.com/documentation/healthkit/hkworkoutbuilder/addmetadata(_:completion:)); [beginNewActivity](https://developer.apple.com/documentation/healthkit/hkworkoutsession/beginnewactivity(configuration:date:metadata:)); `WorkoutEngine.swift` l.57–63 |
| 8 | **There is no phone TTS over OTA.** `expo-speech` and `expo-haptics` are not installed. `expo-keep-awake`, `expo-notifications` and `expo-av` are. | Phone-only logging over OTA gets: screen kept awake, a rest-end **local notification**, and optionally bundled generic audio clips via `expo-av`. **Spoken exercise names on the phone** need one native build. Cheapest route: add a `speak()` function to the ungated `runcoach-workout` module (no prebuild). | `ls node_modules/expo-*`; `package.json` |
| 9 | **The coach's strength output is free text today.** `CoachPlan.strength` is ≤22 words, the keyless default is `STRENGTH_DEFAULT`, `coach-athlete.tsx` sends `strength: ''`, and `parseWeeklyCommitments` treats "gym/strength/weights" as a **hard** commitment that protects the next day. | Add a structured `strengthSession` next to the string rather than replacing it (§6). The commitment regex is already a scheduling hook. | `coach.ts` l.108, 789, 1268; `coach-athlete.tsx` l.117 |

---

## 2. Design principles and tap-count targets

1. **Pre-fill everything.** Every set row starts with the prescribed target, or last time's actual values plus the WS3 progression step. The common case is "did what it said" = **one tap**.
2. **Log on tap, with undo** (same pattern as food, `docs/nutrition/REPORT.md` §5). No Save button inside a session, and a 4 s undo toast after each commit.
3. **The rest timer starts itself** when a set is committed, and the next set is announced when it ends. There's no separate "start rest" tap.
4. **Repeat beats build.** The home/Daily Coach card offers "Same as last time" before anything else.
5. **Keyless first.** Every flow works with no LLM key: presets, progression, placement and feedback rules are deterministic (WS3). The LLM only phrases things.
6. **One source of truth per fact.** Sets live in the phone JSON log. HealthKit carries the workout (time, energy, HR) plus a metadata copy. Load comes from WS3's sRPE conversion; the HR-TRIMP of the same workout is **replaced**, never added.

| Flow | Target | Designed taps | Where |
|---|---|---|---|
| T1 Repeat last strength workout, live logging | ≤3 | **2**: card "↻ Same as Tue" → Start | Phone |
| T2 Repeat and log after the fact ("did it") | ≤3 | **3**: "✓ Did it" → Save (pre-filled as planned) → sRPE chip | Phone |
| T3 Log a set as prescribed | ≤2 | **1**: ✓ on the row | Phone |
| T4 Log a set with different reps or kg | ≤2 | **2**: tap the value → pick from the inline strip (commits + undo) | Phone |
| T5 Log a set on the watch | ≤2 | **1**: big "Done". Different reps: crown turn + "Done" = 1 tap | Watch (B) |
| T6 Timed set (plank, hops) | ≤2 | **1**: "Go". It auto-completes at 0, and the side switch is spoken | Phone / watch |
| T7 Post-workout feedback | – | **2–3**: sRPE chip → feel chip → (Save auto on 2nd chip). Skippable | Phone |
| T8 Next-morning soreness | – | **1**: chip on the morning coach page | Phone |
| T9 New workout from a preset | – | 5 (one-off): ＋ → Goal → Where → Time → Save | Phone |
| T10 Swap an exercise | – | 2: tap exercise → pick an alternative (same pattern, owned equipment) | Phone |
| T11 Tag a strength workout from Apple Workout / another app | ≤3 | **3**: prompt → pick template → sRPE chip | Phone |

---

## 3. Flows and text wireframes

### 3.1 Strength Library and builder (phone)

This is a **separate screen and store** from the run Workout Library (recommendation in §6.4). It opens from the 7-Day Plan (next to "Workout Library") and from the Daily Coach strength card.

```
[‹ Back]              Strength Library
Where: (● Home) (○ Gym)     Kit: dumbbells · band · box   ✎
────────────────────────────────────────────────────────────
★ PRESETS · for runners
┌ Runner Foundation      bodyweight · 20 min · 5 ex    ▶ ┐
┌ Runner Strength A      dumbbells  · 30 min · 5 ex    ▶ ┐
┌ Runner Strength B      dumbbells  · 30 min · 5 ex    ▶ ┐
┌ Heavy Legs             gym        · 40 min · 4 ex    ▶ ┐   ← greyed at Home (needs barbell)
┌ Plyo Primer            bodyweight · 12 min · 4 ex    ▶ ┐
┌ Calves & Achilles      bodyweight · 10 min · 3 ex    ▶ ┐
┌ Core & Hips            bodyweight · 15 min · 5 ex    ▶ ┐
┌ Quick 4 (coach default) bodyweight · 10 min · 4 ex   ▶ ┐   ← = today's STRENGTH_DEFAULT, structured
MY WORKOUTS
┌ Tue gym (edited A)     gym · 35 min · last 3 d ago   ▶ ┐
                                        [＋ New workout]
```

- **Presets** are data only: names, exercise ids, sets/reps and rest. Their programme content (volumes, which exercises) comes from WS3 and the exercise ids from WS4. Presets are read-only. "Edit" makes a copy under My Workouts.
- **Equipment filter:** "Kit" is a one-time multi-select (bodyweight, band, dumbbells, kettlebell, box/step, bench, pull-up bar, barbell/rack, machines). At **Home**, a preset whose required kit isn't owned is greyed, with an "Auto-swap to home kit" action. It swaps each exercise to the first WS4 alternative with the same movement pattern and owned equipment.

**＋ New workout (3-question wizard, keyless):**

```
1  Goal     (Runner strength) (Heavy legs) (Plyo & hops) (Core & hips) (Calves & Achilles) (Mobility)
2  Where    (Home · bodyweight) (Home · my kit) (Gym)
3  Time     (10) (20) (30) (45) min
            ↓ deterministic generator = preset for the goal, filtered by kit, trimmed by time
┌ Runner strength · home kit · 20 min ─────────────────────────┐
│ 1 Split squat (DB)        3 × 8/leg   rest 90s        ⋮ ↔    │  ↔ = swap (T10)
│ 2 Single-leg RDL (DB)     3 × 8/leg   rest 90s        ⋮ ↔    │
│ 3 Calf raise, single-leg  3 × 12/leg  rest 60s        ⋮ ↔    │
│ 4 Side plank              2 × 30s/side rest 45s       ⋮ ↔    │
│   [＋ Add exercise]   (search + filter sheet, same pattern as the food add-sheet)
│ Superset: long-press 3 → "Pair with 4"                         │
└──────────────────────────────────────── [Save]  ~21 min ─────┘
```

- The **add-exercise sheet** reuses the food add-sheet pattern: one search box, filter chips (muscle, equipment, pattern), and Recents / ★ tabs. It searches the bundled WS4 exercise subset offline.
- **Per-exercise ⋮** menu: rest, a sets×reps or time stepper (the same `Stepper` component as `workout-library.tsx`), "per side", RIR target, the progression rule (WS3: double progression default), and a note/cue override.
- **Minutes estimate** = Σ(sets × (work-sec estimate + rest)) + transitions. This drives the load projection in the 7-Day Plan (§4.2).

### 3.2 Scheduling: Daily Coach, 7-Day Plan, season plan, calendar

**Daily Coach card** (replaces today's `🦵 LEG STRENGTH` text row at `daily-coach.tsx` l.596):

```
🦵 STRENGTH · Runner Strength A · ~30 min · home
Split squat 3×8/leg @12 kg (+1 rep) · SL-RDL 3×8 · Calf raise 3×12 · Side plank 2×30s
Why today: easy run day; 48 h before Thu intervals; Tue legs recovered.      ← WS3 rule text, deterministic
[▶ Start]   [↻ Same as Tue]   [✓ Did it]                    ⋯ swap · move · skip
                                                     [⌚ Send to watch]  (B: RunCoach · A+: Apple Workout)
```

- **Not a strength day** (per WS3 rules, e.g. the day before intervals): the card collapses to `No strength today: intervals tomorrow. Optional: Calves & Achilles (10 min, low load)`. Keyless.
- **Rest day forced by the cap/readiness** (`intensity: 'rest'`): the plan still offers strength if WS3 allows it, with the existing text ("mobility & strength") now linked to a template.
- **Injured / sick / break** (`athlete_status_v1`): strength is replaced by "pain-free mobility" (today's behaviour), with no template.
- The **LLM** may rephrase the "Why today" line and the `strength` string. It never picks the exercises or loads.

**7-Day Plan** (`week-plan.tsx`): each day row gets a strength chip, and the projection includes strength load.

```
Tue  Easy 40min Z2               🏋 A · 30'        strain 38  ATL ▲
Wed  Rest                        🏋 light · 10'    strain 22
Thu  Intervals 5×3min Z4         –                 strain 61
Fri  Easy 30min                  🏋 B · 30'        strain 40
Long-press 🏋 → move to another day (the rules re-check and warn: "Heavy legs <24 h before Thu intervals")
```

**Season plan** (`seasonPlan.ts` weeks): each week gets a **strength focus + frequency** from WS3's phase mapping, e.g. Base "2× general / hypertrophy", Build "2× heavy + plyo", Peak "1× maintenance", Taper "1× light, none in race week" (the exact rules are WS3's). Deload weeks inherit the running deload (`periodization_v1`), and strength volume drops by the WS3 factor.

**Calendar (.ics)** extends `planIcs.ts`, which is pure string generation and unit-testable:

| What | ICS shape | Notes |
|---|---|---|
| Season weeks (exists) | All-day week banner (`DTSTART;VALUE=DATE`) | Add `· strength 2× heavy+plyo` to the SUMMARY/DESCRIPTION |
| Planned strength days (new, next 7–14 days from the deterministic plan) | All-day `VEVENT` "🏋 Runner Strength A · 30 min", DESCRIPTION = the exercise list. UID `runcoach-strength-<date>@runcoachai` | A stable UID means a re-import updates rather than duplicates. All-day `DATE` values per [RFC 5545 §3.6.1](https://datatracker.ietf.org/doc/html/rfc5545#section-3.6.1). |
| Optional preferred time (setting) | Timed event + `VALARM` (e.g. −15 min) | Only if Geert sets a strength time. It's a local time, so the export includes a `TZID` (Europe/Brussels) |

### 3.3 Phone session logger (Option A's recorder)

```
Runner Strength A        12:40 ⏱  ♥ 112 (if a watch workout is running)     [End]
────────────────────────────────────────────────────────────────────
1 Split squat (DB)  · cue: knee tracks over toes           ⓘ (form card, WS4)
   last: 3×8 @ 10 kg · today +2 kg (double progression)
   ✓ 1   8/leg   12 kg                        ← done (tap = undo toast)
   ● 2   8/leg   12 kg   [✓]                  ← T3: 1 tap  | T4: tap "8" → strip 6 7 [8] 9 10 → pick = commit
   ○ 3   8/leg   12 kg
   REST 1:12 ━━━━━━━━━━░░░░  [+30s] [skip]    ← auto-started on commit; keep-awake on; local notif at 0
2 Single-leg RDL …
────────────────────────────────────────────────────────────────────
[＋ Exercise]                                        [Finish → feedback]
```

- **Rest timer:** `expo-keep-awake` keeps the screen on, and an `expo-notifications` local notification fires at rest end if the phone is locked or backgrounded. No native build is needed.
- **Spoken cues on the phone:** these need native TTS (Finding 8). In A they're absent or clip-based. With the A+ native build, the phone speaks the same script as the watch (§3.4), ducking music like `RunCoachWatchSyncModule` does.
- **Crash-safe:** each commit writes the in-progress session (a merge write of one session, never a whole-shard replace; this is the daily-components lesson), so a force-quit resumes where it stopped.

### 3.4 Watch strength mode (Option B) with spoken cues

**Screens** (a nested pager like the run screen: controls ◂ | centre | ▸ media):

```
┌──────────────────────────┐   ┌──────────────────────────┐   ┌──────────────────────────┐
│ SPLIT SQUAT     2/3      │   │ REST            ♥ 128    │   │ SIDE PLANK  1/2  L       │
│ 8 / leg   ·   12 kg      │   │      1:05                │   │      0:22                │
│ (crown: reps ↕)          │   │  ◔ ring                  │   │  ━━━━━━░░░               │
│ ♥ 121  peak 134          │   │ Next: Split squat 3/3    │   │ ♥ 115                    │
│ ┌──────────────────────┐ │   │ [+30s]        [Skip ▸]   │   │                          │
│ │        DONE ✓        │ │   │                          │   │  auto → "Switch sides"   │
│ └──────────────────────┘ │   └──────────────────────────┘   └──────────────────────────┘
└──────────────────────────┘
 set screen (open segment)      rest (timed segment)           timed set (timed "work")
```

- **Next set:** a tap on DONE calls `lap()` on the open segment. Optionally, a strength-mode setting remaps the **Action Button** from pause to "Done". Pausing between sets is **wrong** for strength: rest is not a pause, and a pause stops recording and triggers the existing "still paused" reminder.
- **Crown** rotates reps (hold "kg" to switch the crown to weight in 0.5/1/2.5 steps). The change rides along in `segLog` as optional `reps`/`kg` keys.
- **HR:** live HR, plus peak HR per set in the set log (display and history only; Finding 5).
- **Haptics** fire only at transitions: set committed (`.success`), rest ending ("3, 2, 1" gets `.click`, as today), next exercise (`.notification`). None per second.

**Spoken cue script** (all through `SpeechCue.say`, so they honour the mute toggle and earbud routing):

| Moment | Cue (example) | Existing mechanism |
|---|---|---|
| Session start | "Strength. Runner A. Five exercises, about thirty minutes." | `announceSegment` of the first segment |
| First set of an exercise | "Split squat. Three sets of eight per leg, twelve kilos. Knee over toes." | Label + **one** form reminder (≤6 words, WS4, first set only; setting "Form tips: on/off") |
| Later sets | "Set two of three. Eight per leg." | Label |
| Set committed | "Rest ninety seconds." | `.success` haptic + the recovery segment's announce |
| Rest countdown | "Thirty seconds" (rest ≥60 s) · "Ten seconds" · "3, 2, 1" (one utterance) | `countdownEnd`, enabled for **recovery** segments in strength mode |
| Next exercise | "Next: single-leg Romanian deadlift, eight per leg." | Announce of the next work segment |
| Timed set | "Side plank, left, thirty seconds. Go." → "Ten seconds" → "Switch sides." | Timed work segment + countdown |
| End | "Strength complete. Fourteen sets, thirty-two minutes." | `advanceSegment` → "Workout complete" (text extended) |

The watch speaks when no earbuds are on the phone. An Ultra paired directly to AirPods plays watch audio there.

### 3.5 Post-workout feedback (phone; also prompted after a watch or Apple Workout session)

```
Runner Strength A · 32 min · 14/14 sets · ♥ avg 108 (wrist; under-reads in lifting)
How hard was the whole session?  (session RPE, CR-10)
 1   2   3   4  [5]  6   7   8   9   10            ← 1 tap
How did the loads feel?
 (Too easy)  (● Just right)  (Too hard)            ← 1 tap → auto-save
Optional: per-exercise "reps in reserve on the last set"  ▸
────────────────────────────────────────────
Next time (deterministic, WS3):
 Split squat 3×9/leg @12 kg · Calf raise 3×12 @+4 kg · Side plank 2×35s
[Done]
```

**Next morning:** a chip on the morning coach page reads `Legs after Tue strength: (None) (Mild) (Sore) (Very sore)`. It takes 1 tap, is stored on the session, and feeds the WS3 rule (e.g. "Sore" or worse → the quality run downgrades or the next strength session drops a set). It sits beside the existing Timeline/Status and isn't a new check-in screen.

### 3.6 Sessions recorded elsewhere (Apple Workout, Hevy, Strong…)

The HK scan already sees types 20/50 (`trainingLoad.ts` factor 0.6). When a new strength workout without our `RC_sessionId` appears, the app prompts: `Strength · 34 min found (Apple Workout). Log it? [Runner A] [Other…] [Skip]` → sRPE chip. That's 3 taps (T11). It links by `hkWorkoutUuid`, so there's no second HK write. Sets are optional.

---

## 4. Integration design

### 4.1 Data model (local-first, TypeScript)

```ts
// src/services/strength.ts  (new; pure helpers + load/save, mirrors workoutLibrary.ts)
export type Equipment = 'bodyweight' | 'band' | 'dumbbell' | 'kettlebell' | 'box' | 'bench'
                      | 'pullupBar' | 'barbell' | 'machine';
export type StrengthPlace = 'home' | 'gym';
export type Pattern = 'squat' | 'hinge' | 'lunge' | 'calf' | 'plyo' | 'core' | 'push' | 'pull' | 'hip' | 'mobility';

export interface ExerciseDef {            // bundled WS4 subset (app asset, NOT backed up) or user custom
  id: string; name: string; source: 'bundled' | 'custom';
  pattern: Pattern; muscles: string[]; equipment: Equipment[];
  mode: 'reps' | 'time';                 // time = planks, hops, holds
  perSide?: boolean;
  cueShort?: string;                     // ≤6 words — spoken + watch (WS4)
  cues?: string[];                       // phone form card (WS4), ≤3 bullets
  mediaRef?: string;                     // WS4 asset id + licence tag
  alternatives?: string[];               // same pattern, different kit → swap / auto-swap
}

export interface SetTarget { reps?: number; repsMax?: number; seconds?: number; kg?: number; rir?: number }
export type Progression =
  | { kind: 'double'; repsMin: number; repsMax: number; kgStep: number }   // WS3 default
  | { kind: 'linear'; kgStep: number }
  | { kind: 'time'; secStep: number; secMax: number }
  | { kind: 'none' };

export interface TemplateItem {
  exerciseId: string; sets: SetTarget[]; restSec: number;
  supersetWith?: number;                 // index of the paired item
  progression: Progression; note?: string;
}
export interface StrengthTemplate {
  id: string; name: string; source: 'preset' | 'user' | 'coach';
  goal: 'runner' | 'heavy' | 'plyo' | 'core' | 'calves' | 'mobility' | 'custom';
  place: StrengthPlace; equipment: Equipment[]; estMinutes: number;
  items: TemplateItem[]; updatedAt: number;
}

export interface LoggedSet {
  reps?: number; seconds?: number; kg?: number; rir?: number;
  done: boolean; atMs?: number;          // commit time → rest actually taken = next start − this
  hrPeak?: number;                       // display only (watch)
}
export interface SessionExercise { exerciseId: string; name: string; target: SetTarget[]; sets: LoggedSet[] }

export interface StrengthSession {
  id: string;                            // also written to HK metadata RC_sessionId
  date: string;                          // YYYY-MM-DD, 4 am attribution (same rule as the run/food logs)
  templateId?: string;
  planned?: { by: 'plan' | 'human-coach' | 'self'; forDate: string };
  recorder: 'phone' | 'rc-watch' | 'apple-workout' | 'other-app';
  startMs: number; endMs: number;
  exercises: SessionExercise[];
  sRPE?: number;                         // CR-10
  feel?: 'easy' | 'right' | 'hard';
  soreness?: { date: string; level: 0 | 1 | 2 | 3 };
  hk?: { uuid?: string; written: boolean; activityType: 20 | 50; energyKcal?: number;
         energySource: 'watch' | 'met-estimate' | 'none' };
  load?: { srpeAU: number; trimpEq: number };   // WS3 conversion, cached for CTL/ATL
  notes?: string;
}

// Plan hook: additive to CoachPlan (the string field stays for the LLM/back-compat).
export interface StrengthPrescription {
  templateId: string; name: string; estMinutes: number;
  targets: Record<string, SetTarget[]>;  // exerciseId → today's targets after progression
  why: string;                           // deterministic rule text (WS3)
  optional?: boolean;                    // "light / optional" days
}
// coach.ts: interface CoachPlan { …; strength: string; strengthSession?: StrengthPrescription | null }
// coach.ts: interface WeekPlanDay { …; strength?: { templateId: string; label: string; estMinutes: number; optional?: boolean } }
```

**Storage** (`documentDirectory`, JSON, merge-not-replace writes):

| File / key | Content | `backup.ts` |
|---|---|---|
| `runcoach-strength-library.json` | User templates, custom exercises, owned kit, per-exercise "last used" memory | ✅ add to `FILES` |
| `runcoach-strength-log-YYYY-MM.json` | Monthly shards of `StrengthSession` | ✅ add `'runcoach-strength-log-'` to `FILE_PREFIXES` |
| `strength_settings_v1` (SecureStore) | Default place, sessions/wk, preferred time, cue options (form tips, Action Button = Done), HK write on/off, activity type | ✅ add to `STATIC_SECURE_KEYS` |
| Bundled exercise subset (asset) | WS4 data + media | ❌ app asset (licence tags travel with it) |
| Presets | Code constants (like `workoutLibrary.ts` `seed()`) | ❌ code |
| `strength-load-cache.json` | Per-day sRPE→TRIMP values for CTL/ATL | ❌ recomputable from the log |

`debugExport.ts` gets counts, minutes, sRPE and the HK-write status only. No exercise names are needed.

### 4.2 Load and plan hooks (where WS3's rules plug in)

| Hook | File | Change |
|---|---|---|
| Strength load | `trainingLoad.ts` (types 20/50, factor 0.6) | If an HK strength workout links to a `StrengthSession` with `sRPE` (by `RC_sessionId` metadata or `hk.uuid`), use WS3's `sRPE × min → TRIMP-equivalent` **instead of** the HR-based ×0.6. Phone-logged sessions without a watch contribute the same way. **One path per session**, so there's no double count. |
| Placement | `coach.ts` `getWeekPlan` (deterministic) | Post-pass: place N strength days per WS3 rules (not <X h before quality, hard days hard, ~48 h per muscle group, deload scaling). Emit `WeekPlanDay.strength`. The existing `COMMITMENTS` "gym" entry already marks the following day as protected. |
| Daily prescription | `coach.ts` daily plan (keyless basis) | Fill `strengthSession` from the week's slot + progression. `strength` (string) = `describeStrength()` of it, so today's UI and LLM prompts keep working. |
| Projection | `week-plan.tsx` strain/CTL/ATL | Add the planned strength TRIMP-eq per day (template minutes × expected sRPE). |
| Adherence | `adherence.ts` | Count planned vs done strength sessions (a separate line and not in the run ToF). |
| Volume cap | ToF / cap | **Unchanged**: strength is not time-on-feet (appModel line below says so). |

### 4.3 HealthKit write

| Recorder | Who writes | Activity type | Energy | Structure |
|---|---|---|---|---|
| Phone logger (A) | Phone via `saveWorkoutSample` (JS, OTA) | 50 `traditionalStrengthTraining` by default. 20 `functionalStrengthTraining` if the template is bodyweight/home (setting) | `totals.energyBurned` = MET estimate, **totals only** (no energy samples), so the watch's own passive active-energy samples aren't duplicated. Formula: active kcal ≈ (MET − 1) × kg × h, with MET 3.5 (multiple exercises, 8–15 reps) or 6.0 (vigorous) per the 2024 Compendium codes 02054 / 02050. Worked: (3.5 − 1) × 75 kg × 0.5 h ≈ 94 kcal (illustrative) | `metadata: { RC_sessionId, RC_strength_v1: '<compact JSON>', HKMetadataKeyIndoorWorkout: true }` |
| RunCoach watch (B) | Watch `HKLiveWorkoutBuilder` (watch-measured energy + HR) | Same, sent in the payload (`sport: "strength"`, `strengthType: 50/20`) | Watch-measured. Apple: functional strength has "optimized calorie calculations" from the watch sensors | `builder.addMetadata` **after** `endCollection`, before `finishWorkout`. Also `sendExecStructure` (existing) → phone sidecar |
| Apple Workout via WorkoutKit (A+) | Apple's Workout app | As pushed | Apple | None of ours. The phone links by time overlap + T11 prompt |
| Other apps | Them | – | – | T11 link only |

Rules:

- **Dedup:** before a phone write, if an HK strength workout overlaps the session by >50%, link it (`hk.uuid`) instead of writing.
- **Never in-session activities:** no `beginNewActivity`. `HKWorkoutEvent .segment` exists, but adding events is **untested in this codebase**, so it stays out of scope until a spike proves it safe. Metadata-at-finish + the phone sidecar cover the need.
- **Metadata size:** Apple documents no size limit. Keep `RC_strength_v1` compact, e.g. `[["splitsq",[8,8,7],[12,12,12]],…]`, typically <1 KB. The phone log stays authoritative if the key is ever dropped.
- **Permissions:** the phone already shares Workouts, so there's **no new Health prompt** for A. B adds nothing new on the phone. The watch still only checks access and never shows a sheet (`WorkoutEngine` note).

### 4.4 `backup.ts` and `appModel.ts`

`backup.ts` (three one-line additions):

```ts
// STATIC_SECURE_KEYS
'strength_settings_v1',          // strength: place, sessions/wk, cue options, HK write, activity type
// FILES
'runcoach-strength-library.json', // strength templates, custom exercises, owned kit, last-used memory
// FILE_PREFIXES
'runcoach-strength-log-',         // monthly strength session shards
```

`appModel.ts` (two lines, built like `foodLine`, empty when there's no strength data):

```
• STRENGTH (athlete-logged, in-app): sessions are templates of sets × reps × kg with session-RPE (CR-10) and a
  too-easy/right/too-hard verdict. Load = sRPE × minutes converted to TRIMP units (replaces the HR estimate for that
  workout, never added to it). Strength is NOT time-on-feet and never counts toward the volume cap. Placement is
  deterministic: <WS3 rule summary, e.g. "no heavy legs within 24 h before a quality run; ≥48 h between same-muscle
  sessions; deload weeks −1 set">. Progression is deterministic (double progression); do not invent loads.
• STRENGTH LAST 14 DAYS: 3 sessions (Tue, Fri, Tue), avg sRPE 6, soreness max "mild"; next planned Fri: Runner Strength B.
```

### 4.5 Reuse of `workoutLibrary.ts` and `coach-athlete.tsx`

| Question | Recommendation | Why |
|---|---|---|
| New `kind: 'strength'` in `LibraryWorkout`, or a separate store? | **Separate** `strength.ts` + `runcoach-strength-library.json`. It copies the file's patterns (seeded presets, `describe…()` pure summary, debounced save, `Stepper` UI) | `LibraryWorkout` is built on `WatchWorkoutBlock` (minutes, HR zone, warm-up metres) and flows into `toWorkoutBlob` → watch run pushes and `prescribedTrimp`. A strength entry there would leak into run-only code paths (ToF, power bands, WorkoutKit `.running`). |
| Human-coach prescription | Extend `coach-athlete.tsx` with a "Strength" picker (library chips like "From workout library") that sets `strengthSession` on the plan row. `buildPlan()` today sends `strength: ''` | Same UX the coach already knows. The cloud `PlanRow` needs one optional JSON column (D1). Out of A. |
| Watch payload | Reuse `RoutePayload` + `RouteSeg` with `sport: "strength"`, `pts: []`, `distanceKm: 0`, `indoor: true`. New **optional** `RouteSeg` keys: `reps`, `kg`, `cue`, `perSide` | These must stay Codable-optional (the same rule as `paceLo/paceHi`) so old/new builds decode. |

---

## 5. Watch integration detail (Option B)

### 5.1 Minimum change set

| # | Change | File | Gate |
|---|---|---|---|
| 1 | `sport == "strength"` → `HKWorkoutActivityType(rawValue: strengthType ?? 50)`, `.indoor`, no GPS/route builder (the indoor path already skips both) | `WorkoutEngine.swift` `startFromRoute` | ⛔ gated |
| 2 | In strength mode, `countdownEnd` also fires on **recovery** segments; the "30 seconds" cue for rests ≥60 s | `WorkoutEngine.swift` | ⛔ |
| 3 | Neutral strings when `sport == strength` ("Workout paused", "Workout NOT saved") | `WorkoutEngine.swift` | ⛔ |
| 4 | `segLog` entries accept optional `reps`, `kg`, `hrPeak`. `addMetadata(RC_sessionId, RC_strength_v1)` before `finishWorkout` | `WorkoutEngine.swift` | ⛔ |
| 5 | `StrengthView` (set / rest / timed screens) + a ContentView branch so an empty-route strength payload doesn't open the map pager | `RouteView.swift`/new view, `ContentView.swift` | ⛔ |
| 6 | Optional Action Button → Done in strength mode | `NextSegmentIntent.swift` / pause intent | ⛔ |
| 7 | Phone: build the strength payload, and consume strength `execSegs` into the session log | New `strengthWatch.ts` (keep it **out** of `watchRoute.ts` if possible), `runSegmentsLog.ts` | `watchRoute.ts` is ⛔ if touched |
| 8 | Phone: "Starting run" warm-up line → generic "Starting" | `RunCoachWatchSyncModule.swift` | ⛔ (cosmetic; can be skipped) |

**Auto-pause is safe:** it requires `distanceM > 15`, which an indoor strength session never reaches. The **no-HR watchdog** and the **run-anyway hatch** apply unchanged.

### 5.2 Costs specific to B

- **Watch review gate:** a full `watch-regression-reviewer` pass (recording integrity, Codable-optional payload, cues/audio), plus the on-device smoke test.
- **Health re-approval:** every watch reinstall resets the watch's HK grant. Geert must re-approve in the **iPhone Health app** (profile › Apps › RunCoach), not on the watch.
- **Regression surface:** changes 1–4 live in the run engine. Every branch must be `sport == strength`-guarded so the run path is byte-identical. The alternative is a separate `StrengthEngine` class that duplicates the HK session code: safer for runs, but more code to keep in sync. **Recommendation:** guarded branches in `WorkoutEngine`, because the reviewer checklist already covers it.

### 5.3 A+ alternative: push to Apple's Workout app (no watch gate)

- Extend `RunCoachWorkoutModule.build` with `activity` + `location` + per-step `displayName`. The first step is an open "Split squat · 3×8/leg · 12 kg", followed by a timed "Rest 90 s", repeated per set as an `IntervalBlock`.
- **Gains:**
  - Apple-grade recording, HR and energy;
  - step alerts on the wrist;
  - zero changes under `targets/watch`;
  - it works with the existing "Send to Apple Workout" button path (`daily-coach.tsx` l.100).
- **Loses:**
  - Our spoken script. Apple's step alerts are a full-screen notice plus haptics. Workout Buddy speaks for strength on watchOS 26, but it's AI-generated encouragement, not our targets, and needs an Apple Intelligence iPhone, English and headphones ([Apple Newsroom](https://www.apple.com/newsroom/2025/06/watchos-26-delivers-more-personalized-ways-to-stay-active-and-connected/)).
  - Per-set reps/kg logging on the wrist. Logging happens on the phone afterwards (T2/T11, pre-filled).
- **Caveats:**
  - The spike ran against the **macOS** WorkoutKit SDK. `supportsActivity` must be re-checked on iOS 27 / watchOS 26 at build time, and its result guarded.
  - Apple's own **Custom Workout builder** in the Fitness app didn't expose strength in DC Rainmaker's hands-on ([DC Rainmaker](https://www.dcrainmaker.com/2025/09/apple-watch-workout-builder-ios26-watchos26.html)). The API path is what the spike shows, and whether the Workout app renders a strength custom workout well is **unverified on device**.

### 5.4 Earbud routing and keep-alive in a gym

- The phone only speaks a cue when the **live** route has an external output, so a mid-session earbud disconnect falls back to the watch.
- The phone must stay **reachable**, which today means the background-location keep-alive (`runKeepAlive.ts`: `distanceInterval: 15`, `pausesUpdatesAutomatically: false`, 3 h cap). In a stationary session that keeps the GPS task alive for ~30–45 min.
  - It works, but it costs battery and needs the **Always** location grant for a watch-started session.
  - A gym phone in a locker is often out of Bluetooth range anyway, and then the watch speaker or watch-paired AirPods take over automatically.
  - **Recommendation:** in strength mode, start the keep-alive only if the phone reported earbuds at `primeAudio` time (the phone knows `phoneAudioTarget`). Otherwise let the watch own audio.

---

## 6. Keyless check (every flow)

| Flow | Keyless path |
|---|---|
| Builder / wizard / swap | Deterministic generator from presets + WS4 metadata |
| Daily Coach / 7-Day / season placement | WS3 rules in `getWeekPlan` post-pass (deterministic) |
| "Why today" text | Rule template string. LLM rephrasing is optional |
| Progression "next time" | WS3 double progression / time progression |
| Cues (spoken + on screen) | Template strings + WS4 `cueShort` |
| Feedback → adjustment | WS3 rule table |
| .ics, HK write, backup | Pure code |
| LLM (optional) | Chat can explain or suggest swaps; the APP MODEL line keeps it truthful |

---

## 7. Overlaps with `docs/nutrition/REPORT.md`

| Area | Shared pattern / decision |
|---|---|
| Add-sheet | The same one-box search + filter chips + Recents/★ tabs component serves foods and exercises. Build it once and parameterise the item row. |
| Log-on-pick + 4 s undo | The same toast component and rule. Strength set commit = food log-on-pick. |
| "Copy yesterday / repeat" | Food F4 (copy yesterday) = strength T1 (same as last). One "repeat" affordance on the home cards. |
| Storage | The same monthly-shard JSON + `FILE_PREFIXES` backup + merge-not-replace + 4 am attribution + debug export totals-only. Neither goes into `cloudSync.ts` by default. |
| appModel | The same "advisory context, deterministic rules" style as `foodLine`. Strength also **changes load** (unlike food, which "never changes the training plan"), so its line must say how. |
| HealthKit | Food writes `Dietary*` (Option B there). Strength writes a workout. Both use `@kingstinct` v9 and existing grants for strength. |
| **Food + Strength roadmap** | A combined "fuel & build" week: strength days raise the protein target (nutrition A-rules) and appear as markers on the food timeline, like run markers. Both land on the **Home modes** (☰ Food / Fitness). |
| **Biology (body composition)** | Weekly strength volume (sets × muscle group) and sessions/wk become drivers in Biology's correlation engine (Spearman + lag scan), next to energy balance and CTL. Targets: lean mass, body fat and weight trends. It's read-only and advisory. |

---

## 8. Effort slices (for the PM's Options)

| Slice | Scope | Build type | Effort (sessions) |
|---|---|---|---|
| S1 | `strength.ts` model + presets + Strength Library screen + wizard + swap + kit filter | OTA | 1.5 |
| S2 | Phone session logger (pre-fill, 1-tap sets, inline strip, rest timer, keep-awake, local notif, crash-safe) | OTA | 1.5 |
| S3 | Post-workout feedback + next-morning soreness chip + "next time" (WS3 rules) | OTA | 1 |
| S4 | Plan hooks: `getWeekPlan` placement, `CoachPlan.strengthSession`, Daily Coach card, 7-Day chips + projection, sRPE load replacing ×0.6, adherence, appModel | OTA | 1.5–2 |
| S5 | HK write (`saveWorkoutSample` + metadata) + T11 tagging + dedup | OTA | 0.5–1 |
| S6 | .ics strength events + season-plan strength focus | OTA | 0.5 |
| S7 | `backup.ts`, debug export, tests (pure helpers like `describeStrength`, the generator, ics) | OTA | 0.5 |
| P1 | Phone TTS: `speak()` in `runcoach-workout` (AVSpeechSynthesizer, duck) + the phone cue script | Local Xcode build, **no watch gate**, no prebuild | 0.5 |
| W0 | WorkoutKit strength push to Apple Workout (module `activity`/`displayName`) | Local Xcode build, **no watch gate** | 0.5–1 |
| W1 | RunCoach watch strength mode (§5.1 changes 1–7) | **Watch gate + watch install + Health re-approval** | 2.5–3.5 + review/test |
| C1 | `coach-athlete.tsx` strength prescription + D1 column | OTA + Worker deploy | 1 |

**Suggested grouping:**

| Option | Slices | Build and watch cost |
|---|---|---|
| A | S1–S7 (~7–8 sessions) | All OTA, keyless, no watch risk |
| A+ | A + P1 + W0 (+1–1.5) | One phone build, still no watch gate |
| B | A+ + W1 + C1 | Watch gate, one Health re-approval |

---

## 9. Spike log (scratchpad only)

`…/scratchpad/strength/ws5/wk.swift` (macOS 27 SDK, `swift wk.swift`):

```
running             supportsActivity=true timeGoal(indoor)=true openGoal(indoor)=true
traditionalStrength supportsActivity=true timeGoal(indoor)=true openGoal(indoor)=true
functionalStrength  supportsActivity=true timeGoal(indoor)=true openGoal(indoor)=true
HIIT / coreTraining / flexibility: all true
```

`wk2.swift`: built `CustomWorkout(activity: .traditionalStrengthTraining, location: .indoor, displayName: "Runner strength A", warmup: 5-min "Mobility warm-up", blocks: [IntervalBlock([open "Split squat 3x8/leg @ 12kg", 90 s "Rest 90s"], iterations: 3)])` → `WorkoutPlan(.custom(cw))` created OK.

**Limits:**
- These are macOS results. iOS/watchOS support must be re-checked on the device at build time.
- Scheduling onto the watch and how the Workout app renders the plan were **not** tested (no device in this research run).

---

## 10. Recommendation (WS5 view)

1. **Build phone-first (A):**
   - a 1-tap set logger;
   - "same as last" in 2 taps;
   - deterministic placement in the Daily Coach and 7-Day Plan;
   - sRPE load replacing the flat 0.6;
   - a HealthKit write via the already-installed JS API.

   All of it is OTA, keyless, with no watch risk and no new Health prompt.
2. **Add A+ in the same week:** one phone-only Xcode build that gives the phone spoken cues (`speak()` in `runcoach-workout`) and pushes the session to Apple's Workout app via WorkoutKit. Geert gets on-wrist steps, HR and energy **without** touching the gated watch target.
3. **Decide on B after 2–3 weeks of A/A+ use.** B brings our own watch strength mode with the full spoken script over earbud routing and per-set crown logging. The engine fit is good (open segment = set, timed = rest, `segLog` = set timing), but it costs a gated review, a watch install and a Health re-approval.

**Decisions this workstream needs from Geert** (the PM merges them into D1–D6):
- (a) Default HK activity type: traditional (50) or functional (20) for home/bodyweight?
- (b) Should the Action Button mean "Done" in watch strength mode (B)?
- (c) Form tips spoken on the first set: on or off by default?
- (d) Preferred strength time for timed .ics events, or all-day only?
- (e) Is the WorkoutKit → Apple Workout path (A+) acceptable, given that it gives no custom speech on the wrist?

---

## Sources

- Apple, HKWorkoutActivityType.traditionalStrengthTraining: https://developer.apple.com/documentation/healthkit/hkworkoutactivitytype/traditionalstrengthtraining
- Apple, HKWorkoutActivityType.functionalStrengthTraining ("optimized calorie calculations"): https://developer.apple.com/documentation/healthkit/hkworkoutactivitytype/functionalstrengthtraining
- Apple, HKObject.metadata (custom keys; NSString/NSNumber/NSDate values): https://developer.apple.com/documentation/healthkit/hkobject/metadata
- Apple, HKWorkoutBuilder.addMetadata(_:completion:): https://developer.apple.com/documentation/healthkit/hkworkoutbuilder/addmetadata(_:completion:)
- Apple, HKWorkoutBuilder (iOS builder; watchOS uses HKLiveWorkoutBuilder): https://developer.apple.com/documentation/healthkit/hkworkoutbuilder
- Apple, HKWorkoutSession.beginNewActivity(configuration:date:metadata:): https://developer.apple.com/documentation/healthkit/hkworkoutsession/beginnewactivity(configuration:date:metadata:)
- Apple, HKWorkoutEventType.segment / .lap: https://developer.apple.com/documentation/healthkit/hkworkouteventtype/segment and https://developer.apple.com/documentation/healthkit/hkworkouteventtype/lap
- Apple, Running workout sessions: https://developer.apple.com/documentation/healthkit/running-workout-sessions
- Apple, HKHealthStore.startWatchApp(with:completion:): https://developer.apple.com/documentation/healthkit/hkhealthstore/startwatchapp(with:completion:)
- Apple, WKInterfaceDevice.play(_:) (haptics stop HR collection; background only in a workout session): https://developer.apple.com/documentation/watchkit/wkinterfacedevice/play(_:)
- Apple, WCSession.transferUserInfo(_:): https://developer.apple.com/documentation/watchconnectivity/wcsession/transferuserinfo(_:)
- Apple, SwiftUI digitalCrownRotation: https://developer.apple.com/documentation/swiftui/view/digitalcrownrotation(_:)
- Apple, WorkoutKit CustomWorkout.supportsActivity(_:): https://developer.apple.com/documentation/workoutkit/customworkout/supportsactivity(_:)
- Apple, WorkoutStep.displayName (iOS 18 / watchOS 11): https://developer.apple.com/documentation/workoutkit/workoutstep/displayname
- Apple WWDC24 session 10084, Build custom swimming workouts with WorkoutKit (step names for all workout types): https://developer.apple.com/videos/play/wwdc2024/10084/
- Apple WWDC23 session 10016, Build custom workouts with WorkoutKit: https://developer.apple.com/videos/play/wwdc2023/10016/
- Apple Newsroom, watchOS 26 (Workout Buddy incl. Functional and Traditional Strength Training): https://www.apple.com/newsroom/2025/06/watchos-26-delivers-more-personalized-ways-to-stay-active-and-connected/
- Apple Newsroom, double tap on Series 9 / Ultra 2: https://www.apple.com/newsroom/2023/10/apple-watch-double-tap-gesture-now-available-with-watchos-10-1/
- DC Rainmaker, Apple Watch custom workout builder in iOS 26 / watchOS 26 (hands-on): https://www.dcrainmaker.com/2025/09/apple-watch-workout-builder-ios26-watchos26.html
- Zhang Y, Weaver RG, Armstrong B, Burkart S, Zhang S, Beets MW. 2020, Validity of wrist-worn photoplethysmography devices to measure heart rate: a systematic review and meta-analysis, J Sports Sci 38(17):2021–2034 (resistance training MD −7.26 bpm): https://doi.org/10.1080/02640414.2020.1767348 (abstract read via Europe PMC; replaces an earlier mis-citation of Ho 2022, which studied a cardiopulmonary exercise test, not lifting)
- Herrmann SD et al. 2024 Adult Compendium of Physical Activities (codes 02050 = 6.0 MET, 02054 = 3.5 MET): https://pacompendium.com/adult-compendium/ and https://pubmed.ncbi.nlm.nih.gov/38242596/
- IETF RFC 5545 iCalendar (§3.6.1 Event Component, DATE values for all-day events): https://datatracker.ietf.org/doc/html/rfc5545
- Hevy, rest timer auto-starts on set completion (reference UX for T3): https://www.hevyapp.com/features/workout-rest-timer/
- Hevy, tutorial (previous-performance column, checkmark per set): https://www.hevyapp.com/hevy-tutorial/
- Code read (local repo, not public): `src/services/{workoutLibrary,planIcs,appModel,backup,coach,trainingLoad,runKeepAlive,healthkit}.ts`, `app/{workout-library,week-plan,daily-coach,coach-athlete}.tsx`, `targets/watch/{WorkoutEngine,RouteView}.swift`, `modules/runcoach-watchsync/ios/RunCoachWatchSyncModule.swift`, `modules/runcoach-workout/ios/RunCoachWorkoutModule.swift`, `node_modules/@kingstinct/react-native-healthkit` 9.0.11 typings, `~/.claude/hooks/watch-review-gate.sh`, `docs/nutrition/REPORT.md`.
- **Gaps:**
  - Reddit was not consulted; user sentiment is WS1's scope.
  - The Apple doc pages were read through Apple's public documentation JSON (`developer.apple.com/tutorials/data/documentation/…`), because the HTML pages render client-side.
  - No on-device verification of WorkoutKit strength plans, metadata size, or the keep-alive's battery cost in a stationary session.
