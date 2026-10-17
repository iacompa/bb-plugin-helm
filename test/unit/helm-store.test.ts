// The Helm app's normalized store and realtime patch application (pure).
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyBatch, ancestorsOf, appMembers, descendantsOf, fromSnapshot, leadOf, openNeeds } from "../../components/helm/store.ts";
import type { Snapshot, SnapNode, DirectiveInfo } from "../../components/helm/types.ts";

const ref = { providerId: "codex", modelId: "gpt-6.1-sol", reasoning: "high" };

function node(id: string, over: Partial<SnapNode> = {}): SnapNode {
  return {
    id, runId: "r1", appId: null, tier: "specialist", role: "ui", platform: null, parentId: null, threadId: null, status: "planned", alsoLead: false, slot: "ui",
    model: ref, modelOverride: false, briefVersion: 1, scopeGlobs: [], branch: null, priority: "normal", nowLine: null, topics: [], tokens: 0, turns: 0, cost: 0,
    touched: false, warning: null, createdAt: 0, spawnedAt: null, endedAt: null, lastActivityAt: null, label: id, ...over,
  } as SnapNode;
}

function snap(): Snapshot {
  return {
    run: { id: "r1", name: "Run", status: "running", brief: "", dryRun: false, studioProjectId: null, appsRoot: null, budgetCap: 100, maxAgents: 250, concurrency: 24, spawnsPaused: false, autoAdvance: "ask", limits: {} as never, slots: {}, createdAt: 0, startedAt: 0, endedAt: null, spend: 1, rule: "C3", grouping: "", why: "", counts: { apps: 1, managers: 1, leads: 1, specialists: 1, gates: 1, total: 5 } },
    managers: [{ id: "m0", name: "Wellness", appIds: ["lumen"] }],
    apps: [{ id: "lumen", runId: "r1", name: "Lumen", tagline: "", platforms: ["ios"], shape: "lean", managerNodeId: "m0", projectId: null, repoPath: null, stage: "build", priority: "normal", fixRound: 0, pct: 25, order: 0, test: false, slotOverrides: {}, waivedGates: [], targetPath: null, reads: [], adopted: false, helmBranch: null, userBranch: null }],
    nodes: [
      node("orch", { tier: "orchestrator", role: "orch", slot: "orchestrator", label: "Orchestrator", status: "running", threadId: "t0" }),
      node("m0", { tier: "manager", role: "mgr", slot: "manager", parentId: "orch", label: "Wellness manager", status: "waiting" }),
      node("lumen.lead", { tier: "lead", role: "lead", slot: "lead", parentId: "m0", appId: "lumen", label: "Lumen · App lead", status: "running" }),
      node("lumen.ui", { parentId: "lumen.lead", appId: "lumen", label: "Lumen · UI builder" }),
      node("lumen.review", { tier: "gate", role: "review", slot: "review", parentId: "lumen.lead", appId: "lumen", label: "Lumen · Reviewer" }),
    ],
    directives: [],
    needs: [],
    policies: [],
    findings: [{ id: "F-1", runId: "r1", appId: "lumen", gate: "slop", rule: "S1", severity: "major", path: "a.ts", line: 1, quote: "", why: "", fix: "", commitSha: null, status: "open", round: 1, ownerNodeId: null, waiverDirectiveId: null, createdAt: 0 }],
    outboxFailed: [],
  };
}

const batch = (events: Array<[string, unknown]>, seq = 1) => ({ runId: "r1", seq, events: events.map(([event, payload]) => ({ event, payload, ts: 1000 })) });

test("fromSnapshot normalizes nodes, apps and the child index", () => {
  const s = fromSnapshot(snap());
  assert.equal(s.nodeOrder.length, 5);
  assert.deepEqual(s.children.orch, ["m0"]);
  assert.deepEqual(s.children["lumen.lead"], ["lumen.ui", "lumen.review"]);
  assert.deepEqual(ancestorsOf(s, "lumen.ui"), ["lumen.lead", "m0", "orch"]);
  assert.deepEqual(descendantsOf(s, "m0"), ["lumen.lead", "lumen.ui", "lumen.review"]);
  assert.equal(leadOf(s, "lumen")?.id, "lumen.lead");
  assert.deepEqual(appMembers(s, "lumen").map((n) => n.id), ["lumen.lead", "lumen.ui", "lumen.review"]);
});

test("node.updated merges the raw row, keeping label and the effective model when the row's model is null", () => {
  const s0 = fromSnapshot(snap());
  const raw = { ...s0.nodes["lumen.ui"], status: "running", model: null, nowLine: "Building the timer view" } as Record<string, unknown>;
  delete raw.label;
  const fx = applyBatch(s0, batch([["node.updated", raw]]));
  const n = fx.state.nodes["lumen.ui"];
  assert.equal(n.status, "running");
  assert.equal(n.label, "Lumen · UI builder");
  assert.deepEqual(n.model, ref);
  assert.equal(n.nowLine, "Building the timer view");
  assert.deepEqual(fx.statusChanged, ["lumen.ui"]);
  assert.equal(fx.refetch, false);
  // untouched parts are shared, the old state is not mutated
  assert.equal(fx.state.apps, s0.apps);
  assert.equal(s0.nodes["lumen.ui"].status, "planned");
});

