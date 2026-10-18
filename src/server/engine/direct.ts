// Directives (§6) and Needs-you resolution (§9.7). A directive is recorded,
// applied and fanned out to every recipient in ONE transaction, so the
// Orchestrator's world state can never be stale about what the human changed.

import type { Cascade, Catalog, DirectiveInfo, DirectiveType, ModelRef, NodeInfo, PermissionMode, Role, SlotId, SlotMap, Tier } from "../../shared/types.ts";
import { PlatformLooseSchema } from "../domain/brief.ts";
import { PLATFORM_LABEL } from "../domain/roles.ts";
import { HelmError, type Engine } from "./engine.ts";
import { AGENT_ACTIONS, agentNoticeText, agentSummary, bottomUp, buildAgentModelRecipients, buildAgentRecipients, buildRecipients, descendants, deliveryModeFor, directiveSummary, noticeFor, resolveCascade, steerProblem, touches, type AgentAction, type NoticeDirective } from "../domain/directives.ts";
import { modelName, validateRef } from "../domain/models.ts";
import { hhmm, pad4 } from "./context.ts";
import { waiverProblem } from "../domain/verdict.ts";
import { appMoveRule, isInFlight, stageLabel, stagePct, taskMoveRule, type TaskCol } from "../domain/stages.ts";
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
  /** A supervisor's model change (helm_set_model): exactly these nodes, validated by agentSetModel. */
  affectedIds?: string[];
  /** How the ledger names a multi-agent selection ("3 Slop Hunters under Manager 1"). */
  targetLabel?: string;
  /** Hands-off: the supervisor that decided a card on the human's behalf (named in the notices instead of "the human"). */
  decidedBy?: string;
}

