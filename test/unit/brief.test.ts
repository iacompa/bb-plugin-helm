import { test } from "node:test";
import assert from "node:assert/strict";
import { PortfolioSchema, normalizePortfolio, parseBrief, SAMPLE_BRIEF, SMALL_BRIEF } from "../../src/server/domain/brief.ts";
import { rng } from "../helpers/rng.ts";
import type { Platform } from "../../src/shared/types.ts";

const ORDER: Platform[] = ["ios", "and", "mac", "win"];
const canon = (ps: Platform[]) => [...ps].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));

// ───────────────────────────── the sample briefs ─────────────────────────────

test("§7.7 SAMPLE_BRIEF: 20 apps in 5 groups, ΣP = 43, nothing assumed", () => {
  const r = parseBrief(SAMPLE_BRIEF);
  const p = r.portfolio;
  assert.equal(r.structured, true);
  assert.deepEqual(r.skipped, []);
  assert.equal(p.apps.length, 20);
  assert.deepEqual(p.groups, ["Wellness", "Money", "Creator tools", "Dev & ops", "Travel"]);
  assert.equal(p.apps.reduce((s, a) => s + a.platforms.length, 0), 43);
  assert.ok(p.apps.every((a) => a.platformsAssumed === false));
  assert.deepEqual(p.assumptions, []);
  assert.deepEqual(p.questions, []);
  for (const g of p.groups) assert.equal(p.apps.filter((a) => a.group === g).length, 4, g);
  const by = Object.fromEntries(p.apps.map((a) => [a.name, a]));
  assert.deepEqual(by["Lumen"], { name: "Lumen", tagline: "Sleep & light tracker", platforms: ["ios", "and", "mac"], platformsAssumed: false, group: "Wellness", kind: "app", needs: [], tools: [] });
  assert.deepEqual(by["Ledgerly"].platforms, ["ios", "mac", "win"], "platforms come back in canonical order");
  assert.deepEqual(by["Hush"].platforms, ["ios", "mac"]);
  assert.equal(by["Mint Jar"].tagline, "Savings goals");
  assert.equal(by["Tidewalk"].tagline, "Tide & shoreline routes");
  assert.deepEqual(by["Forge"].platforms, ["mac", "win"]);
  assert.equal(by["Forge"].group, "Dev & ops");
});

test("§7.7 SMALL_BRIEF: one ungrouped macOS app", () => {
  const r = parseBrief(SMALL_BRIEF);
  assert.equal(r.structured, true);
  assert.deepEqual(r.portfolio.apps, [{ name: "Pebble", tagline: "A one-screen habit counter", platforms: ["mac"], platformsAssumed: false, group: "Ungrouped", kind: "app", needs: [], tools: [] }]);
  assert.deepEqual(r.portfolio.groups, ["Ungrouped"]);
});

test("§7.7 assumed platforms: a line without platforms defaults to iOS + Android and is flagged", () => {
  const r = parseBrief("# Fun\n- Doodle — Draw with friends\n- Echo — Voice memos · iOS");
  const [doodle, echo] = r.portfolio.apps;
  assert.deepEqual(doodle.platforms, ["ios", "and"]);
  assert.equal(doodle.platformsAssumed, true);
  assert.equal(echo.platformsAssumed, false);
  assert.deepEqual(r.portfolio.assumptions, ["Doodle: no platforms given — assumed iOS and Android."]);
});

// ───────────────────────────── messy input ─────────────────────────────

test("messy bullets and separators: * • -, em/en dash, hyphen, double hyphen", () => {
  const r = parseBrief(
    [
      "Some intro text that is not an app.",
      "## Tools",
      "* Alpha — First · iOS",
      "  • Beta – Second · android",
      "-   Gamma - Third · Windows",
      "- Delta -- Fourth | macOS | Windows",
      "-Epsilon — Fifth · iPhone iPad",
      "### Other",
      "- Zeta — Sixth · Mac + iOS",
      "- Eta — Seventh · OSX, win",
    ].join("\n"),
  );
  const got = r.portfolio.apps.map((a) => [a.name, a.tagline, a.platforms.join(","), a.group]);
  assert.deepEqual(got, [
    ["Alpha", "First", "ios", "Tools"],
    ["Beta", "Second", "and", "Tools"],
    ["Gamma", "Third", "win", "Tools"],
    ["Delta", "Fourth", "mac,win", "Tools"],
    ["Epsilon", "Fifth", "ios", "Tools"],
    ["Zeta", "Sixth", "ios,mac", "Other"],
    ["Eta", "Seventh", "mac,win", "Other"],
  ]);
  assert.deepEqual(r.portfolio.groups, ["Tools", "Other"]);
  assert.ok(r.portfolio.apps.every((a) => !a.platformsAssumed));
});

