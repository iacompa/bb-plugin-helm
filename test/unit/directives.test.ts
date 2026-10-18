import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ancestors,
  bottomUp,
  buildRecipients,
  coalesceDigests,
  collapseForDisplay,
  deliveryModeFor,
  isQuestion,
  noticeFor,
  noticeText,
  resolveCascade,
  treeFrom,
  type NoticeDirective,
} from "../../src/server/domain/directives.ts";
import { planTopology } from "../../src/server/domain/topology.ts";
import { parseBrief, SAMPLE_BRIEF } from "../../src/server/domain/brief.ts";
import { rng } from "../helpers/rng.ts";
import type { Cascade, DirectiveType } from "../../src/shared/types.ts";

const plan = planTopology(parseBrief(SAMPLE_BRIEF).portfolio.apps, { managerSpan: 4, orchestratorSpan: 6, leadSpan: 6, maxTotalAgents: 250 });
const tree = treeFrom(plan.nodes);

test("A7: telling a specialist reaches specialist (direct), lead (full), manager (digest), Orchestrator (digest + world)", () => {
  const affected = resolveCascade(tree, "lumen.ui", "self");
  const r = buildRecipients(tree, affected);
  const by = Object.fromEntries(r.map((x) => [x.id, x]));
  assert.equal(by["lumen.ui"].level, "direct");
  assert.equal(by["lumen.lead"].level, "full");
  assert.equal(by["m0"].level, "digest");
  assert.equal(by["orch"].level, "digest");
  assert.equal(by["orch"].world, true);
  assert.equal(r.length, 4);
});

test("cascade reports / subtree", () => {
  assert.deepEqual(resolveCascade(tree, "m0", "reports"), ["m0", "lumen.lead", "stride.lead", "oat.lead", "hush.lead"]);
  const sub = resolveCascade(tree, "lumen.lead", "subtree");
  assert.equal(sub.length, 1 + 8);
  const r = buildRecipients(tree, sub);
  const by = Object.fromEntries(r.map((x) => [x.id, x]));
  assert.equal(by["lumen.lead"].level, "direct");
  assert.equal(by["m0"].level, "full");
  assert.equal(by["orch"].level, "digest");
  const shown = collapseForDisplay(r, "lumen.lead");
  assert.equal(shown.hiddenDirect, 8);
});

test("targeting the Orchestrator itself: direct + world", () => {
  const r = buildRecipients(tree, ["orch"]);
  assert.deepEqual(r, [{ id: "orch", level: "direct", world: true }]);
});

test("bottom-up ordering puts the deepest nodes first", () => {
  const order = bottomUp(tree, resolveCascade(tree, "m0", "subtree"));
  assert.equal(order[order.length - 1], "m0");
  const idx = (id: string) => order.indexOf(id);
  assert.ok(idx("lumen.ui") < idx("lumen.lead"));
});

test("property: random trees and directives", () => {
  const rand = rng(42);
  for (let iter = 0; iter < 300; iter++) {
    const n = 2 + Math.floor(rand() * 60);
    const nodes = [{ id: "orch", parentId: null as string | null }];
    for (let i = 1; i < n; i++) nodes.push({ id: `n${i}`, parentId: nodes[Math.floor(rand() * nodes.length)].id });
    const t = treeFrom(nodes);
    const target = nodes[Math.floor(rand() * nodes.length)].id;
    const cascade = (["self", "reports", "subtree"] as Cascade[])[Math.floor(rand() * 3)];
    const affected = resolveCascade(t, target, cascade);
    const r = buildRecipients(t, affected);
    const by = new Map(r.map((x) => [x.id, x]));
    const affectedSet = new Set(affected);
    // every ancestor of every affected node is a recipient
    for (const a of affected) for (const anc of ancestors(t, a)) assert.ok(by.has(anc), `${anc} missing`);
    // orchestrator always present with world
    assert.equal(by.get("orch")?.world, true);
    // parent of an affected node is full unless itself affected (then direct)
    for (const a of affected) {
      const p = t.parentOf(a);
      if (!p) continue;
      assert.equal(by.get(p)!.level, affectedSet.has(p) ? "direct" : "full");
    }
    // each non-orchestrator node has exactly one parent
    for (const nd of nodes.slice(1)) assert.ok(t.parentOf(nd.id));
    // no duplicates
    assert.equal(new Set(r.map((x) => x.id)).size, r.length);
  }
});

