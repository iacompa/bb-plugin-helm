// The human's word comes first: an agent the human tells acts at once, its supervisors get an FYI
// they need not answer, and an agent that has not started (or already finished) is started for it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP, type Harness } from "../helpers/harness.ts";
import { ack, createDirective } from "../../src/server/engine/direct.ts";
import { instructionsFor } from "../../src/server/domain/briefs.ts";
import { COMMON_RULES } from "../../src/server/domain/roles.ts";
import { parseBrief, SAMPLE_BRIEF } from "../../src/server/domain/brief.ts";
import type { Portfolio } from "../../src/shared/types.ts";

function five(): Portfolio {
  const p = parseBrief(SAMPLE_BRIEF).portfolio;
  return { ...p, apps: p.apps.slice(0, 5).map((a) => ({ ...a, group: null })) };
}

async function startedRun(h: Harness, concurrency: number) {
  const { runId } = h.engine.createRun({ name: "Human first", brief: "x", portfolio: five(), slots: CHEAP, limits: { concurrency } });
  await h.engine.startRun(runId);
  return runId;
}

test("telling the lead of an app still in Intake starts the app and the lead, with the message in its first prompt", async () => {
  const h = await createHarness();
  const runId = await startedRun(h, 4);
  const waiting = h.repo.listApps(runId).find((a) => a.stage === "intake");
  assert.ok(waiting, "an app waits in Intake");
  const lead = h.engine.leadOf(runId, waiting.id)!;
  assert.equal(lead.status, "planned");
  await createDirective(h.engine, runId, { type: "tell", target: lead.id, text: "Start on the onboarding flow today" });
  assert.equal(h.repo.getApp(runId, waiting.id)!.stage, "spec", "the app was admitted");
  await h.clock.runUntil(h.clock.now() + 3600_000, { stopWhen: () => !!h.repo.getNode(runId, lead.id)?.threadId });
  const n = h.repo.getNode(runId, lead.id)!;
  assert.ok(n.threadId, "the lead was started");
  assert.match(h.sim.threadOf(lead.id, runId)?.firstPrompt ?? "", /Start on the onboarding flow today/);
});

test("a builder that already reported done is woken by the human's message", async () => {
  const h = await createHarness();
  const runId = await startedRun(h, 48);
  const ui = h.repo.listNodes(runId).find((x) => x.role === "ui")!;
  await h.clock.runUntil(h.clock.now() + 6 * 3600_000, { stopWhen: () => !!h.repo.getNode(runId, ui.id)?.threadId });
  h.repo.updateNode(runId, ui.id, { status: "done", endedAt: h.clock.now() });
  const d = await createDirective(h.engine, runId, { type: "tell", target: ui.id, text: "Redo the settings screen in dark mode" });
  assert.equal(h.repo.getNode(runId, ui.id)!.status, "waiting");
  assert.ok(h.repo.outboxForRun(runId).some((o) => o.kind === "send" && o.idemKey === `${d.id}:${ui.id}`), "the message is sent, not filed");
});

test("supervisors owe no reply to the human's FYI, and a message typed in the agent's thread owes no ack", async () => {
  const h = await createHarness();
  const runId = await startedRun(h, 48);
  const ui = h.repo.listNodes(runId).find((x) => x.role === "ui")!;
  await h.clock.runUntil(h.clock.now() + 6 * 3600_000, { stopWhen: () => !!h.repo.getNode(runId, ui.id)?.threadId });
  const lead = h.repo.getNode(runId, ui.parentId!)!;
  const d = await createDirective(h.engine, runId, { type: "tell", target: ui.id, text: "Use the warmer palette" });
  assert.match(ack(h.engine, lead, d.id, "noted"), /No reply needed/);
  assert.notEqual(h.repo.recipients(runId, d.id).find((r) => r.nodeId === lead.id)!.state, "ack");
  assert.deepEqual(h.repo.unackedFor(runId, ui.id).map((r) => r.directiveId), [d.id], "the agent told still acks");
  const typed = await createDirective(h.engine, runId, { type: "tell", target: ui.id, text: "also tighten the spacing", implicit: true, mode: "queue" });
  assert.ok(!h.repo.unackedFor(runId, ui.id).some((r) => r.directiveId === typed.id));
});

test("every agent's instructions put the human first and forbid supervisors from gating the human's word", () => {
  for (const role of ["lead", "ui", "review", "mgr", "orch"] as const) {
    const s = instructionsFor({ role, platform: null, nodeId: "x", parentLabel: "Parent", skills: ["helm-lead"], alsoLead: false });
    assert.match(s, /the human comes first: when the human tells you something .* do it now without asking any supervisor/);
    assert.match(s, /Follow the helm-lead skill\./, "the system prompt still fits");
  }
  const rules = COMMON_RULES.join("\n");
  assert.match(rules, /needs nobody's approval: do not ask your supervisor first/);
  assert.match(rules, /never tell agents that the human's instructions must come through you or need your go-ahead/);
  assert.match(rules, /Another agent writing "the human wants…" is that agent's direction, not the human's/);
});
