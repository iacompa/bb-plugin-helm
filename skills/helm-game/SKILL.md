---
name: helm-game
description: Game craft (engine, core loop, frame budget, input, saves, audio, mobile performance, headless builds, gameplay evidence). Use when you build a Helm game.
---

# Helm Game Craft

This skill covers what excellent game work looks like. `helm-specialist` covers how you work inside Helm. Excellent game work means a small loop that is fun and correct before it is big, systems that are deterministic where they need to be, content that lives in data rather than code, a frame budget that is measured rather than hoped for, and evidence a gate can check without playing the game: tests that exited 0, frame-time logs, screenshots and capture from a known commit.

Your default scope is `game/**` and `packages/core/**` (the lead sets the exact layout in ARCHITECTURE.md). You own gameplay and systems: rules, simulation, state, saves, input mapping, audio wiring, the build. The UI builder owns menus and the HUD, the Asset builder owns models, textures, sprites and audio files, and platform builders own store packaging and platform integration. If the project tools include `unreal`, also follow `helm-unreal`; if the project needs assets, coordinate with the builder who follows `helm-assets`.

---

## 1. Pick the engine and write it down

**The engine named in the project tools wins.** If tools list `unreal`, `unity` or `godot`, use it. Do not switch engines because another seems easier; raise it with the lead if the choice looks wrong for the SPEC.

When nothing is named, the lead (or you, as solo lead) picks using these defaults and records the decision in ARCHITECTURE.md with the reason, the current stable version installed on the machine, and the target platforms:

| Game | Default engine | Why |
|---|---|---|
| High-end 3D for desktop or console | Unreal Engine 5 | Rendering, tooling, console support. C++ and data; see `helm-unreal`. |
| Cross-platform 2D or 3D, mobile first | Unity or Godot | Mature mobile export, large ecosystems. Godot is MIT licensed with no fees; Unity has license tiers and requires a signed-in license. |
| Apple platforms only | SpriteKit (2D) or RealityKit (3D/AR) | Native, no third-party runtime. SceneKit is deprecated by Apple as of 2025; do not start new 3D work in it. |
| Browser games | Phaser or PixiJS (2D), three.js or Babylon.js (3D) | Ships as static files, testable with Node tooling and a headless browser. |

Rules:
- **Check the tool before you commit to it.** Run `godot --version`, `blender --version`, or locate the Unity or Unreal install. If the engine is not installed or not licensed on this machine, say so in `helm_report` (status `blocked`) and ask for it with `helm_need` (about: `access`). Do not silently fall back to a different engine.
- **Record the engine version and pin it.** Unity: `ProjectSettings/ProjectVersion.txt`. Godot: `config/features` in `project.godot` plus the version in ARCHITECTURE.md. Web: exact versions in `package.json` with the lockfile committed. Unreal: `EngineAssociation` in the `.uproject`.
- **License costs are a human decision.** Unity seat or runtime terms, Unreal royalties, paid asset store packages and paid middleware all go through `helm_need` (about: `spending`). Note the terms in DECISIONS.md via the lead.
- **Engine-agnostic core where it pays.** For web, Apple and Godot games, keep pure rules (combat math, economy, progression, level generation) in `packages/core/` as plain code with no engine imports, so they can be unit-tested headless. In Unity and Unreal, put the same logic in plain C# classes or plain C++ / `UObject`-free structs inside the engine project.

---

## 2. Core loop first, then a vertical slice

**Build the loop before the content.** The core loop is the 10 to 60 second cycle the player repeats (aim, shoot, collect, upgrade; or match, clear, score). Ship it as a playable prototype with primitive shapes before any menus, art or progression.

- **Greybox first.** Cubes, capsules and flat colours from the engine's primitives. Real assets arrive from the Asset builder through the pipeline in section 9; do not block on them.
- **Then a vertical slice:** one level or one session from start screen to fail or win state to results, at target quality on the target platform, with the frame budget met. A vertical slice proves the whole pipeline (input, loop, save, audio, HUD, build) works end to end.
- **Breadth after the slice.** More levels, enemies and items are data added to working systems (section 7), not new code paths.
- **Every milestone is playable.** Never leave the main branch with a game that does not boot to a playable state. Feature flags in config beat half-wired code.
- **Tuning values are data.** Speeds, health, cooldowns, spawn rates and prices live in config or data assets so a designer (or the lead) can tune without touching code.

