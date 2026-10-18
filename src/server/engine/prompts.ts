// Supervisors approve their delegates' BB permission prompts (the "approvePrompts" setting).
// A specialist's or gate's prompt goes to its lead, a lead's to its manager, a manager's to the
// Orchestrator (the Git agent's and the Planner's too, with autonomy on). The supervisor reviews
// the command and allows, denies or escalates it with helm_approve. With autonomy on, an
// escalation or a prompt nobody answers in time climbs to the next supervisor; only the
// Orchestrator's own prompts and what it escalates or leaves reach the human. Without autonomy
// those go straight to the human. Pending prompts live in Helm's meta table, by interaction id.

import type { InteractionLite } from "../bb/port.ts";
import type { NodeInfo } from "../../shared/types.ts";
import type { Engine } from "./engine.ts";
import { supervisorAbove } from "./handsoff.ts";

/** A supervisor that does not answer within this long hands the prompt on (next supervisor, or the human). */
export const PROMPT_TIMEOUT_MS = 15 * 60_000;

export interface RoutedPrompt {
  runId: string;
  nodeId: string;
  approverId: string;
  at: number;
  interaction: InteractionLite;
}

const key = (runId: string, interactionId: string) => `prompt:${runId}:${interactionId}`;

export function getPrompt(e: Engine, runId: string, interactionId: string): RoutedPrompt | null {
  const raw = e.repo.getMeta(key(runId, interactionId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RoutedPrompt;
  } catch {
    return null;
  }
}

/** Forget a routed prompt (answered, or answered in BB directly). */
export function dropPrompt(e: Engine, runId: string, interactionId: string): void {
  e.repo.deleteMeta(key(runId, interactionId));
}

export function pendingPrompts(e: Engine, runId: string): RoutedPrompt[] {
  return e.repo.metaByPrefix(`prompt:${runId}:`).flatMap(([, v]) => {
    try {
      return [JSON.parse(v) as RoutedPrompt];
    } catch {
      return [];
    }
  });
}

/** Send an approval prompt to the agent's supervisor. Returns false when it should reach the human. */
export function routePrompt(e: Engine, node: NodeInfo, i: InteractionLite, note = ""): boolean {
  if (e.settings.approvePrompts !== "supervisor" || i.kind !== "approval") return false;
  const parent = node.parentId ? e.repo.getNode(node.runId, node.parentId) : null;
  const working = !!parent?.threadId && !["failed", "done", "idle", "paused"].includes(parent.status);
  // hands-off: an agent with no working supervisor (the Git agent, the Planner) asks the next one up
  const approver = working ? parent : e.autonomous(e.run(node.runId)) ? supervisorAbove(e, node) : null;
  if (!approver) return false;
  return sendPrompt(e, node, approver, i, note);
}

/** Who gets a prompt this approver escalates or leaves unanswered: the next supervisor up (autonomy on), else the human. */
function nextApprover(e: Engine, runId: string, approverId: string, nodeId: string): NodeInfo | null {
  if (!e.autonomous(e.run(runId))) return null;
  const a = e.repo.getNode(runId, approverId);
  const next = a ? supervisorAbove(e, a) : null;
  return next && next.id !== nodeId ? next : null;
}

function sendPrompt(e: Engine, node: NodeInfo, parent: NodeInfo, i: InteractionLite, note: string): boolean {
  const p: RoutedPrompt = { runId: node.runId, nodeId: node.id, approverId: parent.id, at: e.now(), interaction: i };
  const up = nextApprover(e, node.runId, parent.id, node.id);
  const next = up ? e.label(up) : "the human";
  const text = [
    `Permission request from ${e.label(node)} (${node.id}) — prompt ${i.id}:`,
    ...(note ? [note] : []),
    i.title,
    i.body ? i.body.slice(0, 1500) : "",
    "",
    "You approve commands for the human. Allow ordinary work for its task: building, testing, reading files, installing and downloading what the work needs, git on its own branch. Deny anything destructive outside its worktree, force-pushes, deleting other agents' work, or anything you cannot tell is safe.",
    `Escalate only for a key, password or login, spending real money, or private data; it goes to ${next}.`,
    `Answer now with helm_approve {promptId: "${i.id}", decision: "allow" | "deny" | "escalate", reason}. It is waiting on you; after ${PROMPT_TIMEOUT_MS / 60_000} minutes it goes to ${next}.`,
  ]
    .join("\n");
  e.repo.tx(() => {
    e.repo.setMeta(key(node.runId, i.id), JSON.stringify(p));
    e.repo.comms(node.runId, { from: node.id, to: parent.id, kind: "ask", summary: `permission: ${i.title}`.slice(0, 300) });
    e.sendFromHelm(node.runId, parent.id, text.slice(0, 3000), { senderNodeId: node.id, kind: "message", commsKind: "ask", key: `prompt:${node.runId}:${i.id}:${parent.id}` });
    e.repo.event(node.runId, node.id, "prompt", `permission prompt sent to ${e.label(parent)}: ${i.title}`.slice(0, 300));
  });
  return true;
}

/** Approval cards already waiting in Needs you (from before this setting) go to the supervisors instead. */
export function rerouteOpenPrompts(e: Engine, runId: string): number {
  if (e.settings.approvePrompts !== "supervisor") return 0;
  let n = 0;
  for (const need of e.repo.listNeeds(runId, "open")) {
    if (need.kind !== "approval" || !need.interactionId || !need.nodeId) continue;
    const node = e.repo.getNode(runId, need.nodeId);
    const threadId = (need.data as { threadId?: string } | null)?.threadId ?? node?.threadId;
    if (!node || !threadId) continue;
    const title = need.title.startsWith(`${e.label(node)}: `) ? need.title.slice(e.label(node).length + 2) : need.title;
    const i: InteractionLite = { id: need.interactionId, threadId, kind: "approval", title, body: need.body, options: [], questions: [], decisions: [] };
    if (!routePrompt(e, node, i)) continue;
    e.repo.tx(() => {
      e.repo.resolveNeed(runId, need.id, { action: "dismiss", text: `sent to ${node.parentId} to approve` });
      if (node.status === "needs" && !e.repo.openNeedsFor(runId, node.id).length) e.repo.updateNode(runId, node.id, { status: "running", prevStatus: null });
    });
    n++;
  }
  return n;
}

/** The supervisor's answer. Returns the tool result text. */
export function answerPrompt(e: Engine, by: NodeInfo, promptId: string, decision: "allow" | "deny" | "escalate", reason: string, raiseHuman: (node: NodeInfo, i: InteractionLite, note: string) => void): string {
  const p = getPrompt(e, by.runId, promptId);
  if (!p) return `No pending prompt ${promptId}: it was answered already or went to the human.`;
  if (p.approverId !== by.id) return `Rejected: prompt ${promptId} is for ${p.approverId} to answer, not you.`;
  const node = e.repo.getNode(by.runId, p.nodeId);
  const threadId = p.interaction.threadId || node?.threadId;
  if (!node || !threadId) {
    e.repo.deleteMeta(key(by.runId, promptId));
    return `No agent ${p.nodeId} with a thread any more; the prompt is dropped.`;
  }
  let escalatedTo = "the human";
  e.repo.tx(() => {
    e.repo.deleteMeta(key(by.runId, promptId));
    if (decision === "escalate") {
      const up = nextApprover(e, by.runId, by.id, node.id);
      if (up) {
        escalatedTo = e.label(up);
        sendPrompt(e, node, up, p.interaction, `${e.label(by)} escalated it: ${reason}`);
        return;
      }
      raiseHuman(node, p.interaction, `${e.label(by)} escalated it: ${reason}`);
      return;
    }
    e.repo.enqueue({ id: e.oid(), runId: by.runId, kind: "interaction", nodeId: node.id, payload: { threadId, interactionId: promptId, answer: decision === "allow" ? { kind: "allow" } : { kind: "deny" } }, idemKey: `prompt-answer:${promptId}` });
    e.repo.event(by.runId, node.id, decision === "allow" ? "prompt-allowed" : "prompt-denied", `${e.label(by)} ${decision === "allow" ? "allowed" : "denied"}: ${p.interaction.title} — ${reason}`.slice(0, 300));
    e.repo.comms(by.runId, { from: by.id, to: node.id, kind: "info", summary: `${decision}: ${p.interaction.title}`.slice(0, 300) });
    if (decision === "deny") e.fyi(by.runId, node.id, `${e.label(by)} denied "${p.interaction.title}": ${reason}`.slice(0, 800));
  });
  e.outbox.kick();
  return decision === "escalate" ? `Escalated to ${escalatedTo}: ${p.interaction.title}.` : `${decision === "allow" ? "Allowed" : "Denied"} for ${e.label(node)}.`;
}

/** Prompts their supervisor did not answer in time go to the human (watchdog; Helm's DB only). */
export function expirePrompts(e: Engine, runId: string, raiseHuman: (node: NodeInfo, i: InteractionLite, note: string) => void): number {
  let n = 0;
  for (const p of pendingPrompts(e, runId)) {
    if (e.now() - p.at < PROMPT_TIMEOUT_MS) continue;
    const node = e.repo.getNode(runId, p.nodeId);
    e.repo.tx(() => {
      e.repo.deleteMeta(key(runId, p.interaction.id));
      if (!node?.threadId) return;
      const late = `${p.approverId} did not answer within ${PROMPT_TIMEOUT_MS / 60_000} minutes`;
      // hands-off: the next supervisor up gets it before the human does
      const up = nextApprover(e, runId, p.approverId, node.id);
      if (up && sendPrompt(e, node, up, p.interaction, late)) return;
      raiseHuman(node, p.interaction, late);
    });
    n++;
  }
  return n;
}
