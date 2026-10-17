# Helm — absorption of the old plugins

The brief (§12) asks for each replaced plugin's installed source and skills to be read, with anything its reconstructed table misses listed here. This was done read-only on 2026-10-16. Nothing was enabled, imported or modified, and every plugin below still shows `disabled` in `bb plugin list`.

Status words used below:

- **Covered**: Helm does the same job. The Helm file named is where it lives.
- **Partial**: Helm does some of it, or does it differently. The note says what is missing.
- **UI in progress**: the server side exists, but the panel that shows it is still being built in `components/helm/`. Today `app.tsx` mounts only a minimal run list with open needs.
- **Gap**: not in Helm and probably worth having.
- **Out of scope**: not in Helm on purpose. Either the brief excludes it, or it falls outside Helm's lane (§1 rule 7: Helm manages only the threads it spawns).

## Where the old plugins are installed

| Plugin | Version | Installed source | Plugin data |
|---|---|---|---|
| agent-graph | 0.1.0 | `~/.bb/plugins/cache/git/github.com/nathancolgate/bb-plugin-agent-graph/3fd202e9…` | none |
| chief | 0.1.0 | `~/.bb/plugins/cache/git/github.com/divyesh-puri/bb-plugin-chief/64ac8bc3…` | `~/.bb/plugins/chief/data.db` |
| command-center | 0.7.1 | `~/.bb/plugins/cache/git/github.com/dilipgv/bb-plugin-command-center/48292143…` | `~/.bb/plugins/command-center/data.db` |
| crew | 0.1.1 | `~/.bb/plugins/cache/git/github.com/sajov/bb-plugins/70d89a91…/bb-plugin-crew` | `~/.bb/plugins/crew/data.db` |
| visual-workflows | 0.1.0 | `~/.bb/plugins/cache/git/github.com/dmitriikapustin/bb-plugins-by-kapustin/d862257b…/plugins/visual-workflows` | `~/.bb/plugins/visual-workflows/data.db` |
| workflows (built-in) | 0.1.0 | `/Applications/bb.app/…/builtin-plugins/workflows` (compiled `dist/` plus `skills/`) | none |
| jev-orchestrator | — | **No source on disk.** It is not in `bb plugin list`. Only `~/.bb/plugins/jev-orchestrator/data.db` remains, and its tables are empty. | schema only |

## agent-graph

It only reads and displays. It has no agent tools, no skills, no storage and never spawns threads.

| Capability (where in source) | Helm | Status |
|---|---|---|
| Overview graph of recent BB threads, grouped by project (`server.ts buildOverview`, nav panel "Agent Graph") | Helm's Graph shows only Helm agents. Other threads appear as a flat list from `observatory_list` (`rpc.ts` → `bb/real.ts listForeignThreads`). The ghost-node toggle in `components/helm/ctx.tsx` is UI in progress. | Partial · UI in progress |
| Drill into one thread: turns → tool calls (shell/edit/read/web) → subagents → workflow agents, up to 4 levels of child threads (`buildThread`, `addWork`) | Helm draws one node per agent. It never draws turns, tool calls or subagents. Inspector → Chat embeds BB's `ThreadChat` (`components/helm/inspector/chat.tsx`), which shows the thread's own timeline. | Out of scope (debug view, not supervision) |
| Chat beside the graph, with a thread picker (`BesideThreadTab`, `ThreadChat`) | Inspector Chat tab (`inspector/chat.tsx`). It falls back to Helm's own record if `ThreadChat` fails. | Covered · UI in progress |
| Thread panel action plus a header button on **any** thread (`threadPanelAction "thread-graph"`, `experimental_threadHeaderAction`) | None. The brief plans a `threadPanelAction` (§13), but `app.tsx` has only `navPanel`. | Gap (small) · UI in progress |
| CLI `bb agent-graph show [--thread] [--json]` prints a text tree of any thread | `bb helm status` / `bb helm world` cover Helm runs only (`cli.ts`). | Out of scope (rule 7) |
| Live updates: `thread:changed` → debounced realtime, plus 15 s polling | Helm's own `run:<id>` realtime batches (`realtime.ts`). These are driven by Helm's events, not by polling. | Covered |
| Colour by type or status, "active only" filter, jump to running work (`J`), fit, zoom, legend (`graph.tsx`) | The Graph spec (§11.3) has status chips, legend, fit and zoom. | UI in progress |
| Settings: window hours, max threads, turns shown | n/a | Out of scope |

