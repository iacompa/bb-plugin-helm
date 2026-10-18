// Hands-off (autonomy high): the team decides what Helm used to put in Needs you (the Fixer takes
// failed and stuck agents, supervisors the rest), and installs go through the Git agent's ledger.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP, type Harness } from "../helpers/harness.ts";
import { handleEvent, watchdog } from "../../src/server/engine/events.ts";
import { callTool } from "../../src/server/agent/tools.ts";
import { AUTO_RETRIES, CARD_TIMEOUT_MS } from "../../src/server/engine/handsoff.ts";
import { installsText } from "../../src/server/engine/installs.ts";
import { FIXER_ID, GIT_ID, wakeFixer } from "../../src/server/engine/custom.ts";
import { toHelmSettings } from "../../src/server/settings.ts";
import type { Portfolio } from "../../src/shared/types.ts";
import type { HelmThreadMeta } from "../../src/server/bb/port.ts";
import type { Profile } from "../../src/server/bb/sim-agents.ts";

const H = 3600_000;
const app = (name: string) => ({ name, tagline: `${name} app`, platforms: ["ios" as const], shape: "lean" as const });
const pf = (...names: string[]): Portfolio => ({ apps: names.map(app), groups: [], assumptions: [], questions: [] }) as unknown as Portfolio;
const sentTo = (h: Harness, runId: string, id: string, re: RegExp) => h.repo.outboxForRun(runId).some((o) => o.kind === "send" && o.nodeId === id && re.test(String(o.payload.text)));

async function started(names = ["Alpha", "Beta"], limits: Record<string, unknown> = {}, profileFor?: (m: HelmThreadMeta) => Profile) {
  const h = await createHarness(profileFor ? { profileFor } : {});
  const { runId } = h.engine.createRun({ name: "Co", brief: "x", portfolio: pf(...names), slots: CHEAP, limits: { concurrency: 48, autonomy: "high", ...limits } });
  assert.deepEqual((await h.engine.startRun(runId)).problems, []);
  return { h, runId };
}

async function withThreads(h: Harness, runId: string, ...ids: string[]) {
  await h.clock.runUntil(h.clock.now() + 6 * H, { stopWhen: () => ids.every((id) => !!h.repo.getNode(runId, id)?.threadId) });
  for (const id of ids) assert.ok(h.repo.getNode(runId, id)?.threadId, `${id} has a thread`);
}

const builderOf = (h: Harness, runId: string, appId: string) => h.repo.listNodes(runId).find((n) => n.appId === appId && n.tier === "specialist")!;

