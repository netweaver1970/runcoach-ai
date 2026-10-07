import SwiftUI

struct StrengthDest: Hashable {}   // nav sentinel for the strength screens

// ─── Strength on the wrist: pick a routine → log set by set (kg/reps ±, ✓) → rest countdown → effort → save ──
struct StrengthView: View {
  @ObservedObject var eng = StrengthEngine.shared
  @State private var confirmDiscard = false

  var body: some View {
    Group {
      switch eng.phase {
      case .idle:      pickList
      case .lifting:   liftScreen
      case .resting:   restScreen
      case .finishing: finishScreen
      case .saving:    VStack(spacing: 8) { ProgressView(); Text("Saving…").font(.footnote) }
      case .done:      doneScreen
      }
    }
    .navigationTitle(eng.routine?.name ?? "Strength")
    .navigationBarBackButtonHidden(eng.running)   // mid-workout: stay here (End is on the workout screen)
  }

  private var issueText: some View {
    Group {
      if !eng.issue.isEmpty {
        Text("⚠️ " + eng.issue).font(.system(size: 11, weight: .semibold)).foregroundColor(.orange)
          .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
          .onTapGesture { eng.issue = "" }
      }
    }
  }

  // ── Routine list (today's first) ──
  private var pickList: some View {
    List {
      issueText
      if let o = eng.orphan {
        // the app was closed mid-workout: its sets are still here
        VStack(alignment: .leading, spacing: 4) {
          Text("Unfinished: \(o.name) · \(o.sets) sets").font(.system(size: 13, weight: .semibold))
          Button { eng.sendOrphan() } label: { Label("Send to iPhone", systemImage: "iphone") }.tint(.green)
          Button("Discard", role: .destructive) { eng.discardOrphan() }
        }
      }
      if let p = eng.plan {
        ForEach(p.routines) { r in
          NavigationLink(value: r) {
            VStack(alignment: .leading, spacing: 1) {
              HStack(spacing: 4) {
                Text(r.name).font(.system(size: 15, weight: .semibold))
                if r.today == true && eng.planIsToday { Text("TODAY").font(.system(size: 9, weight: .heavy)).foregroundColor(.green) }
              }
              Text("\(r.items.count) exercises · \(r.items.reduce(0) { $0 + $1.sets.count }) sets").font(.system(size: 11)).foregroundColor(.secondary)
            }
          }
        }
      } else {
        Text("Open Strength on your iPhone to send your routines.").font(.footnote).foregroundColor(.secondary)
      }
    }
  }

  // ── One set: exercise, set n/N, kg ±, reps ±, ✓ ──
  private var liftScreen: some View {
    ScrollView {
      VStack(spacing: 5) {
        statLine
        issueText
        if let it = eng.item {
          Text(it.name).font(.system(size: 16, weight: .bold)).multilineTextAlignment(.center).lineLimit(2).minimumScaleFactor(0.7)
          let n = it.sets.count, k = eng.setIdx + 1
          Text(k > n ? "Extra set \(k) · \(it.lo)–\(it.hi) reps" : "Set \(k) of \(n) · \(it.lo)–\(it.hi) reps")
            .font(.system(size: 11)).foregroundColor(.secondary)
          stepper(label: (it.bw ?? false) ? "BW \(eng.kg >= 0 ? "+" : "−")\(fmtKg(abs(eng.kg))) kg" : "\(fmtKg(eng.kg)) kg",
                  minus: { eng.stepKg(-1) }, plus: { eng.stepKg(1) })
          stepper(label: "\(eng.reps) reps", minus: { eng.stepReps(-1) }, plus: { eng.stepReps(1) })
          Button { eng.doneSet() } label: { Label("Done", systemImage: "checkmark").font(.system(size: 17, weight: .bold)).frame(maxWidth: .infinity) }
            .tint(.green).disabled(eng.reps == 0)
          HStack(spacing: 6) {
            Button { eng.moveExercise(-1) } label: { Image(systemName: "chevron.left") }
            Button { eng.undoLast() } label: { Image(systemName: "arrow.uturn.backward") }.disabled(eng.logged.isEmpty)
            Button { eng.moveExercise(1) } label: { Image(systemName: "chevron.right") }
            Button(role: .destructive) { eng.askFinish() } label: { Image(systemName: "stop.fill") }
          }
          .font(.system(size: 13)).buttonStyle(.bordered)
        }
      }
    }
  }

  private func stepper(label: String, minus: @escaping () -> Void, plus: @escaping () -> Void) -> some View {
    HStack(spacing: 4) {
      Button(action: minus) { Image(systemName: "minus") }.frame(width: 44)
      Text(label).font(.system(size: 18, weight: .semibold, design: .rounded)).monospacedDigit()
        .lineLimit(1).minimumScaleFactor(0.6).frame(maxWidth: .infinity)
      Button(action: plus) { Image(systemName: "plus") }.frame(width: 44)
    }
    .buttonStyle(.bordered)
  }

