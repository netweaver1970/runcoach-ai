import Foundation
import HealthKit
import AVFoundation
import WatchKit
import WatchConnectivity
import CoreLocation

// Owns the run on the watch: an HKWorkoutSession + live builder so OUR app (not Apple's Workout app) records
// the run. That gives us three things the companion-only route screen couldn't have: the app stays alive in
// the background (wrist down), voice prompts keep playing, and HR/pace/distance/energy are recorded to Health.
// Stage 1 = session + audio + live metrics + save. Stage 2 will drive the structured intervals on top of this.
final class WorkoutEngine: NSObject, ObservableObject {
  static let shared = WorkoutEngine()

  private let store = HKHealthStore()
  private var session: HKWorkoutSession?
  private var builder: HKLiveWorkoutBuilder?
  private var routeBuilder: HKWorkoutRouteBuilder?   // records the GPS track → an HKWorkoutRoute so the phone can draw the run map
  private var startDate: Date?
  private var ticker: Timer?

  @Published var running = false
  @Published var paused = false
  @Published var heartRate: Double = 0     // bpm
  @Published var power: Double = 0         // running power, W
  @Published var distanceM: Double = 0
  @Published var energyKcal: Double = 0
  @Published var elapsed: TimeInterval = 0
  @Published var paceStr = "--:--"         // min/km, from moving-average distance/time
  @Published var powerMin: Double = 0      // session min/max running power (W) → the hidden-strip readout
  @Published var powerMax: Double = 0
  @Published var batteryNote = ""          // set on end: e.g. "🔋 −4% in 32m · 7.5%/hr" (internal profiling)
  @Published var healthIssue = ""          // non-empty → a RECORDING problem the runner must see NOW (auth / no HR / start or save failed)

  // Structured-interval state (Stage 2).
  @Published var segLabel = ""             // e.g. "Work" / "Recover" / "Warm-up"
  @Published var segZone = ""              // e.g. "Z4"
  @Published var segRemain = ""            // "2:14" (time) / "350 m" (distance) / "lap ▸" (open)
  @Published var segKind = ""              // work / recovery / warmup / cooldown / drills
  @Published var segIndex = 0
  @Published var segCount = 0
  @Published var segOpen = false           // no time/distance goal → advance with the lap button
  @Published var targetState = 0           // power vs the work target: 0 in-range/none, -1 under, +1 over
  @Published var announceTick = 0          // bumped on each spoken announcement → the map info strip flashes then auto-hides

  // Live SECTION stats for the non-route stats screen. A "section" = the current structured phase, or the
  // whole run when there's no structure (segStartElapsed/segStartDist stay 0 → these equal the run totals).
  @Published var segDistM: Double = 0      // distance in the current section (m)
  @Published var segPaceStr = "--:--"      // current-section pace (min/km)
  @Published var workIndex = 0             // 1-based WORK-rep number of the current section (0 if it isn't a work rep)
  @Published var workCount = 0             // total WORK reps in the session (≥2 ⇒ an intervals run)
  @Published var prevWorkPaceStr = ""      // previous COMPLETED work interval's average pace ("" = none yet)
  @Published var paceTrend = 0             // current section pace vs the previous work avg: -1 faster, +1 slower, 0 flat/none

  private var segs: [RouteSeg] = []
  // NO per-phase HKWorkoutActivity (beginNewActivity/endCurrentActivity) — REMOVED 2026-09-25: HealthKit FAILED the whole
  // session on it ("no active session to begin new activity" → didFailWithError → recording dead), i.e. a structure
  // LABEL could kill the run's HR/power/save. The executed structure still reaches the phone via sendExecStructure
  // (runSegmentsLog.ts), which healthkit.ts already uses when a workout has no per-phase activities. Don't re-add
  // in-session activity calls; if the watch must carry structure itself, write it as workout METADATA at finish.
  private var segLog: [[String: Any]] = []    // executed phases {label,kind,zone,startSec,endSec} → sent to the phone on end
                                              // so it can reconstruct the structure even if HK activities don't read back
  private var segStartElapsed: TimeInterval = 0
  private var segStartDist: Double = 0
  private var lastMoveAt: Date?            // last time distance advanced → auto-pause when stationary
  private var autoPaused = false           // paused BY auto-pause (vs a manual pause) so we can auto-resume
  private var hkToggleAt: Date?            // pause()/resume() sent, HealthKit's state change not in yet (delegate clears it)
  private var outSince: Date?             // when power went out of the target band
  private var lastTargetCue: Date?        // throttle the under/over spoken cue
  private var isIndoor = false            // treadmill/indoor run → speak PACE cues (from motion), not power
  private var paceOutSince: Date?         // when pace went out of the target band
  private var lastPaceCue: Date?          // throttle the under/over PACE cue
  private var paceSamples: [(t: Double, d: Double)] = []   // ~last 22 s of (elapsed, distance) → rolling pace
  private var cueSpoken: Set<String> = []      // which countdown cues (half/20/10/321) fired for the current interval
  private var isIntervalWorkout = false        // ≥2 work reps → an intervals session (countdown only fires for these)
  private var prevWorkPaceSecPerKm: Double = 0 // previous completed work interval's avg pace (0 = none) → the stats-screen trend arrow
  private var startBattery: Float = -1    // watch battery level (0…1) captured at run start → drain/hr on end
  private var hrSeenAt: Date?             // last time a real HR sample (>0 bpm) arrived → the no-HR watchdog
  private var hrWatchFrom: Date?          // watchdog baseline: run start, reset on (re)start/resume (HR lapses while paused)
  private var hrAlerted = false           // the no-HR alert already fired for this lapse (no nagging)
  private var hrDropoutSpoken = false     // "heart rate lost" spoken once per run; later dropouts → banner + haptic only
  private var routeFailed = false         // an insertRouteData batch failed this run → the map may have gaps
  private var starting = false            // a Start is in flight (auth sheet / session creation) → ignore repeat taps
  private var authCheckInFlight = false   // prepareAuth running (.task AND scenePhase .active both fire at launch)
  private var autoPrompted = false        // the AUTOMATIC Health sheet fires at most ONCE per app launch (see prepareAuth)
  private var authRefusedAt: Date?        // Start refused for missing access → a 2nd Start within 60 s runs anyway
  private var authDiag = ""               // outcome of the last Health sheet (main only) → SHORT code in the banner tag
  private var authDiagDetail = ""         // its error text — only in the app-open banner (the Start refusal must stay short)
  private enum IssueKind { case none, auth, hr, start, save, route }
  private var issueKind: IssueKind = .none

