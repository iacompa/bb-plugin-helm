// Hands-off (autonomy high): Helm runs like a company. The human says what they want, where and
// how good, and is stopped only for keys and accounts, real spending and private data. Everything
// else Helm would have put in Needs you becomes a card for someone on the team: the Fixer takes
// every failed, stuck or modelless agent (its own failures go to the Orchestrator), an App Lead
// its squad's BB prompts, a Manager its apps' sign-off and gate disputes, the Orchestrator the
// rest. They decide with helm_resolve. A failed agent is first retried automatically, twice.

import type { NeedInfo, NeedKind, NodeInfo, RunInfo } from "../../shared/types.ts";
import { ORCH_ID } from "../domain/topology.ts";
import { ensureFixerNode, FIXER_ID, fixerCanTake, wakeFixer } from "./custom.ts";
import type { Engine } from "./engine.ts";

/** What may reach the human with autonomy on: words a key, login, account, payment or private-data question uses. */
const HUMAN_TOPIC =
  /\b(api[ -]?keys?|keys? (?:for|to)|secrets?|access tokens?|auth tokens?|api tokens?|passwords?|passphrases?|credentials?|log ?ins?|sign(?:ing)?[ -]?in|sign[ -]?up|accounts?|2fa|otp|oauth|certificates?|provisioning profiles?|signing identit(?:y|ies)|keychain|apple developer|app store connect|play console|developer program|subscriptions?|billing|payments?|pay for|paid|purchases?|buy|invoices?|credit card|pricing|costs? money|\$\d+|usd|budget (?:cap|raise|increase)|personal data|pii|privacy|private data|gdpr|hipaa|consent|legal|licen[cs]e (?:fee|key|agreement|terms)|terms of service|admin password|sudo)\b/i;

/** True when a question for the human is about keys and accounts, spending or private data. */
export function humanTopic(text: string): boolean {
  return HUMAN_TOPIC.test(text);
}

/** Card kinds a supervisor decides when autonomy is on (plus agents' BB prompts). */
const TEAM_KINDS = new Set<NeedKind>(["failed", "slop", "stalled", "signoff", "model"]);
const DECIDERS = new Set(["orchestrator", "manager", "lead"]);

const live = (n: NodeInfo | null | undefined): n is NodeInfo => !!n?.threadId && !["failed", "done", "idle", "paused"].includes(n.status);

/** The Orchestrator, when it can take decisions now (a live thread nobody stopped or paused). */
export function orchAvailable(e: Engine, runId: string): NodeInfo | null {
  const o = e.repo.getNode(runId, ORCH_ID);
  return live(o) ? o : null;
}

/** The node above `n` (the Planner, the Git agent and custom agents without a parent answer to the Orchestrator). */
function above(e: Engine, n: NodeInfo): NodeInfo | null {
  if (n.parentId) return e.repo.getNode(n.runId, n.parentId);
  return n.id === ORCH_ID ? null : e.repo.getNode(n.runId, ORCH_ID);
}

/** The nearest working supervisor above `n`, or null (nobody: the human decides). */
export function supervisorAbove(e: Engine, n: NodeInfo): NodeInfo | null {
  for (let up = above(e, n), hops = 0; up && hops < 8; up = above(e, up), hops++) if (DECIDERS.has(up.tier) && live(up)) return up;
  return null;
}

/** An app's verdicts (sign-off, gate findings past the fix rounds) are its manager's call: a lead does not judge its own gates. */
function appJudge(e: Engine, runId: string, appId: string): NodeInfo | null {
  const app = e.repo.getApp(runId, appId);
  const mgr = app?.managerNodeId ? e.repo.getNode(runId, app.managerNodeId) : null;
  if (live(mgr)) return mgr;
  return mgr ? supervisorAbove(e, mgr) : orchAvailable(e, runId);
}

/** A card the Fixer takes: an agent that failed (not a gate's verdict), got stuck or has no model. Never its own. */
function forFixer(kind: NeedKind, nodeId: string | null, verdict: boolean): boolean {
  return (kind === "failed" || kind === "stalled" || kind === "model") && !verdict && nodeId !== FIXER_ID;
}

/** The run's Fixer when it can take a card (created on first use, so runs started before it have one too). */
function fixerFor(e: Engine, runId: string): NodeInfo | null {
  const n = ensureFixerNode(e, runId);
  return fixerCanTake(n) ? n : null;
}

