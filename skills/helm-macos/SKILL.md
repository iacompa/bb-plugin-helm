---
name: helm-macos
description: macOS craft (SwiftUI with AppKit, menus, keyboard, sandbox, signing, notarization, headless xcodebuild tests). Use when you are a Helm macOS builder.
---

# Helm macOS craft

This skill covers what good macOS work looks like; your protocol skill covers how you work inside Helm. The goal is an app a long-time Mac user would call native: resizable windows, every command in the menu bar with the expected shortcut, full keyboard and VoiceOver support, restored windows, and a sandboxed, signed, notarizable build. A stretched iPhone layout fails, even with green tests.

Two rules run through everything below:

1. **Verify every API against the installed SDK before you rely on it.** Models mix up iOS and macOS APIs, invent modifiers, and reach for patterns that were deprecated years ago. The section "Verifying APIs" explains how to check.
2. **Core owns behavior; you own the Mac experience.** Call Core through the interface CONTRACT.md defines. View models adapt Core to SwiftUI. They hold no business rules of their own.

---

## 1. Project setup

### Toolchain facts to establish first

Run these commands and record the output in your notes. Never assume versions from memory.

```sh
sw_vers                       # host macOS
xcodebuild -version           # Xcode and build number
swift --version               # Swift compiler
xcodebuild -showsdks | grep macosx
```

**Deployment target.** Use the target the brief or CONTRACT.md specifies. If neither specifies one, target the previous major macOS release so the app reaches most users, and gate newer APIs with `if #available(macOS NN, *)`. Write the decision into the project's xcconfig, not just the target settings, so the CLI and the IDE agree.

### Creating the project headlessly

You cannot click through Xcode's New Project sheet. Pick one of these approaches and record the choice:

- **XcodeGen (preferred when installed; check with `which xcodegen`).** Commit `apps/mac/project.yml`, generate with `xcodegen generate`, and commit the generated `.xcodeproj` too, so anyone can build without the tool. Regenerate after every structural change, and never hand-edit the generated project.
- **An existing `.xcodeproj` with synchronized folders.** Recent Xcode versions use folder references, so adding or removing a file inside a synchronized folder doesn't touch `project.pbxproj`. That nearly eliminates merge conflicts. Keep each folder's files in a single target.
- **A Swift package only.** SwiftPM executables don't produce a proper `.app` bundle with an Info.plist, entitlements, asset catalog, and app icon. That works for Core or a utility library. It's wrong for the app you ship.

Move build settings into `.xcconfig` files (`Config/Base.xcconfig`, `Debug.xcconfig`, `Release.xcconfig`) so they're reviewable in diffs. Set at least these: `MACOSX_DEPLOYMENT_TARGET`, `SWIFT_VERSION = 6`, `SWIFT_STRICT_CONCURRENCY = complete`, `ENABLE_HARDENED_RUNTIME = YES`, `CODE_SIGN_ENTITLEMENTS`, `PRODUCT_BUNDLE_IDENTIFIER`, `MARKETING_VERSION`, `CURRENT_PROJECT_VERSION`, and `INFOPLIST_KEY_LSApplicationCategoryType`. New Xcode app templates default some targets to main-actor isolation. Set the default actor isolation explicitly so behavior doesn't depend on which template created the target.

### Suggested layout

```
apps/mac/
  project.yml                 # if using XcodeGen
  App.xcodeproj/
  Config/*.xcconfig
  App/
    AppMain.swift             # @main App, scenes, commands wiring
    AppDelegate.swift         # only if NSApplicationDelegateAdaptor is needed
    Model/                    # @Observable adapters over Core
    Features/<Feature>/       # views + feature-local state
    Commands/                 # Commands types, FocusedValues keys
    Platform/                 # AppKit bridges (NSViewRepresentable, panels)
    Resources/Assets.xcassets, Localizable.xcstrings
    App.entitlements
  Tests/Unit/                 # Swift Testing
  Tests/UI/                   # XCUITest
  scripts/build.sh test.sh release.sh
  docs/evidence/
```

**Signing for local builds.** Use ad hoc signing (`CODE_SIGN_IDENTITY=-`) for Debug and for tests. Keep `CODE_SIGNING_ALLOWED=NO` for compile-only checks: an unsigned app carries no entitlements, so it never exercises the sandbox.

