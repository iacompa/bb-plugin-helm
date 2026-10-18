// Model Studio domain (§7): catalog normalization, slot definitions, presets,
// validation, family warnings, precedence, and the relative cost model.
import type { Catalog, CatalogModel, ModelRef, Role, SlotId, SlotMap } from "../../shared/types.ts";

export const SLOT_DEFS: Array<{ id: SlotId; group: "Coordination" | "Build" | "Gates" | "Support"; name: string; desc: string; role: Role | null }> = [
  { id: "orchestrator", group: "Coordination", name: "Orchestrator", desc: "Strategy, staffing and the portfolio view. Reads everything.", role: "orch" },
  { id: "planner", group: "Coordination", name: "Planner", desc: "Answers your questions about the run and designs new agents when they help. Idle until you ask. Leave empty to use the default Planner model from Settings (Models → Default models), else the Orchestrator's model.", role: "planner" },
  { id: "git", group: "Coordination", name: "Git agent", desc: "Keeps every app to two worktrees (your checkout and one shared work worktree), sends work to GitHub or wherever you tell it, and checks what reached main. Leave empty to use the default Git agent model from Settings, else the Orchestrator's model.", role: "git" },
  { id: "manager", group: "Coordination", name: "Managers", desc: "Oversee up to four app leads each. Roll up status.", role: "mgr" },
  { id: "lead", group: "Coordination", name: "App leads", desc: "One per app: spec, contract, integration, decisions.", role: "lead" },
  { id: "ui", group: "Build", name: "UI builders", desc: "Design system, screens, motion. Asset builders use this model too.", role: "ui" },
  { id: "code", group: "Build", name: "Code builders", desc: "Core logic, backend, data layer. Data builders use this model too.", role: "code" },
  { id: "platform", group: "Build", name: "Platform builders", desc: "macOS · Windows · iOS · Android · Web glue.", role: "platform" },
  { id: "security", group: "Build", name: "Security", desc: "Threat model, dependency and secrets audit. Compliance uses this model too.", role: "security" },
  { id: "test", group: "Build", name: "Test", desc: "Test plans and UI tests (optional per app).", role: "test" },
  { id: "review", group: "Gates", name: "Reviewer", desc: "Independent code and UI review, one per app.", role: "review" },
  { id: "slop", group: "Gates", name: "Slop Hunter", desc: "AI-slop check: filler, fakes, dead code, invented APIs.", role: "slop" },
  { id: "research", group: "Support", name: "Research", desc: "Reads docs, SDKs and competitors for leads.", role: "research" },
  { id: "docs", group: "Support", name: "Docs", desc: "README, store listings, changelogs.", role: "docs" },
  { id: "watcher", group: "Support", name: "Watcher", desc: "Optional light model (e.g. Haiku low) that checks agents that look stuck and nudges, restarts or escalates them. Wakes only when something looks wrong.", role: null },
];

export const SLOT_IDS = SLOT_DEFS.map((s) => s.id);
export const COORDINATION_SLOTS: SlotId[] = ["orchestrator", "manager", "lead"];
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

const ref = (providerId: string, modelId: string, reasoning: string | null): ModelRef => ({ providerId, modelId, reasoning });

/** Seeded presets (§7.3). "Studio default" is exactly what the human said — nothing more. */
export const SEED_PRESETS: Record<string, SlotMap> = {
  "Studio default": {
    ui: ref("codex", "gpt-6.1-sol", "xhigh"),
    code: ref("claude-code", "claude-sonnet-5-5", "high"),
    review: ref("codex", "gpt-6.1-sol", "high"),
    slop: ref("claude-code", "claude-sonnet-5-5", "high"),
  },
  "Cheap dev run": Object.fromEntries(SLOT_IDS.map((s) => [s, ref("claude-code", "claude-haiku-5-5", "low")])) as SlotMap,
  "Max quality": {
    orchestrator: ref("claude-code", "claude-opus-5-5", "max"),
    planner: ref("claude-code", "claude-opus-5-5", "max"),
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
    watcher: ref("claude-code", "claude-haiku-5-5", "low"),
  },
};

/** Relative cost weights (Settings → Pricing seed). Unknown models default to 1.0 and are flagged. */
export const SEED_WEIGHTS: Record<string, number> = {
  "claude-sonnet-5-5": 1.0,
  "claude-haiku-5-5": 0.3,
  "claude-opus-5-5": 2.6,
  "claude-fable-5-1": 3.2,
  "gpt-6.1-sol": 1.5,
  "gpt-6-luna": 0.5,
  "gpt-6-astra": 1.9,
  "gpt-6-sol": 1.3,
  "gpt-5.6-sol": 1.1,
  "gpt-5.6-terra": 0.8,
  "gpt-5.6-luna": 0.4,
  "claude-opus-5": 2.4,
  "claude-sonnet-5": 0.95,
  "claude-fable-5": 3.0,
  "claude-opus-4-8": 2.2,
  "claude-sonnet-4-6": 0.9,
};

