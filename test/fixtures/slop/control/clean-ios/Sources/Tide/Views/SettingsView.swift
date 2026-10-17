import SwiftUI

struct SettingsView: View {
    @Environment(IntakeStore.self) private var store
    @AppStorage("displayName") private var displayName = ""

    var body: some View {
        @Bindable var store = store
        Form {
            Section("settings.profile") {
                TextField("settings.name.placeholder", text: $displayName)
                    .textContentType(.givenName)
            }
            Section("settings.goal") {
                Stepper(value: $store.goal.millilitres, in: 1_000...4_000, step: 250) {
                    Text("\(store.goal.millilitres) ml")
                }
            }
        }
        .navigationTitle(Text("settings.title"))
    }
}
