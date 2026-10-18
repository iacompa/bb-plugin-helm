# Helm — a BB plugin for building many apps at once

> This folder is the original design brief Helm was built from, kept for reference. The plugin has moved on since; [README.md](../README.md) and [docs/](../docs/) describe what it does today.

Helm is one plugin that replaces `agent-graph`, `chief`, `command-center`, `crew` and `visual-workflows`. You describe what you want built; an **Orchestrator** proposes a plan; **Managers** (only when there are more than 4 apps) oversee **App Leads**, one per app; each lead runs a small squad (UI, core logic, one builder per platform, security) and two independent gates — a **Reviewer** and an **AI-slop Hunter** — that must pass before you sign an app off. You can click any agent on the graph, read its chat, see its model and what it is doing, and change it; **everyone above it in the chain is told**.

## What is in this folder

| File | What it is |
|---|---|
| [`ui-prototype.html`](ui-prototype.html) | A clickable UI prototype with sample data (20 apps, 5 managers, 169 agents). Open it in a browser. |
| [`PROMPT.md`](PROMPT.md) | The build prompt you give to BB. It is the complete spec: hierarchy, directives, Model Studio, gates, engine, UI contract, tests, phases, acceptance checklist. |
| [`appendix-roles-and-squads.md`](appendix-roles-and-squads.md) | Role briefs, document templates, squad shapes, wave algorithm, draft skills. |
| [`appendix-slop-policy.md`](appendix-slop-policy.md) | What "no AI slop" means, how it is detected, what counts as proof, test fixtures. |
| [`appendix-research-notes.md`](appendix-research-notes.md) | Where the design ideas come from. Optional. |

## Look at the prototype first (5 minutes)

Open `ui-prototype.html`. Everything in it is sample data; nothing is connected to BB.

1. **Graph** — click any node. The right-hand panel shows its role, model, what it is talking about, its chat, and who gets told about changes to it.
2. In the panel open **Direct**, pick *Message* or *Model change*, choose who it applies to, and press **Send directive**. Watch the pulse travel up to the lead, manager and Orchestrator, and the receipts fill in.
3. **Board** — apps by stage (with a lane per manager) or agent tasks by status. Try dragging a card somewhere it shouldn't go.
4. **Ledger** — every change you made, with the exact text each agent received. **Needs you** — approvals, questions, failures, sign-offs.
5. **Models** (top bar) and **New run** — the wizard asks which models to use every time. A few are pre-filled; the rest are left for you to choose.

## Give it to BB

The simplest way: create a folder for the plugin, copy this folder into it as `spec/`, add it as a project in BB, and start a thread with the prompt *"Read spec/PROMPT.md completely and follow it. Start with Phase 0."*

Or from a terminal (replace `<project-id>` with the id printed by the second command):

```bash
mkdir -p ~/Projects/helm-plugin && cp -R helm-spec ~/Projects/helm-plugin/spec && cd ~/Projects/helm-plugin && git init
```

```bash
bb project create --name "Helm plugin" --root ~/Projects/helm-plugin --json
```

```bash
bb thread spawn --project <project-id> --title "Build Helm" --provider claude-code --model claude-sonnet-5-5 --reasoning-level high --prompt-file spec/PROMPT.md
```

(Use whichever model and reasoning level you prefer for the build; the UI phases are a good place to switch the thread to the model you prefer for UI work.)

## How the build will go

The builder works in seven phases (0–6) and reports at the end of each. **Phase 0 comes first and tests the assumptions this spec could not prove** — for example whether hidden threads can raise approval prompts that Helm can answer. Where reality differs, the builder uses the stated fallback and says so in `docs/VERIFY.md`.

While it develops, the builder is told to keep every real test run to **6 agents or fewer on the cheapest model**, and to run the 20-app and failure scenarios only against a simulator. A full real run (up to 169 agents) happens only when you start one from the wizard.

## Not yet verified (be sceptical of these until Phase 0 reports)

These are the platform behaviours the design leans on but that had not been exercised on BB when this brief was written: what a parent receives when a child finishes (V2), approval prompts from hidden threads (V4), `ThreadChat` on hidden threads (V5), permission ceilings for grandchildren (V6), re-parenting live threads (V10), creating projects from a plugin (V16), detecting messages you type straight into an agent's thread (V18), cascade archive (V20), and canvas performance at 170+ nodes (V15). The full table with fallbacks is in `PROMPT.md` §2.3.

Also: **Windows and Android builds cannot be verified on a machine without their toolchains** (for example when only a Mac is connected). Those apps can reach *Ready*, but the sign-off card will say so and your sign-off is your acceptance of that.

## Defaults in the brief (change any of them in `PROMPT.md` §17.2)

One repo and BB project per app · only the Orchestrator is visible in BB's sidebar (everything else is reachable from Helm) · ask before each wave · every app gets the Full squad · two fix rounds before you are asked · agents run at `auto` permission · no git remotes are created.
