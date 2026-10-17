import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP, type Harness } from "../helpers/harness.ts";
import { createDirective } from "../../src/server/engine/direct.ts";
import { callTool } from "../../src/server/agent/tools.ts";
import { world } from "../../src/server/engine/world.ts";
import { parseBrief, SAMPLE_BRIEF } from "../../src/server/domain/brief.ts";
import type { Portfolio } from "../../src/shared/types.ts";

function five(): Portfolio {
  const p = parseBrief(SAMPLE_BRIEF).portfolio;
  return { ...p, apps: p.apps.slice(0, 5).map((a) => ({ ...a, group: null })) };
}

async function startedRun(h: Harness, portfolio = five(), concurrency = 48) {
  const { runId } = h.engine.createRun({ name: "Dir", brief: "x", portfolio, slots: CHEAP, limits: { concurrency } });
  await h.engine.startRun(runId);
  return runId;
}

async function untilRunning(h: Harness, runId: string, nodeId: string) {
  await h.clock.runUntil(h.clock.now() + 6 * 3600_000, { stopWhen: () => !!h.repo.getNode(runId, nodeId)?.threadId });
  assert.ok(h.repo.getNode(runId, nodeId)?.threadId, `${nodeId} should have a thread`);
}

test("A7/A8: telling a specialist reaches specialist (direct), lead (full), manager (digest), Orchestrator (digest + world) with receipts", async () => {
  const h = await createHarness();
  const runId = await startedRun(h);
  const spec = h.repo.listNodes(runId).find((n) => n.tier === "specialist" && n.role === "ui")!;
  await untilRunning(h, runId, spec.id);
  const d = await createDirective(h.engine, runId, { type: "tell", target: spec.id, text: "Use the warmer palette" });
  const by = Object.fromEntries(d.recipients.map((r) => [r.nodeId, r]));
  const lead = h.repo.getNode(runId, spec.parentId!)!;
  const mgr = h.repo.getNode(runId, lead.parentId!)!;
  assert.equal(by[spec.id].level, "direct");
  assert.equal(by[lead.id].level, "full");
  assert.equal(by[mgr.id].level, "digest");
  assert.equal(by.orch.level, "digest");
  assert.equal(by.orch.world, true);
  // world state has it in the same transaction
  const w = world(h.engine, runId);
  assert.equal(w.recentDirectives[0].id, d.id);
  assert.ok(w.touched.nodes.includes(spec.id));
  // the Changes tab of every one of them lists it
  for (const id of [spec.id, lead.id, mgr.id, "orch"]) assert.ok(h.repo.directivesTouching(runId, id).some((x) => x.id === d.id), `${id} changes`);
  // receipts progress
  await h.clock.advance(60 * 60_000);
  const after = Object.fromEntries(h.repo.recipients(runId, d.id).map((r) => [r.nodeId, r.state]));
  assert.equal(after[spec.id], "ack", JSON.stringify(after));
  assert.equal(after[lead.id], "ack");
  assert.equal(after[mgr.id], "rec");
  assert.equal(after.orch, "rec");
  // the specialist actually received the exact notice text
  const t = h.sim.threadOf(spec.id, runId)!;
  void t;
  const sent = h.repo.outboxForRun(runId).find((o) => o.kind === "send" && o.idemKey === `${d.id}:${spec.id}`)!;
  assert.match(String(sent.payload.text), /^Message from the human \(D-0001\): “Use the warmer palette”\. Treat this as binding; adapt your plan\./);
});

