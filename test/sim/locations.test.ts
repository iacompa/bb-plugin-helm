import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP } from "../helpers/harness.ts";
import type { Portfolio } from "../../src/shared/types.ts";
import { nodeWorktree } from "../../src/server/engine/gates.ts";

const app = (name: string, extra: Record<string, unknown> = {}) => ({ name, tagline: `${name} app`, platforms: ["ios" as const], shape: "lean" as const, ...extra });
const pf = (...apps: ReturnType<typeof app>[]): Portfolio => ({ apps, groups: [], assumptions: [], questions: [] }) as unknown as Portfolio;

test("an existing repository is adopted on a Helm branch; the human's checkout, branch and uncommitted work are never touched", async () => {
  const h = await createHarness();
  const git = h.sim.git;
  const repo = "/disk/work/tide";
  git.createRepo(repo);
  git.write(repo, "README.md", "# Tide\n");
  git.write(repo, "ARCHITECTURE.md", "# The human's own architecture notes\n");
  const humanHead = git.commit(repo, "human: initial");
  git.write(repo, "WIP.txt", "half-done work, not committed");
  git.dirs.set("/disk/work/core", true);

  const { runId } = h.engine.createRun({ name: "Tide work", brief: "finish tide", portfolio: pf(app("Tide", { path: repo, reads: ["/disk/work/core"] }), app("Gamma")), slots: CHEAP });
  const loc = await h.engine.locationReport(runId);
  assert.deepEqual(loc.problems, []);
  assert.ok(loc.notes.some((n) => n.includes("existing repository /disk/work/tide") && n.includes("1 uncommitted change is NOT visible to agents: commit first") && n.includes("helm/")), loc.notes.join("\n"));
  assert.ok(loc.notes.some((n) => n.includes("Tide reads /disk/work/core")), loc.notes.join("\n"));

  const r = await h.engine.startRun(runId);
  assert.deepEqual(r.problems, []);
  const ready = () => h.repo.getApp(runId, "tide")!.stage === "ready";
  await h.clock.runUntil(h.clock.now() + 48 * 3600_000, { stopWhen: ready });
  const tide = h.repo.getApp(runId, "tide")!;
  assert.equal(tide.stage, "ready", h.agents.log.slice(-15).join("\n"));
  assert.equal(tide.adopted, true);
  assert.equal(tide.repoPath, repo);
  assert.equal(tide.userBranch, "main");
  assert.match(tide.helmBranch!, /^helm\/tide-work-[a-z0-9]{6}\/tide$/);
  assert.ok(tide.helmBranch!.includes(runId.slice(-6).toLowerCase()), "the branch carries the run id suffix");
  // the human's side is exactly as it was
  const r0 = git.repos.get(repo)!;
  assert.equal(r0.refs.get("main"), humanHead, "the human's branch did not move");
  const checkout = git.wts.get(repo)!;
  assert.equal(checkout.branch, "main");
  assert.equal(checkout.work.get("WIP.txt"), "half-done work, not committed");
  assert.equal(checkout.work.has(".helm/checks.json"), false, "nothing was written into the human's checkout");
  // no bootstrap commit: Helm's branch starts at the human's commit, and nothing of Helm's is in the repository
  assert.ok(git.isAncestorSha(r0, humanHead, git.resolve(repo, tide.helmBranch!)!), "the Helm branch starts at the human's HEAD");
  // Helm itself added no commit: every commit after the human's is an agent's work
  const msgs: string[] = [];
  for (let c = git.resolve(repo, tide.helmBranch!); c && c !== humanHead; c = r0.commits.get(c)!.parents[0] ?? null) msgs.push(r0.commits.get(c)!.msg);
  assert.equal(msgs.some((m) => m.startsWith("Helm: start")), false, msgs.join(" | "));
  // the wrapper lives in Helm's Studio instead
  const studio = h.engine.studioPath(h.engine.run(runId));
  assert.ok(h.sim.git.treeAt(studio, "HEAD")?.has("bin/run-check.sh"), "Studio has the wrapper");
  // two worktrees: the human's checkout and one shared work worktree beside it, on the Helm branch
  const integration = h.repo.appExtra(runId, "tide").integrationBranch!;
  assert.equal(integration, tide.helmBranch, "the Helm branch is the integration branch");
  const wts = [...git.wts.values()].filter((w) => w.root === repo).map((w) => w.path);
  assert.deepEqual(wts.sort(), [repo, "/disk/work/.helm-work/tide"].sort(), "exactly two worktrees for the app");
  for (const n of h.repo.listNodes(runId).filter((x) => x.appId === "tide" && x.threadId)) assert.equal(await nodeWorktree(h.engine, n), "/disk/work/.helm-work/tide", `${n.id} works in the shared worktree`);
  // the agents were told where they are
  const brief = h.engine.buildBrief(h.engine.run(runId), h.repo.getNode(runId, "tide.lead")!);
  assert.match(brief, /existing repository/);
  assert.match(brief, /no files and no commits/);
  assert.match(brief, /helm_existing_docs/);
  assert.match(brief, /bin\/run-check\.sh/);
  assert.match(brief, /Read-only reference folders.*\/disk\/work\/core/);
  // the sign-off item says Helm never merges
  const so = h.repo.listNeeds(runId, "open").find((n) => n.kind === "signoff" && n.appId === "tide")!;
  assert.match(so.body, /Helm never merges into your branches/);
  // the other app got a new repository under the run folder, as before
  const gamma = h.repo.getApp(runId, "gamma")!;
  assert.equal(gamma.adopted, false);
  assert.ok(gamma.repoPath === null || gamma.repoPath.endsWith("/gamma"));
});

