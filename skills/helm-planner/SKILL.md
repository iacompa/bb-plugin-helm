---
name: helm-planner
description: Plan any Helm run with the user (apps, websites and full-stack web apps, games, automation, or reviews of existing projects). Interview them, confirm what each project is, what it needs (database, accounts, payments, security, HIPAA, privacy, realtime, AI, automation, art, multiplayer) and which tools it uses (Unreal, Unity, Godot, Blender, Docker, BB plugins), ask where each project lives, pick a shape, choose a model for every role from the models this machine has, then write the brief and run `bb helm plan`. Use when the user types /helm-planner, opens Helm → New run → Plan with an agent, or asks to plan, set up, scope, write a brief or prompt for, or design a Helm run.
---

# Helm planner: turn an idea into a Helm run

The user wants Helm to build, finish or review something. Turn that into four things:

1. a **brief file** Helm parses exactly: every project, **what kind it is**, **what it needs**,
   **which tools it uses**, and **where it lives**;
2. a **shape** per project (how big its squad is);
3. a **model for every role in use**, chosen *with* the user from the models **their** machine has;
4. a **plan**, made with `bb helm plan`. It spawns nothing.

You never start the run. Spawning agents costs money, so `bb helm start` happens only when the
user says go. Everyone's accounts differ, so **never assume a model or tool exists**: read the
live lists.

If you were started from Helm's **New run → Plan with an agent** screen, the screen shows your
plan as soon as `bb helm plan` makes it, with an **Open plan to start it** button. The plan opens
with a **Start run** bar at the top. Tell the user to press those two buttons. That is the whole start.

**Be quick.** A good session is a few minutes and two or three messages from you: one message of
questions, one table of models, then the plan. Don't explore the user's code beyond the read-only
checks below, and don't explain Helm's internals unless they ask.

## Facts about Helm: rely on these, never re-derive them

These are authoritative. **Never read Helm's source code or database** to work out how it
behaves. If something isn't covered here or in `bb helm <command> --help`, say you are not sure.

- **Nothing happens at plan time.** `bb helm plan` records a draft (status `planning`). No folder,
  branch, file or thread is created.
- **Starting** (`bb helm start`, or **Start run** in the panel) creates Helm's notes folder, the
  **Studio**, at `<run folder>/_studio`, queues the Orchestrator (and Managers) and admits **wave 1**.
  With autonomy high (the default) later waves go ahead on the record; with `ask` they wait for the user.
- **The run folder** is `--root <folder>` when given, otherwise `<apps root>/<run-slug>` (the apps root
  defaults to `~/Projects/helm`). Projects without their own folder get a new repository there.
  **Always tell the user where the run folder will be, and offer `--root`.**
- **Existing repositories are adopted safely.** When that project's wave is admitted, Helm creates one
  branch, `helm/<run-slug>-<id6>/<project-id>`, at the repository's current HEAD. It adds **no commits and
  no files**, never touches the user's checkout, working tree, index, stash or other branches, and never
  merges. The user merges a signed-off branch themselves.
- **Each project works in one shared worktree**: besides the user's checkout, one shared work worktree
  beside the repository, `<repository folder>/.helm-work/<repository>`, on that branch and on the same
  disk, plus only the lanes the Git agent adds for parallel work (at most the "Worktrees per project"
  setting, default 10). Every agent of the project works there, so they see **committed work only**.
  Keep `appsRoot` on a disk with room; the run's **Git agent** keeps the rule, watches disk space
  and pushes signed-off work.
  If the user has uncommitted work the agents should build on, they must commit it before that wave is
  admitted. `bb helm plan` prints the uncommitted changes per folder.
- **Read-only folders** (`reads`) are enforced by the agents' instructions, not file permissions.
- **Ending a run**: `bb helm end --run <id> --yes` stops and archives every agent the run spawned, or
  discards a draft. `bb helm runs` lists runs. Repositories, `helm/…` branches and the ledger stay.
