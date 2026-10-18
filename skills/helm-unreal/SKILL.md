---
name: helm-unreal
description: Craft standards for Unreal Engine 5 work done by agents from a terminal (project layout, C++ over Blueprints, modules, reflection, headless builds with UnrealBuildTool and RunUAT BuildCookRun, commandlets and Python editor scripting, automation tests, source control with Git LFS, performance, mobile and Windows targets, engine pinning and evidence). Use when you are a Helm lead, Core builder or platform builder in a project whose tools include unreal.
---

# Helm Unreal Craft

This skill covers what excellent Unreal Engine 5 work looks like when the only interface is a terminal. `helm-specialist` covers how you work inside Helm. Excellent work here means: gameplay logic in C++ and data that diff cleanly, Blueprints kept thin, a project that builds, cooks and packages headless from a script anyone can run, automation tests that run with no GPU and exit with a real status code, binary assets tracked in Git LFS with locks, and evidence (build logs, test reports, packaged paths, screenshots) at known paths. Game design, the frame budget, saves and monetization rules are in `helm-game`; asset sources and budgets are in `helm-assets`.

Unreal changes between minor versions. Before relying on a flag, API or plugin, check it against the installed engine: its `--help`/`-help` output, its source headers (the engine ships with source headers under `Engine/Source`), or Epic's documentation for that version. Do not claim exact version numbers you have not read from the machine.

---

## 1. Find the engine and pin the version

- **Locate the engine root** (the folder containing `Engine/`). Typical installs come from the Epic Games Launcher or a source build. Record its absolute path in a gitignored local file or environment variable (for example `UE_ROOT`), never in committed scripts. Committed scripts read `$UE_ROOT`.
- **Read the version** from `$UE_ROOT/Engine/Build/Build.version` (JSON with major, minor, patch) and record it in ARCHITECTURE.md and your `ENV.txt`.
- **Pin it in the project.** The `.uproject` file has `"EngineAssociation"`: a version string such as `"5.x"` for launcher builds, or a GUID for a registered source build. Keep it set to the version the project was built with and do not bump it without the lead and a `DECISIONS.md` entry; upgrading the engine is a major-version change that needs `helm_need`.
- **Not installed?** Report `blocked` and ask with `helm_need` (about: `access`). The engine download requires an Epic account the human controls.
- **License note for the human.** Unreal is used under the Epic Games EULA. Games commercially released have historically owed Epic a royalty on gross revenue above a per-product threshold, and non-game commercial use by larger companies has a seat-based license. Terms change: put a one-line note in your report telling the human to review the current EULA, and do not make licensing decisions yourself.

---

## 2. Project layout

```
<Project>/
  <Project>.uproject          # modules, plugins, EngineAssociation (JSON, committed)
  Config/                     # DefaultEngine.ini, DefaultGame.ini, DefaultInput.ini, DefaultEditor.ini, ...
  Source/
    <Project>.Target.cs       # game target
    <Project>Editor.Target.cs # editor target
    <Project>/                # primary runtime module
      <Project>.Build.cs
      Public/  Private/
    <Project>Tests/           # optional test-only module (editor or developer type)
  Content/                    # .uasset / .umap (binary, Git LFS)
  Plugins/<Plugin>/           # project plugins, each with its own .uplugin and Source/
  Build/                      # platform build config and icons (committed where used)
  Binaries/ Intermediate/ Saved/ DerivedDataCache/   # generated, never committed
```

- **Keep folders predictable under `Content/`:** `Content/<Project>/Core`, `/Characters`, `/Maps`, `/UI`, `/Data`, `/Audio`. The Asset builder owns imported art (`game/Content/**` in many layouts); you own data assets and maps your task names. Agree on the layout in ARCHITECTURE.md.
- **Config is text and reviewable.** Put project settings in `Config/Default*.ini`, not in per-user `Saved/Config`. Comment non-obvious settings.
- **Prefer project plugins for reusable systems.** A plugin with its own module has a clean dependency boundary and can be tested on its own.

---

## 3. C++ first, Blueprints thin

Blueprints are binary `.uasset` files: they do not diff, cannot be reviewed in a pull request, and cannot be edited reliably by an agent. So:

