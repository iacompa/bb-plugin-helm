---
name: helm-ios
description: iOS craft (SwiftUI, Swift concurrency, accessibility, privacy, headless simulator tests). Use when you are a Helm iOS builder.
---

# Helm iOS craft

This skill covers what good iOS work looks like. Your protocol skill covers how you work inside Helm. Do not mix the two up: nothing here overrides scope, branching, reporting, or CONTRACT.md.

Baseline as of late 2026. Since April 28, 2026, App Store Connect only accepts builds made with Xcode 26 or later against the iOS 26 SDK. Building with the iOS 26 SDK does not force an iOS 26 deployment target. Choose the lowest deployment target the brief allows, but treat **iOS 17** as the practical floor: that is where Observation (`@Observable`), SwiftData, and `performAccessibilityAudit()` are available. Write Swift 6 with complete strict concurrency checking. If the toolchain on the machine is newer than this document, the toolchain wins. Check it with `xcodebuild -version` and `swift --version` before you start, and record both in your report.

---

## 1. Project setup and structure

**Generate the project; never hand-write `project.pbxproj`.** Agents corrupt pbxproj files constantly: duplicate UUIDs, orphaned build phases, merge conflicts between parallel branches. Use one of these, in order of preference:

1. **An existing `.xcodeproj` that uses folder-synchronised groups** (Xcode 16+ creates these by default). Files you add under a synchronised folder join the target automatically, so you almost never need to touch the pbxproj. If the app already has a project like this, keep it.
2. **XcodeGen** with a committed `project.yml`. Gitignore the generated `.xcodeproj`, or commit it and regenerate it after every change to `project.yml`. Pick one policy and write it down in the app README.
3. **Tuist**, if the repo already uses it. Do not introduce Tuist yourself; it is more machinery than one app needs.

A layout that works well for agents:

```
apps/ios/
  project.yml                 # or App.xcodeproj with synchronised folders
  Config/
    Base.xcconfig             # shared build settings, committed
    Local.xcconfig.example    # DEVELOPMENT_TEAM etc., the real one is gitignored
  App/
    AppMain.swift             # @main App, scene setup, composition root
    Features/<Feature>/       # one folder per feature: View, Model (state), subviews
    Shared/                   # design tokens, reusable views, formatters
    CoreBridge/               # the ONLY place that imports and adapts Core
    Resources/
      Assets.xcassets
      Localizable.xcstrings
      PrivacyInfo.xcprivacy
    Info.plist
  AppTests/                   # Swift Testing unit tests
  AppUITests/                 # XCUITest smoke and accessibility audits
```

Rules:
- **Put one primary type in each file and name the file after it.** This keeps diffs small and merges clean when several agents touch the same app.
- **Keep build settings in xcconfig files**, not scattered across target settings. Set `SWIFT_VERSION = 6`, `SWIFT_STRICT_CONCURRENCY = complete`, and `ENABLE_USER_SCRIPT_SANDBOXING = YES`. In new Xcode 26 projects, Default Actor Isolation is `MainActor` and Approachable Concurrency is on. For an app target, keep both: UI code is main-actor code, and you opt specific work out with `nonisolated` or `@concurrent`.
- **Add dependencies with Swift Package Manager only**, pinned to exact versions or tight ranges, and commit `Package.resolved`. Every dependency needs a reason in your report. Most apps need none beyond Core.
- **Never commit** `DerivedData/`, `*.xcresult` bundles larger than a few MB, `xcuserdata/`, `.p12`/`.p8`/`.mobileprovision` files, or a filled-in `Local.xcconfig`.

---

## 2. Architecture

The aim is the least architecture that keeps views dumb, state testable, and Core untouched.

