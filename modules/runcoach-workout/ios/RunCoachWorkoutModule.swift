import ExpoModulesCore
import WorkoutKit
import HealthKit

// App-lifetime store so an in-flight HKQuantitySeriesSampleQuery isn't cancelled when the
// AsyncFunction closure returns (a local store would dealloc and drop the query → never resolves).
private let sharedHealthStore = HKHealthStore()

public class RunCoachWorkoutModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RunCoachWorkout")

    AsyncFunction("isSupported") { () -> Bool in
      if #available(iOS 17.0, *) { return true }
      return false
    }

    AsyncFunction("authorize") { () async -> String in
      if #available(iOS 17.0, *) {
        let state = await WorkoutScheduler.shared.requestAuthorization()
        return String(describing: state)
      }
      return "unsupported"
    }

    // Build + schedule the structured workout to the watch, overwriting the same-named
    // (weekday) slot. Other days' workouts are kept → a "RunCoach AI" group of up to 7.
    AsyncFunction("pushDailyWorkout") { (specJson: String) async throws -> Bool in
      guard #available(iOS 17.0, *) else {
        throw NSError(domain: "RunCoachWorkout", code: 10, userInfo: [NSLocalizedDescriptionKey: "WorkoutKit requires iOS 17+"])
      }
      guard let data = specJson.data(using: .utf8),
            let spec = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
        throw NSError(domain: "RunCoachWorkout", code: 11, userInfo: [NSLocalizedDescriptionKey: "Invalid workout spec JSON"])
      }
      return try await WorkoutPusher.push(spec)
    }

    // Remove just the named (weekday) slot — used on rest days.
    AsyncFunction("clearDailyWorkout") { (name: String) async throws -> Bool in
      guard #available(iOS 17.0, *) else { return false }
      try await WorkoutPusher.removeNamed(name)
      return true
    }

    // iOS 27+: the athlete's UNIFIED heart-rate zones (their Health-Settings zones, else the system-generated
    // ones), so RunCoach can use the SAME zones Apple shows instead of computing its own. Returns a JSON string
    // {"source":"user|system|app|none|unavailable","zones":[{"index":n,"min":bpm,"max":bpm}]} — min=0 on the
    // first (unbounded-low) zone, max=0 on the last (unbounded-high) zone. Empty zones on iOS<27 / no config →
    // JS falls back to the computed Karvonen zones. JSON string (not a dict) to stay Expo-return-type safe.
    AsyncFunction("preferredHeartRateZones") { () async -> String in
      if #available(iOS 27.0, *) {
        if let cfg = try? await sharedHealthStore.preferredWorkoutZoneConfiguration(for: HKQuantityType(.heartRate)) {
          let bpm = HKUnit.count().unitDivided(by: .minute())
          let zones: [[String: Double]] = cfg.zones.map { z in
            ["index": Double(z.index),
             "min": z.minimum?.doubleValue(for: bpm) ?? 0,
             "max": z.maximum?.doubleValue(for: bpm) ?? 0]
          }
          var src = "system"
          switch cfg.source { case .user: src = "user"; case .app: src = "app"; default: src = "system" }
          let payload: [String: Any] = ["source": src, "zones": zones]
          if let data = try? JSONSerialization.data(withJSONObject: payload),
             let s = String(data: data, encoding: .utf8) { return s }
        }
        return "{\"source\":\"none\",\"zones\":[]}"
      }
      return "{\"source\":\"unavailable\",\"zones\":[]}"
    }

    // iOS 27 native RMSSD (HKQuantityTypeIdentifierHeartRateVariabilityRMSSD) — read auth + query. It lives HERE,
    // not in the JS HealthKit lib, because that lib validates identifiers against a pre-iOS-27 enum and throws
    // on this one. RMSSD is its OWN HK type (distinct from SDNN) so it needs its own read grant. Used as a
    // cross-check against our R-R-derived RMSSD and a last-resort recovery fallback. No-op (false / []) pre-27.
    AsyncFunction("authorizeRmssd") { () async -> Bool in
      if #available(iOS 27.0, *) {
        do { try await sharedHealthStore.requestAuthorization(toShare: [], read: [HKQuantityType(.heartRateVariabilityRMSSD)]); return true }
        catch { return false }
      }
      return false
    }

    // RMSSD samples in [startMs, endMs] → [{ t: epochMillis, v: ms }]. Plain sample query (RMSSD is discrete,
    // not a series). Resolves [] on iOS < 27 or no data. Promise arg so the query isn't dropped when the closure returns.
    AsyncFunction("queryRmssd") { (startMs: Double, endMs: Double, promise: Promise) in
      guard #available(iOS 27.0, *) else { promise.resolve([[String: Double]]()); return }
      let type = HKQuantityType(.heartRateVariabilityRMSSD)
      let start = Date(timeIntervalSince1970: startMs / 1000.0)
      let end   = Date(timeIntervalSince1970: endMs   / 1000.0)
      let pred  = HKQuery.predicateForSamples(withStart: start, end: end, options: [])
      let unit  = HKUnit.secondUnit(with: .milli)   // RMSSD is milliseconds
      var settled = false
      let query = HKSampleQuery(sampleType: type, predicate: pred, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { (_, samples, _) in
        var out: [[String: Double]] = []
        for s in (samples as? [HKQuantitySample]) ?? [] {
          out.append(["t": s.startDate.timeIntervalSince1970 * 1000.0, "v": s.quantity.doubleValue(for: unit)])
        }
        if !settled { settled = true; promise.resolve(out) }
      }
      sharedHealthStore.execute(query)
    }

    // Expand a HKQuantitySeries into its individual measurements. Older Apple-Watch runs store
    // dense workout HR / running power as a series; the JS HealthKit library's plain sample query
    // returns only the sparse container samples (~10 stray points for a 42-min run). This uses
    // HKQuantitySeriesSampleQuery — the same API Apple's own Fitness app uses — to enumerate every
    // measurement in [startMs, endMs]. Returns [{ t: epochMillis, v: value }] (v = bpm or watts).
    AsyncFunction("queryQuantitySeries") { (typeId: String, startMs: Double, endMs: Double, promise: Promise) in
      guard let qType = HKObjectType.quantityType(forIdentifier: HKQuantityTypeIdentifier(rawValue: typeId)) else {
        promise.resolve([[String: Double]]())
        return
      }
      let start = Date(timeIntervalSince1970: startMs / 1000.0)
      let end   = Date(timeIntervalSince1970: endMs   / 1000.0)
      let pred  = HKQuery.predicateForSamples(withStart: start, end: end, options: [])
      // String initialisers so this compiles on the module's lower deployment target
      // (HKUnit.watt() is iOS 16+). "count/min" = bpm, "m" = metres, "W" = watts.
      let unitStr: String
      switch typeId {
      case HKQuantityTypeIdentifier.heartRate.rawValue:              unitStr = "count/min"
      case HKQuantityTypeIdentifier.distanceWalkingRunning.rawValue: unitStr = "m"
      default:                                                       unitStr = "W"
      }
      let unit = HKUnit(from: unitStr)
      var out: [[String: Double]] = []
      var settled = false
      let query = HKQuantitySeriesSampleQuery(quantityType: qType, predicate: pred) { (_, quantity, dateInterval, _, done, error) in
        if let q = quantity, let di = dateInterval {
          out.append([
            "t":    di.start.timeIntervalSince1970 * 1000.0,
            "tEnd": di.end.timeIntervalSince1970   * 1000.0,   // needed to derive pace from a distance series
            "v":    q.doubleValue(for: unit),
          ])
        }
        if (done || error != nil) && !settled {
          settled = true
          promise.resolve(out)   // resolve with whatever we have; JS falls back if empty
        }
      }
      sharedHealthStore.execute(query)
    }
  }
}

