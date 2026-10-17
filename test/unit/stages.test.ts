import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STAGES,
  STAGE_IDX,
  LEAD_TRANSITIONS,
  SPEC_FILES,
  TASK_COLS,
  appMoveRule,
  colOfStatus,
  isInFlight,
  leadTransition,
  readyAllowed,
  stageLabel,
  stagePct,
  taskMoveRule,
  type TaskCol,
  type TransitionFacts,
} from "../../src/server/domain/stages.ts";
import type { NodeStatus, Stage } from "../../src/shared/types.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const ALL_STAGES: Stage[] = [...STAGES.map((s) => s.id), "cancelled"];

/** Facts under which every lead transition's evidence is satisfied. */
const green = (over: Partial<TransitionFacts> = {}): TransitionFacts => ({
  committedFiles: new Set(SPEC_FILES),
  buildersDone: true,
  buildersPending: [],
  checksGreen: true,
  checksMissing: [],
  checksFailing: [],
  integrationHead: HEAD,
  ...over,
});

const reasonOf = (r: { ok: true } | { ok: false; reason: string }) => (r.ok ? null : r.reason);

// ───────────────────────────── leadTransition ─────────────────────────────

test("§5.1: the four lead transitions are allowed when their evidence holds", () => {
  assert.deepEqual(LEAD_TRANSITIONS, { spec: ["build"], build: ["integrate"], integrate: ["review"], fix: ["integrate"] });
  for (const [from, tos] of Object.entries(LEAD_TRANSITIONS) as Array<[Stage, Stage[]]>)
    for (const to of tos) assert.deepEqual(leadTransition(from, to, green()), { ok: true }, `${from} → ${to}`);
});

test("§5.1: every other (from, to) pair is refused, naming what the lead may request", () => {
  let refused = 0;
  for (const from of ALL_STAGES)
    for (const to of ALL_STAGES) {
      if (LEAD_TRANSITIONS[from]?.includes(to)) continue;
      const r = leadTransition(from, to, green());
      assert.equal(r.ok, false, `${from} → ${to} must be refused`);
      const reason = reasonOf(r)!;
      assert.ok(reason.startsWith(`helm_stage cannot move ${stageLabel(from)} → ${stageLabel(to)}.`), reason);
      const allowed = LEAD_TRANSITIONS[from];
      if (allowed) assert.match(reason, new RegExp(`may only request ${allowed.map(stageLabel).join(" or ")}\\.$`));
      else assert.match(reason, /may only request nothing — this stage advances on gate verdicts or the human\.$/);
      refused++;
    }
  assert.equal(refused, ALL_STAGES.length * ALL_STAGES.length - 4);
});

test("refusal wording for gate-driven stages and skipping ahead", () => {
  assert.equal(
    reasonOf(leadTransition("review", "slop", green())),
    "helm_stage cannot move Review → Slop check. From Review a lead may only request nothing — this stage advances on gate verdicts or the human.",
  );
  assert.equal(reasonOf(leadTransition("spec", "integrate", green())), "helm_stage cannot move Spec → Integrate. From Spec a lead may only request Build.");
  assert.equal(reasonOf(leadTransition("integrate", "ready", green())), "helm_stage cannot move Integrate → Ready. From Integrate a lead may only request Review.");
  assert.equal(reasonOf(leadTransition("fix", "build", green())), "helm_stage cannot move Fix → Build. From Fix a lead may only request Integrate.");
  assert.match(reasonOf(leadTransition("cancelled", "spec", green()))!, /cannot move Cancelled → Spec/);
});

test("spec → build requires all four SPEC files committed, listed in order", () => {
  assert.deepEqual(SPEC_FILES, ["SPEC.md", "ARCHITECTURE.md", "CONTRACT.md", "ACCEPTANCE.md"]);
  assert.equal(
    reasonOf(leadTransition("spec", "build", green({ committedFiles: new Set() }))),
    "Spec is not complete: SPEC.md, ARCHITECTURE.md, CONTRACT.md, ACCEPTANCE.md not committed on the integration branch.",
  );
  for (const f of SPEC_FILES) {
    const files = new Set(SPEC_FILES.filter((x) => x !== f));
    files.add("README.md");
    assert.equal(reasonOf(leadTransition("spec", "build", green({ committedFiles: files }))), `Spec is not complete: ${f} not committed on the integration branch.`);
  }
  // Case matters: these are file names at the integration HEAD.
  const lower = new Set(SPEC_FILES.map((f) => f.toLowerCase()));
  assert.equal(leadTransition("spec", "build", green({ committedFiles: lower })).ok, false);
});

