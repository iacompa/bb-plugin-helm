// Host side of the Screens view: find the screenshots the builders committed under an app's
// folders, read the screen map, and return one image at a time. Read-only: nothing runs, nothing
// is booted or installed. The server passes only folders from Helm's own records, and reads
// only paths this scan returned.

import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";

const SKIP = new Set(["node_modules", ".git", ".gradle", "Pods", ".build", "build", "DerivedData", "SourcePackages", ".helm", ".worktrees", ".bb-worktrees", "dist", ".next", "vendor"]);
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const MAP = join("reports", "screens", "screens.json");
const MAX_FILES = 600;

async function walk(root: string, dir: string, depth: number, out: Array<{ root: string; rel: string; mtime: number }>, deadline: number): Promise<void> {
  if (depth < 0 || Date.now() > deadline || out.length >= MAX_FILES) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of entries) {
    if (Date.now() > deadline || out.length >= MAX_FILES) return;
    if (SKIP.has(d.name) || d.name.startsWith(".")) continue;
    const p = join(dir, d.name);
    if (d.isDirectory()) await walk(root, p, depth - 1, out, deadline);
    else if (d.isFile() && IMAGE.test(d.name)) {
      const rel = relative(root, p).split(sep).join("/");
      if (!/(^|\/)(reports|screens|screenshots)\//i.test(rel)) continue;
      try {
        out.push({ root, rel, mtime: (await stat(p)).mtimeMs });
      } catch {}
    }
  }
}

export function createScreenOps() {
  return {
    /** Screenshots under each folder's reports/ (and screens/ or screenshots/) folders, plus each folder's screen map. */
    async screensScan({ roots }: { roots: string[] }) {
      const files: Array<{ root: string; rel: string; mtime: number }> = [];
      const maps: Array<{ root: string; text: string; mtime: number }> = [];
      const deadline = Date.now() + 10_000;
      for (const root of roots) {
        if (!existsSync(root)) continue;
        await walk(root, root, 8, files, deadline);
        const m = join(root, MAP);
        try {
          const st = await stat(m);
          if (st.isFile() && st.size <= 256 * 1024) maps.push({ root, text: await readFile(m, "utf8"), mtime: st.mtimeMs });
        } catch {}
      }
      return { files, maps };
    },

    /** One image as base64: png, jpg, gif or webp, at most 8 MB. */
    async screenImage({ path }: { path: string }) {
      const ext = extname(path).toLowerCase();
      if (!MIME[ext] || !existsSync(path)) return { data: null, mime: "" };
      const st = await stat(path);
      if (!st.isFile() || st.size > 8 * 1024 * 1024) return { data: null, mime: "" };
      return { data: (await readFile(path)).toString("base64"), mime: MIME[ext] };
    },
  };
}
