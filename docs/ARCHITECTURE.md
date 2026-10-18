# Helm — architecture

Helm is one BB plugin with three runtimes:

| Runtime | Entry | Runs in | Talks to |
|---|---|---|---|
| Plugin server | `server.ts` | BB's plugin host (one process) | BB through `bb.sdk` only. No network calls of its own, no telemetry, no shell |
| Host entry | `host.ts` → `src/host/ops.ts` | each BB host daemon | the machine's git and filesystem, over the typed `HOST_CONTRACT` (`src/shared/host-contract.ts`). Its only network contact is a read-only `git ls-remote` to an app's own remote, for the GitHub view (`src/host/remote.ts`) |
| App | `app.tsx` → `components/helm/` | the BB window | the server over the RPC contract (`src/shared/protocol.ts`) and realtime channels |

```
        human ─┬─ bb helm … (cli.ts) ─┐
               └─ Helm panel (app) ───┤ RPC (rpc.ts) / realtime (realtime.ts)
                                      ▼
                           HelmService (service.ts)          agents ── helm_* tools (agent/tools.ts)
                                      │                                         │
                                      ▼                                         ▼
          ┌──────────────────────── Engine (engine/*) ─────────────────────────────┐
          │ direct.ts  directives + Needs-you      gates.ts   stages, evidence, gates│
          │ events.ts  BB events, reconcile, V18   delta.ts   plan changes mid-run   │
          │ planner.ts free-text briefs            world.ts   world state (DB read)  │
          │ outbox.ts  every BB side effect, durable, idempotent, retried            │
          └───────┬──────────────────────────────────────────────┬─────────────────┘
                  │ pure functions                                │ BbPort (bb/port.ts)
                  ▼                                               ▼
        domain/*: topology, stages,                 RealBB (bb/real.ts) ── bb.sdk, host entry
        directives, scheduler, models,              SimBB  (bb/sim.ts)  ── tests, virtual clock
        roles, briefs, checks, slop/*
                  │
                  ▼
        Repo (db/repo.ts) over SQLite (bb.storage.database())
```

## Layers

**`src/server/domain/`: pure.** No I/O and no clock, so tests run in milliseconds.
- `topology.ts`: `planTopology` decides the org from a portfolio and limits. The wizard, the CLI, the planner and the engine all call it, and no model ever decides the shape.
- `stages.ts`: the per-app stage machine and the board's drag rules.
- `directives.ts`: who a change applies to, who hears about it, and the notice text.
- `scheduler.ts`: admission, waves and priority.
- `models.ts`: catalog normalization, slots, presets, forecast and validation.
- `roles.ts`: the role registry and the tool set per tier.
- `briefs.ts`: the first prompt every agent gets.
- `checks.ts`: the check wrapper.
- `slop/`: the deterministic scanner and its rule table.
- `verdict.ts`: gate verdict validation, plus `blocksReady`.

**`src/server/engine/`: the only stateful part.**
- Every decision is written to the database first.
- Every BB side effect is an **outbox row** written in the same transaction (`project`, `spawn`, `send`, `update`, `stop`, `archive`, `retry`, `compact`, `interaction`, `file`). The outbox worker performs it with retries and an idempotency key, then records the result. A crash between "decide" and "do" therefore heals on restart, and a crash between BB's spawn and Helm's write is healed by the V17 lookup (find the thread by its metadata key before spawning).

**`src/server/bb/`: the only door to BB.**
- `BbPort` is the interface.
- `RealBB` implements it over `bb.sdk.*` and Helm's host entry.
- `SimBB` implements it in memory with a virtual clock, scripted agents (`sim-agents.ts`) and an in-memory git (`sim-git.ts`). The 20-app, 169-agent scenarios, failures and restarts run only here, never against real providers.

**Interfaces.** `cli.ts` (`bb helm …`), `rpc.ts` and `realtime.ts` are thin shells over `service.ts`, so the CLI, the app and tests use one set of functions. `settings.ts` maps BB settings to `HelmSettings` and clamps values to the ceilings.

## Data

SQLite through `bb.storage.database()`, with forward-only migrations in `db/schema.ts`. `bb helm doctor` checks the schema version.

| Area | Tables |
|---|---|
| Structure | `runs`, `apps`, `nodes`, `stage_history` |
| Change | `directives`, `directive_recipients` (receipts), `policies`, `inbox` (FYI lines) |
| Evidence | `reports`, `checks`, `verdicts`, `findings` |
| Human | `needs` |
| Side effects | `outbox` |
| Activity | `node_events`, `comms`, `snapshots` |
| Models | `seen_models`, `hidden_models`, `slot_presets` |
| Other | `observatory_adopted`, `meta` (small keyed facts: planner sessions, squad admission, spawn bases) |

Helm's database is the source of truth for **structure**: who reports to whom, stages, directives and findings. BB is the source of truth for **threads**. The two are reconciled at start-up, on every `thread.*` event, and by `bb helm reconcile`.

