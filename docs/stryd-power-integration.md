# Stryd → HealthKit power integration (DEFERRED — second option)

**Status:** Deferred until Geert has a Stryd pod. This is a *power-quality* upgrade only.
The original motivation — EC drifting with body weight — is already solved for free by the
**weight-adjusted EC** card (`ecn` in `statsLayout.ts` / `app/statistics.tsx`, shipped 2026-08-30,
OTA 01a05453). A dedicated pod does **not** fix the weight artifact (Stryd power is also mass-parameterized;
raw EC = speed÷power stays ∝ 1/mass with any sensor). Do this only if the watch's own power estimate is
too noisy and you want Stryd's cleaner, grade/wind/surface-aware watts.

## Goal
Our own watch app reads the Stryd foot pod over BLE during our `HKWorkoutSession` and records its power as the
workout's running power in HealthKit — so the whole stats pipeline (EC/EF/SE, power-duration curve, NP/IF/TSS,
zone calibration) uses Stryd power instead of Apple's estimate, with no separate app.

## Feasibility — confirmed
- watchOS supports **CoreBluetooth in the central role** since watchOS 6. During an active `HKWorkoutSession`
  the app keeps running, so a `CBCentralManager` can scan / connect / subscribe in the foreground of the workout.
- Stryd speaks **standard BLE profiles** — no Stryd SDK needed, just GATT reads:
  - **Cycling Power Service `0x1818`** → **Cycling Power Measurement `0x2A63`** (notify). Stryd reuses the
    cycling-power profile for running watts. Instantaneous power = `int16` (little-endian) at bytes **[2..3]**,
    after the 16-bit flags field `[0..1]` (standard CPM layout; later optional fields per the flags).
  - **Running Speed & Cadence `0x1814`** → **RSC Measurement `0x2A53`** (notify): flags, instantaneous speed
    (`uint16`, 1/256 m/s), cadence (`uint8`, steps/min), optional stride length + total distance. *(optional —
    only if we also want Stryd distance/cadence)*
  - Battery `0x180F`, Device Info `0x180A` (nice-to-have).

## Architecture / files
- **NEW `targets/watch/StrydSensor.swift`** — a `CBCentralManager` wrapper as an `ObservableObject`:
  scan for peripherals advertising `0x1818` → connect → discover `0x2A63` → subscribe → parse instantaneous
  watts → `@Published var power: Double?` (+ `connected: Bool`). Auto-reconnect on drop; remember the chosen
  peripheral by `CBPeripheral.identifier` (UUID). Optionally also subscribe `0x2A53` for speed/distance.
- **`targets/watch/WorkoutEngine.swift`** (existing HKWorkoutSession owner):
  - On session start, if a Stryd is remembered/enabled, start `StrydSensor`.
  - On each power update (or a 1 Hz timer), build
    `HKQuantitySample(type: .runningPower, quantity: HKQuantity(unit: .watt(), doubleValue: watts), start: now, end: now)`
    and `liveBuilder.add([sample])`.
  - The existing **under/over power cue** (`checkTarget`) can read Stryd power directly → Stryd-driven live
    feedback for structured intervals *without* touching WorkoutKit.
  - If no Stryd connected → unchanged (watch power path).
- **`targets/watch/Info.plist`** — add `NSBluetoothAlwaysUsageDescription`.
- **HealthKit auth** — ensure `HKQuantityTypeIdentifierRunningPower` is in the **SHARE (write)** set of the
  watch's authorization request (we currently read it; confirm we can write it).
- **Phone Settings** — a toggle "Use Stryd power (if paired)" + remembered pod UUID, sent to the watch over the
  existing WatchConnectivity/route payload channel (`src/services/watchRoute.ts`). Optional pairing UI: list
  scanned pods, pick one, store its identifier.

## The fiddly bit — DON'T double-count power
The watch generates its OWN running power. If the live data source also auto-collects it, the saved workout
holds BOTH series → corrupted averages. Options, in order of preference:
1. **Exclude** running power from `HKLiveWorkoutDataSource`'s collected types (so only Stryd samples land).
   Cleanest — VERIFY on-device whether watchOS 9+ auto-collects running power for running workouts and whether
   it can be excluded.
2. **Tag + prefer on read**: mark Stryd samples with metadata (custom `source: stryd` key), and in the JS read
   path (`powerCurve.ts`, `runStats.ts`) prefer Stryd-sourced samples when present. More code, spread out.
3. **Post-process delete** the watch's power samples for that workout, keep Stryd's. Riskiest (deletes HK data).

## Live power targets (scope note)
Structured-interval alerts currently use WorkoutKit `PowerRangeAlert`, which reads the *system* power source, not
an arbitrary BLE stream. Making Stryd drive the WorkoutKit alert is a bigger change → **out of scope for v1**.
v1 = *record* Stryd power + optionally use our own in-app under/over cue (already built) fed by the Stryd stream.

## Test plan
1. Bench: confirm scan finds `0x1818`, subscribe `0x2A63`, parsed watts match the Stryd app's live reading.
2. Confirm exactly ONE power series in the saved workout (no double-count) — check the power sample count via the
   debug export / Health.
3. Same run: compare Stryd-power EC vs watch-power EC — Stryd should be smoother / more consistent.
4. Reconnect: walk out of range / cover the pod mid-run → confirm it reconnects and resumes.
5. Battery + thermal over a long run.
6. Confirm the existing power-target interval alerts still fire (whichever source drives them).

## Effort
~1–2 focused Swift sessions + on-wrist testing. BLE parsing is quick; the dedup + reconnect robustness is where
the time goes. Requires a **native watch build** (local, per the build-conservation rule — next EAS build is the
monthly one). Not OTA-able.

## Prerequisite
Geert acquires a Stryd pod. Until then this stays parked; the weight-adjusted EC covers the weight-artifact need.
