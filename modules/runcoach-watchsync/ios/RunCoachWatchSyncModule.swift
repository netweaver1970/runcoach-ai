import ExpoModulesCore
import WatchConnectivity
import AVFoundation

public class RunCoachWatchSyncModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RunCoachWatchSync")

    // "start"/"end" when the watch begins/ends a run → JS starts/stops the background keep-alive.
    Events("onRunState")

    // Instantiate the WCSession delegate at launch so the phone is always ready to RECEIVE run cues from the
    // watch (not just to send). Without this it's created lazily on the first send() and could miss early cues.
    OnCreate {
      WatchSync.shared.onRunState = { [weak self] state in
        self?.sendEvent("onRunState", ["state": state])
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
  private func speak(_ text: String) {
    guard !text.isEmpty else { return }
    let sess = AVAudioSession.sharedInstance()
    try? sess.setCategory(.playback, mode: .voicePrompt)   // NO .duckOthers → INTERRUPTS (pauses) music; it resumes on deactivate
    try? sess.setActive(true)
    let u = AVSpeechUtterance(string: text); u.rate = AVSpeechUtteranceDefaultSpeechRate
    synth.speak(u)
  }
  func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
    if !s.isSpeaking { try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation]) }
  }

  // A run-start/end signal → forward to JS (the keep-alive). transferUserInfo wakes the phone even when
  // suspended, so the keep-alive can (re)start on a background run start.
  private func handleRun(_ dict: [String: Any]) {
    if let run = dict["run"] as? String { DispatchQueue.main.async { self.onRunState?(run) } }
  }

  // WCSessionDelegate (iOS requires these).
  func session(_ s: WCSession, activationDidCompleteWith st: WCSessionActivationState, error: Error?) {}
  func sessionDidBecomeInactive(_ s: WCSession) {}
  func sessionDidDeactivate(_ s: WCSession) { WCSession.default.activate() }
  func session(_ s: WCSession, didReceiveUserInfo u: [String: Any]) { handleRun(u) }
  func session(_ s: WCSession, didReceiveMessage m: [String: Any]) { handleRun(m) }

  // Run cue from the watch, WITH a reply so the watch knows whether we took it (→ stay silent) or not (→
  // speak on the watch). `handled: true` only when the phone has an external audio device to play it on.
  func session(_ s: WCSession, didReceiveMessage m: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
    handleRun(m)
    guard let cue = m["cue"] as? String else { replyHandler(["handled": false]); return }
    if hasExternalAudioOutput() {
      DispatchQueue.main.async { self.speak(cue) }
      replyHandler(["handled": true])
    } else {
      replyHandler(["handled": false])
    }
  }
}
