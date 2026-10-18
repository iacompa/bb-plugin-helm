// Host-side implementations of HOST_CONTRACT. Runs inside a BB host daemon
// (host.ts) or directly in tests. Commands are run with execFile (no shell) and
// a timeout; every path argument is passed as an argument, never interpolated.

import { execFile, spawn } from "node:child_process";
import { access, chmod, constants as fsc, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { homedir, platform, tmpdir } from "node:os";
import type { HostOps } from "../shared/host-contract.ts";
import { scan, type ScanFile } from "../server/domain/slop/scan.ts";
import { createScreenOps } from "./screens.ts";

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  // reads (git status while planning, evidence) must not refresh the index of the
  // human's checkout or worktrees: no optional locks, no index writes
  GIT_OPTIONAL_LOCKS: "0",
  GIT_AUTHOR_NAME: "Helm",
  GIT_AUTHOR_EMAIL: "helm@localhost",
  GIT_COMMITTER_NAME: "Helm",
  GIT_COMMITTER_EMAIL: "helm@localhost",
};

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; maxBuffer?: number; env?: Record<string, string> } = {}): Promise<RunResult> {
  return new Promise((res) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 20_000, maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024, env: opts.env ? { ...GIT_ENV, ...opts.env } : GIT_ENV, encoding: "utf8" },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 127) : 0;
        res({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

const git = (repo: string, args: string[], timeoutMs?: number, maxBuffer?: number) => run("git", args, { cwd: repo, timeoutMs, maxBuffer });

/** Refs from agents are untrusted: allow only ordinary ref/sha characters, never an option. */
export function safeRef(ref: string): string | null {
  const r = ref.trim();
  if (!r || r.startsWith("-") || r.length > 300) return null;
  if (!/^[A-Za-z0-9._\/@{}~^:+-]+$/.test(r)) return null;
  if (r.includes("..")) return null;
  return r;
}

/** Repo-relative paths from agents: no absolute paths, no escaping the repo. */
export function safeRelPath(p: string): string | null {
  const x = p.trim().replace(/^\.\//, "");
  if (!x || x.startsWith("/") || x.startsWith("-") || x.split(/[\\/]/).includes("..")) return null;
  return x;
}

/** A new branch name Helm creates in an adopted repo: plain characters only. */
function safeBranchName(b: string): string | null {
  const r = safeRef(b);
  if (!r || /[~^:{}@]|\/\/|\/$|\.lock$|^\//.test(r)) return null;
  return r;
}

/** Write a blob into the repo's object store without touching any working tree. */
function hashObject(repo: string, content: string): Promise<string | null> {
  return new Promise((res) => {
    const child = spawn("git", ["hash-object", "-w", "--stdin"], { cwd: repo, env: GIT_ENV });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.on("close", (code) => res(code === 0 ? out.trim() || null : null));
    child.on("error", () => res(null));
    child.stdin.end(content);
  });
}

async function writable(p: string): Promise<boolean> {
  let cur = resolve(p);
  for (let i = 0; i < 64; i++) {
    if (existsSync(cur)) {
      try {
        await access(cur, fsc.W_OK);
        return true;
      } catch {
        return false;
      }
    }
    const up = dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
  return false;
}

async function revParse(repo: string, ref: string): Promise<string | null> {
  const r = safeRef(ref);
  if (!r || !existsSync(repo)) return null;
  const out = await git(repo, ["rev-parse", "--verify", "--quiet", `${r}^{commit}`]);
  return out.code === 0 ? out.stdout.trim() || null : null;
}

/** Read many blobs in one `git cat-file --batch` process. */
function catFileBatch(repo: string, specs: string[], maxBytesEach: number): Promise<Map<string, string | null>> {
  return new Promise((res) => {
    const out = new Map<string, string | null>();
    if (!specs.length) return res(out);
    const child = spawn("git", ["cat-file", "--batch"], { cwd: repo, env: GIT_ENV });
    const chunks: Buffer[] = [];
    let total = 0;
    const LIMIT = 64 * 1024 * 1024;
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (b: Buffer) => {
      total += b.length;
      if (total <= LIMIT) chunks.push(b);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      let pos = 0;
      for (const spec of specs) {
        const nl = buf.indexOf(10, pos);
        if (nl < 0) break;
        const header = buf.subarray(pos, nl).toString("utf8");
        pos = nl + 1;
        if (header.endsWith(" missing") || header.endsWith(" ambiguous")) {
          out.set(spec, null);
          continue;
        }
        const size = Number(header.split(" ")[2] ?? 0);
        const body = buf.subarray(pos, pos + size);
        pos += size + 1;
        if (size > maxBytesEach || body.includes(0)) out.set(spec, null);
        else out.set(spec, body.toString("utf8"));
      }
      res(out);
    });
    child.on("error", () => res(out));
    child.stdin.end(specs.join("\n") + "\n");
  });
}

function parseHistory(text: string): Array<{ commit: string; path: string; line: string }> {
  const out: Array<{ commit: string; path: string; line: string }> = [];
  let commit = "";
  let path = "";
  for (const l of text.split("\n")) {
    if (l.startsWith("\u0000")) commit = l.slice(1).trim();
    else if (l.startsWith("+++ b/")) path = l.slice(6);
    else if (l.startsWith("+") && !l.startsWith("+++") && commit && path) out.push({ commit, path, line: l.slice(1) });
  }
  return out;
}

async function versionOf(cmd: string, args: string[], cwd?: string): Promise<string | null> {
  const r = await run(cmd, args, { cwd, timeoutMs: 15_000 });
  if (r.code !== 0) return null;
  return (r.stdout || r.stderr).trim().split("\n")[0]?.slice(0, 120) || null;
}

/** `git worktree list --porcelain`: the main checkout first. */
async function listWorktrees(root: string): Promise<Array<{ path: string; branch: string | null; head: string | null }>> {
  const r = await git(root, ["worktree", "list", "--porcelain"]);
  if (r.code !== 0) throw new Error(`git worktree list failed: ${r.stderr.trim().slice(0, 300)}`);
  const out: Array<{ path: string; branch: string | null; head: string | null }> = [];
  for (const block of r.stdout.split("\n\n")) {
    const lines = block.split("\n");
    const p = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!p) continue;
    const br = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
    out.push({ path: p, branch: br, head: lines.find((l) => l.startsWith("HEAD "))?.slice(5) ?? null });
  }
  return out;
}

export function createHostOps(): HostOps {
  return {
    ...createScreenOps(),
    async ensureRepo({ path, files, message }) {
      const root = resolve(path);
      await mkdir(root, { recursive: true });
      let created = false;
      if (!existsSync(join(root, ".git"))) {
        const init = await git(root, ["init", "-b", "main"]);
        if (init.code !== 0) {
          // git < 2.28 has no -b; fall back and rename
          const init2 = await git(root, ["init"]);
          if (init2.code !== 0) throw new Error(`git init failed: ${init2.stderr.trim().slice(0, 300)}`);
          await git(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
        }
        created = true;
      }
      for (const f of files) {
        const rel = safeRelPath(f.path);
        if (!rel) throw new Error(`refusing unsafe path ${JSON.stringify(f.path)}`);
        const abs = join(root, rel);
        if (!abs.startsWith(root + sep)) throw new Error(`refusing path outside the repo: ${rel}`);
        if (existsSync(abs)) continue; // never overwrite work
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, f.content, "utf8");
        if (f.executable) await chmod(abs, 0o755);
      }
      const head0 = await revParse(root, "HEAD");
      const st = await git(root, ["status", "--porcelain"]);
      if (!head0 || st.stdout.trim()) {
        await git(root, ["add", "-A"]);
        const c = await git(root, ["commit", "-q", "--allow-empty", "-m", message || "Helm: initial commit"]);
        if (c.code !== 0) throw new Error(`git commit failed: ${c.stderr.trim().slice(0, 300)}`);
      }
      const head = await revParse(root, "HEAD");
      const br = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
      return { created, head, branch: br.code === 0 ? br.stdout.trim() : null };
    },

    async inspectPath({ path }) {
      const abs = resolve(path);
      const empty = { path: abs, exists: false, isDir: false, empty: true, gitRoot: null, head: null, branch: null, dirty: 0, writable: await writable(abs), enclosingRepo: null as string | null };
      let st;
      try {
        st = await stat(abs);
      } catch {
        // a folder that does not exist yet must not be created inside another repository
        let up = dirname(abs);
        while (up !== dirname(up) && !existsSync(up)) up = dirname(up);
        const top = existsSync(up) ? await git(up, ["rev-parse", "--show-toplevel"]) : null;
        return { ...empty, enclosingRepo: top && top.code === 0 ? top.stdout.trim() || null : null };
      }
      if (!st.isDirectory()) return { ...empty, exists: true, empty: false };
      const real = await realpath(abs).catch(() => abs);
      const entries = (await readdir(abs).catch(() => [] as string[])).filter((n) => n !== ".DS_Store");
      const top = await git(abs, ["rev-parse", "--show-toplevel"]);
      const gitRoot = top.code === 0 ? await realpath(top.stdout.trim()).catch(() => top.stdout.trim()) : null;
      let head: string | null = null;
      let branch: string | null = null;
      let dirty = 0;
      if (gitRoot) {
        head = await revParse(abs, "HEAD");
        const br = await git(abs, ["rev-parse", "--abbrev-ref", "HEAD"]);
        branch = br.code === 0 ? br.stdout.trim() : null;
        const s = await git(abs, ["status", "--porcelain"], 60_000);
        dirty = s.code === 0 ? s.stdout.split("\n").filter(Boolean).length : 0;
      }
      return { path: real, exists: true, isDir: true, empty: entries.length === 0, gitRoot, head, branch, dirty, writable: await writable(abs) };
    },

    async adoptRepo({ path, branch, files, message }) {
      const root = resolve(path);
      const b = safeBranchName(branch);
      if (!b) throw new Error(`refusing branch name ${JSON.stringify(branch)}`);
      const base = await revParse(root, "HEAD");
      if (!base) throw new Error(`${root} has no commits yet; commit something first or point the app at an empty folder.`);
      const br = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const userBranch = br.code === 0 && br.stdout.trim() !== "HEAD" ? br.stdout.trim() : null;
      const existing = await revParse(root, `refs/heads/${b}`);
      if (existing) return { created: false, head: existing, base, userBranch };
      // a private index: the human's index, working tree and HEAD are never touched
      const dir = await mkdtemp(join(tmpdir(), "helm-adopt-"));
      const env = { GIT_INDEX_FILE: join(dir, "index") };
      try {
        const rt = await run("git", ["read-tree", base], { cwd: root, env });
        if (rt.code !== 0) throw new Error(`git read-tree failed: ${rt.stderr.trim().slice(0, 300)}`);
        let added = 0;
        for (const f of files) {
          const rel = safeRelPath(f.path);
          if (!rel) throw new Error(`refusing unsafe path ${JSON.stringify(f.path)}`);
          const there = await git(root, ["cat-file", "-e", `${base}:${rel}`]);
          if (there.code === 0) continue; // never overwrite the human's files
          const blob = await hashObject(root, f.content);
          if (!blob) throw new Error(`git hash-object failed for ${rel}`);
          const ui = await run("git", ["update-index", "--add", "--cacheinfo", `${f.executable ? "100755" : "100644"},${blob},${rel}`], { cwd: root, env });
          if (ui.code !== 0) throw new Error(`git update-index failed: ${ui.stderr.trim().slice(0, 300)}`);
          added++;
        }
        let head = base;
        if (added) {
          const wt = await run("git", ["write-tree"], { cwd: root, env });
          if (wt.code !== 0) throw new Error(`git write-tree failed: ${wt.stderr.trim().slice(0, 300)}`);
          const ct = await git(root, ["commit-tree", wt.stdout.trim(), "-p", base, "-m", message || "Helm: adopt"]);
          if (ct.code !== 0) throw new Error(`git commit-tree failed: ${ct.stderr.trim().slice(0, 300)}`);
          head = ct.stdout.trim();
        }
        // create only: an empty old value makes update-ref fail if the branch appeared meanwhile
        const ur = await git(root, ["update-ref", `refs/heads/${b}`, head, ""]);
        if (ur.code !== 0) {
          const now = await revParse(root, `refs/heads/${b}`);
          if (now) return { created: false, head: now, base, userBranch };
          throw new Error(`git update-ref failed: ${ur.stderr.trim().slice(0, 300)}`);
        }
        return { created: true, head, base, userBranch };
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },

    async ensureWorktree({ repo, path, branch, base }) {
      const root = resolve(repo);
      const wt = resolve(path);
      const b = safeBranchName(branch);
      const from = safeRef(base);
      if (!b || !from) throw new Error(`refusing branch ${JSON.stringify(branch)} or base ${JSON.stringify(base)}`);
      const list = await listWorktrees(root);
      const here = list.find((w) => w.path === wt || w.path === (existsSync(wt) ? realpathSync(wt) : wt));
      if (here) {
        if (here.branch !== b) throw new Error(`${wt} is a worktree on ${here.branch ?? "a detached HEAD"}, not ${b}.`);
        return { path: here.path, branch: b, head: here.head, created: false };
      }
      const busy = list.find((w) => w.branch === b);
      if (busy) throw new Error(`branch ${b} is checked out in ${busy.path}; only one worktree can hold it.`);
      if (existsSync(wt) && (await readdir(wt)).filter((n) => n !== ".DS_Store").length) throw new Error(`${wt} exists and is not empty.`);
      if (!(await revParse(root, `refs/heads/${b}`))) {
        const mk = await git(root, ["branch", b, from]);
        if (mk.code !== 0) throw new Error(`git branch failed: ${mk.stderr.trim().slice(0, 300)}`);
      }
      await mkdir(dirname(wt), { recursive: true });
      const add = await git(root, ["worktree", "add", wt, b], 120_000);
      if (add.code !== 0) throw new Error(`git worktree add failed: ${add.stderr.trim().slice(0, 300)}`);
      return { path: realpathSync(wt), branch: b, head: await revParse(wt, "HEAD"), created: true };
    },

    async worktrees({ repo, status }) {
      const list = await listWorktrees(resolve(repo));
      const out = [];
      for (const [i, w] of list.slice(0, 100).entries()) {
        const missing = !existsSync(w.path);
        const s = missing || status === false ? null : await git(w.path, ["status", "--porcelain", "--untracked-files=no"], 60_000);
        out.push({ ...w, main: i === 0, missing, dirty: s && s.code === 0 ? s.stdout.split("\n").filter(Boolean).length : 0 });
      }
      const refs = await git(resolve(repo), ["for-each-ref", "--count=300", "--format=%(refname:short)", "refs/heads"]);
      return { worktrees: out, branches: refs.code === 0 ? refs.stdout.split("\n").filter(Boolean) : [] };
    },

    async revParse({ repo, ref }) {
      return { sha: await revParse(repo, ref) };
    },

    async isAncestor({ repo, ancestor, descendant }) {
      const a = safeRef(ancestor);
      const d = safeRef(descendant);
      if (!a || !d) return { ok: false };
      const r = await git(repo, ["merge-base", "--is-ancestor", a, d]);
      return { ok: r.code === 0 };
    },

    async fileAt({ repo, ref, path, maxBytes }) {
      const r = safeRef(ref);
      const p = safeRelPath(path);
      if (!r || !p) return { content: null };
      const m = await catFileBatch(repo, [`${r}:${p}`], maxBytes ?? 1_000_000);
      return { content: m.get(`${r}:${p}`) ?? null };
    },

    async status({ path }) {
      if (!existsSync(path)) return { head: null, branch: null, clean: false, dirty: [] };
      const head = await revParse(path, "HEAD");
      const br = await git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const st = await git(path, ["status", "--porcelain", "--untracked-files=all"]);
      const dirty = st.stdout
        .split("\n")
        .filter(Boolean)
        .map((l) => l.slice(3).replace(/^"|"$/g, ""));
      return { head, branch: br.code === 0 ? br.stdout.trim() : null, clean: dirty.length === 0, dirty };
    },

    async readFile({ path, maxBytes }) {
      try {
        const s = await stat(path);
        if (!s.isFile() || s.size > (maxBytes ?? 1_000_000)) return { content: null };
        return { content: await readFile(path, "utf8") };
      } catch {
        return { content: null };
      }
    },

    async writeFile({ path, content }) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
      return { ok: true };
    },

    async log({ repo, ref, limit }) {
      const r = safeRef(ref);
      if (!r) return { commits: [] };
      const out = await git(repo, ["log", `-n${limit}`, "--format=%H%x09%ct%x09%s", r]);
      if (out.code !== 0) return { commits: [] };
      return {
        commits: out.stdout
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const [sha, ts, ...rest] = l.split("\t");
            return { sha, ts: Number(ts) * 1000, subject: rest.join("\t").slice(0, 200) };
          }),
      };
    },

    async scan({ repo, ref, paths, history }) {
      const commit = await revParse(repo, ref);
      if (!commit) return { commit: null, findings: [], filesScanned: 0, shippedFiles: 0, exempted: 0, unverified: [`ref ${ref} not found`] };
      const ls = await git(repo, ["ls-tree", "-r", "-l", "--full-tree", commit], 30_000);
      const entries = ls.stdout
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [meta, p] = l.split("\t");
          const size = Number(meta.trim().split(/\s+/)[3]);
          return { path: p, size: Number.isFinite(size) ? size : 0 };
        })
        .filter((e) => e.size <= 1_000_000);
      const wanted = paths?.length ? new Set(paths.map((p) => safeRelPath(p)).filter(Boolean) as string[]) : null;
      // manifests are always read so S3 can cross-check imports
      const isManifest = (p: string) => /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig\.json|requirements\.txt|pyproject\.toml|Package\.swift|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|\.helm\/slop-allow\.json)$/.test(p);
      const chosen = entries.filter((e) => !wanted || wanted.has(e.path) || isManifest(e.path));
      const blobs = await catFileBatch(repo, chosen.map((e) => `${commit}:${e.path}`), 1_000_000);
      const files: ScanFile[] = [];
      for (const e of chosen) {
        const c = blobs.get(`${commit}:${e.path}`);
        if (c != null) files.push({ path: e.path, content: c });
      }
      let allow: Array<{ rule: string; path: string; reason: string }> | undefined;
      let loggers: string[] | undefined;
      const allowFile = files.find((f) => f.path === ".helm/slop-allow.json");
      if (allowFile) {
        try {
          const j = JSON.parse(allowFile.content) as { allow?: typeof allow; loggers?: string[] };
          allow = Array.isArray(j.allow) ? j.allow : undefined;
          loggers = Array.isArray(j.loggers) ? j.loggers : undefined;
        } catch {
          // malformed allowlist is ignored; the scanner reports nothing extra for it
        }
      }
      let hist: Array<{ commit: string; path: string; line: string }> | undefined;
      if (history) {
        const h = await git(repo, ["log", "-p", "--no-color", "--no-ext-diff", "-n", "300", "--format=%x00%H", commit], 60_000, 24 * 1024 * 1024);
        if (h.code === 0) hist = parseHistory(h.stdout);
      }
      const res = scan({ files, allow, history: hist, loggers });
      const findings = wanted ? res.findings.filter((f) => wanted.has(f.path) || f.rule === "S6") : res.findings;
      return { commit, findings, filesScanned: res.filesScanned, shippedFiles: res.shippedFiles, exempted: res.exempted, unverified: res.unverified };
    },

    async toolProbe({ tools }) {
      const dirs = (process.env.PATH ?? "").split(platform() === "win32" ? ";" : ":").filter(Boolean);
      const exts = platform() === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
      const onPath = (bin: string) => {
        for (const d of dirs) for (const x of exts) if (existsSync(join(d, bin + x))) return join(d, bin + x);
        return null;
      };
      const atPath = async (p: string) => {
        const full = p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
        const star = full.indexOf("*");
        if (star < 0) return existsSync(full) ? full : null;
        // one wildcard segment: list its parent and try each entry, newest name last
        const parent = full.slice(0, full.lastIndexOf(sep, star));
        const segEnd = full.indexOf(sep, star);
        const seg = full.slice(parent.length + 1, segEnd < 0 ? undefined : segEnd);
        const rest = segEnd < 0 ? "" : full.slice(segEnd);
        const re = new RegExp(`^${seg.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
        const names = await readdir(parent).catch(() => [] as string[]);
        for (const n of names.filter((x) => re.test(x)).sort().reverse()) if (existsSync(join(parent, n) + rest)) return join(parent, n) + rest;
        return null;
      };
      const found: Record<string, string | null> = {};
      for (const t of tools) {
        let hit: string | null = null;
        for (const b of t.bins) hit ??= onPath(b);
        for (const p of t.paths ?? []) hit ??= await atPath(p);
        found[t.id] = hit;
      }
      return { found };
    },

    async probe() {
      const plat = platform();
      const [gitV, xcode, swift, gradle, dotnet] = await Promise.all([
        versionOf("git", ["--version"]),
        plat === "darwin" ? versionOf("xcodebuild", ["-version"]) : Promise.resolve(null),
        versionOf("swift", ["--version"]),
        versionOf("gradle", ["--version"]),
        versionOf("dotnet", ["--version"]),
      ]);
      const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
      return { platform: plat, home: homedir() || null, git: gitV, xcode, swift, gradle: gradle ? gradle.replace(/^-+$/, "").trim() || "gradle" : null, androidSdk: !!(sdk && existsSync(sdk)), dotnet };
    },
  };
}
