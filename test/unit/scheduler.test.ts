import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AVG_CONCURRENT_PER_APP,
  admit,
  fairShareByManager,
  firstWave,
  inFlightCap,
  nextWave,
  prioritize,
  wavesEstimate,
  type Eligible,
  type WaveApp,
} from "../../src/server/domain/scheduler.ts";
import { parseBrief, SAMPLE_BRIEF } from "../../src/server/domain/brief.ts";
import { planTopology } from "../../src/server/domain/topology.ts";
import type { Priority, Stage } from "../../src/shared/types.ts";

// ───────────────────────────── capacity & waves (§4.2) ─────────────────────────────

test("§4.2 inFlightCap = floor(concurrency / 5), at least 1", () => {
  assert.equal(AVG_CONCURRENT_PER_APP, 5);
  assert.equal(inFlightCap(24), 4);
  assert.equal(inFlightCap(48), 9);
  assert.equal(inFlightCap(4), 1);
  assert.equal(inFlightCap(5), 1);
  assert.equal(inFlightCap(10), 2);
  assert.equal(inFlightCap(0), 1);
});

test("§4.2 20 apps at concurrency 24 → 4 in flight, 5 waves", () => {
  assert.deepEqual(wavesEstimate(20, 24), { inFlight: 4, waves: 5 });
  assert.equal(parseBrief(SAMPLE_BRIEF).portfolio.apps.length, 20);
  assert.deepEqual(wavesEstimate(0, 24), { inFlight: 4, waves: 0 });
  assert.deepEqual(wavesEstimate(1, 24), { inFlight: 4, waves: 1 });
  assert.deepEqual(wavesEstimate(21, 24), { inFlight: 4, waves: 6 });
  assert.deepEqual(wavesEstimate(20, 48), { inFlight: 9, waves: 3 });
  assert.deepEqual(wavesEstimate(3, 4), { inFlight: 1, waves: 3 });
});

// ───────────────────────────── fair share ─────────────────────────────

test("A6 fairShareByManager: round-robin across managers in first-seen order, FIFO within a manager", () => {
  const q = [
    { id: "a1", managerId: "A" },
    { id: "a2", managerId: "A" },
    { id: "a3", managerId: "A" },
    { id: "b1", managerId: "B" },
    { id: "c1", managerId: "C" },
    { id: "c2", managerId: "C" },
  ];
  assert.deepEqual(fairShareByManager(q, 6).map((x) => x.id), ["a1", "b1", "c1", "a2", "c2", "a3"]);
  assert.deepEqual(fairShareByManager(q, 4).map((x) => x.id), ["a1", "b1", "c1", "a2"]);
  assert.deepEqual(fairShareByManager(q, 2).map((x) => x.id), ["a1", "b1"]);
  assert.deepEqual(fairShareByManager(q, 0), []);
  assert.deepEqual(fairShareByManager(q, 99).length, 6);
  assert.deepEqual(fairShareByManager([], 3), []);
  // apps reporting to the Orchestrator directly (no manager) share one lane
  const direct = [{ id: "x", managerId: null }, { id: "y", managerId: null }, { id: "m", managerId: "M" }];
  assert.deepEqual(fairShareByManager(direct, 3).map((x) => x.id), ["x", "m", "y"]);
});

test("fairShareByManager does not mutate its input", () => {
  const q = [{ id: "a", managerId: "A" }, { id: "b", managerId: "B" }];
  const copy = structuredClone(q);
  fairShareByManager(q, 1);
  assert.deepEqual(q, copy);
});

// ───────────────────────────── nextWave ─────────────────────────────

const app = (id: string, stage: Stage, over: Partial<WaveApp> = {}): WaveApp => ({ id, stage, priority: "normal", order: Number(id.replace(/\D/g, "")) || 0, managerId: "M1", ...over });
const intake = (n: number, managers = ["M1"]) => Array.from({ length: n }, (_, i) => app(`q${i}`, "intake", { order: 100 + i, managerId: managers[i % managers.length] }));
const ids = (xs: WaveApp[]) => xs.map((x) => x.id);

