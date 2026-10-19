// The two-worktree rule: every app has the human's checkout and one shared work worktree beside
// it, and the run's Git agent keeps it so. Apps started before the rule (one worktree per agent)
// are consolidated once their work is committed and on the integration branch, never before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP, type Harness } from "../helpers/harness.ts";
import { appWorktrees, auditWorktrees, consolidate } from "../../src/server/engine/worktrees.ts";
import { nodeWorktree } from "../../src/server/engine/gates.ts";
import { callTool } from "../../src/server/agent/tools.ts";
import { GIT_ID } from "../../src/server/engine/custom.ts";
import { createDirective } from "../../src/server/engine/direct.ts";
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

test("the Git agent stands beside the Orchestrator, checks the worktrees on start, and merges into main and pushes on sign-off", async () => {
  const { h, runId } = await run();
  const git = h.repo.getNode(runId, GIT_ID)!;
  assert.equal(git.tier, "git");
  assert.equal(git.parentId, null, "outside the chain of command");
  assert.equal(h.engine.label(git), "Git agent", "no personal name by default");
  assert.equal(h.engine.effectiveModel(h.engine.run(runId), git)?.modelId, h.engine.run(runId).slots.orchestrator?.modelId, "no Git agent default: the Orchestrator's model");
  assert.ok(h.agents.log.some((l) => /^git: Every app is within the limit of 10 worktrees per project/.test(l)), h.agents.log.filter((l) => l.startsWith("git")).join("\n"));

  const so = h.repo.listNeeds(runId, "open").find((n) => n.kind === "signoff" && n.appId === "alpha")!;
  assert.match(so.body, /Result: branch alpha-work .*Signing off is your approval: the Git agent merges it into main and pushes both/);
  await h.resolve(runId, so.id, { action: "signoff" });
  assert.ok(sentTo(h, runId, GIT_ID, /signed off Alpha \(alpha\).*Settings say: merge alpha-work into its main branch and push main and alpha-work to its remote/s));
});

test("gitOnSignoff push: only the work branch is pushed", async () => {
  const { h, runId } = await run({ settings: { gitOnSignoff: "push" } });
  const so = h.repo.listNeeds(runId, "open").find((n) => n.kind === "signoff" && n.appId === "alpha")!;
  await h.resolve(runId, so.id, { action: "signoff" });
  assert.ok(sentTo(h, runId, GIT_ID, /Settings say: push alpha-work to its remote/));
});