---

## 2. Architecture

- **Scenes are the top level.** The `App` body declares every window type: `WindowGroup` for the main or document windows, `Window(id:)` for single-instance windows such as an activity log, `UtilityWindow` for floating panels on macOS 15 and later, `Settings`, and `MenuBarExtra` when the brief calls for one. If the app edits files, use `DocumentGroup`. That gives you Open Recent, autosave, versions, and the proxy icon for free. The file format belongs to Core.
- **State.** App-wide state lives in `@Observable` classes owned with `@State` at the `App` level and passed down with `.environment(...)`. Per-window state, such as selection, sidebar visibility, and the inspector toggle, lives in the window's view tree, using `@SceneStorage` for anything that should survive relaunch. Never put "the selected item" in a global singleton. With two windows open, they'll fight over it.
- **Use Observation, not Combine-era wrappers.** For new code, use `@Observable` with `@State`, `@Bindable`, and `@Environment(Type.self)`. `ObservableObject`, `@Published`, and `@StateObject` still compile, but they re-render more than necessary and mark the code as dated.
- **Core adapter.** Write one protocol, such as `CoreClient`, that mirrors the CONTRACT.md surface, plus a live implementation that calls Core and a fake for previews and tests. View models translate Core results into view state. They never re-validate, re-compute, or re-store anything Core already owns.
- **Concurrency.** Mark UI types `@MainActor`. Start async Core work with `.task` or `.task(id:)` so it cancels when the view disappears. Keep heavy work off the main actor, either inside Core's async API or in a nonisolated or `@concurrent` function. Fix Swift 6 data-race diagnostics properly. Adding `@unchecked Sendable` or `nonisolated(unsafe)` to silence the compiler is a defect unless you document the invariant that makes it safe.
- **Use AppKit only where SwiftUI falls short.** Reach for `NSViewRepresentable` or `NSViewControllerRepresentable` with a `Coordinator` for things like rich `NSTextView` editing, very large `NSOutlineView` trees, or precise first-responder control. Use `@NSApplicationDelegateAdaptor` for lifecycle hooks: the Dock menu, reopen behavior, and the last-window-closed policy. Before you grab the `NSWindow` through a view hack, check whether a scene modifier already does the job: `windowStyle`, `windowToolbarStyle`, `windowResizability`, `defaultSize`, `defaultWindowPlacement`, `windowLevel`, or `windowManagerRole`. Keep every bridge in `Platform/` with a comment explaining why SwiftUI couldn't do it.

---

## 3. Making it feel like a Mac app

### Windows and layout

- Windows resize freely. Set minimum sizes on content (`frame(minWidth:minHeight:)`) and pair them with `.windowResizability(.contentMinSize)`. Choose a sensible `defaultSize`. Layout must stay coherent from the minimum size up to a full-screen 6K display.
- Use `NavigationSplitView` for the sidebar, content, and detail columns, with `navigationSplitViewColumnWidth` to set sensible column widths, and `.inspector(isPresented:)` for a trailing inspector. Don't build primary navigation as a phone-style push stack with back buttons.
- Use `Table` for tabular data. Give it sortable columns (`sortOrder` binding), multiple selection (a `Set` of IDs), and `contextMenu(forSelectionType:menu:primaryAction:)`, so a double-click or Return opens an item and right-clicking acts on the whole selection.
- Keep densities at Mac scale: standard control sizes, system text styles (`.body`, `.headline`, `.caption`), and no oversized touch padding. Fixed point sizes ignore user text settings.
- Use the presentation that matches the job. A popover holds lightweight contextual controls. A sheet attached to its window handles a focused sub-task. Alerts and confirmation dialogs cover destructive or blocking choices. A separate window suits anything the user wants open alongside the main one. Never use full-screen modal takeovers.

### Toolbar, search, and Liquid Glass

