import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASE_TOK,
  FORECAST_HIGH,
  FORECAST_LOW,
  SEED_PRESETS,
  SEED_WEIGHTS,
  SLOT_IDS,
  agentCost,
  familyOf,
  familyWarnings,
  fillFromCode,
  forecast,
  normalizeModel,
  requiredSlots,
  resolveModel,
  resolvePreset,
  spendFromTokens,
  unsetSlots,
  validateRef,
} from "../../src/server/domain/models.ts";
import { parseBrief, SAMPLE_BRIEF, SMALL_BRIEF } from "../../src/server/domain/brief.ts";
import { planTopology } from "../../src/server/domain/topology.ts";
import type { Catalog, ModelRef, SlotId } from "../../src/shared/types.ts";

const SETTINGS = { managerSpan: 4, orchestratorSpan: 6, leadSpan: 6, maxTotalAgents: 250 };
const sample = planTopology(parseBrief(SAMPLE_BRIEF).portfolio.apps, SETTINGS);
const opts = (seen: string[] = [], hidden: string[] = []) => ({ seen: new Set(seen), weights: SEED_WEIGHTS, hiddenIds: new Set(hidden) });
const ref = (providerId: string, modelId: string, reasoning: string | null, serviceTier?: string | null): ModelRef =>
  serviceTier === undefined ? { providerId, modelId, reasoning } : { providerId, modelId, reasoning, serviceTier };

// A catalog shaped like the live one (§2.2): codex reports objects, claude-code reports strings.
const RAW: Record<string, unknown[]> = {
  codex: [
    { model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }, { reasoningEffort: "max" }], supportedServiceTiers: [{ id: "flex" }, "priority"], isDefault: true },
    { id: "gpt-6-luna", name: "GPT-6 Luna", reasoningLevels: ["low", "medium"] },
  ],
  "claude-code": [
    { id: "claude-sonnet-5-5", displayName: "Sonnet 5.5", reasoningLevels: ["low", "medium", "high", "max"] },
    { id: "claude-haiku-5-5", displayName: "Haiku 5.5", reasoningLevels: ["low", "medium", "high"] },
    { id: "claude-opus-5-5", displayName: "Opus 5.5", reasoningLevels: ["low", "medium", "high", "max"] },
    { id: "claude-mystery-1", displayName: "Mystery" },
  ],
};
const LABEL: Record<string, string> = { codex: "Codex", "claude-code": "Claude Code" };
function catalog(over: { unavailable?: string[] } = {}): Catalog {
  return {
    hostId: "local",
    fetchedAt: 0,
    providers: [
      ...Object.keys(RAW).map((id) => ({ id, label: LABEL[id], available: !over.unavailable?.includes(id), error: null })),
      { id: "acp-grok", label: "Grok (ACP)", available: false, error: "not installed" },
    ],
    models: Object.entries(RAW).flatMap(([p, ms]) => ms.map((m) => normalizeModel(p, LABEL[p], m, opts(["codex/gpt-6.1-sol"]))!)),
  };
}

