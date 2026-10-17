// The helm_* agent tools (§8.1). Registered once; exposed per tier by
// agents.configure (a hint). Every execute re-authorizes from the nodes row:
// tier, identity, parent and app come from the database, never from metadata
// or arguments (§8.2, V12).

import { z } from "zod";
import type { Engine } from "../engine/engine.ts";
import { HelmError } from "../engine/engine.ts";
import type { NodeInfo } from "../../shared/types.ts";
import { toolsForNode, PLANNER_TOOLS } from "../domain/roles.ts";
import { PortfolioSchema, normalizePortfolio } from "../domain/brief.ts";
import { VerdictSchema } from "../domain/verdict.ts";
import { ack } from "../engine/direct.ts";
import { assignFix, declareExisting, publishContract, recordCheck, releaseSquadMembers, report, slopScan, spawnSquad, stageRequest, verdict } from "../engine/gates.ts";
import { context, digest, world } from "../engine/world.ts";
import { validateDelta } from "../engine/delta.ts";
import { planTopology } from "../domain/topology.ts";

const Evidence = z.object({ kind: z.enum(["commit", "file", "check", "report"]), ref: z.string().min(1).max(300), branch: z.string().max(200).optional() });
const StageZ = z.enum(["intake", "spec", "build", "integrate", "review", "slop", "fix", "ready", "done"]);
const RelPath = z.string().min(1).max(300).refine((s) => !s.startsWith("/") && !s.startsWith("-") && !s.split(/[\\/]/).includes(".."), "a path inside the repository");