### State
- **Use `@Observable` classes for feature state**, not `ObservableObject`/`@Published`. Own them with `@State` in the view that creates them. Pass them down as plain properties, or use `@Bindable` when a child needs bindings. Share app-wide services through `.environment(_:)` and read them with `@Environment(Type.self)`.
- **`@StateObject`, `@ObservedObject`, and `@EnvironmentObject` are legacy.** Use them only when you are extending code that already uses them, and never mix both styles within one feature.
- **Keep view-local UI state in `@State`** (is the sheet showing, the text field contents). Keep `@State` private.
- **Feature models are `@MainActor`** (this is the default under MainActor isolation). They call Core, map the results into display-ready values, and expose intent methods such as `func save() async`. Views call intents; views do not contain business rules.
- **Never re-implement Core.** If Core returns a domain object, map it into a view state struct in `CoreBridge/` or in the feature model. If Core is missing something you need, that is an escalation, not a local workaround.
- **Model loading as an explicit enum** (`idle`, `loading`, `loaded(T)`, `failed(UserFacingError)`). That way every screen has designed empty, loading, and error states, not just the happy path.

### Concurrency
- **Use structured concurrency.** Start async work from `.task { }` or `.task(id:)` so it is cancelled when the view goes away. Avoid unstructured `Task { }` inside views unless the work is a user-initiated action that must outlive the view, and say so in a comment.
- **Do not use `DispatchQueue.main.async`, completion-handler pyramids, or `@unchecked Sendable` to silence the compiler.** If a type crosses actors, make it `Sendable` properly: a value type, an actor, or a final class with immutable state.
- **Under Approachable Concurrency, `nonisolated async` functions run on the caller's actor.** Mark CPU-heavy functions `@concurrent` so they actually leave the main actor. Put shared mutable state that is not UI behind an `actor`.
- **Check `Task.isCancelled`, or use `try Task.checkCancellation()`, in long loops.**

### Navigation
- **Use `NavigationStack` with a typed path** (`@State private var path: [Route]` where `Route: Hashable`) and `.navigationDestination(for:)`. On iPad, or when the brief asks for multi-column layouts, use `NavigationSplitView`. `NavigationView` is deprecated.
- **Hold routes in an enum.** Deep links and App Intents then push the same `Route` values, so there is one way to reach each screen.
- **For tabs, use `TabView` with the `Tab` type** (iOS 18+), not `.tabItem`. Drive sheets with `.sheet(item:)` from optional state, not with a pile of booleans.
- **Dismiss with `@Environment(\.dismiss)`.** `presentationMode` is deprecated.

### Dependency injection
- **Compose dependencies by hand in the composition root.** `AppMain.swift` builds Core's entry points and your services once, then injects them with `.environment(...)` or initialiser parameters. Do not add a DI framework.
- **Hide every external boundary behind a small protocol**: Core facade, clock, network reachability, notification centre. Tests can then pass fakes. Do not write protocols for things that have only one implementation and no test seam.

### Persistence
Persistence usually belongs to Core. If CONTRACT.md gives local persistence to the platform layer:
- **Prefer SwiftData** (`@Model`, `ModelContainer`, `@Query`) for new code on iOS 17+. Never send `@Model` instances across actors; pass `PersistentIdentifier` and re-fetch. Do background writes in a `@ModelActor`. Version schemas from day one (`VersionedSchema` plus `SchemaMigrationPlan`), because adding them after the first release is painful.
- **Keep an existing Core Data stack** rather than migrating it mid-build. Use `NSPersistentContainer`, a background context for writes, and `viewContext` read-only from the UI.
- **Store secrets and tokens in the Keychain**, never in `UserDefaults` or files. Use `UserDefaults`/`@AppStorage` only for small preferences.

---

## 3. Permissions: ask for less, ask later, explain well

- **Every protected resource needs its `NS…UsageDescription` key in Info.plist.** If the key is missing, the app crashes the moment it asks. Typical keys are `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`, `NSPhotoLibraryAddUsageDescription`, `NSLocationWhenInUseUsageDescription`, `NSContactsUsageDescription`, `NSFaceIDUsageDescription`, and `NSUserTrackingUsageDescription`. Declare only what the app actually uses. Unused keys invite review questions.
- **Write purpose strings that are specific and honest**: what is accessed and what the user gets from it ("Scan receipts to add expenses automatically"), not "This app needs camera access". Localise them in `InfoPlist.xcstrings`.
- **Prefer out-of-process pickers, which need no permission at all.** Use `PhotosPicker` instead of photo library access, the document picker instead of broad file access, `CLLocationButton` or when-in-use location instead of always, and the share sheet instead of contacts access.
- **Ask in context**, right after the user taps the feature that needs the permission, never at launch. Check the current authorisation status first. Handle denial gracefully: offer a fallback such as manual entry, plus a button that opens `UIApplication.openSettingsURLString`. Reviewers test the denial path.
- **For notifications, call `UNUserNotificationCenter.requestAuthorization`** after the user opts into something that needs them. Provisional authorisation is a good fit for low-stakes updates.
- **App Tracking Transparency applies only if the app tracks across other companies' apps or sites.** Most Helm apps do not track, so do not add ATT or the IDFA.
- **Add entitlements and capabilities** (iCloud, App Groups, Push, HealthKit, Background Modes) **only when a feature needs them.** Each one changes signing and review scrutiny.

