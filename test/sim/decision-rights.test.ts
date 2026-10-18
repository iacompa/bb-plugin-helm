// "Whatever the manager can handle, they should handle." Leads decide inside their apps and
// managers inside their groups; only what crosses a remit, the owner's call, or the human-only
// four go up. Upward questions are capped so the Orchestrator is not flooded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP, type Harness } from "../helpers/harness.ts";
import { callTool } from "../../src/server/agent/tools.ts";
import { parseBrief, SAMPLE_BRIEF } from "../../src/server/domain/brief.ts";
import type { NodeInfo, Portfolio } from "../../src/shared/types.ts";

const H = 3600_000;
function six(): Portfolio {
  const p = parseBrief(SAMPLE_BRIEF).portfolio;
  return { ...p, apps: p.apps.slice(0, 6).map((a) => ({ ...a, group: null })) };
}

async function setup() {
  const h = await createHarness();
  const { runId } = h.engine.createRun({ name: "Co", brief: "x", portfolio: six(), slots: CHEAP, limits: { concurrency: 64 } });
  assert.deepEqual((await h.engine.startRun(runId)).problems, []);
  const nodes = h.repo.listNodes(runId);
  const mgr = nodes.find((n) => n.tier === "manager")!;
  const lead = nodes.find((n) => n.tier === "lead" && n.parentId === mgr.id)!;
  const spec = nodes.find((n) => n.tier === "specialist" && n.parentId === lead.id)!;
  await h.clock.runUntil(h.clock.now() + 6 * H, { stopWhen: () => [mgr, lead, spec].every((n) => !!h.repo.getNode(runId, n.id)?.threadId) });
  return { h, runId, mgr, lead, spec };
}
const as = (h: Harness, n: NodeInfo, name: string, args: unknown) => callTool(h.engine, name, h.repo.getNode(n.runId, n.id)!.threadId!, args);
const need = (title: string, about = "other") => ({ kind: "question", about, title, body: "Which one?", options: ["A", "B"] });
const woke = (h: Harness, runId: string, to: string, re: RegExp) => h.repo.outboxForRun(runId).some((o) => o.kind === "send" && o.nodeId === to && re.test(String(o.payload.text)));

test("a lead decides its own app's questions; a manager decides its own group's; nobody above is woken", async () => {
  const { h, runId, mgr, lead } = await setup();
  const open = h.repo.listNeeds(runId, "open").length;
  const l = await as(h, lead, "helm_need", need("Tabs or a sidebar for settings?"));
  assert.match(l.text, /^Autonomy is on, and this is your call: you decide what is inside /);
  assert.ok(!woke(h, runId, mgr.id, /Tabs or a sidebar/), "the manager is not asked");
  const m = await as(h, mgr, "helm_need", need("Which of my apps goes to Review first?"));
  assert.match(m.text, /this is your call: you decide what is inside your group/);
  assert.match(m.text, /Ask the Orchestrator \(helm_message, kind ask\) only if it crosses into another group/);
  assert.ok(!woke(h, runId, "orch", /Which of my apps/), "the Orchestrator is not asked");
  assert.equal(h.repo.listNeeds(runId, "open").length, open, "and not the human");
});

test("a worker's question still goes to its lead, which is told it is inside its remit", async () => {
  const { h, runId, lead, spec } = await setup();
  const r = await as(h, spec, "helm_need", need("ISO or locale dates?"));
  assert.match(r.text, /sent to .* who decides \(not the human\)/);
  assert.ok(woke(h, runId, lead.id, /ISO or locale dates\?.*It is inside your remit: do not pass it up/s));
});

test("the owner's call climbs lead → manager → Orchestrator, which decides it from the brief; it never reaches the human hands-off", async () => {
  const { h, runId, mgr, lead } = await setup();
  const before = h.repo.listNeeds(runId, "open").length;
  const l = await as(h, lead, "helm_need", need("Is the free tier limited to 3 notes?", "owner"));
  assert.match(l.text, /sent to .* who decides/);
  assert.ok(woke(h, runId, mgr.id, /only the owner can answer.*helm_need \(about: owner\)/s));
  const m = await as(h, mgr, "helm_need", need("Is the free tier limited to 3 notes?", "owner"));
  assert.match(m.text, /sent to .* who decides/, m.text);
  assert.ok(woke(h, runId, "orch", /only the owner can answer.*choose what serves the brief best/s));
  const o = await as(h, h.repo.getNode(runId, "orch")!, "helm_need", need("Is the free tier limited to 3 notes?", "owner"));
  assert.match(o.text, /^Autonomy is on: the human wants you to decide this/);
  assert.equal(h.repo.listNeeds(runId, "open").length, before, "nothing in Needs you");
});

test("upward questions are capped: the fourth in an hour arrives as FYI and does not wake the Orchestrator", async () => {
  const { h, runId, mgr } = await setup();
  for (let i = 1; i <= 3; i++) {
    const r = await as(h, mgr, "helm_message", { to: "orch", text: `GO for item ${i}?`, kind: "ask" });
    assert.match(r.text, new RegExp(`^Sent to .*\\(${i} of 3 questions this hour`));
  }
  const fourth = await as(h, mgr, "helm_message", { to: "orch", text: "GO for item 4?", kind: "ask" });
  assert.match(fourth.text, /as FYI.*already asked 3 questions this hour/s);
  assert.ok(!woke(h, runId, "orch", /GO for item 4/), "not a waking message");
  assert.ok(h.repo.recentInbox(runId, "orch", 20).some((x) => /GO for item 4/.test(x.text)), "read on its next turn");
  await h.clock.runUntil(h.clock.now() + 61 * 60_000);
  assert.match((await as(h, mgr, "helm_message", { to: "orch", text: "GO for item 5?", kind: "ask" })).text, /^Sent to /, "the window slides");
});

test("briefs give each supervisor its authority; the Orchestrator never hands out per-item GOs", async () => {
  const { h, runId, mgr, lead } = await setup();
  const brief = (n: NodeInfo) => h.engine.buildBrief(h.engine.run(runId), h.repo.getNode(runId, n.id)!);
  const orch = brief(h.repo.getNode(runId, "orch")!);
  assert.match(orch, /## Your authority\nYou set the strategy and delegate/);
  assert.match(orch, /never require a per-item GO \/ NO-GO/);
  assert.match(brief(mgr), /## Your authority\nYou run your group \(.+\) like a department head/);
  assert.match(brief(lead), /## Your authority\nYou run .+: you are the busiest one, and you keep it moving\. Inside it you decide/);
});
