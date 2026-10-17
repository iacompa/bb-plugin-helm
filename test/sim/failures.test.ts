import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP, type Harness } from "../helpers/harness.ts";
import { watchdog } from "../../src/server/engine/events.ts";
import { createDirective } from "../../src/server/engine/direct.ts";
import type { HelmThreadMeta } from "../../src/server/bb/port.ts";
import type { Profile } from "../../src/server/bb/sim-agents.ts";

const one = (name = "Alpha", platforms = ["ios"]) => ({ apps: [{ name, tagline: "t", platforms }], groups: [], assumptions: [], questions: [] });
const two = { apps: [{ name: "Alpha", tagline: "a", platforms: ["ios"] }, { name: "Beta", tagline: "b", platforms: ["mac"] }], groups: [], assumptions: [], questions: [] };
const H = 3600_000;

async function run(h: Harness, portfolio: unknown, limits: Record<string, number> = {}) {
  const { runId } = h.engine.createRun({ name: "F", brief: "x", portfolio: portfolio as never, slots: CHEAP, limits });
  const r = await h.engine.startRun(runId);
  assert.deepEqual(r.problems, []);
  return runId;
}
const allReady = (h: Harness, runId: string) => h.repo.listApps(runId).every((a) => a.stage === "ready");
const role = (r: string, p: Profile) => (m: HelmThreadMeta): Profile => (m.role === r ? p : "diligent");

function noDuplicateThreads(h: Harness, runId: string) {
  const keys = h.sim.helmThreads().filter((t) => t.meta!.runId === runId).map((t) => t.meta!.key);
  assert.equal(new Set(keys).size, keys.length, "one thread per node and generation");
}

test("A14: a liar specialist's 'done' without evidence is refused and never advances its app", async () => {
  const h = await createHarness({ profileFor: role("ui", "liar") });
  const runId = await run(h, two);
  await h.clock.advance(12 * H);
  const ui = h.repo.listNodes(runId).filter((n) => n.role === "ui");
  for (const n of ui) {
    assert.notEqual(n.status, "done", `${n.id} must not be done`);
    const reps = h.repo.reportsFor(runId, n.id, 10);
    assert.ok(reps.some((r) => !r.verified), `${n.id} has an unverified claim on record`);
  }
  for (const a of h.repo.listApps(runId)) assert.ok(["build", "spec"].includes(a.stage!), `${a.id} stuck before integrate (is ${a.stage})`);
});

test("A16: a sloppy builder's TODO is caught before Ready, fixed, and the shipped HEAD is clean", async () => {
  const h = await createHarness({ profileFor: role("code", "sloppy") });
  const runId = await run(h, one());
  await h.clock.runUntil(h.clock.now() + 48 * H, { stopWhen: () => allReady(h, runId) });
  assert.ok(allReady(h, runId), h.agents.log.slice(-20).join("\n"));
  const app = h.repo.listApps(runId)[0];
  const lead = h.engine.leadOf(runId, app.id)!;
  const root = [...h.sim.git.repos.keys()].find((k) => k.endsWith("/alpha"))!;
  const tree = h.sim.git.treeAt(root, lead.branch!)!;
  assert.ok(tree.size > 3);
  for (const [p, c] of tree) assert.ok(!/TODO/.test(c), `${p} still has a TODO`);
  const caught = h.repo.events(runId, lead.id, 200).some((e) => /slop|scanner|zero-tolerance/i.test(e.summary)) || h.repo.findings(runId, app.id).length > 0;
  assert.ok(caught, "the scanner or the slop gate caught it");
  const stale = h.repo.findings(runId, app.id).filter((f) => f.status === "open");
  assert.deepEqual(stale.map((f) => `${f.id} ${f.gate} ${f.rule}`), [], "a gate passing a newer commit closes its earlier findings");
});

