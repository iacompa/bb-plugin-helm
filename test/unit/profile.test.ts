import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBrief, PortfolioSchema, normalizePortfolio, SAMPLE_BRIEF } from "../../src/server/domain/brief.ts";
import { inferProfile, normalizeNeed, normalizeTool, profileLine } from "../../src/server/domain/profile.ts";
import { planTopology, squadFor } from "../../src/server/domain/topology.ts";
import { scopeFor, skillsFor } from "../../src/server/domain/roles.ts";
import { leadTransition } from "../../src/server/domain/stages.ts";
import { projectSection } from "../../src/server/domain/briefs.ts";
import { LIMIT_DEFAULTS } from "../../src/shared/types.ts";

const one = (line: string) => parseBrief(line).portfolio.apps[0];
const roles = (sq: Array<{ role: string; platform: string | null }>) => sq.map((m) => (m.platform ? `${m.role}:${m.platform}` : m.role));

// ───────────────────────────── deciding the profile ─────────────────────────────

test("a website that takes payments: web kind, web platform, payments + database + security, Docker and the browser plugin", () => {
  const a = one("- Shopfront — Online store with Stripe checkout");
  assert.equal(a.kind, "web");
  assert.deepEqual(a.platforms, ["web"]);
  assert.equal(a.platformsAssumed, false);
  assert.deepEqual(a.needs, ["database", "payments", "security"]);
  assert.deepEqual(a.tools, ["docker", "plugin:browser-automation"]);
});

test("health data: HIPAA brings accounts and security; a wellness tracker does not", () => {
  const clinic = one("- Intake — Patient intake portal for a clinic");
  assert.equal(clinic.kind, "web");
  assert.ok(clinic.needs!.includes("hipaa") && clinic.needs!.includes("auth") && clinic.needs!.includes("security"));
  const sleep = one("- Lumen — Sleep & light tracker · iOS");
  assert.equal(sleep.kind, "app");
  assert.deepEqual(sleep.needs, []);
});

test("games: a mobile game keeps phones; an Unreal game targets desktop and gets Blender for 3D art", () => {
  const runner = one("- Dash — Endless runner game · iOS Android");
  assert.equal(runner.kind, "game");
  assert.deepEqual(runner.platforms, ["ios", "and"]);
  const arena = one("- Arena — 3D arena shooter in Unreal Engine 5");
  assert.equal(arena.kind, "game");
  assert.deepEqual(arena.tools, ["unreal", "blender"]);
  assert.deepEqual(arena.platforms, ["mac", "win"]);
  assert.equal(arena.platformsAssumed, true);
});

test("automation has no platforms and a schedule suggests BB automations; a review audits what exists", () => {
  const digest = one("- Digest — Automate a daily email digest from RSS feeds");
  assert.equal(digest.kind, "automation");
  assert.deepEqual(digest.platforms, []);
  assert.ok(digest.tools!.includes("plugin:automations"));
  const audit = one("- Tide audit — Review the existing iOS app · iOS · /work/tide");
  assert.equal(audit.kind, "review");
  assert.deepEqual(audit.platforms, ["ios"]);
  assert.equal(audit.path, "/work/tide");
});

test("named values win: a kind word, needs (or none) and tools on the line", () => {
  const a = one("- Pocket — Coin collector · Game · needs none · tools Godot, Blender · iOS");
  assert.equal(a.kind, "game");
  assert.deepEqual(a.needs, []);
  assert.deepEqual(a.tools, ["godot", "blender"]);
  assert.deepEqual(a.platforms, ["ios"]);
  const b = one("- Ledger — Team expenses · Website · needs database, accounts and GDPR");
  assert.equal(b.kind, "web");
  assert.deepEqual(b.needs, ["database", "auth", "privacy"]);
  const r = parseBrief("- Odd — Something · needs teleportation");
  assert.match(r.portfolio.assumptions.join("\n"), /teleportation/);
  assert.equal(r.portfolio.apps[0].notes, "Also needs: teleportation.");
});

test("native platforms keep a dashboard an app; a heading can say what its projects are", () => {
  assert.equal(one("- Forge — CI dashboard · macOS Windows").kind, "app");
  const p = parseBrief("# Websites\n- Atlas — Company site\n- Beacon — Docs portal").portfolio;
  assert.deepEqual(p.apps.map((a) => a.kind), ["web", "web"]);
});

