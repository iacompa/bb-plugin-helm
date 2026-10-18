// `bb helm` and Needs-you from the terminal: approve/deny act only on what they can act on (a
// budget or failed card used to be closed with nothing done), every item prints the command for
// each of its choices, `resolve` runs the panel's buttons, and sign-off says what git will do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP } from "../helpers/harness.ts";
import { HelmService } from "../../src/server/service.ts";
import { buildCli } from "../../src/server/cli.ts";
import { parseBrief, SAMPLE_BRIEF } from "../../src/server/domain/brief.ts";

async function setup() {
  const h = await createHarness();
  const p = parseBrief(SAMPLE_BRIEF).portfolio;
  const { runId } = h.engine.createRun({ name: "Cli", brief: "x", portfolio: { ...p, apps: p.apps.slice(0, 2).map((a) => ({ ...a, group: null })) }, slots: CHEAP, limits: { concurrency: 8 } });
  await h.engine.startRun(runId);
  const svc = new HelmService(h.engine);
  const cli = buildCli(svc, { doctor: async () => ({ ok: true, lines: [], checks: [] }) });
  const run = async (...argv: string[]) => {
    const r = await cli.run([...argv, "--run", runId], { cwd: process.cwd() } as never);
    return { ...r, text: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };
  return { h, runId, svc, run };
}

test("approve refuses a budget card and names the commands that act on it; resolve does", async () => {
  const { h, runId, run } = await setup();
  const need = h.repo.tx(() => h.engine.raiseNeed(runId, { kind: "budget", nodeId: null, appId: null, title: "Budget cap reached", body: "Spend 2500 u of 2500 u.", evidence: "", options: ["Raise cap", "Keep paused", "Stop run"] }))!;
  h.repo.updateRun(runId, { spawnsPaused: true });

  const a = await run("approve", need.id, "--json");
  assert.notEqual(a.exitCode, 0);
  assert.match(a.text, /"code": "invalid_value"/);
  assert.match(a.text, new RegExp(`${need.id} is a budget item; approve does not act on it`));
  assert.match(a.text, new RegExp(`bb helm resolve ${need.id} raise-cap --value <units>`));
  assert.equal(h.repo.getNeed(runId, need.id)!.state, "open", "the card stays open");

  const list = await run("needs");
  assert.match(list.text, new RegExp(`${need.id}  \\[budget\\]  Budget cap reached`));
  assert.match(list.text, new RegExp(`→ bb helm resolve ${need.id} keep-paused`));

  const stop = await run("resolve", need.id, "stop-run", "--json");
  assert.match(stop.text, /"code": "confirmation_required"/);
  assert.equal(h.engine.run(runId).status, "running");

  const wrong = await run("resolve", need.id, "retry", "--json");
  assert.match(wrong.text, /takes: raise-cap, keep-paused, stop-run/);

  const raised = await run("resolve", need.id, "raise-cap", "--value", "4000");
  assert.equal(raised.exitCode, 0, raised.text);
  assert.equal(h.engine.run(runId).budgetCap, 4000);
  assert.equal(h.engine.run(runId).spawnsPaused, false);
  assert.equal(h.repo.getNeed(runId, need.id)!.state, "resolved");
  // a second try says it is already done instead of failing
  const again = await run("approve", need.id);
  assert.equal(again.exitCode, 0);
  assert.match(again.text, new RegExp(`${need.id} was already resolved \\(raise_cap\\)`));
});

test("a failed card is retried through resolve and closes; nodes lists every agent id", async () => {
  const { h, runId, run } = await setup();
  const orch = h.repo.getNode(runId, "orch")!;
  const need = h.repo.tx(() => h.engine.raiseNeed(runId, { kind: "failed", nodeId: orch.id, appId: null, title: "Orchestrator failed", body: "Provider error.", evidence: "", options: ["Retry", "Change model", "Stop"] }))!;
  const d = await run("deny", need.id);
  assert.notEqual(d.exitCode, 0);
  assert.match(d.text, new RegExp(`bb helm resolve ${need.id} retry`));
  const r = await run("resolve", need.id, "retry");
  assert.equal(r.exitCode, 0, r.text);
  assert.match(r.text, new RegExp(`${need.id}: retry done \\(D-\\d{4}`));
  assert.equal(h.repo.getNeed(runId, need.id)!.state, "resolved");

  const nodes = await run("nodes");
  assert.match(nodes.text, /^orch\s+\S+\s+Orchestrator/m);
  assert.match(nodes.text, /planner/);
  const unknown = await run("tell", "nobody", "--message-file", "x.md", "--json");
  assert.notEqual(unknown.exitCode, 0);
});

test("sign-off says what the Git agent does with the work, per the setting", async () => {
  const { h, runId, run } = await setup();
  const app = h.repo.listApps(runId)[0];
  h.repo.updateApp(runId, app.id, { stage: "ready" });
  h.settings.gitOnSignoff = "push";
  const need = h.repo.tx(() => h.engine.raiseNeed(runId, { kind: "signoff", nodeId: h.engine.leadOf(runId, app.id)?.id ?? null, appId: app.id, title: `${app.name} is ready for sign-off`, body: "Reviewer: pass\nSlop Hunter: pass\nChecks green on abc1234: build, test\nResult: …", evidence: "Unverified: Android build not verified on this machine", options: ["Sign off", "Send back"] }))!;
  const list = await run("needs");
  assert.match(list.text, /Checks green on abc1234/, "a sign-off card prints its whole body");
  assert.match(list.text, /Evidence: Unverified: Android build/);
  assert.match(list.text, new RegExp(`→ bb helm signoff ${app.name}`));
  const ap = await run("approve", need.id, "--json");
  assert.match(ap.text, /is a signoff item; approve does not act on it/);
  const s = await run("signoff", app.name);
  assert.equal(s.exitCode, 0, s.text);
  assert.match(s.text, new RegExp(`${app.name} is signed off\\. The Git agent now pushes its work branch; main is left for you to merge\\.`));
});

test("an agent Helm runs may read with bb helm but not decide: approve, limits and end refuse it; the human's own threads may", async () => {
  const { h, runId, svc } = await setup();
  const cli = buildCli(svc, { doctor: async () => ({ ok: true, lines: [], checks: [] }) });
  await h.clock.runUntil(h.clock.now() + 3600_000, { stopWhen: () => !!h.repo.getNode(runId, "orch")?.threadId });
  const agentThread = h.repo.getNode(runId, "orch")!.threadId!;
  const need = h.repo.tx(() => h.engine.raiseNeed(runId, { kind: "approval", nodeId: null, appId: null, title: "Run a command", body: "x", evidence: "", options: ["Approve", "Deny"] }))!;
  const as = async (threadId: string | undefined, ...argv: string[]) => {
    const r = await cli.run([...argv, "--run", runId], { cwd: process.cwd(), threadId } as never);
    return { ...r, text: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };
  for (const argv of [["approve", need.id], ["limits", "--budget", "99999"], ["end", "--yes"]]) {
    const r = await as(agentThread, ...argv, "--json");
    assert.notEqual(r.exitCode, 0, argv.join(" "));
    assert.match(r.text, /"code": "forbidden"/);
  }
  assert.equal(h.repo.getNeed(runId, need.id)!.state, "open");
  assert.equal((await as(agentThread, "status")).exitCode, 0, "reading is fine");
  // the human's own assistant thread (not one Helm runs) and the terminal (no thread) decide
  assert.equal((await as("thr_human_assistant", "approve", need.id)).exitCode, 0);
});