/**
 * Who decides a new card: "human", or the id of whoever on the team decides it (autonomy on): the
 * Fixer for failed and stuck agents, else the supervisor closest to the work. Keys, spending,
 * private data, the provider permission mode and completing the run stay with the human.
 */
export function handlerFor(e: Engine, run: RunInfo, x: { kind: NeedKind; nodeId: string | null; appId?: string | null; interactionId?: string | null; data?: unknown }): string {
  if (!e.autonomous(run) || run.status !== "running") return "human";
  const d = x.data as { completeRun?: boolean; permissionFor?: string; findingIds?: string[] } | null | undefined;
  if (d?.completeRun || d?.permissionFor) return "human";
  const prompt = !!x.interactionId && (x.kind === "approval" || x.kind === "question" || x.kind === "decision");
  if (!TEAM_KINDS.has(x.kind) && !prompt) return "human";
  // the human chose to approve every command themselves
  if (prompt && x.kind === "approval" && e.settings.approvePrompts === "human") return "human";
  const verdict = x.kind === "signoff" || x.kind === "slop" || (x.kind === "failed" && !!d?.findingIds);
  if (verdict && x.appId) return appJudge(e, run.id, x.appId)?.id ?? "human";
  if (forFixer(x.kind, x.nodeId, verdict)) {
    const f = fixerFor(e, run.id);
    if (f) return f.id;
  }
  const n = x.nodeId ? e.repo.getNode(run.id, x.nodeId) : null;
  if (!n) return orchAvailable(e, run.id)?.id ?? "human";
  return supervisorAbove(e, n)?.id ?? "human";
}

/** The helm_resolve actions a card takes. */
export function cardActions(need: NeedInfo): string[] {
  switch (need.kind) {
    case "signoff":
      return ["signoff", "sendback"];
    case "slop":
      return ["sendback", "waive", "stop"];
    case "failed":
      return (need.data as { findingIds?: string[] } | null)?.findingIds ? ["sendback", "waive", "stop"] : ["retry", "stop"];
    case "stalled":
      return ["nudge", "retry", "stop"];
    case "model":
      return [];
    default:
      return need.interactionId ? (need.kind === "approval" ? ["approve", "deny"] : ["answer"]) : [];
  }
}

const GUIDE: Partial<Record<NeedKind, string>> = {
  signoff: "Sign it off when both gates passed on this commit, its checks are green and it meets the quality the human asked for in the brief: the unverified items listed are known limits, not reasons to wait. Signing off does what the human's setting says (the Git agent may merge into the human's branch and push). Send it back (text = exactly what to fix) only if something breaks what the brief promises.",
  failed: "Retry if the failure looks passing (an overloaded provider, a dropped turn); Helm already retried it automatically. If it keeps failing, move it to another model with helm_set_model (that retries it and closes this card), or stop it and give its work to someone else. A missing worktree does not come back by retrying: ask the Git agent to recreate it on the agent's branch, then retry.",
  slop: "Send it back with the findings that matter, or waive the ones that are wrong (findings + why). Stop the app only if it cannot be saved.",
  stalled: "Nudge it once; retry it if it is hung; stop it and reassign the work if it keeps stalling.",
  model: "Pick a model for it with helm_set_model (that closes this card).",
};

/** Tell the deciding supervisor a card is theirs (call inside a transaction). */
export function announceCard(e: Engine, need: NeedInfo): void {
  const to = need.handler && need.handler !== "human" ? e.repo.getNode(need.runId, need.handler) : null;
  if (!to) return;
  const acts = cardActions(need);
  const how = need.kind === "model" ? "" : `Decide with helm_resolve {needId: "${need.id}", action: ${acts.map((a) => `"${a}"`).join(" | ") || '"dismiss"'}, text: your reason}.`;
  const prompt = need.interactionId ? "An agent's BB prompt: approve ordinary work for its task (builds, tests, installs and downloads, git on its own branch); deny anything destructive outside its worktree. " : "";
  const text = [
    `Card ${need.id} is yours to decide: the human runs hands-off, so Helm does not stop for them, and this is closest to your part of the work.`,
    need.title,
    need.body.slice(0, 1200),
    need.evidence ? `Evidence: ${need.evidence.slice(0, 400)}` : "",
    `${prompt}${GUIDE[need.kind] ?? ""} ${how}`.trim(),
    "Decide now and keep the work moving. The human sees your decision and reason in the ledger and can still step in.",
  ]
    .filter(Boolean)
    .join("\n");
  e.repo.event(need.runId, to.id, "card", `${need.id} is for ${e.label(to)} to decide: ${need.title}`.slice(0, 300), need.id);
  e.sendFromHelm(need.runId, to.id, text.slice(0, 3000), { key: `card:${need.runId}:${need.id}:${to.id}`, kind: "message", commsKind: "ask" });
  // the Fixer starts with its first card (it reads the card when it starts)
  if (to.id === FIXER_ID && wakeFixer(e, need.runId)) e.emit(need.runId, "node.updated", e.repo.getNode(need.runId, FIXER_ID));
}