export function familyOf(providerId: string, modelId: string): string {
  const m = modelId.toLowerCase();
  if (/gpt|^o\d|codex/.test(m)) return "OpenAI";
  if (/claude|opus|sonnet|haiku|fable/.test(m)) return "Anthropic";
  if (/grok/.test(m)) return "xAI";
  if (/gemini/.test(m)) return "Google";
  if (/composer/.test(m)) return "Cursor";
  if (providerId === "codex") return "OpenAI";
  if (providerId === "claude-code") return "Anthropic";
  if (providerId === "acp-grok") return "xAI";
  return "Mixed";
}

// ───────────────────────────── catalog ─────────────────────────────

interface RawModel {
  id?: unknown;
  model?: unknown;
  displayName?: unknown;
  name?: unknown;
  description?: unknown;
  supportedReasoningEfforts?: unknown;
  reasoningLevels?: unknown;
  defaultReasoningEffort?: unknown;
  supportedServiceTiers?: unknown;
  isDefault?: unknown;
  hidden?: unknown;
  legacy?: unknown;
  deprecated?: unknown;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length ? v : null;
}

function reasoningList(raw: RawModel): string[] {
  const out: string[] = [];
  const src = Array.isArray(raw.supportedReasoningEfforts) ? raw.supportedReasoningEfforts : Array.isArray(raw.reasoningLevels) ? raw.reasoningLevels : [];
  for (const e of src) {
    if (typeof e === "string") out.push(e);
    else if (e && typeof e === "object") {
      const o = e as Record<string, unknown>;
      const id = str(o.reasoningEffort) ?? str(o.id) ?? str(o.level);
      if (id) out.push(id);
    }
  }
  return out;
}

function tierList(raw: RawModel): string[] {
  const src = Array.isArray(raw.supportedServiceTiers) ? raw.supportedServiceTiers : [];
  const out: string[] = [];
  for (const e of src) {
    if (typeof e === "string") out.push(e);
    else if (e && typeof e === "object") {
      const id = str((e as Record<string, unknown>).id);
      if (id) out.push(id);
    }
  }
  return out;
}

export function normalizeModel(
  providerId: string,
  providerLabel: string,
  raw: unknown,
  opts: { seen: Set<string>; weights: Record<string, number>; hiddenIds: Set<string> },
): CatalogModel | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as RawModel;
  const modelId = str(r.model) ?? str(r.id);
  if (!modelId) return null;
  const key = `${providerId}/${modelId}`;
  const weight = opts.weights[modelId];
  return {
    providerId,
    providerLabel,
    modelId,
    name: str(r.displayName) ?? str(r.name) ?? modelId,
    description: str(r.description),
    family: familyOf(providerId, modelId),
    reasoning: reasoningList(r),
    defaultReasoning: str(r.defaultReasoningEffort),
    serviceTiers: tierList(r),
    isDefault: r.isDefault === true,
    isNew: !opts.seen.has(key),
    hidden: opts.hiddenIds.has(key) || r.hidden === true || r.legacy === true || r.deprecated === true,
    weight: typeof weight === "number" ? weight : 1.0,
    weightKnown: typeof weight === "number",
  };
}

export function findModel(catalog: Catalog, r: ModelRef | null | undefined): CatalogModel | null {
  if (!r) return null;
  return catalog.models.find((m) => m.providerId === r.providerId && m.modelId === r.modelId) ?? null;
}

export function modelName(catalog: Catalog | null, r: ModelRef | null | undefined): string {
  if (!r) return "—";
  const m = catalog ? findModel(catalog, r) : null;
  const name = m?.name ?? r.modelId;
  const reason = r.reasoning ? ` ${REASON_LABEL[r.reasoning] ?? r.reasoning}` : "";
  return `${name}${reason}`.trim();
}

export type RefProblem =
  | { kind: "provider"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "reasoning"; message: string }
  | { kind: "tier"; message: string };

/** §7.4 — validate at wizard open, at Approve and at every spawn. Never substitutes. */
export function validateRef(catalog: Catalog, r: ModelRef): RefProblem | null {
  const p = catalog.providers.find((x) => x.id === r.providerId);
  if (!p || !p.available)
    return { kind: "provider", message: `Provider ${r.providerId} is not available on this machine — choose another model.` };
  const m = findModel(catalog, r);
  if (!m) return { kind: "unavailable", message: `Model ${r.modelId} is no longer available — choose another.` };
  if (r.reasoning && m.reasoning.length && !m.reasoning.includes(r.reasoning))
    return { kind: "reasoning", message: `${m.name} does not offer reasoning level ${r.reasoning} (it offers ${m.reasoning.join(", ")}).` };
  if (r.serviceTier && r.serviceTier !== "default" && !m.serviceTiers.includes(r.serviceTier))
    return { kind: "tier", message: `${m.name} does not offer service tier ${r.serviceTier}.` };
  return null;
}

/** Slots that need a model before Approve — every slot some planned node uses. */
export function requiredSlots(bySlot: Record<SlotId, number>): SlotId[] {
  return SLOT_IDS.filter((s) => bySlot[s] > 0);
}

