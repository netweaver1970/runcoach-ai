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

// Contiguous workout index ranges (±0.5) with their kind (1 = strength, 2 = cardio) — band + icon on the chart.
private func workoutRanges(_ series: [KPIPoint]) -> [(Double, Double, Int)] {
  var out: [(Double, Double, Int)] = []; var start: Int? = nil; var kind = 0
  for (i, p) in series.enumerated() {
    let k = p.w ?? 0
    if let s = start, k != kind { out.append((Double(s) - 0.5, Double(i - 1) + 0.5, kind)); start = nil }
    if k != 0 && start == nil { start = i; kind = k }
  }
  if let s = start { out.append((Double(s) - 0.5, Double(series.count - 1) + 0.5, kind)) }
  return out
}

// Time divisions for the x-axis (index positions + labels): day charts every 6 h ("0h" "6h" "12h" "18h"), multi-day
// charts at each Monday ("6 Oct"); a short multi-day series without a Monday gets its first + last date.
private func xTicks(_ kpi: KPI) -> [(Double, String)] {
  let s = kpi.series
  guard s.count > 1 else { return [] }
  let cal = Calendar.current
  let date = { (t: Double) in Date(timeIntervalSince1970: t / 1000) }
  if kpi.frame == "day" {
    var out: [(Double, String)] = []
    for i in 1..<s.count {
      let a = date(s[i - 1].t), b = date(s[i].t)
      let qa = cal.component(.hour, from: a) / 6, qb = cal.component(.hour, from: b) / 6
      if qa != qb || !cal.isDate(a, inSameDayAs: b) { out.append((Double(i) - 0.5, "\(qb * 6)h")) }
    }
    return out
  }
  let f = DateFormatter(); f.locale = Locale(identifier: "en_GB"); f.dateFormat = "d MMM"
  let marks = (kpi.marks ?? []).filter { $0 > 0 && $0 < s.count }
  if !marks.isEmpty { return marks.map { (Double($0) - 0.5, f.string(from: date(s[$0].t))) } }
  return [(0, f.string(from: date(s[0].t))), (Double(s.count - 1), f.string(from: date(s[s.count - 1].t)))]
}

// Tiny legend under a chart explaining the context annotations.
private func contextCaption(_ kpi: KPI) -> String? {
  if kpi.frame == "multi" { return (kpi.marks?.isEmpty == false) ? "┊ week (Mon)" : nil }
  let sleep = kpi.series.contains(where: { ($0.a ?? 0) == 1 }), work = kpi.series.contains(where: { ($0.w ?? 0) != 0 })
  if sleep && work { return "▓ asleep · ▓ workout" }
  if sleep { return "▓ asleep" }
  if work { return "▓ workout" }
  return nil
}

struct RouteDest: Hashable {}   // nav sentinel for the route/map screen

// ─── Root: hierarchical list of KPIs (tap one to open its graph) ───────────────
struct ContentView: View {
  @EnvironmentObject var store: KPIStore
  @ObservedObject var routeStore = RouteStore.shared
  @ObservedObject var engine = WorkoutEngine.shared
  @ObservedObject var strength = StrengthEngine.shared
  @Environment(\.scenePhase) private var scenePhase
  @State private var path = NavigationPath()