test("A6 nextWave fills free in-flight slots from Intake", () => {
  // the sample: 20 apps in 5 managers at concurrency 24 → the first wave is 4 apps from 4 different managers
  const plan = planTopology(parseBrief(SAMPLE_BRIEF).portfolio.apps, { managerSpan: 4, orchestratorSpan: 6, leadSpan: 6, maxTotalAgents: 250 });
  const apps: WaveApp[] = plan.apps.map((a, i) => ({ id: a.id, stage: "intake", priority: "normal", order: i, managerId: a.managerId }));
  const w = firstWave(apps, 24);
  assert.equal(w.length, 4);
  assert.equal(new Set(w.map((a) => a.managerId)).size, 4);
  assert.deepEqual(ids(w), ["lumen", "ledgerly", "frame", "beacon"]);
});

test("§4.2 in-flight is Spec through Fix; Ready, Done and Cancelled free their slot", () => {
  const busy = (["spec", "build", "integrate", "review", "slop", "fix"] as Stage[]).map((s, i) => app(`f${i}`, s));
  assert.deepEqual(nextWave([...busy.slice(0, 4), ...intake(3)], 24, false), [], "4 in flight at cap 4");
  const settled = (["ready", "done", "cancelled"] as Stage[]).map((s, i) => app(`s${i}`, s));
  assert.equal(nextWave([...settled, ...intake(5)], 24, false).length, 4);
  assert.equal(nextWave([...busy.slice(0, 3), ...settled, ...intake(5)], 24, false).length, 1);
});

test("nextWave: spawns paused admits nothing; queue is sorted by priority then order", () => {
  assert.deepEqual(nextWave(intake(5), 24, true), []);
  const q = [app("q1", "intake", { order: 1, priority: "low" }), app("q2", "intake", { order: 2 }), app("q3", "intake", { order: 3, priority: "high" }), app("q4", "intake", { order: 0 })];
  assert.deepEqual(ids(nextWave(q, 24, false)), ["q3", "q4", "q2", "q1"]);
  assert.deepEqual(ids(nextWave(q, 10, false)), ["q3", "q4"]);
});

test("nextWave without batch admits into any free slot", () => {
  const apps = [app("f1", "build"), app("f2", "review"), app("f3", "fix"), ...intake(6)];
  assert.deepEqual(ids(nextWave(apps, 24, false)), ["q0"]);
  assert.deepEqual(ids(nextWave(apps, 24, false, { batch: false })), ["q0"]);
});

test("§4.2 batched (asked) waves wait until half the in-flight slots are free", () => {
  // cap 4: 3 in flight → 1 free < 2, and 6 still waiting → wait
  const three = [app("f1", "build"), app("f2", "review"), app("f3", "fix")];
  assert.deepEqual(nextWave([...three, ...intake(6)], 24, false, { batch: true }), []);
  // 2 in flight → 2 free = half → propose a wave of 2
  assert.deepEqual(ids(nextWave([...three.slice(0, 2), ...intake(6)], 24, false, { batch: true })), ["q0", "q1"]);
  // …unless the remaining queue fits in what is free
  assert.deepEqual(ids(nextWave([...three, ...intake(1)], 24, false, { batch: true })), ["q0"]);
  // …or nothing is in flight at all
  assert.deepEqual(ids(nextWave(intake(6), 24, false, { batch: true })), ["q0", "q1", "q2", "q3"]);
  // odd caps round half up: cap 9 needs 5 free
  const four = Array.from({ length: 4 }, (_, i) => app(`b${i}`, "build"));
  const five = Array.from({ length: 5 }, (_, i) => app(`b${i}`, "build"));
  assert.equal(nextWave([...five, ...intake(20)], 48, false, { batch: true }).length, 0, "4 free of 9 → wait");
  assert.equal(nextWave([...four, ...intake(20)], 48, false, { batch: true }).length, 5, "5 free of 9 → go");
  // batching never admits beyond the cap
  assert.equal(nextWave([...three.slice(0, 1), ...intake(10)], 24, false, { batch: true }).length, 3);
});

test("nextWave round-robins managers inside the priority-sorted queue", () => {
  const q = intake(8, ["A", "A", "A", "A", "B", "B", "C", "C"]).map((a, i) => ({ ...a, managerId: ["A", "A", "A", "A", "B", "B", "C", "C"][i] }));
  assert.deepEqual(ids(nextWave(q, 24, false)), ["q0", "q4", "q6", "q1"]);
});

// ───────────────────────────── prioritize (§4.3) ─────────────────────────────

