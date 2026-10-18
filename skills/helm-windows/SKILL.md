---
name: helm-windows
description: Windows craft (WinUI 3, Windows App SDK, .NET, MVVM, Fluent, accessibility, MSIX, a windows-latest CI build). Use when you are a Helm Windows builder.
---

# Helm Windows craft

Your protocol skill covers how you work inside Helm. This skill covers what good Windows work looks like. The target is an app a Windows 11 user would take for a first-party one: Mica behind a proper title bar, Fluent controls in light, dark, and contrast themes, crisp at every scaling factor, fully operable with keyboard and Narrator, and packaged as MSIX. A phone layout in a maximized window, a hamburger menu as the only navigation at 1920 pixels wide, or a custom title bar that breaks Snap all fail that bar.

Three rules run through everything below:

1. **The host is a Mac. You cannot compile, run, or test WinUI here.** Every XAML compile, API, and packaging claim is unproven until a `windows-latest` GitHub Actions run passes. Your report must say "verified by CI only", with a link to the run. Section 9 explains how to get there.
2. **Verify every API.** Models routinely produce UWP or WPF code that looks like WinUI 3 but doesn't compile. Section 10 lists the traps.
3. **Core owns behavior.** View models call Core through the CONTRACT.md interface and adapt its results for XAML. They hold no business rules of their own.

---

## 1. Project setup

### Stack defaults (unless CONTRACT.md or the brief says otherwise)

- **.NET 10 (LTS).** Target `net10.0-windows10.0.26100.0`, with `TargetPlatformMinVersion` set to `10.0.17763.0`, which is the Windows App SDK floor. Pin the SDK in `global.json` with `rollForward: latestFeature`.
- **Windows App SDK on the stable 2.x line.** Starting with 2.0, the SDK uses semantic versioning and the package version matches the SDK version. Pin an exact `Microsoft.WindowsAppSDK` version, and look up the current stable release on NuGet or in the release notes rather than trusting memory. Never take preview or experimental packages unless told to.
- **Platforms `x64;ARM64`**, with `RuntimeIdentifiers` set to `win-x64;win-arm64`. Never use AnyCPU, which fails at runtime with bad-image-format errors.
- **Packaged single-project MSIX** (the default for the templates). Package identity unlocks notifications, startup tasks, file and protocol activation, and clean install and uninstall. Use unpackaged only if the brief explicitly asks for it.
- **CommunityToolkit.Mvvm** (8.4 or later) for MVVM. Use the Windows Community Toolkit v8 packages (`CommunityToolkit.WinUI.*`) for extras such as `SettingsCard` and `SettingsExpander` (`CommunityToolkit.WinUI.Controls.SettingsControls`).
- `Microsoft.Extensions.Hosting` or `Microsoft.Extensions.DependencyInjection` for composition.
- Add `Microsoft.Windows.SDK.BuildTools.WinUIAnalyzer` with `PrivateAssets="all"`. Microsoft recommends it to catch WinUI runtime pitfalls at build time.

### Scaffolding without a Windows machine

Microsoft now ships `dotnet new` templates. Install them with `dotnet new install Microsoft.WindowsAppSDK.WinUI.CSharp.Templates`. The short names include `winui`, `winui-navview`, `winui-tabview`, and `winui-mvvm`, but confirm them with `dotnet new list winui`. Template expansion is just file generation, so if the .NET SDK is present on the Mac you can scaffold here. If it isn't, don't install it without approval. Hand-write the project instead, starting from the skeleton below, and let CI tell you what's wrong.

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFramework>net10.0-windows10.0.26100.0</TargetFramework>
    <TargetPlatformMinVersion>10.0.17763.0</TargetPlatformMinVersion>
    <Platforms>x64;ARM64</Platforms>
    <RuntimeIdentifiers>win-x64;win-arm64</RuntimeIdentifiers>
    <UseWinUI>true</UseWinUI>
    <EnableMsixTooling>true</EnableMsixTooling>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <ApplicationManifest>app.manifest</ApplicationManifest>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.WindowsAppSDK" Version="<pinned stable>" />
    <PackageReference Include="CommunityToolkit.Mvvm" Version="<pinned>" />
  </ItemGroup>