### Privacy manifest
- **Ship `PrivacyInfo.xcprivacy` in the app target.** Declare `NSPrivacyTracking`, `NSPrivacyTrackingDomains`, `NSPrivacyCollectedDataTypes`, and `NSPrivacyAccessedAPITypes`.
- **Required-reason APIs need a declared reason.** The categories are UserDefaults, file timestamps, system boot time, disk space, and active keyboards. Nearly every app uses UserDefaults, so declare `NSPrivacyAccessedAPICategoryUserDefaults` with reason `CA92.1` (app-only access). Check each reason code against Apple's current list rather than copying from memory; uploads fail with ITMS-91053 when one is missing.
- **Third-party SDKs must ship their own manifests.** If an SDK lacks one, flag it.

---

## 4. Lifecycle and background work

- **Use the SwiftUI `App` lifecycle with `@Environment(\.scenePhase)`.** Save drafts and flush pending writes on `.inactive`/`.background`. Add a `UIApplicationDelegateAdaptor` only for APIs that need it, such as push registration.
- **Assume the app can be killed at any moment in the background.** Restore navigation and drafts with `@SceneStorage` or persisted state. Never rely on `deinit` or "the app is closing" callbacks to save data.
- **Background execution is a privilege, not a timer.** Options, from most to least preferred:
  - Do the work in the foreground when the user is present.
  - Use `BGTaskScheduler` with `BGAppRefreshTask` for short refreshes and `BGProcessingTask` for deferrable heavy work. Register identifiers in `BGTaskSchedulerPermittedIdentifiers`, register handlers before launch finishes, always set an expiration handler, and call `setTaskCompleted`. The system decides when tasks run; never promise exact timing.
  - On iOS 26+, `BGContinuedProcessingTask` lets work the user explicitly started (an export, say) keep going with system UI showing progress. Verify that it exists in your SDK before using it.
  - Use background `URLSession` for large uploads and downloads.
  - Use push notifications to trigger server-driven updates.
- **Declare `UIBackgroundModes` only for modes the app genuinely uses** (audio, location, voip, and so on). Reviewers reject unused background modes.
- **Live Activities and widgets are separate extension targets.** Add them only if the brief asks. Share data through an App Group, and keep extension code free of UI-heavy dependencies.

### App Intents
If the brief mentions Siri, Shortcuts, Spotlight, widgets, or Control Center:
- **Define `AppIntent` types whose `perform()` is a thin call into Core** through the same bridge the UI uses. Expose domain objects as `AppEntity` with an `EntityQuery`.
- **Provide an `AppShortcutsProvider`** so shortcuts work with zero setup, and keep phrases short. Every phrase must include `\(.applicationName)`.
- **Localise intent titles and parameter summaries**, and test intents in a unit test by calling `perform()` against a fake Core.

---

## 5. Accessibility (blocking, not polish)

- **Dynamic Type.** Use text styles (`.font(.body)`, `.headline`, and so on) or `Font.custom(_:size:relativeTo:)`. Never use fixed point sizes for text. Scale custom spacing and icon sizes with `@ScaledMetric`. At accessibility sizes, switch horizontal layouts to vertical with `ViewThatFits`, or with `AnyLayout` keyed on `dynamicTypeSize.isAccessibilitySize`. Text must wrap, not truncate, wherever the content matters.
- **VoiceOver.**
  - Use `Button` for anything tappable, not `.onTapGesture`. A tap gesture is invisible to VoiceOver and to Full Keyboard Access.
  - Give icon-only buttons a label: `Button("Delete", systemImage: "trash") { }` with `.labelStyle(.iconOnly)`, or add `.accessibilityLabel`.
  - Hide decorative images with `Image(decorative:)` or `.accessibilityHidden(true)`.
  - Combine composite rows with `.accessibilityElement(children: .combine)`, and mark section titles with `.accessibilityAddTraits(.isHeader)`.
  - Expose custom actions (`.accessibilityAction(named:)`) for swipe-only gestures, and add `accessibilityValue` for sliders and progress.