test("spec → build does not depend on builders or checks", () => {
  const facts = green({ buildersDone: false, buildersPending: ["x"], checksGreen: false, checksMissing: ["build"], checksFailing: ["tests"], integrationHead: null });
  assert.deepEqual(leadTransition("spec", "build", facts), { ok: true });
});

test("build → integrate requires every builder's verified done report", () => {
  const r = leadTransition("build", "integrate", green({ buildersDone: false, buildersPending: ["lumen.ui", "lumen.code"] }));
  assert.equal(reasonOf(r), "Builders without a verified done report: lumen.ui, lumen.code.");
  // checks are not required to *enter* Integrate — that is where they run
  assert.deepEqual(leadTransition("build", "integrate", green({ checksGreen: false, checksMissing: ["build"], integrationHead: null })), { ok: true });
});

test("fix → integrate requires fixes reported with evidence", () => {
  const r = leadTransition("fix", "integrate", green({ buildersDone: false, buildersPending: ["lumen.platform.ios"] }));
  assert.equal(reasonOf(r), "Fixes not reported with evidence yet: lumen.platform.ios.");
});

test("integrate → review requires an integration HEAD and green checks recorded on it", () => {
  assert.equal(reasonOf(leadTransition("integrate", "review", green({ integrationHead: null }))), "No integration HEAD found.");
  assert.equal(
    reasonOf(leadTransition("integrate", "review", green({ checksGreen: false, checksMissing: ["build", "tests"] }))),
    "Checks not recorded on 012345678: build, tests. Run them through .helm/run-check.sh and call helm_record_check.",
  );
  assert.equal(
    reasonOf(leadTransition("integrate", "review", green({ checksGreen: false, checksFailing: ["lint"] }))),
    "Checks failing on 012345678: lint.",
  );
  // missing is reported before failing
  assert.match(reasonOf(leadTransition("integrate", "review", green({ checksGreen: false, checksMissing: ["a"], checksFailing: ["b"] })))!, /not recorded.*: a\./);
  // integrate → review does not look at builders (they finished before Integrate)
  assert.deepEqual(leadTransition("integrate", "review", green({ buildersDone: false, buildersPending: ["x"] })), { ok: true });
});

// ───────────────────────────── readyAllowed (A13, D12) ─────────────────────────────

const readyIn = (over: Partial<Parameters<typeof readyAllowed>[0]> = {}): Parameters<typeof readyAllowed>[0] => ({
  commit: HEAD,
  reviewPassCommit: HEAD,
  slopPassCommit: HEAD,
  checksGreenCommit: HEAD,
  openZeroTolerance: 0,
  waivedGates: [],
  ...over,
});
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";

test("A13: Ready needs both gate passes and green checks on the same commit", () => {
  assert.deepEqual(readyAllowed(readyIn()), { ok: true });
  assert.equal(reasonOf(readyAllowed(readyIn({ commit: null }))), "No integration commit.");
  assert.equal(reasonOf(readyAllowed(readyIn({ reviewPassCommit: null }))), "No valid Reviewer pass on this commit.");
  assert.equal(reasonOf(readyAllowed(readyIn({ reviewPassCommit: OTHER }))), "No valid Reviewer pass on this commit.");
  assert.equal(reasonOf(readyAllowed(readyIn({ slopPassCommit: null }))), "No valid Slop Hunter pass on this commit.");
  assert.equal(reasonOf(readyAllowed(readyIn({ slopPassCommit: OTHER }))), "No valid Slop Hunter pass on this commit.");
  assert.equal(reasonOf(readyAllowed(readyIn({ checksGreenCommit: null }))), "Deterministic checks are not green on this commit.");
  assert.equal(reasonOf(readyAllowed(readyIn({ checksGreenCommit: OTHER }))), "Deterministic checks are not green on this commit.");
  assert.equal(reasonOf(readyAllowed(readyIn({ openZeroTolerance: 2 }))), "2 zero-tolerance findings are still open.");
});

test("A13: gates passed on one commit and checks green on another is not Ready", () => {
  // Every gate passed — but on the previous commit; checks are green on the new one.
  const r = readyAllowed(readyIn({ reviewPassCommit: OTHER, slopPassCommit: OTHER }));
  assert.equal(r.ok, false);
  // And the reverse: gates on HEAD, checks only on the old commit.
  assert.equal(readyAllowed(readyIn({ checksGreenCommit: OTHER })).ok, false);
});