test("the sample brief stays twenty plain apps: nothing inferred, nothing assumed", () => {
  const p = parseBrief(SAMPLE_BRIEF).portfolio;
  assert.ok(p.apps.every((a) => a.kind === "app" && a.needs!.length === 0 && a.tools!.length === 0));
  assert.deepEqual(p.assumptions, []);
});

test("Helm says what it decided and why", () => {
  const p = parseBrief("- Shopfront — Online store with Stripe checkout").portfolio;
  assert.match(p.assumptions[0], /^Shopfront: Helm decided Website · Database, Payments, Security · Docker, BB browser-automation plugin \(/);
  assert.match(p.assumptions[0], /“online store”/i);
});

test("the planner's portfolio: loose kind, need and tool words are normalized; blocked plugins are refused", () => {
  const p = normalizePortfolio(PortfolioSchema.parse({ apps: [{ name: "Shop", kind: "full-stack", needs: ["Stripe", "Postgres"], tools: ["Docker", "browser", "plugin:crew"] }] }));
  assert.equal(p.apps[0].kind, "web");
  assert.deepEqual(p.apps[0].needs, ["database", "payments"]);
  assert.deepEqual(p.apps[0].tools, ["docker", "plugin:browser-automation"]);
  assert.equal(normalizeTool("plugin:workflows"), null);
  assert.equal(normalizeTool("Unreal Engine"), "unreal");
  assert.equal(normalizeNeed("HIPAA"), "hipaa");
  assert.equal(inferProfile({ name: "X", platforms: [], kind: "automation" }).platforms.length, 0);
});

// ───────────────────────────── squads ─────────────────────────────

test("squads follow the kind and needs", () => {
  assert.deepEqual(roles(squadFor("full", ["ios", "and"], false)), ["ui", "code", "platform:ios", "platform:and", "security", "review", "slop"], "plain apps are unchanged");
  assert.deepEqual(roles(squadFor("full", ["web"], false, { kind: "web", needs: ["database", "payments"] })), ["ui", "code", "data", "platform:web", "security", "review", "slop"]);
  assert.deepEqual(roles(squadFor("lean", ["web"], false, { kind: "web", needs: ["hipaa"] })), ["ui", "code", "security", "compliance", "review", "slop"]);
  assert.deepEqual(roles(squadFor("lean", [], false, { kind: "review" })), ["code", "security", "review", "slop"]);
  assert.deepEqual(roles(squadFor("full", ["ios"], false, { kind: "review", needs: ["privacy"] })), ["code", "ui", "platform:ios", "security", "compliance", "test", "review", "slop"]);
  assert.deepEqual(roles(squadFor("full", [], false, { kind: "automation" })), ["code", "security", "test", "docs", "review", "slop"]);
  assert.deepEqual(roles(squadFor("lean", ["ios"], false, { kind: "game", needs: ["assets"] })), ["ui", "code", "assets", "review", "slop"]);
  assert.deepEqual(roles(squadFor("full", ["mac", "win"], false, { kind: "game", tools: ["unreal"] })), ["ui", "code", "platform:mac", "platform:win", "assets", "review", "slop"]);
  assert.deepEqual(roles(squadFor("solo", ["web"], false, { kind: "web", needs: ["payments"] })), ["review", "slop"]);
});

test("the plan carries each project's profile; new roles share the closest model slot", () => {
  const p = parseBrief("- Shopfront — Online store with Stripe checkout\n- Audit — Review the existing web app · /work/site\n- Bot — Automate weekly reports").portfolio;
  const plan = planTopology(p.apps, LIMIT_DEFAULTS);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.apps.map((a) => a.kind), ["web", "review", "automation"]);
  const data = plan.nodes.find((n) => n.role === "data")!;
  assert.equal(data.slot, "code");
  assert.equal(data.tier, "specialist");
  assert.equal(plan.counts.bySlot.code, 4, "three Core builders and one Data builder");
  assert.equal(profileLine(plan.apps[0]), "Website · Database, Payments, Security · Docker, BB browser-automation plugin");
});

// ───────────────────────────── scopes and skills ─────────────────────────────