- Put window-level actions in `.toolbar` with semantic placements, and add `.searchable` so search lands in the toolbar where Mac users expect it. For user-customizable toolbars, use `.toolbar(id:)` with identified items.
- On macOS 26 and later, standard bars, sidebars, sheets, popovers, and controls adopt the Liquid Glass material automatically. Remove custom backgrounds from toolbars, split views, and sidebars so they don't fight the system material or the scroll-edge effect. Group related toolbar items, and separate groups with `ToolbarSpacer`. Hide a toolbar item by hiding the item itself, not its contents. Otherwise you get an empty glass capsule.
- Use custom `glassEffect` rarely, and only on the most important custom controls. Group several of them in a `GlassEffectContainer`. Use `backgroundExtensionEffect()` for hero content that should appear to extend under a sidebar. Test with Reduce Transparency and Increase Contrast turned on.
- The Info.plist key that keeps the pre-Liquid Glass look is a temporary migration aid. Don't use it to dodge design work in a new app.

### Interaction details Mac users notice

- **Right-click everywhere.** Every item that can be selected has a context menu, and its actions match the menu bar and toolbar.
- **Hover.** Add `.help("…")` tooltips to icon-only controls, and use hover states where they aid discovery.
- **Drag and drop.** Use `draggable` and `dropDestination` with `Transferable` types, both within the app and to and from Finder when the data model allows it.
- **Undo and redo.** Read `@Environment(\.undoManager)` and register undo for every user mutation. When Core owns history, route undo through Core's API instead.
- **Keys.** Delete triggers `onDeleteCommand`. Escape triggers `onExitCommand` or the cancel action. Return triggers the default button (`.keyboardShortcut(.defaultAction)`). Use `.keyboardShortcut(.cancelAction)` on Cancel.
- **Copy and paste.** Support copy and paste on selections (`copyable`, `pasteDestination`, or the command-group equivalents).
- **Appearance.** Use semantic colors and materials, an accent color from the asset catalog, and SF Symbols. Never hard-code white backgrounds or black text. Check every screen in both light and dark mode.

---

## 4. Menu bar, commands, and keyboard shortcuts

The menu bar is the Mac's command index. A feature that exists only as a button is half-finished.

