// Fixes from the October 2026 audit: cards the human dismissed stay dismissed, "Nudge again" really
// nudges, "Stop run" on the budget card ends the run like `bb helm end`, an agent stopped while its
// thread was being made does not keep running, and messages to an agent with no thread never block.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP, type Harness } from "../helpers/harness.ts";
import { watchdog } from "../../src/server/engine/events.ts";
import { createDirective } from "../../src/server/engine/direct.ts";
import type { HelmThreadMeta } from "../../src/server/bb/port.ts";
import type { Profile } from "../../src/server/bb/sim-agents.ts";

const one = { apps: [{ name: "Alpha", tagline: "t", platforms: ["ios"] }], groups: [], assumptions: [], questions: [] };
const H = 3600_000;
const role = (r: string, p: Profile) => (m: HelmThreadMeta): Profile => (m.role === r ? p : "diligent");

async function run(h: Harness, limits: Record<string, number> = {}) {
  const { runId } = h.engine.createRun({ name: "Audit", brief: "x", portfolio: one as never, slots: CHEAP, limits });
  assert.deepEqual((await h.engine.startRun(runId)).problems, []);
  return runId;
}

test("a dismissed stalled card is not raised again for the same silence; Nudge again asks for a report", async () => {
  const h = await createHarness({ profileFor: role("ui", "silent") });
  const runId = await run(h);
  const { watcher: _w, ...noWatcher } = h.repo.getRun(runId)!.slots;
  h.repo.updateRun(runId, { slots: noWatcher });
  const ui = () => h.repo.listNodes(runId).find((n) => n.role === "ui")!;
  await h.clock.runUntil(h.clock.now() + 6 * H, { stopWhen: () => !!ui().threadId });
  const stall = h.repo.getRun(runId)!.limits.stallMinutes * 60_000;
  await h.clock.advance(stall + 60_000);
  await watchdog(h.engine);
  await h.clock.advance(stall + 60_000);
  await watchdog(h.engine);
  const card = () => h.repo.listNeeds(runId, "open").find((n) => n.kind === "stalled" && n.nodeId === ui().id);
  const first = card()!;
  assert.ok(first, "raised once");
  await h.resolve(runId, first.id, { action: "dismiss" });
  await h.clock.advance(10 * 60_000);
  await watchdog(h.engine);
  assert.equal(card(), undefined, "a dismissed card stays dismissed for the same silence");

  // a fresh silence raises a fresh card; Nudge again sends a status check and restarts the stall window
  h.repo.updateNode(runId, ui().id, { nudgedAt: h.clock.now() });
  await h.clock.advance(stall + 60_000);
  await watchdog(h.engine);
  const second = card()!;
  assert.ok(second, "a new stall episode is raised");
  const sends = () => h.repo.outboxForRun(runId).filter((o) => o.kind === "send" && o.nodeId === ui().id && /status check: the human asks/.test(String(o.payload.text))).length;
  await h.resolve(runId, second.id, { action: "nudge" });
  assert.equal(sends(), 1, "the agent is asked for a report");
  assert.equal(h.repo.nodeFlags(runId, ui().id).nudgedAt, h.clock.now());
});

test("Stop run on the budget card stops and archives every agent, the Planner and Git agent included", async () => {
  const h = await createHarness();
  const runId = await run(h, { budgetCap: 0.1 });
  await h.clock.runUntil(h.clock.now() + 6 * H, { stopWhen: () => h.repo.listNeeds(runId, "open").some((n) => n.kind === "budget") });
  const budget = h.repo.listNeeds(runId, "open").find((n) => n.kind === "budget")!;
  await h.resolve(runId, budget.id, { action: "stop_run" });
  assert.equal(h.repo.getRun(runId)!.status, "cancelled");
  assert.ok(h.repo.outboxForRun(runId).some((o) => o.kind === "archive" && o.idemKey === `archiveall:${runId}`), "everything is archived, as `bb helm end` does");
  assert.equal(h.repo.listNeeds(runId, "open").length, 0);
});

test("an agent stopped while its thread was being made is stopped, not left running", async () => {
  const h = await createHarness();
  const runId = await run(h);
  const orch = () => h.repo.getNode(runId, "orch")!;
  // stop the Orchestrator the moment BB is asked to make its thread
  const sim = h.sim as unknown as { spawnThread: (...a: unknown[]) => Promise<unknown> };
  const real = sim.spawnThread.bind(h.sim);
  let stopped = false;
  sim.spawnThread = async (...a: unknown[]) => {
    if (!stopped && orch().status === "queued") {
      stopped = true;
      await createDirective(h.engine, runId, { type: "stop", target: "orch", text: "not now" });
    }
    return real(...a);
  };
  await h.clock.runUntil(h.clock.now() + H, { stopWhen: () => !!orch().threadId });
  assert.ok(stopped, "the stop raced the spawn");
  assert.notEqual(orch().status, "running", "the stopped agent is not shown as working");
  assert.ok(h.repo.outboxForRun(runId).some((o) => o.kind === "stop" && o.idemKey.startsWith(`late-stop:${runId}:orch:`)), "its new thread is stopped");
});

test("a plain message to an agent with no thread is kept as an FYI line and never blocks later rows", async () => {
  const h = await createHarness();
  const runId = await run(h);
  const n = h.repo.listNodes(runId).find((x) => x.tier === "specialist" && !x.threadId)!;
  h.repo.updateNode(runId, n.id, { status: "done" });
  h.engine.sendFromHelm(runId, n.id, "The API moved to v2.", { key: "audit-msg" });
  h.engine.outbox.kick();
  await h.clock.runUntil(h.clock.now() + 60_000, { stopWhen: () => h.repo.outboxForRun(runId).find((o) => o.idemKey === "audit-msg")?.state === "done" });
  assert.equal(h.repo.outboxForRun(runId).find((o) => o.idemKey === "audit-msg")?.state, "done");
  assert.ok(h.repo.unflushedInbox(runId, n.id).some((l) => l.text === "The API moved to v2."));
});