  var body: some View {
    NavigationStack(path: $path) {
      if store.payload?.kpis.isEmpty == false || routeStore.route != nil || strength.plan != nil || strength.orphan != nil {
        List {
          if let r = routeStore.route {
            NavigationLink(value: RouteDest()) {
              Label("\(r.name) · \(String(format: "%.1f", r.distanceKm)) km", systemImage: "map.fill")
                .foregroundColor(.pink)
            }
          }
          if strength.running || strength.plan != nil || strength.orphan != nil {
            NavigationLink(value: StrengthDest()) {
              Label(strength.running ? "Strength · in progress" : strength.orphan != nil ? "Strength · unfinished" : strengthRowTitle, systemImage: "dumbbell.fill")
                .foregroundColor(.green)
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
        .navigationDestination(for: RouteDest.self) { _ in RouteView() }
        .navigationDestination(for: StrengthDest.self) { _ in StrengthView() }
        .navigationDestination(for: StrengthRoutine.self) { RoutinePreview(r: $0) }
      } else {
        VStack(spacing: 6) {
          Image(systemName: "applewatch.radiowaves.left.and.right").font(.title2).foregroundColor(.secondary)
          Text("Open RunCoach AI on your iPhone to sync.").font(.footnote).foregroundColor(.secondary).multilineTextAlignment(.center)
        }.padding()
      }
    }
    // A turn cue fired → bring the map forward (replace the stack so we never stack duplicate map screens).
    .onChange(of: routeStore.jumpToMap) { path = NavigationPath([RouteDest()]) }
    // A run started, or the app was reopened mid-run → auto-show the map + follow (the watch backup).
    .onChange(of: engine.running) { if engine.running { path = NavigationPath([RouteDest()]) } }
    // A strength workout started (from the routine preview) or the app was reopened mid-workout → its screen.
    .onChange(of: strength.running) { if strength.running { path = NavigationPath([StrengthDest()]) } }
    .onChange(of: scenePhase) {
      if scenePhase == .active && engine.running { path = NavigationPath([RouteDest()]) }
      if scenePhase == .active && strength.running { path = NavigationPath([StrengthDest()]) }
      // Re-check Health access every time the app comes forward outside a run (.task only fires on first appear).
      if scenePhase == .active && !engine.running { Task { await engine.prepareAuth() } }
    }
    .onAppear {
      // Only (re)arm GPS if a run is ACTUALLY in progress (reopened mid-run). Having a route loaded is NOT
      // enough — tracking is tied to the run (WorkoutEngine.start/end), so opening the app with a route but
      // no active run must NOT turn the GPS on (battery). Pre-commit this started tracking on route-load.
      if engine.running { routeStore.start(); path = NavigationPath([RouteDest()]) }
    }
    // Recording problems (Health access missing / no heart rate / start or save failed) → ONE banner over every
    // screen, incl. the pushed run screen (RouteView lives inside this NavigationStack). Tap to acknowledge.
    .overlay(alignment: .top) { HealthIssueBanner(engine: engine) }
    // Ask for Health access as soon as the watch app opens — e.g. the first launch after a reinstall reset the
    // grant — instead of only when Start is tapped (where the sheet got missed on 2026-09-25).
    .task { await engine.prepareAuth() }
  }

  // "Strength · Push A" when a routine is planned today, else "Strength · 4 routines"
  private var strengthRowTitle: String {
    let rs = strength.plan?.routines ?? []
    let today = rs.filter { $0.today == true }
    if let t = today.first, strength.planIsToday { return "Strength · \(t.name)\(today.count > 1 ? " +\(today.count - 1)" : "")" }
    return "Strength · \(rs.count) routine\(rs.count == 1 ? "" : "s")"
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
        Chart(Array(kpi.series.enumerated()).filter { ($0.element.x ?? 0) == 0 }, id: \.offset) { i, pt in
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
          let vals = kpi.series.filter { ($0.x ?? 0) == 0 }.map(\.v)   // excluded workout points aren't on the line
          let fixed = ["stress", "battery", "recovery"].contains(kpi.key)
          let lo = fixed ? 0 : (vals.min() ?? 0)
          let hiRaw = fixed ? 100 : (vals.max() ?? 1)
          let hi0 = hiRaw > lo ? hiRaw : lo + 1
          // a little headroom on free-scaled charts so the line never sits on the frame edge
          let padY = fixed ? 0 : (hi0 - lo) * 0.08
          let yLo = lo - padY, hi = hi0 + padY
          let ticks = xTicks(kpi)
          // Value-coloured line (Bevel-style): high→low ramp mapped to the y-axis.
          let lineStyle = kpi.grad.map { LinearGradient(colors: $0.map { Color(hex: $0) }, startPoint: .top, endPoint: .bottom) }
            ?? LinearGradient(colors: [color, color], startPoint: .top, endPoint: .bottom)
          // Segment ids break the line at gaps (data holes / workouts); sleep ranges shade the night.
          let segs = segmentIds(kpi.series)
          let sleep = sleepRanges(kpi.series)
          let work = workoutRanges(kpi.series)
          Chart {
            // sections: sleep (moon) and workouts (dumbbell = strength, runner = cardio) — an icon on top, not just a tint
            ForEach(Array(sleep.enumerated()), id: \.offset) { _, r in
              RectangleMark(xStart: .value("s", r.0), xEnd: .value("e", r.1),
                            yStart: .value("lo", yLo), yEnd: .value("hi", hi))
                // bright enough to read on the watch's black (0.16 was near-invisible — Geert, 2026-10-08)
                .foregroundStyle(Color(hex: "818CF8").opacity(0.38))
                .annotation(position: .overlay, alignment: .top) {
                  Image(systemName: "moon.fill").font(.system(size: 10)).foregroundColor(Color(hex: "C7D2FE"))
                }
            }
            ForEach(Array(work.enumerated()), id: \.offset) { _, r in
              RectangleMark(xStart: .value("s", r.0), xEnd: .value("e", r.1),
                            yStart: .value("lo", yLo), yEnd: .value("hi", hi))
                .foregroundStyle(Color(hex: "FB923C").opacity(0.36))
                .annotation(position: .overlay, alignment: .top) {
                  // 1 strength → dumbbell, 2 cardio → runner, 3 yoga/flexibility/cooldown → shading only
                  if r.2 != 3 {
                    Image(systemName: r.2 == 1 ? "dumbbell.fill" : "figure.run").font(.system(size: 10)).foregroundColor(Color(hex: "FED7AA"))
                  }
                }
            }
            ForEach(Array(kpi.series.enumerated()).filter { ($0.element.x ?? 0) == 0 }, id: \.offset) { i, pt in
              AreaMark(x: .value("i", Double(i)), y: .value("v", pt.v), series: .value("seg", segs[i]))
                .foregroundStyle(LinearGradient(colors: [color.opacity(0.28), color.opacity(0.02)], startPoint: .top, endPoint: .bottom))
              LineMark(x: .value("i", Double(i)), y: .value("v", pt.v), series: .value("seg", segs[i]))
                .foregroundStyle(lineStyle).interpolationMethod(.monotone)
            }
          }
          .chartYScale(domain: yLo...hi)
          // time divisions: a visible dashed line + label at each 6 h (day) or Monday (multi-day)
          .chartXAxis {
            AxisMarks(values: ticks.map(\.0)) { v in
              AxisGridLine(stroke: StrokeStyle(lineWidth: 0.6, dash: [2, 2])).foregroundStyle(Color.white.opacity(0.35))
              AxisValueLabel(anchor: .top) {
                if let d = v.as(Double.self), let t = ticks.first(where: { abs($0.0 - d) < 0.01 }) {
                  Text(t.1).font(.system(size: 9)).foregroundColor(.secondary)
                }
              }
            }
          }
          .frame(height: 124)
          HStack {
            Text("low \(fmtVal(vals.min() ?? 0))").font(.system(size: 11)).foregroundColor(.secondary).lineLimit(1)
            Spacer(minLength: 2)
            if let ctx = contextCaption(kpi) { Text(ctx).font(.system(size: 10)).foregroundColor(.secondary).lineLimit(1).minimumScaleFactor(0.7) }
            Spacer(minLength: 2)
            Text("high \(fmtVal(vals.max() ?? 0))").font(.system(size: 11)).foregroundColor(.secondary).lineLimit(1)
          }
          .padding(.horizontal, 6)   // keep the labels clear of the rounded screen corners
        } else {
          Text("No history yet").font(.system(size: 12)).foregroundColor(.secondary).padding(.vertical, 8)
        }
        Text(relTime(kpi.series.last?.t)).font(.system(size: 11)).foregroundColor(.secondary).padding(.horizontal, 6)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 4)
    }
    .navigationTitle(kpi.label)
  }
}

// ─── Recording-problem banner (driven by WorkoutEngine.healthIssue) ───────────
struct HealthIssueBanner: View {
  @ObservedObject var engine: WorkoutEngine
  var body: some View {
    if !engine.healthIssue.isEmpty {
      Text("⚠️ " + engine.healthIssue)
        .font(.system(size: 12, weight: .semibold)).foregroundColor(.white)
        .multilineTextAlignment(.center).lineLimit(6).minimumScaleFactor(0.65)
        .padding(6).frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.red.opacity(0.92)))
        .padding(.horizontal, 4)
        .onTapGesture { engine.dismissIssue() }
        .accessibilityAddTraits(.isButton)
    }
  }
}
