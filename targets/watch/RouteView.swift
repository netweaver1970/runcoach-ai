import SwiftUI
import MapKit
import CoreLocation
import WatchKit
import AVFoundation
import WatchConnectivity

// Route pushed from the phone (Wayfinder). Sent over the SAME WCSession channel as the KPI payload — the
// watch tries a KPIPayload decode first, then this. Keep the field names in sync with watchRoute.ts.
struct RoutePoint: Codable, Hashable { let lat: Double; let lon: Double }
struct RouteTurn: Codable, Hashable { let lat: Double; let lon: Double; let text: String; let dist: Double }
// One structured-workout segment (Stage 2). dur (s) OR dist (m) → a goal; neither → OPEN (advance with the lap button).
struct RouteSeg: Codable, Hashable { let kind: String; let dur: Double?; let dist: Double?; let label: String; let zone: String?; let pLo: Double?; let pHi: Double? }
struct RoutePayload: Codable {
  let type: String            // "route"
  let name: String
  let distanceKm: Double
  let pts: [RoutePoint]
  let turns: [RouteTurn]?     // turn-by-turn maneuvers (optional — old phone builds omit it)
  let voice: Bool?            // initial voice-on state from the phone setting
  let sport: String?          // "walking" → walk session; anything else → run
  let workout: [RouteSeg]?    // structured intervals the run session steps through
}

// Shared speech. Prefer the PHONE: forward each cue's text over WatchConnectivity and let the phone speak it
// on ITS audio device (earbuds/BT), ducking music — the Apple-Workout behaviour the user wanted (watch audio
// can't reach phone-paired earbuds). The phone replies `handled:true` only when it actually has an external
// output; if it declines, or is unreachable, we speak on the WATCH (a .playback session that interrupts other
// audio, then resumes). Haptics fire separately regardless of where the voice lands.
final class SpeechCue: NSObject, AVSpeechSynthesizerDelegate {
  static let shared = SpeechCue()
  private let synth = AVSpeechSynthesizer()
  override init() { super.init(); synth.delegate = self }
  func say(_ s: String) {
    guard !s.isEmpty else { return }
    let session = WCSession.default
    if session.activationState == .activated && session.isReachable {
      session.sendMessage(["cue": s],
        replyHandler: { [weak self] reply in
          if (reply["handled"] as? Bool) != true { DispatchQueue.main.async { self?.sayOnWatch(s) } }
        },
        errorHandler: { [weak self] _ in DispatchQueue.main.async { self?.sayOnWatch(s) } })
    } else {
      sayOnWatch(s)   // no phone reachable → the watch speaks (its own earbuds or speaker)
    }
  }
  private func sayOnWatch(_ s: String) {
    try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .voicePrompt)   // no mix/duck → interrupts others
    try? AVAudioSession.sharedInstance().setActive(true)
    let u = AVSpeechUtterance(string: s); u.rate = AVSpeechUtteranceDefaultSpeechRate
    synth.speak(u)
  }
  func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    if !s.isSpeaking { try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation]) }
  }
}

// ─── Route store: holds the pushed route + drives live guidance from the watch GPS ───────────────────────
final class RouteStore: NSObject, ObservableObject, CLLocationManagerDelegate {
  static let shared = RouteStore()
  @Published var route: RoutePayload?
  @Published var here: CLLocationCoordinate2D?
  @Published var offRoute = false
  @Published var remainingKm: Double = 0
  @Published var voiceOn = true            // spoken turn cues (the heads-up haptic fires regardless)
  @Published var nextTurnText = ""         // upcoming maneuver, shown on screen
  @Published var jumpToMap = 0             // bumped on each announcement → ContentView jumps to the map screen
  @Published var heading: Double = 0       // device heading (deg) → keep direction arrows right on a rotated map
  @Published var turnDistM: Double = 9999  // metres to the next un-announced turn → drives the approach zoom

  private let mgr = CLLocationManager()
  private var wasOff = false
  private var turns: [RouteTurn] = []
  private var announced: Set<Int> = []     // turn indices already spoken (or passed) for this route
  private var turnMinDist: [Int: Double] = [:]   // closest approach seen per turn → detect a turn we walked past

