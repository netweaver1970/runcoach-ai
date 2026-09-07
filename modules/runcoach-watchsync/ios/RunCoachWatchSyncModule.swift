import ExpoModulesCore
import WatchConnectivity
import AVFoundation

public class RunCoachWatchSyncModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RunCoachWatchSync")

    // "start"/"end" when the watch begins/ends a run → JS starts/stops the background keep-alive.
    // "onRunBattery" carries the watch's post-run battery profiling (drain %/hr) → JS logs it for the debug export.
    // "onRunSegments" carries the executed phase boundaries → JS reconstructs the run's Warmup/Work/…/Cooldown structure.
    Events("onRunState", "onRunBattery", "onRunSegments")

    // Instantiate the WCSession delegate at launch so the phone is always ready to RECEIVE run cues from the
    // watch (not just to send). Without this it's created lazily on the first send() and could miss early cues.
    OnCreate {
      WatchSync.shared.onRunState = { [weak self] state in
        self?.sendEvent("onRunState", ["state": state])
      }
      WatchSync.shared.onRunBattery = { [weak self] info in
        self?.sendEvent("onRunBattery", info)
      }
      WatchSync.shared.onRunSegments = { [weak self] info in
        self?.sendEvent("onRunSegments", info)
      }
    }

    AsyncFunction("isSupported") { () -> Bool in
      WCSession.isSupported()
    }

    AsyncFunction("isPaired") { () -> Bool in
      WCSession.isSupported() ? WCSession.default.isPaired : false
    }

    // Push the KPI payload (JSON string) to the watch app.
    AsyncFunction("sync") { (json: String) -> Bool in
      WatchSync.shared.send(json)
    }
  }
}

final class WatchSync: NSObject, WCSessionDelegate, AVSpeechSynthesizerDelegate {
  static let shared = WatchSync()
  private let synth = AVSpeechSynthesizer()
  var onRunState: ((String) -> Void)?   // "start"/"end" from the watch → JS keep-alive
  var onRunBattery: (([String: Any]) -> Void)?   // watch battery profiling from the run → JS debug log
  var onRunSegments: (([String: Any]) -> Void)?  // executed phase boundaries from the run → JS structure rebuild
  private var resumeWork: DispatchWorkItem?       // pending resume-retry, cancelled when a new cue takes the session
  private var phoneAudioTarget = false            // this run: is the PHONE the audible device (earbuds OR playing audio)?

