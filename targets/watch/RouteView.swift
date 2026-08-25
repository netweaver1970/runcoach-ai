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
            if let s = store.coords.first {
              Annotation("Start", coordinate: s) { Circle().fill(Color.pink).frame(width: 10, height: 10) }
            }
            UserAnnotation()
          }
          VStack(spacing: 1) {
            if store.offRoute {
              Text("OFF ROUTE").font(.caption2).bold().foregroundColor(.orange)
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
