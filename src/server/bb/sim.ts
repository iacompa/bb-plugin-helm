// The simulated BB (§14): an in-memory BbPort with a deterministic virtual
// clock, thread lifecycle events, queued messages, lifecycle-owner cascades,
// native interactions, failures on demand, and scriptable agents. The big
// scenarios (20 apps, 169 agents, crashes) run here, never on real providers.

import type { BbPort, EnvInfo, ForeignThread, HelmEvent, HelmThreadMeta, InteractionAnswer, InteractionLite, PluginLite, RawCatalog, SendResult, SpawnSpec, ThreadRef, ThreadState } from "./port.ts";
import type { HostOps } from "../../shared/host-contract.ts";
import { FakeGit } from "./sim-git.ts";

// ───────────────────────────── virtual clock ─────────────────────────────

interface Timer {
  at: number;
  seq: number;
  fn: () => void;
  cancelled: boolean;
}

export class VirtualClock {
  private t: number;
  private timers: Timer[] = [];
  private seq = 0;
  constructor(start = Date.UTC(2026, 9, 16, 9, 0, 0)) {
    this.t = start;
  }
  now = (): number => this.t;
  setTimeout = (fn: () => void, ms: number): (() => void) => {
    const timer: Timer = { at: this.t + Math.max(0, ms), seq: ++this.seq, fn, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  pending(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }
  nextAt(): number | null {
    const live = this.timers.filter((t) => !t.cancelled);
    return live.length ? Math.min(...live.map((t) => t.at)) : null;
  }
  /** Let promise chains settle (several macrotask turns so awaited I/O-free chains finish). */
  async settle(rounds = 4): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
  }
  /** Run timers in order until `until` (virtual ms) or until nothing is left. */
  async runUntil(until: number, opts: { maxSteps?: number; stopWhen?: () => boolean } = {}): Promise<number> {
    let steps = 0;
    const max = opts.maxSteps ?? 2_000_000;
    await this.settle();
    while (steps < max) {
      if (opts.stopWhen?.()) break;
      this.timers = this.timers.filter((t) => !t.cancelled);
      if (!this.timers.length) break;
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers[0];
      if (next.at > until) break;
      this.timers.shift();
      this.t = Math.max(this.t, next.at);
      steps++;
      try {
        next.fn();
      } catch (e) {
        // timers must not kill the clock; surface it
        console.error("sim timer threw", e);
      }
      await this.settle(2);
    }
    if (this.t < until && !opts.stopWhen?.()) this.t = until;
    await this.settle();
    return steps;
  }
  async advance(ms: number): Promise<number> {
    return this.runUntil(this.t + ms);
  }
}

// ───────────────────────────── simulated threads ─────────────────────────────

export interface SimThread {
  id: string;
  projectId: string;
  environmentId: string;
  title: string;
  status: ThreadState["status"];
  archived: boolean;
  visibility: "hidden" | "visible";
  meta: HelmThreadMeta | null;
  providerId: string;
  model: string;
  reasoning: string | null;
  ownerId: string | null;
  parentThreadId: string | null;
  queue: Array<{ id: string; text: string; origin: string | null; initiator: string; senderThreadId: string | null }>;
  turns: number;
  tokens: number;
  lastText: string | null;
  /** The spawn prompt, for tests. */
  firstPrompt?: string;
  interactions: InteractionLite[];
  turnToken: number;
  failures: number;
  createdAt: number;
}

export interface TurnContext {
  thread: SimThread;
  text: string;
  first: boolean;
  /** Call a helm_* tool as this thread. */
  tool(name: string, params: unknown): Promise<string>;
  git: FakeGit;
  worktree: string | null;
  sim: SimBB;
}

/** What an agent does in one turn; returns its last assistant text. "hang" = never finishes. */
export type AgentDriver = (ctx: TurnContext) => Promise<string | "hang" | { fail: string } | { ask: InteractionLite }>;

export interface SimOptions {
  clock?: VirtualClock;
  git?: FakeGit;
  hostId?: string;
  catalog?: RawCatalog;
  /** Virtual ms an agent turn takes, by role. */
  turnMs?: (meta: HelmThreadMeta | null) => number;
  selfPluginId?: string;
}

export const SIM_CATALOG: RawCatalog = {
  providers: [
    { id: "codex", label: "Codex", available: true },
    { id: "claude-code", label: "Claude Code", available: true },
  ],
  models: [
    { providerId: "codex", id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", description: "", isDefault: true, defaultReasoning: "medium", reasoning: ["low", "medium", "high", "xhigh", "ultra"], serviceTiers: [] },
    { providerId: "codex", id: "gpt-6-luna", displayName: "GPT-6 Luna", description: "", isDefault: false, defaultReasoning: "medium", reasoning: ["low", "medium", "high"], serviceTiers: [] },
    { providerId: "claude-code", id: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5", description: "", isDefault: true, defaultReasoning: "medium", reasoning: ["low", "medium", "high", "xhigh", "max"], serviceTiers: [] },
    { providerId: "claude-code", id: "claude-haiku-5-5", displayName: "Claude Haiku 5.5", description: "", isDefault: false, defaultReasoning: "low", reasoning: ["low", "medium", "high"], serviceTiers: [] },
    { providerId: "claude-code", id: "claude-opus-5-5", displayName: "Claude Opus 5.5", description: "", isDefault: false, defaultReasoning: "high", reasoning: ["low", "medium", "high", "xhigh", "max"], serviceTiers: [] },
  ],
  error: null,
};

export class SimBB implements BbPort {
  readonly kind = "sim" as const;
  readonly clock: VirtualClock;
  readonly git: FakeGit;
  readonly hostId: string;
  readonly selfPluginId: string;
  threads = new Map<string, SimThread>();
  envs = new Map<string, EnvInfo & { projectId: string }>();
  projects = new Map<string, { id: string; name: string; hostId: string; path: string }>();
  catalogData: RawCatalog;
  driver: AgentDriver = async () => "ok";
  toolCaller: ((name: string, threadId: string, params: unknown) => Promise<string>) | null = null;
  private handlers: Array<(e: HelmEvent) => void | Promise<void>> = [];
  private seq = 0;
  private turnMs: (meta: HelmThreadMeta | null) => number;
  /** Failure injection: method name → remaining failures. */
  failures = new Map<string, number>();
  /** Spawn succeeds in BB but the call throws afterwards (a crash between spawn and the DB write). */
  crashAfterSpawn = 0;
  calls: Array<{ method: string; args: unknown }> = [];
  eventLog: HelmEvent[] = [];
  /** Duplicate / reorder injection for events. */
  duplicateEvents = false;

  constructor(opts: SimOptions = {}) {
    this.clock = opts.clock ?? new VirtualClock();
    this.git = opts.git ?? new FakeGit(this.clock.now);
    this.hostId = opts.hostId ?? "host_sim";
    this.catalogData = opts.catalog ?? SIM_CATALOG;
    this.selfPluginId = opts.selfPluginId ?? "helm";
    this.turnMs = opts.turnMs ?? ((m) => (m?.tier === "specialist" ? 8 * 60_000 : m?.tier === "gate" ? 5 * 60_000 : m?.tier === "lead" ? 4 * 60_000 : 60_000));
  }

  now = (): number => this.clock.now();
  setTimeout = (fn: () => void, ms: number): (() => void) => this.clock.setTimeout(fn, ms);

  onEvent(handler: (e: HelmEvent) => void | Promise<void>): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  private emit(e: HelmEvent): void {
    this.eventLog.push(e);
    const send = () => {
      for (const h of this.handlers) void h(e);
    };
    this.clock.setTimeout(send, 5);
    if (this.duplicateEvents && e.type !== "message.dispatch") this.clock.setTimeout(send, 50);
  }

  private id(prefix: string): string {
    return `${prefix}_${(++this.seq).toString(36).padStart(5, "0")}`;
  }

  private maybeFail(method: string): void {
    this.calls.push({ method, args: null });
    const n = this.failures.get(method) ?? 0;
    if (n > 0) {
      this.failures.set(method, n - 1);
      throw new Error(`HTTP 503: simulated ${method} failure`);
    }
  }

  // ───────── projects, catalog ─────────
  async primaryHostId(): Promise<string | null> {
    return this.hostId;
  }
  async createProject(args: { name: string; hostId: string; path: string }): Promise<{ projectId: string }> {
    this.maybeFail("createProject");
    const id = this.id("proj");
    this.projects.set(id, { id, ...args });
    return { projectId: id };
  }
  async findProjectByPath(args: { hostId: string; path: string }): Promise<{ projectId: string } | null> {
    for (const p of this.projects.values()) if (p.path === args.path && p.hostId === args.hostId) return { projectId: p.id };
    return null;
  }
  async catalog(): Promise<RawCatalog> {
    this.maybeFail("catalog");
    return this.catalogData;
  }

  // ───────── threads ─────────
  async spawnThread(spec: SpawnSpec): Promise<ThreadRef> {
    this.maybeFail("spawnThread");
    const modes = this.catalogData.providers.find((p) => p.id === spec.model.providerId)?.permissionModes;
    if (modes?.length && !modes.includes(spec.permissionMode)) throw new Error(`HTTP 400: Provider ${spec.model.providerId} only supports ${modes.join(", ")} permission mode.`);
    const project = this.projects.get(spec.projectId);
    if (!project) throw new Error(`HTTP 404: project ${spec.projectId}`);
    // reusing an environment keeps its id, like BB
    const envId = spec.environment.kind === "reuse" ? spec.environment.environmentId : this.id("env");
    let path: string;
    let branch: string | null;
    if (spec.environment.kind === "worktree") {
      if (!this.git.repos.has(project.path)) throw new Error("HTTP 409: This project checkout has no usable git branch");
      const wt = this.git.createWorktree(project.path, spec.environment.baseBranch);
      path = wt.path;
      branch = wt.branch;
    } else if (spec.environment.kind === "path") {
      path = spec.environment.path;
      branch = this.git.wts.get(path)?.branch ?? null;
    } else {
      const env = this.envs.get(spec.environment.environmentId);
      if (!env) throw new Error("HTTP 404: environment");
      path = env.path!;
      branch = env.branch;
    }
    this.envs.set(envId, { environmentId: envId, hostId: this.hostId, path, branch, status: "ready", projectId: spec.projectId });
    const t: SimThread = {
      id: this.id("thr"),
      projectId: spec.projectId,
      environmentId: envId,
      title: spec.title,
      status: "starting",
      archived: false,
      visibility: spec.visibility,
      meta: spec.meta,
      providerId: spec.model.providerId,
      model: spec.model.modelId,
      reasoning: spec.model.reasoning,
      ownerId: spec.lifecycleOwnerThreadId,
      parentThreadId: null,
      queue: [],
      turns: 0,
      tokens: 0,
      lastText: null,
      firstPrompt: spec.prompt,
      interactions: [],
      turnToken: 0,
      failures: 0,
      createdAt: this.now(),
    };
    this.threads.set(t.id, t);
    this.emit({ type: "thread.created", threadId: t.id });
    this.startTurn(t, spec.prompt, true, this.selfPluginId, "user", null);
    if (this.crashAfterSpawn > 0) {
      this.crashAfterSpawn--;
      throw new Error("simulated crash after spawn");
    }
    return { threadId: t.id, environmentId: envId };
  }

  async findThreadByKey(args: { key: string; runId: string }): Promise<ThreadRef | null> {
    this.calls.push({ method: "findThreadByKey", args });
    for (const t of this.threads.values()) if (!t.archived && t.meta?.key === args.key && t.meta.runId === args.runId) return { threadId: t.id, environmentId: t.environmentId };
    return null;
  }

  private startTurn(t: SimThread, text: string, first: boolean, origin: string | null, initiator: string, senderThreadId: string | null): void {
    t.status = "active";
    const token = ++t.turnToken;
    this.emit({ type: "message.dispatch", threadId: t.id, initiator, senderThreadId, originPluginId: origin, text });
    this.emit({ type: "thread.active", threadId: t.id });
    this.clock.setTimeout(() => void this.runTurn(t, text, first, token), this.turnMs(t.meta));
  }

  private async runTurn(t: SimThread, text: string, first: boolean, token: number): Promise<void> {
    if (t.turnToken !== token || t.archived || t.status !== "active") return;
    const env = this.envs.get(t.environmentId);
    let out: Awaited<ReturnType<AgentDriver>>;
    try {
      out = await this.driver({
        thread: t,
        text,
        first,
        tool: async (name, params) => {
          if (!this.toolCaller) throw new Error("no tool caller");
          this.emit({ type: "thread.activity", threadId: t.id });
          return this.toolCaller(name, t.id, params);
        },
        git: this.git,
        worktree: env?.path ?? null,
        sim: this,
      });
    } catch (e) {
      out = { fail: e instanceof Error ? e.message : String(e) };
    }
    if (t.turnToken !== token || t.archived) return; // stopped mid-turn
    if (out === "hang") return;
    if (typeof out === "object" && "ask" in out) {
      t.interactions.push(out.ask);
      this.emit({ type: "interaction.pending", threadId: t.id, interaction: out.ask });
      return; // waits for respondInteraction
    }
    if (typeof out === "object" && "fail" in out) {
      t.failures++;
      t.status = "error";
      this.emit({ type: "turn.failed", threadId: t.id, requestId: `req_${token}`, category: "overloaded", inputAccepted: true, attempt: 1 });
      this.emit({ type: "thread.failed", threadId: t.id, error: out.fail });
      return;
    }
    t.turns++;
    t.tokens += 4000 + text.length;
    t.lastText = out;
    this.finishTurn(t);
  }

  private finishTurn(t: SimThread): void {
    const next = t.queue.shift();
    if (next) {
      this.emit({ type: "message.dispatched", threadId: t.id, queuedMessageId: next.id, initiator: next.initiator, text: next.text, originPluginId: next.origin });
      this.startTurn(t, next.text, false, next.origin, next.initiator, next.senderThreadId);
      return;
    }
    t.status = "idle";
    this.emit({ type: "thread.idle", threadId: t.id, lastText: t.lastText });
  }

  async sendMessage(args: { threadId: string; text: string; mode: "steer" | "queue"; senderThreadId?: string | null }): Promise<SendResult> {
    this.maybeFail("sendMessage");
    const t = this.threads.get(args.threadId);
    if (!t || t.archived) throw new Error(`HTTP 404: thread ${args.threadId}`);
    return this.deliver(t, args.text, this.selfPluginId, "user", args.senderThreadId ?? null);
  }

  /** The human typing straight into a thread (V18). */
  async humanTypes(threadId: string, text: string): Promise<SendResult> {
    const t = this.threads.get(threadId)!;
    return this.deliver(t, text, null, "user", null);
  }

  private deliver(t: SimThread, text: string, origin: string | null, initiator: string, sender: string | null): SendResult {
    if (t.status === "active" || t.status === "starting" || t.interactions.some((i) => i)) {
      const id = this.id("qm");
      t.queue.push({ id, text, origin, initiator, senderThreadId: sender });
      this.emit({ type: "message.queued", threadId: t.id, queuedMessageId: id, initiator, text, originPluginId: origin });
      return { delivery: "queued", queuedMessageId: id };
    }
    this.startTurn(t, text, false, origin, initiator, sender);
    return { delivery: "sent", queuedMessageId: null };
  }

  async updateThread(args: { threadId: string; model?: string; reasoningLevel?: string | null; title?: string; visibility?: "hidden" | "visible" }): Promise<void> {
    this.maybeFail("updateThread");
    const t = this.threads.get(args.threadId);
    if (!t) throw new Error("HTTP 404");
    if (args.model && !this.catalogData.models.some((m) => m.providerId === t.providerId && m.id === args.model)) throw new Error(`HTTP 400: Model "${args.model}" is not available in this thread's ${t.providerId} model catalog; changing providers requires starting a new thread`);
    if (args.model) t.model = args.model;
    if (args.reasoningLevel !== undefined) t.reasoning = args.reasoningLevel;
    if (args.title) t.title = args.title;
    if (args.visibility) t.visibility = args.visibility;
  }

  async stopThread(threadId: string): Promise<void> {
    this.maybeFail("stopThread");
    const t = this.threads.get(threadId);
    if (!t) throw new Error("HTTP 404");
    if (t.status === "active" || t.status === "starting") {
      t.turnToken++;
      t.queue = [];
      t.status = "idle";
      this.emit({ type: "thread.idle", threadId, lastText: "(stopped)" });
    }
  }

  async archiveThread(threadId: string): Promise<string[]> {
    this.maybeFail("archiveThread");
    const root = this.threads.get(threadId);
    if (!root) throw new Error("HTTP 404");
    const out: string[] = [];
    const visit = (t: SimThread) => {
      for (const c of this.threads.values()) if (c.ownerId === t.id && !c.archived) visit(c);
      if (!t.archived) {
        t.archived = true;
        t.turnToken++;
        t.status = "idle";
        out.push(t.id);
        this.emit({ type: "thread.archived", threadId: t.id });
      }
    };
    visit(root);
    return out;
  }

  async retryThread(args: { threadId: string }): Promise<void> {
    this.maybeFail("retryThread");
    const t = this.threads.get(args.threadId);
    if (!t) throw new Error("HTTP 404");
    this.startTurn(t, "retry", false, this.selfPluginId, "system", null);
  }

  async compactThread(threadId: string): Promise<void> {
    const t = this.threads.get(threadId);
    if (t) t.tokens = Math.floor(t.tokens / 4);
  }

  async threadState(threadId: string): Promise<ThreadState | null> {
    const t = this.threads.get(threadId);
    if (!t) return null;
    const env = this.envs.get(t.environmentId);
    return { threadId, status: t.status, archived: t.archived, providerId: t.providerId, environmentId: t.environmentId, hostId: this.hostId, path: env?.path ?? null, branch: env?.branch ?? null, hasPendingInteraction: t.interactions.length > 0 };
  }

  async environment(environmentId: string): Promise<EnvInfo | null> {
    const e = this.envs.get(environmentId);
    return e ? { environmentId: e.environmentId, hostId: e.hostId, path: e.path, branch: e.branch, status: e.status } : null;
  }

  /** BB removes a managed worktree when its environment is deleted; refused while a thread on it is live. */
  async deleteEnvironment(environmentId: string): Promise<void> {
    const e = this.envs.get(environmentId);
    if (!e) return;
    const live = [...this.threads.values()].some((t) => t.environmentId === environmentId && !t.archived);
    if (live) throw new Error("HTTP 409: environment has live threads");
    this.envs.delete(environmentId);
    if (e.path?.includes("/.bb-worktrees/")) this.git.removeWorktree(e.path);
  }

  async threadContext(threadId: string): Promise<{ usedTokens: number; window: number; estimated: boolean } | null> {
    const t = this.threads.get(threadId);
    return t ? { usedTokens: Math.min(t.tokens, 200_000), window: 200_000, estimated: false } : null;
  }

  async threadOutput(threadId: string): Promise<string | null> {
    return this.threads.get(threadId)?.lastText ?? null;
  }

  async listInteractions(threadId: string): Promise<InteractionLite[]> {
    return this.threads.get(threadId)?.interactions ?? [];
  }

  async respondInteraction(args: { threadId: string; interactionId: string; answer: InteractionAnswer }): Promise<void> {
    this.maybeFail("respondInteraction");
    const t = this.threads.get(args.threadId);
    if (!t) throw new Error("HTTP 404");
    const i = t.interactions.findIndex((x) => x.id === args.interactionId);
    if (i < 0) throw new Error("HTTP 409: interaction already resolved");
    t.interactions.splice(i, 1);
    const answer = args.answer.kind === "allow" ? "approved" : args.answer.kind === "deny" ? "denied" : JSON.stringify(args.answer);
    this.startTurn(t, `interaction ${args.interactionId} → ${answer}`, false, null, "system", null);
  }

  async listPlugins(): Promise<PluginLite[]> {
    return [
      { id: "browser-automation", name: "Browser automation", description: "Persistent DevBrowser desktop and headless sessions", command: "bb browser-automation" },
      { id: "automations", name: "Automations", description: "Scheduled agent/script runs", command: "bb automation" },
    ];
  }

  async countActive(args: { providerId?: string } = {}): Promise<number> {
    void args;
    return [...this.threads.values()].filter((t) => t.status === "active" && !t.archived).length;
  }

  async listForeignThreads(args: { limit: number }): Promise<ForeignThread[]> {
    return [...this.threads.values()]
      .filter((t) => !t.meta)
      .slice(0, args.limit)
      .map((t) => ({ threadId: t.id, title: t.title, status: t.status, projectId: t.projectId, providerId: "claude-code", parentThreadId: t.parentThreadId, originPluginId: null, hidden: t.visibility === "hidden", updatedAt: t.createdAt }));
  }

  host(): HostOps {
    return this.git.hostOps();
  }

  // ───────── helpers for tests ─────────
  helmThreads(): SimThread[] {
    return [...this.threads.values()].filter((t) => t.meta);
  }
  threadOf(nodeId: string, runId?: string): SimThread | undefined {
    return [...this.threads.values()].find((t) => t.meta?.nodeId === nodeId && (!runId || t.meta.runId === runId));
  }
  /** A thread the human made themselves (for the Observatory). */
  addForeignThread(title: string): SimThread {
    const t: SimThread = { id: this.id("thr"), projectId: "proj_user", environmentId: "", title, status: "idle", archived: false, visibility: "visible", meta: null, providerId: "claude-code", model: "claude-sonnet-5-5", reasoning: null, ownerId: null, parentThreadId: null, queue: [], turns: 0, tokens: 0, lastText: null, interactions: [], turnToken: 0, failures: 0, createdAt: this.now() };
    this.threads.set(t.id, t);
    return t;
  }
}
