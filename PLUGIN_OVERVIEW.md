## What you get

- **A plan before anything spawns.** Write a brief in your own words, or plan it in a conversation with the planner agent. Helm works out the team: an Orchestrator, Managers once you pass 4 apps, one App Lead per app with a squad sized to the job (solo, lean or full), and two gates per app. A plan shows a **Start run** bar that checks your models and folders first and says exactly what to fix.
- **Your models, chosen per role.** The Model Studio reads the live model list from the providers you already have in BB. Pick a model for every role, or start from a preset, and see a cost estimate in relative units.
- **A live graph you can steer.** Select any agent to tell it something, change its model, pause, resume, stop or reprioritize it. A one-line Steer box sits under every agent. Each change reaches the agent's chain of command, and the Ledger keeps a receipt per recipient.
- **Supervisors who steer too.** The Orchestrator, Managers and Leads can instruct the agents below them. Everyone up the chain sees it, and your own directives always win.
- **One inbox.** Wave approvals, questions, failures, stalls, budget and sign-off all land in **Needs you**.
- **Sign-off on evidence.** An app moves forward only on verified commits and checks that exit 0. An independent Reviewer and a Slop Hunter must both pass the exact commit you sign off. A deterministic scanner flags placeholders, fake data, invented dependencies, debug leftovers and secrets.
- **Several runs at once.** Each run you open gets a session tab. The panel remembers your draft, your view and the planning conversation when you leave and come back.

## How it works

- Apps live wherever you say. A new app gets a new repository under a run folder you choose. An existing repository is adopted on one new `helm/…` branch at your last commit. Helm adds no commits to your branches, never touches your checkout, and never merges.
- Agents work in BB worktrees, so they see committed work only.
- Waves keep concurrency under your limit. After the first wave, Helm asks before admitting more apps, or runs them automatically if you choose.
- Helm keeps its structure, directives, receipts and evidence in its own database on your BB server. It reacts to BB's events instead of polling.
- It manages only the threads it spawns, makes no network calls of its own, and sends no telemetry.

## From a terminal

`bb helm` gives the same controls: `plan`, `start`, `status`, `tell`, `model`, `stop`, `needs`, `signoff`, `ledger`, `end`, `errors` and `doctor`. The `helm-planner` skill turns an idea into a ready-to-start plan from any thread. The `helm` skill teaches other threads to drive a run.

## Costs

Every agent is its own thread on your providers, so a run uses many times the tokens of a single chat. Set a budget cap when you approve a run: Helm stops spawning new agents when the cap is reached.
