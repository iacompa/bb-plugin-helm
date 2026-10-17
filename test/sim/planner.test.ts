import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP } from "../helpers/harness.ts";
import { callTool } from "../../src/server/agent/tools.ts";
import { Planner, defaultPlannerModel } from "../../src/server/engine/planner.ts";
import { SAMPLE_BRIEF } from "../../src/server/domain/brief.ts";
import type { HelmThreadMeta } from "../../src/server/bb/port.ts";
import type { Profile } from "../../src/server/bb/sim-agents.ts";

const FREE_TEXT = `Hi! I'd like three small things built this quarter.
Mint Jar: a savings jar for kids, on iPhone and Android
Ledgerly: a receipts scanner for freelancers, on macOS and Windows
Quiet Hours: a focus timer
Thanks.`;

const planner = (p: Profile) => (m: HelmThreadMeta): Profile => (m.role === "planner" ? p : "diligent");

test("structured briefs never need the planner; free text does", () => {
  assert.equal(Planner.needsPlanner(SAMPLE_BRIEF), false);
  assert.equal(Planner.needsPlanner(FREE_TEXT), true);
});

test("D11: the planner defaults to the code slot's model at medium", () => {
  const m = defaultPlannerModel(CHEAP)!;
  assert.equal(m.modelId, CHEAP.code!.modelId);
  assert.equal(m.reasoning, "medium");
});

test("§7.7: one hidden planner thread proposes a valid portfolio, then is archived", async () => {
  const h = await createHarness({ profileFor: planner("diligent") });
  const s = await h.planner.start({ brief: FREE_TEXT, model: defaultPlannerModel(CHEAP)! });
  assert.equal(s.status, "running", s.error ?? "");
  await h.clock.advance(5 * 60_000);
  const done = h.planner.get(s.id)!;
  assert.equal(done.status, "done", done.error ?? "");
  assert.deepEqual(done.portfolio!.apps.map((a) => a.name), ["Mint Jar", "Ledgerly", "Quiet Hours"]);
  assert.deepEqual(done.portfolio!.apps[1].platforms.sort(), ["mac", "win"]);
  assert.ok(done.portfolio!.questions.length <= 3 && done.portfolio!.questions.some((q) => q.includes("Quiet Hours")));
  const t = h.sim.threads.get(s.threadId!)!;
  assert.equal(t.visibility, "hidden");
  assert.ok(t.archived, "archived after its one turn");
  assert.equal(h.sim.helmThreads().filter((x) => x.meta?.tier === "planner").length, 1, "exactly one planner thread");
  // nothing else was spawned and no run exists
  assert.equal(h.repo.listRuns().length, 0);
});

test("an invalid proposal is rejected with the reason and the planner can correct it in the same turn", async () => {
  const h = await createHarness({ profileFor: planner("sloppy") });
  const s = await h.planner.start({ brief: FREE_TEXT, model: defaultPlannerModel(CHEAP)! });
  await h.clock.advance(5 * 60_000);
  const done = h.planner.get(s.id)!;
  assert.equal(done.status, "done", `${done.error} ${h.agents.log.slice(-5).join(" | ")}`);
  assert.equal(done.attempts, 1, "the malformed call never reached the planner record: the tool's schema refused it with the reason");
});

test("a planner that ends its turn without proposing fails (from BB's idle event, no polling)", async () => {
  const h = await createHarness({ profileFor: planner("liar") });
  const s = await h.planner.start({ brief: FREE_TEXT, model: defaultPlannerModel(CHEAP)! });
  await h.clock.advance(5 * 60_000);
  const f = h.planner.get(s.id)!;
  assert.equal(f.status, "failed");
  assert.match(f.error ?? "", /without an accepted proposal/);
});

test("only the planner's own thread may propose a portfolio; agents and strangers are refused", async () => {
  const h = await createHarness({ profileFor: planner("liar") });
  const s = await h.planner.start({ brief: FREE_TEXT, model: defaultPlannerModel(CHEAP)! });
  const pf = { apps: [{ name: "X", tagline: "x", platforms: ["ios"] }], groups: [], assumptions: [], questions: [] };
  const opts = { planner: (t: string, p: unknown) => h.planner.propose(t, p) };
  const stranger = await callTool(h.engine, "helm_propose_plan", "thr_stranger", { portfolio: pf }, opts);
  assert.ok(stranger.isError);
  assert.equal(h.planner.get(s.id)!.status, "running");
  const unknownModel = await h.planner.start({ brief: FREE_TEXT, model: { providerId: "claude-code", modelId: "no-such-model", reasoning: "low" } }).catch((e: Error) => e);
  assert.ok(unknownModel instanceof Error && /Planner model/.test(unknownModel.message), "a missing model is never substituted");
});
