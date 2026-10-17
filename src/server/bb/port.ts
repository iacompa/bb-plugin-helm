// BbPort — the only door from Helm's engine to BB (§9.1). Nothing outside
// src/server/bb/ touches api.sdk. Two implementations: real.ts (api.sdk + the
// host entry) and sim.ts (deterministic, in-memory; §14).

import type { ModelRef } from "../../shared/types.ts";
import type { HostOps } from "../../shared/host-contract.ts";

export type PermissionMode = "accept-edits" | "auto" | "full";
export type SendMode = "steer" | "queue";

/** Where a spawned thread works. */
export type EnvSpec =
  | { kind: "worktree"; hostId: string | null; baseBranch: string | null } // managed worktree off a named branch (null = default)
  | { kind: "path"; hostId: string | null; path: string } // unmanaged checkout of an existing folder (Studio project)
  | { kind: "reuse"; environmentId: string };

/** Written under pluginMetadata.helm on every spawn (§3.3). */
export interface HelmThreadMeta {
  v: 1;
  runId: string;
  nodeId: string;
  tier: string;
  role: string;
  key: string;
}

export interface SpawnSpec {
  projectId: string;
  environment: EnvSpec;
  title: string;
  prompt: string;
  model: ModelRef;
  permissionMode: PermissionMode;
  visibility: "hidden" | "visible";
  /** Lifecycle owner only — never parentThreadId (V2: a native parent link wakes the parent for a full turn on every child completion). */
  lifecycleOwnerThreadId: string | null;
  meta: HelmThreadMeta;
}

export interface ThreadRef {
  threadId: string;
  environmentId: string | null;
}

export interface ThreadState {
  threadId: string;
  status: "active" | "error" | "idle" | "pending" | "starting" | "stopping";
  archived: boolean;
  environmentId: string | null;
  hostId: string | null;
  path: string | null;
  branch: string | null;
  hasPendingInteraction: boolean;
}

export interface EnvInfo {
  environmentId: string;
  hostId: string;
  path: string | null;
  branch: string | null;
  status: string;
}

export interface SendResult {
  delivery: "sent" | "queued";
  queuedMessageId: string | null;
}

/** A pending native interaction, reduced to what the Needs inbox shows. */
export interface InteractionLite {
  id: string;
  threadId: string;
  kind: "approval" | "question" | "plan" | "other";
  title: string;
  body: string;
  options: string[];
  questions: Array<{ id: string; prompt: string; options: string[]; allowFreeText: boolean; multiSelect: boolean }>;
  decisions: string[];
}

export type InteractionAnswer =
  | { kind: "allow"; forSession?: boolean }
  | { kind: "deny" }
  | { kind: "answer"; answers: Record<string, { selected: string[]; freeText?: string }> }
  | { kind: "value"; value: unknown };

export interface RawCatalog {
  providers: Array<{ id: string; label: string; available: boolean }>;
  models: Array<{
    providerId: string;
    id: string;
    displayName: string;
    description: string;
    isDefault: boolean;
    defaultReasoning: string | null;
    reasoning: string[];
    serviceTiers: string[];
  }>;
  error: { providerId: string; code: string; detail: string | null } | null;
}

/** A thread Helm did not spawn — shown read-only in the Observatory (§11.4). */
export interface ForeignThread {
  threadId: string;
  title: string;
  status: string;
  projectId: string;
  providerId: string;
  parentThreadId: string | null;
  originPluginId: string | null;
  hidden: boolean;
  updatedAt: number;
}

/** Events, translated from bb.events into Helm's vocabulary. */
export type HelmEvent =
  | { type: "thread.created"; threadId: string }
  | { type: "thread.active"; threadId: string }
  | { type: "thread.idle"; threadId: string; lastText: string | null }
  | { type: "thread.failed"; threadId: string; error: string | null }
  | { type: "thread.archived"; threadId: string }
  | { type: "thread.activity"; threadId: string }
  | { type: "interaction.pending"; threadId: string; interaction: InteractionLite }
  | { type: "message.queued"; threadId: string; queuedMessageId: string; initiator: string; text: string; originPluginId: string | null }
  | { type: "message.dispatched"; threadId: string; queuedMessageId: string; initiator: string; text: string; originPluginId: string | null }
  | { type: "message.cancelled"; threadId: string; queuedMessageId: string }
  | { type: "turn.failed"; threadId: string; requestId: string; category: string | null; inputAccepted: boolean; attempt: number }
  /** From the message.dispatch hook: every message about to reach a thread (V18 implicit directives). Always proceeds. */
  | { type: "message.dispatch"; threadId: string; initiator: string; senderThreadId: string | null; originPluginId: string | null; text: string };

export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): () => void;
}

export interface BbPort extends Timers {
  readonly kind: "real" | "sim";
  onEvent(handler: (e: HelmEvent) => void | Promise<void>): () => void;

  primaryHostId(): Promise<string | null>;
  createProject(args: { name: string; hostId: string; path: string }): Promise<{ projectId: string }>;
  findProjectByPath(args: { hostId: string; path: string }): Promise<{ projectId: string } | null>;
  catalog(args: { hostId: string | null }): Promise<RawCatalog>;

  spawnThread(spec: SpawnSpec): Promise<ThreadRef>;
  /** V17 lookup: a Helm thread already spawned with this key (heals a crash between spawn and the DB write). */
  findThreadByKey(args: { key: string; runId: string; ownerThreadId: string | null }): Promise<ThreadRef | null>;
  sendMessage(args: { threadId: string; text: string; mode: SendMode; senderThreadId?: string | null }): Promise<SendResult>;
  updateThread(args: { threadId: string; model?: string; reasoningLevel?: string | null; title?: string; visibility?: "hidden" | "visible" }): Promise<void>;
  stopThread(threadId: string): Promise<void>;
  archiveThread(threadId: string): Promise<string[]>;
  retryThread(args: { threadId: string; turnRequestId?: string }): Promise<void>;
  compactThread(threadId: string): Promise<void>;
  threadState(threadId: string): Promise<ThreadState | null>;
  environment(environmentId: string): Promise<EnvInfo | null>;
  threadContext(threadId: string): Promise<{ usedTokens: number; window: number; estimated: boolean } | null>;
  threadOutput(threadId: string): Promise<string | null>;
  listInteractions(threadId: string): Promise<InteractionLite[]>;
  respondInteraction(args: { threadId: string; interactionId: string; answer: InteractionAnswer }): Promise<void>;
  countActive(args?: { providerId?: string }): Promise<number>;
  listForeignThreads(args: { limit: number }): Promise<ForeignThread[]>;

  /** Git and filesystem work, executed by the host entry on the machine that owns the repo. */
  host(hostId: string | null): HostOps;
}

/** Extract the Helm metadata blob from a pluginMetadata object. */
export function readMeta(pm: unknown): HelmThreadMeta | null {
  if (!pm || typeof pm !== "object") return null;
  const h = (pm as Record<string, unknown>).helm;
  if (!h || typeof h !== "object") return null;
  const m = h as Record<string, unknown>;
  if (typeof m.runId !== "string" || typeof m.nodeId !== "string" || typeof m.key !== "string") return null;
  return { v: 1, runId: m.runId, nodeId: m.nodeId, tier: String(m.tier ?? ""), role: String(m.role ?? ""), key: m.key };
}