test("two branches: every app works on <app>-work, every brief but the Git agent's carries the binding Git rules, and its messages are delivered as Git rules", async () => {
  const { h, runId } = await run();
  assert.equal(h.repo.appExtra(runId, "alpha").integrationBranch, "alpha-work");
  assert.equal(h.repo.appExtra(runId, "beta").integrationBranch, "beta-work");
  const run_ = h.engine.run(runId);
  const lead = h.repo.listNodes(runId).find((n) => n.appId === "alpha" && n.tier === "lead")!;
  const builder = h.repo.listNodes(runId).find((n) => n.appId === "alpha" && n.tier === "specialist")!;
  for (const n of [lead, builder, h.repo.getNode(runId, "orch")!]) {
    const brief = h.engine.buildBrief(run_, n);
    assert.match(brief, /## Git rules \(strict, set by the human\)/, n.id);
    assert.match(brief, /binding/, n.id);
  }
  assert.match(h.engine.buildBrief(run_, lead), /alpha-work/);
  assert.doesNotMatch(h.engine.buildBrief(run_, h.repo.getNode(runId, GIT_ID)!), /## Git rules/);

  const git = h.repo.getNode(runId, GIT_ID)!;
  const sent = await callTool(h.engine, "helm_message", git.threadId!, { to: lead.id, text: "Delete branch bb/old once merged.", kind: "info" });
  assert.ok(!sent.isError, sent.text);
  assert.ok(sentTo(h, runId, lead.id, /^Git rule from Git agent .*binding by the human's policy.*Delete branch bb\/old/s));
  const orch = h.repo.getNode(runId, "orch")!;
  await callTool(h.engine, "helm_message", orch.threadId!, { to: lead.id, text: "Plain note.", kind: "ask" });
  assert.ok(sentTo(h, runId, lead.id, /^Message from .*Plain note\./s), "other agents' messages are not Git rules");
});

test("the audit flags agent branches beside main and the work branch, and leaves the human's alone", async () => {
  const { h, runId } = await run();
  const repo = h.repo.getApp(runId, "alpha")!.repoPath!;
  const refs = h.sim.git.repos.get(repo)!.refs;
  const tip = h.sim.git.resolve(repo, "alpha-work")!;
  refs.set("feature/mine", tip);
  await h.clock.advance(H);
  assert.deepEqual(await auditWorktrees(h.engine, runId), [], "a human branch is not an agent's");
  refs.set("bb/alpha-builder-thr_x", tip);
  await h.clock.advance(H);
  const [a] = await appWorktrees(h.engine, runId, { appId: "alpha" });
  assert.deepEqual(a.extraBranches, ["bb/alpha-builder-thr_x"]);
  assert.deepEqual(await auditWorktrees(h.engine, runId), ["alpha"]);
  assert.ok(sentTo(h, runId, GIT_ID, /Helm worktree check: Alpha has 1 agent branch\(es\) besides main and alpha-work.*git branch -d/s));
});

test("a run's Helm branch and another live run's work branch on the same repository are kept, not agent branches", async () => {
  const { h, runId } = await run();
  const repo = h.repo.getApp(runId, "alpha")!.repoPath!;
  const refs = h.sim.git.repos.get(repo)!.refs;
  const tip = h.sim.git.resolve(repo, "alpha-work")!;
  // this run's Helm branch (where the app's work started), merged long ago
  refs.set("helm/two/alpha", tip);
  h.repo.updateApp(runId, "alpha", { helmBranch: "helm/two/alpha" });
  // a second live run working on the same repository from its own lead's branch
  const other = h.engine.createRun({ name: "Other", brief: "x", portfolio: pf("Alpha"), slots: CHEAP, limits: { concurrency: 4, autonomy: "high" } }).runId;
  refs.set("bb/alpha-app-lead-thr_other", tip);
  h.repo.updateApp(other, "alpha", { repoPath: repo, integrationBranch: "bb/alpha-app-lead-thr_other", helmBranch: "helm/other/alpha" });
  await h.clock.advance(H);
  let [a] = await appWorktrees(h.engine, runId, { appId: "alpha" });
  assert.deepEqual(a.helmBranches.sort(), ["bb/alpha-app-lead-thr_other", "helm/two/alpha"]);
  assert.deepEqual(a.extraBranches, []);
  assert.equal(a.overBranches, 0, "recorded Helm branches are not counted in the limit");
  assert.deepEqual(await auditWorktrees(h.engine, runId), [], "nothing for the Git agent to delete");
  // a real leftover is still flagged, and the alert says which branches may go
  refs.set("bb/alpha-builder-thr_x", tip);
  await h.clock.advance(H);
  [a] = await appWorktrees(h.engine, runId, { appId: "alpha" });
  assert.deepEqual(a.extraBranches, ["bb/alpha-builder-thr_x"]);
  assert.deepEqual(await auditWorktrees(h.engine, runId), ["alpha"]);
  assert.ok(sentTo(h, runId, GIT_ID, /1 agent branch\(es\).*never a Helm branch a live run records/s));
  // once the other run is cancelled its work branch is an ordinary leftover again
  h.repo.updateRun(other, { status: "cancelled" });
  [a] = await appWorktrees(h.engine, runId, { appId: "alpha" });
  assert.deepEqual(a.helmBranches, ["helm/two/alpha"]);
  assert.deepEqual(a.extraBranches.sort(), ["bb/alpha-app-lead-thr_other", "bb/alpha-builder-thr_x"]);
});

test("the Git agent's evidence is checked in the Studio and the apps' repositories", async () => {
  const { h, runId } = await run();
  const git = h.repo.getNode(runId, GIT_ID)!;
  const repo = h.repo.getApp(runId, "alpha")!.repoPath!;
  const sha = h.sim.git.resolve(repo, h.repo.appExtra(runId, "alpha").integrationBranch!)!;
  const ok = await callTool(h.engine, "helm_report", git.threadId!, { status: "done", summary: "Pushed Alpha.", evidence: [{ kind: "commit", ref: sha }] });
  assert.ok(!ok.isError, ok.text);
  assert.equal(h.repo.getNode(runId, GIT_ID)!.warning, null);
  await callTool(h.engine, "helm_report", git.threadId!, { status: "done", summary: "x", evidence: [{ kind: "commit", ref: "0123456789ab" }] });
  assert.match(h.repo.getNode(runId, GIT_ID)!.warning!, /commit 0123456789ab is not in the Studio or any app's repository/);
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
  assert.ok(before.legacy && before.worktrees.length > 2, `${before.worktrees.length} worktrees`);
  assert.equal(before.extra, 0, "within the limit of 10, but still one worktree per agent");

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

test("a paused run: the audit stays quiet, and consolidating keeps the paused agents paused until resumed", async () => {
  const { h, runId } = await run({ legacy: true });
  await mergeAll(h, runId, "alpha");
  const lead = h.repo.getNode(runId, "alpha.lead")!;
  // live agents, as in a running app (idle and finished ones are not paused)
  for (const n of h.repo.listNodes(runId).filter((x) => x.appId === "alpha" && x.threadId && x.status !== "done")) h.repo.updateNode(runId, n.id, { status: "waiting" });
  await createDirective(h.engine, runId, { type: "pause", target: "orch", cascade: "subtree", text: "hold everything" });
  await h.clock.advance(H);
  const alerts = () => h.repo.outboxForRun(runId).filter((o) => o.nodeId === GIT_ID && /Helm worktree check/.test(String(o.payload.text))).length;
  const n0 = alerts();
  assert.deepEqual(await auditWorktrees(h.engine, runId), [], "no clean-up work while the run is paused");
  assert.equal(alerts(), n0);

  const r = await consolidate(h.engine, runId, "alpha", "test");
  assert.match(r, /paused and start(s)? there when resumed/, r);
  await h.clock.advance(H);
  const after = h.repo.getNode(runId, lead.id)!;
  assert.equal(after.status, "paused", "still paused");
  assert.equal(after.threadId, null, "no new thread while paused");
  assert.equal(h.repo.nodeFlags(runId, lead.id).prevStatus, "queued");

  await createDirective(h.engine, runId, { type: "resume", target: "orch", cascade: "subtree", text: "go on" });
  await h.clock.runUntil(h.clock.now() + H, { stopWhen: () => !!h.repo.getNode(runId, lead.id)?.threadId });
  assert.equal(await nodeWorktree(h.engine, h.repo.getNode(runId, lead.id)!), h.engine.workTree(runId, "alpha"), "resumed in the shared worktree");
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

test("Look shows what a decision is about: the checkout, the work worktree with its uncommitted files, and the commits it names", async () => {
  const { h, runId } = await run();
  const { needLook, commitRefs } = await import("../../src/server/look.ts");
  const repo = h.repo.getApp(runId, "alpha")!.repoPath!;
  const tip = h.sim.git.resolve(repo, "alpha-work")!;
  const work = h.engine.workTree(runId, "alpha")!;
  h.sim.git.wts.get(work)!.work.set("src/half.swift", "// wip");
  const lead = h.repo.listNodes(runId).find((n) => n.appId === "alpha" && n.tier === "lead")!;
  h.engine.raiseNeed(runId, { kind: "decision", nodeId: lead.id, appId: "alpha", title: `Rebind to ${tip.slice(0, 9)}?`, body: `The work worktree at ${work} has local edits; deadbeef1 is unknown.`, evidence: "", options: ["Yes", "No"], dedupeKey: "look-test" });
  const need = h.repo.listNeeds(runId, "open").find((n) => n.title.startsWith("Rebind"))!;
  const look = await needLook(h.engine, runId, need.id);
  assert.equal(look.workBranch, "alpha-work");
  assert.deepEqual(look.places.map((p) => p.role), ["work", "checkout"], "the folder the decision names comes first");
  assert.ok(look.places[0].named);
  assert.ok(look.places[0].dirty.includes("src/half.swift"), JSON.stringify(look.places[0]));
  const c = look.commits.find((x) => x.ref === tip.slice(0, 9))!;
  assert.equal(c.sha, tip);
  assert.equal(c.onWork, true);
  assert.equal(look.commits.find((x) => x.ref === "deadbeef1")!.sha, null);
  assert.deepEqual(commitRefs("c767f2e and 9e8924389a, not 1234567 or abcdefg"), ["c767f2e", "9e8924389a"]);
});

test("the limit per project is a setting: lanes beside the work worktree count, and going over it wakes the Git agent", async () => {
  const { h, runId } = await run({ settings: { worktreesPerApp: 3 } });
  const repo = h.repo.getApp(runId, "alpha")!.repoPath!;
  const work = h.engine.workTree(runId, "alpha")!;
  const tip = h.sim.git.resolve(repo, "alpha-work")!;
  h.sim.git.addWorktree(repo, `${work}--ui-b`, "lane-tmp", tip);
  let [a] = await appWorktrees(h.engine, runId, { appId: "alpha" });
  assert.deepEqual(a.worktrees.map((w) => w.role).sort(), ["checkout", "lane", "work"]);
  assert.equal(a.cap, 3);
  assert.equal(a.extra, 0);
  h.sim.git.addWorktree(repo, `${work}--ui-c`, "lane-tmp2", tip);
  [a] = await appWorktrees(h.engine, runId, { appId: "alpha" });
  assert.equal(a.extra, 1);
  await h.clock.advance(H);
  assert.ok((await auditWorktrees(h.engine, runId)).includes("alpha"));
  assert.ok(sentTo(h, runId, GIT_ID, /Alpha has 4 worktrees \(limit 3\)/));
  const brief = h.engine.buildBrief(h.engine.run(runId), h.repo.listNodes(runId).find((n) => n.appId === "alpha" && n.tier === "lead")!);
  assert.match(brief, /at most 3 worktrees per project/);
});

test("the Worktrees view: each worktree's state and own size, the git storage, the app's total and the disk; a low disk wakes the Git agent", async () => {
  const { h, runId } = await run();
  const { worktreesViewFor, worktreeSizesText } = await import("../../src/server/worktree-view.ts");
  const view = worktreesViewFor(h.engine);
  const work = h.engine.workTree(runId, "alpha")!;
  h.sim.git.wts.get(work)!.work.set("src/wip.swift", "x".repeat(5000));
  const first = view.view(runId, { refresh: "open" });
  assert.equal(first.checking, true, "git is read in the background; the view answers at once");
  assert.equal(first.checkedAt, null);
  assert.deepEqual(first.apps.map((a) => a.name).slice(0, 2), ["Alpha", "Beta"], "the apps are listed before git is read");
  const v = await view.measureAndWait(runId);
  const a = v.apps.find((x) => x.appId === "alpha")!;
  const w = a.worktrees.find((x) => x.role === "work")!;
  assert.equal(w.state, "editing");
  assert.ok((w.bytes ?? 0) > 5000, String(w.bytes));
  assert.equal(a.store?.bytes, 1_000_000);
  assert.equal(a.total, a.worktrees.reduce((s, x) => s + (x.bytes ?? 0), 0) + 1_000_000);
  assert.deepEqual(a.branches.slice(0, 2).map((b) => [b.name, b.kind]), [["main", "main"], ["alpha-work", "work"]]);
  assert.equal(v.disks.length, 1);
  assert.equal(v.disks[0].free, 200e9);
  assert.match(worktreeSizesText(v), /Alpha: .* in total \(git storage 1 MB\)/);
  // a low disk: the Git agent hears once a day
  h.sim.git.diskFree = 8e9;
  await h.clock.advance(H);
  await auditWorktrees(h.engine, runId);
  assert.ok(sentTo(h, runId, GIT_ID, /Helm disk check: only 8\.0 GB free of 500 GB on the disk holding Alpha, Beta/));
  const n = h.repo.outboxForRun(runId).filter((o) => o.nodeId === GIT_ID && /Helm disk check/.test(String(o.payload.text))).length;
  await h.clock.advance(H);
  await auditWorktrees(h.engine, runId);
  assert.equal(h.repo.outboxForRun(runId).filter((o) => o.nodeId === GIT_ID && /Helm disk check/.test(String(o.payload.text))).length, n, "once a day");
  // the Git agent's tool measures too
  const git = h.repo.getNode(runId, GIT_ID)!;
  const r = await callTool(h.engine, "helm_worktrees", git.threadId!, { sizes: true });
  assert.match(r.text, /## Space[\s\S]*Disk the computer's own disk \(Alpha, Beta\): 8\.0 GB free/);
});

test("the Worktrees view opens at once from what Helm kept (even after a restart), lists each app's branches and disk, and shows only its own folders in Finder", async () => {
  const { h, runId } = await run();
  const { worktreesViewFor, WorktreesView, diskOf } = await import("../../src/server/worktree-view.ts");
  await worktreesViewFor(h.engine).measureAndWait(runId);
  // a fresh view (a restart) answers from the database without reading git
  const fresh = new WorktreesView(h.engine);
  const v = fresh.view(runId);
  assert.ok(v.checkedAt, "what was read before is shown at once");
  assert.equal(v.checking, false, "nothing is read again without being asked");
  const a = v.apps.find((x) => x.appId === "alpha")!;
  assert.equal(a.branches.filter((b) => b.kind === "main" || b.kind === "work").length, 2);
  assert.equal(a.overBranches, 0);
  assert.ok(a.where.length >= 1 && a.where.every((d) => d.bytes !== null), JSON.stringify(a.where));
  // opening reads git again only when what is kept is a few minutes old
  assert.equal(fresh.view(runId, { refresh: "open" }).checking, false);
  await h.clock.advance(10 * 60_000);
  assert.equal(fresh.view(runId, { refresh: "open" }).checking, true);
  // Show in Finder: only folders of the view
  await fresh.reveal(runId, a.repo!);
  assert.deepEqual(h.sim.git.revealed, [a.repo]);
  await assert.rejects(fresh.reveal(runId, "/etc"), /not one of this run's worktrees/);
  // disks from paths
  assert.deepEqual(diskOf("/Volumes/My SSD/apps/x"), { name: "My SSD", external: true });
  assert.deepEqual(diskOf("/Users/me/Projects/x"), { name: "internal", external: false });
  assert.deepEqual(diskOf("/media/me/Backup/x"), { name: "Backup", external: true });
  assert.deepEqual(diskOf("D:\\apps\\x"), { name: "D: drive", external: true });
});

test("a repository folder that is gone says so plainly, with no branches", async () => {
  const { h, runId } = await run();
  const gone = h.repo.getApp(runId, "beta")!.repoPath!;
  const ops = h.sim.git.hostOps.bind(h.sim.git);
  h.sim.git.hostOps = () => {
    const o = ops();
    return {
      ...o,
      worktrees: async (input: { repo: string; status?: boolean }) => {
        if (input.repo === gone) throw new Error(`the repository folder is missing: ${input.repo}`);
        return o.worktrees(input);
      },
    };
  };
  const [b] = await appWorktrees(h.engine, runId, { appId: "beta" });
  assert.match(b.error ?? "", /^the repository folder is missing: /);
  const { worktreesViewFor } = await import("../../src/server/worktree-view.ts");
  const v = await worktreesViewFor(h.engine).measureAndWait(runId);
  const beta = v.apps.find((x) => x.appId === "beta")!;
  assert.equal(beta.branches.length, 0);
  assert.equal(beta.store, null);
  assert.equal(beta.total, null);
});

test("the human sets a run's branch and worktree limits: the Git agent is told, briefs and the audit follow", async () => {
  const { h, runId } = await run();
  const { setGitLimits } = await import("../../src/server/engine/worktrees.ts");
  assert.deepEqual(h.engine.gitLimits(runId), { branches: 2, worktrees: 10, own: false });
  const lead = () => h.repo.listNodes(runId).find((n) => n.appId === "alpha" && n.tier === "lead")!;
  assert.match(h.engine.buildBrief(h.engine.run(runId), lead()), /exactly two branches/);
  setGitLimits(h.engine, runId, { branches: 4 });
  assert.deepEqual(h.engine.gitLimits(runId), { branches: 4, worktrees: 10, own: true });
  assert.ok(sentTo(h, runId, GIT_ID, /Git rule from the human: from now on each project of this run may have at most 4 branches/));
  assert.match(h.engine.buildBrief(h.engine.run(runId), lead()), /at most 4 branches: its main branch, its work branch \(`alpha-work`\), and up to 2 more that only the Git agent creates/);
  const git = h.repo.getNode(runId, GIT_ID)!;
  assert.match(h.engine.buildBrief(h.engine.run(runId), git), /now \*\*4 branches per project\*\*/);
  // lane branches the Git agent made count toward the limit; within it they are no problem
  const repo = h.repo.getApp(runId, "alpha")!.repoPath!;
  const refs = h.sim.git.repos.get(repo)!.refs;
  const head = [...refs.values()][0];
  refs.set("alpha-work--ui-a", head);
  refs.set("alpha-work--ui-b", head);
  let [a] = await appWorktrees(h.engine, runId, { appId: "alpha" });
  assert.deepEqual(a.laneBranches.sort(), ["alpha-work--ui-a", "alpha-work--ui-b"]);
  assert.equal(a.overBranches, 0);
  setGitLimits(h.engine, runId, { branches: 3 });
  [a] = await appWorktrees(h.engine, runId, { appId: "alpha" });
  assert.equal(a.overBranches, 1);
  await h.clock.advance(H);
  assert.ok((await auditWorktrees(h.engine, runId)).includes("alpha"));
  assert.ok(sentTo(h, runId, GIT_ID, /Alpha has 1 branch\(es\) over the limit of 3/));
  // back to the settings
  setGitLimits(h.engine, runId, { branches: null, worktrees: null });
  assert.deepEqual(h.engine.gitLimits(runId), { branches: 2, worktrees: 10, own: false });
});

test("the GitHub view: per app, what its remote has and what it does not; read only when asked", async () => {
  const { h, runId } = await run();
  const { githubViewFor, githubText } = await import("../../src/server/github-view.ts");
  const repo = h.repo.getApp(runId, "alpha")!.repoPath!;
  const refs = h.sim.git.repos.get(repo)!.refs;
  h.sim.git.remotes.set(repo, new Map([["main", refs.get("main")!], ["old-feature", "f".repeat(40)]]));
  const first = githubViewFor(h.engine).view(runId);
  assert.equal(first.checking, false, "opening the panel without asking reads nothing");
  assert.equal(first.checkedAt, null);
  const v = await githubViewFor(h.engine).viewAndWait(runId);
  const a = v.apps.find((x) => x.appId === "alpha")!;
  assert.equal(a.web, "https://github.com/example/app");
  assert.equal(a.counts.synced, 1);
  assert.equal(a.counts.onlyRemote, 1);
  assert.ok(a.counts.toPush >= 1, "the work branch is not on the remote");
  assert.equal(a.branches[0].kind, "main");
  const beta = v.apps.find((x) => x.appId === "beta")!;
  assert.equal(beta.remote, null);
  assert.equal(v.totals.noRemote, 1);
  assert.match(githubText(v), /Beta: no remote: nothing of it is on GitHub/);
  assert.match(githubText(v), /old-feature · only on the remote/);
  // the Git agent can ask too
  const git = h.repo.getNode(runId, GIT_ID)!;
  const r = await callTool(h.engine, "helm_worktrees", git.threadId!, { github: true });
  assert.match(r.text, /## On GitHub[\s\S]*Alpha: origin https:\/\/github\.com\/example\/app\.git/);
});