test("A15: a gate that edits files is refused (read-only violation) and its verdict does not count", async () => {
  const h = await createHarness({ profileFor: role("review", "vandal") });
  const runId = await run(h, one());
  await h.clock.advance(24 * H);
  const app = h.repo.listApps(runId)[0];
  assert.notEqual(app.stage, "ready");
  const rev = h.repo.listNodes(runId).find((n) => n.role === "review")!;
  const ev = h.repo.events(runId, rev.id, 100).map((e) => e.summary).join("\n");
  assert.match(ev, /read-only/i);
  assert.equal(h.repo.verdicts(runId, app.id).filter((v) => v.accepted).length, 0);
});

test("A18: a failing agent raises a need with BB's error; Retry recovers it and the app reaches Ready", async () => {
  const h = await createHarness({ profileFor: role("code", "flaky") });
  const runId = await run(h, one());
  await h.clock.runUntil(h.clock.now() + 12 * H, { stopWhen: () => h.repo.listNeeds(runId, "open").some((n) => n.kind === "failed") });
  const need = h.repo.listNeeds(runId, "open").find((n) => n.kind === "failed")!;
  assert.ok(need, "a failed need is raised");
  assert.match(need.title + need.body + need.evidence, /fail|error|overloaded/i);
  assert.equal(h.repo.getNode(runId, need.nodeId!)!.status, "failed");
  // retry until the flaky agent recovers (it fails twice)
  for (let k = 0; k < 4 && !allReady(h, runId); k++) {
    const open = h.repo.listNeeds(runId, "open").find((n) => n.kind === "failed");
    if (open) await h.resolve(runId, open.id, { action: "retry" });
    await h.clock.runUntil(h.clock.now() + 24 * H, { stopWhen: () => allReady(h, runId) || h.repo.listNeeds(runId, "open").some((n) => n.kind === "failed") });
  }
  assert.ok(allReady(h, runId));
  noDuplicateThreads(h, runId);
});

test("A19: a silent agent is nudged once, then raised as stalled — from Helm's own database, no polling", async () => {
  const h = await createHarness({ profileFor: role("ui", "silent") });
  const runId = await run(h, one());
  // the plain watchdog: this run has no Watcher model
  const r0 = h.repo.getRun(runId)!;
  const { watcher: _w, ...noWatcher } = r0.slots;
  h.repo.updateRun(runId, { slots: noWatcher });
  const ui = () => h.repo.listNodes(runId).find((n) => n.role === "ui")!;
  await h.clock.runUntil(h.clock.now() + 6 * H, { stopWhen: () => !!ui().threadId });
  const stall = h.repo.getRun(runId)!.limits.stallMinutes * 60_000;
  const callsBefore = h.sim.calls.filter((c) => c.method === "threadState").length;
  await h.clock.advance(stall + 60_000);
  const w1 = await watchdog(h.engine);
  assert.ok(w1.nudged.includes(ui().id));
  assert.equal(h.sim.calls.filter((c) => c.method === "threadState").length, callsBefore, "the watchdog asked BB nothing");
  await h.clock.advance(stall + 60_000);
  const w2 = await watchdog(h.engine);
  assert.ok(w2.stalled.includes(ui().id));
  assert.ok(h.repo.listNeeds(runId, "open").some((n) => n.kind === "stalled" && n.nodeId === ui().id));
  const w3 = await watchdog(h.engine);
  assert.equal(w3.nudged.length + w3.stalled.length, 0, "nudged once, raised once");
});

test("A20: reaching the budget cap pauses new spawns and raises one budget need; raising the cap resumes", async () => {
  const h = await createHarness();
  const runId = await run(h, two, { budgetCap: 0.1 });
  await h.clock.runUntil(h.clock.now() + 6 * H, { stopWhen: () => h.repo.getRun(runId)!.spawnsPaused });
  assert.ok(h.repo.getRun(runId)!.spawnsPaused);
  const needs = h.repo.listNeeds(runId, "open").filter((n) => n.kind === "budget");
  assert.equal(needs.length, 1);
  const spawned = h.sim.calls.filter((c) => c.method === "spawnThread").length;
  await h.clock.advance(2 * H);
  assert.equal(h.sim.calls.filter((c) => c.method === "spawnThread").length, spawned, "nothing new starts");
  await h.resolve(runId, needs[0].id, { action: "raise_cap", value: 1_000_000 });
  await h.clock.runUntil(h.clock.now() + 48 * H, { stopWhen: () => allReady(h, runId) });
  assert.ok(allReady(h, runId));
});