test("a human-waived gate does not need a pass, but checks still must be green", () => {
  assert.deepEqual(readyAllowed(readyIn({ reviewPassCommit: null, waivedGates: ["review"] })), { ok: true });
  assert.deepEqual(readyAllowed(readyIn({ slopPassCommit: null, waivedGates: ["slop"] })), { ok: true });
  assert.deepEqual(readyAllowed(readyIn({ reviewPassCommit: null, slopPassCommit: null, waivedGates: ["review", "slop"] })), { ok: true });
  assert.equal(readyAllowed(readyIn({ reviewPassCommit: null, waivedGates: ["slop"] })).ok, false);
  assert.equal(readyAllowed(readyIn({ waivedGates: ["review", "slop"], checksGreenCommit: null })).ok, false);
  assert.equal(readyAllowed(readyIn({ waivedGates: ["review", "slop"], openZeroTolerance: 1 })).ok, false);
});

test("D12: Ready is reachable without local verification for CI-tier platforms (acceptance happens at sign-off)", () => {
  // readyAllowed takes no platform input on purpose: Windows/Android apps verified only by CI still reach
  // Ready on green gates + checks; the sign-off card carries "… not verified on this machine" and the
  // human's sign-off is the explicit acceptance (§5.4, D12). The card text is produced by the engine.
  const input = readyIn();
  assert.deepEqual(Object.keys(input).sort(), ["checksGreenCommit", "commit", "openZeroTolerance", "reviewPassCommit", "slopPassCommit", "waivedGates"]);
  assert.deepEqual(readyAllowed(input), { ok: true });
  // …and sign-off itself (Ready → Done) is a human move that the board always allows.
  assert.deepEqual(appMoveRule({ name: "Quill", stage: "ready" }, "done"), { ok: true, act: "signoff", label: "Sign off" });
});

// ───────────────────────────── board: apps ─────────────────────────────

test("§5.7: the four human app moves", () => {
  const a = (stage: Stage) => ({ name: "Lumen", stage });
  assert.deepEqual(appMoveRule(a("ready"), "done"), { ok: true, act: "signoff", label: "Sign off" });
  assert.deepEqual(appMoveRule(a("ready"), "build"), { ok: true, act: "sendback", label: "Send back to Build" });
  assert.deepEqual(appMoveRule(a("intake"), "spec"), { ok: true, act: "start", label: "Start now" });
  assert.deepEqual(appMoveRule(a("done"), "ready"), { ok: true, act: "reopen", label: "Reopen" });
});

test("§5.7: every other app drag snaps back with a reason; same column is a no-op", () => {
  const allowed = new Set(["ready>done", "ready>build", "intake>spec", "done>ready"]);
  const board = STAGES.map((s) => s.id);
  for (const from of board)
    for (const to of board) {
      const r = appMoveRule({ name: "Lumen", stage: from }, to);
      if (from === to) {
        assert.deepEqual(r, { ok: true, noop: true });
        continue;
      }
      if (allowed.has(`${from}>${to}`)) {
        assert.equal(r.ok, true);
        continue;
      }
      assert.equal(r.ok, false, `${from} → ${to}`);
      const why = (r as { why: string }).why;
      if (from === "ready" || from === "done") assert.equal(why, `${stageLabel(from)} apps can be signed off or sent back to Build — not moved to ${stageLabel(to)}.`);
      else if (STAGE_IDX[to] > STAGE_IDX[from]) assert.match(why, /stages advance on evidence, not on drag\.$/);
      else assert.match(why, /^Stages don’t run backwards by drag\./);
    }
});

test("forward-drag reasons name what actually advances the stage", () => {
  const why = (stage: Stage, to: Stage) => (appMoveRule({ name: "Lumen", stage }, to) as { why: string }).why;
  assert.equal(why("build", "integrate"), "Lumen moves to Integrate when its builders finish and integration checks pass — stages advance on evidence, not on drag.");
  assert.match(why("review", "slop"), /when its Reviewer passes/);
  assert.match(why("slop", "ready"), /when its Slop Hunter passes/);
  assert.match(why("spec", "build"), /when its work completes/);
  assert.match(why("intake", "build"), /Lumen moves to Build/);
});

// ───────────────────────────── board: tasks ─────────────────────────────

