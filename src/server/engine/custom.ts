// The Planner and the agents it designs. Every run has a Planner (Amer by default) beside the
// Orchestrator (Gestra): idle until the human or the Orchestrator writes to it, it answers
// questions and can add an agent that has never existed (a GitHub sync agent, a storage guard,
// a HIPAA reviewer) to report to any supervisor. Custom agents ride the plan-change flow
// (PlanDelta.agents), so autonomy, approval and the ledger work as for any plan change, and
// they are woken by events (stage changes, Ready, sign-off, failures) instead of polling.

import type { Catalog, ModelRef, NodeInfo, RunInfo, WakeEvent } from "../../shared/types.ts";
import { WAKE_EVENTS } from "../../shared/types.ts";
import { HelmError, type Engine } from "./engine.ts";
import { ORCH_ID, slugify } from "../domain/topology.ts";
import { CUSTOM_SKILLS, ROLES } from "../domain/roles.ts";
import { RW } from "../domain/models.ts";
import { looksLikePath } from "../domain/brief.ts";

export const PLANNER_ID = "planner";
/** At most this many custom agents alive in one run. */
export const MAX_CUSTOM = 12;

export interface CustomAgentSpec {
  id: string;
  name: string;
  title: string;
  mission: string;
  parentId: string;
  appId: string | null;
  writes: string[];
  reads: string[];
  model: ModelRef | null;
  skills: string[];
  wakeOn: WakeEvent[];
  createdBy: string;
  reason: string;
}

export interface CustomAgentInput {
  name: string;
  title: string;
  mission: string;
  reportsTo: string;
  writes?: string[];
  reads?: string[];
  model?: ModelRef | null;
  skills?: string[];
  wakeOn?: string[];
  reason?: string;
}

/** The name people see: its own, or the run's default for the Orchestrator and the Planner. */
export function nameOf(e: Engine, n: Pick<NodeInfo, "role"> & { name?: string | null }): string | null {
  if (n.name) return n.name;
  if (n.role === "orch") return e.settings.names.orchestrator;
  if (n.role === "planner") return e.settings.names.planner;
  return null;
}

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} .'’-]{0,39}$/u;

/** A problem with a new name for `exceptId` (null when it is fine). */
export function nameProblem(e: Engine, runId: string, name: string, exceptId: string | null = null): string | null {
  const n = name.trim();
  if (!NAME_RE.test(n)) return `"${name}" is not a usable name: 1–40 letters, digits, spaces, dots, apostrophes or dashes, starting with a letter or digit.`;
  const taken = e.repo.listNodes(runId).find((x) => x.id !== exceptId && x.status !== "done" && nameOf(e, x)?.toLowerCase() === n.toLowerCase());
  return taken ? `${n} is already the name of ${e.label(taken)} (${taken.id}); choose another.` : null;
}

function cleanGlobs(globs: string[]): string[] | string {
  const out: string[] = [];
  for (const g of globs.slice(0, 10)) {
    const t = g.trim();
    if (!t) continue;
    if (t.startsWith("/") || t.startsWith("~") || /^[A-Za-z]:/.test(t) || t.split(/[\\/]/).includes("..")) return `write scope "${g}" must be a relative path inside the agent's workspace (no absolute paths, no "..")`;
    out.push(t.slice(0, 200));
  }
  return out;
}

