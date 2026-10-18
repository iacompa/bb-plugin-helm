// Helm's settings (§10.4): BB settings descriptors and the mapping to the
// engine's HelmSettings. Every value is also settable with `bb plugin config`.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { LIMIT_CEILINGS, LIMIT_DEFAULTS, type HelmLimits, type ModelRef, type Tier } from "../shared/types.ts";
import { DEFAULT_SETTINGS, type HelmSettings } from "./engine/context.ts";
import { SEED_WEIGHTS } from "./domain/models.ts";
import type { PermissionMode } from "./bb/port.ts";

const PERM_NOTE = "Applies to agents spawned after the change (BB sets a thread's mode when it starts). A provider that cannot run this mode asks you once which of its modes to use.";
const PERM = {
  type: "select",
  options: ["auto", "accept-edits", "full"] as string[],
  experimental_optionLabels: { auto: "Auto: BB's safety check allows routine commands and asks about risky ones", "accept-edits": "Allow edits: file edits go ahead, commands ask for approval", full: "Full access: no permission checks" },
  default: "auto",
} as const;

/** A model the settings can offer: from a provider that is connected (the last catalog Helm saw). */
export interface ModelChoice {
  /** provider/model */
  value: string;
  label: string;
  reasoning: string[];
  defaultReasoning: string | null;
}

/** The dropdown values for "no default model" and "the model's own reasoning" (BB options cannot be empty). */
export const NO_MODEL = "none";
export const MODEL_REASONING = "default";

const REASONING_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"];

/** The two default-model pickers (model + reasoning) for one role, as BB select settings. */
function modelSelects(choices: ModelChoice[], who: "Planner" | "Orchestrator", empty: string, desc: string) {
  const levels = [...new Set(choices.flatMap((c) => c.reasoning))].sort((a, b) => (REASONING_ORDER.indexOf(a) + 1 || 99) - (REASONING_ORDER.indexOf(b) + 1 || 99));
  return {
    model: {
      type: "select",
      label: `Default ${who} model`,
      description: `${desc} Lists the models of the providers you have connected (refreshed when Helm restarts). Also in the Helm panel: Models → Default models.`,
      options: [NO_MODEL, ...choices.map((c) => c.value)] as string[],
      experimental_optionLabels: { [NO_MODEL]: empty, ...Object.fromEntries(choices.map((c) => [c.value, c.label])) } as Record<string, string>,
      default: NO_MODEL,
    },
    reasoning: {
      type: "select",
      label: `Default ${who} reasoning`,
      description: "Used with the model above. A level the model does not offer falls back to the model's own default.",
      options: [MODEL_REASONING, ...levels] as string[],
      experimental_optionLabels: { [MODEL_REASONING]: "The model's default" } as Record<string, string>,
      default: MODEL_REASONING,
    },
  } as const;
}

/** Helm's settings, with the default-model pickers filled from the models you can use. */
export function settingsDescriptors(choices: ModelChoice[]) {
  const pl = modelSelects(choices, "Planner", "Not set: use each run's Orchestrator model", "The Planner's (Amer's) model in runs whose Planner role has no model.");
  const or = modelSelects(choices, "Orchestrator", "Not set: choose it in each new run", "The Orchestrator's model for new runs that do not choose one.");
  return { plannerModel: pl.model, plannerReasoning: pl.reasoning, orchestratorModel: or.model, orchestratorReasoning: or.reasoning, ...BASE_DESCRIPTORS };
}

