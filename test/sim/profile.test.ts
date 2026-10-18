import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP, type Harness } from "../helpers/harness.ts";
import { callTool } from "../../src/server/agent/tools.ts";
import { parseBrief } from "../../src/server/domain/brief.ts";

const H = 3600_000;

async function until(h: Harness, runId: string, nodeId: string) {
  await h.clock.runUntil(h.clock.now() + 6 * H, { stopWhen: () => !!h.repo.getNode(runId, nodeId)?.threadId });
  const t = h.repo.getNode(runId, nodeId)?.threadId;
  assert.ok(t, `${nodeId} should have a thread`);
  return t!;
}

const BRIEF = "# Shop\n- Storefront — Online store with Stripe checkout\n- Atlas — Company site · Website · needs none";

test("a website run: profiles are stored, briefs carry the project section with installed tools, plugins reach the lead", async () => {
  const h = await createHarness();
  const { runId } = h.engine.createRun({ name: "Web", brief: BRIEF, portfolio: parseBrief(BRIEF).portfolio, slots: CHEAP, limits: { concurrency: 48 } });
  const app = h.repo.getApp(runId, "storefront")!;
  assert.equal(app.kind, "web");
  assert.deepEqual(app.needs, ["database", "payments", "security"]);
  assert.deepEqual(h.repo.getApp(runId, "atlas")!.needs, []);
  const data = h.repo.getNode(runId, "storefront.data")!;
  assert.equal(data.slot, "code");
  assert.ok(h.repo.getNode(runId, "storefront.p.web"), "a Web builder");
  assert.deepEqual(h.repo.getNode(runId, "storefront.ui")!.scopeGlobs, ["apps/web/**", "packages/ui/**", "reports/ui/**"]);
  assert.deepEqual((await h.engine.startRun(runId)).problems, []);
  const lead = h.engine.leadOf(runId, "storefront")!;
  await until(h, runId, lead.id);
  const brief = h.engine.buildBrief(h.repo.getRun(runId)!, h.repo.getNode(runId, lead.id)!);
  assert.match(brief, /## The project\nWebsite: /);
  assert.match(brief, /- Docker \(installed\)/, "the host probe found Docker");
  assert.match(brief, /- BB browser-automation plugin \(installed\)/);
  assert.match(brief, /Other BB plugins enabled here[^\n]*\n- automations: /, "the lead hears about other plugins");
  const w = await callTool(h.engine, "helm_world", h.repo.getNode(runId, "orch")!.threadId!, {});
  assert.match(w.text, /"profile":\s*"Website · Database, Payments, Security · Docker, BB browser-automation plugin"/);
});

test("the Orchestrator changes a live project's needs: the squad follows and the lead is told", async () => {
  const h = await createHarness();
  const { runId } = h.engine.createRun({ name: "Web", brief: BRIEF, portfolio: parseBrief(BRIEF).portfolio, slots: CHEAP, limits: { concurrency: 48 } });
  assert.deepEqual((await h.engine.startRun(runId)).problems, []);
  const orch = await until(h, runId, "orch");
  const lead = h.engine.leadOf(runId, "atlas")!;
  const leadThread = await until(h, runId, lead.id);
  const sent: Array<{ threadId: string; text: string }> = [];
  const orig = h.sim.sendMessage.bind(h.sim);
  h.sim.sendMessage = async (a) => (sent.push({ threadId: a.threadId, text: a.text }), orig(a));

  const bad = await callTool(h.engine, "helm_propose_plan", orch, { delta: { profiles: { atlas: { needs: ["teleportation"] } } } });
  assert.match(bad.text, /unknown need/i);
  const r = await callTool(h.engine, "helm_propose_plan", orch, { delta: { profiles: { atlas: { needs: ["hipaa", "auth"] } }, rationale: "it stores patient forms" } });
  assert.ok(!r.isError, r.text);
  await h.clock.advance(60_000);
  const app = h.repo.getApp(runId, "atlas")!;
  assert.deepEqual(app.needs, ["hipaa", "auth"]);
  assert.ok(h.repo.getNode(runId, "atlas.compliance"), "Compliance joined the squad");
  assert.ok(h.repo.getNode(runId, "atlas.security"), "Security stays in the full squad");
  assert.ok(h.engine.plan(runId).apps.find((a) => a.id === "atlas")!.squad.some((m) => m.role === "compliance"));
  await h.clock.advance(2 * 60_000);
  const told = sent.find((m) => m.threadId === leadThread && m.text.includes("Your project's profile changed"));
  assert.ok(told, "the lead was told");
  assert.match(told!.text, /Compliance/);
});

test("a review project: auditors write only reports, and every specialist loads helm-audit", async () => {
  const h = await createHarness();
  const brief = "- Tide audit — Review the existing iOS app · iOS";
  const { runId } = h.engine.createRun({ name: "Audit", brief, portfolio: parseBrief(brief).portfolio, slots: CHEAP, limits: { concurrency: 48 } });
  const nodes = h.repo.listNodes(runId).filter((n) => n.tier === "specialist");
  assert.ok(nodes.length >= 4);
  for (const n of nodes) assert.equal(n.scopeGlobs.length, 1, n.id), assert.match(n.scopeGlobs[0], /^reports\//);
  assert.equal(h.repo.getApp(runId, "tide-audit")!.kind, "review");
});
