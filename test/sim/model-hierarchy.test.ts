// Supervisors change the models of the agents below them (helm_set_model): the Orchestrator
// anyone, a Manager its Leads and their teams, a Lead its squad and gates. Nobody is woken,
// the hierarchy is enforced, and a run-wide role change moves that role's default.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP, type Harness } from "../helpers/harness.ts";
import { callTool } from "../../src/server/agent/tools.ts";
import { parseBrief, SAMPLE_BRIEF } from "../../src/server/domain/brief.ts";
import type { NodeInfo, Portfolio } from "../../src/shared/types.ts";

const OPUS = "claude-code/claude-opus-5-5:high";
const SONNET = "claude-code/claude-sonnet-5-5:medium";

function six(): Portfolio {
  const p = parseBrief(SAMPLE_BRIEF).portfolio;
  return { ...p, apps: p.apps.slice(0, 6).map((a) => ({ ...a, group: null })) };
}

async function setup() {
  const h = await createHarness();
  const { runId } = h.engine.createRun({ name: "Models", brief: "x", portfolio: six(), slots: CHEAP, limits: { concurrency: 64 } });
  assert.deepEqual((await h.engine.startRun(runId)).problems, []);
  const nodes = h.repo.listNodes(runId);
  const mgrs = nodes.filter((n) => n.tier === "manager");
  assert.ok(mgrs.length >= 2, "two managers");
  const lead = nodes.find((n) => n.tier === "lead" && n.parentId === mgrs[0].id)!;
  const want = ["orch", ...mgrs.map((m) => m.id), lead.id];
  await h.clock.runUntil(h.clock.now() + 6 * 3600_000, { stopWhen: () => want.every((id) => !!h.repo.getNode(runId, id)?.threadId) });
  for (const id of want) assert.ok(h.repo.getNode(runId, id)?.threadId, `${id} has a thread`);
  return { h, runId, mgrs, lead };
}

const as = (h: Harness, runId: string, n: NodeInfo | string, name: string, args: unknown) =>
  callTool(h.engine, name, h.repo.getNode(runId, typeof n === "string" ? n : n.id)!.threadId!, args);
const model = (h: Harness, runId: string, id: string) => {
  const m = h.repo.getNode(runId, id)!.model;
  return m ? `${m.providerId}/${m.modelId}:${m.reasoning}` : null;
};
const under = (h: Harness, runId: string, root: string) => {
  const all = h.repo.listNodes(runId);
  const out: NodeInfo[] = [];
  const walk = (id: string) => all.filter((n) => n.parentId === id).forEach((n) => (out.push(n), walk(n.id)));
  walk(root);
  return out;
};

test("the Orchestrator moves every Slop Hunter: all switch, nobody is woken, future Slop Hunters follow", async () => {
  const { h, runId } = await setup();
  const before = h.repo.outboxForRun(runId).length;
  const r = await as(h, runId, "orch", "helm_set_model", { changes: [{ role: "slop hunters", model: OPUS }], reason: "the human asked" });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /^D-\d{4}: \d+ Slop Hunters/);
  const slops = h.repo.listNodes(runId).filter((n) => n.role === "slop");
  assert.ok(slops.length >= 6);
  for (const n of slops) assert.equal(model(h, runId, n.id), OPUS, n.id);
  assert.deepEqual(h.repo.getRun(runId)!.slots.slop, { providerId: "claude-code", modelId: "claude-opus-5-5", reasoning: "high" }, "the role's default moved");
  assert.equal(model(h, runId, h.repo.listNodes(runId).find((n) => n.role === "review")!.id), "claude-code/claude-haiku-5-5:low", "reviewers untouched");
  const d = h.repo.listDirectives(runId, 1)[0];
  assert.equal(d.type, "model");
  assert.equal(d.byNode, "orch");
  assert.equal(d.affected.length, slops.length);
  assert.ok(d.recipients.every((x) => x.level === "digest"), "nobody is woken");
  assert.ok(!h.repo.outboxForRun(runId).slice(before).some((o) => o.kind === "send" && String(o.idemKey).startsWith(d.id)), "no message interrupts anyone");
  assert.match(d.summary, /→ \d+ Slop Hunters: model → Claude Opus 5\.5/);
});

