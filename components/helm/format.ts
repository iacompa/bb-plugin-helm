// Labels, constants and small pure helpers for the Helm app. These mirror the
// server's domain rules (re-implemented here: the app never imports server code).
import type {
  Catalog,
  CatalogModel,
  DirectiveInfo,
  DirectiveType,
  ModelRef,
  NodeStatus,
  Role,
  SlotId,
  SlotMap,
  SnapApp,
  SnapNode,
  Stage,
} from "./types.ts";

export const STAGES: Array<{ id: Stage; label: string; hint: string }> = [
  { id: "intake", label: "Intake", hint: "Waiting for capacity or a spec slot" },
  { id: "spec", label: "Spec", hint: "Lead writes SPEC, ARCHITECTURE, CONTRACT" },
  { id: "build", label: "Build", hint: "Specialists build in parallel worktrees" },
  { id: "integrate", label: "Integrate", hint: "Lead merges, runs deterministic checks" },
  { id: "review", label: "Review", hint: "Independent Reviewer agent" },
  { id: "slop", label: "Slop check", hint: "Slop Hunter + deterministic slop scan" },
  { id: "fix", label: "Fix", hint: "At most two fix rounds" },
  { id: "ready", label: "Ready", hint: "Gates green — waiting for your sign-off" },
  { id: "done", label: "Done", hint: "Signed off" },
];
export const STAGE_IDX: Record<Stage, number> = { intake: 0, spec: 1, build: 2, integrate: 3, review: 4, slop: 5, fix: 6, ready: 7, done: 8, cancelled: 9 };
export const stageLabel = (s: Stage | string) => STAGES.find((x) => x.id === s)?.label ?? (s === "cancelled" ? "Cancelled" : String(s));

export const TASK_COLS = [
  { id: "planned", label: "Planned", hint: "Not spawned yet" },
  { id: "queued", label: "Queued / held", hint: "Waiting for capacity, or paused by you" },
  { id: "running", label: "Running", hint: "" },
  { id: "waiting", label: "Waiting", hint: "On children, a gate, or fixes" },
  { id: "needs", label: "Needs you", hint: "Approvals, questions, failures" },
  { id: "done", label: "Done", hint: "" },
] as const;
export type TaskCol = (typeof TASK_COLS)[number]["id"];

export const ST: Record<string, string> = {
  planned: "Planned",
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
  needs: "Needs you",
  paused: "Paused",
  idle: "Idle",
  failed: "Failed",
  done: "Done",
};
export const statusLabel = (s: string | null | undefined) => (s ? ST[s] ?? s : "Unknown");

export const PLAT: Record<string, string> = { mac: "macOS", win: "Windows", ios: "iOS", and: "Android" };

export const ROLE_LABEL: Record<Role, string> = {
  orch: "Orchestrator",
  mgr: "Manager",
  lead: "App lead",
  ui: "UI builder",
  code: "Code builder",
  platform: "Platform builder",
  security: "Security",
  test: "Test",
  review: "Reviewer",
  slop: "Slop Hunter",
  research: "Research",
  docs: "Docs",
};

