// The RPC input schemas, shared by the server (validated at the wire by BB) and the
// Helm panel, which checks every request before sending it so a bad one fails with a
// precise message instead of BB's generic "rpc input validation failed".
import { z } from "zod";

/** Longest brief or planning text Helm accepts (a long contract, plus room). */
export const TEXT_MAX = 200_000;

const Id = z.string().min(1).max(200);
const Run = z.object({ runId: Id });
const ModelRefZ = z.object({ providerId: Id, modelId: Id, reasoning: z.string().max(40).nullish(), serviceTier: z.string().max(40).nullish() });
const SlotsZ = z.record(z.string(), ModelRefZ);
const CascadeZ = z.enum(["self", "reports", "subtree"]);
const Any = z.any();

const DirectiveInputZ = z.object({
  type: z.enum(["tell", "model", "scope", "priority", "pause", "resume", "stop", "retry", "spawn", "approve", "deny", "answer", "plan", "signoff", "sendback", "waive", "policy", "slots"]),
  target: Id,
  cascade: CascadeZ.optional(),
  mode: z.enum(["steer", "queue"]).optional(),
  policy: z.boolean().optional(),
  text: z.string().max(20_000).optional(),
  value: z.unknown().optional(),
  modelTo: ModelRefZ.nullish(),
  findingIds: z.array(Id).max(50).optional(),
  slots: SlotsZ.optional(),
  slotsScope: z.enum(["future", "all"]).optional(),
  rotatedConfirmed: z.boolean().optional(),
});

const PortfolioZ = z.object({
  apps: z.array(z.object({ name: z.string().min(1).max(60), tagline: z.string().max(160).default(""), platforms: z.array(z.string()).max(4), group: z.string().max(60).nullish(), shape: z.enum(["solo", "lean", "full"]).optional(), notes: z.string().max(1200).nullish(), test: z.boolean().optional(), priority: z.enum(["low", "normal", "high"]).optional(), path: z.string().trim().max(500).nullish(), reads: z.array(z.string().trim().min(1).max(500)).max(10).optional() })).max(60),
  groups: z.array(z.string()).max(20).default([]),
  assumptions: z.array(z.string()).max(30).default([]),
  questions: z.array(z.string()).max(3).default([]),
});

const LimitsZ = z.record(z.string(), z.number()).optional();

