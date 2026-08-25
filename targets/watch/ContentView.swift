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

// ─── Chart context helpers ─────────────────────────────────────────────────────

// Break the line into segments at every gap flag (g==1): a data hole or an excluded workout.
private func segmentIds(_ series: [KPIPoint]) -> [Int] {
  var out: [Int] = []; var seg = 0
  for (i, p) in series.enumerated() { if i > 0 && (p.g ?? 0) == 1 { seg += 1 }; out.append(seg) }
  return out
}

// Contiguous asleep index ranges (as x-positions, ±0.5) for sleep shading.
private func sleepRanges(_ series: [KPIPoint]) -> [(Double, Double)] {
  var ranges: [(Double, Double)] = []; var start: Int? = nil
  for (i, p) in series.enumerated() {
    let asleep = (p.a ?? 0) == 1
    if asleep && start == nil { start = i }
    if !asleep, let s = start { ranges.append((Double(s) - 0.5, Double(i - 1) + 0.5)); start = nil }
  }
  if let s = start { ranges.append((Double(s) - 0.5, Double(series.count - 1) + 0.5)) }
  return ranges
}

// Tiny legend under a chart explaining the context annotations.
private func contextCaption(_ kpi: KPI) -> String? {
  if kpi.frame == "multi" { return (kpi.marks?.isEmpty == false) ? "┊ week (Mon)" : nil }
  if kpi.series.contains(where: { ($0.a ?? 0) == 1 }) { return "▓ asleep" }
  return nil
}

// ─── Root: hierarchical list of KPIs (tap one to open its graph) ───────────────
struct ContentView: View {
  @EnvironmentObject var store: KPIStore
  @ObservedObject var routeStore = RouteStore.shared

  var body: some View {
    NavigationStack {
      if store.payload?.kpis.isEmpty == false || routeStore.route != nil {
        List {
          if let r = routeStore.route {
            NavigationLink { RouteView() } label: {
              Label("\(r.name) · \(String(format: "%.1f", r.distanceKm)) km", systemImage: "map.fill")
                .foregroundColor(.pink)
            }
          }
          if let p = store.payload {
            ForEach(p.kpis) { kpi in
              NavigationLink(value: kpi) { KPIRow(kpi: kpi, selected: kpi.key == p.selected) }
            }
            if p.updatedAt > 0 {
              Text("Updated \(relTime(p.updatedAt))")
                .font(.system(size: 11)).foregroundColor(.secondary)
                .listRowBackground(Color.clear)
            }
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
        let lineStyle = kpi.grad.map { LinearGradient(colors: $0.map { Color(hex: $0) }, startPoint: .top, endPoint: .bottom) }
          ?? LinearGradient(colors: [color, color], startPoint: .top, endPoint: .bottom)
        Chart(Array(kpi.series.enumerated()), id: \.offset) { i, pt in
          LineMark(x: .value("i", i), y: .value("v", pt.v)).foregroundStyle(lineStyle).interpolationMethod(.monotone)
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
          let vals = kpi.series.map(\.v)
          let fixed = ["stress", "battery", "recovery"].contains(kpi.key)
          let lo = fixed ? 0 : (vals.min() ?? 0)
          let hiRaw = fixed ? 100 : (vals.max() ?? 1)
          let hi = hiRaw > lo ? hiRaw : lo + 1
          // Value-coloured line (Bevel-style): high→low ramp mapped to the y-axis.
          let lineStyle = kpi.grad.map { LinearGradient(colors: $0.map { Color(hex: $0) }, startPoint: .top, endPoint: .bottom) }
            ?? LinearGradient(colors: [color, color], startPoint: .top, endPoint: .bottom)
          // Segment ids break the line at gaps (data holes / workouts); sleep ranges shade the night.
          let segs = segmentIds(kpi.series)
          let sleep = sleepRanges(kpi.series)
          Chart {
            ForEach(Array(sleep.enumerated()), id: \.offset) { _, r in
              RectangleMark(xStart: .value("s", r.0), xEnd: .value("e", r.1),
                            yStart: .value("lo", lo), yEnd: .value("hi", hi))
                .foregroundStyle(Color(hex: "6366F1").opacity(0.16))
            }
            ForEach(kpi.marks ?? [], id: \.self) { m in
              RuleMark(x: .value("wk", Double(m) - 0.5))
                .foregroundStyle(Color.gray.opacity(0.35))
                .lineStyle(StrokeStyle(lineWidth: 0.5, dash: [2, 2]))
            }
            ForEach(Array(kpi.series.enumerated()), id: \.offset) { i, pt in
              AreaMark(x: .value("i", Double(i)), y: .value("v", pt.v), series: .value("seg", segs[i]))
                .foregroundStyle(LinearGradient(colors: [color.opacity(0.28), color.opacity(0.02)], startPoint: .top, endPoint: .bottom))
              LineMark(x: .value("i", Double(i)), y: .value("v", pt.v), series: .value("seg", segs[i]))
                .foregroundStyle(lineStyle).interpolationMethod(.monotone)
            }
          }
          .chartYScale(domain: lo...hi)
          .chartXAxis(.hidden)
          .frame(height: 110)
          HStack {
            Text("low \(fmtVal(vals.min() ?? 0))").font(.system(size: 11)).foregroundColor(.secondary)
            Spacer()
            if let ctx = contextCaption(kpi) { Text(ctx).font(.system(size: 10)).foregroundColor(.secondary) }
            Spacer()
            Text("high \(fmtVal(vals.max() ?? 0))").font(.system(size: 11)).foregroundColor(.secondary)
          }
        } else {
          Text("No history yet").font(.system(size: 12)).foregroundColor(.secondary).padding(.vertical, 8)
        }
        Text(relTime(kpi.series.last?.t)).font(.system(size: 11)).foregroundColor(.secondary)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 4)
    }
    .navigationTitle(kpi.label)
  }
}
