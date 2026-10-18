// Host side of the GitHub view: what a repository's remote (GitHub or any other) has, compared
// with this computer, without downloading anything. `git ls-remote` asks the remote only for its
// branch names and the commit each points at; commits are counted locally where both commits are
// here. Git's own login (credential helper, SSH key) is used as it is; Helm never sees or stores
// a credential, and git is never allowed to ask for one (it fails instead of waiting).

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export type RemoteBranchState = "synced" | "ahead" | "behind" | "diverged" | "newer" | "local" | "remote";

export interface RemoteBranch {
  name: string;
  /** The commit on this computer, and on the remote (null: the branch is not there). */
  local: string | null;
  remote: string | null;
  /**
   * synced (same commit) · ahead (this computer has commits the remote lacks) · behind (the remote
   * has newer commits, already known here) · diverged (both changed) · newer (the remote has commits
   * this computer has never seen) · local (only here) · remote (only on the remote).
   */
  state: RemoteBranchState;
  /** Commits here that are not on the remote; commits on the remote not here (null: cannot tell without downloading). */
  ahead: number | null;
  behind: number | null;
  /** When the local branch's last commit was made (ms). */
  at: number | null;
}

export interface RemoteStatus {
  repo: string;
  remotes: string[];
  remote: string | null;
  /** The remote's address with any user or token removed. */
  url: string | null;
  /** The repository's web page (https), when the address has one. */
  web: string | null;
  defaultBranch: string | null;
  branches: RemoteBranch[];
  /** Commits on this computer's branches that no remote branch has, each counted once (null: unknown). */
  unpushed: number | null;
  error: string | null;
}

const ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10",
};