## chief

| Capability (where in source) | Helm | Status |
|---|---|---|
| Chief → worker → reviewer roles, gated per thread (`managed_threads.role`, `bb.agents.configure`) | Five tiers plus gates (`domain/topology.ts`, `domain/roles.ts`). Tools per tier: `domain/roles.ts toolsForNode`. Authority is the `nodes` row (`server.ts` configure). | Covered |
| `chief_delegate`: spawn a titled worker in a managed worktree | `helm_spawn_squad` plus outbox `spawn` rows (`engine.ts handleSpawn`), worktrees off the integration branch (DECISIONS 5) | Covered |
| `chief_roster` / `chief_inspect`: live status, persisted report, last output | `helm_world`, `helm_digest`, `helm_context`. Inspector Overview for the human. | Covered · UI in progress |
| `chief_continue` (with `--allow-edits` for a reviewer repair pass) | The `tell` directive (`direct.ts createDirective`). Gates never edit; fixes go to owners through `helm_assign_fix`. | Covered (differently) |
| `chief_review`: one read-only review per idle worker, deduplicated | Reviewer and Slop Hunter gates per app at a pinned commit (`engine/gates.ts`) | Covered |
| `chief_complete`: only Chief marks work complete, and only when not running | Stages advance only on verified facts (`helm_stage`, `gates.ts tryReady`). Human sign-off: `bb helm signoff`. | Covered |
| `chief_report` ready/blocked, with result, blocker and recommendation required ("evidence, not proof") | `helm_report` with evidence refs checked by `gates.ts verifyEvidence`. A `done` must cite a commit not already in its base (DECISIONS 16). | Covered |
| Durable `alert_outbox` with dedupe key and retry | `engine/outbox.ts` (`OutboxWorker`), idempotency keys, `outbox_retry` RPC | Covered |
| Lifecycle alerts to Chief on idle, failed, archived or deleted | `engine/events.ts handleEvent`. Reports are forwarded only on done, blocked or failed (DECISIONS 2). | Covered |
| Stall alert after `stallMinutes` active | Watchdog every 5 min (`server.ts` schedule → `events.ts watchdog`): nudge once, then a `stalled` need (DECISIONS 14) | Covered |
| Supervisor loop reconciles every pass, using live `deletedAt`/`archivedAt` | `events.ts reconcile` on start and through `bb helm reconcile` | Covered |
| **Auto-replaces a dead Chief** and retargets its queued alerts | A failed Orchestrator raises a `failed` need with Retry. Nothing respawns it automatically. | Partial (deliberate: a human decides) |
| **Project rules file `chief.md`** at the repo root, read through the project file API and cached | No per-project rules file. The nearest thing is standing policies (`bb helm tell --policy`, the `policy` directive) and the run brief. | Gap (small) |
| Files every managed thread into a sidebar section named "Chief" (`threadSections`) | Helm hides every node except the Orchestrator (D3). It creates no section. | Partial |
| Homepage "Start Chief" launcher (`homepageSection`) and a crown badge in Chief thread headers | Nav panel only | Gap (small) · UI in progress |
| Settings: provider, model and reasoning per role | Model Studio slots and presets (`domain/models.ts`, `models_*` and `presets_*` RPC) | Covered · Studio UI in progress |
| Skills `chief` and `chief-worker` | `skills/helm-orchestrator`, `helm-manager`, `helm-lead`, `helm-specialist`, `helm-reviewer` | Covered |

## command-center

