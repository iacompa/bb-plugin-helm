---
name: helm-android
description: Android craft (Kotlin, Jetpack Compose, Material 3, permissions, Play rules, headless emulator tests). Use when you are a Helm Android builder.
---

# Helm Android craft

This skill covers what good Android work looks like. Your protocol skill covers how you work inside Helm. Nothing here overrides scope, branching, reporting, or CONTRACT.md.

Baseline as of late 2026. Google Play requires new apps and updates to **target API 36 (Android 16)** from August 31, 2026, and the next step (API 37) is expected a year later. On API 36:
- Edge-to-edge cannot be opted out of.
- Predictive back is on by default.
- Orientation and resizability locks are ignored on large screens.

Set `compileSdk` and `targetSdk` to 36, or to the newest stable SDK installed. Set `minSdk` to what the brief allows. **26** is a sensible default; go lower only on request. Use the Android Gradle Plugin 9.x line with its built-in Kotlin support, Kotlin 2.2+, JDK 17+, and the Compose BOM. Before you start, check the real toolchain with `./gradlew --version` and `sdkmanager --list_installed`. If the toolchain is newer than this document, the toolchain wins. Record the versions in your report.

---

## 1. Project setup and structure

```
apps/and/
  settings.gradle.kts
  build.gradle.kts              # plugins { ... apply false } only
  gradle.properties             # org.gradle.caching=true, configuration-cache, jvmargs
  gradle/libs.versions.toml     # the ONLY place versions live
  gradle/wrapper/               # committed wrapper (jar + properties)
  app/
    build.gradle.kts
    proguard-rules.pro
    src/main/
      AndroidManifest.xml
      kotlin/<pkg>/
        App.kt                  # Application: composition root (AppContainer)
        MainActivity.kt         # enableEdgeToEdge(), setContent { AppTheme { AppNav() } }
        ui/theme/               # Material 3 color scheme, typography, shapes
        ui/<feature>/           # Screen.kt (stateless), Route.kt (stateful), ViewModel, UiState
        ui/components/          # shared composables
        corebridge/             # the ONLY package that touches Core APIs
      res/values/strings.xml
      res/xml/                  # data_extraction_rules.xml, backup rules
    src/test/                   # JVM unit tests
    src/androidTest/            # instrumented + Compose UI tests
```

Rules:
- **Keep every version in the version catalog.** No hard-coded versions in module scripts. Manage all Compose artifacts through `platform(libs.androidx.compose.bom)` and do not pin individual Compose versions unless you have a documented reason.
- **Start with one `:app` module.** Split into feature or library modules only when build times or ownership demand it. Agents love to create twelve modules for a four-screen app; do not. If Core arrives as a Gradle module or a KMP library, depend on it exactly as CONTRACT.md describes.
- **Use the Kotlin Compose compiler plugin** (`org.jetbrains.kotlin.plugin.compose`), not the old `composeOptions { kotlinCompilerExtensionVersion }`. Use **KSP**, not kapt, for annotation processors such as Room.
- **Commit the Gradle wrapper.** Never commit `local.properties`, `build/`, `.gradle/`, `*.jks`/`*.keystore`, `google-services.json` containing production keys, or `.idea/` workspace files.
- **Set the application ID, namespace, and `versionCode`/`versionName` explicitly.** `versionCode` must only ever increase.

---

## 2. Architecture

The target is unidirectional data flow with the fewest moving parts.