let t0 = 1000;
const el = (nodeId: string, over: Partial<Eligible> = {}): Eligible => ({
  nodeId,
  tier: "specialist",
  appPriority: "normal",
  appStage: "build",
  managerId: "M1",
  createdAt: t0++,
  firstInLine: false,
  providerId: null,
  ...over,
});
const order = (xs: Eligible[]) => prioritize(xs).map((x) => x.nodeId);

test("§4.3(1) first-in-line beats everything else", () => {
  assert.deepEqual(order([el("hi", { appPriority: "high", appStage: "slop", tier: "gate" }), el("fil", { firstInLine: true, appPriority: "low", appStage: "spec" })]), ["fil", "hi"]);
});

test("§4.3(2) app priority: high > normal > low", () => {
  const ps: Priority[] = ["low", "normal", "high"];
  assert.deepEqual(order(ps.map((p) => el(p, { appPriority: p, appStage: p === "low" ? "slop" : "spec" }))), ["high", "normal", "low"]);
});

test("§4.3(3) stage depth: later stages first, gates before builders", () => {
  const xs = [
    el("spec.lead", { appStage: "spec", tier: "lead" }),
    el("build.ui", { appStage: "build" }),
    el("integrate.lead", { appStage: "integrate", tier: "lead" }),
    el("review.gate", { appStage: "review", tier: "gate" }),
    el("slop.gate", { appStage: "slop", tier: "gate" }),
    el("none", { appStage: null, tier: "manager" }),
  ];
  assert.deepEqual(order(xs), ["slop.gate", "review.gate", "integrate.lead", "build.ui", "spec.lead", "none"]);
  // in the same stage, a gate goes before a builder even if the builder is older
  assert.deepEqual(order([el("builder", { appStage: "review" }), el("gate", { appStage: "review", tier: "gate" })]), ["gate", "builder"]);
});

test("§4.3(4,5) fair share across managers, then older first", () => {
  const xs = [el("a1", { managerId: "A" }), el("a2", { managerId: "A" }), el("a3", { managerId: "A" }), el("b1", { managerId: "B" }), el("b2", { managerId: "B" }), el("c1", { managerId: "C" })];
  assert.deepEqual(order(xs), ["a1", "b1", "c1", "a2", "b2", "a3"]);
  // equal on every key → stable by node id
  assert.deepEqual(order([el("z", { createdAt: 5, managerId: "Z" }), el("y", { createdAt: 5, managerId: "Y" })]), ["y", "z"]);
});

test.todo("§4.3 prioritize: managerTurn depends on input order (and counts nodes from other priority/stage buckets), so a newer node can beat an older one from the same manager — spec does not define managerTurn");

test("prioritize does not mutate its input", () => {
  const xs = [el("b", { appPriority: "low" }), el("a", { appPriority: "high" })];
  prioritize(xs);
  assert.deepEqual(xs.map((x) => x.nodeId), ["b", "a"]);
});

// ───────────────────────────── admit (caps are hard) ─────────────────────────────

test("admit respects concurrency, the agent cap and provider caps, in priority order", () => {
  const cap = { concurrency: 4, running: 1, maxTotalAgents: 250, nonPlanned: 10, providerCaps: { codex: 1 }, runningByProvider: {}, spawnsPaused: false };
  const xs = [el("n1", { providerId: "codex" }), el("n2", { providerId: "codex" }), el("g", { tier: "gate", appStage: "review", providerId: "claude-code" }), el("n3")];
  const r = admit(xs, cap);
  assert.deepEqual(r.start, ["g", "n1", "n3"]);
  assert.deepEqual(r.held, [{ nodeId: "n2", reason: "codex cap 1 reached" }]);
  const tight = admit(xs, { ...cap, concurrency: 3 });
  assert.deepEqual(tight.start, ["g", "n1"]);
  assert.deepEqual(tight.held, [
    { nodeId: "n2", reason: "concurrency 3 reached" },
    { nodeId: "n3", reason: "concurrency 3 reached" },
  ]);
  assert.deepEqual(admit(xs, { ...cap, spawnsPaused: true }).start, []);
  const full = admit([el("x")], { ...cap, nonPlanned: 250 });
  assert.deepEqual(full.held, [{ nodeId: "x", reason: "agent cap 250 reached" }]);
  assert.deepEqual(admit([el("x")], { ...cap, nonPlanned: 250 }, { alreadyCounted: new Set(["x"]) }).start, ["x"], "queued nodes already count against the cap");
});
