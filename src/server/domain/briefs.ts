// briefFor(node) — the first prompt every agent gets (appendix A7) — plus the
// short per-session instructions string, standing-policy blocks and the
// PORTFOLIO.md world block. Pure string building; all human free text and
// metadata is escaped before interpolation.
import type { NodeInfo, PolicyInfo, ProjectKind, ProjectNeed, Role } from "../../shared/types.ts";
import { KIND_LABEL, NEED_LABEL } from "../../shared/types.ts";
import { COMMON_RULES, ROLES, roleLabel } from "./roles.ts";
import { KIND_INFO, NEED_INFO, PLUGIN_INFO, TOOL_INFO, toolLabel } from "./profile.ts";

/** Neutralize text that came from a human or metadata so it reads as data. */
export function escapeForPrompt(s: string, max = 4000): string {
  const t = s.replace(/\r/g, "").replace(/```/g, "ʼʼʼ").replace(/<\/?(system|instructions?)>/gi, "").slice(0, max);
  return t;
}

export function quoteData(s: string, max = 400): string {
  return JSON.stringify(escapeForPrompt(s, max));
}

export const POLICY_BLOCK_LIMIT = 1200;

export function policyBlock(policies: Array<Pick<PolicyInfo, "id" | "text">>): string {
  if (!policies.length) return "";
  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const p of policies) {
    const line = `- ${p.id}: ${escapeForPrompt(p.text, 300)}`;
    if (used + line.length + 1 > POLICY_BLOCK_LIMIT - 60) {
      omitted++;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (omitted) lines.push(`- …and ${omitted} more — see helm_context.`);
  return lines.join("\n");
}

export interface BriefContext {
  runName: string;
  appName: string | null;
  tagline: string | null;
  parentLabel: string;
  leadLabel: string | null;
  peers: string[];
  children: string[];
  contractVersion: number;
  policies: Array<Pick<PolicyInfo, "id" | "text">>;
  changesBeforeStart: Array<{ id: string; text: string }>;
  branch: string | null;
  baseBranch: string | null;
  repoPath: string | null;
  extra: string[];
  integrationCommit?: string | null;
  scannerFindings?: string | null;
  handover?: string | null;
  /** Apps outside Helm's apps root: an adopted repository and/or read-only reference folders. */
  location?: { adopted: boolean; userBranch: string | null; helmBranch: string | null; reads: string[] } | null;
  /** What the project is and needs, and which tools are installed (true / false / null = not checked). */
  project?: ProjectBrief | null;
  /** How the agent is called ("Amer · Planner", "Ledger · GitHub Sync"); defaults to its role. */
  displayName?: string | null;
  /** A custom agent's mission and who designed it. */
  mission?: { text: string; by: string } | null;
}

export interface ProjectBrief {
  kind: ProjectKind;
  needs: ProjectNeed[];
  tools: string[];
  installed: Record<string, boolean | null>;
  /** Other enabled BB plugins (shown to leads), id → one line. */
  plugins?: Array<{ id: string; line: string }>;
}

/** "## The project": the kind and what it delivers, each need with its rules, each tool with how to use it and whether it is installed. */
export function projectSection(role: Role, alsoLead: boolean, p: ProjectBrief): string {
  const leads = role === "lead" || alsoLead;
  const L = [`## The project`, `${KIND_LABEL[p.kind]}: ${KIND_INFO[p.kind].desc} Deliverable: ${KIND_INFO[p.kind].deliverable}.`];
  if (p.kind === "review") {
    if (leads) L.push("This is a review: the source is read-only for everyone. Commit ACCEPTANCE.md as the review plan (what is audited at which commit, by whom, and what counts as evidence), have each auditor write its findings under `reports/<role>/`, then compile REVIEW.md. Failing checks are findings, not blockers. Follow helm-audit.");
    else if (ROLES[role].tier === "specialist") L.push("This is a review: the source is read-only. Audit your area against your craft skill's standard and write findings with evidence under your reports folder. Follow helm-audit.");
    else L.push("This is a review: judge REVIEW.md. Every finding must be backed by evidence at the audited commit; vague or unverifiable findings fail.");
  }
  if (p.needs.length) {
    L.push("", "Needs (Helm decided these from the brief; if one is wrong or missing, tell your lead, who can ask the Orchestrator to change it):");
    for (const n of p.needs) L.push(`- ${NEED_LABEL[n]}: ${NEED_INFO[n]}`);
  }
  if (p.tools.length) {
    L.push("", "Tools:");
    for (const t of p.tools) {
      const plugin = t.startsWith("plugin:") ? t.slice(7) : null;
      const how = plugin ? PLUGIN_INFO[plugin]?.use ?? "Use it through its CLI (see `bb guide`) or its agent tools." : TOOL_INFO[t]?.use ?? "Use it from the terminal if it is installed.";
      const have = p.installed[t];
      const state = have === true ? "installed" : have === false ? (plugin ? "not enabled in BB — work without it and say so in your report" : "not found on this machine — do not rely on it; tell your lead, who can ask the human, and meanwhile work without it") : "not checked";
      L.push(`- ${toolLabel(t)} (${state}). ${how}`);
    }
  }
  if (leads && p.plugins?.length) L.push("", "Other BB plugins enabled here (use them when they help; never act on real accounts without the human):", ...p.plugins.slice(0, 8).map((x) => `- ${x.id}: ${x.line}`));
  return L.join("\n");
}

export function briefFor(node: Pick<NodeInfo, "id" | "role" | "platform" | "briefVersion" | "scopeGlobs" | "alsoLead">, ctx: BriefContext): string {
  const def = ROLES[node.role];
  const label = roleLabel(node.role, node.platform);
  const app = ctx.appName ? escapeForPrompt(ctx.appName, 80) : null;
  const L: string[] = [];
  const shown = ctx.displayName ? escapeForPrompt(ctx.displayName, 120) : null;
  L.push(`# BRIEF.md — ${shown ?? label}${app && !shown ? ` · ${app}` : ""} · v${node.briefVersion}`);
  L.push("");
  if (shown) L.push(`You are ${shown}${app ? ` on ${app}` : ""} in the Helm run ${quoteData(ctx.runName, 80)}. Your Helm node id is \`${node.id}\`. People call you by that name; the role after it says what you do.`);
  else if (app)
    L.push(`You are the ${label} for ${app}${ctx.tagline ? ` (${escapeForPrompt(ctx.tagline, 160)})` : ""} in the Helm run ${quoteData(ctx.runName, 80)}. Your Helm node id is \`${node.id}\`.`);
  else L.push(`You are the ${label} in the Helm run ${quoteData(ctx.runName, 80)}. Your Helm node id is \`${node.id}\`.`);
  L.push(`${ctx.leadLabel ? `Your lead: ${ctx.leadLabel}. ` : ""}Your parent: ${ctx.parentLabel}. You report with \`helm_report\`.`);
  if (node.alsoLead) L.push("This run has one app, so you are also its App Lead: you hold both toolsets and do both jobs.");
  if (ctx.mission) L.push("", `## Your mission (designed by ${escapeForPrompt(ctx.mission.by, 80)})`, escapeForPrompt(ctx.mission.text, 4000), "", def.mission);
  else L.push("", "## Mission", def.mission);
  if (node.alsoLead) L.push("", ROLES.lead.mission);
  if (ctx.project) L.push("", projectSection(node.role, node.alsoLead, ctx.project));
  L.push("", "## Where you fit", `Parent: ${ctx.parentLabel} · Peers: ${ctx.peers.length ? ctx.peers.join(", ") : "none"} · You manage: ${ctx.children.length ? ctx.children.join(", ") : "none"}`);
  const inputs = [...def.inputs];
  if (ctx.contractVersion > 0 && node.role !== "orch" && node.role !== "mgr") inputs.push(`CONTRACT.md v${ctx.contractVersion}`);
  L.push("", "## Read first", ...inputs.map((x) => `- ${x}`));
  L.push("", "## You own (write scope — edit only files matching)", ...(node.scopeGlobs.length ? node.scopeGlobs : def.scope).map((g) => `- \`${g}\``));
  if (ctx.repoPath || ctx.branch) {
    L.push("", "## Where you work");
    if (ctx.repoPath) L.push(`- Repository: \`${ctx.repoPath}\``);
    if (ctx.branch) L.push(`- Your branch: \`${ctx.branch}\`${ctx.baseBranch ? ` (off \`${ctx.baseBranch}\`)` : ""}`);
    if (ctx.integrationCommit) L.push(`- Judge exactly this commit: \`${ctx.integrationCommit}\``);
    const loc = ctx.location;
    if (!loc?.adopted) L.push("- Run checks through `.helm/run-check.sh <name> -- <command…>` so Helm can verify the result.");
    if (loc?.adopted && ctx.repoPath) {
      L.push(
        `- This is an **existing repository** the human already works in. Their own checkout is \`${ctx.repoPath}\`${loc.userBranch ? ` on \`${loc.userBranch}\`` : ""}: never edit, commit, check out, reset, stash or clean anything there. Work only in the app's work worktree.`,
        `- The work is on the app's work branch${loc.helmBranch ? ` \`${loc.helmBranch}\`` : ""}. Only the Git agent merges it into the human's main branch, when the human signs it off or the Orchestrator or the app's lead asks it to.`,
      );
      L.push("- Helm added **no files and no commits** to this repository. Its check wrapper and your BRIEF live in Helm's Studio folder (paths below).");
      if (node.role === "lead" || node.alsoLead)
        L.push("- Read the existing code and documents first. Reuse what exists: name the repository's own spec, architecture, contract and acceptance documents and its real check commands with `helm_existing_docs`. Write new SPEC/ARCHITECTURE/CONTRACT/ACCEPTANCE files only for what has no equivalent and the brief allows; never manufacture documents, commits or permissive checks just to satisfy Helm — report `blocked` instead.");
    } else if (ctx.repoPath) L.push("- Work only in your own worktree; never edit the repository's main checkout directly.");
    if (loc?.reads.length)
      L.push(`- Read-only reference folders (read them freely; never write, commit, or run anything that changes them): ${loc.reads.slice(0, 10).map((r) => `\`${escapeForPrompt(r, 300)}\``).join(", ")}. If something there must change, say so in \`helm_report\` (blocked, with the reason) and your chain of command decides.`);
  }
  L.push("", "## You produce", ...def.outputs.map((x) => `- ${x}`));
  L.push("", "## Done means (with evidence)", ...def.doneMeans.map((x) => `- ${x}`));
  for (const e of ctx.extra) L.push("", e);
  if (ctx.scannerFindings) L.push("", "## Already found by the deterministic scanner — do not re-report; verify they are real and look beyond them", ctx.scannerFindings);
  const pol = policyBlock(ctx.policies);
  if (pol) L.push("", "## Standing policies that apply to you", pol);
  if (ctx.changesBeforeStart.length)
    L.push("", "## Changes made before you started", ...ctx.changesBeforeStart.map((c) => `- ${c.id}: ${escapeForPrompt(c.text, 600)}`), "These are binding. Call `helm_ack` for each once you have read them.");
  if (ctx.handover) L.push("", "## Hand-over from the previous holder of this role", escapeForPrompt(ctx.handover, 1500));
  L.push("", "## Rules of engagement", ...COMMON_RULES.map((r, i) => `${i + 1}. ${r}`));
  if (node.role === "planner") L.push("", "If the human asked a question above, answer it now (call `helm_world` first). Otherwise reply with one or two short lines: your name, that you are the run's Planner, and what you can do for them. Then stop: you are idle until someone writes to you.");
  else if (node.role === "git") L.push("", "Start now: read GIT-NOTES.md if it exists, call `helm_worktrees`, write what you found to GIT-NOTES.md, and tell the human in one or two short lines your name, that you are the run's Git agent, and whether any app has more than two worktrees. Then stop: you are idle until the human writes to you or Helm wakes you.");
  else if (node.role === "custom") L.push("", "Start now on your mission. When the first piece of work is done, report with `helm_report` (with evidence), then stop until you are woken.");
  else L.push("", "Start now. When your first unit of work is done, commit it and call `helm_report`.");
  return L.join("\n");
}