test("an unknown node asks for a refetch (it needs a label) but is shown at once", () => {
  const s0 = fromSnapshot(snap());
  const fx = applyBatch(s0, batch([["node.updated", { ...node("lumen.code", { parentId: "lumen.lead", appId: "lumen" }), label: undefined }]]));
  assert.equal(fx.refetch, true);
  assert.ok(fx.state.nodes["lumen.code"]);
  assert.ok(fx.state.children["lumen.lead"].includes("lumen.code"));
});

test("directive.created then receipt.updated patch the ledger; duplicates are ignored", () => {
  const d: DirectiveInfo = {
    id: "D-0001", runId: "r1", ts: 1, type: "tell", targetNodeId: "lumen.ui", cascade: "self", mode: "steer", policy: false, text: "hi", value: null, modelFrom: null, modelTo: null,
    affected: ["lumen.ui"], actor: "human", implicit: false, summary: "Message to UI builder",
    recipients: [
      { directiveId: "D-0001", nodeId: "lumen.ui", level: "direct", world: false, state: "queued", notice: "Message from the human (D-0001): “hi”.", deliveredAt: null, ackAt: null, ackNote: null },
      { directiveId: "D-0001", nodeId: "lumen.lead", level: "full", world: false, state: "queued", notice: "…", deliveredAt: null, ackAt: null, ackNote: null },
      { directiveId: "D-0001", nodeId: "orch", level: "digest", world: true, state: "rec", notice: "…", deliveredAt: null, ackAt: null, ackNote: null },
    ],
  };
  const s0 = fromSnapshot(snap());
  const a = applyBatch(s0, batch([["directive.created", d]]));
  assert.equal(a.state.directives.length, 1);
  assert.deepEqual(a.created.map((x) => x.id), ["D-0001"]);
  const b = applyBatch(a.state, batch([["directive.created", d], ["receipt.updated", { directiveId: "D-0001", nodeId: "lumen.ui", state: "ack" }]], 2));
  assert.equal(b.state.directives.length, 1);
  assert.equal(b.created.length, 0);
  assert.equal(b.state.directives[0].recipients[0].state, "ack");
  assert.equal(b.state.directives[0].recipients[0].ackAt, 1000);
  assert.deepEqual(b.receipts, [{ directiveId: "D-0001", nodeId: "lumen.ui", state: "ack" }]);
  assert.equal(b.state.seq, 2);
  // a receipt for a directive we don't have yet → refetch
  assert.equal(applyBatch(s0, batch([["receipt.updated", { directiveId: "D-9", nodeId: "x", state: "delivered" }]])).refetch, true);
});

test("needs, stages, spend, spawns and findings are patched in place", () => {
  const s0 = fromSnapshot(snap());
  const need = { id: "N-1", runId: "r1", kind: "approval", nodeId: "lumen.ui", appId: "lumen", title: "Run npm install?", body: "", evidence: "", options: ["Approve", "Deny"], interactionId: null, state: "open", createdAt: 1, resolvedAt: null, resolution: null };
  const a = applyBatch(s0, batch([["need.created", need], ["stage.changed", { appId: "lumen", stage: "review" }], ["spend.updated", { nodeId: "lumen.ui", tokens: 5000, cost: 0.4, runSpend: 2.5 }], ["spawns.paused", { paused: true, budgetCap: 150 }], ["finding.updated", { id: "F-1", status: "fixed", verdict: "V-1" }]]));
  assert.equal(openNeeds(a.state).length, 1);
  assert.equal(a.needsCreated.length, 1);
  assert.equal(a.state.apps.lumen.stage, "review");
  assert.equal(a.state.nodes["lumen.ui"].tokens, 5000);
  assert.equal(a.state.run.spend, 2.5);
  assert.equal(a.state.run.spawnsPaused, true);
  assert.equal(a.state.run.budgetCap, 150);
  assert.equal(a.state.findings[0].status, "fixed");
  assert.equal(a.refetch, false);
  const b = applyBatch(a.state, batch([["need.resolved", { id: "N-1", action: "approve" }]], 2));
  assert.equal(openNeeds(b.state).length, 0);
  assert.equal(b.state.needs[0].state, "resolved");
});

test("structural events request a refetch; batches for another run are ignored", () => {
  const s0 = fromSnapshot(snap());
  for (const ev of ["plan.changed", "run.started", "run.reconciled", "edge.added", "run.updated"]) assert.equal(applyBatch(s0, batch([[ev, {}]])).refetch, true, ev);
  const other = applyBatch(s0, { runId: "r2", seq: 9, events: [{ event: "stage.changed", payload: { appId: "lumen", stage: "done" }, ts: 1 }] });
  assert.equal(other.state, s0);
});
