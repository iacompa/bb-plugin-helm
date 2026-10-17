// The service layer: one set of functions behind the CLI, the RPC and the UI,
// so a directive sent from any surface is the same code path (§9 rules).

import type { Autonomy, DirectiveInfo, ModelRef, NodeInfo, Portfolio, RunInfo, SlotId, SlotMap } from "../shared/types.ts";
import { SLOT_IDS, SEED_PRESETS, modelName, validateRef } from "./domain/models.ts";
import { ORCH_ID } from "./domain/topology.ts";
import { createDirective, previewDirective, resolveNeed, type DirectiveInput, type NeedResolution } from "./engine/direct.ts";
import { HelmError, autonomyText, type Engine } from "./engine/engine.ts";
import { reconcile, watchdog } from "./engine/events.ts";
import { completeRun, sendback, signoff } from "./engine/gates.ts";
import { snapshot, world, worldBlock } from "./engine/world.ts";
import { replaceWorldBlock } from "./domain/briefs.ts";
import { hhmm } from "./engine/context.ts";
import { defaultPlannerModel, Planner } from "./engine/planner.ts";

export interface PlanInput {
  brief: string;
  portfolio?: Portfolio;
  name?: string;
  preset?: string;
  slots?: SlotMap;
  limits?: Record<string, number>;
  autoAdvance?: "ask" | "auto";
  /** Squad shape for every app that does not name one (D5 default: full). */
  shape?: "solo" | "lean" | "full";
  /** Parent folder for this run's new app repositories (default: the apps root setting). */
  appsRoot?: string;
}

/** "code=claude-code/claude-haiku-5-5:low" → [slot, ref]. */
export function parseSlotArg(s: string): [SlotId, ModelRef] {
  const m = s.match(/^([a-z]+)=([^/\s]+)\/([^:\s]+)(?::([a-z]+))?$/);
  if (!m) throw new HelmError(`Cannot read the slot ${JSON.stringify(s)}.`, "invalid_value", "Write it as slot=provider/model:reasoning, e.g. code=claude-code/claude-haiku-5-5:low");
  const slot = m[1] as SlotId;
  if (!SLOT_IDS.includes(slot)) throw new HelmError(`No slot named ${slot}.`, "invalid_value", `Slots: ${SLOT_IDS.join(", ")}`);
  return [slot, { providerId: m[2], modelId: m[3], reasoning: m[4] ?? null }];
}

export class HelmService {
  private portfolioTimers = new Map<string, () => void>();

  planner: Planner | null = null;

  constructor(readonly engine: Engine) {}

  // ───────── the planner (§7.7) ─────────

  /** Start a planner for a free-text brief. The model is the human's choice; D11 default: the code slot at medium. */
  async planChatStart(input: { model?: ModelRef | null; text?: string | null; preset?: string; slots?: SlotMap }) {
    if (!this.planner) throw new HelmError("The planner is not available.", "unavailable");
    const model = input.model ?? defaultPlannerModel(this.slotsFrom({ preset: input.preset, slots: input.slots }));
    if (!model) throw new HelmError("Choose a model for the planner.", "model_required");
    return this.planner.startChat({ model, text: input.text ?? null });
  }

  async plannerStart(input: { brief: string; model?: ModelRef | null; preset?: string; slots?: SlotMap }) {
    if (!this.planner) throw new HelmError("The planner is not available.", "unavailable");
    const model = input.model ?? defaultPlannerModel(this.slotsFrom({ preset: input.preset, slots: input.slots }));
    if (!model) throw new HelmError("Choose a planner model.", "model_required", "Pass --planner-model provider/model:reasoning, or a preset with a code slot.");
    return this.planner.start({ brief: input.brief, model });
  }

  plannerGet(id: string) {
    const s = this.planner?.get(id);
    if (!s) throw new HelmError(`No planner ${id}.`, "not_found");
    return s;
  }

  get repo() {
    return this.engine.repo;
  }

  // ───────── addressing ─────────

  /** The run a command means when none is given: the newest running run, else the newest run. */
  defaultRunId(): string | null {
    const runs = this.repo.listRuns().sort((a, b) => b.createdAt - a.createdAt);
    return (runs.find((r) => r.status === "running" || r.status === "paused") ?? runs[0])?.id ?? null;
  }

