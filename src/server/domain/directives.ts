// Directives (§6): who a human change applies to, who must hear about it, and
// what each of them is told. Everything here is pure and table-tested.
import type {
  Cascade,
  DirectiveType,
  ModelRef,
  RecipientLevel,
} from "../../shared/types.ts";
import { ORCH_ID } from "./topology.ts";

export interface Tree {
  parentOf(id: string): string | null;
  childrenOf(id: string): string[];
  has(id: string): boolean;
}

export function treeFrom(nodes: Array<{ id: string; parentId: string | null }>): Tree {
  const parent = new Map<string, string | null>();
  const kids = new Map<string, string[]>();
  for (const n of nodes) {
    parent.set(n.id, n.parentId);
    if (!kids.has(n.id)) kids.set(n.id, []);
  }
  for (const n of nodes) {
    if (n.parentId && kids.has(n.parentId)) kids.get(n.parentId)!.push(n.id);
  }
  return {
    parentOf: (id) => parent.get(id) ?? null,
    childrenOf: (id) => kids.get(id) ?? [],
    has: (id) => parent.has(id),
  };
}

export function ancestors(tree: Tree, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  let p = tree.parentOf(id);
  while (p && !seen.has(p)) {
    out.push(p);
    seen.add(p);
    p = tree.parentOf(p);
  }
  return out;
}

export function descendants(tree: Tree, id: string): string[] {
  const out: string[] = [];
  const stack = [...tree.childrenOf(id)];
  const seen = new Set<string>([id]);
  while (stack.length) {
    const c = stack.shift()!;
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
    stack.push(...tree.childrenOf(c));
  }
  return out;
}

/** Deepest first — the order stop and archive must run in (bottom-up). */
export function bottomUp(tree: Tree, ids: string[]): string[] {
  const depth = (id: string) => ancestors(tree, id).length;
  return [...ids].sort((a, b) => depth(b) - depth(a) || a.localeCompare(b));
}

export function resolveCascade(tree: Tree, target: string, cascade: Cascade): string[] {
  if (!tree.has(target)) return [target];
  if (cascade === "self") return [target];
  if (cascade === "reports") return [target, ...tree.childrenOf(target)];
  return [target, ...descendants(tree, target)];
}

export interface Recipient {
  id: string;
  level: RecipientLevel;
  world: boolean;
}

/** §6.3 — every affected node direct; their parents full; higher ancestors digest; the Orchestrator always in world state. */
export function buildRecipients(tree: Tree, affected: string[]): Recipient[] {
  const out = new Map<string, Recipient>();
  for (const id of affected) out.set(id, { id, level: "direct", world: false });
  const affectedSet = new Set(affected);
  const parentsOfAffected = new Set(affected.map((x) => tree.parentOf(x)).filter((x): x is string => !!x));
  for (const id of affected)
    for (const a of ancestors(tree, id)) {
      if (out.has(a)) continue;
      out.set(a, { id: a, level: parentsOfAffected.has(a) && !affectedSet.has(a) ? "full" : "digest", world: false });
    }
  const orch = out.get(ORCH_ID) ?? { id: ORCH_ID, level: "digest" as const, world: false };
  orch.world = true;
  out.set(ORCH_ID, orch);
  return [...out.values()];
}

/** For the ledger and graph: collapse many direct recipients to the target + "+N below". */
export function collapseForDisplay(recipients: Recipient[], target: string, limit = 6): { shown: Recipient[]; hiddenDirect: number } {
  const direct = recipients.filter((r) => r.level === "direct");
  if (direct.length <= limit) return { shown: recipients, hiddenDirect: 0 };
  const shown = recipients.filter((r) => r.level !== "direct" || r.id === target);
  return { shown, hiddenDirect: direct.length - 1 };
}

// ───────────────────────────── notice text (§6.5) ─────────────────────────────

export interface NoticeDirective {
  id: string;
  type: DirectiveType;
  cascade: Cascade;
  text: string;
  value?: unknown;
  modelFrom?: ModelRef | null;
  modelTo?: ModelRef | null;
  implicit?: boolean;
  ts: number;
}

export interface NoticeContext {
  targetName: string;
  briefVersion: number;
  modelName: (ref: ModelRef | null | undefined) => string;
  touchedCount: number;
  /** "HH:MM" clock for the directive time. */
  clock: string;
}

