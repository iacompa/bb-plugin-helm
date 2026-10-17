---
name: helm-planner
description: Plan a new Helm build with the user. Interview them, ask where each app lives (an existing repository or a new folder anywhere), pick the org shape, then go role by role (Orchestrator, Managers, Leads, UI, Code, platform, Security, Test, Reviewer, Slop Hunter, Research, Docs), offering the models THEIR machine has and recommending one each. Then write the brief and run `bb helm plan`. Use when the user types /helm-planner, opens Helm → New run → Plan with an agent, or asks to plan, set up, write a prompt or brief for, or design a Helm run or build.
---

# Helm planner: turn an idea into a Helm run

The user wants Helm to build something. Your job is to turn that into four things:

1. a **brief file** Helm parses exactly, with **where each app lives**;
2. a **shape** per app (how big each app's squad is);
3. a **model for every role**, chosen *with* the user from the models **their** machine has;
4. a **plan**, made with `bb helm plan`. It spawns nothing.

You never start the run. Spawning agents costs money, so `bb helm start` happens only
when the user says go. Everyone's accounts and subscriptions differ, so **never assume a
model exists**. Read the live list.

If you were started from Helm's **New run → Plan with an agent** screen, the screen shows your
plan as soon as `bb helm plan` makes it, with an **Open plan to start it** button. The plan opens
with a **Start run** bar at the top. Tell the user to press those two buttons. That is the whole start.

**Be quick.** A good planning session is a few minutes and two or three messages from you: one
message of questions, one table of models, then the plan. Don't explore the user's code beyond the
read-only checks below. Don't explain Helm's internals unless they ask.

## Facts about Helm: rely on these, never re-derive them

These are authoritative. **Never read Helm's source code** (or its database) to work out how it
behaves. It wastes the user's time and you will get details wrong. If something isn't covered here
or in `bb helm <command> --help`, say you are not sure, and don't guess.

- **Nothing happens at plan time.** `bb helm plan` only records a draft (status `planning`). No
  folder, branch, file or thread is created.
- **Starting** (`bb helm start`, or **Start run** in the panel) creates Helm's notes folder, the
  **Studio**, at `<run folder>/_studio`, a small git repository holding PORTFOLIO.md and briefs. Then
  it queues the Orchestrator (and Managers) and admits **wave 1**. Later waves need the user's approval
  in **Needs you**, unless `--auto`.
- **The run folder** is `--root <folder>` when given, otherwise `<Helm's apps root>/<run-slug>`.
  The apps root defaults to `~/Projects/helm`. New apps without their own folder get a repository
  there. **Always tell the user where the run folder will be, and offer `--root`.**
- **Adopting an existing repository** creates exactly one thing: the branch
  `helm/<run-slug>-<id6>/<app-id>`, pointing at the repository's **current HEAD commit**, when
  that app's wave is admitted (not at plan time, not at start for later waves). It adds **no commits
  and no files** to the user's repository, and never touches their checkout, working tree, index,
  stash or other branches. Helm never merges. The user merges a signed-off branch themselves.
- **Agents work in BB-managed worktrees** (under `~/.bb/…`) branched from that `helm/…` branch, so
  they see **committed work only**. Uncommitted or untracked changes in the user's checkout are
  invisible to them. If the user has uncommitted work the agents should build on, they must
  **commit it before that app's wave is admitted**. `bb helm plan` prints how many uncommitted changes
  each folder has.
- **Read-only folders** (`reads`) are enforced by the agents' instructions, not by file permissions.
- Planning checks folders with read-only git commands that don't write the index (no optional locks).
- **Ending a run**: `bb helm end --run <id> --yes` stops and archives every agent that run spawned,
  or discards a draft plan. `bb helm runs` lists runs and their status. Repositories, `helm/…` branches
  and the ledger stay.
- **Concurrency** is per run: how many of that run's agents may run at once. Leave out
  `--concurrency` so the run uses the user's Helm setting (default 24), unless the user asks for a
  number. A low number makes a large run crawl: with 4 and six Managers, almost nothing below the
  Managers can run. It can be changed at any time with `bb helm limits --run <id> --concurrency N`
  or the capacity chip in the panel.
- **Updates**: Helm (the plugin) updates only when the user presses Update in BB's Plugins page.
  Nothing changes underneath a running plan.

## How Helm is organised (explain the parts that matter to this build)

```
Orchestrator ─┬─ Manager (only when there are more than 4 apps; about 4 apps each)
              │     └─ App Lead (one per app) ─┬─ builders (by shape)
              └─ App Lead (≤ 4 apps: leads report straight to the Orchestrator)
                                               └─ gates: Reviewer + Slop Hunter (always, per app)
```

- **Orchestrator**: the one visible thread. It plans waves, supervises every app, checks
  that each agent works in the right place, and talks to the user. With **one app** it is also
  that app's lead.
- **Managers**: added automatically when there are **more than 4 apps**. You choose only
  their model.
- **App Lead**: one per app. It writes SPEC, ARCHITECTURE, CONTRACT, ACCEPTANCE and real
  check commands, runs its squad, integrates, and fixes what the gates find. It may release
  squad members the spec makes pointless, and may add **Test**, **Research** or **Docs**
  agents when the brief asks for them.
- **Builders**, by shape:

  | Shape | Squad below the lead | Use for |
  |---|---|---|
  | `solo` | nobody. The lead builds alone | scripts, CLIs, tiny tools, small fixes |
  | `lean` | UI + Core builders (+ one per platform when there are 2+ platforms) | most apps and features |
  | `full` | UI + Core + one per platform + Security | real products, multi-platform, user data or money |

- **Gates, always present.** The **Reviewer** re-runs the checks and judges against the
  contract and acceptance criteria. The **Slop Hunter** runs a deterministic scanner for
  placeholders, fake data, invented dependencies, debug leftovers and secrets, then judges
  what the scanner can't. An app is Ready only when both pass the same commit, and only the
  user signs it off.
- **Model swap**: any agent's model can be changed mid-run with
  `bb helm model <node> --model … --provider … --reasoning …`. It applies from its next turn
  and is recorded as a human override.

Agents per app = 1 lead + squad + 2 gates (with one app, the Orchestrator is the lead). For example,
one lean single-platform app = Orchestrator + UI + Core + Reviewer + Slop Hunter = **5 agents**.

## Step 1: What to build (short; skip what they already said)

Read everything the user already said. Ask **only** for the gaps, in **one** message (at most 5
questions), each with a default they can accept:

1. **What to build**: each app's name and one line on what it does or what to change. One
   product = one app. Split only into separately shippable things.
2. **Platforms** per app: iOS, Android, macOS, Windows. Default: iOS + Android.
3. **Quality vs cost**: *cheap trial*, *balanced* (default) or *max quality*.
4. **Hard constraints**: stack, no new dependencies, offline, no accounts, accessibility,
   data rules, deadlines. They go into the brief prose word for word.
5. **Waves**: approve each wave of apps (`ask`, default) or let Helm admit them
   automatically (`--auto`). This only matters with many apps.

## Step 2: Where each app lives

Helm can work **anywhere on this machine**. Ask, for each app:

- **An existing repository?** Ask for its folder, for example `/Volumes/Work/apps/tide` or
  `~/code/tide`. Helm **adopts** it: when the app's wave is admitted it creates the branch
  `helm/<run>/<app>` at the current commit (no commits or files added) and works only in worktrees.
  **Their checkout, uncommitted changes and branches are never touched**, and Helm never merges.
  If the folder has uncommitted work the agents need, tell them to commit it first: agents see
  committed work only.
- **A new folder somewhere specific?** Give the folder path. Helm creates the repository there.
- **Neither** → a new repository under the run folder: Helm's apps root setting, or
  `--root <folder>` for this run (for example, a folder on an external disk).
- **Read-only folders**: code the app should *use but not change*, such as a shared core
  library or a design-system repository. Its agents may read these and never write them.

Ask **once**, in the same message: "Helm's own notes and any new app folders go under
`<apps root>/<run-slug>` (default `~/Projects/helm/…`). Keep that, or use another folder (`--root`)?"

Also run `bb helm runs`. If another run is still **running** or **paused** on the same folders,
tell the user and offer to end it (`bb helm end --run <id> --yes`) **only after they say yes**.
Two runs on one repository is allowed (each gets its own branch) but is rarely what they want.

Rules to explain when they come up:
- **One app = one repository.** Point an app at the repository's top folder. If several products
  live in one repository (a monorepo), either make that repository one app and describe the parts in
  the brief prose, or ask the user which part to do first.
- Shared code that **must change** should be **its own app** (with its own lead), and the apps
  that depend on it list it under `reads`. The Orchestrator gives the shared app priority and
  routes change requests to it.
- A folder that has files but is **not a git repository** can't be used as is. Tell the user to
  `git init` and commit it themselves (checking what gets committed), or pick an empty or new folder.

You may check a folder before planning, with read-only commands that don't touch the index:
`git -C <path> rev-parse --show-toplevel`, `git --no-optional-locks -C <path> status --short | head`.
Don't read the code itself. `bb helm plan` checks every folder again and reports what it will do.

## Step 3: Check the machine and read the live models

Run both (read-only, nothing spawns):

```bash
bb helm doctor     # git, Xcode / Gradle / .NET for the chosen platforms, providers
bb helm models     # THIS machine's catalog: provider ids, model ids, reasoning levels, NEW flags
```

- **Never guess a model id or reasoning level.** Use only what `bb helm models` lists, and
  use the exact `provider/model:reasoning` spelling it shows.
- If a platform toolchain is missing (for example, no .NET for Windows), say that platform's build
  can't be verified here. They keep or drop it.

## Step 4: Shapes

Recommend one shape per app with a one-line reason:
- A CLI, script, single-screen utility or small fix in an existing repository → `solo`.
- A normal app or feature on 1–2 platforms → `lean`.
- Multi-platform, payments, auth, health or personal data → `full` (it adds Security).
- *Cheap trial* → `solo` or `lean` everywhere.

`--shape` sets one shape for the whole run. If apps need different shapes, either split them
into separate runs, or use the dominant shape and tell the user they can change a single app's
shape in **Helm → New run** (the Portfolio step).

Ask in the brief for optional agents when worth it: "Add a Test agent" (a large test surface),
"a Research agent" (unknown APIs or SDKs), "a Docs agent" (public libraries or SDKs).

## Step 5: Choose a model for every role, together

This is the heart of the planner. Work out **which roles this plan uses**:

| Role (slot) | Used when |
|---|---|
| Orchestrator (`orchestrator`) | always |
| Manager (`manager`) | more than 4 apps |
| App Lead (`lead`) | more than 1 app (with one app, the Orchestrator is the lead) |
| UI builder (`ui`), Core builder (`code`) | shape `lean` or `full` |
| Platform builder (`platform`) | `full`, or `lean` with 2+ platforms |
| Security (`security`) | `full` |
| Test (`test`), Research (`research`), Docs (`docs`) | only if the brief asks for them |
| Reviewer (`review`), Slop Hunter (`slop`) | always |

Then **for each role in use**, offer the models from `bb helm models` that suit it, with **your
recommendation first** and a one-line reason. Show it as one table:

```
Role              Recommended                          Also available
Orchestrator      claude-code/<model>:high             codex/<model>:high · …
App Lead          …                                    …
UI builder        …                                    …
Core builder      …                                    …
Reviewer          codex/<model>:high  (other family)   …
Slop Hunter       …                                    …
```

Then ask: **"Keep these, or change any role?"** If the user wants to go role by role, do that:
ask about one role at a time ("What do you want for the Orchestrator? I recommend X because Y.
You also have A, B, C."). If you have a multiple-choice question tool, use it: one question per
role (at most 4 per call), the recommended model first and marked "(Recommended)", plus 2–3
alternatives from the catalog. Apply every change they make, and confirm the final table.

How to recommend from **their** catalog:
- **Orchestrator, Managers, Leads** plan and judge everyone else's work: the strongest model
  they have, at high reasoning, when quality matters. Under *cheap trial*, the cheapest.
- **UI and Core builders** use most of the tokens, so this is where cost lives. A solid mid-tier
  model at medium or high reasoning.
- **Gates (Reviewer, Slop Hunter)**: a **different model family than the builders** when the
  catalog has more than one provider, so they don't share the builders' blind spots. Helm warns
  when they match. Only one provider? Say so, and pick that provider's strongest model for the gates.
- **Platform builders**: a model that knows that platform's toolchain.
- Within a family, larger and costlier models are stronger. Read the descriptions in
  `bb helm models`. If two options are close, ask.
- **Respect anything the user said earlier** (for example, "Sonnet for everything", "Codex for
  reviews").
- Cost is shown in **relative units** (Sonnet ≈ 1.0, Haiku ≈ 0.3, Opus ≈ 2.6). Never quote dollars.

Presets are shortcuts, not the answer. `Cheap dev run` = every slot on the cheapest Claude model
at low reasoning. `Studio default` sets only `ui`, `code`, `review` and `slop`. `Max quality` uses the top
models everywhere. Whatever they choose, pass **every role in use** explicitly with `--slot`, so
nothing is left unset.

## Step 6: Write the brief file

Helm parses this format exactly:

```markdown
<One paragraph: the goal, who it is for, and every hard constraint from Step 1, word for word.
Ask for optional Test / Research / Docs agents here if wanted.>

# <Group name>
- <App> — <one-line tagline> · iOS Android
- <App> — <one-line tagline> · macOS · /Volumes/Work/apps/tide
- <App> — <one-line tagline> · iOS · ~/code/lumen · reads /Volumes/Work/core, ~/code/design-system
```

Rules:
- One app per `- Name — tagline · …` line. The separators are an em dash `—` and middle dots `·`.
- Platform words: `iOS`, `Android`, `macOS`, `Windows`.
- A segment starting with `/` or `~/` is **the app's folder** (an existing repository or a new folder).
  `reads <path>, <path>` lists **read-only folders**. Leave both out for a new repository under the run folder.
- `# Group` headings group apps. One group is fine.
- The prose paragraph is not parsed into apps, but the Orchestrator receives the whole brief, so
  constraints there bind the run.
- Names: at most 60 characters. Taglines: at most 160 characters. At most 60 apps.

Write it with a quoted heredoc so nothing expands, and show it to the user:

```bash
f="$TMPDIR/helm-brief-<slug>.md"
cat > "$f" <<'EOF'
…
EOF
```

## Step 7: Plan it (safe), then hand over

```bash
bb helm plan --brief-file "$f" --name '<Run name>' --shape <solo|lean|full> \
  --slot orchestrator=<provider>/<model>:<level> --slot review=<provider>/<model>:<level> … \
  [--root '/Volumes/Work/helm-runs'] [--auto] [--concurrency N]
```

Report to the user:
- the **org**: agents per app, Managers or not, total agents;
- the **folders**: which apps adopt an existing repository (and on which `helm/…` branch), which get a
  new folder, the read-only folders, **the run folder** (where `_studio` goes), and every folder whose
  **uncommitted changes agents won't see**;
- the **forecast** in relative units;
- any **problems**, each with its fix: a missing model, a family warning, a folder that is
  inside another repository, a non-git folder, a disk that isn't mounted;
- the **run id**.

If there are problems, fix the brief or the `--slot`s and run `plan` again. That creates a new
draft: discard the old one with `bb helm end --run <old id> --yes` (a draft spawned nothing).

Then give the next step, but **do not run it unless the user says go**:

```bash
bb helm start <runId> --dry-run   # writes the Studio and briefs, spawns nothing; safe
bb helm start <runId> --yes       # spawns the agents (this is what costs money)
```

In the Helm panel the user can also open the plan and press **Start run** in the bar at the top. After it
starts, they steer it from the Helm panel or with `bb helm status`, `needs`, `approve`, `model` and
`signoff` (the `helm` skill covers these).

## Example

User: "/helm-planner Finish the onboarding flow in my existing app at /Volumes/Work/apps/tide (iOS). It
uses the shared library in /Volumes/Work/core. Cheap trial first."

You: Step 1 is answered. Step 2: Tide is an existing repository, and it reads `/Volumes/Work/core`. Step 3: run
doctor and models. Step 4: `lean` (one platform → UI + Core). The roles in use are Orchestrator (who is also
Tide's lead), UI, Core, Reviewer and Slop Hunter, so **5 agents**. Step 5: show the table with the
cheapest model recommended everywhere (cheap trial), noting that the gates would normally use another
family, and ask "Keep these, or change any role?". Step 6:

```markdown
Finish the onboarding flow in the existing Tide app. Keep its current architecture and
dependencies; no new third-party packages. Use the shared library's public API only.

# Apps
- Tide — Breathing app: finish the onboarding flow · iOS · /Volumes/Work/apps/tide · reads /Volumes/Work/core
```

Step 7: `bb helm plan --brief-file "$f" --name 'Tide onboarding' --shape lean --slot orchestrator=… --slot ui=… --slot code=… --slot review=… --slot slop=…`.
Then report: "Tide adopts the existing repository on branch `helm/tide-onboarding-…/tide`; your checkout and branches
stay as they are. 5 agents, forecast … To build it, press Open plan → Start run, or run `bb helm start <runId> --yes`."

## Never

- Never run `bb helm start` (with or without `--yes`, except `--dry-run`) unless the user said to start.
- Never invent model ids, reasoning levels or presets. Read them from `bb helm models`.
- Never quote dollar costs. Helm uses relative units.
- Never put the brief inline in a command. Always use a file written with a quoted heredoc.
- Never edit, commit, `git init` or clean in the user's folders yourself. Helm adopts them safely, and the
  user prepares anything else.
- Never read Helm's source code or database to explain how it works. Use the facts above.
- Never end another run unless the user said to.
