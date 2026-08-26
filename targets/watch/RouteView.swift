import SwiftUI
import MapKit
import CoreLocation
import WatchKit
import AVFoundation

// Route pushed from the phone (Wayfinder). Sent over the SAME WCSession channel as the KPI payload — the
// watch tries a KPIPayload decode first, then this. Keep the field names in sync with watchRoute.ts.
struct RoutePoint: Codable, Hashable { let lat: Double; let lon: Double }
struct RouteTurn: Codable, Hashable { let lat: Double; let lon: Double; let text: String; let dist: Double }
struct RoutePayload: Codable {
  let type: String            // "route"
  let name: String
  let distanceKm: Double
  let pts: [RoutePoint]
  let turns: [RouteTurn]?     // turn-by-turn maneuvers (optional — old phone builds omit it)
  let voice: Bool?            // initial voice-on state from the phone setting
  let sport: String?          // "walking" → walk session; anything else → run
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

  private let mgr = CLLocationManager()
  private var wasOff = false
  private let synth = AVSpeechSynthesizer()
  private var turns: [RouteTurn] = []
  private var announced: Set<Int> = []     // turn indices already spoken for this route

  override init() {
    super.init()
    mgr.delegate = self
    mgr.desiredAccuracy = kCLLocationAccuracyBest
  }

  func setRoute(_ r: RoutePayload) {
    DispatchQueue.main.async {
      self.route = r; self.remainingKm = r.distanceKm; self.offRoute = false; self.wasOff = false
      self.turns = r.turns ?? []; self.voiceOn = r.voice ?? true; self.announced = []; self.nextTurnText = ""
      self.start()   // track from the moment a route lands, so turn cues fire on any screen (not just the map)
    }
  }
  func start() {
    mgr.requestWhenInUseAuthorization(); mgr.startUpdatingLocation()
    if CLLocationManager.headingAvailable() { mgr.startUpdatingHeading() }
  }
  func stop() { mgr.stopUpdatingLocation(); mgr.stopUpdatingHeading() }

  private func speak(_ s: String) {
    guard voiceOn, !s.isEmpty else { return }
    do {
      try AVAudioSession.sharedInstance().setCategory(.playback, mode: .voicePrompt, options: [.duckOthers])
      try AVAudioSession.sharedInstance().setActive(true)
    } catch { }
    let u = AVSpeechUtterance(string: s)
    u.rate = AVSpeechUtteranceDefaultSpeechRate
    synth.speak(u)
  }

