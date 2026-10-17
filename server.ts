// Helm — plugin server entry. Wires storage, the real BB port, the engine,
// the helm_* agent tools, the `bb helm` CLI, RPC, realtime and the watchdog.
// The server makes no network calls of its own; it talks to BB through
// bb.sdk and to the machine through Helm's host entry.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { migrate, Repo, type SqlDb } from "./src/server/db/repo.ts";
import { RealBB } from "./src/server/bb/real.ts";
import { runDoctor } from "./src/server/bb/doctor.ts";
import { Engine } from "./src/server/engine/engine.ts";
import { installEventHandler, reconcile } from "./src/server/engine/events.ts";
import { callTool, TOOL_DEFS } from "./src/server/agent/tools.ts";
import { PLANNER_TOOLS, ROLES, toolsForNode } from "./src/server/domain/roles.ts";
import { instructionsFor, PLANNER_INSTRUCTIONS } from "./src/server/domain/briefs.ts";
import { Planner } from "./src/server/engine/planner.ts";
import { readMeta } from "./src/server/bb/port.ts";
import { HelmService } from "./src/server/service.ts";
import { buildCli } from "./src/server/cli.ts";
import { registerRpc } from "./src/server/rpc.ts";
import { Coalescer } from "./src/server/realtime.ts";
import { bindSettings } from "./src/server/settings.ts";
import { PLANNER_CHANNEL, RUNS_CHANNEL } from "./src/shared/protocol.ts";
import type { NodeInfo } from "./src/shared/types.ts";

/** Events that change what PORTFOLIO.md's machine block shows. */
const PORTFOLIO_EVENTS = new Set(["stage.changed", "need.created", "need.resolved", "directive.created", "plan.changed", "spawns.paused"]);

export default async function plugin(bb: BbPluginApi) {
  const log = { info: (m: string) => bb.log.info(m), warn: (m: string) => bb.log.warn(m), error: (m: string) => bb.log.error(m) };
  const settings = await bindSettings(bb);

  const db = bb.storage.database() as unknown as SqlDb;
  migrate(db);
  const repo = new Repo(db);
  const port = new RealBB(bb, { log: log.warn });
  port.install();

  let svc: HelmService | null = null;
  const realtime = new Coalescer((channel, payload) => bb.realtime.publish(channel, payload), port);
  const engine = new Engine({
    repo,
    port,
    settings,
    log,
    publish: (runId, event, payload) => {
      realtime.push(runId, event, payload);
      // the runs list (session tabs) shows status and open needs for every run, not just the one on screen
      if (event === "run.updated" || event === "need.created" || event === "need.resolved") bb.realtime.publish(RUNS_CHANNEL, { runId, event });
      if (PORTFOLIO_EVENTS.has(event)) svc?.portfolioChanged(runId);
    },
  });
  installEventHandler(engine, { selfPluginIds: [bb.pluginId] });
  svc = new HelmService(engine);
  const planner = new Planner(engine, (s) => bb.realtime.publish(PLANNER_CHANNEL, { id: s.id, status: s.status }));
  planner.install();
  svc.planner = planner;
  const plannerOpt = { planner: (threadId: string, portfolio: unknown) => planner.propose(threadId, portfolio) };

  // ───────── agent tools: registered once, exposed per tier, re-authorized on every call ─────────
  for (const def of TOOL_DEFS) {
    bb.agents.registerTool({
      name: def.name,
      description: def.description,
      presentation: def.presentation,
      parameters: def.parameters,
      execute: async (params, ctx) => {
        const r = await callTool(engine, def.name, ctx.threadId, params, plannerOpt);
        return r.isError ? { content: [{ type: "text", text: r.text }], isError: true } : r.text;
      },
    });
  }

  // The tool list is a hint for the session (V12); authority is the nodes row at execute time.
  bb.agents.configure((ctx) => {
    let node: NodeInfo | null = repo.nodeByThread(ctx.thread.id);
    if (!node && planner.isPlannerSpawn(readMeta({ helm: ctx.pluginMetadata.helm }), ctx.thread.id)) {
      // §7.7: the planner's only tool is helm_propose_plan
      return { tools: [...PLANNER_TOOLS], skills: ["helm"], instructions: PLANNER_INSTRUCTIONS };
    }
    if (!node) {
      // the first session can start before Helm has written the thread id: fall back to the spawn
      // metadata, but only for a node whose spawn is in flight, in a thread no other plugin started
      const meta = readMeta({ helm: ctx.pluginMetadata.helm });
      const cand = meta ? repo.getNode(meta.runId, meta.nodeId) : null;
      const foreignOrigin = !!ctx.origin?.pluginId && ctx.origin.pluginId !== bb.pluginId;
      if (cand && !foreignOrigin && ((!cand.threadId && cand.status === "queued") || cand.threadId === ctx.thread.id)) node = cand;
    }
    if (!node) return { tools: [], skills: ["helm", "helm-planner"] };
    const role = ROLES[node.role];
    const parent = node.parentId ? repo.getNode(node.runId, node.parentId) : null;
    const skills = [role.skill, ...(node.alsoLead ? ["helm-lead"] : [])];
    return {
      tools: toolsForNode(node.tier, node.alsoLead),
      skills,
      instructions: instructionsFor({ role: node.role, platform: node.platform, nodeId: node.id, parentLabel: parent ? engine.label(parent) : "the human", skill: role.skill, alsoLead: node.alsoLead }),
    };
  });

  bb.cli.register(buildCli(svc, { doctor: () => runDoctor(bb, port, repo, engine.settings, { tools: TOOL_DEFS.length, hook: true }) }));
  registerRpc(bb, svc);

  // Start once BB has bound the SDK: recover the outbox, subscribe, reconcile live runs.
  bb.background.service("engine", {
    async start(signal) {
      await engine.init((runId) => reconcile(engine, runId));
      for (const run of repo.activeRuns()) if (repo.portfolioDirty(run.id)) svc!.portfolioChanged(run.id);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  });

  // Stall detection reads Helm's own database only (§9.5); it never asks BB whether work is done.
  bb.background.schedule("watchdog", "*/5 * * * *", async () => {
    const r = await svc!.watchdog();
    if (r.nudged.length || r.stalled.length) log.info(`watchdog: nudged ${r.nudged.join(", ") || "none"}; stalled ${r.stalled.join(", ") || "none"}`);
  });

  bb.onDispose(() => {
    realtime.dispose();
    svc?.dispose();
    engine.dispose();
  });
}