const AppZ = z.object({ name: z.string().min(1).max(60), tagline: z.string().max(160).default(""), platforms: z.array(z.string()).max(4).default([]), group: z.string().max(60).nullish(), shape: z.enum(["solo", "lean", "full"]).optional(), notes: z.string().max(1200).nullish(), path: z.string().trim().min(1).max(500).nullish(), reads: z.array(z.string().trim().min(1).max(500)).max(10).optional() });

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
    description: "Ask the human something only they can decide (question|approval|decision). Creates a Needs-you item; then stop and wait — the answer will be sent to you.",
    parameters: z.object({ kind: z.enum(["question", "approval", "decision"]), title: z.string().min(1).max(200), body: z.string().max(1200), options: z.array(z.string().max(80)).max(6).optional(), evidence: z.string().max(600).optional() }).strict(),
    presentation: { label: { pending: "Asking the human", completed: "Asked the human" }, icon: { glyph: "MessageQuestion" } },
  },
  {
    name: "helm_message",
    description: "Message your parent, a child, or a sibling in the same app (kind info|ask|handoff). Cross-app traffic goes up through your manager or the Orchestrator.",
    parameters: z.object({ to: z.string().min(1).max(80), text: z.string().min(1).max(2000), kind: z.enum(["info", "ask", "handoff"]).default("info") }).strict(),
    presentation: { label: { pending: "Sending a message", completed: "Sent a message" }, icon: { glyph: "MessageSquare" } },
  },
  { name: "helm_world", description: "The whole run from Helm's database: stages, needs, recent human directives with receipts, touched agents, policies, managers and apps. Always current.", parameters: z.object({ appsPage: z.number().int().min(0).max(20).optional() }).strict(), presentation: { label: { pending: "Reading world state", completed: "Read world state" }, icon: { glyph: "Globe" } } },
  {
    name: "helm_propose_plan",
    description: "Propose a portfolio (planner) or a plan delta (Orchestrator: add apps, drop apps, change shapes). Helm validates it and asks the human.",
    parameters: z.object({ portfolio: PortfolioSchema.optional(), delta: z.object({ add: z.array(AppZ).max(20).optional(), drop: z.array(z.string()).max(20).optional(), shapes: z.record(z.string(), z.enum(["solo", "lean", "full"])).optional(), rationale: z.string().max(600).optional() }).strict().optional() }).strict(),
    presentation: { label: { pending: "Proposing a plan", completed: "Proposed a plan" }, icon: { glyph: "ListTodo" } },
  },
  { name: "helm_propose_wave", description: "Propose which Intake apps to start next and why.", parameters: z.object({ appIds: z.array(z.string()).min(1).max(20), rationale: z.string().max(600) }).strict(), presentation: { label: { pending: "Proposing a wave", completed: "Proposed a wave" }, icon: { glyph: "Layers" } } },
  { name: "helm_set_priority", description: "Set an app's or node's priority (low|normal|high). Managers only within their group.", parameters: z.object({ appId: z.string().optional(), nodeId: z.string().optional(), priority: z.enum(["low", "normal", "high"]), reason: z.string().max(300) }).strict(), presentation: { label: { pending: "Setting priority", completed: "Set priority" }, icon: { glyph: "Sort" } } },
  { name: "helm_digest", description: "Rolled-up state of the apps under you, plus FYI lines you have not read.", parameters: z.object({}).strict(), presentation: { label: { pending: "Reading digest", completed: "Read digest" }, icon: { glyph: "AlignLeft" } } },
  {
    name: "helm_spawn_squad",
    description: "Ask Helm to start squad members of your app's plan (role ui|code|platform|security|test, platform for platform builders). Helm checks shape, lead span and caps; returns accepted / deferred with reasons. Use `release` (with a reason) for members your SPEC no longer needs: Helm stops them and does not wait for them at Integrate.",
    parameters: z
      .object({
        spawn: z.array(z.object({ role: z.enum(["ui", "code", "platform", "security", "test", "research", "docs"]), platform: z.enum(["mac", "win", "ios", "and"]).nullish() })).max(12).default([]),
        release: z.array(z.object({ role: z.enum(["ui", "code", "platform", "security", "test", "research", "docs"]), platform: z.enum(["mac", "win", "ios", "and"]).nullish(), reason: z.string().min(1).max(300) })).max(12).default([]),
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
  helm_world: "the Orchestrator",
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
    return { text, isError: text.startsWith("Rejected") || text.startsWith("No ") };
  } catch (err) {
    if (err instanceof HelmError) return { text: err.message, isError: true };
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
      const need = e.repo.tx(() => e.raiseNeed(node.runId, { kind: p.kind as "question", nodeId: node.id, appId: node.appId, title: String(p.title), body: String(p.body ?? ""), evidence: String(p.evidence ?? ""), options: (p.options as string[]) ?? [], dedupeKey: `need:${node.id}:${String(p.title).slice(0, 80)}`, setNodeNeeds: true }));
      return need ? `Created ${need.id}. Stop and wait; the answer will be sent to you.` : "You already asked this; stop and wait for the answer.";
    }
    case "helm_message":
      return message(e, node, String(p.to), String(p.text), String(p.kind ?? "info"));
    case "helm_world":
      return JSON.stringify(world(e, node.runId, { appsPage: p.appsPage as number | undefined }));
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
      const spawn = (p.spawn ?? []) as Array<{ role: string; platform?: string | null }>;
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

function message(e: Engine, from: NodeInfo, to: string, text: string, kind: string): string {
  const target = e.repo.getNode(from.runId, to);
  if (!target) return `No node ${to}. Use ids from helm_context.`;
  const allowed = target.id === from.parentId || target.parentId === from.id || (target.parentId === from.parentId && target.appId !== null && target.appId === from.appId);
  if (!allowed) return `Rejected: you can message your parent, your children and siblings in the same app. Route cross-app traffic through ${from.parentId ?? "the Orchestrator"}.`;
  const line = `Message from ${e.label(from)} (${from.id}, ${kind}): ${text}`;
  e.repo.tx(() => {
    e.repo.comms(from.runId, { from: from.id, to: target.id, kind, summary: text.slice(0, 300) });
    if (kind === "info") e.fyi(from.runId, target.id, line.slice(0, 800));
    else e.sendFromHelm(from.runId, target.id, line, { senderNodeId: from.id, kind: "message", commsKind: kind, key: `msg:${from.runId}:${from.id}:${target.id}:${e.now()}` });
  });
  return kind === "info" ? `Delivered to ${e.label(target)} as FYI (it reads it on its next turn).` : `Sent to ${e.label(target)}.`;
}

function proposePlan(e: Engine, node: NodeInfo, p: Record<string, unknown>): string {
  const delta = p.delta as { add?: Array<z.infer<typeof AppZ>>; drop?: string[]; shapes?: Record<string, "solo" | "lean" | "full">; rationale?: string } | undefined;
  if (!delta) return "Rejected: the Orchestrator proposes a delta (add / drop / shapes). A whole portfolio comes from the planner.";
  const add = delta.add?.length ? normalizePortfolio(PortfolioSchema.parse({ apps: delta.add })).apps : [];
  const v = validateDelta(e, node.runId, { add, drop: delta.drop, shapes: delta.shapes });
  if (!v.ok) return `Rejected: ${v.error}`;
  const need = e.repo.tx(() => e.raiseNeed(node.runId, { kind: "plan", nodeId: node.id, appId: null, title: `Plan change: ${v.summary}`, body: `${delta.rationale ?? ""}\nAdds up to ${v.agents} agents (spawned lazily).`.trim(), evidence: "", options: ["Approve plan change", "Deny"], dedupeKey: `delta:${v.summary}`, data: { delta: { add, drop: delta.drop ?? [], shapes: delta.shapes ?? {} } } }));
  return need ? `Valid. Raised ${need.id} for the human; you will be told the outcome.` : "Already proposed; waiting for the human.";
}

function proposeWave(e: Engine, node: NodeInfo, appIds: string[], rationale: string): string {
  const apps = e.repo.listApps(node.runId);
  const bad = appIds.filter((id) => apps.find((a) => a.id === id)?.stage !== "intake");
  if (bad.length) return `Rejected: not in Intake: ${bad.join(", ")}.`;
  const run = e.run(node.runId);
  if (run.autoAdvance === "auto" && !run.spawnsPaused) {
    e.repo.tx(() => {
      for (const id of appIds) e.admitAppTx(node.runId, id, `wave proposed by the Orchestrator: ${rationale.slice(0, 120)}`);
    });
    void e.pump(node.runId);
    return `Admitted ${appIds.join(", ")} (auto-advance is on).`;
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
    void e.pump(node.runId);
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
