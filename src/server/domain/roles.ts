// Role registry (appendix A1/A3). Roles are data: briefs, Settings → Roles and
// the per-tier tool sets all read from here.
import type { Platform, ProjectKind, ProjectNeed, Role, SlotId, Tier } from "../../shared/types.ts";

export interface RoleDef {
  role: Role;
  tier: Tier;
  slot: SlotId;
  label: string;
  mission: string;
  scope: string[];
  inputs: string[];
  outputs: string[];
  doneMeans: string[];
  skill: string;
}

export const PLATFORM_LABEL: Record<Platform, string> = {
  mac: "macOS",
  win: "Windows",
  ios: "iOS",
  and: "Android",
  web: "Web",
};

export const PLATFORM_ORDER: Platform[] = ["mac", "win", "ios", "and", "web"];

export const ROLES: Record<Role, RoleDef> = {
  orch: {
    role: "orch",
    tier: "orchestrator",
    slot: "orchestrator",
    label: "Orchestrator",
    mission:
      "Turn the human's brief into a staffed, staged portfolio and keep the whole picture so the human never has to. You do not write app code.",
    scope: ["PORTFOLIO.md"],
    inputs: ["PORTFOLIO.md", "helm_world", "manager digests", "Needs-you items", "directive notices"],
    outputs: ["wave proposals (helm_propose_wave)", "priority calls (helm_set_priority)", "plan deltas (helm_propose_plan)", "the strategy section of PORTFOLIO.md"],
    doneMeans: ["every app is done or cancelled", "a final portfolio summary in PORTFOLIO.md"],
    skill: "helm-orchestrator",
  },
  mgr: {
    role: "mgr",
    tier: "manager",
    slot: "manager",
    label: "Manager",
    mission:
      "Keep up to four apps healthy and moving: unblock leads, balance their asks on capacity, spot duplicated work across apps, and give the Orchestrator an honest roll-up. You do not write app code.",
    scope: ["MANAGER-NOTES-<nodeId>.md"],
    inputs: ["lead reports", "helm_digest", "directive notices", "MANAGER-NOTES-<nodeId>.md"],
    outputs: ["MANAGER-NOTES-<nodeId>.md (risks, cross-app dependencies, decisions)", "priority proposals inside your group", "escalations"],
    doneMeans: ["every app in your group is done or cancelled"],
    skill: "helm-manager",
  },
  lead: {
    role: "lead",
    tier: "lead",
    slot: "lead",
    label: "App lead",
    mission:
      "Own one app end to end: make it real, make it coherent, hand it to the gates in a state that can pass.",
    scope: ["SPEC.md", "ARCHITECTURE.md", "CONTRACT.md", "DECISIONS.md", "ACCEPTANCE.md", ".helm/**", "integration merges"],
    inputs: ["BRIEF.md", "builder reports and diffs", "gate verdicts"],
    outputs: ["SPEC.md", "ARCHITECTURE.md", "CONTRACT.md (versioned)", "ACCEPTANCE.md", "DECISIONS.md", ".helm/checks.json", "integration merges", "the hand-over note"],
    doneMeans: ["the app reached Ready with evidence and the human signed off"],
    skill: "helm-lead",
  },
  ui: {
    role: "ui",
    tier: "specialist",
    slot: "ui",
    label: "UI builder",
    mission:
      "Build the design system and every screen so the app looks intentionally designed, in both themes, with every state.",
    scope: ["apps/*/ui/**", "packages/design-system/**", "reports/ui/**"],
    inputs: ["SPEC.md (UI sections)", "CONTRACT.md (view models)", "ACCEPTANCE.md (UI criteria)"],
    outputs: ["design tokens", "components", "screens with loading, empty, error, offline and permission-denied states", "screenshots of each key screen at three sizes in reports/ui/"],
    doneMeans: ["every screen in SPEC has all states, both themes and accessibility", "screenshots committed as evidence"],
    skill: "helm-specialist",
  },
  code: {
    role: "code",
    tier: "specialist",
    slot: "code",
    label: "Core builder",
    mission: "Build the logic, data layer and functionality exactly as the CONTRACT says.",
    scope: ["packages/core/**", "packages/data/**", "reports/core/**"],
    inputs: ["CONTRACT.md", "ARCHITECTURE.md", "ACCEPTANCE.md"],
    outputs: ["models, storage and migrations", "validation and error handling", "meaningful unit tests", "a README section for the public API"],
    doneMeans: ["CONTRACT fully implemented", "meaningful tests that can fail", "no fake data on shipped paths"],
    skill: "helm-specialist",
  },
  platform: {
    role: "platform",
    tier: "specialist",
    slot: "platform",
    label: "Platform builder",
    mission:
      "Make the app real on one platform: project configuration, permissions and manifests, lifecycle, navigation, system integration, packaging, wiring UI to Core.",
    scope: ["apps/<platform>/**", "reports/<platform>/**"],
    inputs: ["SPEC.md", "CONTRACT.md", "ARCHITECTURE.md"],
    outputs: ["the platform app project", "permissions and manifests", "packaging"],
    doneMeans: ["the platform app builds, runs the main flow and passes that platform's checks"],
    skill: "helm-specialist",
  },
  security: {
    role: "security",
    tier: "specialist",
    slot: "security",
    label: "Security",
    mission: "Find real security and privacy problems early and cheaply.",
    scope: ["SECURITY.md", ".github/**"],
    inputs: ["SPEC.md", "ARCHITECTURE.md", "CONTRACT.md", "dependency manifests"],
    outputs: ["SECURITY.md: threat model, data inventory, dependency audit, secrets scan, privacy drafts", "findings with severity and path:line filed to the lead"],
    doneMeans: ["threat model written", "dependencies and secrets audited", "findings filed"],
    skill: "helm-specialist",
  },
  test: {
    role: "test",
    tier: "specialist",
    slot: "test",
    label: "Test",
    mission: "Write a test plan from ACCEPTANCE; add UI and integration tests with fixtures. Every test must be able to fail.",
    scope: ["tests/**", "reports/tests/**"],
    inputs: ["ACCEPTANCE.md", "CONTRACT.md"],
    outputs: ["test plan", "UI and integration tests"],
    doneMeans: ["the ACCEPTANCE criteria that need tests have meaningful ones"],
    skill: "helm-specialist",
  },
  research: {
    role: "research",
    tier: "specialist",
    slot: "research",
    label: "Research",
    mission: "Answer a specific question with sources and no code.",
    scope: ["docs/research/**"],
    inputs: ["the question from your lead"],
    outputs: ["an answer with sources"],
    doneMeans: ["answers with sources, no code"],
    skill: "helm-specialist",
  },
  docs: {
    role: "docs",
    tier: "specialist",
    slot: "docs",
    label: "Docs",
    mission: "Keep README.md and store listings truthful: every claim must correspond to something the code does.",
    scope: ["README.md", "docs/**"],
    inputs: ["the code", "SPEC.md"],
    outputs: ["README.md", "store listings", "changelogs"],
    doneMeans: ["docs match what the code actually does"],
    skill: "helm-specialist",
  },
  data: {
    role: "data",
    tier: "specialist",
    slot: "code",
    label: "Data builder",
    mission: "Own the database: schema, migrations, indexes, access rules, seed data and backups, exactly as the CONTRACT says.",
    scope: ["db/**", "migrations/**", "prisma/**", "supabase/**", "drizzle/**", "packages/db/**", "reports/data/**"],
    inputs: ["CONTRACT.md (data model)", "ARCHITECTURE.md", "ACCEPTANCE.md"],
    outputs: ["schema and versioned migrations", "indexes justified by queries", "row-level access rules where data is shared", "clearly fake seed data", "a tested backup and restore"],
    doneMeans: ["migrations apply from empty and from the previous version", "every list query has an index", "a restore was tested"],
    skill: "helm-specialist",
  },
  compliance: {
    role: "compliance",
    tier: "specialist",
    slot: "security",
    label: "Compliance",
    mission: "Decide which rules apply (HIPAA, privacy law, PCI), map each to a control in the code or configuration, and file the gaps. Not legal advice: the human and their counsel decide.",
    scope: ["COMPLIANCE.md", "docs/compliance/**", "reports/compliance/**"],
    inputs: ["SPEC.md", "ARCHITECTURE.md", "CONTRACT.md", "SECURITY.md"],
    outputs: ["COMPLIANCE.md: applicability, data inventory, control matrix with path:line evidence, vendor list, human decisions", "findings filed to the lead"],
    doneMeans: ["every applicable requirement maps to evidence or a filed gap", "decisions only the human can make are raised once"],
    skill: "helm-specialist",
  },
  assets: {
    role: "assets",
    tier: "specialist",
    slot: "ui",
    label: "Asset builder",
    mission: "Make the art: 3D models, sprites, textures, animation and audio within the budgets, with sources and licences recorded.",
    scope: ["assets/**", "art/**", "game/Content/**", "game/assets/**", "reports/assets/**"],
    inputs: ["SPEC.md (asset list)", "ARCHITECTURE.md (engine, formats, budgets)"],
    outputs: ["source files and engine-ready exports", "assets/LICENSES.md", "renders and an import check in reports/assets/"],
    doneMeans: ["every asset in SPEC exists within budget and imports cleanly", "every third-party asset has a recorded licence"],
    skill: "helm-specialist",
  },
  review: {
    role: "review",
    tier: "gate",
    slot: "review",
    label: "Reviewer",
    mission: "An independent verdict on whether this commit meets ACCEPTANCE. You are read-only on source.",
    scope: ["reports/**"],
    inputs: ["ACCEPTANCE.md", "the commit named in your brief", "CONTRACT.md"],
    outputs: ["a verdict through helm_verdict", "reports under reports/review/"],
    doneMeans: ["a valid verdict bound to a commit"],
    skill: "helm-reviewer",
  },
  slop: {
    role: "slop",
    tier: "gate",
    slot: "slop",
    label: "Slop Hunter",
    mission:
      "Make sure nothing that looks AI-generated-and-unchecked ships. Run the deterministic scanner first, then look for what it cannot see.",
    scope: ["reports/**"],
    inputs: ["ACCEPTANCE.md", "scanner output for the judged commit", "README.md and UI copy"],
    outputs: ["a verdict through helm_verdict", "reports under reports/slop/"],
    doneMeans: ["a valid verdict bound to a commit"],
    skill: "helm-slop-hunter",
  },
};