  private var statLine: some View {
    HStack(spacing: 8) {
      Label(eng.heartRate > 0 ? "\(Int(eng.heartRate))" : "--", systemImage: "heart.fill").foregroundColor(.red)
      Text(clock(eng.elapsed)).foregroundColor(.yellow)
      Text("\(Int(eng.kcal)) kcal").foregroundColor(.secondary)
    }
    .font(.system(size: 12, weight: .semibold)).monospacedDigit().labelStyle(.titleAndIcon)
  }

  // ── Rest countdown + what's next ──
  private var restScreen: some View {
    ScrollView {
      VStack(spacing: 6) {
        Text("REST").font(.system(size: 11, weight: .heavy)).foregroundColor(.secondary)
        Text(clock(TimeInterval(eng.restLeft))).font(.system(size: 44, weight: .bold, design: .rounded)).monospacedDigit()
          .foregroundColor(eng.restLeft <= 10 ? .green : .orange)
        if let it = eng.item {
          Text("Next: \(it.name)").font(.system(size: 13, weight: .semibold)).lineLimit(2).multilineTextAlignment(.center)
          Text("Set \(eng.setIdx + 1) · \((it.bw ?? false) ? "BW \(eng.kg >= 0 ? "+" : "−")\(fmtKg(abs(eng.kg)))" : fmtKg(eng.kg)) kg × \(eng.reps)")
            .font(.system(size: 12)).foregroundColor(.secondary)
        }
        HStack(spacing: 6) {
          Button("+15 s") { eng.addRest(15) }
          Button { eng.skipRest() } label: { Label("Skip", systemImage: "forward.fill") }.tint(.green)
        }
        .font(.system(size: 13, weight: .semibold)).buttonStyle(.bordered)
        statLine
      }
    }
  }

  // ── Effort + save ──
  private var finishScreen: some View {
    ScrollView {
      VStack(spacing: 6) {
        issueText
        Text("\(eng.logged.count) of \(eng.totalPlannedSets) sets · \(Int(eng.elapsed / 60)) min").font(.system(size: 13, weight: .semibold))
        Text("How hard was it? (RPE)").font(.system(size: 11)).foregroundColor(.secondary)
        stepper(label: "\(eng.rpe) / 10", minus: { eng.rpe = max(1, eng.rpe - 1) }, plus: { eng.rpe = min(10, eng.rpe + 1) })
        Button { eng.save() } label: { Label("Save", systemImage: "square.and.arrow.down").frame(maxWidth: .infinity) }
          .tint(.green).disabled(eng.logged.isEmpty)
        if eng.canResume { Button("Back to workout") { eng.backToWorkout() } }
        Button("Discard", role: .destructive) { confirmDiscard = true }
      }
    }
    .confirmationDialog("Discard this workout? Nothing is saved.", isPresented: $confirmDiscard) {
      Button("Discard", role: .destructive) { eng.discard() }
      Button("Cancel", role: .cancel) { }
    }
  }

  private var doneScreen: some View {
    VStack(spacing: 8) {
      Image(systemName: "checkmark.circle.fill").font(.system(size: 34)).foregroundColor(.green)
      Text(eng.doneNote).font(.system(size: 13)).multilineTextAlignment(.center)
      issueText
      Button("Done") { eng.finishDone() }
    }
  }

  private func clock(_ t: TimeInterval) -> String {
    let s = max(0, Int(t))
    return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
  }
}

// ── Routine preview → Start (a tap on the list never starts a workout by itself) ──
struct RoutinePreview: View {
  let r: StrengthRoutine
  @ObservedObject var eng = StrengthEngine.shared
  var body: some View {
    List {
      if !eng.issue.isEmpty {
        Text("⚠️ " + eng.issue).font(.system(size: 11, weight: .semibold)).foregroundColor(.orange)
      }
      Button { eng.start(r) } label: { Label("Start", systemImage: "dumbbell.fill").font(.system(size: 16, weight: .bold)) }
        .listItemTint(.green)
      ForEach(Array(r.items.enumerated()), id: \.offset) { _, it in
        VStack(alignment: .leading, spacing: 1) {
          Text(it.name).font(.system(size: 14, weight: .semibold))
          let kg = it.sets.first?.kg ?? 0
          Text("\(it.sets.count) × \(it.lo)–\(it.hi) · \((it.bw ?? false) ? "BW \(kg >= 0 ? "+" : "−")\(fmtKg(abs(kg)))" : fmtKg(kg)) kg · rest \(Int(min(it.rest, 3600))) s")
            .font(.system(size: 11)).foregroundColor(.secondary)
        }
      }
    }
    .navigationTitle(r.name)
  }
}