export const TYPE_LABEL: Record<DirectiveType, string> = {
  tell: "Message",
  model: "Model change",
  scope: "Scope edit",
  pause: "Pause",
  resume: "Resume",
  stop: "Stop",
  retry: "Retry",
  priority: "Priority",
  waive: "Gate waiver",
  approve: "Approval",
  deny: "Denial",
  answer: "Answer",
  signoff: "Sign-off",
  sendback: "Send-back",
  plan: "Plan approval",
  policy: "Standing policy",
  spawn: "Spawn now",
  slots: "Model Studio",
};

const DIRECT_LEAD: Partial<Record<DirectiveType, string>> = {
  tell: "Message from the human",
  model: "The human changed your model",
  scope: "The human edited your brief",
  pause: "The human paused you",
  resume: "The human resumed you",
  stop: "The human stopped you",
  retry: "The human asked you to retry",
  priority: "The human changed your priority",
  waive: "The human waived a finding",
  spawn: "The human spawned you",
  signoff: "The human signed the app off",
  sendback: "The human sent the app back",
  approve: "The human approved your request",
  deny: "The human denied your request",
  answer: "The human answered your question",
  plan: "The human approved the plan",
  policy: "Message from the human",
  slots: "The human changed the model slots",
};

export function baseText(d: NoticeDirective, ctx: NoticeContext): string {
  switch (d.type) {
    case "tell":
    case "policy":
      return `“${d.text}”`;
    case "model":
      return `model changed ${ctx.modelName(d.modelFrom)} → ${ctx.modelName(d.modelTo)}`;
    case "scope":
      return `brief edited to v${ctx.briefVersion}: ${d.text}`;
    case "pause":
      return `paused: ${d.text || "held by the human"}`;
    case "resume":
      return "resumed by the human";
    case "stop":
      return "stopped by the human";
    case "retry":
      return "retry requested by the human";
    case "priority":
      return `priority set to ${String(d.value)}${d.text ? `: ${d.text}` : ""}`;
    case "waive":
      return `finding waived: ${d.text}`;
    case "spawn":
      return "spawned now by the human";
    case "signoff":
      return "signed off by the human — the app is done";
    case "sendback":
      return `sent back to Build by the human: ${d.text}`;
    case "approve":
      return `approved by the human: ${d.text}`;
    case "deny":
      return `denied by the human: ${d.text}`;
    case "answer":
      return `answered by the human: ${d.text}`;
    case "plan":
      return `plan approved by the human: ${d.text}`;
    case "slots":
      return d.text;
  }
}

function scopeNote(c: Cascade): string {
  return c === "self" ? "" : c === "reports" ? " Applies to this agent and its direct reports." : " Applies to this agent and everyone below it.";
}

function implicitNote(d: NoticeDirective): string {
  return d.implicit ? " (typed directly in the agent's thread)" : "";
}

export type NoticeKind = RecipientLevel | "world";

export function noticeText(d: NoticeDirective, kind: NoticeKind, ctx: NoticeContext): string {
  const base = baseText(d, ctx);
  const sn = scopeNote(d.cascade);
  if (kind === "direct") {
    const lead = DIRECT_LEAD[d.type] ?? "Message from the human";
    const tail =
      d.type === "model"
        ? " Applies from your next turn — do not revert it."
        : d.type === "pause"
          ? " Stop after the current step and wait."
          : d.type === "scope"
            ? " Re-read BRIEF.md and stay inside the new scope."
            : d.type === "tell" || d.type === "policy"
              ? " Treat this as binding; adapt your plan."
              : "";
    return `${lead} (${d.id})${implicitNote(d)}: ${base}.${tail}${sn}`;
  }
  if (kind === "full")
    return `Your direct report ${ctx.targetName} was changed by the human (${d.id})${implicitNote(d)} — ${base}.${sn} This is binding: do not undo it; adjust your plan and reply with helm_ack ${d.id}.`;
  const digest = `${d.id} · ${ctx.targetName} — ${base} (by human${d.implicit ? ", typed directly in the agent's thread" : ""}, ${ctx.clock}).`;
  if (kind === "digest") return digest;
  return `${digest} Recorded in world state: ${ctx.touchedCount} agents touched by you.`;
}

