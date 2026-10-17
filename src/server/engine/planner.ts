// The planner (§7.7): when a brief is not in the structured shape, one short hidden
// thread reads it and calls helm_propose_plan once. Its only tool is that one; its
// authority is the planner record for its thread id. One turn, then it is archived.
// Never polled: completion arrives as the tool call or as BB's idle/failed event.

import { HelmError, type Engine } from "./engine.ts";
import type { HelmEvent } from "../bb/port.ts";
import type { ModelRef, Portfolio, SlotMap } from "../../shared/types.ts";
import { PortfolioSchema, normalizePortfolio, parseBrief } from "../domain/brief.ts";
import { planTopology } from "../domain/topology.ts";
import { validateRef } from "../domain/models.ts";
import { PLANNER_INSTRUCTIONS, plannerPrompt } from "../domain/briefs.ts";
import { expandHome } from "./context.ts";
import { GITIGNORE } from "../domain/checks.ts";
import { TEXT_MAX } from "../../shared/rpc-schemas.ts";

export const PLANNER_DIR = "_planner";

/** The first message of a "Plan with an agent" conversation. */
export function planChatPrompt(idea: string | null): string {
  const L = [
    "I opened Helm → New run → Plan with an agent. Load and follow the helm-planner skill: interview me briefly, check `bb helm doctor` and `bb helm models`, ask me which model to use for each role from the models available on this machine (recommend one per role and let me change it), ask where each app lives (an existing repository or a new folder), write the brief file, and run `bb helm plan`.",
    "When `bb helm plan` succeeds, tell me the run id; the New run screen will offer to open it. Never run `bb helm start` unless I say so.",
  ];
  if (idea) L.push("", "What I want to build:", "<idea>", idea.slice(0, TEXT_MAX), "</idea>");
  else L.push("", "Start by asking me what I want to build.");
  return L.join("\n");
}

export interface PlannerSession {
  id: string;
  status: "spawning" | "running" | "done" | "failed";
  threadId: string | null;
  model: ModelRef;
  portfolio: Portfolio | null;
  error: string | null;
  attempts: number;
  createdAt: number;
  endedAt: number | null;
}

/** D11: the planner defaults to the `code` slot's model at medium. */
export function defaultPlannerModel(slots: SlotMap): ModelRef | null {
  const code = slots.code ?? slots.lead ?? slots.orchestrator;
  return code ? { providerId: code.providerId, modelId: code.modelId, reasoning: "medium" } : null;
}

export class Planner {
  private unsub: (() => void) | null = null;
  private spawning = new Set<string>();
  private waiters = new Map<string, Set<(s: PlannerSession) => void>>();

  constructor(
    private e: Engine,
    private onChange: (s: PlannerSession) => void = () => {},
  ) {}

  install(): void {
    this.unsub = this.e.port.onEvent((ev) => this.onEvent(ev));
  }

  dispose(): void {
    this.unsub?.();
    this.unsub = null;
    for (const [id, set] of this.waiters) for (const w of set) w(this.get(id)!);
    this.waiters.clear();
  }

  get(id: string): PlannerSession | null {
    const raw = this.e.repo.getMeta(`planner:${id}`);
    return raw ? (JSON.parse(raw) as PlannerSession) : null;
  }

  byThread(threadId: string): PlannerSession | null {
    const id = this.e.repo.getMeta(`planner-thread:${threadId}`);
    return id ? this.get(id) : null;
  }

  /** Is this metadata a live planner spawn (the configure hint; authority is still checked per call)? */
  isPlannerSpawn(meta: { tier: string; nodeId: string } | null, threadId: string): boolean {
    if (!meta || meta.tier !== "planner") return false;
    const s = this.get(meta.nodeId);
    if (!s || (s.status !== "spawning" && s.status !== "running")) return false;
    return s.threadId === null ? s.status === "spawning" : s.threadId === threadId;
  }

  private save(s: PlannerSession): void {
    this.e.repo.setMeta(`planner:${s.id}`, JSON.stringify(s));
    if (s.threadId) this.e.repo.setMeta(`planner-thread:${s.threadId}`, s.id);
    this.onChange(s);
    if (s.status === "done" || s.status === "failed") for (const w of this.waiters.get(s.id) ?? []) w(s);
  }

