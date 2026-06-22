import SwiftUI
import WatchConnectivity
import WidgetKit

// ─── Data model (mirrors the JSON the phone pushes) ────────────────────────────
struct KPIPoint: Codable, Hashable { let t: Double; let v: Double }
struct KPI: Codable, Identifiable, Hashable {
  var id: String { key }
  let key: String
  let label: String
  let unit: String
  let value: Double
  let color: String          // "#RRGGBB"
  let grad: [String]?        // optional top→bottom colour ramp for the graph
  let series: [KPIPoint]
}
struct KPIPayload: Codable {
  let selected: String
  let updatedAt: Double
  let kpis: [KPI]
}

let APP_GROUP = "group.com.netweaver1970.runcoachai"

// ─── Store + WatchConnectivity receiver ───────────────────────────────────────
final class KPIStore: NSObject, ObservableObject, WCSessionDelegate {
  @Published var payload: KPIPayload?
  static let shared = KPIStore()

  override init() {
    super.init()
    load()                               // last cached payload (App Group)
    if WCSession.isSupported() {
      WCSession.default.delegate = self
      WCSession.default.activate()
    }
  }

  private func persist(_ data: Data, _ p: KPIPayload) {
    let d = UserDefaults(suiteName: APP_GROUP)
    d?.set(data, forKey: "kpiPayload")
    // Compact snapshot the complication reads.
    if let sel = p.kpis.first(where: { $0.key == p.selected }) ?? p.kpis.first {
      d?.set(sel.value, forKey: "selValue")
      d?.set(sel.label, forKey: "selLabel")
      d?.set(sel.unit,  forKey: "selUnit")
      d?.set(sel.color, forKey: "selColor")
    }
    WidgetCenter.shared.reloadAllTimelines()
  }

  private func load() {
    guard let data = UserDefaults(suiteName: APP_GROUP)?.data(forKey: "kpiPayload"),
          let p = try? JSONDecoder().decode(KPIPayload.self, from: data) else { return }
    payload = p
  }

  private func ingest(_ context: [String: Any]) {
    guard let json = context["json"] as? String, let data = json.data(using: .utf8),
          let p = try? JSONDecoder().decode(KPIPayload.self, from: data) else { return }
    DispatchQueue.main.async { self.payload = p; self.persist(data, p) }
  }

  // WCSession delivers the latest state via application context + immediate messages.
  func session(_ s: WCSession, didReceiveApplicationContext c: [String: Any]) { ingest(c) }
  func session(_ s: WCSession, didReceiveUserInfo u: [String: Any]) { ingest(u) }
  func session(_ s: WCSession, didReceiveMessage m: [String: Any]) { ingest(m) }
  func session(_ s: WCSession, activationDidCompleteWith a: WCSessionActivationState, error: Error?) {
    if let c = s.receivedApplicationContext as [String: Any]?, !c.isEmpty { ingest(c) }
  }
}

@main
struct RunCoachWatchApp: App {
  @StateObject private var store = KPIStore.shared
  var body: some Scene {
    WindowGroup { ContentView().environmentObject(store) }
  }
}