export const RPC_SCHEMAS = {
  run_list: { input: z.object({}).optional(), output: Any },
  run_get: { input: Run, output: Any },
  run_create: {
    input: z.object({ brief: z.string().max(TEXT_MAX), portfolio: PortfolioZ.optional(), name: z.string().max(80).optional(), preset: z.string().max(80).optional(), slots: SlotsZ.optional(), limits: LimitsZ, autoAdvance: z.enum(["ask", "auto"]).optional(), autonomy: z.enum(["high", "ask"]).optional(), appsRoot: z.string().trim().max(500).optional() }),
    output: Any,
  },
  run_setSlots: { input: z.object({ runId: Id, slots: SlotsZ }), output: Any },
  /** Read-only: whether a planned run can start (models, folders) and what Helm will do with each folder. */
  run_readiness: { input: Run, output: Any },
  settings_permissions: { input: z.object({}), output: Any },
  settings_models: { input: z.object({}), output: Any },
  settings_setModels: { input: z.object({ planner: ModelRefZ.nullable().optional(), orchestrator: ModelRefZ.nullable().optional(), git: ModelRefZ.nullable().optional(), applyToPlanners: z.boolean().optional() }), output: Any },
  /** Every app's worktrees (the rule is two per app). */
  worktrees_list: { input: z.object({ runId: Id, app: z.string().max(80).optional() }), output: Any },
  /** The Git agent's Worktrees view: every app's worktrees and branches, their state, and (with `measure`) the space they take. */
  worktrees_view: { input: z.object({ runId: Id, refresh: z.enum(["open", "now"]).optional() }), output: Any },
  github_view: { input: z.object({ runId: Id, refresh: z.enum(["open", "now"]).optional() }), output: Any },
  worktrees_reveal: { input: z.object({ runId: Id, path: z.string().min(1).max(1000) }), output: Any },
  git_setLimits: { input: z.object({ runId: Id, branches: z.number().int().min(2).max(12).nullish(), worktrees: z.number().int().min(2).max(32).nullish() }), output: Any },
  screens_setDevices: { input: z.object({ devices: z.array(z.string().min(1).max(60)).max(20) }), output: Any },
  /** Create (and start) the run's Git agent if needed; returns its thread. */
  git_open: { input: z.object({ runId: Id }), output: Any },
  /** What a decision is about, read live from git: the app's checkout and worktrees, and the commits it names. */
  needs_look: { input: z.object({ runId: Id, needId: z.string().min(1).max(80) }), output: Any },
  screens_list: { input: z.object({ runId: Id, appId: z.string().max(80).nullish(), fresh: z.boolean().optional() }), output: Any },
  screens_image: { input: z.object({ runId: Id, appId: z.string().min(1).max(80), path: z.string().min(1).max(1500) }), output: Any },
  settings_setPermissions: { input: z.object({ modes: z.record(z.enum(["orchestrator", "manager", "lead", "specialist", "gate"]), z.enum(["auto", "accept-edits", "full"])).optional(), approvePrompts: z.enum(["supervisor", "human"]).optional() }), output: Any },
  /** Change a run's concurrency and budget cap, before or during the run. */
  run_setLimits: { input: z.object({ runId: Id, concurrency: z.number().int().min(1).max(48).optional(), budgetCap: z.number().positive().max(1e9).optional(), autonomy: z.enum(["high", "ask"]).optional() }), output: Any },
  run_start: { input: z.object({ runId: Id, dryRun: z.boolean().optional() }), output: Any },
  run_finish: { input: z.object({ runId: Id, status: z.enum(["done", "cancelled"]) }), output: Any },
  world_get: { input: Run, output: Any },
  /** Create (and start) the run's Planner if needed; optionally send it the human's question. */
  planner_open: { input: z.object({ runId: Id, question: z.string().max(8000).optional() }), output: Any },
  node_rename: { input: z.object({ runId: Id, nodeId: Id, name: z.string().min(1).max(40) }), output: Any },
  agent_retire: { input: z.object({ runId: Id, nodeId: Id, reason: z.string().max(300).optional() }), output: Any },
  node_get: { input: z.object({ runId: Id, nodeId: Id }), output: Any },
  directive_preview: { input: z.object({ runId: Id, type: DirectiveInputZ.shape.type, target: Id, cascade: CascadeZ.optional() }), output: Any },
  /** Read-only: the preview plus the exact notice each recipient would receive (no state change). */
  directive_previewNotices: {
    input: z.object({ runId: Id, type: DirectiveInputZ.shape.type, target: Id, cascade: CascadeZ.optional(), text: z.string().max(20_000).optional(), value: z.unknown().optional(), modelTo: ModelRefZ.nullish() }),
    output: Any,
  },
  /** Read-only: one app with its gate verdicts, checks, findings and stage history. */
  app_get: { input: z.object({ runId: Id, appId: Id }), output: Any },
  directive_create: { input: z.object({ runId: Id, directive: DirectiveInputZ }), output: Any },
  ledger_list: { input: z.object({ runId: Id, limit: z.number().int().min(1).max(1000).optional() }), output: Any },
  needs_list: { input: z.object({ runId: Id, state: z.enum(["open", "resolved"]).optional() }), output: Any },
  needs_resolve: {
    input: z.object({
      runId: Id,
      needId: Id,
      action: z.enum(["approve", "deny", "answer", "retry", "change_model", "stop", "raise_cap", "keep_paused", "stop_run", "signoff", "sendback", "waive", "dismiss", "nudge", "complete_run"]),
      text: z.string().max(20_000).optional(),
      model: ModelRefZ.optional(),
      value: z.number().optional(),
      findingIds: z.array(Id).max(50).optional(),
      rotatedConfirmed: z.boolean().optional(),
    }),
    output: Any,
  },
  models_catalog: { input: z.object({ refresh: z.boolean().optional(), markSeen: z.boolean().optional() }).optional(), output: Any },
  models_validate: { input: z.object({ slots: SlotsZ }), output: Any },
  presets_list: { input: z.object({}).optional(), output: Any },
  presets_save: { input: z.object({ name: z.string().min(1).max(80), slots: SlotsZ }), output: Any },
  presets_delete: { input: z.object({ name: z.string().min(1).max(80) }), output: Any },
  plan_preview: { input: z.object({ brief: z.string().max(TEXT_MAX).optional(), portfolio: PortfolioZ.optional(), slots: SlotsZ.optional(), limits: LimitsZ }), output: Any },
  board_moveApp: { input: z.object({ runId: Id, appId: Id, to: z.enum(["intake", "spec", "build", "integrate", "review", "slop", "fix", "ready", "done"]), text: z.string().max(20_000).optional() }), output: Any },
  board_moveTask: { input: z.object({ runId: Id, nodeId: Id, to: z.string().max(40) }), output: Any },
  observatory_list: { input: z.object({ limit: z.number().int().min(1).max(500).optional() }).optional(), output: Any },
  settings_get: { input: z.object({}).optional(), output: Any },
  planner_start: { input: z.object({ brief: z.string().min(1).max(TEXT_MAX), model: ModelRefZ.optional() }), output: Any },
  /** "Plan with an agent": a visible conversation that follows the helm-planner skill. */
  planchat_start: { input: z.object({ model: ModelRefZ.nullish(), text: z.string().max(TEXT_MAX).nullish() }), output: z.object({ threadId: z.string() }) },
  planner_get: { input: z.object({ id: Id }), output: Any },
  outbox_retry: { input: z.object({ runId: Id, outboxId: Id }), output: Any },
  /** The panel reports its own failures (rejected requests, crashes) to the error journal. */
  client_error: { input: z.object({ level: z.enum(["error", "warn", "user"]).optional(), at: z.string().max(200), message: z.string().max(2000), detail: z.string().max(4000).nullish(), runId: z.string().max(200).nullish() }), output: Any },
};
