import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP } from "../helpers/harness.ts";
import { callTool } from "../../src/server/agent/tools.ts";
import { createDirective } from "../../src/server/engine/direct.ts";
import type { HelmThreadMeta } from "../../src/server/bb/port.ts";
import type { Profile } from "../../src/server/bb/sim-agents.ts";

const H = 3600_000;
const one = { apps: [{ name: "Alpha", tagline: "t", platforms: ["ios"] }], groups: [], assumptions: [], questions: [] };

test("a lead can release a squad member its SPEC no longer needs; Integrate stops waiting for it", async () => {
  // the UI builder never produces verifiable work (as when the SPEC has no UI)
  const h = await createHarness({ profileFor: (m: HelmThreadMeta): Profile => (m.role === "ui" ? "liar" : "diligent") });
  const { runId } = h.engine.createRun({ name: "R", brief: "x", portfolio: one as never, slots: CHEAP });
  assert.deepEqual((await h.engine.startRun(runId)).problems, []);
  await h.clock.advance(12 * H);

  const app = h.repo.listApps(runId)[0];
  assert.equal(app.stage, "build", "stuck in Build while the UI builder has no verified done");
  const lead = h.engine.leadOf(runId, app.id)!;
  const ui = h.repo.listNodes(runId).find((n) => n.role === "ui")!;
  assert.ok(ui.threadId);

  // citing the commit it started from is not work: refused, and still not done
  const base = h.repo.getMeta(`base:${runId}:${ui.id}`);
  assert.ok(base, "the spawn base was recorded");
  const fake = await callTool(h.engine, "helm_report", ui.threadId!, { status: "done", summary: "nothing to do", evidence: [{ kind: "commit", ref: base }] });
  assert.match(fake.text, /already on the integration branch/);
  assert.notEqual(h.repo.getNode(runId, ui.id)!.status, "done");

  const before = await callTool(h.engine, "helm_stage", lead.threadId!, { to: "integrate", evidence: [] });
  assert.match(before.text, /UI/i, "the UI builder is named as pending");

  // a specialist cannot release anyone; only leads may
  const denied = await callTool(h.engine, "helm_spawn_squad", ui.threadId!, { release: [{ role: "code", reason: "x" }] });
  assert.ok(denied.isError);

  const rel = await callTool(h.engine, "helm_spawn_squad", lead.threadId!, { release: [{ role: "ui", reason: "SPEC excludes a GUI" }] });
  assert.ok(!rel.isError, rel.text);
  assert.match(rel.text, /released: .*UI/i);
  await h.clock.advance(5 * 60_000);

  const after = h.repo.getNode(runId, ui.id)!;
  assert.equal(after.status, "idle");
  assert.match(after.warning ?? "", /released by the lead: SPEC excludes a GUI/);
  const stopRow = h.repo.outboxForRun(runId).find((o) => o.kind === "stop" && o.idemKey === `release:${runId}:${ui.id}`);
  assert.equal(stopRow?.state, "done", "the released thread was stopped");
  assert.ok(!h.sim.threads.get(ui.threadId!)!.archived, "released, not archived early");

  const again = await callTool(h.engine, "helm_spawn_squad", lead.threadId!, { release: [{ role: "ui", reason: "again" }] });
  assert.match(again.text, /released: .*UI/i, "idempotent");

  const res = await callTool(h.engine, "helm_stage", lead.threadId!, { to: "integrate", evidence: [] });
  assert.doesNotMatch(res.text, /UI builder/i, res.text);
  assert.equal(h.repo.getApp(runId, app.id)!.stage, "integrate", res.text);

  // never re-admitted or respawned later
  await h.clock.advance(6 * H);
  const threadsForUi = h.sim.helmThreads().filter((t) => t.meta!.runId === runId && t.meta!.nodeId === ui.id);
  assert.equal(threadsForUi.length, 1);
});

test("a builder the human stopped is not waited for at Integrate", async () => {
  const h = await createHarness({ profileFor: (m: HelmThreadMeta): Profile => (m.role === "ui" ? "liar" : "diligent") });
  const { runId } = h.engine.createRun({ name: "R", brief: "x", portfolio: one as never, slots: CHEAP });
  await h.engine.startRun(runId);
  await h.clock.advance(12 * H);
  const app = h.repo.listApps(runId)[0];
  const lead = h.engine.leadOf(runId, app.id)!;
  const ui = h.repo.listNodes(runId).find((n) => n.role === "ui")!;
  await createDirective(h.engine, runId, { type: "stop", target: ui.id, cascade: "self" });
  await h.clock.advance(5 * 60_000);
  const res = await callTool(h.engine, "helm_stage", lead.threadId!, { to: "integrate", evidence: [] });
  assert.equal(h.repo.getApp(runId, app.id)!.stage, "integrate", res.text);
});