test("platform words without a · separator are read from the whole description", () => {
  const [a, b, c] = parseBrief("- Pocket — budgeting for Android and Windows\n- Window Pane — a window manager\n- Macro — keyboard macros for macOS").portfolio.apps;
  assert.deepEqual(a.platforms, ["and", "win"]);
  assert.equal(a.tagline, "budgeting for Android and Windows");
  // "window" and "Macro" are not platform words (word boundaries)
  assert.deepEqual(b.platforms, ["ios", "and"]);
  assert.equal(b.platformsAssumed, true);
  assert.deepEqual(c.platforms, ["mac"]);
});

test("numbered lists and prose are not the structured shape — they go to the planner", () => {
  const numbered = parseBrief("1. Lumen — Sleep tracker · iOS\n2. Stride — Run planner · Android");
  assert.equal(numbered.structured, false);
  assert.deepEqual(numbered.portfolio.apps, []);
  const prose = parseBrief("I want a sleep tracker for iOS and a budgeting app for Windows.");
  assert.equal(prose.structured, false);
  assert.deepEqual(prose.portfolio, { apps: [], groups: [], assumptions: [], questions: [] });
  assert.equal(parseBrief("").structured, false);
});

test("bullets that are not app lines are reported as skipped; headings without apps are dropped", () => {
  const r = parseBrief("# Empty\n# Real\n- just a note\n- Lumen — Sleep · iOS\n* another thought\n-not a bullet");
  assert.deepEqual(r.skipped, ["- just a note", "* another thought"]);
  assert.deepEqual(r.portfolio.groups, ["Real"]);
  assert.equal(r.portfolio.apps.length, 1);
});

test("CRLF line endings parse the same as LF", () => {
  const crlf = parseBrief(SAMPLE_BRIEF.replace(/\n/g, "\r\n"));
  assert.deepEqual(crlf.portfolio, parseBrief(SAMPLE_BRIEF).portfolio);
});

// ───────────────────────────── PortfolioSchema (planner output) ─────────────────────────────

test("PortfolioSchema accepts the planner's shape and loose platform words", () => {
  const p = PortfolioSchema.parse({
    apps: [
      { name: " Lumen ", tagline: "Sleep", platforms: ["iOS", "Android", " macOS ", "ios"], group: "Wellness", shape: "lean" },
      { name: "Quill", platforms: ["Windows", "mac"] },
      { name: "Pebble" },
    ],
    groups: ["Wellness"],
    questions: ["Should Mint Jar also ship on Android?"],
  });
  assert.deepEqual(p.apps[0].platforms, ["ios", "and", "mac", "ios"]);
  assert.equal(p.apps[0].name, "Lumen");
  assert.equal(p.apps[1].tagline, "");
  assert.deepEqual(p.assumptions, []);
  const n = normalizePortfolio(p);
  assert.deepEqual(n.apps[0].platforms, ["ios", "and", "mac"], "duplicates removed");
  assert.equal(n.apps[0].platformsAssumed, false);
  assert.deepEqual(n.apps[1], { name: "Quill", tagline: "", platforms: ["win", "mac"], platformsAssumed: false, group: null, shape: undefined, notes: null, kind: "app", needs: [], tools: [] });
  assert.deepEqual(n.apps[2].platforms, ["ios", "and"]);
  assert.equal(n.apps[2].platformsAssumed, true);
  assert.deepEqual(n.questions, ["Should Mint Jar also ship on Android?"]);
});

test("PortfolioSchema rejects bad planner output", () => {
  const app = { name: "Lumen", platforms: ["ios"] };
  const bad: Array<[string, unknown]> = [
    ["unknown platform", { apps: [{ name: "X", platforms: ["linux"] }] }],
    ["empty name", { apps: [{ name: "   " }] }],
    ["name too long", { apps: [{ name: "x".repeat(61) }] }],
    ["unknown app key", { apps: [{ ...app, priority: "high" }] }],
    ["unknown top-level key", { apps: [app], managers: [] }],
    ["bad shape", { apps: [{ ...app, shape: "huge" }] }],
    ["more than 5 platforms", { apps: [{ name: "X", platforms: ["ios", "and", "mac", "win", "web", "ios"] }] }],
    ["unknown kind", { apps: [{ ...app, kind: "spaceship" }] }],
    ["more than 3 questions", { apps: [app], questions: ["a", "b", "c", "d"] }],
    ["more than 60 apps", { apps: Array.from({ length: 61 }, (_, i) => ({ name: `A${i}` })) }],
    ["apps missing", { groups: [] }],
    ["apps not an array", { apps: "Lumen" }],
    ["platform not a string", { apps: [{ name: "X", platforms: [1] }] }],
    ["not an object", "Lumen, Stride"],
  ];
  for (const [why, input] of bad) assert.equal(PortfolioSchema.safeParse(input).success, false, why);
  const err = PortfolioSchema.safeParse({ apps: [{ name: "X", platforms: ["linux"] }] });
  assert.match(JSON.stringify(err.error?.issues), /Unknown platform \\"linux\\"/);
  assert.equal(PortfolioSchema.safeParse({ apps: [] }).success, true, "an empty plan is valid input (the wizard says 'No apps found')");
});

