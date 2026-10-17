import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECKS_JSON_SKELETON,
  RUN_CHECK_SH,
  missingChecks,
  parseChecksJson,
  parseTrailer,
  verifyCheckClaim,
} from "../../src/server/domain/checks.ts";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const SHA2 = "ffffffffffffffffffffffffffffffffffffffff";

// ───────────────────────────── parseTrailer ─────────────────────────────

test("parseTrailer reads a real trailer line, with and without [dirty:1]", () => {
  assert.deepEqual(parseTrailer(`$ npm test\nok 1\n[helm-exit:0] [commit:${SHA}] [ts:123]\n`), { exitCode: 0, commit: SHA, ts: 123, dirty: false });
  assert.deepEqual(parseTrailer(`[helm-exit:0] [commit:${SHA}] [ts:123] [dirty:1]`), { exitCode: 0, commit: SHA, ts: 123, dirty: true });
  assert.deepEqual(parseTrailer(`boom\r\n[helm-exit:2] [commit:${SHA}] [ts:1700000000]\r\n`), { exitCode: 2, commit: SHA, ts: 1700000000, dirty: false });
  assert.deepEqual(parseTrailer("[helm-exit:-1] [commit:none] [ts:9]"), { exitCode: -1, commit: "none", ts: 9, dirty: false });
  assert.equal(parseTrailer("[helm-exit:0] [commit:abc1234] [ts:1]")?.commit, "abc1234");
});

test("parseTrailer only trusts one of the last three lines and an exact shape", () => {
  const trailer = `[helm-exit:0] [commit:${SHA}] [ts:1]`;
  assert.ok(parseTrailer(`${trailer}\na\nb`));
  assert.equal(parseTrailer(`${trailer}\na\nb\nc`), null, "a trailer buried under more output does not count");
  assert.equal(parseTrailer(""), null);
  assert.equal(parseTrailer("all good, exit 0"), null);
  assert.equal(parseTrailer(`echo ${trailer}`), null, "must start the line");
  assert.equal(parseTrailer("[helm-exit:0] [commit:abc] [ts:1]"), null, "sha shorter than 7");
  assert.equal(parseTrailer(`[helm-exit:0] [commit:${"g".repeat(40)}] [ts:1]`), null, "not hex");
  assert.equal(parseTrailer(`[helm-exit:x] [commit:${SHA}] [ts:1]`), null);
  assert.equal(parseTrailer(`[helm-exit:0] [commit:${SHA}] [ts:1] [dirty:0]`), null);
  // the last matching line wins
  assert.equal(parseTrailer(`[helm-exit:1] [commit:${SHA}] [ts:1]\n[helm-exit:0] [commit:${SHA}] [ts:2]`)?.exitCode, 0);
});

// ───────────────────────────── verifyCheckClaim ─────────────────────────────

const out = (code: number, commit = SHA, dirty = false) => `$ make\n...\n[helm-exit:${code}] [commit:${commit}] [ts:123]${dirty ? " [dirty:1]" : ""}\n`;
const reason = (r: ReturnType<typeof verifyCheckClaim>) => (r.ok ? null : r.reason);

test("§8.5: a matching claim is accepted and returns the trailer", () => {
  const r = verifyCheckClaim({ exitCode: 0, commit: SHA }, out(0), SHA);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.trailer, { exitCode: 0, commit: SHA, ts: 123, dirty: false });
  // a failing check honestly claimed as failing is recorded too
  assert.equal(verifyCheckClaim({ exitCode: 1, commit: SHA }, out(1), SHA).ok, true);
  // short sha claims and case differences match the full trailer sha
  assert.equal(verifyCheckClaim({ exitCode: 0, commit: SHA.slice(0, 9).toUpperCase() }, out(0), SHA).ok, true);
  assert.equal(verifyCheckClaim({ exitCode: 0, commit: SHA }, out(0, SHA.slice(0, 12)), SHA).ok, true);
});

