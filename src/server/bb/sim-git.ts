// An in-memory git for the simulator: repositories, branches, commits, worktrees
// and loose files, enough to exercise every evidence check Helm makes. It also
// implements HostOps so the engine cannot tell it from the real host entry.

import type { HostOps } from "../../shared/host-contract.ts";
import { scan } from "../domain/slop/scan.ts";

interface Commit {
  sha: string;
  parents: string[];
  tree: Map<string, string>;
  msg: string;
  ts: number;
}
interface FRepo {
  root: string;
  commits: Map<string, Commit>;
  refs: Map<string, string>;
}
interface FWorktree {
  path: string;
  root: string;
  branch: string | null;
  detached: string | null;
  work: Map<string, string>;
}

function hash(s: string): string {
  // deterministic 40-hex digest (FNV-1a variants); collisions are irrelevant at simulator scale
  let out = "";
  for (let k = 0; k < 5; k++) {
    let h = 0x811c9dc5 ^ (k * 0x9e3779b1);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out;
}

export class FakeGit {
  repos = new Map<string, FRepo>();
  wts = new Map<string, FWorktree>();
  /** Free bytes on the simulated disk (tests lower it to see the low-space alert). */
  diskFree = 200e9;
  /** Folders shown in the file manager (the Worktrees view's Show in Finder). */
  revealed: string[] = [];
  /** What each repository's remote has (tests set it): branch → commit. No entry: the repository has no remote. */
  remotes = new Map<string, Map<string, string>>();
  loose = new Map<string, string>();
  /** Plain (non-git) folders tests place on the simulated disk: path → has files. */
  dirs = new Map<string, boolean>();
  private seq = 0;
  constructor(private now: () => number = Date.now) {}

  // ───────── internals ─────────
  private wtFor(path: string): { wt: FWorktree; rel: string } | null {
    let best: FWorktree | null = null;
    for (const wt of this.wts.values()) if ((path === wt.path || path.startsWith(`${wt.path}/`)) && (!best || wt.path.length > best.path.length)) best = wt;
    if (!best) return null;
    return { wt: best, rel: path === best.path ? "" : path.slice(best.path.length + 1) };
  }
  private repoFor(path: string): FRepo | null {
    const direct = this.repos.get(path);
    if (direct) return direct;
    const w = this.wtFor(path);
    return w ? this.repos.get(w.wt.root) ?? null : null;
  }
  head(wt: FWorktree): string | null {
    if (wt.detached) return wt.detached;
    return wt.branch ? this.repos.get(wt.root)!.refs.get(wt.branch) ?? null : null;
  }
  resolve(repoOrWt: string, ref: string): string | null {
    const repo = this.repoFor(repoOrWt);
    if (!repo) return null;
    const r = ref.replace(/\^\{commit\}$/, "").replace(/^refs\/heads\//, "");
    if (r === "HEAD") {
      const w = this.wtFor(repoOrWt)?.wt ?? this.wts.get(repo.root);
      return w ? this.head(w) : null;
    }
    if (repo.refs.has(r)) return repo.refs.get(r)!;
    if (/^[0-9a-f]{4,40}$/.test(r)) {
      const m = [...repo.commits.keys()].filter((s) => s.startsWith(r));
      return m.length === 1 ? m[0] : null;
    }
    return null;
  }
  private commitObj(repo: FRepo, sha: string | null): Commit | null {
    return sha ? repo.commits.get(sha) ?? null : null;
  }
  isAncestorSha(repo: FRepo, a: string, b: string): boolean {
    const seen = new Set<string>();
    const stack = [b];
    while (stack.length) {
      const s = stack.pop()!;
      if (s === a) return true;
      if (seen.has(s)) continue;
      seen.add(s);
      stack.push(...(repo.commits.get(s)?.parents ?? []));
    }
    return false;
  }

  // ───────── agent-side operations (what an agent's shell would do) ─────────
  createRepo(root: string): FRepo {
    const repo: FRepo = { root, commits: new Map(), refs: new Map() };
    this.repos.set(root, repo);
    this.wts.set(root, { path: root, root, branch: "main", detached: null, work: new Map() });
    return repo;
  }
  createWorktree(root: string, baseRef: string | null): { path: string; branch: string } {
    const repo = this.repos.get(root);
    if (!repo) throw new Error(`no repo at ${root}`);
    const base = this.resolve(root, baseRef ?? "main");
    if (!base) throw new Error(`HTTP 409: base branch ${baseRef ?? "main"} not found`);
    const n = ++this.seq;
    const branch = `helm-wt-${n}`;
    const path = `${root}/.bb-worktrees/${n}`;
    repo.refs.set(branch, base);
    this.wts.set(path, { path, root, branch, detached: null, work: new Map(repo.commits.get(base)!.tree) });
    return { path, branch };
  }
  /** `git worktree add <path> <branch>` (the branch made from base when missing). */
  addWorktree(root: string, path: string, branch: string, base: string): { path: string; branch: string; created: boolean } {
    const repo = this.repos.get(root);
    if (!repo) throw new Error(`no repo at ${root}`);
    const here = this.wts.get(path);
    if (here) {
      if (here.branch !== branch) throw new Error(`${path} is a worktree on ${here.branch}, not ${branch}.`);
      return { path, branch, created: false };
    }
    const busy = [...this.wts.values()].find((w) => w.root === root && w.branch === branch);
    if (busy) throw new Error(`branch ${branch} is checked out in ${busy.path}; only one worktree can hold it.`);
    if (!repo.refs.has(branch)) {
      const b = this.resolve(root, base);
      if (!b) throw new Error(`base ${base} not found`);
      repo.refs.set(branch, b);
    }
    const sha = repo.refs.get(branch)!;
    this.wts.set(path, { path, root, branch, detached: null, work: new Map(repo.commits.get(sha)!.tree) });
    return { path, branch, created: true };
  }
  /** `git worktree remove` (what BB does when an environment is deleted). */
  removeWorktree(path: string): void {
    this.wts.delete(path);
  }
  write(wtPath: string, rel: string, content: string): void {
    const w = this.wts.get(wtPath);
    if (!w) throw new Error(`no worktree ${wtPath}`);
    w.work.set(rel, content);
  }
  remove(wtPath: string, rel: string): void {
    this.wts.get(wtPath)?.work.delete(rel);
  }
  read(wtPath: string, rel: string): string | null {
    return this.wts.get(wtPath)?.work.get(rel) ?? null;
  }
  commit(wtPath: string, msg: string, extraParents: string[] = []): string {
    const w = this.wts.get(wtPath);
    if (!w) throw new Error(`no worktree ${wtPath}`);
    const repo = this.repos.get(w.root)!;
    const parent = this.head(w);
    const tree = new Map([...w.work].filter(([p]) => !p.startsWith("reports/")));
    const sha = hash(`${parent}|${msg}|${[...tree].map(([k, v]) => `${k}=${v}`).join("\n")}|${++this.seq}`);
    repo.commits.set(sha, { sha, parents: parent ? [parent, ...extraParents] : extraParents, tree, msg, ts: this.now() });
    if (w.detached) w.detached = sha;
    else if (w.branch) repo.refs.set(w.branch, sha);
    return sha;
  }
  /** Merge another commit into the worktree's branch: theirs wins on conflict. */
  merge(wtPath: string, ref: string): string {
    const w = this.wts.get(wtPath)!;
    const repo = this.repos.get(w.root)!;
    const sha = this.resolve(w.root, ref);
    if (!sha) throw new Error(`merge: ${ref} not found`);
    const head = this.head(w);
    if (head && this.isAncestorSha(repo, sha, head)) return head;
    for (const [p, c] of repo.commits.get(sha)!.tree) w.work.set(p, c);
    return this.commit(wtPath, `Merge ${ref.slice(0, 9)}`, [sha]);
  }
  checkoutDetached(wtPath: string, ref: string): boolean {
    const w = this.wts.get(wtPath);
    if (!w) return false;
    const sha = this.resolve(w.root, ref);
    if (!sha) return false;
    w.detached = sha;
    w.work = new Map(this.repos.get(w.root)!.commits.get(sha)!.tree);
    return true;
  }
  pull(wtPath: string, branch: string): void {
    this.merge(wtPath, branch);
  }
  /** What .helm/run-check.sh would leave behind. */
  runCheck(wtPath: string, name: string, exitCode: number, output = "ok"): string {
    const w = this.wts.get(wtPath)!;
    const sha = this.head(w) ?? "none";
    const dirty = this.statusOf(w).filter((p) => !p.startsWith("reports/")).length ? " [dirty:1]" : "";
    const rel = `reports/checks/${name}.txt`;
    w.work.set(rel, `$ ${name}\n${output}\n[helm-exit:${exitCode}] [commit:${sha}] [ts:${Math.floor(this.now() / 1000)}]${dirty}\n`);
    return rel;
  }
  statusOf(w: FWorktree): string[] {
    const repo = this.repos.get(w.root)!;
    const head = this.commitObj(repo, this.head(w));
    const base = head?.tree ?? new Map<string, string>();
    const dirty: string[] = [];
    for (const [p, c] of w.work) if (base.get(p) !== c) dirty.push(p);
    for (const p of base.keys()) if (!w.work.has(p)) dirty.push(p);
    return dirty.sort();
  }
  treeAt(root: string, ref: string): Map<string, string> | null {
    const repo = this.repoFor(root);
    const sha = repo ? this.resolve(root, ref) : null;
    return sha ? repo!.commits.get(sha)!.tree : null;
  }

  // ───────── HostOps ─────────
  hostOps(home = "/home/sim"): HostOps {
    return {
      ensureWorktree: async ({ repo, path, branch, base }) => {
        const r = this.addWorktree(repo, path, branch, base);
        return { ...r, head: this.head(this.wts.get(path)!) };
      },
      worktrees: async ({ repo }) => {
        const list = [...this.wts.values()].filter((w) => w.root === repo).sort((a, b) => Number(b.path === repo) - Number(a.path === repo));
        return { worktrees: list.map((w) => ({ path: w.path, branch: w.detached ? null : w.branch, head: this.head(w), main: w.path === repo, dirty: this.statusOf(w).filter((p) => !p.startsWith("reports/")).length, missing: false })), branches: [...(this.repos.get(repo)?.refs.keys() ?? [])] };
      },
      ensureRepo: async ({ path, files, message }) => {
        let created = false;
        if (!this.repos.has(path)) {
          this.createRepo(path);
          created = true;
        }
        const wt = this.wts.get(path)!;
        for (const f of files) if (!wt.work.has(f.path)) wt.work.set(f.path, f.content);
        if (!this.head(wt) || this.statusOf(wt).length) this.commit(path, message || "Helm: initial commit");
        return { created, head: this.head(wt), branch: wt.branch };
      },
      inspectPath: async ({ path }) => {
        const repo = this.repoFor(path);
        if (repo) {
          const wt = this.wts.get(repo.root)!;
          return { path, exists: true, isDir: true, empty: !this.head(wt) && wt.work.size === 0, gitRoot: repo.root, head: this.head(wt), branch: wt.branch, dirty: this.statusOf(wt).length, writable: true };
        }
        if (this.dirs.has(path)) return { path, exists: true, isDir: true, empty: !this.dirs.get(path), gitRoot: null, head: null, branch: null, dirty: 0, writable: true };
        const enclosing = [...this.repos.keys()].find((r) => path.startsWith(`${r}/`)) ?? null;
        return { path, exists: false, isDir: false, empty: true, gitRoot: null, head: null, branch: null, dirty: 0, writable: true, enclosingRepo: enclosing };
      },
      adoptRepo: async ({ path, branch, files, message }) => {
        const repo = this.repos.get(path);
        if (!repo) throw new Error(`no repository at ${path}`);
        const wt = this.wts.get(path)!;
        const base = this.head(wt);
        if (!base) throw new Error(`${path} has no commits yet`);
        const userBranch = wt.detached ? null : wt.branch;
        const existing = repo.refs.get(branch);
        if (existing) return { created: false, head: existing, base, userBranch };
        const tree = new Map(repo.commits.get(base)!.tree);
        let added = 0;
        for (const f of files)
          if (!tree.has(f.path)) {
            tree.set(f.path, f.content);
            added++;
          }
        let head = base;
        if (added) {
          head = hash(`${base}|${message}|adopt|${++this.seq}`);
          repo.commits.set(head, { sha: head, parents: [base], tree, msg: message, ts: this.now() });
        }
        repo.refs.set(branch, head);
        return { created: true, head, base, userBranch };
      },
      revParse: async ({ repo, ref }) => ({ sha: this.resolve(repo, ref) }),
      isAncestor: async ({ repo, ancestor, descendant }) => {
        const r = this.repoFor(repo);
        const a = this.resolve(repo, ancestor);
        const d = this.resolve(repo, descendant);
        return { ok: !!(r && a && d && this.isAncestorSha(r, a, d)) };
      },
      fileAt: async ({ repo, ref, path }) => ({ content: this.treeAt(repo, ref)?.get(path.replace(/^\.\//, "")) ?? null }),
      status: async ({ path }) => {
        const w = this.wts.get(path);
        if (!w) return { head: null, branch: null, clean: false, dirty: [] };
        const dirty = this.statusOf(w);
        return { head: this.head(w), branch: w.detached ? "HEAD" : w.branch, clean: dirty.length === 0, dirty };
      },
      readFile: async ({ path }) => {
        const hit = this.wtFor(path);
        if (hit && hit.rel) return { content: hit.wt.work.get(hit.rel) ?? null };
        return { content: this.loose.get(path) ?? null };
      },
      writeFile: async ({ path, content }) => {
        const hit = this.wtFor(path);
        if (hit && hit.rel) hit.wt.work.set(hit.rel, content);
        else this.loose.set(path, content);
        return { ok: true };
      },
      log: async ({ repo, ref, limit }) => {
        const r = this.repoFor(repo);
        let sha = r ? this.resolve(repo, ref) : null;
        const out: Array<{ sha: string; subject: string; ts: number }> = [];
        while (r && sha && out.length < limit) {
          const c = r.commits.get(sha)!;
          out.push({ sha, subject: c.msg, ts: c.ts });
          sha = c.parents[0] ?? null;
        }
        return { commits: out };
      },
      scan: async ({ repo, ref, paths, history }) => {
        const r = this.repoFor(repo);
        const sha = r ? this.resolve(repo, ref) : null;
        if (!r || !sha) return { commit: null, findings: [], filesScanned: 0, shippedFiles: 0, exempted: 0, unverified: [`ref ${ref} not found`] };
        const tree = r.commits.get(sha)!.tree;
        const files = [...tree].map(([path, content]) => ({ path, content }));
        let hist: Array<{ commit: string; path: string; line: string }> | undefined;
        if (history) {
          hist = [];
          const seen = new Set<string>();
          const stack = [sha];
          while (stack.length && seen.size < 300) {
            const s = stack.pop()!;
            if (seen.has(s)) continue;
            seen.add(s);
            const c = r.commits.get(s)!;
            const parent = c.parents[0] ? r.commits.get(c.parents[0])!.tree : new Map<string, string>();
            for (const [p, content] of c.tree) if (parent.get(p) !== content) for (const line of content.split("\n")) hist.push({ commit: s, path: p, line });
            stack.push(...c.parents);
          }
        }
        const res = scan({ files, history: hist });
        const want = paths?.length ? new Set(paths) : null;
        return { commit: sha, findings: want ? res.findings.filter((f) => want.has(f.path) || f.rule === "S6") : res.findings, filesScanned: res.filesScanned, shippedFiles: res.shippedFiles, exempted: res.exempted, unverified: res.unverified };
      },
      // the Screens view reads the worktrees' files (no images are decoded here)
      screensScan: async ({ roots }: { roots: string[] }) => {
        const files: Array<{ root: string; rel: string; mtime: number }> = [];
        const maps: Array<{ root: string; text: string; mtime: number }> = [];
        for (const root of roots) {
          const wt = this.wts.get(root);
          if (!wt) continue;
          for (const rel of wt.work.keys()) if (/\.(png|jpe?g|gif|webp)$/i.test(rel) && /(^|\/)(reports|screens|screenshots)\//i.test(rel)) files.push({ root, rel, mtime: this.now() });
          const m = wt.work.get("reports/screens/screens.json");
          if (m !== undefined) maps.push({ root, text: m, mtime: this.now() });
        }
        return { files, maps };
      },
      // sizes: a worktree's files count their content length; every folder is on one 500 GB disk
      diskUsage: async ({ paths, repos, measure }: { paths: string[]; repos?: string[]; measure?: boolean }) => ({
        sizes: paths.map((path) => {
          const w = this.wts.get(path);
          const bytes = w && measure !== false ? [...w.work.values()].reduce((n, c) => n + c.length, 0) + 4096 : null;
          return { path, bytes, dev: 1, free: this.diskFree, total: 500e9 };
        }),
        repos: (repos ?? []).map((repo) => ({ repo, gitDir: this.repoFor(repo) ? `${this.repoFor(repo)!.root}/.git` : null, bytes: this.repoFor(repo) && measure !== false ? 1_000_000 : null })),
      }),
      remoteStatus: async ({ repo }: { repo: string }) => {
        const r = this.repos.get(repo);
        const theirs = this.remotes.get(repo);
        const base = { repo, remotes: theirs ? ["origin"] : [], remote: theirs ? "origin" : null, url: theirs ? "https://github.com/example/app.git" : null, web: theirs ? "https://github.com/example/app" : null, defaultBranch: theirs ? "main" : null, error: r ? null : `the repository folder is missing: ${repo}` };
        if (!r) return { ...base, branches: [], unpushed: null };
        const names = [...new Set([...r.refs.keys(), ...(theirs?.keys() ?? [])])];
        const branches = names.map((name) => {
          const l = r.refs.get(name) ?? null;
          const t = theirs?.get(name) ?? null;
          const state = l && t ? (l === t ? "synced" : r.commits.has(t) ? "ahead" : "newer") : l ? "local" : "remote";
          return { name, local: l, remote: t, state: state as "synced" | "ahead" | "newer" | "local" | "remote", ahead: state === "synced" ? 0 : state === "ahead" || state === "local" ? 1 : null, behind: state === "synced" || state === "ahead" ? 0 : null, at: null };
        });
        return { ...base, branches, unpushed: branches.filter((b) => b.state === "ahead" || b.state === "local").length };
      },
      reveal: async ({ path }: { path: string }) => {
        this.revealed.push(path);
        return { ok: true, shown: path };
      },
      screenImage: async ({ path }: { path: string }) => {
        const w = this.wtFor(path);
        const content = w ? w.wt.work.get(w.rel) : undefined;
        return content === undefined ? { data: null, mime: "" } : { data: Buffer.from(content).toString("base64"), mime: path.endsWith(".png") ? "image/png" : "image/jpeg" };
      },
      toolProbe: async (input: { tools: Array<{ id: string }> }) => ({ found: Object.fromEntries(input.tools.map((t) => [t.id, t.id === "docker" ? "/usr/local/bin/docker" : null])) }),
      probe: async () => ({ platform: "darwin", home, git: "git version 2.50.0 (sim)", xcode: "Xcode 27.0 (sim)", swift: "Swift 6.3 (sim)", gradle: null, androidSdk: false, dotnet: null }),
    };
  }
}