  override init() {
    super.init()
    mgr.delegate = self
    mgr.desiredAccuracy = kCLLocationAccuracyBest
    mgr.headingFilter = kCLHeadingFilterNone   // frequent heading updates → a steadier compass fan
  }

  func setRoute(_ r: RoutePayload) {
    DispatchQueue.main.async {
      self.route = r; self.remainingKm = r.distanceKm; self.offRoute = false; self.wasOff = false
      self.turns = r.turns ?? []; self.voiceOn = r.voice ?? true; self.announced = []; self.turnMinDist = [:]; self.nextTurnText = ""
      self.start()   // track from the moment a route lands, so turn cues fire on any screen (not just the map)
    }
  }
  func start() {
    mgr.requestWhenInUseAuthorization(); mgr.startUpdatingLocation()
    if CLLocationManager.headingAvailable() { mgr.startUpdatingHeading() }
  }
  func stop() { mgr.stopUpdatingLocation(); mgr.stopUpdatingHeading() }

  private func speak(_ s: String) { guard voiceOn else { return }; SpeechCue.shared.say(s) }

  // Fire the nearest not-yet-announced turn once you're within ~40 m: a heads-up haptic (always) + a spoken
  // cue (when voice is on). `nextTurnText` tracks the upcoming maneuver for the on-screen readout.
  private func checkTurns(_ loc: CLLocation) {
    guard !turns.isEmpty else { return }
    // Announce turns STRICTLY in ROUTE ORDER — the earliest un-announced turn is always "next". The old code
    // announced the nearest un-announced turn by straight-line distance, so two turns close together (or a loop
    // doubling back) could fire the SECOND turn's cue at the FIRST turn — which also handed you that other
    // turn's direction (the wrong left/right). If we've clearly walked past the current turn without triggering
    // (got within 60 m then receded past 90 m), skip it silently so the pointer doesn't wedge.
    var bi = -1
    for i in 0..<turns.count where !announced.contains(i) { bi = i; break }
    guard bi >= 0 else { nextTurnText = ""; turnDistM = 9999; return }
    let t = turns[bi]
    let d = loc.distance(from: CLLocation(latitude: t.lat, longitude: t.lon))
    let newMin = min(turnMinDist[bi] ?? .greatestFiniteMagnitude, d)
    turnMinDist[bi] = newMin
    if newMin < 60 && d > 90 { announced.insert(bi); return }   // passed it → advance the pointer next tick
    nextTurnText = t.text
    turnDistM = d                  // distance to the next turn → the map zooms in as this shrinks
    if d < 40 {
      announced.insert(bi)
      jumpToMap += 1   // a turn is happening → surface the map (ContentView watches this)
      WKInterfaceDevice.current().play(.notification)   // firm double-tap so it's felt mid-run
      speak(d > 18 ? "In \(Int((d / 5).rounded()) * 5) meters, \(t.text)" : t.text)
    }
  }

  var coords: [CLLocationCoordinate2D] {
    (route?.pts ?? []).map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lon) }
  }

  func locationManager(_ m: CLLocationManager, didUpdateLocations locs: [CLLocation]) {
    guard let loc = locs.last, let r = route, r.pts.count > 1 else { return }
    // nearest route point, then remaining distance along the route from there to the finish
    var bestI = 0; var bestD = Double.greatestFiniteMagnitude
    for (i, p) in r.pts.enumerated() {
      let d = loc.distance(from: CLLocation(latitude: p.lat, longitude: p.lon))
      if d < bestD { bestD = d; bestI = i }
    }
    var rem = 0.0
    var i = bestI
    while i < r.pts.count - 1 {
      let a = CLLocation(latitude: r.pts[i].lat, longitude: r.pts[i].lon)
      let b = CLLocation(latitude: r.pts[i + 1].lat, longitude: r.pts[i + 1].lon)
      rem += a.distance(from: b); i += 1
    }
    let off = bestD > 40   // >40 m from the nearest point on the line → off route
    DispatchQueue.main.async {
      self.here = loc.coordinate
      self.remainingKm = rem / 1000
      self.offRoute = off
      if off && !self.wasOff { WKInterfaceDevice.current().play(.notification) }  // buzz once on going off-route
      self.wasOff = off
      self.checkTurns(loc)
    }
  }

  func locationManager(_ m: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
    let h = newHeading.trueHeading >= 0 ? newHeading.trueHeading : newHeading.magneticHeading
    DispatchQueue.main.async { self.heading = h }
  }
}

