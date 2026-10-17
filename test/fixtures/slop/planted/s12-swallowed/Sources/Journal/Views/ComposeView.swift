import SwiftUI

struct ComposeView: View {
    let store: JournalStore
    @State private var text = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            TextEditor(text: $text)
                .padding()
                .navigationTitle("New entry")
                .toolbar {
                    Button("Save") {
                        store.add(text)
                        dismiss()
                    }
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
        }
    }
}