test("the Orchestrator sets two managers to two different models in one call", async () => {
  const { h, runId, mgrs } = await setup();
  const r = await as(h, runId, "orch", "helm_set_model", { changes: [{ nodes: [mgrs[0].id], model: OPUS }, { nodes: [mgrs[1].id], model: "claude-sonnet-5-5" }] });
  assert.ok(!r.isError, r.text);
  assert.equal(model(h, runId, mgrs[0].id), OPUS);
  assert.equal(model(h, runId, mgrs[1].id), SONNET, "provider and reasoning filled in from the catalog");
  assert.equal(h.repo.getRun(runId)!.slots.manager?.modelId, "claude-haiku-5-5", "only some managers moved: the default stays");
  // all managers at once moves the default
  const all = await as(h, runId, "orch", "helm_set_model", { changes: [{ role: "managers", model: OPUS }] });
  assert.ok(!all.isError, all.text);
  assert.equal(h.repo.getRun(runId)!.slots.manager?.modelId, "claude-opus-5-5");
});

test("a Manager changes the Slop Hunters of its own group only, and nobody above or beside it", async () => {
  const { h, runId, mgrs } = await setup();
  const [m1, m2] = mgrs;
  const r = await as(h, runId, m1, "helm_set_model", { changes: [{ role: "slop", model: OPUS }] });
  assert.ok(!r.isError, r.text);
  const mine = under(h, runId, m1.id).filter((n) => n.role === "slop");
  const theirs = under(h, runId, m2.id).filter((n) => n.role === "slop");
  assert.ok(mine.length && theirs.length);
  for (const n of mine) assert.equal(model(h, runId, n.id), OPUS);
  for (const n of theirs) assert.equal(model(h, runId, n.id), "claude-code/claude-haiku-5-5:low", "the other manager's group is untouched");
  assert.equal(h.repo.getRun(runId)!.slots.slop?.modelId, "claude-haiku-5-5", "a manager never moves the run's default");

  for (const target of ["orch", m2.id, m1.id, theirs[0].id]) {
    const bad = await as(h, runId, m1, "helm_set_model", { changes: [{ nodes: [target], model: OPUS }] });
    assert.ok(bad.isError, `${target}: ${bad.text}`);
    assert.match(bad.text, /not below you/);
  }
  assert.equal(model(h, runId, "orch"), "claude-code/claude-haiku-5-5:low");
  assert.equal(model(h, runId, m2.id), "claude-code/claude-haiku-5-5:low");
  // its own leads, by role and narrowed to one app
  const lead = under(h, runId, m1.id).find((n) => n.tier === "lead")!;
  const one = await as(h, runId, m1, "helm_set_model", { changes: [{ role: "lead", app: lead.appId!, model: SONNET }] });
  assert.ok(!one.isError, one.text);
  assert.equal(model(h, runId, lead.id), SONNET);
});

test("a Lead changes its own squad and gates, never another app's agents or its supervisors", async () => {
  const { h, runId, mgrs, lead } = await setup();
  const squad = under(h, runId, lead.id);
  const slop = squad.find((n) => n.role === "slop")!;
  const code = squad.find((n) => n.role === "code")!;
  const r = await as(h, runId, lead, "helm_set_model", { changes: [{ nodes: [slop.id], model: OPUS }, { role: "code", model: SONNET }] });
  assert.ok(!r.isError, r.text);
  assert.equal(model(h, runId, slop.id), OPUS);
  assert.equal(model(h, runId, code.id), SONNET);
  const other = h.repo.listNodes(runId).find((n) => n.role === "slop" && n.appId !== lead.appId)!;
  for (const target of [other.id, mgrs[0].id, "orch"]) {
    const bad = await as(h, runId, lead, "helm_set_model", { changes: [{ nodes: [target], model: OPUS }] });
    assert.ok(bad.isError && /not below you/.test(bad.text), bad.text);
  }
  const all = await as(h, runId, lead, "helm_set_model", { changes: [{ role: "reviewer", model: OPUS }] });
  assert.ok(!all.isError, all.text);
  assert.equal(h.repo.listNodes(runId).filter((n) => n.role === "review" && model(h, runId, n.id) === OPUS).length, 1, "only its own Reviewer");
});

