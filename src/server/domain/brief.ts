// Reading the brief (§7.7). Structured briefs (# Group headings and
// "- Name — tagline · iOS Android" lines, optionally "· /path/to/folder" and
// "· reads /a, ~/b") are parsed deterministically; anything else goes to the
// planner thread, whose only output is a PortfolioSchema.
import { z } from "zod";
import type { Platform, Portfolio, PortfolioApp } from "../../shared/types.ts";

export const PlatformSchema = z.enum(["mac", "win", "ios", "and"]);
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
};

/** Accepts both Helm ids and the words people type ("Android", "macOS"). */
export const PlatformLooseSchema = z
  .string()
  .transform((s, ctx) => {
    const k = s.trim().toLowerCase().replace(/\s+/g, "");
    const p = PLATFORM_ALIASES[k];
    if (!p) {
      ctx.addIssue({ code: "custom", message: `Unknown platform "${s}" (use ios, android, macos or windows)` });
      return z.NEVER;
    }
    return p;
  });

export const PortfolioSchema = z
  .object({
    apps: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(60),
            tagline: z.string().trim().max(160).default(""),
            platforms: z.array(PlatformLooseSchema).max(4).default([]),
            group: z.string().trim().max(60).nullish(),
            shape: ShapeSchema.optional(),
            notes: z.string().max(1200).nullish(),
            path: z.string().trim().min(1).max(500).nullish(),
            reads: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
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

export function normalizePortfolio(p: z.output<typeof PortfolioSchema>): Portfolio {
  const apps: PortfolioApp[] = p.apps.map((a) => {
    const platforms = [...new Set(a.platforms)];
    return {
      name: a.name,
      tagline: a.tagline,
      platforms: platforms.length ? platforms : ["ios", "and"],
      platformsAssumed: platforms.length === 0,
      group: a.group ?? null,
      shape: a.shape,
      notes: a.notes ?? null,
      ...(a.path ? { path: a.path } : {}),
      ...(a.reads.length ? { reads: [...new Set(a.reads)] } : {}),
    };
  });
  return { apps, groups: p.groups, assumptions: p.assumptions, questions: p.questions };
}

export interface ParsedBrief {
  portfolio: Portfolio;
  structured: boolean;
  /** Lines that looked like apps but could not be read. */
  skipped: string[];
}

function platformsIn(text: string): Platform[] {
  const pl = text.toLowerCase();
  const out: Platform[] = [];
  if (/\b(ios|iphone|ipad)\b/.test(pl)) out.push("ios");
  if (/\bandroid\b/.test(pl)) out.push("and");
  if (/\b(mac|macos|osx)\b/.test(pl)) out.push("mac");
  if (/\b(win|windows)\b/.test(pl)) out.push("win");
  return out;
}

/** A brief segment naming a folder: absolute, home-relative, or a Windows drive path. */
export function looksLikePath(s: string): boolean {
  return /^(\/|~\/|~$|[A-Za-z]:[\\/])/.test(s.trim());
}

const READS_RE = /^(?:reads?|uses?|context)\s*:?\s+(.+)$/i;

function splitPaths(s: string): string[] {
  return s
    .split(/\s*[,;]\s*(?=[\/~]|[A-Za-z]:[\\/])/)
    .map((x) => x.trim())
    .filter(looksLikePath);
}

/** Port of the prototype's parseBrief, plus "assumed" platform marking, app folders and read-only folders. */
export function parseBrief(text: string): ParsedBrief {
  const groups: string[] = [];
  const apps: PortfolioApp[] = [];
  const skipped: string[] = [];
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
    for (const seg of parts.slice(1)) {
      const r = seg.match(READS_RE);
      if (r && splitPaths(r[1]).length) reads.push(...splitPaths(r[1]));
      else if (looksLikePath(seg)) path ??= seg.trim();
      else platParts.push(seg);
    }
    // path segments never count as platform words ("/Volumes/mac-ssd" is not macOS)
    const platText = parts.length > 1 ? platParts.join(" ") : m[2];
    const plat = platformsIn(platText);
    if (!cur) cur = "Ungrouped";
    if (!groups.includes(cur)) groups.push(cur);
    apps.push({
      name,
      tagline,
      platforms: plat.length ? plat : ["ios", "and"],
      platformsAssumed: plat.length === 0,
      group: cur,
      ...(path ? { path } : {}),
      ...(reads.length ? { reads: [...new Set(reads)] } : {}),
    });
  }
  const assumptions = apps
    .filter((a) => a.platformsAssumed)
    .map((a) => `${a.name}: no platforms given — assumed iOS and Android.`);
  return {
    portfolio: { apps, groups, assumptions, questions: [] },
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
