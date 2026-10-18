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
function modelSelects(choices: ModelChoice[], who: "Planner" | "Orchestrator" | "Git agent" | "Fixer", empty: string, desc: string) {
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
  const pl = modelSelects(choices, "Planner", "Not set: use each run's Orchestrator model", "The Planner's model in runs whose Planner role has no model.");
  const or = modelSelects(choices, "Orchestrator", "Not set: choose it in each new run", "The Orchestrator's model for new runs that do not choose one.");
  const gt = modelSelects(choices, "Git agent", "Not set: use each run's Orchestrator model", "The Git agent's model: it keeps every app's branches and worktrees in order, watches their disk space and sends work where you tell it.");
  const fx = modelSelects(choices, "Fixer", "Not set: use each run's Orchestrator model", "The Fixer's model: when an agent fails or gets stuck, the Fixer finds out why and gets it going again (retry, another model, a rebuilt worktree, or the work reassigned), so the error never reaches you. A capable model pays off here.");
  return { plannerModel: pl.model, plannerReasoning: pl.reasoning, orchestratorModel: or.model, orchestratorReasoning: or.reasoning, gitModel: gt.model, gitReasoning: gt.reasoning, fixerModel: fx.model, fixerReasoning: fx.reasoning, ...BASE_DESCRIPTORS };
}

