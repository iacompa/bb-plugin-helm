import SwiftUI

struct TodayView: View {
    @Environment(IntakeStore.self) private var store
    @State private var errorMessage: String?

    private let amounts = [150, 250, 330, 500]

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                ProgressRing(progress: Double(store.total(on: .now)) / Double(store.goal.millilitres))
                    .frame(width: 180, height: 180)
                    .accessibilityLabel(Text("today.progress.accessibility \(store.total(on: .now))"))
                Text("today.total \(store.total(on: .now)) \(store.goal.millilitres)")
                    .font(.title2.monospacedDigit())
                HStack(spacing: 12) {
                    ForEach(amounts, id: \.self) { ml in
                        Button("\(ml) ml") { log(ml) }
                            .buttonStyle(.borderedProminent)
                    }
                }
            }
            .padding()
            .navigationTitle(Text("today.title"))
            .toolbar {
                NavigationLink(value: "history") { Label("history.title", systemImage: "calendar") }
            }
            .navigationDestination(for: String.self) { _ in HistoryView() }
            .alert(Text("error.title"), isPresented: .constant(errorMessage != nil)) {
                Button("common.ok") { errorMessage = nil }
            } message: {
                Text(errorMessage ?? "")
            }
        }
    }

    private func log(_ ml: Int) {
        do {
            try store.log(ml)
            Haptics.logged()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct ProgressRing: View {
    let progress: Double

    var body: some View {
        ZStack {
            Circle().stroke(.blue.opacity(0.15), lineWidth: 16)
            Circle()
                .trim(from: 0, to: min(progress, 1))
                .stroke(.blue, style: StrokeStyle(lineWidth: 16, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.snappy, value: progress)
        }
    }
}

#Preview {
    TodayView()
        .environment(IntakeStore.preview)
}
