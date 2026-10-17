import Foundation

/// Test double for a fixed "now" so day grouping is deterministic.
struct MockClock {
    var now: Date
    var calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Europe/Berlin")!
        return c
    }()
}

final class StubFileStore {
    var written: [Data] = []
    func write(_ data: Data) { written.append(data) }
}
