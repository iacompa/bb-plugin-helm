import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP, type Harness } from "../helpers/harness.ts";
import { createDirective, resolveNeed } from "../../src/server/engine/direct.ts";
import { SIM_CATALOG } from "../../src/server/bb/sim.ts";
import { PERMISSION_LABEL } from "../../src/shared/types.ts";
import { handleEvent } from "../../src/server/engine/events.ts";
import { completeRun } from "../../src/server/engine/gates.ts";

const H = 3600_000;
const two = { apps: [{ name: "Alpha", tagline: "a", platforms: ["ios"] }, { name: "Beta", tagline: "b", platforms: ["mac"] }], groups: [], assumptions: [], questions: [] };
const CODEX = { providerId: "codex", modelId: "gpt-6-luna", reasoning: "medium" };

async function started(h: Harness) {
  const { runId } = h.engine.createRun({ name: "Swap", brief: "x", portfolio: two as never, slots: CHEAP, limits: { concurrency: 48 } });
  assert.deepEqual((await h.engine.startRun(runId)).problems, []);
  return runId;
}

async function untilThread(h: Harness, runId: string, nodeId: string, not?: string) {
  await h.clock.runUntil(h.clock.now() + 6 * H, { stopWhen: () => { const t = h.repo.getNode(runId, nodeId)?.threadId; return !!t && t !== not; } });
  const t = h.repo.getNode(runId, nodeId)?.threadId;
  assert.ok(t && t !== not, `${nodeId} should have a${not ? " new" : ""} thread`);
  return t!;
}

const thread = (h: Harness, id: string) => h.sim.helmThreads().find((t) => t.id === id)!;

test("a model on another provider moves the agent to a new thread in the same workspace, with a hand-over", async () => {
  const h = await createHarness();
  const runId = await started(h);
  const spec = h.repo.listNodes(runId).find((n) => n.role === "code")!;
  const old = await untilThread(h, runId, spec.id);
  const oldEnv = thread(h, old).environmentId;

  await createDirective(h.engine, runId, { type: "model", target: spec.id, modelTo: CODEX });
  const n = h.repo.getNode(runId, spec.id)!;
  assert.equal(n.threadId, null, "the old thread is let go at once");
  assert.equal(n.model?.providerId, "codex");
  assert.ok(!h.sim.calls.some((c) => c.method === "updateThread" && (c.args as { threadId?: string })?.threadId === old), "BB is never asked to change the provider in place");

  const fresh = await untilThread(h, runId, spec.id, old);
  const t = thread(h, fresh);
  assert.equal(t.providerId, "codex");
  assert.equal(t.model, "gpt-6-luna");
  assert.equal(t.environmentId, oldEnv, "it continues in its predecessor's workspace");
  assert.match(t.firstPrompt ?? "", /same workspace/);
  assert.notEqual(thread(h, old).status, "active", "the old thread was stopped");
  assert.equal(thread(h, old).archived, false, "the old thread is kept (it may own child threads)");
  assert.equal(h.repo.getMeta(`reuse:${runId}:${spec.id}`), null);
});

test("the same provider still switches in place, without a new thread", async () => {
  const h = await createHarness();
  const runId = await started(h);
  const spec = h.repo.listNodes(runId).find((n) => n.role === "code")!;
  const old = await untilThread(h, runId, spec.id);
  await createDirective(h.engine, runId, { type: "model", target: spec.id, modelTo: { providerId: "claude-code", modelId: "claude-sonnet-5-5", reasoning: "high" } });
  await h.clock.advance(5 * 60_000);
  assert.equal(h.repo.getNode(runId, spec.id)!.threadId, old);
  assert.equal(thread(h, old).model, "claude-sonnet-5-5");
});

test("Model Studio 'all agents now' moves failed agents and per-agent overrides too, and retries them", async () => {
  const h = await createHarness();
  const runId = await started(h);
  const [a, b] = h.repo.listNodes(runId).filter((n) => n.tier === "lead");
  const ta = await untilThread(h, runId, a.id);
  const tb = await untilThread(h, runId, b.id);
  // a fails (provider out of usage); b has its own per-agent model
  await handleEvent(h.engine, { type: "thread.failed", threadId: ta, error: "usage limit reached" } as never);
  assert.equal(h.repo.getNode(runId, a.id)!.status, "failed");
  assert.equal(h.repo.openNeedsFor(runId, a.id).filter((x) => x.kind === "failed").length, 1);
  await createDirective(h.engine, runId, { type: "model", target: b.id, modelTo: { providerId: "claude-code", modelId: "claude-sonnet-5-5", reasoning: "high" } });

  await createDirective(h.engine, runId, { type: "slots", target: "orch", slots: { lead: CODEX }, slotsScope: "all", text: "leads to Codex" });
  for (const [id, old] of [[a.id, ta], [b.id, tb]] as const) {
    const n = h.repo.getNode(runId, id)!;
    assert.equal(n.model?.providerId, "codex", id);
    assert.equal(n.modelOverride, false, `${id}: the override gave way`);
    const fresh = await untilThread(h, runId, id, old);
    assert.equal(thread(h, fresh).providerId, "codex", id);
  }
  assert.equal(h.repo.openNeedsFor(runId, a.id).filter((x) => x.kind === "failed").length, 0, "the failed card is closed");
});

