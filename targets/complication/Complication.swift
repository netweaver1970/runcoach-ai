import WidgetKit
import SwiftUI

private let APP_GROUP = "group.com.netweaver1970.runcoachai"

extension Color {
  init(hex: String) {
    let s = Scanner(string: hex.hasPrefix("#") ? String(hex.dropFirst()) : hex)
    var rgb: UInt64 = 0; s.scanHexInt64(&rgb)
    self.init(.sRGB, red: Double((rgb >> 16) & 0xFF) / 255, green: Double((rgb >> 8) & 0xFF) / 255, blue: Double(rgb & 0xFF) / 255)
  }
}

struct KPIEntry: TimelineEntry {
  let date: Date
  let value: Double
  let label: String
  let unit: String
  let color: Color
}

func readEntry() -> KPIEntry {
  let d = UserDefaults(suiteName: APP_GROUP)
  let v = d?.double(forKey: "selValue") ?? 0
  let label = d?.string(forKey: "selLabel") ?? "Stress"
  let unit = d?.string(forKey: "selUnit") ?? ""
  let color = Color(hex: d?.string(forKey: "selColor") ?? "#EF4444")
  return KPIEntry(date: Date(), value: v, label: label, unit: unit, color: color)
}

struct Provider: TimelineProvider {
  func placeholder(in: Context) -> KPIEntry { KPIEntry(date: Date(), value: 0, label: "Stress", unit: "", color: .red) }
  func getSnapshot(in: Context, completion: @escaping (KPIEntry) -> Void) { completion(readEntry()) }
  func getTimeline(in: Context, completion: @escaping (Timeline<KPIEntry>) -> Void) {
    // Refresh hourly; the watch app reloads the timeline whenever fresh data arrives.
    completion(Timeline(entries: [readEntry()], policy: .after(Date().addingTimeInterval(3600))))
  }
}

struct ComplicationView: View {
  @Environment(\.widgetFamily) var family
  let entry: KPIEntry
  private var valueStr: String { entry.value == entry.value.rounded() ? String(Int(entry.value)) : String(format: "%.1f", entry.value) }

  var body: some View {
    switch family {
    case .accessoryCircular:
      Gauge(value: max(0, min(100, entry.value)), in: 0...100) {
        Text(entry.label.prefix(3)).font(.system(size: 9))
      } currentValueLabel: {
        Text(valueStr).font(.system(size: 15, weight: .bold))
      }
      .gaugeStyle(.accessoryCircular)
      .tint(entry.color)
    case .accessoryInline:
      Text("\(entry.label) \(valueStr)\(entry.unit)")
    case .accessoryCorner:
      Text(valueStr).font(.system(size: 17, weight: .bold)).foregroundColor(entry.color)
        .widgetLabel(entry.label)
    default: // accessoryRectangular
      HStack {
        VStack(alignment: .leading) {
          Text(entry.label).font(.system(size: 11, weight: .semibold)).foregroundColor(.secondary)
          Text("\(valueStr)\(entry.unit)").font(.system(size: 22, weight: .bold)).foregroundColor(entry.color)
        }
        Spacer()
      }
    }
  }
}

@main
struct RunCoachComplication: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RunCoachComplication", provider: Provider()) { entry in
      ComplicationView(entry: entry)
    }
    .configurationDisplayName("RunCoach KPI")
    .description("Your chosen RunCoach metric on the watch face.")
    .supportedFamilies([.accessoryCircular, .accessoryInline, .accessoryCorner, .accessoryRectangular])
  }
}