export function unsetSlots(slots: SlotMap, bySlot: Record<SlotId, number>): SlotId[] {
  return requiredSlots(bySlot).filter((s) => !slots[s]);
}

/** Resolve presets against the live catalog: entries whose model vanished are reported, never replaced. */
export function resolvePreset(catalog: Catalog, preset: SlotMap): { slots: SlotMap; unavailable: Array<{ slot: SlotId; problem: string }> } {
  const slots: SlotMap = {};
  const unavailable: Array<{ slot: SlotId; problem: string }> = [];
  for (const s of SLOT_IDS) {
    const r = preset[s];
    if (!r) continue;
    const problem = validateRef(catalog, r);
    if (problem) unavailable.push({ slot: s, problem: problem.message });
    slots[s] = r;
  }
  return { slots, unavailable };
}

/** "Fill the rest like Code builders" — an explicit click, never silent. */
export function fillFromCode(slots: SlotMap, bySlot: Record<SlotId, number>): SlotMap {
  const code = slots.code;
  if (!code) return slots;
  const out: SlotMap = { ...slots };
  for (const s of requiredSlots(bySlot)) if (!out[s]) out[s] = { ...code };
  return out;
}

export function familyWarnings(catalog: Catalog | null, slots: SlotMap): string[] {
  const fam = (s: SlotId) => {
    const r = slots[s];
    if (!r) return null;
    return (catalog && findModel(catalog, r)?.family) || familyOf(r.providerId, r.modelId);
  };
  const out: string[] = [];
  const gates: Array<[SlotId, string]> = [
    ["review", "Reviewer"],
    ["slop", "Slop Hunter"],
  ];
  const builders: Array<[SlotId, string]> = [
    ["ui", "UI builders"],
    ["code", "Code builders"],
  ];
  for (const [g, gl] of gates)
    for (const [b, bl] of builders) {
      const fg = fam(g);
      if (fg && fg === fam(b)) out.push(`${gl} and ${bl} are both ${fg} models — they can share blind spots.`);
    }
  return out;
}

/** node override > app override > run slots > preset (§7.5). */
export function resolveModel(input: { nodeOverride?: ModelRef | null; appOverride?: ModelRef | null; runSlot?: ModelRef | null; preset?: ModelRef | null }): ModelRef | null {
  return input.nodeOverride ?? input.appOverride ?? input.runSlot ?? input.preset ?? null;
}

// ───────────────────────────── cost (§7.6) ─────────────────────────────

export const BASE_TOK: Record<Role, number> = {
  orch: 1800,
  mgr: 700,
  lead: 1400,
  ui: 900,
  code: 1100,
  platform: 800,
  security: 350,
  test: 300,
  review: 500,
  slop: 300,
  research: 300,
  docs: 300,
  data: 700,
  compliance: 350,
  assets: 700,
  planner: 400,
  git: 300,
  custom: 400,
};

export const RW: Record<string, number> = { none: 0.5, low: 0.7, medium: 0.85, high: 1, xhigh: 1.35, max: 1.7, ultra: 2.2, ultracode: 1.8 };
export const UNIT_PER_KTOK = 0.0075;
export const FORECAST_LOW = 0.7;
export const FORECAST_HIGH = 1.35;

export function weightOf(r: ModelRef | null | undefined, weights: Record<string, number>): number {
  if (!r) return 1;
  return weights[r.modelId] ?? 1;
}

export function agentCost(role: Role, r: ModelRef | null | undefined, weights: Record<string, number>): number {
  const rw = r?.reasoning ? (RW[r.reasoning] ?? 1) : 1;
  return BASE_TOK[role] * weightOf(r, weights) * rw * UNIT_PER_KTOK;
}

export function agentTokensK(role: Role): number {
  return BASE_TOK[role];
}

export interface Forecast {
  units: number;
  low: number;
  high: number;
  tokensK: number;
  unknownWeights: string[];
}

export function forecast(nodes: Array<{ role: Role; slot: SlotId; model?: ModelRef | null }>, slots: SlotMap, weights: Record<string, number>): Forecast {
  let units = 0;
  let tokensK = 0;
  const unknown = new Set<string>();
  for (const n of nodes) {
    const r = n.model ?? slots[n.slot] ?? null;
    units += agentCost(n.role, r, weights);
    tokensK += BASE_TOK[n.role];
    if (r && weights[r.modelId] === undefined) unknown.add(r.modelId);
  }
  return { units, low: units * FORECAST_LOW, high: units * FORECAST_HIGH, tokensK, unknownWeights: [...unknown] };
}

export function fmtUnits(x: number): string {
  return `${x < 10 ? x.toFixed(2) : Math.round(x).toLocaleString("en-US")} u`;
}

/** Actual spend for a node from recorded tokens (k) when available. */
export function spendFromTokens(tokens: number, r: ModelRef | null | undefined, weights: Record<string, number>): number {
  return (tokens / 1000) * weightOf(r, weights) * UNIT_PER_KTOK;
}
