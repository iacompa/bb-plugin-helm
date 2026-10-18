---
name: helm
description: Drive Helm from the terminal with bb helm (plan and start runs, world state, tell or steer agents, models, needs, sign-off). Use to inspect or steer a Helm run.
---

# `bb helm` — the Helm CLI

Helm runs a portfolio of projects (apps, websites, games, automation, reviews of existing projects) as an agent hierarchy: Orchestrator → Managers → App
Leads → specialists (UI, Core, Platform, Security, optional Test) plus two gates per app
(Reviewer, Slop Hunter). This CLI is the human's control surface. **Every mutating command
is a human directive**: it is binding on the agents it reaches, it is recorded in the ledger,
and the Orchestrator sees it in world state. Run mutating commands only when the user asked
for that action; confirm irreversible ones (`stop`, `signoff`, `sendback`, `complete`,
`deny`) with the user first. Agents that Helm runs may only read (`status`, `world`, `needs`,
`screens`, `nodes`, …): Helm refuses every other command from their threads.

## Conventions

- `--run <id>` picks the run on most commands; the default is the **latest active run**. `start` and
  `export` take the run id as a positional instead; `runs`, `plan`, `models`, `defaults`, `doctor`,
  `errors` and `reconcile` take no run.
- `--json` prints machine-readable output. On failure it prints
  `{"ok":false,"error":{"code":"…","message":"…","hint":"…"}}` and exits non-zero. Prefer
  `--json` in scripts and when you need to parse ids.
- **Multi-line or free text always comes from a file** (`--brief-file`, `--message-file`).
  Never pass it inline: backticks and `$(…)` inside double quotes are executed by the shell.
  Write the file with a *quoted* heredoc so nothing expands:

  ```bash
  f="$TMPDIR/helm-msg.md"
  cat > "$f" <<'EOF'
  Use the `SyncEngine` from CONTRACT v3; drop the $PRICE banner.
  EOF
  bb helm tell frame.lead --message-file "$f"
  ```

  Short one-line values (`--reason`, `--name`) go in **single** quotes.

**Node ids:** `orch` (Orchestrator) · `planner` · `git` (Git agent) · `m1`, `m2` … (Managers) ·
`<app>.lead` · `<app>.code` · `<app>.ui` · `<app>.p.mac|win|ios|and|web` (platform builders) ·
`<app>.security` · `<app>.test` · `<app>.research` · `<app>.docs` · `<app>.data` ·
`<app>.compliance` · `<app>.assets` · `<app>.review` · `<app>.slop`. Commands also take an app name
(its lead) or an agent's personal name. Get real ids from `bb helm nodes`.

**Stages:** intake → spec → build → integrate → review → slop → (fix) → ready → done.
Stages advance only on verified evidence (commits, checks run through the evidence wrapper,
gate verdicts). Only the human moves Ready → Done (`signoff`) or Ready → Build (`sendback`).

## Read

| Command | What it shows |
|---|---|
| `bb helm status` | Current run summary: apps by stage, agents, spend, open needs. |
| `bb helm runs` | All runs with ids and status. |
| `bb helm world [--run <id>]` | The same data the Orchestrator's `helm_world` returns: stages, open needs, recent directives with receipts, touched agents, policies, managers and apps. |
| `bb helm nodes [--app <name>]` | Every agent of the run: id, status, label and model. |
| `bb helm needs [<id>]` | Open Needs-you items (`N-…`): kind, title, who raised it, age, and the exact command for each choice. Sign-off items, or one item asked for by id, show the full body and evidence. |
| `bb helm errors [--hours <n>] [--all] [--json] [--clear]` | Helm's error journal, newest first. It covers server, RPC, agent-tool and panel failures; `--all` adds refused requests. Run it first whenever something in Helm fails; `bb helm doctor` shows the last 24 hours' count. |
| `bb helm ledger [--limit <n>]` | Recent directives (`D-…`) with per-agent receipts (queued → delivered → ack/rec, or failed). It includes steers by supervisors (`Manager → Agent: …`), which agents give with `helm_direct`; the human's directives always win. |
| `bb helm models` | Live model catalog with NEW flags and the current slots. |
| `bb helm doctor` | Safe environment probes (no spawning); pass/fail per probe. |

