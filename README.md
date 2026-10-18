# Helm

A BB plugin that runs a portfolio of software projects (apps, websites, games, automation, and reviews of existing projects) as a supervised hierarchy of agents:

```
Orchestrator → Managers (only when apps > 4) → App Leads → Specialists + Gates (Reviewer, Slop Hunter)
```

You get a plan from a plain-language brief, models chosen every run, a graph and board of every agent, directives that reach the whole chain of command with receipts, one Needs-you inbox, and Ready gated on verified evidence.

Every agent loads the skills for its role by default (`skills/`). The UI builder designs natively for iOS and Android (a direction contract, a visual target per screen, captures on your devices, compare-and-fix, and a native self-audit). The Slop Hunter writes a coverage plan for every part of the app it is given before it hunts, and checks user-facing copy for stock phrasing and unbacked claims. The Reviewer reviews design first, then line by line, and says what is solid as well as what must change.

The full brief and the UI contract are in [spec/](spec/). How the design is built is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). What was proven on this machine is in [docs/VERIFY.md](docs/VERIFY.md). Every default and deviation is in [docs/DECISIONS.md](docs/DECISIONS.md).

## Requirements

- BB ≥ 0.46, plugin SDK ≥ 0.6.49, Node 24 (for the tests).
- git on the host. `bb helm doctor` checks it, along with Xcode, Gradle and .NET for the platforms you target.
- At least one provider with models. Helm never substitutes a model you did not choose.

## Install

Install from a stable folder. BB warns when a plugin is installed from inside a BB-managed workspace, because the source is deleted when that environment is destroyed.

```
npm install
bb plugin build
bb plugin install path:. --yes
bb helm doctor
```

After editing the source: `bb plugin build && bb plugin reload helm`.

## Your first run

1. `bb helm doctor`: git, your providers' models, and the platform tools Helm found.
2. Write a short brief, for example `brief.md`:

   ```
   # Tools
   - Pebble — habit counter with streaks · iOS · ~/code/pebble
   ```
3. `bb helm plan --brief-file brief.md --preset "Cheap dev run" --shape lean` prints the team, the forecast and anything that blocks a start.
4. `bb helm start <runId> --dry-run` writes the plan files only; `bb helm start <runId> --yes` starts it.
5. `bb helm needs` while it runs, `bb helm signoff pebble` when it is Ready, `bb helm end --yes` to stop early.

Or do all of it in the panel: **Helm → New run**.

## Costs

Every agent is its own thread on your providers. Even this one-app run starts the Orchestrator, the Planner, the Git agent, a squad and two gates, and a 20-app plan can be 170 agents. By default up to 24 agents run at once and **autonomy is high**: the Orchestrator admits later waves and approves plan changes itself. Helm estimates cost in **relative units** (1 u is about 133k tokens on a weight-1.0 model such as Sonnet; cheaper models count less) and stops spawning at the run's **budget cap** (default 2,500 u), then asks you. Set the cap, the concurrency and the autonomy when you approve a run, or later with `bb helm limits`.

## Use it

In BB, open **Helm** in the sidebar and choose **New run**. In step 1, choose **Plan with an agent** to plan in a conversation right there. Or type `/helm-planner` in any BB thread. Either way, the planner:
- asks what you want built and where each app lives;
- goes role by role (Orchestrator, Managers, Leads, UI, Code, platform, Security, Test, Reviewer, Slop Hunter, Research, Docs), listing the models **your** setup has and recommending one for each;
- writes the brief and runs `bb helm plan`.

