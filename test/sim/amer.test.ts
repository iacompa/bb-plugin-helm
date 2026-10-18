// Every run has a Planner (Amer) beside the Orchestrator (Gestra). It is idle until asked, and it
// can design custom agents that never existed (a GitHub sync agent, a storage guard) to report to
// any supervisor. They join through the plan-change flow and are woken by events, never polling.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP, type Harness } from "../helpers/harness.ts";
import { callTool } from "../../src/server/agent/tools.ts";
import { HelmService } from "../../src/server/service.ts";
import { parseBrief, SAMPLE_BRIEF } from "../../src/server/domain/brief.ts";
import type { Autonomy, Portfolio } from "../../src/shared/types.ts";

const H = 3600_000;
function four(): Portfolio {
  const p = parseBrief(SAMPLE_BRIEF).portfolio;
  return { ...p, apps: p.apps.slice(0, 4).map((a) => ({ ...a, group: null })) };
}

async function setup(autonomy?: Autonomy) {
  const h = await createHarness();
  const { runId } = h.engine.createRun({ name: "Company", brief: "x", portfolio: four(), slots: { ...CHEAP, planner: undefined }, limits: { concurrency: 48, ...(autonomy ? { autonomy } : {}) } });
  assert.deepEqual((await h.engine.startRun(runId)).problems, []);
  await h.clock.runUntil(h.clock.now() + 6 * H, { stopWhen: () => ["orch", "planner"].every((id) => !!h.repo.getNode(runId, id)?.threadId) });
  const lead = h.repo.listNodes(runId).find((n) => n.tier === "lead")!;
  return { h, runId, lead, svc: new HelmService(h.engine) };
}

const as = (h: Harness, runId: string, id: string, name: string, args: unknown) => callTool(h.engine, name, h.repo.getNode(runId, id)!.threadId!, args);
const sentTo = (h: Harness, runId: string, id: string, re: RegExp) => h.repo.outboxForRun(runId).some((o) => o.kind === "send" && o.nodeId === id && re.test(String(o.payload.text)));

const LEDGER = {
  name: "Ledger",
  title: "GitHub Sync",
  mission: "Purpose: make sure every signed-off project's work is on GitHub. When you act: when woken by a sign-off. Never push without the human.",
  reportsTo: "orch",
  wakeOn: ["signoff", "stage"],
  reason: "the human wants everything on GitHub",
};

test("the run starts with Amer · Planner and Gestra · Orchestrator; the Planner is visible and never picks an expensive model by itself", async () => {
  const { h, runId } = await setup();
  const planner = h.repo.getNode(runId, "planner")!;
  assert.equal(planner.tier, "planner");
  assert.equal(planner.parentId, null, "outside the chain of command");
  assert.equal(h.engine.label(planner), "Amer · Planner");
  assert.equal(h.engine.label(h.repo.getNode(runId, "orch")!), "Gestra · Orchestrator");
  const t = h.sim.helmThreads().find((x) => x.id === planner.threadId)!;
  assert.equal(t.title, "Amer · Planner · Company");
  // no Planner role and no default in Settings: it uses the Orchestrator's model
  assert.equal(h.engine.run(runId).slots.orchestrator?.modelId, "claude-haiku-5-5");
  assert.equal(h.engine.effectiveModel(h.engine.run(runId), planner)?.modelId, "claude-haiku-5-5");
  assert.equal(planner.modelOverride, false);
});

test("the Planner adds a custom agent under the Orchestrator: it starts, the Orchestrator is told, and events wake it", async () => {
  const { h, runId } = await setup();
  const r = await as(h, runId, "planner", "helm_create_agent", LEDGER);
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /^Created Ledger · GitHub Sync \(x-ledger\), reporting to Gestra · Orchestrator; it starts now/);
  assert.match(r.text, /bb helm rename x-ledger/);
  const n = h.repo.getNode(runId, "x-ledger")!;
  assert.equal(n.tier, "custom");
  assert.equal(n.parentId, "orch");
  assert.deepEqual(n.scopeGlobs, ["agents/ledger/**"]);
  assert.deepEqual(n.wakeOn, ["signoff", "stage"]);
  assert.equal(n.createdBy, "planner");
  assert.ok(h.repo.listNeeds(runId, "open").every((x) => x.kind !== "plan"), "autonomy approved it; nothing in Needs you");
  assert.ok(h.repo.recentInbox(runId, "orch", 50).some((x) => /Ledger · GitHub Sync \(x-ledger\) joined your team/.test(x.text)), "the Orchestrator was told");

  await h.clock.runUntil(h.clock.now() + 6 * H, { stopWhen: () => !!h.repo.getNode(runId, "x-ledger")?.threadId });
  const t = h.sim.helmThreads().find((x) => x.id === h.repo.getNode(runId, "x-ledger")!.threadId)!;
  assert.equal(t.title, "Ledger · GitHub Sync");

  await h.clock.runUntil(h.clock.now() + 24 * H, { stopWhen: () => sentTo(h, runId, "x-ledger", /Helm wake-up \(stage\)/) });
  assert.ok(sentTo(h, runId, "x-ledger", /Helm wake-up \(stage\)/), "woken by a stage change");
});

