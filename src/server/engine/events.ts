// Reacting to BB (§9.4–9.7): lifecycle events, receipts, native interactions,
// implicit directives, the stall watchdog (Helm's DB only) and reconcile.
// Never polls BB: everything here runs because BB told us something, because
// the human acted, or because the watchdog read our own database.

import type { HelmEvent, InteractionLite } from "../bb/port.ts";
import type { Engine } from "./engine.ts";
import type { NodeInfo, NeedKind } from "../../shared/types.ts";
import { createDirective, remindUnacked } from "./direct.ts";
import { askKey } from "./asks.ts";
import { spendFromTokens } from "../domain/models.ts";
import { isQuestion } from "../domain/directives.ts";
import { nodeWorktree } from "./gates.ts";
import { dropPrompt, expirePrompts, getPrompt, pendingPrompts, rerouteOpenPrompts, routePrompt } from "./prompts.ts";
import { sweep } from "./watch.ts";
import { auditWorktrees } from "./worktrees.ts";
import { COMPACT_AT } from "./context.ts";
import { worktreesViewFor } from "../worktree-view.ts";

const TERMINAL = new Set(["done", "failed"]);

export function installEventHandler(e: Engine, opts: { selfPluginIds?: string[]; onPlannerEvent?: (ev: HelmEvent) => Promise<boolean> } = {}): void {
  e.eventHandler = (ev) => handleEvent(e, ev, opts);
}

export async function handleEvent(e: Engine, ev: HelmEvent, opts: { selfPluginIds?: string[]; onPlannerEvent?: (ev: HelmEvent) => Promise<boolean> } = {}): Promise<void> {
  if (ev.type === "message.dispatched" || ev.type === "message.cancelled") {
    // a queued message starting means the turn before it ended without the thread going idle:
    // questions that turn was answering are due now (read before receipts makes this message's own question live)
    const node = ev.type === "message.dispatched" ? e.repo.nodeByThread(ev.threadId) : null;
    const due = node ? liveAsks(e, node) : [];
    receipts(e, ev);
    if (node && due.length) {
      const out = await e.port.threadOutput(ev.threadId).catch(() => null);
      passOnAnswers(e, node, out, new Set(due));
      e.outbox.kick();
    }
    return;
  }
  if (opts.onPlannerEvent && (await opts.onPlannerEvent(ev))) return;
  const node = e.repo.nodeByThread(ev.threadId);
  if (!node) return; // not ours: the Observatory reads these, Helm never acts on them
  const run = e.repo.getRun(node.runId);
  if (!run) return;
  const now = e.now();
  switch (ev.type) {
    case "thread.created":
    case "thread.activity":
      e.repo.updateNode(node.runId, node.id, { lastActivityAt: now });
      return;
    case "thread.active": {
      // a stop Helm has not carried out yet wins over a stale "active" (the turn is about to be stopped)
      if (stopPending(e, node)) return;
      // a node Helm stopped can see an "active" that was emitted before the stop landed: confirm once with BB
      if (node.status === "idle" && node.endedAt) {
        const st = await e.port.threadState(ev.threadId).catch(() => null);
        if (!st || (st.status !== "active" && st.status !== "starting")) return;
        e.repo.updateNode(node.runId, node.id, { endedAt: null });
      }
      e.repo.updateNode(node.runId, node.id, { lastActivityAt: now, nudgedAt: null });
      if (["waiting", "queued", "idle", "done"].includes(node.status) && run.status !== "cancelled") e.setStatus(node.runId, node.id, "running", { warning: node.status === "done" ? null : node.warning });
      await settleAnsweredInBb(e, node);
      if (!node.branch) e.fire(e.refreshEnv(node.runId, node.id), `refresh workspace of ${node.id}`);
      if (e.repo.unflushedInbox(node.runId, node.id).length) e.scheduleFlush(node.runId, node.id);
      return;
    }
    case "thread.idle":
      return onIdle(e, node, ev.lastText);
    case "thread.failed": {
      if (TERMINAL.has(node.status) && node.status === "failed") return;
      let worktree = "unknown";
      try {
        const wt = await nodeWorktree(e, node);
        if (wt) {
          const st = await e.host(node.runId).status({ path: wt });
          worktree = st.head ? `intact at ${st.head.slice(0, 9)}${st.clean ? "" : ` with ${st.dirty.length} uncommitted changes`}` : "missing";
        }
      } catch {
        worktree = "could not be checked";
      }
      e.repo.tx(() => {
        e.repo.updateNode(node.runId, node.id, { status: "failed", endedAt: now, warning: (ev.error ?? "failed").slice(0, 200) });
        e.raiseNeed(node.runId, {
          kind: "failed",
          nodeId: node.id,
          appId: node.appId,
          title: `${e.label(node)} failed after BB's retries`,
          body: `${ev.error ?? "The provider reported a failure."}\nWorktree: ${worktree}.`,
          evidence: `thread ${node.threadId}`,
          options: ["Retry", "Change model and retry", "Stop"],
          dedupeKey: `failed:${node.id}:${node.threadId}`,
        });
      });
      e.emit(node.runId, "node.updated", e.repo.getNode(node.runId, node.id));
      await e.pump(node.runId);
      return;
    }
    case "thread.archived": {
      if (e.archiving.delete(ev.threadId)) return;
      if (TERMINAL.has(node.status) || node.status === "idle") return;
      e.repo.tx(() => {
        e.repo.updateNode(node.runId, node.id, { status: "idle", endedAt: now, warning: "archived outside Helm" });
        e.repo.event(node.runId, node.id, "archived", "the thread was archived outside Helm");
      });
      e.emit(node.runId, "node.updated", e.repo.getNode(node.runId, node.id));
      await e.pump(node.runId);
      return;
    }
    case "interaction.pending":
      return onInteraction(e, node, ev.interaction);
    case "turn.failed":
      // provider-retry handles attempts; Helm only records it (§9.5)
      e.repo.event(node.runId, node.id, "turn.failed", `turn failed (${ev.category ?? "unknown"}), attempt ${ev.attempt}; BB is retrying`);
      return;
    case "message.queued":
      return;
    case "message.dispatch":
      return onDispatch(e, node, ev, opts.selfPluginIds ?? []);
  }
}