// Travel-direction arrows: the route coords are ordered start→…→start, so an arrow pointing from a point to
// one a little further along shows which WAY to run the loop (clockwise vs counter-clockwise). One prominent
// green arrow at the start + a few pink ones around the loop.
private func geoBearing(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
  let dLon = (b.longitude - a.longitude) * .pi / 180
  let la = a.latitude * .pi / 180, lb = b.latitude * .pi / 180
  let y = sin(dLon) * cos(lb)
  let x = cos(la) * sin(lb) - sin(la) * cos(lb) * cos(dLon)
  return (atan2(y, x) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360)
}
private func compass16(_ deg: Double) -> String {
  let dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
  return dirs[Int((deg / 45).rounded()) % 8]
}
// Which way to set off, RELATIVE to the way you're facing (map is heading-up) — beats an absolute compass point.
private func relStart(_ bearing: Double, _ heading: Double) -> String {
  var rel = (bearing - heading).truncatingRemainder(dividingBy: 360)
  if rel > 180 { rel -= 360 }; if rel < -180 { rel += 360 }
  if abs(rel) <= 30 { return "Straight ahead" }
  if abs(rel) >= 150 { return "Turn around" }
  return rel > 0 ? "Head right ↱" : "Head left ↰"
}
private struct DirArrow: Identifiable { let id: Int; let coord: CLLocationCoordinate2D; let deg: Double; let t: Double }
private func directionArrows(_ c: [CLLocationCoordinate2D]) -> [DirArrow] {
  guard c.count > 4 else { return [] }
  let n = min(26, max(10, c.count / 5)), ahead = max(1, c.count / 40)
  var out: [DirArrow] = []
  for k in 0..<n {
    let i = Int(Double(k) / Double(n) * Double(c.count - 1))
    let j = min(i + ahead, c.count - 1)
    if i != j { out.append(DirArrow(id: k, coord: c[i], deg: geoBearing(c[i], c[j]), t: Double(k) / Double(max(1, n - 1)))) }
  }
  return out
}
// Route-progress colour: green (start) → amber (middle) → red (finish) — shows direction AND how far along.
private func gradeColor(_ t: Double) -> Color {
  let stops: [(Double, Double, Double)] = [(0.13, 0.64, 0.29), (0.92, 0.70, 0.03), (0.86, 0.15, 0.15)]
  let seg = t < 0.5 ? 0 : 1, lt = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5
  let a = stops[seg], b = stops[seg + 1]
  return Color(red: a.0 + (b.0 - a.0) * lt, green: a.1 + (b.1 - a.1) * lt, blue: a.2 + (b.2 - a.2) * lt)
}

// ─── Guidance view: the route on a map + a live "km left" / off-route readout ─────────────────────────────
private func fmtClock(_ t: TimeInterval) -> String {
  let s = Int(t); return String(format: "%d:%02d", s / 60, s % 60)
}
private func segColor(_ kind: String) -> Color {
  switch kind {
  case "work": return .orange
  case "recovery": return .cyan
  case "warmup", "cooldown": return .green
  case "drills": return .purple
  default: return .primary
  }
}

struct RouteView: View {
  @ObservedObject var store = RouteStore.shared
  @ObservedObject var engine = WorkoutEngine.shared
  @State private var cam: MapCameraPosition = .userLocation(followsHeading: true, fallback: .automatic)   // heading-up follow
  @State private var page = 0                                                       // 0 = controls (start/stop, shown first) · 1 = map · 2 = media
  @State private var infoOn = false                                                 // map screen: metrics strip hidden by default (the min/now/max power strip shows instead)
  @State private var zoomedForTurn = false                                          // camera is in the close turn-approach zoom (vs live follow)
  @State private var hideInfoTask: DispatchWorkItem?                                 // pending auto-hide of the flashed info strip
  @State private var showEndConfirm = false                                         // Save / Discard end sheet
  @State private var mapOn = true                                                   // false → metrics-only (no MapKit = battery)
  @State private var headingUp = true                                               // true = heading-up, false = north-up
  @AppStorage("autoPause") private var autoPause = false                            // pause when stationary

