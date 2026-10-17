# Helm — verify-first results (§2.3)

Machine: BB 0.46.1, plugin SDK 0.6.49, one host (`host_…`, macOS, git 2.54.0, Xcode 27.0).
Every real agent in these experiments ran on `claude-code / claude-haiku-5-5` at `low`. No real run had more than 6 agents.

Sources:
- **Phase 0**: CLI experiments with 3 agent threads. Full commands and output are in [phase0-cli-results.md](phase0-cli-results.md).
- **Smoke 1**: the first live Helm run (`helm-smoke`, 1 app). Cancelled after it exposed the skill-name bug (below).
- **Smoke 2**: the second live Helm run, `run_…` ("Helm smoke 2"). One app, "Tally" (a macOS command-line tool), lean shape, 5 agents: Orchestrator-as-lead, Core builder, UI builder, Reviewer, Slop Hunter.
- **Sim**: the simulated BB adapter (`src/server/bb/sim.ts`) and the tests under `test/`.

| # | Result | Evidence (short; details below or in phase0-cli-results.md) | What Helm does |
|---|---|---|---|
| V1 | confirmed | SDK 0.6.49 typings (`docs/SDK-NOTES.md` §threads.spawn). Smoke 2 spawned hidden threads with model, reasoning, permission mode, `pluginMetadata.helm`, title, environment and `lifecycleOwnerThreadId` (`bb thread show`: `visibility=hidden owner=thr_… parent=null origin=helm`) | as designed |
| V2 | **changed** | Phase 0: each child turn completion sends `[bb system] … completed:` with the child's full final message, which **starts a new turn in the parent** about 2.0 s later and cascades up. P went from 29.5k to 193k tokens after four such turns | No native parent links below the Orchestrator. Children get only `lifecycleOwnerThreadId`, and Helm forwards one compact, verified report on done/blocked/failed (DECISIONS 2, 3) |
| V3 | confirmed | Smoke 2: Orchestrator log shows `helm_context` and `helm_world` resolving its node. Specialists' `helm_report` calls landed on the right nodes (Core builder `done` with verified commits `a83e933`, `9da3c4a`). Sim: every tool test resolves by `ctx.threadId` | authority is the `nodes` row for `ctx.threadId` |
| V4 | **unverified live** | No permission prompt happened in either smoke run (every tier runs at `auto`, D9). Sim covers `interaction.pending` → Needs-you → `interactions.resolve` | The `interaction.pending` handler is in place. The fallback also runs: reconcile reads `hasPendingInteraction` and calls `interactions.list` |
| V5 | pending UI | see the Inspector Chat tab (Phase 3+) | fallback planned: node events/comms through RPC |
| V6 | confirmed | Phase 0: a child explicitly requesting `full` under an `auto` parent got `full` and ran a shell command. `bb guide threads`: "nesting a thread does not cap its permissions" | Helm passes the mode explicitly for every spawn, one setting per tier (D9) |
| V7 | confirmed (design) | `thread.idle.lastAssistantText` + `helm_report` populate the node's "now" line. In smoke 2 every node's line came from its reports | timeline read only for the selected node |
| V8 | confirmed / refuted marker | Phase 0: `providers.list/models` shape recorded. **No** legacy/hidden/release-date field exists. Claude models carry no per-model service tiers | NEW badges only from Helm's `seen_models`; service tier validated per model, else per provider (DECISIONS 7) |
| V9 | confirmed | Phase 0: worktree spawn in a non-git project → `HTTP 409: This project checkout has no usable git branch` in under 1 s, with no thread created | Helm creates one git repo per app through the host entry (D1, V16) |
| V10 | confirmed, with side effects | Phase 0: `parentThreadId` can change, `lifecycleOwnerThreadId` cannot, and both old and new parents are woken for a full turn each | "Adopt" in the Observatory is Helm-DB-only. Helm never reparents |
| V11 | confirmed | `bb helm` was an unknown command before install. Helm now owns it | — |
| V12 | confirmed | Smoke 1 found the real failure mode: a skill folder name differing from its frontmatter `name` makes `configure()` throw "selected unknown skill id", so the session gets **no tools**. Fixed (folders `helm-*`) with a regression test. Smoke 2 sessions got their tier's tools. Spoof test (`test/plugin/server.test.ts`, "V12"): metadata claiming to be the Orchestrator gets no tool list and no authority | `configure` uses metadata only for a node whose spawn is in flight and only in a thread no other plugin started. Every `execute` re-authorizes from the DB |
| V13 | confirmed | Phase 0: 20 worktrees in 0.78 s for a tiny repo. BB provisioning 291–422 ms per thread | gates get their own worktree off the integration branch and must stay clean |
| V14 | **refuted** | Phase 0: `provider-usage` gives account-level quota windows (`usedPercent`), not per-thread spend. `cost` is null | relative cost units from per-node token counts × per-model weights (DECISIONS 6) |
| V15 | sim / pending UI | Graph culling and level-of-detail are being built with the UI; the 169-node plan exists in the sim | collapse managers by default above ~60 nodes |
| V16 | **changed** | The plugin server cannot shell out. A BB **host entry** can: smoke 1 and 2 created `~/Projects/helm/<run>/_studio` and `…/tally` with `git init` and a first commit through `host.ts` | git and file work runs in the host entry (DECISIONS 9) |
| V17 | confirmed | SDK spawns carry `originPluginId=helm` (smoke 2 `bb thread show`). Lookup is `threads.list({originPluginId, includeHidden})` + `threads.experimental_listPluginMetadata` by key. Sim A21: a crash between spawn and the DB write never duplicates a thread after restart | as designed |
| V18 | confirmed | Smoke 2: a user-authored message queued into the Orchestrator's thread (`env -u BB_THREAD_ID bb thread tell thr_… --mode queue "Keep packages/core/README.md under 40 lines."`) appeared in the ledger as `D-0001 23:27 (typed in thread) Orchestrator: "Keep packages/core/README.md under 40 lines." [1 delivered]` | the `message.dispatch` hook records an implicit `tell` (questions to the Orchestrator excepted, DECISIONS 15) |
| V19 | not needed | Helm never raises `ui.requestInput` inside agent threads. Agents ask through `helm_need`, which creates a Helm-native Needs-you item answered with `threads.send` | the stated fallback is the design |
| V20 | confirmed | Phase 0: archiving P returned `archivedThreadIds` [G, C, P] with one `archivedAt`. Stop does not cascade | Helm stops bottom-up itself, then archives (sign-off, completion). Smoke 1's cancellation archived the Orchestrator |

