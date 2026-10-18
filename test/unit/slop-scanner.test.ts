// Appendix B §8: the slop fixture suite and its thresholds.
//
// Fixtures live in test/fixtures/slop/. Each fixture directory is a small app
// tree that is loaded from disk and handed to the pure scanner. Files whose real
// name ends in .ts/.tsx are stored as `<name>.fixture` so that neither `tsc`
// (tsconfig includes test/) nor the `test/**/*.test.ts` glob picks them up; the
// loader strips the suffix. A fixture's top-level history.json is passed as
// `history` (added lines from earlier commits) and is not part of the tree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { scan, type ScanFile, type ScanFinding, type ScanInput, type AllowEntry } from "../../src/server/domain/slop/scan.ts";
import { validateVerdict, VerdictSchema, type VerdictEnvironment } from "../../src/server/domain/verdict.ts";
import { redactSecrets } from "../../src/server/domain/slop/rules.ts";

const ROOT = fileURLToPath(new URL("../fixtures/slop/", import.meta.url));
const ZERO_TOLERANCE = new Set(["S1", "S2", "S3", "S5", "S6"]);

interface Expected {
  rule: string;
  path: string;
  line: number;
}

function walk(dir: string, top: string, out: ScanFile[]): ScanFile[] {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, top, out);
    else {
      const rel = relative(top, abs).split("\\").join("/");
      if (rel === "history.json") continue;
      out.push({ path: rel.replace(/\.fixture$/, ""), content: readFileSync(abs, "utf8") });
    }
  }
  return out;
}

/** Build the scanner input for a fixture directory the way host ops do for a repo. */
function loadFixture(kind: "planted" | "control", name: string): ScanInput {
  const dir = join(ROOT, kind, name);
  const files = walk(dir, dir, []);
  const input: ScanInput = { files };
  const hist = join(dir, "history.json");
  if (existsSync(hist)) input.history = JSON.parse(readFileSync(hist, "utf8"));
  const allowFile = files.find((f) => f.path === ".helm/slop-allow.json");
  if (allowFile) {
    const j = JSON.parse(allowFile.content) as { allow?: AllowEntry[]; loggers?: string[] };
    if (Array.isArray(j.allow)) input.allow = j.allow;
    if (Array.isArray(j.loggers)) input.loggers = j.loggers;
  }
  return input;
}

const fixtureNames = (kind: "planted" | "control") => readdirSync(join(ROOT, kind)).filter((n) => statSync(join(ROOT, kind, n)).isDirectory()).sort();
const expected = JSON.parse(readFileSync(join(ROOT, "expected.json"), "utf8")) as Record<string, Expected[] | string>;
const expectedFor = (name: string): Expected[] => {
  const e = expected[name];
  return Array.isArray(e) ? e : [];
};

const matches = (f: ScanFinding, e: Expected) => f.rule === e.rule && f.path === e.path && Math.abs(f.line - e.line) <= 1;
const fmt = (e: { rule: string; path: string; line: number }) => `${e.rule} ${e.path}:${e.line}`;

test("§8 fixture layout: every planted fixture has expectations and every expectation has a fixture", () => {
  const planted = fixtureNames("planted");
  assert.deepEqual(planted, [
    "s1-todo-in-view",
    "s11-hollow-tests",
    "s12-swallowed",
    "s2-fake-user-in-prod",
    "s3-invented-import",
    "s5-debug-logging",
    "s6-live-key",
    "s7-generic-copy",
    "s7-narration",
  ]);
  assert.deepEqual(fixtureNames("control"), ["clean-android", "clean-ios", "clean-ts"]);
  const keys = Object.keys(expected).filter((k) => !k.startsWith("_")).sort();
  assert.deepEqual(keys, planted);
  for (const name of planted) assert.ok(expectedFor(name).length > 0, `${name} has no expected findings`);
  for (const name of fixtureNames("control")) {
    const n = loadFixture("control", name).files.length;
    assert.ok(n >= 10 && n <= 25, `${name} should be a realistic 10–25 file app (has ${n})`);
  }
});