const BASE_DESCRIPTORS = {
  plannerName: { type: "string", label: "Planner's name", description: "Empty: the Planner is just called Planner. A name here is shown with the role (\"Nova · Planner\"). Rename one run's with bb helm rename planner <name>; bb helm rename planner none clears it.", default: DEFAULT_SETTINGS.names.planner },
  orchestratorName: { type: "string", label: "Orchestrator's name", description: "Empty: the Orchestrator is just called Orchestrator. Rename one run's with bb helm rename orch <name>; bb helm rename orch none clears it.", default: DEFAULT_SETTINGS.names.orchestrator },
  gitName: { type: "string", label: "Git agent's name", description: "Empty: the Git agent is just called Git agent. Rename one run's with bb helm rename git <name>; bb helm rename git none clears it.", default: DEFAULT_SETTINGS.names.git },
  fixerName: { type: "string", label: "Fixer's name", description: "Empty: the Fixer is just called Fixer. Rename one run's with bb helm rename fixer <name>; bb helm rename fixer none clears it.", default: DEFAULT_SETTINGS.names.fixer },
  gitOnSignoff: {
    type: "select",
    label: "When you sign a project off, the Git agent",
    description: "Each project has two branches: main and its work branch (<app>-work), where every agent works. Work reaches main only when you sign it off, or when the Orchestrator or the project's lead asks the Git agent to merge it. You can always tell the Git agent in its thread to send work anywhere: another remote, a folder on this Mac or an external disk.",
    options: ["push", "merge-push", "report"] as string[],
    experimental_optionLabels: {
      push: "Pushes the project's work branch to its remote (GitHub); main is left alone",
      "merge-push": "Merges the work branch into main and pushes both (recommended)",
      report: "Only reports what is where; sends nothing",
    },
    default: DEFAULT_SETTINGS.gitOnSignoff,
  },
  worktreesPerApp: {
    type: "number",
    label: "Worktrees per project (most)",
    description: "The most worktrees one project may have (2 to 32; each run can have its own in the Git agent's Worktrees view): your checkout, the shared work worktree every agent uses, and extra lanes the Git agent makes when a project needs parallel work (several UI designs at once, say). Above this the Git agent is told to bring it back down. The Git agent's Worktrees view shows each project's worktrees and the space they take.",
    default: DEFAULT_SETTINGS.worktreesPerApp,
  },
  branchesPerApp: {
    type: "number",
    label: "Branches per project (most)",
    description: "The most branches one project may have (2 to 12): main and its work branch, plus branches only the Git agent creates when a project needs parallel work. Each run can have its own limit: set it in the Git agent's Worktrees view (two for one run, more for another).",
    default: DEFAULT_SETTINGS.branchesPerApp,
  },
  appsRoot: { type: "string", label: "Apps root folder", description: "Default parent folder for new app repositories: <root>/<run>/<app>. An app can also name its own folder or an existing repository anywhere (brief: \"- Name — tagline · macOS · /path/to/repo\"), and bb helm plan --root sets this per run.", default: DEFAULT_SETTINGS.appsRoot },
  concurrency: { type: "number", label: "Concurrent agents", description: `Default for new runs: how many of a run's agents may run at once (max ${LIMIT_CEILINGS.concurrency}). Change a running run with bb helm limits or the capacity chip.`, default: LIMIT_DEFAULTS.concurrency },
  maxTotalAgents: { type: "number", label: "Agent cap per run", description: `Upper bound on a plan's size (max ${LIMIT_CEILINGS.maxTotalAgents}).`, default: LIMIT_DEFAULTS.maxTotalAgents },
  managerSpan: { type: "number", label: "Apps per manager", description: `With more than 4 apps, Managers each oversee up to this many apps (2 to ${LIMIT_CEILINGS.managerSpan}; values outside are clamped).`, default: LIMIT_DEFAULTS.managerSpan },
  orchestratorSpan: { type: "number", label: "Orchestrator span", description: `The most Managers (or app leads, with 4 apps or fewer) reporting straight to the Orchestrator (2 to ${LIMIT_CEILINGS.orchestratorSpan}).`, default: LIMIT_DEFAULTS.orchestratorSpan },
  leadSpan: { type: "number", label: "Specialists per lead at once", description: `How many builders one App Lead may have running at the same time (1 to ${LIMIT_CEILINGS.leadSpan}).`, default: LIMIT_DEFAULTS.leadSpan },
  fixRounds: { type: "number", label: "Fix rounds before asking you", description: `How many times a gate may fail an app and send it back to fix before Helm asks you what to do (0 to ${LIMIT_CEILINGS.fixRounds}).`, default: LIMIT_DEFAULTS.fixRounds },
  stallMinutes: { type: "number", label: "Minutes of silence before a nudge", description: "A working agent silent this long is nudged; still silent after another stretch, it comes to Needs you (5 to 240).", default: LIMIT_DEFAULTS.stallMinutes },
  budgetCap: { type: "number", label: "Default budget cap (relative units)", description: "Default for new runs. 1 unit is about 133k tokens on a weight-1.0 model such as Sonnet (cheaper models count less, pricier ones more; see Pricing weights). At the cap Helm stops spawning new agents and asks you. Change a running run with bb helm limits --budget N.", default: LIMIT_DEFAULTS.budgetCap },
  autonomy: {
    type: "select",
    label: "Autonomy",
    description: "Default for new runs. High is hands-off: the team decides on the record (the Orchestrator sets strategy, managers sign off their apps, leads answer their squads, the Fixer takes failed and stuck agents, installs go through the Git agent), and only keys and accounts, spending and private data come to you. Ask: questions, waves, plan changes, failures and sign-off come to Needs you. Change a running run with bb helm limits --autonomy.",
    options: ["high", "ask"] as string[],
    experimental_optionLabels: { high: "Hands-off: the team decides; ask me only for keys and accounts, spending or private data", ask: "Ask me about every question, wave, plan change and failure" },
    default: "high",
  },
  autoAdvance: { type: "select", label: "Later waves", description: "Applies only when Autonomy is Ask. With Autonomy High (the default), the Orchestrator admits later waves itself.", options: ["ask", "auto"] as string[], experimental_optionLabels: { ask: "Ask me before each wave", auto: "Run waves automatically" }, default: "ask" },
  permissionOrchestrator: { ...PERM, label: "Permission mode: Orchestrator", description: PERM_NOTE },
  permissionManager: { ...PERM, label: "Permission mode: Managers", description: PERM_NOTE },
  permissionLead: { ...PERM, label: "Permission mode: App Leads", description: PERM_NOTE },
  permissionSpecialist: { ...PERM, label: "Permission mode: Specialists", description: PERM_NOTE },
  permissionGate: { ...PERM, label: "Permission mode: gates", description: PERM_NOTE },
  approvePrompts: {
    type: "select",
    label: "Who approves agents' permission prompts",
    description: "A builder's prompt goes to its lead, a lead's to its manager, a manager's (and the Git agent's, the Planner's and the Fixer's) to the Orchestrator. Installs and downloads count as ordinary work. A prompt escalated, or unanswered for 15 minutes, goes one level up; it comes to you only from the Orchestrator, or when it needs a key, spending or private data. The Orchestrator's own prompts always come to you.",
    options: ["supervisor", "human"] as string[],
    experimental_optionLabels: { supervisor: "Their supervisor approves for me", human: "Ask me every time" },
    default: "supervisor",
  },
  showLeadsInSidebar: { type: "boolean", label: "Show App Leads in the BB sidebar", description: "Off: only the Orchestrator, the Planner and the Git agent appear in BB's sidebar; every agent is still on Helm's graph.", default: false },
  zeroTolerance: { type: "string", label: "Zero-tolerance slop categories", description: "Comma-separated rule ids whose open findings block Ready: S1 placeholders, S2 fake data, S3 invented dependencies, S4 dead code, S5 debug leftovers, S6 secrets, S7 filler, S8 unbacked claims, S9 generic UI, S10 over- or under-engineering, S11 skipped tests, S12 swallowed failures. Other text is ignored; empty means nothing blocks Ready, secrets included.", default: DEFAULT_SETTINGS.zeroTolerance.join(",") },
  weights: { type: "string", label: "Pricing weights (JSON)", description: "Relative cost per model, keyed by the model id as bb helm models prints it (no provider), e.g. {\"claude-haiku-5-5\": 0.25}. 1.0 is Sonnet's cost. Empty = Helm's defaults.", experimental_multiline: true, default: "" },
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
    git: perm(v.permissionOrchestrator),
    fixer: perm(v.permissionOrchestrator),
    custom: perm(v.permissionSpecialist),
  };
  const nm = (x: unknown, d: string) => (typeof x === "string" && x.trim() ? x.trim().slice(0, 40) : d);
  return {
    ...DEFAULT_SETTINGS,
    limits,
    permissionMode,
    showLeadsInSidebar: v.showLeadsInSidebar === true,
    appsRoot: typeof v.appsRoot === "string" && v.appsRoot.trim() ? v.appsRoot.trim() : DEFAULT_SETTINGS.appsRoot,
    names: { planner: nm(v.plannerName, DEFAULT_SETTINGS.names.planner), orchestrator: nm(v.orchestratorName, DEFAULT_SETTINGS.names.orchestrator), git: nm(v.gitName, DEFAULT_SETTINGS.names.git), fixer: nm(v.fixerName, DEFAULT_SETTINGS.names.fixer) },
    defaultModels: {
      planner: withReasoning(parseModelSetting(v.plannerModel, "Default Planner model", warn), v.plannerReasoning, choices),
      orchestrator: withReasoning(parseModelSetting(v.orchestratorModel, "Default Orchestrator model", warn), v.orchestratorReasoning, choices),
      git: withReasoning(parseModelSetting(v.gitModel, "Default Git agent model", warn), v.gitReasoning, choices),
      fixer: withReasoning(parseModelSetting(v.fixerModel, "Default Fixer model", warn), v.fixerReasoning, choices),
    },
    gitOnSignoff: v.gitOnSignoff === "push" || v.gitOnSignoff === "report" ? v.gitOnSignoff : "merge-push",
    worktreesPerApp: clampInt(v.worktreesPerApp, 2, 32, DEFAULT_SETTINGS.worktreesPerApp),
    branchesPerApp: clampInt(v.branchesPerApp, 2, 12, DEFAULT_SETTINGS.branchesPerApp),
    weights,
    zeroTolerance: typeof v.zeroTolerance === "string" ? v.zeroTolerance.split(/[,\s]+/).filter((x) => /^S\d+$/.test(x)) : DEFAULT_SETTINGS.zeroTolerance,
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
