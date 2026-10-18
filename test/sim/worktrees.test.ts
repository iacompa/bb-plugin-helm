// The two-worktree rule: every app has the human's checkout and one shared work worktree beside
// it, and the run's Git agent keeps it so. Apps started before the rule (one worktree per agent)
// are consolidated once their work is committed and on the integration branch, never before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP, type Harness } from "../helpers/harness.ts";
import { appWorktrees, auditWorktrees, consolidate } from "../../src/server/engine/worktrees.ts";
import { nodeWorktree } from "../../src/server/engine/gates.ts";
import { GIT_ID } from "../../src/server/engine/custom.ts";
import type { HelmSettings } from "../../src/server/engine/context.ts";
import type { Portfolio } from "../../src/shared/types.ts";

const H = 3600_000;
const app = (name: string) => ({ name, tagline: `${name} app`, platforms: ["ios" as const], shape: "lean" as const });
const pf = (...names: string[]): Portfolio => ({ apps: names.map(app), groups: [], assumptions: [], questions: [] }) as unknown as Portfolio;
const sentTo = (h: Harness, runId: string, id: string, re: RegExp) => h.repo.outboxForRun(runId).some((o) => o.kind === "send" && o.nodeId === id && re.test(String(o.payload.text)));

async function run(opts: { legacy?: boolean; settings?: Partial<HelmSettings> } = {}) {
  const h = await createHarness({ settings: opts.settings });
  const { runId } = h.engine.createRun({ name: "Two", brief: "x", portfolio: pf("Alpha", "Beta"), slots: CHEAP, limits: { concurrency: 48, autonomy: "high" } });
  // an app from before the rule: an integration branch and no work worktree, so each agent gets its own
  if (opts.legacy)
    h.sim.onEvent(() => {
      const a = h.repo.getApp(runId, "alpha");
      if (a?.projectId && !h.repo.appExtra(runId, "alpha").integrationBranch) h.repo.updateApp(runId, "alpha", { integrationBranch: "main" });
    });
  assert.deepEqual((await h.engine.startRun(runId)).problems, []);
  await h.clock.runUntil(h.clock.now() + 72 * H, { maxSteps: 2_000_000, stopWhen: () => h.repo.getApp(runId, "alpha")!.stage === "ready" });
  assert.equal(h.repo.getApp(runId, "alpha")!.stage, "ready", h.agents.log.slice(-15).join("\n"));
  return { h, runId };
}

/** What the app lead does when asked: merge every agent's last commit into the integration branch. */
async function mergeAll(h: Harness, runId: string, appId: string) {
  const lead = h.repo.listNodes(runId).find((n) => n.appId === appId && n.tier === "lead")!;
  const at = (await nodeWorktree(h.engine, lead))!;
  for (const n of h.repo.listNodes(runId).filter((x) => x.appId === appId && x.threadId && x.id !== lead.id)) {
    const p = await nodeWorktree(h.engine, n);
    const head = p && h.sim.git.wts.has(p) ? h.sim.git.head(h.sim.git.wts.get(p)!) : null;
    if (head) h.sim.git.merge(at, head);
  }
}

test("a new app has exactly two worktrees, and every agent of it works in the shared one", async () => {
  const { h, runId } = await run();
  const [a] = await appWorktrees(h.engine, runId, { appId: "alpha" });
  assert.equal(a.worktrees.length, 2, JSON.stringify(a.worktrees));
  assert.deepEqual(a.worktrees.map((w) => w.role).sort(), ["checkout", "work"]);
  assert.equal(a.extra, 0);
  assert.match(a.work!, /\/\.helm-work\/alpha$/);
  const squad = h.repo.listNodes(runId).filter((n) => n.appId === "alpha" && n.threadId);
  assert.ok(squad.length >= 3, "lead, builders and gates ran");
  for (const n of squad) assert.equal(await nodeWorktree(h.engine, n), a.work, `${n.id} works in the shared worktree`);
  assert.ok(!(await auditWorktrees(h.engine, runId)).length, "nothing to report");
  assert.ok(!sentTo(h, runId, GIT_ID, /Helm worktree check/));
});

