# BB Plugin SDK — exact API shapes (@get-bb/plugin-sdk 0.6.49)

Source: `node_modules/@get-bb/plugin-sdk/bundled-types/*.d.ts`. Shapes below were
expanded with the TypeScript checker (zod `z.infer` = **output** type) and trimmed.
`JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue }`,
`JsonObject = { [k: string]: JsonValue }`. `signal?: AbortSignal` is accepted by most
read args and omitted below unless it matters.

Import paths: `@get-bb/plugin-sdk` (server: `BbPluginApi`, `defineCli`, `cliCommand`,
`PluginCliError`, `defineRpcContract`), `@get-bb/plugin-sdk/app` (frontend),
`@get-bb/plugin-sdk/host` (`experimental_defineHostEntry`), `@get-bb/plugin-sdk/testing`.
Server entry: `export default async function plugin(bb: BbPluginApi) { ... }`.

---------------------------------------------------------------------------------

## GOTCHAS (read first)

1. **`ThreadResponse` has NO `model`, NO `reasoningLevel`, NO `permissionMode`, NO `hostId`.**
   It has `providerId`, `environmentId`, `projectId`, `status`, `runtime.displayStatus`, etc.
   To get model: `threads.defaultExecutionOptions({threadId})` → `{model, permissionMode,
   reasoningLevel, serviceTier, source, seq?} | null`, or read `model` on a
   `ThreadQueuedMessage` / `MessageDispatchHookContext.requestedExecution`.
   Host: `threads.get({threadId, include: ...})` → `ThreadWithIncludesResponse.environment.hostId`
   (`include` is a plain `string`; the accepted values are not in the typings), or
   `threads.list` rows (`environmentHostId`), or `environments.get`.
2. **`threads.list` returns a plain array** (`ThreadListResponse = ThreadListRow[]`), NOT `{items}`.
   Paging is `limit`/`offset` args; there is no cursor/total. List rows are a *different*
   shape than `ThreadResponse` (they have `environmentHostId`, `environmentPath`,
   `environmentBranchName`, `hasPendingInteraction`, `queuedWork`, `activity`, ...).
   Hidden threads are excluded unless `includeHidden: true`; archived only with `archived: true`.
3. **`threads.count`**: args `{ groupBy?: "host" | "project" | "provider"; hostId?; parentThreadId?;
   projectId?; providerId?; status?: ThreadStatus }` → `{ total: number; groups?: {key: string|null; count: number}[] }`.
   `parentThreadId: "none"` (sentinel `THREAD_COUNT_ROOT_PARENT`) counts root threads only.
   Archived/deleted are excluded. `threads.listRunning()` → `{id, hostId: string|null}[]`.
4. **`threads.send` has NO `prompt` shortcut** (only `spawn` does). `send` requires `mode`
   (`"auto" | "start" | "steer" | "queue-if-active" | "steer-if-active"`, no default) and `input: PromptInput[]`.
5. **zod-default fields are REQUIRED in the TS types** (output type): in `input` text blocks
   `mentions` is required → always pass `{ type: "text", text, mentions: [] }`. Same for
   `environment: {type:"provider", inputs}` (`inputs` required, may be `null`). Using
   `spawn({ prompt })` avoids the text-block issue.
6. `spawn` `environment` is **required** (no default). Easiest: `{ type: "project-default" }`.
   `projectId` is required. `permissionMode` input also accepts legacy `"workspace-write"`
   (mapped to one of `"accept-edits" | "auto" | "full"`).
7. `threads.archive` returns `{ ok: true; archivedThreadIds: string[] }` (cascades).
   `stop`, `compact`, `unarchive`, `delete` return `{ ok: true }`. `delete` needs
   `childThreadsConfirmed: boolean` (required). `update` returns the updated `ThreadResponse`.
8. `threads.interactions.list` returns a **plain array** of `PendingInteraction`.
9. `threads.events.list/wait` and `threads.timeline` take **string** numeric params
   (`limit: string`, `afterSeq: string`, `waitMs: string`, `segmentLimit: string`, booleans as `"true"|"false"`).
   The high-level `threads.wait({threadId, status?, event?, timeoutMs?, pollIntervalMs?})` takes numbers.
10. CLI option types are `"boolean" | "string" | "integer" | "enum" | "duration"` — there is **no `"number"`**.
    `integer` **requires `min` and `max`**. `split` only valid with `repeatable: true`.
    Register with `bb.cli.register(defineCli(spec))`; `run` must return `{ exitCode, stdout?, stderr? }`.
11. `bb.storage.database()` returns `better-sqlite3`'s `Database.Database` (synchronous). `migrate(db, statements)`
    is append-only by index.
12. `registerTool` icon is `presentation.icon = { glyph: string }` (object, not a string). Nav panel /
    panel action icons are plain `string` (`BbIconName = string`) — no union in typings.
    Built-in icon set is small (~177 names, see §22): **Ship, Network, Compass, Anchor, LayoutDashboard do NOT exist**;
    Workflow, Bot exist. Unknown names silently fall back to branding/generic icon.
13. Events are fire-and-forget announcements (return ignored). Only `experimental_hooks.on("message.dispatch")`
    can veto/queue. Hook handlers: max one per hook per plugin (second throws), 10 s box, fail-closed.
14. `ThreadQueuedMessage` has `threadId`, `initiator`, `senderThreadId`, `content` (blocks) — no `prompt`/`text` field.
15. `providers.models` entries: `id`, `model`, `displayName`, `description`, `isDefault`, `defaultReasoningEffort`,
    `supportedReasoningEfforts[]`, `supportedServiceTiers?`. **No legacy/hidden/release-date markers.** There is a
    separate top-level `selectedOnlyModels` array (same entry shape; semantics undocumented — presumably models only
    offered when already selected).
16. `projects.create` source union has only one arm: `{ type: "local_path"; hostId: string; path: string }`.
17. `files.read` returns `contentEncoding: "base64" | "utf8"`; `files.write` returns a union
    `{outcome:"written"} | {outcome:"conflict", currentSha256}` (optimistic concurrency via `expectedSha256`).
18. `agents.configure` selects which registered tools/skills are active per session; tool/instruction changes apply
    on next session start, never mid-session. `contributeInstructions` and `configure` are one-per-factory.
19. `bb.sdk` is bind-gated: prefer using it from handlers/services/timers, not top-level factory code.
20. `threads.spawn` from a plugin defaults `origin: "plugin"`, `originPluginId: <self>`; seeding `pluginMetadata`
    forces attribution to this plugin. Metadata blobs > 256 KiB reject.

---------------------------------------------------------------------------------

## Shared enums

```ts
type ThreadStatus = "active" | "error" | "idle" | "pending" | "starting" | "stopping";
type ThreadRuntimeDisplayStatus = ThreadStatus | "waiting-for-host" | "provisioning";
type PermissionMode = "accept-edits" | "auto" | "full";
type ReasoningLevel = string;   // zod string; provider ladder: "none"|"low"|"medium"|"high"|"xhigh"|"max"|"ultra"|"ultracode"
type ServiceTier = string;
type ThreadCreateOrigin = "app" | "cli" | "plugin" | "sdk";
type ThreadTurnInitiator = "agent" | "system" | "user";
type ExecutionInputFieldSource = "client-preference" | "explicit";

// PromptInput (the `input` block type for spawn/send/queue)
type PromptInput =
  | { type: "text"; text: string; mentions: Mention[]; visibility?: "agent-only" }   // mentions REQUIRED in TS
  | { type: "image"; url: string; visibility?: "agent-only" }
  | { type: "localImage"; path: string; hostId?: string; sourceProjectId?: string; visibility?: "agent-only" }
  | { type: "localFile"; path: string; hostId?: string; mimeType?: string; name?: string;
      sizeBytes?: number; sourceProjectId?: string; visibility?: "agent-only" };
type Mention = {
  start: number; end: number;
  resource:
    | { kind: "thread"; label: string; threadId: string; projectId?: string }
    | { kind: "project"; label: string; projectId: string }
    | { kind: "section"; label: string; sectionId: string }
    | { kind: "path"; label: string; path: string; entryKind: "directory" | "file"; source: "workspace" | "thread-storage" }
    | { kind: "command"; label: string; name: string; argumentHint: string | null;
        origin: "project" | "builtin" | "user"; source: "command" | "skill"; trigger: "/" | "$" }
    | { kind: "plugin"; label: string; pluginId: string; itemId: string; icon?: string | null }
    | { kind: "attachment"; label: string; path: string };
};
```