test("§8.5: exit-code mismatch is rejected", () => {
  assert.equal(reason(verifyCheckClaim({ exitCode: 0, commit: SHA }, out(1), SHA)), "you claimed exit 0 but the trailer says 1");
  assert.equal(reason(verifyCheckClaim({ exitCode: 2, commit: SHA }, out(0), SHA)), "you claimed exit 2 but the trailer says 0");
});

test("§8.5: commit mismatch is rejected (including a trailer with no commit)", () => {
  assert.equal(reason(verifyCheckClaim({ exitCode: 0, commit: SHA }, out(0, SHA2), SHA)), "the trailer is for commit fffffffff, not a1b2c3d4e");
  assert.equal(reason(verifyCheckClaim({ exitCode: 0, commit: SHA }, out(0, "none"), SHA)), "the trailer is for commit none, not a1b2c3d4e");
});

test("§8.5: a check run on a dirty worktree is rejected", () => {
  assert.equal(reason(verifyCheckClaim({ exitCode: 0, commit: SHA }, out(0, SHA, true), SHA)), "the check ran on a dirty worktree — commit first, then re-run");
});

test("§8.5: a missing output file or trailer is rejected", () => {
  assert.match(reason(verifyCheckClaim({ exitCode: 0, commit: SHA }, null, SHA))!, /^output file not found/);
  assert.match(reason(verifyCheckClaim({ exitCode: 0, commit: SHA }, "$ make\nall good\n", SHA))!, /^no \[helm-exit:…\] trailer/);
});

test("a valid check on an older commit is recorded (it just won't count toward the current HEAD)", () => {
  const r = verifyCheckClaim({ exitCode: 0, commit: SHA }, out(0), SHA2);
  assert.equal(r.ok, true);
  assert.equal(verifyCheckClaim({ exitCode: 0, commit: SHA }, out(0), null).ok, true);
});

// ───────────────────────────── checks.json ─────────────────────────────

test("parseChecksJson accepts a real declaration and refuses non-objects", () => {
  const real = { build: { command: "npm run build", tier: "local", timeoutSec: 900, category: "build" }, "ci-windows": { command: "see .github/workflows/win.yml", tier: "ci" } };
  assert.deepEqual(parseChecksJson(JSON.stringify(real)), real);
  assert.equal(parseChecksJson(null), null);
  assert.equal(parseChecksJson(""), null);
  assert.equal(parseChecksJson("{not json"), null);
  assert.equal(parseChecksJson("[]"), null);
  assert.equal(parseChecksJson("null"), null);
  assert.equal(parseChecksJson("42"), null);
  assert.equal(parseChecksJson('"build"'), null);
});