- **Touch targets are at least 44×44 pt.** Use `.contentShape(Rectangle())` to enlarge hit areas without changing visuals.
- **Colour and motion.** Use semantic colours (`Color.primary`, `.secondary`, asset colours with dark and high-contrast variants). Never convey meaning by colour alone. Honour `accessibilityReduceMotion` and `accessibilityReduceTransparency`, and replace large motion with fades.
- **Liquid Glass (iOS 26).** System bars, tab bars, sheets, and toolbars adopt the new material automatically when built with the iOS 26 SDK. Do not paint opaque custom backgrounds behind them or fight them with hacks. Use `glassEffect` sparingly on custom floating controls, and check legibility with Reduce Transparency on.
- **Audit automatically.** In a UI test, call `try app.performAccessibilityAudit()` on every main screen (Xcode 15+, iOS 17+), and fail the test on issues you have not explicitly triaged.

---

## 6. Localisation readiness

Even if the brief is English-only, build it so that adding a language is a translation job, not a refactor.
- **Use one String Catalog (`Localizable.xcstrings`)**, plus `InfoPlist.xcstrings` for purpose strings and the display name. SwiftUI `Text("Welcome back")` and `String(localized:)` extract keys automatically at build time. Add translator comments (`comment:`) for anything ambiguous.
- **Never build sentences by concatenation.** Use interpolation inside a localised string and let the catalog handle plurals (variants by count).
- **Format with `FormatStyle`**: `.formatted(.currency(code:))`, `Date.FormatStyle`, `Measurement` formatting. Never format dates or numbers by hand.
- **Lay out with leading/trailing, never left/right.** Check right-to-left by launching with `-AppleLanguages "(ar)"`, and check expansion with the `-NSDoubleLocalizedStrings YES` launch argument.
- **Keep user-facing text out of Core error types.** Map errors to localised messages in the UI layer.

---

## 7. Performance

- **Keep `body` cheap and pure.** No formatting of large collections, no I/O, no sorting there. Precompute in the model.
- **Use `List` or `LazyVStack` for anything unbounded.** Give rows stable `id`s, never array indices. Avoid `AnyView`; use `@ViewBuilder` and concrete types.
- **Observation tracks the properties a view actually reads**, so split large models, or read fine-grained properties in child views, to limit invalidation. During development, `Self._printChanges()` shows why a view re-rendered. Remove it before committing.
- **Decode images off the main actor and downsample to display size.** `AsyncImage` has no persistent cache, so use Core's or `URLCache` for repeat loads.
- **Avoid `GeometryReader` for simple sizing.** Prefer `containerRelativeFrame`, `.frame(maxWidth: .infinity)`, or the `Layout` protocol.
- **Cold launch must not block on network.** Show cached or placeholder content immediately.
- **For a measurable regression concern,** profile headless with `xcrun xctrace record --template 'Time Profiler' --launch -- <app path>` on a simulator, or add `XCTMetric`-based performance tests (`XCTApplicationLaunchMetric`).

---

## 8. Store-compliance items

