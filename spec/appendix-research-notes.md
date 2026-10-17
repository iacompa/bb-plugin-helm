# Appendix C — Where the design comes from

Context only; nothing here is required reading to build Helm. Each source below was checked to resolve at the time of writing (HTTP 200). The summaries are short paraphrases of the ideas Helm took, not quotations; read the originals before relying on a detail.

## Multi-agent design

- **Anthropic — "How we built our multi-agent research system"** — https://www.anthropic.com/engineering/multi-agent-research-system
  An orchestrator that plans and delegates to parallel workers, with detailed task descriptions (objective, output format, tools, boundaries) so workers do not duplicate each other, effort-scaling guidance written into the prompts, and the observation that multi-agent systems consume many times the tokens of a single chat. **Helm took:** the orchestrator–worker shape; precise builder briefs (`briefFor`); lazy spawning and visible cost; the honesty warning about token use.

- **Anthropic — "Building effective agents"** — https://www.anthropic.com/research/building-effective-agents
  A catalogue of simple composable patterns, including orchestrator–workers and evaluator–optimizer loops, and the advice to add complexity only when it earns its keep. **Helm took:** the Reviewer/fix loop as an evaluator–optimizer; the collapse rules (use fewer agents when the job is small).

- **Cognition — "Don't Build Multi-Agents"** — https://cognition.ai/blog/dont-build-multi-agents
  Argues that parallel agents make conflicting implicit decisions unless context is shared, and that long-running work needs a single thread of decisions. **Helm took:** parallelism *across* apps (independent) and disjoint write scopes *within* an app; one writer of decisions (the lead); a versioned CONTRACT; `DECISIONS.md`; context kept small through reports and files.

- **"Why Do Multi-Agent LLM Systems Fail?" (MAST taxonomy)** — https://arxiv.org/abs/2503.13657
  A study classifying multi-agent failures into specification problems, inter-agent misalignment, and weak verification or termination. **Helm took:** explicit specs per node, directive propagation so agents stay aligned, evidence-required verification gates, bounded fix rounds and explicit termination (sign-off).

## Tools in the same space (parallel coding agents with a human in the loop)

- **Vibe Kanban** — https://github.com/BloopAI/vibe-kanban — a kanban board for coding-agent tasks in isolated workspaces.
- **Conductor** — https://conductor.build — a macOS app for running several coding agents side by side in separate worktrees.
- **Claude Squad** — https://github.com/smtg-ai/claude-squad — manages multiple agent sessions in separate workspaces from the terminal.

**What Helm adds to these:** a real hierarchy (Orchestrator → Managers → Leads → Specialists), change propagation to the whole chain of command with receipts, a portfolio-level view for 10–20 apps, models asked every run, and independent Review and Slop gates with verified evidence.

## Reading for the gates

Code-review and "AI-generated code" checklists in the wild converge on the same short list: invented APIs and dependencies, placeholder and fake data, hollow tests, swallowed errors, secrets, and claims the code does not back. `appendix-slop-policy.md` turns that list into categories S1–S12 with a scanner and an evidence-checked verdict.