---------------------------------------------------------------------------------

## 1. `bb.sdk.threads.spawn(args: ThreadSpawnArgs): Promise<ThreadResponse>`

```ts
type ThreadSpawnArgs = ThreadSpawnBaseArgs & (
  | { input: PromptInput[]; prompt?: never }
  | { input?: never; prompt: string }          // SDK convenience
);
interface ThreadSpawnBaseArgs {               // = CreateThreadRequest minus input, origin* made optional
  projectId: string;                          // REQUIRED
  environment:                                // REQUIRED
    | { type: "reuse"; environmentId: string }
    | { type: "host"; hostId?: string;
        workspace:
          | { type: "unmanaged"; path: string | null;
              branch?: { kind: "existing"; name: string } | { kind: "new"; baseBranch: string } }
          | { type: "managed-worktree";
              baseBranch: { kind: "named"; name: string } | { kind: "default" } }
          | { type: "personal" } }
    | { type: "project-default" }
    | { type: "provider"; environmentProviderId: string; inputs: JsonValue | null;
        machine?: { type: "existing"; hostId: string }
                | { type: "new"; machineProviderId: string; inputs: JsonValue | null } };
  title?: string;
  providerId?: string;
  model?: string;
  reasoningLevel?: string;
  serviceTier?: string;
  permissionMode?: "accept-edits" | "auto" | "full";   // input also accepts "workspace-write"
  visibility?: "hidden" | "visible";
  parentThreadId?: string;
  lifecycleOwnerThreadId?: string;
  pluginMetadata?: JsonObject;                // seeded under this plugin's namespace
  pluginSubmission?: { pluginId: string; data: JsonValue };
  sectionId?: string | null;
  pinned?: boolean;
  sendAt?: number;                            // epoch ms; future => queued
  sessionOptions?: Record<string, string | boolean>;
  sourceThreadId?: string;
  sourceSeqEnd?: number;
  executionInputSources?: { model?: ExecutionInputFieldSource; permissionMode?: ...; providerId?: ...;
                            reasoningLevel?: ...; serviceTier?: ... };
  origin?: "app" | "cli" | "plugin" | "sdk";  // defaults "plugin" from a plugin
  originPluginId?: string;                    // defaults to this plugin
  originKind?: "fork" | null;
  startedOnBehalfOf?: { initiator: "agent" | "system"; senderThreadId: string } | null;
}
```

### `ThreadResponse` (return of spawn/fork/update/markRead/restoreEnvironment; `thread` in every event)

```ts
interface ThreadResponse {
  id: string;
  title: string | null;
  titleFallback: string | null;
  status: "active" | "error" | "idle" | "pending" | "starting" | "stopping";
  runtime: { displayStatus: ThreadStatus | "waiting-for-host" | "provisioning" };
  projectId: string;
  providerId: string;
  environmentId: string | null;
  parentThreadId: string | null;
  lifecycleOwnerThreadId: string | null;
  sourceThreadId: string | null;
  sectionId: string | null;
  visibility: "hidden" | "visible";
  originKind: "fork" | null;
  originPluginId: string | null;
  archivedAt: number | null;
  deletedAt: number | null;
  pinnedAt: number | null;
  lastReadAt: number | null;
  latestAttentionAt: number;
  createdAt: number;
  updatedAt: number;
  queuedMessageCount: number;
  activeBackgroundAgentCount: number;
  canRestoreEnvironment: boolean;
  canSpawnChild: boolean;
  // NO model / reasoningLevel / permissionMode / hostId
}
```

`threads.get({ threadId, include?: string })` → `ThreadResponse | ThreadWithIncludesResponse`, where the latter adds:

```ts
environment?: Environment | null;    // see §10 (has hostId, path, branchName, ...)
environmentHostName?: string | null;
host?: { id: string; name: string; status: "connected" | "disconnected"; type: "ephemeral" | "persistent";
         maxPermissionMode: PermissionMode; machineProviderId: string | null; lastSeenAt: number | null;
         lifecycle: {...}; createdAt: number; updatedAt: number; lastRejectedProtocolVersion: number | null } | null;
```

---------------------------------------------------------------------------------

## 2. `threads.send(args: ThreadSendArgs): Promise<SendMessageResponse>`

```ts
interface ThreadSendArgs {
  threadId: string;
  input: PromptInput[];                      // REQUIRED, no `prompt` shortcut
  mode: "auto" | "start" | "steer" | "queue-if-active" | "steer-if-active";   // REQUIRED
  senderThreadId?: string;
  model?: string;
  reasoningLevel?: string;
  serviceTier?: string;
  permissionMode?: "auto" | "accept-edits" | "full";
  sendAt?: number;
  pluginSubmission?: { pluginId: string; data: JsonValue };
  executionInputSources?: { model?; permissionMode?; reasoningLevel?; serviceTier? };  // ExecutionInputFieldSource
}
type SendMessageResponse =
  | { ok: true; delivery: "sent" }
  | { ok: true; delivery: "queued"; queuedMessage: ThreadQueuedMessage };
```

---------------------------------------------------------------------------------

## 3. Other thread methods

```ts
// ThreadActionArgs = { threadId: string; signal?: AbortSignal }
update(args: { threadId: string; title?: string | null; model?: string | null; reasoningLevel?: string | null;
               parentThreadId?: string | null; sectionId?: string | null; visibility?: "hidden" | "visible";
               sessionOptions?: Record<string, string | boolean | null> }): Promise<ThreadResponse>;
stop(args: ThreadActionArgs): Promise<{ ok: true }>;      // waits for interrupt attempt; may remain "stopping"
archive(args: ThreadActionArgs): Promise<{ ok: true; archivedThreadIds: string[] }>;
archiveAll(args: ThreadActionArgs): Promise<{ ok: true; archivedThreadIds: string[] }>;
unarchive(args: ThreadActionArgs): Promise<{ ok: true }>;
delete(args: { threadId: string; childThreadsConfirmed: boolean }): Promise<{ ok: true }>;
compact(args: ThreadActionArgs): Promise<{ ok: true }>;
retry(args: { threadId: string; turnRequestId?: string; sendAt?: number; reason?: string }): Promise<RetryTurnResponse>;
type RetryTurnResponse =
  | { ok: true; delivery: "sent"; attempt: number; turnRequestId: string }
  | { ok: true; delivery: "queued"; attempt: number; turnRequestId: string; queuedMessageId: string;
      sendAt: number | null; waitingOn: QueuedWaitingOn };
output(args: { threadId: string }): Promise<{ output: string | null }>;   // last assistant text
defaultExecutionOptions(args: ThreadActionArgs): Promise<{ model: string; permissionMode: PermissionMode;
  reasoningLevel: string; serviceTier: string; seq?: number;
  source: "client/thread/start" | "client/turn/requested" | "client/turn/start" } | null>;
childSummary(args): Promise<{ nonDeletedChildCount: number; unarchivedDescendantCount: number }>;
listRunning(args?): Promise<{ id: string; hostId: string | null }[]>;
fork(args: ThreadForkArgs): Promise<ThreadResponse>;    // sourceThreadId required; visibility/origin optional
wait(args: { threadId: string; status?: ThreadStatus; event?: string; timeoutMs?: number; pollIntervalMs?: number })
  : Promise<{ matched: true; threadId: string; target: { kind: "status"; status }; thread: ThreadGetResult }
          | { matched: true; threadId: string; target: { kind: "event"; eventType: string }; event: ThreadEventRow }>;
// also: pin/unpin/markRead/markUnread (→ ThreadResponse), search, message, promptHistory, open, paneAction,
// editMessage, restoreEnvironment, storageFiles/storageLocation/storagePaths, conversationOutline,
// cancelPlan/clearContext/clearGoal (→ {ok:true}), tabs.get/update, resolveMentions, reorderPinned
```