### State
- **One `ViewModel` per screen**, exposing `val uiState: StateFlow<FeatureUiState>` (an immutable data class or sealed interface) and plain functions for user intents (`onSaveClick()`, `onQueryChange(q)`). Build state with `stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), initial)` when it is derived from Core flows.
- **Split screens in two.** The stateful route composable gets the ViewModel and collects with `collectAsStateWithLifecycle()`. It passes state and lambdas into a stateless `FeatureScreen(state, onEvent…)`. That stateless screen is what previews and UI tests render.
- **Model one-off outcomes as state** (`userMessage: String?` cleared after it is shown, `navigateTo: Route?` consumed), not as fire-and-forget `SharedFlow` or `Channel` events that get lost across configuration changes.
- **Hoist state to the lowest common owner.** Use `remember` for ephemeral UI state, `rememberSaveable` for anything that must survive rotation and process death, and `SavedStateHandle` in ViewModels for screen arguments and in-progress input.
- **Never re-implement Core.** ViewModels call Core through `corebridge/` and map Core models into UI state. Map Core errors to user-facing messages in the UI layer. If Core lacks something, escalate.
- **Give every screen loading, empty, error, and content states**, and give each a preview.

### Navigation
- **Use Navigation 3** (`androidx.navigation3`, stable since November 2025) for new apps. The back stack is a state list you own, rendered by `NavDisplay`, with routes as `@Serializable` `NavKey` types and `rememberNavBackStack` for persistence. If the app already uses Navigation Compose 2.8+, keep it and use its type-safe `@Serializable` routes. Never use string routes with hand-built argument parsing.
- **Deep links, notifications, and shortcuts resolve to the same route types** as in-app navigation.
- **The structure and look follow the UI builder's design** (`reports/ui/DIRECTION.md`) and helm-ui's `reference/android.md` (`bb skill show <id> --path reference/android.md`): navigation bar, rail or drawer by width, edge to edge, system back everywhere, Material 3 colour and type roles.
- **Size the layout from the window.** Use `material3-adaptive`: `currentWindowAdaptiveInfo()` / window size classes, `NavigationSuiteScaffold` to switch between bottom bar and rail, and `ListDetailPaneScaffold` for list-detail. Do not branch on "is tablet" heuristics.

### Dependency injection
- **Use manual DI by default.** An `AppContainer` built in `App.onCreate()` holds Core facades and singletons. ViewModels get their dependencies through `viewModelFactory { initializer { FeatureViewModel(app.container.repo, createSavedStateHandle()) } }`. That is enough for most Helm apps.
- **Use Hilt only if the repo already does.** Do not introduce Koin, Hilt, and a service locator side by side.
- **Put every external boundary behind an interface** so tests can supply fakes: Core facade, clock, connectivity, notification poster. Do not add interfaces for things with one implementation and no test need.

### Persistence (only if CONTRACT.md gives it to the platform layer)
- **Room** with KSP, `exportSchema = true` (commit the schema JSON), and explicit `Migration`s or `@AutoMigration` for every version bump. Never use `fallbackToDestructiveMigration()` in release builds. DAOs return `Flow` for observed queries and use `suspend` for writes.
- **DataStore** (Preferences or typed) instead of `SharedPreferences`.
- **Keystore for secrets.** Do not add `androidx.security:security-crypto` (EncryptedSharedPreferences); it is deprecated. Never log tokens.
- **Backups.** Configure `android:dataExtractionRules` (API 31+) and `fullBackupContent` to exclude tokens and caches from cloud backup and device transfer.

### Coroutines
- **Use `viewModelScope` in ViewModels and `LaunchedEffect`/`rememberCoroutineScope` in composables.** Never use `GlobalScope`, and never call `runBlocking` on the main thread. Inject dispatchers so tests can swap them, and do I/O on `Dispatchers.IO` inside the data layer, not in the UI.
- **Use `repeatOnLifecycle` / `collectAsStateWithLifecycle`** to collect flows only while the UI is visible.

---

## 3. Edge-to-edge, predictive back, large screens

These are mandatory on API 36. Agents get them wrong more than anything else.

