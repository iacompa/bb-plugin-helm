// Reading the brief (§7.7). Structured briefs (# Group headings and
// "- Name — tagline · iOS Android" lines, optionally "· /path/to/folder",
// "· reads /a, ~/b", a kind word "· Website", "· needs payments, HIPAA" and
// "· tools Unreal, Blender") are parsed deterministically; anything else goes to the
// planner thread, whose only output is a PortfolioSchema. Either way each project's
// kind, needs and tools are decided (profile.ts) where the brief does not name them.
import { z } from "zod";
import type { Platform, Portfolio, PortfolioApp, ProjectKind, ProjectNeed } from "../../shared/types.ts";
import { PLATFORM_LABEL } from "./roles.ts";
import { inferProfile, kindWord, listWords, normalizeNeed, normalizeTool, profileAssumption, PROFILE_HINT } from "./profile.ts";

export const PlatformSchema = z.enum(["mac", "win", "ios", "and", "web"]);
export const ShapeSchema = z.enum(["solo", "lean", "full"]);

const PLATFORM_ALIASES: Record<string, Platform> = {
  ios: "ios",
  iphone: "ios",
  ipad: "ios",
  android: "and",
  and: "and",
  macos: "mac",
  mac: "mac",
  osx: "mac",
  windows: "win",
  win: "win",
  web: "web",
  website: "web",
  browser: "web",
};

/** Accepts both Helm ids and the words people type ("Android", "macOS"). */
export const PlatformLooseSchema = z
  .string()
  .transform((s, ctx) => {
    const k = s.trim().toLowerCase().replace(/\s+/g, "");
    const p = PLATFORM_ALIASES[k];
    if (!p) {
      ctx.addIssue({ code: "custom", message: `Unknown platform "${s}" (use ios, android, macos, windows or web)` });
      return z.NEVER;
    }
    return p;
  });

/** "Website", "full-stack", "audit" → a project kind. */
export const KindLooseSchema = z.string().transform((s, ctx) => {
  const k = kindWord(s);
  if (!k) {
    ctx.addIssue({ code: "custom", message: `Unknown kind "${s}" (use app, web, game, automation or review)` });
    return z.NEVER;
  }
  return k;
});

export const PortfolioSchema = z
  .object({
    apps: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(60),
            tagline: z.string().trim().max(160).default(""),
            platforms: z.array(PlatformLooseSchema).max(5).default([]),
            group: z.string().trim().max(60).nullish(),
            shape: ShapeSchema.optional(),
            notes: z.string().max(1200).nullish(),
            path: z.string().trim().min(1).max(500).nullish(),
            reads: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
            kind: KindLooseSchema.optional(),
            needs: z.array(z.string().max(40)).max(12).optional(),
            tools: z.array(z.string().max(60)).max(8).optional(),
          })
          .strict(),
      )
      .max(60),
    groups: z.array(z.string().max(60)).max(20).default([]),
    assumptions: z.array(z.string().max(400)).max(20).default([]),
    questions: z.array(z.string().max(300)).max(3).default([]),
  })
  .strict();

export type PortfolioInput = z.input<typeof PortfolioSchema>;

/**
 * Fill in a project's kind, needs, tools and platforms: what was named is kept, the rest is
 * decided from its name, tagline and notes. `context` (a brief heading) informs the decision
 * without being stored.
 */
export function applyProfile(a: PortfolioApp, context = ""): { app: PortfolioApp; assumption: string | null } {
  const named = a.platformsAssumed ? [] : a.platforms;
  const p = inferProfile({ name: a.name, tagline: a.tagline, notes: [a.notes ?? "", context].join(" "), platforms: named, kind: a.kind, needs: a.needs, tools: a.tools });
  return { app: { ...a, kind: p.kind, needs: p.needs, tools: p.tools, platforms: p.platforms, platformsAssumed: p.platformsAssumed }, assumption: profileAssumption(a.name, p) };
}

/** Profiles for a portfolio that arrived from elsewhere (the wizard, the API); assumptions are not repeated. */
export function withProfiles(p: Portfolio): Portfolio {
  return { ...p, apps: p.apps.map((a) => applyProfile(a).app) };
}

function platformAssumption(a: PortfolioApp): string | null {
  if (!a.platformsAssumed) return null;
  return `${a.name}: no platforms given — assumed ${a.platforms.map((x) => PLATFORM_LABEL[x]).join(" and ")}.`;
}

