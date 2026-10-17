// briefFor(node) — the first prompt every agent gets (appendix A7) — plus the
// short per-session instructions string, standing-policy blocks and the
// PORTFOLIO.md world block. Pure string building; all human free text and
// metadata is escaped before interpolation.
import type { NodeInfo, PolicyInfo, Role } from "../../shared/types.ts";
import { COMMON_RULES, ROLES, roleLabel } from "./roles.ts";

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
}

export function briefFor(node: Pick<NodeInfo, "id" | "role" | "platform" | "briefVersion" | "scopeGlobs" | "alsoLead">, ctx: BriefContext): string {
  const def = ROLES[node.role];
  const label = roleLabel(node.role, node.platform);
  const app = ctx.appName ? escapeForPrompt(ctx.appName, 80) : null;
  const L: string[] = [];
  L.push(`# BRIEF.md — ${label}${app ? ` · ${app}` : ""} · v${node.briefVersion}`);
  L.push("");
  if (app)
    L.push(`You are the ${label} for ${app}${ctx.tagline ? ` (${escapeForPrompt(ctx.tagline, 160)})` : ""} in the Helm run ${quoteData(ctx.runName, 80)}. Your Helm node id is \`${node.id}\`.`);
  else L.push(`You are the ${label} in the Helm run ${quoteData(ctx.runName, 80)}. Your Helm node id is \`${node.id}\`.`);
  L.push(`${ctx.leadLabel ? `Your lead: ${ctx.leadLabel}. ` : ""}Your parent: ${ctx.parentLabel}. You report with \`helm_report\`.`);
  if (node.alsoLead) L.push("This run has one app, so you are also its App Lead: you hold both toolsets and do both jobs.");
  L.push("", "## Mission", def.mission);
  if (node.alsoLead) L.push("", ROLES.lead.mission);
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
        `- This is an **existing repository** the human already works in. Their own checkout is \`${ctx.repoPath}\`${loc.userBranch ? ` on \`${loc.userBranch}\`` : ""}: never edit, commit, check out, reset, stash or clean anything there. Work only in your own worktree.`,
        `- This run's work starts from the Helm branch${loc.helmBranch ? ` \`${loc.helmBranch}\`` : ""}. Helm never merges into the human's branches; they merge the signed-off result themselves.`,
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
  L.push("", "Start now. When your first unit of work is done, commit it and call `helm_report`.");
  return L.join("\n");
}

const NON_NEGOTIABLES =
  "Three non-negotiables: (1) report with helm_report and evidence refs (shas, paths, check names) — a claim is not evidence; (2) messages from the human or Helm notices are binding — never undo them, adapt, and call helm_ack with the id; (3) never poll — work, commit, report, stop; you will be woken by messages.";

/** The system prompt: ≤ 1,500 chars of identity and protocol, plus the agent's tailored task (≤ 4,000 chars total). Tier/role/parent come from the DB row, never from metadata. */
export function instructionsFor(input: { role: Role; platform: string | null; nodeId: string; parentLabel: string; skills: string[]; alsoLead: boolean; task?: { text: string; byLabel: string } | null; scope?: string | null }): string {
  const label = roleLabel(input.role, (input.platform as never) ?? null);
  const skills = input.skills.map((x) => `the ${x} skill`);
  const follow = skills.length > 1 ? `${skills.slice(0, -1).join(", ")} and ${skills[skills.length - 1]}` : skills[0] ?? "your Helm skill";
  const s = `You are a Helm agent: the ${label}${input.alsoLead ? " (also App Lead)" : ""}, node ${JSON.stringify(input.nodeId)}. Your parent is ${JSON.stringify(input.parentLabel)}. ${NON_NEGOTIABLES} Call helm_context when you need your place in the org, policies or unacknowledged directives. Follow ${follow}.`.slice(0, 1500);
  const scope = input.scope ? ` ${input.scope}` : "";
  const task = input.task ? `\n\nYour task, written for you by ${input.task.byLabel} (the full text is in your BRIEF):\n${escapeForPrompt(input.task.text, 2200)}` : "";
  return `${s}${scope}${task}`.slice(0, 4000);
}

export const PLANNER_INSTRUCTIONS =
  "You are Helm's planner. Read the human's brief and call helm_propose_plan exactly once with the portfolio: every app (name, one-line tagline, platforms from ios/android/macos/windows, optional group, the folder it lives in as \"path\" only when the brief names one, and \"reads\" for other folders the brief says it should use or read), the groups, any assumptions you made, and at most 3 clarifying questions. Do not write code, do not spawn agents, do not ask anything outside the tool call. Then stop.";

export function plannerPrompt(brief: string): string {
  return `Read this brief and propose the portfolio with helm_propose_plan. Use group names from the brief's headings or themes. If a platform is unclear, assume iOS and Android and record that under assumptions.\n\n<brief>\n${escapeForPrompt(brief, 20000)}\n</brief>`;
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