test("a custom agent under an app lead works in that project; bad designs are refused with the fix", async () => {
  const { h, runId, lead } = await setup();
  const r = await as(h, runId, "planner", "helm_create_agent", { name: "Vera", title: "HIPAA Reviewer", mission: "Purpose: review every change for HIPAA safeguards and write findings to reports/vera. Never touch production data.", reportsTo: lead.id, skills: ["helm-compliance"] });
  assert.ok(!r.isError, r.text);
  const n = h.repo.getNode(runId, `${lead.appId}.x-vera`)!;
  assert.equal(n.appId, lead.appId);
  assert.deepEqual(n.scopeGlobs, ["reports/vera/**"]);

  const dup = await as(h, runId, "planner", "helm_create_agent", { ...LEDGER, name: "vera" });
  assert.match(dup.text, /vera is already the name of Vera · HIPAA Reviewer/);
  const amer = await as(h, runId, "planner", "helm_create_agent", { ...LEDGER, name: "Amer" });
  assert.match(amer.text, /already the name of Amer · Planner/);
  const spec = h.repo.listNodes(runId).find((x) => x.tier === "specialist")!;
  assert.match((await as(h, runId, "planner", "helm_create_agent", { ...LEDGER, reportsTo: spec.id })).text, /cannot supervise agents/);
  assert.match((await as(h, runId, "planner", "helm_create_agent", { ...LEDGER, writes: ["/etc/**"] })).text, /must be a relative path/);
  assert.match((await as(h, runId, "planner", "helm_create_agent", { ...LEDGER, skills: ["helm-wizardry"] })).text, /No craft skill helm-wizardry/);
  assert.match((await as(h, runId, "planner", "helm_create_agent", { ...LEDGER, wakeOn: ["hourly"] })).text, /wakeOn\.0: Invalid option/);
});

test("with autonomy ask, a new agent waits for the human in Needs you", async () => {
  const { h, runId } = await setup("ask");
  const r = await as(h, runId, "planner", "helm_create_agent", LEDGER);
  assert.match(r.text, /^Raised N-\d+: the human approves Ledger in Needs you/);
  assert.equal(h.repo.getNode(runId, "x-ledger"), null);
  const need = h.repo.listNeeds(runId, "open").find((x) => x.kind === "plan")!;
  assert.match(need.title, /New agent: Ledger · GitHub Sync → reports to Gestra · Orchestrator/);
  await h.resolve(runId, need.id, { action: "approve", text: "yes", actor: "human" });
  assert.ok(h.repo.getNode(runId, "x-ledger"), "created on approval");
});

test("only the Planner designs agents; the human renames anyone and retires custom agents", async () => {
  const { h, runId, lead, svc } = await setup();
  const denied = await as(h, runId, "orch", "helm_create_agent", LEDGER);
  assert.ok(denied.isError && /is for the Planner/.test(denied.text), denied.text);
  assert.ok(!(await as(h, runId, "planner", "helm_create_agent", LEDGER)).isError);

  assert.equal(svc.rename(runId, "Gestra", "Atlas"), "Atlas · Orchestrator");
  assert.equal(svc.rename(runId, "planner", "Nova"), "Nova · Planner");
  assert.equal(svc.rename(runId, "Ledger", "Keel"), "Keel · GitHub Sync");
  assert.throws(() => svc.rename(runId, "Keel", "Atlas"), /already the name of Atlas · Orchestrator/);
  assert.deepEqual(svc.agents(runId).map((a) => a.label).sort(), ["Atlas · Orchestrator", "Git Pusher · Git agent", "Keel · GitHub Sync", "Nova · Planner"]);

  assert.match(svc.retire(runId, lead.id, "no"), /only custom agents can be retired/);
  assert.match(svc.retire(runId, "Keel", "not needed"), /Keel · GitHub Sync retired \(not needed\)/);
  assert.equal(h.repo.getNode(runId, "x-ledger")!.status, "done");
  assert.equal(svc.rename(runId, "orch", "Keel"), "Keel · Orchestrator", "a retired agent's name is free again");
});

test("supervisors and the Planner can talk; the human's question reaches the Planner and steers nobody", async () => {
  const { h, runId, lead, svc } = await setup();
  await h.clock.runUntil(h.clock.now() + 6 * H, { stopWhen: () => !!h.repo.getNode(runId, lead.id)?.threadId });
  const m = await as(h, runId, lead.id, "helm_message", { to: "planner", text: "Would a release-notes agent help?", kind: "ask" });
  assert.ok(!m.isError, m.text);

  const directives = h.repo.listDirectives(runId, 50).length;
  const r = await svc.ask(runId, "Should we add a HIPAA agent for the clinic app?");
  assert.equal(r.delivered, "now");
  assert.ok(sentTo(h, runId, "planner", /From the human \(bb helm ask\): Should we add a HIPAA agent/));
  assert.equal(h.repo.listDirectives(runId, 50).length, directives, "asking the Planner is not a directive");
});

test("a due message behind a later one for the same agent waits without spinning the outbox", async () => {
  const { h, runId } = await setup();
  const t = h.clock.now();
  h.repo.enqueue({ id: "o-later", runId, kind: "send", nodeId: "orch", payload: { text: "later" }, idemKey: "spin:later", notBefore: t + 120_000 });
  h.repo.enqueue({ id: "o-now", runId, kind: "send", nodeId: "orch", payload: { text: "now" }, idemKey: "spin:now" });
  h.engine.outbox.kick();
  const steps = await h.clock.runUntil(t + 60_000);
  assert.ok(steps < 500, `the clock ran ${steps} timers in one virtual minute`);
  await h.clock.runUntil(t + 10 * 60_000);
  assert.equal(h.repo.getOutbox("o-now")?.state, "done", "delivered once the earlier row went");
});
