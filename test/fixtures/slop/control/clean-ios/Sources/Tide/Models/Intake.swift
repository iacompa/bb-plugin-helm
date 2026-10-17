import Foundation

struct Intake: Identifiable, Codable, Hashable {
    let id: UUID
    var millilitres: Int
    var loggedAt: Date

    init(id: UUID = UUID(), millilitres: Int, loggedAt: Date = .now) {
        self.id = id
        self.millilitres = millilitres
        self.loggedAt = loggedAt
    }
}

struct DailyGoal: Codable, Equatable {
    var millilitres: Int

    /// Most adults are advised 2–2.5 litres a day from drinks; we start at the
    /// lower bound and let the person raise it rather than guilt them early.
    static let standard = DailyGoal(millilitres: 2_000)
}
