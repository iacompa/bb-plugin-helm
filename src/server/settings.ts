// Helm's settings (§10.4): BB settings descriptors and the mapping to the
// engine's HelmSettings. Every value is also settable with `bb plugin config`.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { LIMIT_CEILINGS, LIMIT_DEFAULTS, type HelmLimits, type Tier } from "../shared/types.ts";
import { DEFAULT_SETTINGS, type HelmSettings } from "./engine/context.ts";
import { SEED_WEIGHTS } from "./domain/models.ts";
import type { PermissionMode } from "./bb/port.ts";

const PERM = { type: "select", options: ["auto", "accept-edits", "full"] as string[], default: "auto" } as const;

export const SETTINGS_DESCRIPTORS = {
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
  permissionOrchestrator: { ...PERM, label: "Permission mode: Orchestrator" },
  permissionManager: { ...PERM, label: "Permission mode: Managers" },
  permissionLead: { ...PERM, label: "Permission mode: App Leads" },
  permissionSpecialist: { ...PERM, label: "Permission mode: Specialists" },
  permissionGate: { ...PERM, label: "Permission mode: gates" },
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
  };
  return {
    ...DEFAULT_SETTINGS,
    limits,
    permissionMode,
    showLeadsInSidebar: v.showLeadsInSidebar === true,
    appsRoot: typeof v.appsRoot === "string" && v.appsRoot.trim() ? v.appsRoot.trim() : DEFAULT_SETTINGS.appsRoot,
    weights,
    zeroTolerance: typeof v.zeroTolerance === "string" ? v.zeroTolerance.split(/[,\s]+/).filter((x) => /^S\d+$/.test(x)) : DEFAULT_SETTINGS.zeroTolerance,
    createRemote: v.createRemote === true,
    autoAdvance: v.autoAdvance === "auto" ? "auto" : "ask",
  };
}

/** Define the settings and keep a synchronous copy current for the engine. */
export async function bindSettings(bb: BbPluginApi): Promise<() => HelmSettings> {
  const handle = bb.settings.define(SETTINGS_DESCRIPTORS);
  let current = toHelmSettings((await handle.get()) as Values, (m) => bb.log.warn(m));
  handle.onChange((next) => {
    current = toHelmSettings(next as Values, (m) => bb.log.warn(m));
  });
  return () => current;
}
