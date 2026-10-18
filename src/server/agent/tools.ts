// The helm_* agent tools (§8.1). Registered once; exposed per tier by
// agents.configure (a hint). Every execute re-authorizes from the nodes row:
// tier, identity, parent and app come from the database, never from metadata
// or arguments (§8.2, V12).

import { askKey } from "../engine/asks.ts";
import { worktreesViewFor, worktreeSizesText } from "../worktree-view.ts";
import { githubViewFor, githubText } from "../github-view.ts";
import { setTask } from "../engine/tasks.ts";
import { applyVerdicts, watcherRun, type WatchVerdict } from "../engine/watch.ts";
import { answerPrompt } from "../engine/prompts.ts";
import { raiseInteractionNeed } from "../engine/events.ts";
import { cardActions, humanTopic } from "../engine/handsoff.ts";
import { recordInstall, requestInstall } from "../engine/installs.ts";
import { z } from "zod";
import type { Engine } from "../engine/engine.ts";
import { HelmError } from "../engine/engine.ts";
import { HUMAN_ONLY, NEED_ABOUT, PROJECT_NEEDS, type NodeInfo, type ProjectNeed } from "../../shared/types.ts";
import { decideYourselfText, UPWARD_ASKS_PER_HOUR } from "../domain/authority.ts";
import { toolsForNode, PLANNER_TOOLS } from "../domain/roles.ts";
import { KindLooseSchema, PortfolioSchema, normalizePortfolio } from "../domain/brief.ts";
import { VerdictSchema } from "../domain/verdict.ts";
import { ack, agentDirect, agentModels, agentSetModel, resolveModelWord, resolveNeed, type ModelChange, type NeedResolution } from "../engine/direct.ts";
import { buildSpec, renameNode, retireAgent } from "../engine/custom.ts";
import { assignFix, declareExisting, publishContract, recordCheck, releaseSquadMembers, report, sendback, signoff, slopScan, spawnSquad, stageRequest, verdict } from "../engine/gates.ts";
import { context, digest, world } from "../engine/world.ts";
import { validateDelta, type ProfileChange } from "../engine/delta.ts";
import { appWorktrees, consolidate, worktreesText } from "../engine/worktrees.ts";
import { normalizeNeed, normalizeTool } from "../domain/profile.ts";
import { ORCH_ID, planTopology } from "../domain/topology.ts";
import { inFlightCap } from "../domain/scheduler.ts";
import { isInFlight } from "../domain/stages.ts";

const Evidence = z.object({ kind: z.enum(["commit", "file", "check", "report"]), ref: z.string().min(1).max(300), branch: z.string().max(200).optional() });
const StageZ = z.enum(["intake", "spec", "build", "integrate", "review", "slop", "fix", "ready", "done"]);
const RelPath = z.string().min(1).max(300).refine((s) => !s.startsWith("/") && !s.startsWith("-") && !s.split(/[\\/]/).includes(".."), "a path inside the repository");

const AppZ = z.object({ name: z.string().min(1).max(60), tagline: z.string().max(160).default(""), platforms: z.array(z.string()).max(5).default([]), group: z.string().max(60).nullish(), shape: z.enum(["solo", "lean", "full"]).optional(), notes: z.string().max(1200).nullish(), path: z.string().trim().min(1).max(500).nullish(), reads: z.array(z.string().trim().min(1).max(500)).max(10).optional(), kind: z.string().max(40).optional(), needs: z.array(z.string().max(40)).max(12).optional(), tools: z.array(z.string().max(60)).max(8).optional() });
const ProfileZ = z.object({ kind: KindLooseSchema.optional(), needs: z.array(z.string().max(40)).max(12).optional(), tools: z.array(z.string().max(60)).max(8).optional() }).strict();
const SquadRoleZ = z.enum(["ui", "code", "platform", "security", "test", "research", "docs", "data", "compliance", "assets"]);
const SquadPlatformZ = z.enum(["mac", "win", "ios", "and", "web"]);

export interface ToolDef {
  name: string;
  description: string;
  parameters: z.ZodType;
  presentation: { label: { pending: string; completed: string }; icon: { glyph: string }; suppress?: boolean };
}

