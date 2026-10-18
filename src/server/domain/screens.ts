// The Screens view: the human clicks through an app's screens like a tiny browser. Nothing
// runs; the pages are the screenshots the builders commit (reports/ui, reports/<platform>/…),
// and the links between them come from the screen map the UI builder writes at
// reports/screens/screens.json. Strict about what counts as a page (the human's rule: "just
// showing the UI"): with a map, only its pages; never evidence or debug captures (before/after,
// probes, names with a commit or a time); never captures for a platform the app does not target;
// and for a phone app, never a capture shaped like a computer screen.

import { z } from "zod";
import { DEVICE_CATALOG } from "../../shared/devices.ts";

export const SCREEN_MAP_PATH = "reports/screens/screens.json";

export interface ScanFile {
  root: string;
  rel: string;
  mtime: number;
  /** Pixel size, when the host could read the image's header. */
  w?: number | null;
  h?: number | null;
}

/** The shape of one capture: a phone or tablet held upright, or anything wider. */
export type Form = "phone" | "tablet" | "wide";
/** How the viewer frames the app's pages. */
export type Device = "phone" | "desktop" | "web" | "any";

/** What the app is, so only its own kind of screen is shown. */
export interface ScreenTarget {
  name: string;
  platforms: string[];
  /** The phones the human wants each page on, in order (the "Phones for screenshots" setting). */
  devices?: string[];
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
  w: number | null;
  h: number | null;
  form: Form | null;
  /** The phone or tablet it was captured on ("iPhone 17 Pro Max"), from its file name. */
  device: string | null;
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
  /** How to frame the pages: a phone for an iOS or Android app. */
  device: Device;
  /** The phones the pages were captured on: the human's list first, in its order. */
  devices: string[];
  /** Captures that were found and are not pages, with why (counts per reason). */
  hidden: { count: number; reasons: string[] };
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

const DEVICE_START = /^(iphone|ipad|pixel|galaxy|samsung|nexus|oneplus)$/i;
const DEVICE_PART = /^(\d{1,2}(e|a)?|pro|max|plus|mini|air|se|ultra|fold\d*|flip\d*|xl|lite|fe|s\d{1,2}|z|galaxy|tablet|tab|m\d|a\d{2}|(1st|2nd|3rd|\d+th)|generation|inch|\d{2}(in)?)$/i;

/** "iPhone 17 Pro Max" or "iphone-17-pro-max" → "iphone-17-pro-max". */
export function deviceSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** "iphone-17-pro-max" → "iPhone 17 Pro Max" (a device in Helm's list keeps its exact name: "iPhone SE (3rd generation)"). */
export function deviceName(slug: string): string {
  const known = DEVICE_CATALOG.find((d) => deviceSlug(d.name) === slug);
  if (known) return known.name;
  return slug
    .split("-")
    .filter(Boolean)
    .map((t) => (t === "iphone" ? "iPhone" : t === "ipad" ? "iPad" : /^(se|xl|fe)$/.test(t) ? t.toUpperCase() : /^\d/.test(t) ? t : t[0].toUpperCase() + t.slice(1)))
    .join(" ");
}

/** A device named inside a list of name tokens: its slug and where it starts and ends. */
function findDevice(tokens: string[]): { slug: string; from: number; to: number } | null {
  const i = tokens.findIndex((t) => DEVICE_START.test(t));
  if (i < 0) return null;
  let j = i + 1;
  while (j < tokens.length && DEVICE_PART.test(tokens[j])) j++;
  return { slug: tokens.slice(i, j).join("-").toLowerCase(), from: i, to: j };
}

/** What a screenshot's path says about it: the screen and the variant. */
export function parseScreenFile(f: ScanFile): { id: string; variant: ScreenVariant } | null {
  const rel = f.rel.replace(/\\/g, "/");
  if (!isScreenFile(rel)) return null;
  const platform = rel.match(/(?:^|\/)reports\/ui\/(ios|and|mac|win|web)\//)?.[1] ?? rel.match(/(?:^|\/)reports\/(ui|ios|and|mac|win|web|unreal|game)\//)?.[1] ?? null;
  const base = rel.split("/").pop()!.replace(IMAGE_FILE, "");
  let parts: string[];
  let screen: string;
  let device: string | null = null;
  if (base.includes("--")) {
    // reports/ui/<screen>--<state>--<size>--<theme>.png
    parts = base.split("--").map((p) => p.trim()).filter(Boolean);
    screen = parts.shift() ?? base;
    const at = parts.findIndex((p) => findDevice(p.split(/[-_. ]+/))?.from === 0);
    if (at >= 0) device = deviceName(deviceSlug(parts.splice(at, 1)[0]));
  } else {
    // <route>-<width>-<theme>.png, home_dark.png, 01-settings.png, home-iphone-air.png …
    const all = base.split(/[-_. ]+/).filter(Boolean);
    const d = findDevice(all);
    if (d) device = deviceName(d.slug);
    const tokens = d ? [...all.slice(0, d.from), ...all.slice(d.to)] : all;
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
  const w = f.w ?? null;
  const h = f.h ?? null;
  return { id, variant: { path: joinPath(f.root, rel), rel, platform, size, theme, state, mtime: f.mtime, w, h, form: formOf(w, h, size) ?? (device ? (/^ipad/i.test(device) ? "tablet" : "phone") : null), device } };
}

/** A capture's shape from its pixels (upright phone ≥ 1.55 tall per wide), else from its size word. */
export function formOf(w: number | null, h: number | null, size: string | null): Form | null {
  if (w && h) {
    const r = h / w;
    return r >= 1.55 ? "phone" : r >= 1.15 ? "tablet" : "wide";
  }
  if (!size) return null;
  if (/^(phone|mobile|compact|small|watch|3\d\d(w|px)?)$/i.test(size)) return "phone";
  if (/^(tablet|regular|medium)$/i.test(size)) return "tablet";
  if (/^(desktop|large|expanded|tv|(1[0-9]|[2-9]\d)\d\d(w|px)?)$/i.test(size)) return "wide";
  return null;
}

const MOBILE = new Set(["ios", "and"]);
const NAMES: Record<string, string> = { ios: "iOS", and: "Android", mac: "macOS", win: "Windows", web: "the web" };

/** How the viewer frames an app: a phone when every platform it targets is a phone OS. */
export function deviceFor(platforms: string[]): Device {
  if (platforms.length && platforms.every((p) => MOBILE.has(p))) return "phone";
  if (platforms.length && platforms.every((p) => p === "web")) return "web";
  if (platforms.length && platforms.every((p) => p === "mac" || p === "win")) return "desktop";
  return "any";
}

/** Folders of agents' proof and design targets, not the app's pages. */
const EVIDENCE_DIR = /(^|\/)(evidence|reviews?|slop|audit|security|compliance|tests?|checks|debug|probes?|repro|diffs?|baselines?|targets?|compare|comparisons?|failures?|tmp|temp|old|archive|before|after)\//i;
/** File names of debug captures: before/after shots, probes, or a commit or a time in the name. */
const DEBUG_WORD = /^(before|after|probe|stuck|debug|repro|worktree|reload|persisted|unresolved|crash|failed?|failure|diff|wip|tmp|temp|old|test|broken|bug)$/i;
const DEBUG_TOKEN = /^(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}$|^\d{3,4}z$|^\d{8}(t\d{4,6}z?)?$|^\d{10,13}$/i;

export function debugCapture(rel: string): boolean {
  const r = rel.replace(/\\/g, "/");
  if (EVIDENCE_DIR.test(r.split("/").slice(0, -1).join("/") + "/")) return true;
  const base = r.split("/").pop()!.replace(IMAGE_FILE, "");
  if (/\d{4}-\d{2}-\d{2}/.test(base)) return true;
  return base.split(/[-_. ]+|--/).some((t) => DEBUG_WORD.test(t) || DEBUG_TOKEN.test(t));
}

/** Why a capture is not one of the app's pages, or null when it is. */
export function notAPage(v: ScreenVariant, target: ScreenTarget | null): string | null {
  if (!target?.platforms.length) return null;
  if (v.platform && NAMES[v.platform] && !target.platforms.includes(v.platform)) return `captures for ${NAMES[v.platform]}, which ${target.name} does not target`;
  if (deviceFor(target.platforms) === "phone" && v.form === "wide") return `captures shaped like a computer screen; ${target.name} is a phone app`;
  return null;
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
 * (if any). The same relative file in several worktrees counts once: the newest wins. With a
 * `target`, captures that are not the app's own kind of screen are hidden (and counted).
 */
export function buildScreenMap(files: ScanFile[], manifests: Array<{ root: string; text: string; mtime: number }>, target: ScreenTarget | null = null): ScreenMap {
  const problems: string[] = [];
  const hidden = new Map<string, number>();
  const hide = (why: string) => hidden.set(why, (hidden.get(why) ?? 0) + 1);
  const newest = new Map<string, ScanFile>();
  for (const f of files) {
    const prev = newest.get(f.rel);
    if (!prev || f.mtime > prev.mtime) newest.set(f.rel, f);
  }
  const byId = new Map<string, Screen>();
  const byRel = new Map<string, ScreenVariant>();
  const fromFiles = new Map<string, ScreenVariant[]>();
  for (const f of newest.values()) {
    const p = parseScreenFile(f);
    if (!p) continue;
    byRel.set(p.variant.rel, p.variant);
    const list = fromFiles.get(p.id) ?? [];
    list.push(p.variant);
    fromFiles.set(p.id, list);
  }

  // the newest screen map wins
  const m = [...manifests].sort((a, b) => b.mtime - a.mtime)[0];
  let parsed: z.infer<typeof ManifestZ> | null = null;
  if (m) {
    try {
      const r = ManifestZ.safeParse(JSON.parse(m.text));
      if (r.success) parsed = r.data;
      else problems.push(`${SCREEN_MAP_PATH}: ${r.error.issues[0]?.path.join(".") || "?"}: ${r.error.issues[0]?.message ?? "invalid"}`);
    } catch (err) {
      problems.push(`${SCREEN_MAP_PATH} is not valid JSON (${err instanceof Error ? err.message.slice(0, 120) : "parse error"}).`);
    }
  }

  const keep = (v: ScreenVariant, listed: boolean): boolean => {
    const why = notAPage(v, target) ?? (!listed && debugCapture(v.rel) ? "evidence or debug captures (before/after, probes, a commit or a time in the name), not pages" : null);
    if (why) hide(why);
    return !why;
  };

  let order: string[] = [];
  let start: string | null = null;
  let source: ScreenMap["source"] = "files";
  if (parsed && m) {
    // with a map, its pages are the only pages; captures of other screens are not shown
    source = "map";
    const listed = new Set<string>();
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
        if (s.variants.some((v) => v.rel === rel) || listed.has(rel)) continue;
        listed.add(rel);
        const known = byRel.get(rel) ?? { path: joinPath(m.root, rel), rel, platform: null, size: null, theme: null, state: null, mtime: m.mtime, w: null, h: null, form: null, device: null };
        if (keep(known, true)) s.variants.push(known);
      }
      for (const v of fromFiles.get(id) ?? []) if (!s.variants.some((x) => x.rel === v.rel) && keep(v, false)) s.variants.push(v);
      fromFiles.delete(id);
      s.links = (ms.links ?? []).map((l) => ({ to: screenId(l.to) || l.to, x: l.x, y: l.y, w: Math.min(l.w, 1 - l.x), h: Math.min(l.h, 1 - l.y), label: l.label ?? null }));
      if (!order.includes(id)) order.push(id);
    }
    for (const list of fromFiles.values()) for (const v of list) if (!listed.has(v.rel) && keep(v, false)) hide("captures of screens that are not in the screen map");
    for (const s of byId.values()) for (const l of s.links) if (!byId.has(l.to)) problems.push(`${s.id}: link to unknown screen "${l.to}".`);
    start = parsed.start && byId.has(screenId(parsed.start)) ? screenId(parsed.start) : null;
  } else {
    for (const [id, list] of fromFiles) {
      const vs = list.filter((v) => keep(v, false));
      if (vs.length) byId.set(id, { id, name: title(id), note: null, variants: vs, links: [] });
    }
    const rank = (id: string) => {
      const i = START_NAMES.indexOf(id);
      return i < 0 ? START_NAMES.length : i;
    };
    order = [...byId.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }

  const screens = order.map((id) => byId.get(id)!).filter((s) => s.variants.length || s.links.length);
  // the human's phones first, in their order; then the usual default (phone, light, default state, newest)
  const wanted = (target?.devices ?? []).map(deviceSlug);
  const dRank = (v: ScreenVariant) => {
    if (!v.device) return wanted.length + 1;
    const i = wanted.indexOf(deviceSlug(v.device));
    return i < 0 ? wanted.length : i;
  };
  for (const s of screens) s.variants.sort((a, b) => dRank(a) - dRank(b) || rankVariant(a) - rankVariant(b) || b.mtime - a.mtime || a.rel.localeCompare(b.rel));
  const found = [...new Set(screens.flatMap((s) => s.variants.map((v) => v.device).filter((d): d is string => !!d)))];
  const devices = found.sort((a, b) => {
    const ia = wanted.indexOf(deviceSlug(a));
    const ib = wanted.indexOf(deviceSlug(b));
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  if (!start) start = screens.find((s) => s.variants.length)?.id ?? null;
  const count = [...hidden.values()].reduce((a, b) => a + b, 0);
  return {
    start,
    screens,
    source,
    problems: problems.slice(0, 20),
    device: deviceFor(target?.platforms ?? []),
    devices,
    hidden: { count, reasons: [...hidden].sort((a, b) => b[1] - a[1]).map(([why, n]) => `${n} ${why}`) },
  };
}
