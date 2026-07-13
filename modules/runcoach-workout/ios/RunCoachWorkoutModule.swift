import ExpoModulesCore
import WorkoutKit
import HealthKit

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
    let name = workout.displayName ?? "Day"
    try await removeNamed(name)

    let plan = WorkoutPlan(.custom(workout))
    let when = Calendar.current.dateComponents(
      [.year, .month, .day, .hour, .minute],
      from: Date().addingTimeInterval(300)
    )
    try await WorkoutScheduler.shared.schedule(plan, at: when)
    return true
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
        var alert: (any WorkoutAlert)? = nil
        if let lo = d(b["powerLowWatts"]), let hi = d(b["powerHighWatts"]), lo > 0, hi > 0 {
          let lower = Measurement(value: min(lo, hi), unit: UnitPower.watts)
          let upper = Measurement(value: max(lo, hi), unit: UnitPower.watts)
          alert = PowerRangeAlert(target: lower...upper)
        }

        let work = IntervalStep(.work, goal: workMin > 0 ? .time(workMin * 60, .seconds) : .open, alert: alert)

        let restMin = d(b["restMinutes"]) ?? 0
        if restMin > 0 {
          // Recovery belongs BETWEEN reps only — the cooldown follows the final rep, so
          // never append a dangling recovery after it. reps-1 work+recovery, then a bare work.
          let rec = IntervalStep(.recovery, goal: .time(restMin * 60, .seconds))
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