test("a new folder anywhere becomes a new repository there", async () => {
  const h = await createHarness();
  const { runId } = h.engine.createRun({ name: "Elsewhere", brief: "x", portfolio: pf(app("Solo One", { path: "~/elsewhere/solo-one" })), slots: CHEAP });
  const loc = await h.engine.locationReport(runId);
  assert.deepEqual(loc.problems, []);
  assert.ok(loc.notes.some((n) => n.includes("new repository at ~/elsewhere/solo-one")));
  await h.engine.startRun(runId);
  await h.clock.advance(10 * 60_000);
  const a = h.repo.getApp(runId, "solo-one")!;
  assert.equal(a.repoPath, "/home/sim/elsewhere/solo-one");
  assert.equal(a.adopted, false);
  assert.ok(h.sim.git.repos.has("/home/sim/elsewhere/solo-one"));
});

test("unsafe or ambiguous folders are problems, and start refuses them", async () => {
  const h = await createHarness();
  const git = h.sim.git;
  git.createRepo("/disk/mono");
  git.write("/disk/mono", "a.txt", "a");
  git.commit("/disk/mono", "init");
  git.dirs.set("/disk/notgit", true);
  const { runId } = h.engine.createRun({
    name: "Bad",
    brief: "x",
    portfolio: pf(
      app("Sub", { path: "/disk/mono/packages/sub" }),
      app("Plain", { path: "/disk/notgit" }),
      app("Sys", { path: "/usr/local/thing" }),
      app("Home", { path: "~" }),
      app("Dup A", { path: "/disk/dup" }),
      app("Dup B", { path: "/disk/dup/inner" }),
      app("Reader", { reads: ["/disk/missing"] }),
      app("Nested", { path: "/disk/mono/new-thing" }),
    ),
    slots: CHEAP,
  });
  const { problems } = await h.engine.locationReport(runId);
  const has = (re: RegExp) => assert.ok(problems.some((p) => re.test(p)), `${re} in:\n${problems.join("\n")}`);
  has(/^Sub: .*inside the repository \/disk\/mono/);
  has(/^Plain: .*not a git repository/);
  has(/^Sys: .*system folder \/usr/);
  has(/^Home: .*home folder/);
  has(/^Dup B: .*overlaps Dup A/);
  has(/^Reader: read-only folder \/disk\/missing does not exist/);
  has(/^Nested: .*inside the repository \/disk\/mono/);
  const r = await h.engine.startRun(runId);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.startsWith("Plain:")));
  assert.equal(h.sim.helmThreads().length, 0, "nothing spawned");
});