A reviewer will find these, so check them before you report done:
- **No placeholder content, broken links, lorem ipsum, or "coming soon" screens** in the shipped flow (Guideline 2.1). Every button does something.
- **Account deletion.** If the app creates accounts, it must let users delete their account from inside the app (5.1.1(v)). Do not force sign-in for features that do not need an account.
- **Privacy policy.** The app must link to its privacy policy from inside the app as well as in App Store Connect (5.1.1(i)). Build the link into Settings or About.
- **Login services.** If a third-party or social login is the primary login, also offer an equivalent privacy-preserving option (4.8). Sign in with Apple satisfies this.
- **AI data sharing.** Get explicit consent before sending personal data to a third-party AI service (5.1.2(i)). Apps that generate content need reporting and blocking (1.2).
- **Payments.** Digital goods and unlocks use StoreKit 2 in-app purchase, with a visible Restore Purchases button (3.1.1). Physical goods may use other payment methods.
- **Minimum functionality.** The app must be more than a wrapped website (4.2).
- **Metadata and icon.** No mention of other platforms in metadata or UI (2.3.10). The icon is a full-bleed 1024 px asset with no transparency. For iOS 26, provide light, dark, and tinted variants, or an Icon Composer `.icon` file if the toolchain supports it.
- **Export compliance.** Set `ITSAppUsesNonExemptEncryption` to `NO` in Info.plist if the app uses only standard HTTPS/system crypto. This avoids a manual question on every upload.
- **Usage strings and privacy manifest** are complete and match actual behaviour (see section 3). Write privacy nutrition-label notes for the human who fills in App Store Connect: what data is collected, whether it is linked to the user, and whether it is used for tracking.

---

## 9. Signing without secrets

- **Simulator builds and tests need no signing identity.** Pass `CODE_SIGNING_ALLOWED=NO` for unit tests and plain builds. Turn signing back on only if an entitlement (App Groups, Keychain sharing) forces it on simulator.
- **Keep `DEVELOPMENT_TEAM`, the bundle ID prefix, and the provisioning style in a gitignored `Config/Local.xcconfig`**, and commit a `.example` alongside it. Use automatic signing for development.
- **For archive/export in CI, use App Store Connect API key authentication**: `-allowProvisioningUpdates -authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID"`, with values from the environment or a secret store. Never put the key, certificates, passwords, or profiles in the repo, in logs, or in reports.
- **Release signing is a human step unless the brief provides credentials through a secrets mechanism.** If you reach it without them, stop and escalate. Do not generate certificates.

---

## 10. Build and test, headless

Pick a simulator explicitly. Never rely on "whatever is booted".

**Reuse the one `helm-ios` simulator.** Every simulator costs gigabytes of disk, and every app
and every agent share this machine. Look for an existing device named `helm-ios` first and use
it; create it only if none exists. Never create a simulator per app, per task or per run, and
erase (`xcrun simctl erase "$UDID"`) rather than delete-and-recreate. Keep DerivedData inside
the app's worktree (`-derivedDataPath build/DerivedData`, git-ignored), never the global default.

```bash
# Toolchain and runtimes
xcodebuild -version
xcrun simctl list runtimes
xcrun simctl list devices available

# Reuse the shared simulator; create it only if it does not exist yet
UDID=$(xcrun simctl list devices available | sed -n 's/^ *helm-ios (\([0-9A-F-]*\)).*/\1/p' | head -1)
[ -n "$UDID" ] || UDID=$(xcrun simctl create helm-ios "iPhone 17" "com.apple.CoreSimulator.SimRuntime.iOS-26-0")
xcrun simctl boot "$UDID" && xcrun simctl bootstatus "$UDID" -b

# If using XcodeGen
(cd apps/ios && xcodegen generate)

# Build and run all tests, with a result bundle
xcodebuild test \
  -project apps/ios/App.xcodeproj -scheme App \
  -destination "platform=iOS Simulator,id=$UDID" \
  -derivedDataPath apps/ios/build/DerivedData \
  -resultBundlePath "$REPORT_DIR/tests.xcresult" \
  CODE_SIGNING_ALLOWED=NO 2>&1 | tee "$REPORT_DIR/xcodebuild-test.log"

# Fast loop: build once, then run a subset
xcodebuild build-for-testing ...same flags...
xcodebuild test-without-building ... -only-testing:AppTests/FeatureModelTests

# Human-readable summary from the result bundle (Xcode 16+ subcommands)
xcrun xcresulttool get test-results summary --path "$REPORT_DIR/tests.xcresult" > "$REPORT_DIR/test-summary.json"
```