- **Edge-to-edge.**
  - Call `enableEdgeToEdge()` in `MainActivity.onCreate` before `setContent`.
  - Use `Scaffold` and apply its `innerPadding` to content.
  - For custom layouts, use `WindowInsets.safeDrawing` / `systemBars` / `displayCutout` via `Modifier.windowInsetsPadding(...)`, and `Modifier.imePadding()` around text input.
  - Let lists draw behind the system bars, with `contentPadding` from the insets so the last item is reachable.
  - Do not use `window.statusBarColor`/`navigationBarColor` (deprecated, ignored on 15+), Accompanist `systemuicontroller`, or `windowOptOutEdgeToEdgeEnforcement`.
  - Verify with both gesture navigation and three-button navigation, in light and dark modes.
- **Predictive back.**
  - Do not override `onBackPressed()` or listen for `KEYCODE_BACK`. With target 36 these are not called.
  - Use `BackHandler(enabled = …)` in Compose for custom back logic, or `PredictiveBackHandler` when you want to animate with the gesture progress. The navigation library handles ordinary back stacks.
  - Keep back handlers disabled unless they are actually intercepting, or the system's back-to-home animation is lost.
  - Do not ship `android:enableOnBackInvokedCallback="false"`.
- **Large screens and configuration changes.**
  - On displays 600dp and wider, Android 16 ignores `screenOrientation`, `resizableActivity="false"`, and aspect-ratio limits; Android 17 removes the temporary opt-out. Design for any size.
  - Expect activity re-creation on rotation, fold, and resize, and keep state in ViewModels plus `rememberSaveable`.
  - Test at least one tablet or foldable emulator profile, or a resized window.

---

## 4. Permissions: minimal, contextual, recoverable

- **Declare only what a shipped feature uses.** Then inspect the *merged* manifest, because libraries inject permissions. Run `./gradlew :app:processDebugMainManifest` and read `app/build/intermediates/merged_manifests/debug/.../AndroidManifest.xml`. Strip anything unwanted with `<uses-permission android:name="…" tools:node="remove"/>`.
- **Request runtime permissions** with `rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission())` (or `RequestMultiplePermissions`), triggered by the user action that needs the permission. Never request at launch.
  - Check `ContextCompat.checkSelfPermission` first.
  - Show a rationale when `shouldShowRequestPermissionRationale` is true.
  - After permanent denial, offer a fallback and a deep link to app settings.
  - Do not use `requestPermissions`/`onRequestPermissionsResult` or Accompanist permissions.
- **Prefer permissionless alternatives.**
  - **Photos and videos:** use the Photo Picker (`ActivityResultContracts.PickVisualMedia`/`PickMultipleVisualMedia`). Play allows `READ_MEDIA_IMAGES`/`READ_MEDIA_VIDEO` only for apps whose core purpose needs broad media access, and requires a declaration.
  - **Files:** use the Storage Access Framework (`OpenDocument`, `CreateDocument`). Never use `MANAGE_EXTERNAL_STORAGE`.
  - **Location:** use `ACCESS_COARSE_LOCATION` unless precision is essential. Background location is a separate, later request with its own Play declaration; avoid it.
  - **Camera:** to just take a photo, use the `TakePicture` contract instead of the `CAMERA` permission.
  - **Bluetooth:** use `BLUETOOTH_SCAN` with `android:usesPermissionFlags="neverForLocation"` when you do not derive location.
  - **Package visibility:** use `<queries>` with specific intents or packages, never `QUERY_ALL_PACKAGES`.
- **Notifications.** `POST_NOTIFICATIONS` is a runtime permission on API 33+. Create notification channels with meaningful names and importance, and ask only after the user opts into something that needs notifications.
- **Exact alarms.** `SCHEDULE_EXACT_ALARM` is denied by default on 14+, and `USE_EXACT_ALARM` is limited to alarm-clock and calendar apps. Most "reminders" work fine with inexact alarms or WorkManager.
- **Health data.** API 36 replaces the body-sensor permissions with granular health permissions, and requires an activity that shows the privacy rationale.

---

## 5. Lifecycle and background work