const NON_NEGOTIABLES =
  "Three non-negotiables: (1) report with helm_report and evidence refs (shas, paths, check names) — a claim is not evidence; (2) messages from the human or Helm notices are binding — never undo them, adapt, and call helm_ack with the id; (3) never poll — work, commit, report, stop; you will be woken by messages.";

/** The system prompt: ≤ 1,500 chars of identity and protocol, plus the agent's tailored task (≤ 4,000 chars total). Tier/role/parent come from the DB row, never from metadata. */
export function instructionsFor(input: { role: Role; platform: string | null; nodeId: string; parentLabel: string; skills: string[]; alsoLead: boolean; task?: { text: string; byLabel: string } | null; scope?: string | null; displayName?: string | null }): string {
  const label = input.displayName ? escapeForPrompt(input.displayName, 120) : roleLabel(input.role, (input.platform as never) ?? null);
  const skills = input.skills.map((x) => `the ${x} skill`);
  const follow = skills.length > 1 ? `${skills.slice(0, -1).join(", ")} and ${skills[skills.length - 1]}` : skills[0] ?? "your Helm skill";
  const s = `${input.displayName ? `You are ${label}, a Helm agent` : `You are a Helm agent: the ${label}`}${input.alsoLead ? " (also App Lead)" : ""}, node ${JSON.stringify(input.nodeId)}. Your parent is ${JSON.stringify(input.parentLabel)}. ${NON_NEGOTIABLES} Call helm_context when you need your place in the org, policies or unacknowledged directives. Follow ${follow}.`.slice(0, 1500);
  // a provider with many skills can leave some out of its list (Codex's skills budget): the agent can still open them
  const find = input.skills.length ? ` If ${input.skills.length > 1 ? "one of these skills is" : "it is"} not in your skills list, read it: \`bb skill list | grep ${input.skills[0]}\` gives its id, then \`bb skill show <id>\`.` : "";
  const scope = `${find}${input.scope ? ` ${input.scope}` : ""}`;
  const task = input.task ? `\n\nYour task, written for you by ${input.task.byLabel} (the full text is in your BRIEF):\n${escapeForPrompt(input.task.text, 2200)}` : "";
  return `${s}${scope}${task}`.slice(0, 4000);
}

