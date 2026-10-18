// The GitHub view's host side: what a remote has compared with this computer, from `git ls-remote`
// only (nothing downloaded). Tested against a bare repository standing in for GitHub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanUrl, createRemoteOps, webUrl } from "../../src/host/remote.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const commit = (cwd: string, file: string) => {
  writeFileSync(join(cwd, file), file);
  git(cwd, "add", file);
  git(cwd, "commit", "-qm", file);
};

test("remote addresses: credentials are dropped and the web page is found", () => {
  assert.equal(cleanUrl("https://user:secret@github.com/o/r.git"), "https://github.com/o/r.git");
  assert.equal(webUrl("https://x-access-token:abc@github.com/o/r.git"), "https://github.com/o/r");
  assert.equal(webUrl("git@github.com:o/r.git"), "https://github.com/o/r");
  assert.equal(webUrl("ssh://git@gitlab.com:22/g/sub/r.git"), "https://gitlab.com/g/sub/r");
  assert.equal(webUrl("/Volumes/Backup/r.git"), null);
});

test("remoteStatus: same, ahead, newer, only here and only on the remote, without fetching", async () => {
  const root = mkdtempSync(join(tmpdir(), "helm-remote-"));
  const bare = join(root, "remote.git");
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  const a = join(root, "a");
  git(root, "init", "-q", "-b", "main", a);
  commit(a, "one");
  git(a, "remote", "add", "origin", bare);
  git(a, "push", "-q", "origin", "main");
  git(a, "branch", "work");
  git(a, "push", "-q", "origin", "work");
  // ahead: a commit on work not pushed
  git(a, "checkout", "-q", "work");
  commit(a, "two");
  // only here, with one unpushed commit; only here with nothing unpushed
  git(a, "checkout", "-q", "-b", "bb/agent");
  commit(a, "three");
  git(a, "branch", "spec", "main");
  git(a, "checkout", "-q", "main");
  // newer: another clone pushes to main; only on the remote: another branch
  const b = join(root, "b");
  git(root, "clone", "-q", bare, b);
  commit(b, "four");
  git(b, "push", "-q", "origin", "main");
  git(b, "push", "-q", "origin", "main:feature");

  const r = await createRemoteOps().remoteStatus({ repo: a });
  assert.equal(r.error, null);
  assert.equal(r.remote, "origin");
  assert.equal(r.defaultBranch, "main");
  const by = Object.fromEntries(r.branches.map((x) => [x.name, x]));
  assert.equal(by.work.state, "ahead");
  assert.equal(by.work.ahead, 1);
  assert.equal(by.main.state, "newer", "the remote's commit was never downloaded");
  assert.equal(by["bb/agent"].state, "local");
  assert.equal(by["bb/agent"].ahead, 2, "two commits on no remote branch (two and three)");
  assert.equal(by.spec.state, "local");
  assert.equal(by.spec.ahead, 0, "its commit is on the remote already");
  assert.equal(by.feature.state, "remote");
  // nothing was downloaded
  assert.throws(() => git(a, "cat-file", "-e", `${by.main.remote}^{commit}`));
  // no remote at all
  const c = join(root, "c");
  git(root, "init", "-q", "-b", "main", c);
  commit(c, "x");
  const none = await createRemoteOps().remoteStatus({ repo: c });
  assert.equal(none.remote, null);
  assert.deepEqual(none.branches.map((x) => [x.name, x.state, x.ahead]), [["main", "local", 1]]);
  // a folder that is gone
  assert.match((await createRemoteOps().remoteStatus({ repo: join(root, "gone") })).error ?? "", /repository folder is missing/);
});
