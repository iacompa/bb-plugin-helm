import { DatabaseSync } from "node:sqlite";
import { migrate, Repo, type SqlDb } from "../../src/server/db/repo.ts";
import { SimBB, VirtualClock } from "../../src/server/bb/sim.ts";
import { createSimAgents, type Profile } from "../../src/server/bb/sim-agents.ts";
import { Engine } from "../../src/server/engine/engine.ts";
import { installEventHandler, reconcile } from "../../src/server/engine/events.ts";
import { Planner } from "../../src/server/engine/planner.ts";
import { callTool } from "../../src/server/agent/tools.ts";
import { resolveNeed, type NeedResolution } from "../../src/server/engine/direct.ts";
import { sendback, signoff } from "../../src/server/engine/gates.ts";
import { DEFAULT_SETTINGS, type HelmSettings } from "../../src/server/engine/context.ts";
import { SEED_PRESETS } from "../../src/server/domain/models.ts";
import type { HelmThreadMeta } from "../../src/server/bb/port.ts";
import { rng } from "./rng.ts";

export interface Harness {
  db: DatabaseSync;
  repo: Repo;
  sim: SimBB;
  clock: VirtualClock;
  engine: Engine;
  agents: ReturnType<typeof createSimAgents>;
  settings: HelmSettings;
  resolve(runId: string, needId: string, res: NeedResolution): ReturnType<typeof resolveNeed>;
  planner: Planner;
  restart(): Promise<Harness>;
}

export const CHEAP = SEED_PRESETS["Cheap dev run"];

export async function createHarness(opts: { profileFor?: (m: HelmThreadMeta) => Profile; settings?: Partial<HelmSettings>; db?: DatabaseSync; sim?: SimBB; seed?: number } = {}): Promise<Harness> {
  const clock = opts.sim?.clock ?? new VirtualClock();
  const db = opts.db ?? new DatabaseSync(":memory:");
  migrate(db as unknown as SqlDb);
  const repo = new Repo(db as unknown as SqlDb, clock.now);
  const agents = createSimAgents(opts.profileFor ?? (() => "diligent"));
  const sim = opts.sim ?? new SimBB({ clock, turnMs: agents.turnMs });
  sim.driver = agents.driver;
  const settings: HelmSettings = { ...DEFAULT_SETTINGS, ...(opts.settings ?? {}), limits: { ...DEFAULT_SETTINGS.limits, ...(opts.settings?.limits ?? {}) } };
  const engine = new Engine({ repo, port: sim, settings: () => settings, rand: rng(opts.seed ?? 7) });
  installEventHandler(engine, { selfPluginIds: ["helm"] });
  const planner = new Planner(engine);
  planner.install();
  sim.toolCaller = async (name, threadId, params) => (await callTool(engine, name, threadId, params, { planner: (t, p) => planner.propose(t, p) })).text;
  await engine.init((id) => reconcile(engine, id));
  const h: Harness = {
    db,
    repo,
    sim,
    clock,
    engine,
    agents,
    settings,
    planner,
    resolve: (runId, needId, res) => resolveNeed(engine, runId, needId, res, { signoff: (a, d) => signoff(engine, runId, a, d), sendback: (a, d) => sendback(engine, runId, a, d) }),
    restart: async () => {
      engine.dispose();
      planner.dispose();
      return createHarness({ ...opts, db, sim });
    },
  };
  return h;
}
