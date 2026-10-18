// Reacting to BB (§9.4–9.7): lifecycle events, receipts, native interactions,
// implicit directives, the stall watchdog (Helm's DB only) and reconcile.
// Never polls BB: everything here runs because BB told us something, because
// the human acted, or because the watchdog read our own database.

import type { HelmEvent, InteractionLite } from "../bb/port.ts";
import type { Engine } from "./engine.ts";
import type { NodeInfo, NeedKind } from "../../shared/types.ts";
import { createDirective, remindUnacked } from "./direct.ts";
import { spendFromTokens } from "../domain/models.ts";
import { isQuestion } from "../domain/directives.ts";
import { nodeWorktree } from "./gates.ts";
import { expirePrompts, getPrompt, rerouteOpenPrompts, routePrompt } from "./prompts.ts";
import { sweep } from "./watch.ts";

const TERMINAL = new Set(["done", "failed"]);
const COMPACT_AT = 0.7;

export function installEventHandler(e: Engine, opts: { selfPluginIds?: string[]; onPlannerEvent?: (ev: HelmEvent) => Promise<boolean> } = {}): void {
  e.eventHandler = (ev) => handleEvent(e, ev, opts);
}

export async function handleEvent(e: Engine, ev: HelmEvent, opts: { selfPluginIds?: string[]; onPlannerEvent?: (ev: HelmEvent) => Promise<boolean> } = {}): Promise<void> {
  if (ev.type === "message.dispatched" || ev.type === "message.cancelled") return receipts(e, ev);
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
      if (!node.branch) void e.refreshEnv(node.runId, node.id);
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
        e.repo.enqueue({ id: e.oid(), runId: node.runId, kind: "compact", nodeId: node.id, payload: {}, idemKey: key });
        e.sendFromHelm(node.runId, node.id, `Your context is past ${Math.round(COMPACT_AT * 100)}% of its window. It is being compacted now; afterwards re-read your BRIEF${node.role === "orch" ? " and PORTFOLIO.md" : ""} and call helm_context before continuing.`, { key: `${key}:msg` });
      });
    }
  }
  remindUnacked(e, e.repo.getNode(node.runId, node.id)!);
  e.outbox.kick();
  await e.pump(node.runId);
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
  if (node.role === "planner") {
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
    const p = JSON.parse(r.payload_json) as { nodeIds?: string[] };
    return !!p.nodeIds?.includes(node.id);
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
  return /^(FYI from Helm|Reminder: please call helm_ack|Report from |Re-check commit |Fix round |CONTRACT\.md is now|# BRIEF\.md|status check:|Your context is past)/.test(text);
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
      try {
        nudged.push(...(await sweep(e, run)));
      } catch (err) {
        e.log.warn(`watcher sweep for ${run.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (expirePrompts(e, run.id, (n, i, note) => raiseInteractionNeed(e, n, i, note))) e.emit(run.id, "run.updated", { id: run.id });
      e.proposeNextWave(run.id);
      continue;
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
        const raised = e.raiseNeed(run.id, { kind: "stalled", nodeId: n.id, appId: n.appId, title: `${e.label(n)} has been silent for ${Math.round((now - last) / 60_000)} min`, body: "It was nudged once and has not answered.", evidence: `last activity ${new Date(last).toISOString()}`, options: ["Nudge again", "Retry", "Stop"], dedupeKey: `stalled:${n.id}:${flags.nudgedAt}` });
        if (raised) stalled.push(n.id);
      }
    }
    if (expirePrompts(e, run.id, (n, i, note) => raiseInteractionNeed(e, n, i, note))) e.emit(run.id, "run.updated", { id: run.id });
    e.proposeNextWave(run.id);
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