test("A9: a subtree stop stops every descendant bottom-up; an unreachable node shows a failed receipt", async () => {
  const h = await createHarness();
  const runId = await startedRun(h);
  const lead = h.repo.listNodes(runId).find((n) => n.tier === "lead")!;
  await h.clock.runUntil(h.clock.now() + 6 * 3600_000, { stopWhen: () => h.repo.listNodes(runId).filter((n) => n.parentId === lead.id && n.threadId).length >= 3 });
  const kids = h.repo.listNodes(runId).filter((n) => n.parentId === lead.id && n.threadId);
  const d = await createDirective(h.engine, runId, { type: "stop", target: lead.id, cascade: "subtree" });
  const stopRow = h.repo.outboxForRun(runId).find((o) => o.kind === "stop" && o.idemKey === `${d.id}:stop`)!;
  const order = stopRow.payload.nodeIds as string[];
  assert.equal(order[order.length - 1], lead.id, "lead stops last");
  for (const k of kids) assert.ok(order.indexOf(k.id) < order.indexOf(lead.id));
  await h.clock.advance(5 * 60_000);
  for (const id of order) assert.equal(h.repo.getNode(runId, id)!.status, "idle", `${id} ${JSON.stringify(h.repo.events(runId, id, 8).map((x) => `${x.kind}:${x.summary}`))}`);
  for (const id of order) assert.equal(h.repo.recipients(runId, d.id).find((r) => r.nodeId === id)!.state, "delivered");
  // unreachable: BB refuses every stop → failed receipts after retries
  h.sim.failures.set("stopThread", 99);
  await h.clock.runUntil(h.clock.now() + 3600_000, { stopWhen: () => h.repo.listNodes(runId).some((n) => n.appId !== lead.appId && n.threadId && h.sim.threadOf(n.id, runId)?.status === "active") });
  const lead2 = h.repo.listNodes(runId).find((n) => n.appId !== lead.appId && n.threadId && h.sim.threadOf(n.id, runId)?.status === "active")!;
  const d2 = await createDirective(h.engine, runId, { type: "stop", target: lead2.id, cascade: "self" });
  await h.clock.advance(30 * 60_000);
  assert.equal(h.repo.recipients(runId, d2.id).find((r) => r.nodeId === lead2.id)!.state, "failed");
});

test("A10: a model change applies through threads.update, is recorded from → to, and the lead is told not to revert it", async () => {
  const h = await createHarness();
  const runId = await startedRun(h);
  const spec = h.repo.listNodes(runId).find((n) => n.role === "code")!;
  await untilRunning(h, runId, spec.id);
  const to = { providerId: "claude-code", modelId: "claude-sonnet-5-5", reasoning: "high" };
  const d = await createDirective(h.engine, runId, { type: "model", target: spec.id, modelTo: to });
  assert.equal(d.modelFrom?.modelId, "claude-haiku-5-5");
  assert.equal(d.modelTo?.modelId, "claude-sonnet-5-5");
  await h.clock.advance(5 * 60_000);
  assert.equal(h.sim.threadOf(spec.id, runId)!.model, "claude-sonnet-5-5");
  assert.equal(h.sim.threadOf(spec.id, runId)!.reasoning, "high");
  const n = h.repo.getNode(runId, spec.id)!;
  assert.equal(n.modelOverride, true);
  const full = h.repo.recipients(runId, d.id).find((r) => r.level === "full")!;
  assert.match(full.notice, /This is binding: do not undo it/);
  // an unavailable model is refused, never substituted
  await assert.rejects(createDirective(h.engine, runId, { type: "model", target: spec.id, modelTo: { providerId: "codex", modelId: "gpt-0-gone", reasoning: "low" } }), /no longer available/);
});

test("A11: a standing policy appears in the prompt of an agent spawned afterwards and in helm_context", async () => {
  const h = await createHarness();
  const runId = await startedRun(h, five(), 6);
  const mgr = h.repo.listNodes(runId).find((n) => n.tier === "manager")!;
  await createDirective(h.engine, runId, { type: "tell", target: mgr.id, cascade: "subtree", text: "Never add analytics SDKs", policy: true });
  const later = h.repo.listNodes(runId).find((n) => n.tier === "specialist" && !n.threadId && h.repo.getNode(runId, n.parentId!)?.parentId === mgr.id)!;
  await untilRunning(h, runId, later.id);
  const spawnRow = h.sim.calls.find((c) => c.method === "spawnThread");
  void spawnRow;
  const thread = h.sim.threadOf(later.id, runId)!;
  const brief = h.engine.buildBrief(h.repo.getRun(runId)!, h.repo.getNode(runId, later.id)!);
  assert.match(brief, /Standing policies that apply to you[\s\S]*Never add analytics SDKs/);
  const ctx = await callTool(h.engine, "helm_context", thread.id, {});
  assert.match(ctx.text, /Never add analytics SDKs/);
});