  // Types the watch app records (share) and reads. workoutRoute share is REQUIRED for HKWorkoutRouteBuilder to save
  // the GPS track (the phone's run map) — it was missing before 2026-09-25.
  private static let shareTypes: Set<HKSampleType> = [HKObjectType.workoutType(), HKSeriesType.workoutRoute()]
  private static let readTypes: Set<HKObjectType> = [
    HKQuantityType(.heartRate), HKQuantityType(.distanceWalkingRunning), HKQuantityType(.activeEnergyBurned),
    HKQuantityType(.runningPower),
  ]

  func requestAuth() async -> Bool {
    guard HKHealthStore.isHealthDataAvailable() else { await setAuthDiag("Health unavailable"); return false }
    do {
      try await store.requestAuthorization(toShare: Self.shareTypes, read: Self.readTypes)
      // After a completed sheet HealthKit should consider the request ANSWERED. "answered" while Workouts still reads
      // not-set = the grant exists but the status read is wrong; "ask" = the answer was never recorded (2026-09-25).
      let after = (try? await store.statusForAuthorizationRequest(toShare: Self.shareTypes, read: Self.readTypes)) ?? .unknown
      await setAuthDiag("sheet ok→\(Self.reqName(after))")
    } catch {
      // This error used to be swallowed — it's the one clue to why a grant doesn't stick.
      let ns = error as NSError
      await setAuthDiag("sheet err \(ns.code)", detail: String(ns.localizedDescription.prefix(40)))
      return false
    }
    return workoutAuthorized
  }
  private func setAuthDiag(_ d: String, detail: String = "") async {
    await MainActor.run { self.authDiag = d; self.authDiagDetail = detail }
  }
  private static func reqName(_ r: HKAuthorizationRequestStatus) -> String {
    switch r {
    case .shouldRequest: return "ask"
    case .unnecessary:   return "answered"
    case .unknown:       return "unknown"
    @unknown default:    return "?"
    }
  }

  // Can we record + SAVE a workout? Only SHARE status is observable — HealthKit hides READ grants (heart rate,
  // power), so a missing HR grant is caught at run time by the no-HR watchdog (checkHeartRateFlow) instead.
  var workoutAuthorized: Bool { store.authorizationStatus(for: HKObjectType.workoutType()) == .sharingAuthorized }
  // Say exactly WHAT is missing and WHETHER it was switched off or never answered — the runner can fix the right
  // toggle, and "off" vs "not set" tells us if a grant isn't sticking (2026-09-25: the sheet kept reappearing).
  private func authTag() -> String {
    let route = store.authorizationStatus(for: HKSeriesType.workoutRoute()) == .sharingAuthorized ? "on" : "off"
    let diag = authDiag.isEmpty ? "" : " · \(authDiag)"
    switch store.authorizationStatus(for: HKObjectType.workoutType()) {
    case .sharingDenied: return "Workouts off · Routes \(route)\(diag)"
    case .notDetermined: return "Workouts not set · Routes \(route)\(diag)"
    default:             return "Routes \(route)\(diag)"
    }
  }
  private func authIssueText() -> String {
    switch store.authorizationStatus(for: HKObjectType.workoutType()) {
    case .sharingDenied:
      return "Can't save runs: 'Workouts' is OFF. iPhone: Health app › your profile › Apps › RunCoach › turn on Workouts (+ all). [\(authTag())]"
    case .notDetermined:
      return "Health access not confirmed. Tap Start to see the Health sheet, then 'Turn On All'. [\(authTag())]\(authDiagDetail.isEmpty ? "" : " (\(authDiagDetail))")"
    default:
      return "Health access needed. iPhone: Health app › your profile › Apps › RunCoach › turn all on. [\(authTag())]"
    }
  }