// ───────────────────────────── property: render → parse round trip ─────────────────────────────

const WORDS = ["Sleep", "budget", "notes", "photo", "tracker", "planner", "log", "routes", "focus", "sketch", "invoices", "habit", "timer", "music", "garden"];
const ALIASES: Record<Platform, string[]> = { ios: ["iOS", "iPhone", "ios", "iPad"], and: ["Android", "android", "ANDROID"], mac: ["macOS", "Mac", "mac", "OSX"], win: ["Windows", "Win", "windows"], web: ["Web", "web"] };
const BULLETS = ["-", "*", "•"];
const SEPS = ["—", "–", "-", "--"];

test("property: random app lists rendered to text parse back to the same names, groups and platforms", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const r = rng(seed);
    const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
    const nGroups = 1 + Math.floor(r() * 4);
    const expected: Array<{ name: string; group: string; platforms: Platform[]; assumed: boolean; tagline: string }> = [];
    const lines: string[] = ["Please build these."];
    const used = new Set<string>();
    for (let g = 0; g < nGroups; g++) {
      const group = `Group ${String.fromCharCode(65 + g)} ${pick(WORDS)}`;
      lines.push("", `${"#".repeat(1 + Math.floor(r() * 3))} ${group}`);
      const nApps = 1 + Math.floor(r() * 5);
      for (let i = 0; i < nApps; i++) {
        let name: string;
        do {
          const len = 3 + Math.floor(r() * 7);
          name = Array.from({ length: len }, (_, k) => String.fromCharCode((k === 0 ? 65 : 97) + Math.floor(r() * 26))).join("");
          if (r() < 0.3) name += ` ${pick(["Jar", "Box", "Lab", "Kit"])}`;
        } while (used.has(name));
        used.add(name);
        const tagline = Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(WORDS)).join(" ");
        const platforms = ORDER.filter(() => r() < 0.45);
        const shuffled = [...platforms].sort(() => r() - 0.5);
        const platText = shuffled.map((p) => pick(ALIASES[p])).join(pick([" ", " + ", ", ", " / "]));
        const indent = r() < 0.2 ? "  " : "";
        lines.push(`${indent}${pick(BULLETS)} ${name} ${pick(SEPS)} ${tagline}${platforms.length ? ` ${pick(["·", "|"])} ${platText}` : ""}`);
        expected.push({ name, group, platforms: platforms.length ? platforms : ["ios", "and"], assumed: platforms.length === 0, tagline });
      }
    }
    const text = lines.join(r() < 0.5 ? "\n" : "\r\n");
    const got = parseBrief(text).portfolio;
    const ctx = `seed ${seed}\n${text}`;
    assert.deepEqual(
      got.apps.map((a) => a.name),
      expected.map((e) => e.name),
      ctx,
    );
    assert.deepEqual(
      got.apps.map((a) => canon(a.platforms)),
      expected.map((e) => e.platforms),
      ctx,
    );
    assert.deepEqual(
      got.apps.map((a) => [a.group, a.tagline, a.platformsAssumed]),
      expected.map((e) => [e.group, e.tagline, e.assumed]),
      ctx,
    );
    assert.deepEqual(got.groups, [...new Set(expected.map((e) => e.group))], ctx);
    assert.equal(got.assumptions.length, expected.filter((e) => e.assumed).length, ctx);
    // and whatever the deterministic parser produced is valid planner-schema input
    const back = PortfolioSchema.safeParse({ apps: got.apps.map((a) => ({ name: a.name, tagline: a.tagline, platforms: a.platforms, group: a.group })), groups: got.groups });
    assert.equal(back.success, true, ctx);
  }
});

test("app folders and read-only folders in a structured brief; path words never count as platforms", () => {
  const r = parseBrief(`# Portfolio
- Lumen — finish the loan tracker · iOS Android · /Volumes/💾My Disk's SSD X1/APP/app builds/studio/.worktrees/lumen-T-01 · reads /Volumes/💾My Disk's SSD X1/APP/app builds/studio/shared-core, ~/shared/design
- Mac Tool — utility · /Volumes/mac-ssd/tools/thing
- Plain — no folder · Windows`);
  assert.equal(r.structured, true);
  const [lumen, tool, plain] = r.portfolio.apps;
  assert.equal(lumen.path, "/Volumes/💾My Disk's SSD X1/APP/app builds/studio/.worktrees/lumen-T-01");
  assert.deepEqual(lumen.reads, ["/Volumes/💾My Disk's SSD X1/APP/app builds/studio/shared-core", "~/shared/design"]);
  assert.deepEqual(lumen.platforms.sort(), ["and", "ios"]);
  assert.equal(tool.path, "/Volumes/mac-ssd/tools/thing");
  assert.deepEqual(tool.platforms, ["ios", "and"], "'mac-ssd' in a path is not macOS: platforms stay assumed");
  assert.equal(tool.platformsAssumed, true);
  assert.equal(plain.path, undefined);
  assert.deepEqual(plain.platforms, ["win"]);
});