### `threads.context({ threadId })` → `ThreadContextResponse`

```ts
{ usage: null | {
    usedTokens: number;
    modelContextWindow: number;
    estimated: boolean;
    cost?: { amount: number; currency: string };
    snapshot?: { usedTokens: number; contextWindowTokens: number; autoCompactAtTokens: number | null;
                 estimated: boolean; model: string; capturedAt: string; providerSessionId: string;
                 providerTurnId: string | null;
                 categories: { id: string; label: string; tokens: number; kind: "deferred" | "free" | "reserved" | "used";
                               entries: { id: string; label: string; tokens: number }[] }[] };
  } }
```

### `threads.timeline(args)` → `ThreadTimelineResponse` (brief)

```ts
args: { threadId: string; afterSequence?: string; beforeAnchorId?: string; beforeAnchorSeq?: string;
        segmentLimit?: string; deferContent?: "true"|"false"; includeNestedRows?: "true"|"false"; summaryOnly?: "true"|"false" }
{
  rows: TimelineRow[];            // row.kind: "conversation" | "turn" | "work" | "system" (each has id, createdAt, ...)
  maxSeq: number;
  timelinePage: { historySnapshot: string; olderCursor: { anchorId: string; anchorSeq: number } | null;
                  olderRowsSourceSeqEnd: number | null; returnedSegmentCount: number; olderRowUpdates?: TimelineRow[] };
  delta?: { upsertRows: TimelineRow[]; rowOrder?: string[] };
  contextWindowUsage?: <same as context().usage>;
  pendingTodos: { items: { id: string; text: string; status: "completed" | "pending" | "in_progress" }[];
                  sourceSeq: number; updatedAt: number } | null;
  goal: { objective: string; status: "paused" | "active" | "budgetLimited" | "complete"; tokenBudget: number | null;
          tokensUsed: number; timeUsedSeconds: number; sourceSeq: number; updatedAt: number } | null;
  activeThinking: { id: string; text: string; startedAt: number; updatedAt: number } | null;
  activePromptMode: { mode: "plan"; prompt: string; providerId: string } | null;
  activeBackgroundCommands: WorkRow[]; activeWorkflows: WorkRow[];
  modelFallback: { originalModel: string; fallbackModel: string; reason: "provider" | "refusal"; message: string;
                   detectedAt: number; sourceSeq: number } | null;
  completedTurnDisplay: "collapse" | "flat";
  contextBoundarySeq: number | null;
  providerCommands: {...}[] | null;
  sessionOptions: (...)[] | null;
}
```

### `threads.list(args?)` → `ThreadListRow[]` (plain array)

```ts
args: { archived?: boolean; environmentId?: string; hostId?: string; sectionId?: string; hasParent?: boolean;
        includeHidden?: boolean; limit?: number; offset?: number; originKind?: "fork"; originPluginId?: string;
        parentThreadId?: string; projectId?: string; sourceThreadId?: string; unsectioned?: boolean }
interface ThreadListRow {
  id: string; title: string | null; titleFallback: string | null;
  status: ThreadStatus; runtime: { displayStatus: ThreadRuntimeDisplayStatus };
  projectId: string; providerId: string;
  environmentId: string | null; environmentHostId: string | null; environmentPath: string | null;
  environmentBranchName: string | null; environmentName: string | null; environmentIsWorktree: boolean | null;
  environmentProviderId: string | null;
  environmentWorkspaceDisplayKind: "managed-worktree" | "unmanaged-worktree" | "other";
  parentThreadId: string | null; lifecycleOwnerThreadId: string | null; sourceThreadId: string | null;
  sectionId: string | null; visibility: "hidden" | "visible";
  originKind: "fork" | null; originPluginId: string | null;
  hasPendingInteraction: boolean;
  queuedWork: "failed" | "none" | "waiting";
  activity: { activeBackgroundAgentCount: number; activeBackgroundCommandCount: number; activeGoalCount: number;
              activePlanModeCount: number; activeWorkflowCount: number };
  archivedAt: number | null; deletedAt: number | null; pinnedAt: number | null; pinSortKey: string | null;
  lastReadAt: number | null; latestAttentionAt: number; createdAt: number; updatedAt: number;
}
```

### `threads.count(args?)` — see Gotcha 3.

### Plugin metadata (on `PluginBbSdk`, `pluginId` optional → defaults to self)

```ts
getPluginMetadata(args: { threadId: string; pluginId?: string }): Promise<JsonObject>;   // {} when absent
updatePluginMetadata(args: { threadId: string; pluginId?: string; set?: JsonObject; remove?: string[] }): Promise<JsonObject>;
experimental_listPluginMetadata(args: { threadIds: readonly string[] /*1–200*/; pluginId?: string })
  : Promise<{ threads: { threadId: string; metadata: JsonObject }[] }>;   // only threads that have metadata; incl. archived/deleted
experimental_listDescendants(args: { threadIds: readonly string[] /*1–200*/; includeArchived?: boolean; includeHidden?: boolean })
  : Promise<{ threads: { threadId: string; descendantIds: string[] }[] }>;  // children first; unknown/deleted omitted
experimental_listAncestors(args: { threadIds: readonly string[] })
  : Promise<{ threads: { threadId: string; ancestorIds: string[] }[] }>;   // parent → root
```

---------------------------------------------------------------------------------

## 4. `threads.interactions`

```ts
list(args: { threadId: string }): Promise<PendingInteraction[]>;        // plain array
get(args: { threadId: string; interactionId: string }): Promise<PendingInteraction>;
respond(args: { threadId: string; interactionId: string; value: JsonValue }): Promise<PendingInteraction>;
resolve(args: { threadId: string; interactionId: string; resolution: PendingInteractionResolution }): Promise<PendingInteraction>;
cancel(args: { threadId: string; interactionId: string }): Promise<PendingInteraction>;

type PendingInteraction = ProviderPendingInteraction | PluginPendingInteraction;
// common fields:
{ id: string; threadId: string; createdAt: number; resolvedAt: number | null; expiresAt?: number | null;
  status: "pending" | "resolving" | "resolved" | "interrupted"; statusReason: string | null; }
// Provider variants additionally: providerId, providerRequestId, providerThreadId, turnId: string,
//   origin?: { kind: "provider"; providerId; providerRequestId; providerThreadId }
//   payload is one of:
//   { kind: "approval"; reason: string | null; availableDecisions: ("allow_once" | "allow_for_session" | "deny")[];
//     subject: { kind: "command"; command; cwd; itemId; actions[]; sessionGrant }
//            | { kind: "file_change"; itemId; writeScope; sessionGrant }
//            | { kind: "permission_grant"; itemId; permissions; toolName }
//            | { kind: "plan"; itemId; plan: string; planFilePath: string | null }
//            | { kind: "tool_use"; itemId; tool: string; presentation } }
//   { kind: "user_question"; questions: { id; prompt; allowFreeText: boolean; multiSelect: boolean;
//                                         options?: { label; value; description? }[]; shortLabel? }[] }
//   { kind: `${string}/${string}`; title: string; data: JsonValue }       // provider extension request
// Plugin variant: origin: { kind: "plugin"; pluginId: string; rendererId: string }; turnId: string | null;
//   payload: { kind: "plugin"; title: string; data: JsonValue; presentation?: PluginRowPresentation-like }

type PendingInteractionResolution =
  | { decision: "allow_once" | "allow_for_session";
      grantedPermissions: null | { fileSystem: null | { read: string[]; write: string[] };
                                   network: null | { enabled: boolean | null } } }
  | { decision: "deny" }
  | { kind: "user_answer"; answers: Record<string, { selected: string[]; freeText?: string }> }
  | { kind: "plugin_submitted"; description?: { title?: string; detail?: string; payload?: JsonValue } }
  | { kind: "request_answer"; value: JsonValue };
```