test("§8 thresholds: 100% of planted S1/S2/S3/S5/S6, ≥90% of the rest, ≤2% false positives on controls", (t) => {
  const byRule = new Map<string, { want: number; found: number }>();
  const missed: string[] = [];
  const extras: string[] = [];
  let truePositives = 0;

  for (const name of fixtureNames("planted")) {
    const res = scan(loadFixture("planted", name));
    const exp = expectedFor(name);
    for (const e of exp) {
      const hit = res.findings.some((f) => matches(f, e));
      const stat = byRule.get(e.rule) ?? { want: 0, found: 0 };
      stat.want++;
      if (hit) {
        stat.found++;
        truePositives++;
      } else missed.push(`${name}: ${fmt(e)}`);
      byRule.set(e.rule, stat);
    }
    for (const f of res.findings) if (!exp.some((e) => matches(f, e))) extras.push(`${name}: ${fmt(f)} (${f.ruleId})`);
  }

  const controlFindings: string[] = [];
  for (const name of fixtureNames("control")) {
    const res = scan(loadFixture("control", name));
    for (const f of res.findings) controlFindings.push(`${name}: ${fmt(f)} (${f.ruleId}) ${f.quote}`);
  }

  let ztWant = 0;
  let ztFound = 0;
  let restWant = 0;
  let restFound = 0;
  for (const [rule, s] of [...byRule.entries()].sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))) {
    t.diagnostic(`recall ${rule}: ${s.found}/${s.want} (${((100 * s.found) / s.want).toFixed(1)}%)`);
    if (ZERO_TOLERANCE.has(rule)) {
      ztWant += s.want;
      ztFound += s.found;
    } else {
      restWant += s.want;
      restFound += s.found;
    }
  }
  const fp = controlFindings.length;
  const fpRate = fp / (fp + truePositives);
  t.diagnostic(`zero-tolerance recall (S1/S2/S3/S5/S6): ${ztFound}/${ztWant}`);
  t.diagnostic(`other recall: ${restFound}/${restWant} (${((100 * restFound) / restWant).toFixed(1)}%)`);
  t.diagnostic(`false positives on controls: ${fp}; planted findings found: ${truePositives}; FP rate ${(100 * fpRate).toFixed(2)}%`);
  for (const m of missed) t.diagnostic(`missed: ${m}`);
  for (const c of controlFindings) t.diagnostic(`false positive: ${c}`);
  for (const x of extras) t.diagnostic(`unexpected (planted, not counted): ${x}`);

  assert.equal(ztFound, ztWant, `zero-tolerance items missed:\n${missed.filter((m) => ZERO_TOLERANCE.has(m.split(": ")[1].split(" ")[0])).join("\n")}`);
  assert.ok(restWant > 0 && restFound / restWant >= 0.9, `recall on the rest is ${restFound}/${restWant}:\n${missed.join("\n")}`);
  assert.ok(fpRate <= 0.02, `false-positive rate ${(100 * fpRate).toFixed(2)}% > 2%:\n${controlFindings.join("\n")}`);
});

test("scanner output is deterministic, sorted, and independent of file order", () => {
  const sevOrder: Record<string, number> = { blocker: 0, major: 1, minor: 2, nit: 3 };
  for (const kind of ["planted", "control"] as const)
    for (const name of fixtureNames(kind)) {
      const input = loadFixture(kind, name);
      const a = scan(input);
      const b = scan(loadFixture(kind, name));
      assert.deepEqual(a, b, `${kind}/${name}: two runs differ`);
      const reversed = scan({ ...input, files: [...input.files].reverse() });
      assert.deepEqual(reversed, a, `${kind}/${name}: result depends on file order`);
      const sorted = [...a.findings].sort((x, y) => sevOrder[x.severity] - sevOrder[y.severity] || x.path.localeCompare(y.path) || x.line - y.line || x.rule.localeCompare(y.rule));
      assert.deepEqual(a.findings, sorted, `${kind}/${name}: findings are not sorted`);
      const keys = a.findings.map((f) => `${f.rule}|${f.path}|${f.line}`);
      assert.equal(new Set(keys).size, keys.length, `${kind}/${name}: duplicate findings`);
      for (const f of a.findings) {
        assert.ok(f.quote.length <= 200, "quote ≤ 200 chars");
        if (f.line > 0) {
          const file = input.files.find((x) => x.path === f.path);
          assert.ok(file, `${f.path} is a scanned file`);
          // a secret's quote is its line with the value redacted
          const exact = file.content.split(/\r?\n/)[f.line - 1];
          assert.equal((f.rule === "S6" ? redactSecrets(exact) : exact).trim().slice(0, 200), f.quote, `${fmt(f)}: quote is the exact line`);
        }
      }
    }
});

