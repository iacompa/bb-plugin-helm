# Helm

A BB plugin that runs a portfolio of software projects (apps, websites, games, automation, and reviews of existing projects) as a supervised hierarchy of agents:

```
Orchestrator → Managers (only when apps > 4) → App Leads → Specialists + Gates (Reviewer, Slop Hunter)
```

You get a plan from a plain-language brief, models chosen every run, a graph and board of every agent, directives that reach the whole chain of command with receipts, one Needs-you inbox, and Ready gated on verified evidence.

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

## Use it

In BB, open **Helm** in the sidebar and choose **New run**. In step 1, choose **Plan with an agent** to plan in a conversation right there. Or type `/helm-planner` in any BB thread. Either way, the planner:
- asks what you want built and where each app lives;
- goes role by role (Orchestrator, Managers, Leads, UI, Code, platform, Security, Test, Reviewer, Slop Hunter, Research, Docs), listing the models **your** setup has and recommending one for each;
- writes the brief and runs `bb helm plan`.

Nothing spawns until you start the plan. When the planner has made it, press **Open plan to start it**. A plan that has not started shows a **Start run** bar at the top: it checks your models and folders first, says what will happen (wave 1 starts right away; Helm asks before later waves), and shows exactly what to fix if it can't start yet. **Details** in that bar offers a dry run and **Discard plan**.

**Helm remembers where you were.** The New run wizard keeps its draft: brief, portfolio, models, and the planning conversation. Your view, selection and inspector tab are kept too. Leave the panel, reload, or open Helm in another window, and you come back to the same place. **Close** keeps the draft (New run reopens it). **Discard** clears it, and starting a run clears it.

Or use the terminal:

```
bb helm plan --brief-file brief.md --preset "Cheap dev run"   # nothing spawns; prints the shape, forecast, problems
bb helm start <runId> --dry-run                               # writes the Studio and briefs, spawns nothing
bb helm start <runId> --yes
bb helm status
bb helm needs                     # approvals, questions, failures, sign-offs
bb helm tell <agent> --message-file note.md
bb helm model <agent> --model claude-sonnet-5-5 --provider claude-code --reasoning medium
bb helm slots --replace codex --with claude-code/claude-sonnet-5-5:high   # a provider ran out: move every role off it now
bb helm stop <agent>              # bottom-up, subtree by default
bb helm signoff <app>
bb helm ledger                    # every change with its receipts
bb helm complete --yes            # after every app is signed off
bb helm end --run <id> --yes      # end a run now, or discard a draft plan
bb helm limits --concurrency 24   # agents running at once in this run; also --budget N, --autonomy high|ask
```

A structured brief is read deterministically: `# Group` headings, then `- Name — tagline · iOS Android macOS Windows Web` lines.

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
- An **existing repository** (or a linked worktree) is adopted. When the app's wave is admitted, Helm creates one `helm/<run>/<app>` branch at your HEAD and adds **no files and no commits**. Your checkout, uncommitted changes and branches are never touched, and Helm never merges. You merge the signed-off branch yourself. Agents work in their own worktrees, so they see **committed work only**: commit anything they should build on first (`bb helm plan` counts the uncommitted changes per folder). Checking folders never writes your index (`GIT_OPTIONAL_LOCKS=0`).
- A missing or empty folder becomes a new repository.
- `· reads /path/a, ~/path/b` lists folders the app's agents may read but never change.
- `--root <folder>` moves this run's folder (its new repositories and Helm's `_studio` notes), for example onto another disk. The default is `~/Projects/helm/<run>`.
- `bb helm plan` prints what will happen to every folder, and refuses unsafe ones: system folders, a folder inside another repository, a non-git folder with files. Free text is read by one short hidden planner thread on the model you choose (`--planner-model`, default: the `code` slot at medium). `bb helm <command> --help` covers every option. Every command accepts `--json`.

**Several sessions at once.** Every run you open gets a tab under the top bar. Each tab shows whether the run is live and how many items need you, and runs keep going while you look at another tab. **+ New session** opens a fresh start page without touching your runs. From there you can write a brief, plan with an agent, or reopen any earlier run. Closing a tab only hides it; to end a run use the run menu or `bb helm end`.

**The Orchestrator runs it.** Runs default to **autonomy high**. Agents' questions go up the chain, and the Orchestrator decides. Waves and plan changes go ahead on the record. You are asked only about four things: credentials or API keys, spending real money, anything that could expose private data, and access only you can grant. Sign-off, real failures and the budget cap still come to you. Switch a run to **ask** (every question, wave and plan change) in the capacity chip, the wizard's Approve step, or with `bb helm limits --autonomy ask`.

**Steering.** Every agent's inspector ends in a one-line **Steer…** box. Type an instruction and press Enter. It interrupts the agent's current turn, or tick *after its turn* to wait. You can also apply it to the agent's reports or its whole team. The line under the box shows who else hears about it: its parent gets it in full, and the levels above see one FYI line.

Supervisors steer too. The Orchestrator, Managers and Leads can instruct, pause, resume or reprioritize anyone below them with `helm_direct`:
- everyone up the chain sees it, and the graph pulses along that path;
- the ledger shows who steered whom, and can be filtered to steers from supervisors;
- your own directives always win: supervisors cannot resume what you paused, override a priority you set, or steer the review gates.

FYI lines reach agents with their next Helm tool result rather than as separate messages, so being kept informed costs no extra turns.
## Settings

Settings live under `bb plugin config helm`:
- apps root (default `~/Projects/helm`);
- concurrency and total-agent caps;
- spans, fix rounds and stall minutes;
- budget cap, in relative units;
- wave approval (`ask` / `auto`);
- permission mode per tier;
- showing leads in the sidebar;
- zero-tolerance slop categories;
- git remotes (off);
- pricing weights.

## Development

```
npm test           # unit, simulator (20 apps / 169 agents, failures, restarts) and plugin-host tests
npm run typecheck
bb plugin build
```

Skills are loaded live from `skills/` when the plugin is installed from a path. A save reaches running agents at once, and invalid frontmatter breaks them (DECISIONS 26). `npm test` checks every skill's frontmatter.

Cost rule for development:
- Never start a real run with more than 6 agents.
- Use the cheapest model (`claude-haiku-5-5` at `low`) for every real test.
- Big scenarios run only against the simulator (`src/server/bb/sim.ts`).

## Privacy and scope

- The plugin server talks to BB only through `bb.sdk`. It makes no network calls of its own, sends no telemetry, and never stores credentials.
- Git and file work runs in Helm's host entry (`host.ts`), with no shell.
- Helm manages only the threads it spawns. Everything else is read-only (the Observatory).
- Repositories, branches and worktrees are never deleted. In an existing repository, Helm adds only its own branch.

## When something goes wrong

Run `bb helm errors`. Helm records every failure it sees in its own database:
- server errors and warnings;
- requests BB or Helm refused;
- agent tool calls it refused;
- crashes or rejected requests in the panel.

It records what failed and where, never the contents of your brief or messages. `bb helm doctor` includes the count for the last 24 hours. The panel checks requests before sending them, so a problem such as an over-long brief says which field and by how much.

## License

MIT. See [LICENSE](LICENSE).
