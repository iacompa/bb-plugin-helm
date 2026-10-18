import { test } from "node:test";
import assert from "node:assert/strict";
import { briefFor, instructionsFor, type BriefContext } from "../../src/server/domain/briefs.ts";
import { scopeFor, skillsFor } from "../../src/server/domain/roles.ts";

const ctx = (over: Partial<BriefContext> = {}): BriefContext => ({
  runName: "R", appName: "Tide", tagline: null, parentLabel: "the human", leadLabel: null, peers: [], children: [],
  contractVersion: 0, policies: [], changesBeforeStart: [], branch: null, baseBranch: null, repoPath: null, extra: [], ...over,
});
const node = (role: "orch" | "lead" | "review" | "slop" | "ui", alsoLead = false) => ({ id: role, role, platform: null, briefVersion: 1, scopeGlobs: scopeFor(role, null), alsoLead });

test("a lead that builds the app itself owns the repository; the Orchestrator of a one-app run owns the lead's scope", () => {
  assert.deepEqual(scopeFor("lead", null, "app", { solo: true }), ["**"]);
  assert.ok(scopeFor("lead", null, "review", { solo: true }).includes("REVIEW.md"), "a review stays read-only on source");
  const orch = scopeFor("orch", null, "app", { alsoLead: true });
  assert.ok(orch.includes("PORTFOLIO.md") && orch.includes("SPEC.md") && orch.includes(".helm/**"), orch.join(" "));
  assert.deepEqual(scopeFor("orch", null, "app", { alsoLead: true, solo: true }), ["PORTFOLIO.md", "**"]);
  assert.ok(scopeFor("ui", null).includes("reports/screens/**"), "the UI builder writes the screen map");

  const b = briefFor(node("orch", true), ctx());
  assert.doesNotMatch(b, /You do not write app code/, "the Orchestrator-as-lead writes the lead's documents");
  assert.match(b, /- `SPEC\.md`/);
  const solo = briefFor(node("orch", true), ctx({ solo: true }));
  assert.match(solo, /- `\*\*`/);
  assert.match(solo, /no squad \(solo\): you build all of it yourself/);
  assert.match(briefFor(node("orch"), ctx()), /You do not write app code/, "an Orchestrator of many apps still does not");
  // a scope the human edited is shown as it is
  assert.match(briefFor({ ...node("lead"), scopeGlobs: ["SPEC.md"] }, ctx({ solo: true })), /## You own[^\n]*\n- `SPEC\.md`\n\n/);
});

test("gates are told to submit one verdict and never commit, in the brief and the system prompt", () => {
  for (const role of ["review", "slop"] as const) {
    const b = briefFor(node(role), ctx());
    assert.match(b, /answer with exactly one `helm_verdict`\. Never commit anything/);
    assert.doesNotMatch(b, /commit it and call `helm_report`/);
    assert.doesNotMatch(b, /Commit small and often/);
    assert.match(b, /Never commit, not even your reports/);
    assert.match(instructionsFor({ role, platform: null, nodeId: role, parentLabel: "Tide · App lead", skills: [], alsoLead: false }), /never commit and never poll/);
  }
  assert.match(briefFor(node("ui"), ctx()), /commit it and call `helm_report`/);
  assert.match(briefFor(node("ui"), ctx()), /never one that changes the run/, "agents keep off the human's mutating CLI commands");
});

test("skills follow the work: a game's UI builder gets helm-game, phone builders get helm-payments for in-app purchases", () => {
  assert.ok(skillsFor({ role: "ui", platform: null, alsoLead: false }, { shape: "full", platforms: ["ios"], kind: "game" }).includes("helm-game"));
  assert.ok(skillsFor({ role: "platform", platform: "ios", alsoLead: false }, { shape: "full", platforms: ["ios"], kind: "app", needs: ["payments"] }).includes("helm-payments"));
  assert.ok(!skillsFor({ role: "platform", platform: "mac", alsoLead: false }, { shape: "full", platforms: ["mac"], kind: "app", needs: ["payments"] }).includes("helm-payments"));
  assert.ok(!skillsFor({ role: "lead", platform: null, alsoLead: false }, { shape: "solo", platforms: [], kind: "review" }).includes("helm-code"));
});

test("the Git agent keeps each app within the run's worktree and branch limits, not a fixed two worktrees", () => {
  const b = briefFor({ id: "git", role: "git", platform: null, briefVersion: 1, scopeGlobs: scopeFor("git", null), alsoLead: false }, ctx());
  assert.doesNotMatch(b, /two worktrees/);
  assert.match(b, /within the run's worktree limit \(default 10\) and branch limit \(default 2\)/);
  assert.match(b, /`\.helm-work\/<repository>--<lane>`/);
  assert.match(b, /more worktrees or branches than its limits/);
});