- **Assume process death.** The OS kills backgrounded apps freely. Test with "Don't keep activities", or with `adb shell am kill <pkg>` after backgrounding, and confirm the user returns to the same screen with input intact.
- **Prefer foreground work.** Do work while the user is present when you can.
- **Use WorkManager for deferrable, guaranteed work** (sync, uploads, cleanup).
  - Use `CoroutineWorker` with `Constraints` (network, battery-not-low), and enqueue unique work (`enqueueUniqueWork`/`enqueueUniquePeriodicWork`) so it does not duplicate.
  - Periodic work has a 15-minute minimum and runs when the system allows.
  - Use expedited work (`setExpedited`) for short, user-important tasks.
  - Return `Result.retry()` with backoff rather than looping.
- **Use foreground services only for ongoing, user-noticeable work** that cannot be deferred: playback, navigation, an active call, a user-started transfer.
  - Since API 34, every foreground service must declare `android:foregroundServiceType`, hold the matching `FOREGROUND_SERVICE_<TYPE>` permission, meet that type's runtime prerequisites, and pass the type to `startForeground()`.
  - Since API 35, `dataSync` and `mediaProcessing` have daily time budgets: implement `onTimeout` and stop promptly. Several types cannot be started from `BOOT_COMPLETED`.
  - Use `shortService` (about 3 minutes) for brief critical work.
  - Prefer a user-initiated data transfer job or WorkManager over `dataSync` where possible.
  - Every foreground service type needs a Play Console declaration with a demo video, so each one you add creates release work for a human. Note it in your report.
- **Never use `AlarmManager` loops, `IntentService`, `JobIntentService`, or long-running threads in `Application`** for background work.
- **Keep `Application.onCreate` fast.** Initialise lazily, and use App Startup only if several libraries need ordered initialisation.

---

## 6. Accessibility (TalkBack and beyond)

- **Semantics.**
  - Give every meaningful image or icon a `contentDescription` that describes the action or meaning ("Delete draft", not "trash icon"). Set it to `null` for decorative images.
  - Icon buttons need a description.
  - Use `Modifier.clickable(onClickLabel = "Open details", role = Role.Button)` for custom clickables.
  - Merge composite rows with `Modifier.semantics(mergeDescendants = true) {}` (clickable rows merge automatically).
  - Mark section titles with `semantics { heading() }`.
  - Use `stateDescription` for custom toggles and `customActions` for swipe-only gestures.
  - Fix traversal order with `isTraversalGroup`/`traversalIndex` only when the visual order misleads.
- **Touch targets are at least 48×48dp.** Material 3 components enforce this when interactive. For custom components, use `Modifier.minimumInteractiveComponentSize()` or padding.
- **Text scaling.**
  - Use `sp` for text, via `MaterialTheme.typography`.
  - Android 14+ scales fonts non-linearly up to 200%. Never give text containers fixed heights.
  - Let rows wrap or reflow at large scales, and test at 2.0 font scale.
- **Colour.** Generate the scheme from Material 3 roles and support dynamic colour on 12+ with a branded fallback. Meet 4.5:1 contrast for body text. Never convey state by colour alone. Respect the user's animation scale (it is reported as reduced motion) in custom animations.
- **Automate checks.**
  - In Compose UI tests (Compose 1.8+), add `ui-test-junit4-accessibility` and call `composeTestRule.enableAccessibilityChecks()`. Actions then run Accessibility Test Framework checks for labels, contrast, touch-target size, and traversal.
  - For any View-based screens, use Espresso's `AccessibilityChecks.enable()`.
  - These need an emulator or device (API 34+ is recommended); Robolectric results are not conclusive.
  - Note any TalkBack walkthrough you did manually.

---

## 7. Localisation readiness

