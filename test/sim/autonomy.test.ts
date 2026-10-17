// "It keeps asking me to approve things every second." With autonomy high (the default for new
// runs) agents' questions go up the chain and the Orchestrator decides; waves and plan changes go
// ahead on the record. Only credentials, spending, private data and access reach the human.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP } from "../helpers/harness.ts";
import { callTool } from "../../src/server/agent/tools.ts";
import { HelmService } from "../../src/server/service.ts";
import { parseBrief, SAMPLE_BRIEF } from "../../src/server/domain/brief.ts";
import type { Autonomy, NodeInfo, Portfolio } from "../../src/shared/types.ts";

const H = 3600_000;
function five(): Portfolio {
  const p = parseBrief(SAMPLE_BRIEF).portfolio;
  return { ...p, apps: p.apps.slice(0, 5).map((a) => ({ ...a, group: null })) };
}

async function setup(autonomy?: Autonomy) {
  const h = await createHarness();
  const { runId } = h.engine.createRun({ name: "Auto", brief: "x", portfolio: five(), slots: CHEAP, limits: { concurrency: 48, ...(autonomy ? { autonomy } : {}) } });
  await h.engine.startRun(runId);
  const spec = h.repo.listNodes(runId).find((n) => n.tier === "specialist")!;
  await h.clock.runUntil(h.clock.now() + 6 * H, { stopWhen: () => !!h.repo.getNode(runId, spec.id)?.threadId });
  return { h, runId, spec: h.repo.getNode(runId, spec.id)!, lead: h.repo.getNode(runId, spec.parentId!)! };
}
const ask = (h: Awaited<ReturnType<typeof createHarness>>, n: NodeInfo, args: Record<string, unknown>) => callTool(h.engine, "helm_need", h.repo.getNode(n.runId, n.id)!.threadId!, { kind: "question", title: "Which date format?", body: "ISO or locale?", options: ["ISO", "Locale"], ...args });

test("new runs default to autonomy high", async () => {
  const { h, runId } = await setup();
  assert.equal(h.engine.run(runId).limits.autonomy, "high");
});

test("a specialist's ordinary question goes to its lead, not the human", async () => {
  const { h, runId, spec, lead } = await setup();
  const open = h.repo.listNeeds(runId, "open").length;
  const r = await ask(h, spec, {});
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^Autonomy is on: sent to .*who decides \(not the human\)/);
  assert.equal(h.repo.listNeeds(runId, "open").length, open, "no Needs-you item");
  const sent = h.repo.outboxForRun(runId).find((o) => o.kind === "send" && o.nodeId === lead.id && /instead of the human because autonomy is on: Which date format\?/.test(String(o.payload.text)));
  assert.ok(sent, "the lead is asked");
});

test("credentials, spending, private data and access still reach the human, labelled", async () => {
  const { h, runId, spec } = await setup();
  for (const [about, label] of [["credentials", "Credentials"], ["spending", "Spending"], ["privacy", "Private data"], ["access", "Access"]] as const) {
    const r = await ask(h, spec, { about, title: `need ${about}` });
    assert.match(r.text, /^Created N-/, r.text);
    assert.ok(h.repo.listNeeds(runId, "open").some((n) => n.title === `${label}: need ${about}`));
  }
});

test("the Orchestrator is told to decide ordinary questions itself", async () => {
  const { h, runId } = await setup();
  const orch = h.repo.getNode(runId, "orch")!;
  const open = h.repo.listNeeds(runId, "open").length;
  const r = await ask(h, orch, {});
  assert.match(r.text, /^Autonomy is on: the human wants you to decide this/);
  assert.equal(h.repo.listNeeds(runId, "open").length, open);
});

test("with autonomy ask, questions reach the human as before", async () => {
  const { h, runId, spec } = await setup("ask");
  const r = await ask(h, spec, {});
  assert.match(r.text, /^Created N-/);
  assert.ok(h.repo.listNeeds(runId, "open").some((n) => n.title === "Which date format?"));
});

test("plan changes are approved on the Orchestrator's behalf and recorded as such", async () => {
  const { h, runId } = await setup();
  const orch = h.repo.getNode(runId, "orch")!;
  const before = h.repo.listApps(runId).length;
  const r = await callTool(h.engine, "helm_propose_plan", orch.threadId!, { delta: { add: [{ name: "Ember", tagline: "a campfire timer", platforms: ["ios"] }], rationale: "the brief asks for it" } });
  assert.match(r.text, /Autonomy is on, so N-\d+ is approved and applied now/, r.text);
  await h.clock.advance(60_000);
  assert.equal(h.repo.listApps(runId).length, before + 1, "the app was added");
  const d = h.repo.listDirectives(runId, 50).find((x) => x.type === "plan")!;
  assert.equal(d.actor, "system", "not attributed to the human");
  assert.match(d.text ?? d.summary, /approved by the Orchestrator; autonomy is on/);
});

test("switching autonomy on mid-run tells every live agent with its next tool result", async () => {
  const { h, runId, spec } = await setup("ask");
  const svc = new HelmService(h.engine);
  await svc.setLimits(runId, { autonomy: "high" });
  assert.equal(h.engine.run(runId).limits.autonomy, "high");
  assert.ok(h.repo.unflushedInbox(runId, spec.id).some((l) => /^Autonomy is now on\. The human wants the Orchestrator to run this build/.test(l.text)));
  assert.ok(h.repo.unflushedInbox(runId, "orch").some((l) => /Decide everything yourself except/.test(l.text)));
  const r = await ask(h, spec, {});
  assert.match(r.text, /^Autonomy is on: sent to/);
});
