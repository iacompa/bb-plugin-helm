# Helm

A BB plugin that runs a portfolio of app builds as a supervised hierarchy of agents:

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

Nothing spawns until you start the plan. Or use the terminal:

```
bb helm plan --brief-file brief.md --preset "Cheap dev run"   # nothing spawns; prints the shape, forecast, problems
bb helm start <runId> --dry-run                               # writes the Studio and briefs, spawns nothing
bb helm start <runId> --yes
bb helm status
bb helm needs                     # approvals, questions, failures, sign-offs
bb helm tell <agent> --message-file note.md
bb helm model <agent> --model claude-sonnet-5-5 --provider claude-code --reasoning medium
bb helm stop <agent>              # bottom-up, subtree by default
bb helm signoff <app>
bb helm ledger                    # every change with its receipts
bb helm complete --yes            # after every app is signed off
```

A structured brief is read deterministically: `# Group` headings, then `- Name — tagline · iOS Android macOS Windows` lines.

**Apps can live anywhere on your machine.** Add a folder to an app's line:
- `- Tide — breathing app · iOS · /Volumes/Work/apps/tide` works in that folder.
- An **existing repository** (or a linked worktree) is adopted. Helm creates one `helm/<run>/<app>` branch at your HEAD and adds **no files and no commits**. Your checkout, uncommitted changes and branches are never touched, and Helm never merges. You merge the signed-off branch yourself.
- A missing or empty folder becomes a new repository.
- `· reads /path/a, ~/path/b` lists folders the app's agents may read but never change.
- `--root <folder>` moves this run's new repositories, for example onto another disk.
- `bb helm plan` prints what will happen to every folder, and refuses unsafe ones: system folders, a folder inside another repository, a non-git folder with files. Free text is read by one short hidden planner thread on the model you choose (`--planner-model`, default: the `code` slot at medium). `bb helm <command> --help` covers every option. Every command accepts `--json`.

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

## License

MIT. See [LICENSE](LICENSE).
