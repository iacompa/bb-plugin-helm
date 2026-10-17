// The Helm engine (§9): plans and starts runs, admits work within capacity,
// spawns threads idempotently through the outbox, and owns every state change.
// Event handling, directives, gates and tools live in sibling modules that take
// the engine as their first argument; nothing here touches api.sdk directly.

import type { OutboxRow, Repo } from "../db/repo.ts";
import type { BbPort, EnvSpec, HelmEvent } from "../bb/port.ts";
import type { HostOps } from "../../shared/host-contract.ts";
import type {
  AppInfo,
  Catalog,
  HelmLimits,
  ModelRef,
  NeedInfo,
  NeedKind,
  NodeInfo,
  NodeStatus,
  Portfolio,
  RunInfo,
  SlotMap,
  Stage,
} from "../../shared/types.ts";
import { LIMIT_DEFAULTS } from "../../shared/types.ts";
import { OutboxWorker, type HandlerResult } from "./outbox.ts";
import { DEFAULT_SETTINGS, expandHome, newRunId, silentLogger, type HelmSettings, type Logger } from "./context.ts";
import { parseBrief } from "../domain/brief.ts";
import { ORCH_ID, planTopology, slugify, type TopologyPlan } from "../domain/topology.ts";
import { ROLES, roleLabel, scopeFor, tierOfRole } from "../domain/roles.ts";
import { forecast, normalizeModel, PROVIDER_LABEL, requiredSlots, resolveModel, validateRef, modelName, unsetSlots, familyWarnings } from "../domain/models.ts";
import { briefFor, initialPortfolioMd, managerNotesMd, type BriefContext } from "../domain/briefs.ts";
import { firstWave, wavesEstimate, admit, type Eligible, nextWave } from "../domain/scheduler.ts";
import { RUN_CHECK_SH, CHECKS_JSON_SKELETON, GITIGNORE } from "../domain/checks.ts";
import { stagePct } from "../domain/stages.ts";
import { treeFrom, type Tree } from "../domain/directives.ts";
import { expandTilde, isInside, samePath, targetPathProblem } from "../../shared/paths.ts";

export class HelmError extends Error {
  constructor(
    message: string,
    readonly code = "helm_error",
    readonly hint?: string,
  ) {
    super(message);
  }
}

export interface EngineDeps {
  repo: Repo;
  port: BbPort;
  settings?: () => HelmSettings;
  log?: Logger;
  publish?: (runId: string, event: string, payload: unknown) => void;
  rand?: () => number;
}

export interface CreateRunInput {
  name?: string;
  brief: string;
  portfolio?: Portfolio;
  slots: SlotMap;
  limits?: Partial<HelmLimits>;
  autoAdvance?: "ask" | "auto";
  appsRoot?: string;
  hostId?: string | null;
}

export interface PlanPreview {
  plan: TopologyPlan;
  portfolio: Portfolio;
  assumed: string[];
  forecast: ReturnType<typeof forecast>;
  waves: { inFlight: number; waves: number };
  required: string[];
  unset: string[];
  warnings: string[];
}

const STUDIO_DIR = "_studio";
const DEFER_SHORT = 3_000;
/** How long unread FYI lines wait for a free ride on a tool result before they are sent on their own. */
const FLUSH_MS = 120_000;

export class Engine {
  readonly repo: Repo;
  readonly port: BbPort;
  readonly log: Logger;
  readonly outbox: OutboxWorker;
  private settingsFn: () => HelmSettings;
  private publishFn: (runId: string, event: string, payload: unknown) => void;
  private rand: () => number;
  private catalogs = new Map<string, Catalog>();
  private homes = new Map<string, string | null>();
  private plans = new Map<string, TopologyPlan>();
  /** Threads Helm is archiving right now — their thread.archived events are expected. */
  readonly archiving = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  /** Event handler, installed by events.ts (kept late-bound to avoid an import cycle). */
  eventHandler: ((e: HelmEvent) => Promise<void>) | null = null;
  /** Hook for gate/stage follow-ups after an app changes stage (installed by gates.ts). */
  onStage: ((runId: string, appId: string, stage: Stage) => void) | null = null;

  constructor(deps: EngineDeps) {
    this.repo = deps.repo;
    this.port = deps.port;
    this.log = deps.log ?? silentLogger;
    this.settingsFn = deps.settings ?? (() => DEFAULT_SETTINGS);
    this.publishFn = deps.publish ?? (() => {});
    this.rand = deps.rand ?? Math.random;
    this.outbox = new OutboxWorker(
      this.repo,
      this.port,
      {
        project: (r) => this.handleProject(r),
        spawn: (r) => this.handleSpawn(r),
        send: (r) => this.handleSend(r),
        update: (r) => this.handleUpdate(r),
        stop: (r) => this.handleStop(r),
        archive: (r) => this.handleArchive(r),
        retry: (r) => this.handleRetry(r),
        compact: (r) => this.handleCompact(r),
        interaction: (r) => this.handleInteraction(r),
        file: (r) => this.handleFile(r),
      },
      {
        onFailed: (row, err) => this.onOutboxFailed(row, err),
        onDone: () => {},
        log: this.log,
        jitter: this.rand,
      },
    );
  }

  get settings(): HelmSettings {
    return this.settingsFn();
  }

  now(): number {
    return this.port.now();
  }

  emit(runId: string, event: string, payload: unknown): void {
    try {
      this.publishFn(runId, event, payload);
    } catch (e) {
      this.log.warn(`publish failed: ${String(e)}`);
    }
  }

