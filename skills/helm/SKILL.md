---
name: helm
description: Drive the Helm BB plugin from the command line with `bb helm …` — plan and start runs from a brief, read world state, tell/steer/pause/stop agents, change models and priorities, answer Needs-you items, sign off or send back apps, read the ledger, export. Use when the user asks to inspect or steer a Helm run (portfolio, agents, needs, sign-off) from a terminal or script.
---

# `bb helm` — the Helm CLI

Helm runs a portfolio of projects (apps, websites, games, automation, reviews of existing projects) as an agent hierarchy: Orchestrator → Managers → App
Leads → specialists (UI, Core, Platform, Security, optional Test) plus two gates per app
(Reviewer, Slop Hunter). This CLI is the human's control surface. **Every mutating command
is a human directive**: it is binding on the agents it reaches, it is recorded in the ledger,
and the Orchestrator sees it in world state. Run mutating commands only when the user asked
for that action; confirm irreversible ones (`stop`, `signoff`, `sendback`, `complete`,
`deny`) with the user first.

## Conventions

- `--run <id>` works on every command; default is the **latest active run**.
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

**Node ids:** `orch` (Orchestrator) · `m1`, `m2` … (Managers) · `<app>.lead` ·
`<app>.code` · `<app>.ui` · `<app>.p.mac|win|ios|and` (platform builders) ·
`<app>.security` · `<app>.test` · `<app>.research` · `<app>.docs` · `<app>.review` ·
`<app>.slop`. Get real ids from `bb helm world --json`.

**Stages:** intake → spec → build → integrate → review → slop → (fix) → ready → done.
Stages advance only on verified evidence (commits, checks run through the evidence wrapper,
gate verdicts). Only the human moves Ready → Done (`signoff`) or Ready → Build (`sendback`).

## Read

| Command | What it shows |
|---|---|
| `bb helm status` | Current run summary: apps by stage, agents, spend, open needs. |
| `bb helm runs` | All runs with ids and status. |
| `bb helm world [--run <id>]` | The same data the Orchestrator's `helm_world` returns: stages, open needs, recent directives with receipts, touched agents, policies, managers and apps. |
| `bb helm needs` | Open Needs-you items (`N-…`): kind, title, asking node, age. |
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
  folder. An **existing repository** is adopted on a new `helm/<run>/<app>` branch (the human's
  checkout, uncommitted changes and branches are never touched, and Helm never merges). A missing
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
  Slots: `orchestrator manager lead ui code platform security test review slop research docs`
  (Data builders use the `code` model, Compliance the `security` model, Asset builders the `ui` model).
  Check model ids and reasoning levels with `bb helm models` — never guess them.
- Run `start --dry-run` first and show the user the result; `start` without `--yes` asks.

## Steer agents

```bash
bb helm tell <node> --message-file f.md [--cascade self|reports|subtree] [--mode steer|queue] [--policy]
bb helm model <node> --model <id> [--provider <id>] [--reasoning <level>]
bb helm slots [--slot role=provider/model:level ...] [--replace <provider> --with provider/model:level] [--future]
bb helm pause|resume|stop|retry <node> [--cascade self|reports|subtree]
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
  `bb helm world` / `status` instead of `tell`-ing it a question.

## Answer Needs-you

```bash
bb helm needs
bb helm approve <needId> [--reason 'one line']
bb helm deny <needId> [--reason 'one line']
bb helm answer <needId> --message-file answer.md
```

- `approve` / `deny` — approvals, plan deltas and waves proposed by the Orchestrator,
  destructive-command requests from agents.
- `answer` — a question or decision an agent asked with `helm_need`; the text is delivered
  into that agent's thread.
- Waiving a gate finding is the human's call and needs a typed reason (≥ 20 characters for
  zero-tolerance slop; secrets also need confirmation the credential was rotated). Agents
  can never waive.

## Finish apps and runs

```bash
bb helm signoff <app>                       # Ready → Done; squad archived bottom-up
bb helm sendback <app> --message-file why.md   # Ready → Build; gates reset, the lead is told why
bb helm complete [--run <id>]               # stop and archive every remaining agent; repos stay
bb helm end --run <id> --yes                # end a run now (cancel), or discard a draft plan
bb helm limits [--run <id>] [--concurrency N] [--budget N] [--permission provider=mode]   # show or change a run's limits now
```

- `signoff` is the human's acceptance of the app as judged — including anything listed as
  unverified (e.g. "Windows build not verified on this machine"). Show the user the sign-off
  item from `bb helm needs` first; never sign off on your own initiative.
- `sendback` needs a reason file stating exactly what to redo.
- `complete` is for when every app is done or cancelled (Helm raises a need suggesting it).

## Maintenance

| Command | Use |
|---|---|
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
  what one agent works on, ask its supervisor, or `bb helm tell` the agent directly. Managers see
  only their own apps; cross-group work goes through the Orchestrator.
- **"Show me the app" / simulators** → the panel's **Simulators** button, or `bb helm sim`
  (opens a tab in the Orchestrator thread's in-app browser; prints the URL). iOS simulators
  and Android emulators (headless) stream live; Android is fully interactive (tap, swipe,
  type, Back/Home), iOS is watch-only unless `idb` is installed; both have dark/light,
  large text and open-URL buttons. "Install & run" uses the newest build Helm finds in the
  app's worktrees or Xcode's DerivedData (it never builds). macOS apps are launched and
  their window mirrored (BB needs the Screen Recording permission). Windows apps cannot
  run on a Mac: the view shows the screenshots the Windows builder committed.
- **After a Helm upgrade, mid-run** → agents keep the old skills, tools and prompt until
  their session restarts. `bb helm refresh --yes` rewrites briefs and restarts each live
  agent on the new version (supervisors first; work in worktrees stays).
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
- **"Sign off Tide"** → `bb helm needs` (find the sign-off item, read its evidence and
  unverified notes to the user), confirm, `bb helm signoff tide`.

## Never

- Never put multi-line or user-supplied text inline in a command — use a file.
- Never sign off, send back, stop, deny or complete without the user asking for it.
- Never edit Helm's database, app repositories' `.helm/` files or agents' threads to work
  around the CLI; directives must go through `bb helm` (or the Helm UI) so they are
  recorded and acknowledged.