test("the Git agent stands beside the Orchestrator, checks the worktrees on start, and is told to push on sign-off", async () => {
  const { h, runId } = await run();
  const git = h.repo.getNode(runId, GIT_ID)!;
  assert.equal(git.tier, "git");
  assert.equal(git.parentId, null, "outside the chain of command");
  assert.equal(h.engine.label(git), "Git Pusher · Git agent");
  assert.equal(h.engine.effectiveModel(h.engine.run(runId), git)?.modelId, h.engine.run(runId).slots.orchestrator?.modelId, "no Git agent default: the Orchestrator's model");
  assert.ok(h.agents.log.some((l) => /^git: Every app has at most 2 worktrees/.test(l)), h.agents.log.filter((l) => l.startsWith("git")).join("\n"));

  const so = h.repo.listNeeds(runId, "open").find((n) => n.kind === "signoff" && n.appId === "alpha")!;
  await h.resolve(runId, so.id, { action: "signoff" });
  const branch = h.repo.appExtra(runId, "alpha").integrationBranch!;
  assert.ok(sentTo(h, runId, GIT_ID, new RegExp(`signed off Alpha \\(alpha\\).*Settings say: push ${branch.replace(/[/.]/g, "\\$&")} to its remote`, "s")));
});

test("gitOnSignoff report: the Git agent is told to send nothing", async () => {
  const { h, runId } = await run({ settings: { gitOnSignoff: "report" } });
  const so = h.repo.listNeeds(runId, "open").find((n) => n.kind === "signoff" && n.appId === "alpha")!;
  await h.resolve(runId, so.id, { action: "signoff" });
  assert.ok(sentTo(h, runId, GIT_ID, /Settings say: record where its work is \(send nothing\)/));
});

test("an app with one worktree per agent: the audit wakes the Git agent; consolidation refuses uncommitted work, then leaves two worktrees", async () => {
  const { h, runId } = await run({ legacy: true });
  const before = (await appWorktrees(h.engine, runId, { appId: "alpha" }))[0];
  assert.equal(before.work, null, "no shared worktree: the old layout");
  assert.ok(before.extra > 0, `${before.worktrees.length} worktrees`);

  // the watchdog's audit tells the Git agent, once per situation
  assert.deepEqual(await auditWorktrees(h.engine, runId), ["alpha"]);
  assert.ok(sentTo(h, runId, GIT_ID, /Helm worktree check: Alpha has \d+ worktrees/));
  const alerts = () => h.repo.outboxForRun(runId).filter((o) => o.nodeId === GIT_ID && /Helm worktree check/.test(String(o.payload.text))).length;
  const n0 = alerts();
  await h.clock.advance(H);
  await auditWorktrees(h.engine, runId);
  assert.equal(alerts(), n0, "the same situation is not reported twice");

  // a builder's worktree with uncommitted work: refused, nothing changed
  const builder = h.repo.listNodes(runId).find((n) => n.appId === "alpha" && n.tier === "specialist" && n.threadId)!;
  const path = (await nodeWorktree(h.engine, builder))!;
  const wt = h.sim.git.wts.get(path)!;
  wt.work.set("src/half-done.swift", "// not committed");
  const refused = await consolidate(h.engine, runId, "alpha", "test");
  assert.match(refused, /^Rejected: Alpha cannot be consolidated yet; nothing was changed/);
  assert.match(refused, /1 uncommitted file\(s\).*src\/half-done\.swift/);
  assert.equal(h.repo.getNode(runId, builder.id)!.threadId, builder.threadId, "the builder kept its thread");
  assert.equal(h.sim.git.wts.has(path), true, "its worktree is still there");

  // committed and merged: consolidation goes ahead
  wt.work.delete("src/half-done.swift");
  await mergeAll(h, runId, "alpha");
  const integration = h.repo.appExtra(runId, "alpha").integrationBranch!;
  const tip = h.sim.git.resolve(before.repo!, integration);
  // worst case: removing a BB worktree also deletes its branch, and the lead's holds the integration branch
  const git = h.sim.git;
  const rm = git.removeWorktree.bind(git);
  const dropped: string[] = [];
  git.removeWorktree = (p: string) => {
    const w = git.wts.get(p);
    rm(p);
    if (w?.branch && !w.detached && git.repos.get(w.root)?.refs.delete(w.branch)) dropped.push(w.branch);
  };
  const ok = await consolidate(h.engine, runId, "alpha", "test");
  assert.match(ok, /^Alpha now works in one shared worktree: \S+\/\.helm-work\/alpha on /, ok);
  const after = (await appWorktrees(h.engine, runId, { appId: "alpha" }))[0];
  assert.deepEqual(after.worktrees.map((w) => w.role).sort(), ["checkout", "work"], JSON.stringify(after.worktrees));
  assert.equal(after.branch, integration, "the same integration branch");
  assert.ok(dropped.includes(integration), `the integration branch was deleted with the lead's worktree (${dropped.join(", ")})`);
  assert.equal(h.sim.git.resolve(before.repo!, integration), tip, "and recreated at the same commit: nothing lost or added");
  assert.equal(h.sim.git.wts.has(path), false, "the builder's worktree is gone");
  assert.ok(h.sim.helmThreads().filter((t) => t.id === builder.threadId).every((t) => t.archived), "its old thread is archived");
  assert.match(await consolidate(h.engine, runId, "alpha", "test"), /already has 2 worktrees: nothing to consolidate/);
});