---------------------------------------------------------------------------------

## 5. Events — `bb.events.on<E extends PluginThreadEventName>(event, handler: (payload) => void | Promise<void>)`

There is an event-name type: `type PluginThreadEventName = keyof PluginThreadEventPayloads;`

```ts
interface PluginThreadEventPayloads {
  "experimental_environment.removed": { removal: EnvironmentRemoval };
  "experimental_thread.events": { thread: ThreadResponse; sequence: number };   // debounced ≤1/s per thread
  "experimental_thread.parentChanged": { thread: ThreadResponse; previousParentThreadId: string | null };
  "experimental_terminal.input": { terminal: TerminalSession };
  "experimental_host.deleted": { host: Host };
  "thread.created":    { thread: ThreadResponse };
  "thread.active":     { thread: ThreadResponse };
  "thread.idle":       { thread: ThreadResponse; lastAssistantText: string | null };
  "thread.failed":     { thread: ThreadResponse; error: string | null };
  "thread.archived":   { thread: ThreadResponse };      // incl. cascade archives
  "thread.unarchived": { thread: ThreadResponse };
  "thread.deleted":    { thread: ThreadResponse };      // soft delete
  "interaction.pending": { thread: ThreadResponse; interaction: PendingInteraction };
  "message.queued":     { entry: ThreadQueuedMessage }; // every listener sees every row; re-queue fires again
  "message.dispatched": { entry: ThreadQueuedMessage }; // turn has NOT necessarily started yet
  "message.cancelled":  { entry: ThreadQueuedMessage }; // user deleted queued row before dispatch
  "turn.failed": PluginTurnFailedEvent;                 // thread already in "error"
}

interface ThreadQueuedMessage {
  id: string;
  threadId: string;
  content: PromptInput[];
  initiator: "agent" | "system" | "user";
  senderThreadId: string | null;
  origin: "app" | "cli" | "plugin" | "sdk" | null;
  originPluginId: string | null;
  model: string; reasoningLevel: string; serviceTier: string; permissionMode: PermissionMode;
  state: "queued" | "claimed" | "scheduled" | "waiting" | "failed_retrying" | "failed_exhausted";
  waitingOn: QueuedWaitingOn | null;
  payload: { kind: "inline" } | { kind: "retry"; attempt: number; reason: string; retryOfTurnRequestId: string };
  sendAt: number | null;
  editable: boolean;
  groupWithNext: boolean;
  failureReason: string | null;
  createdAt: number; updatedAt: number;
}
type QueuedWaitingOn =
  | { kind: "time" } | { kind: "thread-busy" } | { kind: "stopping" } | { kind: "turn-starting" }
  | { kind: "provisioning" } | { kind: "host-offline"; hostName: string } | { kind: "interaction" }
  | { kind: "plugin"; pluginId: string; reason: string };

interface PluginTurnFailedEvent {
  threadId: string;
  requestId: string;          // pass to threads.retry as turnRequestId
  turnId: string | null;
  errorInfo: { category: "active-turn-not-steerable" | "bad-request" | "budget-exceeded" | "connection-failed"
                 | "context-window-exceeded" | "max-output-tokens" | "max-turns" | "rate-limit" | "stream-disconnected"
                 | "structured-output-retries" | "thread-rollback-failed" | "too-many-failed-attempts" | "billing"
                 | "internal" | "overloaded" | "policy" | "sandbox" | "unauthorized" | "unknown";
               httpStatusCode: number | null; providerCode: string | null } | null;
  inputAccepted: boolean;
  rateLimits: { providerId: string; kind: "unknown" | "spend-control" | "subscription-window" | "credits";
                status: "unknown" | "allowed" | "warning" | "blocked"; reachedReason: string | null;
                overageStatus: null | "allowed" | "rejected" | "unavailable" | "warning"; overageReason: string | null;
                windows: { label: string | null; providerKey: string | null; resetsAtMs: number | null;
                           status: "unknown" | "allowed" | "warning" | "blocked" }[] } | null;
  attemptNumber: number;      // 1 = original dispatch
}
```

---------------------------------------------------------------------------------

## 6. `bb.experimental_hooks`

```ts
interface PluginHooks {
  on<K extends "message.dispatch">(hook: K, handler: (ctx: MessageDispatchHookContext) =>
     MessageDispatchHookDecision | Promise<MessageDispatchHookDecision>): void;  // one per plugin; 10 s box; throw = attempt fails
  recheck(hook: "message.dispatch"): Promise<void>;   // re-drain plugin-held rows; resolves when scheduled
}
type MessageDispatchHookDecision =
  | { action: "proceed" }
  | { action: "wait"; reason: string; sendAt?: number | null }
  | { action: "reject"; message: string };

interface MessageDispatchHookContext {
  thread: ThreadResponse;                     // never null (thread exists in "pending" on first message)
  project: Project;
  environment: Environment | null;
  host: Host | null;
  environmentIntent: null | { kind: "environment"; environmentId: string }
                         | { kind: "provider"; environmentProviderId: string; inputs: JsonValue | null;
                             machine: { type: "existing"; hostId: string } | { type: "new"; machineProviderId: string; inputs: JsonValue | null } };
  input: { blocks: readonly PromptInput[]; text: string };   // text = concatenated text blocks
  requestedExecution: { providerId: string; model: string | null; reasoningLevel: string | null;
                        serviceTier: string | null; permissionMode: PermissionMode | null };
  executionSources: { providerId; model; reasoningLevel; serviceTier; permissionMode: ExecutionInputFieldSource | null };
  attempt: "join-turn" | "start-turn";
  initiator: "user" | "agent" | "system" | "mixed";
  senderThreadId: string | "mixed" | null;    // null = nobody (human/core retry)
  queuedMessages: ThreadQueuedMessage[];      // empty for inline attempt
  experimental_submission: { pluginId: string; data: JsonValue } | null;
  origin: ThreadCreateOrigin | "mixed" | null;
  originPluginId: string | "mixed" | null;
  parentThreadId: string | null;
}
```

---------------------------------------------------------------------------------

## 7. `bb.sdk.providers`