| Capability (where in source) | Helm | Status |
|---|---|---|
| Needs-you inbox: questions, reviews, approvals, with answer and dismiss (`items` table, `list`/`answer`/`dismiss` RPC) | `engine.raiseNeed`, `direct.ts resolveNeed`, `needs_list`/`needs_resolve` RPC, `bb helm needs/approve/deny/answer`, `components/helm/needs.tsx` | Covered · UI in progress |
| Answers delivered back into the asking thread, retried up to 20 times (`deliver-answers` service) | `resolveNeed` → outbox `send` | Covered |
| **`ask`/`review` CLI that any agent can use**, with `--wait` | `helm_need` is for Helm nodes only. BB interactions raised in Helm threads are mirrored into Needs (`events.ts onInteraction`). | Out of scope for non-Helm threads (rule 7) |
| **Snooze** (1 h / 4 h) and a snoozed list | none | Gap (small) |
| **Retract an answer** and queue a CORRECTION | none. A follow-up `tell` is the workaround. | Gap (small) |
| **macOS banner notifications** on lane changes, stalls and new comments; a **nav badge** with the open count | none. Needs raised by Helm itself (plan, signoff, budget, stalled) notify nobody, so the user has to look. SDK 0.6.49 has no notification or badge API (DECISIONS 21). | **Gap** (platform) |
| Board with lanes Queue · In progress · In review · Needs you · Done, drag to move | Board with two lenses, apps by stage and agent tasks (`board_moveApp`, `board_moveTask`, `components/helm/board.tsx`) | Covered · UI in progress |
| **Ad-hoc request intake**: composer with priority, urgent flag, harness/model and workflow; Queue vs Dispatch; reorder | Helm takes a whole brief (`bb helm plan`, wizard). A single task becomes a one-app Solo run. Apps can be added mid-run through `helm_propose_plan` deltas (`engine/delta.ts`). | Partial (deliberate: Helm is portfolio-shaped) |
| Dispatch routes to a project chief, or spawns a worker directly | Orchestrator → Managers → Leads (`topology.ts`), spawned lazily through the outbox | Covered |
| Global Chief → project chief → task architect org (`chief_project_chief`, `chief_handoff`, `chief_roster`) | Orchestrator / Manager / Lead tiers | Covered |
| **Tasks plugin integration**: cards adopted from Tasks, lane moves call `boardMove`, comments become Tasks comments, `--task-key` everywhere | none. Helm never reads or writes Tasks. | **Gap** (§12 says Helm must cooperate with `tasks`; today it ignores it) |
| Stall detection: In progress silent longer than `stallHours` → Needs you | Watchdog → `stalled` need | Covered |
| Archive cascade: archive a card's workers, protect org threads, record ids for **unarchive** | Run completion stops and archives every node after confirmation (DECISIONS 11). Ownership cascade through `lifecycleOwnerThreadId`. There is no unarchive. | Partial |
| Named **workflows** (step lists with a model per step) | Fixed stage machine (`domain/stages.ts`) plus slots per role | Out of scope (§12 workflows row) |
| `retire` and `tidy` to hide org threads from the sidebar | Hidden by default (D3) | Covered |
| PR, Jira and Confluence link extraction on cards (`lib/artifacts.ts`) | none. Helm has no remotes by default (D10). | Out of scope |
| **Voice capture and spoken commands** (`useVoiceCapture`, `lib/voice-command.ts`, alt+v) | none | Out of scope (not in the brief) |
| Skills `chief`, `project-chief`, `chief-architect`, `user-inbox` | Helm tier skills. Threads that are not Helm nodes get `skills/helm` (the `bb helm` CLI guide). | Covered |

## crew