test("Plan with an agent: one visible conversation on the chosen model, with the planner skills and no Helm tools", async () => {
  const h = await createHarness();
  const model = { ...CHEAP.code!, reasoning: "medium" };
  const { threadId } = await h.planner.startChat({ model, text: "Finish the apps in /Volumes/Work/apps" });
  const t = h.sim.threads.get(threadId)!;
  assert.equal(t.visibility, "visible");
  assert.equal(t.model, model.modelId);
  assert.match(t.firstPrompt!, /helm-planner skill/);
  assert.match(t.firstPrompt!, /each role/);
  assert.match(t.firstPrompt!, /<idea>\nFinish the apps in \/Volumes\/Work\/apps\n<\/idea>/);
  assert.match(t.firstPrompt!, /Never run `bb helm start`/);
  assert.equal(h.repo.nodeByThread(threadId), null, "not a node: it has no Helm authority");
  assert.equal(h.repo.listRuns().length, 0, "no run until the planner runs bb helm plan");
});

test("helm_existing_docs: a lead in an existing repository reuses its own documents and checks instead of creating Helm's", async () => {
  const h = await createHarness({ profileFor: (m) => (m.role === "orch" ? "silent" : "diligent") });
  const git = h.sim.git;
  const repo = "/disk/work/lumen";
  git.createRepo(repo);
  git.write(repo, "docs/REQUIREMENTS.md", "# Requirements\n");
  git.write(repo, "docs/ARCH.md", "# Architecture\n");
  git.write(repo, "docs/API.md", "# API contract\n");
  git.write(repo, "docs/CHECKLIST.md", "# Acceptance checklist\n");
  git.commit(repo, "human: docs");
  const { runId } = h.engine.createRun({ name: "Lumen", brief: "x", portfolio: pf(app("Lumen", { path: repo, shape: "solo" })), slots: CHEAP });
  await h.engine.startRun(runId);
  await h.clock.advance(60_000);
  const lead = h.repo.getNode(runId, "orch")!; // one app: the Orchestrator is also the lead
  assert.ok(lead.threadId);
  const { callTool } = await import("../../src/server/agent/tools.ts");
  const call = async (name: string, p: unknown) => (await callTool(h.engine, name, lead.threadId!, p)).text;
  assert.match(await call("helm_existing_docs", { docs: { spec: "docs/NOPE.md" } }), /Rejected: not committed/);
  assert.match(await call("helm_existing_docs", { checks: { build: { command: "echo ok" } } }), /do not run anything real/);
  const ok = await call("helm_existing_docs", {
    docs: { spec: "docs/REQUIREMENTS.md", architecture: "docs/ARCH.md", contract: "docs/API.md", acceptance: "docs/CHECKLIST.md" },
    checks: { build: { command: "npm run build" }, tests: { command: "npm test" } },
  });
  assert.match(ok, /^Recorded at/);
  // the spec stage now passes on the repository's own documents: no SPEC.md was created
  h.repo.updateApp(runId, "lumen", { stage: "spec" });
  const r = await call("helm_stage", { to: "build", evidence: [] });
  assert.doesNotMatch(r, /SPEC\.md|ARCHITECTURE\.md|missing/i, r);
  assert.equal(h.repo.getApp(runId, "lumen")!.stage, "build");
  // and the gate brief lists the declared checks
  const gate = h.repo.getNode(runId, "lumen.review")!;
  assert.match(h.engine.buildBrief(h.engine.run(runId), gate), /`build`: `npm run build`; `tests`: `npm test`/);
});

test("helm_existing_docs is refused for an app in a new repository", async () => {
  const h = await createHarness({ profileFor: (m) => (m.role === "orch" ? "silent" : "diligent") });
  const { runId } = h.engine.createRun({ name: "New", brief: "x", portfolio: pf(app("Fresh", { shape: "solo" })), slots: CHEAP });
  await h.engine.startRun(runId);
  await h.clock.advance(60_000);
  const lead = h.repo.getNode(runId, "orch")!;
  const { callTool } = await import("../../src/server/agent/tools.ts");
  assert.match((await callTool(h.engine, "helm_existing_docs", lead.threadId!, { docs: { spec: "README.md" } })).text, /only for an app in an existing repository/);
});
