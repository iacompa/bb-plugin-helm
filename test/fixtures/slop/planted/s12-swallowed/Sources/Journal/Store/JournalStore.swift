import Foundation
import SwiftData

@MainActor
final class JournalStore {
    private let context: ModelContext
    private let exportsDirectory: URL

    init(context: ModelContext, exportsDirectory: URL) {
        self.context = context
        self.exportsDirectory = exportsDirectory
    }

    func add(_ text: String) {
        context.insert(Entry(text: text))
        do {
            try context.save()
        } catch {
        }
    }

    func delete(_ entry: Entry) {
        context.delete(entry)
        try? context.save()
    }

    func export(_ entries: [Entry]) {
        let url = exportsDirectory.appending(path: "journal.txt")
        let body = entries.map { "\($0.createdAt.formatted()): \($0.text)" }.joined(separator: "\n")
        do {
            try body.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            // ignore
        }
    }
}
