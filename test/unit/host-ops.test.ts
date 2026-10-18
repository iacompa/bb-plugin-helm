import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHostOps, safeRef, safeRelPath } from "../../src/host/ops.ts";
import { RUN_CHECK_SH, CHECKS_JSON_SKELETON, GITIGNORE, parseTrailer } from "../../src/server/domain/checks.ts";

const ops = createHostOps();
const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "helm-host-"));

test("ensureRepo: git init + initial commit with the wrapper; idempotent; never overwrites", async () => {
  const dir = join(tmp(), "app");
  const files = [
    { path: ".helm/run-check.sh", content: RUN_CHECK_SH, executable: true },
    { path: ".helm/checks.json", content: CHECKS_JSON_SKELETON },
    { path: ".gitignore", content: GITIGNORE },
    { path: "BRIEF.md", content: "# Brief\n" },
  ];
  const a = await ops.ensureRepo({ path: dir, files, message: "Helm: initial commit" });
  assert.equal(a.created, true);
  assert.match(a.head!, /^[0-9a-f]{40}$/);
  assert.equal(a.branch, "main");
  writeFileSync(join(dir, "BRIEF.md"), "# Edited by the lead\n");
  execFileSync("git", ["commit", "-qam", "edit"], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  const b = await ops.ensureRepo({ path: dir, files, message: "again" });
  assert.equal(b.created, false);
  assert.equal((await ops.fileAt({ repo: dir, ref: "HEAD", path: "BRIEF.md" })).content, "# Edited by the lead\n");
  await assert.rejects(ops.ensureRepo({ path: dir, files: [{ path: "../escape.txt", content: "x" }], message: "x" }));
});

test("the evidence wrapper writes a verifiable trailer", async () => {
  const dir = join(tmp(), "app");
  await ops.ensureRepo({ path: dir, files: [{ path: ".helm/run-check.sh", content: RUN_CHECK_SH, executable: true }, { path: ".gitignore", content: "reports/\n" }], message: "init" });
  let code = 0;
  try {
    execFileSync("bash", [".helm/run-check.sh", "unit", "--", "bash", "-c", "echo hi; exit 3"], { cwd: dir, stdio: "pipe" });
  } catch (e) {
    code = (e as { status: number }).status;
  }
  assert.equal(code, 3);
  const out = (await ops.readFile({ path: join(dir, "reports/checks/unit.txt") })).content!;
  const t = parseTrailer(out)!;
  assert.equal(t.exitCode, 3);
  assert.equal(t.commit, (await ops.revParse({ repo: dir, ref: "HEAD" })).sha);
  assert.equal(t.dirty, false);
});

test("revParse / isAncestor / status / log", async () => {
  const dir = join(tmp(), "r");
  const { head } = await ops.ensureRepo({ path: dir, files: [{ path: "a.txt", content: "a\n" }], message: "one" });
  writeFileSync(join(dir, "b.txt"), "b\n");
  const st = await ops.status({ path: dir });
  assert.equal(st.clean, false);
  assert.deepEqual(st.dirty, ["b.txt"]);
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "two"], { cwd: dir });
  const h2 = (await ops.revParse({ repo: dir, ref: "HEAD" })).sha!;
  assert.equal((await ops.isAncestor({ repo: dir, ancestor: head!, descendant: h2 })).ok, true);
  assert.equal((await ops.isAncestor({ repo: dir, ancestor: h2, descendant: head! })).ok, false);
  assert.equal((await ops.revParse({ repo: dir, ref: "nope" })).sha, null);
  assert.equal((await ops.revParse({ repo: dir, ref: "--all" })).sha, null);
  const log = await ops.log({ repo: dir, ref: "HEAD", limit: 5 });
  assert.deepEqual(log.commits.map((c) => c.subject), ["two", "one"]);
});

test("scan at a commit finds planted slop and history secrets", async () => {
  const dir = join(tmp(), "s");
  mkdirSync(join(dir, "src"), { recursive: true });
  await ops.ensureRepo({
    path: dir,
    files: [
      { path: "package.json", content: JSON.stringify({ name: "x", dependencies: { react: "1" } }) },
      { path: "src/app.ts", content: "import React from 'react';\nimport { magic } from 'left-padder-pro';\n// TODO: wire this up\nexport const x = 1;\n" },
    ],
    message: "init",
  });
  const r = await ops.scan({ repo: dir, ref: "HEAD", history: true });
  const rules = new Set(r.findings.map((f) => f.rule));
  assert.ok(rules.has("S1"), JSON.stringify(r.findings));
  assert.ok(rules.has("S3"), JSON.stringify(r.findings));
  assert.match(r.commit!, /^[0-9a-f]{40}$/);
});