export const TOOL_DEFS: ToolDef[] = [
  { name: "helm_context", description: "Your place in the org: node, parent, children, standing policies, directives you have not acknowledged, CONTRACT version, capacity. ≤2 KB.", parameters: z.object({}).strict(), presentation: { label: { pending: "Reading Helm context", completed: "Read Helm context" }, icon: { glyph: "Info" }, suppress: true } },
  {
    name: "helm_report",
    description: "Report to your parent: status progress|blocked|done|failed, a summary ≤600 chars and evidence refs (commit shas, committed file paths, check names). Helm verifies evidence; done without verifiable evidence is not accepted.",
    parameters: z.object({ status: z.enum(["progress", "blocked", "done", "failed"]), summary: z.string().min(1).max(600), evidence: z.array(Evidence).max(20).optional(), blockers: z.array(z.string().max(200)).max(10).optional(), next: z.string().max(300).optional() }).strict(),
    presentation: { label: { pending: "Reporting to parent", completed: "Reported to parent" }, icon: { glyph: "Sent" } },
  },
  { name: "helm_ack", description: "Acknowledge a binding directive (D-0001…) with one line saying what you changed.", parameters: z.object({ directiveId: z.string().regex(/^D-\d{4,}$/), note: z.string().max(300).optional() }).strict(), presentation: { label: { pending: "Acknowledging", completed: "Acknowledged" }, icon: { glyph: "Check" }, suppress: true } },
  {
    name: "helm_need",
    description:
      "Ask for a decision (question|approval|decision). Set `about`: credentials (an API key, a login, a password, an account), spending (real money: a paid service, a purchase, a budget raise), privacy (secrets or personal data could leak), access (an account or permission on an outside service only the human holds), owner (what the product should be), or other. With autonomy on (hands-off) only credentials, spending, privacy and access reach the human, and only when the question really names a key, login, account, payment or private data; everything else goes to your supervisor, and the Orchestrator decides it (installs, holds, git, gates, retries, sign-off, product calls). Then keep working on what does not depend on it; the answer is sent to you.",
    parameters: z
      .object({
        kind: z.enum(["question", "approval", "decision"]),
        about: z.enum(NEED_ABOUT).default("other"),
        title: z.string().min(1).max(200),
        body: z.string().max(1200),
        options: z.array(z.string().max(80)).max(6).optional(),
        evidence: z.string().max(600).optional(),
      })
      .strict(),
    presentation: { label: { pending: "Asking the human", completed: "Asked the human" }, icon: { glyph: "MessageQuestion" } },
  },
  {
    name: "helm_message",
    description: "Message your parent, a child, or a sibling in the same app (kind info|ask|handoff). Cross-app traffic goes up through your manager or the Orchestrator.",
    parameters: z.object({ to: z.string().min(1).max(80), text: z.string().min(1).max(2000), kind: z.enum(["info", "ask", "handoff"]).default("info") }).strict(),
    presentation: { label: { pending: "Sending a message", completed: "Sent a message" }, icon: { glyph: "MessageSquare" } },
  },
  {
    name: "helm_direct",
    description:
      "Steer anyone below you (your reports and their teams, never gates): tell (a binding instruction; it also wakes a builder that already reported done, while its app is in flight), pause, resume, or priority low|normal|high. The target must helm_ack; everyone between you and it, and above you, gets one FYI line; you get its ack as FYI. urgent (default true) interrupts its current turn, false waits for it. The human's directives win: you cannot resume what the human paused or override a priority the human set. Batch instructions: at most 3 per agent and 12 in total per 10 minutes.",
    parameters: z.object({ to: z.string().min(1).max(80), action: z.enum(["tell", "pause", "resume", "priority"]), text: z.string().max(1500).optional(), priority: z.enum(["low", "normal", "high"]).optional(), urgent: z.boolean().optional() }).strict(),
    presentation: { label: { pending: "Steering a report", completed: "Steered a report" }, icon: { glyph: "Sent" } },
  },
  { name: "helm_models", description: "The models this machine offers (provider/model:reasoning) and the model, role and status of every agent below you. Read it before helm_set_model.", parameters: z.object({}).strict(), presentation: { label: { pending: "Reading models", completed: "Read models" }, icon: { glyph: "AiBrain01" } } },
  {
    name: "helm_set_model",
    description:
      "Change the model of agents below you: the Orchestrator, the Planner and the Fixer can change anyone, a Manager its Leads and their teams, a Lead its squad and gates. Use it when the human asks (directly, or relayed by your supervisor), or to move an agent off a model that keeps failing. Each change picks agents by `nodes` (ids), or by `role` (manager, lead, ui, code, platform, security, test, research, docs, data, compliance, assets, reviewer, slop = Slop Hunter, gates, specialists, all) narrowed by `app`, `under` one of your reports, or `platform`; `model` is provider/model:reasoning from helm_models (provider and reasoning may be left out when unambiguous). Several changes in one call, e.g. one manager to one model and another to a different one. Same provider: it switches at its next turn. Another provider: it moves to a new thread with a hand-over. A failed agent retries on the new model. When the Orchestrator moves every agent of a role, future agents of that role follow.",
    parameters: z
      .object({
        changes: z
          .array(
            z
              .object({
                nodes: z.array(z.string().min(1).max(80)).min(1).max(60).optional(),
                role: z.string().min(1).max(40).optional(),
                app: z.string().min(1).max(80).optional(),
                under: z.string().min(1).max(80).optional(),
                platform: z.string().min(1).max(20).optional(),
                model: z.string().min(1).max(120),
              })
              .strict(),
          )
          .min(1)
          .max(10),
        reason: z.string().max(300).optional(),
      })
      .strict(),
    presentation: { label: { pending: "Changing models", completed: "Changed models" }, icon: { glyph: "SlidersHorizontal" } },
  },
  {
    name: "helm_create_agent",
    description:
      "The Planner designs a new agent for this run, one that has never existed, when it would help: e.g. a Release Notes agent that writes notes for signed-off work, a Storage Guard that checks everything lives on the external SSD, a HIPAA reviewer, a workflow debugger. Never one for git housekeeping, merging or pushing: the run's Git agent does that. Give it a short memorable `name` (unique in the run; the human can rename it), a job `title`, a `mission` (what it does, when, what done looks like, what it must never do), and who it reports to (`reportsTo`: orch, a manager id, or an app lead id; under a lead it works in that app's repository). Optional: `writes` (relative globs it may edit; default its own reports/agents folder), `reads` (absolute read-only folders), `model` (provider/model:reasoning from helm_models; default the Core builder's), `skills` (up to 4 craft skills, e.g. helm-security, helm-compliance, helm-automation), `wakeOn` (stage, ready, signoff, failed: Helm wakes it on those events in its scope instead of it polling). Autonomy on: it is created and starts now. Otherwise the human approves it.",
    parameters: z
      .object({
        name: z.string().min(1).max(40),
        title: z.string().min(2).max(60),
        mission: z.string().min(40).max(4000),
        reportsTo: z.string().min(1).max(80),
        writes: z.array(z.string().min(1).max(200)).max(10).optional(),
        reads: z.array(z.string().min(1).max(500)).max(10).optional(),
        model: z.string().min(1).max(120).optional(),
        skills: z.array(z.string().min(1).max(40)).max(4).optional(),
        wakeOn: z.array(z.enum(["stage", "ready", "signoff", "failed"])).max(4).optional(),
        reason: z.string().max(400).optional(),
      })
      .strict(),
    presentation: { label: { pending: "Designing an agent", completed: "Designed an agent" }, icon: { glyph: "UserRoundPlus" } },
  },
  { name: "helm_rename_agent", description: "Give any agent in the run a new personal name when the human asks (including yourself or the Orchestrator). Names are unique in the run; the agent's thread title follows.", parameters: z.object({ nodeId: z.string().min(1).max(80), name: z.string().min(1).max(40) }).strict(), presentation: { label: { pending: "Renaming", completed: "Renamed" }, icon: { glyph: "Edit" } } },
  { name: "helm_worktrees", description: "The Git agent's view of every app's worktrees, from git itself: the human's checkout, the shared work worktree, lanes and any extra ones (limit: the worktrees-per-project setting), each with branch, commit, uncommitted changes and the agents working there, plus leftover agent branches. Narrow it with `app`. `sizes: true` also measures the space each worktree and each repository's git storage takes and each disk's free space (can take a minute on big folders). `github: true` also reads each app's remote (branch names and commits only, nothing downloaded): what is on GitHub, what is not, what is newer there.", parameters: z.object({ app: z.string().min(1).max(80).optional(), sizes: z.boolean().optional(), github: z.boolean().optional() }).strict(), presentation: { label: { pending: "Listing worktrees", completed: "Listed worktrees" }, icon: { glyph: "GitBranch" } } },
  {
    name: "helm_consolidate",
    description: "Move an app that uses one worktree per agent onto its shared work worktree: once every extra agent worktree's work is committed and on the integration branch, Helm stops those agents, removes their worktrees, creates the shared work worktree on the integration branch and starts the agents again there with a hand-over. Refuses, changing nothing, with what to fix first while anything could be lost.",
    parameters: z.object({ app: z.string().min(1).max(80), reason: z.string().max(300).optional() }).strict(),
    presentation: { label: { pending: "Consolidating worktrees", completed: "Consolidated worktrees" }, icon: { glyph: "GitBranch" } },
  },
  { name: "helm_retire_agent", description: "Stop a custom agent for good (its thread is stopped and archived) when it is no longer useful or the human asks. Only custom agents can be retired.", parameters: z.object({ nodeId: z.string().min(1).max(80), reason: z.string().min(1).max(300) }).strict(), presentation: { label: { pending: "Retiring an agent", completed: "Retired an agent" }, icon: { glyph: "Archive" } } },
  {
    name: "helm_watch",
    description: "The Watcher's only tool: one verdict per agent from Helm's packet. ok (working, leave it) · nudge (interrupt with your note) · restart (stop a hung or looping turn and resume) · escalate (to its nearest active supervisor) · human (credentials, spending, private data, access, or nobody can fix it).",
    parameters: z.object({ verdicts: z.array(z.object({ nodeId: z.string().min(1).max(120), verdict: z.enum(["ok", "nudge", "restart", "escalate", "human"]), note: z.string().min(1).max(600) }).strict()).min(1).max(20) }).strict(),
    presentation: { label: { pending: "Checking agents", completed: "Checked agents" }, icon: { glyph: "Eye" } },
  },
  {
    name: "helm_set_task",
    description: "Write or replace the task of an agent under you (Orchestrator → managers, leads; manager → its leads; lead → its squad and gates). The task becomes part of its system prompt and brief: goal, the files and contract sections it owns, acceptance criteria, constraints, what not to touch. ≤6,000 chars; aim for 150–600 words. A running agent is told at its next step.",
    parameters: z.object({ nodeId: z.string().min(1).max(120), task: z.string().min(1).max(6000) }).strict(),
    presentation: { label: { pending: "Writing a task", completed: "Wrote a task" }, icon: { glyph: "ListTodo" } },
  },
  {
    name: "helm_approve",
    description: "Answer a permission prompt (sent to you as 'Permission request … prompt <id>'). allow: ordinary work for its task, including installs and downloads it needs. deny: destructive, outside its worktree, or unclear. escalate: a key, password or login, spending real money, or private data (it goes to the Orchestrator, and from the Orchestrator to the human).",
    parameters: z.object({ promptId: z.string().min(1).max(120), decision: z.enum(["allow", "deny", "escalate"]), reason: z.string().min(1).max(400) }).strict(),
    presentation: { label: { pending: "Answering a permission prompt", completed: "Answered a permission prompt" }, icon: { glyph: "SecurityCheck" } },
  },
  {
    name: "helm_resolve",
    description: "Decide a card Helm handed you instead of the human (hands-off: the message says 'Card N-… is yours to decide'; the Fixer gets failed and stuck agents, a lead its squad's prompts, a manager its apps' sign-offs and gate disputes, the Orchestrator the rest). action: signoff · sendback (text = exactly what to fix) · retry · stop · nudge · waive (findings + text = why) · approve · deny · answer (text) · dismiss (text = why it needs nothing). Use one of the actions the card names; text records your reason for the human. To move a failing agent to another model use helm_set_model instead (it retries the agent and closes its card).",
    parameters: z.object({ needId: z.string().regex(/^N-\d+$/), action: z.enum(["signoff", "sendback", "retry", "stop", "nudge", "waive", "approve", "deny", "answer", "dismiss"]), text: z.string().max(1500).optional(), findings: z.array(z.string().min(1).max(20)).max(50).optional() }).strict(),
    presentation: { label: { pending: "Deciding a card", completed: "Decided a card" }, icon: { glyph: "CircleCheck" } },
  },
  {
    name: "helm_install",
    description: "Ask the run's Git agent to install something your work needs: packages (npm/pnpm/yarn, CocoaPods, pip, gems, Gradle), an SDK, a command-line tool, a download. The human allows installs: nobody's approval is needed and no supervisor's hold stops one. Say what, why, and where (a folder; default: your worktree). The Git agent installs it, records it in the run's install ledger, and you are told when it is done. Do not install things yourself.",
    parameters: z.object({ what: z.string().min(1).max(300), why: z.string().min(1).max(500), where: z.string().max(500).optional() }).strict(),
    presentation: { label: { pending: "Asking for an install", completed: "Asked for an install" }, icon: { glyph: "Download" } },
  },
  {
    name: "helm_installed",
    description: "The Git agent's record of an install request (I-…), once handled: state done (command = the exact command you ran), failed (note = the error), or needs_human (it needs a key, a login, a password or a payment; then raise helm_need about credentials or spending). Every agent that asked is told, and the run's install ledger keeps it.",
    parameters: z.object({ id: z.string().regex(/^I-\d+$/), state: z.enum(["done", "failed", "needs_human"]), command: z.string().max(500).optional(), note: z.string().max(800).optional() }).strict(),
    presentation: { label: { pending: "Recording an install", completed: "Recorded an install" }, icon: { glyph: "Download" } },
  },
  { name: "helm_world", description: "The whole run from Helm's database: stages, needs, recent human directives with receipts, touched agents, policies, managers and apps. Always current.", parameters: z.object({ appsPage: z.number().int().min(0).max(20).optional() }).strict(), presentation: { label: { pending: "Reading world state", completed: "Read world state" }, icon: { glyph: "Globe" } } },
  {
    name: "helm_propose_plan",
    description:
      "Propose a portfolio (planner) or a plan delta (Orchestrator: add projects, drop projects, change shapes, or change a project's kind (app|web|game|automation|review), needs (database, auth, payments, security, hipaa, privacy, realtime, ai, automation, assets, multiplayer) or tools (blender, unreal, unity, godot, docker, plugin:<id>) — the squad follows). Helm validates it and asks the human.",
    parameters: z.object({ portfolio: PortfolioSchema.optional(), delta: z.object({ add: z.array(AppZ).max(20).optional(), drop: z.array(z.string()).max(20).optional(), shapes: z.record(z.string(), z.enum(["solo", "lean", "full"])).optional(), profiles: z.record(z.string(), ProfileZ).optional(), rationale: z.string().max(600).optional() }).strict().optional() }).strict(),
    presentation: { label: { pending: "Proposing a plan", completed: "Proposed a plan" }, icon: { glyph: "ListTodo" } },
  },
  { name: "helm_propose_wave", description: "Propose which Intake apps to start next and why.", parameters: z.object({ appIds: z.array(z.string()).min(1).max(20), rationale: z.string().max(600) }).strict(), presentation: { label: { pending: "Proposing a wave", completed: "Proposed a wave" }, icon: { glyph: "Layers" } } },
  { name: "helm_set_priority", description: "Set an app's or node's priority (low|normal|high). Managers only within their group.", parameters: z.object({ appId: z.string().optional(), nodeId: z.string().optional(), priority: z.enum(["low", "normal", "high"]), reason: z.string().max(300) }).strict(), presentation: { label: { pending: "Setting priority", completed: "Set priority" }, icon: { glyph: "Sort" } } },
  { name: "helm_digest", description: "Rolled-up state of the apps under you, plus FYI lines you have not read.", parameters: z.object({}).strict(), presentation: { label: { pending: "Reading digest", completed: "Read digest" }, icon: { glyph: "AlignLeft" } } },
  {
    name: "helm_spawn_squad",
    description: "Ask Helm to start squad members of your project's plan (role ui|code|platform|security|test|data|compliance|assets|research|docs, platform for platform builders: mac|win|ios|and|web). Helm checks shape, lead span and caps; returns accepted / deferred with reasons. Give each member a `task`: a short system prompt written for exactly its job (what to build, the files and contract sections it owns, acceptance criteria, what not to touch) — it starts with it. Use `release` (with a reason) for members your SPEC no longer needs: Helm stops them and does not wait for them at Integrate.",
    parameters: z
      .object({
        spawn: z.array(z.object({ role: SquadRoleZ, platform: SquadPlatformZ.nullish(), task: z.string().max(6000).nullish() })).max(12).default([]),
        release: z.array(z.object({ role: SquadRoleZ, platform: SquadPlatformZ.nullish(), reason: z.string().min(1).max(300) })).max(12).default([]),
      })
      .strict(),
    presentation: { label: { pending: "Spawning the squad", completed: "Spawned the squad" }, icon: { glyph: "UserRoundPlus" } },
  },
  { name: "helm_publish_contract", description: "Announce a new CONTRACT.md version (committed on the integration branch) to every builder of the app.", parameters: z.object({ version: z.number().int().min(1).max(999), summary: z.string().min(1).max(600) }).strict(), presentation: { label: { pending: "Publishing the contract", completed: "Published the contract" }, icon: { glyph: "FileText" } } },
  { name: "helm_stage", description: "Move your app to the next stage (spec→build, build→integrate, integrate→review, fix→integrate) with evidence. Helm checks the facts and rejects with the reason.", parameters: z.object({ to: StageZ, evidence: z.array(Evidence).max(20).default([]) }).strict(), presentation: { label: { pending: "Requesting a stage change", completed: "Requested a stage change" }, icon: { glyph: "ArrowRight" } } },
  { name: "helm_assign_fix", description: "Assign a finding (F-…) to the specialist who owns the file; Helm sends them the file:line.", parameters: z.object({ findingId: z.string().regex(/^F-\d+$/), nodeId: z.string().min(1) }).strict(), presentation: { label: { pending: "Assigning a fix", completed: "Assigned a fix" }, icon: { glyph: "Bug" } } },
  {
    name: "helm_existing_docs",
    description:
      "Existing repositories only: name the committed files that already serve as this app's spec, architecture, contract and acceptance documents, and declare its real check commands, instead of creating SPEC.md/ARCHITECTURE.md/CONTRACT.md/ACCEPTANCE.md or .helm/checks.json. Helm verifies each file exists on the integration branch and then uses them for the spec and review stages.",
    parameters: z
      .object({
        docs: z.object({ spec: RelPath.optional(), architecture: RelPath.optional(), contract: RelPath.optional(), acceptance: RelPath.optional() }).strict().optional(),
        checks: z.record(z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/), z.object({ command: z.string().min(1).max(400), tier: z.enum(["local", "ci"]).optional(), category: z.string().max(40).optional(), timeoutSec: z.number().int().min(1).max(7200).optional() }).strict()).optional(),
        reason: z.string().max(600).optional(),
      })
      .strict(),
    presentation: { label: { pending: "Recording the existing documents", completed: "Recorded the existing documents" }, icon: { glyph: "FileText" } },
  },
  { name: "helm_record_check", description: "Record a check you ran through .helm/run-check.sh: name, command, exit code, the output file (reports/checks/<name>.txt) and the commit. Verified against the trailer.", parameters: z.object({ name: z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/), command: z.string().min(1).max(400), exitCode: z.number().int(), outputRef: z.string().min(1).max(300), commit: z.string().min(7).max(64) }).strict(), presentation: { label: { pending: "Recording a check", completed: "Recorded a check" }, icon: { glyph: "CircleCheck" } } },
  { name: "helm_slop_scan", description: "Run Helm's deterministic slop scanner on your branch (or the judged commit for gates) and return the findings.", parameters: z.object({ paths: z.array(z.string().max(400)).max(200).optional() }).strict(), presentation: { label: { pending: "Scanning for slop", completed: "Scanned for slop" }, icon: { glyph: "Search" } } },
  { name: "helm_verdict", description: "Your one verdict as a gate (schema in your skill): gate, appId, commit, verdict pass|fail, summary, checks[{id,ok,how,ref}], findings[{id,rule,severity,path,line,quote,why,fix}], unverified[]. Helm validates every quote at the commit.", parameters: VerdictSchema, presentation: { label: { pending: "Submitting the verdict", completed: "Submitted the verdict" }, icon: { glyph: "SecurityCheck" } } },
];