  runFor(runId?: string | null): RunInfo {
    const id = runId || this.defaultRunId();
    if (!id) throw new HelmError("There is no Helm run yet.", "not_found", "Create one with: bb helm plan --brief-file <file>");
    return this.engine.run(id);
  }

  /** A node by id, an app id or name (its lead), "orch"/"orchestrator", or a manager's group name. */
  nodeFor(runId: string, ref: string): NodeInfo {
    const r = ref.trim();
    const nodes = this.repo.listNodes(runId);
    const lower = r.toLowerCase();
    if (lower === "orchestrator") return this.repo.getNode(runId, ORCH_ID)!;
    const exact = nodes.find((n) => n.id === r) ?? nodes.find((n) => n.id.toLowerCase() === lower);
    if (exact) return exact;
    const app = this.repo.listApps(runId).find((a) => a.id === lower || a.name.toLowerCase() === lower);
    if (app) {
      const lead = this.engine.leadOf(runId, app.id);
      if (lead) return lead;
    }
    const byLabel = nodes.filter((n) => this.engine.label(n).toLowerCase() === lower);
    if (byLabel.length === 1) return byLabel[0];
    throw new HelmError(`No agent ${JSON.stringify(ref)} in this run.`, "not_found", "Use a node id such as ledgerly.ui, an app name (its lead) or orch. `bb helm world` lists them.");
  }

  appFor(runId: string, ref: string) {
    const lower = ref.trim().toLowerCase();
    const app = this.repo.listApps(runId).find((a) => a.id === lower || a.name.toLowerCase() === lower);
    if (!app) throw new HelmError(`No app ${JSON.stringify(ref)} in this run.`, "not_found");
    return app;
  }

  // ───────── planning and starting ─────────

  slotsFrom(input: { preset?: string; slots?: SlotMap }): SlotMap {
    let base: SlotMap = {};
    if (input.preset) {
      const saved = this.repo.listPresets().find((p) => p.name.toLowerCase() === input.preset!.toLowerCase());
      const seed = Object.entries(SEED_PRESETS).find(([k]) => k.toLowerCase() === input.preset!.toLowerCase())?.[1];
      const found = saved?.slots ?? seed;
      if (!found) throw new HelmError(`No preset named ${JSON.stringify(input.preset)}.`, "not_found", `Presets: ${[...Object.keys(SEED_PRESETS), ...this.repo.listPresets().map((p) => p.name)].join(", ")}`);
      base = { ...found };
    }
    return { ...base, ...(input.slots ?? {}) };
  }

  async plan(input: PlanInput) {
    const slots = this.slotsFrom(input);
    let portfolio = input.portfolio;
    if (input.shape) {
      const base = portfolio ?? this.engine.preview({ brief: input.brief, slots, limits: input.limits }).portfolio;
      portfolio = { ...base, apps: base.apps.map((a) => ({ ...a, shape: a.shape && a.shape !== "full" ? a.shape : input.shape })) };
    }
    const { runId, plan } = this.engine.createRun({ name: input.name, brief: input.brief, portfolio, slots, limits: input.limits, autoAdvance: input.autoAdvance, appsRoot: input.appsRoot });
    const pre = this.engine.preview({ portfolio, brief: input.brief, slots, limits: input.limits });
    const run = this.engine.run(runId);
    const loc = await this.engine.locationReport(runId);
    const problems = [...(await this.slotProblems(run)), ...loc.problems];
    return { runId, plan, forecast: pre.forecast, assumed: pre.assumed, problems, locations: loc.notes, runFolder: run.appsRoot };
  }