- **Unit tests use Swift Testing** (`import Testing`, `@Test`, `#expect`, `#require`, parameterised `@Test(arguments:)`). Use XCTest for UI tests (XCUITest) and performance metrics. Test feature models against fake Core facades. Test mapping and formatting, every state of the loading enum, and permission-denied paths.
- **UI tests are a small smoke suite**: launch, reach each primary screen, run `performAccessibilityAudit()`, and complete one core flow. Pass `launchArguments` such as `-ui-testing` so the app uses deterministic fixtures and skips onboarding and permission prompts.
- **Add `-destination-timeout 120` and a generous command timeout.** Simulator boot plus the first test run can take minutes. If xcodebuild hangs, run `xcrun simctl shutdown all`, erase the dedicated simulator, and retry once before you investigate.
- **Treat warnings as a signal.** New compiler warnings (deprecations, concurrency) in your diff are defects. Fix them rather than suppressing them.

### Screenshots

```bash
xcrun simctl status_bar "$UDID" override --time 9:41 --batteryState charged --batteryLevel 100 --cellularBars 4
xcrun simctl install "$UDID" apps/ios/build/DerivedData/Build/Products/Debug-iphonesimulator/App.app
xcrun simctl launch "$UDID" com.example.app -ui-testing
xcrun simctl io "$UDID" screenshot "$REPORT_DIR/screens/home-light.png"
xcrun simctl ui "$UDID" appearance dark
xcrun simctl ui "$UDID" content_size accessibility-extra-extra-extra-large
xcrun simctl io "$UDID" screenshot "$REPORT_DIR/screens/home-dark-ax5.png"
```

Status bar overrides do not survive a simulator reboot, so reapply them. Reset appearance and content size afterwards. To reach deep screens deterministically, have a UI test navigate there and attach screenshots with `XCTAttachment`, then export them from the xcresult (`xcrun xcresulttool export attachments --path … --output-path …`). Alternatively, support a launch argument that opens a given route.

---

## 11. Pitfalls agents fall into

**Deprecated APIs to stop writing.** Use the modern replacement on the right:

| Stop writing | Write instead |
|---|---|
| `NavigationView` | `NavigationStack` / `NavigationSplitView` |
| `.foregroundColor(_:)` | `.foregroundStyle(_:)` |
| `.cornerRadius(_:)` | `.clipShape(.rect(cornerRadius:))` |
| `.onChange(of:perform:)` with a one-value closure | the two-value or zero-value `onChange` form |
| `.tabItem` | `Tab` |
| `ObservableObject` / `@Published` / `@StateObject` in new code | `@Observable` with `@State` |
| `presentationMode` | `dismiss` |
| `ActionSheet` / `Alert(...)` structs | `.confirmationDialog` / `.alert(_:isPresented:)` |
| `showsIndicators:` | `.scrollIndicators(.hidden)` |
| `UIScreen.main.bounds` for layout | container-relative layout |
| `DispatchQueue.main.async` | main-actor isolation |
| `UIApplication.shared.windows` | the active `UIWindowScene`, or SwiftUI environment values |

**Hallucinated APIs.** Models invent plausible modifiers and initialisers, and get availability wrong. Before you rely on an API you have not used in this exact SDK:
- **Compile it.** A clean build is the minimum evidence.
- **Grep the SDK's Swift interface:** `grep -rn "func glassEffect" "$(xcrun --sdk iphonesimulator --show-sdk-path)/System/Library/Frameworks/SwiftUI.framework" --include=*.swiftinterface`. This confirms the symbol, its signature, and its `@available` annotation.
- **Guard availability.** If the API is newer than the deployment target, wrap it in `if #available(iOS 26, *)` and provide a fallback. Never raise the deployment target to dodge this without approval.
- **Read Apple's documentation page for the symbol**, not a blog post from three releases ago.

**Other recurring mistakes:**
- **Silencing Swift 6 errors** with `@preconcurrency`, `nonisolated(unsafe)`, or `@unchecked Sendable` instead of fixing isolation.
- **Starting `Task {}` in `init` or `onAppear`** without cancellation. Use `.task`.
- **Creating `@Observable` models inside `body`** or as a default property value without `@State`. They get recreated on every render.
- **Applying `.onTapGesture` to text or images** that should be buttons.
- **Forgetting the usage-description key** and crashing on the first permission request.
- **Mistaking a passing simulator build for a release build.** Run the Release configuration at least once (`-configuration Release`) to catch `#if DEBUG` leaks and optimiser-only issues.
- **Hard-coding strings, colours, and sizes** that break Dynamic Type, dark mode, and localisation.
- **Editing Core, generated code, or `project.pbxproj` by hand** to make something compile.
- **Claiming "tested" with no xcresult** or no screenshots.

