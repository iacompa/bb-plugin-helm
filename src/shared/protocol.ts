// RPC contract between the Helm app (frontend) and the plugin server (§10.2),
// and the realtime message shape (§10.3). Inputs are validated at the wire;
// outputs are the service layer's plain JSON.

import { z } from "zod";
import { defineRpcContract } from "@get-bb/plugin-sdk";

const Id = z.string().min(1).max(200);
const Run = z.object({ runId: Id });
const ModelRefZ = z.object({ providerId: Id, modelId: Id, reasoning: z.string().max(40).nullable(), serviceTier: z.string().max(40).nullish() });
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

export const RPC = defineRpcContract({
  run_list: { input: z.object({}).optional(), output: Any },
  run_get: { input: Run, output: Any },
  run_create: {
    input: z.object({ brief: z.string().max(40_000), portfolio: PortfolioZ.optional(), name: z.string().max(80).optional(), preset: z.string().max(80).optional(), slots: SlotsZ.optional(), limits: LimitsZ, autoAdvance: z.enum(["ask", "auto"]).optional(), appsRoot: z.string().trim().max(500).optional() }),
    output: Any,
  },
  run_setSlots: { input: z.object({ runId: Id, slots: SlotsZ }), output: Any },
  run_start: { input: z.object({ runId: Id, dryRun: z.boolean().optional() }), output: Any },
  run_finish: { input: z.object({ runId: Id, status: z.enum(["done", "cancelled"]) }), output: Any },
  world_get: { input: Run, output: Any },
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
  plan_preview: { input: z.object({ brief: z.string().max(40_000).optional(), portfolio: PortfolioZ.optional(), slots: SlotsZ.optional(), limits: LimitsZ }), output: Any },
  board_moveApp: { input: z.object({ runId: Id, appId: Id, to: z.enum(["intake", "spec", "build", "integrate", "review", "slop", "fix", "ready", "done"]), text: z.string().max(20_000).optional() }), output: Any },
  board_moveTask: { input: z.object({ runId: Id, nodeId: Id, to: z.string().max(40) }), output: Any },
  observatory_list: { input: z.object({ limit: z.number().int().min(1).max(500).optional() }).optional(), output: Any },
  settings_get: { input: z.object({}).optional(), output: Any },
  planner_start: { input: z.object({ brief: z.string().min(1).max(40_000), model: ModelRefZ.optional() }), output: Any },
  /** "Plan with an agent": a visible conversation that follows the helm-planner skill. */
  planchat_start: { input: z.object({ model: ModelRefZ.nullish(), text: z.string().max(8000).nullish() }), output: z.object({ threadId: z.string() }) },
  planner_get: { input: z.object({ id: Id }), output: Any },
  outbox_retry: { input: z.object({ runId: Id, outboxId: Id }), output: Any },
});

export type RpcContract = typeof RPC;

/** One realtime message on `run:<id>`: a batch of patches, at most 4 per second. */
export interface RealtimeBatch {
  runId: string;
  seq: number;
  events: Array<{ event: string; payload: unknown; ts: number }>;
}

export const realtimeChannel = (runId: string) => `run:${runId}`;
export const RUNS_CHANNEL = "helm:runs";
/** Planner session changes (§7.7): {id, status}; refetch with planner_get. */
export const PLANNER_CHANNEL = "helm:planner";