- **Autonomy** defaults to high: the Orchestrator decides agents' questions, waves and plan changes, and
  the user is asked only about credentials, spending real money, private data or access (plus sign-off
  and failures). Change it with `bb helm limits --run <id> --autonomy ask|high`.
- **Concurrency** is per run. Leave out `--concurrency` so the run uses the user's Helm setting (default
  24) unless they ask for a number; a low number makes a large run crawl.
- **Real-world effects need the human.** Payments stay in test mode, deployments stay local or preview,
  and automations act on no real account until the user provides credentials and approves. Agents never
  install engines or paid software. Mention this when the plan has payments, deployment or automation.
- **Updates**: Helm updates only when the user presses Update in BB's Plugins page.

## What Helm can run

Every project in a run has a **kind**. Helm also decides the kind itself from the project's line, so you
mostly confirm it:

| Kind | What it delivers | Full squad below the lead |
|---|---|---|
| `app` | Native or cross-platform apps (iOS, Android, macOS, Windows) | UI, Core, one builder per platform, Security |
| `web` | Websites and full-stack web apps: frontend, backend, database, deployment | UI (pages), Core (backend), Data (with a database), Web builder, Security |
| `game` | Mobile, desktop or web games, in Unreal, Unity, Godot or a web engine | UI (HUD and menus), Core (gameplay), platform builders, Asset builder |
| `automation` | Bots, scheduled jobs, integrations, data pipelines, workflow tools | Core, Security, Test, Docs |
| `review` | An independent audit of an existing project: REVIEW.md with evidence, **no code changes** | Code, UI, platform, Security and Test auditors |

A **review** never changes the code. If the user wants an existing project **fixed or finished**, plan it
as an `app`, `web` or `game` pointed at its folder (Helm adopts the repository on a branch). A common pair:
a `review` run first, then a fix run that reads the review.

Each project also has **needs**, which add rules for every agent and sometimes a specialist:

| Need | Means | Adds |
|---|---|---|
| `database` | Server data with a schema, migrations, backups | a **Data builder** (Full; in Lean the Core builder owns it) |
| `auth` | Accounts, sign-in, roles | Security even in Lean |
| `payments` | Checkout, subscriptions, in-app purchases (test mode) | Security even in Lean; payment craft for Core and Security |
| `security` | Security is a headline requirement | Security even in Lean |
| `hipaa` | Protected health information (patients, clinics, medical records) | **Compliance** (any shape) and Security |
| `privacy` | GDPR, CCPA, children's data | Compliance (Full) |
| `realtime` | Live updates, chat, collaboration | rules only |
| `ai` | LLM or ML features | rules only (keys server-side, cost caps) |
| `automation` | Scheduled jobs, webhooks, integrations inside a bigger project | automation craft for Core |
| `assets` | 3D, 2D or audio art | an **Asset builder** (games in Lean or Full; apps and websites in Full) |
| `multiplayer` | Online play | Security in a Full game; realtime rules |

And **tools**: external programs (`unreal`, `unity`, `godot`, `blender`, `docker`, `ffmpeg`, or any other
name) and enabled BB plugins written `plugin:<id>` (for example `plugin:browser-automation` to check a
website in a real browser, `plugin:automations` to run a finished job on a schedule inside BB). Every brief
tells the agents how to use each tool headless and whether it is installed on this machine.

**How Helm decides** (so you can predict and correct it): "online store", "checkout", "Stripe" → payments;
a website with payments or accounts → a database; "patients", "clinic", "medical records" → HIPAA (a sleep
or fitness tracker is not HIPAA); "game", "platformer", "shooter", an engine name → game; "automate",
"bot", "scraper", "cron" → automation (unless native platforms are named); "website", "portal", "SaaS",
"landing page" → web; a tagline starting "Review" or "Audit" → review; a 3D game → Blender; a website with a
database → Docker. An Unreal game with no platforms named targets macOS and Windows; other games and apps
default to iOS and Android; websites to web; automation and reviews need no platform. `bb helm plan` prints
each decision with its reason.

