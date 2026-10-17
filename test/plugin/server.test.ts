import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import plugin from "../../server.ts";
import { SAMPLE_BRIEF } from "../../src/server/domain/brief.ts";
import { SIM_CATALOG } from "../../src/server/bb/sim.ts";
import { RPC } from "../../src/shared/protocol.ts";

function host() {
  const dir = mkdtempSync(join(tmpdir(), "helm-plugin-"));
  const providers = SIM_CATALOG.providers.map((p) => ({ id: p.id, displayName: p.label, available: true, serviceTiers: [] }));
  const h = createFakePluginHost({
    pluginId: "helm",
    dataDir: dir,
    // the real skill folders, so configure() is checked against what BB will actually load (V12)
    agentSkillIds: readdirSync(new URL("../../skills/", import.meta.url)).filter((n) => !n.startsWith(".")),
    experimental_hostEntry: true,
    experimental_callHostRpc: (call: { method: string }) => {
      if (call.method === "probe") return { platform: "darwin", home: "/Users/test", git: "git version 2.50.0", xcode: null, swift: null, gradle: null, androidSdk: false, dotnet: null };
      throw new Error(`unexpected host call ${call.method}`);
    },
    sdk: {
      system: { config: async () => ({ primaryHostId: "host_1", primaryHostPlatform: "darwin" }) },
      providers: {
        list: async () => providers,
        models: async (args: { providerId: string }) => ({
          models: SIM_CATALOG.models.filter((m) => m.providerId === args.providerId).map((m) => ({ id: m.id, model: m.id, displayName: m.displayName, description: m.description, isDefault: m.isDefault, defaultReasoningEffort: m.defaultReasoning, supportedReasoningEfforts: m.reasoning.map((r) => ({ reasoningEffort: r, description: r })) })),
          selectedOnlyModels: [],
          providers,
          permissionCeiling: "full",
          modelLoadError: null,
        }),
      },
      threads: { count: async () => ({ total: 3 }) },
    } as never,
  });
  return { ...h, dir };
}

test("the plugin factory registers 21 tools, the CLI, RPC, the dispatch hook, the engine service and the watchdog", async () => {
  const h = host();
  await plugin(h.bb);
  const reg = h.harness.inspection.registrations;
  assert.equal(reg.agentTools.length, 21);
  // every method of the RPC contract has a handler, and nothing else is registered
  assert.deepEqual([...reg.rpcMethods].sort(), Object.keys(RPC).sort());
  assert.ok(reg.services.some((x) => JSON.stringify(x).includes("engine")), JSON.stringify(reg.services));
  assert.ok(reg.schedules.some((x) => JSON.stringify(x).includes("watchdog")));
  assert.equal(typeof reg.hooks["message.dispatch"], "function");
  assert.ok(reg.cli);
  assert.equal(reg.threadEventHandlers["thread.idle"], 1);
  await h.harness.lifecycle.dispose();
});

test("bb helm plan creates a 169-agent plan from a brief file; start without --yes asks first; --json errors carry the envelope", async () => {
  const h = host();
  await plugin(h.bb);
  const brief = join(h.dir, "brief.md");
  writeFileSync(brief, SAMPLE_BRIEF);
  const r = await h.harness.behavior.runCli(["plan", "--brief-file", brief, "--preset", "Cheap dev run"]);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stdout, /20 apps · 5 managers · 20 leads · 103 specialists · 40 gates · 169 agents/);
  const runId = r.stdout.match(/Plan (run_\w+)/)![1];
  const s = await h.harness.behavior.runCli(["start", runId, "--json"]);
  assert.notEqual(s.exitCode, 0);
  assert.match(s.stdout, /"code": "confirmation_required"/);
  const st = await h.harness.behavior.runCli(["status"]);
  assert.match(st.stdout, /planning/);
  const unknown = await h.harness.behavior.runCli(["tell", "nobody", "--message-file", brief, "--json"]);
  assert.notEqual(unknown.exitCode, 0);
  assert.match(unknown.stdout, /"ok": false/);
  await h.harness.lifecycle.dispose();
});

test("bb helm doctor reports host, catalog, database, tools and hook without spawning", async () => {
  const h = host();
  await plugin(h.bb);
  const r = await h.harness.behavior.runCli(["doctor"]);
  assert.match(r.stdout, /✓ host.entry/);
  assert.match(r.stdout, /✓ catalog/);
  assert.match(r.stdout, /✓ database/);
  assert.match(r.stdout, /✓ agent.tools\s+21/);
  assert.equal(r.exitCode, 0, r.stdout);
  assert.equal(h.harness.inspection.sdk.callsTo("threads.spawn").length, 0);
  await h.harness.lifecycle.dispose();
});

test("agents.configure gives a non-Helm thread no Helm tools, only the helm CLI skill", async () => {
  const h = host();
  await plugin(h.bb);
  const cfg = await h.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({}));
  assert.deepEqual(cfg.tools, []);
  assert.deepEqual(cfg.skills, ["helm", "helm-planner"]);
  const tool = await h.harness.behavior.callAgentTool("helm_world", {}, { threadId: "thr_foreign" });
  assert.match(JSON.stringify(tool), /not a Helm agent/);
  await h.harness.lifecycle.dispose();
});

test("V12: spoofed helm metadata gets no tool list and no tool authority", async () => {
  const h = host();
  await plugin(h.bb);
  const brief = join(h.dir, "brief.md");
  writeFileSync(brief, SAMPLE_BRIEF);
  const r = await h.harness.behavior.runCli(["plan", "--brief-file", brief, "--preset", "Cheap dev run"]);
  const runId = r.stdout.match(/Plan (run_\w+)/)![1];
  // a thread writes metadata claiming to be the (planned, unspawned) Orchestrator
  const spoof = { v: 1, runId, nodeId: "orch", tier: "orch", role: "orch", key: `${runId}:root:orch` };
  const cfg = await h.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ pluginMetadata: { helm: spoof }, thread: { id: "thr_spoof", title: null, parentThreadId: null, sourceThreadId: null } } as never));
  assert.deepEqual(cfg.tools, [], "a planned node's spawn is not in flight: no hint");
  const other = await h.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ pluginMetadata: { helm: spoof }, origin: { kind: null, pluginId: "someone-else" } } as never));
  assert.deepEqual(other.tools, []);
  // authority comes from the nodes row for the calling thread, never from metadata or arguments
  const tool = await h.harness.behavior.callAgentTool("helm_world", {}, { threadId: "thr_spoof", pluginMetadata: { helm: spoof } } as never);
  assert.match(JSON.stringify(tool), /not a Helm agent/);
  await h.harness.lifecycle.dispose();
});