test("a failing agent is retried automatically, twice, before anyone is asked; then the Fixer decides, not the human", async () => {
  const { h, runId } = await started();
  const b = builderOf(h, runId, "alpha");
  await withThreads(h, runId, b.id, b.parentId!);
  const lead = h.repo.getNode(runId, b.parentId!)!;
  const fx = h.repo.getNode(runId, FIXER_ID)!;
  assert.ok(fx, "every run has a Fixer");
  assert.ok(!fx.threadId && fx.status === "planned", "it waits for its first card");
  for (let k = 1; k <= AUTO_RETRIES; k++) {
    await handleEvent(h.engine, { type: "thread.failed", threadId: h.repo.getNode(runId, b.id)!.threadId!, error: "Command turn.submit failed" } as never);
    assert.equal(h.repo.getNode(runId, b.id)!.status, "failed");
    assert.equal(h.repo.openNeedsFor(runId, b.id).length, 0, `no card after failure ${k}`);
    await h.clock.advance((k === 1 ? 2 : 10) * 60_000 + 1000);
    await watchdog(h.engine);
    assert.ok(h.repo.outboxForRun(runId).some((o) => o.kind === "retry" && o.nodeId === b.id && String(o.idemKey).startsWith("autoretry:")), `retry ${k} was sent`);
  }
  await handleEvent(h.engine, { type: "thread.failed", threadId: h.repo.getNode(runId, b.id)!.threadId!, error: "Command turn.submit failed" } as never);
  const card = h.repo.openNeedsFor(runId, b.id).find((n) => n.kind === "failed")!;
  assert.ok(card, "after the automatic retries a card is raised");
  assert.equal(card.handler, FIXER_ID, "the Fixer decides");
  assert.match(card.body, /Helm retried it 2 times automatically/);
  assert.match(card.body, /Worktree: .*intact/, "the card says where the worktree is");
  assert.ok(sentTo(h, runId, FIXER_ID, new RegExp(`Card ${card.id} is yours to decide`)));
  assert.equal(h.repo.getNode(runId, FIXER_ID)!.status, "queued", "the Fixer starts with its first card");
  // only the decider may resolve it
  const wrong = await callTool(h.engine, "helm_resolve", lead.threadId!, { needId: card.id, action: "retry" });
  assert.match(wrong.text, /is for fixer to decide, not you/);
  // the Fixer starts, reads the card and retries the agent
  await h.clock.runUntil(h.clock.now() + 2 * H, { stopWhen: () => h.repo.getNeed(runId, card.id)!.state !== "open" });
  assert.equal(h.repo.getNeed(runId, card.id)!.state, "resolved");
  const d = h.repo.listDirectives(runId, 50).find((x) => x.type === "retry" && x.summary.includes("Fixer"))!;
  assert.ok(d, "a retry directive by the Fixer");
  assert.equal(d.actor, "system", "not recorded as the human's");
  assert.match(d.summary, /\(by Fixer\)/);
  const reported = () => (h.repo.db.prepare("SELECT COUNT(*) AS c FROM comms WHERE run_id = ? AND from_node = ? AND to_node = 'orch' AND kind LIKE 'report.%'").get(runId, FIXER_ID) as { c: number }).c > 0;
  await h.clock.runUntil(h.clock.now() + H, { stopWhen: reported });
  assert.ok(reported(), "the Fixer reports to the Orchestrator");
});

test("a failure a retry cannot fix (missing folder, exhausted account) skips the automatic retries", async () => {
  const { h, runId } = await started();
  const b = builderOf(h, runId, "alpha");
  await withThreads(h, runId, b.id, b.parentId!);
  await handleEvent(h.engine, { type: "thread.failed", threadId: h.repo.getNode(runId, b.id)!.threadId!, error: "Unmanaged workspace path does not exist: /tmp/gone" } as never);
  const card = h.repo.openNeedsFor(runId, b.id).find((n) => n.kind === "failed")!;
  assert.ok(card, "raised at once");
  assert.equal(card.handler, FIXER_ID);
  assert.match(card.body, /Worktree: /);
});

test("when the Fixer cannot act, a failed agent's card goes to its lead; the Fixer's own failure goes to the Orchestrator", async () => {
  const { h, runId } = await started();
  const b = builderOf(h, runId, "alpha");
  await withThreads(h, runId, b.id, b.parentId!, "orch");
  h.repo.updateNode(runId, FIXER_ID, { status: "paused" });
  const c1 = h.repo.tx(() => h.engine.raiseNeed(runId, { kind: "stalled", nodeId: b.id, appId: b.appId, title: "stuck", body: "", evidence: "", options: [] }))!;
  assert.equal(c1.handler, b.parentId);
  const c2 = h.repo.tx(() => h.engine.raiseNeed(runId, { kind: "failed", nodeId: FIXER_ID, appId: null, title: "Fixer failed", body: "", evidence: "", options: [] }))!;
  assert.equal(c2.handler, "orch");
});

test("without autonomy, a failure still comes straight to the human", async () => {
  const { h, runId } = await started(["Alpha", "Beta"], { autonomy: "ask" });
  const b = builderOf(h, runId, "alpha");
  await withThreads(h, runId, b.id);
  await handleEvent(h.engine, { type: "thread.failed", threadId: h.repo.getNode(runId, b.id)!.threadId!, error: "Command turn.submit failed" } as never);
  assert.equal(h.repo.openNeedsFor(runId, b.id).find((n) => n.kind === "failed")?.handler, "human");
});