/** A notice written for the human's decision, reworded for the supervisor that made it (hands-off). */
export function onBehalf(text: string, who: string): string {
  return text.replace(/\bThe human\b/g, who).replace(/\bthe human\b/g, who).replace(/\bby human\b/g, `by ${who}`);
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
  // BB cannot move a thread to another provider: read each affected thread's real provider first
  const threadProvider = new Map<string, string | null>();
  const explicit = by && type === "model" && input.affectedIds?.length ? input.affectedIds : null;
  if (type === "model" || (type === "slots" && input.slotsScope === "all")) {
    const changedSlots = Object.keys(input.slots ?? {});
    const ids = type === "model" ? new Set(explicit ?? resolveCascade(e.tree(runId), target.id, cascade)) : null;
    const live = e.repo.listNodes(runId).filter((n) => n.threadId && n.status !== "done" && (ids ? ids.has(n.id) : changedSlots.includes(n.slot)));
    await Promise.all(live.map(async (n) => threadProvider.set(n.id, (await e.port.threadState(n.threadId!).catch(() => null))?.providerId ?? null)));
  }

  let startNow = false;
  const out = e.repo.tx(() => {
    const seq = e.repo.nextSeq(runId, "directive");
    const id = `D-${pad4(seq)}`;
    const ts = e.now();
    const tree = e.tree(runId);
    const affected = explicit ? [...explicit] : resolveCascade(tree, target.id, cascade);
    const recipients = by ? (type === "model" ? buildAgentModelRecipients(tree, by.id, affected) : buildAgentRecipients(tree, by.id, target.id)) : buildRecipients(tree, affected);
    const nodes = new Map(e.repo.listNodes(runId).map((n) => [n.id, n]));
    let modelFrom: ModelRef | null = null;
    let briefVersion = target.briefVersion;
    const follow: Array<() => void> = [];
    /** Give a node a model now: same provider switches in place, another provider gets a new thread. */
    const switchModel = (n: NodeInfo, m: ModelRef, override: boolean): "recorded" | "updated" | "replaced" | "deferred" => {
      e.repo.updateNode(runId, n.id, { model: m, modelOverride: override, providerId: m.providerId });
      if (!n.threadId || n.status === "done") return "recorded";
      const on = threadProvider.get(n.id) ?? n.model?.providerId ?? null;
      if (on && on !== m.providerId) {
        // a stopped agent switches when it is retried; any other agent moves now
        if (n.status === "idle") {
          e.repo.setMeta(`switch:${runId}:${n.id}`, "1");
          return "deferred";
        }
        e.replaceThreadTx(runId, n, `model moved from ${on} to ${m.providerId}`, id);
        return "replaced";
      }
      e.repo.enqueue({ id: e.oid(), runId, kind: "update", nodeId: n.id, payload: { model: m.modelId, reasoningLevel: m.reasoning }, idemKey: `${id}:update:${n.id}` });
      return "updated";
    };

    // ── effects ──
    switch (type) {
      case "model": {
        modelFrom = affected.length === 1 ? nodes.get(affected[0])?.model ?? null : target.model;
        for (const nid of affected) {
          const n = nodes.get(nid)!;
          const r = switchModel(n, input.modelTo!, true);
          e.repo.event(runId, nid, "model", `${mname(n.model)} → ${mname(input.modelTo)}`, id);
          // a supervisor moving a failed agent to a working model: it retries on the new one
          if (by && n.status === "failed") {
            if (!n.threadId) e.repo.updateNode(runId, nid, { status: "queued", firstInLine: true, warning: null });
            else if (r === "updated") {
              e.repo.updateNode(runId, nid, { status: "running", endedAt: null, lastActivityAt: ts, nudgedAt: null, warning: null });
              e.repo.enqueue({ id: e.oid(), runId, kind: "retry", nodeId: nid, payload: {}, idemKey: `${id}:retry:${nid}` });
              for (const need of e.repo.openNeedsFor(runId, nid)) if (need.kind === "failed") e.repo.resolveNeed(runId, need.id, { action: "retry", text: "retried on the new model" });
            }
          }
          // a supervisor gave a model to an agent that waited for one (hands-off): it starts on it
          if (by) {
            const waiting = e.repo.openNeedsFor(runId, nid).filter((x) => x.kind === "model");
            for (const need of waiting) {
              e.repo.resolveNeed(runId, need.id, { action: "change_model", text: `model set by ${e.label(by)}` });
              e.emit(runId, "need.resolved", { id: need.id, action: "change_model" });
            }
            if (waiting.length && !n.threadId && n.status === "needs") e.repo.updateNode(runId, nid, { status: "queued", firstInLine: true, prevStatus: null, warning: null });
          }
        }
        // the Orchestrator moved every agent of a role: future agents of that role follow
        if (by && input.slots && Object.keys(input.slots).length) e.repo.updateRun(runId, { slots: { ...run.slots, ...input.slots } });
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
          if (n.threadId && e.repo.getMeta(`switch:${runId}:${nid}`)) {
            // its model moved to another provider while it was stopped: a new thread takes over
            e.replaceThreadTx(runId, n, "retry on another provider", id);
          } else if (n.threadId && THREAD_GONE.test(n.warning ?? "")) {
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
        // "all": every agent in these roles moves now, per-agent overrides included, and failed ones retry
        const now = input.slotsScope === "all";
        for (const n of nodes.values()) {
          if (!changed.includes(n.slot) || n.status === "done" || (n.modelOverride && !now)) continue;
          const m = slots[n.slot] ?? null;
          if (!m) continue;
          if (!n.threadId) {
            e.repo.updateNode(runId, n.id, { model: m, providerId: m.providerId, modelOverride: false, ...(now && n.status === "failed" ? { status: "queued" as const, firstInLine: true, warning: null } : {}) });
            continue;
          }
          if (!now) continue;
          const r = switchModel(n, m, false);
          if (r === "updated" && n.status === "failed") {
            e.repo.updateNode(runId, n.id, { status: "running", endedAt: null, lastActivityAt: ts, nudgedAt: null, warning: null });
            e.repo.enqueue({ id: e.oid(), runId, kind: "retry", nodeId: n.id, payload: {}, idemKey: `${id}:retry:${n.id}` });
            for (const need of e.repo.openNeedsFor(runId, n.id)) if (need.kind === "failed") e.repo.resolveNeed(runId, need.id, { action: "retry", text: "retried on the new model" });
          }
        }
        break;
      }
      case "signoff":
      case "sendback":
        // applied by resolveSignoff (needs gates.ts); the directive records and notifies
        break;
      case "tell": {
        // the human's word to an agent that has not started: it starts now (its app too), with the message in its first prompt
        const app = target.appId ? e.repo.getApp(runId, target.appId) : null;
        if (!by && !input.implicit && run.status === "running" && (target.status === "planned" || target.status === "queued") && app?.stage !== "done" && app?.stage !== "cancelled") {
          if (app?.stage === "intake") e.admitAppTx(runId, app.id, `the human told ${e.label(target)} to work (${id})`);
          e.repo.updateNode(runId, target.id, { status: "queued", firstInLine: true });
          startNow = true;
        }
        // a builder that already reported done is woken for it while its app is in flight
        if (!by && !input.implicit && target.status === "done" && target.tier === "specialist" && target.threadId && app && isInFlight(app.stage)) {
          e.repo.updateNode(runId, target.id, { status: "waiting", endedAt: null });
          nodes.set(target.id, { ...target, status: "waiting", endedAt: null });
        }
        break;
      }
      case "approve":
      case "deny":
      case "answer":
      case "plan":
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
    const ctx = { targetName: input.targetLabel ?? e.label(target), briefVersion, modelName: mname, touchedCount, clock: hhmm(ts) };
    const actx = by ? { ...ctx, byName: e.label(by), byId: by.id } : null;
    const summary = actx ? agentSummary(nd as NoticeDirective & { type: AgentAction }, actx) : input.decidedBy ? `${directiveSummary(nd, ctx)} (by ${input.decidedBy})` : directiveSummary(nd, ctx);
    e.repo.insertDirective({ id, runId, ts, type, targetNodeId: target.id, cascade, mode: humanMode, policy: !!input.policy || type === "policy", text, value: { value: input.value ?? null, needId: input.needId ?? null, findingIds: input.findingIds ?? null, slots: input.slots ?? null, slotsScope: input.slotsScope ?? null }, modelFrom, modelTo: input.modelTo ?? null, affected, actor, byNode: by?.id ?? null, implicit: !!input.implicit, summary });

    // ── recipients and delivery ──
    const need = input.needId ? e.repo.getNeed(runId, input.needId) : null;
    for (const r of recipients) {
      const n = nodes.get(r.id)!;
      const notice =
        actx && type === "model" && affected.includes(r.id)
          ? `${id} · ${actx.byName} (${actx.byId}) changed your model to ${mname(input.modelTo)}${text ? `: ${text}` : ""}. It applies from your next turn; carry on with your work.`
          : actx
            ? agentNoticeText(nd as NoticeDirective & { type: AgentAction }, r.level, actx)
            : input.decidedBy
              ? onBehalf(noticeFor(nd, r, ctx), input.decidedBy)
              : noticeFor(nd, r, ctx);
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
  if (["resume", "retry", "spawn", "stop", "pause", "slots", "priority"].includes(type) || (by && type === "model") || startNow) await e.pump(runId);
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
  if (r.level === "full") return `${directiveId} was an FYI for you: the human directed your report, who acts on it without your approval. No reply needed; fit your plan around it.`;
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
  // a finished agent in a live app can be handed more work, as helm_assign_fix does; anything else has nothing to steer
  let reopen = false;
  if (target.status === "done") {
    const app = target.appId ? e.repo.getApp(runId, target.appId) : null;
    if (app && !isInFlight(app.stage)) return `Rejected: ${e.label(target)} is done and ${app.name} is ${stageLabel(app.stage)}; there is nothing left to steer.`;
    if (p.action !== "tell") return `${e.label(target)} is done; ${p.action} has no effect. To give it more work, use tell (Helm wakes it).`;
    if (target.tier !== "specialist" || !target.threadId) return `Rejected: ${e.label(target)} is done${target.role === "custom" ? " (retired)" : ""}; only a builder that reported done can be woken for more work.`;
    reopen = true;
  }
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
  if (reopen) e.repo.updateNode(runId, target.id, { status: "waiting", endedAt: null });
  const d = await createDirective(e, runId, { type: p.action, target: target.id, text, value: p.action === "priority" ? p.priority : undefined, mode: p.urgent === false ? "queue" : "steer", byNode: by.id });
  const told = d.recipients.filter((r) => r.level === "digest").length;
  const when = reopen ? "it was done, so Helm woke it; it reports done again when finished" : target.threadId ? (TERMINAL.has(target.status) ? "it was not woken; it reads this when it next starts" : "delivered now") : "it reads this when it starts";
  return `${d.id} sent to ${e.label(target)} (${when}). ${told ? `${told} above ${told === 1 ? "it sees" : "them see"} one FYI line. ` : ""}You will get its acknowledgement as FYI.`;
}

// ───────────────────────────── supervisor model changes (helm_set_model) ─────────────────────────────

const MODEL_PER_SUPERVISOR = 10;

/** Role words a supervisor may use for a selection ("slop hunters", "reviewers", "managers", "gates"). */
const ROLE_WORDS: Record<string, { roles?: Role[]; tiers?: Tier[]; label: string }> = {
  manager: { roles: ["mgr"], label: "Manager" },
  mgr: { roles: ["mgr"], label: "Manager" },
  lead: { roles: ["lead"], label: "Lead" },
  app_lead: { roles: ["lead"], label: "Lead" },
  ui: { roles: ["ui"], label: "UI builder" },
  code: { roles: ["code"], label: "Core builder" },
  core: { roles: ["code"], label: "Core builder" },
  platform: { roles: ["platform"], label: "platform builder" },
  security: { roles: ["security"], label: "Security agent" },
  test: { roles: ["test"], label: "Test agent" },
  research: { roles: ["research"], label: "Research agent" },
  docs: { roles: ["docs"], label: "Docs agent" },
  data: { roles: ["data"], label: "Data builder" },
  compliance: { roles: ["compliance"], label: "Compliance agent" },
  assets: { roles: ["assets"], label: "Asset builder" },
  asset: { roles: ["assets"], label: "Asset builder" },
  review: { roles: ["review"], label: "Reviewer" },
  reviewer: { roles: ["review"], label: "Reviewer" },
  slop: { roles: ["slop"], label: "Slop Hunter" },
  slop_hunter: { roles: ["slop"], label: "Slop Hunter" },
  slophunter: { roles: ["slop"], label: "Slop Hunter" },
  gate: { tiers: ["gate"], label: "gate" },
  specialist: { tiers: ["specialist"], label: "specialist" },
  builder: { tiers: ["specialist"], label: "specialist" },
  all: { label: "agent" },
  everyone: { label: "agent" },
};

export function roleWord(s: string): { roles?: Role[]; tiers?: Tier[]; label: string } | null {
  const k = s.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return ROLE_WORDS[k] ?? ROLE_WORDS[k.replace(/s$/, "")] ?? ROLE_WORDS[k.replace(/_builders?$|_agents?$/, "")] ?? null;
}

/** "provider/model:reasoning", "model:reasoning" or "model" → a model on this machine's catalog. */
export function resolveModelWord(cat: Catalog, s: string): { ref: ModelRef } | { problem: string } {
  const m = s.trim().match(/^(?:([A-Za-z0-9._-]+)\/)?([A-Za-z0-9._\-\[\]]+?)(?::([A-Za-z0-9_-]+))?$/);
  if (!m) return { problem: `Cannot read the model "${s}". Write it as provider/model:reasoning, from helm_models.` };
  const [, providerId, modelId, reasoning] = m;
  const hits = cat.models.filter((x) => x.modelId === modelId && (!providerId || x.providerId === providerId));
  if (!hits.length) return { problem: `No model ${providerId ? `${providerId}/` : ""}${modelId} on this machine. Call helm_models for the list.` };
  const live = hits.filter((x) => cat.providers.find((p) => p.id === x.providerId)?.available);
  if (live.length > 1) return { problem: `${modelId} is offered by ${live.map((x) => x.providerId).join(" and ")}; name the provider (provider/${modelId}).` };
  const hit = live[0] ?? hits[0];
  const ref: ModelRef = { providerId: hit.providerId, modelId: hit.modelId, reasoning: reasoning ?? hit.defaultReasoning ?? null };
  const p = validateRef(cat, ref);
  return p ? { problem: p.message } : { ref };
}

/** Whose models an agent may change: everyone below it; the Planner and the Fixer, everyone but themselves. */
function reach(e: Engine, by: NodeInfo): string[] {
  if (by.tier === "planner" || by.tier === "fixer") return e.repo.listNodes(by.runId).filter((n) => n.id !== by.id).map((n) => n.id);
  return descendants(e.tree(by.runId), by.id);
}

export interface ModelChange {
  nodes?: string[];
  role?: string;
  app?: string;
  under?: string;
  platform?: string;
  model: string;
}

/**
 * A supervisor changes the models of agents below it: the Orchestrator anyone, a Manager its
 * Leads and their teams, a Lead its squad and gates. One directive per change; nobody is woken.
 */
export async function agentSetModel(e: Engine, by: NodeInfo, changes: ModelChange[], reason: string): Promise<string> {
  const runId = by.runId;
  const since = e.now() - STEER_WINDOW_MS;
  const recent = e.repo.listDirectives(runId, 200).filter((d) => d.byNode === by.id && d.type === "model" && d.ts >= since).length;
  if (recent + changes.length > MODEL_PER_SUPERVISOR) return `Rejected: at most ${MODEL_PER_SUPERVISOR} model changes per 10 minutes (you made ${recent}). Select by role to change many agents in one change.`;
  const cat = await e.catalog(e.repo.runHost(runId));
  const tree = e.tree(runId);
  const all = e.repo.listNodes(runId);
  const byId = new Map(all.map((n) => [n.id, n]));
  const below = new Set(reach(e, by));
  const apps = e.repo.listApps(runId);

  // validate everything first: either every change applies or none does
  const planned: Array<{ ids: string[]; ref: ModelRef; label: string; target: string; slots?: SlotMap; skipped: string[] }> = [];
  for (const [i, c] of changes.entries()) {
    const tag = changes.length > 1 ? `Change ${i + 1}: ` : "";
    const res = resolveModelWord(cat, c.model);
    if ("problem" in res) return `Rejected: ${tag}${res.problem}`;
    let ids: string[];
    let label: string;
    let target = by.id;
    if (c.nodes?.length) {
      if (c.role || c.app || c.under || c.platform) return `Rejected: ${tag}name agents by nodes, or select them by role/app/under/platform, not both.`;
      const bad = c.nodes.filter((id) => !byId.has(id));
      if (bad.length) return `Rejected: ${tag}no agent ${bad.join(", ")}. Use ids from helm_models or helm_context.`;
      const outside = c.nodes.filter((id) => !below.has(id));
      if (outside.length) return `Rejected: ${tag}${outside.map((id) => (id === by.id ? "yourself" : id)).join(", ")} ${outside.length === 1 ? "is" : "are"} not below you. You can change the models of agents below you only; ask ${by.parentId ?? "the human"} for anything else.`;
      ids = [...new Set(c.nodes)];
      label = ids.length === 1 ? e.label(byId.get(ids[0])!) : `${ids.length} agents`;
      if (ids.length === 1) target = ids[0];
    } else {
      if (!c.role && !c.app && !c.under && !c.platform) return `Rejected: ${tag}say who: nodes, or a role (e.g. slop, reviewer, lead, manager), an app, or under one of your reports.`;
      let pool = [...below];
      let where = "";
      if (c.under) {
        const u = byId.get(c.under);
        if (!u) return `Rejected: ${tag}no agent ${c.under}.`;
        if (!below.has(u.id)) return `Rejected: ${tag}${u.id === by.id ? "under yourself is the default; leave under out" : `${u.id} is not below you`}.`;
        pool = [u.id, ...descendants(tree, u.id)];
        target = u.id;
        where = ` under ${e.label(u)}`;
      }
      if (c.app) {
        const want = c.app.trim().toLowerCase();
        const app = apps.find((a) => a.id === want || a.name.toLowerCase() === want);
        if (!app) return `Rejected: ${tag}no app ${c.app}. Apps: ${apps.map((a) => a.id).slice(0, 30).join(", ")}.`;
        pool = pool.filter((id) => byId.get(id)!.appId === app.id);
        where += ` in ${app.name}`;
      }
      let what = "agent";
      if (c.role) {
        const w = roleWord(c.role);
        if (!w) return `Rejected: ${tag}unknown role "${c.role}". Use manager, lead, ui, code, platform, security, test, research, docs, data, compliance, assets, reviewer, slop (Slop Hunter), gates, specialists or all.`;
        pool = pool.filter((id) => {
          const n = byId.get(id)!;
          return (!w.roles || w.roles.includes(n.role)) && (!w.tiers || w.tiers.includes(n.tier));
        });
        what = w.label;
      }
      if (c.platform) {
        const pl = PlatformLooseSchema.safeParse(c.platform);
        if (!pl.success) return `Rejected: ${tag}unknown platform "${c.platform}".`;
        pool = pool.filter((id) => byId.get(id)!.platform === pl.data);
        if (!c.role) what = `${PLATFORM_LABEL[pl.data]} builder`;
      }
      ids = pool;
      label = `${ids.length === 1 ? e.label(byId.get(ids[0])!) : `${ids.length} ${what}s`}${where}`;
      if (!ids.length) return `Rejected: ${tag}no ${what} below you${where}. Call helm_models to see who is below you.`;
    }
    const skipped = ids.filter((id) => byId.get(id)!.status === "done").map((id) => e.label(byId.get(id)!));
    ids = ids.filter((id) => byId.get(id)!.status !== "done");
    const same = (r: ModelRef | null) => !!r && r.providerId === res.ref.providerId && r.modelId === res.ref.modelId && (r.reasoning ?? null) === (res.ref.reasoning ?? null);
    ids = ids.filter((id) => !same(byId.get(id)!.model));
    // the Orchestrator moving every agent that uses a slot moves that slot's default too
    let slots: SlotMap | undefined;
    if ((by.id === ORCH_ID || by.tier === "planner") && ids.length) {
      const chosen = new Set(ids);
      for (const slot of new Set(ids.filter((id) => byId.get(id)!.role !== "custom").map((id) => byId.get(id)!.slot))) {
        const users = all.filter((n) => n.slot === slot && n.status !== "done" && n.id !== by.id && n.role !== "custom");
        if (users.every((n) => chosen.has(n.id) || same(n.model))) slots = { ...(slots ?? {}), [slot]: res.ref };
      }
    }
    planned.push({ ids, ref: res.ref, label, target, slots, skipped });
  }

  const lines: string[] = [];
  for (const p of planned) {
    if (!p.ids.length) {
      lines.push(`${p.label}: already on ${modelName(cat, p.ref)}; nothing changed.`);
      continue;
    }
    const humanSet = p.ids.filter((id) => e.repo.directivesTouching(runId, id).find((d) => d.type === "model" && d.affected.includes(id))?.actor === "human");
    const d = await createDirective(e, runId, { type: "model", target: p.target, modelTo: p.ref, byNode: by.id, affectedIds: p.ids, targetLabel: p.label, text: reason, slots: p.slots });
    const moved = p.ids.filter((id) => {
      const n = e.repo.getNode(runId, id);
      return n && byId.get(id)!.threadId && n.threadId !== byId.get(id)!.threadId;
    }).length;
    const names = p.ids.length <= 8 ? ` (${p.ids.join(", ")})` : "";
    lines.push(
      `${d.id}: ${p.label}${names} → ${modelName(cat, p.ref)} [${p.ref.providerId}/${p.ref.modelId}${p.ref.reasoning ? `:${p.ref.reasoning}` : ""}].` +
        (moved ? ` ${moved} moved to a new thread on ${p.ref.providerId} with a hand-over.` : "") +
        (p.slots ? ` Future ${Object.keys(p.slots).join(", ")} agents use it too.` : "") +
        (p.skipped.length ? ` Skipped (done): ${p.skipped.join(", ")}.` : "") +
        (humanSet.length ? ` Note: the human had chosen the model of ${humanSet.map((id) => e.label(byId.get(id)!)).join(", ")}; change it only because the human asked.` : ""),
    );
  }
  return `${lines.join("\n")}\nAgents on the same provider switch at their next turn; nobody was interrupted.`;
}

/** The models this machine offers, and which model each agent below the caller uses. Bounded. */
export async function agentModels(e: Engine, by: NodeInfo): Promise<string> {
  const runId = by.runId;
  const cat = await e.catalog(e.repo.runHost(runId)).catch(() => null);
  const out: string[] = ["Models on this machine (write them as provider/model:reasoning):"];
  if (!cat) out.push("  (the catalog could not be read right now)");
  else
    for (const p of cat.providers.filter((x) => x.available)) {
      for (const m of cat.models.filter((x) => x.providerId === p.id && !x.hidden).slice(0, 20))
        out.push(`  ${p.id}/${m.modelId}  ${m.name}  reasoning: ${m.reasoning.join("/") || "—"}${m.defaultReasoning ? ` (default ${m.defaultReasoning})` : ""}`);
    }
  const below = reach(e, by)
    .map((id) => e.repo.getNode(runId, id)!)
    .filter((n) => n && n.status !== "done");
  out.push("", below.length ? `Agents below you (${below.length}): id · role · model · status` : "Nobody is below you.");
  const fmt = (r: ModelRef | null) => (r ? `${r.providerId}/${r.modelId}${r.reasoning ? `:${r.reasoning}` : ""}` : "(none)");
  for (const n of below.slice(0, 80)) out.push(`  ${n.id} · ${e.label(n)} · ${fmt(n.model ?? e.run(runId).slots[n.slot] ?? null)}${n.modelOverride ? " (set individually)" : ""} · ${n.status}`);
  if (below.length > 80) out.push(`  … and ${below.length - 80} more; select them by role, app or under.`);
  out.push("", "Change them with helm_set_model: by nodes, or by role (manager, lead, ui, code, platform, security, test, data, compliance, assets, reviewer, slop, gates, specialists, all), optionally in one app or under one of your reports.");
  return out.join("\n").slice(0, 12_000);
}

/** One reminder for unacked notices (the target of a directive only) when the node goes idle (§6.4). */
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
  /** Hands-off: the supervisor that decided it (helm_resolve), named in the notices. */
  decidedBy?: string;
}

type ResolveHooks = { signoff(appId: string, d: DirectiveInfo): Promise<void>; sendback(appId: string, d: DirectiveInfo): Promise<void> };
type Resolved = { need: ReturnType<Engine["repo"]["getNeed"]>; directive: DirectiveInfo | null; already?: string };

/** Needs being resolved right now: a double click, or the panel and the CLI together, must not apply a decision twice. */
const RESOLVING = new Set<string>();

export async function resolveNeed(e: Engine, runId: string, needId: string, res: NeedResolution, hooks: ResolveHooks): Promise<Resolved> {
  const key = `${runId}:${needId}`;
  if (RESOLVING.has(key)) return { need: e.repo.getNeed(runId, needId), directive: null, already: `${needId} is already being resolved; nothing more to do.` };
  RESOLVING.add(key);
  try {
    return await resolveNeedOnce(e, runId, needId, res, hooks);
  } finally {
    RESOLVING.delete(key);
  }
}

async function resolveNeedOnce(e: Engine, runId: string, needId: string, res: NeedResolution, hooks: ResolveHooks): Promise<Resolved> {
  const need = e.repo.getNeed(runId, needId);
  if (!need) throw new HelmError(`No need ${needId}.`, "not_found");
  // a second click, a stale card or another resolver got there first: say so instead of failing
  if (need.state !== "open") {
    const how = (need.resolution as { action?: string } | null)?.action;
    const mins = need.resolvedAt ? Math.max(1, Math.round((e.now() - need.resolvedAt) / 60_000)) : 0;
    const ago = mins ? ` ${mins < 90 ? `${mins} min` : `${Math.round(mins / 60)} h`} ago` : "";
    return { need, directive: null, already: `${needId} was already resolved${how ? ` (${how})` : ""}${ago}; nothing more to do.` };
  }
  const target = need.nodeId ?? ORCH_ID;
  const text = res.text?.trim() ?? "";
  const who = res.decidedBy ? { actor: res.actor, decidedBy: res.decidedBy } : {};
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
          directive = await createDirective(e, runId, { ...who, type: "plan", target: ORCH_ID, text: text || summary, needId, actor: res.actor });
        } else if (res.action === "approve") {
          const appIds = ((need.data as { appIds?: string[] })?.appIds ?? []).filter(Boolean);
          directive = await createDirective(e, runId, { ...who, type: "plan", target: ORCH_ID, text: text || `admit ${appIds.join(", ")}`, needId, actor: res.actor });
          e.repo.tx(() => {
            for (const a of appIds) e.admitAppTx(runId, a, `wave approved (${directive!.id})`);
          });
          await e.pump(runId);
        }
        break;
      }
      const perm = need.data as { permissionFor?: string; choices?: Record<string, PermissionMode> } | null;
      if (perm?.permissionFor) {
        const mode = res.action === "answer" ? perm.choices?.[text] : undefined;
        if (!mode) throw new HelmError(`Choose one of: ${Object.keys(perm.choices ?? {}).join("; ")}.`, "invalid_value");
        e.setProviderPermission(runId, perm.permissionFor, mode, res.actor === "system" ? "Helm" : "The human chose");
        await e.pump(runId);
        break;
      }
      if (res.action === "answer" && !text) throw new HelmError("An answer needs text.", "invalid_value");
      directive = await createDirective(e, runId, { ...who, type: res.action, target, text: text || (res.action === "approve" ? "approved" : "denied"), needId });
      break;
    }
    case "nudge": {
      // a working agent is asked for a status report and gets another stall window; a stopped one is retried
      const n = need.nodeId ? e.repo.getNode(runId, need.nodeId) : null;
      if (n?.threadId && !["failed", "idle", "needs"].includes(n.status)) {
        e.repo.tx(() => {
          e.repo.updateNode(runId, n.id, { nudgedAt: e.now() });
          e.sendFromHelm(runId, n.id, `status check: ${res.decidedBy ?? "the human"} asks for a helm_report (progress, blocked or done, with evidence).${text ? ` ${text}` : ""}`, { mode: "steer", key: `nudge-human:${runId}:${needId}` });
          e.repo.event(runId, n.id, "nudge", `nudged again by ${res.decidedBy ?? "the human"}`);
        });
        e.outbox.kick();
        break;
      }
      directive = await createDirective(e, runId, { ...who, type: "retry", target, text });
      break;
    }
    case "retry":
      directive = await createDirective(e, runId, { ...who, type: "retry", target, text });
      break;
    case "change_model":
      if (!res.model) throw new HelmError("Choose a model.", "invalid_value");
      directive = await createDirective(e, runId, { ...who, type: "model", target, modelTo: res.model, text });
      e.repo.tx(() => {
        const n = e.node(runId, target);
        if (!n.threadId && (n.status === "needs" || n.status === "failed")) e.repo.updateNode(runId, n.id, { status: "queued", firstInLine: true, prevStatus: null, warning: null });
      });
      if (e.node(runId, target).threadId && e.node(runId, target).status === "failed") await createDirective(e, runId, { ...who, type: "retry", target, text: "retry on the new model" });
      await e.pump(runId);
      break;
    case "stop":
      directive = await createDirective(e, runId, { ...who, type: "stop", target, cascade: need.kind === "slop" || need.kind === "signoff" ? "subtree" : "self", text });
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
      directive = await createDirective(e, runId, { ...who, type: "stop", target: ORCH_ID, cascade: "subtree", text: text || "run stopped from the budget prompt" });
      // like ending the run: every agent (the Planner and Git agent have no parent) is stopped and archived
      e.repo.tx(close);
      await completeRun(e, runId, "cancelled");
      return { need: e.repo.getNeed(runId, needId), directive };
    case "signoff":
      if (!need.appId) throw new HelmError("This item is not about an app.", "bad_state");
      directive = await createDirective(e, runId, { ...who, type: "signoff", target: e.leadOf(runId, need.appId)!.id, text, needId });
      await hooks.signoff(need.appId, directive);
      break;
    case "sendback":
      if (!need.appId) throw new HelmError("This item is not about an app.", "bad_state");
      if (!text) throw new HelmError("Send back needs a reason.", "invalid_value");
      directive = await createDirective(e, runId, { ...who, type: "sendback", target: e.leadOf(runId, need.appId)!.id, text, needId });
      await hooks.sendback(need.appId, directive);
      break;
    case "waive": {
      const app = need.appId ? e.repo.getApp(runId, need.appId) : null;
      // the gate judging now (the app sits in its stage after the fix-round cap), else either gate
      const atGate = app && (app.stage === "review" || app.stage === "slop") ? e.repo.getNode(runId, `${app.id}.${app.stage}`) : null;
      const gate = atGate ?? (need.appId ? e.repo.getNode(runId, `${need.appId}.slop`) ?? e.repo.getNode(runId, `${need.appId}.review`) : null);
      directive = await createDirective(e, runId, { ...who, type: "waive", target: gate?.id ?? target, findingIds: res.findingIds, text, rotatedConfirmed: res.rotatedConfirmed });
      // a waiver alone moves nothing: the gate judges the same commit again with those findings set aside
      const head = app ? e.repo.appExtra(runId, app.id).integrationHead : null;
      if (atGate?.threadId && head) {
        const d = directive;
        e.repo.tx(() => {
          e.repo.updateNode(runId, atGate.id, { status: "running", lastActivityAt: e.now(), nudgedAt: null });
          e.sendFromHelm(runId, atGate.id, `Re-check commit ${head}: the human waived ${(res.findingIds ?? []).join(", ") || "findings"} (${d.id}${text ? `: ${text}` : ""}). Leave the waived findings out, confirm nothing else blocks, and submit one helm_verdict for ${head}.`, { key: `waive-recheck:${runId}:${atGate.id}:${d.id}` });
        });
        e.outbox.kick();
      }
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
  e.fire(e.pump(runId), `pump ${runId}`);
}

export function stagePctOf(stage: Parameters<typeof stagePct>[0]): number {
  return stagePct(stage);
}