test("ref and path sanitizers refuse option-like and escaping input", () => {
  assert.equal(safeRef("--output=/tmp/x"), null);
  assert.equal(safeRef("a..b"), null);
  assert.equal(safeRef("main"), "main");
  assert.equal(safeRef("helm/lumen/integration"), "helm/lumen/integration");
  assert.equal(safeRelPath("../x"), null);
  assert.equal(safeRelPath("/etc/passwd"), null);
  assert.equal(safeRelPath("./src/a.ts"), "src/a.ts");
});

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();

test("adoptRepo on a real repository (emoji, apostrophe and spaces in the path): a branch at HEAD, nothing else changes", async () => {
  const dir = join(tmp(), "💾My Disk's SSD X1", "app builds", "tide");
  mkdirSync(dir, { recursive: true });
  g(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# Tide\n");
  g(dir, "add", "-A");
  g(dir, "commit", "-qm", "human: init");
  writeFileSync(join(dir, "README.md"), "# Tide (unsaved edit)\n");
  writeFileSync(join(dir, "WIP.txt"), "untracked work\n");
  const before = { head: g(dir, "rev-parse", "HEAD"), status: g(dir, "status", "--porcelain"), branch: g(dir, "rev-parse", "--abbrev-ref", "HEAD") };

  const info = await ops.inspectPath({ path: dir });
  assert.equal(info.isDir, true);
  assert.ok(info.gitRoot && info.gitRoot === info.path, `${info.gitRoot} vs ${info.path}`);
  assert.equal(info.branch, "main");
  assert.equal(info.dirty, 2);

  const a = await ops.adoptRepo({ path: dir, branch: "helm/tide-work-abc123/tide", files: [], message: "Helm: start" });
  assert.equal(a.created, true);
  assert.equal(a.head, before.head, "no commit: the Helm branch is the human's HEAD");
  assert.equal(a.base, before.head);
  assert.equal(a.userBranch, "main");
  assert.equal(g(dir, "rev-parse", "helm/tide-work-abc123/tide"), before.head);
  // the human's checkout is exactly as it was
  assert.equal(g(dir, "rev-parse", "HEAD"), before.head);
  assert.equal(g(dir, "rev-parse", "--abbrev-ref", "HEAD"), before.branch);
  assert.equal(g(dir, "status", "--porcelain"), before.status);
  // idempotent
  const again = await ops.adoptRepo({ path: dir, branch: "helm/tide-work-abc123/tide", files: [], message: "x" });
  assert.equal(again.created, false);
  // files, when given, go only into a new commit on the Helm branch (private index), never the checkout
  const b = await ops.adoptRepo({ path: dir, branch: "helm/other/tide", files: [{ path: ".helm/x.json", content: "{}\n" }, { path: "README.md", content: "overwrite?" }], message: "Helm: files" });
  assert.notEqual(b.head, before.head);
  assert.equal(g(dir, "show", `${b.head}:.helm/x.json`), "{}");
  assert.equal(g(dir, "show", `${b.head}:README.md`), "# Tide", "an existing file is never overwritten");
  assert.equal(g(dir, "status", "--porcelain"), before.status, "the human's index and working tree are untouched");
  await assert.rejects(ops.adoptRepo({ path: dir, branch: "-bad", files: [], message: "x" }));
});

test("inspectPath on a linked worktree reports the worktree as its own top folder; a sub-folder points at its repository", async () => {
  const root = join(tmp(), "ia");
  const main = join(root, "lumen");
  mkdirSync(main, { recursive: true });
  g(main, "init", "-q", "-b", "main");
  writeFileSync(join(main, "a.txt"), "a\n");
  g(main, "add", "-A");
  g(main, "commit", "-qm", "init");
  const wt = join(root, ".worktrees", "lumen-T-01");
  g(main, "worktree", "add", "-q", "-b", "T-01", wt);
  const w = await ops.inspectPath({ path: wt });
  assert.equal(w.gitRoot, w.path, "a linked worktree can be adopted directly");
  assert.equal(w.branch, "T-01");
  const a = await ops.adoptRepo({ path: wt, branch: "helm/r/lumen", files: [], message: "x" });
  assert.equal(a.userBranch, "T-01");
  assert.equal(g(main, "rev-parse", "helm/r/lumen"), g(wt, "rev-parse", "HEAD"));
  mkdirSync(join(main, "sub"));
  const sub = await ops.inspectPath({ path: join(main, "sub") });
  assert.ok(sub.gitRoot && sub.gitRoot !== sub.path, "a folder inside a repository is not its own repository");
  const none = await ops.inspectPath({ path: join(root, "nope") });
  assert.equal(none.exists, false);
  assert.equal(none.writable, true);
  assert.equal(none.enclosingRepo ?? null, null);
  const nested = await ops.inspectPath({ path: join(main, "not", "yet") });
  assert.equal(nested.exists, false);
  assert.ok(nested.enclosingRepo && nested.enclosingRepo.endsWith("/lumen"), "a missing folder inside a repository names that repository");
});

test("inspectPath never rewrites the index of the human's repository (no optional locks)", async () => {
  const dir = join(tmp(), "human");
  mkdirSync(dir);
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "a\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir, env });
  // make the index's stat data stale (same content, new mtime): a plain `git status` would refresh and rewrite it
  const later = new Date(Date.now() + 5_000);
  utimesSync(join(dir, "a.txt"), later, later);
  const before = statSync(join(dir, ".git", "index")).mtimeMs;
  const info = await ops.inspectPath({ path: dir });
  assert.equal(info.dirty, 0);
  assert.equal(statSync(join(dir, ".git", "index")).mtimeMs, before, "the index was not written");
  // control: without the guard, git does rewrite it, so the assertion above means something
  execFileSync("git", ["status", "--porcelain"], { cwd: dir, env: { ...process.env, GIT_OPTIONAL_LOCKS: "1" } });
  assert.notEqual(statSync(join(dir, ".git", "index")).mtimeMs, before, "control: plain git status refreshes the index");
});

test("ensureWorktree: one work worktree beside the repository on its branch; idempotent; refuses a busy branch or a full folder; worktrees lists them", async () => {
  const root = tmp();
  const repo = join(root, "app");
  await ops.ensureRepo({ path: repo, files: [{ path: "README.md", content: "# App\n" }], message: "init" });
  const work = join(root, ".helm-work", "app");
  const a = await ops.ensureWorktree({ repo, path: work, branch: "helm/run/app", base: "HEAD" });
  assert.equal(a.created, true);
  assert.equal(a.branch, "helm/run/app");
  assert.match(a.head!, /^[0-9a-f]{40}$/);
  const b = await ops.ensureWorktree({ repo, path: work, branch: "helm/run/app", base: "HEAD" });
  assert.equal(b.created, false);
  assert.equal(b.path, a.path);
  // the same folder on another branch, a branch held elsewhere, a folder with files: refused
  await assert.rejects(ops.ensureWorktree({ repo, path: work, branch: "other", base: "HEAD" }), /is a worktree on helm\/run\/app/);
  await assert.rejects(ops.ensureWorktree({ repo, path: join(root, "second"), branch: "helm/run/app", base: "HEAD" }), /checked out in/);
  mkdirSync(join(root, "full"));
  writeFileSync(join(root, "full", "x.txt"), "x");
  await assert.rejects(ops.ensureWorktree({ repo, path: join(root, "full"), branch: "fresh", base: "HEAD" }), /exists and is not empty/);
  await assert.rejects(ops.ensureWorktree({ repo, path: join(root, "w"), branch: "bad..name", base: "HEAD" }), /refusing branch/);

  writeFileSync(join(a.path, "README.md"), "# changed\n");
  const { worktrees } = await ops.worktrees({ repo });
  assert.equal(worktrees.length, 2, "the checkout and the work worktree");
  assert.equal(worktrees[0].main, true);
  assert.equal(worktrees[0].branch, "main");
  assert.equal(worktrees[1].path, a.path);
  assert.equal(worktrees[1].branch, "helm/run/app");
  assert.equal(worktrees[1].dirty, 1);
  assert.equal((await ops.worktrees({ repo, status: false })).worktrees[1].dirty, 0, "status skipped");
});