function receipts(e: Engine, ev: Extract<HelmEvent, { type: "message.dispatched" | "message.cancelled" }>): void {
  // a queued question: the turn that answers it starts now (or it was deleted and nobody will answer)
  const ask = e.repo.getMeta(`askq:${ev.queuedMessageId}`);
  if (ask) {
    e.repo.deleteMeta(`askq:${ev.queuedMessageId}`);
    if (ev.type === "message.dispatched" && e.repo.getMeta(ask)) e.repo.setMeta(ask, JSON.stringify({ state: "live", at: e.now() }));
    else e.repo.deleteMeta(ask);
  }
  const rs = e.repo.recipientsByQueuedMessage(ev.queuedMessageId);
  if (!rs.length) return;
  e.repo.tx(() => {
    for (const r of rs) {
      if (ev.type === "message.dispatched") {
        if (r.state !== "queued") continue;
        e.repo.updateRecipient(r.runId, r.directiveId, r.nodeId, { state: "delivered", deliveredAt: e.now() });
        e.emit(r.runId, "receipt.updated", { directiveId: r.directiveId, nodeId: r.nodeId, state: "delivered" });
      } else {
        e.repo.updateRecipient(r.runId, r.directiveId, r.nodeId, { state: "failed" });
        e.repo.event(r.runId, r.nodeId, "receipt.failed", `${r.directiveId}: the queued notice was deleted before delivery`);
        e.emit(r.runId, "receipt.updated", { directiveId: r.directiveId, nodeId: r.nodeId, state: "failed" });
      }
    }
  });
}

/**
 * A thread that runs again after a permission prompt may have been answered in BB itself: close Helm's
 * cards and routed prompts for interactions BB no longer lists, and put the agent back to work.
 */
