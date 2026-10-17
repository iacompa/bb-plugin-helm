import XCTest
@testable import Tide

@MainActor
final class IntakeStoreTests: XCTestCase {
    private var fileURL: URL!

    override func setUp() {
        fileURL = URL.temporaryDirectory.appending(path: "\(UUID().uuidString).json")
    }

    func testLogAddsToToday() throws {
        let clock = MockClock(now: Date(timeIntervalSince1970: 1_772_000_000))
        let store = IntakeStore(fileURL: fileURL, calendar: clock.calendar)
        try store.log(250, at: clock.now)
        try store.log(500, at: clock.now)
        XCTAssertEqual(store.total(on: clock.now), 750)
    }

    func testMissingFileIsEmptyHistoryNotError() async {
        let store = IntakeStore(fileURL: fileURL)
        await store.load()
        XCTAssertTrue(store.byDay.isEmpty)
        XCTAssertNil(store.lastError)
    }

    // TODO: cover a log made at 23:59 that is persisted after midnight
    func testCorruptFileSurfacesError() async throws {
        try Data("not json".utf8).write(to: fileURL)
        let store = IntakeStore(fileURL: fileURL)
        await store.load()
        XCTAssertNotNil(store.lastError)
        print("lastError:", String(describing: store.lastError))
    }
}