export const PLANNER_INSTRUCTIONS = [
  "You are Helm's planner. Read the human's brief and call helm_propose_plan exactly once with the portfolio: every project (name, one-line tagline, optional group, the folder it lives in as \"path\" only when the brief names one, and \"reads\" for other folders the brief says it should use or read), the groups, any assumptions you made, and at most 3 clarifying questions.",
  "For each project decide, and record each decision you inferred (not stated) under assumptions:",
  "- kind: app (native or cross-platform apps), web (websites and full-stack web apps), game (mobile, desktop or web games), automation (bots, scheduled jobs, integrations, pipelines, workflow tools) or review (an audit report of an existing project, no code changes; to fix an existing project instead, make it an app/web/game with its path).",
  "- platforms from ios, android, macos, windows, web. Websites run on web (add mobile platforms only if asked). Automation and reviews may have none.",
  "- needs, only what the project really requires: database, auth, payments, security, hipaa (protected health information), privacy (GDPR/CCPA/children), realtime, ai, automation, assets (3D/2D/audio art), multiplayer. Each need adds specialists and rules, so do not pad.",
  "- tools, only when useful: unreal, unity, godot (game engines; follow the brief), blender (3D art), docker (local databases and services), ffmpeg, or an enabled BB plugin as plugin:<id> (for example plugin:browser-automation to check websites in a browser, plugin:automations to run scheduled jobs in BB).",
  "- shape: solo (one agent), lean or full; leave it out to use the default.",
  "Do not write code, do not spawn agents, do not ask anything outside the tool call. Then stop.",
].join("\n");