@available(iOS 17.0, *)
enum WorkoutPusher {
  static func push(_ spec: [String: Any]) async throws -> Bool {
    let state = await WorkoutScheduler.shared.requestAuthorization()
    guard state == .authorized else {
      throw NSError(domain: "RunCoachWorkout", code: 12, userInfo: [NSLocalizedDescriptionKey: "Workout scheduling not authorized"])
    }

    let workout = build(spec)
    // Clear EVERY previously-scheduled workout of ours before adding the new one. `scheduledWorkouts` is
    // per-app so these are only ours, and in practice only today's is ever live (we always schedule at
    // now+5min). Removing by NAME alone left stale entries — e.g. when a `remove` silently failed, or the
    // name differed between the coach's plan and an adjusted re-synth — so the watch kept showing the OLD
    // duration next to the new one. Remove-all guarantees the pushed (adjusted) workout is the only one.
    await removeAllScheduled()

    let plan = WorkoutPlan(.custom(workout))
    let when = Calendar.current.dateComponents(
      [.year, .month, .day, .hour, .minute],
      from: Date().addingTimeInterval(300)
    )
    try await WorkoutScheduler.shared.schedule(plan, at: when)
    return true
  }

  // Remove EVERY workout we've scheduled (the list is per-app → all ours). Best-effort per entry.
  static func removeAllScheduled() async {
    let scheduled = await WorkoutScheduler.shared.scheduledWorkouts
    for sw in scheduled { try? await WorkoutScheduler.shared.remove(sw.plan, at: sw.date) }
  }

  // Remove all currently-scheduled custom workouts whose display name matches.
  static func removeNamed(_ name: String) async throws {
    let scheduled = await WorkoutScheduler.shared.scheduledWorkouts
    for sw in scheduled {
      if case .custom(let cw) = sw.plan.workout, (cw.displayName ?? "") == name {
        try? await WorkoutScheduler.shared.remove(sw.plan, at: sw.date)
      }
    }
  }

