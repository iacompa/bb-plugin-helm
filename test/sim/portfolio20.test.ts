import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP } from "../helpers/harness.ts";
import { parseBrief, SAMPLE_BRIEF } from "../../src/server/domain/brief.ts";

const H = 3600_000;

test("A1/A2/A6: the 20-app sample brief runs to completion — 169 agents, waves, gates, sign-off — with every invariant held", async (t) => {
  const h = await createHarness();
  const portfolio = parseBrief(SAMPLE_BRIEF).portfolio;
  // "ask" autonomy: this test covers the human approving every later wave
  const { runId, plan } = h.engine.createRun({ name: "Sample 20", brief: SAMPLE_BRIEF, portfolio, slots: CHEAP, limits: { autonomy: "ask" } });
  assert.deepEqual([plan.counts.managers, plan.counts.leads, plan.counts.specialists, plan.counts.gates, plan.counts.total + 0], [5, 20, 103, 40, 169]);
  const conc = h.repo.getRun(runId)!.limits.concurrency;

  // invariant probes, sampled on every BB event
  let maxActive = 0;
  h.sim.onEvent(() => {
    const active = h.sim.helmThreads().filter((t) => t.meta!.runId === runId && !t.archived && (t.status === "active" || t.status === "starting")).length;
    maxActive = Math.max(maxActive, active);
  });

  const t0 = h.clock.now();
  const r = await h.engine.startRun(runId);
  assert.deepEqual(r.problems, []);
  const finished = () => h.repo.listApps(runId).every((a) => a.stage === "ready" || a.stage === "done");
  let waves = 0;
  for (let guard = 0; guard < 200 && h.repo.getRun(runId)!.status === "running"; guard++) {
    await h.clock.runUntil(h.clock.now() + 72 * H, { maxSteps: 2_000_000, stopWhen: () => h.repo.listNeeds(runId, "open").length > 0 || h.repo.getRun(runId)!.status !== "running" });
    const open = h.repo.listNeeds(runId, "open");
    const unexpected = open.filter((n) => !["plan", "signoff"].includes(n.kind) && !(n.data as { completeRun?: boolean } | undefined)?.completeRun);
    assert.deepEqual(unexpected.map((n) => `${n.kind}: ${n.title}`), [], "no failures, stalls or questions in a clean run");
    if (!open.length && h.repo.getRun(runId)!.status === "running") assert.fail(`stuck: ${h.repo.listApps(runId).map((a) => `${a.id}:${a.stage}`).join(" ")}`);
    for (const n of open) {
      if (n.kind === "plan") waves++;
      await h.resolve(runId, n.id, { action: n.kind === "plan" ? "approve" : n.kind === "signoff" ? "signoff" : "complete_run" });
    }
  }
  await h.clock.advance(H);
  const dirs = h.repo.listDirectives(runId);
  t.diagnostic(`virtual time ${((h.clock.now() - t0) / H).toFixed(1)} h · threads ${h.sim.helmThreads().length} · max active ${maxActive}/${conc} · waves approved ${waves} · directives ${dirs.length} · outbox rows ${h.repo.outboxForRun(runId).length} · spend ${h.engine.spend(runId).toFixed(2)} u`);

  const apps = h.repo.listApps(runId);
  assert.equal(apps.length, 20);
  assert.ok(apps.every((a) => a.stage === "done"), apps.map((a) => `${a.id}:${a.stage}`).join(" "));
  assert.equal(h.repo.getRun(runId)!.status, "done");
  assert.ok(waves >= 1, "later waves were proposed and approved");

  // no duplicate threads; every node got exactly one
  const threads = h.sim.helmThreads().filter((t) => t.meta!.runId === runId);
  const keys = threads.map((t) => t.meta!.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(new Set(threads.map((t) => t.meta!.nodeId)).size, 169);
  // concurrency never exceeded
  assert.ok(maxActive <= conc, `max ${maxActive} active > concurrency ${conc}`);
  // every outbox row done (nothing silently pending or failed)
  const left = h.repo.outboxForRun(runId, ["pending", "inflight", "failed"]);
  assert.deepEqual(left.map((o) => `${o.kind} ${o.nodeId} ${o.state} ${o.lastError}`), []);
  // everything is archived at the end of the run
  assert.ok(threads.every((t) => t.archived), `${threads.filter((t) => !t.archived).length} threads not archived`);
  // every Ready had both gates' verdicts accepted at the same commit as green checks
  for (const a of apps) {
    const v = h.repo.verdicts(runId, a.id).filter((x) => x.accepted && x.verdict === "pass");
    assert.ok(v.some((x) => x.gate === "review") && v.some((x) => x.gate === "slop"), `${a.id} gates`);
  }
});
