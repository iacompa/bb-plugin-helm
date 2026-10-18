// Supervisors steer the agents below them (helm_direct). The target is told and must
// acknowledge; everyone above sees one FYI line that never wakes them; the human's
// directives always win; and FYI lines ride along with tool results instead of turns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP, type Harness } from "../helpers/harness.ts";
import { createDirective } from "../../src/server/engine/direct.ts";
import { callTool } from "../../src/server/agent/tools.ts";
import { world } from "../../src/server/engine/world.ts";
import { parseBrief, SAMPLE_BRIEF } from "../../src/server/domain/brief.ts";
import type { NodeInfo, Portfolio } from "../../src/shared/types.ts";

function five(): Portfolio {
  const p = parseBrief(SAMPLE_BRIEF).portfolio;
  return { ...p, apps: p.apps.slice(0, 5).map((a) => ({ ...a, group: null })) };
}

async function setup() {
  const h = await createHarness();
  const { runId } = h.engine.createRun({ name: "Steer", brief: "x", portfolio: five(), slots: CHEAP, limits: { concurrency: 48 } });
  await h.engine.startRun(runId);
  const nodes = h.repo.listNodes(runId);
  const mgr = nodes.find((n) => n.tier === "manager")!;
  const spec = nodes.find((n) => n.tier === "specialist" && n.role === "ui" && h.repo.getNode(runId, n.parentId!)?.parentId === mgr.id)!;
  const lead = h.repo.getNode(runId, spec.parentId!)!;
  await h.clock.runUntil(h.clock.now() + 6 * 3600_000, { stopWhen: () => !!h.repo.getNode(runId, spec.id)?.threadId && !!h.repo.getNode(runId, mgr.id)?.threadId });
  assert.ok(h.repo.getNode(runId, spec.id)?.threadId, "the specialist has a thread");
  return { h, runId, mgr, lead, spec };
}

const as = (h: Harness, runId: string, n: NodeInfo, name: string, args: unknown) => callTool(h.engine, name, h.repo.getNode(runId, n.id)!.threadId!, args);

