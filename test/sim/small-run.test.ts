import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP } from "../helpers/harness.ts";

const apps3 = { apps: [
  { name: "Alpha", tagline: "a", platforms: ["ios"] as const },
  { name: "Beta", tagline: "b", platforms: ["ios", "and"] as const },
  { name: "Gamma", tagline: "c", platforms: ["mac"] as const },
].map((a) => ({ ...a, platforms: [...a.platforms] })), groups: [], assumptions: [], questions: [] };

test("C2: a 3-app run reaches Ready on every app through real gates, then signs off and archives", async () => {
  const h = await createHarness();
  const { runId } = h.engine.createRun({ name: "Three", brief: "three apps", portfolio: apps3 as never, slots: CHEAP });
  const r = await h.engine.startRun(runId);
  assert.deepEqual(r.problems, []);
  const allReady = () => h.repo.listApps(runId).every((a) => a.stage === "ready");
  await h.clock.runUntil(h.clock.now() + 48 * 3600_000, { stopWhen: allReady });
  const apps = h.repo.listApps(runId);
  if (!allReady()) {
    console.log(apps.map((a) => `${a.id}:${a.stage}`).join(" "));
    console.log(h.agents.log.join("\n"));
    console.log(h.repo.listNodes(runId).map((n) => `${n.id} ${n.status} ${n.warning ?? ""}`).join("\n"));
    console.log(h.repo.outboxForRun(runId, ["pending", "failed"]).map((o) => `${o.kind} ${o.nodeId} ${o.state} ${o.lastError}`).join("\n"));
  }
  assert.ok(allReady(), "every app should be ready");
  const signoffs = h.repo.listNeeds(runId, "open").filter((n) => n.kind === "signoff");
  assert.equal(signoffs.length, 3);
  for (const n of signoffs) await h.resolve(runId, n.id, { action: "signoff" });
  await h.clock.advance(10 * 60_000);
  assert.ok(h.repo.listApps(runId).every((a) => a.stage === "done"));
  const appThreads = h.sim.helmThreads().filter((t) => t.meta!.nodeId !== "orch");
  assert.ok(appThreads.filter((t) => t.meta!.nodeId.includes(".")).every((t) => t.archived), "squads archived");
  assert.equal(h.repo.outboxForRun(runId, ["failed"]).length, 0);
});