export const COMMON_RULES = [
  "You are one node in a chain of command. Report to your parent with `helm_report` — a summary of at most 600 characters plus evidence references (commit shas, file paths, check names), never pasted content.",
  'A claim is not evidence. "Done" means: commits on your branch, files at known paths, checks that exited 0 on the current commit. Say which.',
  'When a message arrives that starts with "Message from the human", "The human changed…", "The human edited…" or "Your direct report … was changed by the human", it is binding. Do not undo it. Adapt your plan, then call `helm_ack` with its id and one line saying what you changed.',
  "Stay inside your write scope. If you need a change outside it, `helm_message` the owner (usually your lead) and wait; do not edit around it.",
  "Never poll. Work, commit, report, then stop. You will be woken by messages.",
  "If you are blocked on a decision only the human can make, call `helm_need` once with a precise question and options, then stop. Do not guess.",
  "Commit small and often on your branch with clear messages. No secrets in code, config or history. Never use a destructive or major-version command (`--force`, dropping data, major dependency upgrades) without an approval through `helm_need`.",
  "Keep your own context small: read diffs, reports and the specific files you need, not the whole repository. Put durable facts in files, not chat.",
];

export function roleLabel(role: Role, platform: Platform | null): string {
  if (role === "platform" && platform) return `${PLATFORM_LABEL[platform]} builder`;
  return ROLES[role].label;
}

