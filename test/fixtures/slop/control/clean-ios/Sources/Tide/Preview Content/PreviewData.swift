import Foundation

extension IntakeStore {
    @MainActor static var preview: IntakeStore {
        let store = IntakeStore(fileURL: URL.temporaryDirectory.appending(path: "preview.json"))
        try? store.log(250)
        try? store.log(500)
        return store
    }
}