  // Ask for Health access when the watch app OPENS — a calm moment — instead of only at Start (mid-run-start the
  // sheet got dismissed/missed), and keep a visible banner while it's still missing.
  // statusForAuthorizationRequest covers the READ types too (HR/power/distance/energy — their grant itself stays
  // private, but "never asked" is visible), so a type that's never been asked is asked HERE, at open — e.g. right
  // after a watch-app reinstall reset the grant (the root cause of the 2026-09-25 hollow run).
  func prepareAuth() async {
    // One check at a time — launch fires both .task and scenePhase .active, and two concurrent requests could show
    // the Health sheet twice right when the runner is granting access after an install.
    let go = await MainActor.run { () -> Bool in
      if self.authCheckInFlight { return false }
      self.authCheckInFlight = true; return true
    }
    guard go else { return }
    // AUTOMATIC prompt at most ONCE per launch. Re-prompting on every re-appear/foreground LOOPED: save the sheet →
    // (grant not complete) → red banner → the sheet's dismissal re-activates the app → prompt again → sheet covers the
    // banner, forever. After the one automatic sheet, re-checks only refresh the banner; Start still asks if needed.
    let prompt = await MainActor.run { () -> Bool in
      let first = !self.autoPrompted; self.autoPrompted = true; return first
    }
    if prompt {
      let req = (try? await store.statusForAuthorizationRequest(toShare: Self.shareTypes, read: Self.readTypes)) ?? .unknown
      if req != .unnecessary {
        _ = await requestAuth()
        // A fresh grant can land a beat after the sheet closes — re-read once before calling it missing.
        if !workoutAuthorized { try? await Task.sleep(nanoseconds: 1_500_000_000) }
      }
    }
    let ok = workoutAuthorized
    await MainActor.run {
      self.authCheckInFlight = false
      // Haptic only the FIRST time the missing-access banner appears — not on every wrist raise while it's denied.
      // Never cover a REAL failure (e.g. "Run NOT saved" after a run, then a wrist raise) with the access banner.
      if ok { self.clearIssue(.auth) }
      else if self.issueKind == .none || self.issueKind == .auth { self.flagIssue(.auth, self.authIssueText(), speak: nil, alert: self.issueKind != .auth) }
    }
  }

  // Surface a recording problem on-wrist: banner (all run pages + home) + firm haptic + one spoken line. The speech
  // deliberately bypasses the cue mute — a run that silently records nothing is exactly what must not be missed.
  private func flagIssue(_ kind: IssueKind, _ text: String, speak line: String?, alert: Bool = true) {
    issueKind = kind; healthIssue = text
    if alert { WKInterfaceDevice.current().play(.failure) }
    if let line { SpeechCue.shared.say(line) }
    // Soft notes (map-only problems) auto-hide after 8 s so they don't sit over the map controls for a whole run.
    // Recording problems (auth / no HR / start / save) stay until tapped or resolved.
    if kind == .route {
      DispatchQueue.main.asyncAfter(deadline: .now() + 8) { if self.issueKind == .route && self.healthIssue == text { self.dismissIssue() } }
    }
  }
  private func clearIssue(_ kind: IssueKind) { if issueKind == kind { issueKind = .none; healthIssue = "" } }
  func dismissIssue() { issueKind = .none; healthIssue = "" }   // runner tapped the banner (acknowledged)

  // No-HR safety net. The session can be "running" (timer, segments, cues all alive) while HealthKit delivers
  // nothing — the watch's HR read grant was reset by a reinstall, or a loose strap. Tell the runner within ~45 s
  // instead of letting a whole session record nothing (2026-09-25: 11 min of warm-up + drills with no HR/power).
  private func checkHeartRateFlow() {
    guard running, !paused, !hrAlerted, let from = hrWatchFrom else { return }
    let since = max(hrSeenAt ?? from, from)
    let limit: TimeInterval = hrSeenAt == nil ? 45 : 60          // first reading vs a later dropout
    guard Date().timeIntervalSince(since) > limit else { return }
    hrAlerted = true
    if hrSeenAt == nil {
      flagIssue(.hr, "No heart rate. Allow Health access for RunCoach (iPhone Settings › Privacy › Health) and check the watch fit.",
                speak: "No heart rate detected. Check Health access for RunCoach.")
    } else {
      // A flaky optical sensor can drop out repeatedly: speak the first dropout of a run, then banner + haptic only.
      flagIssue(.hr, "Heart rate lost — check the watch fit.", speak: hrDropoutSpoken ? nil : "Heart rate lost. Check the watch fit.")
      hrDropoutSpoken = true
    }
  }

