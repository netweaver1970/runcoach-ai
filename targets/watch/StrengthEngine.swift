import Foundation
import HealthKit
import WatchKit
import WatchConnectivity

// ─── Strength logging on the wrist (Build 4) ─────────────────────────────────────────────────────────────────
// The phone pushes the routines (with today's suggested weights/reps) as a "strength" payload; here they're logged
// set by set inside OUR OWN HKWorkoutSession (Traditional Strength Training) → live heart rate + measured calories,
// and Apple Health gets ONE workout recorded by the watch. On save the logged sets go back to the phone
// (transferUserInfo "strengthLog"), which adds the session to its store LINKED to this workout (no phone copy).
// Deliberately SEPARATE from WorkoutEngine (the run engine): no shared state, so nothing here can touch a run.
// Only one HKWorkoutSession can exist at a time → each engine refuses to start while the other one is running.

struct StrengthSetPlan: Codable, Hashable { let kg: Double; let reps: Int }
struct StrengthItem: Codable, Hashable {
  let exId: String
  let name: String
  let rest: Double          // seconds after each set
  let lo: Int; let hi: Int  // rep range
  let bw: Bool?             // body-weight move: kg = ADDED weight (negative = assistance)
  let step: Double?         // weight step (2 kg dumbbells, 2.5 kg stack/plates)
  let sets: [StrengthSetPlan]
}
struct StrengthRoutine: Codable, Hashable, Identifiable {
  let id: String
  let name: String
  let today: Bool?
  let items: [StrengthItem]
}
struct StrengthPlan: Codable {
  let type: String          // "strength"
  let date: String          // phone's local YYYY-MM-DD when pushed
  let bodyKg: Double?
  let routines: [StrengthRoutine]
}
// `slot` = the routine item index (a routine may list the same exercise twice); `set` = 1-based within that slot.
struct LoggedSet: Codable { let exId: String; let slot: Int; let set: Int; let reps: Int; let kg: Double; let doneAt: Double }

// What's on disk while a workout is open, so a killed app can still hand its sets to the phone.
private struct LiveState: Codable { let sid: String; let start: Double; let routine: StrengthRoutine; let logged: [LoggedSet]; let rpe: Int }

enum StrengthPhase { case idle, lifting, resting, finishing, saving, done }

final class StrengthEngine: NSObject, ObservableObject {
  static let shared = StrengthEngine()

  private let store = HKHealthStore()
  private var session: HKWorkoutSession?
  private var builder: HKLiveWorkoutBuilder?
  private var ticker: Timer?
  private var startDate: Date?
  private var sid = ""
  private var saveGen = 0                  // bumps per save → a late finishWorkout after the watchdog fired is ignored

  @Published var plan: StrengthPlan?
  @Published var phase: StrengthPhase = .idle
  @Published var routine: StrengthRoutine?
  @Published var exIdx = 0
  @Published var setIdx = 0                // 0-based set of the current exercise (≥ sets.count = an extra set)
  @Published var kg: Double = 0
  @Published var reps = 0
  @Published var logged: [LoggedSet] = []
  @Published var restLeft = 0
  @Published var heartRate: Double = 0
  @Published var kcal: Double = 0
  @Published var elapsed: TimeInterval = 0
  @Published var rpe = 7
  @Published var issue = ""                // shown on the strength screens (start/save problems)
  @Published var doneNote = ""             // after save: "Saved to Health · 14 sets · 41 min · 212 kcal"
  @Published var canResume = true          // false once the system ended/failed the session → only Save/Discard
  // spoken set announcements ("Chest Press, set 2 of 4, 10 reps, 27.5 kilos") — the runner's switch, remembered
  @Published var voiceOn: Bool = UserDefaults.standard.object(forKey: "strengthVoice") as? Bool ?? true {
    didSet { UserDefaults.standard.set(voiceOn, forKey: "strengthVoice") }
  }
  @Published var orphan: (name: String, sets: Int)?   // a workout the app was killed in → "Send to iPhone" / "Discard"
  private var restEnd: Date?
  private var restTicked = false           // the 10-s-left tick already played

