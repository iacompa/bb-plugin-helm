// Incident: a 22-app run at concurrency 4 started, but nothing ever spawned. The four
// Managers took all four slots and waited for the Orchestrator's thread, while the
// Orchestrator waited for a slot. Supervisors now start first, children never hold a
// slot before their parent is on its way, and a run already stuck that way recovers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP } from "../helpers/harness.ts";
import { parseBrief, SAMPLE_BRIEF } from "../../src/server/domain/brief.ts";
import { admit, prioritize, type Eligible } from "../../src/server/domain/scheduler.ts";

const H = 3600_000;

test("the Orchestrator sorts before Managers even though m0… sorts before orch", () => {
  const base = { appPriority: "normal" as const, appStage: null, managerId: null, createdAt: 1, firstInLine: true, providerId: null };
  const nodes: Eligible[] = [...["m0", "m1", "m2", "m3", "m4"].map((id) => ({ ...base, nodeId: id, tier: "manager" as const })), { ...base, nodeId: "orch", tier: "orchestrator" }];
  assert.equal(prioritize(nodes)[0].nodeId, "orch");
  const r = admit(nodes, { concurrency: 4, running: 0, maxTotalAgents: 250, nonPlanned: 0, providerCaps: {}, runningByProvider: {}, spawnsPaused: false });
  assert.ok(r.start.includes("orch"), JSON.stringify(r));
});

test("a 20-app run at concurrency 4 starts: the Orchestrator gets a thread, then its Managers", async () => {
  const h = await createHarness();
  const portfolio = parseBrief(SAMPLE_BRIEF).portfolio;
  const { runId, plan } = h.engine.createRun({ name: "Tight", brief: SAMPLE_BRIEF, portfolio, slots: CHEAP, limits: { concurrency: 4 } });
  assert.ok(plan.counts.managers >= 4, "more managers than slots");
  const r = await h.engine.startRun(runId);
  assert.deepEqual(r.problems, []);
  const spawns = h.repo.outboxForRun(runId).filter((o) => o.kind === "spawn");
  assert.ok(spawns.some((o) => o.nodeId === "orch"), `orch spawn queued; got ${spawns.map((o) => o.nodeId).join(",")}`);
  await h.clock.runUntil(h.clock.now() + 2 * H, { stopWhen: () => h.repo.listNodes(runId).filter((n) => n.tier === "manager" && n.threadId).length >= 1 });
  assert.ok(h.repo.getNode(runId, "orch")!.threadId, "the Orchestrator has a thread");
  assert.ok(h.repo.listNodes(runId).some((n) => n.tier === "manager" && n.threadId), "managers follow");
});

test("a run already stuck (Managers' spawns holding every slot, no Orchestrator spawn) recovers on the next pump", async () => {
  const h = await createHarness();
  const portfolio = parseBrief(SAMPLE_BRIEF).portfolio;
  const { runId } = h.engine.createRun({ name: "Stuck", brief: SAMPLE_BRIEF, portfolio, slots: CHEAP, limits: { concurrency: 4 } });
  await h.engine.startRun(runId);
  // recreate the stuck state: drop the Orchestrator's spawn, give four Managers one each
  h.repo.db.prepare("DELETE FROM outbox WHERE run_id = ? AND kind = 'spawn'").run(runId);
  for (const id of ["m0", "m1", "m2", "m3"]) h.repo.enqueue({ id: `stuck-${id}`, runId, kind: "spawn", nodeId: id, payload: { nodeId: id, gen: 1 }, idemKey: `spawn:${runId}:${id}:1` });
  assert.ok(!h.repo.getNode(runId, "orch")!.threadId);
  await h.engine.pump(runId);
  assert.ok(h.repo.outboxForRun(runId).some((o) => o.kind === "spawn" && o.nodeId === "orch"), "the Orchestrator's spawn is queued");
  await h.clock.runUntil(h.clock.now() + 2 * H, { stopWhen: () => !!h.repo.getNode(runId, "m0")?.threadId });
  assert.ok(h.repo.getNode(runId, "orch")!.threadId);
  assert.ok(h.repo.getNode(runId, "m0")!.threadId, "the waiting Managers spawn once the Orchestrator exists");
});