export function tierOfRole(role: Role): Tier {
  return ROLES[role].tier;
}

export function slotOfRole(role: Role): SlotId {
  return ROLES[role].slot;
}

export function scopeFor(role: Role, platform: Platform | null, kind: ProjectKind = "app"): string[] {
  if (kind === "review") {
    // an audit: source is read-only, every auditor writes its part of the report
    if (ROLES[role].tier === "specialist") return [`reports/${role === "platform" && platform ? platform : role}/**`];
    if (role === "lead") return [...ROLES.lead.scope.filter((g) => g !== "integration merges"), "REVIEW.md"];
  }
  if (role === "platform" && platform === "web") return ["apps/web/**", "infra/**", "deploy/**", "reports/web/**"];
  if (kind === "web" && role === "ui") return ["apps/web/**", "packages/ui/**", "reports/ui/**"];
  if (kind === "web" && role === "code") return ["apps/api/**", "packages/core/**", "packages/server/**", "reports/core/**"];
  if (kind === "game" && role === "code") return ["game/**", "packages/core/**", "reports/core/**"];
  if (kind === "game" && role === "ui") return ["game/**/UI/**", "game/**/ui/**", "reports/ui/**"];
  const base = ROLES[role].scope;
  if (role === "platform" && platform) return base.map((g) => g.replace("<platform>", platform));
  return base;
}

/** Which tools each tier may call (§8.1). The execute-time check uses this. */
export const TOOLS_BY_TIER: Record<Tier, string[]> = {
  orchestrator: [
    "helm_context",
    "helm_report",
    "helm_ack",
    "helm_need",
    "helm_message",
    "helm_direct",
    "helm_models",
    "helm_set_model",
    "helm_approve",
    "helm_set_task",
    "helm_world",
    "helm_propose_plan",
    "helm_propose_wave",
    "helm_set_priority",
    "helm_digest",
  ],
  manager: [
    "helm_context",
    "helm_report",
    "helm_ack",
    "helm_need",
    "helm_message",
    "helm_direct",
    "helm_models",
    "helm_set_model",
    "helm_approve",
    "helm_set_task",
    "helm_set_priority",
    "helm_digest",
  ],
  lead: [
    "helm_context",
    "helm_report",
    "helm_ack",
    "helm_need",
    "helm_message",
    "helm_direct",
    "helm_models",
    "helm_set_model",
    "helm_approve",
    "helm_set_task",
    "helm_spawn_squad",
    "helm_publish_contract",
    "helm_stage",
    "helm_assign_fix",
    "helm_record_check",
    "helm_slop_scan",
    "helm_existing_docs",
  ],
  specialist: ["helm_context", "helm_report", "helm_ack", "helm_need", "helm_message", "helm_slop_scan"],
  gate: [
    "helm_context",
    "helm_report",
    "helm_ack",
    "helm_need",
    "helm_message",
    "helm_record_check",
    "helm_slop_scan",
    "helm_verdict",
  ],
};