test("allowlist exemptions (allow entries and logger wrappers) are counted in `exempted`", (t) => {
  let total = 0;
  for (const name of fixtureNames("control")) {
    const input = loadFixture("control", name);
    if (!input.allow && !input.loggers) continue;
    const withAllow = scan(input);
    const without = scan({ files: input.files, history: input.history });
    assert.equal(without.exempted, 0);
    assert.equal(without.findings.length - withAllow.findings.length, withAllow.exempted, `${name}: every hidden finding is counted`);
    t.diagnostic(`${name}: exempted ${withAllow.exempted}`);
    total += withAllow.exempted;
  }
  assert.ok(total >= 2, "the control logger wrappers are exercised through the allowlist");

  // an explicit allow entry on a planted fixture hides exactly its findings and counts them
  const input = loadFixture("planted", "s5-debug-logging");
  const base = scan(input);
  const allowed = scan({ ...input, allow: [{ rule: "S5", path: "Sources/Courier/Auth/LoginViewModel.swift", reason: "test" }] });
  assert.equal(allowed.exempted, 2);
  assert.equal(allowed.findings.length, base.findings.length - 2);
  assert.ok(!allowed.findings.some((f) => f.path === "Sources/Courier/Auth/LoginViewModel.swift" && f.rule === "S5"));
  // a different rule on the same path is not exempted
  const otherRule = scan({ ...input, allow: [{ rule: "S6", path: "Sources/Courier/Auth/LoginViewModel.swift", reason: "test" }] });
  assert.equal(otherRule.exempted, 0);
  assert.deepEqual(otherRule.findings, base.findings);
});

test("control look-alikes are shielded by context, not by luck", () => {
  // The Compose @Preview passes onClick = {} and the iOS logger prints inside #if DEBUG.
  // Moving either onto a release path must be flagged.
  const android = loadFixture("control", "clean-android");
  const screen = android.files.find((f) => f.path.endsWith("ui/TransactionListScreen.kt"))!;
  const unmasked = { ...screen, content: screen.content.replace("@Preview(showBackground = true)\n", "") };
  const res = scan({ files: android.files.map((f) => (f === screen ? unmasked : f)) });
  assert.ok(res.findings.some((f) => f.ruleId === "S1-empty-handler" && f.path === screen.path));

  const ios = loadFixture("control", "clean-ios");
  const log = ios.files.find((f) => f.path.endsWith("Support/Log.swift"))!;
  const noDebug = { ...log, content: log.content.replaceAll("#if DEBUG\n", "").replaceAll("#endif\n", "") };
  const r2 = scan({ files: ios.files.map((f) => (f === log ? noDebug : f)) });
  assert.ok(r2.findings.some((f) => f.rule === "S5" && f.path === log.path));
  const r3 = scan({ files: ios.files.map((f) => (f === log ? noDebug : f)), loggers: ios.loggers });
  assert.ok(!r3.findings.some((f) => f.rule === "S5" && f.path === log.path));
  assert.equal(r3.exempted, 2);
});

test("S7 stock copy is flagged only in text people read: READMEs, store listings and UI strings", () => {
  const line = "Sync your notes seamlessly across devices.";
  const paths = ["README.md", "apps/ios/README.md", "fastlane/metadata/en-US/description.txt", "app/src/main/res/values-de/strings.xml", "Sources/App/en.lproj/Localizable.strings", "lib/l10n/app_en.arb", "docs/notes.md", "src/sync.ts", "tests/README.md", "node_modules/x/README.md"];
  const res = scan({ files: paths.map((path) => ({ path, content: path.endsWith(".ts") ? `// ${line}` : line })) });
  const hit = res.findings.filter((f) => f.ruleId === "S7-copy").map((f) => f.path).sort();
  assert.deepEqual(hit, paths.slice(0, 6).sort());
  assert.ok(!scan({ files: [{ path: "README.md", content: "Snap a receipt and Tally works out who owes whom." }] }).findings.length);
});

test("S6 entropy rule: credential-like literals are flagged; interpolations and cache keys are not", () => {
  // generated at runtime so no credential-shaped literal sits in this file
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const fake = `FAKE${Array.from({ length: 28 }, (_, i) => alphabet[(i * 11 + 3) % alphabet.length]).join("")}`;
  const content = [
    `export const apiSecret = "${fake}";`,
    "const cacheKey = `compact:${runId}:${nodeId}:${turns}:${attempt}`;",
    'const storageKey = "pantry/items/v3/by-location/kitchen";',
    'const label = "Q8x2Lr7Vw0Zp4Nt6Ky1Bm9Hc3Js5Dg";',
  ].join("\n");
  const res = scan({ files: [{ path: "src/config.ts", content }] });
  const s6 = res.findings.filter((f) => f.rule === "S6").map((f) => f.line);
  assert.deepEqual(s6, [1]);
});

// ───────────────────────────── verdict validator (§6) ─────────────────────────────

const HEAD = "9f2c1ab0c3d4e5f60718293a4b5c6d7e8f901234";
const REPORTS = new Set(["reports/slop/scan.json", "reports/tests/vitest.txt"]);

function fakeEnv(repo: string, overrides: Partial<VerdictEnvironment> = {}): VerdictEnvironment {
  const files = new Map(loadFixture("planted", repo).files.map((f) => [f.path, f.content] as const));
  return {
    integrationHead: HEAD,
    readAt: async (commit, path) => (commit.length >= 7 && HEAD.startsWith(commit.toLowerCase()) ? (files.get(path) ?? null) : null),
    refExists: async (ref) => REPORTS.has(ref),
    worktree: { clean: true, head: HEAD, dirtyPaths: [] },
    ...overrides,
  };
}

