// Host side of the Screens view: find the screenshots the builders committed under an app's
// folders, read the screen map, and return one image at a time. Read-only: nothing runs, nothing
// is booted or installed. The server passes only folders from Helm's own records, and reads
// only paths this scan returned.

import { existsSync } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";

// agents' proof folders are skipped too: their captures are never pages
const SKIP = new Set(["node_modules", ".git", ".gradle", "Pods", ".build", "build", "DerivedData", "SourcePackages", ".helm", ".worktrees", ".bb-worktrees", ".helm-work", "dist", ".next", "vendor", "evidence"]);
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const MAP = join("reports", "screens", "screens.json");
const MAX_FILES = 600;

type Found = { root: string; rel: string; mtime: number; w: number | null; h: number | null };

/** Pixel size from the first bytes of a PNG, GIF, WebP or JPEG; null when it cannot tell. */
export function imageSize(b: Buffer): { w: number; h: number } | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.length >= 10 && b.toString("ascii", 0, 3) === "GIF") return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b.length >= 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const kind = b.toString("ascii", 12, 16);
    if (kind === "VP8X") return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (kind === "VP8L") {
      const v = b.readUInt32LE(21);
      return { w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff) };
    }
    if (kind === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

async function sizeOf(p: string): Promise<{ w: number; h: number } | null> {
  let fh: import("node:fs/promises").FileHandle | null = null;
  try {
    fh = await open(p, "r");
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return imageSize(buf.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function walk(root: string, dir: string, depth: number, out: Found[], deadline: number): Promise<void> {
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
        const size = await sizeOf(p);
        out.push({ root, rel, mtime: (await stat(p)).mtimeMs, w: size?.w ?? null, h: size?.h ?? null });
      } catch {}
    }
  }
}

export function createScreenOps() {
  return {
    /** Screenshots under each folder's reports/ (and screens/ or screenshots/) folders, plus each folder's screen map. */
    async screensScan({ roots }: { roots: string[] }) {
      const files: Found[] = [];
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