test("a stopped agent switches provider when it is retried, and replaced threads are archived when the run ends", async () => {
  const h = await createHarness();
  const runId = await started(h);
  const spec = h.repo.listNodes(runId).find((n) => n.role === "code")!;
  const old = await untilThread(h, runId, spec.id);
  await createDirective(h.engine, runId, { type: "stop", target: spec.id });
  await h.clock.advance(60_000);
  await createDirective(h.engine, runId, { type: "model", target: spec.id, modelTo: CODEX });
  assert.equal(h.repo.getNode(runId, spec.id)!.threadId, old, "nothing restarts until it is retried");

  await createDirective(h.engine, runId, { type: "retry", target: spec.id });
  const fresh = await untilThread(h, runId, spec.id, old);
  assert.equal(thread(h, fresh).providerId, "codex");
  assert.deepEqual(h.engine.retiredThreads(runId), [old]);

  await completeRun(h.engine, runId, "cancelled");
  await h.clock.advance(5 * 60_000);
  assert.equal(thread(h, old).archived, true, "the replaced thread is archived with the run");
});

test("an agent whose record already names the new provider, but whose thread is still on the old one, is moved (the earlier failed swap)", async () => {
  const h = await createHarness();
  const runId = await started(h);
  const spec = h.repo.listNodes(runId).find((n) => n.role === "code")!;
  const old = await untilThread(h, runId, spec.id);
  // what an in-place swap that BB refused left behind: Helm says codex, the thread is claude-code
  h.repo.updateNode(runId, spec.id, { model: CODEX, modelOverride: true });
  await createDirective(h.engine, runId, { type: "model", target: spec.id, modelTo: CODEX });
  const fresh = await untilThread(h, runId, spec.id, old);
  assert.equal(thread(h, fresh).providerId, "codex");
});

test("a provider that cannot run Helm's permission mode holds its agents and asks the human once; the answer releases them", async () => {
  const h = await createHarness();
  const sim = h.sim as unknown as { catalogData: typeof SIM_CATALOG };
  sim.catalogData = {
    ...SIM_CATALOG,
    providers: [...SIM_CATALOG.providers, { id: "acp-grok", label: "Grok", available: true, permissionModes: ["accept-edits", "full"] }],
    models: [...SIM_CATALOG.models, { providerId: "acp-grok", id: "grok-4.7", displayName: "Grok 4.7", description: "", isDefault: true, defaultReasoning: "high", reasoning: ["low", "high"], serviceTiers: [] }],
  };
  const GROK = { providerId: "acp-grok", modelId: "grok-4.7", reasoning: "high" };
  const { runId } = h.engine.createRun({ name: "Perm", brief: "x", portfolio: two as never, slots: { ...CHEAP, code: GROK }, limits: { concurrency: 48 } });
  assert.deepEqual((await h.engine.startRun(runId)).problems, []);
  const codes = h.repo.listNodes(runId).filter((n) => n.role === "code");
  await h.clock.runUntil(h.clock.now() + 6 * H, { stopWhen: () => codes.every((c) => h.repo.getNode(runId, c.id)!.status === "needs") });
  for (const c of codes) assert.equal(h.repo.getNode(runId, c.id)!.status, "needs", `${c.id} waits for the choice`);
  const asks = h.repo.listNeeds(runId, "open").filter((x) => (x.data as { permissionFor?: string } | null)?.permissionFor === "acp-grok");
  assert.equal(asks.length, 1, "one question per provider, not one per agent");
  assert.deepEqual(asks[0].options, [PERMISSION_LABEL["accept-edits"], PERMISSION_LABEL.full]);

  await resolveNeed(h.engine, runId, asks[0].id, { action: "answer", text: PERMISSION_LABEL.full }, { signoff: async () => {}, sendback: async () => {} });
  assert.equal(h.repo.getRun(runId)!.limits.providerPermission?.["acp-grok"], "full");
  for (const c of codes) {
    const t = await untilThread(h, runId, c.id);
    assert.equal(thread(h, t).providerId, "acp-grok");
  }
});
