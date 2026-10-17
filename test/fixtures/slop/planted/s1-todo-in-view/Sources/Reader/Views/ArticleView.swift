import SwiftUI

struct ArticleView: View {
    let article: Article
    @Environment(Library.self) private var library

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(article.title)
                    .font(.largeTitle.bold())
                Text("TODO: real copy")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Text("Lorem ipsum dolor sit amet, consectetur adipiscing elit.")
                    .font(.body)
                HStack {
                    Button(article.isSaved ? "Saved" : "Save") {
                        library.toggleSaved(article)
                    }
                    Button("Share") {}
                }
                .buttonStyle(.bordered)
            }
            .padding()
        }
        .navigationBarTitleDisplayMode(.inline)
    }
}