---

## 12. Evidence to commit

Commit these under `reports/ios/` (in your write scope), e.g. `reports/ios/<task>/`:
- **The test log** (`xcodebuild-test.log`, trimmed to the summary and failures if it is huge) and `test-summary.json` from xcresulttool. Commit the `.xcresult` only if it is small; otherwise record its path and the summary.
- **Screenshots of every screen you built or changed:** light mode and dark mode, plus at least one at an accessibility Dynamic Type size. Add an RTL or pseudo-language capture if you touched layout. Use descriptive filenames (`settings-dark-ax5.png`).
- **The accessibility audit result** from the UI test run.
- **A short `ENV.txt`**: Xcode version, SDK, simulator device and runtime, deployment target, and the exact commands you ran.
- **A compliance note** if you added or changed permissions, entitlements, background modes, the privacy manifest, or data collection. Say what changed and why.

---

## 13. Self-review checklist

Before you report done, confirm each item:

- [ ] Builds clean with Xcode 26+ under Swift 6 strict concurrency, with no new warnings, in both Debug and Release.
- [ ] Every API used exists in the installed SDK at the deployment target, or is guarded with `#available` and has a fallback.
- [ ] No deprecated APIs from the table above in new code.
- [ ] UI calls Core only through the bridge; no Core logic is duplicated; no change to CONTRACT.md semantics.
- [ ] State uses `@Observable` with `@State`/`@Environment`; async work is tied to `.task`; there are no unjustified `Task {}` calls and no `@unchecked Sendable`.
- [ ] Navigation goes through a typed `NavigationStack` path, and deep links and intents reuse the same routes.
- [ ] Every screen has designed loading, empty, error, and permission-denied states.
- [ ] Permissions are asked in context, purpose strings are specific and localised, and unused keys, entitlements, and background modes are removed.
- [ ] `PrivacyInfo.xcprivacy` is present and accurate, including required-reason APIs.
- [ ] Account deletion, privacy policy link, and IAP restore are present if applicable.
- [ ] Dynamic Type works up to AX5 without clipped content; VoiceOver labels and traits are correct; touch targets are at least 44 pt; `performAccessibilityAudit()` passes.
- [ ] All user-facing strings are in String Catalogs, formatting uses `FormatStyle`, and layout uses leading/trailing.
- [ ] No secrets, certificates, profiles, team-specific signing values, or DerivedData are committed.
- [ ] Unit tests (Swift Testing) and the UI smoke tests pass headless, with logs and summary saved.
- [ ] Screenshots are committed for each changed screen (light, dark, large text).
- [ ] `ENV.txt` and the compliance note are written; the report states anything not verified.

---

## Sources

- https://developer.apple.com/news/upcoming-requirements/
- https://developer.apple.com/app-store/review/guidelines/
- https://developer.apple.com/documentation/bundleresources/privacy-manifest-files
- https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api
- https://developer.apple.com/documentation/uikit/protecting-the-user-s-privacy/requesting-access-to-protected-resources
- https://developer.apple.com/design/human-interface-guidelines/accessibility
- https://developer.apple.com/documentation/observation
- https://developer.apple.com/documentation/swiftdata
- https://developer.apple.com/documentation/appintents
- https://developer.apple.com/documentation/backgroundtasks
- https://developer.apple.com/documentation/testing
- https://developer.apple.com/documentation/xctest/xcuiapplication/performaccessibilityaudit(for:_:)
- https://developer.apple.com/documentation/xcode/localizing-and-varying-text-with-a-string-catalog
- https://www.donnywals.com/setting-default-actor-isolation-in-xcode-26/
- https://www.massicotte.org/blog/mainactor-by-default
- https://github.com/twostraws/SwiftUI-Agent-Skill
- https://github.com/AvdLee/SwiftUI-Agent-Skill
- https://www.jessesquires.com/blog/overriding-status-bar-settings-ios-simulator/
- https://expo.dev/blog/app-store-connect-minimum-sdk-26
