// Session tabs in the Helm panel: several runs open at once, and a fresh session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSession } from "../../components/helm/store.ts";

const runs = ["r3", "r2", "r1"]; // newest first, as run_list returns them

test("first visit ever opens the newest run as a tab", () => {
  assert.deepEqual(resolveSession(runs, null, [], { firstLoad: true, firstVisit: true }), { runId: "r3", tabs: ["r3"] });
});

test("a reload brings back the remembered run and every open tab", () => {
  assert.deepEqual(resolveSession(runs, "r1", ["r2", "r1"], { firstLoad: true, firstVisit: false }), { runId: "r1", tabs: ["r2", "r1"] });
});

test("a fresh session stays blank even with tabs open, and the tabs stay", () => {
  assert.deepEqual(resolveSession(runs, null, ["r2", "r1"], { firstLoad: false, firstVisit: false }), { runId: null, tabs: ["r2", "r1"] });
});

test("a reload of a fresh session with closed tabs stays blank", () => {
  assert.deepEqual(resolveSession(runs, null, [], { firstLoad: true, firstVisit: false }), { runId: null, tabs: [] });
});

test("opening a run adds its tab; a run that disappears closes its tab and falls back to another", () => {
  assert.deepEqual(resolveSession(runs, "r3", ["r1"], { firstLoad: false, firstVisit: false }), { runId: "r3", tabs: ["r1", "r3"] });
  assert.deepEqual(resolveSession(["r1", "r2"], "r9", ["r9", "r2"], { firstLoad: false, firstVisit: false }), { runId: "r2", tabs: ["r2"] });
  assert.deepEqual(resolveSession([], "r9", ["r9"], { firstLoad: false, firstVisit: false }), { runId: null, tabs: [] });
});
