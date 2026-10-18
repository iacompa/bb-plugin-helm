## What you get

- **A plan before the run starts.** Write a brief in your own words, or plan it in a conversation with the planner agent. Helm works out the team: an Orchestrator, Managers once you pass 4 apps, one App Lead per app with a squad sized to the job (solo, lean or full), and two gates per app. A plan shows a **Start run** bar that checks your models and folders first and says exactly what to fix.
- **Your models, chosen per role.** The Model Studio reads the live model list from the providers you already have in BB. Pick a model for every role, or start from a preset, and see a cost estimate in relative units (1 u ≈ 133k Sonnet-class tokens).
- **A live graph you can steer.** Select any agent to tell it something, change its model, pause, resume, stop or reprioritize it. A one-line Steer box sits under every agent. Each change reaches the agent's chain of command, and the Ledger keeps a receipt per recipient.
- **Supervisors who steer too.** The Orchestrator, Managers and Leads can instruct the agents below them. Everyone up the chain sees it, and your own directives always win.
- **One inbox.** Wave approvals, questions, failures, stalls, budget and sign-off all land in **Needs you**.
- **Sign-off on evidence.** An app moves forward only on verified commits and checks that exit 0. An independent Reviewer and a Slop Hunter must both pass the exact commit you sign off. A deterministic scanner flags placeholders, fake data, invented dependencies, debug leftovers and secrets.
- **Several runs at once.** Each run you open gets a session tab. The panel remembers your draft, your view and the planning conversation when you leave and come back.

## How it works

- Apps live wherever you say. A new app gets a new repository under a run folder you choose. An existing repository gets one `<app>-work` branch at your last commit and one shared work worktree beside it. Helm adds no commits to your branches and never touches your checkout or uncommitted changes.
- Agents commit on the work branch, so they see committed work only. When you sign a project off, the Git agent merges the work branch into main and pushes both by default; a setting makes it push only the work branch, or only report.
- Waves keep concurrency under your limit. With autonomy high (the default) the Orchestrator admits later waves itself; set autonomy to ask and Helm asks before each one.
- Helm keeps its structure, directives, receipts and evidence in its own database on your BB server. It reacts to BB's events instead of polling.
- It manages only the threads it spawns and sends no telemetry. Its only network contact is a read-only `git ls-remote` to your own remotes, when you open the GitHub tab.

## From a terminal

`bb helm` gives the same controls: `plan`, `start`, `status`, `nodes`, `tell`, `model`, `stop`, `needs`, `resolve`, `signoff`, `ledger`, `end`, `errors` and `doctor`. The `helm-planner` skill turns an idea into a ready-to-start plan from any thread. The `helm` skill teaches other threads to drive a run.

## Requirements

git on the BB host and at least one AI provider connected in BB. To verify builds on this machine: Xcode for iOS and macOS, the Android SDK and Gradle for Android, .NET for Windows (otherwise those builds are marked unverified). `bb helm doctor` checks them.

## Costs

Every agent is its own thread on your providers, so a run uses many times the tokens of a single chat. Even a one-app run starts several agents (Orchestrator, Planner, Git agent, its squad and two gates; the Fixer starts only when an agent fails). Costs are estimated in relative units: 1 u is about 133k tokens on a Sonnet-class model. Set a budget cap when you approve a run: Helm stops spawning new agents when the cap is reached and asks you.