  /**
   * Change a run's limits while it runs (or before it starts): how many agents may run at once,
   * and the budget cap. Raising the cap above the spend lifts a budget pause. Recorded as an event
   * and told to the Orchestrator as one FYI line.
   */
  async setLimits(runId: string, input: { concurrency?: number; budgetCap?: number; autonomy?: Autonomy }) {
    const run = this.engine.run(runId);
    if (run.status === "done" || run.status === "cancelled") throw new HelmError(`The run is ${run.status}; its limits can no longer change.`, "bad_state");
    const changes: string[] = [];
    const limits = { ...run.limits };
    const patch: { concurrency?: number; budgetCap?: number; spawnsPaused?: boolean; limits?: typeof limits } = {};
    if (input.concurrency !== undefined && input.concurrency !== run.concurrency) {
      const c = Math.round(input.concurrency);
      if (!(c >= 1 && c <= 48)) throw new HelmError("Concurrency must be between 1 and 48.", "invalid_input");
      changes.push(`at most ${c} agents running at once (was ${run.concurrency})`);
      patch.concurrency = c;
      limits.concurrency = c;
    }
    if (input.budgetCap !== undefined && input.budgetCap !== run.budgetCap) {
      const cap = Number(input.budgetCap);
      if (!(cap > 0)) throw new HelmError("The budget cap must be above 0.", "invalid_input");
      changes.push(`budget cap ${Math.round(cap)} u (was ${Math.round(run.budgetCap)} u)`);
      patch.budgetCap = cap;
      limits.budgetCap = cap;
      if (run.spawnsPaused && cap > this.engine.spend(runId)) patch.spawnsPaused = false;
    }
    const autonomyOn = input.autonomy !== undefined && input.autonomy !== (run.limits.autonomy ?? "ask") ? input.autonomy : null;
    if (autonomyOn) {
      changes.push(autonomyOn === "high" ? "autonomy on: the Orchestrator decides everything except credentials, spending, private data and access" : "autonomy off: questions, waves and plan changes ask the human again");
      limits.autonomy = autonomyOn;
    }
    if (!changes.length) return this.engine.run(runId);
    patch.limits = limits;
    const text = `The human changed the run's limits: ${changes.join("; ")}.${patch.spawnsPaused === false ? " Spawns resume." : ""}`;
    this.repo.tx(() => {
      this.repo.updateRun(runId, patch);
      this.repo.event(runId, ORCH_ID, "limits", text);
      if (run.status !== "planning") this.repo.pushInbox(runId, ORCH_ID, text);
      // every live agent learns the new rule with its next Helm tool result (no extra turn)
      if (autonomyOn === "high" && run.status !== "planning")
        for (const n of this.repo.listNodes(runId).filter((x) => x.threadId && !["done", "idle", "failed"].includes(x.status)))
          this.repo.pushInbox(runId, n.id, `Autonomy is now on. ${autonomyText(n.id === ORCH_ID)}`);
    });
    this.engine.emit(runId, "run.updated", { id: runId, limits: true });
    if (run.status === "running") await this.engine.pump(runId);
    return this.engine.run(runId);
  }

  /** Read-only: can this planned run start, and what will Helm do with its folders? */
  async readiness(runId: string) {
    const run = this.engine.run(runId);
    if (run.status !== "planning") return { ok: false, status: run.status, problems: [`The run is ${run.status}; only a planned run can start.`], notes: [], runFolder: run.appsRoot };
    const loc = await this.engine.locationReport(runId);
    const problems = [...(await this.slotProblems(run)), ...loc.problems];
    return { ok: !problems.length, status: run.status, problems, notes: loc.notes, runFolder: run.appsRoot };
  }

  /** Which required slots are unset or unavailable on the live catalog. */
  async slotProblems(run: RunInfo): Promise<string[]> {
    const plan = this.engine.plan(run.id);
    const out: string[] = [];
    const cat = await this.engine.catalog(this.repo.runHost(run.id)).catch(() => null);
    for (const s of SLOT_IDS) {
      if (!plan.counts.bySlot[s]) continue;
      const r = run.slots[s];
      if (!r) {
        out.push(`${s}: no model chosen`);
        continue;
      }
      if (cat) {
        const p = validateRef(cat, r);
        if (p) out.push(`${s}: ${p.message}`);
      }
    }
    return out;
  }

  async setSlots(runId: string, slots: SlotMap) {
    const run = this.engine.run(runId);
    if (run.status !== "planning") throw new HelmError("Slots of a started run change through a directive (bb helm model, or the Model Studio).", "bad_state");
    this.repo.updateRun(runId, { slots: { ...run.slots, ...slots } });
    return this.engine.run(runId);
  }