/** The planner thread gets exactly one tool. */
export const PLANNER_TOOLS = ["helm_propose_plan"];

export function toolsForNode(tier: Tier, alsoLead: boolean): string[] {
  const set = new Set(TOOLS_BY_TIER[tier]);
  if (alsoLead) for (const t of TOOLS_BY_TIER.lead) set.add(t);
  return [...set];
}

const PLATFORM_SKILL: Record<Platform, string> = { mac: "helm-macos", win: "helm-windows", ios: "helm-ios", and: "helm-android", web: "helm-web" };
const CRAFT_SKILL: Partial<Record<Role, string>> = {
  ui: "helm-ui",
  code: "helm-code",
  security: "helm-security",
  test: "helm-test",
  research: "helm-research",
  docs: "helm-docs",
  data: "helm-data",
  compliance: "helm-compliance",
  assets: "helm-assets",
};
/** The Core builder's craft follows the project's kind. */
const CORE_SKILL: Record<ProjectKind, string> = { app: "helm-code", web: "helm-backend", game: "helm-game", automation: "helm-automation", review: "helm-code" };
/** A server is part of the project when it needs any of these. */
const SERVER_NEEDS: ProjectNeed[] = ["database", "auth", "payments", "realtime", "ai", "multiplayer"];

export interface SkillProfile {
  shape: string;
  platforms: Platform[];
  kind?: ProjectKind;
  needs?: ProjectNeed[];
  tools?: string[];
}

/** The craft skill a builder loads next to its protocol skill (helm-specialist): how to do its kind of work well. */
export function craftSkill(role: Role, platform: Platform | null, kind: ProjectKind = "app"): string | null {
  if (role === "platform") return platform ? PLATFORM_SKILL[platform] : null;
  if (role === "code") return CORE_SKILL[kind];
  return CRAFT_SKILL[role] ?? null;
}

/**
 * Every skill an agent loads: its protocol skill, its craft skill, the skills its project's
 * kind, needs and tools call for, and for a solo lead (who builds the project itself) the
 * craft of every part it builds. In a review project specialists audit (helm-audit) with
 * their craft as the standard to audit against.
 */
export function skillsFor(n: { role: Role; platform: Platform | null; alsoLead: boolean }, app: SkillProfile | null): string[] {
  const kind = app?.kind ?? "app";
  const needs = app?.needs ?? [];
  const tools = app?.tools ?? [];
  const has = (x: ProjectNeed) => needs.includes(x);
  const out = [ROLES[n.role].skill];
  const tier = ROLES[n.role].tier;
  if (kind === "review" && (tier === "specialist" || n.role === "lead" || n.alsoLead)) out.push("helm-audit");
  const craft = craftSkill(n.role, n.platform, kind);
  if (craft) out.push(craft);
  if (n.alsoLead) out.push("helm-lead");
  const leads = n.role === "lead" || n.alsoLead;
  const solo = app?.shape === "solo";
  if (app && kind !== "review") {
    // the extra craft a role needs for this project
    if (n.role === "code") {
      if (kind === "app" && needs.some((x) => SERVER_NEEDS.includes(x))) out.push("helm-backend");
      if (has("database") && app.shape !== "full") out.push("helm-data");
      if (has("payments")) out.push("helm-payments");
      if (has("automation") && kind !== "automation") out.push("helm-automation");
    }
    if (n.role === "security" && has("payments")) out.push("helm-payments");
    if (n.role === "platform" && kind === "game") out.push("helm-game");
  }
  if (tools.includes("unreal") && (leads || n.role === "code" || n.role === "platform")) out.push("helm-unreal");
  if (leads && solo && app) {
    for (const p of app.platforms.slice(0, 2)) out.push(PLATFORM_SKILL[p]);
    if (kind !== "app" && kind !== "review") out.push(CORE_SKILL[kind]);
    if (kind === "app" && needs.some((x) => SERVER_NEEDS.includes(x))) out.push("helm-backend");
    if (has("database")) out.push("helm-data");
    if (has("payments")) out.push("helm-payments");
    if (has("hipaa") || has("privacy")) out.push("helm-compliance");
    if (has("assets")) out.push("helm-assets");
  }
  return [...new Set(out)];
}