```ts
interface ProvidersArea {
  catalog(): Promise<SystemProviderCatalogEntry[]>;
  setEnabled(args: { providerId: string; enabled: boolean }): Promise<SystemProviderCatalogEntry[]>;
  list(args?: ProviderListArgs): Promise<ProviderInfo[]>;
  models(args?: ProviderModelsArgs): Promise<ProviderModelsResult>;
}
type ProviderListArgs = ({ environmentId: string } | { hostId: string } | {}) & { capability?: "usage" };
  // environmentId and hostId are mutually exclusive
type ProviderModelsArgs = ({ environmentId: string } | { hostId: string; projectId?: string } | { projectId?: string })
                          & { providerId?: string };

interface ProviderInfo {
  id: string; displayName: string; pluginId: string; available: boolean; logoUrl: string | null;
  family?: string; icon?: { glyph: string };
  capabilities: { modelCatalogScope: "host" | "workspace"; permissionModes: PermissionMode[];
                  supportsFork: boolean; supportsNativeUserQuestion: boolean; supportsServiceTier: boolean;
                  supportsSessionRewind: boolean; supportsThreadArchive: boolean; supportsThreadRename: boolean };
  reasoningLevels?: { id: string; label: string; description?: string }[];
  serviceTiers?: { id: string; label: string; description?: string }[];
  completedTurnDisplay: "collapse" | "flat";
  composerActions: ({ kind: "skills"; trigger: "/" | "$" } | { kind: "plan" | "goal"; command: { name; trailingText; trigger } })[];
  maintenance: { health: boolean; installation: boolean; usage: boolean };
  strings?: { expiredHint: string; installUrl: string; signInHint: string; brandPrefix?: string;
              iconTint?: { light: string; dark: string }; planModeCopy?: string };
  extensionKinds?: Record<`${string}/${string}`, { item: boolean; state: boolean }>;
}
interface ProviderModelsResult {
  models: ModelEntry[];
  selectedOnlyModels: ModelEntry[];           // undocumented semantics
  providers: ProviderInfo[];
  permissionCeiling: PermissionMode;
  modelLoadError: null | { providerId: string; detail: string | null;
                           code: "auth_required" | "failed" | "missing_executable" | "provider_unavailable" | "timeout" };
}
interface ModelEntry {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: { reasoningEffort: string; description: string; label?: string }[];
  supportedServiceTiers?: { id: string; label?: string; description?: string }[];
  routeProviderId?: string;
  sessionOptions?: ({ type: "select"; id; label; value: string; values: { id; label; description?; group? }[]; category?; description? }
                  | { type: "boolean"; id; label; value: boolean; category?; description?; fixed?: boolean })[];
  // NO legacy / hidden / releaseDate / deprecated markers
}
interface SystemProviderCatalogEntry {
  id: string; displayName: string; available: boolean; enabled: boolean; logoUrl: string | null;
  pluginId: string; pluginName: string; pluginEnabled: boolean; info: ProviderInfo | null;
}
```

---------------------------------------------------------------------------------

## 8. `bb.sdk.projects`

```ts
create(args: { name: string; source: { type: "local_path"; hostId: string; path: string } }): Promise<Project>;
list(args?: { include?: string; includePersonal?: boolean }): Promise<Project[] | ProjectWithThreads[]>;
get(args: { projectId: string }): Promise<Project>;
// also: update, delete, reorder, branches, files, fileContent, paths, commands, defaultExecutionOptions,
//       promptHistory, sidebarBootstrap, sources.*, attachments.*, machineEnvironment...

interface Project {
  id: string; name: string; kind: "personal" | "standard"; gitRemoteUrl: string | null;
  sources: { id: string; projectId: string; type: "local_path"; hostId: string; path: string;
             isDefault: boolean; createdAt: number; updatedAt: number }[];
  createdAt: number; updatedAt: number;
}
// ProjectWithThreads (when include asks for it) = Project & {
//   threads: ThreadListRow[];
//   defaultExecutionOptions: { providerId; model; reasoningLevel; serviceTier; permissionMode } | null }
```

---------------------------------------------------------------------------------

## 9. `bb.sdk.files`

```ts
read(args: { path: string; hostId?: string; rootPath?: string }): Promise<{
  path: string; content: string; contentEncoding: "base64" | "utf8"; sha256: string; sizeBytes: number;
  mimeType?: string; modifiedAtMs?: number }>;
write(args: { path: string; content: string; hostId?: string; rootPath?: string;
              contentEncoding?: "base64" | "utf8"; createParents?: boolean; expectedSha256?: string | null; mode?: number })
  : Promise<{ outcome: "written"; sha256: string; sizeBytes: number } | { outcome: "conflict"; currentSha256: string | null }>;
mkdir(args: { path: string; hostId?: string; rootPath?: string; recursive?: boolean }): Promise<{ ok: true }>;
list(args: { path: string; hostId?: string; query?: string; limit?: number; includeHidden?: boolean; excludeNames?: string[] })
  : Promise<{ files: { name: string; path: string }[]; truncated: boolean }>;
// also: listPaths, move, remove, createPreview
```
`hostId` omitted = presumably the primary host (not stated in typings). `rootPath` semantics are not documented
in the typings (daemon commands accept an optional `rootPath` sandbox root).

---------------------------------------------------------------------------------

## 10. `bb.sdk.environments`

```ts
get(args: { environmentId: string }): Promise<Environment>;
list(args?: { projectId?: string; hostId?: string; path?: string; status?: EnvironmentStatus;
              environmentProviderId?: string; instanceKey?: string; limit?: number; offset?: number }): Promise<Environment[]>;
interface Environment {
  id: string; projectId: string; hostId: string; name: string | null; path: string | null;
  branchName: string | null; baseBranch: string | null; defaultBranch: string | null; mergeBaseBranch: string | null;
  isGitRepo: boolean; isWorktree: boolean; managed: boolean;
  status: "creating" | "destroyed" | "error" | "provisioning" | "ready";
  workspaceProvisionType: "managed-worktree" | "personal" | "unmanaged" | null;
  hostLifecycle: "active" | "removing" | "removed" | "cleanup-failed";
  lifecycle: { phase: "active" | "retiring" | "teardown" | "destroyed"; retireAt: number | null;
               teardown: { attempt: number; status: "running" | "removed" | "failed"; message?: string } | null };
  environmentProviderId: string | null; environmentProviderInstanceKey: string | null;
  environmentProviderSelection: { inputs: JsonValue; machine: {...} } | null;
  createdAt: number; updatedAt: number;
}
// also: diff*, commit, status, paths, update, delete, pullRequest*, archiveThreads, listProviders
```

---------------------------------------------------------------------------------

## 11. `bb.sdk.system.config()` → `SystemConfigResult` (selected fields)

```ts
{
  primaryHostId: string | null;
  primaryHostPlatform: "darwin" | "linux" | "unknown" | "win32" | "wsl" | null;
  serverUrl: string;
  dataDir: string;
  hostDaemonPort: number | null;
  generalSettings: { defaultProviderId: string | null; providerOrder: string[]; managedBranchPrefix: string;
                     allowFastServiceTier: boolean; streamerMode: boolean; ... };
  appearance: {...}; experiments: {...}; featureFlags: {...}; keybindings: [...]; serverAccess: {...};
  localHelperPorts: number[]; pluginThemes: [...]; customThemes: string[]; voiceTranscriptionEnabled: boolean;
}
```

---------------------------------------------------------------------------------

## 12. `bb.agents`

```ts
interface PluginAgents {
  configure(provider: (context: PluginAgentConfigurationContext) => PluginAgentConfiguration): void;  // sync; one per factory
  registerTool<Schema extends z.ZodType>(tool: PluginAgentToolRegistrationBase & {
    parameters: Schema;                                  // zod: validated, execute gets z.output<Schema>
    execute(params: z.output<Schema>, ctx: PluginAgentToolContext): PluginAgentToolResult | Promise<PluginAgentToolResult>;
  }): void;
  registerTool(tool: PluginAgentToolRegistrationBase & {
    parameters: Record<string, unknown>;                 // raw JSON schema: params unvalidated
    execute(params: unknown, ctx: PluginAgentToolContext): PluginAgentToolResult | Promise<PluginAgentToolResult>;
  }): void;
  contributeInstructions(provider: (ctx: { threadId: string; projectId: string }) => string | null): void; // sync, ≤4096 chars
}
interface PluginAgentToolRegistrationBase {
  name: string;               // [a-zA-Z0-9_-]+, unique across plugins, not a reserved built-in
  description: string;
  instructions?: string;      // appended to thread instructions when tool is active; ≤4096 chars
  presentation?: PluginRowPresentation;
}
interface PluginRowPresentation {
  label?: { pending: string; completed: string };   // each ≤80 chars, plain text
  icon?: { glyph: string };   // host glyph name ("Workflow") or "<pluginId>/<name>" from bb.branding.experimental_icons
  suppress?: boolean;         // collapse by default
  tint?: { light: string; dark: string };           // free-form colour strings
}
// default when omitted: "Running <name>" / "Ran <name>", plugin branding glyph, then "Toolbox"
interface PluginAgentToolContext { threadId: string; projectId: string; signal: AbortSignal }
type PluginAgentToolResult = string | { content: PluginAgentToolContentPart[]; isError?: boolean };
type PluginAgentToolContentPart = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

interface PluginAgentConfiguration {
  tools: Array<string | { name: string; parameters: Record<string, unknown> /* narrowing JSON-schema override */ }>;
  skills: string[];            // manifest skill frontmatter names
  instructions?: string;       // ≤4096 chars
}
interface PluginAgentConfigurationContext {
  readonly pluginMetadata: { readonly [key: string]: ReadonlyJsonValue };   // this plugin's thread metadata, frozen
  thread: { id: string; title: string | null; parentThreadId: string | null; sourceThreadId: string | null };
  project: { id: string; kind: "personal" | "standard"; name: string; gitRemoteUrl: string | null };
  environment: { id: string; name: string | null; path: string | null; branchName: string | null;
                 /** @deprecated */ workspaceProvisionType: "managed-worktree" | "personal" | "unmanaged" | null };
  host: { id: string; name: string };
  provider: { id: string; model: string; capabilities: { supportsNativeUserQuestion: boolean } };
  origin: { kind: "fork" | null; pluginId: string | null };
}
```