export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);

const TIER_NAME: Record<string, string> = {
  helm_world: "the Orchestrator, the Planner, the Git agent and the Fixer",
  helm_resolve: "the Orchestrator, Managers, App Leads and the Fixer",
  helm_installed: "the Git agent",
  helm_worktrees: "the Git agent",
  helm_consolidate: "the Git agent",
  helm_approve: "the Orchestrator, Managers and App Leads",
  helm_set_task: "the Orchestrator, Managers and App Leads",
  helm_direct: "the Orchestrator, Managers and App Leads",
  helm_models: "the Orchestrator, Managers, App Leads, the Planner and the Fixer",
  helm_set_model: "the Orchestrator, Managers, App Leads, the Planner and the Fixer",
  helm_create_agent: "the Planner",
  helm_rename_agent: "the Planner",
  helm_retire_agent: "the Planner",
  helm_propose_plan: "the Orchestrator",
  helm_propose_wave: "the Orchestrator",
  helm_set_priority: "the Orchestrator and Managers",
  helm_digest: "the Orchestrator and Managers",
  helm_spawn_squad: "App Leads",
  helm_publish_contract: "App Leads",
  helm_stage: "App Leads",
  helm_existing_docs: "App Leads",
  helm_assign_fix: "App Leads",
  helm_record_check: "App Leads and gates",
  helm_slop_scan: "App Leads, specialists and gates",
  helm_verdict: "gates (Reviewer, Slop Hunter)",
};