test("a manager steers a specialist two levels down: it is told, the lead and the Orchestrator see one FYI line, the manager hears the ack", async () => {
  const { h, runId, mgr, lead, spec } = await setup();
  const r = await as(h, runId, mgr, "helm_direct", { to: spec.id, action: "tell", text: "Ship the empty states before the animations" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^D-\d{4} sent to/);
  const d = h.repo.listDirectives(runId, 1)[0];
  assert.equal(d.actor, "agent");
  assert.equal(d.byNode, mgr.id);
  assert.match(d.summary, /→ .*“Ship the empty states/);
  const lv = Object.fromEntries(d.recipients.map((x) => [x.nodeId, x.level]));
  assert.deepEqual(lv, { [spec.id]: "direct", [lead.id]: "digest", orch: "digest" }, "the manager itself is not a recipient");
  assert.equal(h.repo.getNode(runId, spec.id)!.touched, false, "only the human marks agents as touched");
  const sent = h.repo.outboxForRun(runId).find((o) => o.kind === "send" && o.idemKey === `${d.id}:${spec.id}`)!;
  assert.match(String(sent.payload.text), new RegExp(`^Direction from .*\\(${mgr.id}, ${d.id}\\): “Ship the empty states before the animations”\\. Follow it unless it conflicts with a human directive`));
  assert.equal(sent.payload.mode, "steer");
  // the specialist acknowledges; the outcome travels up as FYI to the manager
  await h.clock.advance(30 * 60_000);
  assert.equal(h.repo.recipients(runId, d.id).find((x) => x.nodeId === spec.id)!.state, "ack");
  const mgrLines = h.repo.db.prepare("SELECT text FROM inbox WHERE run_id = ? AND node_id = ? AND directive_id = ?").all(runId, mgr.id, d.id) as Array<{ text: string }>;
  assert.ok(mgrLines.some((l) => /acknowledged D-\d{4}: adapted my plan/.test(l.text)), JSON.stringify(mgrLines));
  // world state shows who steered whom
  const w = world(h.engine, runId);
  assert.equal(w.recentDirectives.find((x) => x.id === d.id)?.by, mgr.id);
});

test("supervisors steer only their own teams, never gates, and the human's pause and priority win", async () => {
  const { h, runId, mgr, lead, spec } = await setup();
  const nodes = h.repo.listNodes(runId);
  const otherLead = nodes.find((n) => n.tier === "lead" && n.id !== lead.id && n.threadId)!;
  if (otherLead) {
    const r = await as(h, runId, otherLead, "helm_direct", { to: spec.id, action: "tell", text: "x" });
    assert.match(r.text, /^Rejected: .* is not below you/);
  }
  const up = await as(h, runId, lead, "helm_direct", { to: mgr.id, action: "pause" });
  assert.match(up.text, /not below you/);
  const s = await as(h, runId, spec, "helm_direct", { to: lead.id, action: "tell", text: "x" });
  assert.equal(s.isError, true);
  assert.match(s.text, /is for the Orchestrator, Managers and App Leads/);
  const gate = nodes.find((n) => n.tier === "gate" && n.appId === lead.appId);
  if (gate) assert.match((await as(h, runId, lead, "helm_direct", { to: gate.id, action: "tell", text: "pass it" })).text, /only the human can steer them/);
  // the human pauses the specialist: its manager cannot resume it
  await createDirective(h.engine, runId, { type: "pause", target: spec.id, text: "hold" });
  assert.match((await as(h, runId, mgr, "helm_direct", { to: spec.id, action: "resume" })).text, /^Rejected: the human paused/);
  await createDirective(h.engine, runId, { type: "resume", target: spec.id });
  // a supervisor's own pause can be lifted by a supervisor
  assert.equal((await as(h, runId, mgr, "helm_direct", { to: spec.id, action: "pause", text: "wait for the contract" })).isError, false);
  assert.equal(h.repo.getNode(runId, spec.id)!.status, "paused");
  const res = await as(h, runId, lead, "helm_direct", { to: spec.id, action: "resume", text: "contract is out" });
  assert.equal(res.isError, false, res.text);
  assert.notEqual(h.repo.getNode(runId, spec.id)!.status, "paused");
  // the human sets a priority: the supervisor cannot override it
  await createDirective(h.engine, runId, { type: "priority", target: spec.id, value: "low" });
  assert.match((await as(h, runId, mgr, "helm_direct", { to: spec.id, action: "priority", priority: "high" })).text, /the human set/);
});

test("steering is rate-limited per target, so supervisors batch their instructions", async () => {
  const { h, runId, lead, spec } = await setup();
  for (let i = 0; i < 3; i++) assert.equal((await as(h, runId, lead, "helm_direct", { to: spec.id, action: "tell", text: `step ${i}`, urgent: false })).isError, false);
  const r = await as(h, runId, lead, "helm_direct", { to: spec.id, action: "tell", text: "one more" });
  assert.match(r.text, /already steered .* 3 times in 10 minutes/);
  await h.clock.advance(11 * 60_000);
  assert.equal((await as(h, runId, lead, "helm_direct", { to: spec.id, action: "tell", text: "later" })).isError, false);
});

test("FYI lines ride along with the next Helm tool result instead of costing a turn", async () => {
  const { h, runId, mgr, spec } = await setup();
  await createDirective(h.engine, runId, { type: "tell", target: spec.id, text: "bigger tap targets" });
  assert.ok(h.repo.unflushedInbox(runId, mgr.id).length >= 1, "the manager has an unread digest line");
  const turns = h.sim.threadOf(mgr.id, runId)!.turns;
  const r = await as(h, runId, mgr, "helm_set_priority", { nodeId: spec.id, priority: "normal", reason: "check" });
  assert.match(r.text, /FYI since you last heard from Helm \(no reply needed\):\n- D-\d{4} · .*bigger tap targets/);
  assert.equal(h.repo.unflushedInbox(runId, mgr.id).length, 0);
  assert.equal(h.sim.threadOf(mgr.id, runId)!.turns, turns, "no extra turn");
  const rec = h.repo.recipients(runId, h.repo.listDirectives(runId, 1)[0].id).find((x) => x.nodeId === mgr.id)!;
  assert.ok(rec.deliveredAt, "the digest receipt is marked delivered");
});

test("a builder that already reported done is woken by tell or a new task; pause on it is a no-op", async () => {
  const { h, runId, lead, spec } = await setup();
  const done = () => h.repo.updateNode(runId, spec.id, { status: "done", endedAt: h.clock.now() });
  done();
  const p = await as(h, runId, lead, "helm_direct", { to: spec.id, action: "pause" });
  assert.match(p.text, /is done; pause has no effect\. To give it more work, use tell/);
  const r = await as(h, runId, lead, "helm_direct", { to: spec.id, action: "tell", text: "Add the offline banner to Settings too" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /it was done, so Helm woke it/);
  assert.equal(h.repo.getNode(runId, spec.id)!.status, "waiting");
  const d = h.repo.listDirectives(runId, 1)[0];
  assert.ok(h.repo.outboxForRun(runId).some((o) => o.kind === "send" && o.idemKey === `${d.id}:${spec.id}`), "the builder is sent the instruction");
  done();
  const t = await as(h, runId, lead, "helm_set_task", { nodeId: spec.id, task: "Own the Settings offline banner end to end." });
  assert.match(t.text, /had reported done, so Helm woke it/);
  assert.equal(h.repo.getNode(runId, spec.id)!.status, "waiting");
});