- **Write gameplay logic, systems and rules in C++.** Expose a small, intentional surface to Blueprint (`BlueprintCallable`, `BlueprintPure`, `BlueprintImplementableEvent`, `BlueprintNativeEvent`) for designers and for wiring assets.
- **Blueprints only for configuration and presentation:** subclass a C++ class to set mesh, material, sound and tuning defaults. Blueprint graphs stay short (event to C++ call). If a Blueprint graph grows logic, move it to C++.
- **Tuning lives in data:** `UDataAsset` / `UPrimaryDataAsset`, `UDataTable` rows (`FTableRowBase` structs imported from CSV or JSON), curve assets, and `UDeveloperSettings` classes that appear in Project Settings and save to `Config/`.
- **Never claim you edited a Blueprint graph.** If a task truly needs one, create or update it through Python editor scripting (section 7) for the parts that API supports, or ask the lead to route it to the human. Say exactly what was and was not done.

---

## 4. Modules, Build.cs and Target.cs

- **One primary game module,** plus extra modules only for real boundaries (editor-only tools, tests, a reusable plugin). Each module has `<Module>.Build.cs`:

```csharp
using UnrealBuildTool;

public class MyGame : ModuleRules
{
    public MyGame(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine", "InputCore", "EnhancedInput" });
        PrivateDependencyModuleNames.AddRange(new string[] { });
    }
}
```

- **Public vs private dependencies:** public only if your public headers include that module's types. Everything else private. Fewer public dependencies means faster builds.
- **Editor-only code** goes in a module of type `Editor` in the `.uproject` (or behind `#if WITH_EDITOR`), never in the runtime module, or packaging fails.
- **Target files** define build targets. A game target sets `Type = TargetType.Game`, an editor target `TargetType.Editor`, and both list the modules with `ExtraModuleNames.Add("MyGame")`. Set `DefaultBuildSettings` and `IncludeOrderVersion` to the values the engine's own template uses for the installed version (copy them from a fresh template project rather than guessing).
- **New modules and plugins** must be registered in the `.uproject` or `.uplugin` (`Modules` array with `Name`, `Type`, `LoadingPhase`) or they will not load.

---

## 5. Reflection and UE C++ rules

UnrealHeaderTool (UHT) parses reflection macros before compilation. Mistakes show up as UHT errors, not compiler errors.

- **Every reflected type** has its macro and `GENERATED_BODY()`: `UCLASS()`, `USTRUCT(BlueprintType)`, `UENUM(BlueprintType)`, `UINTERFACE()`. The `#include "<File>.generated.h"` is the last include in the header.
- **Naming prefixes are required by UHT:** `U` for UObject-derived classes, `A` for actors, `F` for structs and plain classes, `E` for enums, `I` for interfaces, `T` for templates.
- **Garbage collection:** pointers to UObjects held by UObjects must be `UPROPERTY()` (use `TObjectPtr<T>` for member pointers in UE5) or the GC can free them under you. Use `TWeakObjectPtr` for non-owning references, `TSoftObjectPtr` / `TSoftClassPtr` for assets loaded on demand.
- **Use engine types:** `FString`, `FName`, `FText` (for anything shown to players, so it can be localized), `TArray`, `TMap`, `TSet`. Avoid raw `new`/`delete` for UObjects; use `NewObject<T>()` and `SpawnActor<T>()`.
- **Specifiers:** `UPROPERTY(EditDefaultsOnly, BlueprintReadOnly, Category="Combat")` for tuning; `EditAnywhere` only when per-instance edits make sense. `UFUNCTION(BlueprintCallable, Category="Inventory")`.
- **Tick sparingly.** Disable `PrimaryActorTick.bCanEverTick` unless needed; prefer timers, events and delegates. Put cross-actor systems in subsystems (`UWorldSubsystem`, `UGameInstanceSubsystem`).
- **Gameplay framework:** game rules in `AGameModeBase` (server only), replicated match state in `AGameStateBase`, per-player replicated state in `APlayerState`, input and UI ownership in `APlayerController`. Use Enhanced Input for input (Input Actions plus Mapping Contexts).
- **Replication** (if multiplayer): `bReplicates`, `UPROPERTY(Replicated)` or `ReplicatedUsing=OnRep_X` with `GetLifetimeReplicatedProps`, `UFUNCTION(Server, Reliable)` RPCs that validate input. The server is authoritative; never trust a client RPC's numbers.
- **Logging:** declare a log category per module (`DECLARE_LOG_CATEGORY_EXTERN` / `DEFINE_LOG_CATEGORY`) and use `UE_LOG(LogMyGame, Warning, TEXT(...))`. Remove ad-hoc on-screen debug messages before reporting done.

