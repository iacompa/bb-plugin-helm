# Helm — build prompt for the BB plugin

> You are a coding agent running inside BB. Build **Helm**: ONE BB plugin that runs a whole portfolio of app builds as an orchestration hierarchy — **Orchestrator → Managers → App Leads → Specialists + Gates** — with a **graph**, a **board**, a **change ledger**, a **"Needs you" inbox** and a **Model Studio**. This file is your complete brief. Read all of it before you write code.

The human who commissioned this builds many apps at once (10 or 20 is normal). They want to say what they want in plain words, approve a plan, then watch and steer a small army of agents without losing track of anything. Every rule below exists to protect that.

---

## 0. Read this first

### 0.1 What is in this folder

| File | What it is | How to use it |
|---|---|---|
| `PROMPT.md` | This brief | The requirements, rules and phases. |
| `ui-prototype.html` | A working, clickable UI prototype with sample data (20 apps, 5 managers, 169 agents). Self-contained: open it in a browser. | **The UI contract.** Click through every view before you design the app. Port the look, layout, copy and behaviour. Do not copy its code (it is vanilla JS with faked data; the plugin is React over real data). |
| `appendix-roles-and-squads.md` | Role briefs, document templates, squad shapes, the wave algorithm, draft `SKILL.md` texts | Source for `skills/` and for the briefs the engine writes. |
| `appendix-slop-policy.md` | Slop categories, scanner design, verdict schema, fixtures | Source for the two gates and `helm_slop_scan`. |
| `appendix-research-notes.md` | Where the design ideas come from | Context. Optional. |

### 0.2 Ground rules

1. **Phase 0 first.** §2.3 lists platform assumptions that are not yet proven. Prove or refute each with a small experiment before building on it (§15, Phase 0). Where reality differs from this brief, **reality wins**: use the stated fallback, write down what you found in `docs/VERIFY.md`, and carry on.
2. **Cost discipline in development.** Helm spawns many agents. While developing:
   - never start a real run with more than **6 agents**;
   - use the cheapest model on this machine for every real test run (read it from `bb provider models`; today that is `claude-haiku-5-5` at `low`);
   - run the big scenarios (20 apps, 169 agents, failures, restarts) **only against the simulated BB adapter** (§14), never against real providers.
3. **Never poll.** Use BB events (`api.events.on`), the realtime channel, and BB's own lifecycle notices. A `background` cron is allowed only to inspect Helm's *own* database for stalls (§9.5), never to ask BB "is it done yet".
4. **Evidence, not assertions.** An agent saying "done" is a claim. Helm records it as a claim until it has checked what it can (commit exists on the branch, file exists, checks exited 0). The same applies to your own report to the human (§17.4).
5. **Take the defaults.** For each open decision in §17.2 use the stated default, record it in `docs/DECISIONS.md`, and keep going. Interrupt the human only for what only they can supply: a credential, a model choice, a destructive action.
6. **Do not depend on the old plugins.** `agent-graph`, `chief`, `command-center`, `crew`, `visual-workflows` and `workflows` are installed but **disabled**, and they stay disabled. Do not enable, import from or call them. You may read their installed source and skills to confirm Helm covers what they did (§12). `jev-orchestrator` is superseded too.
7. **Stay in your lane.** Helm manages only the threads it spawns. For everything else it is read-only (the Observatory, §11.4). Never archive, stop or edit a thread you did not create.
8. **Secrets.** Never log or store credentials, tokens or keys. The plugin server makes no network calls of its own and sends no telemetry; it talks to BB through `api.sdk` only.
9. **Be honest.** If a test fails, say so with the output. If a step is skipped or unverified, say so. Do not write "should work".

### 0.3 How BB plugins are built (orientation)

```
bb plugin new helm          # scaffolds ./bb-plugin-helm
bb plugin types [path]      # repins @get-bb/plugin-sdk typings; read them, do not guess shapes
bb plugin dev [path]        # watch + rebuild + reload while you work
bb plugin build [path]
bb plugin install path:<dir>   # then: bb plugin list / bb plugin logs helm / bb plugin reload helm
bb plugin config helm [set <key> <value>]
```

A package plugin has `package.json` with a `bb` block (`name`, `description`, `branding.icon`, `server: "./server.ts"`, `app: "./app.tsx"`) and `engines` (`bb >= 0.43`, `bbPluginSdk >= 0.4.104`), a `server.ts` that default-exports a factory over `BbPluginApi`, an `app.tsx` built with `definePluginApp` from `@get-bb/plugin-sdk/app`, and a `skills/` folder. The typings live in `node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts` (about 900 KB; grep it, do not read it whole).

---

## 1. The product

### 1.1 One paragraph

The human writes a plain-language brief ("build these 20 apps…"). Helm's **Orchestrator** reads it and proposes a **plan**: how many apps, how many **managers**, which **squad** each app gets, what runs in which **wave**, and what it will probably cost. The human picks **models** (Helm asks every run) and approves. Helm then spawns the hierarchy lazily. Each **App Lead** owns one app end to end; its **specialists** build UI, core logic, each platform, and security; two independent **gates** — a **Reviewer** and a **Slop Hunter** — must pass before the app can be signed off. At every moment the human can click any agent, read its chat, see its model and what it is talking about, and **change it**; every change is delivered to that agent **and to its whole chain of command**, so nobody is ever surprised.

### 1.2 The hierarchy

```
                              You
                               │
                        ┌──────┴──────┐
                        │ Orchestrator │  strategy · staffing · knows everything
                        └──────┬──────┘
          ┌───────────┬────────┼────────┬───────────┐
       Manager     Manager   Manager  Manager     Manager        only when apps > 4
       (≤4 leads)                                                (default span 4, ceiling 6)
          │
   ┌──────┼──────┬──────┐
 App Lead  …     …      …        one per app: SPEC · ARCHITECTURE · CONTRACT · DECISIONS · integration
   │
   ├── UI builder          design system, screens, motion
   ├── Core builder        logic, data layer, functionality
   ├── Platform builders   one each: macOS · Windows · iOS · Android
   ├── Security            threat model, dependencies, secrets
   ├── (Test)              optional
   ├── Reviewer      ◄ gate, spawned when integration checks are green
   └── Slop Hunter   ◄ gate, spawned after the Reviewer passes
```

Roles and tiers:

| Tier | Roles | Spawned | Writes |
|---|---|---|---|
| `orchestrator` | Orchestrator | at run start | `PORTFOLIO.md` (Studio project) |
| `manager` | Manager | at run start (only if apps > 4) | `MANAGER-NOTES.md` |
| `lead` | App Lead | when the app is admitted (Intake → Spec) | `SPEC.md`, `ARCHITECTURE.md`, `CONTRACT.md`, `DECISIONS.md`, `ACCEPTANCE.md`, integration merges |
| `specialist` | UI, Core, Platform×P, Security, Test, (Research, Docs) | when the SPEC is approved by the lead | only inside its write scope |
| `gate` | Reviewer, Slop Hunter | lazily, at their stage | `reports/**` only; read-only on source |

### 1.3 Five promises (each one is an acceptance test in §16)

1. **One sentence in, a staffed plan out.** The human describes what they want; Helm shows the proposed org (counts, groups, waves, cost range) **before** anything spawns.
2. **Nobody is surprised.** Any human change to any agent is delivered to that agent **and every ancestor up to the Orchestrator**, recorded in a ledger with delivery receipts, and phrased as binding ("adapt, don't undo").
3. **Models are asked every run.** Helm reads the live model catalog, pre-fills only what the human has told it, and never guesses a coordination role's model.
4. **Nothing is "Ready" on an agent's say-so.** Ready needs a passing Reviewer verdict, a passing Slop Hunter verdict **and** green deterministic checks, all with evidence.
5. **Cost and size are bounded and visible.** Hard caps on agents, concurrency and budget; a running forecast; a one-click "Spawns paused".

### 1.4 Staffing math (the engine and the wizard must agree)

Per app, with `P` = number of target platforms:

```
agents(app) = 1 lead + 1 UI + 1 Core + P platform + 1 Security + 1 Reviewer + 1 Slop Hunter = 6 + P      (Full shape)
```

Per run with `n` apps and `m` managers:

```
specialists = 3n + ΣP          (UI + Core + Security per app, plus platform builders)
gates       = 2n
total       = 1 + m + n + specialists + gates
```

Worked example (the sample brief in the prototype): 20 apps, ΣP = 43 → `m = 5`, leads 20, specialists `60 + 43 = 103`, gates 40 → **169 agents at most**. Gates exist only once their stage is reached, and many apps will be at different stages, so the live count is far lower. The default hard cap `maxTotalAgents` is **250**; the wizard and the engine both refuse a plan that exceeds it.

### 1.5 Dynamic sizing — the collapse rules

The human asked for this explicitly: the structure must fit the job ("one agent that orchestrates two, or one agent that orchestrates three"). Implement these rules in one pure function `planTopology(portfolio, settings)` and unit-test it table-driven.