const BASE_DESCRIPTORS = {
  plannerName: { type: "string", label: "Planner's name", description: "What new runs call their Planner, the advisor you talk to (it can design new agents). Rename one run's Planner with bb helm rename planner <name>.", default: DEFAULT_SETTINGS.names.planner },
  orchestratorName: { type: "string", label: "Orchestrator's name", description: "What new runs call their Orchestrator. Rename one run's with bb helm rename orch <name>.", default: DEFAULT_SETTINGS.names.orchestrator },
  appsRoot: { type: "string", label: "Apps root folder", description: "Default parent folder for new app repositories: <root>/<run>/<app>. An app can also name its own folder or an existing repository anywhere (brief: \"- Name — tagline · macOS · /path/to/repo\"), and bb helm plan --root sets this per run.", default: DEFAULT_SETTINGS.appsRoot },
  concurrency: { type: "number", label: "Concurrent agents", description: `Default for new runs: how many of a run's agents may run at once (max ${LIMIT_CEILINGS.concurrency}). Change a running run with bb helm limits or the capacity chip.`, default: LIMIT_DEFAULTS.concurrency },
  maxTotalAgents: { type: "number", label: "Agent cap per run", description: `Upper bound on a plan's size (max ${LIMIT_CEILINGS.maxTotalAgents}).`, default: LIMIT_DEFAULTS.maxTotalAgents },
  managerSpan: { type: "number", label: "Apps per manager", default: LIMIT_DEFAULTS.managerSpan },
  orchestratorSpan: { type: "number", label: "Orchestrator span", default: LIMIT_DEFAULTS.orchestratorSpan },
  leadSpan: { type: "number", label: "Specialists per lead at once", default: LIMIT_DEFAULTS.leadSpan },
  fixRounds: { type: "number", label: "Fix rounds before asking you", default: LIMIT_DEFAULTS.fixRounds },
  stallMinutes: { type: "number", label: "Minutes of silence before a nudge", default: LIMIT_DEFAULTS.stallMinutes },
  budgetCap: { type: "number", label: "Default budget cap (relative units)", default: LIMIT_DEFAULTS.budgetCap },
  autonomy: {
    type: "select",
    label: "Autonomy",
    options: ["high", "ask"] as string[],
    experimental_optionLabels: { high: "The Orchestrator decides; ask me only about credentials, spending, private data or access", ask: "Ask me about every question, wave and plan change" },
    default: "high",
  },
  autoAdvance: { type: "select", label: "Later waves", options: ["ask", "auto"] as string[], experimental_optionLabels: { ask: "Ask me before each wave", auto: "Run waves automatically" }, default: "ask" },
  permissionOrchestrator: { ...PERM, label: "Permission mode: Orchestrator", description: PERM_NOTE },
  permissionManager: { ...PERM, label: "Permission mode: Managers", description: PERM_NOTE },
  permissionLead: { ...PERM, label: "Permission mode: App Leads", description: PERM_NOTE },
  permissionSpecialist: { ...PERM, label: "Permission mode: Specialists", description: PERM_NOTE },
  permissionGate: { ...PERM, label: "Permission mode: gates", description: PERM_NOTE },
  approvePrompts: {
    type: "select",
    label: "Who approves agents' permission prompts",
    description: "A builder's prompt goes to its lead, a lead's to its manager, a manager's to the Orchestrator. They escalate to you only for credentials, spending, private data or access, and a prompt nobody answers in 15 minutes comes to you. The Orchestrator's own prompts always come to you.",
    options: ["supervisor", "human"] as string[],
    experimental_optionLabels: { supervisor: "Their supervisor approves for me", human: "Ask me every time" },
    default: "supervisor",
  },
  showLeadsInSidebar: { type: "boolean", label: "Show App Leads in the BB sidebar", default: false },
  zeroTolerance: { type: "string", label: "Zero-tolerance slop categories", description: "Comma-separated rule ids that block Ready.", default: DEFAULT_SETTINGS.zeroTolerance.join(",") },
  createRemote: { type: "boolean", label: "Create a git remote per app", default: false },
  weights: { type: "string", label: "Pricing weights (JSON)", description: "Relative cost per model, e.g. {\"claude-code/claude-haiku-5-5\": 0.25}. Empty = Helm's defaults.", experimental_multiline: true, default: "" },
} as const;

export const SETTINGS_DESCRIPTORS = settingsDescriptors([]);

type Values = Record<string, string | number | boolean | undefined>;

const clampInt = (v: unknown, min: number, max: number, dflt: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

/** "provider/model:reasoning" → a model ref (checked against the catalog where it is used). */
export function parseModelSetting(v: unknown, label: string, warn: (m: string) => void = () => {}): ModelRef | null {
  if (typeof v !== "string" || !v.trim() || v.trim() === NO_MODEL) return null;
  const m = v.trim().match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._\-\[\]]+?)(?::([A-Za-z0-9_-]+))?$/);
  if (!m) {
    warn(`${label}: "${v}" is not provider/model:reasoning; ignoring it.`);
    return null;
  }
  return { providerId: m[1], modelId: m[2], reasoning: m[3] ?? null };
}