---

## 6. Building headless

The editor holds module binaries open. **Close the editor (and disable Live Coding for the session) before building from the terminal,** or the build fails or writes patch binaries.

**Generate project files** (only needed for IDE use or after adding modules; UBT builds without them):

```bash
# macOS
"$UE_ROOT/Engine/Build/BatchFiles/Mac/GenerateProjectFiles.sh" -project="$PWD/MyGame.uproject" -game
# Windows (cmd)
"%UE_ROOT%\Engine\Build\BatchFiles\GenerateProjectFiles.bat" -project="%CD%\MyGame.uproject" -game
```

**Compile targets with UnrealBuildTool through the batch scripts.** The arguments are target name, platform, configuration, then options:

```bash
# macOS editor build (needed before running editor commandlets or tests)
"$UE_ROOT/Engine/Build/BatchFiles/Mac/Build.sh" MyGameEditor Mac Development \
  -Project="$PWD/MyGame.uproject" -WaitMutex 2>&1 | tee reports/unreal/build-editor-mac.log

# Linux
"$UE_ROOT/Engine/Build/BatchFiles/Linux/Build.sh" MyGameEditor Linux Development -Project="$PWD/MyGame.uproject" -WaitMutex

# Windows
"%UE_ROOT%\Engine\Build\BatchFiles\Build.bat" MyGameEditor Win64 Development -Project="%CD%\MyGame.uproject" -WaitMutex
```

Configurations: `Debug`, `DebugGame`, `Development`, `Test`, `Shipping`. Platform names used by UBT and UAT: `Win64`, `Mac`, `Linux`, `IOS`, `Android`.

**Package with RunUAT BuildCookRun.** This builds the game target, cooks content for the platform, stages files, packs them into `.pak` files and archives the result:

```bash
"$UE_ROOT/Engine/Build/BatchFiles/RunUAT.sh" BuildCookRun \
  -project="$PWD/MyGame.uproject" -noP4 -utf8output -unattended \
  -platform=Mac -clientconfig=Development \
  -build -cook -stage -pak -archive -archivedirectory="$PWD/build/Mac" \
  2>&1 | tee reports/unreal/package-mac.log
```

