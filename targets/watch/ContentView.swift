import SwiftUI
import Charts

extension Color {
  init(hex: String) {
    let s = Scanner(string: hex.hasPrefix("#") ? String(hex.dropFirst()) : hex)
    var rgb: UInt64 = 0; s.scanHexInt64(&rgb)
    self.init(.sRGB, red: Double((rgb >> 16) & 0xFF) / 255, green: Double((rgb >> 8) & 0xFF) / 255, blue: Double(rgb & 0xFF) / 255)
  }
}

private func fmtVal(_ v: Double) -> String { v == v.rounded() ? String(Int(v)) : String(format: "%.1f", v) }
private func relTime(_ t: Double?) -> String {
  guard let t = t else { return "" }
  let mins = Int((Date().timeIntervalSince1970 - t / 1000) / 60)
  if mins < 2 { return "just now" }
  if mins < 60 { return "\(mins) min ago" }
  return "\(mins / 60)h ago"
}

// ─── Root: hierarchical list of KPIs (tap one to open its graph) ───────────────
struct ContentView: View {
  @EnvironmentObject var store: KPIStore

  var body: some View {
    NavigationStack {
      if let p = store.payload, !p.kpis.isEmpty {
        List {
          ForEach(p.kpis) { kpi in
            NavigationLink(value: kpi) { KPIRow(kpi: kpi, selected: kpi.key == p.selected) }
          }
          if p.updatedAt > 0 {
            Text("Updated \(relTime(p.updatedAt))")
              .font(.system(size: 11)).foregroundColor(.secondary)
              .listRowBackground(Color.clear)
          }
        }
        .navigationTitle("RunCoach")
        .navigationDestination(for: KPI.self) { KPIDetailView(kpi: $0) }
      } else {
        VStack(spacing: 6) {
          Image(systemName: "applewatch.radiowaves.left.and.right").font(.title2).foregroundColor(.secondary)
          Text("Open RunCoach AI on your iPhone to sync.").font(.footnote).foregroundColor(.secondary).multilineTextAlignment(.center)
        }.padding()
      }
    }
  }
}

// ─── One row in the list: label, value, and a small sparkline ──────────────────
struct KPIRow: View {
  let kpi: KPI
  let selected: Bool
  var body: some View {
    let color = Color(hex: kpi.color)
    HStack(spacing: 8) {
      VStack(alignment: .leading, spacing: 1) {
        HStack(spacing: 4) {
          Text(kpi.label).font(.system(size: 14, weight: .medium))
          if selected { Image(systemName: "star.fill").font(.system(size: 8)).foregroundColor(.yellow) }
        }
        HStack(alignment: .firstTextBaseline, spacing: 2) {
          Text(fmtVal(kpi.value)).font(.system(size: 20, weight: .bold)).foregroundColor(color)
          Text(kpi.unit).font(.system(size: 11)).foregroundColor(.secondary)
        }
      }
      Spacer(minLength: 0)
      if kpi.series.count > 1 {
        Chart(Array(kpi.series.enumerated()), id: \.offset) { i, pt in
          LineMark(x: .value("i", i), y: .value("v", pt.v)).foregroundStyle(color).interpolationMethod(.monotone)
        }
        .chartXAxis(.hidden).chartYAxis(.hidden)
        .frame(width: 52, height: 28)
      }
    }
    .padding(.vertical, 2)
  }
}

// ─── Detail: big value + full graph for one KPI ────────────────────────────────
struct KPIDetailView: View {
  let kpi: KPI
  var body: some View {
    let color = Color(hex: kpi.color)
    ScrollView {
      VStack(alignment: .leading, spacing: 6) {
        HStack(alignment: .firstTextBaseline, spacing: 2) {
          Text(fmtVal(kpi.value)).font(.system(size: 40, weight: .bold)).foregroundColor(color)
          Text(kpi.unit).font(.system(size: 16, weight: .semibold)).foregroundColor(.secondary)
        }
        if kpi.series.count > 1 {
          Chart(Array(kpi.series.enumerated()), id: \.offset) { i, pt in
            AreaMark(x: .value("i", i), y: .value("v", pt.v))
              .foregroundStyle(LinearGradient(colors: [color.opacity(0.35), color.opacity(0.02)], startPoint: .top, endPoint: .bottom))
            LineMark(x: .value("i", i), y: .value("v", pt.v))
              .foregroundStyle(color).interpolationMethod(.monotone)
          }
          .chartXAxis(.hidden)
          .frame(height: 110)
          if let lo = kpi.series.map(\.v).min(), let hi = kpi.series.map(\.v).max() {
            HStack {
              Text("low \(fmtVal(lo))").font(.system(size: 11)).foregroundColor(.secondary)
              Spacer()
              Text("high \(fmtVal(hi))").font(.system(size: 11)).foregroundColor(.secondary)
            }
          }
        } else {
          Text("No history yet").font(.system(size: 12)).foregroundColor(.secondary).padding(.vertical, 8)
        }
        Text("\(relTime(kpi.series.last?.t)) · \(kpi.series.count) pts").font(.system(size: 11)).foregroundColor(.secondary)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 4)
    }
    .navigationTitle(kpi.label)
  }
}