/** Apply the reasoning setting (unless the model text already named one), checked against what the model offers. */
function withReasoning(ref: ModelRef | null, reasoning: unknown, choices: ModelChoice[]): ModelRef | null {
  if (!ref) return null;
  const r = ref.reasoning ?? (typeof reasoning === "string" && reasoning && reasoning !== MODEL_REASONING ? reasoning : null);
  const c = choices.find((x) => x.value === `${ref.providerId}/${ref.modelId}`);
  if (!c) return { ...ref, reasoning: r };
  return { ...ref, reasoning: r && c.reasoning.includes(r) ? r : c.defaultReasoning };
}

/** A model ref → the setting's text. */
export function modelSettingText(r: ModelRef | null | undefined): string {
  return r ? `${r.providerId}/${r.modelId}${r.reasoning ? `:${r.reasoning}` : ""}` : "";
}

/** BB setting values → engine settings, clamped to the ceilings (§4.1). */
export function toHelmSettings(v: Values, warn: (m: string) => void = () => {}, choices: ModelChoice[] = []): HelmSettings {
  const limits: HelmLimits = {
    ...LIMIT_DEFAULTS,
    concurrency: clampInt(v.concurrency, 1, LIMIT_CEILINGS.concurrency, LIMIT_DEFAULTS.concurrency),
    maxTotalAgents: clampInt(v.maxTotalAgents, 1, LIMIT_CEILINGS.maxTotalAgents, LIMIT_DEFAULTS.maxTotalAgents),
    managerSpan: clampInt(v.managerSpan, 2, LIMIT_CEILINGS.managerSpan, LIMIT_DEFAULTS.managerSpan),
    orchestratorSpan: clampInt(v.orchestratorSpan, 2, LIMIT_CEILINGS.orchestratorSpan, LIMIT_DEFAULTS.orchestratorSpan),
    leadSpan: clampInt(v.leadSpan, 1, LIMIT_CEILINGS.leadSpan, LIMIT_DEFAULTS.leadSpan),
    fixRounds: clampInt(v.fixRounds, 0, LIMIT_CEILINGS.fixRounds, LIMIT_DEFAULTS.fixRounds),
    stallMinutes: clampInt(v.stallMinutes, 5, 240, LIMIT_DEFAULTS.stallMinutes),
    budgetCap: Math.max(0.01, Number(v.budgetCap) || LIMIT_DEFAULTS.budgetCap),
    autonomy: v.autonomy === "ask" ? "ask" : "high",
  };
  let weights = SEED_WEIGHTS;
  if (typeof v.weights === "string" && v.weights.trim()) {
    try {
      const parsed = JSON.parse(v.weights) as Record<string, unknown>;
      weights = { ...SEED_WEIGHTS, ...Object.fromEntries(Object.entries(parsed).filter(([, x]) => typeof x === "number" && x > 0) as Array<[string, number]>) };
    } catch {
      warn("The pricing weights setting is not valid JSON; using Helm's defaults.");
    }
  }
  const perm = (x: unknown): PermissionMode => (x === "full" || x === "accept-edits" ? x : "auto");
  const permissionMode: Record<Tier, PermissionMode> = {
    orchestrator: perm(v.permissionOrchestrator),
    manager: perm(v.permissionManager),
    lead: perm(v.permissionLead),
    specialist: perm(v.permissionSpecialist),
    gate: perm(v.permissionGate),
    // the Planner runs like the Orchestrator, custom agents like specialists
    planner: perm(v.permissionOrchestrator),
    custom: perm(v.permissionSpecialist),
  };
  const nm = (x: unknown, d: string) => (typeof x === "string" && x.trim() ? x.trim().slice(0, 40) : d);
  return {
    ...DEFAULT_SETTINGS,
    limits,
    permissionMode,
    showLeadsInSidebar: v.showLeadsInSidebar === true,
    appsRoot: typeof v.appsRoot === "string" && v.appsRoot.trim() ? v.appsRoot.trim() : DEFAULT_SETTINGS.appsRoot,
    names: { planner: nm(v.plannerName, DEFAULT_SETTINGS.names.planner), orchestrator: nm(v.orchestratorName, DEFAULT_SETTINGS.names.orchestrator) },
    defaultModels: {
      planner: withReasoning(parseModelSetting(v.plannerModel, "Default Planner model", warn), v.plannerReasoning, choices),
      orchestrator: withReasoning(parseModelSetting(v.orchestratorModel, "Default Orchestrator model", warn), v.orchestratorReasoning, choices),
    },
    weights,
    zeroTolerance: typeof v.zeroTolerance === "string" ? v.zeroTolerance.split(/[,\s]+/).filter((x) => /^S\d+$/.test(x)) : DEFAULT_SETTINGS.zeroTolerance,
    createRemote: v.createRemote === true,
    autoAdvance: v.autoAdvance === "auto" ? "auto" : "ask",
    approvePrompts: v.approvePrompts === "human" ? "human" : "supervisor",
  };
}