## Findings from the live smoke runs

These live findings changed the code. Each change has a test.

1. **Skill folder name must equal its frontmatter `name`** (smoke 1). BB skipped the skills ("Frontmatter name must match the skill directory name"). `configure()` then failed entirely ("configure() selected unknown skill id 'helm-orchestrator'"), and the Orchestrator ran with no Helm tools. Fixed by renaming the folders. `test/unit/skills.test.ts` guards it.
2. **A lead could not drop a squad member its SPEC made pointless** (smoke 2). The UI builder on a CLI-only app correctly refused to invent a GUI and reported `blocked`. Integrate would have waited forever. Added `helm_spawn_squad {release: [...]}` and made Integrate skip released or human-stopped builders (DECISIONS 16, `test/sim/squad-release.test.ts`).
3. **"Done" citing the spawn base was accepted** (smoke 2). The cancelled UI builder reported `done` with commit `2189f72`, the commit its worktree started from. Helm now records each specialist's base and requires a commit not contained in it (DECISIONS 16, same test).
4. **S5 over-blocking** (smoke 2). The scanner flagged a Swift CLI's `print` output in `main.swift` as zero-tolerance. The policy makes S5 zero-tolerance only when it logs user data. Fixed with `blocksReady` plus a CLI-entry-point exemption (DECISIONS 17, `test/unit/slop-scanner.test.ts`). Planted-fixture thresholds still hold.
5. **Gates cited untracked reports as `file` evidence** (smoke 2). The Reviewer's two `reports/…` refs were flagged unverifiable. The gate skills now say to cite them as `report`.
6. **Stale open findings after a pass** (smoke 2). After the Reviewer passed the fixed commit, its fix-round findings F-1 and F-2 still read `open`. Ready was correct, because a pass at HEAD supersedes them, but the ledger showed stale blockers. Now a gate passing a newer commit marks its earlier findings `fixed` and emits `finding.updated` (DECISIONS 18; the sim test "a gate that fails once…" fails without the fix).