test("scopes follow the kind: auditors write only their reports; web and game builders get their layout", () => {
  assert.deepEqual(scopeFor("code", null, "review"), ["reports/code/**"]);
  assert.deepEqual(scopeFor("platform", "ios", "review"), ["reports/ios/**"]);
  assert.ok(scopeFor("lead", null, "review").includes("REVIEW.md"));
  assert.deepEqual(scopeFor("platform", "web"), ["apps/web/**", "infra/**", "deploy/**", "reports/web/**"]);
  assert.ok(scopeFor("code", null, "game").includes("game/**"));
  assert.deepEqual(scopeFor("data", null), ["db/**", "migrations/**", "prisma/**", "supabase/**", "drizzle/**", "packages/db/**", "reports/data/**"]);
});

test("skills follow the kind, needs and tools", () => {
  const web = { shape: "full", platforms: ["web" as const], kind: "web" as const, needs: ["database" as const, "payments" as const], tools: [] };
  assert.deepEqual(skillsFor({ role: "code", platform: null, alsoLead: false }, web), ["helm-specialist", "helm-backend", "helm-payments"]);
  assert.deepEqual(skillsFor({ role: "platform", platform: "web", alsoLead: false }, web), ["helm-specialist", "helm-web"]);
  assert.deepEqual(skillsFor({ role: "data", platform: null, alsoLead: false }, web), ["helm-specialist", "helm-data"]);
  assert.deepEqual(skillsFor({ role: "security", platform: null, alsoLead: false }, web), ["helm-specialist", "helm-security", "helm-payments"]);
  assert.deepEqual(skillsFor({ role: "code", platform: null, alsoLead: false }, { ...web, shape: "lean" }), ["helm-specialist", "helm-backend", "helm-data", "helm-payments"], "without a Data builder the Core builder owns the database");
  const review = { shape: "full", platforms: [], kind: "review" as const };
  assert.deepEqual(skillsFor({ role: "ui", platform: null, alsoLead: false }, review), ["helm-specialist", "helm-audit", "helm-ui"]);
  assert.deepEqual(skillsFor({ role: "lead", platform: null, alsoLead: false }, review), ["helm-lead", "helm-audit"]);
  const unreal = { shape: "solo", platforms: ["mac" as const], kind: "game" as const, needs: ["assets" as const], tools: ["unreal"] };
  assert.deepEqual(skillsFor({ role: "lead", platform: null, alsoLead: false }, unreal), ["helm-lead", "helm-unreal", "helm-macos", "helm-game", "helm-assets"]);
  assert.deepEqual(skillsFor({ role: "code", platform: null, alsoLead: false }, { shape: "full", platforms: [], kind: "automation" }), ["helm-specialist", "helm-automation"]);
});

// ───────────────────────────── review projects ─────────────────────────────

test("a review project: Spec needs only the review plan; Review needs REVIEW.md, and failing checks do not block it", () => {
  const facts = { committedFiles: new Set(["ACCEPTANCE.md"]), buildersDone: true, buildersPending: [], checksGreen: false, checksMissing: ["test"], checksFailing: ["lint"], integrationHead: "abc1234def" };
  assert.deepEqual(leadTransition("spec", "build", { ...facts, kind: "review" }), { ok: true });
  assert.equal(leadTransition("spec", "build", facts).ok, false, "an app still needs all four spec files");
  const r = leadTransition("integrate", "review", { ...facts, kind: "review" });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /REVIEW\.md/);
  assert.deepEqual(leadTransition("integrate", "review", { ...facts, kind: "review", committedFiles: new Set(["ACCEPTANCE.md", "REVIEW.md"]) }), { ok: true });
});

// ───────────────────────────── briefs ─────────────────────────────

test("the brief's project section: each need's rules, each tool with how to use it and whether it is installed", () => {
  const s = projectSection("code", false, { kind: "game", needs: ["payments"], tools: ["unreal", "blender", "plugin:browser-automation"], installed: { unreal: true, blender: false, "plugin:browser-automation": null } });
  assert.match(s, /^## The project\nGame:/);
  assert.match(s, /- Payments: Payments in test mode only/);
  assert.match(s, /- Unreal Engine \(installed\)\. Keep logic in C\+\+/);
  assert.match(s, /- Blender \(not found on this machine — do not rely on it/);
  assert.match(s, /- BB browser-automation plugin \(not checked\)/);
  const rev = projectSection("lead", false, { kind: "review", needs: [], tools: [], installed: {}, plugins: [{ id: "github", line: "GitHub issues" }] });
  assert.match(rev, /source is read-only for everyone/);
  assert.match(rev, /- github: GitHub issues/);
});
