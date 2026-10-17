import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP } from "../helpers/harness.ts";
import { watchdog } from "../../src/server/engine/events.ts";
import { callTool } from "../../src/server/agent/tools.ts";
import { activeSupervisor, watcherRun } from "../../src/server/engine/watch.ts";
import type { HelmThreadMeta } from "../../src/server/bb/port.ts";

const H = 3600_000;
const one = { apps: [{ name: "Alpha", tagline: "t", platforms: ["ios"] }, { name: "Beta", tagline: "b", platforms: ["mac"] }], groups: [], assumptions: [], questions: [] };

async function setup() {
  const h = await createHarness({ profileFor: (m: HelmThreadMeta) => (m.role === "ui" ? "silent" : "diligent") });
  const { runId } = h.engine.createRun({ name: "W", brief: "x", portfolio: one as never, slots: CHEAP, limits: { concurrency: 48 } });
  assert.deepEqual((await h.engine.startRun(runId)).problems, []);
  const uiId = h.repo.listNodes(runId).find((n) => n.role === "ui")!.id;
  const ui = () => h.repo.getNode(runId, uiId)!;
  await h.clock.runUntil(h.clock.now() + 6 * H, { stopWhen: () => !!ui().threadId });
  return { h, runId, ui };
}

test("a silent agent goes to the Watcher (one light thread), which restarts it; nothing reaches the human", async () => {
  const { h, runId, ui } = await setup();
  assert.ok(h.repo.getRun(runId)!.slots.watcher, "Cheap dev run includes a Watcher");
  await h.clock.advance(h.repo.getRun(runId)!.limits.stallMinutes * 60_000 + 60_000);
  const w = await watchdog(h.engine);
  assert.ok(w.nudged.includes(ui().id), "sent to the Watcher");
  const watcher = h.sim.helmThreads().find((t) => t.meta?.role === "watch")!;
  assert.ok(watcher, "a watcher thread was spawned");
  assert.equal(watcher.model, "claude-haiku-5-5");
  assert.equal(watcherRun(h.engine, watcher.id), runId);
  assert.match(watcher.firstPrompt ?? "", new RegExp(`- id: ${ui().id.replace(".", "\\.")}`));
  await h.clock.advance(5 * 60_000);
  assert.ok(h.repo.events(runId, ui().id).some((ev) => ev.kind === "watch-restart"), "the Watcher's restart was carried out");
  assert.equal(h.repo.listNeeds(runId, "open").filter((x) => x.kind === "stalled").length, 0);
  // looked at once per stall window, not every sweep
  const again = await watchdog(h.engine);
  assert.ok(!again.nudged.includes(ui().id));
});

test("escalate goes to the nearest active supervisor, skipping stopped ones", async () => {
  const { h, runId, ui } = await setup();
  await h.clock.advance(h.repo.getRun(runId)!.limits.stallMinutes * 60_000 + 60_000);
  await watchdog(h.engine);
  const watcher = h.sim.helmThreads().find((t) => t.meta?.role === "watch")!;
  const lead = h.repo.getNode(runId, ui().parentId!)!;
  assert.equal(activeSupervisor(h.engine, ui())?.id, lead.id);
  h.repo.updateNode(runId, lead.id, { status: "idle" });
  const next = activeSupervisor(h.engine, ui());
  assert.notEqual(next?.id, lead.id, "a stopped lead is skipped");
  const r = await callTool(h.engine, "helm_watch", watcher.id, { verdicts: [{ nodeId: ui().id, verdict: "escalate", note: "blocked on the contract" }] });
  assert.match(r.text, new RegExp(`escalated to ${next!.id}`));
  // the watcher has no other tool, and other agents cannot call it
  assert.equal((await callTool(h.engine, "helm_context", watcher.id, {})).isError, true);
  assert.equal((await callTool(h.engine, "helm_watch", ui().threadId!, { verdicts: [{ nodeId: ui().id, verdict: "ok", note: "x" }] })).isError, true);
});