7. **Invalid skill frontmatter broke live agents** (during development). See DECISIONS 26. Fixed by rewording the description, and guarded by a strict-frontmatter test.
8. **Existing repositories, checked live without starting anything.** A `bb helm plan` against real clones and linked worktrees on an external disk (paths with an emoji, an apostrophe and spaces) did the following:
   - Adopted a linked worktree, with its branch and "16 uncommitted changes left untouched".
   - Adopted a clone on `main`.
   - Accepted a read-only shared-code folder.
   - Refused a not-yet-existing folder inside another repository.
   - The first pass exposed that missing case and a branch name that lost the run-id suffix. Both are fixed, with tests.
   Afterwards `git branch --list 'helm/*'` was empty in every repository, and no folder was created: planning writes nothing to the disk. Commit-free adoption itself is covered by a real-git test (`test/unit/host-ops.test.ts`) and the simulator (`test/sim/locations.test.ts`), not by a live run.

## What smoke 2 showed working end to end

- Orchestrator-as-lead wrote SPEC/ARCHITECTURE/CONTRACT v1/ACCEPTANCE and real `.helm/checks.json` commands, committed (`2189f72`), then moved spec → build.
- Specialists were spawned hidden and lifecycle-owned, each in its own BB worktree branch (`bb/tally-core-builder-thr_…`, `bb/tally-ui-builder-thr_…`).
- The Core builder implemented the CLI, tests and checks. When the lead amended CONTRACT to v2 (overflow), the builder implemented it, and its `done` reports were verified against real commits.
- The lead merged, ran build/lint/test through `run-check.sh`, and recorded each check against the integration HEAD. Helm refused Integrate while a builder had no verified done.
- The Reviewer (own worktree, detached at `9aa64ca`) re-ran the checks, verified AC-1…AC-13 against the built binary, and returned an accepted **fail** with a real contract blocker (running-sum overflow, `Tally.swift:32`). Helm opened fix round 1. After the fix, review passed and the Slop Hunter was spawned.
- **Ready was pinned to the judged commit.** The integration branch stayed at `26fbd2e`. A later README tweak (`87c8430`) existed only on the Core builder's branch and was not merged, so it did not count.
- **Independent check by the operator** (scratch copy of `26fbd2e` via `git archive`): `swift test` passed (18 TallyCore tests, 8 CLI tests, 0 failures) and `swift build -c release` completed. `tally 3 4 5` printed `sum: 12 / mean: 4 / count: 3` (exit 0). `tally 1e308 1e308 -1e308` printed `sum: 1e+308`, so the Reviewer's blocker is fixed. `tally 1e308 1e308` printed `tally: sum overflows` (exit 1), and `tally abc` printed `tally: invalid number: abc` (exit 1). SwiftPM needs to run outside a sandbox, which the agents also hit; each recorded check names its commit.
- **Completion.** `bb helm signoff Tally`, then N-2 "Every app is signed off — complete the run?", then `bb helm approve N-2`. The run is `done`. All five threads are `idle` and archived (`bb thread list --include-hidden`). `outboxFailed: 0`. Spend 5.5 units against a forecast of 7.2. Repos and branches stayed.
- **Not exercised live:** a plugin restart in the middle of a run (simulator only: "restart in the middle of a run", A21), a permission interaction in a hidden thread (V4), a budget pause, and a manager tier (more than 4 apps would exceed the 6-agent cost rule).