/** Host icon names (only names from BB's verified icon list). */
export const ROLE_ICON: Record<Role, string> = {
  orch: "Workflow",
  mgr: "Layers",
  lead: "Target",
  ui: "AppWindow",
  code: "Code",
  platform: "Laptop",
  security: "SecurityCheck",
  test: "Beaker",
  review: "Eye",
  slop: "Clean",
  research: "Explore",
  docs: "FileText",
};
export function roleIcon(n: { role: Role; platform?: string | null }): string {
  if (n.role === "platform") return n.platform === "ios" || n.platform === "and" ? "Smartphone" : "Laptop";
  return ROLE_ICON[n.role] ?? "Bot";
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
export const TYPE_ICON: Record<DirectiveType, string> = {
  tell: "MessageSquare",
  model: "Brain",
  scope: "FileText",
  pause: "Pause",
  resume: "Play",
  stop: "Square",
  retry: "RotateCcw",
  priority: "ArrowUp",
  waive: "SecurityCheck",
  approve: "Check",
  deny: "X",
  answer: "MessageSquare",
  signoff: "CircleCheck",
  sendback: "ArrowTurnBackward",
  plan: "Layers",
  policy: "Layers",
  spawn: "Play",
  slots: "SlidersHorizontal",
};

export const SLOT_DEFS: Array<{ id: SlotId; group: "Coordination" | "Build" | "Gates" | "Support"; name: string; desc: string; role: Role }> = [
  { id: "orchestrator", group: "Coordination", name: "Orchestrator", desc: "Strategy, staffing and the portfolio view. Reads everything.", role: "orch" },
  { id: "manager", group: "Coordination", name: "Managers", desc: "Oversee up to four app leads each. Roll up status.", role: "mgr" },
  { id: "lead", group: "Coordination", name: "App leads", desc: "One per app: spec, contract, integration, decisions.", role: "lead" },
  { id: "ui", group: "Build", name: "UI builders", desc: "Design system, screens, motion.", role: "ui" },
  { id: "code", group: "Build", name: "Code builders", desc: "Core logic, data layer, functionality.", role: "code" },
  { id: "platform", group: "Build", name: "Platform builders", desc: "macOS · Windows · iOS · Android glue.", role: "platform" },
  { id: "security", group: "Build", name: "Security", desc: "Threat model, dependency and secrets audit.", role: "security" },
  { id: "test", group: "Build", name: "Test", desc: "Test plans and UI tests (optional per app).", role: "test" },
  { id: "review", group: "Gates", name: "Reviewer", desc: "Independent code and UI review, one per app.", role: "review" },
  { id: "slop", group: "Gates", name: "Slop Hunter", desc: "AI-slop check: filler, fakes, dead code, invented APIs.", role: "slop" },
  { id: "research", group: "Support", name: "Research", desc: "Reads docs, SDKs and competitors for leads.", role: "research" },
  { id: "docs", group: "Support", name: "Docs", desc: "README, store listings, changelogs.", role: "docs" },
];
export const SLOT_GROUPS = ["Coordination", "Build", "Gates", "Support"] as const;

export const REASON_LABEL: Record<string, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
  ultracode: "Ultracode",
};
export const PROVIDER_LABEL: Record<string, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  "acp-cursor": "Cursor (ACP)",
  "acp-grok": "Grok (ACP)",
};
/** Provider colour token (CSS variable defined in helm.css). */
export function providerVar(providerId: string | null | undefined): string {
  if (!providerId) return "var(--h-p-other)";
  if (providerId.includes("codex")) return "var(--h-p-codex)";
  if (providerId.includes("claude")) return "var(--h-p-claude)";
  if (providerId.includes("cursor")) return "var(--h-p-cursor)";
  return "var(--h-p-other)";
}
export const MGR_HUES = ["var(--h-m0)", "var(--h-m1)", "var(--h-m2)", "var(--h-m3)", "var(--h-m4)"];
export const mgrHue = (managerIds: string[], id: string | null | undefined) => {
  const i = id ? managerIds.indexOf(id) : -1;
  return i < 0 ? "var(--h-fg-4)" : MGR_HUES[i % MGR_HUES.length];
};

const ref = (providerId: string, modelId: string, reasoning: string | null): ModelRef => ({ providerId, modelId, reasoning });
export const SEED_PRESETS: Record<string, SlotMap> = {
  "Studio default": {
    ui: ref("codex", "gpt-6.1-sol", "xhigh"),
    code: ref("claude-code", "claude-sonnet-5-5", "high"),
    review: ref("codex", "gpt-6.1-sol", "high"),
    slop: ref("claude-code", "claude-sonnet-5-5", "high"),
  },
  "Cheap dev run": Object.fromEntries(SLOT_DEFS.map((s) => [s.id, ref("claude-code", "claude-haiku-5-5", "low")])) as SlotMap,
  "Max quality": {
    orchestrator: ref("claude-code", "claude-opus-5-5", "max"),
    manager: ref("claude-code", "claude-opus-5-5", "high"),
    lead: ref("claude-code", "claude-opus-5-5", "high"),
    ui: ref("codex", "gpt-6.1-sol", "max"),
    code: ref("claude-code", "claude-opus-5-5", "high"),
    platform: ref("claude-code", "claude-opus-5-5", "high"),
    security: ref("codex", "gpt-6.1-sol", "xhigh"),
    test: ref("claude-code", "claude-sonnet-5-5", "high"),
    review: ref("codex", "gpt-6.1-sol", "xhigh"),
    slop: ref("claude-code", "claude-opus-5-5", "high"),
    research: ref("claude-code", "claude-sonnet-5-5", "medium"),
    docs: ref("claude-code", "claude-sonnet-5-5", "medium"),
  },
};

