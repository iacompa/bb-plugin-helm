// The error journal and request checks: every failure is recorded where `bb helm errors`
// can show it, request contents are never stored, and a bad request names its field.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP } from "../helpers/harness.ts";
import { HelmService } from "../../src/server/service.ts";
import { registerRpc } from "../../src/server/rpc.ts";
import { journaledHandlers, errorsText, inputShape, type RpcHandler } from "../../src/server/journal.ts";
import { callTool } from "../../src/server/agent/tools.ts";
import { requestProblem, readableRpcError } from "../../components/helm/rpccheck.ts";
import { RPC_SCHEMAS, TEXT_MAX } from "../../src/shared/rpc-schemas.ts";
import { planChatPrompt } from "../../src/server/engine/planner.ts";
import { parseBrief, SAMPLE_BRIEF } from "../../src/server/domain/brief.ts";

const MODEL = { providerId: "claude-code", modelId: "claude-opus-5-5", reasoning: "high" };

test("a long planning text is accepted and reaches the planner in full", () => {
  const long = `IA contract\n${"x".repeat(30_000)}\nEND-OF-CONTRACT`;
  assert.equal(requestProblem("planchat_start", { model: MODEL, text: long }), null);
  assert.equal(requestProblem("run_create", { brief: long, limits: {} }), null);
  assert.match(planChatPrompt(long), /END-OF-CONTRACT/);
});

test("a request over a limit names the field and the numbers instead of 'rpc input validation failed'", () => {
  const tooLong = "y".repeat(TEXT_MAX + 5);
  assert.match(requestProblem("planchat_start", { model: MODEL, text: tooLong })!, /^The text is 200,005 characters; Helm accepts up to 200,000\./);
  assert.match(requestProblem("run_get", {})!, /run id/i);
  assert.equal(requestProblem("planchat_start", { model: { providerId: "codex", modelId: "gpt-5" }, text: "hi" }), null, "a model without a reasoning level is fine");
  assert.match(readableRpcError("planchat_start", "HTTP 400: rpc input validation failed"), /bb helm errors/);
});

test("RPC failures are journaled with the input's shape only; refused requests are 'user', crashes are 'error'", async () => {
  const h = await createHarness();
  let handlers: Record<string, RpcHandler> = {};
  registerRpc({ rpc: { register: (_c: unknown, hs: Record<string, RpcHandler>) => (handlers = journaledHandlers(hs, h.repo)) } } as never, new HelmService(h.engine));
  await assert.rejects(() => Promise.resolve(handlers.run_get({ runId: "run_missing" }, {})));
  const secret = "sk-live-NEVER-STORE-THIS";
  const boom = journaledHandlers({ x: () => { throw new Error("kaput"); } }, h.repo);
  await assert.rejects(() => Promise.resolve(boom.x({ brief: secret }, {})));
  const all = h.repo.listErrors();
  assert.equal(all[0].level, "error");
  assert.equal(all[0].at, "x");
  assert.match(all[0].detail!, /"brief":"string\(24\)"/);
  assert.ok(!JSON.stringify(all).includes(secret), "request contents are never stored");
  assert.ok(all.some((e) => e.at === "run_get" && e.level === "user" && e.runId === "run_missing"));
  // the panel reports its own failures through client_error
  await handlers.client_error({ level: "error", at: "panel crash", message: "Cannot read properties of undefined", detail: "at Graph" }, {});
  assert.equal(h.repo.listErrors({ limit: 1 })[0].source, "ui");
  const text = errorsText(h.repo.listErrors(), h.repo.countErrors(0), "last 24 h");
  assert.match(text, /2 errors · 0 warnings · 1 refused requests/);
  assert.match(text, /ui\/panel crash/);
  assert.equal(inputShape({ a: [1, 2], b: null, c: "abc" }), '{"a":"array(2)","b":"null","c":"string(3)"}');
});

test("agent tool refusals are journaled so agent behaviour can be debugged", async () => {
  const h = await createHarness();
  const p = parseBrief(SAMPLE_BRIEF).portfolio;
  const { runId } = h.engine.createRun({ name: "J", brief: "x", portfolio: { ...p, apps: p.apps.slice(0, 2) }, slots: CHEAP, limits: { concurrency: 48 } });
  await h.engine.startRun(runId);
  await h.clock.advance(20 * 60_000);
  const lead = h.repo.listNodes(runId).find((n) => n.tier === "lead" && n.threadId)!;
  await callTool(h.engine, "helm_direct", lead.threadId!, { to: "orch", action: "pause" });
  const e = h.repo.listErrors({ level: "user" }).find((x) => x.source === "tool");
  assert.ok(e, "the refusal is journaled");
  assert.match(e!.at, new RegExp(`^helm_direct by ${lead.id.replace(".", "\\.")}$`));
  assert.match(e!.message, /not below you/);
});

test("the wizard's portfolio keeps kind, needs, tools and all five platforms through the request schema", () => {
  const app = { name: "Ledgerly", tagline: "Clinic billing", platforms: ["mac", "win", "ios", "and", "web"], platformsAssumed: false, kind: "web", needs: ["hipaa", "payments"], tools: ["plugin:browser-automation"] };
  const req = { brief: "x", portfolio: { apps: [app], groups: [], assumptions: [], questions: [] } };
  assert.equal(requestProblem("run_create", req), null);
  assert.equal(requestProblem("plan_preview", { portfolio: req.portfolio }), null);
  // zod drops keys a schema does not name: the human's corrections must survive parsing
  const parsed = RPC_SCHEMAS.run_create.input.parse(req) as { portfolio: { apps: Array<Record<string, unknown>> } };
  for (const k of ["kind", "needs", "tools", "platformsAssumed", "platforms"]) assert.deepEqual(parsed.portfolio.apps[0][k], app[k as keyof typeof app], k);
  assert.match(requestProblem("run_create", { ...req, portfolio: { ...req.portfolio, apps: [{ ...app, kind: "spaceship" }] } })!, /expected one of "app"/);
});
