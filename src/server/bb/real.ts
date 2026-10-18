// The real BbPort over api.sdk and Helm's host entry (§9.1). This is the only
// file that talks to BB. Every call is one SDK request; nothing here polls.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { HOST_CONTRACT, type HostOps } from "../../shared/host-contract.ts";
import type { BbPort, EnvInfo, ForeignThread, HelmEvent, InteractionAnswer, InteractionLite, PluginLite, RawCatalog, SendResult, SpawnSpec, ThreadRef, ThreadState } from "./port.ts";
import { readMeta } from "./port.ts";

type Sdk = BbPluginApi["sdk"];
type Handler = (e: HelmEvent) => void | Promise<void>;

/** Host RPC budgets: git work is quick, a full scan of a big repo is not. */
const HOST_TIMEOUT_MS: Partial<Record<keyof HostOps, number>> = { ensureRepo: 120_000, adoptRepo: 120_000, inspectPath: 90_000, scan: 300_000, probe: 60_000, screensScan: 45_000, ensureWorktree: 150_000, worktrees: 90_000, diskUsage: 600_000, remoteStatus: 120_000 };

function textOf(blocks: ReadonlyArray<{ type: string; text?: string }> | null | undefined): string {
  return (blocks ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

/** Reduce a BB pending interaction to what the Needs inbox shows. */
export function toInteractionLite(i: unknown): InteractionLite {
  const x = i as { id: string; threadId: string; payload?: Record<string, unknown> };
  const p = (x.payload ?? {}) as Record<string, unknown>;
  const base = { id: x.id, threadId: x.threadId, options: [] as string[], questions: [] as InteractionLite["questions"], decisions: [] as string[] };
  if (p.kind === "approval") {
    const subject = (p.subject ?? {}) as Record<string, unknown>;
    const decisions = Array.isArray(p.availableDecisions) ? (p.availableDecisions as string[]) : ["allow_once", "deny"];
    if (subject.kind === "plan") return { ...base, kind: "plan", title: "Approve the agent's plan", body: String(subject.plan ?? "").slice(0, 4000), options: ["Approve", "Deny"], decisions };
    const what =
      subject.kind === "command" ? `Run: ${String(subject.command ?? "")}` : subject.kind === "file_change" ? "Change files" : subject.kind === "tool_use" ? `Use tool ${String(subject.tool ?? "")}` : "Permission request";
    return { ...base, kind: "approval", title: what.slice(0, 200), body: String(p.reason ?? "").slice(0, 2000), options: ["Approve", "Deny"], decisions };
  }
  if (p.kind === "user_question") {
    const qs = Array.isArray(p.questions) ? (p.questions as Array<Record<string, unknown>>) : [];
    const questions = qs.map((q) => ({
      id: String(q.id),
      prompt: String(q.prompt ?? ""),
      options: Array.isArray(q.options) ? (q.options as Array<{ label?: string; value?: string }>).map((o) => String(o.value ?? o.label ?? "")) : [],
      allowFreeText: q.allowFreeText !== false,
      multiSelect: q.multiSelect === true,
    }));
    return { ...base, kind: "question", title: questions[0]?.prompt.slice(0, 200) || "The agent has a question", body: questions.map((q) => q.prompt).join("\n\n").slice(0, 4000), options: questions[0]?.options ?? [], questions };
  }
  const title = typeof p.title === "string" ? p.title : "The agent is waiting for input";
  return { ...base, kind: "other", title: title.slice(0, 200), body: JSON.stringify(p.data ?? null).slice(0, 2000) };
}

function toResolution(a: InteractionAnswer): unknown {
  switch (a.kind) {
    case "allow":
      return { decision: a.forSession ? "allow_for_session" : "allow_once", grantedPermissions: null };
    case "deny":
      return { decision: "deny" };
    case "answer":
      return { kind: "user_answer", answers: a.answers };
    case "value":
      return { kind: "request_answer", value: a.value };
  }
}

export class RealBB implements BbPort {
  readonly kind = "real" as const;
  private handlers: Handler[] = [];
  private primary: string | null | undefined;
  private hostClient: ReturnType<BbPluginApi["hosts"]["experimental_client"]> | null = null;
  private hostCache = new Map<string, HostOps>();

  constructor(
    private bb: BbPluginApi,
    private opts: { log?: (msg: string) => void } = {},
  ) {}

  private get sdk(): Sdk {
    return this.bb.sdk;
  }

  now = (): number => Date.now();
  setTimeout = (fn: () => void, ms: number): (() => void) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  };

  // ───────── events ─────────

  onEvent(handler: Handler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  private emit(e: HelmEvent): void {
    for (const h of this.handlers) {
      try {
        const r = h(e);
        if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch((err) => this.opts.log?.(`event handler failed for ${e.type}: ${String(err)}`));
      } catch (err) {
        this.opts.log?.(`event handler failed for ${e.type}: ${String(err)}`);
      }
    }
  }

  /** Subscribe to BB's lifecycle events and the dispatch hook. Called once from the factory. */
  install(): void {
    const ev = this.bb.events;
    ev.on("thread.created", ({ thread }) => this.emit({ type: "thread.created", threadId: thread.id }));
    ev.on("thread.active", ({ thread }) => this.emit({ type: "thread.active", threadId: thread.id }));
    ev.on("thread.idle", ({ thread, lastAssistantText }) => this.emit({ type: "thread.idle", threadId: thread.id, lastText: lastAssistantText }));
    ev.on("thread.failed", ({ thread, error }) => this.emit({ type: "thread.failed", threadId: thread.id, error }));
    ev.on("thread.archived", ({ thread }) => this.emit({ type: "thread.archived", threadId: thread.id }));
    ev.on("experimental_thread.events", ({ thread }) => this.emit({ type: "thread.activity", threadId: thread.id }));
    ev.on("interaction.pending", ({ thread, interaction }) => this.emit({ type: "interaction.pending", threadId: thread.id, interaction: toInteractionLite(interaction) }));
    ev.on("message.queued", ({ entry }) =>
      this.emit({ type: "message.queued", threadId: entry.threadId, queuedMessageId: entry.id, initiator: entry.initiator, text: textOf(entry.content), originPluginId: entry.originPluginId }),
    );
    ev.on("message.dispatched", ({ entry }) =>
      this.emit({ type: "message.dispatched", threadId: entry.threadId, queuedMessageId: entry.id, initiator: entry.initiator, text: textOf(entry.content), originPluginId: entry.originPluginId }),
    );
    ev.on("message.cancelled", ({ entry }) => this.emit({ type: "message.cancelled", threadId: entry.threadId, queuedMessageId: entry.id }));
    ev.on("turn.failed", (e) =>
      this.emit({ type: "turn.failed", threadId: e.threadId, requestId: e.requestId, category: e.errorInfo?.category ?? null, inputAccepted: e.inputAccepted, attempt: e.attemptNumber }),
    );
    // V18: every message on its way to a provider. Helm only observes; it never holds or refuses a message.
    this.bb.experimental_hooks.on("message.dispatch", (ctx) => {
      try {
        const initiator = ctx.initiator === "mixed" ? "mixed" : ctx.initiator;
        const sender = ctx.senderThreadId === "mixed" ? "mixed" : ctx.senderThreadId;
        const origin = ctx.originPluginId === "mixed" ? null : ctx.originPluginId;
        // report asynchronously so the hook returns at once (10 s box, fail-closed)
        queueMicrotask(() => this.emit({ type: "message.dispatch", threadId: ctx.thread.id, initiator, senderThreadId: sender, originPluginId: origin, text: ctx.input.text ?? "" }));
      } catch (err) {
        this.opts.log?.(`dispatch observer failed: ${String(err)}`);
      }
      return { action: "proceed" };
    });
  }

  // ───────── hosts, projects, catalog ─────────

  async primaryHostId(): Promise<string | null> {
    if (this.primary !== undefined) return this.primary;
    const cfg = await this.sdk.system.config();
    this.primary = cfg.primaryHostId ?? null;
    return this.primary;
  }

  async createProject(args: { name: string; hostId: string; path: string }): Promise<{ projectId: string }> {
    const p = await this.sdk.projects.create({ name: args.name, source: { type: "local_path", hostId: args.hostId, path: args.path } });
    return { projectId: p.id };
  }

  async findProjectByPath(args: { hostId: string; path: string }): Promise<{ projectId: string } | null> {
    const list = (await this.sdk.projects.list({})) as Array<{ id: string; sources?: Array<{ hostId: string; path: string }> }>;
    const norm = (p: string) => p.replace(/\/+$/, "");
    const hit = list.find((p) => p.sources?.some((s) => s.hostId === args.hostId && norm(s.path) === norm(args.path)));
    return hit ? { projectId: hit.id } : null;
  }

  async catalog(args: { hostId: string | null }): Promise<RawCatalog> {
    const hostId = args.hostId ?? (await this.primaryHostId());
    const providers = await this.sdk.providers.list(hostId ? { hostId } : {});
    const out: RawCatalog = { providers: providers.map((p) => ({ id: p.id, label: p.displayName, available: p.available, permissionModes: p.capabilities?.permissionModes ?? null })), models: [], error: null };
    for (const p of providers.filter((x) => x.available)) {
      const res = await this.sdk.providers.models(hostId ? { hostId, providerId: p.id } : { providerId: p.id });
      if (res.modelLoadError && !out.error) out.error = { providerId: res.modelLoadError.providerId, code: res.modelLoadError.code, detail: res.modelLoadError.detail };
      for (const m of res.models) {
        out.models.push({
          providerId: p.id,
          id: m.model || m.id,
          displayName: m.displayName,
          description: m.description,
          isDefault: m.isDefault,
          defaultReasoning: m.defaultReasoningEffort ?? null,
          reasoning: m.supportedReasoningEfforts.map((r) => r.reasoningEffort),
          // claude-code lists tiers per provider, codex per model (V8)
          serviceTiers: (m.supportedServiceTiers?.map((t) => t.id) ?? p.serviceTiers?.map((t) => t.id) ?? []).filter((t) => t !== "default"),
        });
      }
    }
    return out;
  }

  // ───────── threads ─────────

  async spawnThread(spec: SpawnSpec): Promise<ThreadRef> {
    const env = spec.environment;
    const environment =
      env.kind === "reuse"
        ? { type: "reuse" as const, environmentId: env.environmentId }
        : env.kind === "path"
          ? { type: "host" as const, ...(env.hostId ? { hostId: env.hostId } : {}), workspace: { type: "unmanaged" as const, path: env.path } }
          : {
              type: "host" as const,
              ...(env.hostId ? { hostId: env.hostId } : {}),
              workspace: { type: "managed-worktree" as const, baseBranch: env.baseBranch ? { kind: "named" as const, name: env.baseBranch } : { kind: "default" as const } },
            };
    const t = await this.sdk.threads.spawn({
      projectId: spec.projectId,
      environment,
      title: spec.title,
      prompt: spec.prompt,
      providerId: spec.model.providerId,
      model: spec.model.modelId,
      ...(spec.model.reasoning ? { reasoningLevel: spec.model.reasoning } : {}),
      ...(spec.model.serviceTier ? { serviceTier: spec.model.serviceTier } : {}),
      permissionMode: spec.permissionMode,
      visibility: spec.visibility,
      ...(spec.lifecycleOwnerThreadId ? { lifecycleOwnerThreadId: spec.lifecycleOwnerThreadId } : {}),
      pluginMetadata: { helm: { ...spec.meta } },
    });
    return { threadId: t.id, environmentId: t.environmentId };
  }

  async findThreadByKey(args: { key: string; runId: string; ownerThreadId: string | null }): Promise<ThreadRef | null> {
    // V17: Helm's own threads, newest first, matched by the key in pluginMetadata.helm
    const self = this.bb.pluginId;
    for (let offset = 0; offset < 2000; offset += 200) {
      const rows = await this.sdk.threads.list({ originPluginId: self, includeHidden: true, limit: 200, offset });
      // an archived thread is never adopted: a respawn must get a new one
      const candidates = rows.filter((r) => !r.archivedAt).filter((r) => !args.ownerThreadId || r.lifecycleOwnerThreadId === args.ownerThreadId || r.id === args.ownerThreadId || r.lifecycleOwnerThreadId === null);
      if (candidates.length) {
        const meta = await this.sdk.threads.experimental_listPluginMetadata({ threadIds: candidates.map((r) => r.id) });
        for (const m of meta.threads) {
          const h = readMeta(m.metadata);
          if (h && h.key === args.key && h.runId === args.runId) {
            const row = candidates.find((r) => r.id === m.threadId)!;
            return { threadId: row.id, environmentId: row.environmentId };
          }
        }
      }
      if (rows.length < 200) break;
    }
    return null;
  }

  async sendMessage(args: { threadId: string; text: string; mode: "steer" | "queue"; senderThreadId?: string | null }): Promise<SendResult> {
    const res = await this.sdk.threads.send({
      threadId: args.threadId,
      input: [{ type: "text", text: args.text, mentions: [] }],
      mode: args.mode === "steer" ? "steer-if-active" : "queue-if-active",
      ...(args.senderThreadId ? { senderThreadId: args.senderThreadId } : {}),
    });
    return res.delivery === "queued" ? { delivery: "queued", queuedMessageId: res.queuedMessage.id } : { delivery: "sent", queuedMessageId: null };
  }

  async updateThread(args: { threadId: string; model?: string; reasoningLevel?: string | null; title?: string; visibility?: "hidden" | "visible" }): Promise<void> {
    await this.sdk.threads.update({
      threadId: args.threadId,
      ...(args.model ? { model: args.model } : {}),
      ...(args.reasoningLevel !== undefined ? { reasoningLevel: args.reasoningLevel } : {}),
      ...(args.title ? { title: args.title } : {}),
      ...(args.visibility ? { visibility: args.visibility } : {}),
    });
  }

  async stopThread(threadId: string): Promise<void> {
    await this.sdk.threads.stop({ threadId });
  }

  async archiveThread(threadId: string): Promise<string[]> {
    const r = await this.sdk.threads.archive({ threadId });
    return r.archivedThreadIds;
  }

  async deleteEnvironment(environmentId: string): Promise<void> {
    await this.sdk.environments.delete({ environmentId });
  }

  async retryThread(args: { threadId: string; turnRequestId?: string }): Promise<void> {
    await this.sdk.threads.retry({ threadId: args.threadId, ...(args.turnRequestId ? { turnRequestId: args.turnRequestId } : {}), reason: "Helm retry" });
  }

  async compactThread(threadId: string): Promise<void> {
    await this.sdk.threads.compact({ threadId });
  }

  async threadState(threadId: string): Promise<ThreadState | null> {
    let t: Awaited<ReturnType<Sdk["threads"]["get"]>>;
    try {
      t = await this.sdk.threads.get({ threadId });
    } catch (err) {
      if (/404|not found/i.test(String(err))) return null;
      throw err;
    }
    if (t.deletedAt) return null;
    const env = t.environmentId ? await this.environment(t.environmentId).catch(() => null) : null;
    const pending = await this.sdk.threads.interactions.list({ threadId }).catch(() => []);
    return {
      threadId,
      status: t.status,
      archived: !!t.archivedAt,
      providerId: t.providerId ?? null,
      environmentId: t.environmentId,
      hostId: env?.hostId ?? null,
      path: env?.path ?? null,
      branch: env?.branch ?? null,
      hasPendingInteraction: (pending as Array<{ status?: string }>).some((i) => i.status === "pending"),
    };
  }

  async environment(environmentId: string): Promise<EnvInfo | null> {
    try {
      const e = await this.sdk.environments.get({ environmentId });
      return { environmentId: e.id, hostId: e.hostId, path: e.path, branch: e.branchName, status: e.status };
    } catch (err) {
      if (/404|not found/i.test(String(err))) return null;
      throw err;
    }
  }

  async threadContext(threadId: string): Promise<{ usedTokens: number; window: number; estimated: boolean } | null> {
    const r = await this.sdk.threads.context({ threadId });
    return r.usage ? { usedTokens: r.usage.usedTokens, window: r.usage.modelContextWindow, estimated: r.usage.estimated } : null;
  }

  async threadOutput(threadId: string): Promise<string | null> {
    return (await this.sdk.threads.output({ threadId })).output;
  }

  async listInteractions(threadId: string): Promise<InteractionLite[]> {
    const list = await this.sdk.threads.interactions.list({ threadId });
    return (list as Array<{ status?: string }>).filter((i) => i.status === "pending").map(toInteractionLite);
  }

  async respondInteraction(args: { threadId: string; interactionId: string; answer: InteractionAnswer }): Promise<void> {
    await this.sdk.threads.interactions.resolve({ threadId: args.threadId, interactionId: args.interactionId, resolution: toResolution(args.answer) as never });
  }

  async listPlugins(): Promise<PluginLite[]> {
    const r = (await this.sdk.plugins.list()) as unknown as { plugins: Array<{ id: string; name: string | null; description: string | null; enabled: boolean; status: string; cliCommand: { name: string; summary: string } | null }> };
    return r.plugins
      .filter((p) => p.enabled && p.status === "running")
      .map((p) => ({ id: p.id, name: p.name ?? p.id, description: (p.description ?? "").slice(0, 200), command: p.cliCommand ? `bb ${p.cliCommand.name}` : null }));
  }

  async countActive(args: { providerId?: string } = {}): Promise<number> {
    const r = await this.sdk.threads.count({ status: "active", ...(args.providerId ? { providerId: args.providerId } : {}) });
    return r.total;
  }

  async listForeignThreads(args: { limit: number }): Promise<ForeignThread[]> {
    const self = this.bb.pluginId;
    const rows = await this.sdk.threads.list({ includeHidden: true, limit: Math.min(500, Math.max(1, args.limit)) });
    return rows
      .filter((r) => r.originPluginId !== self && !r.archivedAt && !r.deletedAt)
      .map((r) => ({
        threadId: r.id,
        title: r.title ?? r.titleFallback ?? "(untitled)",
        status: r.status,
        projectId: r.projectId,
        providerId: r.providerId,
        parentThreadId: r.parentThreadId,
        originPluginId: r.originPluginId,
        hidden: r.visibility === "hidden",
        updatedAt: r.updatedAt,
      }));
  }

  // ───────── host entry ─────────

  host(hostId: string | null): HostOps {
    const key = hostId ?? "primary";
    const cached = this.hostCache.get(key);
    if (cached) return cached;
    if (!this.hostClient) this.hostClient = this.bb.hosts.experimental_client({ contract: HOST_CONTRACT });
    const client = this.hostClient;
    const resolveHost = async () => {
      const id = hostId ?? (await this.primaryHostId());
      if (!id) throw new Error("No host is available to run git on. Connect a machine in BB and retry.");
      return id;
    };
    const ops = {} as Record<string, (input: unknown) => Promise<unknown>>;
    for (const method of Object.keys(HOST_CONTRACT) as Array<keyof HostOps>) {
      ops[method] = async (input: unknown) => client.call(method, input as never, { hostId: await resolveHost(), timeoutMs: HOST_TIMEOUT_MS[method] ?? 30_000 });
    }
    const typed = ops as unknown as HostOps;
    this.hostCache.set(key, typed);
    return typed;
  }
}