---

## 3. Game design sections in SPEC

Games need design detail an app SPEC does not. If these sections are missing or vague, raise it with the lead before building. As solo lead, write them yourself. Each section should be specific enough to test:

- **Core loop:** the verbs, the cycle, the session length, and what makes the player want another round.
- **Controls:** every action mapped per input device (touch, controller, keyboard and mouse), with defaults and which are rebindable.
- **Progression:** levels, unlocks, XP curves, difficulty ramp, as tables or formulas.
- **Economy:** every currency, every source and sink, prices, and the expected earn rate per session. If real money is involved, list what is sold and how (section 11).
- **Fail and win states:** what ends a run, what the player keeps, how retry works, and how long from fail to playing again (aim for under 3 seconds).
- **Accessibility:** remapping, subtitles and captions with speaker labels, text size, colour-blind safe signalling (never colour alone), screen shake and flash toggles, hold-versus-toggle options, difficulty or assist options. Follow the Game Accessibility Guidelines and avoid flashing above 3 Hz.
- **Platforms and performance targets:** target devices (including the minimum spec), frame rate, resolution, load times, memory and install size. These become ACCEPTANCE budgets.
- **Content list:** levels, enemies, items and the assets each needs (the Asset builder turns this into the asset list with budgets).

---

## 4. Time, frames and determinism

**Know your frame budget.** 60 fps gives 16.6 ms per frame for everything: simulation, rendering, audio and the OS. 30 fps gives 33.3 ms. 120 Hz displays give 8.3 ms. Budget simulation to a fraction of the frame (for example 4 ms of 16.6) and measure it.

**Fixed timestep for simulation, variable for rendering.**
- Run physics and gameplay rules at a fixed step (for example 60 Hz or 50 Hz) using an accumulator: add the real frame delta to an accumulator, step the simulation in fixed increments while the accumulator holds at least one step, then render with interpolation between the last two states using the leftover fraction.
- Clamp the frame delta (for example to 250 ms) so a hitch or a breakpoint does not trigger a "spiral of death" of catch-up steps.
- Engines already provide this: Unity `FixedUpdate` (set in Time settings), Godot `_physics_process` (physics ticks per second in Project Settings), Unreal ticks with variable delta and optional physics substepping. Put physics and rules in the fixed path, presentation in the variable path.
- **Multiply by delta time** in every variable-rate update. Movement that ignores delta runs at different speeds on 60 Hz and 120 Hz screens.

