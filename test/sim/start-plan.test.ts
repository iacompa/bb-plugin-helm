// Starting a plan is one obvious step: the panel asks the server whether the plan can
// start (run_readiness, read-only), Start reports a refusal instead of claiming success,
// a plan that reuses another live run's folders says so, and a plan can be discarded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP } from "../helpers/harness.ts";
import { HelmService } from "../../src/server/service.ts";
import type { Portfolio } from "../../src/shared/types.ts";

const app = (name: string, extra: Record<string, unknown> = {}) => ({ name, tagline: `${name} app`, platforms: ["ios" as const], shape: "lean" as const, ...extra });
const pf = (...apps: ReturnType<typeof app>[]): Portfolio => ({ apps, groups: [], assumptions: [], questions: [] }) as unknown as Portfolio;

async function withRepo() {
  const h = await createHarness();
  h.sim.git.createRepo("/disk/work/tide");
  h.sim.git.write("/disk/work/tide", "README.md", "# Tide\n");
  h.sim.git.commit("/disk/work/tide", "init");
  return { h, svc: new HelmService(h.engine) };
}

test("readiness is read-only: it lists what blocks a start, and a ready plan is still not started", async () => {
  const { h, svc } = await withRepo();
  h.sim.git.dirs.set("/disk/notgit", true);
  const bad = h.engine.createRun({ name: "Bad", brief: "x", portfolio: pf(app("Plain", { path: "/disk/notgit" })), slots: CHEAP });
  const r1 = await svc.readiness(bad.runId);
  assert.equal(r1.ok, false);
  assert.ok(r1.problems.some((p) => p.startsWith("Plain:")), r1.problems.join("\n"));
  assert.equal(h.engine.run(bad.runId).status, "planning");

  const good = h.engine.createRun({ name: "Good", brief: "x", portfolio: pf(app("Tide", { path: "/disk/work/tide" })), slots: CHEAP });
  const r2 = await svc.readiness(good.runId);
  assert.deepEqual(r2.problems, []);
  assert.equal(r2.ok, true);
  assert.ok(r2.notes.some((n) => n.includes("work branch tide-work") && n.includes("at your last commit")), r2.notes.join("\n"));
  assert.match(String(r2.runFolder), /good/);
  assert.equal(h.engine.run(good.runId).status, "planning", "checking never starts the run");
  assert.equal(h.sim.helmThreads().length, 0, "nothing spawned");

  await svc.start(good.runId);
  const r3 = await svc.readiness(good.runId);
  assert.equal(r3.ok, false);
  assert.match(r3.problems[0], /is running; only a planned run can start/);
});

test("start refuses with reasons instead of starting (the panel shows them)", async () => {
  const { h, svc } = await withRepo();
  const { runId } = h.engine.createRun({ name: "No models", brief: "x", portfolio: pf(app("Tide", { path: "/disk/work/tide" })), slots: {} });
  const r = await svc.start(runId);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /still need.* a model/.test(p)), r.problems.join("\n"));
  assert.equal(r.run.status, "planning");
  assert.equal(h.sim.helmThreads().length, 0);
});

test("a plan on folders another live run is working on says so and names the end command", async () => {
  const { h, svc } = await withRepo();
  const old = h.engine.createRun({ name: "Old run", brief: "x", portfolio: pf(app("Tide", { path: "/disk/work/tide" })), slots: CHEAP });
  await svc.start(old.runId);
  const next = h.engine.createRun({ name: "New plan", brief: "x", portfolio: pf(app("Tide", { path: "/disk/work/tide" })), slots: CHEAP });
  const r = await svc.readiness(next.runId);
  const note = r.notes.find((n) => n.includes("Old run"));
  assert.ok(note, r.notes.join("\n"));
  assert.match(note!, /also works on Tide/);
  assert.match(note!, new RegExp(`bb helm end --run ${old.runId} --yes`));
  // once the old run ends, the note goes away
  await svc.finish(old.runId, "cancelled");
  assert.ok(!(await svc.readiness(next.runId)).notes.some((n) => n.includes("Old run")));
});

test("a draft plan can be discarded (bb helm end / Discard plan) and nothing was spawned", async () => {
  const { h, svc } = await withRepo();
  const { runId } = h.engine.createRun({ name: "Draft", brief: "x", portfolio: pf(app("Tide")), slots: CHEAP });
  const r = await svc.finish(runId, "cancelled");
  assert.equal(r.status, "cancelled");
  assert.equal(h.sim.helmThreads().length, 0);
});