/** Notice for recipient r — the Orchestrator's line carries the world-state tail when it is only a digest. */
export function noticeFor(d: NoticeDirective, r: Recipient, ctx: NoticeContext): string {
  if (r.level === "digest" && r.world) return noticeText(d, "world", ctx);
  return noticeText(d, r.level, ctx);
}

/** One-line ledger summary (prototype dirSummary). */
export function directiveSummary(d: NoticeDirective, ctx: NoticeContext): string {
  const nm = ctx.targetName;
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 2)}…` : s);
  switch (d.type) {
    case "tell":
    case "policy":
      return `${nm}: “${cut(d.text, 90)}”`;
    case "model":
      return `${nm}: model ${ctx.modelName(d.modelFrom)} → ${ctx.modelName(d.modelTo)}`;
    case "scope":
      return `${nm}: brief edited (v${ctx.briefVersion}) — ${cut(d.text, 70)}`;
    case "pause":
      return `${nm}: paused — ${d.text || "held by you"}`;
    case "resume":
      return `${nm}: resumed`;
    case "stop":
      return `${nm}: stopped`;
    case "retry":
      return `${nm}: retry requested`;
    case "priority":
      return `${nm}: priority ${String(d.value)}${d.text ? ` — ${d.text}` : ""}`;
    case "waive":
      return `${nm}: finding waived — ${d.text}`;
    case "approve":
      return `${nm}: approved — ${d.text}`;
    case "deny":
      return `${nm}: denied — ${d.text}`;
    case "answer":
      return `${nm}: answered — ${d.text}`;
    case "signoff":
      return `${nm}: signed off`;
    case "sendback":
      return `${nm}: sent back to Build — ${d.text}`;
    case "plan":
      return `${nm}: plan approved — ${d.text}`;
    case "slots":
      return d.text;
    case "spawn":
      return `${nm}: spawned now`;
  }
}

/** §6.6 delivery: direct uses the human's mode; full/digest queue unless urgent. */
export function deliveryModeFor(type: DirectiveType, level: RecipientLevel, humanMode: "steer" | "queue"): "steer" | "queue" {
  if (level === "direct") return humanMode;
  const urgent = type === "stop" || type === "pause" || type === "model" || type === "priority" || type === "signoff" || type === "sendback";
  if (level === "full" && urgent) return "steer";
  return "queue";
}

/** Whether a directive type changes the target and so marks it "touched". */
export function touches(type: DirectiveType): boolean {
  return !["approve", "deny", "answer", "plan", "slots"].includes(type);
}

/** Questions to the Orchestrator are not directives (§6.8). */
export function isQuestion(text: string): boolean {
  const t = text.trim();
  return /\?\s*$/.test(t) || /^(what|which|how|why|who|where|status|summary|show|list|tell me)\b/i.test(t);
}

/** Coalesce digest lines for one recipient created within a window (§6.6). */
export function coalesceDigests(lines: Array<{ ts: number; text: string }>, windowMs = 20_000): string[] {
  const sorted = [...lines].sort((a, b) => a.ts - b.ts);
  const out: string[] = [];
  let bucket: string[] = [];
  let start = -Infinity;
  for (const l of sorted) {
    if (l.ts - start > windowMs) {
      if (bucket.length) out.push(bucket.join("\n"));
      bucket = [];
      start = l.ts;
    }
    bucket.push(l.text);
  }
  if (bucket.length) out.push(bucket.join("\n"));
  return out;
}

/** Which directive types make sense for a node in a given state (Direct tab). */
export function allowedTypes(node: { tier: string; status: string; hasThread: boolean }): DirectiveType[] {
  const out: DirectiveType[] = ["tell", "model", "scope", "priority"];
  if (node.status === "paused") out.push("resume");
  else if (!["done", "idle", "failed", "planned"].includes(node.status)) out.push("pause");
  if (node.hasThread && !["done", "idle"].includes(node.status)) out.push("stop");
  if (["failed", "idle"].includes(node.status) && node.hasThread) out.push("retry");
  if (node.status === "planned" || node.status === "queued") out.push("spawn");
  if (node.tier === "gate") out.push("waive");
  return out;
}

// ───────────────────────────── supervisor steering (helm_direct) ─────────────────────────────

/** What a supervisor may do to someone below it. Everything else (scope, stop, waivers) stays with the human. */
export const AGENT_ACTIONS = ["tell", "pause", "resume", "priority", "model"] as const;
export type AgentAction = (typeof AGENT_ACTIONS)[number];

/** Whether `by` may steer `target`: anyone strictly below it, except gates, whose independence only the human may touch. */
export function steerProblem(tree: Tree, by: string, target: { id: string; tier: string }): string | null {
  if (target.id === by) return "You cannot steer yourself.";
  if (!ancestors(tree, target.id).includes(by)) return `${target.id} is not below you. Steer only your own reports and their teams; route anything else through your parent.`;
  if (target.tier === "gate") return "Gates (Reviewer, Slop Hunter) judge independently; only the human can steer them. Send fixes to the builders instead.";
  return null;
}

/**
 * Who hears about a supervisor's directive. The target is told directly; everyone
 * between the supervisor and the target, and everyone above the supervisor, gets
 * one FYI line that rides along with their next turn (it never wakes them). The
 * supervisor itself is not a recipient: it hears the acknowledgement instead.
 */
export function buildAgentRecipients(tree: Tree, by: string, target: string): Recipient[] {
  const out: Recipient[] = [{ id: target, level: "direct", world: false }];
  for (const a of ancestors(tree, target)) if (a !== by) out.push({ id: a, level: "digest", world: a === ORCH_ID });
  return out;
}

/**
 * Who hears about a supervisor's model change. Nobody is woken: each changed agent gets one line
 * on its next turn, and everyone above them except the supervisor gets one FYI line.
 */
export function buildAgentModelRecipients(tree: Tree, by: string, affected: string[]): Recipient[] {
  const out = new Map<string, Recipient>();
  for (const id of affected) out.set(id, { id, level: "digest", world: id === ORCH_ID });
  for (const id of affected) for (const a of ancestors(tree, id)) if (a !== by && !out.has(a)) out.set(a, { id: a, level: "digest", world: a === ORCH_ID });
  return [...out.values()];
}

export function agentNoticeText(d: NoticeDirective & { type: AgentAction }, level: RecipientLevel, ctx: NoticeContext & { byName: string; byId: string }): string {
  const what =
    d.type === "tell"
      ? `“${d.text}”`
      : d.type === "pause"
        ? `paused${d.text ? `: ${d.text}` : ""}`
        : d.type === "resume"
          ? `resumed${d.text ? `: ${d.text}` : ""}`
          : d.type === "model"
            ? `model → ${ctx.modelName(d.modelTo)}${d.text ? `: ${d.text}` : ""}`
            : `priority set to ${String(d.value)}${d.text ? `: ${d.text}` : ""}`;
  if (level === "direct") {
    // a pause needs no ack (it is never reminded); everything else is acknowledged in one line
    if (d.type === "pause") return `Direction from ${ctx.byName} (${ctx.byId}, ${d.id}): ${what}. Stop after the current step and wait; no ack needed.`;
    const tail = d.type === "tell" ? " Follow it unless it conflicts with a human directive or policy; the human's word wins (say so in your ack)." : "";
    return `Direction from ${ctx.byName} (${ctx.byId}, ${d.id}): ${what}.${tail} Reply with helm_ack ${d.id} in one line.`;
  }
  return `${d.id} · ${ctx.byName} → ${ctx.targetName}: ${what} (${ctx.clock}).`;
}

/** Ledger line for a supervisor's directive. */
export function agentSummary(d: NoticeDirective & { type: AgentAction }, ctx: { byName: string; targetName: string; modelName?: (r: ModelRef | null | undefined) => string }): string {
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 2)}…` : s);
  const what =
    d.type === "tell"
      ? `“${cut(d.text, 90)}”`
      : d.type === "priority"
        ? `priority ${String(d.value)}`
        : d.type === "model"
          ? `model → ${ctx.modelName ? ctx.modelName(d.modelTo) : d.modelTo?.modelId ?? "—"}`
          : d.type === "pause"
            ? "paused"
            : "resumed";
  return `${ctx.byName} → ${ctx.targetName}: ${what}`;
}