  // Kick off from a route payload (keeps HealthKit types out of the SwiftUI view). Requests auth first.
  func startFromRoute(_ r: RoutePayload) {
    // One Start at a time: a second tap while the Health sheet is up used to queue a SECOND start → the second
    // tore down the first (orphaning a live HK session + wiping segs) and created another. Also ignore Start mid-run.
    guard !starting, !running else { return }
    starting = true
    segs = r.workout ?? []
    let activity: HKWorkoutActivityType = (r.sport == "walking") ? .walking : .running
    let indoor = r.indoor ?? false   // treadmill → record .indoor (distance/pace from motion, no GPS) + pace cues
    // Decide "2nd tap after a refusal" at TAP time: that tap must start at once — no Health sheet, no 1.5 s wait,
    // and no chance of the 60 s window expiring while the sheet is up.
    let runAnyway = authRefusedAt.map { Date().timeIntervalSince($0) < 60 } ?? false
    // Auth FIRST, and RESPECT the result: the old code started even when auth failed or the sheet was dismissed,
    // producing a hollow session (timer + cues, zero HR/power, nothing saved). At Start, prompt ONLY if the workout
    // type itself is undetermined (everything else — routes, read types — is asked at app open via prepareAuth, so
    // an unanswered route prompt can't make Start wait). If we still can't record, say so and stay on Start.
    Task {
      if !runAnyway, self.store.authorizationStatus(for: HKObjectType.workoutType()) == .notDetermined {
        _ = await self.requestAuth()
        // A fresh grant can land a beat after the sheet closes — re-read once before refusing.
        if !self.workoutAuthorized { try? await Task.sleep(nanoseconds: 1_500_000_000) }
      }
      let ok = self.workoutAuthorized
      await MainActor.run {
        guard ok else {
          // ESCAPE HATCH: on this watch the auth status can keep reading "not authorized" even after the runner allowed
          // it (2026-09-25: Workouts turned on in iPhone Health AND in the watch sheet, still refused → a hard gate
          // would lock him out of every run). A 2nd Start within 60 s of a refusal runs anyway — explicitly chosen and
          // NOT silent: the 45 s no-HR watchdog, beginCollection failure and "Run NOT saved" banners still catch a
          // run that isn't recording, and the warning below clears itself as soon as real HR arrives.
          if runAnyway {
            self.authRefusedAt = nil
            self.start(activity: activity, indoor: indoor)   // resets issues synchronously → flag the warning AFTER
            self.flagIssue(.auth, "Running without confirmed Health access. No HR within a minute → use Apple Workout.",
                           speak: nil, alert: false)
            DispatchQueue.main.async { self.starting = false }
            return
          }
          self.authRefusedAt = Date()
          self.starting = false
          // SHORT (a long banner covered the Start button on the 49 mm/41 mm layout → the 2nd tap just dismissed it).
          self.flagIssue(.auth, "Health access not confirmed [\(self.authTag())]. Tap Start again to run anyway.",
                         speak: "Health access needed. Tap Start again to run anyway.")
          return
        }
        self.authRefusedAt = nil
        self.clearIssue(.auth)
        self.start(activity: activity, indoor: indoor)
        // Clear the in-flight flag only AFTER start()'s own main.async block has set running = true (the main queue is
        // FIFO) — clearing it synchronously left a window where a tap saw session != nil && !running and tore the
        // brand-new session down. Also runs when start() failed/returned early, so Start is never locked out.
        DispatchQueue.main.async { self.starting = false }
      }
    }
  }

  // Clear a finished/failed session so the NEXT Start can build a fresh one. Without this, a session that
  // failed to start (e.g. a transient HealthKit error) left `session` non-nil while `running` went false —
  // so the Start button reappeared but every press hit the `session == nil` guard and silently no-op'd.
  private func teardown() {
    stopTicker()
    RouteStore.shared.stop()   // backstop: any end path (save/discard/failure/system-ended) stops GPS tracking
    session = nil; builder = nil; routeBuilder = nil; segs = []
  }

  // Tell the phone a run began/ended so it can keep itself alive (background location) → stays reachable to
  // speak cues on the earbuds. transferUserInfo is guaranteed + wakes a suspended phone; sendMessage is the
  // immediate path when it's already reachable.
  private func signalRun(_ state: String) {
    let s = WCSession.default
    guard s.activationState == .activated else { return }
    s.transferUserInfo(["run": state])
    if s.isReachable { s.sendMessage(["run": state], replyHandler: nil, errorHandler: nil) }
  }

  // GPS fixes for the workout ROUTE, forwarded from RouteStore's location manager (RouteView) so we don't run a
  // second one. Only accurate fixes, only while recording. finishRoute() (in end()) ties them to the saved
  // workout → the phone gets an HKWorkoutRoute and can draw the run map (previously our runs saved no route).
  func addRouteLocations(_ locs: [CLLocation]) {
    guard running, let rb = routeBuilder else { return }
    let good = locs.filter { $0.horizontalAccuracy >= 0 && $0.horizontalAccuracy < 50 }
    guard !good.isEmpty else { return }
    rb.insertRouteData(good) { ok, _ in if !ok { DispatchQueue.main.async { self.routeFailed = true } } }   // → "map may have gaps" at save
  }

