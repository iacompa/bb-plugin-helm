import SwiftUI

@main
struct TideApp: App {
    @State private var store = IntakeStore(fileURL: IntakeStore.defaultFileURL)

    var body: some Scene {
        WindowGroup {
            TodayView()
                .environment(store)
                .task { await store.load() }
        }
    }
}