/**
 * Read a model typed in words ("sonnet 5.5 high") against the list: every word but the reasoning
 * must appear in one model's id or name. Several providers offering the same model is ambiguous.
 */
export function matchModelWords(v: unknown, choices: ModelChoice[]): ModelRef | null {
  if (typeof v !== "string" || !v.trim() || v.includes("/")) return null;
  const words = v.toLowerCase().split(/[\s,]+/).filter(Boolean);
  const reasoning = words.find((w) => REASONING_ORDER.includes(w)) ?? null;
  const rest = words.filter((w) => w !== reasoning);
  if (!rest.length) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const hits = choices.filter((c) => {
    const hay = ` ${norm(c.value)} ${norm(c.label)} `;
    return rest.every((w) => hay.includes(` ${norm(w).trim()} `));
  });
  if (hits.length !== 1) return null;
  const [providerId, modelId] = hits[0].value.split("/");
  return { providerId, modelId, reasoning: reasoning && hits[0].reasoning.includes(reasoning) ? reasoning : hits[0].defaultReasoning };
}

/**
 * Earlier versions stored a default model as one "provider/model:reasoning" text; the pickers now
 * hold the model and the reasoning apart. Split an old value when the list offers its model.
 */
async function migrateModelSettings(handle: { get(): Promise<unknown>; experimental_set(v: never): Promise<unknown> }, choices: ModelChoice[]): Promise<unknown> {
  const v = (await handle.get()) as Values;
  const fix: Values = {};
  for (const [m, r] of [["plannerModel", "plannerReasoning"], ["orchestratorModel", "orchestratorReasoning"]] as const) {
    const parsed = parseModelSetting(v[m], m);
    const ref = parsed ?? matchModelWords(v[m], choices);
    // "provider/model" is already a dropdown value; "provider/model:reasoning" and words are not
    if (!ref || (parsed && !parsed.reasoning) || !choices.some((c) => c.value === `${ref.providerId}/${ref.modelId}`)) continue;
    fix[m] = `${ref.providerId}/${ref.modelId}`;
    fix[r] = ref.reasoning ?? MODEL_REASONING;
  }
  if (!Object.keys(fix).length) return v;
  try {
    await handle.experimental_set(fix as never);
    return await handle.get();
  } catch {
    return v;
  }
}

/** Define the settings and keep a synchronous copy current for the engine. */
export type SettingsWriter = (values: Partial<Record<keyof typeof SETTINGS_DESCRIPTORS, string | number | boolean>>) => Promise<void>;

/** Helm's live settings, plus a writer for the panel (the same values as BB's Settings page). */
export async function bindSettings(bb: BbPluginApi, choices: ModelChoice[] = []): Promise<(() => HelmSettings) & { write: SettingsWriter }> {
  const handle = bb.settings.define(settingsDescriptors(choices));
  const read = (v: unknown) => toHelmSettings(v as Values, (m) => bb.log.warn(m), choices);
  let current = read(await migrateModelSettings(handle, choices));
  handle.onChange((next) => {
    current = read(next);
  });
  const write: SettingsWriter = async (values) => {
    await handle.experimental_set(values as never);
    current = read(await handle.get());
  };
  return Object.assign(() => current, { write });
}

/** The setting key for each tier's permission mode. */
export const PERMISSION_KEYS: Partial<Record<Tier, string>> = { orchestrator: "permissionOrchestrator", manager: "permissionManager", lead: "permissionLead", specialist: "permissionSpecialist", gate: "permissionGate" };
