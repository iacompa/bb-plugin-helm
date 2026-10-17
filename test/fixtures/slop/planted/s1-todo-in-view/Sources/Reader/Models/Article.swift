import Foundation

struct Article: Identifiable, Hashable, Codable {
    let id: UUID
    var title: String
    var author: String
    var body: String
    var publishedAt: Date
    var isSaved: Bool
}

@Observable
final class Library {
    var articles: [Article] = []

    func toggleSaved(_ article: Article) {
        guard let index = articles.firstIndex(of: article) else { return }
        articles[index].isSaved.toggle()
    }
}
