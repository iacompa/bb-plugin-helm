import { test } from "node:test";
import assert from "node:assert/strict";
import { planTopology, admissibleSpecialists, squadFor } from "../../src/server/domain/topology.ts";
import { parseBrief, SAMPLE_BRIEF } from "../../src/server/domain/brief.ts";
import type { PortfolioApp } from "../../src/shared/types.ts";

const S = (managerSpan = 4, orchestratorSpan = 6) => ({ managerSpan, orchestratorSpan, leadSpan: 6, maxTotalAgents: 250 });

function apps(n: number, group?: (i: number) => string): PortfolioApp[] {
  return Array.from({ length: n }, (_, i) => ({ name: `App ${i + 1}`, tagline: "t", platforms: ["ios", "and"], group: group ? group(i) : null }));
}

test("A1: the sample brief yields 5 / 20 / 103 / 40 / 169", () => {
  const p = parseBrief(SAMPLE_BRIEF).portfolio;
  assert.equal(p.apps.length, 20);
  const plan = planTopology(p.apps, S());
  assert.equal(plan.ok, true, plan.error ?? "");
  assert.equal(plan.counts.managers, 5);
  assert.equal(plan.counts.leads, 20);
  assert.equal(plan.counts.specialists, 103);
  assert.equal(plan.counts.gates, 40);
  assert.equal(plan.counts.total, 169);
  assert.equal(plan.counts.platforms, 43);
  assert.equal(plan.grouping, "semantic");
  assert.match(plan.why, /kept as written/);
  assert.deepEqual(plan.managers.map((m) => m.name), ["Wellness", "Money", "Creator tools", "Dev & ops", "Travel"]);
});

test("A2/C1: one app → the Orchestrator also leads", () => {
  const plan = planTopology(apps(1), S());
  assert.equal(plan.rule, "C1");
  assert.equal(plan.counts.managers, 0);
  assert.equal(plan.counts.leads, 0);
  const orch = plan.nodes.find((n) => n.id === "orch")!;
  assert.equal(orch.alsoLead, true);
  assert.ok(plan.nodes.filter((n) => n.tier !== "orchestrator").every((n) => n.parentId === "orch"));
  // 1 + UI + Core + 2 platforms + Security + 2 gates
  assert.equal(plan.counts.total, 1 + 1 + 1 + 2 + 1 + 2);
});

test("A2/C2: 3 apps → no managers", () => {
  const plan = planTopology(apps(3), S());
  assert.equal(plan.rule, "C2");
  assert.equal(plan.counts.managers, 0);
  assert.ok(plan.nodes.filter((n) => n.tier === "lead").every((n) => n.parentId === "orch"));
});

test("A2/C3: 5 apps → 2 managers balanced 3 + 2", () => {
  const plan = planTopology(apps(5), S());
  assert.equal(plan.rule, "C3");
  assert.deepEqual(plan.managers.map((m) => m.appIds.length), [3, 2]);
  assert.match(plan.why, /balanced as 3 \+ 2/);
});

test("C3: 18 apps at span 4 → 4,4,4,3,3", () => {
  const plan = planTopology(apps(18), S());
  assert.deepEqual(plan.managers.map((m) => m.appIds.length), [4, 4, 4, 3, 3]);
});

test("A2/C5: more managers than the Orchestrator's span → error with the fix", () => {
  const plan = planTopology(apps(25), S(4, 6));
  assert.equal(plan.ok, false);
  assert.match(plan.error!, /7 managers exceeds the Orchestrator’s span of 6\. Raise the manager span \(max 6\) or split this into two runs\./);
});

test("C4: a one-app semantic group reports straight to the Orchestrator", () => {
  const groups = ["A", "A", "A", "B", "B", "C"];
  const plan = planTopology(apps(6, (i) => groups[i]), S());
  assert.equal(plan.grouping, "semantic");
  assert.equal(plan.managers.length, 2);
  assert.equal(plan.directAppIds.length, 1);
  const lead = plan.nodes.find((n) => n.id === `${plan.directAppIds[0]}.lead`)!;
  assert.equal(lead.parentId, "orch");
});

test("C6: shapes change the squad, gates are never optional", () => {
  assert.equal(squadFor("full", ["ios", "and"], false).length, 2 + 2 + 1 + 2);
  assert.deepEqual(squadFor("lean", ["ios"], false).map((m) => m.role), ["ui", "code", "review", "slop"]);
  assert.deepEqual(squadFor("lean", ["ios", "mac"], false).map((m) => m.role), ["ui", "code", "platform", "platform", "review", "slop"]);
  assert.deepEqual(squadFor("solo", ["ios", "and", "mac"], true).map((m) => m.role), ["review", "slop"]);
});

test("C7: a lead staggers platform builders beyond leadSpan", () => {
  const squad = squadFor("full", ["mac", "win", "ios", "and"], false).filter((m) => m.role !== "review" && m.role !== "slop");
  assert.equal(squad.length, 7);
  const r1 = admissibleSpecialists(squad, 0, 6, true, false);
  assert.ok(r1.start.every((m) => m.role !== "platform"));
  assert.equal(r1.deferred.filter((d) => d.member.role === "platform").length, 4);
  const r2 = admissibleSpecialists(squad.filter((m) => m.role === "platform"), 3, 6, true, true);
  assert.equal(r2.start.length, 3);
  assert.equal(r2.deferred.length, 1);
});

test("cap: plans over maxTotalAgents are refused", () => {
  const plan = planTopology(apps(20), { ...S(), maxTotalAgents: 100 });
  assert.equal(plan.ok, false);
  assert.match(plan.error!, /exceeds the cap of 100/);
});

test("ceilings are never silently exceeded", () => {
  assert.equal(planTopology(apps(5), S(7, 6)).ok, false);
  assert.equal(planTopology(apps(5), S(4, 9)).ok, false);
});

test("table: apps × spans — invariants hold", () => {
  for (const n of [1, 2, 4, 5, 17, 18, 20, 24, 25])
    for (let span = 2; span <= 6; span++) {
      const plan = planTopology(apps(n), S(span, 6));
      const nonOrch = plan.nodes.filter((x) => x.id !== "orch");
      // every non-orchestrator node has exactly one parent that exists
      const ids = new Set(plan.nodes.map((x) => x.id));
      for (const x of nonOrch) assert.ok(x.parentId && ids.has(x.parentId), `${x.id} parent`);
      for (const m of plan.managers) assert.ok(m.appIds.length <= span && m.appIds.length >= 1);
      const top = plan.managers.length + plan.directAppIds.length;
      if (plan.ok) assert.ok(top <= 6 || n === 1);
      else if (n > 4) assert.ok(Math.ceil(n / span) > 6, `n=${n} span=${span}: ${plan.error}`);
      if (n === 1) assert.equal(plan.rule, "C1");
      else if (n <= 4) assert.equal(plan.rule, "C2");
      else assert.equal(plan.rule, "C3");
      // staffing math (Full shape): total = 1 + m + n + 3n + ΣP + 2n
      if (n > 1) assert.equal(plan.counts.total, 1 + plan.managers.length + n + 3 * n + 2 * n + 2 * n);
    }
});

test("duplicate app names get -2 suffixes", () => {
  const plan = planTopology([{ name: "Loop", tagline: "", platforms: ["ios"] }, { name: "Loop", tagline: "", platforms: ["ios"] }], S());
  assert.deepEqual(plan.apps.map((a) => a.id), ["loop", "loop-2"]);
});