async function settleAnsweredInBb(e: Engine, node: NodeInfo): Promise<void> {
  const routed = pendingPrompts(e, node.runId).filter((p) => p.nodeId === node.id);
  if (node.status !== "needs" && !routed.length) return;
  const live = await e.port.listInteractions(node.threadId!).catch(() => null);
  if (!live) return;
  const ids = new Set(live.map((i) => i.id));
  const gone = e.repo.openNeedsFor(node.runId, node.id).filter((n) => n.interactionId && !ids.has(n.interactionId));
  e.repo.tx(() => {
    for (const p of routed) if (!ids.has(p.interaction.id)) dropPrompt(e, node.runId, p.interaction.id);
    for (const n of gone) {
      e.repo.resolveNeed(node.runId, n.id, { action: "answered in BB" });
      e.emit(node.runId, "need.resolved", { id: n.id, action: "answered in BB" });
    }
    const cur = e.repo.getNode(node.runId, node.id);
    if (gone.length && cur?.status === "needs" && !e.repo.openNeedsFor(node.runId, node.id).length) {
      e.repo.updateNode(node.runId, node.id, { prevStatus: null });
      e.setStatus(node.runId, node.id, "running");
    }
  });
}

async function onIdle(e: Engine, node: NodeInfo, lastText: string | null): Promise<void> {
  const run = e.run(node.runId);
  let used: { usedTokens: number; window: number } | null = null;
  try {
    used = await e.port.threadContext(node.threadId!);
  } catch {
    used = null;
  }
  const fresh = e.repo.getNode(node.runId, node.id)!;
  const tokens = fresh.tokens + (used?.usedTokens ?? 0);
  const cost = spendFromTokens(tokens, fresh.model, e.settings.weights);
  e.repo.tx(() => {
    e.repo.updateNode(node.runId, node.id, { lastActivityAt: e.now(), turns: fresh.turns + 1, tokens, cost, nudgedAt: null });
    if (fresh.status === "running") {
      const warn = fresh.tier === "specialist" && !e.repo.reportsFor(node.runId, node.id, 1).length ? "went idle without a report" : fresh.warning;
      e.setStatus(node.runId, node.id, "waiting", { warning: warn });
    }
    if (lastText) e.repo.event(node.runId, node.id, "idle", lastText.slice(0, 200));
  });
  e.emit(node.runId, "spend.updated", { nodeId: node.id, tokens, cost, runSpend: e.spend(node.runId) });
  // budget (§9.6)
  const spend = e.spend(node.runId);
  if (!run.spawnsPaused && spend >= run.budgetCap && run.status === "running") {
    e.repo.tx(() => {
      e.repo.updateRun(node.runId, { spawnsPaused: true });
      e.raiseNeed(node.runId, { kind: "budget", nodeId: null, appId: null, title: `Budget cap reached (${Math.round(spend)} of ${Math.round(run.budgetCap)} u)`, body: "Spawns are paused. Running agents finish their current turn; nothing new starts.", evidence: "", options: ["Raise cap", "Keep paused", "Stop run"], dedupeKey: "budget" });
    });
    e.emit(node.runId, "spawns.paused", { paused: true, reason: "budget" });
  }
  // context hygiene (§8.6)
  if (used && used.window > 0 && used.usedTokens / used.window > COMPACT_AT) {
    const bucket = Math.floor(tokens / 200_000);
    const key = `compact:${node.runId}:${node.id}:${fresh.turns}`;
    if (e.repo.getMeta(`compact:${node.runId}:${node.id}`) !== String(bucket)) {
      e.repo.tx(() => {
        e.repo.setMeta(`compact:${node.runId}:${node.id}`, String(bucket));
        // the agent is told only once the compaction really happened (handleCompact)
        e.repo.enqueue({ id: e.oid(), runId: node.runId, kind: "compact", nodeId: node.id, payload: { key }, idemKey: key });
      });
    }
  }
  remindUnacked(e, e.repo.getNode(node.runId, node.id)!);
  passOnAnswers(e, node, lastText);
  e.outbox.kick();
  await e.pump(node.runId);
}

const ASK_TTL_MS = 24 * 3600_000;

