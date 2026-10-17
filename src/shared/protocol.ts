// RPC contract between the Helm app (frontend) and the plugin server (§10.2),
// and the realtime message shape (§10.3). Inputs are validated at the wire;
// outputs are the service layer's plain JSON.

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { RPC_SCHEMAS } from "./rpc-schemas.ts";

export { RPC_SCHEMAS, TEXT_MAX } from "./rpc-schemas.ts";

export const RPC = defineRpcContract(RPC_SCHEMAS);

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