- **Every user-visible string goes in `res/values/strings.xml`**, including content descriptions and notification channel names. Use `<plurals>` for counts and positional format arguments (`%1$s`, `%2$d`). Never concatenate translated fragments. Mark non-translatable strings `translatable="false"`.
- **Format with locale-aware APIs:** `java.time` formatters with `FormatStyle`, `NumberFormat`/ICU `MeasureFormat`, and `DateUtils` for relative times. Never write `String.format("%.2f")` for money.
- **Support RTL:** `android:supportsRtl="true"`, start/end everywhere, and mirroring for directional icons (`autoMirror` on vector drawables; `Icons.AutoMirrored.*` in Compose).
- **Per-app language.** Enable `androidResources { generateLocaleConfig = true }` with a `resources.properties` default locale, so per-app language selection works once translations exist.
- **Pseudolocales.** Enable them in the debug build type (`isPseudoLocalesEnabled = true`). Run under `en-XA` (expansion and accents) and `ar-XB` (RTL) and screenshot both.

---

## 8. Performance

- **Compose.**
  - Read state as late as possible. Pass lambdas, such as `Modifier.offset { }` and `drawBehind`, for values that change every frame.
  - Wrap computed values in `remember`/`derivedStateOf`.
  - Give `LazyColumn` items stable `key`s and `contentType`.
  - Do not create objects or sort lists inside composition.
  - Strong skipping is the default, but unstable parameters from Core (for example `List` from a Java API) still cause churn. Map them to immutable UI models.