`bb.ui.requestInput(request: { threadId; rendererId; title; payload: JsonValue; timeoutMs?; presentation?: PluginRowPresentation;
describeSubmission?(value) }, { signal? })` → `{ outcome: "submitted"; value: JsonValue } | { outcome: "cancelled"; reason:
"plugin-disposed" | "request-aborted" | "server-restarted" | "thread-deleted" | "thread-stopped" | "timeout" | "user" }`.

---------------------------------------------------------------------------------

## 13. `bb.cli`

```ts
interface PluginCli { register(registration: PluginCliRegistration): void }   // once per factory
declare function defineCli(spec: PluginCliSpec): PluginCliRegistration;
declare function cliCommand<const TOptions extends CliOptions = Record<string, never>,
                            const TPositionals extends CliPositionals = readonly []>(command: {
  summary: string; description?: string; aliases?: readonly string[]; suggestFor?: readonly string[]; hidden?: boolean;
  options?: TOptions; positionals?: TPositionals; constraints?: readonly PluginCliConstraint[];
  passthrough?: boolean; unexpectedPositionalHint?: string;
  run(input: PluginCliRunInput<TOptions, TPositionals>, ctx: PluginCliContext): PluginCliResult | Promise<PluginCliResult>;
}): PluginCliCommand;

interface PluginCliSpec {
  name: string;                         // `bb <name>`; lowercase [a-z0-9-]+
  summary: string;
  description?: string;
  root?: PluginCliCommand;              // runs when no subcommand
  commands: Record<string, PluginCliCommand>;   // keys are paths: "add", "account add"
  usageErrorExitCode?: number;          // default 1
}
interface PluginCliOptionBase { description: string; aliases?: readonly string[]; short?: string; hidden?: boolean;
                                placeholder?: string; stdin?: boolean /* --<name>-stdin */ }
type PluginCliOption =
  | (PluginCliOptionBase & { type: "boolean" })                                   // absent = false
  | (PluginCliOptionBase & { type: "string"; required?: boolean; repeatable?: boolean; split?: string; default?: string })
  | (PluginCliOptionBase & { type: "integer"; min: number; max: number; required?: boolean; default?: number })
  | (PluginCliOptionBase & { type: "enum"; values: readonly string[]; required?: boolean; repeatable?: boolean;
                             split?: string; default?: string })
  | (PluginCliOptionBase & { type: "duration"; defaultUnit: "d" | "h" | "m" | "ms" | "s";
                             bareUnits?: readonly ("d"|"h"|"m"|"ms"|"s")[]; min?: number; max?: number; // ms
                             required?: boolean; default?: number /* ms */ });
interface PluginCliPositional { name: string; description: string; required?: boolean; variadic?: boolean }
type PluginCliConstraint =
  | { kind: "exactly-one" | "at-most-one" | "at-least-one"; options: readonly string[] }
  | { kind: "requires"; option: string; needs: readonly string[] };
interface PluginCliRunInput<O, P> {
  options: { [K in keyof O]: /* boolean | string | number | enum-literal; T[] if repeatable;
                                 | undefined unless required/default */ };
  positionals: { [name]: string | string[] /*variadic*/ | undefined /*not required*/ };
  passthrough: string[];
  help: string;
}
interface PluginCliContext { cwd?: string; threadId?: string; projectId?: string; signal?: AbortSignal }
interface PluginCliResult { exitCode: number; stdout?: string; stderr?: string }
declare const PLUGIN_CLI_OUTPUT_MAX_BYTES: number;
declare class PluginCliError extends Error {
  readonly code: string; readonly hint: string | undefined; readonly exitCode: number;
  constructor(message: string, options?: { code?: string; hint?: string; exitCode?: number });
}
type PluginCliErrorCode = "invalid_value" | "missing_command" | "missing_required" | "unexpected_argument"
                        | "unknown_command" | "unknown_option";   // parser codes; PluginCliError may use any snake_case
```
`--json` on the invocation adds `{ ok: false, error: { code, message, hint? } }` on stdout for errors.

---------------------------------------------------------------------------------

## 14. `bb.storage`

```ts
import Database from "better-sqlite3";
interface PluginStorage {
  kv: { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void>;
        delete(key: string): Promise<void>; list(prefix?: string): Promise<string[]> };   // values ≤256KB
  database(): Database.Database;     // YES better-sqlite3; <dataDir>/plugins/<id>/data.db, WAL, same handle per load
  migrate(db: Database.Database, statements: string[]): void;   // index = migration id; append-only; one txn
}
```

---------------------------------------------------------------------------------

## 15. background / realtime / rpc / http

```ts
bb.background.service(name: string, service: { start(signal: AbortSignal): void | Promise<void> }): void;
  // starts after factory; resolve when signal aborts; crash → capped backoff restart
bb.background.schedule(name: string, cron: string /* 5-field, server-local */, fn: () => void | Promise<void>): void;
bb.realtime.publish(channel: string, payload: unknown): void;   // JSON; broadcast to all clients; undefined→null
bb.http.route(method: string, path: string, handler: (c: hono.Context) => Response | Promise<Response>,
              opts?: { auth?: "local" | "none" | "token" }): void;   // /api/v1/plugins/<id>/http/<path>

declare function defineRpcContract<const C extends PluginRpcContract>(contract: C): C;
type PluginRpcContract = Readonly<Record<string, { readonly input: StandardSchemaV1; readonly output: StandardSchemaV1;
                                                   readonly experimental_description?: string }>>;   // zod 4 schemas work
bb.rpc.register<C extends PluginRpcContract>(contract: C,
  handlers: { [M in keyof C]: (input: Output<C[M]["input"]>, context: ExperimentalPluginRpcHandlerContext)
                                => Input<C[M]["output"]> | Promise<Input<C[M]["output"]>> },
  options?: { experimental_discoverable?: boolean; experimental_description?: string }): void;
interface ExperimentalPluginRpcHandlerContext {
  readonly experimental_caller: { readonly kind: "plugin"; readonly pluginId: string } | { readonly kind: "client" };
}
// wire: POST /api/v1/plugins/<id>/rpc/<method> → { ok: true, result } | { ok: false, error: { code, message, issues? } }
// codes: "handler_error" | "invalid_input" | "invalid_json" | "invalid_output" | "non_json_result" | "unknown_method"
```

---------------------------------------------------------------------------------

## 16. `bb.settings`

