import Foundation
import Observation
import OrderedCollections

enum StoreError: LocalizedError {
    case unreadable(underlying: Error)
    case unwritable(underlying: Error)

    var errorDescription: String? {
        switch self {
        case .unreadable: String(localized: "error.load")
        case .unwritable: String(localized: "error.save")
        }
    }
}

@MainActor
@Observable
final class IntakeStore {
    static var defaultFileURL: URL {
        URL.applicationSupportDirectory.appending(path: "intake.json")
    }

    private(set) var byDay: OrderedDictionary<Date, [Intake]> = [:]
    private(set) var lastError: StoreError?
    var goal: DailyGoal = .standard

    private let fileURL: URL
    private let calendar: Calendar

    init(fileURL: URL, calendar: Calendar = .current) {
        self.fileURL = fileURL
        self.calendar = calendar
    }

    func load() async {
        do {
            let data = try Data(contentsOf: fileURL)
            let intakes = try JSONDecoder().decode([Intake].self, from: data)
            byDay = group(intakes)
        } catch CocoaError.fileReadNoSuchFile {
            // First launch: an empty history is the correct state, not an error.
            byDay = [:]
        } catch {
            lastError = .unreadable(underlying: error)
            Log.error("Could not read intake history: \(error.localizedDescription)")
        }
    }

    func log(_ millilitres: Int, at date: Date = .now) throws {
        let intake = Intake(millilitres: millilitres, loggedAt: date)
        let day = calendar.startOfDay(for: date)
        byDay[day, default: []].append(intake)
        try persist()
    }

    func total(on day: Date) -> Int {
        byDay[calendar.startOfDay(for: day)]?.reduce(0) { $0 + $1.millilitres } ?? 0
    }

    private func persist() throws {
        let all = byDay.values.flatMap { $0 }
        do {
            let data = try JSONEncoder().encode(all)
            try data.write(to: fileURL, options: [.atomic, .completeFileProtection])
        } catch {
            lastError = .unwritable(underlying: error)
            throw StoreError.unwritable(underlying: error)
        }
    }

    private func group(_ intakes: [Intake]) -> OrderedDictionary<Date, [Intake]> {
        var result: OrderedDictionary<Date, [Intake]> = [:]
        for intake in intakes.sorted(by: { $0.loggedAt < $1.loggedAt }) {
            result[calendar.startOfDay(for: intake.loggedAt), default: []].append(intake)
        }
        return result
    }
}