test("A21: a crash between BB's spawn and Helm's write never creates a duplicate thread after restart", async () => {
  let h = await createHarness();
  h.sim.crashAfterSpawn = 3;
  const runId = await run(h, two);
  await h.clock.advance(30_000);
  h = await h.restart();
  await h.clock.runUntil(h.clock.now() + 48 * H, { stopWhen: () => allReady(h, runId) });
  assert.ok(allReady(h, runId));
  noDuplicateThreads(h, runId);
  assert.equal(h.repo.outboxForRun(runId, ["failed"]).length, 0);
});

test("restart in the middle of a run: reconcile picks up every thread and the run still finishes", async () => {
  let h = await createHarness();
  const runId = await run(h, two);
  await h.clock.advance(3 * H);
  const before = h.sim.helmThreads().length;
  h = await h.restart();
  assert.equal(h.sim.helmThreads().length, before);
  await h.clock.runUntil(h.clock.now() + 48 * H, { stopWhen: () => allReady(h, runId) });
  assert.ok(allReady(h, runId));
  noDuplicateThreads(h, runId);
});

test("duplicated and late events change nothing: same result, no duplicate threads or receipts", async () => {
  const h = await createHarness();
  h.sim.duplicateEvents = true;
  const runId = await run(h, two);
  await h.clock.runUntil(h.clock.now() + 48 * H, { stopWhen: () => allReady(h, runId) });
  assert.ok(allReady(h, runId));
  noDuplicateThreads(h, runId);
  const signoffs = h.repo.listNeeds(runId, "open").filter((n) => n.kind === "signoff");
  assert.equal(signoffs.length, 2, "one sign-off card per app");
});

test("A3: a dry run writes the studio files and spawns nothing", async () => {
  const h = await createHarness();
  const { runId } = h.engine.createRun({ name: "Dry", brief: "x", portfolio: two as never, slots: CHEAP });
  await h.engine.startRun(runId, { dryRun: true });
  await h.clock.advance(H);
  assert.equal(h.sim.calls.filter((c) => c.method === "spawnThread").length, 0);
  const r = h.repo.getRun(runId)!;
  assert.equal(r.dryRun, true);
  assert.notEqual(r.status, "running");
  const studio = [...h.sim.git.repos.keys()].find((k) => k.endsWith("/_studio"))!;
  assert.ok(studio, "studio repo written");
  const tree = h.sim.git.treeAt(studio, "HEAD")!;
  assert.ok(tree.has("PORTFOLIO.md"));
  assert.ok([...tree.keys()].some((k) => k.startsWith("briefs/alpha.lead")));
});

test("A5: a model that disappears before spawn raises a model need; nothing is substituted", async () => {
  const h = await createHarness();
  const runId = await run(h, one(), { concurrency: 2 });
  // the security slot's model goes away after start
  const gone = CHEAP.security!;
  h.sim.catalogData = { ...h.sim.catalogData, models: h.sim.catalogData.models.filter((m) => !(m.providerId === gone.providerId && m.id === gone.modelId)) };
  await h.engine.catalog(h.sim.hostId, true);
  await h.clock.runUntil(h.clock.now() + 24 * H, { stopWhen: () => h.repo.listNeeds(runId, "open").some((n) => n.kind === "model") });
  const need = h.repo.listNeeds(runId, "open").find((n) => n.kind === "model");
  assert.ok(need, "a model need is raised");
  const sec = h.repo.listNodes(runId).filter((n) => n.slot === "security");
  for (const n of sec) if (n.threadId) assert.equal(h.sim.threadOf(n.id, runId)!.model, gone.modelId, "never substituted");
});