  // Power tinted by the work target: blue = under, red = over, orange = in-band / no target.
  private var powerColor: Color { engine.targetState < 0 ? .blue : (engine.targetState > 0 ? .red : .orange) }

  // Tell the phone to pause/resume whatever it's playing (music/podcast) — our own audio session interrupts it.
  private func sendMedia(_ action: String) {
    let s = WCSession.default
    guard s.activationState == .activated else { return }
    if s.isReachable { s.sendMessage(["media": action], replyHandler: nil, errorHandler: nil) }
    else { s.transferUserInfo(["media": action]) }
  }

  var body: some View {
    Group {
      if let r = store.route {
        TabView(selection: $page) {
          controlsScreen(r).tag(0)     // ◂ start / pause / lap / stop
          mapScreen(r).tag(1)          // centre: map + a minimisable metrics strip
          mediaScreen().tag(2)         // ▸ pause / resume the audio you're listening to
        }
        .tabViewStyle(.page)
        .navigationTitle("")   // drop the run title → more room (back-swipe still works)
        .confirmationDialog("End run?", isPresented: $showEndConfirm, titleVisibility: .visible) {
          Button("Save & end") { engine.end(save: true) }
          Button("Discard", role: .destructive) { engine.end(save: false) }
          Button("Cancel", role: .cancel) { }
        }
        .onAppear { store.start() }   // tracking is kept running app-wide (see setRoute) so cues fire anywhere
        .onChange(of: store.jumpToMap) { page = 1; flashInfo() }        // a turn cue surfaces the map + flashes the strip
        .onChange(of: engine.announceTick) { flashInfo() }             // any spoken announcement flashes the strip
      } else {
        VStack(spacing: 6) {
          Image(systemName: "map").font(.title2).foregroundColor(.secondary)
          Text("No route yet").font(.headline)
          Text("Generate one in Route on your iPhone, then Send to Watch.")
            .font(.caption).foregroundColor(.secondary).multilineTextAlignment(.center)
        }.padding()
      }
    }
  }

  // ── CONTROLS screen (swipe here for start / pause / lap / stop) ──────────────────────────────────────────
  @ViewBuilder private func controlsScreen(_ r: RoutePayload) -> some View {
    VStack(spacing: 10) {
      if engine.running {
        if !engine.segLabel.isEmpty {
          Text(engine.segLabel.uppercased()).font(.caption).bold().foregroundColor(segColor(engine.segKind))
            .lineLimit(1).minimumScaleFactor(0.6)
          Text(engine.segRemain).font(.title2).monospacedDigit().foregroundColor(segColor(engine.segKind))
        }
        HStack(spacing: 16) {
          Button { engine.togglePause() } label: { Image(systemName: engine.paused ? "play.fill" : "pause.fill") }
          if engine.segCount > 0 { Button { engine.lap() } label: { Image(systemName: "forward.end.fill") } }   // → next segment
          Button(role: .destructive) { showEndConfirm = true } label: { Image(systemName: "stop.fill") }
        }.buttonStyle(.bordered).controlSize(.large).font(.title3)
      } else {
        Text(String(format: "%.1f km", r.distanceKm)).font(.caption).foregroundColor(.secondary)
        if !engine.batteryNote.isEmpty {   // last run's watch-battery profiling
          Text(engine.batteryNote).font(.caption2).foregroundColor(.secondary).lineLimit(1).minimumScaleFactor(0.7)
        }
        Button { engine.startFromRoute(r) } label: { Label("Start", systemImage: "figure.run") }
          .buttonStyle(.borderedProminent).controlSize(.large).tint(.green)
        Button { autoPause.toggle() } label: {
          Label(autoPause ? "Auto-pause on" : "Auto-pause off", systemImage: autoPause ? "pause.circle.fill" : "pause.circle").font(.caption)
        }.buttonStyle(.plain).foregroundColor(autoPause ? .green : .secondary)
      }
      Text("swipe → map").font(.caption2).foregroundColor(.secondary)
    }.padding(.horizontal, 8)
  }

