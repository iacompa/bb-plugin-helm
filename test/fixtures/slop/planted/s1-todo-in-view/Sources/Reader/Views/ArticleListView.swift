import SwiftUI

struct ArticleListView: View {
    @Environment(Library.self) private var library

    var body: some View {
        NavigationStack {
            List(library.articles) { article in
                NavigationLink(value: article) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(article.title).font(.headline)
                        Text(article.author).font(.subheadline).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Reading list")
            .navigationDestination(for: Article.self) { article in
                ArticleView(article: article)
            }
        }
    }
}