| Capability (where in source) | Helm | Status |
|---|---|---|
| Squad **templates** pair, trio and research (`lib/templates.ts`) | Shapes Solo, Lean and Full (`domain/topology.ts`) | Covered |
| **Editable crew file** (YAML, form editor, fullscreen canvas editor, import/export, plan/apply diff) | Shapes are fixed. Only the portfolio brief is editable. | Out of scope (v1: briefs, not tiers) |
| Messaging tools `crew_send`, `crew_broadcast`, `crew_inbox`, `crew_peers`, `crew_whoami` | `helm_message` (parent, child or same-app sibling), `helm_context`, `helm_digest`, the FYI inbox (DECISIONS 3). There is no broadcast; cross-app traffic goes up the chain. | Covered (narrower on purpose) |
| Delivery semantics: queue behind a busy turn, hold while an approval is open, throttle at the limit, loop limits per chain | Outbox `send` with steer/queue (`engine.ts`), FYI coalescing, receipts from `message.dispatched` (`events.ts receipts`) | Partial (no per-chain loop limit) |
| Shared **channel** that wakes nobody unless `@member` is used | FYI inbox plus digest | Covered (differently) |
| **Work queue**: create, claim, handoff, done, fail | Work is the node itself. Fixes are routed with `helm_assign_fix`. | Out of scope |
| `crew_rebase` onto base, with `merge-conflict` on Needs you | Specialists branch from the integration branch at spawn. Only the lead merges (`skills/helm-lead`). | Partial |
| `crew_deliver` / integrator merge **into `main`**, merging only when `checks` exits 0, with "main moved" notes | The deliverable is the lead's integration branch, gated by the Reviewer and Slop Hunter plus `helm_record_check`. Helm never merges into `main`. | Partial (deliberate) |
| Add or remove members mid-crew, with a confirm form | `helm_spawn_squad` with `release` (DECISIONS 15), the `spawn` directive, plan deltas | Covered |
| **Cross-crew dependencies** `waitsFor` (merged, done, or a comment keyword), polled every minute (`dependencies` cron) | Apps are independent. Waves order them, but no app waits on another. | Gap (small) |
| **Follow-up ladder** (`follow-ups` cron): remind, remind, escalate, then Needs you | One watchdog nudge, then `stalled`. Unacked directive reminders through `remindUnacked`. | Partial |
| **Relief / handover**: context at 60 % / 80 % → "Handover suggested" → new shift with a handover brief | Helm compacts at 70 % instead (`events.ts COMPACT_AT`, §8.6). A replacement thread (retry of a node whose thread is gone, gate respawn after send-back) gets a hand-over built from Helm's records: the predecessor's last reports and verified evidence (DECISIONS 20). There is no context-based relief; compaction covers that. | Partial (hand-over on replacement; no 60/80 % relief) |
| **Snapshot / restore** (bindings, open work, undelivered messages) | `bb helm export` writes a JSON snapshot. A `snapshots` table and repo methods exist with no writer. No restore. | Gap (planned: Phase 6) |
| **Replay** of the comms strip on the canvas | The `comms` table is written (`repo.comms`), but Replay is not built | Gap (planned: Phase 6) |
| Crash journal: intent before spawn, `recoverOrphan` | Outbox, then spawn lookup by `pluginMetadata` key, then reconcile (§9.2, §9.4) | Covered |
| **Remote hosts**: `environment: host:<id>` places members on another host | Helm passes a `hostId` internally, but runs always use the primary host and there is no host choice | Out of scope (v1 is local, §17.1) |
| Capacity from `concurrency-limit` plus a plugin-side limit | Helm's own cap from its DB. BB's limit still applies (DECISIONS 8). | Covered |
| Needs-you reasons, including context and merge-conflict | Need kinds in `shared/types.ts` (no context or merge-conflict kind) | Partial |
| **RPC contract for other plugins** (`resolveMember`, `sendToMember`, `memberReply`) | none | Gap (small) |
| Sidebar row-status icons (content script), command palette entries, `::crew` chat card, member header badge | none | Gap (small) · UI in progress |
| Tasks labels and comments, Graph Studio graphs (`crew_graph_run`) | none | Out of scope (Tasks: see the command-center row) |

## visual-workflows

| Capability (where in source) | Helm | Status |
|---|---|---|
| Role registry as data: slug, instructions, provider/model, reasoning, permission mode, colour (`roles` table, six seeded roles) | `domain/roles.ts ROLES` is static code. Models come per role from slots (`domain/models.ts`). Permission is set per tier in settings (`permission*`). | Partial |
| Edit roles in the UI (`RoleEditor`, `roles_create/update/delete/reorder`) | No RPC to edit roles. Settings → Roles (§12: edit briefs, not tiers) is not built. | **Gap** (the §12 row says it exists) |
| Role instructions injected as hidden per-thread instructions (`bb.agents.configure`) | `server.ts` configure → `instructionsFor` plus tier skills | Covered |
| **DAG workflow designer** (teams of up to 40 nodes, drag-to-connect canvas, cycle check) | none | Out of scope (same reasoning as the workflows row) |
| **Run a team on a task**: spawn a thread per node, `{task}`/`{inputs}` templating, parallel branches, step timeout, cancel, outputs of final nodes (`startRun`, `executeRun`) | The stage machine runs Helm's fixed pipeline | Out of scope |
| CLI `bb visual-workflow list/show/teams/run/runs/status/cancel` | `bb helm …` | Out of scope |
| `role_spawn`: one role thread, optional Tasks key | none | Out of scope |
| Import from the `agent-roles` plugin | none | Out of scope |
| `::workflow-role` chat card, role badge in thread header | none | Gap (small) · UI in progress |

## workflows (built-in)

Not absorbed, as §12 says. For the record, it provides:

- agent tools `bb_workflow_run` and `bb_workflow_result` (structured, schema-checked results);
- CLI `bb workflows run/validate/status/history/stop` with `--resume <run-id>`, which reuses recorded results;
- background service `workflow-worker`;
- a "Workflow run" thread panel and a `workflow-preview` chat directive;
- settings for max active runs, agents per run, agent calls per run, total timeout and retention;
- skill `workflows`, which covers JavaScript scripts run in a QuickJS sandbox with `agent()`, `pipeline()` and phases.

