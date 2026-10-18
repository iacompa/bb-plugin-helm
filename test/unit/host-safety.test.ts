// Host safety: what agents can leave in their folders (links, repository config, crafted files)
// must not make Helm's unsandboxed host process write elsewhere, run programs, lose work or hang.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHostOps, parseStatusZ } from "../../src/host/ops.ts";
import { cleanUrl, lsRemoteTarget, safeRemoteName } from "../../src/host/remote.ts";
import { filterOverrides } from "../../src/host/git-env.ts";
import { scan } from "../../src/server/domain/slop/scan.ts";
import { emptyBodyEnd, redactSecrets } from "../../src/server/domain/slop/rules.ts";
import { quoteNear } from "../../src/server/domain/verdict.ts";

const ops = createHostOps();
const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "helm-safe-"));
const G = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: G, stdio: "pipe" }).toString();

test("writeFile replaces a link left at the path instead of writing through it, and honours root", async () => {
  const dir = tmp();
  const outside = join(dir, "outside.txt");
  writeFileSync(outside, "keep me\n");
  const studio = join(dir, "studio");
  mkdirSync(join(studio, "briefs"), { recursive: true });
  const brief = join(studio, "briefs", "a.md");
  symlinkSync(outside, brief);
  await ops.writeFile({ path: brief, content: "# Brief\n" });
  assert.equal(readFileSync(outside, "utf8"), "keep me\n", "the link's target is untouched");
  assert.equal(lstatSync(brief).isSymbolicLink(), false);
  assert.equal(readFileSync(brief, "utf8"), "# Brief\n");
  // a folder link that leaves the root is refused when the server names the root
  symlinkSync(dir, join(studio, "escape"));
  await assert.rejects(ops.writeFile({ path: join(studio, "escape", "x.md"), content: "x", root: studio }), /resolves outside/);
  assert.equal(existsSync(join(dir, "x.md")), false);
  assert.deepEqual(await ops.writeFile({ path: join(studio, "briefs", "b.md"), content: "b", root: studio }), { ok: true });
});

test("readFile does not follow a link at the path unless it stays inside root", async () => {
  const dir = tmp();
  const secret = join(dir, "secret.txt");
  writeFileSync(secret, "token\n");
  const wt = join(dir, "wt");
  mkdirSync(join(wt, "reports"), { recursive: true });
  symlinkSync(secret, join(wt, "reports", "out.txt"));
  assert.equal((await ops.readFile({ path: join(wt, "reports", "out.txt") })).content, null);
  assert.equal((await ops.readFile({ path: join(wt, "reports", "out.txt"), root: wt })).content, null);
  writeFileSync(join(wt, "reports", "real.txt"), "ok\n");
  symlinkSync(join(wt, "reports", "real.txt"), join(wt, "reports", "alias.txt"));
  assert.equal((await ops.readFile({ path: join(wt, "reports", "alias.txt"), root: wt })).content, "ok\n");
  assert.equal((await ops.readFile({ path: join(wt, "reports", "real.txt") })).content, "ok\n");
});

test("ensureRepo never writes through a dangling link at a scaffold path", async () => {
  const dir = tmp();
  const repo = join(dir, "app");
  mkdirSync(repo);
  const target = join(dir, "planted.txt");
  symlinkSync(target, join(repo, "BRIEF.md"));
  await ops.ensureRepo({ path: repo, files: [{ path: "BRIEF.md", content: "# Brief\n" }, { path: "a.txt", content: "a\n" }], message: "init" });
  assert.equal(existsSync(target), false, "nothing was created at the link's target");
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "a\n");
});