  /** Start: recover the outbox, subscribe to events, reconcile live runs. */
  async init(reconcile: (runId: string) => Promise<unknown>): Promise<void> {
    const n = this.outbox.recover();
    if (n) this.log.info(`outbox: ${n} in-flight rows returned to pending after restart`);
    this.unsubscribe = this.port.onEvent(async (e) => {
      try {
        await this.eventHandler?.(e);
      } catch (err) {
        this.log.error(`event ${e.type} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      }
    });
    for (const run of this.repo.activeRuns()) await reconcile(run.id);
    this.outbox.kick();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.outbox.stop();
  }

  // ───────────────────────────── lookups ─────────────────────────────

  run(runId: string): RunInfo {
    const r = this.repo.getRun(runId);
    if (!r) throw new HelmError(`No run ${runId}.`, "not_found");
    return r;
  }

  plan(runId: string): TopologyPlan {
    let p = this.plans.get(runId);
    if (!p) {
      p = this.repo.runPlan(runId) as TopologyPlan;
      if (!p) throw new HelmError(`Run ${runId} has no plan.`, "not_found");
      this.plans.set(runId, p);
    }
    return p;
  }

  cachePlan(runId: string, plan: TopologyPlan): void {
    this.plans.set(runId, plan);
  }

  node(runId: string, id: string): NodeInfo {
    const n = this.repo.getNode(runId, id);
    if (!n) throw new HelmError(`No node ${id} in ${runId}.`, "not_found");
    return n;
  }

  tree(runId: string): Tree {
    return treeFrom(this.repo.listNodes(runId).map((n) => ({ id: n.id, parentId: n.parentId })));
  }

  managerName(runId: string, id: string): string {
    return this.plan(runId).managers.find((m) => m.id === id)?.name ?? id;
  }

  /** "Lumen · UI builder", "Wellness manager", "Orchestrator". */
  label(n: Pick<NodeInfo, "runId" | "id" | "role" | "platform" | "appId">): string {
    if (n.role === "orch") return "Orchestrator";
    if (n.role === "mgr") return `${this.managerName(n.runId, n.id)} manager`;
    const app = n.appId ? this.repo.getApp(n.runId, n.appId) : null;
    const rl = n.role === "lead" ? "App lead" : roleLabel(n.role, n.platform);
    return app ? `${app.name} · ${rl}` : rl;
  }

  /** The lead-equivalent node of an app: its lead, or the Orchestrator in a C1 run. */
  leadOf(runId: string, appId: string): NodeInfo | null {
    return this.repo.getNode(runId, `${appId}.lead`) ?? this.repo.listNodes(runId).find((n) => n.alsoLead) ?? null;
  }

  isLeadNode(n: NodeInfo): boolean {
    return n.tier === "lead" || n.alsoLead;
  }

  host(runId: string): HostOps {
    return this.port.host(this.repo.runHost(runId));
  }

  studioPath(run: RunInfo): string {
    return `${run.appsRoot}/${STUDIO_DIR}`;
  }

  /** Where an app's repository lives: the folder the human named, else <run folder>/<app>. */
  appPath(run: RunInfo, app: AppInfo, home: string | null): string {
    return app.targetPath ? expandTilde(app.targetPath, home) : `${run.appsRoot}/${app.id}`;
  }

  /** The branch Helm creates in an adopted repository; unique per run and app. */
  helmBranchFor(run: RunInfo, app: AppInfo): string {
    // the run id suffix keeps two runs with the same name from sharing a branch
    return `helm/${slugify(run.name).slice(0, 24).replace(/-+$/, "") || "run"}-${run.id.slice(-6).toLowerCase()}/${app.id}`;
  }

  /**
   * Checks every folder the human named (app folders, read-only folders, the run root)
   * on the run's host. `problems` block the start; `notes` say what Helm will do.
   */
  async locationReport(runId: string): Promise<{ problems: string[]; notes: string[] }> {
    const run = this.run(runId);
    const apps = this.repo.listApps(runId);
    const problems: string[] = [];
    const notes: string[] = [];
    const named = apps.filter((a) => a.targetPath || a.reads.length);
    const hostId = this.repo.runHost(runId) ?? (await this.port.primaryHostId());
    const home = await this.homeOf(hostId);
    if (run.appsRoot && !run.appsRoot.startsWith(this.settings.appsRoot)) {
      const p = targetPathProblem(run.appsRoot, home);
      if (p) problems.push(`Run folder: ${p}`);
    }
    if (!named.length) return { problems, notes };
    if (!hostId) return { problems: [...problems, "No host is connected, so the app folders cannot be checked."], notes };
    const host = this.port.host(hostId);
    const placed: Array<{ app: AppInfo; path: string }> = [];
    for (const app of apps.filter((a) => a.targetPath)) {
      const raw = app.targetPath!;
      const bad = targetPathProblem(raw, home);
      if (bad) {
        problems.push(`${app.name}: ${bad}`);
        continue;
      }
      const path = expandTilde(raw, home);
      const clash = placed.find((p) => isInside(path, p.path, home) || isInside(p.path, path, home));
      if (clash) {
        problems.push(`${app.name}: ${raw} overlaps ${clash.app.name}'s folder ${clash.app.targetPath}. Each app needs its own repository.`);
        continue;
      }
      if (run.appsRoot && isInside(path, `${run.appsRoot}/${STUDIO_DIR}`, home)) {
        problems.push(`${app.name}: ${raw} is inside Helm's studio folder for this run.`);
        continue;
      }
      placed.push({ app, path });
      const info = await host.inspectPath({ path }).catch((err: unknown) => {
        problems.push(`${app.name}: could not check ${raw} (${err instanceof Error ? err.message : String(err)}).`);
        return null;
      });
      if (!info) continue;
      if (info.exists && !info.isDir) problems.push(`${app.name}: ${raw} is a file, not a folder.`);
      else if (info.gitRoot && !samePath(info.gitRoot, info.path, home))
        problems.push(`${app.name}: ${raw} is inside the repository ${info.gitRoot}. Point the app at the repository's top folder (one app per repository) and describe the part to work on in the brief.`);
      else if (info.gitRoot && !info.head) problems.push(`${app.name}: the repository at ${raw} has no commits yet. Commit something first, or name an empty folder.`);
      else if (info.gitRoot)
        notes.push(
          `${app.name}: existing repository ${raw}${info.branch ? ` (on ${info.branch})` : ""}. When its wave is admitted Helm makes the branch ${this.helmBranchFor(run, app)} at your last commit; agents work in their own worktrees and never change your checkout or your branches.${info.dirty ? ` ${info.dirty} uncommitted change${info.dirty === 1 ? " is" : "s are"} NOT visible to agents: commit first if they should build on ${info.dirty === 1 ? "it" : "them"}.` : ""}`,
        );
      else if (info.exists && !info.empty)
        problems.push(`${app.name}: ${raw} has files but is not a git repository. Run git init and commit there yourself (check what gets committed first), or name an empty or new folder.`);
      else if (info.enclosingRepo) problems.push(`${app.name}: ${raw} would be a new repository inside the repository ${info.enclosingRepo}. Point the app at that repository's top folder, or choose a folder outside it.`);
      else if (!info.writable) problems.push(`${app.name}: ${raw} cannot be created or written on this host (permissions, or the disk is not mounted).`);
      else notes.push(`${app.name}: new repository at ${raw}.`);
    }
    for (const app of apps)
      for (const r of app.reads) {
        if (expandTilde(r, home).startsWith("~") || !(expandTilde(r, home).startsWith("/") || /^[A-Za-z]:[\\/]/.test(r))) {
          problems.push(`${app.name}: read-only folder "${r}" is not an absolute path.`);
          continue;
        }
        const info = await host.inspectPath({ path: expandTilde(r, home) }).catch(() => null);
        if (!info?.exists) problems.push(`${app.name}: read-only folder ${r} does not exist on this host (is the disk mounted?).`);
      }
    const readers = apps.filter((a) => a.reads.length);
    if (readers.length) notes.push(`Read-only folders: ${readers.map((a) => `${a.name} reads ${a.reads.join(", ")}`).join("; ")}. Agents are told to read them and never change them (an instruction, not a lock).`);
    // another live run already working in the same folders: say so, so the human can end the old one
    for (const other of this.repo.listRuns().filter((r) => r.id !== runId && (r.status === "running" || r.status === "paused"))) {
      const theirs = this.repo.listApps(other.id).filter((a) => a.targetPath).map((a) => expandTilde(a.targetPath!, home));
      const shared = placed.filter((p) => theirs.some((t) => samePath(t, p.path, home))).map((p) => p.app.name);
      if (shared.length) notes.push(`The run "${other.name}" (${other.id}, ${other.status}) also works on ${shared.join(", ")}. If this plan replaces it, end it first: bb helm end --run ${other.id} --yes`);
    }
    return { problems, notes };
  }

  /** Helm's evidence wrapper outside any repository, for adopted apps (no files are added to the human's repository). */
  wrapperPath(run: RunInfo): string {
    return `${this.studioPath(run)}/bin/run-check.sh`;
  }

  /** The checks an adopted app declared with helm_existing_docs, for gate briefs. */
  declaredChecksText(runId: string, appId: string): string {
    const raw = this.repo.getMeta(`existing:${runId}:${appId}`);
    const checks = raw ? ((JSON.parse(raw) as { checks?: Record<string, { command: string }> | null }).checks ?? null) : null;
    if (!checks || !Object.keys(checks).length) return "in `.helm/checks.json` on the judged commit";
    return Object.entries(checks)
      .slice(0, 12)
      .map(([k, v]) => `\`${k}\`: \`${v.command.slice(0, 200)}\``)
      .join("; ");
  }

  briefPath(run: RunInfo, nodeId: string): string {
    return `${this.studioPath(run)}/briefs/${nodeId}.md`;
  }

  async catalog(hostId: string | null, refresh = false): Promise<Catalog> {
    const key = hostId ?? "_";
    const cached = this.catalogs.get(key);
    if (cached && !refresh && this.now() - cached.fetchedAt < 10 * 60_000) return cached;
    const raw = await this.port.catalog({ hostId });
    const seen = this.repo.acknowledgedModels();
    const hidden = this.repo.hiddenModels();
    const weights = this.settings.weights;
    const cat: Catalog = {
      hostId,
      fetchedAt: this.now(),
      providers: raw.providers.map((p) => ({ id: p.id, label: p.label || PROVIDER_LABEL[p.id] || p.id, available: p.available, error: raw.error?.providerId === p.id ? `${raw.error.code}${raw.error.detail ? `: ${raw.error.detail}` : ""}` : null })),
      models: [],
    };
    for (const m of raw.models) {
      const label = cat.providers.find((p) => p.id === m.providerId)?.label ?? m.providerId;
      const cm = normalizeModel(m.providerId, label, { id: m.id, model: m.id, displayName: m.displayName, description: m.description, isDefault: m.isDefault, defaultReasoningEffort: m.defaultReasoning, supportedReasoningEfforts: m.reasoning.map((r) => ({ reasoningEffort: r })), supportedServiceTiers: m.serviceTiers.map((id) => ({ id })) }, { seen, weights, hiddenIds: hidden });
      if (cm) cat.models.push(cm);
    }
    this.catalogs.set(key, cat);
    return cat;
  }

  /** Mark every catalog model as seen (wizard open), keeping NEW flags for this response. */
  markSeen(cat: Catalog): void {
    this.repo.tx(() => {
      for (const m of cat.models) this.repo.touchSeen(m.providerId, m.modelId, false);
    });
  }

  async homeOf(hostId: string | null): Promise<string | null> {
    const key = hostId ?? "_";
    if (this.homes.has(key)) return this.homes.get(key)!;
    try {
      const p = await this.port.host(hostId).probe({});
      this.homes.set(key, p.home);
      return p.home;
    } catch {
      return null;
    }
  }

  // ───────────────────────────── planning ─────────────────────────────

  preview(input: { brief?: string; portfolio?: Portfolio; slots?: SlotMap; limits?: Partial<HelmLimits> }, catalog: Catalog | null = null): PlanPreview {
    const parsed = input.portfolio ? { portfolio: input.portfolio, assumed: [] as string[] } : parseBrief(input.brief ?? "");
    const limits = { ...LIMIT_DEFAULTS, ...this.settings.limits, ...(input.limits ?? {}) };
    const plan = planTopology(parsed.portfolio.apps, limits);
    const slots = input.slots ?? {};
    const fc = forecast(plan.nodes.map((n) => ({ role: n.role, slot: n.slot })), slots, this.settings.weights);
    return {
      plan,
      portfolio: parsed.portfolio,
      assumed: (parsed as { assumed?: string[] }).assumed ?? [],
      forecast: fc,
      waves: wavesEstimate(plan.apps.length, limits.concurrency),
      required: requiredSlots(plan.counts.bySlot),
      unset: unsetSlots(slots, plan.counts.bySlot),
      warnings: [...plan.warnings, ...familyWarnings(catalog, slots)],
    };
  }

  createRun(input: CreateRunInput): { runId: string; plan: TopologyPlan } {
    const pre = this.preview({ brief: input.brief, portfolio: input.portfolio, slots: input.slots, limits: input.limits });
    if (!pre.plan.ok) throw new HelmError(pre.plan.error ?? "The plan is not valid.", "invalid_plan");
    const limits = { ...LIMIT_DEFAULTS, ...this.settings.limits, ...(input.limits ?? {}) };
    const runId = newRunId(this.now(), this.rand);
    const name = (input.name?.trim() || pre.portfolio.groups[0] || `${pre.plan.apps.length} app${pre.plan.apps.length === 1 ? "" : "s"}`).slice(0, 80);
    const slugBase = slugify(input.name?.trim() || "run");
    const appsRoot = `${input.appsRoot?.trim() || this.settings.appsRoot}/${slugBase}-${runId.slice(-6)}`;
    const plan = pre.plan;
    this.repo.tx(() => {
      this.repo.insertRun({
        id: runId,
        name: input.name?.trim() || name,
        brief: input.brief,
        planJson: plan,
        settingsJson: { portfolio: pre.portfolio, permissionMode: this.settings.permissionMode, showLeadsInSidebar: this.settings.showLeadsInSidebar },
        slots: input.slots,
        limits,
        dryRun: false,
        autoAdvance: input.autoAdvance ?? this.settings.autoAdvance,
        appsRoot,
        hostId: input.hostId ?? null,
      });
      for (const a of plan.apps)
        this.repo.insertApp({ runId, id: a.id, name: a.name, tagline: a.tagline, platforms: a.platforms, platformsAssumed: a.platformsAssumed, shape: a.shape, managerNodeId: a.managerId, order: a.order, test: a.test, priority: a.priority, notes: a.notes, targetPath: a.path, reads: a.reads });
      for (const n of plan.nodes)
        this.repo.insertNode({
          runId,
          id: n.id,
          appId: n.appId,
          tier: n.tier,
          role: n.role,
          platform: n.platform,
          parentId: n.parentId,
          slot: n.slot,
          alsoLead: n.alsoLead,
          model: null,
          scopeGlobs: scopeFor(n.role, n.platform),
          branch: null,
          briefMd: null,
        });
    });
    this.plans.set(runId, plan);
    return { runId, plan };
  }

  /** Effective model for a node right now: node override > app override > run slots (§7.5). */
  effectiveModel(run: RunInfo, n: NodeInfo): ModelRef | null {
    const app = n.appId ? this.repo.getApp(run.id, n.appId) : null;
    return resolveModel({ nodeOverride: n.modelOverride ? n.model : null, appOverride: app?.slotOverrides?.[n.slot] ?? null, runSlot: run.slots[n.slot] ?? null });
  }

  /** §9.9 — what "Approve and start" does, in order. */
  async startRun(runId: string, opts: { dryRun?: boolean; catalog?: Catalog } = {}): Promise<{ ok: boolean; problems: string[]; dryRun: boolean; studioPath: string | null }> {
    const run = this.run(runId);
    if (run.status !== "planning") throw new HelmError(`Run ${runId} is ${run.status}; only a planned run can start.`, "bad_state");
    const plan = this.plan(runId);
    // 1. re-validate the plan and every slot against the live catalog
    const problems: string[] = [];
    const replan = planTopology(
      this.repo.listApps(runId).map((a) => ({ name: a.name, tagline: a.tagline, platforms: a.platforms, shape: a.shape, test: a.test, priority: a.priority })),
      run.limits,
    );
    if (!replan.ok) problems.push(replan.error ?? "plan invalid");
    const cat = opts.catalog ?? (await this.catalog(this.repo.runHost(runId), true));
    const missing = unsetSlots(run.slots, plan.counts.bySlot);
    if (missing.length) problems.push(`${missing.length} slot${missing.length === 1 ? "" : "s"} still need${missing.length === 1 ? "s" : ""} a model: ${missing.join(", ")}.`);
    for (const s of requiredSlots(plan.counts.bySlot)) {
      const r = run.slots[s];
      if (!r) continue;
      const p = validateRef(cat, r);
      if (p) problems.push(`${s}: ${p.message}`);
    }
    problems.push(...(await this.locationReport(runId)).problems);
    if (problems.length) return { ok: false, problems, dryRun: !!opts.dryRun, studioPath: null };

    // 2. freeze; create the Studio folder (git init) with PORTFOLIO.md and brief drafts
    const hostId = this.repo.runHost(runId) ?? (await this.port.primaryHostId());
    const home = await this.homeOf(hostId);
    const appsRoot = expandHome(run.appsRoot ?? `${this.settings.appsRoot}/run`, home ?? undefined);
    const nodes = this.repo.listNodes(runId);
    this.repo.tx(() => {
      this.repo.updateRun(runId, { appsRoot });
      if (hostId && !this.repo.runHost(runId)) this.repo.db.prepare("UPDATE runs SET host_id = ? WHERE id = ?").run(hostId, runId);
      for (const n of nodes) {
        const m = this.effectiveModel(run, n);
        this.repo.updateNode(runId, n.id, { model: m, providerId: m?.providerId ?? null });
      }
    });
    const fresh = this.run(runId);
    const studio = this.studioPath(fresh);
    const w = wavesEstimate(plan.apps.length, fresh.concurrency);
    const files: Array<{ path: string; content: string; executable?: boolean }> = [
      { path: "PORTFOLIO.md", content: initialPortfolioMd(fresh.name, fresh.brief, `${plan.apps.length} apps · about ${w.inFlight} in flight at a time · ${w.waves} waves (estimate).`) },
      { path: ".gitignore", content: GITIGNORE },
      // the evidence wrapper for apps in existing repositories, which get no Helm files
      { path: "bin/run-check.sh", content: RUN_CHECK_SH, executable: true },
    ];
    for (const m of plan.managers) files.push({ path: `MANAGER-NOTES-${m.id}.md`, content: managerNotesMd(m.name, m.appIds.map((id) => plan.apps.find((a) => a.id === id)?.name ?? id)) });
    for (const n of this.repo.listNodes(runId)) files.push({ path: `briefs/${n.id}.md`, content: this.buildBrief(fresh, n) });
    await this.port.host(hostId).ensureRepo({ path: studio, files, message: "Helm: plan and brief drafts" });

    // 3. dry run stops here
    if (opts.dryRun) {
      this.repo.db.prepare("UPDATE runs SET dry_run = 1 WHERE id = ?").run(runId);
      this.emit(runId, "run.updated", { id: runId, dryRun: true });
      return { ok: true, problems: [], dryRun: true, studioPath: studio };
    }

    // 4–5. Orchestrator, managers, then wave 1 — all through the outbox
    const c1 = plan.rule === "C1";
    this.repo.tx(() => {
      this.repo.updateRun(runId, { status: "running", startedAt: this.now() });
      this.repo.db.prepare("UPDATE runs SET dry_run = 0 WHERE id = ?").run(runId);
      // standing run-level policies
      for (const text of this.settings.runPolicies) {
        const seq = this.repo.nextSeq(runId, "policy");
        this.repo.insertPolicy({ id: `P-${seq}`, runId, text, scopeNodeId: ORCH_ID, fromDirective: null, createdAt: this.now(), retiredAt: null });
      }
      this.repo.enqueue({ id: this.oid(), runId, kind: "project", nodeId: ORCH_ID, payload: { studio: true }, idemKey: `project:${runId}:studio` });
      this.repo.updateNode(runId, ORCH_ID, { status: "queued", firstInLine: true });
      for (const m of plan.managers) this.repo.updateNode(runId, m.id, { status: "queued", firstInLine: true });
      const apps = this.repo.listApps(runId);
      const wave = c1 ? apps : firstWave(apps.map((a) => ({ id: a.id, stage: a.stage, priority: a.priority, order: a.order, managerId: a.managerNodeId })), fresh.concurrency);
      for (const a of wave) this.admitAppTx(runId, a.id, "wave 1 (approved with the plan)");
    });
    this.emit(runId, "run.started", { id: runId });
    await this.pump(runId);
    return { ok: true, problems: [], dryRun: false, studioPath: studio };
  }

  /** Admit one app: Intake → Spec, its repo is created and its lead queued (inside a transaction). */
  admitAppTx(runId: string, appId: string, why: string): void {
    const app = this.repo.getApp(runId, appId);
    if (!app || app.stage !== "intake") return;
    const lead = this.leadOf(runId, appId);
    this.repo.updateApp(runId, appId, { stage: "spec", pct: stagePct("spec") });
    this.repo.enterStage(runId, appId, "spec", { why });
    this.repo.enqueue({ id: this.oid(), runId, kind: "project", nodeId: lead?.id ?? null, payload: { appId }, idemKey: `project:${runId}:${appId}` });
    if (lead && lead.id !== ORCH_ID && lead.status === "planned") this.repo.updateNode(runId, lead.id, { status: "queued" });
    if (lead) this.repo.event(runId, lead.id, "admitted", `${app.name} admitted: ${why}`);
    this.emit(runId, "stage.changed", { appId, stage: "spec" });
  }

  /** §4.2 — when capacity frees and Intake apps wait: propose (ask) or admit (auto). */
  proposeNextWave(runId: string): void {
    const run = this.run(runId);
    if (run.status !== "running" || run.spawnsPaused) return;
    const apps = this.repo.listApps(runId);
    const wave = nextWave(apps.map((a) => ({ id: a.id, stage: a.stage, priority: a.priority, order: a.order, managerId: a.managerNodeId })), run.concurrency, run.spawnsPaused, { batch: run.autoAdvance !== "auto" });
    if (!wave.length) return;
    // one open wave card at a time: a bigger proposal replaces a smaller one, otherwise keep the card the human sees
    const open = this.repo.listNeeds(runId, "open").filter((n) => n.kind === "plan" && Array.isArray((n.data as { appIds?: unknown })?.appIds));
    if (open.some((n) => ((n.data as { appIds: string[] }).appIds.length >= wave.length))) return;
    for (const n of open) {
      this.repo.resolveNeed(runId, n.id, { action: "superseded" });
      this.emit(runId, "need.resolved", { id: n.id, action: "superseded" });
    }
    if (run.autoAdvance === "auto") {
      this.repo.tx(() => {
        for (const a of wave) this.admitAppTx(runId, a.id, "auto-advance");
      });
      void this.pump(runId);
      return;
    }
    const names = wave.map((a) => apps.find((x) => x.id === a.id)?.name ?? a.id);
    const agents = wave.reduce((s, a) => s + this.repo.listNodes(runId).filter((n) => n.appId === a.id).length, 0);
    this.raiseNeed(runId, {
      kind: "plan",
      nodeId: ORCH_ID,
      appId: null,
      title: `Start the next wave: ${names.join(", ")}`,
      body: `Capacity has freed up. Admitting ${names.length} app${names.length === 1 ? "" : "s"} adds up to ${agents} agents (spawned lazily).`,
      evidence: "",
      options: ["Approve wave", "Not yet"],
      dedupeKey: `wave:${wave.map((a) => a.id).join(",")}`,
      data: { appIds: wave.map((a) => a.id) },
    });
  }

  // ───────────────────────────── scheduler ─────────────────────────────

  private pumping = false;
  private pumpAgain = false;

  /** Admit queued nodes within capacity (§4.1–4.3). Called after every state change that can free a slot. */
  async pump(runId?: string): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        const runs = runId ? [this.run(runId)] : this.repo.activeRuns();
        for (const run of runs) this.pumpRun(run);
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
    this.outbox.kick();
  }

  private pumpRun(run: RunInfo): void {
    if (run.status !== "running") return;
    const spawning = (runId: string, nodeId: string) => this.repo.pendingForNode(nodeId, runId).some((o) => o.kind === "spawn");
    // a parent is "on its way" when it has a thread or a spawn queued; until then its children wait
    // for it and must not take a slot, or they can hold every slot while the parent waits for one
    const parentReady = (runId: string, parentId: string | null) => {
      if (!parentId) return true;
      const p = this.repo.getNode(runId, parentId);
      return !p || !!p.threadId || spawning(runId, p.id);
    };
    const queued = this.repo
      .nodesByStatus(run.id, ["queued"])
      .filter((n) => !n.threadId && !spawning(run.id, n.id) && parentReady(run.id, n.parentId));
    if (!queued.length) return;
    // spawns already queued count against concurrency, except ones blocked on a parent that is not on its way (they hold no thread)
    const pendingRows = this.repo.db.prepare("SELECT run_id AS r, node_id AS n FROM outbox WHERE kind = 'spawn' AND state IN ('pending','inflight')").all() as Array<{ r: string; n: string }>;
    const pendingSpawns = { c: pendingRows.filter((o) => parentReady(o.r, this.repo.getNode(o.r, o.n)?.parentId ?? null)).length };
    const apps = new Map(this.repo.listApps(run.id).map((a) => [a.id, a]));
    const eligible: Eligible[] = queued.map((n) => {
      const app = n.appId ? apps.get(n.appId) : undefined;
      const flags = this.repo.nodeFlags(run.id, n.id);
      return {
        nodeId: n.id,
        tier: n.tier,
        appPriority: (n.priority === "high" ? "high" : app?.priority) ?? "normal",
        appStage: app?.stage ?? null,
        managerId: app?.managerNodeId ?? null,
        createdAt: n.createdAt,
        firstInLine: flags.firstInLine,
        providerId: n.model?.providerId ?? null,
      };
    });
    const res = admit(
      eligible,
      {
        concurrency: run.limits.concurrency,
        running: this.repo.countRunning() + Number(pendingSpawns.c),
        maxTotalAgents: run.limits.maxTotalAgents,
        nonPlanned: this.repo.countAllNonPlanned(),
        providerCaps: run.limits.providerCaps,
        runningByProvider: this.repo.runningByProvider(),
        spawnsPaused: run.spawnsPaused,
      },
      { alreadyCounted: new Set(queued.map((n) => n.id)) },
    );
    if (!res.start.length) return;
    this.repo.tx(() => {
      for (const id of res.start) {
        const gen = (this.repo.db.prepare("SELECT COUNT(*) AS c FROM outbox WHERE run_id = ? AND node_id = ? AND kind = 'spawn'").get(run.id, id) as { c: number }).c + 1;
        const handover = gen > 1 ? this.handoverFor(run.id, id) : null;
        this.repo.enqueue({ id: this.oid(), runId: run.id, kind: "spawn", nodeId: id, payload: { nodeId: id, gen, ...(handover ? { handover } : {}) }, idemKey: `spawn:${run.id}:${id}:${gen}` });
        this.repo.updateNode(run.id, id, { warning: null });
      }
    });
    // children of the supervisors just queued may start now, if capacity allows
    this.pumpAgain = true;
  }

  /** What a replacement thread needs from its predecessor, from Helm's own records (never a transcript). */
  handoverFor(runId: string, nodeId: string): string | null {
    const reps = this.repo.reportsFor(runId, nodeId, 8);
    if (!reps.length) return null;
    const lines = ["Helm's record of the previous thread in this role (newest first):"];
    for (const r of reps.slice(0, 5)) {
      const ev = r.evidence.map((x) => `${x.kind} ${x.ref.slice(0, 12)}`).join(", ");
      lines.push(`- ${r.status}${r.verified ? "" : " (unverified)"}: ${r.summary.slice(0, 220)}${ev ? ` [${ev}]` : ""}`);
    }
    lines.push("Verified commits above are on the integration branch or your predecessor's branch: check with git before redoing work.");
    return lines.join("\n");
  }

  // ───────────────────────────── briefs ─────────────────────────────

  buildBrief(run: RunInfo, n: NodeInfo, extra: { integrationCommit?: string | null; scannerFindings?: string | null; handover?: string | null } = {}): string {
    const nodes = this.repo.listNodes(run.id);
    const byId = new Map(nodes.map((x) => [x.id, x]));
    const parent = n.parentId ? byId.get(n.parentId) : null;
    const app = n.appId ? this.repo.getApp(run.id, n.appId) : null;
    const lead = n.appId ? this.leadOf(run.id, n.appId) : null;
    const peers = nodes.filter((x) => x.parentId === n.parentId && x.id !== n.id && x.parentId !== null && (n.tier === "manager" || n.tier === "lead" ? true : x.appId === n.appId)).map((x) => this.label(x));
    const children = nodes.filter((x) => x.parentId === n.id).map((x) => this.label(x));
    const policies = this.policiesFor(run.id, n.id);
    const changes = this.repo.directivesBeforeSpawn(run.id, n.id).map((d) => ({ id: d.id, text: d.recipients.find((r) => r.nodeId === n.id)?.notice ?? d.summary }));
    const appExtra = app ? this.repo.appExtra(run.id, app.id) : null;
    const lines: string[] = [];
    const studio = this.studioPath(run);
    if (n.role === "orch") {
      lines.push(`## Your memory\nRead \`${studio}/PORTFOLIO.md\` first, every time you start or after a compaction. Helm rewrites the block between the helm:world markers; keep strategy and decisions below it. \`helm_world\` is always current — prefer it to asking anyone.`);
      if (run.autoAdvance === "ask") lines.push("## Waves\nWhen apps wait in Intake and capacity frees up, Helm asks the human to approve the next wave. Use `helm_propose_wave` if you want to suggest a different set.");
    }
    if (n.role === "mgr") lines.push(`## Your notes\nKeep \`${studio}/MANAGER-NOTES-${n.id}.md\` current: apps and status, cross-app dependencies, risks, asks of the Orchestrator.`);
    const wrapper = app?.adopted ? `"${this.wrapperPath(run)}"` : ".helm/run-check.sh";
    if (this.isLeadNode(n) && app?.adopted)
      lines.push(
        `## Your squad\nShape: ${app.shape}. Planned squad: ${nodes.filter((x) => x.appId === app.id && x.tier === "specialist").map((x) => roleLabel(x.role, x.platform)).join(", ") || "none (solo — you build it yourself)"}. Gates: Reviewer, Slop Hunter (Helm spawns them when you reach Review).\nYour own worktree branch is the app's **integration branch**. This is an existing repository: Helm added no files and no commits to it. For the spec stage, reuse the repository's own documents: call \`helm_existing_docs\` with the committed files that serve as the spec, architecture, contract and acceptance documents, and its real check commands. Create SPEC.md / ARCHITECTURE.md / CONTRACT.md / ACCEPTANCE.md only for what has no existing equivalent, and only if the brief allows it; otherwise report \`blocked\` with what is missing. Then \`helm_publish_contract\`, \`helm_stage\` to build and \`helm_spawn_squad\`.\nRun each check through ${wrapper} <name> -- <command…> (Helm's wrapper lives outside the repository) and record it with \`helm_record_check\`.`,
      );
    else if (this.isLeadNode(n) && app)
      lines.push(
        `## Your squad\nShape: ${app.shape}. Planned squad: ${nodes.filter((x) => x.appId === app.id && x.tier === "specialist").map((x) => roleLabel(x.role, x.platform)).join(", ") || "none (solo — you build it yourself)"}. Gates: Reviewer, Slop Hunter (Helm spawns them when you reach Review).\nYour own worktree branch is the app's **integration branch**. Commit SPEC.md, ARCHITECTURE.md, CONTRACT.md and ACCEPTANCE.md there, then \`helm_publish_contract\`, \`helm_stage\` to build and \`helm_spawn_squad\`.\nChecks are declared in \`.helm/checks.json\`; run each through \`.helm/run-check.sh <name> -- <command…>\` and record it with \`helm_record_check\`.`,
      );
    if (n.tier === "specialist") lines.push(`## Your branch\nYou work in your own worktree branched off the app's integration branch. Commit there; your lead merges it. Report done with the commit sha as evidence.${app?.adopted ? ` Run checks through ${wrapper} <name> -- <command…>.` : ""}`);
    if (n.tier === "gate")
      lines.push(
        `## Gate protocol\nBefore judging, run \`git fetch . 2>/dev/null; git checkout --detach <commit>\` for the commit Helm names, so your HEAD is exactly that commit. You are read-only on source: write only under \`reports/**\`. Re-run every declared check through the wrapper (${wrapper} <name> -- <command…>)${app?.adopted ? `; the checks are ${this.declaredChecksText(run.id, app.id)}` : " — they are in `.helm/checks.json`"}, then answer with exactly one \`helm_verdict\` call.`,
      );
    const edits = this.repo.nodeBrief(run.id, n.id);
    if (edits) lines.push(`## Brief edits by the human (binding)\n${edits}`);
    lines.push(`## Your brief file\n\`${this.briefPath(run, n.id)}\` — re-read it when told your brief changed.`);
    const ctx: BriefContext = {
      runName: run.name,
      appName: app?.name ?? null,
      tagline: app?.tagline ?? null,
      parentLabel: parent ? this.label(parent) : "the human",
      leadLabel: lead && lead.id !== n.id && n.tier !== "lead" && n.role !== "orch" ? this.label(lead) : null,
      peers: peers.slice(0, 12),
      children: children.slice(0, 12),
      contractVersion: appExtra?.contractVersion ?? 0,
      policies,
      changesBeforeStart: changes,
      branch: null,
      baseBranch: n.tier === "specialist" || n.tier === "gate" ? appExtra?.integrationBranch ?? null : null,
      repoPath: app?.repoPath ?? null,
      location: app && (app.adopted || app.reads.length) ? { adopted: app.adopted, userBranch: app.userBranch, helmBranch: app.helmBranch, reads: app.reads } : null,
      extra: lines,
      integrationCommit: extra.integrationCommit ?? null,
      scannerFindings: extra.scannerFindings ?? null,
      handover: extra.handover ?? null,
    };
    const nb = this.repo.getNode(run.id, n.id)!;
    return briefFor({ id: nb.id, role: nb.role, platform: nb.platform, briefVersion: nb.briefVersion, scopeGlobs: nb.scopeGlobs, alsoLead: nb.alsoLead }, ctx);
  }

  /** Policies whose scope node is this node or one of its ancestors. */
  policiesFor(runId: string, nodeId: string): Array<{ id: string; text: string }> {
    const tree = this.tree(runId);
    const chain = new Set([nodeId]);
    let p = tree.parentOf(nodeId);
    while (p) {
      chain.add(p);
      p = tree.parentOf(p);
    }
    return this.repo
      .listPolicies(runId)
      .filter((x) => chain.has(x.scopeNodeId))
      .slice(-20)
      .map((x) => ({ id: x.id, text: x.text }));
  }

  // ───────────────────────────── needs ─────────────────────────────

  raiseNeed(runId: string, x: { kind: NeedKind; nodeId: string | null; appId: string | null; title: string; body: string; evidence: string; options: string[]; interactionId?: string | null; dedupeKey?: string | null; data?: unknown; setNodeNeeds?: boolean }): NeedInfo | null {
    const id = `N-${this.repo.nextSeq(runId, "need")}`;
    const need: NeedInfo = {
      id,
      runId,
      kind: x.kind,
      nodeId: x.nodeId,
      appId: x.appId,
      title: x.title.slice(0, 200),
      body: x.body.slice(0, 1200),
      evidence: x.evidence.slice(0, 1200),
      options: x.options,
      interactionId: x.interactionId ?? null,
      state: "open",
      createdAt: this.now(),
      resolvedAt: null,
      resolution: null,
      data: x.data ?? null,
    };
    const inserted = this.repo.insertNeed({ ...need, dedupeKey: x.dedupeKey ?? null });
    if (!inserted) return null;
    if (x.nodeId && x.setNodeNeeds) {
      const n = this.repo.getNode(runId, x.nodeId);
      if (n && n.status !== "needs") this.repo.updateNode(runId, n.id, { status: "needs", prevStatus: n.status });
    }
    if (x.nodeId) this.repo.event(runId, x.nodeId, "need", `${x.kind}: ${x.title}`, id);
    this.emit(runId, "need.created", need);
    return need;
  }

  // ───────────────────────────── outbox handlers ─────────────────────────────

  oid(): string {
    const A = "0123456789abcdefghjkmnpqrstvwxyz";
    let s = "o_";
    for (let i = 0; i < 14; i++) s += A[Math.floor(this.rand() * 32)];
    return s;
  }

  private async handleProject(row: OutboxRow): Promise<HandlerResult> {
    const run = this.run(row.runId);
    if (run.status === "cancelled") return { done: true, result: { skipped: "run cancelled" } };
    const hostId = this.repo.runHost(run.id) ?? (await this.port.primaryHostId());
    if (!hostId) throw new Error("no host is connected");
    const host = this.port.host(hostId);
    if (row.payload.studio) {
      if (run.studioProjectId) return { done: true, result: { projectId: run.studioProjectId } };
      const path = this.studioPath(run);
      await host.ensureRepo({ path, files: [{ path: ".gitignore", content: GITIGNORE }], message: "Helm: studio" });
      const found = await this.port.findProjectByPath({ hostId, path });
      const projectId = found?.projectId ?? (await this.port.createProject({ name: `Helm · ${run.name}`, hostId, path })).projectId;
      this.repo.updateRun(run.id, { studioProjectId: projectId });
      return { done: true, result: { projectId } };
    }
    const appId = String(row.payload.appId);
    const app = this.repo.getApp(run.id, appId);
    if (!app) return { done: true, result: { skipped: "app gone" } };
    if (app.projectId) return { done: true, result: { projectId: app.projectId } };
    const home = await this.homeOf(hostId);
    const path = this.appPath(run, app, home);
    const lead = this.leadOf(run.id, app.id);
    if (app.targetPath) {
      const bad = targetPathProblem(app.targetPath, home);
      if (bad) throw new Error(bad);
      const info = await host.inspectPath({ path });
      if (info.exists && !info.isDir) throw new Error(`${path} is a file, not a folder`);
      if (info.gitRoot && !samePath(info.gitRoot, info.path, home)) throw new Error(`${path} is inside the repository ${info.gitRoot}; point the app at the repository's top folder`);
      if (info.gitRoot) {
        // adopt: Helm's files go on a new branch; the human's checkout, index and branches stay as they are
        const helmBranch = this.helmBranchFor(run, app);
        // no files and no commit: only a branch at the human's HEAD (briefs and the wrapper live in the Studio)
        const res = await host.adoptRepo({ path, branch: helmBranch, files: [], message: `Helm: start ${app.name}` });
        const found = (await this.port.findProjectByPath({ hostId, path })) ?? (info.path !== path ? await this.port.findProjectByPath({ hostId, path: info.path }) : null);
        const projectId = found?.projectId ?? (await this.port.createProject({ name: app.name, hostId, path })).projectId;
        this.repo.updateApp(run.id, app.id, { projectId, repoPath: path, adopted: true, helmBranch, userBranch: res.userBranch, baseCommit: res.base });
        if (lead) this.repo.event(run.id, lead.id, "repo", `adopted existing repository ${path} on branch ${helmBranch} (${res.head.slice(0, 9)}); ${res.userBranch ?? "the human's checkout"} untouched`);
        return { done: true, result: { projectId, head: res.head, adopted: true } };
      }
      if (info.exists && !info.empty) throw new Error(`${path} has files but is not a git repository`);
      if (info.enclosingRepo) throw new Error(`${path} would be created inside the repository ${info.enclosingRepo}`);
    }
    const res = await host.ensureRepo({
      path,
      files: [
        { path: ".helm/run-check.sh", content: RUN_CHECK_SH, executable: true },
        { path: ".helm/checks.json", content: CHECKS_JSON_SKELETON + "\n" },
        { path: ".gitignore", content: GITIGNORE },
        { path: "BRIEF.md", content: lead ? this.buildBrief(run, lead) : `# ${app.name}\n` },
      ],
      message: `Helm: start ${app.name}`,
    });
    const found = await this.port.findProjectByPath({ hostId, path });
    const projectId = found?.projectId ?? (await this.port.createProject({ name: app.name, hostId, path })).projectId;
    this.repo.updateApp(run.id, app.id, { projectId, repoPath: path });
    if (lead) this.repo.event(run.id, lead.id, "repo", `repository ready at ${path} (${res.head?.slice(0, 9) ?? "no commit"})`);
    return { done: true, result: { projectId, head: res.head } };
  }

  private envFor(run: RunInfo, n: NodeInfo, hostId: string | null): EnvSpec | { wait: string } {
    const c1 = n.alsoLead;
    if ((n.role === "orch" && !c1) || n.role === "mgr") {
      if (!run.studioProjectId) return { wait: "studio project" };
      return { kind: "path", hostId, path: this.studioPath(run) };
    }
    const app = n.appId ? this.repo.getApp(run.id, n.appId) : c1 ? this.repo.listApps(run.id)[0] ?? null : null;
    if (!app?.projectId) return { wait: "app repository" };
    const integration = this.repo.appExtra(run.id, app.id).integrationBranch;
    // a lead's first thread starts the integration branch; a replacement lead continues from it
    if (this.isLeadNode(n)) return { kind: "worktree", hostId, baseBranch: integration ?? app.helmBranch ?? null };
    if (!integration) return { wait: "integration branch" };
    return { kind: "worktree", hostId, baseBranch: integration };
  }

  projectFor(run: RunInfo, n: NodeInfo): string | null {
    if ((n.role === "orch" && !n.alsoLead) || n.role === "mgr") return run.studioProjectId;
    const app = n.appId ? this.repo.getApp(run.id, n.appId) : n.alsoLead ? this.repo.listApps(run.id)[0] ?? null : null;
    return app?.projectId ?? null;
  }

  private async handleSpawn(row: OutboxRow): Promise<HandlerResult> {
    const run = this.run(row.runId);
    const n = this.repo.getNode(run.id, String(row.payload.nodeId));
    if (!n) return { done: true, result: { skipped: "node gone" } };
    if (n.threadId) return { done: true, result: { threadId: n.threadId, adopted: true } };
    if (run.status === "cancelled" || run.status === "done") return { done: true, result: { skipped: `run ${run.status}` } };
    if (n.status !== "queued") return { done: true, result: { skipped: `node is ${n.status}` } };
    // never spawn a child for a parent that is not running or waiting (§9.3)
    const parent = n.parentId ? this.repo.getNode(run.id, n.parentId) : null;
    if (parent) {
      if (!parent.threadId) return { defer: DEFER_SHORT, reason: `parent ${parent.id} has no thread yet` };
      if (["failed", "idle", "done"].includes(parent.status)) {
        this.repo.updateNode(run.id, n.id, { status: "planned", warning: `not spawned: parent ${parent.id} is ${parent.status}` });
        return { done: true, result: { skipped: `parent ${parent.status}` } };
      }
    }
    const hostId = this.repo.runHost(run.id);
    const env = this.envFor(run, n, hostId);
    if ("wait" in env) return { defer: DEFER_SHORT, reason: `waiting for ${env.wait}` };
    const projectId = this.projectFor(run, n)!;
    // validate the model at spawn; never substitute (§7.4)
    const model = n.model ?? this.effectiveModel(run, n);
    if (!model) {
      this.repo.tx(() => {
        this.repo.updateNode(run.id, n.id, { status: "needs", prevStatus: "queued" });
        this.raiseNeed(run.id, { kind: "model", nodeId: n.id, appId: n.appId, title: `${this.label(n)} has no model`, body: "Choose a model for this agent.", evidence: "", options: ["Choose model"], dedupeKey: `model:${n.id}` });
      });
      return { done: true, result: { skipped: "no model" } };
    }
    const cat = await this.catalog(hostId);
    const problem = validateRef(cat, model);
    if (problem) {
      this.repo.tx(() => {
        this.repo.updateNode(run.id, n.id, { status: "needs", prevStatus: "queued" });
        this.raiseNeed(run.id, { kind: "model", nodeId: n.id, appId: n.appId, title: `Model ${modelName(cat, model)} is no longer available — choose another`, body: problem.message, evidence: "", options: ["Choose model"], dedupeKey: `model:${n.id}` });
      });
      return { done: true, result: { skipped: problem.message } };
    }
    // one key per generation: a replacement thread never matches its predecessor (V17)
    const gen = Number(row.payload.gen ?? 1);
    const key = `${run.id}:${n.parentId ?? "root"}:${n.id}${gen > 1 ? `#${gen}` : ""}`;
    const owner = parent?.threadId ?? null;
    // V17: a crash between spawn and the DB write is healed by looking first
    let ref = await this.port.findThreadByKey({ key, runId: run.id, ownerThreadId: owner });
    let adopted = !!ref;
    if (!ref) {
      // a specialist's "done" must cite work made after this point (gates.report)
      if (n.tier === "specialist" && n.appId) await this.recordSpawnBase(run.id, n.id, n.appId);
      const integrationCommit = n.tier === "gate" && n.appId ? this.repo.appExtra(run.id, n.appId).integrationHead : null;
      const prompt = this.buildBrief(run, n, { integrationCommit, scannerFindings: this.repo.getMeta(`scanner:${run.id}:${n.id}`), handover: typeof row.payload.handover === "string" ? row.payload.handover : null });
      const visible = n.role === "orch" || (this.settings.showLeadsInSidebar && this.isLeadNode(n));
      ref = await this.port.spawnThread({
        projectId,
        environment: env,
        title: n.role === "orch" ? `Helm · ${run.name}` : this.label(n),
        prompt,
        model,
        permissionMode: this.settings.permissionMode[n.tier] ?? "auto",
        visibility: visible ? "visible" : "hidden",
        lifecycleOwnerThreadId: owner,
        meta: { v: 1, runId: run.id, nodeId: n.id, tier: n.tier, role: n.role, key },
      });
      adopted = false;
    }
    const threadId = ref.threadId;
    this.repo.tx(() => {
      this.repo.updateNode(run.id, n.id, { threadId, environmentId: ref!.environmentId, status: "running", spawnedAt: this.now(), lastActivityAt: this.now(), firstInLine: false, model, providerId: model.providerId, prevStatus: null });
      // directives stored before spawn were in the prompt: they are delivered now (§6.3)
      for (const d of this.repo.directivesBeforeSpawn(run.id, n.id)) this.repo.updateRecipient(run.id, d.id, n.id, { state: "delivered", deliveredAt: this.now() });
      this.repo.event(run.id, n.id, adopted ? "adopted" : "spawned", `${adopted ? "adopted existing thread" : "spawned"} on ${modelName(cat, model)}`, threadId);
      if (parent) this.repo.comms(run.id, { from: parent.id, to: n.id, kind: "spawn", summary: `${this.label(parent)} → ${this.label(n)}: spawned` });
    });
    this.emit(run.id, "node.updated", this.repo.getNode(run.id, n.id));
    this.emit(run.id, "edge.added", { from: n.parentId, to: n.id });
    void this.refreshEnv(run.id, n.id);
    return { done: true, result: { threadId, adopted } };
  }

  /** The integration-branch commit a specialist's worktree starts from. */
  private async recordSpawnBase(runId: string, nodeId: string, appId: string): Promise<void> {
    const app = this.repo.getApp(runId, appId);
    const branch = this.repo.appExtra(runId, appId).integrationBranch;
    if (!app?.repoPath || !branch) return;
    const sha = await this.host(runId)
      .revParse({ repo: app.repoPath, ref: branch })
      .then((r) => r.sha, () => null);
    if (sha) this.repo.setMeta(`base:${runId}:${nodeId}`, sha);
  }

  /** Read the BB-chosen branch of a node's environment; the lead's branch is the integration branch. */
  async refreshEnv(runId: string, nodeId: string): Promise<void> {
    const n = this.repo.getNode(runId, nodeId);
    if (!n?.threadId || n.branch) return;
    const envId = this.repo.nodeEnvironment(runId, nodeId) ?? (await this.port.threadState(n.threadId))?.environmentId ?? null;
    if (!envId) return;
    const env = await this.port.environment(envId);
    if (!env?.branch) return;
    this.repo.tx(() => {
      this.repo.updateNode(runId, nodeId, { branch: env.branch!, environmentId: envId });
      // the lead's current branch is the integration branch (a replacement lead's branch starts from the old one)
      if (this.isLeadNode(n) && n.appId) this.repo.updateApp(runId, n.appId, { integrationBranch: env.branch! });
      else if (n.alsoLead) {
        const app = this.repo.listApps(runId)[0];
        if (app) this.repo.updateApp(runId, app.id, { integrationBranch: env.branch! });
      }
    });
    if (this.isLeadNode(n)) this.outbox.kick();
  }

  /** Text to send, with any FYI lines the node has not seen yet prepended. */
  private withInbox(runId: string, nodeId: string, text: string): { text: string; ids: number[] } {
    const lines = this.repo.unflushedInbox(runId, nodeId);
    if (!lines.length) return { text, ids: [] };
    const fyi = lines.slice(-15).map((l) => `- ${l.text}`);
    if (lines.length > 15) fyi.unshift(`- (${lines.length - 15} older lines — see helm_context)`);
    return { text: `${text}\n\nAlso since your last turn (FYI, no reply needed):\n${fyi.join("\n")}`, ids: lines.map((l) => l.id) };
  }

  private async handleSend(row: OutboxRow): Promise<HandlerResult> {
    const run = this.repo.getRun(row.runId);
    const n = run ? this.repo.getNode(run.id, String(row.nodeId)) : null;
    if (!run || !n) return { done: true, result: { skipped: "gone" } };
    const kind = String(row.payload.kind ?? "notice");
    if (!n.threadId) {
      // planned/queued nodes get stored directives in their spawn prompt (§6.3)
      if (["planned", "queued"].includes(n.status)) return { done: true, result: { skipped: "no thread yet — goes into the spawn prompt" } };
      if (n.status === "needs" || n.status === "failed") return { done: true, result: { skipped: `no thread (${n.status})` } };
      return { defer: DEFER_SHORT, reason: "thread not created yet" };
    }
    if (n.status === "paused" && !row.payload.bypassPause) return { defer: 60_000, reason: "node is paused" };
    if (kind === "flush") {
      if (n.status !== "running") return { done: true, result: { skipped: "not active — lines wait for its next message" } };
      const lines = this.repo.unflushedInbox(run.id, n.id);
      if (!lines.length) return { done: true, result: { skipped: "nothing to flush" } };
      const text = `FYI from Helm (no reply needed):\n${lines.slice(-15).map((l) => `- ${l.text}`).join("\n")}`;
      const res = await this.port.sendMessage({ threadId: n.threadId, text, mode: "queue" });
      this.repo.tx(() => {
        this.repo.markInboxFlushed(lines.map((l) => l.id));
        this.markDigestDelivered(run.id, n.id, lines);
      });
      return { done: true, result: res };
    }
    const base = String(row.payload.text ?? "");
    const { text, ids } = this.withInbox(run.id, n.id, base);
    const mode = row.payload.mode === "steer" ? "steer" : "queue";
    const sender = typeof row.payload.senderNodeId === "string" ? this.repo.getNode(run.id, row.payload.senderNodeId) : null;
    const res = await this.port.sendMessage({ threadId: n.threadId, text, mode, senderThreadId: sender?.threadId ?? null });
    const recips = (row.payload.recipients as Array<{ directiveId: string; nodeId: string }> | undefined) ?? [];
    this.repo.tx(() => {
      if (ids.length) {
        const lines = this.repo.unflushedInbox(run.id, n.id).filter((l) => ids.includes(l.id));
        this.repo.markInboxFlushed(ids);
        this.markDigestDelivered(run.id, n.id, lines);
      }
      for (const r of recips) {
        if (res.delivery === "sent") this.repo.updateRecipient(run.id, r.directiveId, r.nodeId, { state: "delivered", deliveredAt: this.now() });
        else this.repo.updateRecipient(run.id, r.directiveId, r.nodeId, { queuedMessageId: res.queuedMessageId });
      }
      if (kind === "message" && sender) this.repo.comms(run.id, { from: sender.id, to: n.id, kind: String(row.payload.commsKind ?? "info"), summary: base.slice(0, 300) });
    });
    for (const r of recips) this.emit(run.id, "receipt.updated", { directiveId: r.directiveId, nodeId: r.nodeId, state: res.delivery === "sent" ? "delivered" : "queued" });
    return { done: true, result: res };
  }

  private markDigestDelivered(runId: string, nodeId: string, lines: Array<{ directiveId: string | null }>): void {
    for (const l of lines) if (l.directiveId) this.repo.db.prepare("UPDATE directive_recipients SET delivered_at = COALESCE(delivered_at, ?), flushed = 1 WHERE run_id = ? AND directive_id = ? AND node_id = ?").run(this.now(), runId, l.directiveId, nodeId);
  }

  private async handleUpdate(row: OutboxRow): Promise<HandlerResult> {
    const n = this.repo.getNode(row.runId, String(row.nodeId));
    if (!n?.threadId) return { done: true, result: { skipped: "no thread — applies at spawn" } };
    await this.port.updateThread({ threadId: n.threadId, model: row.payload.model as string | undefined, reasoningLevel: (row.payload.reasoningLevel as string | null | undefined) ?? undefined });
    return { done: true };
  }

  private async handleStop(row: OutboxRow): Promise<HandlerResult> {
    const ids = (row.payload.nodeIds as string[] | undefined) ?? [String(row.nodeId)];
    for (const id of ids) {
      const n = this.repo.getNode(row.runId, id);
      if (!n?.threadId) continue;
      const st = await this.port.threadState(n.threadId);
      if (!st || st.archived || st.status === "idle" || st.status === "error") continue;
      await this.port.stopThread(n.threadId);
    }
    const directiveId = typeof row.payload.directiveId === "string" ? row.payload.directiveId : null;
    if (directiveId)
      this.repo.tx(() => {
        for (const id of ids) {
          this.repo.updateRecipient(row.runId, directiveId, id, { state: "delivered", deliveredAt: this.now() });
          this.emit(row.runId, "receipt.updated", { directiveId, nodeId: id, state: "delivered" });
        }
      });
    return { done: true };
  }

  private async handleArchive(row: OutboxRow): Promise<HandlerResult> {
    const ids = (row.payload.nodeIds as string[] | undefined) ?? [String(row.nodeId)];
    const archived: string[] = [];
    for (const id of ids) {
      const n = this.repo.getNode(row.runId, id);
      if (!n?.threadId) continue;
      const st = await this.port.threadState(n.threadId);
      if (!st || st.archived) continue;
      this.archiving.add(n.threadId);
      archived.push(...(await this.port.archiveThread(n.threadId)));
    }
    return { done: true, result: { archived } };
  }

  private async handleRetry(row: OutboxRow): Promise<HandlerResult> {
    const n = this.repo.getNode(row.runId, String(row.nodeId));
    if (!n?.threadId) return { done: true, result: { skipped: "no thread" } };
    const st = await this.port.threadState(n.threadId);
    if (st?.status === "error" || row.payload.turnRequestId) await this.port.retryThread({ threadId: n.threadId, turnRequestId: row.payload.turnRequestId as string | undefined });
    else await this.port.sendMessage({ threadId: n.threadId, text: String(row.payload.text ?? "Retry requested by the human: resume from your last commit. Re-read your BRIEF and helm_context first."), mode: "queue" });
    return { done: true };
  }

  private async handleCompact(row: OutboxRow): Promise<HandlerResult> {
    const n = this.repo.getNode(row.runId, String(row.nodeId));
    if (!n?.threadId) return { done: true };
    await this.port.compactThread(n.threadId);
    return { done: true };
  }

  private async handleInteraction(row: OutboxRow): Promise<HandlerResult> {
    await this.port.respondInteraction({ threadId: String(row.payload.threadId), interactionId: String(row.payload.interactionId), answer: row.payload.answer as never });
    return { done: true };
  }

  private async handleFile(row: OutboxRow): Promise<HandlerResult> {
    await this.port.host(this.repo.runHost(row.runId)).writeFile({ path: String(row.payload.path), content: String(row.payload.content) });
    return { done: true };
  }

  private onOutboxFailed(row: OutboxRow, err: string): void {
    const run = this.repo.getRun(row.runId);
    if (!run) return;
    this.repo.tx(() => {
      if (row.kind === "send") {
        for (const r of (row.payload.recipients as Array<{ directiveId: string; nodeId: string }> | undefined) ?? []) {
          this.repo.updateRecipient(run.id, r.directiveId, r.nodeId, { state: "failed" });
          this.emit(run.id, "receipt.updated", { directiveId: r.directiveId, nodeId: r.nodeId, state: "failed" });
        }
      }
      if (row.kind === "stop" && typeof row.payload.directiveId === "string") {
        for (const id of (row.payload.nodeIds as string[] | undefined) ?? []) {
          this.repo.updateRecipient(run.id, row.payload.directiveId, id, { state: "failed" });
          this.emit(run.id, "receipt.updated", { directiveId: row.payload.directiveId, nodeId: id, state: "failed" });
        }
      }
      if (row.kind === "spawn" && row.nodeId) {
        const n = this.repo.getNode(run.id, row.nodeId);
        if (n && !n.threadId) {
          this.repo.updateNode(run.id, n.id, { status: "failed", warning: `spawn failed: ${err.slice(0, 200)}` });
          this.raiseNeed(run.id, { kind: "failed", nodeId: n.id, appId: n.appId, title: `${this.label(n)} could not be spawned`, body: err.slice(0, 1000), evidence: `outbox ${row.id} · ${row.attempts + 1} attempts`, options: ["Retry", "Change model and retry", "Stop"], dedupeKey: `spawnfail:${n.id}` });
        }
      }
      if (row.kind === "project" && row.nodeId) {
        const n = this.repo.getNode(run.id, row.nodeId);
        if (n) this.raiseNeed(run.id, { kind: "failed", nodeId: n.id, appId: (row.payload.appId as string) ?? null, title: `Could not create the repository for ${this.label(n)}`, body: err.slice(0, 1000), evidence: `outbox ${row.id}`, options: ["Retry", "Stop"], dedupeKey: `projfail:${row.payload.appId ?? "studio"}` });
      }
      if (row.nodeId) this.repo.event(run.id, row.nodeId, "outbox.failed", `${row.kind} failed: ${err.slice(0, 200)}`, row.id);
    });
  }

  // ───────────────────────────── small state helpers ─────────────────────────────

  setStatus(runId: string, nodeId: string, status: NodeStatus, extra: Partial<{ warning: string | null; endedAt: number | null }> = {}): void {
    const n = this.repo.getNode(runId, nodeId);
    if (!n || n.status === status) {
      if (n && extra.warning !== undefined) this.repo.updateNode(runId, nodeId, { warning: extra.warning });
      return;
    }
    this.repo.updateNode(runId, nodeId, { status, ...extra });
    this.emit(runId, "node.updated", { ...n, status, ...extra });
  }

  /** Spend in relative units across a run. */
  spend(runId: string): number {
    return this.repo.listNodes(runId).reduce((s, n) => s + n.cost, 0);
  }

  /** Enqueue a plain message from Helm (not a directive) to a node. */
  sendFromHelm(runId: string, nodeId: string, text: string, opts: { mode?: "steer" | "queue"; key?: string; senderNodeId?: string | null; kind?: string; commsKind?: string; bypassPause?: boolean } = {}): void {
    this.repo.enqueue({
      id: this.oid(),
      runId,
      kind: "send",
      nodeId,
      payload: { text, mode: opts.mode ?? "queue", kind: opts.kind ?? "helm", senderNodeId: opts.senderNodeId ?? null, commsKind: opts.commsKind, bypassPause: opts.bypassPause ?? false },
      idemKey: opts.key ?? `helm:${runId}:${nodeId}:${this.oid()}`,
    });
    this.outbox.kick();
  }

  /** Unread FYI lines as one block for a tool result, marked read; "" when there are none. */
  takeInbox(runId: string, nodeId: string): string {
    const lines = this.repo.unflushedInbox(runId, nodeId);
    if (!lines.length) return "";
    const shown = lines.slice(-10).map((l) => `- ${l.text.slice(0, 300)}`);
    if (lines.length > 10) shown.unshift(`- (${lines.length - 10} older lines not shown)`);
    this.repo.tx(() => {
      this.repo.markInboxFlushed(lines.map((l) => l.id));
      this.markDigestDelivered(runId, nodeId, lines);
    });
    return `FYI since you last heard from Helm (no reply needed):\n${shown.join("\n")}`;
  }

  /** Queue an FYI line; it rides along with the node's next message, or is sent on its own while it is active. */
  fyi(runId: string, nodeId: string, text: string, directiveId: string | null = null): void {
    this.repo.pushInbox(runId, nodeId, text, directiveId);
    this.scheduleFlush(runId, nodeId);
  }

  /**
   * While a node is active, unread FYI lines are delivered with its next Helm tool result
   * (free). Only lines still unread after FLUSH_MS go out as one coalesced message (§6.6),
   * so an agent that never calls a Helm tool still hears them.
   */
  scheduleFlush(runId: string, nodeId: string): void {
    const n = this.repo.getNode(runId, nodeId);
    if (n?.status === "running" && n.threadId) {
      const win = Math.floor(this.now() / FLUSH_MS);
      this.repo.enqueue({ id: this.oid(), runId, kind: "send", nodeId, payload: { kind: "flush" }, idemKey: `flush:${runId}:${nodeId}:${win}`, notBefore: (win + 1) * FLUSH_MS });
      this.outbox.kick();
    }
  }
}