Helm's pipeline is the app stage machine (§5). Nothing here is needed for it.

## jev-orchestrator

There is no source or skill to read. The leftover database schema shows what it did:

- `runs`: goal, orchestrator thread, `jev_model`, input and output tokens.
- `tasks`: for each task:
  - a **demand score** (score, level, confidence, `bumped`);
  - a **harness classification** (harness, confidence, `uncertain`);
  - a **seat** (`seat_id`/`seat_label`) resolved to provider, model, reasoning and service tier;
  - a `capped` flag;
  - a post-run **grade** (score, level, confidence).

| Capability (inferred from schema) | Helm | Status |
|---|---|---|
| Model "seats" resolved to a provider/model/reasoning/tier tuple | Slots and presets (`domain/models.ts`), Model Studio (`components/helm/studio.tsx`) | Covered · UI in progress |
| Per-task demand scoring that routes to a seat, with bump and cap | Model choice is per role slot. Changes are explicit `model` directives. | Out of scope |
| Post-run grading of each task's output | Gate verdicts are pass/fail with findings (`domain/verdict.ts`), not graded scores | Out of scope |
| Token count per run | Tokens per node from `threads.context`, priced in relative units (DECISIONS 6) | Covered |

## What the §12 table missed

1. **agent-graph has no ghost nodes.** Its only placeholders are "+N earlier turns" fold nodes. Ghost nodes for threads outside the run are Helm's own Observatory idea (§11.4), not something being absorbed. What agent-graph really adds is a turn, tool-call and subagent drill-down for **any** thread, plus a CLI tree view. Helm does not do either, deliberately.
2. **chief reads a per-project rules file (`chief.md`)** and automatically replaces a dead Chief. It also files managed threads into a "Chief" sidebar section and adds a homepage "Start Chief" launcher. Helm has none of these.
3. **command-center is tied to the Tasks plugin.** Cards are Tasks tasks, lane moves update Tasks, and comments go to Tasks. Helm has no Tasks integration, although §12 says Helm must cooperate with `tasks`.
4. **command-center pushes notifications**: macOS banners for lane changes, stalls and comments, plus a sidebar badge count. It also has snooze, answer retraction (CORRECTION), voice capture and spoken commands, ad-hoc request intake with a priority queue, named workflows, and unarchive.
5. **crew is much more than templates, handover and Replay.** It has:
   - peer messaging with delivery rules and loop limits;
   - a shared channel and a claimable work queue;
   - merge-to-`main` through an integrator, gated on `checks`, plus `crew_rebase`;
   - cross-crew `waitsFor` dependencies;
   - a four-rung follow-up ladder;
   - context-based relief that suggests a handover at 60 % / 80 %;
   - snapshot and restore;
   - remote-host placement;
   - an editable crew file (YAML plus a canvas editor);
   - a public RPC contract for other plugins;
   - sidebar status icons and command palette entries.

   The §12 row's "handover in BRIEF" now works for replacement threads (DECISIONS 20). Context-based relief is not ported.
6. **visual-workflows is mainly a DAG workflow designer and runner**: a team canvas that spawns a thread per node, with templated inputs, parallel branches and timeouts. Its role registry exists to serve that. Helm absorbs only the registry idea, and the editable part (Settings → Roles) does not exist yet.
7. **jev-orchestrator's source is gone.** Its schema shows per-task demand scoring, harness classification and output grading, beyond simple "model slots". Helm keeps only the slot idea.

## Gaps worth deciding

These go to the human. Nothing in this list was changed.

| Gap | Why it may matter |
|---|---|
| No notifications for Helm-raised needs (plan, signoff, budget, stalled, failed) | Needs you only works if someone is watching. command-center sent banners and showed a badge. |
| No Tasks plugin cooperation | §12 lists `tasks` as a built-in Helm must cooperate with. command-center users relied on it. |
| Settings → Roles editing does not exist (no RPC, no UI) | The §12 row for visual-workflows promises it. |
| ~~Handover brief never populated~~ (fixed, DECISIONS 20) | A replaced node now gets a hand-over from Helm's records. |
| Snapshots, Replay and Observatory Adopt: tables and repo methods exist, but nothing calls them | Planned for Phase 6 and §11.4. Until then, crew's snapshot/restore and Replay have no equivalent. |
| Small: snooze, cross-app dependencies, a per-project rules file, a thread header badge or panel action | Each was used by exactly one old plugin. Each can be added later without changing the design. |
