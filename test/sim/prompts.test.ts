import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP, type Harness } from "../helpers/harness.ts";
import { handleEvent, reconcile, watchdog } from "../../src/server/engine/events.ts";
import { callTool } from "../../src/server/agent/tools.ts";
import { PROMPT_TIMEOUT_MS, pendingPrompts } from "../../src/server/engine/prompts.ts";

const H = 3600_000;
const two = { apps: [{ name: "Alpha", tagline: "a", platforms: ["ios"] }, { name: "Beta", tagline: "b", platforms: ["mac"] }], groups: [], assumptions: [], questions: [] };

async function setup(settings = {}) {
  const h = await createHarness({ settings });
  const { runId } = h.engine.createRun({ name: "P", brief: "x", portfolio: two as never, slots: CHEAP, limits: { concurrency: 48 } });
  assert.deepEqual((await h.engine.startRun(runId)).problems, []);
  const spec = h.repo.listNodes(runId).find((n) => n.role === "code")!;
  await h.clock.runUntil(h.clock.now() + 6 * H, { stopWhen: () => !!h.repo.getNode(runId, spec.id)?.threadId && !!h.repo.getNode(runId, spec.parentId!)?.threadId });
  return { h, runId, spec: h.repo.getNode(runId, spec.id)!, lead: h.repo.getNode(runId, spec.parentId!)! };
}

const sim = (h: Harness, id: string) => h.sim.helmThreads().find((t) => t.id === id)!;

async function prompt(h: Harness, threadId: string, id: string, title = "Run: npm test") {
  const ask = { id, threadId, kind: "approval" as const, title, body: "", options: [], questions: [], decisions: [] };
  sim(h, threadId).interactions.push(ask);
  await handleEvent(h.engine, { type: "interaction.pending", threadId, interaction: ask } as never);
}

const humanCards = (h: Harness, runId: string) => h.repo.listNeeds(runId, "open").filter((x) => x.kind === "approval");

test("a builder's permission prompt goes to its lead, not the human; the lead's allow reaches BB", async () => {
  const { h, runId, spec, lead } = await setup();
  await prompt(h, spec.threadId!, "int_a");
  assert.equal(humanCards(h, runId).length, 0, "nothing in Needs you");
  assert.equal(pendingPrompts(h.engine, runId)[0]?.approverId, lead.id);
  // only the approver may answer
  const wrong = await callTool(h.engine, "helm_approve", h.repo.getNode(runId, "orch")!.threadId!, { promptId: "int_a", decision: "allow", reason: "x" });
  assert.match(wrong.text, /is for .* to answer/);
  const r = await callTool(h.engine, "helm_approve", lead.threadId!, { promptId: "int_a", decision: "allow", reason: "ordinary test run" });
  assert.equal(r.isError, false, r.text);
  await h.clock.advance(60_000);
  assert.equal(sim(h, spec.threadId!).interactions.length, 0, "BB got the answer");
  assert.equal(pendingPrompts(h.engine, runId).length, 0);
});

test("escalate sends the prompt to the human, with who escalated and why", async () => {
  const { h, runId, spec, lead } = await setup();
  await prompt(h, spec.threadId!, "int_b", "Run: curl -H 'Authorization: …' https://api.example");
  await callTool(h.engine, "helm_approve", lead.threadId!, { promptId: "int_b", decision: "escalate", reason: "uses an API key" });
  const cards = humanCards(h, runId);
  assert.equal(cards.length, 1);
  assert.match(cards[0].body, /escalated it: uses an API key/);
});

test("a prompt its supervisor does not answer in time comes to the human", async () => {
  const { h, runId, spec } = await setup();
  await prompt(h, spec.threadId!, "int_c");
  await h.clock.advance(PROMPT_TIMEOUT_MS + 1000);
  await watchdog(h.engine);
  assert.equal(humanCards(h, runId).length, 1);
  assert.equal(pendingPrompts(h.engine, runId).length, 0);
});

test("'Ask me every time' keeps every prompt with the human", async () => {
  const { h, runId, spec } = await setup({ approvePrompts: "human" });
  await prompt(h, spec.threadId!, "int_d");
  assert.equal(humanCards(h, runId).length, 1);
  assert.equal(pendingPrompts(h.engine, runId).length, 0);
});

test("approval cards already waiting in Needs you move to the supervisors when the run is reconciled", async () => {
  const h0 = await setup({ approvePrompts: "human" });
  const { h, runId, spec, lead } = h0;
  await prompt(h, spec.threadId!, "int_e");
  assert.equal(humanCards(h, runId).length, 1);
  (h.engine.settings as { approvePrompts: string }).approvePrompts = "supervisor";
  await reconcile(h.engine, runId);
  assert.equal(humanCards(h, runId).length, 0);
  assert.equal(pendingPrompts(h.engine, runId)[0]?.approverId, lead.id);
});

test("the panel reads and writes the permission settings (per role, and who approves)", async () => {
  const { HelmService } = await import("../../src/server/service.ts");
  const { toHelmSettings } = await import("../../src/server/settings.ts");
  const h = await createHarness();
  const svc = new HelmService(h.engine);
  const stored: Record<string, string> = {};
  svc.writeSettings = async (v) => {
    Object.assign(stored, v);
    Object.assign(h.engine.settings, toHelmSettings(stored));
  };
  assert.deepEqual(svc.permissions().approvePrompts, "supervisor");
  const r = await svc.setPermissions({ modes: { lead: "full", specialist: "accept-edits" }, approvePrompts: "human" });
  assert.deepEqual(stored, { permissionLead: "full", permissionSpecialist: "accept-edits", approvePrompts: "human" });
  assert.equal(r.modes.lead, "full");
  assert.equal(r.modes.manager, "auto");
  assert.equal(r.approvePrompts, "human");
  await assert.rejects(svc.setPermissions({ modes: { boss: "full" } as never }), /Unknown role/);
});