test("the seeded skeleton parses, but every local command is a placeholder the lead must replace", () => {
  // parseChecksJson only parses; placeholder refusal is the engine's job (gates.ts, PLACEHOLDER_CMD).
  const decl = parseChecksJson(CHECKS_JSON_SKELETON)!;
  assert.deepEqual(Object.keys(decl), ["build", "lint", "tests", "slop-scan"]);
  assert.ok(Object.values(decl).every((d) => (d.tier ?? "local") === "local"));
  for (const n of ["build", "lint", "tests"]) assert.match(decl[n].command, /^echo 'set the/);
  // With nothing recorded, the skeleton's four local checks are all missing.
  assert.deepEqual(missingChecks(decl, [], SHA), { missing: ["build", "lint", "tests", "slop-scan"], failing: [] });
});

test.todo("parseChecksJson should reject (or drop) entries that are not {command: string} objects — `{\"build\": null}` makes missingChecks throw");

// ───────────────────────────── missingChecks ─────────────────────────────

test("missingChecks: only local checks count; a pass on HEAD clears, a fail on HEAD is failing", () => {
  const decl = parseChecksJson(JSON.stringify({ build: { command: "b" }, tests: { command: "t", tier: "local" }, lint: { command: "l" }, win: { command: "w", tier: "ci" }, off: { command: "x", tier: "none" } }));
  const rec = [
    { name: "build", exitCode: 0, commitSha: SHA },
    { name: "tests", exitCode: 1, commitSha: SHA },
    { name: "lint", exitCode: 0, commitSha: SHA2 }, // green, but on another commit
  ];
  assert.deepEqual(missingChecks(decl, rec, SHA), { missing: ["lint"], failing: ["tests"] });
  // a later pass at the same HEAD clears the failure
  assert.deepEqual(missingChecks(decl, [...rec, { name: "tests", exitCode: 0, commitSha: SHA }, { name: "lint", exitCode: 0, commitSha: SHA }], SHA), { missing: [], failing: [] });
  // rows without a commit never count
  assert.deepEqual(missingChecks(decl, [{ name: "build", exitCode: 0, commitSha: null }], SHA).missing, ["build", "tests", "lint"]);
  // a null exit code is not a pass
  assert.deepEqual(missingChecks(decl, [{ name: "build", exitCode: null, commitSha: SHA }], SHA).failing, ["build"]);
});

test("missingChecks with no checks.json falls back to build + tests", () => {
  assert.deepEqual(missingChecks(null, [], SHA), { missing: ["build", "tests"], failing: [] });
  assert.deepEqual(missingChecks(null, [{ name: "build", exitCode: 0, commitSha: SHA.slice(0, 7) }, { name: "tests", exitCode: 0, commitSha: SHA }], SHA), { missing: [], failing: [] });
});

test("§5.2: a record on a different commit that merely shares HEAD's 7-char prefix does not count", () => {
  const sibling = SHA.slice(0, 7) + "0".repeat(33);
  assert.notEqual(sibling, SHA);
  assert.deepEqual(missingChecks(null, [{ name: "build", exitCode: 0, commitSha: sibling }, { name: "tests", exitCode: 0, commitSha: SHA }], SHA), { missing: ["build"], failing: [] });
  // a uselessly short recorded sha never matches
  assert.deepEqual(missingChecks(null, [{ name: "build", exitCode: 0, commitSha: "a" }, { name: "tests", exitCode: 0, commitSha: SHA }], SHA).missing, ["build"]);
});

// ───────────────────────────── the real wrapper ─────────────────────────────

function sh(cwd: string, cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function gitRepo(): { dir: string; head: () => string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "helm-runcheck-")));
  const git = (...a: string[]) => {
    const r = sh(dir, "git", a);
    assert.equal(r.code, 0, `git ${a.join(" ")}: ${r.err}`);
    return r.out.trim();
  };
  git("init", "-q");
  mkdirSync(join(dir, ".helm"));
  writeFileSync(join(dir, ".helm/run-check.sh"), RUN_CHECK_SH);
  chmodSync(join(dir, ".helm/run-check.sh"), 0o755);
  writeFileSync(join(dir, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return { dir, head: () => git("rev-parse", "HEAD"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("RUN_CHECK_SH: a passing command tees output and writes a trailer that verifies", (t) => {
  const repo = gitRepo();
  t.after(repo.cleanup);
  const r = sh(repo.dir, "bash", [".helm/run-check.sh", "build", "--", "echo", "compiled 3 files"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /compiled 3 files/);
  const file = readFileSync(join(repo.dir, "reports/checks/build.txt"), "utf8");
  const lines = file.trimEnd().split("\n");
  assert.equal(lines[0], "$ echo compiled 3 files");
  assert.equal(lines[1], "compiled 3 files");
  const tr = parseTrailer(file);
  assert.ok(tr, file);
  assert.equal(tr.exitCode, 0);
  assert.equal(tr.commit, repo.head());
  assert.equal(tr.dirty, false, "an untracked reports/ file does not make the tree dirty");
  assert.ok(Math.abs(tr.ts - Date.now() / 1000) < 120);
  assert.equal(verifyCheckClaim({ exitCode: 0, commit: repo.head() }, file, repo.head()).ok, true);
});

test("RUN_CHECK_SH: a failing command keeps its exit code, stderr is captured", (t) => {
  const repo = gitRepo();
  t.after(repo.cleanup);
  const r = sh(repo.dir, "bash", [".helm/run-check.sh", "tests", "--", "bash", "-c", "echo 2 failing >&2; exit 3"]);
  assert.equal(r.code, 3);
  const file = readFileSync(join(repo.dir, "reports/checks/tests.txt"), "utf8");
  assert.match(file, /2 failing/);
  assert.equal(parseTrailer(file)?.exitCode, 3);
  assert.equal(reason(verifyCheckClaim({ exitCode: 0, commit: repo.head() }, file, repo.head())), "you claimed exit 0 but the trailer says 3");
  assert.equal(verifyCheckClaim({ exitCode: 3, commit: repo.head() }, file, repo.head()).ok, true);
});

test("RUN_CHECK_SH: uncommitted changes mark the trailer dirty; changes under reports/ do not", (t) => {
  const repo = gitRepo();
  t.after(repo.cleanup);
  // a committed report that the wrapper overwrites is not "dirty"
  sh(repo.dir, "bash", [".helm/run-check.sh", "lint", "--", "true"]);
  assert.equal(sh(repo.dir, "git", ["add", "-A"]).code, 0);
  assert.equal(sh(repo.dir, "git", ["commit", "-q", "-m", "reports"]).code, 0);
  sh(repo.dir, "bash", [".helm/run-check.sh", "lint", "--", "true"]);
  assert.equal(parseTrailer(readFileSync(join(repo.dir, "reports/checks/lint.txt"), "utf8"))?.dirty, false);
  // a modified tracked source file is
  writeFileSync(join(repo.dir, "README.md"), "changed\n");
  const r = sh(repo.dir, "bash", [".helm/run-check.sh", "lint", "--", "true"]);
  assert.equal(r.code, 0);
  const file = readFileSync(join(repo.dir, "reports/checks/lint.txt"), "utf8");
  assert.equal(parseTrailer(file)?.dirty, true);
  assert.match(reason(verifyCheckClaim({ exitCode: 0, commit: repo.head() }, file, repo.head()))!, /dirty worktree/);
});

test("RUN_CHECK_SH: usage errors exit 64 without a report", (t) => {
  const repo = gitRepo();
  t.after(repo.cleanup);
  const noCmd = sh(repo.dir, "bash", [".helm/run-check.sh", "build", "--"]);
  assert.equal(noCmd.code, 64);
  assert.match(noCmd.err, /no command given/);
  const bad = sh(repo.dir, "bash", [".helm/run-check.sh", "../evil", "--", "true"]);
  assert.equal(bad.code, 64);
  assert.match(bad.err, /bad check name/);
  // without "--" the command still runs
  assert.equal(sh(repo.dir, "bash", [".helm/run-check.sh", "plain", "true"]).code, 0);
  assert.ok(parseTrailer(readFileSync(join(repo.dir, "reports/checks/plain.txt"), "utf8")));
});

test("RUN_CHECK_SH: outside a git repo the trailer says commit:none and never verifies", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "helm-runcheck-nogit-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (sh(dir, "git", ["rev-parse", "--show-toplevel"]).code === 0) return t.skip("tmpdir is inside a git repo");
  writeFileSync(join(dir, "run-check.sh"), RUN_CHECK_SH);
  const r = sh(dir, "bash", ["run-check.sh", "build", "--", "true"]);
  assert.equal(r.code, 0);
  const file = readFileSync(join(dir, "reports/checks/build.txt"), "utf8");
  assert.equal(parseTrailer(file)?.commit, "none");
  assert.equal(verifyCheckClaim({ exitCode: 0, commit: SHA }, file, SHA).ok, false);
});
