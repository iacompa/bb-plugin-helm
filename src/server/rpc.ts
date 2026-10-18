// RPC handlers (§10.2): thin shells over the service layer. Every mutation
// returns the updated entity; the engine emits the realtime patches.

import { needLook } from "./look.ts";
import { worktreesViewFor } from "./worktree-view.ts";
import { setGitLimits } from "./engine/worktrees.ts";
import { cleanDevices, devicesForPlatforms, DEVICE_CATALOG, MAX_DEVICES } from "../shared/devices.ts";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { ensureGitAgent, ensurePlanner } from "./engine/custom.ts";
import { RPC } from "../shared/protocol.ts";
import type { SlotMap } from "../shared/types.ts";
import type { HelmService } from "./service.ts";
import { appMove, moveTask, startAppNow } from "./engine/direct.ts";
import { validateRef } from "./domain/models.ts";
import type { TaskCol } from "./domain/stages.ts";
import { HelmError, SCREEN_DEVICES_KEY } from "./engine/engine.ts";
import { noticeFor, type NoticeDirective } from "./domain/directives.ts";
import { modelName } from "./domain/models.ts";
import { hhmm, pad4 } from "./engine/context.ts";
import type { ModelRef } from "../shared/types.ts";

const SELF_ONLY_TYPES = ["approve", "deny", "answer", "plan", "signoff", "sendback", "waive", "slots", "spawn"];
const NON_TOUCHING = ["approve", "deny", "answer", "plan", "slots"];

