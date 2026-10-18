import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP } from "../helpers/harness.ts";
import { parseBrief, SAMPLE_BRIEF } from "../../src/server/domain/brief.ts";

// Seen live: BB compacts only an idle or errored thread ("HTTP 409: Context can only be compacted
// while the thread is idle or errored"). A thread that woke up again before its compaction ran
// used to fail five times, log a warning each time, and still be told "it is being compacted".
test("compaction waits for an idle thread, and the agent is told only after it happened", async () => {
  const h = await createHarness();
  const p = parseBrief(SAMPLE_BRIEF).portfolio;
  const { runId } = h.engine.createRun({ name: "C", brief: "x", portfolio: { ...p, apps: p.apps.slice(0, 1).map((a) => ({ ...a, group: null })) }, slots: CHEAP, limits: { concurrency: 8 } });
  await h.engine.startRun(runId);
  await h.clock.runUntil(h.clock.now() + 3600_000, { stopWhen: () => !!h.repo.getNode(runId, "orch")?.threadId });
  const orch = h.repo.getNode(runId, "orch")!;
  const thread = h.sim.threads.get(orch.threadId!)!;
  const metaKey = `compact:${runId}:orch`;
  const compactRow = (key: string) => h.repo.outboxForRun(runId).find((o) => o.kind === "compact" && o.idemKey === key);
  const told = (key: string) => h.repo.outboxForRun(runId).some((o) => o.kind === "send" && o.idemKey === `${key}:msg`);

  // busy: skipped without spending attempts, the bucket forgotten so the next idle retries, nothing said
  thread.status = "active";
  h.repo.setMeta(metaKey, "0");
  h.repo.enqueue({ id: "o_busy", runId, kind: "compact", nodeId: "orch", payload: { key: "k-busy" }, idemKey: "k-busy" });
  h.engine.outbox.kick();
  await h.clock.runUntil(h.clock.now() + 3600_000, { stopWhen: () => compactRow("k-busy")?.state === "done" || thread.status !== "active" });
  const busy = compactRow("k-busy")!;
  assert.equal(busy.state, "done");
  assert.equal(busy.attempts, 0);
  assert.match(JSON.stringify(busy.result), /busy/);
  assert.equal(h.repo.getMeta(metaKey), "");
  assert.ok(!told("k-busy"), "no message about a compaction that did not happen");

  // idle: compacted, then the agent is told to re-read its brief
  thread.status = "idle";
  const before = thread.tokens;
  h.repo.enqueue({ id: "o_idle", runId, kind: "compact", nodeId: "orch", payload: { key: "k-idle" }, idemKey: "k-idle" });
  h.engine.outbox.kick();
  await h.clock.runUntil(h.clock.now() + 3600_000, { stopWhen: () => compactRow("k-idle")?.state === "done" });
  assert.equal(compactRow("k-idle")!.state, "done");
  assert.ok(thread.tokens <= before);
  assert.ok(told("k-idle"), "the agent hears about the compaction once it happened");
});