  // ── MAP screen (centre) — map + a minimisable metrics strip ─────────────────────────────────────────────
  @ViewBuilder private func mapScreen(_ r: RoutePayload) -> some View {
    ZStack(alignment: .bottom) {
      if mapOn {
        // interactionModes WITHOUT .pan → horizontal swipes fall through to the TabView pager (the map was
        // eating them); the crown still zooms and the camera still follows you.
        Map(position: $cam, interactionModes: [.zoom]) {
          MapPolyline(coordinates: store.coords)
            .stroke(store.offRoute ? Color.orange : Color.blue, lineWidth: 4)
          ForEach(directionArrows(store.coords)) { a in
            Annotation(a.id == 0 ? "Start" : "", coordinate: a.coord) {
              Image(systemName: a.id == 0 ? "arrow.up.circle.fill" : "arrowshape.up.fill")
                .font(.system(size: a.id == 0 ? 30 : 19, weight: .black))
                .foregroundColor(gradeColor(a.t))
                .shadow(color: .white, radius: 1.5).shadow(color: .black.opacity(0.7), radius: 1)
                .rotationEffect(.degrees(a.deg - (headingUp ? store.heading : 0)))
            }
          }
          UserAnnotation()
        }
        .mapControls { }   // remove MapKit's built-in compass (it appears when the heading-up camera rotates)
      } else {
        Color.black.ignoresSafeArea()   // metrics-only: no MapKit rendering → saves battery
      }
      if infoOn {
        VStack(spacing: 2) {
          if engine.running {
            HStack(spacing: 10) {
              Text("♥\(Int(engine.heartRate))").foregroundColor(.red)
              if engine.power > 0 { Text("\(Int(engine.power))w").foregroundColor(powerColor) }
            }.font(.title3).bold().monospacedDigit()
            if store.offRoute {
              Text("OFF ROUTE").font(.caption).bold().foregroundColor(.orange)
            } else if !engine.segLabel.isEmpty {
              Text(engine.segZone.isEmpty ? engine.segLabel.uppercased() : "\(engine.segLabel.uppercased()) \(engine.segZone)")
                .font(.caption).bold().foregroundColor(segColor(engine.segKind)).lineLimit(1).minimumScaleFactor(0.6)
            }
            Text(engine.segRemain).font(.title3).monospacedDigit().foregroundColor(segColor(engine.segKind))
          } else {
            if store.offRoute {
              Text("OFF ROUTE").font(.caption).bold().foregroundColor(.orange)
            } else if !store.nextTurnText.isEmpty {
              Text(store.nextTurnText).font(.caption).bold().foregroundColor(.cyan).lineLimit(2).multilineTextAlignment(.center)
            } else if let a = directionArrows(store.coords).first, store.remainingKm > r.distanceKm * 0.92 {
              Text(relStart(a.deg, store.heading)).font(.caption).bold().foregroundColor(.green)
            }
            Text(String(format: "%.1f km left", store.remainingKm)).font(.subheadline).monospacedDigit()
            Text("swipe → controls").font(.caption2).foregroundColor(.secondary)
          }
        }
        .padding(.horizontal, 12).padding(.vertical, 4)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
        .padding(.bottom, 18).padding(.horizontal, 6)   // sit just ABOVE the TabView page dots
      } else if engine.running && engine.power > 0 {
        // Strip hidden → a compact Min / Now / Max power readout, so the number that matters stays glanceable.
        HStack(spacing: 14) {
          powerStat("min", engine.powerMin)
          powerStat("now", engine.power, powerColor, big: true)
          powerStat("max", engine.powerMax)
        }
        .padding(.horizontal, 12).padding(.vertical, 3)
        .background(.ultraThinMaterial, in: Capsule())
        .padding(.bottom, 18)
      }
    }
    .overlay(alignment: .topTrailing) {
      VStack(spacing: 6) {
        Button { store.voiceOn.toggle() } label: {
          Image(systemName: store.voiceOn ? "speaker.wave.2.fill" : "speaker.slash.fill")
            .font(.system(size: 14)).frame(width: 36, height: 36).contentShape(Rectangle()).background(.ultraThinMaterial, in: Circle())
        }.buttonStyle(.plain)
        Button { withAnimation { infoOn.toggle() } } label: {   // minimise/show the metrics strip
          Image(systemName: infoOn ? "eye.fill" : "eye.slash.fill")
            .font(.system(size: 13)).frame(width: 36, height: 36).contentShape(Rectangle()).background(.ultraThinMaterial, in: Circle())
        }.buttonStyle(.plain)
      }.padding(4)
    }
    .overlay(alignment: .topLeading) {
      Button { mapOn.toggle() } label: {
        Image(systemName: mapOn ? "map.fill" : "map")
          .font(.system(size: 13)).frame(width: 36, height: 36).contentShape(Rectangle()).background(.ultraThinMaterial, in: Circle())
      }.buttonStyle(.plain).padding(4)
    }
    .overlay(alignment: .bottomTrailing) {
      // Lap here too, so you can advance a segment without swiping to Controls (works even with the strip hidden).
      if engine.running && engine.segCount > 0 {
        Button { engine.lap() } label: {
          Image(systemName: "forward.end.fill").font(.system(size: 16)).frame(width: 44, height: 44).contentShape(Circle()).background(.ultraThinMaterial, in: Circle())
        }.buttonStyle(.plain).padding(.trailing, 6).padding(.bottom, 20)
      }
    }
    .onChange(of: store.turnDistM) {
      guard mapOn, engine.running else { return }
      if store.turnDistM < 80, let h = store.here {
        // Approaching a turn → close, position-locked zoom (re-centres on you each update).
        cam = .camera(MapCamera(centerCoordinate: h, distance: 140, heading: headingUp ? store.heading : 0))
        zoomedForTurn = true
      } else if zoomedForTurn {
        // Left the turn-approach band → hand the camera back to LIVE follow ONCE. Previously the 80–140 m band
        // matched neither branch, so the camera stayed frozen on the last fixed position mid-run (the "cached
        // segment" that only jumped later). Gating on zoomedForTurn also avoids re-arming follow every GPS tick.
        cam = headingUp ? .userLocation(followsHeading: true, fallback: .automatic)
                        : .userLocation(fallback: .automatic)
        zoomedForTurn = false
      }
    }
    .onChange(of: page) {
      // Returning to the map re-arms live follow, clearing any stale region MapKit was still showing.
      if page == 1 && !zoomedForTurn {
        cam = headingUp ? .userLocation(followsHeading: true, fallback: .automatic)
                        : .userLocation(fallback: .automatic)
      }
    }
  }