  func start(activity: HKWorkoutActivityType, indoor: Bool = false) {
    if session != nil && !running { teardown() }   // a stale/dead session is lingering → clear it and retry
    guard session == nil else { return }           // a genuinely running session → ignore a double-Start
    isIndoor = indoor
    // Fresh per-run state, set SYNCHRONOUSLY (start() only runs on main, via startFromRoute's MainActor.run): a fast
    // beginCollection failure below can't have its banner wiped by a later async reset, and a retry never shows the
    // previous run's HR/distance (a stale HR masks a no-HR session for 45 s; a stale distance instantly completed a
    // distance-based warm-up).
    issueKind = .none; healthIssue = ""; hrSeenAt = nil; hrWatchFrom = Date(); hrAlerted = false; hrDropoutSpoken = false
    hkToggleAt = nil
    routeFailed = false; heartRate = 0; distanceM = 0; energyKcal = 0; power = 0; paceStr = "--:--"
    if !indoor && store.authorizationStatus(for: HKSeriesType.workoutRoute()) != .sharingAuthorized {
      flagIssue(.route, "Workout Routes not allowed — this run records, but its map won't be saved (iPhone Settings › Privacy › Health › RunCoach).",
                speak: nil, alert: false)
    }
    let cfg = HKWorkoutConfiguration()
    cfg.activityType = activity
    cfg.locationType = indoor ? .indoor : .outdoor   // indoor/treadmill → distance/pace from motion, no GPS
    do {
      let s = try HKWorkoutSession(healthStore: store, configuration: cfg)
      let b = s.associatedWorkoutBuilder()
      b.dataSource = HKLiveWorkoutDataSource(healthStore: store, workoutConfiguration: cfg)
      s.delegate = self
      b.delegate = self
      session = s; builder = b
      routeBuilder = indoor ? nil : HKWorkoutRouteBuilder(healthStore: store, device: .local())   // outdoor only — no GPS track on a treadmill
      let now = Date(); startDate = now
      s.startActivity(with: now)
      b.beginCollection(withStart: now) { [weak self] ok, err in
        // Collection didn't start → nothing will record. Say so and END the session (→ .ended → teardown → the
        // Start button works again) rather than leaving a hollow run ticking.
        guard !ok, let self else { return }
        DispatchQueue.main.async {
          self.signalRun("end")   // stop the phone keep-alive — no run is happening
          self.flagIssue(.start, "Recording didn't start\(err.map { " (\($0.localizedDescription))" } ?? "") — check Health access, then Start again.",
                         speak: "Recording failed to start. Check Health access.")
          self.session?.end()
        }
      }
      signalRun("start")   // wake the phone's keep-alive so cues can route to the earbuds
      if !indoor {         // no GPS on a treadmill — don't burn battery hunting for a fix
        RouteStore.shared.resetGuidance()   // fresh turn/off-route state (so a 2nd run on the same route re-announces)
        RouteStore.shared.start()           // GPS tracking is tied to the RUN (start→stop), not to the route being loaded
      }
      // Internal battery profiling: snapshot the watch battery so we can report drain/hr when the run ends.
      let dev = WKInterfaceDevice.current(); dev.isBatteryMonitoringEnabled = true
      let bat0 = dev.batteryLevel
      DispatchQueue.main.async {
        self.running = true; self.paused = false; self.elapsed = 0
        self.segCount = self.segs.count; self.segIndex = 0; self.segStartElapsed = 0; self.segStartDist = 0
        self.lastMoveAt = Date(); self.autoPaused = false
        self.powerMin = 0; self.powerMax = 0; self.batteryNote = ""; self.startBattery = bat0; self.segLog = []
        self.cueSpoken = []; self.isIntervalWorkout = self.segs.filter { $0.kind == "work" }.count >= 2
        self.workCount = self.segs.filter { $0.kind == "work" }.count
        self.segDistM = 0; self.segPaceStr = "--:--"; self.prevWorkPaceStr = ""; self.prevWorkPaceSecPerKm = 0; self.paceTrend = 0
        self.paceSamples = []; self.paceOutSince = nil; self.lastPaceCue = nil
        self.recomputeWorkIndex()
        if !self.segs.isEmpty { self.announceSegment(self.segs[0]) }   // "Warm-up …"
      }
      startTicker()
    } catch {
      session = nil; builder = nil
      DispatchQueue.main.async {
        self.flagIssue(.start, "Couldn't start the workout (\(error.localizedDescription)).", speak: "Workout failed to start.")
      }
    }
  }

  // Pause/resume only from a state HealthKit accepts, and never while the previous request is still in flight:
  // pause() before the session reached .running (Action Button right after Start) or a double press before .paused
  // arrives can make HealthKit FAIL the session (didFailWithError → the run is torn down). Decided on HealthKit's
  // REAL state, not our `paused` flag (which lags the delegate). A lost delegate unblocks after 3 s.
  private func hkCanToggle(_ s: HKWorkoutSession) -> Bool {
    if let t = hkToggleAt, Date().timeIntervalSince(t) < 3 { return false }
    return s.state == .running || s.state == .paused
  }

  func togglePause() {
    guard let s = session, hkCanToggle(s) else { return }
    autoPaused = false                     // a manual pause/resume overrides auto-pause bookkeeping
    hkToggleAt = Date()
    if s.state == .paused { s.resume() } else { s.pause() }
  }

  // save == false → discard the workout (nothing written to Health). The UI guards this behind a confirmation.
  func end(save: Bool = true) {
    guard let s = session, let b = builder else { return }
    if segIndex < segs.count {   // log the final in-progress phase (run stopped before it completed)
      let seg = segs[segIndex]
      segLog.append(["label": seg.label, "kind": seg.kind, "zone": seg.zone ?? "", "startSec": segStartElapsed, "endSec": elapsed])
    }
    sendExecStructure()   // forward the executed phase boundaries so the phone can reconstruct the structure
    reportBattery()    // internal profiling: watch battery drain/hr → on-wrist note + phone debug log
    signalRun("end")   // let the phone stop the background keep-alive
    RouteStore.shared.stop()   // run over → stop GPS tracking (no more turn/off-route cues, saves battery)
    s.end()
    let rb = routeBuilder   // capture before clearing; finishRoute must run AFTER the workout is saved
    if save {
      b.endCollection(withEnd: Date()) { _, _ in
        b.finishWorkout { workout, err in
          // Tie the accumulated GPS track to the saved workout → the phone gets an HKWorkoutRoute (run map). Its
          // result is surfaced softly (no speech/haptic): the run, HR and power are already saved at this point.
          if let w = workout, let rb = rb {
            rb.finishRoute(with: w, metadata: nil) { route, rerr in
              DispatchQueue.main.async {
                if route == nil {
                  self.flagIssue(.route, "Run saved — map NOT saved\(rerr.map { " (\($0.localizedDescription))" } ?? "").", speak: nil, alert: false)
                } else if self.routeFailed {
                  self.flagIssue(.route, "Run saved — map may have gaps (some GPS points weren't stored).", speak: nil, alert: false)
                }
              }
            }
          }
          if workout == nil {   // the run itself was NOT saved → the runner must know (was silent before)
            DispatchQueue.main.async {
              self.flagIssue(.save, "Run NOT saved to Health\(err.map { " (\($0.localizedDescription))" } ?? "") — check Health access.",
                              speak: "This run was not saved. Check Health access.")
            }
          }
        }
      }
    } else {
      b.discardWorkout()   // discarded run → drop the route too (rb is released)
    }
    stopTicker()
    session = nil; builder = nil; routeBuilder = nil; segs = []; isIndoor = false; paceSamples = []
    try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    DispatchQueue.main.async {
      self.running = false; self.paused = false; self.power = 0
      self.segLabel = ""; self.segRemain = ""; self.segZone = ""; self.segIndex = 0; self.segCount = 0
      self.workIndex = 0; self.workCount = 0; self.segDistM = 0; self.segPaceStr = "--:--"; self.prevWorkPaceStr = ""; self.paceTrend = 0
    }
  }