test("status: a failure is never clean; renames and unusual names parse; a missing folder says so", async () => {
  const dir = tmp();
  const notRepo = join(dir, "plain");
  mkdirSync(notRepo);
  const bad = await ops.status({ path: notRepo });
  assert.equal(bad.clean, false);
  assert.match(bad.error ?? "", /git status failed/);
  assert.equal((await ops.status({ path: join(dir, "gone") })).missing, true);

  const repo = join(dir, "r");
  await ops.ensureRepo({ path: repo, files: [{ path: "old name.txt", content: "a\n" }], message: "one" });
  gitIn(repo, "mv", "old name.txt", "new name.txt");
  writeFileSync(join(repo, "café.txt"), "x\n");
  const st = await ops.status({ path: repo });
  assert.deepEqual([...st.dirty].sort(), ["café.txt", "new name.txt"]);
  assert.deepEqual(parseStatusZ("R  new\0old\0?? b\0"), ["new", "b"]);
});

test("repository config cannot make host git run programs (fsmonitor, upload-pack, ext::)", async () => {
  const dir = tmp();
  const marker = join(dir, "ran");
  const hook = join(dir, "hook.sh");
  writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`);
  chmodSync(hook, 0o755);
  const upstream = join(dir, "upstream");
  await ops.ensureRepo({ path: upstream, files: [{ path: "a.txt", content: "a\n" }], message: "one" });
  const repo = join(dir, "repo");
  execFileSync("git", ["clone", "-q", upstream, repo], { env: G, stdio: "pipe" });
  gitIn(repo, "config", "core.fsmonitor", hook);
  await ops.status({ path: repo });
  await ops.worktrees({ repo, status: true });
  assert.equal(existsSync(marker), false, "the fsmonitor hook did not run");
  gitIn(repo, "config", "remote.origin.uploadpack", `${hook}; git-upload-pack`);
  const rs = await ops.remoteStatus({ repo });
  assert.equal(existsSync(marker), false, "the configured upload-pack did not run");
  assert.equal(rs.error, null, "the remote is still read with the stock upload-pack");
  assert.ok(rs.branches.some((b) => b.name === "main" && b.state === "synced"));
  gitIn(repo, "config", "protocol.ext.allow", "always");
  gitIn(repo, "remote", "set-url", "origin", `ext::sh -c touch% ${marker}`);
  await ops.remoteStatus({ repo });
  assert.equal(existsSync(marker), false, "ext:: stays disabled");
  assert.equal(safeRemoteName("origin"), true);
  assert.equal(safeRemoteName("--upload-pack=x"), false);
  assert.equal(safeRemoteName("a/../b"), false);
});

test("a repository's own hooks and filter drivers do not run in Helm's git; its remote is read from outside it", async () => {
  const dir = tmp();
  const marker = join(dir, "ran");
  const prog = join(dir, "prog.sh");
  writeFileSync(prog, `#!/bin/sh\necho "$0 $*" >> "${marker}"\ncat\n`);
  chmodSync(prog, 0o755);
  const upstream = join(dir, "upstream");
  await ops.ensureRepo({ path: upstream, files: [{ path: ".gitattributes", content: "*.txt filter=evil\n*.md filter=odd one\n" }, { path: "a.txt", content: "hello\n" }], message: "one" });
  const repo = join(dir, "repo");
  execFileSync("git", ["clone", "-q", upstream, repo], { env: G, stdio: "pipe" });
  for (const h of ["post-checkout", "reference-transaction", "pre-commit", "post-commit"]) {
    writeFileSync(join(repo, ".git", "hooks", h), `#!/bin/sh\necho hook-${h} >> "${marker}"\n`);
    chmodSync(join(repo, ".git", "hooks", h), 0o755);
  }
  gitIn(repo, "config", "filter.evil.smudge", prog);
  gitIn(repo, "config", "filter.evil.clean", prog);
  gitIn(repo, "config", "filter.evil.required", "true");
  // a driver from an included file counts as the repository's too
  writeFileSync(join(dir, "inc.cfg"), `[filter "odd one"]\n\tprocess = ${prog}\n`);
  gitIn(repo, "config", "include.path", join(dir, "inc.cfg"));
  const w = await ops.ensureWorktree({ repo, path: join(dir, "w"), branch: "b1", base: "HEAD" });
  assert.equal(w.created, true);
  assert.equal(readFileSync(join(dir, "w", "a.txt"), "utf8"), "hello\n", "checked out as committed");
  execFileSync("touch", ["-t", "202001010000", join(dir, "w", "a.txt")]);
  await ops.status({ path: join(dir, "w") });
  await ops.worktrees({ repo, status: true });
  assert.equal(existsSync(marker) ? readFileSync(marker, "utf8") : "", "", "no hook or filter ran");
  // the remote is read from an empty folder: a relative address still resolves against the repository
  gitIn(repo, "remote", "set-url", "origin", "../upstream");
  const rs = await ops.remoteStatus({ repo });
  assert.equal(rs.error, null);
  assert.ok(rs.branches.some((b) => b.name === "main" && b.state === "synced"));
  // an address that could pass for an option (git's own commands refuse to set one)
  writeFileSync(join(repo, ".git", "config"), readFileSync(join(repo, ".git", "config"), "utf8") + `[remote "evil"]\n\turl = --upload-pack=${prog}\n`);
  assert.match((await ops.remoteStatus({ repo, remote: "evil" })).error ?? "", /no usable address/);
  assert.equal(existsSync(marker), false);
});