</Project>
```

Prefer generating from a template when you can. Hand-written projects miss details such as `Package.appxmanifest` assets and the `app.manifest` DPI settings. When you hand-write, copy those structures from the official template sources.

### Suggested layout

```
apps/win/
  global.json
  App.sln
  Directory.Build.props        # Nullable, AnalysisLevel, TreatWarningsAsErrors for new code
  src/App/                     # WinUI project: App.xaml, MainWindow.xaml, Views/, Controls/, Assets/, Strings/en-us/Resources.resw, Package.appxmanifest
  src/App.Presentation/        # net10.0 class library: ViewModels, services interfaces, Core adapter. No Microsoft.UI references.
  tests/App.Presentation.Tests/ # net10.0 test project (xUnit or MSTest)
  ci/windows-ci.yml            # workflow source (see section 9)
  docs/evidence/
```

The `App.Presentation` split is the key move for a Mac host. Keeping ViewModels in a plain `net10.0` library that doesn't reference `Microsoft.UI.*` makes them unit-testable with `dotnet test` on any OS, including this Mac if the SDK is installed, and much faster to iterate on than the WinUI project.

---

## 2. Architecture

- **MVVM.** Each page has a ViewModel resolved from dependency injection. The page exposes it as a typed `ViewModel` property, and XAML binds with `x:Bind ViewModel.Property`. Set the page's `DataContext` only if you're forced to use `{Binding}`.
- **Toolkit patterns** (8.4 or later):
  ```csharp
  public partial class ItemsViewModel(ICoreClient core) : ObservableObject
  {
      [ObservableProperty]
      [NotifyCanExecuteChangedFor(nameof(DeleteCommand))]
      public partial ItemSummary? Selected { get; set; }

      [ObservableProperty] public partial bool IsLoading { get; set; }

      public ObservableCollection<ItemSummary> Items { get; } = [];

      [RelayCommand]
      private async Task LoadAsync(CancellationToken ct) { /* call core, fill Items */ }

      [RelayCommand(CanExecute = nameof(CanDelete))]
      private Task DeleteAsync() => core.DeleteAsync(Selected!.Id);
      private bool CanDelete() => Selected is not null;
  }
  ```
  In WinUI projects, use partial properties rather than fields with `[ObservableProperty]`. The field form triggers analyzer warning MVVMTK0045 because it isn't trim- or AOT-safe under WinRT. If the analyzer asks for a newer `LangVersion` (MVVMTK0051), set what it says. Async `[RelayCommand]` methods produce `IAsyncRelayCommand`, which blocks concurrent execution by default and supports cancellation. Bind buttons to the generated command, not to click handlers. Use `WeakReferenceMessenger` for loose cross-ViewModel signals, sparingly.
- **UI thread.** ViewModels can't touch `DispatcherQueue` directly if they're going to stay testable, so inject a small `IUiDispatcher` that the WinUI project implements with `DispatcherQueue.TryEnqueue`. Batch collection updates into one enqueue. Never block with `.Result`, `.Wait()`, or `GetAwaiter().GetResult()`.
- **Core adapter.** Write an `ICoreClient` that mirrors CONTRACT.md, with a live implementation (a project reference, P/Invoke, or IPC, whichever the contract specifies) and a fake for tests and design-time data. ViewModels never re-validate, re-sort, or persist data Core owns.
- **Navigation.** Use an `INavigationService` that wraps `Frame.Navigate(typeof(Page))`, mapping ViewModel types to pages in one place. Keep a reference to the main window in `App`. `Window.Current` is always null in WinUI 3 desktop apps.

---

## 3. Making it feel like a Windows app

### Shape the app correctly

Choose a silhouette from shipping apps:

- **Settings or config tool:** Left `NavigationView` with `SettingsCard` and `SettingsExpander` pages.
- **Document or session editor:** `TabView` with full-bleed content, like Terminal or Notepad.
- **Hierarchical browser:** `TreeView` plus a list plus `BreadcrumbBar`.
- **Dashboard:** `NavigationView` plus cards.
- **Single-purpose utility:** a compact window, no `NavigationView`.

For navigation, use `NavigationView` with `PaneDisplayMode="Auto"` so it moves from Left to LeftCompact to LeftMinimal as width shrinks. Use the built-in Settings item (`IsSettingsVisible`) rather than a custom one.

### Title bar and backdrop

- Extend content into the title bar with `ExtendsContentIntoTitleBar = true`, use the `TitleBar` control (Windows App SDK 1.7 and later), and call `SetTitleBar(titleBarElement)`. Calling `SetTitleBar` is what keeps window dragging, double-click to maximize, the system menu, and Snap Layouts on the maximize button working. Keep interactive elements out of the drag region unless you mark them as passthrough.
- Set `SystemBackdrop = new MicaBackdrop()` on the main window, and use `DesktopAcrylicBackdrop` for transient or secondary windows. Leave page backgrounds transparent so the backdrop shows through. Painting a solid color over Mica defeats it. `SystemBackdropElement` (2.0 and later) places a backdrop within the layout when that's needed.

### Commands and density

- Desktop users expect visible commands. Use a `CommandBar` (primary plus overflow) per page and a `MenuBar` when the app has many commands. Every item in a list or canvas gets a `ContextFlyout` (`MenuFlyout`) on right-click and Shift+F10, and its items mirror the command bar.
- Show keyboard accelerators in menus and tooltips. `KeyboardAccelerator` displays them automatically on `MenuFlyoutItem` and in tooltips.
- Follow the Fluent type ramp (`CaptionTextBlockStyle`, `BodyTextBlockStyle`, `BodyStrongTextBlockStyle`, `SubtitleTextBlockStyle`, `TitleTextBlockStyle`) and a 4-pixel spacing grid. Use standard control heights, Segoe Fluent Icons through `FontIcon` or `SymbolIcon`, and no oversized touch padding.
- **Pick the right control for the job.** A blocking decision is a `ContentDialog`, and destructive actions get a verb-labeled primary button and Cancel. Inline status and errors use `InfoBar`. Hints and onboarding use `TeachingTip`. Numbers go in `NumberBox`, dates in `CalendarDatePicker`, booleans in `ToggleSwitch`, and two or three choices in `RadioButtons`. WinUI has no `DataGrid`. For tabular data, use a `ListView` with a `Grid` item template and a header row, or a vetted toolkit control.
- **Responsive layout.** Use `VisualStateManager` with `AdaptiveTrigger`s at sensible widths (for example, 640 and 1008 effective pixels). Commands that drop out at narrow widths must move to the overflow menu, not disappear.
- **Window sizing.** WinUI 3 has no `SizeToContent`, and the default window is often wrong for the app. Size the window explicitly on first launch (section 5) and set minimums with `OverlappedPresenter.PreferredMinimumWidth` and `PreferredMinimumHeight`.

### Theming and dark mode

- Reference colors and brushes only through `{ThemeResource ...}`, using semantic keys such as `TextFillColorPrimaryBrush`, `CardBackgroundFillColorDefaultBrush`, and `ControlStrokeColorDefaultBrush`. `{StaticResource}` and inline hex colors don't update when the theme changes.
- Define custom brushes in `ThemeDictionaries` with Light, Dark, and HighContrast entries. In HighContrast, use only `SystemColor*` resources. If the platform brushes already work, leave that dictionary empty. Never set `HighContrastAdjustment="None"` as a fix.
- Offer a System, Light, or Dark setting by setting `RequestedTheme` on the window's root `FrameworkElement`. Persist the choice. When the title bar is extended, keep the caption-button colors in sync with the theme.
- Use the accent color through `SystemAccentColor` and its light and dark variants, never a hard-coded brand color on controls. Base custom styles on the default style (`BasedOn="{StaticResource DefaultButtonStyle}"`) rather than re-templating controls.

---

## 4. Keyboard

- Logical Tab order follows reading order. Fix it with layout first and `TabIndex` second. Use arrow-key navigation inside composite groups (`XYFocusKeyboardNavigation="Enabled"`, with `TabFocusNavigation="Once"` on the group), and F6 to cycle between panes.
- Add `KeyboardAccelerator` bindings with the conventional shortcuts: Ctrl+N, Ctrl+O, Ctrl+S, Ctrl+Shift+S, Ctrl+W (close tab or window), Ctrl+F, Ctrl+Z and Ctrl+Y, Delete, F2 (rename), F5 (refresh), Ctrl+Tab (next tab), and Ctrl+, (settings is common in modern apps). Never repurpose Alt+F4, Win-key combinations, or Alt+Tab.
- Add `AccessKey` values so Alt shows key tips on top-level commands.
- Escape closes dialogs and flyouts, and Enter activates the default button (`ContentDialog.DefaultButton`).
- Never remove focus visuals. `UseSystemFocusVisuals` stays on, and custom templates keep the focus states.
- After navigation and when a dialog closes, put focus somewhere sensible with `Focus(FocusState.Programmatic)`.

---

## 5. High DPI and window state

- WinUI 3 apps are per-monitor DPI aware (v2) by default. XAML layout uses effective pixels and scales automatically. **`AppWindow` APIs (`Resize`, `Move`, `MoveAndResize`, `Size`, `Position`) work in physical pixels.** Convert using the window's scale: `GetDpiForWindow(hwnd) / 96.0`, or `XamlRoot.RasterizationScale` once content has loaded. Handle `XamlRoot.Changed` when the window moves to a monitor with a different scale. Forgetting this conversion produces tiny windows at 200% and giant ones at 100%.
- Prefer vector assets such as Fluent icons and paths. For bitmaps and package logos, supply scale variants (`.scale-100`, `.scale-125`, `.scale-150`, `.scale-200`, `.scale-400`). Set `DecodePixelWidth` on large images.
- Handle text scaling (Settings → Accessibility → Text size). Never put fixed heights on text containers, and let text wrap.
- **Persist window state.** On `AppWindow.Closing`, save the position, size, and whether the `OverlappedPresenter.State` is `Maximized`. Save to `ApplicationData.Current.LocalSettings` for a packaged app, or to a JSON file under `%LOCALAPPDATA%` for an unpackaged one. On launch, check the saved rectangle against `DisplayArea.GetFromRect(rect, DisplayAreaFallback.Nearest).WorkArea`, clamp it so the title bar stays reachable, apply it with `MoveAndResize`, and call `Maximize()` if needed. A disconnected monitor must never leave the window off-screen. On first launch, center a sensible default size, converted to physical pixels.

---

## 6. System integration

Integrate only what the brief or CONTRACT.md asks for:

- **Single instance and activation.** Use `Microsoft.Windows.AppLifecycle.AppInstance.FindOrRegisterForKey` with `RedirectActivationToAsync` to send a second launch to the running instance. Read `AppInstance.GetCurrent().GetActivatedEventArgs()` for file and protocol activation. Declare file type associations and protocols in `Package.appxmanifest`.
- **Notifications.** Use `Microsoft.Windows.AppNotifications.AppNotificationManager`. Register it at startup and handle `NotificationInvoked`.
- **File pickers.** Use `Microsoft.Windows.Storage.Pickers` (`new FileOpenPicker(this.AppWindow.Id)`) on current SDKs. The older `Windows.Storage.Pickers` types require `WinRT.Interop.InitializeWithWindow.Initialize(picker, hwnd)`, and without it they throw "invalid window handle" errors at runtime.
- **Launch at sign-in.** Declare a `StartupTask` extension in the manifest and let the user control it.
- **Secrets.** Store credentials in `Windows.Security.Credentials.PasswordVault`, never in settings or files. Encrypt data at rest with `DataProtectionProvider` if Core doesn't handle it.
- **Interop.** For anything Win32, get the handle from `WinRT.Interop.WindowNative.GetWindowHandle(window)`. Prefer CsWin32-generated P/Invoke over hand-written signatures.
- **Localization.** Put strings in `Strings/<lang>/Resources.resw`. Use `x:Uid` in XAML and `Microsoft.Windows.ApplicationModel.Resources.ResourceLoader` in code. Format with `CultureInfo.CurrentCulture`, and use Start and End alignment, not Left and Right, so the layout works right-to-left.

---

## 7. Packaging

- **`Package.appxmanifest`.** Set `Identity` (`Name`, a `Publisher` that exactly matches the signing certificate's subject, and a four-part `Version`), `DisplayName`, `PublisherDisplayName`, and logos at every scale. Set `TargetDeviceFamily Name="Windows.Desktop"` with `MinVersion` aligned to `TargetPlatformMinVersion`.
- **Capabilities.** Declare the minimum set. `runFullTrust` is required for desktop WinUI apps. Add `internetClient` only if Core talks to the network. Treat broad capabilities such as `broadFileSystemAccess` as escalations.
- **Signing.** Never commit a `.pfx` file or password. For verification builds, CI produces unsigned packages (`AppxPackageSigningEnabled=false`). For sideload builds, the certificate arrives as a base64 repository secret, is decoded in the job, used, and deleted in the same job. Store submissions are uploaded unsigned and signed by the Store. Production signing should add a timestamp so signatures outlive the certificate.
- **Deployment.** The default is framework-dependent: the Windows App SDK runtime is installed as a package dependency. `WindowsAppSDKSelfContained=true` bundles the Windows App SDK, and `SelfContained=true` bundles .NET. These are separate switches, and neither produces a single-file WinUI executable.
- **Native AOT.** Opt in with `PublishAot` only when asked. It needs the MSVC toolchain and IL- and trim-clean code. Fix the CsWinRT and trimming warnings rather than suppressing them.

---

## 8. Accessibility (UI Automation)

- Every interactive control exposes a name: visible text content, `AutomationProperties.Name`, or `AutomationProperties.LabeledBy` pointing at its label. Icon-only buttons always need `AutomationProperties.Name` and a `ToolTipService.ToolTip`. Give images a name, or set `AutomationProperties.AccessibilityView="Raw"` if they're decorative.
- Give every control that tests or Core-driven flows target a stable `AutomationProperties.AutomationId`. Never select elements by display text.
- Mark page and section titles with `AutomationProperties.HeadingLevel`. Announce async status changes with `AutomationProperties.LiveSetting="Polite"` on the status element, and raise `LiveRegionChanged` from its automation peer when the text changes.
- Prefer semantic controls. A `Grid` with a tap handler is invisible to UI Automation and to the keyboard. If you must build a custom control, override `OnCreateAutomationPeer` and implement the right patterns (Invoke, Toggle, Value, Selection), and implement keyboard handling and HighContrast visuals too.
- Never convey state by color alone. Maintain at least 4.5:1 contrast for body text and 3:1 for large text and UI glyphs in both themes.
- These need manual QA on Windows, which you can't do from a Mac: Narrator through the main flow, a contrast theme, keyboard-only operation, Accessibility Insights for Windows FastPass, and checks at 100, 150, and 200% scale. List them in your report as **not verified** unless a UI Automation test in CI covers part of them.

---

## 9. Build and test: CI is the only proof

### What you can do on the Mac

- Check XAML for well-formedness: `find src/App -name "*.xaml" -exec xmllint --noout {} +`. This catches broken markup before CI does, though it doesn't validate types or bindings.
- If the .NET SDK is installed, run `dotnet test tests/App.Presentation.Tests` here. ViewModels, the Core adapter, and formatting can be fully tested locally. `EnableWindowsTargeting=true` lets Windows-targeted projects restore on macOS, but the WinUI XAML compiler and MSIX tooling still need Windows.
- Everything else waits for CI.

### The workflow

GitHub runs workflows only from `.github/workflows/` at the repository root, which is outside the `apps/win/**` write scope. Author the workflow at `apps/win/ci/windows-ci.yml` and escalate to get it installed at `.github/workflows/windows-ci.yml`, unless your assignment already grants that path. Keep the two copies identical.

```yaml
name: windows-ci
on:
  push:
    paths: ['apps/win/**', '.github/workflows/windows-ci.yml']
  pull_request:
    paths: ['apps/win/**']
  workflow_dispatch:
permissions:
  contents: read
concurrency:
  group: windows-ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  build-test:
    runs-on: windows-latest
    strategy:
      fail-fast: false
      matrix:
        platform: [x64, ARM64]
    defaults:
      run:
        working-directory: apps/win
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-dotnet@v5
        with:
          global-json-file: apps/win/global.json
      - uses: microsoft/setup-msbuild@v2
      - name: Unit tests
        if: matrix.platform == 'x64'
        run: dotnet test tests/App.Presentation.Tests -c Release --logger "trx;LogFileName=unit.trx" --results-directory TestResults
      - name: Build and package (unsigned MSIX)
        run: >
          msbuild src/App/App.csproj /restore /m
          /p:Configuration=Release
          /p:Platform=${{ matrix.platform }}
          /p:GenerateAppxPackageOnBuild=true
          /p:AppxPackageSigningEnabled=false
          /p:UapAppxPackageBuildMode=SideloadOnly
          /p:AppxBundle=Never
          /p:AppxPackageDir=${{ github.workspace }}\apps\windows\artifacts\msix\
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: windows-${{ matrix.platform }}
          path: |
            apps/win/TestResults/**
            apps/win/artifacts/msix/**
          if-no-files-found: warn
```

Notes on the workflow:

- **Action versions.** Check each action's releases page and use the current major version. The versions shown were current when this skill was written.
- **Why MSBuild for packaging.** Microsoft's CI guidance uses MSBuild with `GenerateAppxPackageOnBuild` because some MSIX and PRI tasks need full MSBuild. `dotnet test` is fine for the plain `net10.0` test project.
- **Test reporting.** If the test project opts into Microsoft.Testing.Platform, the TRX switch changes (`--report-trx`). Check `dotnet test --help` against the SDK you pinned.
- **Runner pinning.** `windows-latest` moves over time. If a toolchain bump breaks the build, pin `windows-2025` and note it in your report.
- **Optional UI smoke test.** A FlaUI (UIA3) or Appium-based test can launch the built app and check key AutomationIds in a second job. Hosted runners do have a desktop session, but treat these tests as best-effort. If they're flaky, report them as not verified rather than retrying until they pass.

### The CI loop

```sh
git push                                   # on your branch, per protocol
gh run list --workflow windows-ci --branch <branch> --limit 3
gh run watch <run-id> --exit-status
gh run view <run-id> --log-failed          # read every error, fix all in one pass
gh run download <run-id> -D reports/win/evidence/ci-<run-id>   # trx summary, then delete binaries you won't commit
```

Batch your fixes. Each CI round trip costs minutes, so read the whole failure log, fix every error, re-check XAML locally, then push again. Never report success based on a run that targeted a different commit. Match the run's head SHA to your commit.

---

## 10. Pitfalls: hallucinated, legacy, and wrong-framework APIs

**How to verify.**

1. Look up the type on Microsoft Learn's Windows App SDK API reference and check its version selector against the version you pinned.
2. Find a working usage in the WinUI Gallery or the Windows App SDK samples.
3. On a Windows machine, `winapp find-api` checks APIs against the restored project. That isn't available here.
4. The CI compile is the final check. Treat a new warning as a failure to investigate.

| Wrong | Right in WinUI 3 / Windows App SDK |
|---|---|
| `Windows.UI.Xaml.*` namespaces (UWP) | `Microsoft.UI.Xaml.*` |
| `Window.Current`, `CoreWindow`, `ApplicationView.GetForCurrentView()`, `CoreApplication` view APIs | Hold your own `MainWindow` reference, and use `AppWindow` for size, title, and presenter |
| `Dispatcher.RunAsync` / `CoreDispatcher` | `DispatcherQueue.TryEnqueue` |
| `ContentDialog.ShowAsync()` with no `XamlRoot` | Set `dialog.XamlRoot = element.XamlRoot` first, and show only one dialog at a time |
| `Windows.Storage.Pickers` without window initialization | `Microsoft.Windows.Storage.Pickers` with `AppWindow.Id`, or call `InitializeWithWindow` |
| WPF: `MessageBox`, `DataGrid`, `SizeToContent`, `Window.Resources`, `Window.DataContext`, `Style.Triggers`, `Visibility.Hidden`, `DynamicResource` | `ContentDialog`, a `ListView` template, explicit `AppWindow` sizing, resources on the root element, a `ViewModel` property with `x:Bind`, `VisualStateManager`, `Collapsed`, `ThemeResource` |
| `{Binding}` everywhere | `x:Bind`, which is compiled and type-checked. Its default mode is OneTime, so add `Mode=OneWay` for values that change |
| `[ObservableProperty] private string _name;` | `[ObservableProperty] public partial string Name { get; set; }` |
| `Microsoft.Toolkit.Mvvm`, `Microsoft.Toolkit.Uwp.UI.*` | `CommunityToolkit.Mvvm`, `CommunityToolkit.WinUI.*` (v8) |
| `AcrylicBrush` with `BackgroundSource="HostBackdrop"` | `DesktopAcrylicBackdrop` as the window's `SystemBackdrop` |
| `ApplicationData.Current` in an unpackaged app | Works only with package identity. Stay packaged, or use a file under `%LOCALAPPDATA%` |
| AnyCPU builds, `PresentationCore` references | x64 or ARM64 only. Remove the WPF references, which crash the XAML compiler |
| Plausible inventions such as `Window.Width`, `Window.SetMinSize`, `NavigationView.Pages` | Check the API reference. Real equivalents are `AppWindow.Size` and `Resize` and `OverlappedPresenter.PreferredMinimumWidth` |

### Other mistakes agents make

- Claiming "builds" or "tests pass" for WinUI code without a CI run on the current commit.
- Wrapping a `ListView` in a `ScrollViewer`, which breaks virtualization.
- Hard-coding colors, so dark and contrast themes break.
- Calling `SetTitleBar` with nothing, or with a region full of buttons, which breaks drag and Snap.
- Mixing physical and effective pixels.
- Swallowing exceptions in `async void` handlers. Keep `async void` for event handlers only, and catch and log inside them.
- Reimplementing Core rules in ViewModels.
- Committing `bin/`, `obj/`, `AppPackages/`, `*.pfx`, `*.user`, or downloaded CI binaries.

---

## 11. Performance

- Use `x:Bind` over `{Binding}`. Defer hidden UI with `x:Load`, and prioritize item content with `x:Phase` in list templates.
- Use virtualizing collections for anything that might exceed a screenful: `ListView`, `GridView`, or `ItemsRepeater`. Implement `ISupportIncrementalLoading` for large remote sets.
- Keep the visual tree shallow, preferring a `Grid` over nested `StackPanel`s, and use `x:DefaultBindMode` deliberately.
- Keep the `App` constructor and `OnLaunched` light: activate the window first, then load data asynchronously.
- Consider `PublishReadyToRun` for startup time when CI measurements justify it.
- Use `async`/`await` for I/O and `Task.Run` for CPU-bound work that isn't already inside Core. Batch UI updates.
- Record measured numbers (for example, startup time from a CI smoke test) rather than adjectives. If you couldn't measure, say so.

---

## 12. Evidence to commit

Put these under `reports/win/evidence/`, as text where possible:

- `ci.md`: the run URL, head SHA, matrix results for each platform, and the exact phrase **"Verified by CI only (windows-latest). Not built or run locally: host is macOS."**
- `tests.txt`: the test summary parsed from the TRX file (passed, failed, and skipped counts, plus the names of any failures), and which tests ran locally on the Mac, if any.
- `package.txt`: the MSIX artifact names and sizes, the manifest identity, the capabilities with a justification for each, and the signing mode (unsigned verification build).
- `api-verification.txt`: each Windows App SDK or toolkit API introduced, with the minimum version and the reference page you checked.
- `accessibility.md`: AutomationIds and names added, keyboard and accelerator map, theme resources used, and an explicit list of manual checks still owed (Narrator, contrast theme, DPI 100/150/200%, Accessibility Insights).
- The workflow file under `apps/win/ci/`.
- Screenshots only if a CI UI job produced them. Never fabricate visuals.

---

## Self-review checklist

**Native feel**
- [ ] The app silhouette matches its job (`NavigationView`, `TabView`, or utility), and navigation adapts to window width.
- [ ] The title bar uses `ExtendsContentIntoTitleBar` and `SetTitleBar` with the `TitleBar` control. Dragging, double-click, and Snap Layouts work. Mica is on the main window, and pages don't paint over it.
- [ ] There's a command bar or menu bar, right-click and Shift+F10 context menus, accelerators shown in tooltips and menus, and Settings in `NavigationView`'s Settings item.
- [ ] Explicit first-launch size, minimum size, and saved state are clamped to the current displays.

**Theming, DPI, accessibility**
- [ ] Only `ThemeResource` brushes are used. Light, Dark, and HighContrast all work, and the in-app theme choice persists.
- [ ] Physical and effective pixels are converted correctly, and scale assets or vectors are supplied.
- [ ] Every interactive control has a UIA name and the important ones have AutomationIds. Headings, live regions, Tab and arrow navigation, Escape and Enter, and focus visuals are all in place.
- [ ] The manual accessibility checks that are still owed are listed in the report.

**Architecture and correctness**
- [ ] ViewModels live in a `net10.0` library with no `Microsoft.UI` references, are unit-tested, and call Core only through the CONTRACT.md interface.
- [ ] Toolkit partial properties and generated commands are used, with no MVVMTK warnings and no blocking calls on the UI thread.
- [ ] No UWP or WPF APIs. Every new API was checked against the pinned Windows App SDK version.

**Packaging and CI**
- [ ] The MSIX manifest identity, minimal capabilities, and logos are complete. No certificate or secret is committed.
- [ ] The workflow is authored, installed (or escalated), and green for x64 and ARM64 on the current SHA. Artifacts are uploaded.
- [ ] The report says "verified by CI only", with the run link, and lists everything not verified.

---

## Sources

- Microsoft Learn, Windows App SDK 2.0 release notes (semantic versioning, 2.x features): https://learn.microsoft.com/en-us/windows/apps/win-app-sdk/release-notes/windows-app-sdk-2-0
- Microsoft Learn, Windows App SDK 1.8 release notes: https://learn.microsoft.com/en-us/windows/apps/win-app-sdk/release-notes/windows-app-sdk-1-8
- Microsoft Learn, Windows App SDK release channels: https://learn.microsoft.com/en-us/windows/apps/win-app-sdk/release-channels
- Microsoft Learn, Set up continuous integration for your WinUI app: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/ci-for-winui3
- Microsoft Learn, Title bar customization and the `TitleBar` control: https://learn.microsoft.com/windows/apps/develop/title-bar , https://learn.microsoft.com/windows/apps/design/controls/title-bar
- Microsoft Learn, Manage app windows (`AppWindow`, presenters): https://learn.microsoft.com/en-us/windows/apps/develop/ui/manage-app-windows
- Microsoft Learn, `OverlappedPresenter` API reference: https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.ui.windowing.overlappedpresenter
- Microsoft Learn, Open files and folders with pickers in WinUI: https://learn.microsoft.com/en-gb/windows/apps/develop/files/using-file-folder-pickers
- Microsoft Learn, Store and retrieve app data: https://learn.microsoft.com/en-us/windows/apps/develop/data/store-and-retrieve-app-data
- Microsoft Learn, WinUI agent plugin (AI-assisted development): https://learn.microsoft.com/en-us/windows/apps/develop/ai-assisted/winui-agent-plugin
- Microsoft #ifdef Windows blog, Introducing dotnet new templates for WinUI (May 2026): https://devblogs.microsoft.com/ifdef-windows/introducing-dotnet-new-templates-for-winui/
- Microsoft #ifdef Windows blog, Windows App Development CLI v0.6: https://devblogs.microsoft.com/ifdef-windows/windows-app-development-cli-v0-6-create-new-winui-applications-sign-packages-with-azure-and-more/
- microsoft/win-dev-skills (agent plugins index): https://github.com/microsoft/win-dev-skills
- microsoft/winappCli WinUI agent skills (winui-design, winui-dev-workflow, winui-packaging, winui-ui-testing, winui-code-review quality rules, theme-accessibility reference): https://github.com/microsoft/winappCli/tree/main/plugins/winui/agent-plugin/skills
- .NET Blog, Announcing .NET Community Toolkit 8.4 (partial properties, WinRT analyzers): https://devblogs.microsoft.com/dotnet/announcing-the-dotnet-community-toolkit-840/
- InfoQ, .NET Community Toolkit 8.4 coverage: https://www.infoq.com/news/2024/12/dotnet-community-toolkit-84
- NuGet, Microsoft.WindowsAppSDK: https://www.nuget.org/packages/Microsoft.WindowsAppSDK
- GitHub, actions/runner-images Windows Server 2025 image readme: https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md
- GitHub, actions/setup-dotnet releases: https://github.com/actions/setup-dotnet/releases
- Visual Studio Magazine, WinUI 3 Gallery 2.9 and Windows App SDK 2.0: https://visualstudiomagazine.com/articles/2026/05/01/winui-3-gallery-2-9-highlights-windows-app-sdk-2-0-for-app-developers.aspx