  // Internal battery profiling: compute watch drain since start → a %/hr figure. Shows on the wrist (batteryNote)
  // and is forwarded to the phone so it lands in the debug export's perf log. Best-effort (needs both readings).
  private func reportBattery() {
    let end = WKInterfaceDevice.current().batteryLevel
    guard startBattery >= 0, end >= 0, let sd = startDate else { return }
    let dur = Date().timeIntervalSince(sd)
    guard dur > 60 else { return }                       // too short to mean anything
    let drainPct = Double(startBattery - end) * 100      // + = discharged (usually); may be <0 if it charged
    let perHr = drainPct / (dur / 3600)
    let note = String(format: "🔋 %@%.0f%% in %dm · %.1f%%/hr",
                      drainPct >= 0 ? "−" : "+", abs(drainPct), Int(dur / 60), perHr)
    DispatchQueue.main.async { self.batteryNote = note }
    let s = WCSession.default
    if s.activationState == .activated {
      s.transferUserInfo(["watchBatteryPerHr": perHr, "watchDrainPct": drainPct, "watchDurMin": dur / 60,
                          "watchStartPct": Double(startBattery) * 100, "watchEndPct": Double(end) * 100])
    }
  }

  // Forward the executed phase boundaries to the phone (start ms + each phase's actual start/end seconds + label).
  // The phone matches them to the HK workout by start time and rebuilds the Warmup/Work/Recovery/Cooldown bands
  // + per-phase stats — a deterministic path that doesn't depend on HK reading our per-activity markers back.
  private func sendExecStructure() {
    guard !segLog.isEmpty, let sd = startDate else { return }
    let s = WCSession.default
    guard s.activationState == .activated else { return }
    s.transferUserInfo(["execStart": sd.timeIntervalSince1970 * 1000, "execDur": elapsed, "execSegs": segLog])
  }

