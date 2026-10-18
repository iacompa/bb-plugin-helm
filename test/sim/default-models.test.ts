// "I need to be able in the settings to pick the default planner model and the default
// orchestrator model." The defaults fill empty roles, and the Planner can move to the new default now.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP } from "../helpers/harness.ts";
import { HelmService } from "../../src/server/service.ts";
import { parseModelSetting, toHelmSettings } from "../../src/server/settings.ts";
import { parseBrief, SAMPLE_BRIEF } from "../../src/server/domain/brief.ts";
import type { Portfolio } from "../../src/shared/types.ts";

const SONNET = { providerId: "claude-code", modelId: "claude-sonnet-5-5", reasoning: "medium" };
function two(): Portfolio {
  const p = parseBrief(SAMPLE_BRIEF).portfolio;
  return { ...p, apps: p.apps.slice(0, 2).map((a) => ({ ...a, group: null })) };
}

test("the settings read provider/model:reasoning and ignore anything else", () => {
  assert.deepEqual(parseModelSetting("claude-code/claude-sonnet-5-5:medium", "x"), SONNET);
  assert.deepEqual(parseModelSetting("codex/gpt-6.1-sol", "x"), { providerId: "codex", modelId: "gpt-6.1-sol", reasoning: null });
  const warned: string[] = [];
  assert.equal(parseModelSetting("sonnet please", "Default Planner model", (m) => warned.push(m)), null);
  assert.match(warned[0], /Default Planner model.*not provider\/model:reasoning/);
  assert.deepEqual(toHelmSettings({ plannerModel: "claude-code/claude-sonnet-5-5:medium" }).defaultModels, { planner: SONNET, orchestrator: null });
});

test("new runs take the default Planner and Orchestrator models for roles they leave empty", async () => {
  const h = await createHarness({ settings: { defaultModels: { planner: SONNET, orchestrator: { ...SONNET, reasoning: "high" } } } });
  const { orchestrator: _o, planner: _p, ...rest } = CHEAP;
  const { runId } = h.engine.createRun({ name: "D", brief: "x", portfolio: two(), slots: rest, limits: { concurrency: 32 } });
  const run = h.engine.run(runId);
  assert.deepEqual(run.slots.orchestrator, { ...SONNET, reasoning: "high" });
  assert.deepEqual(run.slots.planner, SONNET);
  // a run that chose its own keeps it
  const own = h.engine.createRun({ name: "E", brief: "x", portfolio: two(), slots: CHEAP, limits: { concurrency: 32 } });
  assert.equal(h.engine.run(own.runId).slots.planner?.modelId, "claude-haiku-5-5");
});

test("saving a default Planner model can move every running run's Planner to it now", async () => {
  const h = await createHarness();
  const { planner: _p, ...rest } = CHEAP;
  const { runId } = h.engine.createRun({ name: "Live", brief: "x", portfolio: two(), slots: rest, limits: { concurrency: 32 } });
  await h.engine.startRun(runId);
  await h.clock.runUntil(h.clock.now() + 6 * 3600_000, { stopWhen: () => !!h.repo.getNode(runId, "planner")?.threadId });
  const svc = new HelmService(h.engine);
  svc.writeSettings = async (v) => {
    Object.assign(h.settings, { defaultModels: toHelmSettings({ plannerModel: v.plannerModel ?? "", orchestratorModel: v.orchestratorModel ?? "" }).defaultModels });
  };
  const r = await svc.setDefaultModels({ planner: SONNET, applyToPlanners: true });
  assert.deepEqual(r.moved, ["Live"]);
  assert.equal(r.text.planner, "claude-code/claude-sonnet-5-5:medium");
  assert.deepEqual(h.engine.run(runId).slots.planner, SONNET);
  assert.equal(h.engine.effectiveModel(h.engine.run(runId), h.repo.getNode(runId, "planner")!)?.modelId, "claude-sonnet-5-5");
  assert.equal(h.repo.listDirectives(runId, 5)[0].type, "slots", "on the record");
  const again = await svc.setDefaultModels({ planner: SONNET, applyToPlanners: true });
  assert.deepEqual(again.moved, [], "nothing to move twice");
  await assert.rejects(svc.setDefaultModels({ planner: { providerId: "claude-code", modelId: "no-such-model", reasoning: null } }), /no-such-model|No model|not offered|unknown/i);
});