- **Main thread.** Enable `StrictMode` in debug builds to catch disk and network access on the main thread. Load images with an established library (Coil 3) at display size.
- **Release builds.**
  - Turn on R8: `isMinifyEnabled = true` and `isShrinkResources = true` for release. Full mode is the default.
  - Add targeted keep rules only for code accessed by reflection (serialisation, JNI, Core's FFI if any), with a comment on each. Never blanket `-keep class ** { *; }`.
  - Always build and smoke-test the minified release variant. R8 bugs never show up in debug.
- **Startup.** Add a Baseline Profile (`androidx.baselineprofile` plugin plus a Macrobenchmark module) once the main flows are stable. Measure cold start with Macrobenchmark rather than guessing.
- **Native code.** If Core ships `.so` files, Play requires 16 KB page alignment for apps targeting API 35+. Use AGP 8.5.1+ and NDK r28+, check alignment with APK Analyzer or `check_elf_alignment.sh`, and confirm the current enforcement date on the official page.

---

## 9. Store-compliance items

- **Target API 36 or higher**, and ship an Android App Bundle (`bundleRelease`). Play App Signing holds the app signing key; you only ever touch an upload key, and never in the repo.
- **Data safety form.** You must accurately declare what the app *and every SDK in it* collects and shares, whether data is encrypted in transit (only if *all* of it is), and how users request deletion. Leave a `DATA_SAFETY.md`-style note in your report directory listing every data type, its purpose, and the SDKs involved, so a human can fill in the form. Any mismatch with actual behaviour is enforceable.
- **Account deletion.** If the app creates accounts, provide account deletion inside the app, plus a web URL for deletion requests.
- **Privacy policy.** Link it from inside the app and from the listing.
- **Sensitive permission declarations.** Photo/video, background location, foreground service types, exact alarms, `QUERY_ALL_PACKAGES`, and health each require a Play Console declaration. Avoid them, or list every one you used in your report.
- **Families policy.** If the audience includes children, ads and SDKs are restricted. Flag it rather than guessing.
- **Payments.** Digital goods are sold through Play Billing (current Billing Library major version), with restoration via `queryPurchasesAsync`.
- **Network security.** `usesCleartextTraffic` is false (the default); use a network security config only for named debug hosts.
- **Exported components.** Mark every component with an intent filter `android:exported` explicitly; export only what must be exported. Consider `android:intentMatchingFlags="enforceIntentFilter"` on API 36.

---

## 10. Signing without secrets

- **Debug builds use the auto-generated debug keystore.** Nothing to commit.
- **Release `signingConfigs` read from environment variables or `~/.gradle/gradle.properties`** (`RELEASE_STORE_FILE`, `RELEASE_STORE_PASSWORD`, …). When they are absent, the build skips release signing instead of failing configuration, so CI can still build an unsigned bundle. Keystores, passwords, `google-services.json` with production credentials, and Play service-account JSON never enter the repo, logs, or reports.
- **Uploading to Play is a human step** unless the brief supplies credentials through a secrets mechanism. Escalate rather than improvising.

---

## 11. Build and test, headless

```bash
cd apps/and
./gradlew --version
./gradlew :app:assembleDebug
./gradlew :app:testDebugUnitTest            # JVM tests -> app/build/test-results/, reports/tests/
./gradlew :app:lintDebug                    # -> app/build/reports/lint-results-debug.html
./gradlew :app:assembleRelease              # R8 / minified build must succeed

# Emulator, headless (choose an installed system image)
sdkmanager "system-images;android-36;google_apis;arm64-v8a"   # x86_64 on Intel/Linux hosts
echo no | avdmanager create avd -n helm-api36 -k "system-images;android-36;google_apis;arm64-v8a" -d pixel_8
emulator -avd helm-api36 -no-window -no-audio -no-boot-anim -no-snapshot-save -gpu swiftshader_indirect &
adb wait-for-device shell 'while [ -z "$(getprop sys.boot_completed)" ]; do sleep 2; done'
for s in window_animation_scale transition_animation_scale animator_duration_scale; do adb shell settings put global $s 0; done

./gradlew :app:connectedDebugAndroidTest    # -> app/build/reports/androidTests/connected/
```

- **Gradle Managed Devices are an alternative** that needs no hand-managed emulator. Define a device in `testOptions.managedDevices` and run `./gradlew :app:pixel8Api36DebugAndroidTest -Pandroid.testoptions.manageddevices.emulator.gpu=swiftshader_indirect`. This is reproducible in CI.
- **JVM unit tests (JUnit 4 or 5, `kotlinx-coroutines-test`)** cover ViewModels with fake Core facades. Cover every `UiState` branch, error mapping, and `SavedStateHandle` restoration. Use `runTest` and a main-dispatcher rule. Fakes beat mocks.
- **Instrumented Compose tests** use `createAndroidComposeRule<MainActivity>()` or `createComposeRule()` on the stateless screens. Find nodes by semantics (text, content description, `testTag` as a last resort) and enable accessibility checks. Keep one smoke flow end-to-end. Room migrations get a `MigrationTestHelper` test.
- **Gradle setup.** Run with `--stacktrace` when diagnosing, and keep the configuration cache and build cache on. If the emulator stalls, kill it (`adb emu kill`), wipe it (`-wipe-data`), and retry once before you investigate.

### Screenshots

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell settings put global sysui_demo_allowed 1
adb shell am broadcast -a com.android.systemui.demo -e command enter
adb shell am broadcast -a com.android.systemui.demo -e command clock -e hhmm 0941
adb shell am start -W -n <applicationId>/.MainActivity
adb exec-out screencap -p > "reports/and/home--default--pixel-9--light.png"
adb shell cmd uimode night yes
adb exec-out screencap -p > "reports/and/home--default--pixel-9--dark.png"
adb shell settings put system font_scale 2.0
adb exec-out screencap -p > "reports/and/evidence/home-dark-font200.png"
adb shell settings put system font_scale 1.0; adb shell cmd uimode night no
adb shell am broadcast -a com.android.systemui.demo -e command exit
```

To reach deep screens reliably, navigate in an instrumented test and capture from there. Alternatively, accept a debug-only intent extra that opens a route. Do not add a screenshot-testing framework (Roborazzi, Paparazzi, Compose Preview Screenshot Testing) unless the brief or lead asks for one.

---

## 12. Pitfalls agents fall into

**Deprecated or legacy APIs to stop writing:**
- **Back handling:** `onBackPressed()` and `KEYCODE_BACK` handling. Use `BackHandler`/`OnBackPressedDispatcher`.
- **Activity results and permissions:** `startActivityForResult`/`onActivityResult`, `requestPermissions`. Use Activity Result contracts.
- **Old background primitives:** `AsyncTask`, `IntentService`, `JobIntentService`, `Handler()` without a Looper, `GlobalScope`.
- **Accompanist:** `systemuicontroller`, `insets`, `permissions`, `pager`, `navigation-animation`. These are deprecated and folded into Activity, Foundation, Navigation, and Material 3.
- **Material 2 imports** (`androidx.compose.material.*`) mixed with Material 3 (`androidx.compose.material3.*`). Pick Material 3 everywhere, and use `Icons.AutoMirrored` for directional icons.
- **Bar colours:** `window.statusBarColor`, `setDecorFitsSystemWindows` hacks, opt-outs from edge-to-edge.
- **Flow collection in Compose:** `collectAsState()` instead of `collectAsStateWithLifecycle()`. `LiveData` in new Compose code.
- **Storage and build tooling:** `SharedPreferences` for new data, EncryptedSharedPreferences, kapt, the `composeOptions` compiler version block, `buildscript { dependencies { classpath } }` in new projects.
- **Navigation:** string routes.
- **Screen orientation:** `android:screenOrientation="portrait"` as a layout strategy.

**Hallucinated APIs and versions.** Models invent Material 3 parameters, composables, and artifact versions that do not exist. Before you rely on one:
- **Compile it.** `./gradlew :app:compileDebugKotlin` is the minimum evidence.
- **Confirm the artifact version exists** on Google Maven (`https://maven.google.com/web/index.html`) or Maven Central, and check that the Compose BOM actually maps the library version you think it does (`./gradlew :app:dependencies --configuration debugRuntimeClasspath | grep material3`).
- **Read the real signature in the downloaded sources jar.** For example, look under `~/.gradle/caches/modules-2/files-2.1/androidx.compose.material3/` and `unzip -p …-sources.jar path/To/File.kt | grep -n "fun TopAppBar"`, or open the official reference page for that exact version.
- **Watch experimental annotations.** `@OptIn(ExperimentalMaterial3Api::class)` is acceptable when needed; scope it narrowly. Never use APIs marked `@RestrictTo` or internal.
- **Gate newer platform APIs.** Use `Build.VERSION.SDK_INT >= …` checks, or prefer the Jetpack `*Compat` equivalent, for anything newer than `minSdk`. Lint's `NewApi` check catches these, so do not suppress it.

**Other recurring mistakes:**
- **Collecting flows or launching coroutines directly in composition** without `LaunchedEffect`, or with unstable keys that restart them every recomposition.
- **Passing the ViewModel or `NavController` deep into child composables.** Pass state and lambdas instead.
- **Forgetting `innerPadding`**, so content hides under bars. Doubling insets, so there are big gaps.
- **Testing only the debug build.** R8 then strips something used through reflection, and the release crashes on launch.
- **Leaving permissions in the merged manifest** from a library you added "just in case".
- **Hard-coded strings, colours, and dp text sizes.**
- **Editing Core or generated sources** to get a build through.
- **Claiming tests pass** without committing their output.

---

## 13. Evidence to commit

Commit these under `reports/and/` (in your write scope): page captures at the top level as your BRIEF names them (`reports/and/<screen>--<state>--<device>--<theme>.png`, one emulator per listed model), everything else in `reports/and/evidence/`, which Screens leaves out:
- **Unit test results:** the JUnit XML summary or HTML index from `app/build/test-results` / `app/build/reports/tests`, and the console tail showing `BUILD SUCCESSFUL` and the test count.
- **Instrumented test results** from `app/build/reports/androidTests/connected/` (or the managed-device equivalent), including the accessibility-check outcome.
- **The lint summary**, showing no new errors and any warnings you accepted with a reason.
- **Proof the release build passes:** `assembleRelease` or `bundleRelease` output, and a note that the minified build launched.
- **Emulator screenshots** of each new or changed screen: light and dark on each device your BRIEF lists, named as it says; font scale 2.0, pseudolocale or RTL if you changed layout, and one large-screen capture if layout adapts go in `reports/and/evidence/` with descriptive filenames.
- **`ENV.txt`:** AGP, Gradle, Kotlin, JDK, compile, target, and min SDK, the emulator image, and the exact commands you ran.
- **A compliance note** whenever you add or change permissions, foreground service types, data collection, SDKs, or exported components, including Data safety implications.

---

## 14. Self-review checklist

Before you report done, confirm each item:

- [ ] `compileSdk`/`targetSdk` are 36 or higher, versions live only in the catalog, the Compose BOM is used, and KSP is used rather than kapt.
- [ ] Every API and artifact version used exists in the resolved dependencies and SDK; newer APIs are gated by SDK checks; lint `NewApi` is clean.
- [ ] No deprecated APIs from the list above in new code.
- [ ] UI reaches Core only through `corebridge/`; no Core logic is duplicated.
- [ ] ViewModels expose `StateFlow<UiState>`, composables collect with lifecycle awareness, screens are stateless with previews, and state survives rotation and process death.
- [ ] Navigation uses type-safe routes (Navigation 3, or Navigation Compose with serializable routes), and deep links reuse them.
- [ ] Edge-to-edge is correct with gesture and three-button navigation, the IME does not cover inputs, and predictive back works with no `onBackPressed`.
- [ ] Layout adapts to compact, medium, and expanded widths, with no orientation locks.
- [ ] The merged manifest holds only needed permissions; requests are contextual with rationale and fallback; permissionless pickers are used where possible.
- [ ] Background work uses WorkManager; any foreground service has a correct type, permission, timeout handling, and a note about its Play declaration.
- [ ] TalkBack labels, roles, headings, and merging are correct; touch targets are at least 48dp; text works at 200%; Compose accessibility checks pass.
- [ ] All strings are in resources with plurals and positional arguments; RTL and pseudolocales have been checked.
- [ ] Release build with R8 succeeds and launches; keep rules are minimal and commented.
- [ ] Data safety notes, account deletion, privacy policy link, and sensitive-permission declarations are addressed or flagged.
- [ ] No keystores, passwords, service-account files, or `local.properties` are committed.
- [ ] Unit and instrumented tests pass headless; results, lint, screenshots, `ENV.txt`, and the compliance note are committed; anything unverified is stated plainly.

---

## Sources

- https://developer.android.com/google/play/requirements/target-sdk
- https://developer.android.com/about/versions/16/behavior-changes-16
- https://developer.android.com/blog/posts/prepare-your-app-for-the-resizability-and-orientation-changes-in-android-17
- https://developer.android.com/develop/ui/compose/system/insets
- https://developer.android.com/guide/navigation/custom-back/predictive-back-gesture
- https://developer.android.com/blog/posts/jetpack-navigation-3-is-stable
- https://developer.android.com/topic/architecture
- https://developer.android.com/develop/background-work/services/fgs/service-types
- https://developer.android.com/develop/background-work/background-tasks/persistent
- https://developer.android.com/training/permissions/requesting
- https://support.google.com/googleplay/android-developer/answer/14115180
- https://support.google.com/googleplay/android-developer/answer/13392821
- https://support.google.com/googleplay/android-developer/answer/10787469
- https://developer.android.com/guide/practices/page-sizes
- https://developer.android.com/develop/ui/compose/accessibility/key-steps
- https://developer.android.com/develop/ui/compose/accessibility/testing
- https://developer.android.com/guide/topics/resources/app-languages
- https://developer.android.com/build/shrink-code
- https://developer.android.com/topic/performance/baselineprofiles/overview
- https://developer.android.com/build/releases/agp-9-0-0-release-notes
- https://developer.android.com/studio/test/gradle-managed-devices
