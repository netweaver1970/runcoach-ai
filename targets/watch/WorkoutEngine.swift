import Foundation
import HealthKit
import AVFoundation
import WatchKit

// Owns the run on the watch: an HKWorkoutSession + live builder so OUR app (not Apple's Workout app) records
// the run. That gives us three things the companion-only route screen couldn't have: the app stays alive in
// the background (wrist down), voice prompts keep playing, and HR/pace/distance/energy are recorded to Health.
// Stage 1 = session + audio + live metrics + save. Stage 2 will drive the structured intervals on top of this.
final class WorkoutEngine: NSObject, ObservableObject {
  static let shared = WorkoutEngine()

  private let store = HKHealthStore()
  private var session: HKWorkoutSession?
  private var builder: HKLiveWorkoutBuilder?
  private var startDate: Date?
  private var ticker: Timer?

  @Published var running = false
  @Published var paused = false
  @Published var heartRate: Double = 0     // bpm
  @Published var distanceM: Double = 0
  @Published var energyKcal: Double = 0
  @Published var elapsed: TimeInterval = 0
  @Published var paceStr = "--:--"         // min/km, from moving-average distance/time

  func requestAuth() async -> Bool {
    guard HKHealthStore.isHealthDataAvailable() else { return false }
    let share: Set<HKSampleType> = [HKObjectType.workoutType()]
    let read: Set<HKObjectType> = [
      HKQuantityType(.heartRate), HKQuantityType(.distanceWalkingRunning), HKQuantityType(.activeEnergyBurned),
    ]
    do { try await store.requestAuthorization(toShare: share, read: read); return true } catch { return false }
  }

  // Kick off from a route payload (keeps HealthKit types out of the SwiftUI view). Requests auth first.
  func startFromRoute(_ r: RoutePayload) {
    Task {
      _ = await requestAuth()
      await MainActor.run { self.start(activity: (r.sport == "walking") ? .walking : .running) }
    }
  }

  func start(activity: HKWorkoutActivityType) {
    guard session == nil else { return }
    let cfg = HKWorkoutConfiguration()
    cfg.activityType = activity
    cfg.locationType = .outdoor
    do {
      let s = try HKWorkoutSession(healthStore: store, configuration: cfg)
      let b = s.associatedWorkoutBuilder()
      b.dataSource = HKLiveWorkoutDataSource(healthStore: store, workoutConfiguration: cfg)
      s.delegate = self
      b.delegate = self
      session = s; builder = b
      let now = Date(); startDate = now
      s.startActivity(with: now)
      b.beginCollection(withStart: now) { _, _ in }
      // Keep an active playback session so turn/interval voice prompts sound even wrist-down.
      try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .voicePrompt, options: [.duckOthers])
      try? AVAudioSession.sharedInstance().setActive(true)
      DispatchQueue.main.async { self.running = true; self.paused = false; self.elapsed = 0 }
      startTicker()
    } catch {
      session = nil; builder = nil
    }
  }

  func togglePause() {
    guard let s = session else { return }
    if paused { s.resume() } else { s.pause() }
  }

  // save == false → discard the workout (nothing written to Health). The UI guards this behind a confirmation.
  func end(save: Bool = true) {
    guard let s = session, let b = builder else { return }
    s.end()
    if save {
      b.endCollection(withEnd: Date()) { _, _ in b.finishWorkout { _, _ in } }
    } else {
      b.discardWorkout()
    }
    stopTicker()
    session = nil; builder = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    DispatchQueue.main.async { self.running = false; self.paused = false }
  }

  private func startTicker() {
    ticker?.invalidate()
    ticker = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      guard let self, let sd = self.startDate, !self.paused else { return }
      DispatchQueue.main.async { self.elapsed = Date().timeIntervalSince(sd); self.updatePace() }
    }
  }
  private func stopTicker() { ticker?.invalidate(); ticker = nil }

  private func updatePace() {
    guard distanceM > 20, elapsed > 5 else { return }
    let secPerKm = elapsed / (distanceM / 1000)
    paceStr = String(format: "%d:%02d", Int(secPerKm) / 60, Int(secPerKm) % 60)
  }
}

extension WorkoutEngine: HKWorkoutSessionDelegate {
  func workoutSession(_ ws: HKWorkoutSession, didChangeTo toState: HKWorkoutSessionState,
                      from: HKWorkoutSessionState, date: Date) {
    DispatchQueue.main.async { self.paused = (toState == .paused) }
  }
  func workoutSession(_ ws: HKWorkoutSession, didFailWithError error: Error) {
    DispatchQueue.main.async { self.running = false }
  }
}

extension WorkoutEngine: HKLiveWorkoutBuilderDelegate {
  func workoutBuilderDidCollectEvent(_ b: HKLiveWorkoutBuilder) { }
  func workoutBuilder(_ b: HKLiveWorkoutBuilder, didCollectDataOf types: Set<HKSampleType>) {
    for t in types {
      guard let qt = t as? HKQuantityType, let stat = b.statistics(for: qt) else { continue }
      if qt == HKQuantityType(.heartRate) {
        let bpm = stat.mostRecentQuantity()?.doubleValue(for: .count().unitDivided(by: .minute())) ?? 0
        DispatchQueue.main.async { self.heartRate = bpm }
      } else if qt == HKQuantityType(.distanceWalkingRunning) {
        let m = stat.sumQuantity()?.doubleValue(for: .meter()) ?? self.distanceM
        DispatchQueue.main.async { self.distanceM = m; self.updatePace() }
      } else if qt == HKQuantityType(.activeEnergyBurned) {
        let kcal = stat.sumQuantity()?.doubleValue(for: .kilocalorie()) ?? self.energyKcal
        DispatchQueue.main.async { self.energyKcal = kcal }
      }
    }
  }
}
