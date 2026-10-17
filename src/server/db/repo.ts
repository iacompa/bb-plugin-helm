// Typed access to Helm's SQLite database. Works over better-sqlite3 (inside BB)
// and node:sqlite (tests): both expose exec/prepare/run/get/all with positional
// parameters. Every state change and its node_events row go in one transaction.
import type {
  AppInfo,
  CheckInfo,
  CommsInfo,
  DirectiveInfo,
  FindingInfo,
  HelmLimits,
  ModelRef,
  NeedInfo,
  NodeEventInfo,
  NodeInfo,
  NodeStatus,
  PolicyInfo,
  RecipientInfo,
  ReportInfo,
  RunInfo,
  SlotMap,
  Stage,
  StageHistoryInfo,
  VerdictInfo,
} from "../../shared/types.ts";
import { LIMIT_DEFAULTS } from "../../shared/types.ts";
import { MIGRATIONS } from "./schema.ts";

type Param = string | number | null;
export interface SqlStatement {
  run(...params: Param[]): unknown;
  get(...params: Param[]): unknown;
  all(...params: Param[]): unknown[];
}
export interface SqlDb {
  exec(sql: string): unknown;
  prepare(sql: string): SqlStatement;
}

type Row = Record<string, unknown>;

const j = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== "string" || !s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
const js = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));
const b = (v: unknown) => v === 1 || v === true;
const n = (v: unknown): number | null => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : null);
const s = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function migrate(db: SqlDb): number {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL)");
  const row = db.prepare("SELECT version FROM schema_version").get() as Row | undefined;
  let v = row ? Number(row.version) : 0;
  if (!row) db.prepare("INSERT INTO schema_version(version) VALUES (0)").run();
  while (v < MIGRATIONS.length) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      v++;
      db.prepare("UPDATE schema_version SET version = ?").run(v);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return v;
}

/** error: something broke · warn: degraded or retried · user: a request Helm refused with a reason. */
export type ErrorLevel = "error" | "warn" | "user";
export interface ErrorEntry { id: number; ts: number; level: ErrorLevel; source: string; at: string; runId: string | null; message: string; detail: string | null }