**Determinism where multiplayer or replays need it.**
- Same inputs plus same seed must produce the same state. Drive simulation only from inputs and a seeded PRNG that you own (not the engine's global random, not `Math.random()`).
- Never iterate unordered hash maps or sets in simulation code; iteration order can differ between runs. Sort or use ordered containers.
- Floating point is not reliably identical across compilers, CPUs and platforms. For cross-platform lockstep, use fixed-point maths or integer simulation; for same-binary replays, floats are usually fine but test it.
- Keep wall-clock time, frame rate and rendering out of simulation. The simulation takes a tick number, not `now()`.
- Record a replay as seed plus per-tick inputs. A replay that diverges is a bug, and a replay test catches it (section 14).

---

## 5. Input

- **Map actions, not keys.** Code reads `Jump`, `Fire`, `Move` from an action map; bindings live in data. Unity: the Input System package with an Input Actions asset. Godot: the Input Map with named actions. Unreal: Enhanced Input (Input Actions and Mapping Contexts). Web: a small action map over keyboard, Pointer Events and the Gamepad API.
- **Support every device the SPEC lists:** touch (virtual stick or gestures, with targets at least 44 pt / 48 dp, and no essential action in the screen corners covered by system gestures), controller (handle connect and disconnect mid-game, show the right glyphs for the connected pad), keyboard and mouse (pointer lock where needed).
- **Rebinding is required on desktop and console,** saved to the settings file, with conflict detection and a reset to defaults. On touch, offer layout and size options where the SPEC asks.
- **Buffer and forgive.** Short input buffers (for example 100 ms for a jump pressed just before landing) and coyote time make games feel responsive. Put the values in data.
- **Pause on focus loss** and on controller disconnect. Mobile: pause on interruption (calls, notifications, backgrounding) and save state there.
- **Measure input latency** when the SPEC cares about feel: time from input event to the first frame that shows the response, in the frame-time log.

---

## 6. Scenes, levels and structure

- **One scene or level per screen or level,** loaded by a small scene or level manager that owns transitions, loading screens and unloading. No gameplay code that assumes a particular scene is already loaded.
- **Keep systems decoupled.** Systems talk through events or signals, or through an explicit service owned by the game root, not through global singletons that reach into each other. Unity: plain C# services and ScriptableObject event channels. Godot: signals and a few autoloads with narrow jobs. Unreal: subsystems (`UGameInstanceSubsystem`, `UWorldSubsystem`) and delegates.
- **Pool frequently spawned objects** (bullets, particles, enemies) instead of allocating and destroying every frame. Garbage collection spikes in C# and JavaScript show up as frame hitches.
- **Async loading** for anything that takes more than a frame. A level load must not freeze input or audio; show progress.
- **Scene files merge badly.** Unity scenes and prefabs (force text serialization in Editor settings), Godot `.tscn` (text, merge-friendly), Unreal `.umap` and `.uasset` (binary, lock them). Agree with siblings who edits which scene, or split levels into sub-scenes or World Partition cells so builders do not collide.

---

## 7. Data-driven content

**Content is data; code is systems.** Adding an enemy, item or level should not need a code change.

- **Unity:** ScriptableObjects for definitions (enemy stats, item tables, level configs), addressables or `Resources` only where needed. `Resources` loads everything in the folder into the build; prefer Addressables for large content.
- **Unreal:** `UDataAsset` / `UPrimaryDataAsset` for definitions, `UDataTable` with an `FTableRowBase` struct for tabular data imported from CSV or JSON, curves for tuning. See `helm-unreal`.
- **Godot:** custom `Resource` classes saved as `.tres` (text), plus JSON or CSV for large tables.
- **Web and Apple:** JSON files validated at load against a schema, with types generated from or checked against the schema.

Rules:
- **Validate content at load and in tests.** Every definition is checked for missing references, out-of-range values and duplicate IDs. A test loads every content file and fails on any error.
- **Stable IDs, not names or indices.** Saves and network messages reference content by a stable string or GUID that never changes once shipped.
- **No fake content on shipped paths.** Debug levels, cheat menus and test items go in debug-only folders or build configurations, stripped from release builds. The Slop Hunter checks this.

---

## 8. Save data and settings

Lost saves are the bug players never forgive.

- **Versioned format.** Every save has a `version` field. Load runs migrations from any older version to the current one, tested with fixture saves from each released version.
- **Atomic writes.** Write to a temporary file in the same directory, flush, then rename over the old file. Keep the previous save as a backup and fall back to it if the current one fails to parse or fails its checksum.
- **Small and explicit.** Save the minimal state that rebuilds the game (IDs, counters, positions), not serialized engine objects. Never save engine object references, pointers or scene paths that can change.
- **Save at safe points** (checkpoints, level end, backgrounding on mobile, quitting) and never mid-write on a crash path. Autosave must not cause a frame hitch: serialize on the main thread if required, write on a background thread.
- **Platform paths:** Unity `Application.persistentDataPath`, Godot `user://`, Unreal `Saved/SaveGames` via `USaveGame`, web IndexedDB (localStorage is small and synchronous).
- **Cloud save** (iCloud, Google Play Games Saved Games, Steam Cloud, a custom backend) needs a developer account and configuration, which only the human can provide: ask with `helm_need` (about: `access` or `credentials`) and keep local saves working meanwhile. Define a conflict rule (newest by play time, or let the player choose) and test it.
- **Settings are separate from progress** (audio volumes, bindings, graphics quality, accessibility) so resetting one never wipes the other.
- **Tamper resistance is a design choice.** Single-player saves can be plain; anything that grants paid or competitive value must be validated server-side, not trusted from the client.

---

## 9. Audio, UI/HUD and asset handoffs

**Audio.**
- Route sounds through buses (master, music, effects, voice, UI) with player-facing volume sliders per bus, saved in settings.
- Limit concurrent voices per sound and overall; prioritize important sounds. Spatialize 3D sounds with sensible attenuation.
- Duck music under voice. Music loops must be seamless (the Asset builder delivers loop points). Subtitles cover all voice and important sound cues (section 3).
- Stream long music; load short effects into memory. Pause or mute when the app is backgrounded.

**UI and HUD handoff.** The UI builder owns menus, HUD layout, fonts and visual design. You own the data the HUD shows. Expose it through a narrow, documented interface (an observable game state or events such as `HealthChanged`, `ScoreChanged`), list it in CONTRACT.md via the lead, and never put game rules in UI code. Agree pause and focus behaviour (who pauses the simulation when a menu opens).

**Asset handoff.** The Asset builder owns source and exported assets under its scope. You agree with them on: folder and naming conventions, units and scale, pivot conventions, collision shapes, animation names and events, and which engine import settings apply. Reference assets by path or ID from data, never hard-code them in scattered code. If an asset breaks a budget or imports wrong, message the Asset builder with the file and the measured number; do not fix their files yourself.

---

## 10. Performance, especially on mobile

Set budgets in ACCEPTANCE (frame time, memory, load time, install size, draw calls) and measure on the minimum target device or the closest available proxy.

- **Frame time, not fps.** Log per-frame CPU and GPU time and report p50, p95 and p99 plus the share of frames over budget. Averages hide hitches.
- **Draw calls and batching.** Batch static geometry, use texture atlases and shared materials, use GPU instancing for repeated meshes. Low-end mobile wants draw calls in the low hundreds or fewer; set the number in ACCEPTANCE.
- **Overdraw** is the usual mobile GPU killer: large transparent particles, stacked UI panels, full-screen effects. Use the engine's overdraw view and trim alpha areas.
- **Texture memory.** Compressed formats per platform (ASTC on modern mobile), mipmaps on 3D textures, sizes matched to on-screen size. The Asset builder owns the files; you own the import settings policy if it lives in code.
- **Allocation.** No per-frame allocations in hot paths (C#, JavaScript, GDScript). Pool, reuse buffers, avoid LINQ and closures in `Update`.
- **Thermal throttling and battery.** Phones throttle after minutes of sustained load. Run a soak of at least 20 to 30 minutes on device and log frame time over the whole run. Cap the frame rate (30 or 60 per SPEC, not unlimited), lower the rate in menus, and offer a battery-saver option where the SPEC allows.
- **Load times and install size.** Measure cold start to first interactive frame, and the size of the packaged build per platform.
- **Tools:** the engine profiler (Unity Profiler and Frame Debugger, Godot debugger monitors and profiler, Unreal Insights), Xcode Instruments on iOS, Android GPU Inspector and Perfetto on Android, browser performance tools for web games.

---

## 11. Monetization rules

If the game takes money or shows ads, these are non-negotiable. Real charges, store fees and ad network accounts need the human (`helm_need`, about: `spending` or `credentials`); build against sandbox or test modes meanwhile.

- **Digital goods use the store's billing.** In-app purchases of currency, items, levels and subscriptions in iOS and Android games use StoreKit and Google Play Billing. Provide Restore Purchases on iOS. Validate receipts server-side when purchases grant lasting or competitive value. Never ship test product IDs or a fake "purchase succeeded" path.
- **Ads need consent.** In the EEA and UK, show a consent dialog from a certified consent management platform before personalized ads. On iOS, App Tracking Transparency governs access to the advertising identifier. Ads must not interrupt gameplay unexpectedly, must have a visible close, and rewarded ads must be optional and deliver the reward.
- **Children.** If the audience includes children, follow the store's kids or families policy and laws such as COPPA: no behavioural advertising, no external links or purchases without a parental gate. The human decides the audience; ask if the SPEC is unclear.
- **No pay-to-win dark patterns.** No fake scarcity timers, no confusing multi-layer currencies designed to hide real prices, no pressure prompts after failure, no pre-ticked purchases. Show real-money prices clearly. Treat this as a product rule and say so in your report if the SPEC asks for any of it.
- **Loot boxes and random paid rewards.** Apple and Google require the odds to be disclosed before purchase. Some countries restrict or regulate paid random rewards (Belgium treats them as gambling; several jurisdictions require published probabilities; rating boards label them). Laws change: list the target regions, record the decision in DECISIONS.md via the lead, and ask the human with `helm_need` (about: `other`) before shipping any paid random reward.

---

## 12. Multiplayer basics (only when the SPEC needs it)

Multiplayer multiplies every cost. Confirm it is in the SPEC (need `multiplayer`) before building any of it.

- **Authoritative server.** The server owns game state and validates every client action. Clients send inputs or intents, not results ("I pressed fire at tick 1042", not "I hit player 3 for 50").
- **Client prediction and reconciliation.** The client applies its own inputs immediately, keeps a buffer of unacknowledged inputs, and when the server state arrives, rewinds to it and replays pending inputs. Other players are interpolated between past snapshots.
- **Lag compensation.** For hit detection, the server rewinds other players to where the shooter saw them (within a capped window) before testing the hit.
- **Tick rate and bandwidth.** Pick a server tick rate (for example 20 to 60 Hz), send deltas, quantize floats, and set a bandwidth budget per client in ACCEPTANCE.
- **Matchmaking and sessions.** Use the platform or a service where possible (Steamworks, Epic Online Services, Google Play Games, Game Center, Nakama, the engine's own services). Define what happens on disconnect and rejoin.
- **Anti-cheat basics.** Never trust the client for damage, currency, position limits or cooldowns. Rate-limit actions, sanity-check movement speed, keep secrets and economy logic on the server, and log anomalies. Third-party anti-cheat is a later, human-approved decision.
- **Engine netcode:** Unreal replication (see `helm-unreal`), Unity Netcode for GameObjects or Entities, Godot high-level multiplayer (`MultiplayerAPI`, `MultiplayerSynchronizer`). Use the engine's stack before writing your own.
- **Hosting costs money.** Dedicated servers, relay services and paid backends need `helm_need` (about: `spending`). Meanwhile run the server locally or headless in tests (a dedicated server build or a headless engine instance) and test with simulated latency and packet loss.

---

## 13. Platform and store notes

Platform builders own packaging and store configuration; you make the game ready for it.

- **Pause and resume correctly** on backgrounding, and handle safe areas and notches (expose the safe-area rect to the UI builder).
- **Respect platform rules:** Apple Game Center and Google Play Games sign-in are optional unless the SPEC requires them; controller support declarations on Apple platforms if you claim controller support; age ratings questionnaires are filled by the human.
- **Store accounts, signing identities, console dev kits and platform SDK access are human-only.** Ask once with `helm_need` (about: `access` or `credentials`) and keep building for the platforms you can build locally.
- **Console targets** require a developer agreement and NDA-protected SDKs. Do not attempt console builds without them; plan the code so a console port is a platform layer, not a rewrite.

---

## 14. Testing

Every test must be able to fail. A game that "runs" is not tested.

- **Unit tests on systems.** Pure rules (damage, economy, progression, inventory, procedural generation with a fixed seed, save migration, content validation) get fast unit tests that run headless: Vitest or Jest for web, Swift Testing for Apple, NUnit via the Unity Test Framework (Edit Mode), GUT or GdUnit4 for Godot, Automation Spec for Unreal.
- **Play-mode and automation tests.** Load a scene, drive inputs for N fixed ticks, assert on state (player reached the goal, enemy died, score equals the expected value). Unity Play Mode tests, Godot scene tests with GUT or GdUnit4, Unreal functional tests, Playwright-style browser tests for web games through `plugin:browser-automation` when available.
- **Deterministic replays.** Record seed plus inputs for a golden run, replay it headless and assert the final state hash. A changed hash is either a bug or an intended rule change that must update the golden file in the same commit with a reason.
- **Soak tests.** Run the game unattended (an AI bot or recorded inputs looping) for a long session, logging frame time and memory. Memory must plateau, not grow.
- **Save tests.** Round-trip, migrate from every fixture version, recover from a truncated or corrupt file.
- **Performance tests** encode ACCEPTANCE budgets: frame time p95 in a benchmark scene, load time, memory high-water mark.
- Run tests through `.helm/run-check.sh tests -- <command>` so the result is recorded.

---

## 15. Headless builds and CI

Only use flags you have verified on the installed version (`--help` or the official docs). Write the exact commands into a script in the repo (for example `game/tools/build.sh`) so CI and other builders run the same thing.

**Unity** (needs an activated license on the machine; activation is a human step via `helm_need`):

```bash
# Build through a static C# method you write (e.g. Assets/Editor/BuildScript.cs calling BuildPipeline.BuildPlayer)
"$UNITY" -batchmode -nographics -quit -projectPath game \
  -buildTarget Android -executeMethod BuildScript.BuildAndroid \
  -logFile reports/game/unity-build.log

# Edit Mode tests (do not pass -quit with -runTests; the runner exits itself)
"$UNITY" -batchmode -nographics -projectPath game \
  -runTests -testPlatform EditMode \
  -testResults reports/game/editmode-results.xml -logFile reports/game/unity-tests.log
```

Your build method must exit non-zero on failure (check the `BuildReport` result and call `EditorApplication.Exit(1)`), or the CI step will pass on a failed build. Play Mode tests that need rendering may fail under `-nographics`; run them without it where a GPU is available.

**Godot 4** (needs `export_presets.cfg` committed and export templates installed for the exact engine version):

```bash
godot --version
godot --headless --path game --export-release "Web" build/web/index.html
godot --headless --path game --export-debug "Android" build/android/game-debug.apk
```

The preset name must match `export_presets.cfg` exactly. Android export needs the Android SDK and a debug keystore configured in editor settings; release keystores are human-provided. For tests, use the test add-on's command-line runner (GUT: `godot --headless -s addons/gut/gut_cmdln.gd`); check the add-on's docs for the flag that makes it exit with a failing code.

**Web engines:** `npm ci`, then the bundler's build (`npm run build`), unit tests with the project's runner, and screenshots of the running build through `plugin:browser-automation` or Playwright.

**Unreal:** see `helm-unreal` (UnrealBuildTool, RunUAT BuildCookRun, automation tests with `-nullrhi`).

**Apple engines:** `xcodebuild test` on a simulator, as in `helm-ios` or `helm-macos`.

CI rules:
- **CI runners need the engine installed and licensed.** Unity and Unreal images are large; Windows packaging needs a Windows runner. If CI needs paid minutes or a license secret, ask via `helm_need`.
- **Cache wisely:** Unity `Library/`, Godot `.godot/`, Unreal `DerivedDataCache/`. Never commit them.
- **Build every target platform you claim,** or state in your report which ones are "verified by CI only" or not verified.

---

## 16. Pitfalls agents fall into

- **Building menus, shops and progression before the loop is fun.** Loop first.
- **Movement without delta time,** physics in the render update, or rules depending on frame rate.
- **Global singletons everywhere** and systems reaching into each other's internals.
- **Content hard-coded in code** (enemy stats in a switch statement) instead of data.
- **Unversioned, non-atomic saves** that break on the first update.
- **Claiming performance without a log** from the target device or a stated proxy.
- **Inventing engine APIs.** Engines rename and deprecate APIs every release. Compile, run, and check the docs for the installed version before relying on a call.
- **Editing binary engine assets by script** in ways the editor would not, or committing editor caches (`Library/`, `.godot/`, `Intermediate/`).
- **Test and debug code in release builds:** cheat menus, god mode, fake purchase success, test ad units.
- **Unverified build flags** copied from forums. Use only flags from `--help` or official docs.

---

## Done means

**Design and engine**
- [ ] Engine and version recorded in ARCHITECTURE.md, matching project tools; version pinned in the project files.
- [ ] SPEC has loop, controls, progression, economy, fail states, accessibility and performance targets; gaps raised with the lead.
- [ ] Vertical slice playable from launch to fail or win to retry on a target platform.

**Systems**
- [ ] Simulation on a fixed step with clamped delta; rendering interpolated; no frame-rate-dependent behaviour.
- [ ] Deterministic simulation (seeded PRNG, no unordered iteration, no wall clock) where replays or multiplayer need it.
- [ ] Input through an action map; every SPEC device supported; rebinding saved where required; pause on focus loss.
- [ ] Content in data with stable IDs, validated at load and in a test; no debug content on shipped paths.
- [ ] Saves versioned, atomic, backed up, migrated and tested; settings separate from progress.

**Quality**
- [ ] Unit tests on systems, play-mode or automation tests, a deterministic replay test, and save tests pass headless.
- [ ] Frame-time p50/p95/p99 measured against ACCEPTANCE budgets on a stated device or proxy; soak run shows stable memory and frame time.
- [ ] Monetization (if any) uses store billing, consented ads, disclosed odds, and no dark patterns; spending and accounts requested via `helm_need`.
- [ ] Multiplayer (if any) is server-authoritative with prediction and tested under simulated latency.
- [ ] Headless build script committed and run for each claimed platform; unverified platforms stated.
- [ ] `helm_slop_scan` clean on your files.

## Evidence to commit

Under `reports/game/` (for example `reports/game/<task>/`):
- `build-<platform>.log` (trimmed to the summary and errors if huge) and the packaged build path and size.
- Test results (`editmode-results.xml`, test runner output, replay test output) and the `.helm/run-check.sh` output path.
- `frametime-<scene>-<device>.csv` plus a short `perf.md` table: device, build config, p50/p95/p99 frame time, share of frames over budget, memory high-water mark, load time.
- `soak-<device>.csv` with frame time and memory over the run.
- Screenshots of each built screen or level state (`level1-start.png`, `level1-fail.png`), and short gameplay capture where the platform allows it.
- `ENV.txt`: engine and version, OS, device or simulator, and the exact commands run.

## Sources

- Glenn Fiedler, Fix Your Timestep!: https://gafferongames.com/post/fix_your_timestep/
- Glenn Fiedler, Deterministic Lockstep: https://gafferongames.com/post/deterministic_lockstep/
- Gabriel Gambetta, Fast-Paced Multiplayer: https://www.gabrielgambetta.com/client-server-game-architecture.html
- Valve, Source Multiplayer Networking: https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking
- Robert Nystrom, Game Programming Patterns: https://gameprogrammingpatterns.com/
- Game Accessibility Guidelines: https://gameaccessibilityguidelines.com/
- Xbox Accessibility Guidelines: https://learn.microsoft.com/en-us/gaming/accessibility/guidelines
- Unity Manual, Command line arguments: https://docs.unity3d.com/Manual/EditorCommandLineArguments.html
- Unity Test Framework: https://docs.unity3d.com/Packages/com.unity.test-framework@latest
- Godot Docs, Command line tutorial: https://docs.godotengine.org/en/stable/tutorials/editor/command_line_tutorial.html
- Godot Docs, Exporting projects: https://docs.godotengine.org/en/stable/tutorials/export/exporting_projects.html
- Unreal Engine documentation: https://dev.epicgames.com/documentation/en-us/unreal-engine
- Apple App Store Review Guidelines: https://developer.apple.com/app-store/review/guidelines/
- Google Play Payments policy: https://support.google.com/googleplay/android-developer/answer/9858738
- Google Play Families policies: https://support.google.com/googleplay/android-developer/answer/9893335
- Android Performance (games): https://developer.android.com/games/optimize
- Phaser: https://phaser.io/
- three.js documentation: https://threejs.org/docs/
- Babylon.js documentation: https://doc.babylonjs.com/