/** Validate a Planner's design and turn it into a spec Helm can apply. Returns an error string or the spec. */
export function buildSpec(e: Engine, by: NodeInfo, input: CustomAgentInput, taken: Set<string> = new Set()): CustomAgentSpec | string {
  const runId = by.runId;
  const run = e.run(runId);
  if (run.status === "done" || run.status === "cancelled") return `The run is ${run.status}.`;
  const name = input.name.trim();
  const np = nameProblem(e, runId, name);
  if (np) return np;
  if (taken.has(name.toLowerCase())) return `Two new agents are both called ${name}.`;
  const title = input.title.trim().slice(0, 60);
  if (title.length < 2) return "Give the agent a job title (e.g. GitHub Sync, Storage Guard).";
  const mission = input.mission.trim();
  if (mission.length < 40) return "The mission is too short: say what it does, when, what done looks like and what it must never do.";
  const parent = e.repo.getNode(runId, input.reportsTo);
  if (!parent) return `No agent ${input.reportsTo} to report to. Use an id from helm_world (orch, a manager, or an app lead).`;
  if (!(parent.tier === "orchestrator" || parent.tier === "manager" || parent.tier === "lead")) return `${e.label(parent)} cannot supervise agents: report to the Orchestrator (orch), a manager or an app lead.`;
  if (parent.status === "done") return `${e.label(parent)} is done; choose another supervisor.`;
  const appId = parent.tier === "lead" ? parent.appId : parent.alsoLead ? e.repo.listApps(runId)[0]?.id ?? null : null;
  const app = appId ? e.repo.getApp(runId, appId) : null;
  if (app && (app.stage === "done" || app.stage === "cancelled")) return `${app.name} is ${app.stage}; its team takes no new agents.`;
  const alive = e.repo.listNodes(runId).filter((n) => n.role === "custom" && n.status !== "done").length + taken.size;
  if (alive >= MAX_CUSTOM) return `This run already has ${alive} custom agents (the limit is ${MAX_CUSTOM}). Retire one first.`;
  const slug = slugify(name) || "agent";
  const ids = new Set(e.repo.listNodes(runId).map((n) => n.id));
  let id = appId ? `${appId}.x-${slug}` : `x-${slug}`;
  for (let k = 2; ids.has(id); k++) id = appId ? `${appId}.x-${slug}-${k}` : `x-${slug}-${k}`;
  const writes = cleanGlobs(input.writes?.length ? input.writes : [appId ? `reports/${slug}/**` : `agents/${slug}/**`]);
  if (typeof writes === "string") return writes;
  const reads = (input.reads ?? []).map((r) => r.trim()).filter(Boolean).slice(0, 10);
  const badRead = reads.find((r) => !looksLikePath(r));
  if (badRead) return `read-only folder "${badRead}" must be an absolute path (/…, ~/… or a drive letter).`;
  const skills = [...new Set(input.skills ?? [])];
  const badSkill = skills.find((s) => !CUSTOM_SKILLS.includes(s));
  if (badSkill) return `No craft skill ${badSkill}. Choose from: ${CUSTOM_SKILLS.join(", ")}.`;
  if (skills.length > 4) return "At most 4 craft skills per agent.";
  const wakeOn = [...new Set(input.wakeOn ?? [])];
  const badWake = wakeOn.find((w) => !(WAKE_EVENTS as string[]).includes(w));
  if (badWake) return `Unknown wake event ${badWake}. Use: ${WAKE_EVENTS.join(", ")}.`;
  return { id, name, title, mission: mission.slice(0, 4000), parentId: parent.id, appId, writes, reads, model: input.model ?? null, skills, wakeOn: wakeOn as WakeEvent[], createdBy: by.id, reason: (input.reason ?? "").trim().slice(0, 400) };
}

/** Re-check a stored spec when it is applied (the run may have changed while it waited for approval). */
export function recheckSpec(e: Engine, runId: string, s: CustomAgentSpec): string | null {
  const np = nameProblem(e, runId, s.name);
  if (np) return np;
  const parent = e.repo.getNode(runId, s.parentId);
  if (!parent || parent.status === "done") return `${s.parentId} is gone or done.`;
  if (e.repo.getNode(runId, s.id)) return `${s.id} already exists.`;
  return null;
}