/**
 * Another agent asked this one a question and the turn that answered it has ended without a
 * helm_message back (that clears the question). An answer written in the agent's own thread
 * reaches no agent, so Helm passes it on, and the asker is woken to use it.
 */
function askState(v: string): { state?: string; at?: number } {
  try {
    return JSON.parse(v) as { state?: string; at?: number };
  } catch {
    return {}; // unreadable: forgotten at the next pass
  }
}

/** The questions to this node whose answering turn is running. */
function liveAsks(e: Engine, node: NodeInfo): string[] {
  return e.repo.metaByPrefix(askKey(node.runId, node.id, "")).filter(([, v]) => askState(v).state === "live").map(([k]) => k);
}

function passOnAnswers(e: Engine, node: NodeInfo, lastText: string | null, only?: Set<string>): void {
  const prefix = askKey(node.runId, node.id, "");
  for (const [k, v] of e.repo.metaByPrefix(prefix)) {
    if (only && !only.has(k)) continue;
    const st = askState(v);
    if (st.state !== "live") {
      if (!st.at || e.now() - st.at > ASK_TTL_MS) e.repo.deleteMeta(k);
      continue;
    }
    e.repo.deleteMeta(k);
    const asker = e.repo.getNode(node.runId, k.slice(prefix.length));
    if (!asker || asker.status === "done") continue;
    const answer = (lastText ?? "").trim();
    const text = answer
      ? `Answer from ${e.label(node)} (${node.id}) to your question. It replied in its own thread instead of with helm_message, so Helm passes it on:\n${answer.length > 1800 ? `${answer.slice(0, 1800)}…` : answer}`
      : `${e.label(node)} (${node.id}) finished the turn your question started, and Helm found no answer from it. You have no answer: ask again, or tell it what you need.`;
    e.sendFromHelm(node.runId, asker.id, text, { key: `answer:${k}:${e.now()}`, senderNodeId: node.id, kind: "message", commsKind: "info" });
  }
}

function needKindFor(i: InteractionLite): NeedKind {
  if (i.kind === "question") return "question";
  if (i.kind === "plan") return "decision";
  return "approval";
}

async function onInteraction(e: Engine, node: NodeInfo, i: InteractionLite): Promise<void> {
  if (e.repo.needByInteraction(i.id) || getPrompt(e, node.runId, i.id)) return;
  if (routePrompt(e, node, i)) return;
  e.repo.tx(() => raiseInteractionNeed(e, node, i));
  e.emit(node.runId, "node.updated", e.repo.getNode(node.runId, node.id));
}

/** An agent's BB prompt as a Needs-you card (call inside a transaction). */
export function raiseInteractionNeed(e: Engine, node: NodeInfo, i: InteractionLite, note = ""): void {
  {
    e.raiseNeed(node.runId, {
      kind: needKindFor(i),
      nodeId: node.id,
      appId: node.appId,
      title: `${e.label(node)}: ${i.title}`.slice(0, 200),
      body: note ? `${note}\n${i.body}` : i.body,
      evidence: "",
      options: i.kind === "approval" ? ["Approve", "Deny"] : i.options.length ? i.options : ["Answer"],
      interactionId: i.id,
      dedupeKey: `interaction:${i.id}`,
      data: { questions: i.questions, decisions: i.decisions, threadId: i.threadId },
      setNodeNeeds: true,
    });
  }
}

/** V18 — the human typed straight into an agent's thread: record an implicit `tell` so the chain is told. */
async function onDispatch(e: Engine, node: NodeInfo, ev: Extract<HelmEvent, { type: "message.dispatch" }>, selfIds: string[]): Promise<void> {
  if (ev.initiator !== "user" || ev.senderThreadId) return;
  if (ev.originPluginId && selfIds.includes(ev.originPluginId)) return;
  const text = ev.text.trim();
  if (!text) return;
  if (isHelmText(e, node, text)) return;
  // the Planner is a conversation with the human, not a chain of command: nothing to record or relay
  if (node.role === "planner" || node.role === "git") {
    e.repo.event(node.runId, node.id, "question", `the human: ${text.slice(0, 160)}`);
    return;
  }
  if (node.role === "orch" && isQuestion(text)) {
    e.repo.event(node.runId, node.id, "question", `the human asked: ${text.slice(0, 160)}`);
    return;
  }
  await createDirective(e, node.runId, { type: "tell", target: node.id, text: text.slice(0, 2000), implicit: true, mode: "queue" });
}

