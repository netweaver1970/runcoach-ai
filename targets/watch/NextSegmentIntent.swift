import AppIntents

// App Intents that the Ultra's ACTION BUTTON can trigger. To use: watch Settings → Action Button → Shortcut →
// pick "Next Segment" (or "Toggle Pause"). Pressing the orange button then runs it without opening the app,
// so you can advance intervals / pause mid-stride. Also available in the Shortcuts app + Siri.
struct NextSegmentIntent: AppIntent {
  static var title: LocalizedStringResource = "Next Segment"
  static var description = IntentDescription("Skip the RunCoach run to the next interval.")
  static var openAppWhenRun: Bool = false
  func perform() async throws -> some IntentResult {
    await MainActor.run { WorkoutEngine.shared.lap() }
    return .result()
  }
}

struct TogglePauseIntent: AppIntent {
  static var title: LocalizedStringResource = "Pause or Resume Run"
  static var description = IntentDescription("Pause or resume the current RunCoach run.")
  static var openAppWhenRun: Bool = false
  func perform() async throws -> some IntentResult {
    await MainActor.run { WorkoutEngine.shared.togglePause() }
    return .result()
  }
}

struct RunCoachShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(intent: NextSegmentIntent(), phrases: ["Next segment in \(.applicationName)"],
                shortTitle: "Next Segment", systemImageName: "forward.end.fill")
    AppShortcut(intent: TogglePauseIntent(), phrases: ["Pause \(.applicationName)"],
                shortTitle: "Pause / Resume", systemImageName: "playpause.fill")
  }
}