  /**
   * Change which model roles use. A planned run just records it; a started run applies it
   * through a slots directive: "all" moves every agent in those roles now (another provider
   * means a new thread in the same workspace; failed agents retry), "future" only new spawns.
   */
  async changeSlots(runId: string, slots: SlotMap, scope: "all" | "future" = "all"): Promise<{ run: RunInfo; directive: DirectiveInfo | null }> {
    const ids = Object.keys(slots);
    if (!ids.length) throw new HelmError("Name at least one role and its model.", "invalid_value");
    const cat = await this.engine.catalog(this.repo.runHost(runId));
    for (const [slot, ref] of Object.entries(slots)) {
      const p = validateRef(cat, ref!);
      if (p) throw new HelmError(`${slot}: ${p.message}`, "invalid_value");
    }
    const run = this.engine.run(runId);
    if (run.status === "planning") return { run: await this.setSlots(runId, slots), directive: null };
    if (run.status === "done" || run.status === "cancelled") throw new HelmError(`${run.name} is ${run.status}; its models can no longer change.`, "bad_state");
    const text = `Models — ${ids.map((id) => `${id}: ${modelName(cat, slots[id as SlotId])}`).join("; ")} (${scope === "all" ? "every agent in these roles, now" : "future spawns"})`;
    const directive = await this.directive(runId, { type: "slots", target: ORCH_ID, slots, slotsScope: scope, text });
    return { run: this.engine.run(runId), directive };
  }

  async start(runId: string, opts: { dryRun?: boolean } = {}) {
    const r = await this.engine.startRun(runId, { dryRun: opts.dryRun });
    return { ...r, run: this.engine.run(runId) };
  }

  // ───────── directives and needs ─────────

  preview(runId: string, input: Pick<DirectiveInput, "type" | "target" | "cascade">) {
    return previewDirective(this.engine, runId, input);
  }

  async directive(runId: string, input: DirectiveInput): Promise<DirectiveInfo> {
    return createDirective(this.engine, runId, { actor: "human", ...input });
  }

  async resolve(runId: string, needId: string, res: NeedResolution) {
    const id = needId.toUpperCase().startsWith("N-") ? needId.toUpperCase() : `N-${needId}`;
    return resolveNeed(this.engine, runId, id, res, {
      signoff: (appId, d) => signoff(this.engine, runId, appId, d),
      sendback: (appId, d) => sendback(this.engine, runId, appId, d),
    });
  }

  /** Sign off an app by name: resolves its open sign-off card. */
  async signoffApp(runId: string, appRef: string, text?: string) {
    const app = this.appFor(runId, appRef);
    const need = this.repo.listNeeds(runId, "open").find((n) => n.kind === "signoff" && n.appId === app.id);
    if (!need) throw new HelmError(`${app.name} is not waiting for sign-off (it is in ${app.stage}).`, "bad_state");
    return this.resolve(runId, need.id, { action: "signoff", text });
  }

  async sendbackApp(runId: string, appRef: string, text: string) {
    const app = this.appFor(runId, appRef);
    const need = this.repo.listNeeds(runId, "open").find((n) => n.kind === "signoff" && n.appId === app.id);
    if (!need) throw new HelmError(`${app.name} is not waiting for sign-off (it is in ${app.stage}).`, "bad_state");
    return this.resolve(runId, need.id, { action: "sendback", text });
  }

  /** Complete or cancel a run: stop and archive every remaining agent (after the human confirms). */
  async finish(runId: string, status: "done" | "cancelled") {
    const run = this.engine.run(runId);
    if (run.status === "done" || run.status === "cancelled") throw new HelmError(`The run is already ${run.status}.`, "bad_state");
    if (status === "done") {
      const open = this.repo.listApps(runId).filter((a) => a.stage !== "done" && a.stage !== "cancelled");
      if (open.length) throw new HelmError(`${open.length} app${open.length === 1 ? " is" : "s are"} not signed off yet: ${open.map((a) => a.name).join(", ")}.`, "bad_state", "Sign them off, or cancel the run instead.");
    }
    await completeRun(this.engine, runId, status);
    return this.engine.run(runId);
  }

  // ───────── reads ─────────

  world(runId: string) {
    return world(this.engine, runId);
  }

  snapshot(runId: string) {
    return snapshot(this.engine, runId);
  }

  statusText(runId?: string | null): string {
    const id = runId || this.defaultRunId();
    if (!id) return "No Helm runs yet. Create one with: bb helm plan --brief-file <file>\n";
    const run = this.engine.run(id);
    const w = world(this.engine, id).run;
    const apps = this.repo.listApps(id);
    const needs = this.repo.listNeeds(id, "open");
    const lines = [
      `${run.name} (${run.id}) — ${run.status}${run.dryRun ? " · dry run" : ""}${run.spawnsPaused ? " · SPAWNS PAUSED" : ""}`,
      `agents: ${w.agents.spawned} spawned · ${w.agents.running} running · ${w.agents.queued} queued · ${w.agents.planned} planned (cap ${w.agents.cap}) · spend ${this.engine.spend(id).toFixed(1)} of ${run.budgetCap} u`,
      `apps: ${apps.map((a) => `${a.name} ${a.stage}`).join(" · ")}`,
      `needs you: ${needs.length ? needs.map((n) => `${n.id} ${n.title}`).join(" | ") : "nothing"}`,
    ];
    return `${lines.join("\n")}\n`;
  }

