// BB rejects an RPC result that is not plain JSON (an undefined value anywhere fails the
// whole call). Every read the UI makes is checked here against a started run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP } from "../helpers/harness.ts";
import { HelmService } from "../../src/server/service.ts";
import { registerRpc } from "../../src/server/rpc.ts";
import { parseBrief, SAMPLE_BRIEF } from "../../src/server/domain/brief.ts";

function nonJson(v: unknown, path = "$result"): string | null {
  if (v === undefined) return `${path} is undefined`;
  if (v === null || typeof v === "string" || typeof v === "boolean") return null;
  if (typeof v === "number") return Number.isFinite(v) ? null : `${path} is ${v}`;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const p = nonJson(v[i], `${path}[${i}]`);
      if (p) return p;
    }
    return null;
  }
  if (typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const p = nonJson(x, `${path}.${k}`);
      if (p) return p;
    }
    return null;
  }
  return `${path} is a ${typeof v}`;
}

test("every read RPC returns plain JSON for a run with fewer than 30 apps", async () => {
  const h = await createHarness();
  const p = parseBrief(SAMPLE_BRIEF).portfolio;
  const { runId } = h.engine.createRun({ name: "Json", brief: "x", portfolio: { ...p, apps: p.apps.slice(0, 5) }, slots: CHEAP, limits: { concurrency: 48 } });
  await h.engine.startRun(runId);
  await h.clock.advance(30 * 60_000);
  let handlers: Record<string, (input: Record<string, unknown>) => unknown> = {};
  const fakeBb = { rpc: { register: (_c: unknown, hs: typeof handlers) => (handlers = hs) } };
  registerRpc(fakeBb as never, new HelmService(h.engine));
  const node = h.repo.listNodes(runId).find((n) => n.threadId)!;
  const app = h.repo.listApps(runId)[0];
  const calls: Array<[string, Record<string, unknown>]> = [
    ["run_list", {}],
    ["run_get", { runId }],
    ["world_get", { runId }],
    ["node_get", { runId, nodeId: node.id }],
    ["app_get", { runId, appId: app.id }],
    ["ledger_list", { runId, limit: 50 }],
  ];
  for (const [name, input] of calls) {
    assert.ok(handlers[name], `${name} is registered`);
    const out = await handlers[name](input);
    assert.equal(nonJson(out), null, `${name}: ${nonJson(out)}`);
  }
});