- Attach commands with `.commands { ... }` on the main scene. Include the stock groups that apply: `SidebarCommands()`, `ToolbarCommands()`, `TextEditingCommands()`, `TextFormattingCommands()`, and `InspectorCommands()`.
- Adjust standard menus with `CommandGroup(replacing:)`, `CommandGroup(before:)`, and `CommandGroup(after:)` and the standard placements (`.newItem`, `.saveItem`, `.pasteboard`, `.sidebar`, `.help`, and so on). Add app-specific menus with `CommandMenu("Name")`. Don't duplicate items the system already provides, such as About, Hide, Quit, Settings, and Window management.
- **Commands act on the focused window.** Publish actions or models from the window with `.focusedSceneValue(\.key, value)`, or with `.focusedValue` for focus-specific values, and read them in the command with `@FocusedValue(\.key)`. Declare the keys with `extension FocusedValues { @Entry var key: T? }`. Disable the command when the value is `nil`. A command that silently does nothing is a bug.
- **Shortcuts.** Use `.keyboardShortcut` with the conventional bindings: ⌘N new, ⌘O open, ⌘S save, ⇧⌘S save as, ⌘W close, ⌘F find, ⌘Z and ⇧⌘Z undo and redo, ⌘⌫ delete item, ⌘R refresh where it makes sense, ⌃⌘S to toggle the sidebar (stock), and ⌥⌘I or ⌃⌘I for the inspector. The Settings scene supplies ⌘, automatically. Never rebind system-reserved shortcuts (⌘Q, ⌘H, ⌘Tab, ⌘Space, ⌘`). Check for collisions before adding custom shortcuts. Document the full shortcut map in your evidence.
- **Focus.** Use `@FocusState` with `.focused(...)`, give custom interactive views `.focusable()`, and handle custom keys with `onKeyPress`. Everything must work with Full Keyboard Access turned on in System Settings.

### Multiple windows

- Use `WindowGroup(for: Item.ID.self) { $id in ... }` together with `@Environment(\.openWindow)` and `openWindow(value: id)`. Opening a value that already has a window brings that window forward instead of creating a duplicate. Pass IDs, not whole models, because the value must be `Codable` and `Hashable` for restoration.
- Each window owns independent state. Test with three windows open on different items, then close them in different orders.
- Decide the last-window policy deliberately. Single-window utilities quit when the window closes (`applicationShouldTerminateAfterLastWindowClosed` returns `true`). Document-based and multi-window apps stay running.

### Settings scene

- Use `Settings { SettingsView() }` with a `TabView` of `Tab("General", systemImage: "gear") { ... }` panes. Each pane is a `Form` with `.formStyle(.grouped)` and `@AppStorage` bindings, unless Core owns the setting. In that case, read and write through Core. Keep the window compact and fixed-width.
- To open Settings from your own UI, use `SettingsLink` or the `openSettings` environment action (macOS 14 and later). The old `showSettingsWindow:` and `showPreferencesWindow:` selector tricks stop working on macOS 14. Community reports say `openSettings` needs a live SwiftUI view hierarchy and is unreliable from a menu-bar-only app. If the brief has a menu-bar-only app with Settings, test that path on the host OS and record the result.

### Window state restoration

- SwiftUI restores open windows, their frames, and `@SceneStorage` values automatically, following the user's system setting. Make restoration correct by storing selection and navigation state as `@SceneStorage` keys or Codable IDs. Never store live objects.
- Use `.restorationBehavior(.disabled)` (macOS 15 and later) for transient windows such as onboarding or diagnostics. Use `.defaultLaunchBehavior(...)` to control which windows appear at launch, and `defaultWindowPlacement` or `defaultPosition` for first-launch placement that respects the display's visible frame.
- **Test restoration.** Open two windows on different items, resize them, quit with ⌘Q, relaunch, and confirm the windows, sizes, and selections came back. For UI tests that need a clean slate, launch with `-ApplePersistenceIgnoreState YES`.

### Menu bar extras

Use `MenuBarExtra("Name", systemImage: "…") { ... }` for menu-style extras and `.menuBarExtraStyle(.window)` for rich popover-like panels. For a menu-bar-only app, set `LSUIElement` to `true` so the app has no Dock icon. The `isInserted:` initializer lets users hide the extra. Remember that removing the extra terminates a menu-bar-only app.

---

## 5. System integration

Integrate only what the brief or CONTRACT.md asks for, and do it with current APIs:

- **Files.** Use `fileImporter` and `fileExporter`, or `DocumentGroup`. Declare exported and imported `UTType`s in the Info.plist for any custom format. Under the sandbox, persist access to user-chosen locations with security-scoped bookmarks (`bookmarkData(options: .withSecurityScope)` and `startAccessingSecurityScopedResource()`), and always balance them with `stopAccessing...`.
- **URLs and activation.** Use `onOpenURL` and `handlesExternalEvents(matching:)` to route a URL to the right window, and register URL schemes in the Info.plist.
- **Notifications.** Use the UserNotifications framework. Ask for permission at the moment the value is obvious to the user, not at launch.
- **Launch at login.** Use `SMAppService.mainApp.register()`. Older login-item APIs are deprecated.
- **Secrets.** Store credentials and tokens in the Keychain (`SecItem*`), never in `UserDefaults`, `@AppStorage`, or files.
- **Sharing.** Use `ShareLink` for the system share menu. Use App Intents only when Shortcuts or Spotlight integration is in scope.
- **Dock and logging.** Use `NSApp.dockTile.badgeLabel` and `applicationDockMenu(_:)` via the delegate adaptor. Log with `os.Logger`, never `print`, marking private data `privacy: .private`.

---

## 6. Packaging, sandbox, hardened runtime, notarization

### Minimal entitlements

Turn on App Sandbox (`com.apple.security.app-sandbox`) from the start. Retrofitting it later surfaces file-access bugs all at once. Then add only what a feature needs, and justify each key in your report:

| Need | Entitlement |
|---|---|
| Core calls a network service | `com.apple.security.network.client` |
| App listens on a socket | `com.apple.security.network.server` (rare; question it) |
| Open and save documents the user picks | `com.apple.security.files.user-selected.read-write` (or `read-only`) |
| Downloads folder | `com.apple.security.files.downloads.read-write` |
| Camera or microphone | `com.apple.security.device.camera` / `device.audio-input`, plus a usage string in the Info.plist |
| Printing | `com.apple.security.print` |

Every protected resource needs its usage-description key in the Info.plist, or the app crashes or is silently denied. Treat any temporary-exception entitlement, `cs.disable-library-validation`, `cs.allow-jit`, `cs.allow-unsigned-executable-memory`, or `cs.allow-dyld-environment-variables` as an escalation, not a quick fix. If a hardened-runtime exception seems necessary, record exactly which component needs it and why.

Verify what actually shipped:

```sh
codesign -d --entitlements - --xml "build/.../App.app" | plutil -p -
codesign --verify --deep --strict --verbose=2 "build/.../App.app"
```

### Release pipeline (script it; never commit secrets)

Write `scripts/release.sh` to run these steps:

1. `xcodebuild archive -scheme App -configuration Release -archivePath build/App.xcarchive`
2. `xcodebuild -exportArchive -archivePath build/App.xcarchive -exportOptionsPlist Config/ExportOptions.plist -exportPath build/export`, with `method` set to `developer-id` for direct distribution. The team ID isn't secret. Certificates and keys are.
3. `ditto -c -k --keepParent build/export/App.app build/App.zip`. The notary service accepts zip, dmg, and pkg files, but not a bare `.app`.
4. `xcrun notarytool submit build/App.zip --key "$NOTARY_KEY_PATH" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER_ID" --wait`. An App Store Connect API key passed by file path from a CI secret is the most robust choice for automation. Keychain profiles (`--keychain-profile`) break when CI runs as a different user. Always fetch and keep the log with `notarytool log <id> ...`, even when the submission succeeds.
5. `xcrun stapler staple build/export/App.app`. You can't staple to a zip, so staple the app and then re-zip it, or staple a dmg.
6. `spctl --assess --type execute -vv build/export/App.app` to check that Gatekeeper accepts it.

Never generate `altool` (the notary service dropped it). Gitignore `*.p8`, `*.p12`, `*.cer`, and provisioning profiles. Read credentials only from environment variables or CI secrets, failing clearly when they're missing. Without a Developer ID identity, ship the script, prove the ad hoc path works, and report "notarization not executed: no credentials".

---

## 7. Accessibility

- **VoiceOver names.** Every control has a meaningful name. Give icon-only buttons a real label: `Button("Add Item", systemImage: "plus") { ... }` with `.labelStyle(.iconOnly)` keeps the spoken name. Bare `Image` buttons don't. Use `accessibilityLabel`, `accessibilityValue`, and `accessibilityHint` where the visible text isn't enough. Mark decorative images `accessibilityHidden(true)`.
- **Structure.** Use `accessibilityElement(children: .combine)` for list rows that read as one item, `accessibilityAddTraits(.isHeader)` for section titles, `accessibilityAction(named:)` for actions otherwise reachable only by hover or drag, and `accessibilitySortPriority` when reading order is wrong.
- **Keyboard.** With Full Keyboard Access on, Tab reaches every control, and focus rings stay visible. Don't disable focus effects unless you draw an equivalent.
- **Settings.** Respect the accessibility environment values: Reduce Motion (`accessibilityReduceMotion`) replaces animations with fades or nothing, Reduce Transparency removes translucency in custom surfaces, and Increase Contrast (`colorSchemeContrast`) needs sufficient contrast. Don't rely on color alone to carry meaning.
- **Identifiers.** Give elements that UI tests target an `accessibilityIdentifier`. Never select elements by their localized label.
- **Automated audit.** In an XCUITest, call `try app.performAccessibilityAudit()`, available on macOS 14 and later. Fix the issues it reports, or justify each one with the issue handler. Also do a manual pass with Accessibility Inspector (Xcode → Open Developer Tool) and VoiceOver (⌘F5) across the main flow.
- **Localization.** Put user-facing strings in a String Catalog (`Localizable.xcstrings`). Use `Text("key")` literals and `String(localized:)`, never concatenate localized fragments, and format numbers and dates with `FormatStyle`.

---

## 8. Performance

- **Launch.** Do no synchronous Core or disk work in `App.init` or scene construction. Show the window immediately and load content in `.task`.
- **Lists and identity.** `List`, `Table`, and `LazyVStack` load lazily, but only with stable identity. Use `Identifiable` with persistent IDs. Never use `id: \.self` on mutable values, and never create a `UUID()` during render.
- **Invalidation.** `@Observable` tracks reads per property. Keep view bodies small, pass the narrowest data each view needs, and keep expensive formatting or filtering out of `body`. Cache derived data in the model when it's costly. Avoid `GeometryReader`-driven layouts when stacks, grids, or `ViewThatFits` will do.
- **Main thread.** Run the main flow and look for hangs in Xcode's diagnostics. Anything Core does that's slow belongs behind an async boundary.
- **Measure headlessly.** Profile with `xcrun xctrace record --template 'Time Profiler' --launch -- <path to app binary>`. Use `leaks --atExit -- <binary>` for a quick leak check, and `os_signpost` intervals around Core calls. Put the numbers in your report, not adjectives.
- **Energy.** Don't run polling timers. Prefer notifications and async sequences from Core, and pause work in hidden windows.

---

## 9. Headless build and test

Wrap these commands in `scripts/build.sh` and `scripts/test.sh` so every agent runs the same thing. Always run them with `set -euo pipefail` so a failing `xcodebuild` isn't hidden behind a pipe.

```sh
cd apps/mac
xcodebuild -list -project App.xcodeproj

# Build (ad hoc signed so entitlements apply)
xcodebuild -project App.xcodeproj -scheme App -configuration Debug \
  -destination 'platform=macOS' -derivedDataPath build/DD \
  CODE_SIGN_IDENTITY=- build

# Unit tests (Swift Testing + XCTest), result bundle for evidence
xcodebuild test -project App.xcodeproj -scheme App \
  -destination 'platform=macOS' -derivedDataPath build/DD \
  -resultBundlePath build/Unit.xcresult -only-testing:UnitTests \
  -skipMacroValidation -skipPackagePluginValidation

# Summarize results for the report
xcrun xcresulttool get test-results summary --path build/Unit.xcresult
xcrun xcresulttool get test-results tests   --path build/Unit.xcresult
```

- Write unit tests with Swift Testing (`import Testing`, `@Test`, `#expect`, `#require`, and parameterized arguments). Test view models against the fake `CoreClient`, plus command enablement, restoration encoding, and formatting. UI tests stay in XCTest/XCUIAutomation.
- **UI tests** need a logged-in GUI session, and the runner may need Accessibility or Automation permission. Put them in a separate test plan or target so unit tests always run headlessly. If the environment can't run them, report "UI tests written, not executed: no GUI session" rather than marking them passed.
- Macro and plugin validation prompts stall non-interactive builds. The `-skip…Validation` flags above avoid that. Review any new macro or plugin dependency yourself.
- Delete old result bundles first; `xcodebuild` won't overwrite them.
- Running the app (`open`, `screencapture`) may be blocked by the agent sandbox or Screen Recording permission. If so, say so, and give the exact command for a human to run.

---

## 10. Verifying APIs (do this every time)

1. **Search the installed SDK.** Many symbols live in `SwiftUICore`, not `SwiftUI`, so search both:
   ```sh
   SDK=$(xcrun --sdk macosx --show-sdk-path)
   grep -n "func windowResizability" \
     "$SDK"/System/Library/Frameworks/SwiftUI.framework/Modules/SwiftUI.swiftmodule/arm64e-apple-macos.swiftinterface \
     "$SDK"/System/Library/Frameworks/SwiftUICore.framework/Modules/SwiftUICore.swiftmodule/arm64e-apple-macos.swiftinterface
   ```
   If a symbol isn't there, it doesn't exist. Find the real one. Check the `@available` annotations against your deployment target, and watch for `unavailable` on macOS.
2. **Check Apple's documentation.** Apple's doc pages render as Markdown with an availability block when you append `.md` to the URL, for example `developer.apple.com/documentation/swiftui/settings.md`.
3. **Compile.** A clean build at the real deployment target with no new warnings is the final check. Treat deprecation warnings as failures to fix.

### Common mistakes and their replacements

| Wrong (iOS-only, deprecated, or invented) | Use instead |
|---|---|
| `UIColor`, `UIApplication`, `UIScreen`, `UIDevice`, `UIImpactFeedbackGenerator` | `NSColor` and SwiftUI `Color`, `NSApplication`, `NSScreen` or scene APIs, nothing (no haptics) |
| `.navigationBarTitleDisplayMode`, `.navigationBarItems`, `EditButton`, `.fullScreenCover`, `.keyboardType`, `.textInputAutocapitalization`, `.listStyle(.insetGrouped)` | These are unavailable on macOS. Use `.navigationTitle` and `.navigationSubtitle`, toolbar items, selection plus Delete, sheets or windows, and `.listStyle(.sidebar)`, `.inset`, or `.bordered` |
| `NavigationView` | `NavigationSplitView` or `NavigationStack` |
| `.foregroundColor`, `.cornerRadius`, `.edgesIgnoringSafeArea`, `.accessibility(label:)` | `.foregroundStyle`, `.clipShape(.rect(cornerRadius:))`, `.ignoresSafeArea`, `.accessibilityLabel` |
| `ObservableObject` + `@Published` + `@StateObject` in new code | `@Observable` + `@State` |
| `onChange(of:perform:)` with one closure parameter | The two-parameter `(old, new)` or zero-parameter form |
| `Alert(...)`, `.actionSheet` | `.alert(_:isPresented:actions:message:)`, `.confirmationDialog` |
| `PreviewProvider` | `#Preview` |
| `NSApp.sendAction(Selector(("showSettingsWindow:")))` | `SettingsLink` or `openSettings` |
| `NSUserNotification`, `SMLoginItemSetEnabled` | UserNotifications, `SMAppService` |
| `xcrun altool --notarize-app` | `xcrun notarytool submit --wait` |
| `.tabItem` in new Settings panes | `Tab("…", systemImage:)` (macOS 15 and later) |
| Invented helpers such as `.windowSize(…)`, `.menuBarItem(…)`, `NSWindow.shared` | Search the SDK interface. Real equivalents are `defaultSize`, `MenuBarExtra`, and scene modifiers |

### Other mistakes agents make

- Calling the work done because tests pass, without launching the app or checking the menus.
- Leaving `CODE_SIGN_ENTITLEMENTS` unset, or building unsigned and assuming the sandbox was exercised.
- Hard-coded frames; `DispatchQueue.main.async` sprinkled instead of actor isolation; singleton per-window state.
- Committing `DerivedData`, `.xcresult` bundles (summarize them instead), `xcuserdata`, or signing material, or hand-editing a generated `.xcodeproj`.

---

## 11. Evidence to commit

Put these under `reports/mac/evidence/` (in your write scope) (text, not binaries, where possible) and reference them in your report:

- `build.txt`: the exact commands plus the last lines of a successful build, along with `xcodebuild -version` and the deployment target.
- `tests.txt`: the `xcresulttool ... summary` output with the counts of passed, failed, and skipped tests, plus a list of tests written but not executed and the reason.
- `entitlements.txt`: the `codesign -d --entitlements` dump and a one-line justification for each key.
- `accessibility.txt`: the audit result or the issues fixed, plus notes from a manual VoiceOver and keyboard pass.
- `shortcuts.md`: the menu and shortcut map.
- `api-verification.txt`: each API newer than the deployment target or added this session, with its availability and where you confirmed it.
- Screenshots of the main window in light and dark mode, Settings, and a multi-window state, if the environment allows capture. Otherwise, a note saying it doesn't.
- `notarization.txt`: either the notarytool log summary plus stapler and spctl output, or an explicit "not executed: no credentials" with the script path.

---

## Self-review checklist

Answer each item truthfully before you report.

**Native feel**
- [ ] Windows resize freely, minimum sizes are enforced, and layout holds from minimum to full screen.
- [ ] Navigation uses a sidebar or split view, not a phone push stack. The inspector uses `.inspector`.
- [ ] Every command is in the menu bar with conventional shortcuts, with no system-shortcut collisions, and commands disable when inapplicable.
- [ ] Context menus, hover help on icon buttons, drag and drop where it fits, undo and redo, and Delete, Escape, and Return all work.
- [ ] Light and dark mode both look right. There are no custom backgrounds fighting the system material, and toolbar items are grouped.

**Scenes**
- [ ] The Settings scene opens with ⌘, and contains grouped forms.
- [ ] Multiple windows have independent state, and reopening an open item focuses its existing window.
- [ ] Windows, sizes, and selections survive quit and relaunch. Transient windows don't restore.
- [ ] The last-window-closed behavior is deliberate.

**Correctness and Core**
- [ ] All behavior goes through the CONTRACT.md interface, with no duplicated Core logic.
- [ ] The build is clean under Swift 6 strict concurrency, with no unexplained `@unchecked Sendable` or `nonisolated(unsafe)`.
- [ ] Every API newer than the deployment target is gated and was confirmed in the SDK interface.
- [ ] There are no deprecation warnings and no iOS-only APIs.

**Security and packaging**
- [ ] The sandbox is on, entitlements are minimal and justified, and usage strings exist for every protected resource.
- [ ] Hardened runtime is on. The release script reads secrets from the environment only, and nothing secret is committed.
- [ ] Notarization status is reported honestly.

**Accessibility and performance**
- [ ] Every control has a VoiceOver name, the full flow works with the keyboard alone, and the accessibility audit passes or its findings are justified.
- [ ] Reduce Motion and Reduce Transparency are respected, and strings are in a String Catalog.
- [ ] No synchronous work happens at launch, list identity is stable, and profiling numbers are recorded.

**Evidence**
- [ ] Build and test output, entitlements, accessibility notes, the shortcut map, and the API verification file are committed, and anything not run says why.

---

## Sources

- Apple, SwiftUI `Settings` scene: https://developer.apple.com/documentation/swiftui/settings
- Apple, `OpenSettingsAction` / `openSettings`: https://developer.apple.com/documentation/swiftui/opensettingsaction
- Apple, `MenuBarExtra`: https://developer.apple.com/documentation/swiftui/menubarextra
- Apple, `restorationBehavior(_:)`: https://developer.apple.com/documentation/swiftui/scene/restorationbehavior(_:)
- Apple, `focusedSceneValue(_:_:)` and `FocusedValues` with `@Entry`: https://developer.apple.com/documentation/swiftui/view/focusedscenevalue(_:_:)
- Apple, Windows in SwiftUI: https://developer.apple.com/documentation/swiftui/windows
- Apple, WWDC24 "Tailor macOS windows with SwiftUI" (notes): https://wwdcnotes.com/documentation/wwdc24-10148-tailor-macos-windows-with-swiftui/
- Apple, Adopting Liquid Glass: https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass
- Apple, WWDC25 sessions 310 and 323 (new design for AppKit and SwiftUI): https://developer.apple.com/videos/play/wwdc2025/310/ , https://developer.apple.com/videos/play/wwdc2025/323/
- Apple, WWDC26 Xcode group lab (synchronized folders, xcconfig, agents): https://developer.apple.com/videos/play/wwdc2026/8013/
- Apple, WWDC26 SwiftUI guide: https://developer.apple.com/wwdc26/guides/swiftui/
- Apple, App Sandbox: https://developer.apple.com/documentation/security/app-sandbox
- Apple, Hardened Runtime: https://developer.apple.com/documentation/security/hardened-runtime
- Apple, Customizing the notarization workflow: https://developer.apple.com/documentation/security/customizing-the-notarization-workflow
- Apple, `performAccessibilityAudit(for:_:)`: https://developer.apple.com/documentation/xcuiautomation/xcuiapplication/performaccessibilityaudit(for:_:)
- Apple, Human Interface Guidelines, Designing for macOS: https://developer.apple.com/design/human-interface-guidelines/designing-for-macos
- Apple Developer Forums, notarytool credentials on CI: https://developer.apple.com/forums/thread/786582 , https://developer.apple.com/forums/thread/710678
- Peter Steinberger, showing Settings from macOS menu bar items (2025): https://steipete.me/posts/2025/showing-settings-from-macos-menu-bar-items/
- Electron notarize README (notarytool API-key flags): https://github.com/electron/notarize
- twostraws/Swift-Agent-Skills index and SwiftUI Pro skill: https://github.com/twostraws/Swift-Agent-Skills , https://github.com/twostraws/SwiftUI-Agent-Skill
- swift.org, Setting up Cursor for Swift development (agent skills): https://swift.org/documentation/articles/getting-started-with-cursor-swift.html
- Local verification: macOS 27 SDK `SwiftUI.swiftinterface` and `xcresulttool` help on the build host (Xcode 27.0).