interface VerdictFixture {
  repo: string;
  expectProblem?: string;
  verdict: unknown;
}

const readVerdict = (p: string) => JSON.parse(readFileSync(p, "utf8")) as VerdictFixture;

test("verdict validator accepts the well-formed verdict fixtures (so rejections are not vacuous)", async () => {
  for (const name of ["valid-fail.json", "valid-pass.json"]) {
    const fx = readVerdict(join(ROOT, "verdicts", name));
    const v = VerdictSchema.parse(fx.verdict);
    const res = await validateVerdict(v, fakeEnv(fx.repo));
    assert.equal(res.accepted, true, `${name}: ${res.problems.join(" | ")}`);
    assert.equal(res.unlocatable.length, 0);
    assert.equal(res.located.length, v.findings.length);
  }
});

test("verdict validator rejects 100% of the malformed verdict fixtures, for the right reason", async (t) => {
  const dir = join(ROOT, "verdicts", "malformed");
  const names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  for (const required of ["missing-ref", "unlocatable-quote", "pass-with-blocker", "pass-with-zero-checks", "more-than-ten-nits", "wrong-commit"])
    assert.ok(names.includes(`${required}.json`), `missing malformed fixture ${required}`);
  let rejected = 0;
  for (const name of names) {
    const fx = readVerdict(join(dir, name));
    const v = VerdictSchema.parse(fx.verdict); // schema-valid: rejection must come from the validator
    const res = await validateVerdict(v, fakeEnv(fx.repo));
    assert.equal(res.accepted, false, `${name} was accepted`);
    assert.ok(fx.expectProblem, `${name} declares expectProblem`);
    assert.ok(res.problems.some((p) => p.includes(fx.expectProblem!)), `${name}: expected a problem containing "${fx.expectProblem}", got: ${res.problems.join(" | ")}`);
    rejected++;
  }
  t.diagnostic(`malformed verdicts rejected: ${rejected}/${names.length}`);
  assert.equal(rejected, names.length);
});

test("verdict validator flags a gate that wrote outside reports/ or moved HEAD", async () => {
  const v = VerdictSchema.parse(readVerdict(join(ROOT, "verdicts", "valid-fail.json")).verdict);
  const dirty = await validateVerdict(v, fakeEnv("s6-live-key", { worktree: { clean: false, head: HEAD, dirtyPaths: ["reports/slop/notes.md", "src/payments/stripe.ts"] } }));
  assert.equal(dirty.accepted, false);
  assert.equal(dirty.readOnlyViolation, true);
  const moved = await validateVerdict(v, fakeEnv("s6-live-key", { worktree: { clean: true, head: "0123456789abcdef0123456789abcdef01234567", dirtyPaths: [] } }));
  assert.equal(moved.accepted, false);
  assert.equal(moved.readOnlyViolation, true);
  const reportsOnly = await validateVerdict(v, fakeEnv("s6-live-key", { worktree: { clean: false, head: HEAD, dirtyPaths: ["reports/slop/notes.md"] } }));
  assert.equal(reportsOnly.accepted, true, reportsOnly.problems.join(" | "));
});

test("S5: a CLI entry point's plain output is not a debug leftover; elsewhere it is; user data still is", async () => {
  const files = [
    { path: "packages/core/Sources/tally/main.swift", content: 'let s = summarise(xs)\nprint("count \\(s.count) sum \\(s.sum)")\n' },
    { path: "bin/tally.js", content: 'console.log(format(result));\n' },
    { path: "packages/core/Sources/TallyCore/Stats.swift", content: 'func f() {\n  print("here")\n}\n' },
    { path: "src/main.go", content: 'fmt.Println(x)\nprintln("user email", email)\n' },
  ];
  const out = scan({ files });
  const s5 = out.findings.filter((f) => f.rule === "S5");
  assert.deepEqual(s5.map((f) => f.path).sort(), ["packages/core/Sources/TallyCore/Stats.swift", "src/main.go"]);
  assert.equal(s5.find((f) => f.path === "src/main.go")!.severity, "blocker");
});

test("blocksReady: S5 blocks only when it logs user data; other zero-tolerance rules at major", async () => {
  const { blocksReady } = await import("../../src/server/domain/verdict.ts");
  assert.equal(blocksReady({ rule: "S5", severity: "major" }), false);
  assert.equal(blocksReady({ rule: "S5", severity: "blocker" }), true);
  assert.equal(blocksReady({ rule: "S1", severity: "major" }), true);
  assert.equal(blocksReady({ rule: "S4", severity: "blocker" }), false);
  assert.equal(blocksReady({ rule: "S1", severity: "major" }, ["S6"]), false);
});