/** A refused or failed tool call, for `bb helm errors` (the agent sees the same text). */
function journalTool(e: Engine, node: NodeInfo, name: string, level: "user" | "error", text: string): void {
  try {
    e.repo.recordError({ level, source: "tool", at: `${name} by ${node.id}`, runId: node.runId, message: text.slice(0, 600) });
  } catch {
    /* never break the tool call */
  }
}

/** Tools whose result already carries the unread FYI lines (helm_context marks them read). */
const INBOX_FREE = new Set(["helm_context", "helm_digest", "helm_verdict"]);

export interface ToolResult {
  text: string;
  isError: boolean;
}

export type PlannerHandler = (threadId: string, portfolio: unknown) => Promise<string | null>;

/** Execute a tool for a thread. Authorization is the node row; arguments are validated here. */
export async function callTool(e: Engine, name: string, threadId: string, raw: unknown, opts: { planner?: PlannerHandler } = {}): Promise<ToolResult> {
  const def = TOOL_DEFS.find((t) => t.name === name);
  if (!def) return { text: `Unknown tool ${name}.`, isError: true };
  const parsed = def.parameters.safeParse(raw ?? {});
  if (!parsed.success) return { text: `Invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`, isError: true };
  const node = e.repo.nodeByThread(threadId);
  const watchRun = node ? null : watcherRun(e, threadId);
  if (watchRun) {
    if (name !== "helm_watch") return { text: "You are Helm's Watcher: helm_watch is your only tool.", isError: true };
    const run = e.repo.getRun(watchRun);
    if (!run || run.status === "cancelled" || run.status === "done") return { text: `The run is ${run?.status ?? "gone"}; stop now.`, isError: true };
    return { text: await applyVerdicts(e, watchRun, (parsed.data as { verdicts: Array<{ nodeId: string; verdict: WatchVerdict; note: string }> }).verdicts), isError: false };
  }
  if (name === "helm_watch") return { text: "helm_watch is for Helm's Watcher.", isError: true };
  if (!node) {
    if (PLANNER_TOOLS.includes(name) && opts.planner) {
      const r = await opts.planner(threadId, (parsed.data as { portfolio?: unknown }).portfolio);
      if (r !== null) return { text: r, isError: false };
    }
    return { text: "This thread is not a Helm agent, so Helm tools are not available here.", isError: true };
  }
  if (!toolsForNode(node.tier, node.alsoLead).includes(name)) return { text: `${name} is for ${TIER_NAME[name] ?? "another tier"}; you are ${e.label(node)}.`, isError: true };
  const run = e.repo.getRun(node.runId);
  if (!run || run.status === "cancelled" || run.status === "done") return { text: `The run is ${run?.status ?? "gone"}; stop now.`, isError: true };
  e.repo.updateNode(node.runId, node.id, { lastActivityAt: e.now(), nudgedAt: null });
  try {
    const text = await dispatch(e, node, name, parsed.data as Record<string, unknown>);
    const isError = text.startsWith("Rejected") || text.startsWith("No ");
    if (isError) journalTool(e, node, name, "user", text);
    // FYI lines ride along with the tool result the agent is already reading: no extra turn
    const fyi = INBOX_FREE.has(name) ? "" : e.takeInbox(node.runId, node.id);
    return { text: fyi ? `${text}\n\n${fyi}` : text, isError };
  } catch (err) {
    if (err instanceof HelmError) {
      journalTool(e, node, name, "user", err.message);
      return { text: err.message, isError: true };
    }
    e.log.error(`tool ${name} for ${node.id} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    return { text: `Helm could not complete ${name}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

async function dispatch(e: Engine, node: NodeInfo, name: string, p: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "helm_context":
      return context(e, node);
    case "helm_report":
      return report(e, node, p as never);
    case "helm_ack":
      return ack(e, node, String(p.directiveId), (p.note as string) ?? null);
    case "helm_need": {
      const routed = routeNeed(e, node, p);
      if (routed) return routed;
      const need = e.repo.tx(() => e.raiseNeed(node.runId, { kind: p.kind as "question", nodeId: node.id, appId: node.appId, title: String(p.title), body: String(p.body ?? ""), evidence: String(p.evidence ?? ""), options: (p.options as string[]) ?? [], dedupeKey: `need:${node.id}:${String(p.title).slice(0, 80)}`, setNodeNeeds: true }));
      return need ? `Created ${need.id} for the human. Keep working on what does not depend on it; the answer is sent to you.` : "You already asked this; the answer is sent to you.";
    }
    case "helm_resolve":
      return resolveCard(e, node, p as { needId: string; action: NeedResolution["action"]; text?: string; findings?: string[] });
    case "helm_install":
      return requestInstall(e, node, p as { what: string; why: string; where?: string });
    case "helm_installed":
      return recordInstall(e, node, p as { id: string; state: "done" | "failed" | "needs_human"; command?: string; note?: string });
    case "helm_message":
      return message(e, node, String(p.to), String(p.text), String(p.kind ?? "info"));
    case "helm_direct":
      return agentDirect(e, node, p as never);
    case "helm_models":
      return agentModels(e, node);
    case "helm_set_model":
      return agentSetModel(e, node, p.changes as ModelChange[], String(p.reason ?? ""));
    case "helm_create_agent":
      return createAgent(e, node, p);
    case "helm_rename_agent":
      return `Renamed: ${renameNode(e, node.runId, String(p.nodeId), String(p.name), e.label(node))}. Tell the human.`;
    case "helm_retire_agent":
      return retireAgent(e, node.runId, node, String(p.nodeId), String(p.reason));
    case "helm_world":
      return JSON.stringify(world(e, node.runId, { appsPage: p.appsPage as number | undefined }));
    case "helm_worktrees": {
      const app = p.app ? resolveApp(e, node.runId, String(p.app)) : undefined;
      let text = worktreesText(await appWorktrees(e, node.runId, { appId: app }));
      if (p.sizes) {
        const v = await worktreesViewFor(e).measureAndWait(node.runId);
        text += `\n\n## Space\n${worktreeSizesText({ ...v, apps: v.apps.filter((a) => !app || a.appId === app) })}`;
      }
      if (p.github) {
        const g = await githubViewFor(e).viewAndWait(node.runId);
        text += `\n\n## On GitHub\n${githubText({ ...g, apps: g.apps.filter((a) => !app || a.appId === app) })}`;
      }
      return text;
    }
    case "helm_consolidate":
      return consolidate(e, node.runId, resolveApp(e, node.runId, String(p.app)), e.label(node));
    case "helm_propose_plan":
      return proposePlan(e, node, p);
    case "helm_propose_wave":
      return proposeWave(e, node, p.appIds as string[], String(p.rationale ?? ""));
    case "helm_set_priority":
      return setPriority(e, node, p);
    case "helm_digest":
      return digest(e, node);
    case "helm_spawn_squad":
    {
      const spawn = (p.spawn ?? []) as Array<{ role: string; platform?: string | null; task?: string | null }>;
      const release = (p.release ?? []) as Array<{ role: string; platform?: string | null; reason: string }>;
      const out = [release.length ? releaseSquadMembers(e, node, release) : "", spawn.length ? await spawnSquad(e, node, spawn) : ""];
      return out.filter(Boolean).join("\n") || "Name at least one member to spawn or release.";
    }
    case "helm_publish_contract":
      return publishContract(e, node, Number(p.version), String(p.summary));
    case "helm_stage":
      return stageRequest(e, node, p.to as never, (p.evidence as never) ?? []);
    case "helm_assign_fix":
      return assignFix(e, node, String(p.findingId), String(p.nodeId));
    case "helm_set_task":
      return setTask(e, node, String(p.nodeId), String(p.task));
    case "helm_approve":
      return answerPrompt(e, node, String(p.promptId), p.decision as "allow" | "deny" | "escalate", String(p.reason), (n, i, note) => raiseInteractionNeed(e, n, i, note, "human"));
    case "helm_record_check":
      return recordCheck(e, node, p as never);
    case "helm_existing_docs":
      return declareExisting(e, node, p as never);
    case "helm_slop_scan":
      return slopScan(e, node, p.paths as string[] | undefined);
    case "helm_verdict":
      return verdict(e, node, p as never);
  }
  return `Unknown tool ${name}.`;
}

/** An app by id or name (case-insensitive). */
function resolveApp(e: Engine, runId: string, key: string): string {
  const apps = e.repo.listApps(runId);
  const k = key.trim().toLowerCase();
  const hit = apps.find((a) => a.id === key) ?? apps.find((a) => a.name.toLowerCase() === k || a.id.toLowerCase() === k);
  if (!hit) throw new HelmError(`No app "${key}" in this run. Apps: ${apps.map((a) => a.id).slice(0, 30).join(", ")}.`, "not_found");
  return hit.id;
}

function message(e: Engine, from: NodeInfo, to: string, text: string, kind: string): string {
  const target = e.repo.getNode(from.runId, to);
  if (!target) return `No node ${to}. Use ids from helm_context.`;
  // the Planner, the Git agent and the Fixer may talk to anyone; supervisors and custom agents may talk to them
  const side = (t: string) => t === "planner" || t === "git" || t === "fixer";
  const planner = side(from.tier) || (side(target.tier) && ["orchestrator", "manager", "lead", "custom", "planner", "git", "fixer"].includes(from.tier));
  const allowed = planner || target.id === from.parentId || target.parentId === from.id || (target.parentId === from.parentId && target.appId !== null && target.appId === from.appId);
  if (!allowed) return `Rejected: you can message your parent, your children and siblings in the same app. Route cross-app traffic through ${from.parentId ?? "the Orchestrator"}.`;
  let note = "";
  // a supervisor's questions upward are capped: decide inside your remit, batch the rest
  if (kind === "ask" && target.id === from.parentId && (from.tier === "lead" || from.tier === "manager") && e.autonomous(e.run(from.runId))) {
    const asked = e.repo.countComms(from.runId, from.id, target.id, "ask", e.now() - 3600_000);
    if (asked >= UPWARD_ASKS_PER_HOUR) {
      kind = "info";
      note = ` It went as FYI, not as a question: you already asked ${UPWARD_ASKS_PER_HOUR} questions this hour. Decide what is inside ${scopeName(e, from)} yourself and keep going; put what truly needs ${e.label(target)} into one message later, with your recommendation.`;
    } else note = ` (${asked + 1} of ${UPWARD_ASKS_PER_HOUR} questions this hour. Decide what is inside ${scopeName(e, from)} yourself.)`;
  }
  // the human made the Git agent's word on git final: every agent follows it
  const line =
    from.tier === "git"
      ? `Git rule from ${e.label(from)} (${from.id}, ${kind}), binding by the human's policy on branches, worktrees, merges and pushes: ${text}\nDo what it asks about git now; it outranks earlier instructions on git. If doing it would discard someone's uncommitted work, reply to it (helm_message to "git") with exactly what is in the way instead.`
      : `Message from ${e.label(from)} (${from.id}, ${kind}): ${text}${kind === "ask" ? `\nAnswer it with helm_message to "${from.id}": ${e.label(from)} sees only what you send that way, not what you write in your thread.` : ""}`;
  const asking = kind === "ask" && from.tier !== "git";
  e.repo.tx(() => {
    e.repo.comms(from.runId, { from: from.id, to: target.id, kind, summary: text.slice(0, 300) });
    // writing back answers the target's open question to this agent: Helm need not pass anything on
    e.repo.deleteMeta(askKey(from.runId, from.id, target.id));
    if (asking) e.repo.setMeta(askKey(from.runId, target.id, from.id), JSON.stringify({ state: "sending", at: e.now() }));
    // a Git rule is never a mere FYI: it reaches the agent now
    if (kind === "info" && from.tier !== "git") e.fyi(from.runId, target.id, line.slice(0, 800));
    else e.sendFromHelm(from.runId, target.id, line, { senderNodeId: from.id, kind: "message", commsKind: kind, key: `msg:${from.runId}:${from.id}:${target.id}:${e.now()}`, askFrom: asking ? from.id : undefined });
  });
  return (
    (kind === "info" && from.tier !== "git"
      ? `Delivered to ${e.label(target)} as FYI (it reads it on its next turn).`
      : asking
        ? `${!target.threadId ? `${e.label(target)} has not started; it sees your question when it does, and is told to answer with helm_message.` : `${target.status === "paused" ? `${e.label(target)} is paused; it gets your question when it is resumed.` : `Sent to ${e.label(target)}; it is woken to answer.`} Its answer comes to you as a message (Helm passes it on even if it replies only in its own thread).`} Until it answers you have no answer: do not tell anyone what it said.`
        : `Sent to ${e.label(target)}.`) + note
  );
}

const ABOUT_LABEL: Record<string, string> = { credentials: "Credentials", spending: "Spending", privacy: "Private data", access: "Access", owner: "Owner's call" };

/**
 * Autonomy is high: a question that is not about credentials, spending, privacy or access goes to
 * the asker's supervisor instead of the human; the Orchestrator decides it itself. Returns the tool
 * result when routed, or null when it should reach the human.
 */
function routeNeed(e: Engine, node: NodeInfo, p: Record<string, unknown>): string | null {
  const run = e.run(node.runId);
  let about = String(p.about ?? "other");
  const label = () => {
    if (about !== "other") p.title = `${ABOUT_LABEL[about] ?? about}: ${String(p.title)}`.slice(0, 200);
  };
  if (!e.autonomous(run) || node.tier === "planner") {
    label();
    return null;
  }
  // hands-off: the human hears only about keys and accounts, real spending and private data
  let note = "";
  if ((HUMAN_ONLY as readonly string[]).includes(about)) {
    if (humanTopic(`${String(p.title)} ${String(p.body ?? "")} ${String(p.evidence ?? "")}`)) {
      label();
      return null;
    }
    note = "Helm did not send this to the human: it names no key, login, account, payment or private data, and the human wants everything else decided without them. ";
    about = "other";
  }
  // the owner's call: the Orchestrator makes it from the brief; everyone else passes it up
  if (about === "owner" && node.tier === "orchestrator") about = "other";
  const supervisor = node.tier === "orchestrator" || node.tier === "manager" || node.tier === "lead";
  // the Git agent and custom agents without a supervisor ask the Orchestrator
  const parent = node.parentId ? e.repo.getNode(node.runId, node.parentId) : node.tier !== "orchestrator" ? e.repo.getNode(node.runId, ORCH_ID) : null;
  // a supervisor decides what is inside its own remit (a real company: managers manage)
  if ((about === "other" && supervisor) || !parent) {
    e.repo.event(node.runId, node.id, "decide", `kept a decision (autonomy): ${String(p.title).slice(0, 160)}`);
    return note + decideYourselfText(node.tier, scopeName(e, node));
  }
  const options = ((p.options as string[] | undefined) ?? []).length ? ` Options: ${(p.options as string[]).join(" / ")}.` : "";
  const what = `${p.kind === "approval" ? "Approval" : p.kind === "decision" ? "Decision" : "Question"} from ${e.label(node)} (${node.id}), sent to you instead of the human because autonomy is on: ${String(p.title)}. ${String(p.body ?? "")}${options}${p.evidence ? ` Evidence: ${String(p.evidence)}` : ""}`;
  const how =
    about === "owner"
      ? ` It says only the owner can answer. Answer it with helm_message (to ${node.id}) from the brief, PORTFOLIO.md or your notes${parent.tier === "orchestrator" ? "; if they do not settle it, choose what serves the brief best and record it under Decisions in PORTFOLIO.md" : "; if they do not settle it, pass it up with helm_need (about: owner)"}.`
      : ` Decide and answer with helm_message (to ${node.id}). It is inside your remit: do not pass it up unless it crosses into another app or group. Only a key, login or account, real spending or private data goes to the human (helm_need).`;
  e.repo.tx(() => {
    e.repo.comms(node.runId, { from: node.id, to: parent.id, kind: "ask", summary: `(instead of the human) ${String(p.title)}`.slice(0, 300) });
    e.sendFromHelm(node.runId, parent.id, (what + how).slice(0, 3000), { senderNodeId: node.id, kind: "message", commsKind: "ask", key: `ask:${node.runId}:${node.id}:${String(p.title).slice(0, 60)}` });
  });
  return `${note}Autonomy is on: sent to ${e.label(parent)}, who decides (not the human). Keep working on what does not depend on it; the answer arrives as a message.`;
}

/** helm_resolve: a supervisor decides a card Helm handed it instead of the human. */
async function resolveCard(e: Engine, node: NodeInfo, p: { needId: string; action: NeedResolution["action"]; text?: string; findings?: string[] }): Promise<string> {
  const need = e.repo.getNeed(node.runId, p.needId);
  if (!need) return `No card ${p.needId}.`;
  if (need.state !== "open") return `${need.id} is already decided; nothing to do.`;
  if (need.handler !== node.id) return need.handler === "human" || !need.handler ? `${need.id} waits for the human (a key, spending or private data); you cannot decide it.` : `${need.id} is for ${need.handler} to decide, not you.`;
  const acts = cardActions(need);
  if (!acts.includes(p.action) && p.action !== "dismiss") return `Rejected: ${need.id} takes ${acts.join(", ") || "only helm_set_model"}${need.kind === "model" ? " (pick its model with helm_set_model)" : ""}.`;
  const text = (p.text ?? "").trim();
  if (!text && ["sendback", "answer", "dismiss", "waive"].includes(p.action)) return `Rejected: ${p.action} needs text (${p.action === "answer" ? "the answer" : p.action === "sendback" ? "exactly what to fix" : "why"}).`;
  if (p.action === "waive" && !p.findings?.length) return "Rejected: name the findings to waive (findings).";
  try {
    const r = await resolveNeed(
      e,
      node.runId,
      need.id,
      { action: p.action, text, findingIds: p.findings, actor: "system", decidedBy: e.label(node) },
      { signoff: (appId, d) => signoff(e, node.runId, appId, d), sendback: (appId, d) => sendback(e, node.runId, appId, d) },
    );
    if (r.already) return r.already;
    e.repo.event(node.runId, node.id, "decide", `decided ${need.id} (${need.title.slice(0, 120)}): ${p.action}${text ? ` — ${text.slice(0, 160)}` : ""}`);
    return `${need.id}: ${p.action} done${r.directive ? ` (${r.directive.id})` : ""}. The human sees your decision and reason in the ledger.`;
  } catch (err) {
    return `Could not ${p.action} ${need.id}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** The remit a supervisor decides inside: its app, its group, or the run. */
function scopeName(e: Engine, n: NodeInfo): string {
  if (n.tier === "lead" && n.appId) return e.repo.getApp(n.runId, n.appId)?.name ?? "your app";
  if (n.tier === "manager") {
    const apps = e.repo.listApps(n.runId).filter((a) => a.managerNodeId === n.id).map((a) => a.name);
    return apps.length ? `your group (${apps.slice(0, 6).join(", ")}${apps.length > 6 ? ", …" : ""})` : "your group";
  }
  return n.tier === "orchestrator" ? "the run" : "your task";
}

/** Autonomy is high: approve a wave or plan change on the Orchestrator's behalf, on the record. */
async function autoApprove(e: Engine, runId: string, needId: string, what: string, by = "the Orchestrator"): Promise<void> {
  const noGate = async () => {
    throw new HelmError("not a sign-off", "bad_state");
  };
  await resolveNeed(e, runId, needId, { action: "approve", text: `${what} (approved by ${by}; autonomy is on)`, actor: "system" }, { signoff: noGate, sendback: noGate });
}

/** helm_create_agent: the Planner designs an agent; it joins through the plan-change flow (autonomy approves it at once). */
async function createAgent(e: Engine, node: NodeInfo, p: Record<string, unknown>): Promise<string> {
  let model = null;
  if (p.model) {
    const res = resolveModelWord(await e.catalog(e.repo.runHost(node.runId)), String(p.model));
    if ("problem" in res) return `Rejected: ${res.problem}`;
    model = res.ref;
  }
  const spec = buildSpec(e, node, { name: String(p.name), title: String(p.title), mission: String(p.mission), reportsTo: String(p.reportsTo), writes: p.writes as string[] | undefined, reads: p.reads as string[] | undefined, model, skills: p.skills as string[] | undefined, wakeOn: p.wakeOn as string[] | undefined, reason: p.reason as string | undefined });
  if (typeof spec === "string") return `Rejected: ${spec}`;
  const v = validateDelta(e, node.runId, { agents: [spec] });
  if (!v.ok) return `Rejected: ${v.error}`;
  const parent = e.node(node.runId, spec.parentId);
  const what = `New agent: ${spec.name} · ${spec.title} → reports to ${e.label(parent)}`;
  const need = e.repo.tx(() => e.raiseNeed(node.runId, { kind: "plan", nodeId: node.id, appId: spec.appId, title: what, body: `${spec.reason ? `${spec.reason}\n` : ""}Mission: ${spec.mission}`.slice(0, 1200), evidence: "", options: ["Approve new agent", "Deny"], dedupeKey: `agent:${spec.id}`, data: { delta: { agents: [spec] } } }));
  if (!need) return `Already proposed ${spec.name}; waiting for the human.`;
  const rename = `The human can rename it any time (ask you, or \`bb helm rename ${spec.id} "<name>"\`).`;
  if (!e.autonomous(e.run(node.runId))) return `Raised ${need.id}: the human approves ${spec.name} in Needs you; you will be told the outcome. ${rename}`;
  try {
    await autoApprove(e, node.runId, need.id, what, e.label(node));
  } catch (err) {
    return `Rejected while applying: ${err instanceof Error ? err.message : String(err)}`;
  }
  const made = e.repo.getNode(node.runId, spec.id);
  if (!made) return `Approved ${need.id}, but ${spec.name} was not created; check helm_world.`;
  const m = made.model ?? e.effectiveModel(e.run(node.runId), made);
  return `Created ${e.label(made)} (${made.id}), reporting to ${e.label(parent)}; ${made.status === "queued" ? "it starts now" : `it is ${made.status}`} on ${m ? `${m.providerId}/${m.modelId}${m.reasoning ? `:${m.reasoning}` : ""}` : "the default model"}${spec.wakeOn.length ? `, woken on ${spec.wakeOn.join(", ")}` : ""}. Its supervisor was told. Tell the human its name and job. ${rename}`;
}

function proposePlan(e: Engine, node: NodeInfo, p: Record<string, unknown>): string {
  const delta = p.delta as { add?: Array<z.infer<typeof AppZ>>; drop?: string[]; shapes?: Record<string, "solo" | "lean" | "full">; profiles?: Record<string, z.infer<typeof ProfileZ>>; rationale?: string } | undefined;
  if (!delta) return "Rejected: the Orchestrator proposes a delta (add / drop / shapes / profiles). A whole portfolio comes from the planner.";
  const add = delta.add?.length ? normalizePortfolio(PortfolioSchema.parse({ apps: delta.add })).apps : [];
  const profiles: Record<string, ProfileChange> = {};
  for (const [id, pr] of Object.entries(delta.profiles ?? {})) {
    const needs = pr.needs?.map(normalizeNeed);
    if (needs?.some((x) => !x)) return `Rejected: unknown need in ${id}: ${pr.needs!.filter((x) => !normalizeNeed(x)).join(", ")}. Known: ${PROJECT_NEEDS.join(", ")}.`;
    const tools = pr.tools?.map(normalizeTool);
    if (tools?.some((x) => !x)) return `Rejected: ${id} names a tool Helm cannot use: ${pr.tools!.filter((x) => !normalizeTool(x)).join(", ")}.`;
    profiles[id] = { ...(pr.kind ? { kind: pr.kind } : {}), ...(needs ? { needs: [...new Set(needs as ProjectNeed[])] } : {}), ...(tools ? { tools: [...new Set(tools as string[])] } : {}) };
  }
  const v = validateDelta(e, node.runId, { add, drop: delta.drop, shapes: delta.shapes, profiles });
  if (!v.ok) return `Rejected: ${v.error}`;
  // folders on the human's disk are the human's call: shown on the card and never approved on their behalf
  const folders = add.flatMap((a) => [...(a.path ? [`${a.name} works in ${a.path}`] : []), ...((a.reads ?? []).length ? [`${a.name} reads ${(a.reads ?? []).join(", ")}`] : [])]);
  const need = e.repo.tx(() => e.raiseNeed(node.runId, { kind: "plan", nodeId: node.id, appId: null, title: `Plan change: ${v.summary}`, body: `${delta.rationale ?? ""}\nAdds up to ${v.agents} agents (spawned lazily).${folders.length ? `\nFolders on your disk: ${folders.join("; ")}.` : ""}`.trim(), evidence: "", options: ["Approve plan change", "Deny"], dedupeKey: `delta:${v.summary}`, data: { delta: { add, drop: delta.drop ?? [], shapes: delta.shapes ?? {}, profiles } } }));
  if (need && folders.length) return `Valid. It names folders on the human's disk, so ${need.id} waits for the human even with autonomy on; you will be told the outcome.`;
  if (need && e.autonomous(e.run(node.runId))) {
    void autoApprove(e, node.runId, need.id, `Plan change: ${v.summary}`).catch((err: unknown) => e.log.error(`auto-approve ${need.id}: ${err instanceof Error ? err.message : String(err)}`));
    return `Valid. Autonomy is on, so ${need.id} is approved and applied now (on the record).`;
  }
  return need ? `Valid. Raised ${need.id} for the human; you will be told the outcome.` : "Already proposed; waiting for the human.";
}

function proposeWave(e: Engine, node: NodeInfo, appIds: string[], rationale: string): string {
  const apps = e.repo.listApps(node.runId);
  const bad = appIds.filter((id) => apps.find((a) => a.id === id)?.stage !== "intake");
  if (bad.length) return `Rejected: not in Intake: ${bad.join(", ")}.`;
  const run = e.run(node.runId);
  if (run.status !== "running") return `Rejected: the run is ${run.status}; waves start once it is running.`;
  if ((run.autoAdvance === "auto" || e.autonomous(run)) && !run.spawnsPaused) {
    // admitted on the human's behalf only up to the in-flight cap; the rest wait in Intake for a later wave
    const free = Math.max(0, inFlightCap(run.concurrency) - apps.filter((a) => isInFlight(a.stage)).length);
    const now = appIds.slice(0, free);
    if (!now.length) return `No room: ${inFlightCap(run.concurrency)} apps are already in flight. Helm proposes the next wave when one finishes.`;
    e.repo.tx(() => {
      for (const id of now) e.admitAppTx(node.runId, id, `wave proposed by the Orchestrator: ${rationale.slice(0, 120)}`);
    });
    e.fire(e.pump(node.runId), `pump ${node.runId}`);
    const later = appIds.slice(free);
    return `Admitted ${now.join(", ")} (${e.autonomous(run) ? "autonomy" : "auto-advance"} is on).${later.length ? ` ${later.join(", ")} wait in Intake: the in-flight cap is ${inFlightCap(run.concurrency)}.` : ""}`;
  }
  const need = e.repo.tx(() => e.raiseNeed(node.runId, { kind: "plan", nodeId: node.id, appId: null, title: `Start the next wave: ${appIds.map((id) => apps.find((a) => a.id === id)?.name ?? id).join(", ")}`, body: rationale, evidence: "", options: ["Approve wave", "Not yet"], dedupeKey: `wave:${appIds.join(",")}`, data: { appIds } }));
  return need ? `Raised ${need.id}; the human decides.` : "Already proposed.";
}

function setPriority(e: Engine, node: NodeInfo, p: Record<string, unknown>): string {
  const pr = String(p.priority);
  if (p.appId) {
    const app = e.repo.getApp(node.runId, String(p.appId));
    if (!app) return `No app ${p.appId}.`;
    if (node.tier === "manager" && app.managerNodeId !== node.id) return `Rejected: ${app.name} is not in your group.`;
    e.repo.tx(() => {
      e.repo.updateApp(node.runId, app.id, { priority: pr });
      e.repo.event(node.runId, node.id, "priority", `${app.name} → ${pr}: ${String(p.reason).slice(0, 120)}`);
    });
    e.fire(e.pump(node.runId), `pump ${node.runId}`);
    return `${app.name} priority is ${pr}.`;
  }
  if (p.nodeId) {
    const t = e.repo.getNode(node.runId, String(p.nodeId));
    if (!t) return `No node ${p.nodeId}.`;
    if (node.tier === "manager" && !(t.appId && e.repo.getApp(node.runId, t.appId)?.managerNodeId === node.id)) return "Rejected: that node is not in your group.";
    e.repo.updateNode(node.runId, t.id, { priority: pr });
    return `${e.label(t)} priority is ${pr}.`;
  }
  return "Rejected: give appId or nodeId.";
}

/** For tests and the planner: does a portfolio produce a valid topology? */
export function planCheck(e: Engine, portfolio: unknown): string | null {
  const parsed = PortfolioSchema.safeParse(portfolio);
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  const plan = planTopology(normalizePortfolio(parsed.data).apps, e.settings.limits);
  return plan.ok ? null : plan.error;
}
