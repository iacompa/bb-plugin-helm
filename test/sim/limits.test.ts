// Incident: a run set to 4 agents at once could not be raised while running, and the agents
// of another live run counted against its 4. Concurrency is now per run, and a run's limits
// change live (bb helm limits, the capacity popover), with the Orchestrator told.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP } from "../helpers/harness.ts";
import { HelmService } from "../../src/server/service.ts";
import { parseBrief, SAMPLE_BRIEF } from "../../src/server/domain/brief.ts";

const H = 3600_000;
const five = () => {
  const p = parseBrief(SAMPLE_BRIEF).portfolio;
  return { ...p, apps: p.apps.slice(0, 5).map((a) => ({ ...a, group: null })) };
};
const live = (h: Awaited<ReturnType<typeof createHarness>>, runId: string) => h.repo.listNodes(runId).filter((n) => n.threadId).length;

test("one run's agents do not use up another run's concurrency", async () => {
  const h = await createHarness();
  const svc = new HelmService(h.engine);
  const a = h.engine.createRun({ name: "A", brief: "x", portfolio: five(), slots: CHEAP, limits: { concurrency: 4 } });
  await svc.start(a.runId);
  await h.clock.runUntil(h.clock.now() + 2 * H, { stopWhen: () => h.repo.countRunning(a.runId) >= 4 });
  const b = h.engine.createRun({ name: "B", brief: "x", portfolio: five(), slots: CHEAP, limits: { concurrency: 4 } });
  await svc.start(b.runId);
  await h.clock.runUntil(h.clock.now() + 2 * H, { stopWhen: () => !!h.repo.getNode(b.runId, "orch")?.threadId });
  assert.ok(h.repo.getNode(b.runId, "orch")!.threadId, "run B starts even while run A is at its limit");
});

test("raising concurrency on a running run lets waiting agents start, and the Orchestrator is told", async () => {
  const h = await createHarness();
  const svc = new HelmService(h.engine);
  const portfolio = parseBrief(SAMPLE_BRIEF).portfolio;
  const { runId } = h.engine.createRun({ name: "Tight", brief: SAMPLE_BRIEF, portfolio, slots: CHEAP, limits: { concurrency: 2 } });
  await svc.start(runId);
  await h.clock.runUntil(h.clock.now() + H, { stopWhen: () => live(h, runId) >= 2 });
  await h.clock.advance(10 * 60_000);
  const before = live(h, runId);
  const queued = h.repo.nodesByStatus(runId, ["queued"]).length;
  assert.ok(queued > 0, "agents are waiting for a slot");

  const r = await svc.setLimits(runId, { concurrency: 24 });
  assert.equal(r.concurrency, 24);
  assert.equal(h.engine.run(runId).limits.concurrency, 24, "the scheduler reads the new limit");
  await h.clock.runUntil(h.clock.now() + H, { stopWhen: () => live(h, runId) > before + 1 });
  assert.ok(live(h, runId) > before, `more agents spawned after raising the limit (${before} → ${live(h, runId)})`);
  const told = h.repo.recentInbox(runId, "orch", 50).some((l) => /changed the run's limits: at most 24 agents running at once \(was 2\)/.test(l.text));
  assert.ok(told, "the Orchestrator hears about it");
});

test("limits are validated, a budget raise lifts a budget pause, and finished runs refuse", async () => {
  const h = await createHarness();
  const svc = new HelmService(h.engine);
  const { runId } = h.engine.createRun({ name: "L", brief: "x", portfolio: five(), slots: CHEAP });
  await assert.rejects(svc.setLimits(runId, { concurrency: 0 }), /between 1 and 48/);
  await assert.rejects(svc.setLimits(runId, { budgetCap: 0 }), /above 0/);
  const planned = await svc.setLimits(runId, { concurrency: 12, budgetCap: 900 });
  assert.deepEqual([planned.concurrency, planned.budgetCap], [12, 900], "a plan's limits change before start too");
  h.repo.updateRun(runId, { spawnsPaused: true });
  await svc.setLimits(runId, { budgetCap: 5000 });
  assert.equal(h.engine.run(runId).spawnsPaused, false);
  await svc.finish(runId, "cancelled");
  await assert.rejects(svc.setLimits(runId, { concurrency: 8 }), /can no longer change/);
});
