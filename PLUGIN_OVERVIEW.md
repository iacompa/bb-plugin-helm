Run a whole portfolio of app builds as a supervised hierarchy of agents, and sign off only on evidence.

## What you get

- **A plan from a plain-language brief.** Helm reads your list of apps (or has a short planner thread read free text) and computes the org: an Orchestrator, Managers once you have more than 4 apps, one App Lead per app, a squad of specialists, and two gates per app (a Reviewer and a Slop Hunter). Nothing spawns until you approve.
- **Models chosen every run.** The Model Studio shows your live provider catalog with NEW tags, slots per role, presets and a cost forecast in relative units.
- **Steer any agent.** Tell, change the model, pause, stop, retry or set a priority on any agent. Every change reaches that agent's whole chain of command, and the Ledger shows a receipt per recipient.
- **One inbox.** Approvals, questions, failures, stalls, budget and sign-off all land in **Needs you**.
- **Evidence, not assertions.** An app moves forward only on verified commits, files and checks that exit 0 on the integration commit. Both gates must pass the exact commit you sign off. A deterministic scanner catches placeholders, fake data, invented dependencies, debug leftovers and secrets.
- **`bb helm`.** The same controls from a terminal: plan, start, tell, model, stop, needs, approve, signoff, ledger, doctor and more.

## How it works

- Each app gets its own git repository and BB project under `~/Projects/helm/<run>/`. Agents work in BB worktrees.
- Helm keeps its structure, directives, receipts and evidence in its own database on your BB server, and reacts to BB's events instead of polling.
- It manages only the threads it spawns and is read-only for everything else.
- The plugin makes no network calls of its own and sends no telemetry.

## For agents

Every Helm agent gets a role skill and a small set of `helm_*` tools for its tier:
- reporting with evidence;
- acknowledging changes;
- asking the human;
- the lead's stage, squad and contract tools;
- the gates' verdict and scan tools.

The `helm` skill teaches any other thread to use `bb helm`. The `helm-planner` skill (`/helm-planner`) turns an idea into a ready-to-start run: it interviews you, then picks shapes and models per role, writes the brief and plans it.