/** A card left undecided this long moves one level up (from the Orchestrator: to the human). */
export const CARD_TIMEOUT_MS = 2 * 3600_000;
const REMIND_EVERY_MS = 45 * 60_000;

/**
 * Watchdog pass over the cards supervisors decide: remind a decider that sits idle on one, move a
 * card up a level when its decider cannot decide (stopped, paused, failed) or leaves it for hours,
 * and give it to the human when nobody above can.
 */
export function sweepCards(e: Engine, runId: string): number {
  adoptCards(e, runId);
  const cards = e.repo.listNeeds(runId, "open").filter((n) => n.handler && n.handler !== "human");
  let moved = 0;
  for (const c of cards) {
    const k = `card-since:${runId}:${c.id}`;
    const since = Number(e.repo.getMeta(k) ?? c.createdAt);
    const cur = e.repo.getNode(runId, c.handler!);
    // a Fixer that is still starting can take its cards
    const stuck = !live(cur) && !fixerCanTake(cur);
    if (stuck || e.now() - since > CARD_TIMEOUT_MS) {
      const next = cur ? supervisorAbove(e, cur) : orchAvailable(e, runId);
      const handler = next?.id ?? "human";
      e.repo.tx(() => {
        e.repo.setNeedHandler(runId, c.id, handler);
        e.repo.setMeta(k, String(e.now()));
        const why = stuck ? `${cur ? e.label(cur) : c.handler} cannot decide now` : `${cur ? e.label(cur) : c.handler} left it undecided for ${Math.round(CARD_TIMEOUT_MS / 3600_000)} hours`;
        e.repo.event(runId, cur?.id ?? ORCH_ID, "card", `${c.id} moves to ${next ? e.label(next) : "the human"}: ${why}`.slice(0, 300), c.id);
        const fresh = { ...c, handler };
        if (!next) e.repo.setMeta(adoptKey(runId, c.id), "human");
        if (next) announceCard(e, fresh);
        e.emit(runId, "need.created", fresh);
      });
      moved++;
      continue;
    }
    const rk = `card-remind:${runId}:${c.id}:${cur!.id}`;
    const last = Number(e.repo.getMeta(rk) ?? since);
    if (e.now() - last < REMIND_EVERY_MS || cur!.status === "running" || !cur!.threadId) continue;
    e.repo.tx(() => {
      e.repo.setMeta(rk, String(e.now()));
      e.sendFromHelm(runId, cur!.id, `Reminder: card ${c.id} is still yours to decide (${c.title}). Use helm_resolve now${c.kind === "model" ? " (or helm_set_model)" : ""}; left for ${Math.round(CARD_TIMEOUT_MS / 3600_000)} hours it moves up a level.`, { key: `${rk}:${e.now()}`, kind: "message", commsKind: "ask" });
    });
  }
  return moved;
}

const adoptKey = (runId: string, needId: string) => `card-adopt:${runId}:${needId}`;

/**
 * Hand the Fixer the failed and stuck agents that reached the human before it could take them
 * (cards raised while the run was paused, under autonomy Ask, or before this version), once each.
 * A card that already climbed the whole team stays with the human.
 */
function adoptCards(e: Engine, runId: string): void {
  const run = e.run(runId);
  if (!e.autonomous(run) || run.status !== "running") return;
  const waiting = e.repo.listNeeds(runId, "open").filter((c) => (!c.handler || c.handler === "human") && !c.interactionId && forFixer(c.kind, c.nodeId, !!(c.data as { findingIds?: string[] } | null)?.findingIds) && !e.repo.getMeta(adoptKey(runId, c.id)));
  if (!waiting.length) return;
  const f = fixerFor(e, runId);
  if (!f) return;
  for (const c of waiting) {
    e.repo.tx(() => {
      e.repo.setMeta(adoptKey(runId, c.id), f.id);
      e.repo.setNeedHandler(runId, c.id, f.id);
      e.repo.setMeta(`card-since:${runId}:${c.id}`, String(e.now()));
      e.repo.event(runId, f.id, "card", `${c.id} moves from the human to ${e.label(f)}: failed and stuck agents are the Fixer's`.slice(0, 300), c.id);
      const fresh = { ...c, handler: f.id };
      announceCard(e, fresh);
      e.emit(runId, "need.created", fresh);
    });
  }
}