test("a card left undecided moves up a level, and reaches the human only after the Orchestrator", async () => {
  // a Fixer that hangs: its cards are not decided
  const { h, runId } = await started(["Alpha", "Beta"], {}, (m) => (m.role === "fixer" ? "silent" : "diligent"));
  const b = builderOf(h, runId, "alpha");
  await withThreads(h, runId, b.id, b.parentId!, "orch");
  const raised = h.repo.tx(() => h.engine.raiseNeed(runId, { kind: "stalled", nodeId: b.id, appId: b.appId, title: "Alpha builder looks stuck", body: "x", evidence: "", options: ["Nudge again", "Retry", "Stop"] }))!;
  const chain = [raised.handler];
  for (let k = 0; k < 4 && h.repo.getNeed(runId, raised.id)!.handler !== "human"; k++) {
    await h.clock.advance(CARD_TIMEOUT_MS + 60_000);
    await watchdog(h.engine);
    chain.push(h.repo.getNeed(runId, raised.id)!.handler);
  }
  assert.equal(chain[0], FIXER_ID, "the Fixer first");
  assert.ok(chain.includes("orch"), `the Orchestrator before the human: ${chain.join(" → ")}`);
  assert.equal(chain[chain.length - 1], "human");
  assert.equal(chain[chain.length - 2], "orch");
});

