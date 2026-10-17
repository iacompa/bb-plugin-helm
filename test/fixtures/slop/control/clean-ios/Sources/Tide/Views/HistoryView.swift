import SwiftUI

struct HistoryView: View {
    @Environment(IntakeStore.self) private var store

    var body: some View {
        Group {
            if store.byDay.isEmpty {
                ContentUnavailableView("history.empty.title", systemImage: "drop", description: Text("history.empty.body"))
            } else {
                List {
                    ForEach(store.byDay.keys.reversed(), id: \.self) { day in
                        Section(day.formatted(date: .abbreviated, time: .omitted)) {
                            ForEach(store.byDay[day] ?? []) { intake in
                                LabeledContent(intake.loggedAt.formatted(date: .omitted, time: .shortened), value: "\(intake.millilitres) ml")
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle(Text("history.title"))
    }
}