test("filterOverrides switches off the repository's own drivers, keeps stock Git LFS and global ones, and refuses names -c cannot carry", () => {
  const L = (...e: [string, string, string][]) => e.map(([sc, k, v]) => `${sc}\0${k}\n${v}\0`).join("");
  assert.deepEqual(filterOverrides(""), []);
  assert.deepEqual(filterOverrides(L(["global", "filter.lfs.process", "git-lfs filter-process"], ["local", "filter.lfs.smudge", "git-lfs smudge -- %f"], ["local", "filter.lfs.process", "git-lfs filter-process --skip"], ["global", "filter.crypt.clean", "/usr/local/bin/x"])), []);
  assert.deepEqual(filterOverrides(L(["local", "filter.evil.smudge", "/x"], ["worktree", "filter.a b.clean", "y"], ["local", "filter.evil.clean", "/x"])), [
    "-c", "filter.evil.process=", "-c", "filter.evil.smudge=", "-c", "filter.evil.clean=", "-c", "filter.evil.required=false",
    "-c", "filter.a b.process=", "-c", "filter.a b.smudge=", "-c", "filter.a b.clean=", "-c", "filter.a b.required=false",
  ]);
  // a stock LFS command does not excuse another key of the same driver
  assert.equal((filterOverrides(L(["local", "filter.lfs.process", "git-lfs filter-process"], ["local", "filter.lfs.clean", "/x"])) as string[]).length, 8);
  assert.match((filterOverrides(L(["local", "filter.a=b.smudge", "/x"])) as { error: string }).error, /cannot switch off/);
  // git without --show-scope: every driver counts as the repository's
  assert.equal((filterOverrides("filter.mine.clean\n/x\0", false) as string[]).length, 8);
  assert.equal(lsRemoteTarget("https://github.com/o/r.git", "/r"), "https://github.com/o/r.git");
  assert.equal(lsRemoteTarget("git@github.com:o/r.git\n", "/r"), "git@github.com:o/r.git");
  assert.equal(lsRemoteTarget("/srv/r.git", "/r"), "/srv/r.git");
  assert.equal(lsRemoteTarget("../up", "/a/r"), resolve("/a/r", "../up"));
  assert.equal(lsRemoteTarget("-u x", "/r"), null);
});

test("credentials are removed from remote addresses even when the password holds / or @", () => {
  assert.equal(cleanUrl("https://user:pa/ss@github.com/o/r.git"), "https://github.com/o/r.git");
  assert.equal(cleanUrl("https://user:p@ss@github.com/o/r.git"), "https://github.com/o/r.git");
  assert.equal(cleanUrl("ssh://git@gitlab.com:22/g/r.git"), "ssh://gitlab.com:22/g/r.git");
  assert.equal(cleanUrl("git@github.com:o/r.git"), "git@github.com:o/r.git");
  assert.equal(cleanUrl("https://github.com/o/r.git"), "https://github.com/o/r.git");
});