  ledgerText(runId: string, limit = 30): string {
    const ds = this.repo.listDirectives(runId, limit);
    if (!ds.length) return "No directives yet.\n";
    return (
      ds
        .map((d) => {
          const c = { queued: 0, delivered: 0, ack: 0, rec: 0, failed: 0 } as Record<string, number>;
          for (const r of d.recipients) c[r.state] = (c[r.state] ?? 0) + 1;
          const receipts = Object.entries(c)
            .filter(([, n]) => n)
            .map(([k, n]) => `${n} ${k}`)
            .join(", ");
          return `${d.id}  ${hhmm(d.ts)}  ${d.implicit ? "(typed in thread) " : ""}${d.summary}  [${receipts}]`;
        })
        .join("\n") + "\n"
    );
  }

  async modelsText(): Promise<string> {
    const host = await this.engine.port.primaryHostId();
    const cat = await this.engine.catalog(host, true);
    const out: string[] = [];
    for (const p of cat.providers) {
      out.push(`${p.label} (${p.id})${p.available ? "" : " — unavailable"}${p.error ? ` — ${p.error}` : ""}`);
      for (const m of cat.models.filter((x) => x.providerId === p.id && !x.hidden)) out.push(`  ${m.isNew ? "NEW " : "    "}${m.modelId}  ${m.name}  reasoning: ${m.reasoning.join("/") || "—"}${m.isDefault ? "  (default)" : ""}`);
    }
    const id = this.defaultRunId();
    if (id) {
      const run = this.engine.run(id);
      out.push("", `Slots of ${run.name}:`);
      for (const s of SLOT_IDS) if (run.slots[s]) out.push(`  ${s.padEnd(13)} ${modelName(cat, run.slots[s]!)}`);
    }
    return `${out.join("\n")}\n`;
  }

  async reconcileAll(): Promise<string[]> {
    const out: string[] = [];
    for (const run of this.repo.activeRuns()) {
      const r = await reconcile(this.engine, run.id);
      out.push(`${run.name}: checked ${r.checked}${r.changes.length ? `, ${r.changes.length} changes: ${r.changes.join("; ")}` : ", nothing to fix"}`);
    }
    this.engine.outbox.kick();
    return out;
  }

  watchdog() {
    return watchdog(this.engine);
  }

  exportRun(runId: string) {
    return { exportedAt: new Date(this.engine.now()).toISOString(), ...snapshot(this.engine, runId) };
  }

  // ───────── PORTFOLIO.md (the Orchestrator's memory, §8.6) ─────────

  /** Rewrite the machine block of PORTFOLIO.md at most once per 30 s per run. */
  portfolioChanged(runId: string): void {
    if (this.portfolioTimers.has(runId)) return;
    this.repo.updateRun(runId, { portfolioDirty: true });
    const cancel = this.engine.port.setTimeout(() => {
      this.portfolioTimers.delete(runId);
      void this.writePortfolio(runId).catch((e) => this.engine.log.warn(`PORTFOLIO.md update failed: ${String(e)}`));
    }, 30_000);
    this.portfolioTimers.set(runId, cancel);
  }

  async writePortfolio(runId: string): Promise<void> {
    const run = this.repo.getRun(runId);
    if (!run || !run.appsRoot || run.status === "planning") return;
    const path = `${this.engine.studioPath(run)}/PORTFOLIO.md`;
    const host = this.engine.host(runId);
    const cur = (await host.readFile({ path })).content ?? "";
    const next = replaceWorldBlock(cur, worldBlock(this.engine, runId));
    if (next !== cur) await host.writeFile({ path, content: next });
    this.repo.updateRun(runId, { portfolioDirty: false });
  }

  dispose(): void {
    this.planner?.dispose();
    for (const cancel of this.portfolioTimers.values()) cancel();
    this.portfolioTimers.clear();
  }
}