  // The "today" flags were set on the phone's date of the push — stale on a later day.
  var planIsToday: Bool {
    let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.locale = Locale(identifier: "en_US_POSIX")
    return plan?.date == f.string(from: Date())
  }
  // A LIVE strength session (blocks a run Start, keeps the strength screen forward). NOT while saving: the HK session
  // has already been ended then, and a hung save must never lock the runner out of a run (watch review H1).
  var running: Bool { session != nil && [.lifting, .resting, .finishing].contains(phase) }

  override init() {
    super.init()
    if let d = UserDefaults.standard.data(forKey: "strengthPlan"), let p = try? JSONDecoder().decode(StrengthPlan.self, from: d) { plan = p }
    if let d = UserDefaults.standard.data(forKey: "strengthLive"), let l = try? JSONDecoder().decode(LiveState.self, from: d) {
      if l.logged.isEmpty { clearLive() } else { orphan = (l.routine.name, l.logged.count) }
    }
  }

  // Called on MAIN by KPIStore.ingest. A plan arriving mid-workout is stored but never swaps the routine being logged.
  func setPlan(_ p: StrengthPlan, raw: Data) {
    plan = p
    UserDefaults.standard.set(raw, forKey: "strengthPlan")
  }

  var item: StrengthItem? {
    guard let r = routine, exIdx < r.items.count else { return nil }
    return r.items[exIdx]
  }
  func loggedCount(_ i: Int) -> Int { logged.filter { $0.slot == i }.count }
  var totalPlannedSets: Int { routine?.items.reduce(0) { $0 + $1.sets.count } ?? 0 }

  // ─── Start ──────────────────────────────────────────────────────────────────────────────────────────────
  func start(_ r: StrengthRoutine) {
    if phase == .saving { issue = "Still saving the last workout — a moment."; return }
    guard session == nil, phase == .idle || phase == .done else { return }
    if WorkoutEngine.shared.running || WorkoutEngine.shared.isStarting { issue = "A run is in progress — end it first."; return }
    if orphan != nil { issue = "Send or discard the unfinished workout first."; return }
    guard store.authorizationStatus(for: HKObjectType.workoutType()) == .sharingAuthorized else {
      issue = "Health access needed to record. iPhone: Health app › your profile › Apps › RunCoach › Turn On All."
      WKInterfaceDevice.current().play(.failure)
      return
    }
    let cfg = HKWorkoutConfiguration()
    cfg.activityType = .traditionalStrengthTraining
    cfg.locationType = .indoor
    do {
      let s = try HKWorkoutSession(healthStore: store, configuration: cfg)
      let b = s.associatedWorkoutBuilder()
      b.dataSource = HKLiveWorkoutDataSource(healthStore: store, workoutConfiguration: cfg)
      s.delegate = self; b.delegate = self
      session = s; builder = b
      let now = Date(); startDate = now
      // Int64: the watch is arm64_32 — a plain Int is 32-bit and epoch-ms overflowed it → trap on Start (2026-10-07)
      sid = "sw-\(Int64(now.timeIntervalSince1970 * 1000))"
      issue = ""; doneNote = ""; heartRate = 0; kcal = 0; elapsed = 0; rpe = 7; canResume = true
      routine = r; logged = []; exIdx = 0; restEnd = nil; restLeft = 0
      loadSet(0, 0)
      phase = .lifting
      announce()
      saveLive()
      s.startActivity(with: now)
      b.beginCollection(withStart: now) { [weak self] ok, err in
        guard !ok, let self else { return }
        DispatchQueue.main.async {
          guard self.session === s else { return }
          self.issue = "Recording didn't start\(err.map { " (\($0.localizedDescription))" } ?? "") — check Health access."
          WKInterfaceDevice.current().play(.failure)
          s.end()
          self.clearLive(); self.reset()
        }
      }
      WKInterfaceDevice.current().play(.start)
      startTicker()
    } catch {
      session = nil; builder = nil
      issue = "Couldn't start the workout (\(error.localizedDescription))."
    }
  }