## How Helm is organised

```
Orchestrator ─┬─ Manager (only with more than 4 projects; about 4 each)
              │     └─ Lead (one per project) ─┬─ specialists (by kind, shape and needs)
              └─ Lead (≤ 4 projects: leads report straight to the Orchestrator)
                                               └─ gates: Reviewer + Slop Hunter (always)
```

- **Orchestrator**: the one visible thread. It plans waves, supervises everything, can change a project's
  kind, needs or tools mid-run (the squad follows), and talks to the user. With **one project** it is also
  that project's lead.
- **Managers**: added automatically with more than 4 projects. You choose only their model.
- **Lead**: one per project. Writes the spec (for a review: the review plan), runs its squad, integrates,
  and fixes what the gates find. It may release specialists the spec makes pointless, and add **Test**,
  **Research** or **Docs** agents when the brief asks for them.
- **Shapes** set the size:

  | Shape | Squad | Use for |
  |---|---|---|
  | `solo` | nobody; the lead does it all, with every needed craft skill | scripts, small tools, small fixes, quick audits |
  | `lean` | UI + Core (Core alone for automation; Code + Security auditors for a review), platform builders with 2+ platforms, + what the needs force | most projects |
  | `full` | the kind's full squad (table above) + what the needs add | real products, multi-platform, money, health or personal data |

- **Gates, always present.** The **Reviewer** re-runs the checks and judges against the acceptance
  criteria; the **Slop Hunter** scans for placeholders, fake data, invented dependencies, debug leftovers
  and secrets, then judges what the scanner can't. For a review project they judge the report: every
  finding must have evidence. A project is Ready only when both pass the same commit, and only the user
  signs it off.
- **Model swaps** mid-run: `bb helm model <node> --model … --provider … --reasoning …`, or whole roles with
  `bb helm slots`.

Agents per project = 1 lead + squad + 2 gates (with one project the Orchestrator is the lead). Example: one
lean single-platform app = Orchestrator + UI + Core + Reviewer + Slop Hunter = **5 agents**. A full website
with a database and payments = lead + UI + Core + Data + Web + Security + 2 gates = **8 agents**.

## Step 1: What to build (one message; skip what they already said)

Read everything the user already said. Ask **only** for the gaps, in **one** message of at most 6
questions, each with a default they can accept:

1. **The projects**: each one's name and one line on what it does, or what to change or audit. One
   shippable product = one project. Say the kind you understood for each ("Website", "Game", "Review"…).
2. **Platforms**: iOS, Android, macOS, Windows, Web. Default from the kind (above).
3. **Needs you are not sure about**: only the ones that change the squad or the risk. For example: "Does
   the store take payments, or only show products?", "Will it store patient information?", "Do players
   play online together?", "Accounts, or no sign-in?". Don't ask about needs the user already made clear.
4. **Engine and tools** for games and art: Unreal, Unity, Godot or a web engine; Blender for 3D. For
   websites: any required stack or host. For automation: what triggers it and which services it touches.
5. **Quality vs cost**: *cheap trial*, *balanced* (default) or *max quality*.
6. **Hard constraints**: stack, no new dependencies, offline, accessibility, data rules, regions,
   deadlines. They go into the brief prose word for word.

For HIPAA, payments and deployment, tell the user once what stays with them: signing BAAs with vendors,
live payment keys and real charges, domains and hosting accounts, and any credential. Agents build
against test modes and local services until then.

## Step 2: Where each project lives

Helm works **anywhere on this machine**. For each project ask:

- **An existing repository?** Ask for its folder path. Helm adopts it on a branch (see the facts above).
  If it has uncommitted work the agents need, tell the user to commit it first.
  Reviews always name an existing folder.