  // ─── Audio diagnostics ──────────────────────────────────────────────────────────────────────────────────
  // The cue path is all `try?` with no logging, so every audio bug has been guesswork. Append each event to a
  // small pullable file (Documents/runcoach-audio-log.txt) so a single route run tells us exactly what happened:
  // was the cue received, did the phone think it had an external output, did it speak or decline to the watch,
  // and did the music resume. Ring-buffered to the last 250 lines. Pull with devicectl copy from.
  private var alogBuf: [String] = []
  private func alog(_ e: String) {
    let ts = ISO8601DateFormatter().string(from: Date())
    alogBuf.append("\(ts) \(e)")
    if alogBuf.count > 250 { alogBuf.removeFirst(alogBuf.count - 250) }
    let text = alogBuf.joined(separator: "\n")
    if let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
      try? text.write(to: dir.appendingPathComponent("runcoach-audio-log.txt"), atomically: true, encoding: .utf8)
    }
  }
  private func routeDesc() -> String {
    AVAudioSession.sharedInstance().currentRoute.outputs.map { $0.portType.rawValue }.joined(separator: ",")
  }

  override init() {
    super.init()
    synth.delegate = self
    if WCSession.isSupported() {
      WCSession.default.delegate = self
      WCSession.default.activate()
    }
  }

  func send(_ json: String) -> Bool {
    guard WCSession.isSupported() else { return false }
    let s = WCSession.default
    let ctx: [String: Any] = ["json": json]
    // Latest-state context (delivered next time the watch app runs) + a live message when
    // reachable + a queued userInfo transfer as a guaranteed fallback.
    try? s.updateApplicationContext(ctx)
    if s.isReachable { s.sendMessage(ctx, replyHandler: nil, errorHandler: nil) }
    s.transferUserInfo(ctx)
    return true
  }

  // ─── Run-voice on the PHONE ─────────────────────────────────────────────────────────────────────────────
  // The watch forwards each run cue's TEXT here so it plays on the phone's audio device (earbuds), ducking
  // music — the Apple-Workout behaviour. We only take the cue when the phone actually has an EXTERNAL output
  // (headphones/Bluetooth/CarPlay); otherwise we decline so the cue speaks on the watch instead.
  private func hasExternalAudioOutput() -> Bool {
    let outs = AVAudioSession.sharedInstance().currentRoute.outputs
    return outs.contains { out in
      switch out.portType {
      case .headphones, .bluetoothA2DP, .bluetoothLE, .bluetoothHFP, .airPlay, .carAudio, .usbAudio, .headsetMic:
        return true
      default:
        return false
      }
    }
  }
  private func speakNow(_ text: String) {   // the cue handler has already activated the session
    guard !text.isEmpty else { return }
    let u = AVSpeechUtterance(string: text); u.rate = AVSpeechUtteranceDefaultSpeechRate
    synth.speak(u)
  }
  func speechSynthesizer(_ s: AVSpeechSynthesizer, didStart u: AVSpeechUtterance) { alog("synth START") }
  func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
    alog("synth FINISH → resume")
    if !s.isSpeaking { resumeOthers() }   // cue done → resume the music, verifying it actually took
  }

  // Pause/resume whatever the phone is playing, driven from the watch's Media screen. Activating a non-mixing
  // playback session INTERRUPTS (pauses) the other app; deactivating with notifyOthers hands it back so it
  // resumes — a manual lever for when a cue's auto-resume doesn't take.
  private func handleMedia(_ dict: [String: Any]) {
    guard let action = dict["media"] as? String else { return }
    let sess = AVAudioSession.sharedInstance()
    DispatchQueue.main.async {
      if action == "pause" {
        try? sess.setCategory(.playback, mode: .default)
        try? sess.setActive(true)
      } else {
        self.resumeOthers()   // deactivate + verify-and-retry that the other app actually resumed
      }
    }
  }

  // A run-start/end signal → forward to JS (the keep-alive). transferUserInfo wakes the phone even when
  // suspended, so the keep-alive can (re)start on a background run start.
  private func handleRun(_ dict: [String: Any]) {
    guard let run = dict["run"] as? String else { return }
    if run == "start" { DispatchQueue.main.async { self.primeAudio() } }   // warm the audio route → first cue isn't lost
    if run == "end"   { phoneAudioTarget = false }
    DispatchQueue.main.async { self.onRunState?(run) }
  }

  // On run start, WARM the phone's audio route so the FIRST cue isn't swallowed. The very first utterance is
  // often clipped/lost while the output route spins up (~300 ms) — the bug where the user heard nothing until
  // music was already playing. We pre-activate the voice session and, if earbuds are connected, speak a short
  // throwaway line that absorbs that spin-up, so the segment cue that lands a moment later is clean. Without
  // earbuds we don't hold the phone session (the watch speaks the cues).
  private func primeAudio() {
    cancelResume()   // priming takes the session → don't let a stale retry deactivate under it
    let sess = AVAudioSession.sharedInstance()
    // Decide the cue target for THIS run BEFORE touching the session — activating INTERRUPTS other audio, which
    // then makes isOtherAudioPlaying read false. The PHONE owns cues when it's audible: earbuds/BT connected OR
    // it's actively playing audio (music/YouTube, even on the built-in speaker). Otherwise (silent + no earbuds)
    // the phone stays untouched and the watch speaks. (Before, we required an EXTERNAL output, so a Z2 run with
    // YouTube on the phone speaker got the cue on the watch and YouTube untouched — the 2026-09-07 report.)
    let otherBefore = sess.isOtherAudioPlaying
    let ext = hasExternalAudioOutput()
    phoneAudioTarget = ext || otherBefore
    alog("prime ext=\(ext) other=\(otherBefore) → phoneTarget=\(phoneAudioTarget) route=\(routeDesc())")
    if phoneAudioTarget {
      try? sess.setCategory(.playback, mode: .voicePrompt)
      try? sess.setActive(true)
      speakNow("Starting run")
    }
    // else: leave the silent phone alone (don't interrupt nothing); cues will speak on the watch.
  }

  // Watch → phone battery profiling (drain %/hr for the run). Forward to JS so it lands in the debug export.
  // Executed phase boundaries → forward to JS (start ms, total dur, and the [{label,kind,zone,startSec,endSec}] list).
  private func handleExecSegments(_ dict: [String: Any]) {
    guard let start = dict["execStart"] as? Double, let segs = dict["execSegs"] as? [[String: Any]], !segs.isEmpty else { return }
    onRunSegments?(["execStart": start, "execDur": dict["execDur"] as? Double ?? 0, "execSegs": segs])
  }

  private func handleWatchBattery(_ dict: [String: Any]) {
    guard let perHr = dict["watchBatteryPerHr"] as? Double else { return }
    onRunBattery?([
      "device": "watch",
      "perHr": perHr,
      "drainPct": dict["watchDrainPct"] as? Double ?? 0,
      "durMin": dict["watchDurMin"] as? Double ?? 0,
      "startPct": dict["watchStartPct"] as? Double ?? 0,
      "endPct": dict["watchEndPct"] as? Double ?? 0,
    ])
  }

  // Hand the interrupted app back its audio, then VERIFY it actually resumed. Deactivating with
  // notifyOthersOnDeactivation should let music/podcasts resume, but it doesn't always take (the user's "audio
  // paused, never came back"). So after a beat we check isOtherAudioPlaying and retry a few times — unless a new
  // cue is speaking (don't fight it) or there was simply nothing else to resume.
  private func resumeOthers(_ attempt: Int = 0) {
    // CRITICAL: only tear the session down when NO cue owns it. Without this guard the retry fired in the gap
    // between the rapid 3-2-1 countdown cues — after a cue's setActive(true) but before its async speakNow ran —
    // deactivating the session the cue just took, so the utterance was dropped (music cut, nothing heard) and,
    // because it never played, didFinish never fired and the music never resumed. (Regression: retry loop +
    // interval countdown cues.)
    guard !synth.isSpeaking else { alog("resume skip (speaking)"); return }
    try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    alog("resume deactivate attempt=\(attempt) other=\(AVAudioSession.sharedInstance().isOtherAudioPlaying)")
    guard attempt < 4 else { return }
    let work = DispatchWorkItem { [weak self] in
      guard let self = self, !self.synth.isSpeaking else { return }
      if !AVAudioSession.sharedInstance().isOtherAudioPlaying { self.resumeOthers(attempt + 1) }
    }
    resumeWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: work)
  }

  // A new cue is taking the session → cancel any pending resume-retry so it can't deactivate underneath the cue.
  private func cancelResume() { resumeWork?.cancel(); resumeWork = nil }

  // WCSessionDelegate (iOS requires these).
  func session(_ s: WCSession, activationDidCompleteWith st: WCSessionActivationState, error: Error?) {}
  func sessionDidBecomeInactive(_ s: WCSession) {}
  func sessionDidDeactivate(_ s: WCSession) { WCSession.default.activate() }
  func session(_ s: WCSession, didReceiveUserInfo u: [String: Any]) { handleRun(u); handleMedia(u); handleWatchBattery(u); handleExecSegments(u) }
  func session(_ s: WCSession, didReceiveMessage m: [String: Any]) { handleRun(m); handleMedia(m); handleWatchBattery(m); handleExecSegments(m) }

  // Run cue from the watch, WITH a reply so the watch knows whether we took it (→ stay silent) or not (→
  // speak on the watch). `handled: true` only when the phone has an external audio device to play it on.
  func session(_ s: WCSession, didReceiveMessage m: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
    handleRun(m); handleMedia(m)
    guard let cue = m["cue"] as? String else { replyHandler(["handled": false]); return }
    cancelResume()   // this cue now owns the session — kill any pending resume-retry before we activate
    // Activate our session FIRST — that routes audio to any CONNECTED earbuds, so currentRoute then reflects
    // them. Checking BEFORE activation reported the built-in speaker while the buds sat idle, so the initial
    // cue wrongly fell back to the watch until music was already playing (the bug the user hit).
    let sess = AVAudioSession.sharedInstance()
    // Decide BEFORE activating (activation would interrupt other audio and zero isOtherAudioPlaying). Phone owns
    // the cue if it was chosen at run start (phoneAudioTarget), has earbuds now, or is playing audio right now.
    let ext = hasExternalAudioOutput()
    let otherBefore = sess.isOtherAudioPlaying
    let playOnPhone = phoneAudioTarget || ext || otherBefore
    alog("cue in '\(cue.prefix(24))' ext=\(ext) other=\(otherBefore) phoneTarget=\(phoneAudioTarget) → phone=\(playOnPhone) route=\(routeDesc())")
    if playOnPhone {
      phoneAudioTarget = true   // stick with the phone for the rest of the run (later cues fire after we've interrupted the music, so isOtherAudioPlaying would read false)
      try? sess.setCategory(.playback, mode: .voicePrompt)   // no duck → INTERRUPTS (pauses) other audio, then resumes
      try? sess.setActive(true)
      DispatchQueue.main.async { self.alog("cue speak '\(cue.prefix(24))'"); self.speakNow(cue) }
      replyHandler(["handled": true])
    } else {
      alog("cue DECLINED → watch (phone silent, no earbuds)")   // don't activate → don't interrupt a silent phone
      replyHandler(["handled": false])
    }
  }
}