function stopPending(e: Engine, node: NodeInfo): boolean {
  const rows = e.repo.db.prepare("SELECT payload_json FROM outbox WHERE run_id = ? AND kind = 'stop' AND state IN ('pending','inflight')").all(node.runId) as Array<{ payload_json: string }>;
  return rows.some((r) => {
    try {
      const p = JSON.parse(r.payload_json) as { nodeIds?: string[]; threadIds?: string[] };
      return !!p.nodeIds?.includes(node.id) || (!!node.threadId && !!p.threadIds?.includes(node.threadId));
    } catch {
      return false;
    }
  });
}

/** Was this text sent by Helm itself (a notice, a brief, a reminder)? */
function isHelmText(e: Engine, node: NodeInfo, text: string): boolean {
  const since = e.now() - 30 * 60_000;
  const rows = e.repo.db.prepare("SELECT payload_json FROM outbox WHERE run_id = ? AND node_id = ? AND kind IN ('send','spawn','retry') AND created_at >= ?").all(node.runId, node.id, since) as Array<{ payload_json: string }>;
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload_json) as { text?: string };
      if (p.text && (text.startsWith(p.text.slice(0, 200)) || p.text.startsWith(text.slice(0, 200)))) return true;
    } catch {
      // ignore malformed payloads
    }
  }
  return /^(FYI from Helm|Reminder: please call helm_ack|Report from |Re-check commit |Fix round |CONTRACT\.md is now|# BRIEF\.md|status check:|Your context (?:is|was) past)/.test(text);
}

// ───────────────────────────── watchdog (DB only) ─────────────────────────────