  // Fire the nearest not-yet-announced turn once you're within ~40 m: a heads-up haptic (always) + a spoken
  // cue (when voice is on). `nextTurnText` tracks the upcoming maneuver for the on-screen readout.
  private func checkTurns(_ loc: CLLocation) {
    guard !turns.isEmpty else { return }
    var bi = -1; var bd = Double.greatestFiniteMagnitude
    for (i, t) in turns.enumerated() where !announced.contains(i) {
      let d = loc.distance(from: CLLocation(latitude: t.lat, longitude: t.lon))
      if d < bd { bd = d; bi = i }
    }
    guard bi >= 0 else { nextTurnText = ""; return }
    let t = turns[bi]
    nextTurnText = t.text
    if bd < 40 {
      announced.insert(bi)
      jumpToMap += 1   // a turn is happening → surface the map (ContentView watches this)
      WKInterfaceDevice.current().play(.directionUp)
      speak(bd > 18 ? "In \(Int((bd / 5).rounded()) * 5) meters, \(t.text)" : t.text)
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
private struct DirArrow: Identifiable { let id: Int; let coord: CLLocationCoordinate2D; let deg: Double }
private func directionArrows(_ c: [CLLocationCoordinate2D]) -> [DirArrow] {
  guard c.count > 4 else { return [] }
  let n = 5, ahead = max(1, c.count / 30)
  var out: [DirArrow] = []
  for k in 0..<n {
    let i = Int(Double(k) / Double(n) * Double(c.count - 1))
    let j = min(i + ahead, c.count - 1)
    if i != j { out.append(DirArrow(id: k, coord: c[i], deg: geoBearing(c[i], c[j]))) }
  }
  return out
}

// ─── Guidance view: the route on a map + a live "km left" / off-route readout ─────────────────────────────
private func fmtClock(_ t: TimeInterval) -> String {
  let s = Int(t); return String(format: "%d:%02d", s / 60, s % 60)
}

struct RouteView: View {
  @ObservedObject var store = RouteStore.shared
  @ObservedObject var engine = WorkoutEngine.shared
  @State private var cam: MapCameraPosition = .userLocation(followsHeading: true, fallback: .automatic)   // heading-up follow
  @State private var panelUp = true                                                 // collapse the bottom panel
  @State private var showEndConfirm = false                                         // Save / Discard end sheet

  var body: some View {
    Group {
      if let r = store.route {
        ZStack(alignment: .bottom) {
          Map(position: $cam) {
            MapPolyline(coordinates: store.coords)
              .stroke(store.offRoute ? Color.orange : Color.pink, lineWidth: 4)
            // Travel-direction arrows. id 0 = a bold green "start this way" arrow; the rest show the loop's
            // direction around its length so clockwise vs counter-clockwise reads at a glance.
            ForEach(directionArrows(store.coords)) { a in
              Annotation(a.id == 0 ? "Start" : "", coordinate: a.coord) {
                Image(systemName: a.id == 0 ? "arrow.up.circle.fill" : "arrowtriangle.up.fill")
                  .font(.system(size: a.id == 0 ? 30 : 11))
                  .foregroundColor(a.id == 0 ? .green : .pink)
                  .rotationEffect(.degrees(a.deg - store.heading))   // map is heading-up → offset arrows by heading
                  .shadow(color: .black.opacity(0.5), radius: 1)
              }
            }
            UserAnnotation()
          }
          if panelUp {
          VStack(spacing: 3) {
            Button { withAnimation { panelUp = false } } label: {
              Image(systemName: "chevron.compact.down").font(.system(size: 18)).foregroundColor(.secondary)
                .frame(maxWidth: .infinity, minHeight: 24).contentShape(Rectangle())   // whole strip tappable
            }.buttonStyle(.plain)
            // Status line: off-route / start heading / upcoming turn (as before), or live HR+pace when running.
            if store.offRoute {
              Text("OFF ROUTE").font(.caption2).bold().foregroundColor(.orange)
            } else if !store.nextTurnText.isEmpty {
              Text(store.nextTurnText).font(.caption2).bold().foregroundColor(.cyan)
                .lineLimit(2).multilineTextAlignment(.center)
            } else if let a = directionArrows(store.coords).first, store.remainingKm > r.distanceKm * 0.92 {
              Text(relStart(a.deg, store.heading)).font(.caption2).bold().foregroundColor(.green)
            } else if engine.running {
              HStack(spacing: 8) {
                Label("\(Int(engine.heartRate))", systemImage: "heart.fill").foregroundColor(.red)
                Text("\(engine.paceStr)/km").foregroundColor(.secondary)
              }.font(.caption2).monospacedDigit()
            }
            // Primary readout: distance+clock while running, else km-left to the finish.
            if engine.running {
              Text("\(String(format: "%.2f", engine.distanceM / 1000)) km · \(fmtClock(engine.elapsed))")
                .font(.headline).monospacedDigit()
            } else {
              Text(String(format: "%.1f km left", store.remainingKm)).font(.headline).monospacedDigit()
            }
            // Controls.
            if engine.running {
              HStack(spacing: 10) {
                Button { engine.togglePause() } label: { Image(systemName: engine.paused ? "play.fill" : "pause.fill") }
                Button(role: .destructive) { showEndConfirm = true } label: { Image(systemName: "stop.fill") }
              }.buttonStyle(.bordered).controlSize(.mini)
            } else {
              Button { engine.startFromRoute(r) } label: { Label("Start run", systemImage: "figure.run") }
                .buttonStyle(.borderedProminent).controlSize(.small).tint(.green)
            }
          }
          .padding(.vertical, 4).padding(.horizontal, 10)
          .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
          .padding(.bottom, 6)
          } else {
            // Collapsed → give the map the screen back; a small handle brings the panel (and controls) back.
            Button { withAnimation { panelUp = true } } label: {
              Image(systemName: "chevron.compact.up").font(.system(size: 18)).padding(.horizontal, 22).padding(.vertical, 5)
                .background(.ultraThinMaterial, in: Capsule())
            }.buttonStyle(.plain).padding(.bottom, 6)
          }
        }
        .overlay(alignment: .topTrailing) {
          Button { store.voiceOn.toggle() } label: {
            Image(systemName: store.voiceOn ? "speaker.wave.2.fill" : "speaker.slash.fill")
              .font(.system(size: 12)).padding(6)
              .background(.ultraThinMaterial, in: Circle())
          }
          .buttonStyle(.plain).padding(6)
        }
        .onAppear { store.start() }   // tracking is kept running app-wide (see setRoute) so cues fire anywhere
        .navigationTitle(r.name)
        .confirmationDialog("End run?", isPresented: $showEndConfirm, titleVisibility: .visible) {
          Button("Save & end") { engine.end(save: true) }
          Button("Discard", role: .destructive) { engine.end(save: false) }
          Button("Cancel", role: .cancel) { }
        }
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
}
