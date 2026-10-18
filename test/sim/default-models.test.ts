// "I need to be able in the settings to pick the default planner model and the default
// orchestrator model." The defaults fill empty roles, and the Planner can move to the new default now.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP } from "../helpers/harness.ts";
import { HelmService } from "../../src/server/service.ts";
import { parseModelSetting, settingsDescriptors, toHelmSettings, type ModelChoice } from "../../src/server/settings.ts";
import { MODEL_CHOICES_KEY } from "../../src/server/engine/engine.ts";
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
  let written: Record<string, unknown> = {};
  svc.writeSettings = async (v) => {
    written = v;
    Object.assign(h.settings, { defaultModels: toHelmSettings({ plannerModel: v.plannerModel ?? "", plannerReasoning: v.plannerReasoning ?? "", orchestratorModel: v.orchestratorModel ?? "", orchestratorReasoning: v.orchestratorReasoning ?? "" }).defaultModels });
  };
  const r = await svc.setDefaultModels({ planner: SONNET, applyToPlanners: true });
  assert.deepEqual(r.moved, ["Live"]);
  assert.equal(r.text.planner, "claude-code/claude-sonnet-5-5:medium");
  assert.deepEqual(written, { plannerModel: "claude-code/claude-sonnet-5-5", plannerReasoning: "medium" }, "the model and the reasoning are separate pickers");
  assert.deepEqual(h.engine.run(runId).slots.planner, SONNET);
  assert.equal(h.engine.effectiveModel(h.engine.run(runId), h.repo.getNode(runId, "planner")!)?.modelId, "claude-sonnet-5-5");
  assert.equal(h.repo.listDirectives(runId, 5)[0].type, "slots", "on the record");
  const again = await svc.setDefaultModels({ planner: SONNET, applyToPlanners: true });
  assert.deepEqual(again.moved, [], "nothing to move twice");
  await assert.rejects(svc.setDefaultModels({ planner: { providerId: "claude-code", modelId: "no-such-model", reasoning: null } }), /no-such-model|No model|not offered|unknown/i);
});

test("the pickers list the models of connected providers, with names, so nothing is typed", async () => {
  const h = await createHarness();
  await h.engine.catalog(null);
  const choices = JSON.parse(h.repo.getMeta(MODEL_CHOICES_KEY) ?? "[]") as ModelChoice[];
  assert.ok(choices.length > 0, "the catalog saved the choices for Settings");
  assert.ok(choices.every((c) => /^[^/]+\/[^/]+$/.test(c.value) && c.label.length > 0));
  const d = settingsDescriptors(choices);
  assert.equal(d.plannerModel.type, "select");
  assert.deepEqual(d.plannerModel.options, ["none", ...choices.map((c) => c.value)]);
  assert.equal(d.plannerModel.experimental_optionLabels[choices[0].value], choices[0].label);
  assert.match(d.plannerModel.experimental_optionLabels.none, /Not set/);
  assert.equal(d.orchestratorModel.options.length, choices.length + 1);
  assert.equal(d.plannerReasoning.options[0], "default");
  // with no catalog yet, the pickers still exist (only "Not set")
  assert.deepEqual(settingsDescriptors([]).plannerModel.options, ["none"]);
});

test("the reasoning picker applies only when the chosen model offers that level", () => {
  const choices: ModelChoice[] = [{ value: "claude-code/claude-sonnet-5-5", label: "Sonnet 5.5", reasoning: ["low", "medium", "high"], defaultReasoning: "medium" }];
  const pick = (r: string) => toHelmSettings({ plannerModel: "claude-code/claude-sonnet-5-5", plannerReasoning: r }, () => {}, choices).defaultModels.planner;
  assert.equal(pick("high")?.reasoning, "high");
  assert.equal(pick("ultracode")?.reasoning, "medium", "falls back to the model's default");
  assert.equal(pick("default")?.reasoning, "medium");
  assert.equal(toHelmSettings({ plannerModel: "none", plannerReasoning: "high" }, () => {}, choices).defaultModels.planner, null);
});