/** Create the agents of an approved plan change (inside a transaction). */
export function applyAgentsTx(e: Engine, runId: string, specs: CustomAgentSpec[]): string[] {
  const run = e.run(runId);
  const made: string[] = [];
  for (const s of specs) {
    const problem = recheckSpec(e, runId, s);
    if (problem) throw new HelmError(`Cannot add ${s.name}: ${problem}`, "invalid_plan");
    e.repo.insertNode({
      runId,
      id: s.id,
      appId: s.appId,
      tier: "custom",
      role: "custom",
      platform: null,
      parentId: s.parentId,
      slot: "code",
      alsoLead: false,
      model: s.model ?? run.slots.code ?? null,
      modelOverride: !!s.model,
      scopeGlobs: s.writes,
      branch: null,
      briefMd: null,
      name: s.name,
      title: s.title,
      charter: s.mission,
      wakeOn: s.wakeOn,
      createdBy: s.createdBy,
    });
    e.repo.setMeta(`custom:${runId}:${s.id}`, JSON.stringify({ reads: s.reads, skills: s.skills, reason: s.reason }));
    if (run.status === "running") e.repo.updateNode(runId, s.id, { status: "queued", firstInLine: true });
    const node = e.repo.getNode(runId, s.id)!;
    const by = e.repo.getNode(runId, s.createdBy);
    const parent = e.repo.getNode(runId, s.parentId)!;
    const who = by ? e.label(by) : "the Planner";
    e.repo.event(runId, s.id, "created", `designed by ${who}: ${s.title}${s.reason ? ` (${s.reason.slice(0, 160)})` : ""}`);
    e.repo.comms(runId, { from: s.createdBy, to: s.id, kind: "spawn", summary: `${who} → ${e.label(node)}: created to report to ${e.label(parent)}` });
    e.fyi(runId, parent.id, `${e.label(node)} (${s.id}) joined your team, designed by ${who}. Mission: ${s.mission.slice(0, 300)}${s.mission.length > 300 ? "…" : ""} It reports to you: read its reports, steer it with helm_direct, replace its task with helm_set_task, and ask ${who} to retire it when it stops being useful.`);
    if (parent.id !== ORCH_ID) e.fyi(runId, ORCH_ID, `${who} added ${e.label(node)} (${s.id}) under ${e.label(parent)}: ${s.title}.`);
    made.push(s.id);
  }
  return made;
}

export function customMeta(e: Engine, runId: string, nodeId: string): { reads: string[]; skills: string[]; reason: string } {
  try {
    const v = JSON.parse(e.repo.getMeta(`custom:${runId}:${nodeId}`) ?? "{}") as { reads?: string[]; skills?: string[]; reason?: string };
    return { reads: v.reads ?? [], skills: v.skills ?? [], reason: v.reason ?? "" };
  } catch {
    return { reads: [], skills: [], reason: "" };
  }
}

/** The title of an agent's BB thread. */
export function threadTitle(e: Engine, run: RunInfo, n: NodeInfo): string {
  return n.role === "orch" || n.role === "planner" ? `${e.label(n)} · ${run.name}` : e.label(n);
}

/** Rename any agent (the human, or the Planner on the human's word). Its BB thread title follows. */
export function renameNode(e: Engine, runId: string, nodeId: string, name: string, actor: string): string {
  const n = e.repo.getNode(runId, nodeId);
  if (!n) throw new HelmError(`No agent ${nodeId}.`, "not_found");
  const clean = name.trim();
  const problem = nameProblem(e, runId, clean, n.id);
  if (problem) throw new HelmError(problem, "invalid_value");
  const before = e.label(n);
  e.repo.tx(() => {
    e.repo.updateNode(runId, n.id, { name: clean });
    e.repo.event(runId, n.id, "renamed", `${before} → ${clean} (by ${actor})`);
  });
  const after = e.repo.getNode(runId, n.id)!;
  if (after.threadId) void e.port.updateThread({ threadId: after.threadId, title: threadTitle(e, e.run(runId), after) }).catch((err: unknown) => e.log.warn(`rename ${n.id}: ${err instanceof Error ? err.message : String(err)}`));
  e.emit(runId, "node.updated", after);
  return e.label(after);
}

/** Stop a custom agent for good. The Planner may retire any; a supervisor only those below it. */
export function retireAgent(e: Engine, runId: string, by: NodeInfo | null, nodeId: string, reason: string): string {
  const n = e.repo.getNode(runId, nodeId);
  if (!n) return `No agent ${nodeId}.`;
  if (n.role !== "custom") return `Rejected: only custom agents can be retired; ${e.label(n)} is part of the plan (change the plan with helm_propose_plan instead).`;
  if (n.status === "done") return `${e.label(n)} is already retired.`;
  if (by && by.tier !== "planner") {
    let cur = n.parentId;
    let above = false;
    while (cur) {
      if (cur === by.id) above = true;
      cur = e.repo.getNode(runId, cur)?.parentId ?? null;
    }
    if (!above) return `Rejected: ${e.label(n)} is not below you.`;
  }
  const why = reason.trim().slice(0, 300) || "no longer needed";
  e.repo.tx(() => {
    e.repo.updateNode(runId, n.id, { status: "done", endedAt: e.now(), warning: `retired: ${why}` });
    e.repo.event(runId, n.id, "retired", `${by ? e.label(by) : "the human"}: ${why}`);
    if (n.threadId) {
      e.repo.enqueue({ id: e.oid(), runId, kind: "stop", nodeId: n.id, payload: { nodeIds: [n.id] }, idemKey: `retire-stop:${runId}:${n.id}` });
      e.repo.enqueue({ id: e.oid(), runId, kind: "archive", nodeId: n.id, payload: { nodeIds: [n.id] }, idemKey: `retire-archive:${runId}:${n.id}` });
    }
    if (n.parentId && n.parentId !== by?.id) e.fyi(runId, n.parentId, `${e.label(n)} was retired by ${by ? e.label(by) : "the human"}: ${why}.`);
  });
  e.emit(runId, "node.updated", e.repo.getNode(runId, n.id));
  e.outbox.kick();
  return `${e.label(n)} retired (${why}); its thread is stopped and archived.`;
}