- **A new folder somewhere specific?** Give the path; Helm creates the repository there.
- **Neither** → a new repository under the run folder.
- **Read-only folders**: code or material the project should *use but not change* (a shared library, a
  design system, an earlier review). Its agents may read these and never write them.

Ask **once**: "Helm's notes and any new project folders go under `<apps root>/<run-slug>` (default
`~/Projects/helm/…`). Keep that, or use another folder (`--root`)?"

Run `bb helm runs`. If another run is **running** or **paused** on the same folders, tell the user and
offer to end it (`bb helm end --run <id> --yes`) **only after they say yes**.

Rules to explain when they come up:
- **One project = one repository**, pointed at its top folder. For a monorepo, make it one project and
  describe the parts in the brief prose, or ask which part goes first.
- Shared code that **must change** should be **its own project**; the projects that depend on it list it
  under `reads`. The Orchestrator gives it priority.
- A folder with files that is **not a git repository** can't be used as is. The user runs `git init` and
  commits it themselves, or picks an empty or new folder.

You may check a folder with read-only commands that don't touch the index:
`git -C <path> rev-parse --show-toplevel` and `git --no-optional-locks -C <path> status --short | head`.
Don't read the code. `bb helm plan` checks every folder again.

## Step 3: Check the machine and read the live models

Run both (read-only, nothing spawns):

```bash
bb helm doctor     # git, Xcode / Gradle / .NET, project tools (Blender, Unreal, Unity, Godot, Docker, FFmpeg), providers
bb helm models     # THIS machine's catalog: provider ids, model ids, reasoning levels, NEW flags
```

- **Never guess a model id or reasoning level.** Use only what `bb helm models` lists, spelled exactly
  `provider/model:reasoning`.
- If a platform toolchain is missing (no .NET for Windows, no Android SDK), that platform's build can't be
  verified here. The user keeps or drops it.
- If a tool the plan needs is missing (an engine, Blender, Docker), say so now. The user installs it or
  changes the plan; agents never install it.
- `bb plugin list` shows the enabled BB plugins if the user wants one used as a tool.

## Step 4: Shapes

Recommend one shape per project with a one-line reason:
- A script, CLI, single-screen utility, small fix, or quick audit of a small project → `solo`.
- A normal project on 1–2 platforms → `lean`.
- Multi-platform, a full-stack product, payments, accounts, health or personal data, a commercial game, or
  a thorough audit → `full`.
- *Cheap trial* → `solo` or `lean` everywhere.

`--shape` sets one shape for the whole run. If projects need different shapes, use the dominant one and
tell the user they can change a single project's shape (and its kind and needs) in **Helm → New run**
(the Portfolio step), or split them into separate runs.

Ask in the brief prose for optional agents when worth it: a Test agent (a large test surface), a Research
agent (unknown APIs, SDKs or regulations), a Docs agent (public libraries, SDKs, runbooks).

## Step 5: Choose a model for every role, together

Work out **which roles this plan uses**:

| Role (slot) | Used when |
|---|---|
| Orchestrator (`orchestrator`) | always |
| Manager (`manager`) | more than 4 projects |
| Lead (`lead`) | more than 1 project |
| UI builder (`ui`) | lean or full apps, websites and games; full reviews. **Asset builders use this slot** (any game with art or Blender) |
| Core builder (`code`) | any lean or full project. **Data builders use this slot** |
| Platform builder (`platform`) | full, or lean with 2+ platforms; includes the **Web builder** |
| Security (`security`) | full (games only with accounts, payments or multiplayer), every review, or a sensitive need (auth, payments, HIPAA, security). **Compliance uses this slot** |
| Test (`test`) | full automation and reviews, or when the brief asks |
| Research (`research`), Docs (`docs`) | when the brief asks; Docs in full automation |
| Reviewer (`review`), Slop Hunter (`slop`) | always |

