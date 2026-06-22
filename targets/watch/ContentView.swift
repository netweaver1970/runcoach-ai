import SwiftUI
import Charts

extension Color {
  init(hex: String) {
    let s = Scanner(string: hex.hasPrefix("#") ? String(hex.dropFirst()) : hex)
    var rgb: UInt64 = 0; s.scanHexInt64(&rgb)
    self.init(.sRGB, red: Double((rgb >> 16) & 0xFF) / 255, green: Double((rgb >> 8) & 0xFF) / 255, blue: Double(rgb & 0xFF) / 255)
  }
}

struct ContentView: View {
  @EnvironmentObject var store: KPIStore
  @State private var selection: String = ""

  var body: some View {
    if let p = store.payload, !p.kpis.isEmpty {
      TabView(selection: $selection) {
        ForEach(p.kpis) { kpi in
          KPIView(kpi: kpi).tag(kpi.key)
        }
      }
      .tabViewStyle(.page)
      .onAppear { if selection.isEmpty { selection = p.selected } }
    } else {
      VStack(spacing: 6) {
        Image(systemName: "applewatch.radiowaves.left.and.right").font(.title2).foregroundColor(.secondary)
        Text("Open RunCoach AI on your iPhone to sync.").font(.footnote).foregroundColor(.secondary).multilineTextAlignment(.center)
      }.padding()
    }
  }
}

struct KPIView: View {
  let kpi: KPI
  var body: some View {
    let color = Color(hex: kpi.color)
    ScrollView {
      VStack(alignment: .leading, spacing: 6) {
        Text(kpi.label.uppercased()).font(.system(size: 12, weight: .semibold)).foregroundColor(.secondary)
        HStack(alignment: .firstTextBaseline, spacing: 2) {
          Text(fmt(kpi.value)).font(.system(size: 40, weight: .bold)).foregroundColor(color)
          Text(kpi.unit).font(.system(size: 16, weight: .semibold)).foregroundColor(.secondary)
        }
        if kpi.series.count > 1 {
          Chart(kpi.series, id: \.t) { pt in
            AreaMark(x: .value("t", pt.t), y: .value("v", pt.v))
              .foregroundStyle(LinearGradient(colors: [color.opacity(0.35), color.opacity(0.02)], startPoint: .top, endPoint: .bottom))
            LineMark(x: .value("t", pt.t), y: .value("v", pt.v))
              .foregroundStyle(color).interpolationMethod(.monotone)
          }
          .chartXAxis(.hidden)
          .frame(height: 90)
        }
        Text(relTime(kpi.series.last?.t)).font(.system(size: 11)).foregroundColor(.secondary)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 4)
    }
  }
  private func fmt(_ v: Double) -> String { v == v.rounded() ? String(Int(v)) : String(format: "%.1f", v) }
  private func relTime(_ t: Double?) -> String {
    guard let t = t else { return "" }
    let mins = Int((Date().timeIntervalSince1970 - t / 1000) / 60)
    if mins < 2 { return "just now" }
    if mins < 60 { return "\(mins) min ago" }
    return "\(mins / 60)h ago"
  }
}
