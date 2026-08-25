import SwiftUI
import MapKit
import CoreLocation
import WatchKit

// Route pushed from the phone (Wayfinder). Sent over the SAME WCSession channel as the KPI payload — the
// watch tries a KPIPayload decode first, then this. Keep the field names in sync with watchRoute.ts.
struct RoutePoint: Codable, Hashable { let lat: Double; let lon: Double }
struct RoutePayload: Codable {
  let type: String            // "route"
  let name: String
  let distanceKm: Double
  let pts: [RoutePoint]
}

// ─── Route store: holds the pushed route + drives live guidance from the watch GPS ───────────────────────
final class RouteStore: NSObject, ObservableObject, CLLocationManagerDelegate {
  static let shared = RouteStore()
  @Published var route: RoutePayload?
  @Published var here: CLLocationCoordinate2D?
  @Published var offRoute = false
  @Published var remainingKm: Double = 0

  private let mgr = CLLocationManager()
  private var wasOff = false

  override init() {
    super.init()
    mgr.delegate = self
    mgr.desiredAccuracy = kCLLocationAccuracyBest
  }

  func setRoute(_ r: RoutePayload) {
    DispatchQueue.main.async { self.route = r; self.remainingKm = r.distanceKm; self.offRoute = false; self.wasOff = false }
  }
  func start() { mgr.requestWhenInUseAuthorization(); mgr.startUpdatingLocation() }
  func stop() { mgr.stopUpdatingLocation() }

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
    }
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
struct RouteView: View {
  @ObservedObject var store = RouteStore.shared

  var body: some View {
    Group {
      if let r = store.route {
        ZStack(alignment: .bottom) {
          Map {
            MapPolyline(coordinates: store.coords)
              .stroke(store.offRoute ? Color.orange : Color.pink, lineWidth: 4)
            // Travel-direction arrows. id 0 = a bold green "start this way" arrow; the rest show the loop's
            // direction around its length so clockwise vs counter-clockwise reads at a glance.
            ForEach(directionArrows(store.coords)) { a in
              Annotation(a.id == 0 ? "Start" : "", coordinate: a.coord) {
                Image(systemName: a.id == 0 ? "arrow.up.circle.fill" : "arrowtriangle.up.fill")
                  .font(.system(size: a.id == 0 ? 20 : 11))
                  .foregroundColor(a.id == 0 ? .green : .pink)
                  .rotationEffect(.degrees(a.deg))
                  .shadow(color: .black.opacity(0.5), radius: 1)
              }
            }
            UserAnnotation()
          }
          VStack(spacing: 1) {
            if store.offRoute {
              Text("OFF ROUTE").font(.caption2).bold().foregroundColor(.orange)
            } else if let a = directionArrows(store.coords).first, store.remainingKm > r.distanceKm * 0.92 {
              // Still at the start → spell out which way to set off (clockwise vs counter reads from the arrows).
              Text("Head \(compass16(a.deg)) to start").font(.caption2).bold().foregroundColor(.green)
            }
            Text(String(format: "%.1f km left", store.remainingKm))
              .font(.headline).monospacedDigit()
          }
          .padding(.vertical, 4).padding(.horizontal, 10)
          .background(.ultraThinMaterial, in: Capsule())
          .padding(.bottom, 6)
        }
        .onAppear { store.start() }
        .onDisappear { store.stop() }
        .navigationTitle(r.name)
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