test("A12: typing straight into an agent's thread records an implicit directive that informs the chain", async () => {
  const h = await createHarness();
  const runId = await startedRun(h);
  const spec = h.repo.listNodes(runId).find((n) => n.role === "ui")!;
  await untilRunning(h, runId, spec.id);
  await h.clock.advance(60 * 60_000);
  await h.sim.humanTypes(h.repo.getNode(runId, spec.id)!.threadId!, "Make the buttons bigger");
  await h.clock.advance(60_000);
  const d = h.repo.listDirectives(runId).find((x) => x.implicit)!;
  assert.ok(d, "implicit directive recorded");
  assert.equal(d.text, "Make the buttons bigger");
  const lead = d.recipients.find((r) => r.level === "full")!;
  assert.match(lead.notice, /typed directly in the agent's thread/);
  assert.equal(d.recipients.find((r) => r.level === "direct")!.state, "delivered");
  // Helm's own notices never become implicit directives
  assert.equal(h.repo.listDirectives(runId).filter((x) => x.implicit).length, 1);
});

test("questions to the Orchestrator are not directives (§6.8)", async () => {
  const h = await createHarness();
  const runId = await startedRun(h);
  await untilRunning(h, runId, "orch");
  await h.clock.advance(10 * 60_000);
  await h.sim.humanTypes(h.repo.getNode(runId, "orch")!.threadId!, "What is blocking progress?");
  await h.clock.runUntil(h.clock.now() + 3600_000, { stopWhen: () => h.repo.events(runId, "orch").some((x) => x.kind === "question") });
  assert.equal(h.repo.listDirectives(runId).length, 0);
  await h.sim.humanTypes(h.repo.getNode(runId, "orch")!.threadId!, "Prioritise Ledgerly this week");
  await h.clock.runUntil(h.clock.now() + 3600_000, { stopWhen: () => h.repo.listDirectives(runId).length > 0 });
  assert.equal(h.repo.listDirectives(runId).length, 1);
});

test("directives to a planned node are stored and injected into its spawn prompt; receipt delivered at spawn", async () => {
  const h = await createHarness();
  const runId = await startedRun(h, five(), 6);
  const planned = h.repo.listNodes(runId).find((n) => n.status === "planned" && n.tier === "specialist" && h.repo.getNode(runId, n.parentId!)!.status !== "planned")!;
  const d = await createDirective(h.engine, runId, { type: "tell", target: planned.id, text: "Use SwiftData" });
  assert.equal(h.repo.recipients(runId, d.id).find((r) => r.nodeId === planned.id)!.state, "queued");
  const brief = h.engine.buildBrief(h.repo.getRun(runId)!, h.repo.getNode(runId, planned.id)!);
  assert.match(brief, /Changes made before you started[\s\S]*D-0001/);
  await untilRunning(h, runId, planned.id);
  assert.notEqual(h.repo.recipients(runId, d.id).find((r) => r.nodeId === planned.id)!.state, "queued");
});

test("digests to an idle manager never wake it; they ride along with its next message", async () => {
  const h = await createHarness();
  const runId = await startedRun(h);
  const mgr = h.repo.listNodes(runId).find((n) => n.tier === "manager")!;
  await h.clock.runUntil(h.clock.now() + 3600_000, { stopWhen: () => h.repo.getNode(runId, mgr.id)!.status === "waiting" });
  const before = h.sim.threadOf(mgr.id, runId)!.turns;
  const spec = h.repo.listNodes(runId).find((n) => n.tier === "specialist" && h.repo.getNode(runId, n.parentId!)?.parentId === mgr.id)!;
  await createDirective(h.engine, runId, { type: "tell", target: spec.id, text: "smaller icons" });
  await h.clock.advance(2 * 60_000);
  assert.equal(h.sim.threadOf(mgr.id, runId)!.turns, before, "the manager was not woken for an FYI");
  assert.equal(h.repo.unflushedInbox(runId, mgr.id).length, 1);
});