function needsOf(words: string[]): { needs: ProjectNeed[]; unknown: string[] } {
  const needs: ProjectNeed[] = [];
  const unknown: string[] = [];
  for (const w of words) {
    const n = normalizeNeed(w);
    if (n) needs.push(n);
    else unknown.push(w);
  }
  return { needs: [...new Set(needs)], unknown };
}

function toolsOf(words: string[]): string[] {
  return [...new Set(words.map(normalizeTool).filter((x): x is string => !!x))];
}

export function normalizePortfolio(p: z.output<typeof PortfolioSchema>): Portfolio {
  const assumptions = [...p.assumptions];
  const apps: PortfolioApp[] = p.apps.map((a) => {
    const platforms = [...new Set(a.platforms)];
    const nd = a.needs ? needsOf(a.needs) : null;
    const notes = [a.notes ?? "", nd?.unknown.length ? `Also needs: ${nd.unknown.join(", ")}.` : ""].filter(Boolean).join(" ") || null;
    const base: PortfolioApp = {
      name: a.name,
      tagline: a.tagline,
      platforms,
      platformsAssumed: platforms.length === 0,
      group: a.group ?? null,
      shape: a.shape,
      notes,
      ...(a.path ? { path: a.path } : {}),
      ...(a.reads.length ? { reads: [...new Set(a.reads)] } : {}),
      ...(a.kind ? { kind: a.kind } : {}),
      ...(nd ? { needs: nd.needs } : {}),
      ...(a.tools ? { tools: toolsOf(a.tools) } : {}),
    };
    const { app } = applyProfile(base);
    const pa = platformAssumption(app);
    if (pa && !assumptions.some((x) => x.startsWith(`${app.name}:`))) assumptions.push(pa);
    return app;
  });
  return { apps, groups: p.groups, assumptions: assumptions.slice(0, 20), questions: p.questions };
}

export interface ParsedBrief {
  portfolio: Portfolio;
  structured: boolean;
  /** Lines that looked like apps but could not be read. */
  skipped: string[];
}

/** Platform words in text. "web" counts only in a platform segment: in a tagline it is usually not one ("web scraper"). */
function platformsIn(text: string, web: boolean): Platform[] {
  const pl = text.toLowerCase();
  const out: Platform[] = [];
  if (/\b(ios|iphone|ipad)\b/.test(pl)) out.push("ios");
  if (/\bandroid\b/.test(pl)) out.push("and");
  if (/\b(mac|macos|osx)\b/.test(pl)) out.push("mac");
  if (/\b(win|windows)\b/.test(pl)) out.push("win");
  if (web && /\b(web|website|browser)\b/.test(pl)) out.push("web");
  return out;
}

/** A brief segment naming a folder: absolute, home-relative, or a Windows drive path. */
export function looksLikePath(s: string): boolean {
  return /^(\/|~\/|~$|[A-Za-z]:[\\/])/.test(s.trim());
}

const READS_RE = /^(?:reads?|uses?|context)\s*:?\s+(.+)$/i;
const NEEDS_RE = /^needs?\s*:?\s+(.+)$/i;
const TOOLS_RE = /^(?:tools?|with|using|uses?)\s*:?\s+(.+)$/i;

function splitPaths(s: string): string[] {
  return s
    .split(/\s*[,;]\s*(?=[\/~]|[A-Za-z]:[\\/])/)
    .map((x) => x.trim())
    .filter(looksLikePath);
}

