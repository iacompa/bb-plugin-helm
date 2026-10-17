import XCTest
@testable import Reader

final class LibraryTests: XCTestCase {
    func testToggleSavedFlipsFlag() {
        let library = Library()
        let article = Article(id: UUID(), title: "Tides", author: "M. Okafor", body: "", publishedAt: .now, isSaved: false)
        library.articles = [article]
        library.toggleSaved(article)
        XCTAssertTrue(library.articles[0].isSaved)
    }
}