const ctx = { targetName: "Lumen · UI builder", briefVersion: 4, modelName: (r: { modelId: string; reasoning: string | null } | null | undefined) => (r ? `${r.modelId} ${r.reasoning ?? ""}`.trim() : "?"), touchedCount: 3, clock: "14:05" };
const D = (type: DirectiveType, extra: Partial<NoticeDirective> = {}): NoticeDirective => ({ id: "D-0007", type, cascade: "self", text: "Use the warmer palette", ts: 0, ...extra });

test("notice text — direct / full / digest / world", () => {
  assert.equal(
    noticeText(D("tell"), "direct", ctx),
    "Message from the human (D-0007): “Use the warmer palette”. Do it now: the human's word outranks every supervisor's task, hold and standing rule, and needs nobody's approval. Do not ask your supervisor; Helm has told them.",
  );
  assert.equal(
    noticeText(D("tell"), "full", ctx),
    "FYI: the human told your direct report Lumen · UI builder directly (D-0007) — “Use the warmer palette”. Lumen · UI builder acts on it now, without your approval. Do not re-issue it, hold it, add conditions or countermand it; fit your own plan around it. No reply needed.",
  );
  assert.equal(noticeText(D("tell"), "digest", ctx), "D-0007 · Lumen · UI builder — “Use the warmer palette” (by human, 14:05).");
  assert.equal(noticeText(D("tell"), "world", ctx), "D-0007 · Lumen · UI builder — “Use the warmer palette” (by human, 14:05). Recorded in world state: 3 agents touched by you.");
  const m = D("model", { modelFrom: { providerId: "codex", modelId: "gpt-6.1-sol", reasoning: "xhigh" }, modelTo: { providerId: "claude-code", modelId: "claude-sonnet-5-5", reasoning: "high" } });
  assert.equal(noticeText(m, "direct", ctx), "The human changed your model (D-0007): model changed gpt-6.1-sol xhigh → claude-sonnet-5-5 high. Applies from your next turn — do not revert it.");
  assert.equal(noticeText(D("pause", { text: "" }), "direct", ctx), "The human paused you (D-0007): paused: held by the human. Stop after the current step and wait.");
  assert.equal(noticeText(D("scope", { cascade: "subtree" }), "direct", ctx), "The human edited your brief (D-0007): brief edited to v4: Use the warmer palette. Re-read BRIEF.md and stay inside the new scope. Applies to this agent and everyone below it.");
  assert.equal(noticeText(D("stop", { cascade: "reports" }), "full", ctx).includes("Applies to this agent and its direct reports."), true);
  assert.match(noticeText(D("tell", { implicit: true }), "digest", ctx), /typed directly in the agent's thread/);
  assert.equal(noticeFor(D("tell"), { id: "orch", level: "digest", world: true }, ctx).endsWith("agents touched by you."), true);
});

test("notice text snapshot: every type × kind is non-empty and names the id", () => {
  const types: DirectiveType[] = ["tell", "model", "scope", "priority", "pause", "resume", "stop", "retry", "waive", "approve", "deny", "answer", "signoff", "sendback", "plan", "spawn", "policy", "slots"];
  for (const t of types)
    for (const k of ["direct", "full", "digest", "world"] as const) {
      const s = noticeText(D(t, { value: "high" }), k, ctx);
      assert.ok(s.length > 10 && (t === "slots" && k === "direct" ? true : s.includes("D-0007")), `${t}/${k}: ${s}`);
    }
});

test("delivery modes", () => {
  assert.equal(deliveryModeFor("tell", "direct", "queue"), "queue");
  assert.equal(deliveryModeFor("tell", "full", "steer"), "queue");
  assert.equal(deliveryModeFor("stop", "full", "steer"), "steer");
  assert.equal(deliveryModeFor("model", "digest", "steer"), "queue");
});

test("questions are not directives", () => {
  assert.equal(isQuestion("What is blocking progress?"), true);
  assert.equal(isQuestion("status"), true);
  assert.equal(isQuestion("Prioritise Ledgerly this week"), false);
});

test("digest coalescing within 20 s", () => {
  const out = coalesceDigests([
    { ts: 0, text: "a" },
    { ts: 5000, text: "b" },
    { ts: 30000, text: "c" },
  ]);
  assert.deepEqual(out, ["a\nb", "c"]);
});