test("colOfStatus maps every node status to a task column", () => {
  const expected: Record<NodeStatus, TaskCol> = {
    planned: "planned",
    queued: "queued",
    paused: "queued",
    idle: "queued",
    running: "running",
    waiting: "waiting",
    needs: "needs",
    failed: "needs",
    done: "done",
  };
  for (const [s, c] of Object.entries(expected)) assert.equal(colOfStatus(s as NodeStatus), c, s);
  assert.equal(colOfStatus("bogus" as NodeStatus), "queued");
  assert.deepEqual(TASK_COLS.map((c) => c.id), ["planned", "queued", "running", "waiting", "needs", "done"]);
});

test("§5.7: the human task moves", () => {
  assert.deepEqual(taskMoveRule({ status: "planned" }, "running"), { ok: true, act: "start", label: "Spawn and start now" });
  for (const status of ["queued", "paused", "idle"] as NodeStatus[]) assert.deepEqual(taskMoveRule({ status }, "running"), { ok: true, act: "start", label: "Start now" });
  assert.deepEqual(taskMoveRule({ status: "planned" }, "queued"), { ok: true, act: "spawn", label: "Spawn (queue)" });
  assert.deepEqual(taskMoveRule({ status: "running" }, "queued"), { ok: true, act: "hold", label: "Hold" });
});

test("§5.7: refused task moves and their reasons", () => {
  const statuses: NodeStatus[] = ["planned", "queued", "paused", "idle", "running", "waiting", "needs", "failed", "done"];
  const cols = TASK_COLS.map((c) => c.id) as TaskCol[];
  const allowed = new Set(["planned>running", "queued>running", "planned>queued", "running>queued"]);
  for (const status of statuses)
    for (const to of cols) {
      const from = colOfStatus(status);
      const r = taskMoveRule({ status }, to);
      if (from === to) {
        assert.deepEqual(r, { ok: true, noop: true }, `${status} → ${to}`);
        continue;
      }
      if (allowed.has(`${from}>${to}`)) {
        assert.equal(r.ok, true, `${status} → ${to}`);
        continue;
      }
      assert.equal(r.ok, false, `${status} → ${to}`);
      const why = (r as { why: string }).why;
      if (from === "needs") assert.equal(why, "This is waiting on you — resolve it in Needs you, then it moves on its own.");
      else if (from === "done") assert.equal(why, "Done work is final. To redo it, tell the lead what to change.");
      else if (to === "done" || to === "waiting" || to === "needs") assert.match(why, /^Agents move to (Done|Waiting|Needs you) when they report it, not by drag\.$/);
      else assert.equal(why, "That move isn’t something you can force.");
    }
  assert.equal((taskMoveRule({ status: "running" }, "needs") as { why: string }).why, "Agents move to Needs you when they report it, not by drag.");
});

// ───────────────────────────── helpers ─────────────────────────────

test("in-flight stages are Spec through Fix (§4.2)", () => {
  assert.deepEqual(ALL_STAGES.filter(isInFlight), ["spec", "build", "integrate", "review", "slop", "fix"]);
  assert.equal(stageLabel("slop"), "Slop check");
  assert.equal(stageLabel("cancelled"), "Cancelled");
});

test("stagePct is monotonic along the main path and in the fraction, clamped to [0, 100]", () => {
  const path: Stage[] = ["intake", "spec", "build", "integrate", "review", "slop", "ready", "done"];
  let prev = -1;
  for (const s of path) {
    for (let k = 0; k <= 10; k++) {
      const v = stagePct(s, k / 10);
      assert.ok(v >= prev, `${s} @ ${k / 10}: ${v} < ${prev}`);
      assert.ok(v >= 0 && v <= 100);
      prev = v;
    }
  }
  assert.equal(stagePct("intake"), 0);
  assert.equal(stagePct("ready"), 100);
  assert.equal(stagePct("done", 0.5), 100);
  assert.equal(stagePct("cancelled", 0.5), 0);
  // fractions outside [0, 1] are clamped
  assert.equal(stagePct("build", -3), stagePct("build", 0));
  assert.equal(stagePct("build", 7), stagePct("build", 1));
  // Fix sits between Integrate's start and Slop's end, and is monotonic in its own fraction
  assert.ok(stagePct("fix", 0) >= stagePct("integrate", 0) && stagePct("fix", 1) <= stagePct("slop", 1));
  for (let k = 0; k < 10; k++) assert.ok(stagePct("fix", k / 10) <= stagePct("fix", (k + 1) / 10));
});