On Windows use `RunUAT.bat` with `-platform=Win64`. Common additions: `-clientconfig=Shipping` for release builds, `-nocompileeditor` when the editor is already built, `-iterate` for incremental cooks, `-allmaps` or `-map=/Game/Maps/Level1` to choose maps (the project's Maps to Cook list in packaging settings is the better place). `-server -serverconfig=Development` adds a dedicated server build when the project has a server target. Check `RunUAT.sh BuildCookRun -help` on the installed engine before adding anything else.

Rules:
- **Script it.** Put the exact commands in `Build/Scripts/build.sh` (and `.bat`), reading `UE_ROOT` from the environment, so CI and other builders run identical steps.
- **Check the exit code and the log.** UAT ends with a line reporting success or failure and an exit code; a pipe through `tee` hides the exit code unless you use `set -o pipefail`. Search the log for `error` lines and cite the log path.
- **Cook warnings matter.** Missing references, failed asset loads and "redirector" warnings become runtime bugs. Fix or list them.
- **Shipping builds strip** console commands, `UE_LOG` below a threshold and stats; test at least once in Shipping before claiming release readiness.

---

## 7. Commandlets and Python editor scripting

The editor runs headless with `-run=<Commandlet>`. On Windows use `UnrealEditor-Cmd.exe` from `Engine/Binaries/Win64` (it writes to the console). On macOS and Linux use the editor binary under `Engine/Binaries/<Platform>/` (check which `UnrealEditor` or `UnrealEditor-Cmd` executable exists in your install). Below, `$UE_EDITOR` stands for that binary.

```bash
# Resave packages (fixes outdated package versions; touches many binary files, so coordinate first)
"$UE_EDITOR" "$PWD/MyGame.uproject" -run=ResavePackages -unattended -nosplash

# Compile every Blueprint and report errors (catches Blueprints broken by C++ changes)
"$UE_EDITOR" "$PWD/MyGame.uproject" -run=CompileAllBlueprints -unattended -nosplash
```

Add `-log` or `-abslog="<path>"` to capture output, and keep logs under `reports/unreal/`.

**Python editor scripting** (enable the Python Editor Script Plugin, and Editor Scripting Utilities where your engine version still lists it, in the `.uproject` `Plugins` array):

```bash
# Run a script through the Python commandlet
"$UE_EDITOR" "$PWD/MyGame.uproject" -run=pythonscript -script="$PWD/Build/Scripts/import_assets.py" -unattended -nosplash
```

The `-ExecutePythonScript="<path>"` argument runs a script after the full editor starts, which some APIs need. Use the `unreal` module in scripts:
- **Import assets** with `unreal.AssetImportTask` (set `filename`, `destination_path`, `automated = True`, `replace_existing`, `save = True`) passed to `unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([...])`. Set FBX or glTF import options explicitly rather than relying on dialog defaults.
- **Fill DataTables** from CSV or JSON committed in the repo, so the data source is reviewable text and the `.uasset` is a build product of it.
- **Validate content:** iterate assets with the asset registry and check naming, texture sizes, LOD counts and missing references against the asset budget; write results to `reports/unreal/`.
- Python API names differ between versions. Check the Python API reference for the installed version and test each script on one asset before batch runs.

---

## 8. Automation tests

**Write tests in C++ with the Automation framework.** Put them in a test module or behind `WITH_DEV_AUTOMATION_TESTS`.

- **Automation Spec** for behaviour-style tests: `BEGIN_DEFINE_SPEC(FInventorySpec, "MyGame.Inventory", <flags>)` / `END_DEFINE_SPEC`, then `Define()` with `Describe(...)` and `It(...)` blocks, `TestEqual`, `TestTrue`. Flags combine an application context (for example editor context) with a filter (for example product filter); the exact flag names changed across UE5 versions, so copy them from an engine header or an existing test in your engine version.
- **Simple tests** (`IMPLEMENT_SIMPLE_AUTOMATION_TEST`) for pure logic: damage formulas, inventory rules, save migrations, DataTable validation.
- **Functional tests** (`AFunctionalTest` placed in a test map) for in-world behaviour: spawn, drive inputs, wait, assert, finish with a result. These need a map, which is a binary asset; keep the logic in C++ and the map minimal.
- **Name tests hierarchically** (`MyGame.Combat.Damage.Crit`) so filters select groups.

**Run headless:**

```bash
"$UE_EDITOR" "$PWD/MyGame.uproject" \
  -ExecCmds="Automation RunTests MyGame;Quit" \
  -unattended -nullrhi -nosplash -nosound -log \
  -ReportExportPath="$PWD/reports/unreal/automation" \
  2>&1 | tee reports/unreal/automation.log
```

- `-nullrhi` runs with no GPU, so tests that render or take screenshots must run without it on a machine with a GPU.
- `Automation RunTests <filter>` runs tests whose names start with the filter. `Automation RunAll` exists but runs engine tests too; filter to your project.
- `-ReportExportPath` writes a JSON report (`index.json`) and HTML viewer; commit the JSON or a summary, and cite it.
- **Verify the run actually ran tests.** Count passed and failed tests in the report. A report with zero tests is a failure, not a pass. The editor can exit 0 even when tests fail, so your wrapper script must parse the report and exit non-zero on any failure.

**Gauntlet** (`RunUAT RunUnreal`) orchestrates multi-process tests on packaged builds (client plus server, devices, performance captures). Use it only when the SPEC needs packaged-build or multi-device testing and the lead has agreed the setup; it needs per-project test configuration in C#.

---

## 9. Source control

- **Git LFS for binaries.** In `.gitattributes`: `*.uasset filter=lfs diff=lfs merge=lfs -text` and the same for `*.umap`, plus raw source art types the Asset builder commits (`*.fbx`, `*.png`, `*.wav`, and so on). Set it up before the first binary commit; migrating later rewrites history (needs `helm_need`).
- **Locks for unmergeable files.** Mark `*.uasset` and `*.umap` as `lockable` in `.gitattributes` and use `git lfs lock <path>` before editing, `git lfs unlock` after merging. If the LFS server does not support locking, agree file ownership per builder in ARCHITECTURE.md and message siblings before touching a shared asset.
- **`.gitignore`** must exclude `Binaries/`, `Intermediate/`, `Saved/`, `DerivedDataCache/`, `.vs/`, `.idea/`, generated `*.sln` / `*.xcworkspace`, and the same folders inside each plugin (`Plugins/*/Binaries/`, `Plugins/*/Intermediate/`).
- **One editor at a time per binary asset.** Two branches editing the same `.uasset` produce a conflict nobody can merge; one side's work is lost. Plan maps with World Partition and One File Per Actor where suitable so builders touch different files.
- **Redirectors.** Moving or renaming assets leaves redirector files. Fix them up (the editor's Fix Up Redirectors, or `ResavePackages` with the redirector option for your version) in a dedicated commit, coordinated with siblings.
- **LFS storage and bandwidth** on hosted git can cost money; large projects may need a paid plan or a different server, which is a `helm_need` (about: `spending`).

---

## 10. Performance and scalability

Budgets come from ACCEPTANCE and `helm-game` (16.6 ms at 60 fps, 33.3 ms at 30).

- **Read the frame first:** `stat unit` shows Frame, Game (game thread), Draw (render thread), GPU and RHIT times; the largest one is the bottleneck. `stat fps`, `stat gpu`, `stat scenerendering` and `stat memory` narrow it down.
- **Unreal Insights for traces.** Launch the game or editor with tracing on (for example `-trace=default` or `-trace=cpu,gpu,frame,bookmark` and `-tracefile=<path>.utrace`), reproduce, and open the trace in Unreal Insights. Commit a summary (top costs, frame-time percentiles), not multi-gigabyte traces.
- **CSV profiler** for frame-time logs across a run (`csvprofile start` / `csvprofile stop` console commands); commit the CSV to `reports/unreal/`.
- **Scalability settings** (`sg.ViewDistanceQuality`, `sg.ShadowQuality`, `sg.PostProcessQuality`, and others, levels 0 to 3 or more) and device profiles (`Config/DefaultDeviceProfiles.ini`) map hardware tiers to settings. Ship sensible defaults per tier and expose quality options to players on desktop.
- **Rendering features have costs.** Lumen, Nanite and virtual shadow maps target desktop and console-class GPUs. Mobile uses the mobile renderer with its own feature set; decide per platform in ARCHITECTURE.md and test on the target.
- **Common wins:** fewer ticking actors, pooled projectiles, HLODs and culling distances, instanced static meshes for repeated props, texture streaming budgets, fewer dynamic lights and shadow casters on mobile.

---

## 11. Platforms

- **Mac:** builds and packages on macOS with Xcode installed. Distribution outside development needs signing and notarization with an Apple developer account (human-only, `helm_need` about `credentials`).
- **Windows (`Win64`):** packaging requires a Windows host or a Windows CI runner with Visual Studio and the engine installed. If you are on macOS or Linux, write the CI workflow (ask the lead if `.github/**` is not yours) and state "Windows: verified by CI only" or "not verified".
- **Linux:** native builds on Linux; cross-compiling from Windows uses Epic's cross-compile toolchain for the engine version.
- **Android:** needs Android Studio, a specific SDK, NDK and JDK combination for the engine version (see the engine's Android setup docs and the setup script under `Engine/Extras/Android`). Debug builds can use a debug keystore; the release keystore and the Play Console account are human-provided.
- **iOS:** needs a Mac with Xcode, and for device builds a signing identity and provisioning profile. Signing identities, certificates and App Store Connect access are human-only: ask once with `helm_need` and keep building for targets you can.
- **Consoles** need platform developer agreements and NDA SDKs; do not attempt them without explicit human setup.
- **Store and platform accounts** (Steam, Epic Games Store, Apple, Google) are human-only.

---

## 12. Pitfalls agents fall into

- **Building with the editor open** or Live Coding active, then reporting a stale binary as current.
- **Logic in Blueprints** that no reviewer can read, or claiming Blueprint edits that never happened.
- **Missing `UPROPERTY()` on UObject pointers,** leading to random crashes after garbage collection.
- **Editor-only code in runtime modules,** which compiles in the editor and fails at packaging.
- **Unverified UAT flags** from old forum posts. UE4-era names (`UE4Editor`, `UE4Editor-Cmd`) do not exist in UE5.
- **Tests that never ran:** a wrong filter, a missing test module, or `-nullrhi` with rendering tests, reported as "all passed".
- **Committing `Binaries/`, `Intermediate/`, `Saved/` or `DerivedDataCache/`,** or binary assets without LFS.
- **Engine version drift:** opening the project in a newer engine silently upgrades assets so the old engine can no longer load them.
- **HighResShot under `-nullrhi`** produces nothing; screenshots need a real RHI.

---

## Done means

**Project**
- [ ] Engine version read from `Build.version`, recorded in ARCHITECTURE.md and `ENV.txt`, and matched by `EngineAssociation`.
- [ ] Layout follows section 2; modules registered; editor code isolated; public dependencies minimal.
- [ ] Logic in C++ with a deliberate Blueprint surface; tuning in data assets, DataTables (from committed CSV/JSON) or developer settings.

**Build**
- [ ] Editor and game targets compile headless from a committed script reading `UE_ROOT`; logs show no errors.
- [ ] BuildCookRun packages every platform this machine can build; cook warnings fixed or listed; other platforms marked "verified by CI only" or "not verified".
- [ ] Shipping configuration built at least once before claiming release readiness.

**Tests**
- [ ] Automation tests (spec, simple, functional as needed) run headless with a filter, report exported, test count above zero, wrapper exits non-zero on failure.
- [ ] `CompileAllBlueprints` clean after C++ changes that Blueprints depend on.

**Repo and platforms**
- [ ] Git LFS and `.gitattributes` cover binaries; locks or ownership agreed; `.gitignore` excludes generated folders.
- [ ] Signing, store, engine-download and LFS-plan needs raised once via `helm_need`; nothing secret committed.
- [ ] Performance measured with `stat unit`, CSV profiler or Insights against ACCEPTANCE budgets.
- [ ] EULA note included in the report for the human.
- [ ] `helm_slop_scan` clean on your files.

## Evidence to commit

Under `reports/unreal/` (for example `reports/unreal/<task>/`):
- `build-<target>-<platform>.log` and `package-<platform>.log` (trimmed to summary and errors if huge), plus a `packages.md` listing each packaged build path, configuration, size and commit.
- `automation/index.json` (or a summary of it) and `automation.log`, with passed, failed and total counts stated in your report.
- `compile-blueprints.log` when C++ changes touch exposed APIs.
- Screenshots taken with `HighResShot` (for example `HighResShot 1920x1080` via `-ExecCmds` on a machine with a GPU) copied from `Saved/Screenshots/` into `reports/unreal/screens/` with descriptive names.
- Performance captures: CSV profiler output and a short `perf.md` with frame-time percentiles per scene and device.
- `ENV.txt`: engine version and root type (launcher or source), OS, Xcode or Visual Studio version, SDK versions for mobile, and the exact commands run.

## Sources

- Unreal Engine documentation: https://dev.epicgames.com/documentation/en-us/unreal-engine
- Unreal Build Tool: https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-build-tool-in-unreal-engine
- Build operations, cooking, packaging and staging: https://dev.epicgames.com/documentation/en-us/unreal-engine/build-operations-cooking-packaging-deploying-and-running-projects-in-unreal-engine
- Automation test framework: https://dev.epicgames.com/documentation/en-us/unreal-engine/automation-test-framework-in-unreal-engine
- Automation Spec: https://dev.epicgames.com/documentation/en-us/unreal-engine/automation-spec-in-unreal-engine
- Scripting the editor using Python: https://dev.epicgames.com/documentation/en-us/unreal-engine/scripting-the-unreal-editor-using-python
- Unreal Insights: https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-insights-in-unreal-engine
- Gauntlet automation framework: https://dev.epicgames.com/documentation/en-us/unreal-engine/gauntlet-automation-framework-in-unreal-engine
- Epic C++ coding standard: https://dev.epicgames.com/documentation/en-us/unreal-engine/epic-cplusplus-coding-standard-for-unreal-engine
- Unreal Engine EULA: https://www.unrealengine.com/eula
- Unreal Engine licensing FAQ: https://www.unrealengine.com/faq
- Git LFS: https://git-lfs.com/
- Git LFS file locking: https://github.com/git-lfs/git-lfs/wiki/File-Locking