test("scan reads files whose names git would quote", async () => {
  const dir = tmp();
  const repo = join(dir, "r");
  await ops.ensureRepo({ path: repo, files: [{ path: "src/clé.ts", content: 'export const k = "AKIAABCDEFGHIJKLMNOP";\n' }], message: "one" });
  const res = await ops.scan({ repo, ref: "HEAD" });
  const hit = res.findings.find((f) => f.ruleId === "S6-token");
  assert.equal(hit?.path, "src/clé.ts");
  assert.doesNotMatch(hit!.quote, /AKIAABCDEFGHIJKLMNOP/, "the secret is not in the quote");
});

test("S6 quotes are redacted, and a gate quoting the redacted line still validates", () => {
  const line = 'const stripeKey = "sk_live_abcdefgh12345678";';
  const r = redactSecrets(line);
  assert.equal(r, 'const stripeKey = "<redacted: 24 chars>";');
  assert.equal(redactSecrets(r), r, "idempotent");
  assert.equal(redactSecrets("DATABASE_URL=postgres://u:p@h/db"), "DATABASE_URL=<redacted: 19 chars>");
  const res = scan({ files: [{ path: "src/pay.ts", content: `export function pay() {}\n${line}\n` }, { path: ".env", content: "API_TOKEN=abc123def456\n" }] });
  for (const f of res.findings.filter((x) => x.rule === "S6")) assert.match(f.quote, /<redacted: \d+ chars>/, f.ruleId);
  assert.equal(quoteNear(`a\n${line}\n`, 2, r), true);
  assert.equal(quoteNear(`a\n${line}\n`, 2, line), true, "the raw line still matches");
  assert.equal(quoteNear(`a\nconst other = "sk_live_zzzzzzzz99999999x";\n`, 2, r), false);
});

test("the scanner stays linear on crafted input (empty catch, long lines, blank Kotlin)", () => {
  const cases: Array<[string, string]> = [
    ["src/a.ts", "catch{/*".repeat(20_000)],
    ["src/b.ts", "catch" + " ".repeat(150_000) + "x"],
    ["src/c.ts", "catch (".repeat(20_000)],
    ["src/d.ts", ".catch(( ".repeat(20_000)],
    ["src/e.py", "a".repeat(300_000)],
    ["src/f.ts", "a.".repeat(150_000)],
    ["src/g.kt", "\n".repeat(150_000)],
  ];
  for (const [path, content] of cases) {
    const t = performance.now();
    scan({ files: [{ path, content }] });
    const ms = performance.now() - t;
    assert.ok(ms < 1500, `${path}: ${ms.toFixed(0)} ms`);
  }
});

test("empty catch bodies are still found (comments only), and bodies with code are not", () => {
  const src = [
    "try { a() } catch (e) {",
    "  // ignore",
    "}",
    "try { b() } catch (e) { /* ignore */ }",
    "try { c() } catch (e) { log(e) }",
    "p.catch((err) => { /* swallowed */ })",
    "q.catch(() => { report() })",
    "try { d() } catch (e) { // already rolled back, nothing to undo",
    "}",
  ].join("\n");
  const hits = scan({ files: [{ path: "src/x.ts", content: src }] }).findings.filter((f) => f.rule === "S12").map((f) => `${f.ruleId}:${f.line}`);
  assert.deepEqual(hits.sort(), ["S12-empty-catch:1", "S12-empty-catch:4", "S12-empty-promise-catch:6"]);
  const swift = scan({ files: [{ path: "Sources/A/B.swift", content: "do { try x() } catch let error as NSError {\n}\n" }] }).findings.filter((f) => f.rule === "S12");
  assert.equal(swift.length, 1);
  assert.equal(emptyBodyEnd("{ /* never closed", 0), -1);
  assert.equal(emptyBodyEnd("{  }", 0), 4);
  assert.equal(emptyBodyEnd("{ /* } */ }", 0), 11, "a brace inside a comment does not close the body");
});