## Plan and start

```bash
bb helm plan --brief-file brief.md [--preset 'Cheap dev run'] \
  [--slot code=claude-code/claude-sonnet-5-5:high --slot review=codex/gpt-6.1-sol:high …] \
  [--name 'Outdoor apps'] [--root '~/helm-runs']
bb helm start <runId> --dry-run      # validate and show what would happen, spawns nothing
bb helm start <runId> --yes          # approve and start (no prompt)
```

- `plan` reads the brief, proposes the portfolio and prints the shape, the forecast and what
  happens to each folder. It is a dry run: no run agents spawn until `start`.
- **Apps can live anywhere.** `- Name — tagline · macOS · /path/to/folder` puts the app in that
  folder. An **existing repository** is adopted on one `<app>-work` branch at its HEAD (the human's
  checkout, uncommitted changes and other branches are never touched); on sign-off the Git agent merges
  it into main and pushes both, unless the setting says push only or report only. A missing
  or empty folder becomes a new repository. `· reads /path/a, ~/path/b` lists read-only
  folders its agents may read. `--root` sets where apps without a folder go for this run
  (default: the apps root setting). One app per repository; a folder inside another repository,
  or a non-empty non-git folder, is reported as a problem.
- **Projects are more than apps.** Each line gets a kind: `app`, `web` (websites and full-stack
  web apps), `game` (mobile, desktop or web; Unreal, Unity or Godot), `automation` (bots,
  scheduled jobs, integrations) or `review` (an audit report of an existing project, no code
  changes). Helm also decides its **needs** (`database auth payments security hipaa privacy
  realtime ai automation assets multiplayer`) and **tools** (`unreal unity godot blender docker
  ffmpeg`, BB plugins as `plugin:<id>`) from the words in the brief, prints each decision with
  its reason, and staffs the squad from them (a Data builder for a database, Compliance for
  HIPAA, an Asset builder for art, a Web builder for websites). Override on the line:
  `- Shop — bookings · Website · needs payments, HIPAA · tools Docker`, `· Game · tools Unreal`,
  `· Review`, or `· needs none`. Mid-run the Orchestrator can change a profile; the squad follows.
