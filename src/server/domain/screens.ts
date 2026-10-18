// The Screens view: the human clicks through an app's screens like a tiny browser. Nothing
// runs; the pages are the screenshots the builders commit (reports/ui, reports/<platform>/…),
// and the links between them come from an optional screen map the UI builder writes at
// reports/screens/screens.json. Without a map, every captured screen is still a page.

import { z } from "zod";

export const SCREEN_MAP_PATH = "reports/screens/screens.json";

export interface ScanFile {
  root: string;
  rel: string;
  mtime: number;
}

export interface ScreenVariant {
  /** Absolute path on the host (what screens_image reads). */
  path: string;
  rel: string;
  platform: string | null;
  size: string | null;
  theme: string | null;
  state: string | null;
  mtime: number;
}

export interface ScreenLink {
  to: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string | null;
}

export interface Screen {
  id: string;
  name: string;
  note: string | null;
  variants: ScreenVariant[];
  links: ScreenLink[];
}

export interface ScreenMap {
  start: string | null;
  screens: Screen[];
  /** "map": the builders' screen map drove the pages and links; "files": pages from screenshots only. */
  source: "map" | "files";
  problems: string[];
}

const unit = z.number().min(0).max(1);
const ManifestZ = z.object({
  start: z.string().max(80).optional(),
  screens: z
    .array(
      z.object({
        id: z.string().min(1).max(80),
        name: z.string().max(80).optional(),
        note: z.string().max(300).optional(),
        image: z.string().max(400).optional(),
        images: z.array(z.string().max(400)).max(24).optional(),
        links: z.array(z.object({ to: z.string().min(1).max(80), x: unit, y: unit, w: unit, h: unit, label: z.string().max(80).optional() })).max(40).optional(),
      }),
    )
    .max(200),
});

/** Folders whose images are screens (gate and audit evidence is not). */
const SCREEN_DIR = /^(?:.*\/)?reports\/(ui|ios|and|mac|win|web|unreal|game|screens)\//;
const OTHER_SCREEN_DIR = /(^|\/)(screens|screenshots)\//i;
export const IMAGE_FILE = /\.(png|jpe?g|webp|gif)$/i;
const THEMES = new Set(["light", "dark"]);
const SIZES = /^(phone|tablet|desktop|watch|tv|mobile|small|medium|large|compact|regular|expanded|\d{3,4}(w|px)?|\d{3,4}x\d{3,4})$/i;
const STATES = new Set(["default", "empty", "loading", "error", "offline", "filled", "populated", "disabled", "selected", "success", "largetext", "large-text", "a11y"]);
const START_NAMES = ["home", "main", "index", "root", "launch", "start", "dashboard", "today", "feed", "onboarding", "welcome", "login", "sign-in"];

