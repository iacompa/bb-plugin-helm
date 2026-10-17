import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP, type Harness } from "../helpers/harness.ts";
import { callTool } from "../../src/server/agent/tools.ts";
import { instructionsFor } from "../../src/server/domain/briefs.ts";
import { parseBrief, SAMPLE_BRIEF } from "../../src/server/domain/brief.ts";
import { skillsFor } from "../../src/server/domain/roles.ts";
import { getTask } from "../../src/server/engine/tasks.ts";

const H = 3600_000;
const one = { apps: [{ name: "Alpha", tagline: "t", platforms: ["ios"] }], groups: [], assumptions: [], questions: [] };

async function until(h: Harness, runId: string, nodeId: string) {
  await h.clock.runUntil(h.clock.now() + 6 * H, { stopWhen: () => !!h.repo.getNode(runId, nodeId)?.threadId });
  const t = h.repo.getNode(runId, nodeId)?.threadId;
  assert.ok(t, `${nodeId} should have a thread`);
  return t!;
}

test("each builder loads its craft skill next to the protocol skill; a solo lead gets its platforms' skills", () => {
  assert.deepEqual(skillsFor({ role: "ui", platform: null, alsoLead: false }, null), ["helm-specialist", "helm-ui"]);
  assert.deepEqual(skillsFor({ role: "platform", platform: "ios", alsoLead: false }, null), ["helm-specialist", "helm-ios"]);
  assert.deepEqual(skillsFor({ role: "platform", platform: "and", alsoLead: false }, null), ["helm-specialist", "helm-android"]);
  assert.deepEqual(skillsFor({ role: "slop", platform: null, alsoLead: false } as never, null), ["helm-slop-hunter"]);
  assert.deepEqual(skillsFor({ role: "lead", platform: null, alsoLead: false }, { shape: "solo", platforms: ["mac", "win"] }), ["helm-lead", "helm-macos", "helm-windows"]);
  assert.deepEqual(skillsFor({ role: "lead", platform: null, alsoLead: false }, { shape: "full", platforms: ["ios"] }), ["helm-lead"]);
});

test("the system prompt names every skill and carries the tailored task, within 4,000 chars", () => {
  const s = instructionsFor({ role: "platform", platform: "ios", nodeId: "a.p.ios", parentLabel: "Alpha · App lead", skills: ["helm-specialist", "helm-ios"], alsoLead: false, task: { text: "Build the onboarding flow. ".repeat(300), byLabel: "Alpha · App lead" } });
  assert.match(s, /the helm-specialist skill and the helm-ios skill/);
  assert.match(s, /Your task, written for you by Alpha · App lead/);
  assert.ok(s.length <= 4000);
});

test("a lead writes a squad member's task before it starts: it is in the member's first prompt; others' agents are refused", async () => {
  const h = await createHarness();
  const { runId } = h.engine.createRun({ name: "T", brief: "x", portfolio: one as never, slots: CHEAP, limits: { concurrency: 48 } });
  assert.deepEqual((await h.engine.startRun(runId)).problems, []);
  const app = h.repo.listApps(runId)[0];
  const lead = h.engine.leadOf(runId, app.id)!;
  const leadThread = await until(h, runId, lead.id);
  const ui = h.repo.listNodes(runId).find((n) => n.role === "ui")!;

  const r = await callTool(h.engine, "helm_set_task", leadThread, { nodeId: ui.id, task: "Own the onboarding screens (OnboardingView, PermissionsView). Use tokens from CONTRACT §3. Done = all five states in both themes, screenshots in reports/ui/." });
  assert.match(r.text, /starts with it/);
  const uiThread = await until(h, runId, ui.id);
  const t = h.sim.helmThreads().find((x) => x.id === uiThread)!;
  assert.match(t.firstPrompt ?? "", new RegExp(`## Your task \\(from ${h.engine.label(lead)}[\\s\\S]*OnboardingView`));

  // a builder cannot write tasks, and nobody writes one for their supervisor
  assert.equal((await callTool(h.engine, "helm_set_task", uiThread, { nodeId: lead.id, task: "x" })).isError, true);
  const up = await callTool(h.engine, "helm_set_task", leadThread, { nodeId: "orch", task: "x" });
  assert.match(up.text, /not in your org/);

  // replacing the task of a running agent tells it and rewrites its brief
  const sent: string[] = [];
  const orig = h.sim.sendMessage.bind(h.sim);
  h.sim.sendMessage = async (a) => (sent.push(a.text), orig(a));
  const again = await callTool(h.engine, "helm_set_task", leadThread, { nodeId: ui.id, task: "Drop PermissionsView; ship OnboardingView first." });
  assert.match(again.text, /it was told/);
  assert.equal(getTask(h.engine, runId, ui.id)?.text, "Drop PermissionsView; ship OnboardingView first.");
  await h.clock.advance(60_000);
  assert.ok(sent.some((x) => x.includes("Drop PermissionsView")), "the running agent is told");
});

test("a manager sees only its own apps: no other managers as peers, a scope fence, and no tasks for another manager's leads", async () => {
  const h = await createHarness();
  const { runId } = h.engine.createRun({ name: "M", brief: "x", portfolio: parseBrief(SAMPLE_BRIEF).portfolio, slots: CHEAP, limits: { concurrency: 48 } });
  assert.deepEqual((await h.engine.startRun(runId)).problems, []);
  const mgrs = h.repo.listNodes(runId).filter((n) => n.tier === "manager");
  assert.ok(mgrs.length >= 2, "the sample brief has several managers");
  const [a, b] = mgrs;
  const brief = h.engine.buildBrief(h.repo.getRun(runId)!, a);
  assert.match(brief, /Peers: none/);
  assert.ok(!brief.includes(h.engine.label(b)), "the other manager is not named");
  assert.match(brief, /## Your scope\nYou manage only these apps: /);

  const aThread = await until(h, runId, a.id);
  const theirLead = h.repo.listNodes(runId).find((n) => n.tier === "lead" && n.parentId === b.id)!;
  const ownLead = h.repo.listNodes(runId).find((n) => n.tier === "lead" && n.parentId === a.id)!;
  assert.match((await callTool(h.engine, "helm_set_task", aThread, { nodeId: theirLead.id, task: "x" })).text, /not in your org/);
  assert.match((await callTool(h.engine, "helm_set_task", aThread, { nodeId: ownLead.id, task: "Ship the iOS app before the Android one." })).text, /Task set/);
});

test("every skill an agent can be given ships with the plugin, with matching frontmatter, under the size budget", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const { ROLES, craftSkill, PLATFORM_ORDER } = await import("../../src/server/domain/roles.ts");
  const names = new Set<string>(["helm", "helm-planner", "helm-lead"]);
  for (const r of Object.values(ROLES)) {
    names.add(r.skill);
    for (const p of r.role === "platform" ? PLATFORM_ORDER : [null]) {
      const c = craftSkill(r.role, p);
      if (c) names.add(c);
    }
  }
  for (const n of names) {
    const path = new URL(`../../skills/${n}/SKILL.md`, import.meta.url);
    assert.ok(existsSync(path), `skills/${n}/SKILL.md ships`);
    const text = readFileSync(path, "utf8");
    assert.match(text, new RegExp(`^---\\nname: ${n}\\ndescription: .+\\n---\\n`), `${n} frontmatter`);
    // ≈ 10,000 tokens at ~4 chars a token
    assert.ok(text.length < 40_000, `${n} is ${text.length} chars`);
  }
});