  // Point at slot i, set k: weight carries over from this session's last logged set of that slot (the runner
  // adjusted it), else the phone's suggestion; reps come from the plan (last time's reps / top of the range).
  private func loadSet(_ i: Int, _ k: Int) {
    guard let r = routine, i < r.items.count else { return }
    exIdx = i; setIdx = k
    let it = r.items[i]
    let p = it.sets.isEmpty ? nil : it.sets[min(k, it.sets.count - 1)]
    kg = logged.last(where: { $0.slot == i })?.kg ?? p?.kg ?? 0
    reps = p?.reps ?? it.hi
  }

  // ─── Logging ────────────────────────────────────────────────────────────────────────────────────────────
  func stepKg(_ dir: Double) {
    let st = item?.step ?? 2.5
    let v = ((kg + dir * st) * 4).rounded() / 4
    kg = (item?.bw ?? false) ? v : max(0, v)    // assistance (negative) only on body-weight moves
  }
  func stepReps(_ d: Int) { reps = max(0, min(99, reps + d)) }

  func doneSet() {
    guard phase == .lifting, let it = item, reps > 0, let r = routine else { return }
    logged.append(LoggedSet(exId: it.exId, slot: exIdx, set: loggedCount(exIdx) + 1, reps: reps, kg: kg, doneAt: Date().timeIntervalSince1970 * 1000))
    saveLive()
    WKInterfaceDevice.current().play(.success)
    // next: the next set of this slot, else the first slot that still has planned sets left
    var next: (Int, Int)?
    if loggedCount(exIdx) < it.sets.count { next = (exIdx, loggedCount(exIdx)) }
    else {
      for j in 0..<r.items.count {
        let i = (exIdx + 1 + j) % r.items.count
        if loggedCount(i) < r.items[i].sets.count { next = (i, loggedCount(i)); break }
      }
    }
    guard let (ni, nk) = next else { loadSet(exIdx, loggedCount(exIdx)); phase = .finishing; return }   // all planned sets done
    loadSet(ni, nk)
    if it.rest >= 5 && it.rest < 3600 {
      restEnd = Date().addingTimeInterval(it.rest); restLeft = Int(it.rest); restTicked = false
      phase = .resting
    } else { announce() }   // no rest → straight into the next set
  }
  func addRest(_ s: Double) { if let e = restEnd { restEnd = e.addingTimeInterval(s); restLeft = max(0, restLeft + Int(s)) } }
  func skipRest() { restEnd = nil; restLeft = 0; if phase == .resting { phase = .lifting } }
  func skipRestTapped() { let was = phase == .resting; skipRest(); if was { announce() } }

  // Machine taken / free → do ANY exercise next: from the set screen, or during the rest (the countdown keeps going;
  // the "Next:" line and the end-of-rest announcement follow the choice).
  func pickExercise(_ i: Int) {
    guard let r = routine, i >= 0, i < r.items.count, phase == .lifting || phase == .resting else { return }
    loadSet(i, loggedCount(i))
    if phase == .lifting { announce() }
  }

  // "Chest Press, set 2 of 4, 10 reps, 27.5 kilos" (body-weight moves: "body weight plus 5 kilos" / "assisted, 20 kilos")
  func announce() {
    guard voiceOn, let it = item else { return }
    let n = it.sets.count, k = setIdx + 1
    let w: String
    if it.bw ?? false { w = kg > 0 ? "body weight plus \(fmtKg(kg)) kilos" : kg < 0 ? "assisted, \(fmtKg(-kg)) kilos" : "body weight" }
    else { w = "\(fmtKg(kg)) kilos" }
    SpeechCue.shared.say("\(it.name), \(k > n ? "extra set" : "set \(k) of \(n)"), \(reps) reps, \(w)")
  }