test("helm_models lists the catalog and the agents below; bad models and roles are refused with the fix; specialists have no model tools", async () => {
  const { h, runId, mgrs, lead } = await setup();
  const list = await as(h, runId, mgrs[0], "helm_models", {});
  assert.match(list.text, /claude-code\/claude-opus-5-5/);
  assert.match(list.text, new RegExp(`${lead.id} · `));
  assert.ok(!list.text.includes(` ${mgrs[1].id} · `), "another manager is not below it");
  const bad = await as(h, runId, "orch", "helm_set_model", { changes: [{ role: "slop", model: "claude-code/no-such-model" }] });
  assert.ok(bad.isError && /No model/.test(bad.text), bad.text);
  const reasoning = await as(h, runId, "orch", "helm_set_model", { changes: [{ role: "slop", model: "claude-code/claude-haiku-5-5:max" }] });
  assert.ok(reasoning.isError && /reasoning level max/.test(reasoning.text), reasoning.text);
  const role = await as(h, runId, "orch", "helm_set_model", { changes: [{ role: "wizards", model: OPUS }] });
  assert.ok(role.isError && /unknown role/.test(role.text), role.text);
  const nobody = await as(h, runId, "orch", "helm_set_model", { changes: [{ model: OPUS }] });
  assert.ok(nobody.isError && /say who/.test(nobody.text), nobody.text);
  // one invalid change rejects the whole call: nothing moved
  const mixed = await as(h, runId, "orch", "helm_set_model", { changes: [{ role: "slop", model: OPUS }, { role: "slop", model: "nope/nope" }] });
  assert.ok(mixed.isError);
  assert.ok(h.repo.listNodes(runId).filter((n) => n.role === "slop").every((n) => model(h, runId, n.id) !== OPUS));

  const spec = under(h, runId, lead.id).find((n) => n.tier === "specialist")!;
  await h.clock.runUntil(h.clock.now() + 6 * 3600_000, { stopWhen: () => !!h.repo.getNode(runId, spec.id)?.threadId });
  const denied = await as(h, runId, spec, "helm_set_model", { changes: [{ nodes: [lead.id], model: OPUS }] });
  assert.ok(denied.isError && /is for the Orchestrator, Managers, App Leads and the Planner/.test(denied.text), denied.text);
});

test("a model on another provider moves the agent to a new thread", async () => {
  const { h, runId, lead } = await setup();
  const code = under(h, runId, lead.id).find((n) => n.role === "code")!;
  await h.clock.runUntil(h.clock.now() + 6 * 3600_000, { stopWhen: () => !!h.repo.getNode(runId, code.id)?.threadId });
  const old = h.repo.getNode(runId, code.id)!.threadId!;
  const r = await as(h, runId, lead, "helm_set_model", { changes: [{ nodes: [code.id], model: "codex/gpt-6-luna:high" }] });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /moved to a new thread on codex/);
  await h.clock.runUntil(h.clock.now() + 6 * 3600_000, { stopWhen: () => { const t = h.repo.getNode(runId, code.id)?.threadId; return !!t && t !== old; } });
  const t = h.sim.helmThreads().find((x) => x.id === h.repo.getNode(runId, code.id)!.threadId)!;
  assert.equal(t.providerId, "codex");
  assert.equal(t.model, "gpt-6-luna");
});
