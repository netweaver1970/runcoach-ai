import SwiftUI
import MapKit
import CoreLocation
import WatchKit
import AVFoundation

// Route pushed from the phone (Wayfinder). Sent over the SAME WCSession channel as the KPI payload — the
// watch tries a KPIPayload decode first, then this. Keep the field names in sync with watchRoute.ts.
struct RoutePoint: Codable, Hashable { let lat: Double; let lon: Double }
struct RouteTurn: Codable, Hashable { let lat: Double; let lon: Double; let text: String; let dist: Double }
// One structured-workout segment (Stage 2). dur (s) OR dist (m) → a goal; neither → OPEN (advance with the lap button).
struct RouteSeg: Codable, Hashable { let kind: String; let dur: Double?; let dist: Double?; let label: String; let zone: String? }
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
  private let synth = AVSpeechSynthesizer()
  private var turns: [RouteTurn] = []
  private var announced: Set<Int> = []     // turn indices already spoken for this route

  override init() {
    super.init()
    mgr.delegate = self
    mgr.desiredAccuracy = kCLLocationAccuracyBest
    mgr.headingFilter = kCLHeadingFilterNone   // frequent heading updates → a steadier compass fan
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
      try AVAudioSession.sharedInstance().setCategory(.playback, mode: .voicePrompt, options: [.duckOthers, .mixWithOthers])
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
    guard bi >= 0 else { nextTurnText = ""; turnDistM = 9999; return }
    let t = turns[bi]
    nextTurnText = t.text
    turnDistM = bd                 // distance to the next turn → the map zooms in as this shrinks
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
  let n = min(16, max(6, c.count / 8)), ahead = max(1, c.count / 40)
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
  @State private var panelUp = true                                                 // collapse the bottom panel
  @State private var showEndConfirm = false                                         // Save / Discard end sheet
  @State private var mapOn = true                                                   // false → metrics-only (no MapKit = battery)
  @State private var headingUp = true                                               // true = heading-up, false = north-up
  @AppStorage("autoPause") private var autoPause = false                            // pause when stationary

  var body: some View {
    Group {
      if let r = store.route {
        ZStack(alignment: .bottom) {
          if mapOn {
          Map(position: $cam) {
            MapPolyline(coordinates: store.coords)
              .stroke(store.offRoute ? Color.orange : Color.pink, lineWidth: 4)
            // Travel-direction arrows. id 0 = a bold green "start this way" arrow; the rest show the loop's
            // direction around its length so clockwise vs counter-clockwise reads at a glance.
            ForEach(directionArrows(store.coords)) { a in
              Annotation(a.id == 0 ? "Start" : "", coordinate: a.coord) {
                Image(systemName: a.id == 0 ? "arrow.up.circle.fill" : "arrowtriangle.up.fill")
                  .font(.system(size: a.id == 0 ? 30 : 18, weight: .black))
                  .foregroundColor(a.id == 0 ? .green : .white)      // white = distinct from the pink route line
                  .shadow(color: .black, radius: 1)                  // black outline → visible on the light map
                  .shadow(color: .black.opacity(0.8), radius: 2)
                  .rotationEffect(.degrees(a.deg - (headingUp ? store.heading : 0)))   // offset only when heading-up
              }
            }
            UserAnnotation()
          }
          } else {
            Color.black.ignoresSafeArea()   // metrics-only: no MapKit rendering → saves battery
          }
          if panelUp {
          VStack(spacing: 3) {
            Button { withAnimation { panelUp = false } } label: {
              Image(systemName: "chevron.compact.down").font(.system(size: 18)).foregroundColor(.secondary)
                .frame(maxWidth: .infinity, minHeight: 24).contentShape(Rectangle())   // whole strip tappable
            }.buttonStyle(.plain)
            if engine.running {
              // Interval banner: label + zone + rep count, then the big remaining time/distance.
              if store.offRoute {
                Text("OFF ROUTE").font(.caption2).bold().foregroundColor(.orange)
              } else if !engine.segLabel.isEmpty {
                HStack(spacing: 6) {
                  Text(engine.segLabel.uppercased()).bold()
                  if !engine.segZone.isEmpty { Text(engine.segZone).opacity(0.9) }
                  Spacer()
                  if engine.segCount > 0 { Text("\(min(engine.segIndex + 1, engine.segCount))/\(engine.segCount)").opacity(0.7) }
                }.font(.caption2).foregroundColor(segColor(engine.segKind))
                Text(engine.segRemain).font(.title3).monospacedDigit().foregroundColor(segColor(engine.segKind))
              }
              // Pace + distance here; HR + power are the always-on pill at the top.
              HStack(spacing: 10) {
                Text("\(engine.paceStr)/km").foregroundColor(.secondary)
                Text(String(format: "%.2f km", engine.distanceM / 1000)).foregroundColor(.secondary)
              }.font(.caption2).monospacedDigit()
              HStack(spacing: 8) {
                Button { engine.togglePause() } label: { Image(systemName: engine.paused ? "play.fill" : "pause.fill") }
                if engine.segOpen { Button { engine.lap() } label: { Image(systemName: "forward.end.fill") } }
                Button(role: .destructive) { showEndConfirm = true } label: { Image(systemName: "stop.fill") }
              }.buttonStyle(.bordered).controlSize(.small)
            } else {
              if store.offRoute {
                Text("OFF ROUTE").font(.caption2).bold().foregroundColor(.orange)
              } else if !store.nextTurnText.isEmpty {
                Text(store.nextTurnText).font(.caption2).bold().foregroundColor(.cyan).lineLimit(2).multilineTextAlignment(.center)
              } else if let a = directionArrows(store.coords).first, store.remainingKm > r.distanceKm * 0.92 {
                Text(relStart(a.deg, store.heading)).font(.caption2).bold().foregroundColor(.green)
              }
              Text(String(format: "%.1f km left", store.remainingKm)).font(.subheadline).monospacedDigit()
              Button { engine.startFromRoute(r) } label: { Label("Start", systemImage: "figure.run").font(.caption) }
                .buttonStyle(.borderedProminent).controlSize(.mini).tint(.green)
              Button { autoPause.toggle() } label: {
                Label(autoPause ? "Auto-pause on" : "Auto-pause off", systemImage: autoPause ? "pause.circle.fill" : "pause.circle")
                  .font(.caption2)
              }.buttonStyle(.plain).foregroundColor(autoPause ? .green : .secondary)
            }
          }
          .padding(.vertical, 2).padding(.horizontal, 8)
          .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
          .padding(.bottom, 4)
          } else {
            // Collapsed → give the map the screen back; a big handle brings the panel (and controls) back.
            Button { withAnimation { panelUp = true } } label: {
              Image(systemName: "chevron.up").font(.system(size: 16, weight: .bold)).foregroundColor(.primary)
                .frame(width: 100, height: 34).contentShape(Rectangle())
                .background(.ultraThinMaterial, in: Capsule())
            }.buttonStyle(.plain).padding(.bottom, 6)
          }
        }
        .overlay(alignment: .topTrailing) {
          Button { store.voiceOn.toggle() } label: {
            Image(systemName: store.voiceOn ? "speaker.wave.2.fill" : "speaker.slash.fill")
              .font(.system(size: 15)).frame(width: 40, height: 40).contentShape(Rectangle())
              .background(.ultraThinMaterial, in: Circle())
          }.buttonStyle(.plain).padding(4)
        }
        .overlay(alignment: .topLeading) {
          VStack(spacing: 6) {
            // Map on/off — off = metrics-only, drops MapKit rendering to save battery on long runs.
            Button { mapOn.toggle() } label: {
              Image(systemName: mapOn ? "map.fill" : "map")
                .font(.system(size: 14)).frame(width: 40, height: 40).contentShape(Rectangle())
                .background(.ultraThinMaterial, in: Circle())
            }.buttonStyle(.plain)
            // Toggle north-up ↔ heading-up (also re-centres, recovering from a crown/pan interaction).
            if mapOn {
              Button {
                headingUp.toggle()
                cam = headingUp ? .userLocation(followsHeading: true, fallback: .automatic)
                                : .userLocation(fallback: .automatic)
              } label: {
                Image(systemName: headingUp ? "location.north.line.fill" : "n.circle.fill")
                  .font(.system(size: 15)).frame(width: 40, height: 40).contentShape(Rectangle())
                  .background(.ultraThinMaterial, in: Circle())
              }.buttonStyle(.plain)
            }
          }.padding(4)
        }
        .overlay(alignment: .top) {
          // HR + power always visible during a run, even when the panel is collapsed — big + prominent.
          if engine.running {
            HStack(spacing: 12) {
              Text("♥\(Int(engine.heartRate))").foregroundColor(.red)
              if engine.power > 0 { Text("\(Int(engine.power))w").foregroundColor(.orange) }
            }.font(.title3).bold().monospacedDigit()
            .padding(.horizontal, 12).padding(.vertical, 4)
            .background(.ultraThinMaterial, in: Capsule())
            .padding(.top, 2)
          }
        }
        .onChange(of: store.turnDistM) {
          // A turn is coming up → zoom the map to street detail so a detour isn't missed; restore follow after.
          guard mapOn, engine.running else { return }
          if store.turnDistM < 80, let h = store.here {
            cam = .camera(MapCamera(centerCoordinate: h, distance: 140, heading: headingUp ? store.heading : 0))
          } else if store.turnDistM > 140 {
            cam = headingUp ? .userLocation(followsHeading: true, fallback: .automatic)
                            : .userLocation(fallback: .automatic)
          }
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