  // ◀ ▶ between exercises (swap order, skip one, add an extra set to a finished one)
  func moveExercise(_ d: Int) {
    guard let r = routine, !r.items.isEmpty, phase == .lifting else { return }
    let i = (exIdx + d + r.items.count) % r.items.count
    loadSet(i, loggedCount(i))
    announce()
  }
  func undoLast() {
    guard phase == .lifting, let last = logged.popLast() else { return }
    saveLive()
    loadSet(last.slot, loggedCount(last.slot))
    kg = last.kg; reps = last.reps
  }

  func askFinish() { if phase == .lifting || phase == .resting { skipRest(); phase = .finishing } }
  func backToWorkout() { if phase == .finishing && canResume { loadSet(exIdx, loggedCount(exIdx)); phase = .lifting } }
  func finishDone() { issue = ""; doneNote = ""; reset() }

  // ─── End ────────────────────────────────────────────────────────────────────────────────────────────────
  func save() {
    guard phase == .finishing, let s = session, let b = builder, let r = routine, let sd = startDate else { return }
    if logged.isEmpty { discard(); return }
    phase = .saving
    stopTicker()
    saveGen += 1
    let gen = saveGen
    let end = Date()
    let sets = logged, rpeNow = rpe, sidNow = sid
    var meta: [String: Any] = [HKMetadataKeyWorkoutBrandName: "RunCoach · \(r.name)", "RunCoachSession": sidNow]
    let summary = exerciseSummary(r, sets)
    if !summary.isEmpty { meta["RunCoachExercises"] = String(summary.prefix(1500)) }
    // Save WATCHDOG: HealthKit must confirm within 30 s, else the sets go to the phone without a workout id (the
    // phone saves its own copy; if the watch workout lands later, the phone's reconcile deletes that copy).
    DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
      guard let self, self.saveGen == gen, self.phase == .saving else { return }
      self.saveGen += 1
      self.completeSave(r: r, sd: sd, end: end, sets: sets, rpe: rpeNow, sid: sidNow, uuid: nil, effortOk: false, kcal: self.kcal,
                        err: "Health didn't confirm the save")
    }
    s.end()
    b.addMetadata(meta) { _, _ in
      b.endCollection(withEnd: end) { _, _ in
        b.finishWorkout { [weak self] w, err in
          let kcal = b.statistics(for: HKQuantityType(.activeEnergyBurned))?.sumQuantity()?.doubleValue(for: .kilocalorie()) ?? 0
          let finish = { (effortOk: Bool) in
            DispatchQueue.main.async {
              guard let self, self.saveGen == gen else { return }   // the watchdog already handed off
              self.saveGen += 1
              self.completeSave(r: r, sd: sd, end: end, sets: sets, rpe: rpeNow, sid: sidNow, uuid: w?.uuid.uuidString,
                                effortOk: effortOk, kcal: kcal, err: err?.localizedDescription)
            }
          }
          // RPE → Apple's Effort score on the watch's own workout (the phone retries if this doesn't take)
          if let w, rpeNow > 0, #available(watchOS 11.0, *), let s2 = self?.store {
            let q = HKQuantitySample(type: HKQuantityType(.workoutEffortScore), quantity: HKQuantity(unit: .appleEffortScore(), doubleValue: Double(min(10, max(1, rpeNow)))),
                                     start: w.startDate, end: w.endDate)
            s2.relateWorkoutEffortSample(q, with: w, activity: nil) { ok, _ in finish(ok) }
          } else { finish(false) }
        }
      }
    }
  }

  private func completeSave(r: StrengthRoutine, sd: Date, end: Date, sets: [LoggedSet], rpe: Int, sid: String, uuid: String?,
                            effortOk: Bool, kcal: Double, err: String?) {
    // the sets go to the phone EITHER WAY: no uuid (save failed / unconfirmed) → the phone saves its own copy to Health
    sendLog(makeLog(r: r, sd: sd, end: end, sets: sets, rpe: rpe, sid: sid, uuid: uuid, effortOk: effortOk, kcal: kcal))
    clearLive()
    let mins = Int(end.timeIntervalSince(sd) / 60)
    if uuid != nil {
      doneNote = "Saved to Health · \(sets.count) sets · \(mins) min · \(Int(kcal)) kcal"
      WKInterfaceDevice.current().play(.success)
    } else {
      doneNote = "\(sets.count) sets sent to iPhone."
      issue = "Not confirmed in Health on the watch\(err.map { " (\($0))" } ?? "") — the iPhone will save it."
      WKInterfaceDevice.current().play(.failure)
    }
    session = nil; builder = nil
    phase = .done
  }

  private func makeLog(r: StrengthRoutine, sd: Date, end: Date, sets: [LoggedSet], rpe: Int, sid: String, uuid: String?,
                       effortOk: Bool, kcal: Double) -> [String: Any] {
    ["id": sid, "routineId": r.id, "routineName": r.name,
     "startedAt": sd.timeIntervalSince1970 * 1000, "finishedAt": end.timeIntervalSince1970 * 1000,
     "rpe": rpe, "uuid": uuid ?? "", "effort": effortOk ? "ok" : "", "kcal": kcal, "bodyKg": plan?.bodyKg ?? 0,
     "sets": sets.map { ["exId": $0.exId, "set": $0.set, "reps": $0.reps, "kg": $0.kg, "doneAt": $0.doneAt] }]
  }

  func discard() {
    if let s = session, let b = builder { s.end(); b.discardWorkout() }
    clearLive()
    reset()
  }

  private func reset() {
    stopTicker()
    session = nil; builder = nil; restEnd = nil; restLeft = 0
    phase = .idle; routine = nil; logged = []
  }

  // ─── Crash safety: the open workout on disk; an orphan (app killed mid-workout) can still be sent ─────────
  private func saveLive() {
    guard let r = routine, let sd = startDate,
          let d = try? JSONEncoder().encode(LiveState(sid: sid, start: sd.timeIntervalSince1970, routine: r, logged: logged, rpe: rpe)) else { return }
    UserDefaults.standard.set(d, forKey: "strengthLive")
  }
  private func clearLive() { UserDefaults.standard.removeObject(forKey: "strengthLive") }
  func sendOrphan() {
    guard let d = UserDefaults.standard.data(forKey: "strengthLive"), let l = try? JSONDecoder().decode(LiveState.self, from: d), !l.logged.isEmpty else {
      orphan = nil; clearLive(); return
    }
    let sd = Date(timeIntervalSince1970: l.start)
    let last = (l.logged.map(\.doneAt).max() ?? sd.timeIntervalSince1970 * 1000) / 1000
    sendLog(makeLog(r: l.routine, sd: sd, end: Date(timeIntervalSince1970: last + 60), sets: l.logged, rpe: l.rpe, sid: l.sid,
                    uuid: nil, effortOk: false, kcal: 0))
    clearLive(); orphan = nil
  }
  func discardOrphan() { clearLive(); orphan = nil }

  // ─── To the phone: an OUTBOX on disk, flushed whenever WatchConnectivity is activated ─────────────────────
  private func sendLog(_ log: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: log), let json = String(data: data, encoding: .utf8) else { return }
    var box = UserDefaults.standard.stringArray(forKey: "strengthOutbox") ?? []
    box.append(json)
    UserDefaults.standard.set(box, forKey: "strengthOutbox")
    flushOutbox()
  }
  // transferUserInfo is queued + guaranteed once handed over → the outbox only bridges "not activated yet".
  // Called on main (sendLog) and from KPIStore's activation callback.
  func flushOutbox() {
    DispatchQueue.main.async {
      let s = WCSession.default
      guard s.activationState == .activated else { return }
      let box = UserDefaults.standard.stringArray(forKey: "strengthOutbox") ?? []
      guard !box.isEmpty else { return }
      for json in box { s.transferUserInfo(["strengthLog": json]) }
      UserDefaults.standard.removeObject(forKey: "strengthOutbox")
    }
  }

  // "Chest Press 4×8–10 @ 27.5 kg; …" (same shape as the phone's exerciseSummary)
  private func exerciseSummary(_ r: StrengthRoutine, _ sets: [LoggedSet]) -> String {
    var order: [String] = []
    for l in sets where !order.contains(l.exId) { order.append(l.exId) }
    return order.map { id in
      let ss = sets.filter { $0.exId == id }
      let lo = ss.map(\.reps).min() ?? 0, hi = ss.map(\.reps).max() ?? 0, top = ss.map(\.kg).max() ?? 0
      let name = r.items.first(where: { $0.exId == id })?.name ?? id   // (summary is per exercise, across slots)
      return "\(name) \(ss.count)×\(lo == hi ? "\(lo)" : "\(lo)–\(hi)") @ \(fmtKg(top)) kg"
    }.joined(separator: "; ")
  }

  // ─── Clock: elapsed + rest countdown (the workout session keeps the app running with the wrist down) ────
  private func startTicker() {
    ticker?.invalidate()
    ticker = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      guard let self, let sd = self.startDate else { return }
      self.elapsed = Date().timeIntervalSince(sd)
      guard self.phase == .resting, let e = self.restEnd else { return }
      let left = Int(ceil(e.timeIntervalSinceNow))
      self.restLeft = max(0, left)
      if left <= 10 && left > 0 && !self.restTicked { self.restTicked = true; WKInterfaceDevice.current().play(.click) }
      if left <= 0 {
        self.restEnd = nil; self.phase = .lifting
        WKInterfaceDevice.current().play(.notification)
        self.announce()   // the next set (voice switch on) — the haptic above always plays
      }
    }
  }
  private func stopTicker() { ticker?.invalidate(); ticker = nil }
}