export async function watchdog(e: Engine): Promise<{ nudged: string[]; stalled: string[] }> {
  const nudged: string[] = [];
  const stalled: string[] = [];
  const now = e.now();
  for (const run of e.repo.activeRuns()) {
    const stallMs = run.limits.stallMinutes * 60_000;
    // a run with a Watcher model hands suspects to it instead of nudging blindly
    if (run.slots.watcher) {
      let swept = false;
      try {
        nudged.push(...(await sweep(e, run)));
        swept = true;
      } catch (err) {
        e.log.warn(`watcher sweep for ${run.id} failed, using the plain stall checks this pass: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (swept) {
        if (expirePrompts(e, run.id, (n, i, note) => raiseInteractionNeed(e, n, i, note))) e.emit(run.id, "run.updated", { id: run.id });
        e.proposeNextWave(run.id);
        continue;
      }
    }
    for (const n of e.repo.nodesByStatus(run.id, ["running"])) {
      if (!n.threadId) continue;
      const last = n.lastActivityAt ?? n.spawnedAt ?? now;
      if (now - last < stallMs) continue;
      const flags = e.repo.nodeFlags(run.id, n.id);
      if (!flags.nudgedAt) {
        e.repo.tx(() => {
          e.repo.updateNode(run.id, n.id, { nudgedAt: now });
          e.sendFromHelm(run.id, n.id, "status check: reply with helm_report (progress, blocked or done, with evidence).", { mode: "steer", key: `nudge:${run.id}:${n.id}:${last}` });
          e.repo.event(run.id, n.id, "nudge", `no activity for ${Math.round((now - last) / 60_000)} min — nudged once`);
        });
        nudged.push(n.id);
      } else if (now - flags.nudgedAt >= stallMs) {
        const raised = e.raiseNeed(run.id, { kind: "stalled", nodeId: n.id, appId: n.appId, title: `${e.label(n)} has been silent for ${Math.round((now - last) / 60_000)} min`, body: "It was nudged once and has not answered.", evidence: `last activity ${new Date(last).toISOString()}`, options: ["Nudge again", "Retry", "Stop"], dedupeKey: `stalled:${n.id}:${flags.nudgedAt}`, snoozeMs: Number.MAX_SAFE_INTEGER });
        if (raised) stalled.push(n.id);
      }
    }
    if (expirePrompts(e, run.id, (n, i, note) => raiseInteractionNeed(e, n, i, note))) e.emit(run.id, "run.updated", { id: run.id });
    e.proposeNextWave(run.id);
  }
  // the worktree rule: the Git agent hears about any app over the limits (throttled, host calls);
  // the Worktrees view is read again in the background (git every 30 min, sizes every 2 h)
  for (const run of e.repo.activeRuns()) {
    await auditWorktrees(e, run.id).catch((err) => e.log.warn(`worktree check for ${run.id} failed: ${err instanceof Error ? err.message : String(err)}`));
    void worktreesViewFor(e).refreshIfStale(run.id).catch(() => {});
  }
  e.outbox.kick();
  return { nudged, stalled };
}

// ───────────────────────────── reconcile (§9.4) ─────────────────────────────

export async function reconcile(e: Engine, runId: string): Promise<{ checked: number; changes: string[] }> {
  const changes: string[] = [];
  const rerouted = rerouteOpenPrompts(e, runId);
  if (rerouted) changes.push(`${rerouted} waiting permission prompts sent to the agents' supervisors`);
  const run = e.run(runId);
  const nodes = e.repo.listNodes(runId).filter((n) => !["planned", "done"].includes(n.status));
  for (const n of nodes) {
    if (!n.threadId) {
      const spawning = e.repo.pendingForNode(n.id, runId).some((o) => o.kind === "spawn");
      if (!spawning && ["running", "waiting"].includes(n.status)) {
        e.repo.updateNode(runId, n.id, { status: "queued" });
        changes.push(`${n.id}: no thread → queued`);
      }
      continue;
    }
    const st = await e.port.threadState(n.threadId);
    if (!st) {
      if (n.status !== "failed") {
        e.repo.tx(() => {
          e.repo.updateNode(runId, n.id, { status: "failed", warning: "thread missing" });
          e.raiseNeed(runId, { kind: "failed", nodeId: n.id, appId: n.appId, title: `${e.label(n)}: its thread is missing`, body: "BB no longer knows this thread.", evidence: `thread ${n.threadId}`, options: ["Retry", "Stop"], dedupeKey: `missing:${n.id}:${n.threadId}` });
        });
        changes.push(`${n.id}: thread missing → failed`);
      }
      continue;
    }
    if (st.archived) {
      if (!["idle", "failed"].includes(n.status)) {
        e.repo.updateNode(runId, n.id, { status: "idle", warning: "archived outside Helm" });
        changes.push(`${n.id}: archived → idle`);
      }
      continue;
    }
    if (st.status === "error" && n.status !== "failed") {
      await handleEvent(e, { type: "thread.failed", threadId: n.threadId, error: "found in error state at reconcile" });
      changes.push(`${n.id}: error → failed`);
      continue;
    }
    if (st.status === "idle" && n.status === "running") {
      e.repo.updateNode(runId, n.id, { status: "waiting" });
      changes.push(`${n.id}: idle thread → waiting`);
    }
    if (st.status === "active" && ["queued", "waiting"].includes(n.status)) {
      e.repo.updateNode(runId, n.id, { status: "running", lastActivityAt: e.now() });
      changes.push(`${n.id}: active thread → running`);
    }
    if (st.hasPendingInteraction) {
      for (const i of await e.port.listInteractions(n.threadId)) await onInteraction(e, e.repo.getNode(runId, n.id)!, i);
    }
    if (!n.branch && st.branch) {
      e.repo.updateNode(runId, n.id, { branch: st.branch, environmentId: st.environmentId });
      if (e.isLeadNode(n) && n.appId && !e.repo.appExtra(runId, n.appId).integrationBranch) e.repo.updateApp(runId, n.appId, { integrationBranch: st.branch });
    }
  }
  if (changes.length) e.emit(runId, "run.reconciled", { changes });
  e.outbox.kick();
  if (run.status === "running") await e.pump(runId);
  return { checked: nodes.length, changes };
}
