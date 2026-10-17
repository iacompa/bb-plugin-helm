// Directives (§6) and Needs-you resolution (§9.7). A directive is recorded,
// applied and fanned out to every recipient in ONE transaction, so the
// Orchestrator's world state can never be stale about what the human changed.

import type { Cascade, DirectiveInfo, DirectiveType, ModelRef, NodeInfo, SlotId, SlotMap } from "../../shared/types.ts";
import { HelmError, type Engine } from "./engine.ts";
import { AGENT_ACTIONS, agentNoticeText, agentSummary, bottomUp, buildAgentRecipients, buildRecipients, deliveryModeFor, directiveSummary, noticeFor, resolveCascade, steerProblem, touches, type AgentAction, type NoticeDirective } from "../domain/directives.ts";
import { modelName, validateRef } from "../domain/models.ts";
import { hhmm, pad4 } from "./context.ts";
import { waiverProblem } from "../domain/verdict.ts";
import { appMoveRule, stagePct, taskMoveRule, type TaskCol } from "../domain/stages.ts";
import { ORCH_ID } from "../domain/topology.ts";
import type { InteractionAnswer } from "../bb/port.ts";
import { applyDelta, type PlanDelta } from "./delta.ts";
import { completeRun } from "./gates.ts";

export interface DirectiveInput {
  type: DirectiveType;
  target: string;
  cascade?: Cascade;
  mode?: "steer" | "queue";
  policy?: boolean;
  text?: string;
  value?: unknown;
  modelTo?: ModelRef | null;
  actor?: "human" | "system";
  implicit?: boolean;
  needId?: string;
  findingIds?: string[];
  slots?: SlotMap;
  slotsScope?: "future" | "all";
  /** For waivers of S6: "I have rotated this credential". */
  rotatedConfirmed?: boolean;
  /** A supervisor steering someone below it (helm_direct); validated by agentDirect. */
  byNode?: string;
}

const SELF_ONLY: DirectiveType[] = ["approve", "deny", "answer", "plan", "signoff", "sendback", "waive", "slots", "spawn"];
const TERMINAL = new Set(["done", "idle", "failed"]);
/** Warnings reconcile and the event handler write when a node's thread no longer exists for Helm. */
const THREAD_GONE = /thread missing|archived outside Helm/;
const NO_ACK = new Set(["stop", "pause"]);

export async function previewDirective(e: Engine, runId: string, input: Pick<DirectiveInput, "type" | "target" | "cascade">) {
  const tree = e.tree(runId);
  if (!tree.has(input.target)) throw new HelmError(`No node ${input.target}.`, "not_found");
  const cascade = SELF_ONLY.includes(input.type) ? "self" : input.cascade ?? "self";
  const affected = resolveCascade(tree, input.target, cascade);
  const recipients = buildRecipients(tree, affected);
  const nodes = new Map(e.repo.listNodes(runId).map((n) => [n.id, n]));
  const run = e.run(runId);
  const readCostK = recipients.reduce((s, r) => s + (r.level === "digest" ? 0.2 : 2.5), 0);
  const units = recipients.reduce((s, r) => {
    const n = nodes.get(r.id);
    const w = n?.model ? (e.settings.weights[n.model.modelId] ?? 1) : 1;
    return s + (r.level === "digest" ? 0.2 : 2.5) * w * 0.0075;
  }, 0);
  return {
    affected,
    recipients: recipients.map((r) => ({ ...r, label: nodes.get(r.id) ? e.label(nodes.get(r.id)!) : r.id, hasThread: !!nodes.get(r.id)?.threadId, status: nodes.get(r.id)?.status ?? "planned" })),
    counts: { direct: recipients.filter((r) => r.level === "direct").length, full: recipients.filter((r) => r.level === "full").length, digest: recipients.filter((r) => r.level === "digest").length },
    readCostK,
    units,
    runStatus: run.status,
  };
}