| Rule | Condition | Result |
|---|---|---|
| **C1** | exactly 1 app | The Orchestrator **also acts as the App Lead** (one node, both toolsets). No manager. |
| **C2** | 2–4 apps | Orchestrator → App Leads directly. **No manager layer.** |
| **C3** | more than 4 apps | Managers are added. Group size ≤ `managerSpan` (default **4**, ceiling **6**). `k = ceil(n / managerSpan)` managers, groups balanced (e.g. 18 apps, span 4 → 5 managers of 4,4,4,3,3). If the brief's `#` headings (or the planner's detected themes) give groups that **all fit** within the span and number ≤ `orchestratorSpan`, keep them as written ("semantic grouping"); otherwise balance. |
| **C4** | a semantic group of exactly 1 app | That lead reports **directly to the Orchestrator** (no one-app manager), provided the Orchestrator's span allows it. |
| **C5** | managers (+ direct leads) > `orchestratorSpan` (default **6**, ceiling **8**) | **Error**, with the fix in the message: raise the manager span (max 6) or split the work into two runs. Never silently exceed a ceiling. |
| **C6** | each app | Squad **shape**: **Full** (default; the staffing above), **Lean** (UI + Core + one builder per platform only when P > 1, no standalone Security agent — the Reviewer's security checklist and the deterministic scanner cover it), **Solo** (the lead builds; no specialists). **Gates exist in every shape** and are never optional; only the human can waive a gate, per app, with a recorded reason. |
| **C7** | per lead | At most `leadSpan` (default **6**, ceiling **8**) specialists **running at once**. If an app has more builders than that (e.g. P = 4 → UI, Core, 4 platforms, Security = 7), the lead staggers them: platform builders start after the Core builder has published the first CONTRACT. |

Prototype note: the wizard in `ui-prototype.html` implements C2/C3/C5 and shows Full-shape counts. C1, C4, C6 and C7 are **specified here but not in the prototype**; add them to the real wizard (a small shape chip per app row: "Full · 8 agents ▾").

### 1.6 What the human can do (the full list — build every one)

- Describe work in words; get a plan; approve it; or run a **dry run** that writes the plan and briefs but spawns nothing.
- Choose **models per role**, per app, per agent — and be asked at every run.
- See the whole org as a **graph**; click any node to read its **chat**, **model**, **role**, what it is **talking about now**, its **brief**, **reports**, **comms**, and every **change** made to it.
- **Change any agent**: message it, change its model, edit its brief/scope, pause/resume/stop/retry it, set priority, waive a finding, answer a question, approve/deny, sign off or send back. Choose who it applies to (this agent / + its direct reports / + everyone below).
- Talk to any lead or manager individually, or to the Orchestrator, which answers questions about the whole portfolio from its world state.
- Use a **board**: apps by stage (with swimlanes by manager) and agent tasks by status.
- Work from one **Needs you** inbox for approvals, questions, failures, slop blocks, wave plans and sign-offs.
- Set **standing policies** ("no third-party analytics in any app") that are injected into every agent spawned from then on.
- Cap spend and size; pause all spawning with one click.

Read the prototype now, then continue.

---

## 2. The platform: what is known, what is not

### 2.1 Verified (read from the 0.4.104 typings and `bb --help` on this machine)

Use the exact names below. When you need a shape, `grep` the typings; do not guess.

**Plugin entry points**
- `server.ts`: default-export a factory over `BbPluginApi`. Surfaces: `settings`, `storage` (KV + SQLite), `http`, `rpc`, `realtime`, `background` (services, cron), `cli` (`defineCli`, `cliCommand`; one `register` per factory run), `agents`, `events`, `experimental_hooks`, `ui`, `status`, `sdk`, `onDispose`.
- `app.tsx`: `definePluginApp` from `@get-bb/plugin-sdk/app`. Slots: `navPanel`, `threadPanelAction`, `homepageSection`, `settingsSection`. Hooks: `useRpc`, `useRealtime`, `useBbNavigate`, `useBbContext`, `useSettings`, `useComposer`. Component: `ThreadChat`.

**Threads (`api.sdk.threads`)**
- `spawn(args)`: `CreateThreadRequest` (minus `input`, `origin`, `originKind`, `startedOnBehalfOf`, which are optional here) plus `prompt: string` or `input`. Useful fields: `projectId`, `title`, `model`, `providerId`, `reasoningLevel` (`none|low|medium|high|xhigh|max|ultra|ultracode`), `serviceTier` (`default|fast`), `permissionMode` (`accept-edits|auto|full|workspace-write`), `parentThreadId`, `lifecycleOwnerThreadId`, `visibility` (`hidden|visible`), `sectionId`, `sendAt`, `pluginMetadata` (JSON object), and `environment` — a union by `type`: `reuse {environmentId}` · `host {hostId?, workspace: unmanaged {path, branch?} | managed-worktree {baseBranch: named {name} | default} | personal}` · `project-default` · `provider {environmentProviderId, inputs, machine?}`.
- `send(args)`: `SendMessageRequest` + `threadId`. `mode` is one of `queue-if-active | steer-if-active | auto | start | steer`; also `senderThreadId?` (set it when one agent messages another), `model`, `reasoningLevel`, `permissionMode`, `sendAt`, `serviceTier`.
- `update(args)`: `model`, `parentThreadId` (nullable), `reasoningLevel`, `sectionId`, `title`, `visibility`.
- `list({archived, environmentId, sectionId, hasParent, includeHidden, limit, offset, originKind, originPluginId, parentThreadId, projectId, sourceThreadId, unsectioned})`, `search`, `count({groupBy, hostId, parentThreadId, projectId, providerId, status})` (a server-side `COUNT`; **use it for capacity checks, never page `list`**), `listRunning`.
- `getPluginMetadata / updatePluginMetadata({threadId, pluginId, set, remove})`.
- `get`, `stop`, `archive`, `archiveAll`, `unarchive`, `retry({threadId, turnRequestId?, sendAt?, reason?})`, `compact`, `context` (recorded context usage, may be `null`), `output` (last assistant output), `timeline`, `wait({threadId, status|event, timeoutMs})`.
- `interactions.{list,get,respond,resolve,cancel}`, `queue.list`, `queuedMessages.*`, `events.{list,wait}`, `childSummary`.
- Also: `projects.create({name, source: {type: "local_path", hostId, path}})`, `providers.list / models`, `threadSections.{create,list,update,delete}`.

**Events (`api.events.on(name, handler)`; announcements, return values ignored)**
`thread.created`, `thread.active`, `thread.idle` (payload includes **`lastAssistantText`** — your cheapest source for "what is it talking about"), `thread.failed` (with `error`), `thread.archived` (including cascade archives), `thread.unarchived`, `thread.deleted`, `interaction.pending` (thread + interaction), `message.queued`, `message.dispatched`, `message.cancelled`, `turn.failed` (with `attemptNumber`), and `experimental_thread.events` (debounced to at most 1/s per thread).
`message.dispatch` is a *hook* (in `experimental_hooks`), not an event: its input names the author category (`initiator`: `user | agent | system | mixed`) and `senderThreadId` (null when a human typed it).

**Agents (`api.agents`)**
- `registerTool({name, description, instructions?, presentation?, parameters, execute(params, ctx)})`. `parameters` is a zod schema (validated) or raw JSON schema. Names match `[a-zA-Z0-9_-]+` and must be unique across plugins. `ctx = { threadId, projectId, signal }`. `instructions` (≤ 4096 chars) is appended to the thread's instructions whenever the tool is in the session's tool set. `presentation` controls how calls read in the timeline (labels, icon, tint, `suppress`).
- `configure(ctx => ({ tools, skills, instructions? }))`: **one callback per factory run; synchronous; runs at `thread.start` / `turn.submit`.** `ctx` has `pluginMetadata` (**untrusted**: any client, plugin or the agent itself can write it), `thread {id, title, parentThreadId, sourceThreadId}`, and `project`. **Tool and instruction changes apply only when the provider session is next started or resumed**, never to a running session. More than 256 ids fails closed.
- `ui.requestInput(request)` opens a form in the thread composer; inside a tool's `execute` the tool call returns a waiting notice immediately and the eventual answer reaches the agent as a message.

**CLI facts** (`bb thread spawn --help`): `--parent-thread`, `--parent-self`, `--visibility hidden|visible` (a child inherits its parent's), `--lifecycle-owner-thread`, `--new-environment worktree --base-branch`, `--provider`, `--model`, `--reasoning-level`, `--service-tier`, `--permission-mode accept-edits|auto|full`, `--section`, `--title`, `--send-at`, `--plan`, `--prompt-file` (use it; backticks in a double-quoted `--prompt` get executed by the shell). `bb helm` is **not** an existing command, so the name is free.

**Behaviours that shape the design**
- A parent's permission mode is a **hard ceiling** for its children.
- Parents get native lifecycle notices when a child completes, fails or is interrupted (exact text and timing: V2).
- `tell` steers by default; `--mode queue` does not interrupt a running turn.
- **`stop` does not cascade.** Archiving a thread with a lifecycle owner cascades (V20). Helm must stop descendants itself, bottom-up.
- **Hidden threads raise no attention indicators in BB.** Helm must surface their pending interactions itself (the "Needs you" inbox).
- Built-in plugins already exist for `concurrency-limit`, `tasks`, `provider-retry` and `provider-usage`. Helm's caps are *additional* to BB's; the stricter wins. Do not fight `provider-retry`: treat a node as `failed` only after the thread lands in `error` with retries exhausted.

### 2.2 The model catalog on this machine (for fixtures and defaults only — **read it live, never hard-code it**)

One host (a Mac). `codex`: `gpt-6.1-sol` (default), `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol|terra|luna` — reasoning `none…ultra`. `claude-code`: `claude-opus-5-5`, `claude-fable-5-1`, `claude-sonnet-5-5` (default), `claude-haiku-5-5` and older — reasoning `low, medium, high, xhigh, ultracode, max`. `acp-cursor`: Auto, `grok-4.6`, `composer-2.5`. `acp-grok`: `acp-default`. Only one machine is connected, so **Windows and Android builds cannot be verified locally** (§5.4).

### 2.3 Verify-first table (Phase 0 produces `docs/VERIFY.md` with evidence for every row)

Mark each row **confirmed / refuted / changed**, paste the evidence (command + output), and switch to the fallback where needed. V1 and V11 are already resolved.

| # | Question | How to test cheaply | If it fails → fallback |
|---|---|---|---|
| V1 | ✅ Spawn accepts parent, visibility, model, reasoning, permission mode, metadata, title, section, environment, lifecycle owner | read typings | — |
| V2 | What exactly does a parent receive when a child finishes/fails/is interrupted, and when? Does it duplicate what Helm would send? | spawn a parent and a trivial child on the cheap model; read the parent's transcript | Helm sends its own "child finished" notice only when no native one arrived; dedupe by `(childThreadId, event)` |
| V3 | ✅(partial) Tool `ctx.threadId` identifies the calling thread; DB lookup by it gives the node | a smoke tool that echoes the node it resolves | core to the design — if broken, stop and report |
| V4 | Does `interaction.pending` fire for **hidden** threads, and does `threads.interactions.respond` from the plugin answer it? | hidden thread whose agent asks for a permission | on `thread.active` for hidden threads, call `interactions.list` once per transition (still no timers) |
| V5 | Does `ThreadChat` render any thread (including hidden), live, with a composer? | embed it in a panel | render `timeline`/`output` through RPC and send through `threads.send`; wrap sends in `directive()` |
| V6 | Permission ceiling: which `permissionMode` can a plugin-spawned grandchild actually hold? Best default per tier? | spawn Orchestrator→lead→specialist at `workspace-write` and `auto`; try an edit and a command | per-tier mode table in Settings; start the Orchestrator at the highest mode any descendant needs |
| V7 | Cheapest way to show "talking about now" for 170 nodes | use `thread.idle.lastAssistantText` and `helm_report`; read `timeline` only for the selected node | digest-only for unselected nodes |
| V8 | `providers.list / models` shape: reasoning levels, service tiers, any release marker | call it | NEW badges come only from Helm's own `seen_models` |
| V9 | Do managed worktrees need a git project? | try a non-git project | Helm creates a git repo per app, so require git |
| V10 | `threads.update({parentThreadId})` on a live thread: re-links? native notices follow? | test | "Adopt" in the Observatory becomes Helm-DB-only tracking |
| V11 | ✅ `bb helm` is free | `bb helm` → unknown command | — |
| V12 | Per-tier tools: `configure` is sync and runs at thread start, so select tools from `ctx.pluginMetadata` (a **hint**) and **authorize inside every tool's `execute`** from the DB row for `ctx.threadId` | test with a spoofed metadata write | — (design already assumes it) |
| V13 | Worktree cost: disk and creation time for ~170 environments | create 20 trivial worktrees, time them, extrapolate | gates reuse the lead's integration worktree read-only (and Helm verifies an empty diff); or `project-default` for gates |
| V14 | Can `provider-usage` give real spend per thread? | read its CLI/service surface | relative cost units only (§7.6) |
| V15 | Canvas at 170–250 nodes | the prototype's HTML+SVG approach, scaled up | level-of-detail, collapse managers by default, canvas/WebGL if needed |
| V16 | Can the plugin create a project (`mkdir` + `git init` + `projects.create`) itself? | try from the plugin server | a short-lived bootstrap thread on the cheap model runs `mkdir`/`git init`; or `bb project create` if shelling out is allowed |
| V17 | Idempotent spawn lookup: `threads.list({originPluginId, parentThreadId, includeHidden:true})` then `getPluginMetadata` | kill mid-spawn, look up | encode the key in the title as `[helm:<key>]` and use `search` |
| V18 | Detect a **human typing directly into an agent's BB thread** (author category `user`, no sender) via `message.dispatched`/`message.queued` entries or the `message.dispatch` hook | type into a Helm thread | the Chat tab in Helm routes through `directive()`; direct typing is shown as "unobserved change" the next time Helm reads the thread |
| V19 | Does a `ui.requestInput` form raised inside a hidden thread's tool appear as a `PendingInteraction` Helm can answer? | test | Helm-native Needs-you items answered via `threads.send` |
| V20 | `lifecycleOwnerThreadId`: does archiving/deleting the owner cascade to children? What does `threads.archiveAll` do? | test with 3 levels | Helm archives bottom-up itself |

---

## 3. Data model

Helm's database is the **source of truth for structure** (who reports to whom, stages, directives, findings). BB is the source of truth for **threads**. Reconcile the two at start-up and on every `thread.*` event (§9.3).

### 3.1 Types

```ts
type Tier   = 'orchestrator' | 'manager' | 'lead' | 'specialist' | 'gate';
type Role   = 'orch' | 'mgr' | 'lead' | 'ui' | 'code' | 'platform' | 'security' | 'test' | 'research' | 'docs' | 'review' | 'slop';
type Platform = 'mac' | 'win' | 'ios' | 'and';
type Shape  = 'solo' | 'lean' | 'full';
type Stage  = 'intake' | 'spec' | 'build' | 'integrate' | 'review' | 'slop' | 'fix' | 'ready' | 'done';
type NodeStatus = 'planned' | 'queued' | 'running' | 'waiting' | 'needs' | 'paused' | 'idle' | 'failed' | 'done';
type ModelRef = { providerId: string; modelId: string; reasoning: string | null; serviceTier?: string | null };
type SlotId = 'orchestrator' | 'manager' | 'lead' | 'ui' | 'code' | 'platform' | 'security' | 'test' | 'review' | 'slop' | 'research' | 'docs';
```

Status meanings: `planned` no thread, not yet eligible · `queued` eligible, waiting for capacity, **no thread yet** (a queued node holds no worktree) · `running` thread active · `waiting` idle *by design* (a lead waiting on builders or a gate) · `needs` blocked on the human · `paused` held by the human · `idle` stopped by the human · `failed` retries exhausted or crashed · `done` complete **with evidence**.

`maxTotalAgents` counts every node whose status is not `planned`.

### 3.2 Ids

- Nodes: `orch`, `m0…`, `<app>.lead`, `<app>.ui`, `<app>.code`, `<app>.p.ios|and|mac|win`, `<app>.security`, `<app>.test`, `<app>.review`, `<app>.slop` (`<app>` = slug, unique per run; suffix `-2` on collision). In a C1 run the single node is `orch` and also owns the app.
- Directives `D-0001…` (per run) · policies `P-1…` · needs `N-…` · findings `F-…` · runs `run_<ulid>`.

### 3.3 Thread metadata written on every spawn

`pluginMetadata: { helm: { v: 1, runId, nodeId, tier, role, key } }`, where `key = "<runId>:<parentNodeId>:<childKey>"`. It is a **hint** for tool selection and for the idempotent-spawn lookup. **Never authorize from it** (§2.3 V12).

### 3.4 SQLite schema (migrate with a `schema_version` table; write forward-only migrations)

```sql
CREATE TABLE runs(
  id TEXT PRIMARY KEY, name TEXT, status TEXT,            -- planning|running|paused|done|cancelled
  brief TEXT, plan_json TEXT, settings_json TEXT,         -- frozen at start; later edits are directives
  studio_project_id TEXT, apps_root TEXT,
  budget_cap REAL, max_agents INTEGER, concurrency INTEGER, spawns_paused INTEGER DEFAULT 0,
  auto_advance TEXT DEFAULT 'ask',                        -- ask|auto
  created_at INTEGER, started_at INTEGER, ended_at INTEGER);

CREATE TABLE apps(
  id TEXT PRIMARY KEY, run_id TEXT, name TEXT, tagline TEXT, platforms TEXT,   -- JSON ["ios","and"]
  shape TEXT DEFAULT 'full', manager_node_id TEXT, project_id TEXT, repo_path TEXT,
  stage TEXT DEFAULT 'intake', priority TEXT DEFAULT 'normal',                 -- low|normal|high
  fix_round INTEGER DEFAULT 0, pct INTEGER DEFAULT 0, nouns TEXT);

CREATE TABLE nodes(
  id TEXT PRIMARY KEY, run_id TEXT, app_id TEXT, tier TEXT, role TEXT, platform TEXT,
  parent_id TEXT, thread_id TEXT UNIQUE, status TEXT DEFAULT 'planned', also_lead INTEGER DEFAULT 0,
  slot TEXT, model_json TEXT, model_override INTEGER DEFAULT 0,
  brief_md TEXT, brief_version INTEGER DEFAULT 1, scope_globs TEXT, branch TEXT, environment_id TEXT,
  priority TEXT DEFAULT 'normal', now_line TEXT, topics TEXT,                  -- "talking about now"
  tokens INTEGER DEFAULT 0, turns INTEGER DEFAULT 0, cost REAL DEFAULT 0,
  created_at INTEGER, spawned_at INTEGER, ended_at INTEGER, last_activity_at INTEGER, prev_status TEXT);
CREATE INDEX nodes_run_status ON nodes(run_id, status);
CREATE INDEX nodes_parent ON nodes(parent_id);

CREATE TABLE directives(
  id TEXT PRIMARY KEY, run_id TEXT, ts INTEGER, type TEXT, target_node_id TEXT,
  cascade TEXT DEFAULT 'self', mode TEXT DEFAULT 'steer', policy INTEGER DEFAULT 0,
  text TEXT, value_json TEXT, model_from_json TEXT, model_to_json TEXT,
  affected_json TEXT, actor TEXT DEFAULT 'human', implicit INTEGER DEFAULT 0);
CREATE TABLE directive_recipients(
  directive_id TEXT, node_id TEXT, level TEXT,                                 -- direct|full|digest
  world INTEGER DEFAULT 0, state TEXT DEFAULT 'queued',                        -- queued|delivered|ack|rec|failed
  outbox_id TEXT, delivered_at INTEGER, ack_at INTEGER, PRIMARY KEY(directive_id, node_id));
CREATE TABLE policies(id TEXT PRIMARY KEY, run_id TEXT, text TEXT, scope_node_id TEXT, from_directive TEXT, created_at INTEGER, retired_at INTEGER);

CREATE TABLE outbox(
  id TEXT PRIMARY KEY, run_id TEXT, kind TEXT,                                 -- spawn|send|update|stop|archive|project
  node_id TEXT, payload_json TEXT, idem_key TEXT UNIQUE,
  state TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0, next_attempt_at INTEGER, last_error TEXT,
  created_at INTEGER, done_at INTEGER);                                        -- pending|inflight|done|failed

CREATE TABLE findings(
  id TEXT PRIMARY KEY, run_id TEXT, app_id TEXT, gate TEXT, rule TEXT, severity TEXT, -- blocker|major|minor|nit
  path TEXT, line INTEGER, quote TEXT, why TEXT, fix TEXT, commit_sha TEXT,
  status TEXT DEFAULT 'open', round INTEGER, waiver_directive_id TEXT, created_at INTEGER);  -- open|fixed|waived|wontfix
CREATE TABLE checks(id TEXT PRIMARY KEY, run_id TEXT, app_id TEXT, name TEXT, command TEXT, status TEXT, exit_code INTEGER, output_ref TEXT, commit_sha TEXT, tier TEXT, ts INTEGER); -- tier: local|ci|none
CREATE TABLE stage_history(app_id TEXT, stage TEXT, entered_at INTEGER, exited_at INTEGER, evidence_json TEXT);

CREATE TABLE needs(
  id TEXT PRIMARY KEY, run_id TEXT, kind TEXT,                                 -- approval|question|signoff|failed|slop|plan|budget
  node_id TEXT, title TEXT, body TEXT, evidence TEXT, options_json TEXT,
  interaction_id TEXT, state TEXT DEFAULT 'open', created_at INTEGER, resolved_at INTEGER, resolution_json TEXT);

CREATE TABLE node_events(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, node_id TEXT, ts INTEGER, kind TEXT, summary TEXT, ref TEXT);
CREATE TABLE comms(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, ts INTEGER, from_node TEXT, to_node TEXT, kind TEXT, summary TEXT, directive_id TEXT);
CREATE TABLE seen_models(provider_id TEXT, model_id TEXT, first_seen_at INTEGER, last_seen_at INTEGER, acknowledged INTEGER DEFAULT 0, PRIMARY KEY(provider_id, model_id));
CREATE TABLE slot_presets(name TEXT PRIMARY KEY, slots_json TEXT, updated_at INTEGER);   -- user-saved; "Studio default" is seeded from §7.2
CREATE TABLE snapshots(id TEXT PRIMARY KEY, run_id TEXT, ts INTEGER, world_json TEXT);  -- Replay, Phase 6
```

Write every state change and its `node_events` row in **one transaction**. Keep rows small: summaries ≤ 600 characters; never store transcripts (BB has them).

---

## 4. Topology, capacity and scheduling

### 4.1 Limits (all configurable in Settings and per run; defaults are the starting point, ceilings are hard)

| Setting | Default | Ceiling | Meaning |
|---|---|---|---|
| `managerSpan` | 4 | 6 | leads per manager |
| `orchestratorSpan` | 6 | 8 | managers + directly attached leads under the Orchestrator |
| `leadSpan` | 6 | 8 | specialists *running at once* under one lead |
| `maxTotalAgents` | 250 | 400 | nodes whose status is not `planned`; spawning refuses beyond it |
| `concurrency` | 24 | 48 | agents `running` at once (the wizard slider is 4–48, step 2) |
| `providerCaps` | codex 12 · claude-code 16 · acp-cursor 4 · acp-grok 4 | — | running agents per provider; edit per machine |
| `fixRounds` | 2 | 3 | fix loops before the human is asked |
| `stallMinutes` | 20 | — | no activity from a `running` node (§9.5) |
| `budgetCap` | wizard default 2500 | — | relative cost units (§7.6); reaching it sets **Spawns paused** |

Capacity checks use `threads.count({status:'active', parentThreadId?, providerId?})` plus Helm's own bookkeeping; the stricter of Helm's and BB's `concurrency-limit` wins.

### 4.2 Admission, waves

- A **wave** is a batch of apps admitted together. `inFlightApps = floor(concurrency / 5)` (five concurrently running agents per in-flight app is the planning figure), `waves = ceil(apps / inFlightApps)`. Example: 20 apps at concurrency 24 → 4 in flight → 5 waves. This is an *estimate shown to the human*; real admission is dynamic.
- An app is **in flight** from Spec through Fix. **Ready** and **Done** apps do not count (they wait on the human, not on capacity).
- `autoAdvance = ask` (default): when slots free up and Intake apps are waiting, the Orchestrator proposes the next wave as a Needs-you item of kind `plan` (apps to start, agents it adds, forecast delta). Approving admits those apps. `auto` admits them without asking and posts a digest.
- Inside admitted apps, builders follow capacity automatically; there is no per-builder approval.

### 4.3 Priority when more is eligible than capacity allows

1. Nodes that unblock a Needs-you item or that a human directive just resumed/retried/spawned ("first in line").
2. App priority (`high` > `normal` > `low`).
3. Stage depth: later stages first; **gates before builders** (finishing work frees slots and shrinks work-in-progress).
4. Per-manager fair share (round-robin across managers so one group cannot starve the rest).
5. Older first.

### 4.4 What spawns when (lazy spawning is what keeps 169 agents affordable)

| Node | Spawn trigger | Environment |
|---|---|---|
| Orchestrator | run approved | the Studio project; visible thread |
| Manager | run approved (unless C1/C2) | the Studio project; hidden |
| App Lead | app admitted | the app's project; managed worktree `helm/<app>/integration`; hidden |
| Specialists | lead publishes SPEC + CONTRACT v1 and calls `helm_spawn_squad` | managed worktree `helm/<app>/<role>` off the integration branch; hidden |
| Reviewer | integrate → review (deterministic checks green on the merged commit) | worktree at the integration commit; **read-only by verification** (§5.3); hidden |
| Slop Hunter | review passed | same as Reviewer |
| Re-checks | after a fix round | **reuse** the existing gate thread (send "re-check commit X"); do not spawn a new gate |

By default only the Orchestrator is `visible` in BB's sidebar; everything else is `hidden` and reached through Helm (setting `showLeadsInSidebar`, default off). Spawn every non-orchestrator thread with `parentThreadId` = its parent's thread and `lifecycleOwnerThreadId` = its parent's thread (V20).

### 4.5 Changing the plan mid-run

- **Add apps** (the human says "also build X"): the Orchestrator calls `helm_propose_plan` with a *delta*; Helm validates it against §1.5 and §4.1 and raises a `plan` need. New apps join the manager with room; if none has room and the Orchestrator's span allows, a new manager is spawned. **Never rebalance live reporting lines** (V10).
- **Drop an app**: stop its subtree bottom-up, archive, mark cancelled; its slots return to the pool.
- **Change an app's shape** (Solo → Full): spawn the missing specialists; the reverse stops and archives the extras.

---

## 5. Stages, gates and evidence

### 5.1 Stage machine (per app; the board's columns)

| Stage | Meaning | Advances when (all mechanically checked where possible) |
|---|---|---|
| `intake` | admitted to the plan, waiting for capacity | wave approved / capacity free / human "Start now" → `spec` |
| `spec` | the lead writes SPEC, ARCHITECTURE, CONTRACT v1, ACCEPTANCE | lead calls `helm_stage(build)` and the four files exist and are committed |
| `build` | specialists build in parallel worktrees | every spawned builder reported done **with commits on its branch** |
| `integrate` | lead merges and runs deterministic checks | build + lint + tests (+ `helm_slop_scan` hard categories) exit 0 on the merged commit → `review` |
| `review` | independent Reviewer | valid verdict `pass` bound to the current commit → `slop`; `fail` → `fix` |
| `slop` | Slop Hunter + deterministic scan | valid verdict `pass` → `ready`; `fail` → `fix` |
| `fix` | at most `fixRounds` loops | builders fix → lead re-integrates → checks → gates re-run on the new commit |
| `ready` | all gates green | the human signs off → `done`, or sends back → `build` |
| `done` | signed off | squad threads archived bottom-up |

Every transition is recorded in `stage_history` with its evidence. **Stages never move by drag** except the human actions in §5.7.

### 5.2 Evidence, not assertions

`helm_stage` and `helm_report` take `evidence: [{kind:'commit'|'file'|'check'|'report', ref}]`. Helm verifies what it can: the commit exists on the named branch (`git rev-parse`), the file exists at that commit, the check row has `exit_code = 0` **and** `commit_sha` equals the integration HEAD. A transition whose evidence fails verification is **rejected** and the reason is returned to the calling agent as the tool result. A node that reports `done` without verifiable evidence stays `waiting` with a warning chip in the UI.

### 5.3 Gate protocol (Reviewer and Slop Hunter)

1. Gates are told the commit to judge and read `ACCEPTANCE.md`. They are read-only on source: they may run builds, tests and the scanner, and write only under `reports/**`.
2. They answer with **one** call: `helm_verdict(verdictJson)` — schema in `appendix-slop-policy.md` §6. Helm validates it:
   - `pass` requires **zero open `blocker` or `major` findings** and at least one check;
   - every check needs `how` and `ref` (a command and its output file, or a file:line);
   - every finding needs `path`, `line` and `quote`, and **Helm verifies the quote appears within ±2 lines of that line at the judged commit**. A finding that cannot be located is rejected as unverifiable (this is how hallucinated findings die);
   - anything the gate could not verify goes in `unverified[]` and is shown to the human at sign-off.
3. **Read-only enforcement:** after every verdict, Helm checks the gate's worktree is clean and HEAD equals the judged commit (anything outside `reports/**` counts as a violation). A violation rejects the verdict and raises a Needs-you item.
4. Gates should run on a **different model family from the builders** when possible (soft warning in the Studio, §7.4).

### 5.4 Platform verification tiers

| Platform | Local verification | Otherwise |
|---|---|---|
| iOS, macOS | `xcodebuild` / `swift test` on a connected macOS host with Xcode | tier `none` (flag it) |
| Android | Gradle + SDK present on a connected host | tier `ci` |
| Windows | a connected Windows host | tier `ci` (this machine has none) |

Detect with cheap probes at plan time (`xcodebuild -version`, `./gradlew --version`, `dotnet --info`) run by the engine through a short, cheap-model bootstrap thread, and show the result in the wizard's "Checks before start". For `ci` tiers the lead adds a CI workflow file to the repo and ACCEPTANCE marks those checks `verified-by-CI-only`. **Ready is still reachable**, but the sign-off card must say "Windows build not verified on this machine" and the human's sign-off is their explicit acceptance of that.

### 5.5 The fix loop

Round *k* (≤ `fixRounds`): the lead receives the open findings (severity ≥ major), assigns each to the owning specialist **by message with the finding id and file:line**, specialists fix and report with commits, the lead re-integrates, deterministic checks re-run, **both gates re-run on the new commit** (reusing their threads; the Reviewer verifies earlier findings first, then reviews the new diff). After the last round, anything still open raises a Needs-you item (`slop` or `failed`) offering: send back to Build with a note · waive named findings (reason required) · stop the app.

### 5.6 Sign-off

Reaching `ready` raises a `signoff` need containing the evidence (verdict summaries, checks, unverified items, CI-tier notes). Human actions: **Sign off** (confirm dialog → directive `signoff` → app `done`, squad archived bottom-up), **Send back** (reason required → app returns to `build`, gates reset to `planned`, the lead is told exactly why), **Reopen** from `done` back to `ready`.

### 5.7 Board rules (identical to the prototype)

- **Apps by stage:** allowed drags are Ready→Done (sign off), Ready→Build (send back, reason required), Intake→Spec (start now), Done→Ready (reopen). Everything else snaps back with a one-line reason ("Stages advance on evidence, not on drag").
- **Agent tasks:** Planned/Queued→Running (start now), Planned→Queued (spawn), Running→Queued (hold). `Needs you` items are resolved in the inbox; Done is final; moves to Waiting/Done/Needs are made by agents, not by drag.

---

## 6. Directives — how a human change reaches everyone who needs to know

This is the feature the whole product turns on. Build it first-class, test it hardest.

### 6.1 Types

| Type | Meaning | Notes |
|---|---|---|
| `tell` | message / instruction | `mode` steer (default) or queue |
| `model` | change model and reasoning | applies from the agent's next turn; records `from → to`; marks the node `override` |
| `scope` | edit the node's brief and write scope | bumps `brief_version`; the agent is told to re-read `BRIEF.md` |
| `priority` | `low/normal/high` for an app or node | feeds the scheduler (§4.3) |
| `pause` / `resume` / `stop` / `retry` | hold, release, end, re-run | `stop` cascades bottom-up when cascade ≠ self; `retry` uses `threads.retry` or a resume message |
| `waive` | waive a finding | gate nodes only; reason required; zero-tolerance categories need ≥ 20 characters and cannot be waived by a lead |
| `approve` / `deny` / `answer` | resolve a Needs-you item | the answer is delivered into the asking agent's thread |
| `signoff` / `sendback` | sign off or reject a Ready app | §5.6 |
| `plan` | approve a wave or plan delta | §4.2 |
| `spawn` | spawn a planned node now | jumps the queue |
| `policy` | make this directive a standing policy | §6.6 |
| `slots` | change Model Studio slots mid-run | scope `future` (new spawns only) or `all` (also running nodes' next turns) |

### 6.2 Cascade

`self` (just the target) · `reports` (target + direct children) · `subtree` (target + every descendant). Before sending, the Direct tab shows the counts and a rough cost ("12 agents · about $3 of extra reading"). `resolveCascade` is a pure function; test it.

### 6.3 Recipients — **the rule that satisfies "everyone above it must see it"**

```ts
function buildRecipients(d): Recipient[] {
  const affected = resolveCascade(d.target, d.cascade);          // every node the change applies to
  const out = new Map<NodeId, Recipient>();
  for (const id of affected)                                      // 1. every affected node, level 'direct'
    out.set(id, { id, level: 'direct', state: 'queued' });
  for (const id of affected)                                      // 2. every ancestor of every affected node
    for (const a of ancestors(id)) {
      if (out.has(a)) continue;
      const isParentOfAffected = affected.some(x => parentOf(x) === a);
      out.set(a, { id: a, level: isParentOfAffected ? 'full' : 'digest', state: 'queued' });
    }
  const orch = out.get('orch') ?? out.set('orch', { id: 'orch', level: 'digest', state: 'queued' }).get('orch')!;
  orch.world = true;                                              // 3. the Orchestrator ALWAYS has it in world state
  return [...out.values()];
}
```

- **direct** — the changed agent(s); **full** — the changed agent's *parent*: the complete notice, told it is binding; **digest** — every higher ancestor, a one-line summary; **world** — the Orchestrator's database-backed world state, updated in the same transaction as the directive, so `helm_world` can never be stale.
- When more than 6 nodes are affected, the **ledger and graph collapse** the direct recipients to the target plus a "+N below" group; **delivery and receipts are still per node**.
- The human can also change an agent that is `planned` or `queued` (no thread yet): the directive is stored and injected into its spawn prompt under "Changes made before you started", and its receipt becomes `delivered` at spawn.

### 6.4 Receipts

`queued` (outbox row exists) → `delivered` (BB's `message.dispatched` for that exact send) → `ack` (the recipient called `helm_ack`, for `direct` and `full` only) or `rec` (a `digest` recipient: recorded in its digest queue and world state; no ack needed). `failed` is shown in red with a Retry. If a `direct`/`full` recipient reaches its next idle without acking, send **one** reminder (`queue-if-active`); after that show a warning dot, do not block.

### 6.5 Notice text (port these templates verbatim into `directives/notices.ts`)

`base(type)`:

| type | base text |
|---|---|
| tell | “{text}” |
| model | model changed {from} → {to} |
| scope | brief edited to v{n}: {text} |
| pause | paused: {text or "held by the human"} |
| resume / stop / retry | resumed / stopped / retry requested — by the human |
| priority | priority set to {value}[: {text}] |
| waive | finding waived: {text} |
| spawn | spawned now by the human |
| signoff | signed off by the human — the app is done |
| sendback | sent back to Build by the human: {text} |
| approve / deny / answer / plan | approved / denied / answered / plan approved by the human: {text} |

`scopeNote`: cascade `reports` → " Applies to this agent and its direct reports."; `subtree` → " Applies to this agent and everyone below it."

- **direct:** `{Lead} ({id}): {base}.{tail}{scopeNote}` where Lead is "Message from the human" / "The human changed your model" / "The human edited your brief" / "The human paused you" / … and `tail` is: model → " Applies from your next turn — do not revert it." · pause → " Stop after the current step and wait." · scope → " Re-read BRIEF.md and stay inside the new scope." · tell → " Treat this as binding; adapt your plan."
- **full (the parent):** `Your direct report {name} was changed by the human ({id}) — {base}.{scopeNote} This is binding: do not undo it; adjust your plan and reply with helm_ack {id}.`
- **digest:** `{id} · {name} — {base} (by human, {hh:mm}).`
- **world (Orchestrator):** the digest line + `Recorded in world state: {k} agents touched by you.`

### 6.6 Delivery rules

- `direct`: the human's `mode` (default **steer**). `full`/`digest`: `queue-if-active` (never interrupt a manager for FYI) — **except** `stop`, `pause`, `model`, `priority` and `signoff`/`sendback`, where `full` uses `steer-if-active`.
- **Coalesce digests:** notices for the same recipient created within 20 s become one message with one line per directive.
- Send through the **outbox** (§9.2) with `idem_key = "<directiveId>:<nodeId>"`. Set `senderThreadId` only for agent-to-agent traffic, not for human directives.
- `pause` is Helm-implemented (BB has no native pause): steer the notice, set status `paused`, and refuse to wake the node with anything but a `resume`/`stop`. A `queued` node is simply held.
- **Implicit directives (V18):** if the human types straight into an agent's BB thread, record an `implicit` `tell` so the chain is still informed; the notices say "(typed directly in the agent's thread)".

### 6.7 Standing policies

A directive with `policy: true` also creates `P-n` scoped to the target's subtree. Policies are injected into (a) the prompt of every node spawned in that scope from then on (a "Standing policies that apply to you" block, ≤ 1,200 characters, overflow summarized with "see `helm_context`"), (b) `helm_context`, (c) the Orchestrator's world state. At most 20 active; the Ledger can retire one (which is itself a directive). Run-level policies from settings (e.g. "Slop gates are zero-tolerance for secrets, placeholders and invented dependencies") are seeded at run start.

### 6.8 Talking to the Orchestrator

The Orchestrator's Chat tab is a normal BB thread. A message that is a **question** (ends with `?` or starts with what/which/how/why/who/where/status/summary/show/list/tell me) is *not* a directive: the Orchestrator answers from `helm_world`. Anything else becomes a `tell` directive. The three canned buttons in the prototype ("What did I change today?", "What is blocking progress?", "How is spend tracking?") send ordinary questions.

---

## 7. Model Studio — models are asked, every run

AI models change fast and the human has access to many. Helm therefore **asks which models to use at the start of every run**, reads the **live** catalog from this machine, and lets the human change any of it mid-run.

### 7.1 Principles

1. **Ask every run.** The wizard's third step is the Studio. It cannot be skipped.
2. **Read the catalog live** (`providers.list` / `providers.models`, per the machine the thread will run on). Never hard-code model ids, reasoning levels or service tiers.
3. **Pre-fill only what the human has told you.** Coordination roles (Orchestrator, Managers, App leads) and any other slot the human has not specified are **never guessed**; Approve stays disabled while a required slot is empty, with the count shown ("2 slots still need a model").
4. **Warn, don't block.** Model choices produce soft warnings, never errors.

### 7.2 Slots (12)

| Group | Slot | Used by |
|---|---|---|
| Coordination | `orchestrator`, `manager`, `lead` | the three coordination tiers |
| Build | `ui`, `code`, `platform`, `security`, `test` | specialists (`platform` covers all four platform builders; `test` is optional) |
| Gates | `review`, `slop` | Reviewer, Slop Hunter |
| Support | `research`, `docs` | optional helpers |

Required before Approve: `orchestrator`, `manager` (if any manager exists), `lead`, `ui`, `code`, `platform` (if any platform builder exists), `security` (if any Full-shape app), `review`, `slop`. Slot descriptions and groupings: copy from `SLOT_DEFS` in the prototype.

### 7.3 Presets

Presets are named maps `slot → ModelRef`, stored in `slot_presets` (the human can "Save as preset"). Seed three:

- **Studio default** — exactly what the human has said they want today, nothing more:
  `ui` → GPT-6.1 Sol, **extra high** · `code` → Sonnet 5.5, **high** · `review` → GPT-6.1 Sol, **high** · `slop` → Sonnet 5.5, **high**. All other slots **unset**.
- **Cheap dev run** — every slot `claude-haiku-5-5` at `low` (for development and smoke tests).
- **Max quality** — as defined in `PRESETS` in the prototype.

Resolve preset entries against the live catalog on load. A model that no longer exists shows as "unavailable" and must be re-chosen. A "Fill the rest like Code builders" button (explicit click) copies the `code` slot into every unset slot; nothing is filled silently.

### 7.4 Validation, NEW badges, warnings

- **Validate** at wizard open, at Approve, and again at **every spawn**: provider present and available on the target machine; model id in the catalog; reasoning level in the model's list; service tier valid. If a spawn-time check fails, do **not** substitute: set the node `needs` with "Model X is no longer available — choose another" and a picker.
- **NEW badges:** compare the catalog with `seen_models` for this host. Unseen ids are **NEW** (a small accent tag in the list, plus a one-line banner "N models are new to you" — shown in the Studio, but not duplicated inside the wizard whose intro already says it). A badge clears when the model is used or acknowledged. Update `seen_models` at wizard open.
- **Same-family warning:** if the Reviewer or Slop Hunter model is in the same family as the UI or Core builders, show a "Heads-up — worth a thought, not a blocker" banner ("Reviewer and Code builders are both Anthropic models — they can share blind spots.") with **Keep my choice** (dismisses it for the session).
- **Older models** are hidden behind "Show older models" **if** the catalog marks them (V8). If it does not, drop that toggle and offer "Hide this model" instead (stored per user).

### 7.5 Precedence and scope

`node override  >  app override  >  run slots  >  preset`. Changing a node's model is a `model` directive (§6). Mid-run Studio edits have a scope chosen in the footer: **future** (new spawns only; the default) or **all** (also running nodes, applied at their next turn through `threads.update`). The footer states the effect: "3 slots change · 12 running agents affected · 31 planned".

### 7.6 Cost model (relative units; label it honestly)

There is no price API (V14), so Helm forecasts in **relative units**, never claiming dollars:

```ts
const BASE_TOK = { orch: 1800, mgr: 700, lead: 1400, ui: 900, code: 1100, platform: 800, security: 350, test: 300, review: 500, slop: 300 }; // k tokens per agent over its life (planning guess; recalibrate in Phase 2)
const RW = { none: .5, low: .7, medium: .85, high: 1, xhigh: 1.35, max: 1.7, ultra: 2.2, ultracode: 1.8 };                                 // reasoning multiplier
cost(agent)  = BASE_TOK[role] * model.weight * RW[reasoning] * 0.0075
forecast     = Σ over nodes (count × cost)      // shown as a range: 0.7× … 1.35×
```

`model.weight` is a per-model relative weight kept in Settings → Pricing (seed: Sonnet 5.5 = 1.0, Haiku 5.5 = 0.3, Opus 5.5 = 2.6, Fable 5.1 = 3.2, GPT-6.1 Sol = 1.5, GPT-6 Luna = 0.5; unknown models default to 1.0 and are flagged). If `provider-usage` yields real spend (V14) or the human enters $/M-token prices, show real money next to the units. **The prototype formats units with a `$` for readability; the real plugin shows `u` (units) unless prices are configured.** Actual spend per node comes from `threads.context` token counts when available, else from turns × a calibrated average. Show one honest warning in the wizard's Approve step: "Multi-agent runs use many times the tokens of one chat, because every agent reads its own context."

### 7.7 Reading the brief (the planner)

- If the brief already follows the structured shape (`# Group` headings and `- Name — tagline · iOS Android macOS` lines), **parse it deterministically** — port the prototype's `parseBrief` (default platforms when a line has none: `ios, and`, marked "assumed" in the UI).
- Otherwise run a **planner**: one short hidden thread on the model chosen in a **"Planner model"** field at the top of wizard step 1 (default: the `code` preset model at `medium`; it is a model choice, so it is the human's to change). The planner's only tool is `helm_propose_plan`, whose input is validated by a zod `PortfolioSchema`: `{ apps: [{name, tagline, platforms[], group?, shape?, notes?}], groups[], assumptions[], questions[] }`. It may return up to 3 `questions` (shown as chips before step 2: "Should Mint Jar also ship on Android?"). One turn, then the thread is archived.
- Whatever produced the portfolio, the topology (managers, groups, counts, "Why this shape") is computed by the **pure** `planTopology`, never by the model.

---

## 8. Agent tools, skills, world state, context hygiene

### 8.1 Tools (all prefixed `helm_`; register once, expose per tier)

| Tool | Tiers | Input → effect |
|---|---|---|
| `helm_context` | all | → my node, parent, children, standing policies that apply to me, directives I have not acked, CONTRACT version, capacity hints (≤ 2 KB) |
| `helm_report` | all | `{status: progress\|blocked\|done\|failed, summary ≤ 600 chars, evidence?[], blockers?[], next?}` → verifies evidence (§5.2), updates the node, forwards a digest to the parent (progress at most once per 2 min per child; blocked/done/failed immediately) |
| `helm_ack` | all | `{directiveId, note?}` → receipt `ack` |
| `helm_need` | all | `{kind: question\|approval\|decision, title, body ≤ 1200, options?[], evidence?}` → creates a Needs-you item, sets the node `needs`, returns "stop and wait; the answer will be sent to you" |
| `helm_message` | all | `{to, text, kind: info\|ask\|handoff}` → allowed targets: my parent, my children, my siblings **in the same app**. Cross-app traffic goes up through the manager/Orchestrator. Logged in `comms`. |
| `helm_world` | Orchestrator | `{appsPage?}` → §8.4 |
| `helm_propose_plan` | Orchestrator, planner | `{portfolio \| delta}` → validates against §1.5/§4.1, raises a `plan` need or returns validation errors |
| `helm_propose_wave` | Orchestrator | `{appIds[], rationale}` → a `plan` need (or auto-admits if `autoAdvance=auto`) |
| `helm_set_priority` | Orchestrator, Manager (within its group) | `{appId\|nodeId, priority, reason}` |
| `helm_digest` | Manager, Orchestrator | → rolled-up state of the apps under me |
| `helm_spawn_squad` | Lead | `{spawn: [{role, platform?}]}` → engine checks shape, `leadSpan`, caps; returns accepted / deferred with reasons |
| `helm_publish_contract` | Lead | `{version, summary}` → bumps CONTRACT version, notifies every builder of the app |
| `helm_stage` | Lead | `{to, evidence[]}` → transition per §5.1 or a rejection with the reason |
| `helm_assign_fix` | Lead | `{findingId, nodeId}` → messages the owner with file:line |
| `helm_record_check` | Lead, gates | `{name, command, exitCode, outputRef, commit}` → verified against the wrapper trailer (§8.5) |
| `helm_slop_scan` | Lead, specialists, gates | `{paths?}` → runs the deterministic scanner, records findings, returns them |
| `helm_verdict` | gates | the verdict JSON (appendix-slop-policy §6) → validated per §5.3 |

Give each tool a `presentation` (short pending/completed labels such as "Reporting to lead"/"Reported to lead", an icon, and `suppress: true` for pure bookkeeping calls such as `helm_ack`) so the BB timeline stays readable.

### 8.2 Selection is a hint; authorization is the truth (V12)

`agents.configure` is synchronous and runs at thread start, so it cannot hit the database. It chooses a tool list from `ctx.pluginMetadata.helm.tier` (a hint — an agent can write its own metadata). **Every tool's `execute` re-authorizes**: look up `ctx.threadId` in `nodes`, take the tier and role from the row, and refuse anything that tier may not call ("helm_stage is for App Leads"). Tier, identity, parent and app always come from the row, never from metadata or tool arguments. Quote or escape any metadata value that ever reaches instructions.

### 8.3 Skills and instructions

Ship `skills/` with one `SKILL.md` per tier: `orchestrator`, `manager`, `lead`, `specialist` (with role/platform sections), `reviewer`, `slop-hunter` (drafts in `appendix-roles-and-squads.md`). `agents.configure` returns the tier's tools and skills plus a **short** `instructions` string (≤ 1,500 characters, hard limit 4,096) that states role, parent, the three non-negotiables (report with evidence · ack directives · never poll) and points at the skill. Tool and instruction changes apply only at the next provider session start, so decide the whole set at spawn.

Each spawned agent's first prompt is built by `briefFor(node)` (template in the appendix): role and mission · its place in the org (parent, siblings, children by name) · inputs and outputs · **write scope** (globs) · current CONTRACT version · standing policies in scope · "changes made before you started" · rules of engagement.

### 8.4 The Orchestrator knows everything: `helm_world` and `PORTFOLIO.md`

`helm_world()` is a **database read** (never a thread scan) returning compact JSON (≈ 6 KB; paginate apps beyond 30):

```
run{ name, status, apps, managers, agents{spawned,running,queued,planned,cap}, spend{units, forecast, cap}, spawnsPaused, autoAdvance }
stages{ intake, spec, build, integrate, review, slop, fix, ready, done }
needs[ {id, kind, title, node, ageMin} ]                // open items
recentDirectives[ last 15: {id, type, target, summary, ageMin, receipts:{queued,delivered,ack,rec,failed}} ]
touched{ count, nodes[ids] }                            // agents changed by the human
policies[ {id, text, scope} ]
managers[ {id, name, apps:[{name, stage, status, priority, blockers[]}]} ]
```

Because every directive writes world state **in the same transaction** that records it, the Orchestrator can never be out of date about what the human changed.

`PORTFOLIO.md` (Studio project) is the Orchestrator's durable memory. Helm regenerates the block between `<!-- helm:world -->` markers (debounced 30 s, only on material change); the Orchestrator keeps strategy and decisions below it. After a compaction or restart it re-reads the file first.

### 8.5 Checks and the evidence wrapper

The plugin server may not be able to run commands (V16). So checks run **inside agents' environments** through a tiny wrapper Helm commits to every app repo at `.helm/run-check.sh <name> -- <command…>`: it runs the command, tees output to `reports/checks/<name>.txt`, appends a trailer line `[helm-exit:<code>] [commit:<sha>] [ts:<epoch>]`, and exits with the command's code. `helm_record_check` reads that file (through `files.read`), parses the trailer, and rejects mismatches (wrong commit, missing trailer, exit code disagreeing with the claim). The gates **re-run the whole check set themselves** with the same wrapper — independent evidence. If V16 shows the plugin server can execute commands, run checks from Helm directly with the same recorded schema and add `helm_run_checks`.

Checks are declared in `.helm/checks.json` (`name → {command, tier: local|ci, timeoutSec, category}`) and seeded by the lead from ACCEPTANCE.md.

### 8.6 Context hygiene

- Reports are summaries (≤ 600 chars) with evidence **refs** (paths, shas), never pasted content.
- The Orchestrator reads manager digests and `helm_world`, never raw transcripts. Managers read lead reports. Leads read specialist reports and diffs.
- Durable facts live in files (`CONTRACT.md`, `DECISIONS.md`, `BRIEF.md`, `PORTFOLIO.md`), not in chat.
- When `threads.context` shows a thread past ~70 % of its window (if the numbers exist), send "compact now, then re-read your BRIEF/PORTFOLIO" and call `threads.compact`.

---

## 9. The engine

### 9.1 Layers

`domain/` pure functions and types (topology, stages, directives, cost, parsing) → `engine/` (outbox, spawner, scheduler, reconcile, watchdog) → `bb/` a **`BbPort` interface** over `api.sdk` with a real implementation and a **simulated** one (§14) → interfaces (agent tools, RPC, CLI, realtime). Nothing outside `bb/` touches `api.sdk`.

### 9.2 Outbox

Every BB side effect (spawn, send, update, stop, archive, project create) is an `outbox` row created in the same transaction as the state change that caused it. One worker per run processes rows: per-node FIFO, different nodes in parallel up to 8 in flight. States `pending → inflight → done | failed`. Retry with backoff 2 s, 8 s, 30 s, 2 m, 10 m (± jitter), five attempts, then `failed` (visible, with Retry). `idem_key` is unique, so enqueuing twice is harmless.

### 9.3 Idempotent spawn

Key = `<runId>:<parentNodeId>:<childKey>`. Procedure: enqueue → **look for an existing thread first** (`threads.list({originPluginId:'helm', parentThreadId, includeHidden:true})`, match `pluginMetadata.helm.key` via `getPluginMetadata`; V17) → adopt it if found, else `threads.spawn` with the key in `pluginMetadata` → in one transaction store `thread_id`, set status, mark the outbox row `done`. A crash between spawn and the database write is healed by the lookup on retry. Never spawn a child for a parent that is not `running` or `waiting`.

### 9.4 Reconcile (at start, on `bb plugin reload helm`, on run resume)

For each non-terminal node: no thread but an in-flight outbox row → look it up (V17) · thread missing → `failed` + a Needs-you item · thread archived outside Helm → `idle` + event · thread idle but node `running` → `waiting`/`idle` by role · thread active but node `queued` → adopt. Then re-drive pending outbox rows, recount capacity with `threads.count`, and re-subscribe to events. Make this safe to run at any time and run it in tests after every simulated crash.

### 9.5 Failure, retry, stall

- `turn.failed` with attempts remaining: **do nothing** (`provider-retry` is handling it). `thread.failed` (retries exhausted): node → `failed`, Needs-you item with the error text, attempts, whether the worktree is intact, and actions **Retry** (resume from last commit) · **Change model and retry** · **Stop**.
- **Stall watchdog:** a `background` cron every 5 minutes that reads **only Helm's database**. A `running` node whose `last_activity_at` is older than `stallMinutes` gets one `queue-if-active` nudge ("status check: reply with helm_report"); silent for another `stallMinutes` → Needs-you "stalled". `last_activity_at` is bumped by `thread.active`, `experimental_thread.events`, `thread.idle` and tool calls. This is not polling BB.
- **Parent-only completion:** a specialist is `done` only when its own `helm_report(done)` passes evidence verification; a lead only through `helm_stage` and the human's sign-off. BB's native "child finished" notice is informational (V2).

### 9.6 Budget and "Spawns paused"

When `spend ≥ budgetCap`, or the human flips the top-bar switch, set `spawns_paused`. The scheduler admits nothing new; running agents finish their turn; a Needs-you item of kind `budget` offers **raise cap by X · keep paused · stop run**. The state is always visible in the top bar and always reversible.

### 9.7 Needs-you plumbing

Two sources, one inbox:
1. **Native interactions** — `interaction.pending` → a `needs` row (`approval`/`question`, `interaction_id`); resolving calls `threads.interactions.respond/resolve`.
2. **Helm-native** — `helm_need`, plan/wave proposals, sign-offs, slop blocks, failures, budget; resolving emits a directive (`approve/deny/answer/plan/signoff/sendback`) delivered through the outbox into the asking agent's thread.

Hidden threads give BB no attention indicator, so this inbox is the **only** place the human learns an agent is blocked. Keep a live count on the nav item and the top-bar tab.

### 9.8 Cleanup

On `done`, archive the app's threads **bottom-up** (gates, specialists, lead); keep branches and repos. On run completion or cancel (after confirmation) stop and archive everything including managers and the Orchestrator. Never delete worktrees or repos yourself.

### 9.9 Run start sequence (what "Approve and start" does, in order)

1. Re-validate the plan and every slot against the **live** catalog (§7.4). Any failure stops here with the reason; nothing has been created yet.
2. Create the run row and freeze `plan_json` and `settings_json`. Create the **Studio project** (a folder with `git init`; V16) and write `PORTFOLIO.md` and the per-node `BRIEF.md` drafts into it.
3. **Dry run stops here**: the plan and briefs exist, nothing is spawned.
4. Spawn the Orchestrator (visible), then the managers (hidden), each through the outbox (§9.3).
5. Admit wave 1 (the first wave is part of the plan the human approved). For each admitted app, in order: create its project and repository (`git init`, an initial commit containing `.helm/run-check.sh`, a skeleton `.helm/checks.json`, `.gitignore`, and `BRIEF.md`), then spawn its lead. **App repositories are created at admission, not at approval**, so apps that never start leave no empty repos. The wizard's "N new projects will be created" counts what *will* be created over the run.
6. Subscribe to events, start the watchdog, emit `run.started`.

---

## 10. Interfaces: CLI, RPC, realtime, settings

### 10.1 CLI — `bb helm …` (use `defineCli` / `cliCommand`; human output by default, `--json` when asked; on failure with `--json` print `{"ok":false,"error":{"code","message","hint"}}` and exit non-zero, like core `bb`)

```
bb helm status                         current run summary
bb helm runs
bb helm plan --brief-file <f> [--preset <name>] [--planner-model <id>]      creates a plan (dry run); prints the shape and the forecast
bb helm start <planId> [--yes]         approve and start
bb helm world [--run <id>]             the same data as helm_world
bb helm tell <node> --message-file <f> [--cascade self|reports|subtree] [--mode steer|queue] [--policy]
bb helm model <node> --model <id> [--provider <id>] [--reasoning <level>]
bb helm pause|resume|stop|retry <node> [--cascade …]
bb helm priority <app|node> low|normal|high
bb helm needs                          open Needs-you items
bb helm approve|deny <needId> [--reason <t>]      bb helm answer <needId> --message-file <f>
bb helm signoff <app>                  bb helm sendback <app> --message-file <f>
bb helm ledger [--follow]
bb helm models                         live catalog with NEW flags and the current slots
bb helm doctor                         run every Phase-0 probe that is safe without spawning; print pass/fail
bb helm reconcile                      §9.4 on demand
bb helm export <run> --out <file>      JSON snapshot (runs, nodes, directives, findings)
```

Multi-line text always comes from `--message-file` / `--brief-file` (never inline: backticks in double quotes are executed by the shell).

### 10.2 RPC (typed in `src/shared/protocol.ts`; every mutation returns the updated entity and emits a realtime event)

`run.{list,get,create,start,cancel}` · `world.get` · `node.{get,timeline,brief,reports}` · `directive.{preview,create}` · `ledger.list(filter)` · `needs.{list,resolve}` · `models.{catalog,validate}` · `presets.{list,save,delete}` · `plan.preview(brief|portfolio, settings)` · `board.{moveApp,moveTask}` (validated by §5.7) · `observatory.{list,adopt}` · `settings.{get,set}`.

### 10.3 Realtime

One channel per run, `run:<id>`. Events: `node.updated`, `edge.added`, `directive.created`, `receipt.updated`, `need.created`, `need.resolved`, `stage.changed`, `spend.updated`, `caps.updated`, `spawns.paused`. **Coalesce to at most 4 messages per second**; send patches, not snapshots. The app keeps a normalized store keyed by id and applies patches.

### 10.4 Settings (a `settingsSection`; every value also settable with `bb plugin config helm set …`)

Spans and caps (§4.1) · permission mode per tier (default `auto`; start the Orchestrator at the highest mode any descendant needs — V6) · show leads in the BB sidebar (default off) · stall minutes · fix rounds · auto-advance default (`ask`) · apps root folder · pricing weights (§7.6) · default planner model preset · check commands per platform · zero-tolerance slop categories (§ appendix-slop-policy) · whether to create a git remote (default no).

---

## 11. The UI — `ui-prototype.html` is the contract

Open the prototype and use every part of it before writing a component. This section names what to build and what each part must do. When this text and the prototype disagree on **look, layout, copy or interaction**, the prototype wins; when they disagree on **behaviour of the real system** (what is persisted, what is verified), this text wins.

### 11.1 Principles

- Calm and dense, not busy. Status is always **colour + icon + text**, never colour alone.
- Everything is keyboard reachable. Both themes (light, dark, and "system") are first-class and use tokens only.
- Animation is informational (propagation, status change) and honours `prefers-reduced-motion`.
- Honest numbers: anything estimated says so.

### 11.2 Frame

A top bar (brand · run switcher · tabs **Graph · Board · Ledger · Needs you** with a live count badge · caps chip "agents n/250 · running r/24 · forecast" · **Spawns paused** switch · Models button · theme toggle · inspector toggle) · the main view · a right-hand **Inspector** · modals for the **Model Studio** and the **New-run wizard**. Below 1100 px the Inspector becomes an overlay and starts closed; below 820 px the Studio is one column. The top bar gives things up in a fixed order as it narrows (run sub-label, then chip labels, then wordmark, then button labels, then tab labels, then the sample tag) — copy those breakpoints from the prototype's CSS; they were measured at 26 widths.

### 11.3 Graph

- **Nodes** are HTML cards (role tile, label, sub-label, status dot, model chip, one-line "now") on an SVG edge layer, both inside one CSS-transformed stage. **Semantic zoom** (`data-lod`): far = dots and group chips, mid = name + status, near = the full card with model and "now".
- **Grouping:** managers and apps collapse to cards (an app card shows stage pill and progress). Click to expand in place; **Open squad** drills into one app; **Collapse all / Focus** keep 170 nodes readable. Collapsed by default above ~60 nodes.
- **Interactions:** click selects and opens the Inspector · drag to pan · wheel/pinch to zoom · `f` fits · `/` focuses search · status filter chips · legend · zoom controls · **Observatory** toggle (§11.4).
- **The "touched" ring** marks any agent the human has changed. **Propagation:** after a directive, pulse outward from the target up its ancestor chain (about 200 ms per hop) and flash the receipts as they arrive; this is the visible proof of "everyone above knows". With reduced motion, show a static highlight of the chain instead.
- Must stay smooth at 169–250 nodes (V15): only render nodes in the viewport at near/mid zoom; never run layout per frame.

### 11.4 Observatory

A toggle that adds dashed "ghost" nodes for BB threads that are **not** in the run (`threads.list`, excluding Helm-owned). Ghosts are read-only except **Adopt** (attach under a manager or lead; V10 decides whether that re-parents the live thread or only tracks it in Helm's database). Keep this strictly read-only otherwise (rule 7).

### 11.5 Board

Two lenses. **Apps by stage**: columns Intake · Spec · Build · Integrate · Review · Slop check · Fix · Ready · Done, optional **swimlanes by manager**, app cards with stage pill, progress, platform chips, lead status, a touched marker. **Agent tasks**: columns Planned · Queued/held · Running · Waiting · Needs you · Done, filter by app, "Hide done". Drag rules are §5.7; an illegal drop snaps back with a toast naming the reason. A rule bar under the header states the rule for the active lens ("Stages advance on evidence, not on drag.").

### 11.6 Ledger

Newest first; filter by type, agent and "receipts pending". Each row: id · type icon + label · one-line summary · time · a mini receipt bar. The detail view lists every recipient with its level chip (**Target**, **Full**, **Digest**, **World state**), receipt state, and **the exact notice text that was sent to that recipient**. A Policies list sits above with **Retire**. Export JSONL.

### 11.7 Needs you

One inbox for all kinds (`approval`, `question`, `signoff`, `failed`, `slop`, `plan`, `budget`). Each card: kind icon · title · body · an evidence block in monospace · actions that fit the kind (Approve / Deny / Answer with option buttons / Sign off / Send back / Retry / Change model and retry / Approve plan / Raise cap) · **Open thread in BB** · age. Resolved items collapse into a "Resolved" list. A kind filter and a count live in the header.

### 11.8 Inspector (seven tabs)

Header: role tile · label · status · model chip · breadcrumb ("Orchestrator › Wellness › Lumen › UI builder"). Tabs:

1. **Overview** — *Talking about now* with topic chips · run stats (tokens, turns, cost so far, running time) · key/values (role and slot, reports to, model + id + reasoning, provider and machine, branch, write scope, thread id) · **Who sees changes to this agent** (the chain You → agent → parent → … → Orchestrator, with how each is told) · children · **Actions** (Tell, Change model, Spawn now, Pause/Resume, Retry, Stop, Open squad, Open thread in BB) · recent events. The **Orchestrator** also shows *State of the world* (stage counts, agents, spend vs forecast, open needs, agents changed) with three "Ask the Orchestrator" buttons and the standing policies. A **Manager** shows *Apps in this group*.
2. **Chat** — the agent's BB thread (V5) with a composer. Directive notices appear inline as system rows with human attribution; agents' `helm_ack` replies appear as theirs. Sending: a question to the Orchestrator is a plain message; anything else is a `tell` directive.
3. **Direct** — *What do you want to change?* (Message · Model change · Scope edit · Pause/Resume · Stop · Retry · Priority · Waive finding, only the types that make sense for this node's state) → type-specific fields → **Who it applies to** (this agent / + direct reports / + everyone below, with counts and rough cost) → **What each person sees** (live preview of every recipient with level and notice text) → "Make it a standing policy" → sticky **Send directive**. After sending, a result box shows the ledger id and receipts updating live.
4. **Comms** — agent-to-agent messages (`comms`) and directive notices, filterable.
5. **Brief** — `BRIEF.md` with version, write scope and acceptance links; **Edit brief** raises a `scope` directive.
6. **Reports** — the node's `helm_report` timeline; for gates, the verdict, checks, and findings (severity, rule, `path:line`, quote, Waive).
7. **Changes** — every directive that touched this node, labelled by role (target / parent / ancestor), with receipt status.

Selecting a planned node shows an "Not spawned yet" banner and a **Spawn now** action. A ghost node shows only Overview with **Adopt**.

### 11.9 Model Studio (modal, also embedded as wizard step 3)

Left: the 12 slots grouped (Coordination · Build · Gates · Support), each with its current model chip and "n live · n planned · n overrides". Right: the live catalog grouped by provider with search, **NEW** tags, a reasoning-level control and (if the model lists them) service tier; banners for NEW models and the same-family heads-up with **Keep my choice**. Tiles: forecast, delta versus the current run, agents affected. A preset menu (Studio default · Cheap dev run · Max quality · Custom · saved presets). Footer: scope (future / all) and **Apply**.

### 11.10 New-run wizard (four steps; nothing spawns until the last)

1. **Brief** — a large text area, a **Planner model** field, "N apps found" pill, the planner's clarifying chips.
2. **Portfolio** — steppers for managers' span (2–6) and Orchestrator span (4–8); a *Why this shape* banner (or the error from C5); totals (apps · managers · leads · specialists · gates · agents at most vs cap); per-manager groups with app rows (name, tagline, platform chips, agent count, a shape chip, remove ✕). 
3. **Models** — the Studio, with Studio default pre-filled and the unset slots called out.
4. **Approve** — totals (apps, agents, waves, estimated range), the honesty warning, *Checks before start* (every role has a model · plan fits the cap · Reviewer + Slop Hunter per app · N new projects will be created · gate families differ from builders · CI-tier platforms), wave approval (Ask me before each wave / Run waves automatically), concurrency slider, budget cap in relative units, **Dry run** checkbox, and **Approve and start**.

### 11.11 Empty and first-run states

No run yet: a calm hero ("Describe what you want to build") with **New run** and two example briefs. No provider/model available: explain and link to BB's provider settings. A run with no apps parsed: the footer button stays disabled and the pill reads "0 apps found".

### 11.12 Accessibility

Tabs, menus and dialogs use proper roles and focus management; every control has a name; contrast meets WCAG AA in both themes; status never depends on colour alone; reduced motion honoured. Because a canvas graph is hard for screen readers, also provide an **Outline** (a collapsible tree list of the same nodes with status and actions) — Phase 6.

### 11.13 Shortcuts

`/` search (graph) · `f` fit · `Esc` closes the top-most popover, modal or overlay Inspector · `Enter` sends in a chat composer, `Shift+Enter` newline.

### 11.14 What the prototype fakes (do not port fiction)

All sample data and the "now"/topic text · the Live simulation toggle · the three canned Orchestrator answers · the brief "planner" (it is the deterministic parser) · cost shown in `$` · receipts timing and agent acks · Adopt, Open thread, Create project (toasts only) · all persistence. Also **not in the prototype but required**: shape chips and C1/C4/C6/C7 (§1.5), the Planner-model field, the "unavailable model" state, the Outline view, the CI-tier sign-off wording.

### 11.15 Porting guidance

Lift the design tokens and component CSS from the prototype's `<style>` into `src/app/styles/` and keep class names where sensible. Translate each render function into a React component with the same structure. Keep copy **verbatim**. Keep the `data-act` names as `data-testid`s for end-to-end tests. Build the graph with HTML nodes + SVG edges in a transformed stage and your own semantic zoom — do not adopt a heavy graph library.

---

## 12. Absorption: one plugin instead of six

The human is disabling these (they already show `disabled`; do not enable them). Helm must cover what they did. This table is reconstructed from each plugin's description when they were inspected; **before porting, read each plugin's installed source and skills, and list anything this table misses in `docs/ABSORPTION.md`.**

| Plugin (source) | What it contributed | Where it lives in Helm |
|---|---|---|
| `agent-graph` (github.com/nathancolgate/bb-plugin-agent-graph) | A graph of BB threads, ghost nodes for non-run threads, chat beside the graph | Graph + Inspector Chat · Observatory (§11.4) |
| `chief` (github.com/divyesh-puri/bb-plugin-chief) | Supervision tools for a chief agent, durable outbox, reconcile on start, evidence-not-proof | Orchestrator/Manager tools · §9.2 outbox · §9.4 reconcile · §5.2 evidence |
| `command-center` (github.com/dilipgv/bb-plugin-command-center) | Needs-you inbox, board lanes, dispatch, archive cascade | Needs you (§11.7) · Board (§11.5) · spawn (§4.4) · cleanup (§9.8) |
| `crew` (github.com/sajov/bb-plugins, `crew/`) | Squad templates, handover, snapshots and Replay | Squad shapes (§1.5, appendix) · handover note in BRIEF · Replay (Phase 6) |
| `visual-workflows` (github.com/dmitriikapustin/bb-plugins-by-kapustin) | A role registry (roles as data) | Role registry in the appendix, editable in Settings → Roles (v1: edit briefs, not tiers) |
| `jev-orchestrator` (superseded; not registered) | Model slots / a studio for choosing models | Model Studio (§7) |
| `workflows` (built-in, disabled) | Generic workflow runner | Not absorbed; Helm's pipeline is the app stage machine (§5) |

Built-in plugins that **stay running** and that Helm must cooperate with: `concurrency-limit`, `provider-retry`, `provider-usage`, `tasks`.

---

## 13. Repository layout

Scaffold with `bb plugin new helm` (creates `bb-plugin-helm/`), then organise like this. Copy this whole spec folder into the repo as `spec/` and keep it.

```
bb-plugin-helm/
  package.json            # bb manifest (name "Helm", icon, server, app), engines, scripts: build dev test typecheck lint
  server.ts               # factory(api): wires db, engine, tools, cli, rpc, realtime, events, cron
  app.tsx                 # definePluginApp: navPanel (Helm), settingsSection, threadPanelAction
  skills/{orchestrator,manager,lead,specialist,reviewer,slop-hunter}/SKILL.md
  src/
    shared/               # protocol.ts (RPC + realtime types), types.ts, ids.ts
    server/
      domain/             # PURE: topology, stages, directives, notices, policies, models, cost, brief, slop/{rules,scan,verdict}
      db/                 # schema.sql, migrate.ts, repo.ts
      engine/             # outbox, spawn, scheduler, reconcile, watchdog, receipts, needs, budget
      bb/                 # port.ts (interface), real.ts (api.sdk), sim.ts (in-memory simulator)
      agent/              # tools.ts, configure.ts, briefs.ts, world.ts
      interfaces/         # cli.ts, rpc.ts, realtime.ts, settings.ts
    app/
      panels/             # Graph, Board, Ledger, Needs, Inspector, Studio, Wizard
      state/  hooks/  styles/
  test/{unit,sim,e2e,fixtures/{slop,briefs,catalog,bb}}
  docs/{VERIFY.md,DECISIONS.md,ABSORPTION.md,ARCHITECTURE.md}
  spec/                   # this folder, verbatim
```

Rules: `domain/` imports nothing from BB or the database. `bb/` is the only place that touches `api.sdk`. Agent tools, RPC and the CLI are thin shells over the same service functions, so a directive sent from the UI, the CLI or the Chat tab is the same code path.

---

## 14. Testing

1. **Unit (table-driven, no I/O):** `planTopology` (1, 2, 4, 5, 17, 18, 20, 24, 25 apps × spans 2–6 × C1–C7, including the C5 error), `resolveCascade`, `buildRecipients`, `noticeText` (snapshot every type × kind), the stage machine (illegal transitions, Ready conditions), the cost model (golden numbers for the 20-app seed), the brief parser, the verdict validator, the scanner.
2. **Property tests (fast-check):** for random trees and directives — every ancestor of every affected node is a recipient · the Orchestrator is always a recipient with `world` · the parent of an affected node is `full` unless that parent is itself affected (then it is `direct`) · each non-orchestrator node has exactly one parent · spans ≤ ceilings · total ≤ cap.
3. **Simulator (`bb/sim.ts`):** an in-memory `BbPort` with a deterministic clock, `thread.*` events, queued messages, capacity, and scriptable agent profiles — *diligent*, *slow*, *flaky* (fails N times), *liar* (claims done with no commits), *silent* (stalls), *chatty*. Required scenarios: the 20-app run to completion · provider failures and retries · **crash and restart at random points → reconcile → no duplicate threads, no lost directives, every outbox row ends done or visibly failed** · duplicate and out-of-order events · budget cap · adding and dropping apps mid-run · shape changes.
4. **Contract tests:** record redacted real BB responses during Phases 0 and 2 into `test/fixtures/bb/` and assert the simulator returns the same shapes (validate with the typings' schemas).
5. **UI:** component tests for the Direct tab's live preview; end-to-end (Playwright) against the app with a mock RPC backed by the simulator: select a node → send a directive → ledger row → receipts update → ripple classes applied; board drag rules; the wizard on the sample brief yields 5 / 20 / 103 / 40 / 169; axe accessibility checks in both themes; screenshots at 1440, 1100 and 820 px.
6. **Real smoke test (cheap, ≤ 6 agents, Haiku at `low`):** one app, Solo or Lean shape, real gates. Verify spawn, report, a directive reaching its ancestors with receipts, a gate verdict with verified evidence, sign-off, cleanup. Record what it cost.
7. `npm run typecheck && npm test` must pass offline. Tests make no network calls.

---

## 15. Phases

After each phase post a short report in your thread (§17.4) and continue, unless a blocker needs the human.

**Phase 0 — Verify (do not skip).** Scaffold the plugin; implement `bb helm doctor` with the probes that need no spawning; run the small experiments for the rest on the cheap model (≤ 6 agents). Produce `docs/VERIFY.md` (every V row: confirmed / refuted / changed + evidence + the fallback chosen) and `docs/DECISIONS.md`. *Exit:* all rows have evidence. If **V3** or **V12** fails, stop and report: the authorization model needs redesign.

**Phase 1 — Domain, database, simulator.** All of `domain/`, the schema and migrations, `BbPort` and `sim.ts`, the unit and property tests, the 20-app simulation. *Exit:* the sample-brief fixture yields 5 managers / 20 leads / 103 specialists / 40 gates / 169 agents; the simulated run completes with every invariant holding.

**Phase 2 — Engine on BB and the agent tools.** `real.ts`, outbox, idempotent spawn, reconcile, event handlers, watchdog, `configure`, all `helm_*` tools with per-tier authorization, skills, briefs, `PORTFOLIO.md`, CLI (`plan`, `start`, `status`, `world`, `tell`, `ledger`, `needs`). Real smoke test. *Exit:* a directive reaches its whole ancestor chain with receipts on real threads; the crash-and-restart reconcile test passes; V2/V4/V6/V17/V18/V20 outcomes are folded in.

**Phase 3 — UI shell on real data.** Graph, Inspector (Overview, Chat, Direct, Comms, Changes), Ledger, Needs you; realtime store; tokens and themes; propagation animation. *Exit:* acceptance items A1–A12 pass against the simulator-backed app and then against a real 3-agent run.

**Phase 4 — Wizard, Studio, models.** Catalog, presets, NEW detection, warnings, validation (including the unavailable-model flow), cost model, planner thread, plan preview, wave approvals. *Exit:* the wizard's plan equals `planTopology`'s; models are asked every run; Approve is disabled until required slots are set.

**Phase 5 — Gates, slop, board.** Reviewer and Slop Hunter flows, scanner and fixtures, verdict validation, fix loop, sign-off and send-back, CI-tier wording, Board (both lenses, drag rules), Observatory, budget cap and Spawns paused, add/drop apps, shapes. *Exit:* planted-slop fixtures are caught; the *liar* agent is caught; sign-off and send-back work end to end.

**Phase 6 — Scale and polish.** 169–250-node performance and level-of-detail, Outline view, Replay/snapshots and export, empty and first-run states, Settings UI, `doctor` complete, plugin README, final acceptance run. *Exit:* all of §16.

---

## 16. Acceptance checklist (each item is observable)

**Plan and shape**
- [ ] A1 The sample brief yields 5 managers, 20 leads, 103 specialists, 40 gates, 169 agents at most; "Why this shape" explains it.
- [ ] A2 1 app → the Orchestrator also leads (C1); 3 apps → no managers (C2); 5 apps → 2 managers balanced 3 + 2 (C3); a plan needing more managers than the Orchestrator's span shows the C5 error with the fix.
- [ ] A3 Nothing is spawned until **Approve and start**; **Dry run** writes the plan and briefs and spawns nothing.

**Models**
- [ ] A4 Step 3 pre-fills exactly the four stated preferences (UI → GPT-6.1 Sol extra high; Code → Sonnet 5.5 high; Review → GPT-6.1 Sol high; Slop → Sonnet 5.5 high) and leaves the other slots empty; Approve is disabled until the rest are chosen; this happens on **every** run.
- [ ] A5 A model missing from the live catalog is flagged "unavailable" and never silently replaced, at plan time and at spawn time.
- [ ] A6 Models new to the host show **NEW**; a same-family gate shows the heads-up with **Keep my choice**.

**Directives and visibility**
- [ ] A7 Telling a specialist reaches: the specialist (direct), its lead (full), its manager (digest) and the Orchestrator (digest + world state). The Changes tab of every one of them lists it; `helm_world` includes it in the same second.
- [ ] A8 Receipts progress queued → delivered → ack/rec in the Ledger and on the graph; a failed delivery is red with Retry.
- [ ] A9 A `subtree` stop stops every descendant bottom-up; an unreachable node shows a failed receipt, not silence.
- [ ] A10 A model change takes effect on the agent's next turn and is recorded `from → to`; the lead is told not to revert it.
- [ ] A11 A standing policy appears in the prompt of an agent spawned afterwards and in `helm_context`.
- [ ] A12 Typing directly into an agent's BB thread produces an implicit directive that informs the chain (or, if V18 failed, the documented fallback).

**Gates and slop**
- [ ] A13 An app cannot reach Ready without a valid Reviewer pass, a valid Slop Hunter pass and green deterministic checks bound to the same commit.
- [ ] A14 A verdict with an unlocatable quote, a check without a command, or a pass with zero checks is rejected.
- [ ] A15 A gate that edits source is caught by the clean-worktree check.
- [ ] A16 The scanner finds every planted zero-tolerance item in the fixtures and ≤ 2 % false positives on the control repos.
- [ ] A17 The *liar* agent (claims done, no commits) never advances a stage.
- [ ] A18 A Windows or Android app with CI-tier checks reaches Ready but the sign-off card says it is not verified on this machine.

**Robustness and limits**
- [ ] A19 Killing and restarting the BB server mid-spawn produces no duplicate threads and no lost directives.
- [ ] A20 Provider rate-limit failures are retried by `provider-retry`; Helm marks a node failed only after exhaustion and raises a Needs-you item with Retry / Change model / Stop.
- [ ] A21 A silent `running` node is nudged once, then raised as stalled.
- [ ] A22 Reaching the budget cap sets **Spawns paused**, admits nothing new, and offers Raise / Keep paused / Stop.
- [ ] A23 Plans over `maxTotalAgents` or `concurrency` are refused or throttled, never exceeded.

**UI**
- [ ] A24 Graph, Board, Ledger, Needs you, Inspector, Studio and the wizard match the prototype's structure and copy in light and dark.
- [ ] A25 169 nodes pan and zoom without visible jank; input latency stays under 50 ms on the dev machine.
- [ ] A26 Everything is reachable by keyboard; axe reports no serious issues; reduced motion removes the ripple.
- [ ] A27 Layout holds from 1800 px down to 820 px, with the Inspector as an overlay below 1100 px.
- [ ] A28 Needs-you count is correct and live; a pending permission prompt in a **hidden** thread appears there.

**Packaging**
- [ ] A29 `bb plugin build` and `bb plugin install path:.` work from a clean checkout; `bb helm doctor` is green.
- [ ] A30 The old plugins stay disabled and nothing in Helm requires them.

---

## 17. Non-goals, decisions, risks, reporting

### 17.1 Non-goals for v1

Remote machines and cloud sandboxes (the schema carries `hostId`; v1 uses the local host) · real-dollar billing beyond optional user-entered prices · publishing to app stores · creating git remotes or pull requests (setting, default off) · multi-user permissions · changing which tiers exist · a mobile UI.

### 17.2 Open decisions — take the default, record it in `docs/DECISIONS.md`

| # | Decision | Default |
|---|---|---|
| D1 | One repo (and BB project) per app vs a monorepo | **one per app** |
| D2 | Where apps live | `~/Projects/helm/<run-slug>/<app>` (editable in the wizard; create if absent) |
| D3 | Thread visibility | **Orchestrator visible; all others hidden** |
| D4 | Wave approval | **ask** |
| D5 | Squad shape default | **Full** |
| D6 | Human approval of each SPEC | **off** (the approved plan and brief are the checkpoint) |
| D7 | Fix rounds | **2** |
| D8 | Test agent | **off** (optional per app) |
| D9 | Permission mode per tier | **`auto`**, subject to V6 |
| D10 | Git remotes | **off** |
| D11 | Planner model | the `code` preset model at `medium` (asked in the wizard) |
| D12 | Windows/Android reaching Ready without local verification | **allowed with explicit acceptance on the sign-off card** |

### 17.3 Risks and how the design answers them

1. **Token cost explodes** → lazy spawning, caps, forecast, budget cap, cheap-model dev rule, digests instead of transcripts.
2. **Parallel agents make conflicting decisions inside one app** → one writer of decisions (the lead), a versioned CONTRACT, disjoint write scopes, integration by the lead, `DECISIONS.md`.
3. **Agents over-claim** → evidence verification, independent gates that re-run checks, quote verification, the *liar* test.
4. **The human is surprised** → directive propagation to the whole chain, receipts, ledger, Needs-you inbox, standing policies.
5. **Hidden threads hide blockers** → Helm's own inbox; V4/V19.
6. **Platform behaviour differs from the assumptions** → Phase 0, fallbacks, `doctor`.
7. **170-node canvas is slow** → LOD, viewport culling, collapse by default.
8. **Notice spam** → coalesced digests, queue-if-active, one reminder only.

### 17.4 How to report (every phase, and at the end)

```
## Phase N report
Built:            what exists now, by path
Verified:         each claim with the command and its output (paste the relevant lines)
Not verified:     what you did not or could not check, and why
Deviations:       where you departed from this brief, and why
Defaults taken:   which §17.2 decisions you used
Real-run cost:    agents spawned, models, rough units
Next:             what the next phase will do
Needs from you:   only if blocked — one specific question
```

Never write "should work". Say what you ran and what it printed.

**Begin with Phase 0.**