```ts
bb.settings.define<Ds extends Record<string, PluginSettingDescriptor>>(descriptors: Ds): PluginSettingsHandle<Ds>;
type PluginSettingDescriptor =
  | { type: "string"; label: string; description?: string; secret?: true; experimental_multiline?: boolean;
      experimental_schema?: StandardSchemaV1<string, string>; default?: string }
  | { type: "boolean"; label: string; description?: string; experimental_schema?: ...; default?: boolean }
  | { type: "number"; label: string; description?: string; experimental_schema?: ...; default?: number }
  | { type: "select"; label: string; description?: string; options: string[];
      experimental_optionLabels?: Record<string, string>; experimental_schema?: ...; default?: string }
  | { type: "project"; label: string; description?: string; experimental_schema?: ...; default?: string };  // value = projectId
interface PluginSettingsHandle<Ds> {
  get(): Promise<PluginSettingsValues<Ds>>;   // default present → T, else T | undefined; callable in factory
  experimental_set(values: Partial<{ [K in keyof Ds]: ValueOf<Ds[K]> | null }>): Promise<PluginSettingsValues<Ds>>;
  onChange(listener: (next, prev) => void): void;
}
```
Secrets are stored on disk (0600) and are never sent to the frontend (`useSettings` omits them).

---------------------------------------------------------------------------------

## 17. Host entries (`bb.host`)

Manifest (package.json) — seen in installed community plugins, not in typings:
```json
"bb": { "name": "...", "server": "./server.ts", "app": "./app.tsx", "host": "./host.ts" }
```
`bb plugin build` bundles it to `dist/host.js` (+ `host.meta.json`); it runs inside each host daemon.

```ts
// host.ts
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
export default experimental_defineHostEntry({ contract, handlers: { method: async (input, ctx) => ... } });

declare function experimental_defineHostEntry<const C extends PluginRpcContract, const S extends ExperimentalHostSignals = {}>(args: {
  contract: C;
  experimental_signals?: S;               // Record<string, { payload: StandardSchemaV1 }>
  handlers: { [M in keyof C]: (input: Output<C[M]["input"]>, context: ExperimentalHostRpcContext<S>) => Input<C[M]["output"]> | Promise<...> };
  dispose?: () => void | Promise<void>;
}): ExperimentalHostEntry<C, S>;          // { experimental_apiVersion: 1; contract; experimental_signals?; handlers; dispose? }
interface ExperimentalHostRpcContext<S> {
  readonly signal: AbortSignal;                       // this request
  readonly lifecycle: { readonly signal: AbortSignal };   // worker lifetime
  readonly experimental_paths: { readonly dataDir: string; readonly tempDir: string };
  experimental_emitSignal<N extends keyof S & string>(signal: N, payload: Input<S[N]["payload"]>): Promise<void>;
  experimental_watch(options: { rootPath: string; ignoredPaths?: readonly string[]; debounceMs?: number; maxWaitMs?: number },
                     listener: (e: { kind: "changed"; changes: readonly { path: string; type: "create" | "delete" | "update" }[] }
                                 | { kind: "rescan-required" } | { kind: "watch-error"; message: string }) => void | Promise<void>)
    : Promise<{ dispose(): Promise<void> }>;
  experimental_retainWorker(): { dispose(): Promise<void> };
}

// server side
bb.hosts.experimental_client<C extends PluginRpcContract, S extends ExperimentalHostSignals = {}>(args: {
  contract: C; experimental_signals?: S }): ExperimentalHostClient<C, S>;
interface ExperimentalHostClient<C, S> {
  call<M extends keyof C & string>(method: M, input: Input<C[M]["input"]>,
       options: { readonly hostId: string; readonly signal?: AbortSignal; readonly timeoutMs?: number /* default 30s, max 30min */ })
    : Promise<Output<C[M]["output"]>>;
  experimental_onWorkerExit(handler: (e: { readonly hostId: string }) => void | Promise<void>): () => void;
  experimental_onSignal<N extends keyof S & string>(signal: N, handler: (e: { hostId: string; payload: Output<S[N]["payload"]> }) => void): () => void;
}
// bb.hosts also: ensureSharedPortTunnel(hostId): Promise<{label; baseDomain}>, declareSharedPorts(hostId, ports): void
```

---------------------------------------------------------------------------------

## 18. Lifecycle / status

```ts
bb.onDispose(hook: () => void | Promise<void>): void;   // LIFO on reload/disable/shutdown
bb.onInstall(handler: () => void | Promise<void>): void; // once after fresh install (not update/reload)
bb.status.needsConfiguration(message: string): void;    // cleared on next load
bb.log.debug|info|warn|error(message: string): void;
bb.server.loopbackBaseUrl: string; bb.server.experimental_appUrl: string | null;
// Throwing Object.assign(new Error(msg), { name: "NeedsConfigurationError" }) from a service also marks needs-configuration.
```

---------------------------------------------------------------------------------

## 19. Frontend: `definePluginApp` and slots (`@get-bb/plugin-sdk/app`)

```ts
definePluginApp(setup: (app: PluginAppBuilder) => void): PluginAppDefinition;   // default export of app.tsx
interface PluginAppBuilder {
  slots: PluginAppSlots; commands: PluginAppCommands; composer: PluginAppComposer;
  contentScripts: PluginAppContentScripts; experimental_icons: { register(r: { name: string;
    component: ComponentType<{ className?: string }> }): void }; experimental_sidebarFooter: ...;
}
interface PluginAppSlots {
  navPanel(r: PluginNavPanelRegistration): void;
  homepageSection(r: { id: string; title: string; component: ComponentType<{ projectId: string | null }> }): void;
  settingsSection(r: { id: string; title?: string; description?: string; experimental_page?: "mobile";
                       component: ComponentType<{}> }): void;
  threadPanelAction(r: PluginThreadPanelActionRegistration): void;
  // also: experimental_newThreadPanelAction, pendingInteraction, sidebarFooterAction, experimental_threadList,
  // experimental_threadHeaderAction, experimental_threadAction<Data>, experimental_browserToolbarAction, fileOpener,
  // experimental_sourceCodeRenderer, experimental_diffRenderer, messageDirective, experimental_codeFenceRenderer,
  // messageAction, commandPaletteAction, experimental_providerIcon, experimental_timelineRenderer,
  // experimental_environmentProviderInputs, experimental_machineProviderInputs, experimental_appOverlay
}
interface PluginNavPanelRegistration {
  id: string;               // letters, digits, -, _
  title: string;
  icon: string;             // BbIconName (REQUIRED); unknown → plugin branding
  path: string;             // URL segment under /plugins/<pluginId>/
  component: ComponentType<{ subPath: string }>;   // PluginNavPanelProps
  headerContent?: ComponentType<{ subPath: string }>;
  fixedTabs?: readonly { panelId: string; id: string; title: string; icon: string;
                         component: ComponentType<{ subPath: string }>; layout?: "flush" | "padded" }[];
  experimental_sidebarAccessory?: ComponentType;
}
interface PluginThreadPanelActionRegistration {
  id: string; title: string; icon?: string;
  component: ComponentType<{ threadId: string; params: JsonValue | null }>;   // PluginThreadPanelProps
  layout?: "flush" | "padded";
  run?(context: { threadId: string; openPanel(options?: { title?: string; params?: JsonValue }): boolean }): void | Promise<void>;
  // run omitted = immediately open a panel tab with defaults; errors are contained and logged
}
```

## 20. Frontend hooks

```ts
useRpc<C extends PluginRpcContract = PluginRpcContract>(): { call<M>(method: M, ...args: [input] | [input?]): Promise<Output> };
useRealtime(channel: string, handler: (payload: unknown) => void): void;
useRealtimeConnectionState(): "connected" | "connecting" | "reconnecting";
useBbContext(): { projectId: string | null; threadId: string | null };
useSettings(): { values: Record<string, string | number | boolean> | undefined; isLoading: boolean };  // no secrets
useSdk(): PluginBrowserBbSdk;   // same areas as bb.sdk (threads plugin-bound), user's session authority
experimental_usePluginId(): string;
useBbNavigate(): BbNavigate;
interface BbNavigate {
  toThread(threadId: string, options?: { split?: boolean }): void;
  toProject(projectId: string): void;
  toPluginPanel(path: string, options?: { subPath?: string; replace?: boolean }): void;
  toCompose(options?: { projectId?: string; initialPrompt?: string; focusPrompt?: boolean;
                        placement?: { sectionId: string | null; pinned: boolean }; environmentId?: string; hostId?: string }): void;
  openThreadPanel(options: PluginTargetedPanelActionOpenOptions /* {actionId, title?, params?} */): boolean;
  openUrl(url: string): boolean;
  experimental_openFilePreview(options): boolean;
  experimental_openFileExternally(options): boolean;
  experimental_openTerminal(options: { terminalId: string }): Promise<boolean>;
}
```