  /** Resolve when the session finishes, or with its current state at the deadline (a deadline, not a poll). */
  wait(id: string, timeoutMs: number): Promise<PlannerSession | null> {
    const cur = this.get(id);
    if (!cur || cur.status === "done" || cur.status === "failed") return Promise.resolve(cur);
    return new Promise((resolve) => {
      const set = this.waiters.get(id) ?? new Set();
      this.waiters.set(id, set);
      let cancel = () => {};
      const finish = (s: PlannerSession | null) => {
        cancel();
        set.delete(finish);
        if (!set.size) this.waiters.delete(id);
        resolve(s);
      };
      set.add(finish);
      cancel = this.e.port.setTimeout(() => finish(this.get(id)), timeoutMs);
    });
  }

  /** Read a brief: structured briefs are parsed deterministically, anything else needs the planner. */
  static needsPlanner(brief: string): boolean {
    return !parseBrief(brief).structured;
  }

  /** The scratch project planner threads run in (no run repository is touched). */
  private async scratchProject(hostId: string): Promise<{ projectId: string; path: string }> {
    const home = await this.e.homeOf(hostId);
    const path = `${expandHome(this.e.settings.appsRoot, home ?? undefined)}/${PLANNER_DIR}`;
    await this.e.port.host(hostId).ensureRepo({ path, files: [{ path: ".gitignore", content: GITIGNORE }, { path: "README.md", content: "Helm planner scratch folder. The planner only reads the brief it is given; nothing here is part of a run.\n" }], message: "Helm: planner" });
    const projectId = (await this.e.port.findProjectByPath({ hostId, path }))?.projectId ?? (await this.e.port.createProject({ name: "Helm · planner", hostId, path })).projectId;
    return { projectId, path };
  }

  /**
   * "Plan with an agent" in the New run screen: a visible conversation that follows the
   * helm-planner skill (interview, live models per role, folders, brief, `bb helm plan`).
   * It has no Helm tools; the plan it makes is an ordinary draft run the human starts.
   */
  async startChat(input: { model: ModelRef; text?: string | null }): Promise<{ threadId: string }> {
    const hostId = await this.e.port.primaryHostId();
    if (!hostId) throw new HelmError("No host is connected.", "unavailable");
    const problem = validateRef(await this.e.catalog(hostId), input.model);
    if (problem) throw new HelmError(`Planner model: ${problem.message}`, "model_unavailable");
    const { projectId, path } = await this.scratchProject(hostId);
    const id = `pc_${this.e.oid().slice(2)}`;
    const idea = input.text?.trim();
    const ref = await this.e.port.spawnThread({
      projectId,
      environment: { kind: "path", hostId, path },
      title: "Helm · plan a build",
      prompt: planChatPrompt(idea ?? null),
      model: input.model,
      permissionMode: this.e.settings.permissionMode.orchestrator ?? "auto",
      visibility: "visible",
      lifecycleOwnerThreadId: null,
      meta: { v: 1, runId: "planchat", nodeId: id, tier: "planchat", role: "planchat", key: `planchat:${id}` },
    });
    this.e.repo.setMeta(`planchat-thread:${ref.threadId}`, id);
    return { threadId: ref.threadId };
  }