// ───────────── numbers and time ─────────────

export const plural = (n: number, a: string, b?: string) => `${n} ${n === 1 ? a : b ?? `${a}s`}`;
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
/** Relative units (never dollars). */
export const fmtUnits = (x: number | null | undefined) => {
  const v = Number(x ?? 0);
  return `${v < 10 ? v.toFixed(2) : Math.round(v).toLocaleString("en-US")} u`;
};
/** Raw token counts → "12k" / "1.4M". */
export const fmtTokens = (t: number | null | undefined) => {
  const v = Number(t ?? 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${Math.round(v / 1000)}k`;
  return String(Math.round(v));
};
export const clockOf = (ms: number | null | undefined) => {
  if (!ms) return "—";
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
export const agoOf = (ms: number | null | undefined, now = Date.now()) => {
  if (!ms) return "—";
  const m = Math.max(0, Math.round((now - ms) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60 ? `${m % 60}m ` : ""}ago`;
  return `${Math.floor(h / 24)}d ago`;
};
export const durationOf = (from: number | null | undefined, to: number | null | undefined = Date.now()) => {
  if (!from) return "—";
  const m = Math.max(0, Math.round(((to ?? Date.now()) - from) / 60000));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

// ───────────── models ─────────────

export function findModel(cat: Catalog | null | undefined, r: ModelRef | null | undefined): CatalogModel | null {
  if (!cat || !r) return null;
  return cat.models.find((m) => m.providerId === r.providerId && m.modelId === r.modelId) ?? null;
}
export function modelName(cat: Catalog | null | undefined, r: ModelRef | null | undefined): string {
  if (!r) return "unset";
  return findModel(cat, r)?.name ?? r.modelId;
}
export const reasonLabel = (r: string | null | undefined) => (r ? REASON_LABEL[r] ?? r : "");
export function modelText(cat: Catalog | null | undefined, r: ModelRef | null | undefined): string {
  if (!r) return "unset";
  return `${modelName(cat, r)}${r.reasoning ? ` ${reasonLabel(r.reasoning)}` : ""}`;
}
export const sameRef = (a: ModelRef | null | undefined, b: ModelRef | null | undefined) =>
  !!a && !!b && a.providerId === b.providerId && a.modelId === b.modelId && (a.reasoning ?? null) === (b.reasoning ?? null);

export const BASE_TOK: Record<Role, number> = { orch: 1800, mgr: 700, lead: 1400, ui: 900, code: 1100, platform: 800, security: 350, test: 300, review: 500, slop: 300, research: 300, docs: 300 };
export const RW: Record<string, number> = { none: 0.5, low: 0.7, medium: 0.85, high: 1, xhigh: 1.35, max: 1.7, ultra: 2.2, ultracode: 1.8 };
export const UNIT_PER_KTOK = 0.0075;
export const FORECAST_LOW = 0.7;
export const FORECAST_HIGH = 1.35;

export function weightOf(cat: Catalog | null | undefined, r: ModelRef | null | undefined): number {
  const m = findModel(cat, r);
  return m?.weight ?? 1;
}
export function agentCost(role: Role, r: ModelRef | null | undefined, cat: Catalog | null | undefined): number {
  const rw = r?.reasoning ? RW[r.reasoning] ?? 1 : 1;
  return BASE_TOK[role] * weightOf(cat, r) * rw * UNIT_PER_KTOK;
}
/** Forecast for a node set: each node uses its own override or the slot model. */
export function forecastNodes(
  nodes: Array<{ role: Role; slot: SlotId; model?: ModelRef | null; modelOverride?: boolean }>,
  slots: SlotMap,
  cat: Catalog | null | undefined,
): { units: number; low: number; high: number } {
  let units = 0;
  for (const n of nodes) units += agentCost(n.role, (n.modelOverride ? n.model : null) ?? slots[n.slot] ?? n.model ?? null, cat);
  return { units, low: units * FORECAST_LOW, high: units * FORECAST_HIGH };
}

export function familyOf(cat: Catalog | null | undefined, r: ModelRef | null | undefined): string | null {
  if (!r) return null;
  const m = findModel(cat, r);
  if (m?.family) return m.family;
  const id = r.modelId.toLowerCase();
  if (id.includes("claude")) return "Claude";
  if (id.includes("gpt") || id.startsWith("o")) return "GPT";
  if (id.includes("grok")) return "Grok";
  return r.providerId;
}
export function familyWarnings(cat: Catalog | null | undefined, slots: SlotMap): string[] {
  const out: string[] = [];
  const gates: Array<[SlotId, string]> = [["review", "Reviewer"], ["slop", "Slop Hunter"]];
  const builders: Array<[SlotId, string]> = [["ui", "UI builders"], ["code", "Code builders"]];
  for (const [g, gl] of gates)
    for (const [b, bl] of builders) {
      const fg = familyOf(cat, slots[g]);
      if (fg && fg === familyOf(cat, slots[b])) out.push(`${gl} and ${bl} are both ${fg} models — they can share blind spots.`);
    }
  return out;
}
/** Problems with a model ref against the live catalog. */
export function refProblem(cat: Catalog | null | undefined, r: ModelRef | null | undefined): string | null {
  if (!r || !cat || !cat.models.length) return null;
  const prov = cat.providers.find((p) => p.id === r.providerId);
  if (prov && !prov.available) return `${prov.label} is not available on this machine.`;
  const m = findModel(cat, r);
  if (!m) return `${r.modelId} is not in the live catalog.`;
  if (r.reasoning && m.reasoning.length && !m.reasoning.includes(r.reasoning)) return `${m.name} does not offer ${reasonLabel(r.reasoning)} reasoning.`;
  return null;
}

// ───────────── nodes, apps ─────────────

export function nodeLabel(n: { label?: string; id: string } | null | undefined): string {
  return n ? n.label || n.id : "";
}
/** Breadcrumb label like the prototype: "Wellness manager", "Lumen lead". */
export function trailLabel(n: SnapNode | null | undefined, apps?: Record<string, SnapApp>): string {
  if (!n) return "";
  if (n.role === "orch") return "Orchestrator";
  if (n.role === "lead" && n.appId && apps?.[n.appId]) return `${apps[n.appId].name} lead`;
  return n.label || n.id;
}
export function roleText(n: SnapNode): string {
  return ROLE_LABEL[n.role] ?? n.role;
}

/** App status for colouring: the worst/most active state among its members. */
export function appStatus(app: SnapApp, members: SnapNode[]): NodeStatus {
  if (app.stage === "done") return "done";
  if (app.stage === "cancelled") return "failed";
  const has = (s: NodeStatus) => members.some((m) => m.status === s);
  if (has("failed")) return "failed";
  if (has("needs") || app.stage === "ready") return "needs";
  if (has("running")) return "running";
  if (has("waiting")) return "waiting";
  if (has("paused")) return "paused";
  if (members.length && members.every((m) => m.status === "planned")) return "planned";
  if (has("queued")) return "queued";
  return members.length ? "idle" : "planned";
}
export function stagePillClass(stage: Stage): string {
  if (stage === "done") return "done";
  if (stage === "ready") return "ready";
  if (stage === "fix") return "fix";
  if (stage === "cancelled") return "cancelled";
  if (stage === "review" || stage === "slop") return "gate";
  if (stage === "spec" || stage === "build" || stage === "integrate") return "run";
  return "";
}

// ───────────── directives ─────────────

export function isQuestion(text: string): boolean {
  return /\?\s*$/.test(text) || /^(what|which|how|why|who|where|status|summary|show|list|tell me)\b/i.test(text.trim());
}
export const SELF_ONLY: DirectiveType[] = ["approve", "deny", "answer", "plan", "signoff", "sendback", "waive", "slots", "spawn"];
export function allowedTypes(node: { tier: string; status: string; threadId?: string | null }): DirectiveType[] {
  const hasThread = !!node.threadId;
  const out: DirectiveType[] = ["tell", "model", "scope", "priority"];
  if (node.status === "paused") out.push("resume");
  else if (!["done", "idle", "failed", "planned"].includes(node.status)) out.push("pause");
  if (hasThread && !["done", "idle"].includes(node.status)) out.push("stop");
  if (["failed", "idle"].includes(node.status) && hasThread) out.push("retry");
  if (node.status === "planned" || node.status === "queued") out.push("spawn");
  if (node.tier === "gate") out.push("waive");
  return out;
}
export function receiptCounts(d: DirectiveInfo) {
  const c = { queued: 0, delivered: 0, ack: 0, rec: 0, failed: 0 };
  for (const r of d.recipients) c[r.state] = (c[r.state] ?? 0) + 1;
  return c;
}
/** Receipts that still wait for something (queued, or delivered but not acked by a direct/full recipient). */
export function pendingReceipts(d: DirectiveInfo): number {
  return d.recipients.filter((r) => r.state === "queued" || r.state === "failed" || (r.state === "delivered" && r.level !== "digest")).length;
}

// ───────────── board rules (§5.7) ─────────────

export type AppMove = { ok: true; noop: true } | { ok: true; noop?: false; act: "signoff" | "sendback" | "start" | "reopen"; label: string } | { ok: false; why: string };
export function appMoveRule(app: { name: string; stage: Stage }, to: Stage): AppMove {
  const from = app.stage;
  if (from === to) return { ok: true, noop: true };
  if (from === "ready" && to === "done") return { ok: true, act: "signoff", label: "Sign off" };
  if (from === "ready" && to === "build") return { ok: true, act: "sendback", label: "Send back to Build" };
  if (from === "intake" && to === "spec") return { ok: true, act: "start", label: "Start now" };
  if (from === "done" && to === "ready") return { ok: true, act: "reopen", label: "Reopen" };
  if (from === "ready" || from === "done") return { ok: false, why: `${stageLabel(from)} apps can be signed off or sent back to Build — not moved to ${stageLabel(to)}.` };
  if (STAGE_IDX[to] > STAGE_IDX[from])
    return {
      ok: false,
      why: `${app.name} moves to ${stageLabel(to)} when its ${from === "build" ? "builders finish and integration checks pass" : from === "review" ? "Reviewer passes" : from === "slop" ? "Slop Hunter passes" : "work completes"} — stages advance on evidence, not on drag.`,
    };
  return { ok: false, why: "Stages don’t run backwards by drag. To redo work, send the app back from Ready, or tell its lead what to redo." };
}
export function colOfStatus(s: NodeStatus | string): TaskCol {
  const map: Record<string, TaskCol> = { planned: "planned", queued: "queued", paused: "queued", idle: "queued", running: "running", waiting: "waiting", needs: "needs", failed: "needs", done: "done" };
  return map[s] ?? "queued";
}
export type TaskMove = { ok: true; noop: true } | { ok: true; noop?: false; act: "start" | "spawn" | "hold"; label: string } | { ok: false; why: string };
export function taskMoveRule(node: { status: NodeStatus | string }, to: TaskCol): TaskMove {
  const from = colOfStatus(node.status);
  if (from === to) return { ok: true, noop: true };
  if ((from === "planned" || from === "queued") && to === "running") return { ok: true, act: "start", label: node.status === "planned" ? "Spawn and start now" : "Start now" };
  if (from === "planned" && to === "queued") return { ok: true, act: "spawn", label: "Spawn (queue)" };
  if (from === "running" && to === "queued") return { ok: true, act: "hold", label: "Hold" };
  if (from === "needs") return { ok: false, why: "This is waiting on you — resolve it in Needs you, then it moves on its own." };
  if (from === "done") return { ok: false, why: "Done work is final. To redo it, tell the lead what to change." };
  if (to === "done" || to === "waiting" || to === "needs") return { ok: false, why: `Agents move to ${TASK_COLS.find((c) => c.id === to)!.label} when they report it, not by drag.` };
  return { ok: false, why: "That move isn’t something you can force." };
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