No run agent spawns until you start the plan. When the planner has made it, press **Open plan to start it**. A plan that has not started shows a **Start run** bar at the top: it checks your models and folders first, says what will happen (wave 1 starts right away; later waves follow on the Orchestrator's decision with autonomy high, or on yours with autonomy ask), and shows exactly what to fix if it can't start yet. **Details** in that bar offers a dry run and **Discard plan**.

**Helm remembers where you were.** The New run wizard keeps its draft: brief, portfolio, models, and the planning conversation. Your view, selection and inspector tab are kept too. Leave the panel, reload, or open Helm in another window, and you come back to the same place. **Close** keeps the draft (New run reopens it). **Discard** clears it, and starting a run clears it.

**Talk to the Planner.** Every run has four agents at the top of the graph:
- The **Orchestrator** runs the build and delegates.
- The **Planner** sits beside it, on the model you choose, unconnected to the rest, and stays idle until you ask it something.
- The **Git agent** sits beside them too. It keeps every app's branches and worktrees in order, shows the space they take (the **Worktrees** button on its card), makes the installs agents ask for and sends work where you say (see below).
- The **Fixer** waits beside them until an agent fails or gets stuck. Then it finds out why and gets it going again: a retry, another model, a worktree the Git agent rebuilds, or the work handed to someone else. It tells the Orchestrator what it did, so those errors never stop for you. Choose its model in **Models → Default models** (otherwise it uses the run's Orchestrator model).

They are called by their roles. To give one a personal name, set it in Settings or run `bb helm rename planner "Nova"` (it shows as "Nova · Planner"); `bb helm rename planner none` clears it.

Click the Planner in the graph (or run `bb helm ask "…"`) to ask about the run or change it. It can add a project, add a need such as HIPAA, or change models. It can also design **new kinds of agent** for your run: a GitHub sync agent, a storage guard that keeps work on your external SSD, a HIPAA reviewer, a workflow debugger. It names each one and tells you the name; rename any agent with `bb helm rename`. Custom agents report to the Orchestrator, a manager or a lead. Events wake them (no polling), and anything leaving your machine still needs you.

**Arrange the graph your way.** Drag any card to move it, or drag a group by its label to move the whole group; an expanded app's squad moves with it. Positions are kept per run in this browser, and the reset button next to Fit puts everything back. Drag the inspector's left edge to make it wider or narrower (double-click the edge to reset).

**It runs like a company.** Leads decide inside their apps and managers inside their groups. The Orchestrator oversees and delegates; it does not hand out per-item GOs. Questions go up only when they cross a team, and at most three an hour wake the next level. You hear about credentials, spending, private data, access, and questions only you can answer.

Or use the terminal:

```
bb helm plan --brief-file brief.md --preset "Cheap dev run"   # no run agent spawns (free text: one short planner thread reads it); prints the shape, forecast, problems
bb helm start <runId> --dry-run                               # writes the Studio and briefs, spawns nothing
bb helm start <runId> --yes
bb helm status
bb helm nodes                     # every agent's id, status and model
bb helm needs                     # approvals, questions, failures, sign-offs, with the command for each choice
bb helm needs N-12                # one item in full, with its evidence
bb helm resolve N-12 retry        # act on an item: retry, stop, change-model, raise-cap, waive, sendback…
bb helm tell <agent> --message-file note.md   # it acts now, without asking its supervisors (they get an FYI); an agent that has not started is started
bb helm model <agent> --model claude-sonnet-5-5 --provider claude-code --reasoning medium
bb helm slots --replace codex --with claude-code/claude-sonnet-5-5:high   # a provider ran out: move every role off it now
# or just ask in a thread: the Orchestrator, a Manager or a Lead changes the models of the agents below it
bb helm ask "Add a HIPAA reviewer for the clinic app"   # talk to the Planner
bb helm agents                    # the Planner, the Orchestrator, the Git agent and every custom agent
bb helm git                       # start the Git agent if the run has none, and print its thread (tell it where to push)
bb helm worktrees                 # every app's worktrees: your checkout, the shared work worktree and any lanes
bb helm worktrees --consolidate <app> --yes   # move an older app's per-agent worktrees onto the shared one
bb helm rename planner "Nova"     # any agent; names are unique in a run
bb helm retire <custom-agent> --yes
bb helm stop <agent>              # bottom-up, subtree by default
bb helm signoff <app>             # by default the Git agent then merges <app>-work into main and pushes both
bb helm ledger                    # every change with its receipts
bb helm complete --yes            # after every app is signed off
bb helm end --run <id> --yes      # end a run now, or discard a draft plan
bb helm limits --concurrency 24   # agents running at once in this run; also --budget N, --autonomy high|ask
```

A structured brief is read deterministically: `# Group` headings, then `- Name — tagline · iOS Android macOS Windows Web` lines (the dash may be `-`, `--`, `–` or `—` with spaces around it, and `|` works in place of `·`).

**Not just apps.** Helm decides what each project is from its line and staffs it to match:

| Kind | What you get | Squad (Full) |
|---|---|---|
| App | Native or cross-platform apps | UI, Core, a builder per platform, Security |
| Website | Full-stack web: frontend, backend, database, deployment | UI, Core (backend), Data, Web builder, Security |
| Game | Mobile, desktop or web games; Unreal, Unity or Godot | Core (gameplay), UI (HUD), Asset builder, platform builders |
| Automation | Bots, scheduled jobs, integrations, pipelines | Core, Security, Test, Docs |
| Review | An audit report of an existing project; source stays read-only | Code, UI, platform, Security and Test auditors |

It also decides each project's **needs** (database, accounts, payments, security, HIPAA, privacy law, realtime, AI, automation, art assets, multiplayer) and **tools** (Unreal, Unity, Godot, Blender, Docker, FFmpeg, and BB plugins such as browser-automation or automations). Needs add specialists: a Data builder for a database, Compliance for HIPAA or privacy law, Security for accounts, payments or health data even in a Lean squad, an Asset builder for art. Each agent's brief carries the rules for every need and says which tools are installed on this machine. Helm prints every decision with its reason before you start. Correct it on the line (`- Clinic — patient intake · Website · needs HIPAA, payments · tools Docker`, `· Game · tools Unreal`, `· Review`, `· needs none`) or in the wizard. Mid-run, the Orchestrator can change a profile and the squad follows. Payments stay in test mode, deployments stay local, and nothing acts on real accounts until you provide the credentials.

**Apps can live anywhere on your machine.** Add a folder to an app's line:
- `- Pebble — habit counter · iOS · ~/code/pebble` works in that folder.
- An **existing repository** (or a linked worktree) is adopted. When the app's wave is admitted, Helm creates one `<app>-work` branch at your HEAD (or continues it if it exists) and adds **no files and no commits**. Your checkout, uncommitted changes and other branches are never touched. Only the Git agent merges the work branch into main, when you sign the project off (or it only pushes, or only reports: your setting). Agents work in the app's work worktree, so they see **committed work only**: commit anything they should build on first (`bb helm plan` counts the uncommitted changes per folder). Checking folders never writes your index (`GIT_OPTIONAL_LOCKS=0`).

**Two branches per app (or as many as you allow), and one shared worktree on the app's own disk.** Every app has main and its work branch (`<app>-work`). Its worktrees are your checkout, one shared **work worktree** beside it at `<repository folder>/.helm-work/<repository>` on the work branch, and only the lanes the Git agent adds when a project needs parallel work (several UI designs at once). Each run has its own limits, set in the Worktrees view: **branches per project** (default 2; more lets the Git agent add lane branches `<app>-work--<lane>`) and **worktrees per project** (default 10). Settings hold the defaults. Agents never create a branch, a worktree or a clone, never merge into main and never push. The lead, the builders, the gates and the app's custom agents all work there, committing only their own files. Keep apps on an external disk (the apps root, or a folder per app) and nothing grows on your internal drive. Older runs gave each agent its own BB worktree on the internal drive; `bb helm worktrees --consolidate <app> --yes` moves such an app onto the shared worktree once that work is committed and merged (it refuses, changing nothing, until then).

**The Git agent** keeps that rule, and its instructions on git are binding on every agent. Helm checks every app's worktrees and branches every half hour and wakes it when one is over the limit, still uses one worktree per agent or has leftover agent branches, and when a disk runs low (under 15 GB or 10% free); it asks the lead to commit or merge, then consolidates, removes merged idle lanes and deletes merged agent branches (`git branch -d`, never `-D`). The **Worktrees** button on its card opens at once with what Helm last read (git is read again in the background when you open it and it is a few minutes old, every 30 minutes, or with **Check now**). Each app is one row: its number of branches and worktrees, its size (git storage included, which all branches share), the disk it is on (your external SSD by name, or This Mac) and **Show in Finder**. Click an app for each worktree (what it is doing: running, being edited, idle; its branch, agents, disk and size) and each branch. Each disk's free space is at the top, with this run's limits. The **GitHub** tab shows what each app's remote has and what it does not, without downloading anything: Helm asks GitHub only for its branch names and the commit each points at (`git ls-remote`, with the login git already has), then compares: branches the same on both, commits not on GitHub yet, uncommitted files, branches newer or only on GitHub, and an **Open on GitHub** button. It reads GitHub only when you open the tab (and it is 15 minutes old) or press **Check GitHub**; `bb helm worktrees --github` prints the same. Your own branches are left alone. Not everything goes to main: the Git agent merges the work branch into main when you sign the project off, or when the Orchestrator or the app's lead judges it ready and asks. On sign-off it merges into main and pushes both (or only pushes the work branch, or only reports: your setting). Tell it in its thread to send work anywhere else: GitHub or another remote, a bare repository or a folder on your Mac or an external disk. It never force-pushes, rewrites history or handles credentials; a push that needs a login comes back to you as a command to run.
- A missing or empty folder becomes a new repository.
- `· reads /path/a, ~/path/b` lists folders the app's agents may read but never change.
- `--root <folder>` moves this run's folder (its new repositories and Helm's `_studio` notes), for example onto another disk. The default is `~/Projects/helm/<run>`.
- `bb helm plan` prints what will happen to every folder, and refuses unsafe ones: system folders, a folder inside another repository, a non-git folder with files. Free text is read by one short hidden planner thread on the model you choose (`--planner-model`, default: the `code` slot at medium); it works in a small `_planner` scratch repository under the apps root (the BB project "Helm · planner"), never in your apps. `bb helm <command> --help` covers every option. Every command accepts `--json`.

**Several sessions at once.** Every run you open gets a tab under the top bar. Each tab shows whether the run is live and how many items need you, and runs keep going while you look at another tab. **+ New session** opens a fresh start page without touching your runs. From there you can write a brief, plan with an agent, or reopen any earlier run. Closing a tab only hides it; to end a run use the run menu or `bb helm end`.

**Hand it over: the team runs it.** Runs default to **autonomy high**, which is hands-off. You say what you want, where, and how good, and the team builds it like a company:
- The Orchestrator sets the strategy and delegates. Managers and leads decide inside their groups and apps, and agents' questions go up the chain.
- Waves, plan changes and product questions the brief does not settle are decided on the record.
- What used to wait in **Needs you** becomes a card for whoever on the team is closest to it. The **Fixer** takes failed, stuck or modelless agents after Helm's two automatic retries. A manager (or the Orchestrator) signs off its apps (the Git agent then merges and pushes as your setting says) and settles gate disputes. A lead answers its squad's permission prompts. A card left for two hours moves up a level, and reaches you only after the Orchestrator.
- **Installs need nobody's approval.** Agents ask the Git agent (`helm_install`). It installs into the project, never with a password, and keeps a ledger of what, where, which command, why and for whom (`bb helm installs`).
- You are asked only for a key, a login or an account, real spending (the budget cap included), private data, and to complete the run.
- Needs you shows the team's cards folded under **Your team is deciding**, and you can still act on any of them (`bb helm needs --all`).

Switch a run to **ask** (every question, wave, plan change and failure comes to you) in the capacity chip, the wizard's Approve step, or with `bb helm limits --autonomy ask`.

**Steering.** Every agent's inspector ends in a one-line **Steer…** box. Type an instruction and press Enter. It interrupts the agent's current turn, or tick *after its turn* to wait. You can also apply it to the agent's reports or its whole team. The line under the box shows who else hears about it: its parent gets it in full, and the levels above see one FYI line.

Supervisors steer too. The Orchestrator, Managers and Leads can instruct, pause, resume or reprioritize anyone below them with `helm_direct`:
- everyone up the chain sees it, and the graph pulses along that path;
- the ledger shows who steered whom, and can be filtered to steers from supervisors;
- your own directives always win: supervisors cannot resume what you paused, override a priority you set, or steer the review gates.

FYI lines reach agents with their next Helm tool result rather than as separate messages, so being kept informed costs no extra turns.
## Words Helm uses

- **Run**: one portfolio being built, with its own agents, limits and budget. **Plan**: a run that has not started.
- **Wave**: the apps admitted together; later apps wait for capacity under the run's concurrency limit.
- **Shape**: how big an app's squad is. **Solo**: the lead builds it alone. **Lean**: a few builders. **Full**: the kind's whole squad.
- **Slot**: a role's model (`orchestrator`, `ui`, `code`, `review` …). The **Model Studio** is where you pick them; a **preset** fills them all.
- **Gate**: an app's Reviewer or Slop Hunter. Both must pass the same commit before the app is **Ready** for your sign-off.
- **Directive** (`D-…`): a change you or a supervisor make to an agent. Each agent it reaches leaves a **receipt** (queued, delivered, acknowledged) in the **Ledger**.
- **Needs you** (`N-…`): what is waiting on you. With autonomy high that is only keys and accounts, spending, private data and completing the run; the rest are **cards** the team decides (`helm_resolve`), shown folded beneath.
- **Fixer**: the run's agent for failed and stuck agents.
- **Install ledger** (`I-…`): every install the Git agent made for an agent, with the command and the reason.
- **Studio**: Helm's notes folder for a run (`<run folder>/_studio`): the agents' briefs and `PORTFOLIO.md`.
- **Observatory**: the graph button that shows BB threads outside the run, read-only.
- **Unit** (u): Helm's cost estimate. 1 u is about 133k tokens on a weight-1.0 model such as Sonnet.

## Settings

Settings live under `bb plugin config helm` (and BB → Settings → Helm, where each one is described):
- apps root (default `~/Projects/helm`);
- concurrency and total-agent caps;
- spans, fix rounds and stall minutes;
- budget cap, in relative units (1 u ≈ 133k tokens on a weight-1.0 model);
- autonomy (`high`: hands-off, the team decides and you hear only about keys and accounts, spending and private data; `ask`: questions, waves, plan changes and failures come to you);
- wave approval (`ask` / `auto`), which applies only when autonomy is `ask`;
- permission mode per tier, and who approves agents' permission prompts (their supervisor, or you);
- personal names for the Planner, the Orchestrator, the Git agent and the Fixer (none by default: they are called by their roles);
- what the Git agent does when you sign a project off (merge and push, push, or report only), and the most branches (default 2) and worktrees (default 10) a project may have;
- the default Planner, Orchestrator, Git agent and Fixer models and their reasoning: dropdowns that list the models of the providers you have connected, so nothing is typed (also in the panel: **Models → Default models**, or `bb helm defaults`). A newly connected provider appears after Helm reloads;
- showing leads in the sidebar;
- zero-tolerance slop categories (default S1 placeholders, S2 fake data, S3 invented dependencies, S5 debug leftovers, S6 secrets);
- pricing weights, keyed by model id (`{"claude-haiku-5-5": 0.25}`).

## Development

```
npm test           # unit, simulator (20 apps / 169 agents, failures, restarts) and plugin-host tests
npm run typecheck
bb plugin build
```

Skills are loaded live from `skills/` when the plugin is installed from a path. A save reaches running agents at once, and invalid frontmatter breaks them (DECISIONS 26). `npm test` checks every skill's frontmatter.

Cost rule for development:
- Never start a real run bigger than one lean single-platform app (7 agents, counting the Planner and the Git agent).
- Use the cheapest model (`claude-haiku-5-5` at `low`) for every real test.
- Big scenarios run only against the simulator (`src/server/bb/sim.ts`).

## Privacy and scope

- The plugin server talks to BB only through `bb.sdk`. It sends no telemetry and never stores credentials. The only network contact Helm makes itself is a read-only `git ls-remote` to your apps' own remotes when you open the GitHub tab (or run `bb helm worktrees --github`), using the login in your global git config.
- Git and file work runs in Helm's host entry (`host.ts`), with no shell. A repository's own git config cannot make Helm's git run a program: Helm's own git commands skip the repository's hooks (your agents' commits still run them), switch off filter drivers it defines except the stock Git LFS ones (your global ones, such as LFS, still run), never sign Helm's own commits, and read remotes from outside the repository, so a repository-level credential helper is not used. In a repository that uses git-crypt or another filter of its own, worktrees Helm creates hold the committed form of those files until an agent checks them out again.
- Helm manages only the threads it spawns. Everything else is read-only (the Observatory).
- Repositories and your own branches are never deleted. In an existing repository, Helm adds only its work branch and its work worktree. The Git agent deletes only Helm's own merged agent and lane branches (`git branch -d`, never `-D`) and removes idle lanes it made; the branches a live run records (each app's Helm branch, and the work branch of every run sharing the repository) are kept. Consolidating an app removes its agents' older per-agent worktrees, only after checking they hold no uncommitted or unmerged work.

## When something goes wrong

Run `bb helm errors`. Helm records every failure it sees in its own database:
- server errors and warnings;
- requests BB or Helm refused;
- agent tool calls it refused;
- crashes or rejected requests in the panel.

It records what failed and where, never the contents of your brief or messages. `bb helm doctor` includes the count for the last 24 hours. The panel checks requests before sending them, so a problem such as an over-long brief says which field and by how much.

## License

MIT. See [LICENSE](LICENSE). Some agent skills adapt open-source guidance (Uizze and Impeccable, platform-design-skills, no-ai-slop, code-review-excellence); their licences and what Helm changed are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