/** Record, apply and deliver a directive. Returns the stored directive. */
export async function createDirective(e: Engine, runId: string, input: DirectiveInput): Promise<DirectiveInfo> {
  const run = e.run(runId);
  const target = e.node(runId, input.target);
  const type = input.type;
  const by = input.byNode ? e.node(runId, input.byNode) : null;
  if (by && !(AGENT_ACTIONS as readonly string[]).includes(type)) throw new HelmError(`Supervisors cannot ${type}; only the human can.`, "invalid_value");
  const cascade: Cascade = by || SELF_ONLY.includes(type) ? "self" : input.cascade ?? "self";
  const text = (input.text ?? "").trim();
  const actor = by ? "agent" : input.actor ?? "human";
  const humanMode = input.mode ?? "steer";

  // validation that needs I/O happens before the transaction
  if (type === "model") {
    if (!input.modelTo) throw new HelmError("A model change needs a model.", "invalid_value");
    const cat = await e.catalog(e.repo.runHost(runId));
    const p = validateRef(cat, input.modelTo);
    if (p) throw new HelmError(p.message, "invalid_value");
  }
  if (type === "tell" && !text) throw new HelmError("A message needs text.", "invalid_value");
  if (type === "sendback" && !text) throw new HelmError("Send back needs a reason.", "invalid_value");
  if (type === "priority" && !["low", "normal", "high"].includes(String(input.value))) throw new HelmError("Priority must be low, normal or high.", "invalid_value");
  if (type === "waive") {
    const ids = input.findingIds ?? [];
    if (!ids.length) throw new HelmError("Name the findings to waive.", "invalid_value");
    for (const id of ids) {
      const f = e.repo.getFinding(runId, id);
      if (!f) throw new HelmError(`No finding ${id}.`, "not_found");
      const p = waiverProblem({ rule: f.rule, reason: text, actor: actor === "human" ? "human" : "lead", rotatedConfirmed: input.rotatedConfirmed });
      if (p) throw new HelmError(p, "invalid_value");
    }
  }
  const cat = await e.catalog(e.repo.runHost(runId)).catch(() => null);
  const mname = (r: ModelRef | null | undefined) => modelName(cat, r);

  const out = e.repo.tx(() => {
    const seq = e.repo.nextSeq(runId, "directive");
    const id = `D-${pad4(seq)}`;
    const ts = e.now();
    const tree = e.tree(runId);
    const affected = resolveCascade(tree, target.id, cascade);
    const recipients = by ? buildAgentRecipients(tree, by.id, target.id) : buildRecipients(tree, affected);
    const nodes = new Map(e.repo.listNodes(runId).map((n) => [n.id, n]));
    let modelFrom: ModelRef | null = null;
    let briefVersion = target.briefVersion;
    const follow: Array<() => void> = [];

    // ── effects ──
    switch (type) {
      case "model": {
        modelFrom = target.model;
        for (const nid of affected) {
          const n = nodes.get(nid)!;
          e.repo.updateNode(runId, nid, { model: input.modelTo!, modelOverride: true, providerId: input.modelTo!.providerId });
          if (n.threadId) e.repo.enqueue({ id: e.oid(), runId, kind: "update", nodeId: nid, payload: { model: input.modelTo!.modelId, reasoningLevel: input.modelTo!.reasoning }, idemKey: `${id}:update:${nid}` });
          e.repo.event(runId, nid, "model", `${mname(n.model)} → ${mname(input.modelTo)}`, id);
        }
        break;
      }
      case "scope": {
        briefVersion = target.briefVersion + 1;
        const prev = e.repo.nodeBrief(runId, target.id);
        const scopeGlobs = Array.isArray((input.value as { scopeGlobs?: unknown })?.scopeGlobs) ? ((input.value as { scopeGlobs: string[] }).scopeGlobs.map(String).slice(0, 40)) : undefined;
        e.repo.updateNode(runId, target.id, { briefVersion, briefMd: `${prev ? `${prev}\n` : ""}- v${briefVersion} (${id}): ${text}`, scopeGlobs });
        follow.push(() => {
          const r = e.run(runId);
          e.repo.enqueue({ id: e.oid(), runId, kind: "file", nodeId: null, payload: { path: e.briefPath(r, target.id), content: e.buildBrief(r, e.node(runId, target.id)) }, idemKey: `${id}:brief` });
        });
        break;
      }
      case "priority": {
        const p = String(input.value);
        for (const nid of affected) e.repo.updateNode(runId, nid, { priority: p });
        if (target.appId && (e.isLeadNode(target) || target.tier === "lead")) e.repo.updateApp(runId, target.appId, { priority: p });
        break;
      }
      case "pause": {
        for (const nid of affected) {
          const n = nodes.get(nid)!;
          if (TERMINAL.has(n.status) || n.status === "paused") continue;
          e.repo.updateNode(runId, nid, { status: "paused", prevStatus: n.status });
        }
        break;
      }
      case "resume": {
        for (const nid of affected) {
          const n = nodes.get(nid)!;
          if (n.status !== "paused") continue;
          const prev = e.repo.nodeFlags(runId, nid).prevStatus;
          const next = n.threadId ? (prev === "running" ? "waiting" : prev ?? "waiting") : prev === "planned" ? "planned" : "queued";
          e.repo.updateNode(runId, nid, { status: next, prevStatus: null, firstInLine: !n.threadId });
        }
        break;
      }
      case "stop": {
        const order = bottomUp(tree, affected);
        for (const nid of order) {
          const n = nodes.get(nid)!;
          if (n.status === "done") continue;
          e.repo.updateNode(runId, nid, { status: n.threadId ? "idle" : "planned", endedAt: ts });
        }
        const withThread = order.filter((nid) => nodes.get(nid)?.threadId);
        if (withThread.length) e.repo.enqueue({ id: e.oid(), runId, kind: "stop", nodeId: null, payload: { nodeIds: withThread, directiveId: id }, idemKey: `${id}:stop` });
        break;
      }
      case "retry": {
        for (const nid of affected) {
          const n = nodes.get(nid)!;
          if (!["failed", "idle", "needs"].includes(n.status)) continue;
          if (n.threadId && THREAD_GONE.test(n.warning ?? "")) {
            // its thread is missing or was archived outside Helm: a new thread takes over, with a hand-over
            e.repo.updateNode(runId, nid, { status: "queued", threadId: null, environmentId: null, branch: null, firstInLine: true, warning: null, endedAt: null });
            e.repo.event(runId, nid, "respawn", `retry: previous thread ${n.threadId} is gone; a new thread takes over`);
          } else if (n.threadId) {
            e.repo.updateNode(runId, nid, { status: "running", endedAt: null, lastActivityAt: ts, nudgedAt: null });
            e.repo.enqueue({ id: e.oid(), runId, kind: "retry", nodeId: nid, payload: {}, idemKey: `${id}:retry:${nid}` });
          } else e.repo.updateNode(runId, nid, { status: "queued", firstInLine: true, warning: null });
        }
        break;
      }
      case "spawn": {
        if (target.status === "planned" || target.status === "queued") e.repo.updateNode(runId, target.id, { status: "queued", firstInLine: true });
        break;
      }
      case "waive": {
        for (const fid of input.findingIds ?? []) e.repo.updateFinding(runId, fid, { status: "waived", waiverDirectiveId: id });
        break;
      }
      case "policy":
        break;
      case "slots": {
        const slots = { ...run.slots, ...(input.slots ?? {}) };
        e.repo.updateRun(runId, { slots });
        const changed = Object.keys(input.slots ?? {}) as SlotId[];
        for (const n of nodes.values()) {
          if (n.modelOverride || !changed.includes(n.slot)) continue;
          const m = slots[n.slot] ?? null;
          if (!m) continue;
          if (!n.threadId) e.repo.updateNode(runId, n.id, { model: m, providerId: m.providerId });
          else if (input.slotsScope === "all" && !TERMINAL.has(n.status)) {
            e.repo.updateNode(runId, n.id, { model: m, providerId: m.providerId });
            e.repo.enqueue({ id: e.oid(), runId, kind: "update", nodeId: n.id, payload: { model: m.modelId, reasoningLevel: m.reasoning }, idemKey: `${id}:update:${n.id}` });
          }
        }
        break;
      }
      case "signoff":
      case "sendback":
        // applied by resolveSignoff (needs gates.ts); the directive records and notifies
        break;
      case "approve":
      case "deny":
      case "answer":
      case "plan":
      case "tell":
        break;
    }
    if (!by && (input.policy || type === "policy")) {
      const pseq = e.repo.nextSeq(runId, "policy");
      const active = e.repo.listPolicies(runId);
      if (active.length >= 20) e.repo.retirePolicy(runId, active[0].id);
      e.repo.insertPolicy({ id: `P-${pseq}`, runId, text: text || directiveSummary({ id, type, cascade, text, ts }, { targetName: e.label(target), briefVersion, modelName: mname, touchedCount: 0, clock: hhmm(ts) }), scopeNodeId: target.id, fromDirective: id, createdAt: ts, retiredAt: null });
    }
    if (!by && touches(type)) for (const nid of affected) e.repo.updateNode(runId, nid, { touched: true });
    const touchedCount = Number((e.repo.db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE run_id = ? AND touched = 1").get(runId) as { c: number }).c);

    const nd: NoticeDirective = { id, type, cascade, text, value: input.value, modelFrom, modelTo: input.modelTo ?? null, implicit: input.implicit, ts };
    const ctx = { targetName: e.label(target), briefVersion, modelName: mname, touchedCount, clock: hhmm(ts) };
    const actx = by ? { ...ctx, byName: e.label(by), byId: by.id } : null;
    const summary = actx ? agentSummary(nd as NoticeDirective & { type: AgentAction }, actx) : directiveSummary(nd, ctx);
    e.repo.insertDirective({ id, runId, ts, type, targetNodeId: target.id, cascade, mode: humanMode, policy: !!input.policy || type === "policy", text, value: { value: input.value ?? null, needId: input.needId ?? null, findingIds: input.findingIds ?? null, slots: input.slots ?? null, slotsScope: input.slotsScope ?? null }, modelFrom, modelTo: input.modelTo ?? null, affected, actor, byNode: by?.id ?? null, implicit: !!input.implicit, summary });

    // ── recipients and delivery ──
    const need = input.needId ? e.repo.getNeed(runId, input.needId) : null;
    for (const r of recipients) {
      const n = nodes.get(r.id)!;
      const notice = actx ? agentNoticeText(nd as NoticeDirective & { type: AgentAction }, r.level, actx) : noticeFor(nd, r, ctx);
      let state: "queued" | "delivered" | "rec" = "queued";
      let outboxId: string | null = null;
      if (r.level === "digest") {
        state = "rec";
        e.repo.insertRecipient(runId, { directiveId: id, nodeId: r.id, level: r.level, world: r.world, state, notice, outboxId: null });
        e.repo.pushInbox(runId, r.id, notice, id);
        continue;
      }
      if (r.level === "direct" && input.implicit) state = "delivered";
      // every node the stop covers is told by the stop itself (§6.4), never by a message that would wake it
      else if (type === "stop" && (r.level === "direct" || affected.includes(r.id))) state = n.threadId ? "queued" : "delivered";
      else if (r.level === "direct" && type === "pause" && n.status !== "running" && nodes.get(r.id)!.status !== "running") state = "delivered";
      else if (r.level === "direct" && need?.interactionId && (type === "approve" || type === "deny" || type === "answer")) {
        outboxId = e.oid();
        e.repo.enqueue({ id: outboxId, runId, kind: "interaction", nodeId: r.id, payload: { threadId: n.threadId, interactionId: need.interactionId, answer: interactionAnswer(type, text, need.data), directiveId: id }, idemKey: `${id}:${r.id}` });
      } else if (n.threadId && !TERMINAL.has(n.status)) {
        outboxId = e.oid();
        const mode = deliveryModeFor(type, r.level, humanMode);
        e.repo.enqueue({ id: outboxId, runId, kind: "send", nodeId: r.id, payload: { text: notice, mode, kind: "notice", recipients: [{ directiveId: id, nodeId: r.id }], bypassPause: type === "pause" || type === "resume" || type === "stop" }, idemKey: `${id}:${r.id}` });
      } else if (n.threadId && TERMINAL.has(n.status) && type !== "retry" && type !== "resume") {
        // a stopped/finished agent is not woken for a notice; record it for its next start
        e.repo.pushInbox(runId, r.id, notice, id);
        state = "delivered";
      }
      // no thread: stays queued with no outbox row → injected into the spawn prompt (§6.3)
      e.repo.insertRecipient(runId, { directiveId: id, nodeId: r.id, level: r.level, world: r.world, state, notice, outboxId });
      if (state === "delivered") e.repo.updateRecipient(runId, id, r.id, { deliveredAt: ts });
    }
    for (const nid of affected) e.repo.event(runId, nid, "directive", summary, id);
    for (const f of follow) f();
    return e.repo.getDirective(runId, id)!;
  });

  e.emit(runId, "directive.created", out);
  for (const nid of out.affected) e.emit(runId, "node.updated", e.repo.getNode(runId, nid));
  e.outbox.kick();
  if (["resume", "retry", "spawn", "stop", "pause", "slots", "priority"].includes(type)) await e.pump(runId);
  return out;
}

function interactionAnswer(type: DirectiveType, text: string, data: unknown): InteractionAnswer {
  if (type === "approve") return { kind: "allow" };
  if (type === "deny") return { kind: "deny" };
  const d = (data ?? {}) as { questions?: Array<{ id: string }> };
  const answers: Record<string, { selected: string[]; freeText?: string }> = {};
  for (const q of d.questions ?? []) answers[q.id] = { selected: [], freeText: text };
  if (!Object.keys(answers).length) return { kind: "value", value: text };
  return { kind: "answer", answers };
}

// ───────────────────────────── acks and reminders ─────────────────────────────

export function ack(e: Engine, node: NodeInfo, directiveId: string, note: string | null): string {
  const d = e.repo.getDirective(node.runId, directiveId);
  if (!d) return `No directive ${directiveId}.`;
  const r = d.recipients.find((x) => x.nodeId === node.id);
  if (!r) return `${directiveId} was not addressed to you.`;
  if (r.level === "digest") return `${directiveId} was an FYI for you — no ack needed.`;
  if (r.state === "ack") return `${directiveId} already acknowledged.`;
  e.repo.updateRecipient(node.runId, directiveId, node.id, { state: "ack", ackAt: e.now(), ackNote: (note ?? "").slice(0, 300), deliveredAt: r.deliveredAt ?? e.now() });
  e.repo.event(node.runId, node.id, "ack", `acknowledged ${directiveId}${note ? `: ${note.slice(0, 120)}` : ""}`, directiveId);
  // the outcome travels up as one FYI line (never a wake-up): to the supervisor that
  // asked, and to the acknowledging agent's parent when that parent was not told directly
  if (r.level === "direct") {
    const line = `${e.label(node)} acknowledged ${directiveId}${note ? `: ${note.slice(0, 200)}` : "."}`;
    const up = new Set([d.byNode, node.parentId].filter((x): x is string => !!x && x !== node.id));
    for (const id of up) if (!d.recipients.some((x) => x.nodeId === id && x.level !== "digest")) e.fyi(node.runId, id, line, directiveId);
  }
  e.emit(node.runId, "receipt.updated", { directiveId, nodeId: node.id, state: "ack" });
  return `Acknowledged ${directiveId}.`;
}

// ───────────────────────────── supervisor steering ─────────────────────────────

const STEER_WINDOW_MS = 10 * 60_000;
const STEER_PER_TARGET = 3;
const STEER_PER_SUPERVISOR = 12;

/** helm_direct: a supervisor steers someone below it. The human's directives always win. */
export async function agentDirect(e: Engine, by: NodeInfo, p: { to: string; action: AgentAction; text?: string; priority?: string; urgent?: boolean }): Promise<string> {
  const runId = by.runId;
  const target = e.repo.getNode(runId, p.to);
  if (!target) return `No node ${p.to}. Use ids from helm_context or helm_world.`;
  const problem = steerProblem(e.tree(runId), by.id, target);
  if (problem) return `Rejected: ${problem}`;
  const text = (p.text ?? "").trim();
  if (p.action === "tell" && !text) return "Rejected: say what you want (text).";
  if (p.action === "priority" && !["low", "normal", "high"].includes(String(p.priority))) return "Rejected: priority must be low, normal or high.";
  if (target.status === "done") return `Rejected: ${e.label(target)} is done.`;
  if (p.action === "pause" && (target.status === "paused" || TERMINAL.has(target.status))) return `${e.label(target)} is ${target.status}; nothing to pause.`;
  if (p.action === "resume" && target.status !== "paused") return `${e.label(target)} is not paused.`;
  const history = e.repo.directivesTouching(runId, target.id).filter((d) => d.affected.includes(target.id));
  if (p.action === "resume") {
    const last = history.find((d) => d.type === "pause" || d.type === "resume");
    if (last?.type === "pause" && last.actor !== "agent") return `Rejected: the human paused ${e.label(target)} (${last.id}); only the human can resume it.`;
  }
  if (p.action === "priority") {
    const last = history.find((d) => d.type === "priority");
    if (last && last.actor !== "agent") return `Rejected: the human set ${e.label(target)}'s priority (${last.id}); raise a helm_need if it should change.`;
  }
  const since = e.now() - STEER_WINDOW_MS;
  const mine = e.repo.listDirectives(runId, 200).filter((d) => d.byNode === by.id && d.ts >= since);
  if (mine.filter((d) => d.targetNodeId === target.id).length >= STEER_PER_TARGET) return `Rejected: you already steered ${e.label(target)} ${STEER_PER_TARGET} times in 10 minutes. Put everything in one message and let it work.`;
  if (mine.length >= STEER_PER_SUPERVISOR) return `Rejected: ${STEER_PER_SUPERVISOR} directives in 10 minutes is the limit. Batch your instructions.`;
  const d = await createDirective(e, runId, { type: p.action, target: target.id, text, value: p.action === "priority" ? p.priority : undefined, mode: p.urgent === false ? "queue" : "steer", byNode: by.id });
  const told = d.recipients.filter((r) => r.level === "digest").length;
  const when = target.threadId ? (TERMINAL.has(target.status) ? "it was not woken; it reads this when it next starts" : "delivered now") : "it reads this when it starts";
  return `${d.id} sent to ${e.label(target)} (${when}). ${told ? `${told} above ${told === 1 ? "it sees" : "them see"} one FYI line. ` : ""}You will get its acknowledgement as FYI.`;
}

/** One reminder for unacked direct/full notices when the node goes idle (§6.4). */
export function remindUnacked(e: Engine, node: NodeInfo): void {
  // a stopped or paused agent is never woken to acknowledge; stops and pauses need no ack at all
  if (["idle", "done", "failed", "paused"].includes(e.repo.getNode(node.runId, node.id)?.status ?? "")) return;
  const pending = e.repo
    .unackedFor(node.runId, node.id)
    .filter((r) => r.state === "delivered" && !e.repo.recipientReminded(node.runId, r.directiveId, node.id) && !NO_ACK.has(e.repo.getDirective(node.runId, r.directiveId)?.type ?? ""));
  if (!pending.length) return;
  e.repo.tx(() => {
    for (const r of pending) e.repo.updateRecipient(node.runId, r.directiveId, node.id, { reminded: true });
    e.sendFromHelm(node.runId, node.id, `Reminder: please call helm_ack for ${pending.map((r) => r.directiveId).join(", ")} with one line saying what you changed.`, { key: `remind:${node.runId}:${node.id}:${pending.map((r) => r.directiveId).join(",")}` });
  });
}

// ───────────────────────────── needs resolution ─────────────────────────────

export interface NeedResolution {
  action: "approve" | "deny" | "answer" | "retry" | "change_model" | "stop" | "raise_cap" | "keep_paused" | "stop_run" | "signoff" | "sendback" | "waive" | "dismiss" | "nudge" | "complete_run";
  text?: string;
  model?: ModelRef;
  value?: number;
  findingIds?: string[];
  rotatedConfirmed?: boolean;
  /** Who resolved it: the human (default), or Helm on the Orchestrator's behalf when autonomy is high. */
  actor?: "human" | "system";
}

export async function resolveNeed(e: Engine, runId: string, needId: string, res: NeedResolution, hooks: { signoff(appId: string, d: DirectiveInfo): Promise<void>; sendback(appId: string, d: DirectiveInfo): Promise<void> }): Promise<{ need: ReturnType<Engine["repo"]["getNeed"]>; directive: DirectiveInfo | null }> {
  const need = e.repo.getNeed(runId, needId);
  if (!need) throw new HelmError(`No need ${needId}.`, "not_found");
  if (need.state !== "open") throw new HelmError(`${needId} is already resolved.`, "bad_state");
  const target = need.nodeId ?? ORCH_ID;
  const text = res.text?.trim() ?? "";
  let directive: DirectiveInfo | null = null;
  const close = () => {
    e.repo.resolveNeed(runId, needId, { action: res.action, text, directiveId: directive?.id ?? null });
    const n = need.nodeId ? e.repo.getNode(runId, need.nodeId) : null;
    if (n?.status === "needs" && !e.repo.openNeedsFor(runId, n.id).some((x) => x.id !== needId)) {
      const prev = e.repo.nodeFlags(runId, n.id).prevStatus;
      e.repo.updateNode(runId, n.id, { status: prev && prev !== "needs" ? (prev === "running" ? "waiting" : prev) : n.threadId ? "waiting" : "queued", prevStatus: null });
    }
    e.emit(runId, "need.resolved", { id: needId, action: res.action });
  };
  switch (res.action) {
    case "approve":
    case "deny":
    case "answer": {
      if (need.kind === "plan") {
        const delta = (need.data as { delta?: PlanDelta })?.delta;
        if (res.action === "approve" && delta) {
          const summary = await applyDelta(e, runId, delta);
          directive = await createDirective(e, runId, { type: "plan", target: ORCH_ID, text: text || summary, needId, actor: res.actor });
        } else if (res.action === "approve") {
          const appIds = ((need.data as { appIds?: string[] })?.appIds ?? []).filter(Boolean);
          directive = await createDirective(e, runId, { type: "plan", target: ORCH_ID, text: text || `admit ${appIds.join(", ")}`, needId, actor: res.actor });
          e.repo.tx(() => {
            for (const a of appIds) e.admitAppTx(runId, a, `wave approved (${directive!.id})`);
          });
          await e.pump(runId);
        }
        break;
      }
      if (res.action === "answer" && !text) throw new HelmError("An answer needs text.", "invalid_value");
      directive = await createDirective(e, runId, { type: res.action, target, text: text || (res.action === "approve" ? "approved" : "denied"), needId });
      break;
    }
    case "retry":
    case "nudge":
      directive = await createDirective(e, runId, { type: "retry", target, text });
      break;
    case "change_model":
      if (!res.model) throw new HelmError("Choose a model.", "invalid_value");
      directive = await createDirective(e, runId, { type: "model", target, modelTo: res.model, text });
      e.repo.tx(() => {
        const n = e.node(runId, target);
        if (!n.threadId && (n.status === "needs" || n.status === "failed")) e.repo.updateNode(runId, n.id, { status: "queued", firstInLine: true, prevStatus: null, warning: null });
      });
      if (e.node(runId, target).threadId && e.node(runId, target).status === "failed") await createDirective(e, runId, { type: "retry", target, text: "retry on the new model" });
      await e.pump(runId);
      break;
    case "stop":
      directive = await createDirective(e, runId, { type: "stop", target, cascade: need.kind === "slop" || need.kind === "signoff" ? "subtree" : "self", text });
      if (need.appId && (need.kind === "slop" || need.kind === "failed")) {
        const lead = e.leadOf(runId, need.appId);
        if (lead && lead.id === target) e.repo.updateApp(runId, need.appId, { stage: "cancelled" });
      }
      break;
    case "raise_cap": {
      const run = e.run(runId);
      const cap = Math.max(run.budgetCap, Number(res.value ?? run.budgetCap * 1.5));
      e.repo.updateRun(runId, { budgetCap: cap, spawnsPaused: false });
      e.emit(runId, "spawns.paused", { paused: false, budgetCap: cap });
      await e.pump(runId);
      break;
    }
    case "keep_paused":
      break;
    case "stop_run":
      directive = await createDirective(e, runId, { type: "stop", target: ORCH_ID, cascade: "subtree", text: text || "run stopped from the budget prompt" });
      e.repo.updateRun(runId, { status: "cancelled", endedAt: e.now() });
      break;
    case "signoff":
      if (!need.appId) throw new HelmError("This item is not about an app.", "bad_state");
      directive = await createDirective(e, runId, { type: "signoff", target: e.leadOf(runId, need.appId)!.id, text, needId });
      await hooks.signoff(need.appId, directive);
      break;
    case "sendback":
      if (!need.appId) throw new HelmError("This item is not about an app.", "bad_state");
      if (!text) throw new HelmError("Send back needs a reason.", "invalid_value");
      directive = await createDirective(e, runId, { type: "sendback", target: e.leadOf(runId, need.appId)!.id, text, needId });
      await hooks.sendback(need.appId, directive);
      break;
    case "waive": {
      const gate = need.appId ? e.repo.getNode(runId, `${need.appId}.slop`) ?? e.repo.getNode(runId, `${need.appId}.review`) : null;
      directive = await createDirective(e, runId, { type: "waive", target: gate?.id ?? target, findingIds: res.findingIds, text, rotatedConfirmed: res.rotatedConfirmed });
      break;
    }
    case "complete_run":
      // §9.10: completion stops and archives everything, only after the human confirms it
      e.repo.tx(close);
      await completeRun(e, runId, "done");
      return { need: e.repo.getNeed(runId, needId), directive: null };
    case "dismiss":
      break;
  }
  e.repo.tx(close);
  return { need: e.repo.getNeed(runId, needId), directive };
}

// ───────────────────────────── board moves (§5.7) ─────────────────────────────

export async function moveTask(e: Engine, runId: string, nodeId: string, to: TaskCol): Promise<{ ok: boolean; why?: string; directive?: DirectiveInfo }> {
  const n = e.node(runId, nodeId);
  const rule = taskMoveRule(n, to);
  if (!rule.ok) return { ok: false, why: rule.why };
  if ("noop" in rule && rule.noop) return { ok: true };
  const act = (rule as { act: string }).act;
  if (act === "start" || act === "spawn") return { ok: true, directive: await createDirective(e, runId, { type: "spawn", target: nodeId }) };
  if (act === "hold") return { ok: true, directive: await createDirective(e, runId, { type: "pause", target: nodeId, text: "held from the board" }) };
  return { ok: false, why: "Not a board action." };
}

export function appMove(e: Engine, runId: string, appId: string, to: Parameters<typeof appMoveRule>[1]) {
  const app = e.repo.getApp(runId, appId);
  if (!app) throw new HelmError(`No app ${appId}.`, "not_found");
  return appMoveRule(app, to);
}

export function startAppNow(e: Engine, runId: string, appId: string): void {
  e.repo.tx(() => {
    e.admitAppTx(runId, appId, "started now by the human");
    const lead = e.leadOf(runId, appId);
    if (lead) e.repo.updateNode(runId, lead.id, { firstInLine: true });
  });
  void e.pump(runId);
}

export function stagePctOf(stage: Parameters<typeof stagePct>[0]): number {
  return stagePct(stage);
}