  // An announcement fired → briefly SHOW the info strip (so the turn/segment/power detail is readable), then
  // auto-hide it after a few seconds so the map + Min/Now/Max power strip return. A manual eye tap still wins
  // until the next announcement. Only flashes when the strip is currently minimised (don't yank a pinned-open one).
  private func flashInfo() {
    hideInfoTask?.cancel()
    withAnimation { infoOn = true }
    let task = DispatchWorkItem { withAnimation { infoOn = false } }
    hideInfoTask = task
    DispatchQueue.main.asyncAfter(deadline: .now() + 7, execute: task)
  }

  // Compact power readout used by the hidden-strip Min / Now / Max row.
  @ViewBuilder private func powerStat(_ label: String, _ w: Double, _ color: Color = .primary, big: Bool = false) -> some View {
    VStack(spacing: 0) {
      Text("\(Int(w))").font(big ? .title3 : .body).bold().monospacedDigit().foregroundColor(color)
      Text(label).font(.system(size: 9)).foregroundColor(.secondary)
    }
  }

  // ── MEDIA screen (pause / resume the audio you're listening to) ─────────────────────────────────────────
  @ViewBuilder private func mediaScreen() -> some View {
    VStack(spacing: 12) {
      Text("Music").font(.headline)
      Button { sendMedia("pause") } label: { Label("Pause", systemImage: "pause.circle.fill").frame(maxWidth: .infinity) }.tint(.orange)
      Button { sendMedia("resume") } label: { Label("Resume", systemImage: "play.circle.fill").frame(maxWidth: .infinity) }.tint(.green)
      Button { store.voiceOn.toggle() } label: {
        Label(store.voiceOn ? "Cues on" : "Cues off", systemImage: store.voiceOn ? "speaker.wave.2.fill" : "speaker.slash.fill").frame(maxWidth: .infinity)
      }
      Text("← swipe to map").font(.caption2).foregroundColor(.secondary)
    }.buttonStyle(.bordered).controlSize(.large).padding(.horizontal, 10)
  }
}
