---
name: helm
description: Drive the Helm BB plugin from the command line with `bb helm …` — plan and start runs from a brief, read world state, tell/steer/pause/stop agents, change models and priorities, answer Needs-you items, sign off or send back apps, read the ledger, export. Use when the user asks to inspect or steer a Helm run (portfolio, agents, needs, sign-off) from a terminal or script.
---

# `bb helm` — the Helm CLI

Helm runs a portfolio of app builds as an agent hierarchy: Orchestrator → Managers → App
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
  [--name 'Outdoor apps'] [--root '/Volumes/Work/helm-runs']
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
  Slots: `orchestrator manager lead ui code platform security test review slop research docs`.
  Check model ids and reasoning levels with `bb helm models` — never guess them.
- Run `start --dry-run` first and show the user the result; `start` without `--yes` asks.

## Steer agents

```bash
bb helm tell <node> --message-file f.md [--cascade self|reports|subtree] [--mode steer|queue] [--policy]
bb helm model <node> --model <id> [--provider <id>] [--reasoning <level>]
bb helm pause|resume|stop|retry <node> [--cascade self|reports|subtree]
bb helm priority <app|node> low|normal|high
```

- `tell` — a binding instruction. `--cascade`: `self` (default, just the node), `reports`
  (node + direct reports), `subtree` (everyone below). `--mode steer` (default) interrupts
  at the next step; `queue` waits for the current turn. `--policy` also makes it a standing
  policy (`P-n`) for that subtree: injected into future agents' briefs and `helm_context`.
  Every affected agent must `helm_ack` it; its parent gets the full notice; higher
  ancestors a digest line.
- `model` — applies from the agent's next turn and marks it as a human override; agents are
  told not to revert it.
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
  `bb helm model <app>.review --model … --provider …` per gate (or a `--slot` at plan time).
- **"Sign off Tide"** → `bb helm needs` (find the sign-off item, read its evidence and
  unverified notes to the user), confirm, `bb helm signoff tide`.

## Never

- Never put multi-line or user-supplied text inline in a command — use a file.
- Never sign off, send back, stop, deny or complete without the user asking for it.
- Never edit Helm's database, app repositories' `.helm/` files or agents' threads to work
  around the CLI; directives must go through `bb helm` (or the Helm UI) so they are
  recorded and acknowledged.