function git(cwd: string, args: string[], timeout = 20_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    execFile("git", args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024, env: ENV, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 124) : 0;
      res({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/** "https://user:token@github.com/o/r.git" → "https://github.com/o/r.git". */
export function cleanUrl(url: string): string {
  return url.replace(/^([a-z+]+:\/\/)[^@/]+@/i, "$1");
}

/** The web page of a remote address: https://host/owner/repo (GitHub, GitLab, Bitbucket and the like); null for local folders. */
export function webUrl(url: string): string | null {
  const u = cleanUrl(url.trim());
  const scp = u.match(/^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?\/?$/);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  const std = u.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i);
  if (std) return `https://${std[1]}/${std[2]}`;
  return null;
}

/** Why the remote could not be read, in words (never with the address's credentials). */
function why(stderr: string, code: number, repo: string, remote: string): string {
  const s = stderr.toLowerCase();
  if (code === 124 || /timed out|timeout/.test(s)) return "the remote did not answer in time";
  if (/could not resolve host|network is unreachable|connection refused|unable to access/.test(s) && !/403|401/.test(s)) return "this computer could not reach the remote (offline?)";
  if (/authentication|could not read username|permission denied|403|401|terminal prompts disabled|askpass/.test(s)) return `the remote asked for a login. Run \`git -C "${repo}" ls-remote ${remote}\` once in Terminal so git keeps your login; Helm never handles credentials`;
  if (/not found|does not exist|does not appear to be a git repository/.test(s)) return "the remote has no such repository (or it is private and your login cannot see it)";
  return (stderr.trim().split("\n").pop() ?? "git ls-remote failed").replace(/[a-z+]+:\/\/[^@\s/]+@/gi, "").slice(0, 200);
}

export function createRemoteOps() {
  return {
    /** What the repository's remote has compared with this computer (branch names and commits only; nothing is downloaded). */
    async remoteStatus({ repo, remote: want }: { repo: string; remote?: string }): Promise<RemoteStatus> {
      const out: RemoteStatus = { repo, remotes: [], remote: null, url: null, web: null, defaultBranch: null, branches: [], unpushed: null, error: null };
      const dir = resolve(repo);
      if (!existsSync(dir)) return { ...out, error: `the repository folder is missing: ${repo}` };
      const rs = await git(dir, ["remote"]);
      if (rs.code !== 0) return { ...out, error: "not a git repository" };
      out.remotes = rs.stdout.split("\n").map((x) => x.trim()).filter(Boolean);
      const remote = want && out.remotes.includes(want) ? want : out.remotes.includes("origin") ? "origin" : out.remotes[0] ?? null;
      // local branches, with their commits and dates
      const refs = await git(dir, ["for-each-ref", "--count=300", "--format=%(refname:short)%09%(objectname)%09%(committerdate:unix)", "refs/heads"]);
      const local = new Map<string, { sha: string; at: number | null }>();
      for (const l of refs.stdout.split("\n").filter(Boolean)) {
        const [name, sha, at] = l.split("\t");
        if (name && sha) local.set(name, { sha, at: at ? Number(at) * 1000 : null });
      }
      if (!remote) {
        out.branches = [...local].map(([name, l]) => ({ name, local: l.sha, remote: null, state: "local" as const, ahead: null, behind: null, at: l.at }));
        await countUnpushed(dir, out.branches, []);
        out.unpushed = await countAll(dir, out.branches, []);
        return out;
      }
      out.remote = remote;
      const u = await git(dir, ["remote", "get-url", remote]);
      out.url = u.code === 0 ? cleanUrl(u.stdout.trim()) : null;
      out.web = out.url ? webUrl(out.url) : null;
      // the remote's branch list: names and commits only
      const ls = await git(dir, ["ls-remote", "--symref", remote, "HEAD", "refs/heads/*"], 30_000);
      if (ls.code !== 0) {
        out.error = why(ls.stderr, ls.code, repo, remote);
        out.branches = [...local].map(([name, l]) => ({ name, local: l.sha, remote: null, state: "local" as const, ahead: null, behind: null, at: l.at }));
        return out;
      }
      const theirs = new Map<string, string>();
      for (const l of ls.stdout.split("\n").filter(Boolean)) {
        const sym = l.match(/^ref: refs\/heads\/(\S+)\s+HEAD$/);
        if (sym) {
          out.defaultBranch = sym[1];
          continue;
        }
        const m = l.match(/^([0-9a-f]{40,64})\s+refs\/heads\/(.+)$/);
        if (m) theirs.set(m[2], m[1]);
      }
      // which of the remote's commits this computer has
      const shas = [...new Set(theirs.values())];
      const known = new Set<string>();
      if (shas.length) {
        const chk = await new Promise<string>((res) => {
          const p = execFile("git", ["cat-file", "--batch-check"], { cwd: dir, env: ENV, timeout: 20_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (_e, stdout) => res(String(stdout ?? "")));
          p.stdin?.end(shas.join("\n") + "\n");
        });
        for (const l of chk.split("\n")) {
          const [sha, type] = l.split(" ");
          if (type === "commit") known.add(sha);
        }
      }
      const names = [...new Set([...local.keys(), ...theirs.keys()])].slice(0, 300);
      for (const name of names) {
        const l = local.get(name);
        const r = theirs.get(name) ?? null;
        const b: RemoteBranch = { name, local: l?.sha ?? null, remote: r, state: "synced", ahead: null, behind: null, at: l?.at ?? null };
        if (l && r) {
          if (l.sha === r) {
            b.ahead = 0;
            b.behind = 0;
          } else if (known.has(r)) {
            const c = await git(dir, ["rev-list", "--left-right", "--count", `${l.sha}...${r}`]);
            const [ahead, behind] = c.stdout.trim().split(/\s+/).map(Number);
            b.ahead = Number.isFinite(ahead) ? ahead : null;
            b.behind = Number.isFinite(behind) ? behind : null;
            b.state = b.ahead && b.behind ? "diverged" : b.ahead ? "ahead" : b.behind ? "behind" : "synced";
          } else b.state = "newer";
        } else if (l) b.state = "local";
        else b.state = "remote";
        out.branches.push(b);
      }
      await countUnpushed(dir, out.branches, [...known]);
      out.unpushed = await countAll(dir, out.branches, [...known]);
      return out;
    },
  };
}

/** Every local branch's commits that are on none of the remote's branches, each counted once. */
async function countAll(dir: string, branches: RemoteBranch[], onRemote: string[]): Promise<number | null> {
  const heads = [...new Set(branches.map((b) => b.local).filter((x): x is string => !!x))].slice(0, 300);
  if (!heads.length) return 0;
  const c = await git(dir, ["rev-list", "--count", ...heads, ...onRemote.slice(0, 300).map((s) => `^${s}`)]);
  const n = Number(c.stdout.trim());
  return c.code === 0 && Number.isFinite(n) ? n : null;
}

/** A branch only here: how many of its commits are on none of the remote's branches. */
async function countUnpushed(dir: string, branches: RemoteBranch[], onRemote: string[]): Promise<void> {
  const not = onRemote.slice(0, 300).map((s) => `^${s}`);
  for (const b of branches.filter((x) => x.state === "local" && x.local).slice(0, 60)) {
    const c = await git(dir, ["rev-list", "--count", b.local!, ...not]);
    const n = Number(c.stdout.trim());
    b.ahead = c.code === 0 && Number.isFinite(n) ? n : null;
  }
}
