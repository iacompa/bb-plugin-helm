import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP } from "../helpers/harness.ts";
import { parseBrief, SAMPLE_BRIEF } from "../../src/server/domain/brief.ts";
import { verdict } from "../../src/server/engine/gates.ts";
import type { Verdict } from "../../src/server/domain/verdict.ts";

// Seen live: gates sent the app's display name (helm_context showed only the name) and were
// refused with "appId must be …"; a gate whose verdict was already accepted was told the app
// "is in Slop check, not Review" with no hint that nothing more was needed.
test("a gate may name its app by id or name; a late verdict is told it was already accepted", async () => {
  const h = await createHarness();
  const p = parseBrief(SAMPLE_BRIEF).portfolio;
  const { runId } = h.engine.createRun({ name: "V", brief: "x", portfolio: { ...p, apps: p.apps.slice(0, 1).map((a) => ({ ...a, group: null })) }, slots: CHEAP, limits: { concurrency: 8 } });
  await h.engine.startRun(runId);
  const app = h.repo.listApps(runId)[0];
  h.repo.updateApp(runId, app.id, { repoPath: "/tmp/helm-test-repo", stage: "build" });
  const gate = h.repo.listNodes(runId).find((n) => n.appId === app.id && n.role === "review")!;
  const v = (appId: string): Verdict => ({ gate: "review", appId, commit: "a".repeat(40), verdict: "pass", summary: "ok", checks: [], findings: [], unverified: [] });

  assert.match(await verdict(h.engine, gate, v("someone-else")), new RegExp(`^Rejected: appId must be "${app.id}" \\(${app.name}, the app you judge\\), not "someone-else"\\.$`));
  // the display name, in any case, names the gate's own app: the next check (the stage) answers
  assert.match(await verdict(h.engine, gate, v(app.name.toUpperCase())), /is in Build, not Review\. Helm messages you when there is a commit to judge\.$/);

  h.repo.insertVerdict({ id: "V-1", runId, nodeId: gate.id, appId: app.id, gate: "review", commit: "b".repeat(40), verdict: "pass", summary: "ok", checks: [], unverified: [], accepted: true, problems: [], ts: h.clock.now() });
  h.repo.updateApp(runId, app.id, { stage: "slop" });
  assert.match(await verdict(h.engine, gate, v(app.id)), /^Nothing to do: your pass verdict on bbbbbbbbb was already accepted and .* has moved on to Slop check\./);
});