  async start(input: { brief: string; model: ModelRef }): Promise<PlannerSession> {
    const brief = input.brief.trim();
    if (!brief) throw new HelmError("The brief is empty.", "bad_input");
    const hostId = await this.e.port.primaryHostId();
    if (!hostId) throw new HelmError("No host is connected.", "unavailable");
    const problem = validateRef(await this.e.catalog(hostId), input.model);
    if (problem) throw new HelmError(`Planner model: ${problem.message}`, "model_unavailable");

    const s: PlannerSession = { id: `pl_${this.e.oid().slice(2)}`, status: "spawning", threadId: null, model: input.model, portfolio: null, error: null, attempts: 0, createdAt: this.e.now(), endedAt: null };
    this.save(s);
    this.spawning.add(s.id);
    try {
      const { projectId, path } = await this.scratchProject(hostId);
      const ref = await this.e.port.spawnThread({
        projectId,
        environment: { kind: "path", hostId, path },
        title: "Helm · planner",
        prompt: `${PLANNER_INSTRUCTIONS}\n\n${plannerPrompt(brief)}`,
        model: input.model,
        permissionMode: this.e.settings.permissionMode.orchestrator ?? "auto",
        visibility: "hidden",
        lifecycleOwnerThreadId: null,
        meta: { v: 1, runId: "planner", nodeId: s.id, tier: "planner", role: "planner", key: `planner:${s.id}` },
      });
      // a fast planner may already have proposed before we get here
      const now = this.get(s.id)!;
      const next: PlannerSession = { ...now, threadId: ref.threadId, status: now.status === "spawning" ? "running" : now.status };
      this.save(next);
      if (next.status === "done" || next.status === "failed") this.archiveSoon(next);
      return next;
    } catch (err) {
      const failed: PlannerSession = { ...this.get(s.id)!, status: "failed", error: err instanceof Error ? err.message.slice(0, 400) : String(err), endedAt: this.e.now() };
      this.save(failed);
      return failed;
    } finally {
      this.spawning.delete(s.id);
    }
  }

  /** The planner's helm_propose_plan. Returns null when the thread is not a planner (callTool then refuses). */
  async propose(threadId: string, portfolio: unknown): Promise<string | null> {
    let s = this.byThread(threadId);
    if (!s) {
      // the tool can arrive before spawnThread returned and Helm recorded the thread id
      return this.spawning.size ? "Helm is still registering this planner; call helm_propose_plan again with the same portfolio." : null;
    }
    if (s.status !== "running") return `This planner is ${s.status}; stop now.`;
    if (portfolio === undefined) return "Rejected: send the whole portfolio ({apps, groups, assumptions, questions}).";
    s = { ...s, attempts: s.attempts + 1 };
    const parsed = PortfolioSchema.safeParse(portfolio);
    if (!parsed.success) {
      this.save(s);
      return `Rejected — fix and call helm_propose_plan again: ${parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`;
    }
    const norm = normalizePortfolio(parsed.data);
    const plan = planTopology(norm.apps, this.e.settings.limits);
    if (!plan.ok) {
      this.save(s);
      return `Rejected — fix and call helm_propose_plan again: ${plan.error}`;
    }
    const done: PlannerSession = { ...s, status: "done", portfolio: norm, endedAt: this.e.now() };
    this.save(done);
    this.archiveSoon(done);
    return `Accepted: ${norm.apps.length} app${norm.apps.length === 1 ? "" : "s"} in ${norm.groups.length} group${norm.groups.length === 1 ? "" : "s"}. The human reviews it in the wizard. Stop now.`;
  }

  private onEvent(ev: HelmEvent): void {
    if (ev.type !== "thread.idle" && ev.type !== "thread.failed" && ev.type !== "thread.archived") return;
    const s = this.byThread(ev.threadId);
    if (!s || s.status !== "running") return;
    // one turn: ending it without an accepted proposal is a failure the human can retry
    const error = ev.type === "thread.failed" ? `the planner failed: ${ev.error ?? "unknown error"}` : ev.type === "thread.archived" ? "the planner was archived before it proposed" : "the planner finished without an accepted proposal";
    const failed: PlannerSession = { ...s, status: "failed", error, endedAt: this.e.now() };
    this.save(failed);
    if (ev.type !== "thread.archived") this.archiveSoon(failed);
  }

  /** Let the tool result reach the thread, then stop and archive it (Helm's own thread). */
  private archiveSoon(s: PlannerSession): void {
    const threadId = s.threadId;
    if (!threadId) return;
    this.e.port.setTimeout(() => {
      void (async () => {
        await this.e.port.stopThread(threadId).catch(() => {});
        await this.e.port.archiveThread(threadId).catch((err) => this.e.log.warn(`planner ${s.id}: archive failed: ${err instanceof Error ? err.message : String(err)}`));
      })();
    }, 3000);
  }
}