export function registerRpc(bb: BbPluginApi, svc: HelmService): void {
  const e = svc.engine;
  const primaryCatalog = async (refresh = false) => e.catalog(await e.port.primaryHostId(), refresh);
  bb.rpc.register(RPC, {
    client_error: ({ level, at, message, detail, runId }) => {
      svc.repo.recordError({ level: level ?? "error", source: "ui", at, runId: runId ?? null, message, detail: detail ?? null });
      return { ok: true };
    },
    run_list: () => ({ runs: svc.repo.listRuns().sort((a, b) => b.createdAt - a.createdAt).map((r) => ({ ...r, spend: e.spend(r.id), apps: svc.repo.listApps(r.id).length, needs: svc.repo.listNeeds(r.id, "open").length })) }),
    run_get: ({ runId }) => svc.snapshot(runId),
    run_create: ({ autonomy, ...input }) => svc.plan({ ...input, limits: { ...(input.limits ?? {}), ...(autonomy ? { autonomy } : {}) } } as never),
    run_setSlots: ({ runId, slots }) => svc.setSlots(runId, slots as SlotMap),
    run_readiness: ({ runId }) => svc.readiness(runId),
    settings_permissions: () => svc.permissions(),
    screens_list: async ({ runId, appId, fresh }) => {
      const apps = svc.screens.apps(runId);
      const id = appId && apps.some((a) => a.id === appId) ? appId : apps[0]?.id ?? null;
      const app = apps.find((a) => a.id === id);
      const picked = e.screenDevices();
      return { apps, appId: id, map: id ? await svc.screens.list(runId, id, !!fresh) : null, devices: { catalog: DEVICE_CATALOG, picked, forApp: app ? devicesForPlatforms(picked, app.platforms) : [], max: MAX_DEVICES } };
    },
    screens_image: ({ runId, appId, path }) => svc.screens.image(runId, appId, path),
    settings_setPermissions: (input) => svc.setPermissions(input as never),
    settings_models: () => svc.defaultModels(),
    settings_setModels: (input) => svc.setDefaultModels(input as never),
    worktrees_list: ({ runId, app }) => svc.worktrees(runId, app),
    worktrees_view: ({ runId, refresh }) => worktreesViewFor(e).view(runId, { refresh }),
    worktrees_reveal: ({ runId, path }) => worktreesViewFor(e).reveal(runId, path),
    git_setLimits: ({ runId, branches, worktrees }) => {
      const limits = setGitLimits(e, runId, { branches, worktrees });
      return { limits, view: worktreesViewFor(e).view(runId) };
    },
    screens_setDevices: ({ devices }) => {
      const picked = cleanDevices(devices);
      svc.repo.setMeta(SCREEN_DEVICES_KEY, JSON.stringify(picked));
      svc.screens.forget();
      return { picked };
    },
    git_open: async ({ runId }) => {
      const n = await ensureGitAgent(e, runId, { queue: true });
      return { nodeId: n.id, threadId: n.threadId, label: e.label(n) };
    },
    run_setLimits: ({ runId, concurrency, budgetCap, autonomy }) => svc.setLimits(runId, { concurrency, budgetCap, autonomy }),
    run_start: ({ runId, dryRun }) => svc.start(runId, { dryRun }),
    run_finish: ({ runId, status }) => svc.finish(runId, status),
    world_get: ({ runId }) => svc.world(runId),
    planner_open: async ({ runId, question }) => {
      if (question?.trim()) {
        const r = await svc.ask(runId, question);
        return { nodeId: r.planner.id, threadId: r.planner.threadId, label: e.label(r.planner), delivered: r.delivered };
      }
      const p = await ensurePlanner(e, runId, { queue: true });
      return { nodeId: p.id, threadId: p.threadId, label: e.label(p), delivered: null };
    },
    node_rename: ({ runId, nodeId, name }) => ({ label: svc.rename(runId, nodeId, name) }),
    agent_retire: ({ runId, nodeId, reason }) => ({ result: svc.retire(runId, nodeId, reason ?? "") }),
    node_get: ({ runId, nodeId }) => {
      const n = e.node(runId, nodeId);
      const run = e.run(runId);
      return {
        node: { ...n, label: e.label(n), model: n.model ?? e.effectiveModel(run, n) },
        brief: svc.repo.nodeBrief(runId, nodeId),
        events: svc.repo.events(runId, nodeId, 100),
        comms: svc.repo.commsFor(runId, nodeId, 100),
        reports: svc.repo.reportsFor(runId, nodeId, 50),
        directives: svc.repo.directivesTouching(runId, nodeId),
        inbox: svc.repo.recentInbox(runId, nodeId, 30),
        needs: svc.repo.openNeedsFor(runId, nodeId),
        children: svc.repo.childrenOf(runId, nodeId).map((c) => c.id),
      };
    },
    directive_preview: ({ runId, type, target, cascade }) => svc.preview(runId, { type, target, cascade }),
    directive_previewNotices: async ({ runId, type, target, cascade, text, value, modelTo }) => {
      const p = await svc.preview(runId, { type, target, cascade });
      const t = e.node(runId, target);
      const cat = await e.catalog(svc.repo.runHost(runId)).catch(() => null);
      const seq = Number((svc.repo.db.prepare("SELECT directive_seq AS v FROM runs WHERE id = ?").get(runId) as { v: number | null } | undefined)?.v ?? 0) + 1;
      const ts = e.now();
      const nodes = svc.repo.listNodes(runId);
      const affected = new Set(p.affected);
      const touchedCount = nodes.filter((n) => n.touched || (!NON_TOUCHING.includes(type) && affected.has(n.id))).length;
      const nd: NoticeDirective = { id: `D-${pad4(seq)}`, type, cascade: SELF_ONLY_TYPES.includes(type) ? "self" : cascade ?? "self", text: (text ?? "").trim(), value, modelFrom: type === "model" ? t.model : null, modelTo: (modelTo as ModelRef | null | undefined) ?? null, implicit: false, ts };
      const ctx = { targetName: e.label(t), briefVersion: type === "scope" ? t.briefVersion + 1 : t.briefVersion, modelName: (r: ModelRef | null | undefined) => modelName(cat, r), touchedCount, clock: hhmm(ts) };
      return { ...p, id: nd.id, recipients: p.recipients.map((r) => ({ ...r, notice: noticeFor(nd, r, ctx) })) };
    },
    app_get: ({ runId, appId }) => {
      const app = svc.repo.getApp(runId, appId);
      if (!app) throw new HelmError(`No app ${appId}.`, "not_found");
      return { app, verdicts: svc.repo.verdicts(runId, appId), checks: svc.repo.checks(runId, appId), findings: svc.repo.findings(runId, appId), stageHistory: svc.repo.stageHistory(runId, appId) };
    },
    directive_create: ({ runId, directive }) => svc.directive(runId, directive as never),
    ledger_list: ({ runId, limit }) => ({ directives: svc.repo.listDirectives(runId, limit ?? 300) }),
    needs_list: ({ runId, state }) => ({ needs: svc.repo.listNeeds(runId, state) }),
    needs_look: ({ runId, needId }) => needLook(svc.engine, runId, needId),
    needs_resolve: ({ runId, needId, ...res }) => svc.resolve(runId, needId, res as never),
    models_catalog: async (input) => {
      const cat = await primaryCatalog(!!input?.refresh);
      if (input?.markSeen) e.markSeen(cat);
      return cat;
    },
    models_validate: async ({ slots }) => {
      const cat = await primaryCatalog();
      return { problems: Object.entries(slots).flatMap(([slot, ref]) => {
        const p = validateRef(cat, ref as never);
        return p ? [{ slot, message: p.message }] : [];
      }) };
    },
    presets_list: () => ({ presets: svc.repo.listPresets() }),
    presets_save: ({ name, slots }) => {
      svc.repo.savePreset(name, slots as SlotMap);
      return { presets: svc.repo.listPresets() };
    },
    presets_delete: ({ name }) => {
      svc.repo.deletePreset(name);
      return { presets: svc.repo.listPresets() };
    },
    plan_preview: (input) => e.preview(input as never),
    board_moveApp: async ({ runId, appId, to, text }) => {
      const rule = appMove(e, runId, appId, to);
      if (!rule.ok) return rule;
      if ("noop" in rule && rule.noop) return rule;
      const act = (rule as { act: string }).act;
      if (act === "signoff") return { ok: true, result: await svc.signoffApp(runId, appId, text) };
      if (act === "sendback") {
        if (!text?.trim()) throw new HelmError("Send back needs a reason.", "invalid_value");
        return { ok: true, result: await svc.sendbackApp(runId, appId, text) };
      }
      if (act === "start") {
        startAppNow(e, runId, appId);
        return { ok: true, app: svc.repo.getApp(runId, appId) };
      }
      return { ok: false, why: "Reopening a signed-off app is not supported; start a new run for further work." };
    },
    board_moveTask: ({ runId, nodeId, to }) => moveTask(e, runId, nodeId, to as TaskCol),
    observatory_list: (input) => e.port.listForeignThreads({ limit: input?.limit ?? 200 }),
    settings_get: () => e.settings,
    outbox_retry: ({ outboxId }) => ({ ok: e.outbox.retry(outboxId) }),
    planner_start: ({ brief, model }) => svc.plannerStart({ brief, model: (model as ModelRef | undefined) ?? null }),
    planner_get: ({ id }) => svc.plannerGet(id),
    planchat_start: ({ model, text }) => svc.planChatStart({ model: (model as ModelRef | null | undefined) ?? null, text: text ?? null }),
  });
}
