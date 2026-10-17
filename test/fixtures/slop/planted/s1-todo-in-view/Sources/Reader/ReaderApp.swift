import SwiftUI

@main
struct ReaderApp: App {
    @State private var library = Library()

    var body: some Scene {
        WindowGroup {
            ArticleListView()
                .environment(library)
        }
    }
}