// ───────────────────────────── automatic retries ─────────────────────────────

export const AUTO_RETRIES = 2;
const RETRY_DELAYS_MS = [2 * 60_000, 10 * 60_000];
const RETRY_WINDOW_MS = 6 * 3600_000;
const retryKey = (runId: string, nodeId: string) => `autoretry:${runId}:${nodeId}`;
/** Failures a retry in a few minutes does not fix: a missing folder, an exhausted or refused account, a model that is gone. */
const NOT_PASSING = /workspace path does not exist|no such file or directory|usage limit|quota|out of credits|insufficient (?:credits|balance|funds)|billing|unauthori[sz]ed|forbidden|invalid (?:api )?key|authentication|model .{0,60}(?:not found|unavailable|not available|does not exist)/i;

interface RetryState {
  n: number;
  at: number;
  due: number | null;
  threadId: string | null;
}

function retryState(e: Engine, runId: string, nodeId: string): RetryState | null {
  try {
    return JSON.parse(e.repo.getMeta(retryKey(runId, nodeId)) ?? "null") as RetryState | null;
  } catch {
    return null;
  }
}

/** How many automatic retries a failing agent has had lately. */
export function autoRetriesSoFar(e: Engine, node: NodeInfo): number {
  const st = retryState(e, node.runId, node.id);
  return st && e.now() - st.at < RETRY_WINDOW_MS ? st.n : 0;
}

/**
 * Autonomy on: schedule an automatic retry of an agent that failed after BB's own retries
 * (after 2 minutes, then 10). Not when its folder is gone: that fails the same way every time.
 * Returns true when a retry is scheduled (call inside a transaction).
 */
export function scheduleAutoRetry(e: Engine, node: NodeInfo, error: string, worktree: string): boolean {
  const run = e.run(node.runId);
  if (!e.autonomous(run) || run.status !== "running" || !node.threadId) return false;
  if (worktree === "missing" || NOT_PASSING.test(error)) return false;
  const n = autoRetriesSoFar(e, node);
  if (n >= AUTO_RETRIES) return false;
  const delay = RETRY_DELAYS_MS[n] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  e.repo.setMeta(retryKey(node.runId, node.id), JSON.stringify({ n: n + 1, at: e.now(), due: e.now() + delay, threadId: node.threadId } satisfies RetryState));
  e.repo.event(node.runId, node.id, "auto-retry", `failed (${error.slice(0, 120)}); Helm retries it in ${Math.round(delay / 60_000)} min (${n + 1} of ${AUTO_RETRIES})`);
  return true;
}

/** Watchdog pass: run the automatic retries that are due. */
export function runDueRetries(e: Engine, runId: string): string[] {
  const done: string[] = [];
  const prefix = retryKey(runId, "");
  for (const [k, v] of e.repo.metaByPrefix(prefix)) {
    let st: RetryState;
    try {
      st = JSON.parse(v) as RetryState;
    } catch {
      e.repo.deleteMeta(k);
      continue;
    }
    if (!st.due || st.due > e.now()) continue;
    const n = e.repo.getNode(runId, k.slice(prefix.length));
    e.repo.tx(() => {
      e.repo.setMeta(k, JSON.stringify({ ...st, due: null }));
      // someone acted first (a retry, a new model, a stop), or the thread changed: leave it
      if (!n || n.status !== "failed" || !n.threadId || n.threadId !== st.threadId) return;
      e.repo.updateNode(runId, n.id, { status: "running", endedAt: null, lastActivityAt: e.now(), nudgedAt: null, warning: null });
      e.repo.enqueue({ id: e.oid(), runId, kind: "retry", nodeId: n.id, payload: {}, idemKey: `autoretry:${runId}:${n.id}:${st.at}` });
      e.repo.event(runId, n.id, "auto-retry", `Helm retried it automatically (${st.n} of ${AUTO_RETRIES})`);
      done.push(n.id);
    });
    if (n && done.includes(n.id)) e.emit(runId, "node.updated", e.repo.getNode(runId, n.id));
  }
  return done;
}