- To plan interactively (questions, folders, a model for every role from this machine's catalog),
  use the `helm-planner` skill, or Helm → New run → **Plan with an agent**.
- A brief written as `# Group` headings with `- Name — tagline · iOS Android macOS Windows`
  lines is parsed directly. Free text starts one short hidden **planner** thread (the only
  thing `plan` ever spawns) on `--planner-model provider/model:reasoning` (default: the
  preset's `code` model at medium). `plan` waits up to about 2.5 minutes. If the planner is
  still reading, it prints its id. Re-run with `--planner <id>` to continue. Show the user
  any questions the planner prints.
- `--preset`: a Model Studio preset (`Studio default`, `Cheap dev run`, `Max quality`, or
  one the user saved). `--slot slot=provider/model:reasoning` overrides one slot; repeat it.
  Slots: `orchestrator manager lead ui code platform security test review slop research docs planner
  git watcher` (Data builders use the `code` model, Compliance the `security` model, Asset builders the
  `ui` model; `planner` and `git` fall back to the default models, then the Orchestrator's; `watcher` is
  optional).
  Check model ids and reasoning levels with `bb helm models` — never guess them.
- Run `start --dry-run` first and show the user the result. `start` without `--yes` changes nothing: it
  exits with `confirmation_required` and says how many projects and agents it would create.

## Steer agents

```bash
bb helm tell <node> --message-file f.md [--cascade self|reports|subtree] [--mode steer|queue] [--policy]
# the human's word comes first: the agent acts now without asking anyone; its supervisors get an FYI and
# may not hold, re-issue or overrule it; an agent that has not started is started (its app too)
bb helm model <node> --model <id> [--provider <id>] [--reasoning <level>]
bb helm slots [--slot role=provider/model:level ...] [--replace <provider> --with provider/model:level] [--future]
# pause, resume, stop and retry an agent: the panel's agent inspector, or its card (bb helm resolve)
bb helm priority <app|node> low|normal|high
```

- `tell` — a binding instruction. `--cascade`: `self` (default, just the node), `reports`
  (node + direct reports), `subtree` (everyone below). `--mode steer` (default) interrupts
  at the next step; `queue` waits for the current turn. `--policy` also makes it a standing
  policy (`P-n`) for that subtree: injected into future agents' briefs and `helm_context`.
  Every affected agent must `helm_ack` it; its parent gets the full notice; higher
  ancestors a digest line.
- `model` — marks a human override; agents are told not to revert it. On the same provider
  it applies from the agent's next turn. On another provider BB needs a new thread: Helm stops
  the old one and respawns the agent in the same workspace with a hand-over. A stopped agent
  switches when retried.
- `slots` — which model each role uses (orchestrator, manager, lead, ui, code, platform, …).
  By default every agent in those roles moves now, including per-agent overrides and failed
  agents, which are retried. `--future` changes only new spawns. `--replace codex --with …`
  moves every role off a provider that is out of usage or down. With no flags, it prints the
  current models by role. The model choice is the user's: ask which model, don't pick one.
- `pause` holds an agent after its current step (Helm-implemented; only `resume` or `stop`
  wakes it). `stop` ends it (bottom-up with a cascade). `retry` re-runs a failed/stalled one.
- `priority` feeds the scheduler; `high` work starts first when capacity is short.
- Questions for the Orchestrator ("what is blocking?") are not directives — read
  `bb helm world` / `status` instead of `tell`-ing it a question, or ask the Planner.

## Ask the Planner; names and custom agents

```bash
bb helm ask "Should we add a HIPAA reviewer for the clinic app?" [--run <id>]
bb helm ask --message-file q.md
bb helm agents [--run <id>] [--json]
bb helm rename <agent> "<name>"
bb helm retire <agent> --yes [--reason "<why>"]
```

- Every run has a **Planner** and a **Git agent** beside the **Orchestrator**. By default they
  have no personal names, just their roles; a name set in Settings (`plannerName`,
  `orchestratorName`, `gitName`) or with `bb helm rename <agent> "<name>"` shows as
  "Nova · Planner", and `bb helm rename <agent> none` clears it. The Planner runs on a
  model the user chooses: the run's `planner` slot, else the **Default Planner model** setting,
  else the Orchestrator's model. It never picks a model by itself. It is idle until asked, so it
  uses no capacity while waiting. Defaults for new runs: Helm panel → Models → Default models,
  or the Settings dropdowns `plannerModel` / `plannerReasoning` and `orchestratorModel` /
  `orchestratorReasoning`. The model dropdowns list the connected providers' models
  (`provider/model`), saved from the last catalog Helm read; a newly connected provider shows
  after `bb plugin reload helm`. On the graph the Planner sits just below the Orchestrator with
  no line to it: it reports to nobody and sees the whole run.
- `ask` sends the question to the Planner's thread (it is visible in the sidebar; the user
  can also just type there). It is not a directive and steers nobody. The Planner answers from
  live world state and, when asked for a change, makes it:
  - plan changes, such as adding a project or adding the `hipaa` need, which brings a
    Compliance agent;
  - model changes;
  - **custom agents**: new kinds of agent designed for this run, such as a GitHub sync agent, a
    storage guard that keeps work on the external SSD, a HIPAA reviewer or a workflow debugger.
- A custom agent reports to the Orchestrator, a manager or a lead. Its supervisor and the
  Orchestrator get an FYI line. Events (stage changes, Ready, sign-off, failures) wake it; it
  never polls. Anything leaving the machine (pushes, deploys, messages, spending) still needs
  the human. With autonomy `ask`, a new agent waits in Needs you. A run holds at most 12.
- The Planner names each agent and says the name; the user can change it. `rename` works on
  any agent (node id, current name, an app's lead, `orch`, `planner`) and the thread title
  follows. Names are unique in a run.
- `agents` lists the Planner, the Orchestrator, the Git agent and every custom agent with mission and status.
  `retire` stops and archives a custom agent; built-in agents change through the plan instead.

### Who decides what

Helm runs like a company:
- Leads decide inside their apps; managers decide inside their groups.
- With autonomy high, a lead's or manager's ordinary question stays with it. Only workers'
  questions go to their lead.
- Upward questions are capped at 3 waking messages an hour per manager or lead; more arrive
  as FYI.
- The Orchestrator oversees and delegates, and grants standing authority, not per-item GOs.
- The human hears about credentials, spending, private data, access, and questions only the
  owner can answer (`about: owner`).

## Answer Needs-you

```bash
bb helm needs [<needId>]
bb helm approve <needId> [--reason 'one line']
bb helm deny <needId> [--reason 'one line']
bb helm answer <needId> --message-file answer.md
bb helm resolve <needId> <choice> [--reason '…' | --message-file f] [--model p/m:level] [--value N] [--findings F-1,F-2] [--rotated] [--yes]
```

- `needs` prints, under each item, the exact command for each of its choices. Use those.
- `approve` / `deny` — only approvals (agents' permission requests), waves and plan changes
  proposed by the Orchestrator, and the "complete the run?" card. On any other kind they refuse
  and print the right command.
- `answer` — a question or decision an agent asked with `helm_need`; the text is delivered
  into that agent's thread. A card asking which permission mode a provider should use is
  answered with `bb helm limits --permission <provider>=<mode>`.
- `resolve` — every other choice, the same as the panel's buttons: `retry`, `change-model`,
  `stop` (failed or stalled agents); `nudge` (stalled); `raise-cap --value N`, `keep-paused`,
  `stop-run` (budget); `sendback --reason`, `waive --findings … --reason`, `stop` (fix rounds
  used up, slop); `complete`, `keep-open` (complete-the-run card). `stop` and `stop-run` need
  `--yes`. Sign-off cards use `signoff` / `sendback` below.
- Waiving a gate finding is the human's call and needs a typed reason (≥ 20 characters for
  zero-tolerance slop; secrets also need `--rotated`, confirming the credential was rotated).
  Agents can never waive.

## Finish apps and runs

```bash
bb helm signoff <app>                       # Ready → Done; squad archived; the Git agent merges and pushes (per the setting)
bb helm sendback <app> --message-file why.md   # Ready → Build; gates reset, the lead is told why
bb helm complete --yes [--run <id>]         # stop and archive every remaining agent; repos stay
bb helm end --run <id> --yes                # end a run now (cancel), or discard a draft plan
bb helm limits [--run <id>] [--concurrency N] [--budget N] [--autonomy high|ask] [--permission provider=mode]   # show or change a run's limits now
```

- `signoff` is the human's acceptance of the app as judged — including anything listed as
  unverified (e.g. "Windows build not verified on this machine"). With the default setting it
  also has the Git agent merge `<app>-work` into main and push both. Show the user the sign-off
  item from `bb helm needs` first (it prints the gates' summaries, the checks, the evidence and
  what signing off sends); never sign off on your own initiative.
- `sendback` needs a reason file stating exactly what to redo.
- `complete` is for when every app is done or cancelled (Helm raises a need suggesting it).

## Maintenance

| Command | Use |
|---|---|
| `bb helm defaults [--planner p/m:level] [--orchestrator p/m:level] [--git p/m:level] [--apply]` | Show or set the default Planner, Orchestrator and Git agent models for new runs (`none` clears one); `--apply` also moves running runs' Planner and Git agent now. |
| `bb helm reconcile` | Re-sync Helm's database with BB threads and the outbox (after a crash or plugin reload). Safe to repeat. |
| `bb helm export <run> --out <file>` | JSON snapshot of the run: runs, nodes, directives, findings. |

## Typical flows

- **"How is the run going?"** → `bb helm status`, then `bb helm needs`; summarize stages,
  blockers and open needs. Use `world --json` for detail.
- **"Tell the Frame lead to use the shared sync module"** → write the text to a file with a
  quoted heredoc, `bb helm tell frame.lead --message-file "$f"`, then
  `bb helm ledger --limit 5` to confirm the receipt reaches `ack`.
- **"Make all gates use model X"** → `bb helm models` to confirm the id, then
  `bb helm slots --slot review=… --slot slop=…` (or a `--slot` at plan time).
- **Or ask a supervisor in its thread.** The Orchestrator, Managers and Leads change the models of
  the agents below them (`helm_set_model`): "change all the Slop Hunters to Opus", "manager 1 on
  Opus and manager 2 on Sonnet", "the Reviewer of Tide only". The Orchestrator can change anyone;
  a Manager only its own leads and their squads; a Lead only its squad and gates. Each change is
  a directive in `bb helm ledger`, marked with who made it.
- **Stuck agents / the Watcher**: with a `watcher` slot (a light model such as Haiku low),
  Helm sends agents that look stuck to the Watcher. It nudges, restarts, or escalates them to
  the nearest active supervisor; only what nobody can fix reaches the user. Add one mid-run
  with `bb helm slots --slot watcher=<provider>/<model>:low`.
- **Skills and tasks**: every builder loads its protocol skill plus a craft skill (helm-ui,
  helm-code, helm-ios, helm-android, helm-macos, helm-windows, helm-security, helm-test,
  helm-research, helm-docs). Supervisors write each agent's task (`helm_set_task`, or `task`
  on `helm_spawn_squad`): it becomes part of the agent's system prompt and brief. To change
  what one agent works on, `bb helm tell` the agent directly (or type in its thread): it acts at once, without its
  supervisor's go-ahead. Managers see
  only their own apps; cross-group work goes through the Orchestrator.
- **"Show me the app" / screens** → the panel's **Screens** button, or `bb helm screens --app <name>`
  to list the pages. Screens shows each app as pages you click through like a tiny browser:
  the screenshots the builders committed (`reports/ui/`, `reports/<platform>/…`), in a phone
  frame for an iOS or Android app, nothing running. Tappable areas come from the UI builder's
  screen map (`reports/screens/screens.json`); with a map its pages are the only pages. Only
  the app's own UI is shown: images from the app's repository and its worktrees only (never
  another repository an agent works in), no evidence or debug captures (before/after, probes,
  a commit or time in the name), no captures for platforms the app does not target, and for a
  phone app nothing shaped like a computer screen. The CLI's "Left out" line says what was
  hidden and why. For a phone app, each page is captured on the devices the user ticks in Screens →
  **Devices** (a list, nothing typed: iPhone 18 Pro, 18 Pro Max, Air, 17, 17 Pro Max, 17e, SE;
  Pixel 9, Pixel 9 Pro XL, Galaxy S25, S25 Ultra; iPad Pro 11-inch, iPad Air 11-inch, iPad mini,
  Pixel Tablet; default the six common phones iPhone 18 Pro, 18 Pro Max, Air, SE, Pixel 9, Galaxy
  S25). An iOS app gets the Apple ones, an Android app the Android ones. Computer and web apps need
  no picking: Helm has their pages captured at 1440×900 and 1920×1080 (a web app also at 390 wide).
  Screens has a device picker and an **All phones** view that shows one page on each device side by
  side, and the camera button asks the app's lead for fresh captures of every page. If an app shows no screens, or the wrong ones, tell the lead with `bb helm tell`.
- **After a Helm upgrade, mid-run** → agents keep the old skills, tools and prompt until
  their session restarts. `bb helm refresh --yes` rewrites briefs and restarts each live
  agent on the new version (supervisors first; work in worktrees stays).
- **Disk space / too many worktrees** → every project has the user's checkout and one shared work
  worktree at `<repository folder>/.helm-work/<repository>`, on the same disk, plus only the lanes
  the Git agent adds for parallel work. Each run has a branch limit (default 2: main and the work
  branch; settings `branchesPerApp`, 2 to 12) and a worktree limit (default 10; `worktreesPerApp`,
  2 to 32), set per run in the Worktrees view. The **Worktrees** button on the Git agent's card
  opens at once with what Helm last read (git is read again in the background on open when a few
  minutes old, every 30 minutes, or with **Check now**): one row per app with its number of
  branches and worktrees, its size, the disk it is on (an external SSD by name, or This Mac) and
  **Show in Finder**; click an app for each worktree (state, branch, agents, disk, size) and branch,
  and its git storage. A row whose repository folder was moved or deleted says so. The **GitHub** tab beside it shows, per app, what its remote has and what it does not (branch names and commits only, from `git ls-remote` with git's own login; nothing downloaded, read only when the tab opens and is 15 minutes old or with **Check GitHub**): branches the same on both, commits not on GitHub yet, uncommitted files, branches newer or only on GitHub, an **Open on GitHub** button; `bb helm worktrees --github` prints the same. `bb helm worktrees` lists them per
  app (`--app <name>` for one). Apps from older runs may still have one BB worktree per agent on the
  internal drive; `bb helm worktrees --consolidate <app> --yes` moves one onto the shared worktree
  (refused while any of them holds uncommitted or unmerged work). The Git agent is told when a disk
  runs low (under 15 GB or 10% free) and frees space without losing work. Put `appsRoot` on an
  external disk to keep new projects off the Mac.
- **Branches** → every project has two: main and its work branch `<app>-work`, where all its
  agents commit. Agents never create branches, worktrees or clones, never merge into main and never
  push. Only the Git agent merges the work branch into main: when the user signs the project off
  (default "merge and push"), or when the Orchestrator or the app's lead asks. Runs started before
  this keep their `helm/<run>/<app>` branch as the work branch.
- **Git agent** → every run has one (`git`, the free-standing node beside the Orchestrator).
  Its instructions on git are binding on every agent (delivered as "Git rule"). `bb helm git`
  starts it if the run has none and prints its thread; tell it in that thread where to send work (GitHub or any remote, a bare
  repository or folder on the Mac or an external disk). Settings: "Git agent" model and reasoning,
  name, and "When you sign a project off, the Git agent" (merge and push / push / report only). It never
  force-pushes or handles credentials.
- **Permission prompts**: by default an agent's prompts go to its supervisor, who answers
  with `helm_approve`. Only escalations (credentials, spending, private data, access), the
  Orchestrator's own prompts, and prompts unanswered for 15 minutes reach the user. Setting:
  "Who approves agents' permission prompts". Per-role modes (Auto, Allow edits, Full access)
  apply to agents spawned afterwards. Both are in the panel's **Permissions** button (next to
  Models) and in BB → Settings → Helm.
- **A card asks which permission mode a provider should use** (e.g. Grok supports only
  accept-edits or full) → that is the user's access decision: explain both (accept-edits
  sends every command to them; full runs commands unchecked) and ask. Then
  `bb helm limits --permission <provider>=<mode>`.
- **"We're out of usage on Codex, move everything to X"** → `bb helm models` to confirm X's
  id, then `bb helm slots --replace codex --with <provider>/<model>:<level>`. Then
  `bb helm needs` to check that the failed cards closed.
- **"Sign off Tide"** → `bb helm needs` (find the sign-off item; read its evidence, the
  unverified notes and what signing off sends to the user), confirm, `bb helm signoff tide`.
- **"Retry the failed agent" / "raise the budget"** → `bb helm needs`, then run the command it
  prints for that choice (`bb helm resolve N-… retry`, `bb helm resolve N-… raise-cap --value 4000`).
  A direct `bb helm retry <node>` retries but leaves the failed card open.

## Never

- Never put multi-line or user-supplied text inline in a command — use a file.
- Never sign off, send back, stop, deny or complete without the user asking for it.
- Never edit Helm's database, app repositories' `.helm/` files or agents' threads to work
  around the CLI; directives must go through `bb helm` (or the Helm UI) so they are
  recorded and acknowledged.