const close = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ""} ${a} ≠ ${b}`);

// ───────────────────────────── normalizeModel ─────────────────────────────

test("normalizeModel reads codex-style objects: model id, display name, efforts, tiers", () => {
  const m = normalizeModel("codex", "Codex", RAW.codex[0], opts())!;
  assert.deepEqual(m, {
    providerId: "codex",
    providerLabel: "Codex",
    modelId: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    description: null,
    family: "OpenAI",
    reasoning: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoning: null,
    serviceTiers: ["flex", "priority"],
    isDefault: true,
    isNew: true,
    hidden: false,
    weight: 1.5,
    weightKnown: true,
  });
});

test("normalizeModel: string reasoning lists, NEW against seen, hidden flags, unknown weights", () => {
  const m = normalizeModel("claude-code", "Claude Code", { id: "claude-sonnet-5-5", reasoningLevels: ["low", { id: "high" }, { level: "max" }, 7], defaultReasoningEffort: "high" }, opts(["claude-code/claude-sonnet-5-5"]))!;
  assert.equal(m.name, "claude-sonnet-5-5", "falls back to the id");
  assert.deepEqual(m.reasoning, ["low", "high", "max"]);
  assert.equal(m.defaultReasoning, "high");
  assert.equal(m.isNew, false);
  assert.equal(m.family, "Anthropic");
  // seen is keyed by provider/model — the same id under another provider is still new
  assert.equal(normalizeModel("acp-cursor", "Cursor", { id: "claude-sonnet-5-5" }, opts(["claude-code/claude-sonnet-5-5"]))!.isNew, true);
  for (const flag of ["hidden", "legacy", "deprecated"]) assert.equal(normalizeModel("codex", "Codex", { id: "gpt-5", [flag]: true }, opts())!.hidden, true, flag);
  assert.equal(normalizeModel("codex", "Codex", { id: "gpt-5" }, opts([], ["codex/gpt-5"]))!.hidden, true, "hidden by the user");
  const unk = normalizeModel("acp-grok", "Grok", { id: "grok-5" }, opts())!;
  assert.equal(unk.weight, 1.0);
  assert.equal(unk.weightKnown, false);
  assert.equal(unk.family, "xAI");
});

test("normalizeModel rejects entries without an id", () => {
  for (const raw of [null, undefined, 3, "gpt", {}, { id: "" }, { id: 5 }, { displayName: "No id" }]) assert.equal(normalizeModel("codex", "Codex", raw, opts()), null, JSON.stringify(raw));
});

test("familyOf: by model name first, then by provider", () => {
  assert.equal(familyOf("acp-cursor", "gpt-6.1-sol"), "OpenAI");
  assert.equal(familyOf("acp-cursor", "o4-mini"), "OpenAI");
  assert.equal(familyOf("acp-cursor", "claude-opus-5-5"), "Anthropic");
  assert.equal(familyOf("acp-cursor", "gemini-3-pro"), "Google");
  assert.equal(familyOf("acp-cursor", "composer-2"), "Cursor");
  assert.equal(familyOf("codex", "mystery"), "OpenAI");
  assert.equal(familyOf("claude-code", "mystery"), "Anthropic");
  assert.equal(familyOf("acp-cursor", "mystery"), "Mixed");
});

// ───────────────────────────── validateRef ─────────────────────────────

test("§7.4 validateRef: provider, model, reasoning level and service tier", () => {
  const c = catalog();
  assert.equal(validateRef(c, ref("codex", "gpt-6.1-sol", "xhigh")), null);
  assert.equal(validateRef(c, ref("codex", "gpt-6.1-sol", null)), null, "no reasoning chosen is fine");
  assert.equal(validateRef(c, ref("claude-code", "claude-mystery-1", "ultra")), null, "a model that lists no levels accepts any");
  assert.deepEqual(validateRef(c, ref("acp-grok", "grok-5", "high")), { kind: "provider", message: "Provider acp-grok is not available on this machine — choose another model." });
  assert.equal(validateRef(c, ref("acp-nope", "x", null))?.kind, "provider");
  assert.equal(validateRef(catalog({ unavailable: ["codex"] }), ref("codex", "gpt-6.1-sol", "high"))?.kind, "provider");
  assert.deepEqual(validateRef(c, ref("codex", "gpt-6-sol", "high")), { kind: "unavailable", message: "Model gpt-6-sol is no longer available — choose another." });
  assert.equal(validateRef(c, ref("claude-code", "gpt-6.1-sol", "high"))?.kind, "unavailable", "model ids are per provider");
  assert.deepEqual(validateRef(c, ref("claude-code", "claude-haiku-5-5", "max")), {
    kind: "reasoning",
    message: "Haiku 5.5 does not offer reasoning level max (it offers low, medium, high).",
  });
  assert.deepEqual(validateRef(c, ref("codex", "gpt-6.1-sol", "high", "turbo")), { kind: "tier", message: "GPT-6.1 Sol does not offer service tier turbo." });
  assert.equal(validateRef(c, ref("codex", "gpt-6.1-sol", "high", "flex")), null);
  assert.equal(validateRef(c, ref("codex", "gpt-6.1-sol", "high", "default")), null);
  assert.equal(validateRef(c, ref("claude-code", "claude-sonnet-5-5", "high", null)), null);
});

// ───────────────────────────── presets & slots ─────────────────────────────

test("§7.3 resolvePreset reports vanished models but never replaces them", () => {
  const c = catalog();
  const { slots, unavailable } = resolvePreset(c, SEED_PRESETS["Max quality"]);
  assert.deepEqual(slots, SEED_PRESETS["Max quality"], "every entry is kept as chosen");
  // Max quality wants Sol at max (offered) and Opus at max/high (offered) — all valid in this catalog.
  assert.deepEqual(unavailable, []);
  const custom = { ui: ref("codex", "gpt-6-sol", "high"), code: ref("claude-code", "claude-haiku-5-5", "max"), review: ref("acp-grok", "grok-5", null), slop: ref("claude-code", "claude-sonnet-5-5", "high") };
  const r = resolvePreset(c, custom);
  assert.deepEqual(r.slots, custom);
  assert.deepEqual(r.unavailable.map((u) => u.slot), ["ui", "code", "review"]);
  assert.match(r.unavailable[0].problem, /no longer available/);
  assert.match(r.unavailable[1].problem, /does not offer reasoning level max/);
  assert.match(r.unavailable[2].problem, /not available on this machine/);
});

test("§7.3 seed presets: Studio default sets exactly ui, code, review, slop", () => {
  assert.deepEqual(Object.keys(SEED_PRESETS["Studio default"]).sort(), ["code", "review", "slop", "ui"]);
  assert.deepEqual(SEED_PRESETS["Studio default"].ui, ref("codex", "gpt-6.1-sol", "xhigh"));
  assert.deepEqual(SEED_PRESETS["Studio default"].code, ref("claude-code", "claude-sonnet-5-5", "high"));
  assert.deepEqual(Object.keys(SEED_PRESETS["Cheap dev run"]).sort(), [...SLOT_IDS].sort());
  assert.ok(Object.values(SEED_PRESETS["Cheap dev run"]).every((r) => r!.modelId === "claude-haiku-5-5" && r!.reasoning === "low"));
});

test("§7.2 requiredSlots / unsetSlots for the 20-app sample", () => {
  const bySlot = sample.counts.bySlot;
  assert.deepEqual(requiredSlots(bySlot), ["orchestrator", "manager", "lead", "ui", "code", "platform", "security", "review", "slop"]);
  assert.deepEqual(unsetSlots(SEED_PRESETS["Studio default"], bySlot), ["orchestrator", "manager", "lead", "platform", "security"]);
  assert.deepEqual(unsetSlots(SEED_PRESETS["Cheap dev run"], bySlot), []);
  assert.deepEqual(unsetSlots({}, bySlot), requiredSlots(bySlot));
});

test("§7.2 required slots shrink with the plan: one macOS app has no managers, leads or platform builders", () => {
  const small = planTopology(parseBrief(SMALL_BRIEF).portfolio.apps, SETTINGS);
  const req = requiredSlots(small.counts.bySlot);
  assert.ok(!req.includes("manager"));
  assert.ok(req.includes("orchestrator") && req.includes("review") && req.includes("slop"));
  // optional slots are never required unless a node uses them
  for (const s of ["test", "research", "docs"] as SlotId[]) assert.ok(!requiredSlots(sample.counts.bySlot).includes(s));
});

test("§7.3 Fill the rest like Code builders copies code into every required unset slot only", () => {
  const bySlot = sample.counts.bySlot;
  const filled = fillFromCode(SEED_PRESETS["Studio default"], bySlot);
  assert.deepEqual(unsetSlots(filled, bySlot), []);
  for (const s of ["orchestrator", "manager", "lead", "platform", "security"] as SlotId[]) assert.deepEqual(filled[s], SEED_PRESETS["Studio default"].code);
  assert.deepEqual(filled.ui, SEED_PRESETS["Studio default"].ui, "set slots are untouched");
  assert.equal(filled.research, undefined, "unused optional slots stay unset");
  assert.notEqual(filled.lead, filled.code, "copies, not shared references");
  const noCode = { ui: ref("codex", "gpt-6.1-sol", "high") };
  assert.equal(fillFromCode(noCode, bySlot), noCode);
});

// ───────────────────────────── family warnings ─────────────────────────────

test("§7.4 same-family warnings: gate vs builder", () => {
  // Studio default: Sol (OpenAI) on UI + Reviewer, Sonnet (Anthropic) on Code + Slop Hunter.
  assert.deepEqual(familyWarnings(catalog(), SEED_PRESETS["Studio default"]), [
    "Reviewer and UI builders are both OpenAI models — they can share blind spots.",
    "Slop Hunter and Code builders are both Anthropic models — they can share blind spots.",
  ]);
  assert.equal(familyWarnings(null, SEED_PRESETS["Cheap dev run"]).length, 4);
  assert.ok(familyWarnings(null, SEED_PRESETS["Cheap dev run"]).includes("Reviewer and Code builders are both Anthropic models — they can share blind spots."));
  // gates on a different family from both builders → no warning
  const mixed = { ui: ref("claude-code", "claude-sonnet-5-5", "high"), code: ref("claude-code", "claude-opus-5-5", "high"), review: ref("codex", "gpt-6.1-sol", "high"), slop: ref("codex", "gpt-6-luna", "medium") };
  assert.deepEqual(familyWarnings(catalog(), mixed), []);
  // unset slots never warn
  assert.deepEqual(familyWarnings(null, { review: ref("codex", "gpt-6.1-sol", "high") }), []);
});

test("familyWarnings prefers the catalog's family over the name heuristic", () => {
  const c = catalog();
  c.models = c.models.map((m) => (m.modelId === "claude-mystery-1" ? { ...m, family: "Mixed" } : m));
  const slots = { code: ref("claude-code", "claude-mystery-1", null), review: ref("claude-code", "claude-sonnet-5-5", "high") };
  assert.deepEqual(familyWarnings(c, slots), [], "catalog says Mixed, not Anthropic");
  assert.equal(familyWarnings(null, slots).length, 1, "without a catalog the name says Anthropic");
});

// ───────────────────────────── precedence ─────────────────────────────

test("§7.5 resolveModel: node > app > run slot > preset", () => {
  const [n, a, r, p] = ["node", "app", "run", "preset"].map((x) => ref("claude-code", x, null));
  assert.equal(resolveModel({ nodeOverride: n, appOverride: a, runSlot: r, preset: p }), n);
  assert.equal(resolveModel({ nodeOverride: null, appOverride: a, runSlot: r, preset: p }), a);
  assert.equal(resolveModel({ appOverride: null, runSlot: r, preset: p }), r);
  assert.equal(resolveModel({ runSlot: null, preset: p }), p);
  assert.equal(resolveModel({ nodeOverride: n, preset: p }), n);
  assert.equal(resolveModel({}), null);
});

// ───────────────────────────── cost (§7.6) ─────────────────────────────

test("§7.6 agentCost = BASE_TOK × weight × RW × 0.0075", () => {
  close(agentCost("ui", ref("codex", "gpt-6.1-sol", "xhigh"), SEED_WEIGHTS), 900 * 1.5 * 1.35 * 0.0075);
  close(agentCost("orch", ref("claude-code", "claude-opus-5-5", "max"), SEED_WEIGHTS), 1800 * 2.6 * 1.7 * 0.0075);
  close(agentCost("code", null, SEED_WEIGHTS), 1100 * 0.0075, "unset slot = weight 1, RW 1");
  close(agentCost("code", ref("x", "unknown-model", "weird"), SEED_WEIGHTS), 1100 * 0.0075, "unknown weight and level default to 1");
  close(agentCost("review", ref("claude-code", "claude-haiku-5-5", "none"), SEED_WEIGHTS), 500 * 0.3 * 0.5 * 0.0075);
});

test("§7.6 forecast golden numbers for the 20-app sample (169 agents)", () => {
  assert.equal(sample.nodes.length, 169);
  const golden: Record<string, { units: number; low: number; high: number }> = {
    "Studio default": { units: 1156.125, low: 809.2875, high: 1560.76875 },
    "Cheap dev run": { units: 205.8525, low: 144.09675, high: 277.900875 },
    "Max quality": { units: 2493.1575, low: 1745.21025, high: 3365.762625 },
  };
  for (const [name, g] of Object.entries(golden)) {
    const f = forecast(sample.nodes, SEED_PRESETS[name], SEED_WEIGHTS);
    close(f.units, g.units, `${name} units`);
    close(f.low, g.low, `${name} low`);
    close(f.high, g.high, `${name} high`);
    assert.equal(f.tokensK, 130700);
    assert.deepEqual(f.unknownWeights, []);
  }
  // nothing chosen: every agent at weight 1, RW 1 → ΣBASE_TOK × 0.0075
  const empty = forecast(sample.nodes, {}, SEED_WEIGHTS);
  close(empty.units, 130700 * 0.0075);
  close(empty.low, 980.25 * FORECAST_LOW);
  close(empty.high, 980.25 * FORECAST_HIGH);
});

test("forecast tokens are ΣBASE_TOK by role; node models override slots; unknown weights are flagged once", () => {
  const roles = sample.nodes.reduce<Record<string, number>>((m, n) => ((m[n.role] = (m[n.role] ?? 0) + 1), m), {});
  assert.deepEqual(roles, { orch: 1, mgr: 5, lead: 20, ui: 20, code: 20, platform: 43, security: 20, review: 20, slop: 20 });
  assert.equal(Object.entries(roles).reduce((s, [r, c]) => s + BASE_TOK[r as keyof typeof BASE_TOK] * c, 0), 130700);
  const nodes = [
    { role: "code" as const, slot: "code" as SlotId, model: ref("claude-code", "claude-opus-5-5", "high") },
    { role: "code" as const, slot: "code" as SlotId },
    { role: "ui" as const, slot: "ui" as SlotId, model: ref("acp-grok", "grok-5", "high") },
    { role: "ui" as const, slot: "ui" as SlotId, model: ref("acp-grok", "grok-5", "high") },
  ];
  const f = forecast(nodes, { code: ref("claude-code", "claude-haiku-5-5", "low") }, SEED_WEIGHTS);
  close(f.units, (1100 * 2.6 + 1100 * 0.3 * 0.7 + 900 * 2) * 0.0075);
  assert.deepEqual(f.unknownWeights, ["grok-5"]);
});

test("§7.6 spendFromTokens: raw tokens → units by model weight", () => {
  close(spendFromTokens(1_000_000, ref("claude-code", "claude-sonnet-5-5", "high"), SEED_WEIGHTS), 7.5);
  close(spendFromTokens(1_000_000, ref("claude-code", "claude-opus-5-5", "high"), SEED_WEIGHTS), 19.5);
  close(spendFromTokens(200_000, ref("claude-code", "claude-haiku-5-5", "low"), SEED_WEIGHTS), 200 * 0.3 * 0.0075);
  close(spendFromTokens(1_000_000, null, SEED_WEIGHTS), 7.5, "unknown model counts at weight 1");
  assert.equal(spendFromTokens(0, null, SEED_WEIGHTS), 0);
  // spend is linear in tokens and ignores reasoning (it is already in the token count)
  close(spendFromTokens(2_000, ref("codex", "gpt-6.1-sol", "max"), SEED_WEIGHTS), 2 * spendFromTokens(1_000, ref("codex", "gpt-6.1-sol", "low"), SEED_WEIGHTS));
});