For **each role in use**, offer the models from `bb helm models` that suit it, **your recommendation
first** with a one-line reason, as one table:

```
Role              Recommended                          Also available
Orchestrator      <provider>/<model>:high              <provider>/<model>:high · …
Lead              …                                    …
UI builder        …                                    …
Core builder      …                                    …
Reviewer          <other family>/<model>:high          …
Slop Hunter       …                                    …
```

Then ask: **"Keep these, or change any role?"** If the user wants to go role by role, ask one role at a
time with your recommendation and the alternatives. With a multiple-choice question tool, use one question
per role (at most 4 per call), the recommended model first and marked "(Recommended)". Apply every change
and confirm the final table.

How to recommend from **their** catalog:
- **Orchestrator, Managers, Leads** plan and judge everyone's work: the strongest model they have, at high
  reasoning, when quality matters. Under *cheap trial*, the cheapest.
- **UI and Core builders** use most of the tokens, so cost lives here: a solid mid-tier model at medium or
  high reasoning. Backend-heavy websites, games and data work favour a strong coder for Core.
- **Security** (and Compliance with it) for payments or health data: a strong model at high reasoning.
- **Gates**: a **different model family than the builders** when the catalog has more than one provider,
  so they don't share blind spots. With one provider, use its strongest model for the gates.
- **Platform builders**: a model that knows that platform's toolchain.
- **Respect anything the user said** ("one model for everything", "a different family for reviews").
- Cost is in **relative units** (Sonnet ≈ 1.0, Haiku ≈ 0.3, Opus ≈ 2.6). Never quote dollars.

Presets are shortcuts: `Cheap dev run` puts every slot on the cheapest Claude model at low reasoning,
`Studio default` sets only `ui`, `code`, `review` and `slop`, `Max quality` uses the top models everywhere.
Whatever they choose, pass **every role in use** with `--slot` so nothing is left unset.

## Step 6: Write the brief file

Helm parses this format exactly:

```markdown
<One paragraph: the goal, who it is for, every hard constraint from Step 1 word for word, and any
optional Test / Research / Docs agents.>

# <Group name>
- <Name> — <one-line tagline> · <platforms>
- <Name> — <one-line tagline> · <kind> · needs <need>, <need> · tools <tool>, <tool> · <folder>
- <Name> — <one-line tagline> · <platforms> · <folder> · reads <folder>, <folder>
```

Each `·` segment is one of:
- **platforms**: `iOS`, `Android`, `macOS`, `Windows`, `Web` (any order, one segment or several);
- **a kind word**: `App`, `Website` (or `Web app`, `Full-stack`), `Game`, `Automation`, `Review` (or `Audit`);
- **`needs …`**: `database`, `auth` (accounts), `payments`, `security`, `hipaa`, `privacy` (GDPR),
  `realtime`, `ai`, `automation`, `assets`, `multiplayer`; `needs none` turns detection off;
- **`tools …`**: `Unreal`, `Unity`, `Godot`, `Blender`, `Docker`, `FFmpeg`, other program names, or BB
  plugins as `plugin:<id>` (`browser` means `plugin:browser-automation`);
- **a folder**: starts with `/`, `~/` or a drive letter. It is the project's own folder (an existing
  repository or a new folder). `reads <folder>, <folder>` lists read-only folders.

Rules:
- One project per `- Name — tagline · …` line, with an em dash `—` and middle dots `·`.
- **Write what you and the user agreed explicitly** (kind, needs, tools), even when Helm would detect it:
  explicit values win and nothing is left to keyword luck. Named needs replace detected ones.
- `# Group` headings group projects (they also hint the kind: `# Websites`, `# Games`).
- The prose paragraph is not parsed into projects, but the Orchestrator reads the whole brief, so
  constraints there bind the run.
- Names ≤ 60 characters, taglines ≤ 160, at most 60 projects.

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
  [--root '<folder>'] [--auto] [--concurrency N]