  private static func d(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }
  private static func i(_ v: Any?) -> Int? { (v as? NSNumber)?.intValue }

  static func build(_ spec: [String: Any]) -> CustomWorkout {
    let name = (spec["name"] as? String) ?? "Day"
    // Warmup/cooldown come from the athlete's WorkoutStructure setting: a positive distance (metres) →
    // a distance goal; 0 (or absent) → an OPEN target the runner controls with the lap button.
    let warmupM   = d(spec["warmupMeters"])   ?? 0
    let cooldownM = d(spec["cooldownMeters"]) ?? 0
    let warmup   = warmupM   > 0 ? WorkoutStep(goal: .distance(warmupM,   .meters)) : WorkoutStep(goal: .open)
    let cooldown = cooldownM > 0 ? WorkoutStep(goal: .distance(cooldownM, .meters)) : WorkoutStep(goal: .open)

    var blocks: [IntervalBlock] = []

    // Drills as a short work block right after the warmup. Named "Drills" (iOS 18+) so the
    // post-run analysis can identify and EXCLUDE this segment from the power/HR calibration.
    if let drills = d(spec["drillsMinutes"]), drills > 0 {
      let drillStep: IntervalStep
      if #available(iOS 18.0, *) {
        drillStep = IntervalStep(.work, step: WorkoutStep(goal: .time(drills * 60, .seconds), displayName: "Drills"))
      } else {
        drillStep = IntervalStep(.work, goal: .time(drills * 60, .seconds))
      }
      blocks.append(IntervalBlock(steps: [drillStep], iterations: 1))
    }

    if let rawBlocks = spec["blocks"] as? [[String: Any]] {
      for b in rawBlocks {
        let reps = max(1, i(b["repeats"]) ?? 1)
        let workMin = d(b["workMinutes"]) ?? 0

        // Power target → PowerRangeAlert (running power, watts).
        //
        // ⚠️ CRASH GUARD (2026-07-18). WorkoutKit `fatalError`s with `unsupportedRange` on a ZERO-WIDTH
        // range — and a Swift fatalError is a TRAP: it cannot be caught from JS, so it kills the whole
        // process (signal 5). A plan whose block carried powerLowWatts == powerHighWatts (191...191, an
        // LLM-supplied single power target rather than a band) therefore crash-LOOPED the app: the day's
        // workout is auto-pushed to the watch on launch, so it died within seconds of every start, with
        // no way in to clear it. Guarantee a minimum spread here, at the boundary, so NO upstream source
        // (LLM, cached plan, coach prescription, hand-edit) can ever trap the process again.
        func powerAlert(_ loKey: String, _ hiKey: String) -> (any WorkoutAlert)? {
          guard let lo = d(b[loKey]), let hi = d(b[hiKey]), lo > 0, hi > 0 else { return nil }
          let minSpread = 6.0                                  // watts — WorkoutKit needs a real band
          var loV = min(lo, hi), hiV = max(lo, hi)
          if hiV - loV < minSpread {
            let mid = (loV + hiV) / 2
            loV = max(1.0, mid - minSpread / 2)
            hiV = loV + minSpread
          }
          return PowerRangeAlert(target: Measurement(value: loV, unit: UnitPower.watts)
                                     ... Measurement(value: hiV, unit: UnitPower.watts))
        }
        let alert = powerAlert("powerLowWatts", "powerHighWatts")

        let work = IntervalStep(.work, goal: workMin > 0 ? .time(workMin * 60, .seconds) : .open, alert: alert)

        let restMin = d(b["restMinutes"]) ?? 0
        if restMin > 0 {
          // A FLOAT (Z2/Z3 recovery, flagged by its own recovery watt band) is running WORK at a lower
          // effort — push it as a .work step so HealthKit records it as Work and its minutes land inside
          // time-on-feet. A jog/walk rest has no band and stays .recovery, correctly outside the budget.
          let floatAlert = powerAlert("recoveryLowWatts", "recoveryHighWatts")
          let rec = floatAlert != nil
            ? IntervalStep(.work,     goal: .time(restMin * 60, .seconds), alert: floatAlert)
            : IntervalStep(.recovery, goal: .time(restMin * 60, .seconds))
          // Recovery belongs BETWEEN reps only — the cooldown follows the final rep, so
          // never append a dangling recovery after it. reps-1 work+recovery, then a bare work.
          if reps > 1 { blocks.append(IntervalBlock(steps: [work, rec], iterations: reps - 1)) }
          blocks.append(IntervalBlock(steps: [work], iterations: 1))
        } else {
          blocks.append(IntervalBlock(steps: [work], iterations: reps))
        }
      }
    }

    return CustomWorkout(
      activity: .running,
      location: .outdoor,
      displayName: name,
      warmup: warmup,
      blocks: blocks,
      cooldown: cooldown
    )
  }
}