export function screenId(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function title(id: string): string {
  return id
    .split("-")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

export function isScreenFile(rel: string): boolean {
  const r = rel.replace(/\\/g, "/");
  return IMAGE_FILE.test(r) && (SCREEN_DIR.test(r) || OTHER_SCREEN_DIR.test(r)) && !/\/reports\/(review|slop|audit|security|compliance|tests?)\//.test(`/${r}`);
}

/** What a screenshot's path says about it: the screen and the variant. */
export function parseScreenFile(f: ScanFile): { id: string; variant: ScreenVariant } | null {
  const rel = f.rel.replace(/\\/g, "/");
  if (!isScreenFile(rel)) return null;
  const platform = rel.match(/(?:^|\/)reports\/(ui|ios|and|mac|win|web|unreal|game)\//)?.[1] ?? null;
  const base = rel.split("/").pop()!.replace(IMAGE_FILE, "");
  let parts: string[];
  let screen: string;
  if (base.includes("--")) {
    // reports/ui/<screen>--<state>--<size>--<theme>.png
    parts = base.split("--").map((p) => p.trim()).filter(Boolean);
    screen = parts.shift() ?? base;
  } else {
    // <route>-<width>-<theme>.png, home_dark.png, 01-settings.png …
    const tokens = base.split(/[-_. ]+/).filter(Boolean);
    const keep: string[] = [];
    parts = [];
    for (const t of tokens) (THEMES.has(t.toLowerCase()) || SIZES.test(t) || STATES.has(t.toLowerCase()) ? parts : keep).push(t);
    if (keep.length > 1 && /^\d{1,3}$/.test(keep[0])) keep.shift(); // a leading order number
    screen = keep.join("-") || base;
  }
  const id = screenId(screen);
  if (!id) return null;
  let size: string | null = null;
  let theme: string | null = null;
  let state: string | null = null;
  for (const p of parts) {
    const l = p.toLowerCase();
    if (THEMES.has(l)) theme = l;
    else if (SIZES.test(l)) size = l;
    else state = state ? `${state} ${l}` : l;
  }
  return { id, variant: { path: joinPath(f.root, rel), rel, platform, size, theme, state, mtime: f.mtime } };
}

function joinPath(root: string, rel: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${rel.replace(/^[\\/]+/, "")}`;
}

/** Order variants so the first is the one to show by default: phone, light, default state, newest. */
function rankVariant(v: ScreenVariant): number {
  return (v.size && !/^(phone|mobile|compact|small|390|375|393)/.test(v.size) ? 4 : 0) + (v.theme === "dark" ? 2 : 0) + (v.state && v.state !== "default" ? 1 : 0);
}

/**
 * Build the pages of an app from the screenshots found under its folders and the screen map
 * (if any). The same relative file in several worktrees counts once: the newest wins.
 */
export function buildScreenMap(files: ScanFile[], manifests: Array<{ root: string; text: string; mtime: number }>): ScreenMap {
  const problems: string[] = [];
  const newest = new Map<string, ScanFile>();
  for (const f of files) {
    const prev = newest.get(f.rel);
    if (!prev || f.mtime > prev.mtime) newest.set(f.rel, f);
  }
  const byId = new Map<string, Screen>();
  const byRel = new Map<string, ScreenVariant>();
  for (const f of newest.values()) {
    const p = parseScreenFile(f);
    if (!p) continue;
    byRel.set(p.variant.rel, p.variant);
    let s = byId.get(p.id);
    if (!s) byId.set(p.id, (s = { id: p.id, name: title(p.id), note: null, variants: [], links: [] }));
    s.variants.push(p.variant);
  }

  // the newest screen map wins
  const m = [...manifests].sort((a, b) => b.mtime - a.mtime)[0];
  let order: string[] = [];
  let start: string | null = null;
  let source: ScreenMap["source"] = "files";
  if (m) {
    let parsed: z.infer<typeof ManifestZ> | null = null;
    try {
      const r = ManifestZ.safeParse(JSON.parse(m.text));
      if (r.success) parsed = r.data;
      else problems.push(`${SCREEN_MAP_PATH}: ${r.error.issues[0]?.path.join(".") || "?"}: ${r.error.issues[0]?.message ?? "invalid"}`);
    } catch (err) {
      problems.push(`${SCREEN_MAP_PATH} is not valid JSON (${err instanceof Error ? err.message.slice(0, 120) : "parse error"}).`);
    }
    if (parsed) {
      source = "map";
      for (const ms of parsed.screens) {
        const id = screenId(ms.id) || ms.id;
        let s = byId.get(id);
        if (!s) byId.set(id, (s = { id, name: title(id), note: null, variants: [], links: [] }));
        if (ms.name) s.name = ms.name;
        if (ms.note) s.note = ms.note;
        for (const img of [...(ms.image ? [ms.image] : []), ...(ms.images ?? [])]) {
          const rel = img.replace(/\\/g, "/").replace(/^\.\//, "");
          if (rel.startsWith("/") || rel.split("/").includes("..") || !IMAGE_FILE.test(rel)) {
            problems.push(`${id}: image "${img}" must be a relative image path inside the repository.`);
            continue;
          }
          if (s.variants.some((v) => v.rel === rel)) continue;
          const known = byRel.get(rel) ?? { path: joinPath(m.root, rel), rel, platform: null, size: null, theme: null, state: null, mtime: m.mtime };
          s.variants.unshift(known);
        }
        s.links = (ms.links ?? []).map((l) => ({ to: screenId(l.to) || l.to, x: l.x, y: l.y, w: Math.min(l.w, 1 - l.x), h: Math.min(l.h, 1 - l.y), label: l.label ?? null }));
        if (!order.includes(id)) order.push(id);
      }
      for (const s of byId.values()) for (const l of s.links) if (!byId.has(l.to)) problems.push(`${s.id}: link to unknown screen "${l.to}".`);
      start = parsed.start && byId.has(screenId(parsed.start)) ? screenId(parsed.start) : null;
    }
  }

  const rest = [...byId.keys()].filter((id) => !order.includes(id));
  const rank = (id: string) => {
    const i = START_NAMES.indexOf(id);
    return i < 0 ? START_NAMES.length : i;
  };
  rest.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  order = [...order, ...rest];
  const screens = order.map((id) => byId.get(id)!).filter((s) => s.variants.length || s.links.length);
  for (const s of screens) s.variants.sort((a, b) => rankVariant(a) - rankVariant(b) || b.mtime - a.mtime || a.rel.localeCompare(b.rel));
  if (!start) start = screens.find((s) => s.variants.length)?.id ?? null;
  return { start, screens, source, problems: problems.slice(0, 20) };
}