```

Report to the user:
- the **projects**: each one's kind, needs, tools, platforms and squad, exactly as `plan` printed them,
  and any decision Helm made that you did not agree with the user (fix it on the line and re-plan);
- the **org**: Managers or not, total agents;
- the **folders**: which projects adopt an existing repository (and on which `helm/…` branch), which get a
  new folder, the read-only folders, **the run folder**, and every folder whose **uncommitted changes
  agents won't see**;
- **tools** the plan needs that `doctor` did not find;
- the **forecast** in relative units;
- any **problems**, each with its fix (a missing model, a family warning, a folder inside another
  repository, a non-git folder, a disk that isn't mounted);
- the **run id**.

If something is wrong, fix the brief or the `--slot`s and run `plan` again. That makes a new draft: discard
the old one with `bb helm end --run <old id> --yes` (a draft spawned nothing).

Then give the next step, but **do not run it unless the user says go**:

```bash
bb helm start <runId> --dry-run   # writes the Studio and briefs, spawns nothing; safe
bb helm start <runId> --yes       # spawns the agents (this is what costs money)
```

In the Helm panel the user can open the plan and press **Start run**. After it starts they steer it from
the panel or with `bb helm status`, `needs`, `approve`, `model` and `signoff` (the `helm` skill covers these).

## Example

User: "/helm-planner I want a booking website for a physiotherapy clinic with online payments, a small
mobile game for kids, and an audit of our existing iOS app before we fix it. Balanced quality."

You (one message): "Here's what I understood, with defaults:
1. **Clinic booking**: a website (web), needs a database, accounts, payments, and HIPAA because it stores
   patient appointments. Payments by card through a hosted checkout? Any stack or host you require?
2. **Kids game**: a mobile game for iOS and Android. 2D or 3D? Any engine (Godot, Unity), or should the
   agents choose? Because players are children, I'll add privacy (COPPA). OK?
3. **iOS app audit**: a review of the existing app: a report with evidence, no code changes. Its folder?
4. New folders go under `~/Projects/helm/<run>`; keep that?
Live payment keys, the BAA with your hosting and database vendors, and the domain stay with you: agents use
test mode and local services until you provide them."

After the answers: doctor and models; shapes `full` (clinic), `lean` (game), `full` (audit); the model
table; then:

```markdown
Build a clinic booking website, a kids' mobile game, and audit the existing iOS app. Patient data never
leaves the clinic's chosen region. No ads in the game. Add a Test agent to the clinic site.

# Clinic
- Clinic booking — Book and pay for physiotherapy sessions · Website · needs database, auth, payments, hipaa · tools Docker, plugin:browser-automation

# Kids
- Puddle Jump — A gentle 2D platformer for young children · Game · iOS Android · needs privacy · tools Godot

# Audit
- App audit — Review the existing iOS app before the fix · Review · iOS · <folder of the existing repository>
```

Then `bb helm plan --brief-file "$f" --name 'Clinic, game, audit' --shape full --slot …` for every role in
use (orchestrator, lead, ui, code, platform, security, test, review, slop), and the report: each project's
profile and squad as printed, the adopted repository's `helm/…` branch, the run folder, missing tools, the
forecast and the run id. Note that `--shape full` made the game full too; offer to set it back to lean in the
Portfolio step.

## Never

- Never run `bb helm start` (except `--dry-run`) unless the user said to start.
- Never invent model ids, reasoning levels, presets, needs or plugin ids. Read models from `bb helm models`
  and plugins from `bb plugin list`.
- Never quote dollar costs. Helm uses relative units.
- Never plan a review when the user wants changes, or changes when they asked for an audit. Ask if unclear.
- Never put the brief inline in a command. Always use a file written with a quoted heredoc.
- Never edit, commit, `git init` or clean in the user's folders, and never install tools yourself.
- Never read Helm's source code or database to explain how it works. Use the facts above.
- Never end another run unless the user said to.