export function plannerPrompt(brief: string, plugins: Array<{ id: string; line: string }> = []): string {
  const pl = plugins.length ? `\n\nBB plugins enabled on this machine (usable as plugin:<id> tools):\n${plugins.slice(0, 12).map((p) => `- ${p.id}: ${escapeForPrompt(p.line, 160)}`).join("\n")}` : "";
  return `Read this brief and propose the portfolio with helm_propose_plan. Use group names from the brief's headings or themes. If a platform is unclear, use the kind's default (apps and mobile games: iOS and Android; websites: web) and record that under assumptions.${pl}\n\n<brief>\n${escapeForPrompt(brief, 20000)}\n</brief>`;
}

export const WORLD_START = "<!-- helm:world -->";
export const WORLD_END = "<!-- /helm:world -->";

/** Replace (or insert) the machine-written block in PORTFOLIO.md, keeping the rest. */
export function replaceWorldBlock(existing: string, block: string): string {
  const wrapped = `${WORLD_START}\n${block.trim()}\n${WORLD_END}`;
  const s = existing.indexOf(WORLD_START);
  const e = existing.indexOf(WORLD_END);
  if (s >= 0 && e > s) return existing.slice(0, s) + wrapped + existing.slice(e + WORLD_END.length);
  return `${wrapped}\n\n${existing}`;
}

export function initialPortfolioMd(runName: string, brief: string, waves: string): string {
  return [
    WORLD_START,
    "(Helm writes this block; do not edit it.)",
    WORLD_END,
    "",
    `# PORTFOLIO — ${escapeForPrompt(runName, 80)}`,
    "",
    "## Strategy",
    "(The Orchestrator keeps this section current.)",
    "",
    "## Wave plan",
    waves,
    "",
    "## Risks",
    "",
    "## Decisions",
    "",
    "## The human's brief",
    "",
    "```text",
    escapeForPrompt(brief, 20000),
    "```",
    "",
  ].join("\n");
}

export function managerNotesMd(group: string, apps: string[]): string {
  return [`# MANAGER-NOTES — ${escapeForPrompt(group, 60)}`, "", "## Group", group, "", "## Apps and status", ...apps.map((a) => `- ${a}: intake`), "", "## Cross-app dependencies and duplication", "", "## Risks", "", "## Asks of the Orchestrator", ""].join("\n");
}