export class Repo {
  private depth = 0;
  constructor(readonly db: SqlDb, readonly now: () => number = Date.now) {}

  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw e;
    } finally {
      this.depth = 0;
    }
  }

  private get1(sql: string, ...p: Param[]): Row | null {
    return (this.db.prepare(sql).get(...p) as Row | undefined) ?? null;
  }
  private all(sql: string, ...p: Param[]): Row[] {
    return this.db.prepare(sql).all(...p) as Row[];
  }
  private run(sql: string, ...p: Param[]): void {
    this.db.prepare(sql).run(...p);
  }

  // ───────────── meta ─────────────
  getMeta(key: string): string | null {
    return s(this.get1("SELECT value FROM meta WHERE key = ?", key)?.value);
  }
  setMeta(key: string, value: string): void {
    this.run("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }
  deleteMeta(key: string): void {
    this.run("DELETE FROM meta WHERE key = ?", key);
  }

  // ───────────── runs ─────────────
  private toRun(r: Row): RunInfo {
    const limits = { ...LIMIT_DEFAULTS, ...j<Partial<HelmLimits>>(r.limits_json, {}) };
    return {
      id: String(r.id),
      name: String(r.name ?? ""),
      status: (r.status as RunInfo["status"]) ?? "planning",
      brief: String(r.brief ?? ""),
      dryRun: b(r.dry_run),
      studioProjectId: s(r.studio_project_id),
      appsRoot: s(r.apps_root),
      budgetCap: Number(r.budget_cap ?? limits.budgetCap),
      maxAgents: Number(r.max_agents ?? limits.maxTotalAgents),
      concurrency: Number(r.concurrency ?? limits.concurrency),
      spawnsPaused: b(r.spawns_paused),
      autoAdvance: (r.auto_advance as RunInfo["autoAdvance"]) ?? "ask",
      limits,
      slots: j<SlotMap>(r.slots_json, {}),
      createdAt: Number(r.created_at ?? 0),
      startedAt: n(r.started_at),
      endedAt: n(r.ended_at),
    };
  }
  insertRun(r: { id: string; name: string; brief: string; planJson: unknown; settingsJson: unknown; slots: SlotMap; limits: HelmLimits; dryRun: boolean; autoAdvance: string; appsRoot: string | null; hostId: string | null }): void {
    this.run(
      `INSERT INTO runs(id, name, status, brief, plan_json, settings_json, apps_root, budget_cap, max_agents, concurrency, auto_advance, created_at, dry_run, slots_json, limits_json, host_id)
       VALUES (?, ?, 'planning', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.id, r.name, r.brief, js(r.planJson), js(r.settingsJson), r.appsRoot, r.limits.budgetCap, r.limits.maxTotalAgents, r.limits.concurrency, r.autoAdvance, this.now(), r.dryRun ? 1 : 0, js(r.slots), js(r.limits), r.hostId,
    );
  }
  getRun(id: string): RunInfo | null {
    const r = this.get1("SELECT * FROM runs WHERE id = ?", id);
    return r ? this.toRun(r) : null;
  }
  runPlan(id: string): unknown {
    return j(this.get1("SELECT plan_json FROM runs WHERE id = ?", id)?.plan_json, null);
  }
  runHost(id: string): string | null {
    return s(this.get1("SELECT host_id FROM runs WHERE id = ?", id)?.host_id);
  }
  listRuns(): RunInfo[] {
    return this.all("SELECT * FROM runs ORDER BY created_at DESC").map((r) => this.toRun(r));
  }
  activeRuns(): RunInfo[] {
    return this.all("SELECT * FROM runs WHERE status IN ('running','paused') ORDER BY created_at").map((r) => this.toRun(r));
  }
  updateRun(id: string, patch: Partial<{ status: string; studioProjectId: string | null; appsRoot: string | null; spawnsPaused: boolean; budgetCap: number; concurrency: number; autoAdvance: string; slots: SlotMap; startedAt: number; endedAt: number; portfolioDirty: boolean; limits: HelmLimits; name: string }>): void {
    const map: Record<string, [string, (v: never) => Param]> = {
      status: ["status", (v: string) => v],
      studioProjectId: ["studio_project_id", (v: string | null) => v],
      appsRoot: ["apps_root", (v: string | null) => v],
      spawnsPaused: ["spawns_paused", (v: boolean) => (v ? 1 : 0)],
      budgetCap: ["budget_cap", (v: number) => v],
      concurrency: ["concurrency", (v: number) => v],
      autoAdvance: ["auto_advance", (v: string) => v],
      slots: ["slots_json", (v: SlotMap) => js(v)],
      startedAt: ["started_at", (v: number) => v],
      endedAt: ["ended_at", (v: number) => v],
      portfolioDirty: ["portfolio_dirty", (v: boolean) => (v ? 1 : 0)],
      limits: ["limits_json", (v: HelmLimits) => js(v)],
      name: ["name", (v: string) => v],
    };
    const sets: string[] = [];
    const vals: Param[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const m = map[k];
      if (!m || v === undefined) continue;
      sets.push(`${m[0]} = ?`);
      vals.push(m[1](v as never));
    }
    if (sets.length) this.run(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`, ...vals, id);
  }
  portfolioDirty(id: string): boolean {
    return b(this.get1("SELECT portfolio_dirty FROM runs WHERE id = ?", id)?.portfolio_dirty);
  }
  nextSeq(runId: string, kind: "directive" | "need" | "finding" | "policy"): number {
    const col = `${kind}_seq`;
    this.run(`UPDATE runs SET ${col} = COALESCE(${col}, 0) + 1 WHERE id = ?`, runId);
    return Number(this.get1(`SELECT ${col} AS v FROM runs WHERE id = ?`, runId)?.v ?? 1);
  }

  // ───────────── apps ─────────────
  private toApp(r: Row): AppInfo {
    return {
      id: String(r.id),
      runId: String(r.run_id),
      name: String(r.name ?? ""),
      tagline: String(r.tagline ?? ""),
      platforms: j(r.platforms, []),
      shape: (r.shape as AppInfo["shape"]) ?? "full",
      managerNodeId: s(r.manager_node_id),
      projectId: s(r.project_id),
      repoPath: s(r.repo_path),
      stage: (r.stage as Stage) ?? "intake",
      priority: (r.priority as AppInfo["priority"]) ?? "normal",
      fixRound: Number(r.fix_round ?? 0),
      pct: Number(r.pct ?? 0),
      order: Number(r.order_idx ?? 0),
      test: b(r.test),
      slotOverrides: j(r.slot_overrides_json, {}),
      waivedGates: j(r.waived_gates_json, []),
      targetPath: s(r.target_path),
      reads: j(r.reads_json, []),
      adopted: b(r.adopted),
      helmBranch: s(r.helm_branch),
      userBranch: s(r.user_branch),
    };
  }
  insertApp(a: { runId: string; id: string; name: string; tagline: string; platforms: string[]; platformsAssumed: boolean; shape: string; managerNodeId: string | null; order: number; test: boolean; priority: string; notes: string | null; targetPath?: string | null; reads?: string[] }): void {
    this.run(
      `INSERT INTO apps(id, run_id, name, tagline, platforms, platforms_assumed, shape, manager_node_id, order_idx, test, priority, notes, target_path, reads_json, stage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'intake')`,
      a.id, a.runId, a.name, a.tagline, js(a.platforms), a.platformsAssumed ? 1 : 0, a.shape, a.managerNodeId, a.order, a.test ? 1 : 0, a.priority, a.notes, a.targetPath ?? null, js(a.reads ?? []),
    );
  }
  getApp(runId: string, id: string): AppInfo | null {
    const r = this.get1("SELECT * FROM apps WHERE run_id = ? AND id = ?", runId, id);
    return r ? this.toApp(r) : null;
  }
  listApps(runId: string): AppInfo[] {
    return this.all("SELECT * FROM apps WHERE run_id = ? ORDER BY order_idx", runId).map((r) => this.toApp(r));
  }
  appExtra(runId: string, id: string): { contractVersion: number; integrationBranch: string | null; integrationHead: string | null; platformsAssumed: boolean; notes: string | null; baseCommit: string | null } {
    const r = this.get1("SELECT contract_version, integration_branch, integration_head, platforms_assumed, notes, base_commit FROM apps WHERE run_id = ? AND id = ?", runId, id) ?? {};
    return { contractVersion: Number(r.contract_version ?? 0), integrationBranch: s(r.integration_branch), integrationHead: s(r.integration_head), platformsAssumed: b(r.platforms_assumed), notes: s(r.notes), baseCommit: s(r.base_commit) };
  }
  updateApp(runId: string, id: string, patch: Partial<{ stage: Stage; priority: string; fixRound: number; pct: number; projectId: string; repoPath: string; shape: string; slotOverrides: SlotMap; waivedGates: string[]; contractVersion: number; integrationBranch: string; integrationHead: string | null; managerNodeId: string | null; test: boolean; adopted: boolean; helmBranch: string | null; userBranch: string | null; baseCommit: string | null }>): void {
    const map: Record<string, [string, (v: never) => Param]> = {
      stage: ["stage", (v: string) => v],
      priority: ["priority", (v: string) => v],
      fixRound: ["fix_round", (v: number) => v],
      pct: ["pct", (v: number) => v],
      projectId: ["project_id", (v: string) => v],
      repoPath: ["repo_path", (v: string) => v],
      shape: ["shape", (v: string) => v],
      slotOverrides: ["slot_overrides_json", (v: SlotMap) => js(v)],
      waivedGates: ["waived_gates_json", (v: string[]) => js(v)],
      contractVersion: ["contract_version", (v: number) => v],
      integrationBranch: ["integration_branch", (v: string) => v],
      integrationHead: ["integration_head", (v: string | null) => v],
      managerNodeId: ["manager_node_id", (v: string | null) => v],
      test: ["test", (v: boolean) => (v ? 1 : 0)],
      adopted: ["adopted", (v: boolean) => (v ? 1 : 0)],
      helmBranch: ["helm_branch", (v: string | null) => v],
      userBranch: ["user_branch", (v: string | null) => v],
      baseCommit: ["base_commit", (v: string | null) => v],
    };
    const sets: string[] = [];
    const vals: Param[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const m = map[k];
      if (!m || v === undefined) continue;
      sets.push(`${m[0]} = ?`);
      vals.push(m[1](v as never));
    }
    if (sets.length) this.run(`UPDATE apps SET ${sets.join(", ")} WHERE run_id = ? AND id = ?`, ...vals, runId, id);
  }

  // ───────────── stage history ─────────────
  enterStage(runId: string, appId: string, stage: Stage, evidence: unknown): void {
    const t = this.now();
    this.run("UPDATE stage_history SET exited_at = ? WHERE run_id = ? AND app_id = ? AND exited_at IS NULL", t, runId, appId);
    this.run("INSERT INTO stage_history(run_id, app_id, stage, entered_at, evidence_json) VALUES (?, ?, ?, ?, ?)", runId, appId, stage, t, js(evidence));
  }
  stageHistory(runId: string, appId: string): StageHistoryInfo[] {
    return this.all("SELECT * FROM stage_history WHERE run_id = ? AND app_id = ? ORDER BY entered_at", runId, appId).map((r) => ({
      appId: String(r.app_id),
      stage: r.stage as Stage,
      enteredAt: Number(r.entered_at),
      exitedAt: n(r.exited_at),
      evidence: j(r.evidence_json, null),
    }));
  }

  // ───────────── nodes ─────────────
  private toNode(r: Row): NodeInfo {
    return {
      id: String(r.id),
      runId: String(r.run_id),
      appId: s(r.app_id),
      tier: r.tier as NodeInfo["tier"],
      role: r.role as NodeInfo["role"],
      platform: (s(r.platform) as NodeInfo["platform"]) ?? null,
      parentId: s(r.parent_id),
      threadId: s(r.thread_id),
      status: (r.status as NodeStatus) ?? "planned",
      alsoLead: b(r.also_lead),
      slot: r.slot as NodeInfo["slot"],
      model: j<ModelRef | null>(r.model_json, null),
      modelOverride: b(r.model_override),
      briefVersion: Number(r.brief_version ?? 1),
      scopeGlobs: j(r.scope_globs, []),
      branch: s(r.branch),
      priority: (r.priority as NodeInfo["priority"]) ?? "normal",
      nowLine: s(r.now_line),
      topics: j(r.topics, []),
      tokens: Number(r.tokens ?? 0),
      turns: Number(r.turns ?? 0),
      cost: Number(r.cost ?? 0),
      touched: b(r.touched),
      warning: s(r.warning),
      createdAt: Number(r.created_at ?? 0),
      spawnedAt: n(r.spawned_at),
      endedAt: n(r.ended_at),
      lastActivityAt: n(r.last_activity_at),
    };
  }
  insertNode(x: { runId: string; id: string; appId: string | null; tier: string; role: string; platform: string | null; parentId: string | null; slot: string; alsoLead: boolean; model: ModelRef | null; scopeGlobs: string[]; branch: string | null; briefMd: string | null }): void {
    this.run(
      `INSERT INTO nodes(id, run_id, app_id, tier, role, platform, parent_id, status, also_lead, slot, model_json, scope_globs, branch, brief_md, created_at, provider_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?, ?)`,
      x.id, x.runId, x.appId, x.tier, x.role, x.platform, x.parentId, x.alsoLead ? 1 : 0, x.slot, js(x.model), js(x.scopeGlobs), x.branch, x.briefMd, this.now(), x.model?.providerId ?? null,
    );
  }
  getNode(runId: string, id: string): NodeInfo | null {
    const r = this.get1("SELECT * FROM nodes WHERE run_id = ? AND id = ?", runId, id);
    return r ? this.toNode(r) : null;
  }
  nodeByThread(threadId: string): NodeInfo | null {
    const r = this.get1("SELECT * FROM nodes WHERE thread_id = ?", threadId);
    return r ? this.toNode(r) : null;
  }
  listNodes(runId: string): NodeInfo[] {
    return this.all("SELECT * FROM nodes WHERE run_id = ? ORDER BY created_at, id", runId).map((r) => this.toNode(r));
  }
  nodesByStatus(runId: string, statuses: NodeStatus[]): NodeInfo[] {
    const q = statuses.map(() => "?").join(",");
    return this.all(`SELECT * FROM nodes WHERE run_id = ? AND status IN (${q}) ORDER BY created_at, id`, runId, ...statuses).map((r) => this.toNode(r));
  }
  childrenOf(runId: string, id: string): NodeInfo[] {
    return this.all("SELECT * FROM nodes WHERE run_id = ? AND parent_id = ? ORDER BY created_at, id", runId, id).map((r) => this.toNode(r));
  }
  nodeBrief(runId: string, id: string): string | null {
    return s(this.get1("SELECT brief_md FROM nodes WHERE run_id = ? AND id = ?", runId, id)?.brief_md);
  }
  nodeEnvironment(runId: string, id: string): string | null {
    return s(this.get1("SELECT environment_id FROM nodes WHERE run_id = ? AND id = ?", runId, id)?.environment_id);
  }
  nodeFlags(runId: string, id: string): { firstInLine: boolean; nudgedAt: number | null; lastReportForwardAt: number | null; prevStatus: NodeStatus | null } {
    const r = this.get1("SELECT first_in_line, nudged_at, last_report_forward_at, prev_status FROM nodes WHERE run_id = ? AND id = ?", runId, id) ?? {};
    return { firstInLine: b(r.first_in_line), nudgedAt: n(r.nudged_at), lastReportForwardAt: n(r.last_report_forward_at), prevStatus: (s(r.prev_status) as NodeStatus) ?? null };
  }
  countNonPlanned(runId: string): number {
    return Number(this.get1("SELECT COUNT(*) AS c FROM nodes WHERE run_id = ? AND status <> 'planned'", runId)?.c ?? 0);
  }
  countAllNonPlanned(): number {
    return Number(this.get1("SELECT COUNT(*) AS c FROM nodes n JOIN runs r ON r.id = n.run_id WHERE r.status IN ('running','paused') AND n.status <> 'planned'")?.c ?? 0);
  }
  updateNode(runId: string, id: string, patch: Partial<{ status: NodeStatus; threadId: string | null; model: ModelRef | null; modelOverride: boolean; briefMd: string; briefVersion: number; scopeGlobs: string[]; branch: string | null; environmentId: string | null; priority: string; nowLine: string | null; topics: string[]; tokens: number; turns: number; cost: number; spawnedAt: number; endedAt: number | null; lastActivityAt: number; touched: boolean; warning: string | null; firstInLine: boolean; nudgedAt: number | null; lastReportForwardAt: number; parentId: string | null; prevStatus: NodeStatus | null; providerId: string | null }>): void {
    const map: Record<string, [string, (v: never) => Param]> = {
      status: ["status", (v: string) => v],
      threadId: ["thread_id", (v: string | null) => v],
      model: ["model_json", (v: ModelRef | null) => js(v)],
      modelOverride: ["model_override", (v: boolean) => (v ? 1 : 0)],
      briefMd: ["brief_md", (v: string) => v],
      briefVersion: ["brief_version", (v: number) => v],
      scopeGlobs: ["scope_globs", (v: string[]) => js(v)],
      branch: ["branch", (v: string | null) => v],
      environmentId: ["environment_id", (v: string | null) => v],
      priority: ["priority", (v: string) => v],
      nowLine: ["now_line", (v: string | null) => v],
      topics: ["topics", (v: string[]) => js(v)],
      tokens: ["tokens", (v: number) => v],
      turns: ["turns", (v: number) => v],
      cost: ["cost", (v: number) => v],
      spawnedAt: ["spawned_at", (v: number) => v],
      endedAt: ["ended_at", (v: number | null) => v],
      lastActivityAt: ["last_activity_at", (v: number) => v],
      touched: ["touched", (v: boolean) => (v ? 1 : 0)],
      warning: ["warning", (v: string | null) => v],
      firstInLine: ["first_in_line", (v: boolean) => (v ? 1 : 0)],
      nudgedAt: ["nudged_at", (v: number | null) => v],
      lastReportForwardAt: ["last_report_forward_at", (v: number) => v],
      parentId: ["parent_id", (v: string | null) => v],
      prevStatus: ["prev_status", (v: string | null) => v],
      providerId: ["provider_id", (v: string | null) => v],
    };
    const sets: string[] = [];
    const vals: Param[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const m = map[k];
      if (!m || v === undefined) continue;
      sets.push(`${m[0]} = ?`);
      vals.push(m[1](v as never));
    }
    if (sets.length) this.run(`UPDATE nodes SET ${sets.join(", ")} WHERE run_id = ? AND id = ?`, ...vals, runId, id);
  }
  runningByProvider(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.all("SELECT n.provider_id AS p, COUNT(*) AS c FROM nodes n JOIN runs r ON r.id = n.run_id WHERE r.status IN ('running','paused') AND n.status = 'running' GROUP BY n.provider_id"))
      if (r.p) out[String(r.p)] = Number(r.c);
    return out;
  }
  countRunning(runId?: string): number {
    if (runId) return Number(this.get1("SELECT COUNT(*) AS c FROM nodes WHERE run_id = ? AND status = 'running'", runId)?.c ?? 0);
    return Number(this.get1("SELECT COUNT(*) AS c FROM nodes n JOIN runs r ON r.id = n.run_id WHERE r.status IN ('running','paused') AND n.status = 'running'")?.c ?? 0);
  }

  // ───────────── node events, comms, reports ─────────────
  event(runId: string, nodeId: string, kind: string, summary: string, ref: string | null = null): void {
    this.run("INSERT INTO node_events(run_id, node_id, ts, kind, summary, ref) VALUES (?, ?, ?, ?, ?, ?)", runId, nodeId, this.now(), kind, summary.slice(0, 600), ref);
  }
  events(runId: string, nodeId: string, limit = 50): NodeEventInfo[] {
    return this.all("SELECT * FROM node_events WHERE run_id = ? AND node_id = ? ORDER BY id DESC LIMIT ?", runId, nodeId, limit).map((r) => ({
      id: Number(r.id),
      runId: String(r.run_id),
      nodeId: String(r.node_id),
      ts: Number(r.ts),
      kind: String(r.kind),
      summary: String(r.summary ?? ""),
      ref: s(r.ref),
    }));
  }
  comms(runId: string, c: { from: string; to: string; kind: string; summary: string; directiveId?: string | null }): void {
    this.run("INSERT INTO comms(run_id, ts, from_node, to_node, kind, summary, directive_id) VALUES (?, ?, ?, ?, ?, ?, ?)", runId, this.now(), c.from, c.to, c.kind, c.summary.slice(0, 600), c.directiveId ?? null);
  }
  commsFor(runId: string, nodeId: string, limit = 100): CommsInfo[] {
    return this.all("SELECT * FROM comms WHERE run_id = ? AND (from_node = ? OR to_node = ?) ORDER BY id DESC LIMIT ?", runId, nodeId, nodeId, limit).map((r) => ({
      id: Number(r.id),
      runId: String(r.run_id),
      ts: Number(r.ts),
      fromNode: String(r.from_node),
      toNode: String(r.to_node),
      kind: String(r.kind),
      summary: String(r.summary ?? ""),
      directiveId: s(r.directive_id),
    }));
  }
  addReport(runId: string, nodeId: string, rep: { status: string; summary: string; evidence: unknown[]; verified: boolean; problems: string[] }): void {
    this.run("INSERT INTO reports(run_id, node_id, ts, status, summary, evidence_json, verified, problems_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", runId, nodeId, this.now(), rep.status, rep.summary.slice(0, 600), js(rep.evidence), rep.verified ? 1 : 0, js(rep.problems));
  }
  reportsFor(runId: string, nodeId: string, limit = 50): ReportInfo[] {
    return this.all("SELECT * FROM reports WHERE run_id = ? AND node_id = ? ORDER BY id DESC LIMIT ?", runId, nodeId, limit).map((r) => ({
      id: Number(r.id),
      runId: String(r.run_id),
      nodeId: String(r.node_id),
      ts: Number(r.ts),
      status: r.status as ReportInfo["status"],
      summary: String(r.summary ?? ""),
      evidence: j(r.evidence_json, []),
      verified: b(r.verified),
      problems: j(r.problems_json, []),
    }));
  }
  lastVerifiedDone(runId: string, nodeId: string): ReportInfo | null {
    const r = this.get1("SELECT * FROM reports WHERE run_id = ? AND node_id = ? AND status = 'done' AND verified = 1 ORDER BY id DESC LIMIT 1", runId, nodeId);
    return r ? this.reportsFor(runId, nodeId, 200).find((x) => x.id === Number(r.id)) ?? null : null;
  }

  // ───────────── directives + recipients ─────────────
  insertDirective(d: Omit<DirectiveInfo, "recipients">): void {
    this.run(
      `INSERT INTO directives(id, run_id, ts, type, target_node_id, cascade, mode, policy, text, value_json, model_from_json, model_to_json, affected_json, actor, by_node, implicit, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      d.id, d.runId, d.ts, d.type, d.targetNodeId, d.cascade, d.mode, d.policy ? 1 : 0, d.text, js(d.value), js(d.modelFrom), js(d.modelTo), js(d.affected), d.actor, d.byNode ?? null, d.implicit ? 1 : 0, d.summary,
    );
  }
  insertRecipient(runId: string, r: Omit<RecipientInfo, "deliveredAt" | "ackAt" | "ackNote"> & { outboxId: string | null }): void {
    this.run(
      "INSERT INTO directive_recipients(run_id, directive_id, node_id, level, world, state, outbox_id, notice) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      runId, r.directiveId, r.nodeId, r.level, r.world ? 1 : 0, r.state, r.outboxId, r.notice,
    );
  }
  private toRecipient(r: Row): RecipientInfo {
    return {
      directiveId: String(r.directive_id),
      nodeId: String(r.node_id),
      level: r.level as RecipientInfo["level"],
      world: b(r.world),
      state: r.state as RecipientInfo["state"],
      notice: String(r.notice ?? ""),
      deliveredAt: n(r.delivered_at),
      ackAt: n(r.ack_at),
      ackNote: s(r.ack_note),
    };
  }
  recipients(runId: string, directiveId: string): RecipientInfo[] {
    return this.all("SELECT * FROM directive_recipients WHERE run_id = ? AND directive_id = ?", runId, directiveId).map((r) => this.toRecipient(r));
  }
  recipientByOutbox(outboxId: string): (RecipientInfo & { runId: string }) | null {
    const r = this.get1("SELECT * FROM directive_recipients WHERE outbox_id = ?", outboxId);
    return r ? { ...this.toRecipient(r), runId: String(r.run_id) } : null;
  }
  recipientsByOutbox(outboxId: string): Array<RecipientInfo & { runId: string }> {
    return this.all("SELECT * FROM directive_recipients WHERE outbox_id = ?", outboxId).map((r) => ({ ...this.toRecipient(r), runId: String(r.run_id) }));
  }
  updateRecipient(runId: string, directiveId: string, nodeId: string, patch: Partial<{ state: string; deliveredAt: number; ackAt: number; ackNote: string; outboxId: string; reminded: boolean; queuedMessageId: string | null }>): void {
    const map: Record<string, [string, (v: never) => Param]> = {
      queuedMessageId: ["queued_message_id", (v: string | null) => v],
      state: ["state", (v: string) => v],
      deliveredAt: ["delivered_at", (v: number) => v],
      ackAt: ["ack_at", (v: number) => v],
      ackNote: ["ack_note", (v: string) => v],
      outboxId: ["outbox_id", (v: string) => v],
      reminded: ["reminded", (v: boolean) => (v ? 1 : 0)],
    };
    const sets: string[] = [];
    const vals: Param[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const m = map[k];
      if (!m || v === undefined) continue;
      sets.push(`${m[0]} = ?`);
      vals.push(m[1](v as never));
    }
    if (sets.length) this.run(`UPDATE directive_recipients SET ${sets.join(", ")} WHERE run_id = ? AND directive_id = ? AND node_id = ?`, ...vals, runId, directiveId, nodeId);
  }
  recipientsByQueuedMessage(queuedMessageId: string): Array<RecipientInfo & { runId: string }> {
    return this.all("SELECT * FROM directive_recipients WHERE queued_message_id = ?", queuedMessageId).map((r) => ({ ...this.toRecipient(r), runId: String(r.run_id) }));
  }
  recipientsInState(runId: string, states: string[]): Array<RecipientInfo> {
    const q = states.map(() => "?").join(",");
    return this.all(`SELECT * FROM directive_recipients WHERE run_id = ? AND state IN (${q})`, runId, ...states).map((r) => this.toRecipient(r));
  }
  recipientReminded(runId: string, directiveId: string, nodeId: string): boolean {
    return b(this.get1("SELECT reminded FROM directive_recipients WHERE run_id = ? AND directive_id = ? AND node_id = ?", runId, directiveId, nodeId)?.reminded);
  }
  unackedFor(runId: string, nodeId: string): RecipientInfo[] {
    return this.all("SELECT * FROM directive_recipients WHERE run_id = ? AND node_id = ? AND level IN ('direct','full') AND state IN ('queued','delivered') ORDER BY directive_id", runId, nodeId).map((r) => this.toRecipient(r));
  }
  queuedForNode(runId: string, nodeId: string): Array<RecipientInfo> {
    return this.all("SELECT * FROM directive_recipients WHERE run_id = ? AND node_id = ? AND state = 'queued' AND outbox_id IS NULL", runId, nodeId).map((r) => this.toRecipient(r));
  }
  private toDirective(r: Row): DirectiveInfo {
    return {
      id: String(r.id),
      runId: String(r.run_id),
      ts: Number(r.ts),
      type: r.type as DirectiveInfo["type"],
      targetNodeId: String(r.target_node_id),
      cascade: r.cascade as DirectiveInfo["cascade"],
      mode: r.mode as DirectiveInfo["mode"],
      policy: b(r.policy),
      text: String(r.text ?? ""),
      value: j(r.value_json, null),
      modelFrom: j(r.model_from_json, null),
      modelTo: j(r.model_to_json, null),
      affected: j(r.affected_json, []),
      actor: (r.actor as DirectiveInfo["actor"]) ?? "human",
      byNode: s(r.by_node),
      implicit: b(r.implicit),
      summary: String(r.summary ?? ""),
      recipients: this.recipients(String(r.run_id), String(r.id)),
    };
  }
  getDirective(runId: string, id: string): DirectiveInfo | null {
    const r = this.get1("SELECT * FROM directives WHERE run_id = ? AND id = ?", runId, id);
    return r ? this.toDirective(r) : null;
  }
  listDirectives(runId: string, limit = 500): DirectiveInfo[] {
    return this.all("SELECT * FROM directives WHERE run_id = ? ORDER BY ts DESC, id DESC LIMIT ?", runId, limit).map((r) => this.toDirective(r));
  }
  directivesTouching(runId: string, nodeId: string): DirectiveInfo[] {
    return this.all(
      // every directive this node was told about, plus those it issued as a supervisor
      "SELECT d.* FROM directives d WHERE d.run_id = ? AND (d.by_node = ? OR EXISTS (SELECT 1 FROM directive_recipients r WHERE r.run_id = d.run_id AND r.directive_id = d.id AND r.node_id = ?)) ORDER BY d.ts DESC, d.id DESC",
      runId, nodeId, nodeId,
    ).map((r) => this.toDirective(r));
  }
  directivesBeforeSpawn(runId: string, nodeId: string): DirectiveInfo[] {
    return this.all(
      "SELECT d.* FROM directives d JOIN directive_recipients r ON r.run_id = d.run_id AND r.directive_id = d.id WHERE d.run_id = ? AND r.node_id = ? AND r.level = 'direct' AND r.state = 'queued' AND r.outbox_id IS NULL ORDER BY d.ts",
      runId, nodeId,
    ).map((r) => this.toDirective(r));
  }

  // ───────────── error journal ─────────────
  recordError(e: { level: ErrorLevel; source: string; at: string; runId?: string | null; message: string; detail?: string | null }): void {
    this.run("INSERT INTO errors(ts, level, source, at, run_id, message, detail) VALUES (?, ?, ?, ?, ?, ?, ?)", this.now(), e.level, e.source.slice(0, 40), e.at.slice(0, 200), e.runId ?? null, e.message.slice(0, 2000), e.detail ? e.detail.slice(0, 4000) : null);
    this.run("DELETE FROM errors WHERE id <= (SELECT MAX(id) FROM errors) - 1000");
  }
  listErrors(opts: { limit?: number; since?: number; level?: ErrorLevel } = {}): ErrorEntry[] {
    return this.all(
      `SELECT * FROM errors WHERE ts >= ? ${opts.level ? "AND level = ?" : ""} ORDER BY id DESC LIMIT ?`,
      ...[opts.since ?? 0, ...(opts.level ? [opts.level] : []), opts.limit ?? 50],
    ).map((r) => ({ id: Number(r.id), ts: Number(r.ts), level: String(r.level) as ErrorLevel, source: String(r.source), at: String(r.at), runId: s(r.run_id), message: String(r.message), detail: s(r.detail) }));
  }
  countErrors(since: number): Record<ErrorLevel, number> {
    const out: Record<ErrorLevel, number> = { error: 0, warn: 0, user: 0 };
    for (const r of this.all("SELECT level, COUNT(*) AS c FROM errors WHERE ts >= ? GROUP BY level", since)) out[String(r.level) as ErrorLevel] = Number(r.c);
    return out;
  }
  clearErrors(): number {
    const n = Number((this.get1("SELECT COUNT(*) AS c FROM errors") as { c: number } | null)?.c ?? 0);
    this.run("DELETE FROM errors");
    return n;
  }

  // ───────────── inbox (FYI lines that must not wake an idle agent) ─────────────
  pushInbox(runId: string, nodeId: string, text: string, directiveId: string | null = null): void {
    this.run("INSERT INTO inbox(run_id, node_id, ts, text, directive_id) VALUES (?, ?, ?, ?, ?)", runId, nodeId, this.now(), text.slice(0, 800), directiveId);
  }
  unflushedInbox(runId: string, nodeId: string): Array<{ id: number; ts: number; text: string; directiveId: string | null }> {
    return this.all("SELECT * FROM inbox WHERE run_id = ? AND node_id = ? AND flushed_at IS NULL ORDER BY id", runId, nodeId).map((r) => ({ id: Number(r.id), ts: Number(r.ts), text: String(r.text), directiveId: s(r.directive_id) }));
  }
  recentInbox(runId: string, nodeId: string, limit = 20): Array<{ id: number; ts: number; text: string; flushedAt: number | null }> {
    return this.all("SELECT * FROM inbox WHERE run_id = ? AND node_id = ? ORDER BY id DESC LIMIT ?", runId, nodeId, limit).map((r) => ({ id: Number(r.id), ts: Number(r.ts), text: String(r.text), flushedAt: n(r.flushed_at) }));
  }
  markInboxFlushed(ids: number[]): void {
    if (!ids.length) return;
    const t = this.now();
    for (const id of ids) this.run("UPDATE inbox SET flushed_at = ? WHERE id = ?", t, id);
  }

  // ───────────── policies ─────────────
  insertPolicy(p: PolicyInfo): void {
    this.run("INSERT INTO policies(id, run_id, text, scope_node_id, from_directive, created_at, retired_at) VALUES (?, ?, ?, ?, ?, ?, ?)", p.id, p.runId, p.text, p.scopeNodeId, p.fromDirective, p.createdAt, p.retiredAt);
  }
  listPolicies(runId: string, includeRetired = false): PolicyInfo[] {
    return this.all(`SELECT * FROM policies WHERE run_id = ? ${includeRetired ? "" : "AND retired_at IS NULL"} ORDER BY created_at`, runId).map((r) => ({
      id: String(r.id),
      runId: String(r.run_id),
      text: String(r.text),
      scopeNodeId: String(r.scope_node_id),
      fromDirective: s(r.from_directive),
      createdAt: Number(r.created_at),
      retiredAt: n(r.retired_at),
    }));
  }
  retirePolicy(runId: string, id: string): void {
    this.run("UPDATE policies SET retired_at = ? WHERE run_id = ? AND id = ?", this.now(), runId, id);
  }

  // ───────────── outbox ─────────────
  enqueue(o: { id: string; runId: string; kind: string; nodeId: string | null; payload: unknown; idemKey: string; notBefore?: number }): boolean {
    const exists = this.get1("SELECT id FROM outbox WHERE idem_key = ?", o.idemKey);
    if (exists) return false;
    this.run(
      "INSERT INTO outbox(id, run_id, kind, node_id, payload_json, idem_key, state, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)",
      o.id, o.runId, o.kind, o.nodeId, js(o.payload), o.idemKey, o.notBefore ?? this.now(), this.now(),
    );
    return true;
  }
  outboxByIdem(idemKey: string): OutboxRow | null {
    const r = this.get1("SELECT rowid AS _seq, * FROM outbox WHERE idem_key = ?", idemKey);
    return r ? toOutbox(r) : null;
  }
  getOutbox(id: string): OutboxRow | null {
    const r = this.get1("SELECT rowid AS _seq, * FROM outbox WHERE id = ?", id);
    return r ? toOutbox(r) : null;
  }
  dueOutbox(now: number, limit = 64): OutboxRow[] {
    return this.all("SELECT rowid AS _seq, * FROM outbox WHERE state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY rowid LIMIT ?", now, limit).map(toOutbox);
  }
  inflightOutbox(): OutboxRow[] {
    return this.all("SELECT rowid AS _seq, * FROM outbox WHERE state = 'inflight' ORDER BY rowid").map(toOutbox);
  }
  outboxForRun(runId: string, states?: string[]): OutboxRow[] {
    if (!states) return this.all("SELECT rowid AS _seq, * FROM outbox WHERE run_id = ? ORDER BY rowid", runId).map(toOutbox);
    const q = states.map(() => "?").join(",");
    return this.all(`SELECT rowid AS _seq, * FROM outbox WHERE run_id = ? AND state IN (${q}) ORDER BY rowid`, runId, ...states).map(toOutbox);
  }
  pendingForNode(nodeId: string, runId: string): OutboxRow[] {
    return this.all("SELECT rowid AS _seq, * FROM outbox WHERE run_id = ? AND node_id = ? AND state IN ('pending','inflight') ORDER BY rowid", runId, nodeId).map(toOutbox);
  }
  nextOutboxAttempt(): number | null {
    return n(this.get1("SELECT MIN(next_attempt_at) AS t FROM outbox WHERE state = 'pending'")?.t);
  }
  markOutbox(id: string, patch: Partial<{ state: string; attempts: number; nextAttemptAt: number | null; lastError: string | null; doneAt: number; result: unknown }>): void {
    const map: Record<string, [string, (v: never) => Param]> = {
      state: ["state", (v: string) => v],
      attempts: ["attempts", (v: number) => v],
      nextAttemptAt: ["next_attempt_at", (v: number | null) => v],
      lastError: ["last_error", (v: string | null) => (v ? v.slice(0, 600) : v)],
      doneAt: ["done_at", (v: number) => v],
      result: ["result_json", (v: unknown) => js(v)],
    };
    const sets: string[] = [];
    const vals: Param[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const m = map[k];
      if (!m || v === undefined) continue;
      sets.push(`${m[0]} = ?`);
      vals.push(m[1](v as never));
    }
    if (sets.length) this.run(`UPDATE outbox SET ${sets.join(", ")} WHERE id = ?`, ...vals, id);
  }

  // ───────────── findings, checks, verdicts ─────────────
  insertFinding(f: FindingInfo): void {
    this.run(
      `INSERT INTO findings(id, run_id, app_id, gate, rule, severity, path, line, quote, why, fix, commit_sha, status, round, waiver_directive_id, created_at, owner_node_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      f.id, f.runId, f.appId, f.gate, f.rule, f.severity, f.path, f.line, f.quote, f.why, f.fix, f.commitSha, f.status, f.round, f.waiverDirectiveId, f.createdAt, f.ownerNodeId,
    );
  }
  private toFinding(r: Row): FindingInfo {
    return {
      id: String(r.id),
      runId: String(r.run_id),
      appId: String(r.app_id),
      gate: r.gate as FindingInfo["gate"],
      rule: String(r.rule),
      severity: r.severity as FindingInfo["severity"],
      path: String(r.path ?? ""),
      line: Number(r.line ?? 0),
      quote: String(r.quote ?? ""),
      why: String(r.why ?? ""),
      fix: String(r.fix ?? ""),
      commitSha: s(r.commit_sha),
      status: r.status as FindingInfo["status"],
      round: Number(r.round ?? 0),
      ownerNodeId: s(r.owner_node_id),
      waiverDirectiveId: s(r.waiver_directive_id),
      createdAt: Number(r.created_at ?? 0),
    };
  }
  findings(runId: string, appId?: string): FindingInfo[] {
    if (appId) return this.all("SELECT * FROM findings WHERE run_id = ? AND app_id = ? ORDER BY created_at, id", runId, appId).map((r) => this.toFinding(r));
    return this.all("SELECT * FROM findings WHERE run_id = ? ORDER BY created_at, id", runId).map((r) => this.toFinding(r));
  }
  getFinding(runId: string, id: string): FindingInfo | null {
    const r = this.get1("SELECT * FROM findings WHERE run_id = ? AND id = ?", runId, id);
    return r ? this.toFinding(r) : null;
  }
  updateFinding(runId: string, id: string, patch: Partial<{ status: string; ownerNodeId: string; waiverDirectiveId: string }>): void {
    if (patch.status) this.run("UPDATE findings SET status = ? WHERE run_id = ? AND id = ?", patch.status, runId, id);
    if (patch.ownerNodeId) this.run("UPDATE findings SET owner_node_id = ? WHERE run_id = ? AND id = ?", patch.ownerNodeId, runId, id);
    if (patch.waiverDirectiveId) this.run("UPDATE findings SET waiver_directive_id = ? WHERE run_id = ? AND id = ?", patch.waiverDirectiveId, runId, id);
  }
  insertCheck(c: CheckInfo): void {
    this.run(
      "INSERT INTO checks(id, run_id, app_id, name, command, status, exit_code, output_ref, commit_sha, tier, ts, node_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      c.id, c.runId, c.appId, c.name, c.command, c.status, c.exitCode, c.outputRef, c.commitSha, c.tier, c.ts, c.nodeId,
    );
  }
  checks(runId: string, appId: string): CheckInfo[] {
    return this.all("SELECT * FROM checks WHERE run_id = ? AND app_id = ? ORDER BY ts DESC", runId, appId).map((r) => ({
      id: String(r.id),
      runId: String(r.run_id),
      appId: String(r.app_id),
      name: String(r.name),
      command: String(r.command ?? ""),
      status: r.status as CheckInfo["status"],
      exitCode: n(r.exit_code),
      outputRef: s(r.output_ref),
      commitSha: s(r.commit_sha),
      tier: (r.tier as CheckInfo["tier"]) ?? "local",
      nodeId: s(r.node_id),
      ts: Number(r.ts),
    }));
  }
  insertVerdict(v: VerdictInfo & { runId: string; nodeId: string }): void {
    this.run(
      "INSERT INTO verdicts(id, run_id, app_id, gate, node_id, commit_sha, verdict, summary, checks_json, unverified_json, accepted, problems_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      v.id, v.runId, v.appId, v.gate, v.nodeId, v.commit, v.verdict, v.summary, js(v.checks), js(v.unverified), v.accepted ? 1 : 0, js(v.problems), v.ts,
    );
  }
  verdicts(runId: string, appId: string): VerdictInfo[] {
    return this.all("SELECT * FROM verdicts WHERE run_id = ? AND app_id = ? ORDER BY ts DESC", runId, appId).map((r) => ({
      id: String(r.id),
      appId: String(r.app_id),
      gate: r.gate as VerdictInfo["gate"],
      commit: String(r.commit_sha),
      verdict: r.verdict as VerdictInfo["verdict"],
      summary: String(r.summary ?? ""),
      checks: j(r.checks_json, []),
      unverified: j(r.unverified_json, []),
      accepted: b(r.accepted),
      problems: j(r.problems_json, []),
      ts: Number(r.ts),
    }));
  }

  // ───────────── needs ─────────────
  insertNeed(x: NeedInfo & { dedupeKey?: string | null }): boolean {
    if (x.dedupeKey) {
      const ex = this.get1("SELECT id FROM needs WHERE run_id = ? AND dedupe_key = ? AND state = 'open'", x.runId, x.dedupeKey);
      if (ex) return false;
    }
    this.run(
      `INSERT INTO needs(id, run_id, kind, node_id, title, body, evidence, options_json, interaction_id, state, created_at, resolved_at, resolution_json, app_id, dedupe_key, data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      x.id, x.runId, x.kind, x.nodeId, x.title, x.body, x.evidence, js(x.options), x.interactionId, x.state, x.createdAt, x.resolvedAt, js(x.resolution), x.appId, x.dedupeKey ?? null, js(x.data ?? null),
    );
    return true;
  }
  private toNeed(r: Row): NeedInfo {
    return {
      id: String(r.id),
      runId: String(r.run_id),
      kind: r.kind as NeedInfo["kind"],
      nodeId: s(r.node_id),
      appId: s(r.app_id),
      title: String(r.title ?? ""),
      body: String(r.body ?? ""),
      evidence: String(r.evidence ?? ""),
      options: j(r.options_json, []),
      interactionId: s(r.interaction_id),
      state: r.state as NeedInfo["state"],
      createdAt: Number(r.created_at ?? 0),
      resolvedAt: n(r.resolved_at),
      resolution: j(r.resolution_json, null),
      data: j(r.data_json, null),
    };
  }
  getNeed(runId: string, id: string): NeedInfo | null {
    const r = this.get1("SELECT * FROM needs WHERE run_id = ? AND id = ?", runId, id);
    return r ? this.toNeed(r) : null;
  }
  needByInteraction(interactionId: string): NeedInfo | null {
    const r = this.get1("SELECT * FROM needs WHERE interaction_id = ? ORDER BY created_at DESC LIMIT 1", interactionId);
    return r ? this.toNeed(r) : null;
  }
  listNeeds(runId: string, state?: "open" | "resolved"): NeedInfo[] {
    if (state) return this.all("SELECT * FROM needs WHERE run_id = ? AND state = ? ORDER BY created_at DESC", runId, state).map((r) => this.toNeed(r));
    return this.all("SELECT * FROM needs WHERE run_id = ? ORDER BY created_at DESC", runId).map((r) => this.toNeed(r));
  }
  openNeedsFor(runId: string, nodeId: string): NeedInfo[] {
    return this.all("SELECT * FROM needs WHERE run_id = ? AND node_id = ? AND state = 'open'", runId, nodeId).map((r) => this.toNeed(r));
  }
  resolveNeed(runId: string, id: string, resolution: unknown): void {
    this.run("UPDATE needs SET state = 'resolved', resolved_at = ?, resolution_json = ? WHERE run_id = ? AND id = ?", this.now(), js(resolution), runId, id);
  }

  // ───────────── models ─────────────
  seenModels(): Set<string> {
    return new Set(this.all("SELECT provider_id, model_id FROM seen_models").map((r) => `${r.provider_id}/${r.model_id}`));
  }
  acknowledgedModels(): Set<string> {
    return new Set(this.all("SELECT provider_id, model_id FROM seen_models WHERE acknowledged = 1").map((r) => `${r.provider_id}/${r.model_id}`));
  }
  touchSeen(providerId: string, modelId: string, acknowledge = false): void {
    const t = this.now();
    this.run(
      "INSERT INTO seen_models(provider_id, model_id, first_seen_at, last_seen_at, acknowledged) VALUES (?, ?, ?, ?, ?) ON CONFLICT(provider_id, model_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, acknowledged = MAX(acknowledged, excluded.acknowledged)",
      providerId, modelId, t, t, acknowledge ? 1 : 0,
    );
  }
  hiddenModels(): Set<string> {
    return new Set(this.all("SELECT provider_id, model_id FROM hidden_models").map((r) => `${r.provider_id}/${r.model_id}`));
  }
  setHidden(providerId: string, modelId: string, hidden: boolean): void {
    if (hidden) this.run("INSERT OR IGNORE INTO hidden_models(provider_id, model_id) VALUES (?, ?)", providerId, modelId);
    else this.run("DELETE FROM hidden_models WHERE provider_id = ? AND model_id = ?", providerId, modelId);
  }
  listPresets(): Array<{ name: string; slots: SlotMap; updatedAt: number }> {
    return this.all("SELECT * FROM slot_presets ORDER BY name").map((r) => ({ name: String(r.name), slots: j(r.slots_json, {}), updatedAt: Number(r.updated_at) }));
  }
  savePreset(name: string, slots: SlotMap): void {
    this.run("INSERT INTO slot_presets(name, slots_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET slots_json = excluded.slots_json, updated_at = excluded.updated_at", name, js(slots), this.now());
  }
  deletePreset(name: string): void {
    this.run("DELETE FROM slot_presets WHERE name = ?", name);
  }

  // ───────────── snapshots + observatory ─────────────
  saveSnapshot(id: string, runId: string, world: unknown): void {
    this.run("INSERT OR REPLACE INTO snapshots(id, run_id, ts, world_json) VALUES (?, ?, ?, ?)", id, runId, this.now(), js(world));
  }
  snapshots(runId: string): Array<{ id: string; ts: number }> {
    return this.all("SELECT id, ts FROM snapshots WHERE run_id = ? ORDER BY ts", runId).map((r) => ({ id: String(r.id), ts: Number(r.ts) }));
  }
  snapshot(id: string): unknown {
    return j(this.get1("SELECT world_json FROM snapshots WHERE id = ?", id)?.world_json, null);
  }
  adopt(runId: string, threadId: string, parentNodeId: string, title: string): void {
    this.run("INSERT OR REPLACE INTO observatory_adopted(run_id, thread_id, parent_node_id, adopted_at, title) VALUES (?, ?, ?, ?, ?)", runId, threadId, parentNodeId, this.now(), title);
  }
  adopted(runId: string): Array<{ threadId: string; parentNodeId: string; title: string; adoptedAt: number }> {
    return this.all("SELECT * FROM observatory_adopted WHERE run_id = ?", runId).map((r) => ({ threadId: String(r.thread_id), parentNodeId: String(r.parent_node_id), title: String(r.title ?? ""), adoptedAt: Number(r.adopted_at) }));
  }
  isHelmThread(threadId: string): boolean {
    return !!this.get1("SELECT 1 AS x FROM nodes WHERE thread_id = ?", threadId);
  }
}

export interface OutboxRow {
  /** Insertion order (SQLite rowid) — the per-node FIFO key. */
  seq: number;
  id: string;
  runId: string;
  kind: "spawn" | "send" | "update" | "stop" | "archive" | "project" | "file" | "compact" | "retry" | "interaction";
  nodeId: string | null;
  payload: Record<string, unknown>;
  idemKey: string;
  state: "pending" | "inflight" | "done" | "failed";
  attempts: number;
  nextAttemptAt: number | null;
  lastError: string | null;
  createdAt: number;
  doneAt: number | null;
  result: unknown;
}

function toOutbox(r: Row): OutboxRow {
  return {
    seq: Number(r._seq ?? 0),
    id: String(r.id),
    runId: String(r.run_id),
    kind: r.kind as OutboxRow["kind"],
    nodeId: s(r.node_id),
    payload: j(r.payload_json, {}),
    idemKey: String(r.idem_key),
    state: r.state as OutboxRow["state"],
    attempts: Number(r.attempts ?? 0),
    nextAttemptAt: n(r.next_attempt_at),
    lastError: s(r.last_error),
    createdAt: Number(r.created_at ?? 0),
    doneAt: n(r.done_at),
    result: j(r.result_json, null),
  };
}
