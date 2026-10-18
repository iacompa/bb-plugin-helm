// Host side of the Git agent's Worktrees view: how much disk each folder takes (worktrees, a
// repository's shared git storage) and how much is free on the disk it is on. Read-only: `du`
// where it exists (macOS, Linux), a bounded walk elsewhere; free space from statfs.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readdir, statfs } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { gitEnv } from "./git-env.ts";

export interface DiskSize {
  path: string;
  /** Bytes on disk; null when it could not be measured. */
  bytes: number | null;
  /** Device id, so folders on the same disk group together. */
  dev: number | null;
  free: number | null;
  total: number | null;
}

function du(path: string): Promise<number | null> {
  return new Promise((res) => {
    execFile("du", ["-sk", path], { timeout: 180_000, maxBuffer: 1024 * 1024, encoding: "utf8" }, (_err, stdout) => {
      // du exits non-zero on unreadable subfolders but still prints the total
      const kb = Number(String(stdout ?? "").trim().split(/\s+/)[0]);
      res(Number.isFinite(kb) && kb >= 0 && String(stdout ?? "").trim() ? kb * 1024 : null);
    });
  });
}

async function walk(path: string, deadline: number): Promise<number | null> {
  let total = 0;
  const stack = [path];
  while (stack.length) {
    if (Date.now() > deadline) return null;
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of entries) {
      const p = join(dir, d.name);
      if (d.isDirectory()) stack.push(p);
      else if (d.isFile())
        try {
          const st = await lstat(p);
          total += st.blocks ? st.blocks * 512 : st.size;
        } catch {}
    }
  }
  return total;
}

async function measure(path: string): Promise<number | null> {
  if (!existsSync(path)) return null;
  if (process.platform !== "win32") {
    const n = await du(path);
    if (n !== null) return n;
  }
  return walk(path, Date.now() + 120_000);
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

/** The repository's shared git storage (objects and refs every branch and worktree uses). */
function gitCommonDir(repo: string): Promise<string | null> {
  return new Promise((res) => {
    execFile("git", ["rev-parse", "--git-common-dir"], { cwd: repo, timeout: 20_000, encoding: "utf8", env: gitEnv({ GIT_OPTIONAL_LOCKS: "0" }) }, (err, stdout) => {
      const d = String(stdout ?? "").trim();
      res(err || !d ? null : isAbsolute(d) ? d : resolve(repo, d));
    });
  });
}

/**
 * Show a folder in the file manager, selected in its parent where the platform can. Always a
 * reveal, never an open: opening an app bundle or a file would launch it.
 */
function openInFileManager(dir: string): Promise<boolean> {
  const [cmd, args] = process.platform === "darwin" ? ["open", ["-R", dir]] : process.platform === "win32" ? ["explorer.exe", [`/select,${dir}`]] : ["xdg-open", [dir]];
  return new Promise((res) => {
    // explorer.exe exits 1 even when it opened the window
    execFile(cmd as string, args as string[], { timeout: 15_000 }, (err) => res(!err || process.platform === "win32"));
  });
}

export function createDiskOps() {
  return {
    /** Show a folder in Finder (Explorer, the Files app); a folder that is gone opens its nearest existing parent. */
    async reveal({ path }: { path: string }) {
      if (!isAbsolute(path)) return { ok: false, shown: null };
      let p = resolve(path);
      while (!existsSync(p)) {
        const up = dirname(p);
        if (up === p) return { ok: false, shown: null };
        p = up;
      }
      // only plain folders are shown; for anything else (a file, a link) its folder is
      const st = await lstat(p).catch(() => null);
      if (!st?.isDirectory()) p = dirname(p);
      return { ok: await openInFileManager(p), shown: p };
    },
    /** Size of each folder (with `measure`), its disk's free and total space, and each repository's git storage. */
    async diskUsage({ paths, repos, measure: doMeasure }: { paths: string[]; repos?: string[]; measure?: boolean }) {
      const one = async (path: string): Promise<DiskSize> => {
        let dev: number | null = null;
        let free: number | null = null;
        let total: number | null = null;
        try {
          dev = (await lstat(path)).dev;
          const fs = await statfs(path);
          free = fs.bavail * fs.bsize;
          total = fs.blocks * fs.bsize;
        } catch {}
        return { path, bytes: doMeasure === false ? null : await measure(path), dev, free, total };
      };
      const sizes = await pool(paths, 4, one);
      const stores = await pool(repos ?? [], 2, async (repo) => {
        const gitDir = existsSync(repo) ? await gitCommonDir(repo) : null;
        return { repo, gitDir, bytes: gitDir && doMeasure !== false ? await measure(gitDir) : null };
      });
      return { sizes, repos: stores };
    },
  };
}