test("a gate that fails once and then passes a newer commit closes its earlier findings", async () => {
  const h = await createHarness({ profileFor: role("review", "picky") });
  const runId = await run(h, one());
  await h.clock.runUntil(h.clock.now() + 48 * H, { stopWhen: () => allReady(h, runId) });
  assert.ok(allReady(h, runId), h.agents.log.slice(-20).join("\n"));
  const app = h.repo.listApps(runId)[0];
  const review = h.repo.findings(runId, app.id).filter((f) => f.gate === "review");
  assert.ok(review.length >= 1, "the first review failed with a finding");
  assert.deepEqual(review.filter((f) => f.status !== "fixed").map((f) => `${f.id} ${f.status}`), [], "closed by the later pass");
});

test("retrying a node whose thread was archived outside Helm respawns it with a hand-over; a replaced lead continues the integration branch", async () => {
  const h = await createHarness({ profileFor: role("ui", "silent") });
  const runId = await run(h, one());
  await h.clock.advance(3 * H);
  const ui = h.repo.listNodes(runId).find((n) => n.role === "ui")!;
  assert.ok(ui.threadId);
  // the silent builder said something before going quiet
  h.repo.addReport(runId, ui.id, { status: "progress", summary: "tokens and button component committed", evidence: [], verified: true, problems: [] });
  const oldUi = ui.threadId!;
  await h.sim.archiveThread(oldUi); // archived by someone outside Helm
  await h.clock.advance(60_000);
  assert.match(h.repo.getNode(runId, ui.id)!.warning ?? "", /archived outside Helm/);

  await createDirective(h.engine, runId, { type: "retry", target: ui.id, cascade: "self" });
  await h.clock.advance(10 * 60_000);
  const after = h.repo.getNode(runId, ui.id)!;
  assert.ok(after.threadId && after.threadId !== oldUi, `a new thread took over: ${JSON.stringify({ status: after.status, t: after.threadId, w: after.warning })} ${JSON.stringify(h.repo.outboxForRun(runId).filter((o) => o.nodeId === ui.id).map((o) => [o.kind, o.state, o.lastError]))} ${JSON.stringify(h.repo.events(runId, ui.id, 10).map((e) => e.summary))}`);
  const t = h.sim.threads.get(after.threadId!)!;
  assert.match(t.firstPrompt ?? "", /Hand-over from the previous holder/);
  assert.match(t.firstPrompt ?? "", /tokens and button component committed/);
  assert.notEqual(after.branch, ui.branch, "its own new branch was recorded");

  // the lead: archived outside Helm, retried; its replacement starts from the integration branch
  const app = h.repo.listApps(runId)[0];
  const lead = h.engine.leadOf(runId, app.id)!;
  const before = h.repo.appExtra(runId, app.id).integrationBranch!;
  const headBefore = h.sim.git.repos.get([...h.sim.git.repos.keys()].find((k) => k.endsWith("/alpha"))!)!.refs.get(before);
  await h.sim.archiveThread(lead.threadId!);
  await h.clock.advance(60_000);
  await createDirective(h.engine, runId, { type: "retry", target: lead.id, cascade: "self" });
  await h.clock.advance(10 * 60_000);
  const lead2 = h.repo.getNode(runId, lead.id)!;
  assert.notEqual(lead2.threadId, lead.threadId);
  const now = h.repo.appExtra(runId, app.id).integrationBranch!;
  assert.notEqual(now, before, "the replacement's branch is the integration branch now");
  const repo = h.sim.git.repos.get([...h.sim.git.repos.keys()].find((k) => k.endsWith("/alpha"))!)!;
  assert.ok(h.sim.git.isAncestorSha(repo, headBefore!, repo.refs.get(now)!), "it continues from the old integration head");
});