/** Port of the prototype's parseBrief, plus "assumed" platform marking, app folders, read-only folders, kinds, needs and tools. */
export function parseBrief(text: string): ParsedBrief {
  const groups: string[] = [];
  const apps: PortfolioApp[] = [];
  const skipped: string[] = [];
  const assumptions: string[] = [];
  let cur: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(/^\s*#{1,3}\s*(.+?)\s*$/);
    if (h) {
      cur = h[1];
      continue;
    }
    const m = line.match(/^\s*[-*•]\s*(.+?)\s+[—–-]{1,2}\s+(.+)$/);
    if (!m) {
      if (/^\s*[-*•]\s+\S/.test(line)) skipped.push(line.trim());
      continue;
    }
    const name = m[1].trim();
    const parts = m[2].split(/\s*[·|]\s*/);
    const tagline = parts[0].trim();
    let path: string | null = null;
    const reads: string[] = [];
    const platParts: string[] = [];
    let kind: ProjectKind | undefined;
    let needs: ProjectNeed[] | undefined;
    const unknownNeeds: string[] = [];
    const tools: string[] = [];
    for (const seg of parts.slice(1)) {
      const r = seg.match(READS_RE);
      const nd = seg.match(NEEDS_RE);
      const tl = seg.match(TOOLS_RE);
      const k = kindWord(seg);
      if (r && splitPaths(r[1]).length) reads.push(...splitPaths(r[1]));
      else if (looksLikePath(seg)) path ??= seg.trim();
      else if (nd) {
        needs ??= [];
        if (!/^(none|nothing|no extras?)$/i.test(nd[1].trim())) {
          const got = needsOf(listWords(nd[1]));
          needs.push(...got.needs);
          unknownNeeds.push(...got.unknown);
        }
      } else if (tl) tools.push(...toolsOf(listWords(tl[1])));
      else if (k) {
        kind = k;
        if (k === "web") platParts.push("web");
      } else platParts.push(seg);
    }
    // path segments never count as platform words ("/Volumes/mac-ssd" is not macOS)
    const segmented = parts.length > 1;
    const plat = platformsIn(segmented ? platParts.join(" ") : m[2], segmented);
    if (!cur) cur = "Ungrouped";
    if (!groups.includes(cur)) groups.push(cur);
    if (unknownNeeds.length)
      assumptions.push(`${name}: “${unknownNeeds.join(", ")}” is not a need Helm knows (database, auth, payments, security, HIPAA, privacy, realtime, AI, automation, assets, multiplayer); it is passed to the lead as a note.`);
    const base: PortfolioApp = {
      name,
      tagline,
      platforms: plat,
      platformsAssumed: plat.length === 0,
      group: cur,
      ...(path ? { path } : {}),
      ...(reads.length ? { reads: [...new Set(reads)] } : {}),
      ...(kind ? { kind } : {}),
      ...(needs ? { needs: [...new Set(needs)] } : {}),
      ...(tools.length ? { tools: [...new Set(tools)] } : {}),
      ...(unknownNeeds.length ? { notes: `Also needs: ${unknownNeeds.join(", ")}.` } : {}),
    };
    const { app, assumption } = applyProfile(base, cur === "Ungrouped" ? "" : cur);
    apps.push(app);
    const pa = platformAssumption(app);
    if (pa) assumptions.push(pa);
    if (assumption) assumptions.push(assumption);
  }
  if (assumptions.some((x) => x.includes(": Helm decided "))) assumptions.push(PROFILE_HINT);
  return {
    portfolio: { apps, groups, assumptions: assumptions.slice(0, 40), questions: [] },
    structured: apps.length > 0,
    skipped,
  };
}

/** The prototype's sample brief: 20 apps, 5 headings, ΣP = 43. */
export const SAMPLE_BRIEF = `Build all of these in parallel. Every app gets its own repository, one lead developer, and the platforms listed. I want a review and an AI-slop check on each before I see it.

# Wellness
- Lumen — Sleep & light tracker · iOS Android macOS
- Stride — Walk & run planner · iOS Android
- Oat — Meal planner · iOS Android
- Hush — Focus soundscapes · iOS macOS

# Money
- Ledgerly — Freelance invoicing · macOS Windows iOS
- Tally — Shared expenses · iOS Android
- Quill — Contracts & e-sign · macOS Windows
- Mint Jar — Savings goals · iOS Android

# Creator tools
- Frame — Photo culling · macOS iOS
- Loop — Audio sampler · macOS iOS
- Inkwell — Notes & sketch · macOS iOS Android
- Reel — Short video trim · iOS Android

# Dev & ops
- Beacon — Uptime monitor · macOS Windows
- Patch — Release notes · macOS Windows
- Kestrel — Log viewer · macOS Windows
- Forge — CI dashboard · macOS Windows

# Travel
- Wayfarer — Itinerary planner · iOS Android
- Tidewalk — Tide & shoreline routes · iOS Android
- Perch — Coworking finder · iOS Android
- Bloc — Climbing log · iOS Android`;

export const SMALL_BRIEF = `One small app to try Helm.

- Pebble — A one-screen habit counter · macOS`;