/** Wake the custom agents that asked for this event, in their scope. Never wakes a stopped, paused or unspawned agent. */
export function wakeCustom(e: Engine, runId: string, kind: WakeEvent, appId: string | null, text: string): void {
  const nodes = e.repo.listNodes(runId).filter((n) => n.role === "custom" && n.wakeOn.includes(kind) && n.threadId && ["running", "waiting"].includes(n.status));
  if (!nodes.length) return;
  const app = appId ? e.repo.getApp(runId, appId) : null;
  for (const n of nodes) {
    const inScope = !appId || n.appId === appId || (!n.appId && (n.parentId === ORCH_ID || (!!app && app.managerNodeId === n.parentId)));
    if (!inScope) continue;
    e.sendFromHelm(runId, n.id, `Helm wake-up (${kind}): ${text}. Do what your mission says for this, report with helm_report, then stop.`, { key: `wake:${runId}:${n.id}:${kind}:${appId ?? "-"}:${e.now()}` });
  }
}

/** The Planner's model: its slot, else the strongest model on the Orchestrator's provider at its highest reasoning. */
export function plannerModel(run: RunInfo, cat: Catalog | null): ModelRef | null {
  if (run.slots.planner) return run.slots.planner;
  const base = run.slots.orchestrator ?? run.slots.lead ?? null;
  if (!cat) return base;
  const live = cat.models.filter((m) => !m.hidden && cat.providers.find((p) => p.id === m.providerId)?.available);
  const same = live.filter((m) => !base || m.providerId === base.providerId);
  const pool = same.length ? same : live;
  if (!pool.length) return base;
  const best = [...pool].sort((a, b) => b.weight - a.weight || Number(b.isDefault) - Number(a.isDefault))[0];
  const levels = [...best.reasoning].sort((a, b) => (RW[b] ?? 1) - (RW[a] ?? 1));
  return { providerId: best.providerId, modelId: best.modelId, reasoning: levels[0] ?? best.defaultReasoning ?? null };
}

/** Make sure the run has its Planner; queue it when the run is running and `queue` is set. Returns the node. */
export async function ensurePlanner(e: Engine, runId: string, opts: { queue?: boolean; catalog?: Catalog | null } = {}): Promise<NodeInfo> {
  const run = e.run(runId);
  let n = e.repo.getNode(runId, PLANNER_ID);
  if (!n) {
    const cat = opts.catalog !== undefined ? opts.catalog : await e.catalog(e.repo.runHost(runId)).catch(() => null);
    const model = plannerModel(run, cat);
    e.repo.tx(() => {
      e.repo.insertNode({ runId, id: PLANNER_ID, appId: null, tier: "planner", role: "planner", platform: null, parentId: null, slot: "planner", alsoLead: false, model, modelOverride: !run.slots.planner && !!model, scopeGlobs: ROLES.planner.scope, branch: null, briefMd: null, name: e.settings.names.planner });
      e.repo.event(runId, PLANNER_ID, "created", `the run's Planner, on ${model ? `${model.providerId}/${model.modelId}${model.reasoning ? `:${model.reasoning}` : ""}` : "no model yet"}`);
    });
    n = e.repo.getNode(runId, PLANNER_ID)!;
    e.emit(runId, "node.updated", n);
  }
  if (opts.queue && run.status === "running" && !n.threadId && (n.status === "planned" || n.status === "idle")) {
    e.repo.updateNode(runId, n.id, { status: "queued", firstInLine: true, warning: null });
    await e.pump(runId);
    n = e.repo.getNode(runId, PLANNER_ID)!;
  }
  return n;
}
