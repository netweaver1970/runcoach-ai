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
  private let synth = AVSpeechSynthesizer()

  @Published var running = false
  @Published var paused = false
  @Published var heartRate: Double = 0     // bpm
  @Published var power: Double = 0         // running power, W
  @Published var distanceM: Double = 0
  @Published var energyKcal: Double = 0
  @Published var elapsed: TimeInterval = 0
  @Published var paceStr = "--:--"         // min/km, from moving-average distance/time

  // Structured-interval state (Stage 2).
  @Published var segLabel = ""             // e.g. "Work" / "Recover" / "Warm-up"
  @Published var segZone = ""              // e.g. "Z4"
  @Published var segRemain = ""            // "2:14" (time) / "350 m" (distance) / "lap ▸" (open)
  @Published var segKind = ""              // work / recovery / warmup / cooldown / drills
  @Published var segIndex = 0
  @Published var segCount = 0
  @Published var segOpen = false           // no time/distance goal → advance with the lap button

  private var segs: [RouteSeg] = []
  private var segStartElapsed: TimeInterval = 0
  private var segStartDist: Double = 0
  private var lastMoveAt: Date?            // last time distance advanced → auto-pause when stationary
  private var autoPaused = false           // paused BY auto-pause (vs a manual pause) so we can auto-resume

  func requestAuth() async -> Bool {
    guard HKHealthStore.isHealthDataAvailable() else { return false }
    let share: Set<HKSampleType> = [HKObjectType.workoutType()]
    let read: Set<HKObjectType> = [
      HKQuantityType(.heartRate), HKQuantityType(.distanceWalkingRunning), HKQuantityType(.activeEnergyBurned),
      HKQuantityType(.runningPower),
    ]
    do { try await store.requestAuthorization(toShare: share, read: read); return true } catch { return false }
  }

  // Kick off from a route payload (keeps HealthKit types out of the SwiftUI view). Requests auth first.
  func startFromRoute(_ r: RoutePayload) {
    segs = r.workout ?? []
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
      DispatchQueue.main.async {
        self.running = true; self.paused = false; self.elapsed = 0
        self.segCount = self.segs.count; self.segIndex = 0; self.segStartElapsed = 0; self.segStartDist = 0
        self.lastMoveAt = Date(); self.autoPaused = false
        if !self.segs.isEmpty { self.announceSegment(self.segs[0]) }   // "Warm-up …"
      }
      startTicker()
    } catch {
      session = nil; builder = nil
    }
  }

  func togglePause() {
    guard let s = session else { return }
    autoPaused = false                     // a manual pause/resume overrides auto-pause bookkeeping
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
    session = nil; builder = nil; segs = []
    try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    DispatchQueue.main.async {
      self.running = false; self.paused = false; self.power = 0
      self.segLabel = ""; self.segRemain = ""; self.segZone = ""; self.segIndex = 0; self.segCount = 0
    }
  }

  private func startTicker() {
    ticker?.invalidate()
    ticker = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      guard let self, let sd = self.startDate, !self.paused else { return }
      DispatchQueue.main.async {
        self.elapsed = Date().timeIntervalSince(sd); self.updatePace(); self.tickSegments()
        // Auto-pause (opt-in) when stationary for 12 s; the distance handler auto-resumes on the next movement.
        if UserDefaults.standard.bool(forKey: "autoPause"), let lm = self.lastMoveAt, Date().timeIntervalSince(lm) > 12 {
          self.autoPaused = true; self.session?.pause()
        }
      }
    }
  }
  private func stopTicker() { ticker?.invalidate(); ticker = nil }

  private func updatePace() {
    guard distanceM > 20, elapsed > 5 else { return }
    let secPerKm = elapsed / (distanceM / 1000)
    paceStr = String(format: "%d:%02d", Int(secPerKm) / 60, Int(secPerKm) % 60)
  }

  // Interval voice cues; honours the same mute toggle as turn cues. Re-activate the audio session per utterance
  // — during a workout watchOS can drop it, which silenced the cues.
  private func speak(_ s: String) {
    guard RouteStore.shared.voiceOn, !s.isEmpty else { return }
    do {
      try AVAudioSession.sharedInstance().setCategory(.playback, mode: .voicePrompt, options: [.duckOthers])
      try AVAudioSession.sharedInstance().setActive(true)
    } catch { }
    let u = AVSpeechUtterance(string: s)
    u.rate = AVSpeechUtteranceDefaultSpeechRate
    synth.speak(u)
  }

  // ─── Structured intervals ───────────────────────────────────────────────────────────────────────────────
  func lap() { if running { advanceSegment() } }   // manual advance (open segments, or skip)

  private func tickSegments() {
    guard running, !segs.isEmpty, segIndex < segs.count else { return }
    let seg = segs[segIndex]
    let inTime = elapsed - segStartElapsed
    let inDist = distanceM - segStartDist
    var done = false
    if let d = seg.dur { done = inTime >= d }
    else if let m = seg.dist { done = inDist >= m }
    if done { advanceSegment() } else { updateSegDisplay(seg, inTime, inDist) }
  }

  private func advanceSegment() {
    segIndex += 1
    segStartElapsed = elapsed; segStartDist = distanceM
    if segIndex >= segs.count {
      segLabel = "Done"; segRemain = ""; segZone = ""; segKind = ""; segOpen = false
      WKInterfaceDevice.current().play(.success); speak("Workout complete")
      return
    }
    announceSegment(segs[segIndex])
  }

  private func announceSegment(_ seg: RouteSeg) {
    WKInterfaceDevice.current().play(.start)
    var phrase = seg.label
    if let d = seg.dur {
      let m = Int((d / 60).rounded())
      phrase += m >= 1 ? ", \(m) minute\(m == 1 ? "" : "s")" : ", \(Int(d)) seconds"
    } else if let mm = seg.dist {
      phrase += ", \(Int(mm)) meters"
    }
    if let z = seg.zone, !z.isEmpty { phrase += ", \(z)" }
    speak(phrase)
    updateSegDisplay(seg, 0, 0)
  }

  private func updateSegDisplay(_ seg: RouteSeg, _ inTime: TimeInterval, _ inDist: Double) {
    segLabel = seg.label; segZone = seg.zone ?? ""; segKind = seg.kind
    segOpen = (seg.dur == nil && seg.dist == nil)
    if let d = seg.dur {
      let rem = max(0, d - inTime)
      segRemain = String(format: "%d:%02d", Int(rem) / 60, Int(rem) % 60)
    } else if let m = seg.dist {
      segRemain = "\(max(0, Int(m - inDist))) m"
    } else {
      segRemain = "lap ▸"
    }
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
        DispatchQueue.main.async {
          if m > self.distanceM + 1 {                       // advanced ≥1 m → moving
            self.lastMoveAt = Date()
            if self.autoPaused { self.autoPaused = false; self.session?.resume() }   // moving again → auto-resume
          }
          self.distanceM = m; self.updatePace()
        }
      } else if qt == HKQuantityType(.activeEnergyBurned) {
        let kcal = stat.sumQuantity()?.doubleValue(for: .kilocalorie()) ?? self.energyKcal
        DispatchQueue.main.async { self.energyKcal = kcal }
      } else if qt == HKQuantityType(.runningPower) {
        let w = stat.mostRecentQuantity()?.doubleValue(for: .watt()) ?? self.power
        DispatchQueue.main.async { self.power = w }
      }
    }
  }
}