func fmtKg(_ v: Double) -> String { v == v.rounded() ? String(Int(v)) : (v * 2 == (v * 2).rounded() ? String(format: "%.1f", v) : String(format: "%.2f", v)) }

extension StrengthEngine: HKWorkoutSessionDelegate {
  func workoutSession(_ ws: HKWorkoutSession, didChangeTo toState: HKWorkoutSessionState, from: HKWorkoutSessionState, date: Date) {
    DispatchQueue.main.async {
      guard ws === self.session else { return }
      // ended by the SYSTEM while logging (not by our save/discard) → the sets so far still reach the phone
      if toState == .ended && (self.phase == .lifting || self.phase == .resting || self.phase == .finishing) {
        self.issue = "The watch ended the workout."
        self.canResume = false; self.skipRest()
        self.phase = .finishing
      }
    }
  }
  func workoutSession(_ ws: HKWorkoutSession, didFailWithError error: Error) {
    DispatchQueue.main.async {
      guard ws === self.session else { return }
      self.issue = "Workout stopped by the system (\(error.localizedDescription)). Save sends your sets to the iPhone."
      WKInterfaceDevice.current().play(.failure)
      self.canResume = false
      if self.phase == .lifting || self.phase == .resting { self.skipRest(); self.phase = .finishing }
    }
  }
}

extension StrengthEngine: HKLiveWorkoutBuilderDelegate {
  func workoutBuilderDidCollectEvent(_ b: HKLiveWorkoutBuilder) { }
  func workoutBuilder(_ b: HKLiveWorkoutBuilder, didCollectDataOf types: Set<HKSampleType>) {
    for t in types {
      guard let qt = t as? HKQuantityType, let stat = b.statistics(for: qt) else { continue }
      if qt == HKQuantityType(.heartRate) {
        let bpm = stat.mostRecentQuantity()?.doubleValue(for: .count().unitDivided(by: .minute())) ?? 0
        DispatchQueue.main.async { if bpm > 0 { self.heartRate = bpm } }
      } else if qt == HKQuantityType(.activeEnergyBurned) {
        let k = stat.sumQuantity()?.doubleValue(for: .kilocalorie()) ?? 0
        DispatchQueue.main.async { self.kcal = k }
      }
    }
  }
}