  private func startTicker() {
    ticker?.invalidate()
    ticker = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      guard let self, let sd = self.startDate, !self.paused else { return }
      DispatchQueue.main.async {
        self.elapsed = Date().timeIntervalSince(sd); self.updatePace(); self.updateSectionStats()
        self.paceSamples.append((self.elapsed, self.distanceM))                       // rolling-pace window for treadmill cues
        self.paceSamples.removeAll { self.elapsed - $0.t > 22 }                       // keep ~last 22 s
        self.tickSegments()
        self.checkHeartRateFlow()
        // Auto-pause is OPT-IN (default off) and only after the run has genuinely started (25 s + 15 m moved),
        // so it never pauses at the start or spuriously; the distance handler auto-resumes on the next movement.
        if UserDefaults.standard.bool(forKey: "autoPause"), self.elapsed > 25, self.distanceM > 15, !self.autoPaused,
           let lm = self.lastMoveAt, Date().timeIntervalSince(lm) > 12,
           let s = self.session, s.state == .running, self.hkCanToggle(s) {   // once — not every tick until .paused lands
          self.autoPaused = true; self.hkToggleAt = Date(); s.pause()
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

  // Distance + pace WITHIN the current section (or the whole run when unstructured), plus the trend arrow vs
  // the previous work interval's average pace. Runs every tick from the ticker so a plain run updates too.
  private func updateSectionStats() {
    segDistM = max(0, distanceM - segStartDist)
    let segTime = elapsed - segStartElapsed
    guard segDistM > 20, segTime > 5 else { paceTrend = 0; return }
    let spk = segTime / (segDistM / 1000)
    segPaceStr = String(format: "%d:%02d", Int(spk) / 60, Int(spk) % 60)
    // Trend only means something during a work rep with a previous work rep to compare against. >3 s/km either
    // way to shrug off jitter (lower s/km = faster = ▼).
    if workIndex > 0, prevWorkPaceSecPerKm > 0 {
      paceTrend = spk < prevWorkPaceSecPerKm - 3 ? -1 : (spk > prevWorkPaceSecPerKm + 3 ? 1 : 0)
    } else { paceTrend = 0 }
  }

  // 1-based WORK-rep number of the current section (0 when the current section isn't a work rep).
  private func recomputeWorkIndex() {
    guard segIndex < segs.count, segs[segIndex].kind == "work" else { workIndex = 0; return }
    workIndex = segs[0...segIndex].filter { $0.kind == "work" }.count
  }

  // Interval voice cues; honours the same mute toggle as turn cues. Re-activate the audio session per utterance
  // — during a workout watchOS can drop it, which silenced the cues.
  private func speak(_ s: String) { guard RouteStore.shared.voiceOn else { return }; SpeechCue.shared.say(s) }

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
    if done { advanceSegment() }
    else { updateSegDisplay(seg, inTime, inDist); if isIndoor { checkPaceTarget(seg) } else { checkTarget(seg) }; countdownEnd(seg, inTime) }
  }

  // Rolling pace (sec/km) over the last ~20 s — reflects a treadmill-speed change within seconds, unlike the
  // whole-section average. nil until there's a stable window (≥12 s spanned, ≥40 m covered).
  private func rollingPaceSec() -> Double? {
    guard let first = paceSamples.first, paceSamples.count >= 2 else { return nil }
    let dt = elapsed - first.t, dd = distanceM - first.d
    guard dt >= 12, dd >= 40 else { return nil }
    return dt / (dd / 1000)
  }

  // INDOOR/treadmill analog of checkTarget: compare the rolling pace to the work block's pace band and speak a
  // terse under/over-PACE cue (haptic says which way). Pace comes from the watch's motion sensor indoors.
  private func checkPaceTarget(_ seg: RouteSeg) {
    guard seg.kind == "work", let fast = seg.paceLo, let slow = seg.paceHi, let cur = rollingPaceSec() else {
      targetState = 0; paceOutSince = nil; return
    }
    let st = cur < fast ? -1 : (cur > slow ? 1 : 0)   // -1 = too FAST (ahead), +1 = too SLOW (behind)
    targetState = st == -1 ? 1 : (st == 1 ? -1 : 0)   // colour: fast→"over" tint, slow→"under" tint (reuse powerColor)
    if st == 0 { paceOutSince = nil; return }
    if paceOutSince == nil { paceOutSince = Date() }
    let now = Date()
    if now.timeIntervalSince(paceOutSince!) > 8, lastPaceCue == nil || now.timeIntervalSince(lastPaceCue!) > 25 {
      lastPaceCue = now
      announceTick += 1
      WKInterfaceDevice.current().play(st < 0 ? .directionDown : .directionUp)   // too fast → ease (down); too slow → push (up)
      let mmss = String(format: "%d:%02d", Int(cur) / 60, Int(cur) % 60)
      speak(st < 0 ? "Ease, \(mmss)" : "Push, \(mmss)")   // terse — pace number; haptic says ease/push
    }
  }

  // Spoken pacing cues through a WORK interval (intervals sessions only — done on the track, no route needed):
  // one "Halfway", then "20 seconds", "10 seconds", and a final "3, 2, 1". Each fires once (guarded), routes to
  // the earbuds like every other cue (honours the mute toggle), with a light tick. Longer intervals get the full
  // set; short ones only the cues that fit (a 30 s rep skips halfway + 20 s). Recovery/warm-up/drills are silent.
  private func countdownEnd(_ seg: RouteSeg, _ inTime: TimeInterval) {
    guard isIntervalWorkout, seg.kind == "work", let d = seg.dur else { return }
    let rem = d - inTime
    // Halfway — only for intervals long enough to be worth it, and clear of the 20 s cue.
    if d >= 50, !cueSpoken.contains("half"), inTime >= d / 2, inTime < d / 2 + 1.2 {
      cueSpoken.insert("half"); speak("Halfway")
    }
    func fire(_ key: String, _ at: Double, _ phrase: String, _ minDur: Double) {
      if d >= minDur, !cueSpoken.contains(key), rem > at - 0.5, rem <= at + 0.5 {
        cueSpoken.insert(key); WKInterfaceDevice.current().play(.click); speak(phrase)
      }
    }
    fire("20", 20, "20 seconds", 28)
    fire("10", 10, "10 seconds", 16)
    // One utterance, not three cues 1 s apart: the rapid separate cues collided on the phone's per-utterance
    // audio activate/deactivate and dropped the 2/1 (and left the music paused). Spoken as "3, 2, 1" the commas
    // give the countdown cadence in a single interruption.
    fire("321", 3, "3, 2, 1", 8)
  }

  // During a WORK segment with a power band, colour the power (targetState) and speak a throttled under/over cue.
  private func checkTarget(_ seg: RouteSeg) {
    guard seg.kind == "work", let lo = seg.pLo, let hi = seg.pHi, power > 5 else { targetState = 0; outSince = nil; return }
    let st = power < lo ? -1 : (power > hi ? 1 : 0)
    targetState = st
    if st == 0 { outSince = nil; return }
    if outSince == nil { outSince = Date() }
    let now = Date()
    if now.timeIntervalSince(outSince!) > 8, lastTargetCue == nil || now.timeIntervalSince(lastTargetCue!) > 25 {
      lastTargetCue = now
      announceTick += 1                                // flash the info strip with the power cue too
      WKInterfaceDevice.current().play(st < 0 ? .directionUp : .directionDown)
      speak(st < 0 ? "Under, \(Int(power)) watts" : "Over, \(Int(power)) watts")   // terse — number only, the haptic says up/down
    }
  }

  private func advanceSegment() {
    if segIndex < segs.count {   // log the ACTUAL span of the phase that just finished → phone rebuilds the bands
      let s = segs[segIndex]
      segLog.append(["label": s.label, "kind": s.kind, "zone": s.zone ?? "", "startSec": segStartElapsed, "endSec": elapsed])
      // A work rep just finished → remember its average pace so the NEXT work rep can show a faster/slower arrow.
      if s.kind == "work" {
        let t = elapsed - segStartElapsed, d = distanceM - segStartDist
        if d > 20, t > 5 {
          prevWorkPaceSecPerKm = t / (d / 1000)
          prevWorkPaceStr = String(format: "%d:%02d", Int(prevWorkPaceSecPerKm) / 60, Int(prevWorkPaceSecPerKm) % 60)
        }
      }
    }
    segIndex += 1
    segStartElapsed = elapsed; segStartDist = distanceM
    segDistM = 0; segPaceStr = "--:--"; paceTrend = 0; recomputeWorkIndex()   // reset section stats for the new phase
    targetState = 0; outSince = nil; lastTargetCue = nil; paceOutSince = nil; lastPaceCue = nil; cueSpoken = []   // reset per-segment trackers
    if segIndex >= segs.count {
      segLabel = "Done"; segRemain = ""; segZone = ""; segKind = ""; segOpen = false
      WKInterfaceDevice.current().play(.success); speak("Workout complete")
      return
    }
    announceSegment(segs[segIndex])
  }

  private func announceSegment(_ seg: RouteSeg) {
    announceTick += 1                                 // flash the map info strip for this announcement
    WKInterfaceDevice.current().play(.notification)   // firm cue on each interval change
    var phrase = seg.label
    if let d = seg.dur {
      let m = Int((d / 60).rounded())
      phrase += m >= 1 ? ", \(m) minute\(m == 1 ? "" : "s")" : ", \(Int(d)) seconds"
    } else if let mm = seg.dist {
      phrase += ", \(Int(mm)) meters"
    }
    if let z = seg.zone, !z.isEmpty { phrase += ", \(z)" }
    // State the prescribed target band on a work segment so you know it before you're in it. Indoor/treadmill
    // → PACE band (min/km); outdoor → POWER band (watts). e.g. "…, target 5:30 to 6:00 per km" / "…250 to 280 watts".
    if seg.kind == "work" {
      let mmss = { (s: Double) in String(format: "%d:%02d", Int(s) / 60, Int(s) % 60) }
      if isIndoor, let fast = seg.paceLo, let slow = seg.paceHi, fast > 0, slow > 0 {
        phrase += ", target \(mmss(fast)) to \(mmss(slow)) per kilometer"
      } else if let lo = seg.pLo, let hi = seg.pHi, lo > 0, hi > 0 {
        phrase += ", target \(Int(lo)) to \(Int(hi)) watts"
      }
    }
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
    DispatchQueue.main.async {
      // Ignore a STALE session's events while a different one is current (a replaced/orphaned session ending must
      // not tear down the live run). session == nil (already cleared by end()) still processes → idempotent cleanup.
      guard self.session == nil || ws === self.session else { return }
      self.paused = (toState == .paused)
      self.hkToggleAt = nil   // HealthKit applied a state change → pause/resume may be sent again
      if toState == .running { self.hrWatchFrom = Date() }   // (re)started/resumed → fresh no-HR baseline (HR lapses while paused)
      if toState == .ended { self.running = false; self.teardown() }   // ended (incl. by the system) → allow a fresh Start
    }
  }
  func workoutSession(_ ws: HKWorkoutSession, didFailWithError error: Error) {
    DispatchQueue.main.async {
      guard self.session == nil || ws === self.session else { return }   // a stale session's failure isn't ours
      self.running = false; self.paused = false; self.teardown()
      self.signalRun("end")   // stop the phone keep-alive
      self.flagIssue(.start, "Workout stopped by the system (\(error.localizedDescription)).", speak: "Workout stopped unexpectedly.")
    }
  }
}

extension WorkoutEngine: HKLiveWorkoutBuilderDelegate {
  func workoutBuilderDidCollectEvent(_ b: HKLiveWorkoutBuilder) { }
  func workoutBuilder(_ b: HKLiveWorkoutBuilder, didCollectDataOf types: Set<HKSampleType>) {
    for t in types {
      guard let qt = t as? HKQuantityType, let stat = b.statistics(for: qt) else { continue }
      if qt == HKQuantityType(.heartRate) {
        let bpm = stat.mostRecentQuantity()?.doubleValue(for: .count().unitDivided(by: .minute())) ?? 0
        DispatchQueue.main.async {
          self.heartRate = bpm
          if bpm > 0 {   // HR flowing (again) → clear the no-HR alert, and any access warning (HR proves the read grant works)
            self.hrSeenAt = Date(); if self.hrAlerted { self.hrAlerted = false; self.clearIssue(.hr) }
            self.clearIssue(.auth)
          }
        }
      } else if qt == HKQuantityType(.distanceWalkingRunning) {
        let m = stat.sumQuantity()?.doubleValue(for: .meter()) ?? self.distanceM
        DispatchQueue.main.async {
          if m > self.distanceM + 1 {                       // advanced ≥1 m → moving
            self.lastMoveAt = Date()
            // moving again → auto-resume, but only once HealthKit is actually PAUSED (a pause still in flight would
            // otherwise land after this resume and leave the run paused with auto-resume switched off)
            if self.autoPaused, let s = self.session, s.state == .paused, self.hkCanToggle(s) {
              self.autoPaused = false; self.hkToggleAt = Date(); s.resume()
            }
          }
          self.distanceM = m; self.updatePace()
        }
      } else if qt == HKQuantityType(.activeEnergyBurned) {
        let kcal = stat.sumQuantity()?.doubleValue(for: .kilocalorie()) ?? self.energyKcal
        DispatchQueue.main.async { self.energyKcal = kcal }
      } else if qt == HKQuantityType(.runningPower) {
        let w = stat.mostRecentQuantity()?.doubleValue(for: .watt()) ?? self.power
        DispatchQueue.main.async {
          self.power = w
          if w > 5 {   // ignore the ~0 W readings while standing (see stationary-repair note) so min stays real
            self.powerMax = max(self.powerMax, w)
            self.powerMin = self.powerMin == 0 ? w : min(self.powerMin, w)
          }
        }
      }
    }
  }
}
