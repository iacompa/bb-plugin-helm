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

export const SETTINGS_DESCRIPTORS = {
  plannerName: { type: "string", label: "Planner's name", description: "What new runs call their Planner, the advisor you talk to (it can design new agents). Rename one run's Planner with bb helm rename planner <name>.", default: DEFAULT_SETTINGS.names.planner },
  orchestratorName: { type: "string", label: "Orchestrator's name", description: "What new runs call their Orchestrator. Rename one run's with bb helm rename orch <name>.", default: DEFAULT_SETTINGS.names.orchestrator },
  plannerModel: { type: "string", label: "Default Planner model", description: "The model of the Planner (Amer) in runs whose Planner role has no model, written provider/model:reasoning, e.g. claude-code/claude-sonnet-5-5:medium. Empty = the run's Orchestrator model. Easier: Helm panel → Models → Default models.", default: "" },
  orchestratorModel: { type: "string", label: "Default Orchestrator model", description: "The Orchestrator's model for new runs that do not choose one, written provider/model:reasoning, e.g. claude-code/claude-sonnet-5-5:high. Empty = choose it in each new run. Easier: Helm panel → Models → Default models.", default: "" },
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

type Values = Record<string, string | number | boolean | undefined>;

const clampInt = (v: unknown, min: number, max: number, dflt: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

/** "provider/model:reasoning" → a model ref (checked against the catalog where it is used). */
export function parseModelSetting(v: unknown, label: string, warn: (m: string) => void = () => {}): ModelRef | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const m = v.trim().match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._\-\[\]]+?)(?::([A-Za-z0-9_-]+))?$/);
  if (!m) {
    warn(`${label}: "${v}" is not provider/model:reasoning; ignoring it.`);
    return null;
  }
  return { providerId: m[1], modelId: m[2], reasoning: m[3] ?? null };
}

/** A model ref → the setting's text. */
export function modelSettingText(r: ModelRef | null | undefined): string {
  return r ? `${r.providerId}/${r.modelId}${r.reasoning ? `:${r.reasoning}` : ""}` : "";
}

/** BB setting values → engine settings, clamped to the ceilings (§4.1). */
export function toHelmSettings(v: Values, warn: (m: string) => void = () => {}): HelmSettings {
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
    defaultModels: { planner: parseModelSetting(v.plannerModel, "Default Planner model", warn), orchestrator: parseModelSetting(v.orchestratorModel, "Default Orchestrator model", warn) },
    weights,
    zeroTolerance: typeof v.zeroTolerance === "string" ? v.zeroTolerance.split(/[,\s]+/).filter((x) => /^S\d+$/.test(x)) : DEFAULT_SETTINGS.zeroTolerance,
    createRemote: v.createRemote === true,
    autoAdvance: v.autoAdvance === "auto" ? "auto" : "ask",
    approvePrompts: v.approvePrompts === "human" ? "human" : "supervisor",
  };
}

/** Define the settings and keep a synchronous copy current for the engine. */
export type SettingsWriter = (values: Partial<Record<keyof typeof SETTINGS_DESCRIPTORS, string | number | boolean>>) => Promise<void>;

/** Helm's live settings, plus a writer for the panel (the same values as BB's Settings page). */
export async function bindSettings(bb: BbPluginApi): Promise<(() => HelmSettings) & { write: SettingsWriter }> {
  const handle = bb.settings.define(SETTINGS_DESCRIPTORS);
  let current = toHelmSettings((await handle.get()) as Values, (m) => bb.log.warn(m));
  handle.onChange((next) => {
    current = toHelmSettings(next as Values, (m) => bb.log.warn(m));
  });
  const write: SettingsWriter = async (values) => {
    await handle.experimental_set(values as never);
    current = toHelmSettings((await handle.get()) as Values, (m) => bb.log.warn(m));
  };
  return Object.assign(() => current, { write });
}

/** The setting key for each tier's permission mode. */
export const PERMISSION_KEYS: Partial<Record<Tier, string>> = { orchestrator: "permissionOrchestrator", manager: "permissionManager", lead: "permissionLead", specialist: "permissionSpecialist", gate: "permissionGate" };