## 21. Components

```ts
<ThreadChat threadId: string
            variant?: "compact" | "full" | "timeline"      // default "full"
            layout?: "contained" | "document"              // default "contained"
            focusRequest?: number
            permissionPolicy?: "editable" | "inherit"      // default "inherit"
            className?: string leadingContent?: ReactNode
            messageActions?: readonly ThreadChatMessageAction[] />

<experimental_ProviderModelPicker
   value: ExperimentalProviderModelPickerValue
   onChange(value: ExperimentalProviderModelPickerValue): void
   routing?: { kind: "host"; hostId: string } | { kind: "environment"; environmentId: string }  // omit = primary machine
   allowProviderChange?: boolean      // default true
   align?: "center" | "end" | "start" // default "start"
   disabled?: boolean className?: string />
interface ExperimentalProviderModelPickerValue {
  providerId: string; model: string; reasoningLevel: string;
  serviceTier?: string;   // only when provider supports tiers; "default" if model offers none
}   // designed to be forwarded verbatim to threads.spawn

<experimental_Icon name: string fallback?: string /* default "Zap" */ className? style? aria-hidden? aria-label? />
```
Also exported: `Markdown`, `UrlLink`, `ThreadTitle`, `experimental_FileLink`, `experimental_NewThreadComposer`,
`experimental_PermissionModePicker`, `experimental_BranchPicker`, `experimental_Diff`, `experimental_SourceCode`,
`experimental_ProviderIcon`, `experimental_ThreadStatusGlyph`, `experimental_ThreadActionsMenu`, ...

## 22. Icon names

The typings only have `type BbIconName = string;` (resolution order: app-registered name → built-in → `"<pluginId>/<name>"`
from manifest `bb.branding.experimental_icons`; unknown → surface fallback). No union exists in any `.d.ts`.
The actual built-in list was read from the installed BB app bundle (`ICON_NAMES` in
`/Applications/bb.app/.../app/dist/assets/index-*.js`) — 177 names for this app version:

```
AiBrain01 AiBrowser AiContentGenerator01 AlertCircle AlertTriangle AlignLeft AppWindow Archive ArchiveRestore
ArrowDown ArrowLeft ArrowReloadHorizontal ArrowRight ArrowTurnBackward ArrowTurnForward ArrowUp ArrowUpDown
ArrowUpRight Beaker BellDot Bot Brain Browser Bug Calendar CalendarCheckOut02 ChartColumn Check ChevronDown
ChevronLeft ChevronRight ChevronUp ChevronsDown ChevronsUp ChildThread Circle CircleArrowShrink CircleCheck
CircleQuestion CircleX Clean Clock ClockArrowDown ClockArrowUp ClosePluginPane CloseThreadPane Cloud CloudOff Code
Coffee Columns2 ComputerCloud ComputerTerminal01 Copy CornerDownLeft CornerDownRight DateTime DiffAdded DiffConflict
DiffModified DiffRemoved DiffRenamed Discord DiscordLogo Download DragDropHorizontal DragDropVertical Edit EditFile
ElectricPlugs Explore ExternalLink Eye EyeOff File FileAttachment FileDiff FileQuestion FileText Filter
FilterHorizontal Folder Folder02 FolderEdit FolderExport FolderGit FolderMinus FolderOpen FolderPlus FolderSync
FolderUnknown Fork GitBranch GitMerge GitPullRequest GitPullRequestArrow GitPullRequestClosed GitPullRequestDraft
Github GithubLogo Globe GridView Home Info Keyboard Laptop Layers Limitation Link ListEnd ListTodo ListView Loading
Lock Mail MailOpen Maximize2 MessageCirclePlus MessageQuestion MessageSquare MessageSquarePlus Mic Minimize2 Minus
MoreHorizontal MoveTo NewTab News01 PackageReceive Palette PanelBottom PanelLeft PanelRight Paperclip Pause Pin
PinOff Play Plug02 Plus Puzzle Repeat RotateCcw Rows2 Search SectionAdd SectionMove SecurityCheck Sent Settings
SideChat SlidersHorizontal Smartphone Sort SortingAZ02 SortingNineOne SortingOneNine SortingZA01 Spinner Square
SquareUnlock02 Star Target Terminal TextWrap TimeSchedule ToolCase Toolbox Trash2 Unavailable UserRound
UserRoundPlus Workflow X Zap ZoomIn ZoomOut
```
Requested checks: **Workflow ✔, Bot ✔** — Ship ✘, Network ✘, Compass ✘, Anchor ✘, LayoutDashboard ✘ (also absent:
Rocket, Gauge, Server, Package, Activity, Sparkles, Kanban). Close substitutes: `Explore`, `Globe`, `Layers`,
`GridView`, `Target`, `Workflow`, `Toolbox`. For a custom glyph, register one with `app.experimental_icons.register`
(frontend only) or declare an SVG under manifest `bb.branding.experimental_icons` and use `"<pluginId>/<name>"`.
The 55 always-loaded "core" names are a subset; the remaining 122 load lazily (`preloadExtendedIcons`).

---------------------------------------------------------------------------------

## 23. Testing (`@get-bb/plugin-sdk/testing`)

`createFakePluginHost(options?: { pluginId?; settings?: Record<string, string|number|boolean>; sdk?: FakeSdkOverrides
(nested stubs keyed like bb.sdk, e.g. { threads: { spawn: async () => ... } }); dataDir?; appUrl?; loopbackBaseUrl?;
agentSkillIds?; sharedPortTunnelIdentities?; machineBootstrap?; machineResource?; experimental_hostEntry?: boolean;
experimental_declaredIconNames?; experimental_callHostRpc?: (call) => unknown })` → `{ bb: BbPluginApi; harness }`.
Run your factory with `await plugin(host.bb)`. `harness.behavior`: `callRpc(method, input?, {experimental_caller?})`,
`runCli(argv, ctx?)`, `fetchHttp(method, path, init?)`, `runService(name)` → `{controller, done}`, `runSchedule(name)`,
`emitThreadEvent(event, payload)` → `{errors}`, `callAgentTool(name, input, ctx?)`, `resolveAgentConfiguration(ctx)` →
`{tools, skills, instructions}`, `setSettings(values)`, `submitInteraction(id, value)`, `cancelInteraction(id)`,
`experimental_emitHostSignal/emitHostWorkerExit`, `resolveProviderEnv/Health`, `experimental_openWebSocket`.
`harness.inspection`: `registrations` (`rpcMethods`, `httpRoutes`, `services`, `schedules`, `cli`, `agentTools`,
`agentConfigurationProvider`, `instructionProvider`, `threadEventHandlers` (counts per event), `hooks`,
`settingsDescriptors`, ...), `sdk` (`calls`, `callsTo("threads.spawn")`, `stub(path, impl)`), `logEntries`,
`realtimeSignals`, `needsConfigurationMessages`, `recheckCount`, `pendingInteractions`, `experimental_hostRpcCalls`.
`harness.lifecycle`: `reload(factory)`, `dispose()`, `install()`. Unstubbed `bb.sdk` calls throw naming the path.
Fixtures: `makeThreadResponse`, `makeQueueEntry`, `makeTurnFailedEvent`, `makeHostResponse`,
`makeMessageDispatchHookContext`, `makePluginAgentConfigurationContext` (partial overrides). Frontend:
`@get-bb/plugin-sdk/testing/app` → `loadPluginApp`, `renderSlot`, `mountPluginContentScripts`, `installTestPluginRuntime`.