test("BB removes the old worktrees in the background: the agents wait, and start in the shared worktree once it is done", async () => {
  const { h, runId } = await run({ legacy: true });
  await mergeAll(h, runId, "alpha");
  const git = h.sim.git;
  const rm = git.removeWorktree.bind(git);
  const later: string[] = [];
  git.removeWorktree = (p: string) => void later.push(p);
  const lead = h.repo.getNode(runId, "alpha.lead")!;
  h.repo.updateNode(runId, lead.id, { status: "waiting" });

  const r = await consolidate(h.engine, runId, "alpha", "test");
  assert.match(r, /^Alpha is moving to one shared worktree on \S+\. Removed \d+ agent worktree\(s\)\. BB is still removing the old worktrees \(.*checked out in/, r);
  assert.equal(h.repo.getNode(runId, lead.id)!.status, "queued", "queued, not stopped");
  await h.clock.advance(60_000);
  assert.equal(h.repo.getNode(runId, lead.id)!.threadId, null, "no thread, and no worktree of its own, while BB is busy");
  assert.equal(h.engine.workTree(runId, "alpha"), null);

  for (const p of later.splice(0)) rm(p);
  git.removeWorktree = rm;
  await h.clock.runUntil(h.clock.now() + H, { stopWhen: () => !!h.repo.getNode(runId, lead.id)?.threadId });
  const work = h.engine.workTree(runId, "alpha");
  assert.match(work!, /\/\.helm-work\/alpha$/);
  assert.equal(await nodeWorktree(h.engine, h.repo.getNode(runId, lead.id)!), work, "the lead started in the shared worktree");
  assert.equal(h.repo.getMeta(`consolidating:${runId}:alpha`), null);
  assert.equal((await appWorktrees(h.engine, runId, { appId: "alpha" }))[0].worktrees.length, 2);
});

test("a consolidation that stopped half-way is finished by running it again", async () => {
  const { h, runId } = await run({ legacy: true });
  await mergeAll(h, runId, "alpha");
  const git = h.sim.git;
  const rm = git.removeWorktree.bind(git);
  const later: string[] = [];
  git.removeWorktree = (p: string) => void later.push(p);
  h.repo.updateNode(runId, "alpha.lead", { status: "waiting" });
  await consolidate(h.engine, runId, "alpha", "test");
  for (const p of later.splice(0)) rm(p);
  git.removeWorktree = rm;
  const again = await consolidate(h.engine, runId, "alpha", "test");
  assert.match(again, /^Alpha now works in one shared worktree: \S+\/\.helm-work\/alpha on \S+\. \d agent\(s\) start again there with a hand-over: alpha\.lead\b/, again);
});

test("the Git agent consolidates by itself when woken, and the other app is untouched", async () => {
  const { h, runId } = await run({ legacy: true });
  await mergeAll(h, runId, "alpha");
  await auditWorktrees(h.engine, runId);
  await h.clock.runUntil(h.clock.now() + 2 * H, { stopWhen: () => h.agents.log.some((l) => l.startsWith("git consolidate")) });
  const line = h.agents.log.find((l) => l.startsWith("git consolidate"))!;
  assert.match(line, /^git consolidate Alpha: Alpha now works in one shared worktree/, line);
  assert.equal((await appWorktrees(h.engine, runId, { appId: "alpha" }))[0].worktrees.length, 2);
  assert.equal((await appWorktrees(h.engine, runId, { appId: "beta" }))[0].extra, 0);
});