test("sign-off is the manager's call hands-off: helm_resolve signs the app off on the record", async () => {
  const { h, runId } = await started(["Alpha", "Beta", "Gamma", "Delta", "Echo"], { managerSpan: 2 });
  await h.clock.runUntil(h.clock.now() + 72 * H, { maxSteps: 2_000_000, stopWhen: () => h.repo.listNeeds(runId, "open").some((n) => n.kind === "signoff") });
  const so = h.repo.listNeeds(runId, "open").find((n) => n.kind === "signoff")!;
  assert.ok(so, "an app reached sign-off");
  const appInfo = h.repo.getApp(runId, so.appId!)!;
  const judge = appInfo.managerNodeId ?? "orch";
  assert.equal(so.handler, judge, "its manager (or the Orchestrator) decides, not the lead and not the human");
  const lead = h.engine.leadOf(runId, so.appId!)!;
  const notLead = await callTool(h.engine, "helm_resolve", lead.threadId!, { needId: so.id, action: "signoff" });
  assert.match(notLead.text, /is for .* to decide, not you/);
  const r = await callTool(h.engine, "helm_resolve", h.repo.getNode(runId, judge)!.threadId!, { needId: so.id, action: "signoff", text: "both gates passed on this commit, checks green" });
  assert.match(r.text, /signoff done/, r.text);
  assert.equal(h.repo.getApp(runId, so.appId!)!.stage, "done");
  const d = h.repo.listDirectives(runId, 50).find((x) => x.type === "signoff")!;
  assert.equal(d.actor, "system");
  assert.match(d.summary, /\(by /);
  assert.ok(sentTo(h, runId, GIT_ID, new RegExp(`signed off ${appInfo.name}`)), "the Git agent does what the human's setting says");
});

test("Needs you lists only the human's cards; the team's are counted apart", async () => {
  const { h, runId } = await started();
  const b = builderOf(h, runId, "alpha");
  await withThreads(h, runId, b.id, b.parentId!);
  h.repo.tx(() => h.engine.raiseNeed(runId, { kind: "stalled", nodeId: b.id, appId: b.appId, title: "stuck", body: "", evidence: "", options: [] }));
  h.repo.tx(() => h.engine.raiseNeed(runId, { kind: "budget", nodeId: null, appId: null, title: "Budget cap reached", body: "", evidence: "", options: [] }));
  const { openNeeds } = await import("../../components/helm/store.ts");
  const open = openNeeds({ needs: h.repo.listNeeds(runId) });
  assert.deepEqual(open.map((n) => n.title), ["Budget cap reached"], "spending stays with the human");
});

test("installs: any agent asks the Git agent; the ledger keeps what, where, how, why and who needed it, and everyone who asked is told", async () => {
  const { h, runId } = await started();
  const a = builderOf(h, runId, "alpha");
  const b = h.repo.listNodes(runId).find((n) => n.appId === "alpha" && n.tier === "specialist" && n.id !== a.id) ?? builderOf(h, runId, "beta");
  await withThreads(h, runId, a.id, b.id);
  const where = "/Projects/alpha";
  const r1 = await callTool(h.engine, "helm_install", h.repo.getNode(runId, a.id)!.threadId!, { what: "node_modules (npm ci)", why: "run the unit tests", where });
  assert.match(r1.text, /^Asked the Git agent for I-1 /, r1.text);
  const r2 = await callTool(h.engine, "helm_install", h.repo.getNode(runId, b.id)!.threadId!, { what: "node_modules  (npm ci)", why: "typecheck needs the types", where });
  assert.match(r2.text, /^Already asked for as I-1/);
  assert.ok(sentTo(h, runId, GIT_ID, /Install request I-1 from .*The human allows installs: do it now/s), "the Git agent is asked, with the rule");
  await withThreads(h, runId, GIT_ID);
  const git = h.repo.getNode(runId, GIT_ID)!;
  // only the Git agent records installs, and a done install names its command
  const nope = await callTool(h.engine, "helm_installed", h.repo.getNode(runId, a.id)!.threadId!, { id: "I-1", state: "done", command: "npm ci" });
  assert.equal(nope.isError, true);
  assert.match((await callTool(h.engine, "helm_installed", git.threadId!, { id: "I-1", state: "done" })).text, /exact command/);
  const ok = await callTool(h.engine, "helm_installed", git.threadId!, { id: "I-1", state: "done", command: "npm ci", note: "added 812 packages" });
  assert.match(ok.text, /Recorded I-1 as done; the 2 agents that asked were told/);
  for (const id of [a.id, b.id]) assert.ok(sentTo(h, runId, id, /Install I-1 is done: node_modules \(npm ci\) in \/Projects\/alpha \(npm ci\)/), id);
  const x = h.repo.getInstall(runId, "I-1")!;
  assert.equal(x.state, "done");
  assert.deepEqual(x.neededBy.map((n) => n.nodeId), [a.id, b.id]);
  const text = installsText(h.engine, runId);
  assert.match(text, /I-1 {2}done {2}node_modules \(npm ci\) {2}— {2}\/Projects\/alpha/);
  assert.match(text, /command: npm ci/);
  assert.match(text, /needed by .*: run the unit tests/);
  assert.match(text, /needed by .*: typecheck needs the types/);
});

test("the shared rules and briefs tell every agent to keep moving and to ask the Git agent for installs", async () => {
  const { COMMON_RULES } = await import("../../src/server/domain/roles.ts");
  const all = COMMON_RULES.join("\n");
  assert.match(all, /Installs and downloads need nobody's approval: ask the Git agent with `helm_install/);
  assert.match(all, /needs no GO, allowance, time box or written authority/);
  const { h, runId } = await started();
  const lead = h.engine.leadOf(runId, "alpha")!;
  const brief = h.engine.buildBrief(h.engine.run(runId), lead);
  assert.match(brief, /Helm hands you your squad's BB prompts \(helm_resolve\)/);
  assert.match(brief, /The Fixer takes a builder or gate that fails/);
  const fixerBrief = h.engine.buildBrief(h.engine.run(runId), h.repo.getNode(runId, FIXER_ID)!);
  assert.match(fixerBrief, /## Your cards/);
  assert.match(fixerBrief, /workspace path does not exist/);
  assert.match(fixerBrief, /Start now: read FIXER-NOTES\.md/);
});

test("the Fixer's model: its role in the run, else the default in Settings, else the Orchestrator's; and it can move any agent's model", async () => {
  const s = toHelmSettings({ fixerModel: "claude-code/claude-opus-5-5:high", fixerName: "Mendel" });
  assert.deepEqual(s.defaultModels.fixer, { providerId: "claude-code", modelId: "claude-opus-5-5", reasoning: "high" });
  assert.equal(s.names.fixer, "Mendel");
  const { fixer: _f, ...slots } = CHEAP;
  const h = await createHarness({ settings: { defaultModels: { ...s.defaultModels }, names: { ...s.names } } });
  const { runId } = h.engine.createRun({ name: "Co", brief: "x", portfolio: pf("Alpha", "Beta"), slots, limits: { concurrency: 48, autonomy: "high" } });
  assert.deepEqual((await h.engine.startRun(runId)).problems, []);
  const fx = h.repo.getNode(runId, FIXER_ID)!;
  assert.equal(fx.model?.modelId, "claude-opus-5-5");
  assert.equal(h.engine.label(fx), "Mendel · Fixer");
  const h2 = await createHarness();
  const plain = h2.engine.createRun({ name: "P", brief: "x", portfolio: pf("Alpha", "Beta"), slots: { ...slots, orchestrator: { providerId: "claude-code", modelId: "claude-sonnet-5-5", reasoning: "medium" } }, limits: { concurrency: 48, autonomy: "high" } });
  assert.deepEqual((await h2.engine.startRun(plain.runId)).problems, []);
  assert.equal(h2.repo.getNode(plain.runId, FIXER_ID)!.model?.modelId, "claude-sonnet-5-5", "no default: the Orchestrator's model");
  // it reaches every agent's model, not only those below it
  h.repo.tx(() => wakeFixer(h.engine, runId));
  await h.engine.pump(runId);
  const b = builderOf(h, runId, "alpha");
  await withThreads(h, runId, FIXER_ID, b.id);
  const r = await callTool(h.engine, "helm_set_model", h.repo.getNode(runId, FIXER_ID)!.threadId!, { changes: [{ nodes: [b.id], model: "claude-code/claude-opus-5-5:high" }], reason: "keeps failing on its model" });
  assert.match(r.text, /^D-\d+: /, r.text);
  assert.equal(h.repo.getNode(runId, b.id)!.model?.modelId, "claude-opus-5-5");
  const m = await callTool(h.engine, "helm_message", h.repo.getNode(runId, FIXER_ID)!.threadId!, { to: GIT_ID, text: "recreate the worktree", kind: "ask" });
  assert.doesNotMatch(m.text, /Rejected/);
});

test("failed and stuck agents that reached the human before the Fixer could take them are handed to it once", async () => {
  const { h, runId } = await started();
  const b = builderOf(h, runId, "alpha");
  await withThreads(h, runId, b.id, b.parentId!, "orch");
  const old = h.repo.tx(() => h.engine.raiseNeed(runId, { kind: "failed", nodeId: b.id, appId: b.appId, title: "Alpha builder failed after BB's retries", body: "x", evidence: "", options: [], handler: "human" }))!;
  const budget = h.repo.tx(() => h.engine.raiseNeed(runId, { kind: "budget", nodeId: null, appId: null, title: "Budget cap reached", body: "", evidence: "", options: [], handler: "human" }))!;
  assert.equal(old.handler, "human");
  await watchdog(h.engine);
  assert.equal(h.repo.getNeed(runId, old.id)!.handler, FIXER_ID, "the Fixer takes it");
  assert.equal(h.repo.getNeed(runId, budget.id)!.handler, "human", "spending stays with the human");
  assert.ok(sentTo(h, runId, FIXER_ID, new RegExp(`Card ${old.id} is yours to decide`)));
  // once only: a card the team gave back to the human stays there
  h.repo.setNeedHandler(runId, old.id, "human");
  await watchdog(h.engine);
  assert.equal(h.repo.getNeed(runId, old.id)!.handler, "human");
});