## Threads and the chain of command

- The Orchestrator, the Planner and the Git agent are the visible Helm threads (App Leads too when "Show App Leads in the BB sidebar" is on). Every other node is spawned **hidden** with `lifecycleOwnerThreadId` set to its parent's thread and **no `parentThreadId`**. A native parent link wakes the parent for a full turn on every child completion (V2, DECISIONS 2).
- Children talk upward through `helm_report`. Helm verifies the evidence and forwards one compact line on done, blocked or failed. Progress lines and digest-level notices go to the node's FYI inbox and never wake an idle agent (DECISIONS 3).
- Authority is the `nodes` row for the calling thread id, checked again on every tool call. `agents.configure` only picks a tool list (V12).

## Where apps live

`Engine.locationReport` checks every folder the human named, on the run's host, at plan time and again before start:
- `inspectPath` reports what is there: existing, empty, git top folder, branch, uncommitted count, writable, enclosing repository;
- `targetPathProblem` refuses system folders, disk roots and the home folder.

At start, the `project` outbox handler does one of two things:
- **adopts** an existing repository with `adoptRepo`: a create-only `<app>-work` branch at HEAD (or the existing one), nothing else (DECISIONS 23; runs from before keep their `helm/<run>/<app>` branch as the work branch);
- or creates a repository with `ensureRepo` as before.

It then finds or creates the BB project for that folder. Before an app's first spawn, `ensureWorkTree` adds one shared **work worktree** beside the repository, `<repository folder>/.helm-work/<repository>`, on the work branch; every agent of the app works there (DECISIONS 49). Its briefs and the evidence wrapper come from the Studio, and the lead may map the repository's own documents and checks with `helm_existing_docs` (DECISIONS 24). Work reaches `main` only through the Git agent (below).

## The free-standing agents

Every run also has agents outside the chain of command (`engine/custom.ts`):
- the **Planner** answers the human's questions and makes plan changes, model changes and **custom agents** on request (`bb helm ask`). Custom agents report to a supervisor the Planner names and are woken by events (`wakeOn`), never by timers;
- the **Git agent** keeps every app to its branch and worktree limits, watches disk space, and merges and pushes signed-off work as the "When you sign a project off" setting says;
- an optional **Watcher** (the `watcher` slot) gets the watchdog's stall suspects and nudges, restarts or escalates them (`engine/watch.ts`).

## Directives

A human change (`tell`, `model`, `pause`, `stop`, `policy`, …) is a **directive**, created by `createDirective` in `direct.ts`:

1. It is applied, and the affected set is computed by cascade.
2. A recipient level is computed for every node on the chain: direct, full, digest, or world.
3. Receipts are recorded per recipient, and the notices go out through the outbox.

Each receipt moves through queued → delivered → read → acked, or failed. Text typed straight into a Helm thread becomes an implicit `tell` through the `message.dispatch` hook (V18). Questions to the Orchestrator are not directives.

## Stages and evidence

Each app runs through intake → spec → build → integrate → review → slop → (fix) → ready → done. Every step needs evidence that Helm checks itself:
- **Commits:** a commit counts only if it exists on the named branch.
- **Files:** a file counts only if it exists at that commit.
- **Checks:** a check counts only if it exited 0 on the integration HEAD.
- **Gate verdicts:** each verdict must locate its quoted findings, leave the worktree clean, and judge the current HEAD.
- **Specialist done:** a specialist's done must cite a commit newer than its spawn base.
- **Ready:** Ready is pinned to one commit and needs an accepted pass from both gates at that commit plus no open finding that `blocksReady`. Sign-off is the human's.

## Never poll

- Completion arrives as BB events (`bb.events.on`) and the `message.dispatch` hook.
- The only timers are:
  - the outbox's retry backoff;
  - realtime coalescing;
  - the PORTFOLIO.md debounce;
  - deadlines (planner wait);
  - the 5-minute watchdog. It finds stalls from Helm's own `nodes` table (DECISIONS 14), and at most every 30 minutes it reads each app's worktrees and branches through the host entry (local git only) so the Git agent hears when an app is over its limits or a disk runs low. It never reads remotes; the GitHub view does that only when the human opens it.

## Tests

`npm test` runs Node's test runner with `--experimental-transform-types --experimental-sqlite`.

| Folder | Covers |
|---|---|
| `test/unit` | pure domain functions; the slop fixtures (planted vs. control); skill-folder names |
| `test/sim` | the engine against `SimBB`: directives (A7–A12), failures (A14–A21, restarts, duplicate events, dry runs, vanished models), the 20-app portfolio with invariants, squad release, planner |
| `test/plugin` | the real `server.ts` factory on BB's fake plugin host: registrations, CLI, doctor, configure, the V12 spoof test |

Live verification on this machine is in `docs/VERIFY.md`.
