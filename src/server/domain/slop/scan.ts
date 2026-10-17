// The deterministic slop scanner (appendix B §4). Pure: give it the tracked
// files of one commit (and optionally added lines from history) and it returns
// the same sorted findings every time. No network, no model.
import type { Severity } from "../../../shared/types.ts";
import { ASSERTION_TOKENS, BLOCK_RULES, LINE_RULES, SECRET_NAME, USER_DATA, WHY_SIGNAL, type LangFamily } from "./rules.ts";

export interface ScanFile {
  path: string;
  content: string;
}

export interface AllowEntry {
  rule: string;
  path: string;
  reason: string;
}

export interface ScanInput {
  files: ScanFile[];
  allow?: AllowEntry[];
  /** Added lines from `git log -p` on the integration branch, for S6 history checks. */
  history?: Array<{ commit: string; path: string; line: string }>;
  /** Logger wrappers exempt from S5 (from .helm/slop-allow.json "loggers"). */
  loggers?: string[];
}

export interface ScanFinding {
  rule: string;
  ruleId: string;
  severity: Severity;
  path: string;
  line: number;
  quote: string;
  why: string;
  fix: string;
}

export interface ScanResult {
  findings: ScanFinding[];
  filesScanned: number;
  shippedFiles: number;
  exempted: number;
  unverified: string[];
}

const EXT_LANG: Record<string, LangFamily> = {
  ts: "js", tsx: "js", js: "js", jsx: "js", mjs: "js", cjs: "js", vue: "js", svelte: "js",
  swift: "swift", kt: "kotlin", kts: "kotlin", java: "java", cs: "csharp", py: "python",
  go: "go", rs: "rust", m: "c", mm: "c", h: "c", c: "c", cc: "c", cpp: "c", hpp: "c",
  sh: "shell", bash: "shell", zsh: "shell",
  html: "markup", xml: "markup", xaml: "markup", storyboard: "markup", xib: "markup",
  strings: "strings", stringsdict: "strings", arb: "strings", resx: "markup",
  json: "data", yaml: "data", yml: "data", toml: "data", plist: "markup", gradle: "kotlin", properties: "data",
};

export function langOf(path: string): LangFamily {
  const base = path.split("/").pop() ?? path;
  if (/^\.env/.test(base)) return "data";
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  return EXT_LANG[ext] ?? "other";
}

const NOT_SHIPPED: RegExp[] = [
  /(^|\/)tests?\//,
  /(^|\/)__tests__\//,
  /(^|\/)[^/]*Tests\//,
  /(^|\/)[^/]*UITests\//,
  /(^|\/)[^/]*Spec\.[^/]+$/,
  /\.(test|spec)\.[^/]+$/,
  /(^|\/)[^/]*_test\.(go|py)$/,
  /(^|\/)test_[^/]*\.py$/,
  /(^|\/)src\/(test|androidTest)\//,
  /(^|\/)fixtures\//,
  /(^|\/)examples\//,
  /^example\//,
  /(^|\/)docs\//,
  /\.stories\.[^/]+$/,
  /(^|\/)[^/]*Preview[^/]*$/,
  /(^|\/)Preview Content\//,
  /^reports\//,
  /^\.helm\//,
  /(^|\/)(node_modules|Pods|build|dist|\.gradle|DerivedData|vendor|\.build|bin|obj)\//,
  /\.md$/i,
];

const TEST_FILE: RegExp[] = [
  /(^|\/)tests?\//,
  /(^|\/)__tests__\//,
  /(^|\/)[^/]*Tests\//,
  /(^|\/)[^/]*Spec\.[^/]+$/,
  /\.(test|spec)\.[^/]+$/,
  /(^|\/)[^/]*_test\.(go|py)$/,
  /(^|\/)test_[^/]*\.py$/,
  /(^|\/)src\/(test|androidTest)\//,
];

const VENDORED = /(^|\/)(node_modules|Pods|DerivedData|vendor|\.build|\.gradle|build|dist|bin|obj)\//;
const GENERATED = /(\.g\.dart|\.pb\.\w+|\.generated\.\w+|(^|\/)R\.java)$/;
const LOCKFILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Package\.resolved|Podfile\.lock|gradle\.lockfile|poetry\.lock|Cargo\.lock)$/;

export function isShipped(path: string): boolean {
  return !NOT_SHIPPED.some((r) => r.test(path));
}

export function isTestFile(path: string): boolean {
  return TEST_FILE.some((r) => r.test(path));
}

export function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const trimQuote = (s: string) => {
  const t = s.trim();
  return t.length > 200 ? t.slice(0, 200) : t;
};

function lineOfIndex(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

function commentPrefix(lang: LangFamily): RegExp {
  return lang === "python" || lang === "shell" || lang === "data" ? /^\s*#/ : /^\s*(\/\/|\*|\/\*)/;
}

// ───────────────────────────── S3: imports vs manifests ─────────────────────────────

const NODE_BUILTINS = new Set(
  "assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib test sqlite".split(" "),
);
const APPLE_FRAMEWORKS = new Set(
  "PackageDescription Foundation SwiftUI UIKit AppKit Combine CoreData CoreGraphics CoreImage CoreLocation CoreML CoreMotion CoreText CloudKit HealthKit MapKit AVFoundation AVKit Photos PhotosUI StoreKit UserNotifications WidgetKit ActivityKit Charts SwiftData Observation OSLog os Security LocalAuthentication AuthenticationServices CryptoKit Network NaturalLanguage Vision VisionKit EventKit Contacts ContactsUI MessageUI SafariServices WebKit GameKit SpriteKit SceneKit RealityKit ARKit Metal MetalKit QuartzCore CoreAudio AudioToolbox MediaPlayer PassKit BackgroundTasks AppIntents Intents IntentsUI XCTest Testing Darwin Dispatch UniformTypeIdentifiers QuickLook PDFKit CoreBluetooth CoreHaptics TipKit ServiceManagement".split(" "),
);
const PY_STDLIB = new Set(
  "abc argparse array ast asyncio base64 bisect collections concurrent contextlib copy csv dataclasses datetime decimal enum functools glob hashlib heapq hmac html http importlib inspect io itertools json logging math multiprocessing operator os pathlib pickle platform queue random re secrets select shutil signal socket sqlite3 ssl statistics string struct subprocess sys tempfile textwrap threading time timeit tkinter traceback types typing unittest urllib uuid warnings weakref xml zipfile zoneinfo __future__".split(" "),
);

interface Manifests {
  npm: Set<string> | null;
  npmLock: string | null;
  pythonDeps: Set<string> | null;
  swiftDeps: Set<string> | null;
  swiftLocal: Set<string>;
  gradleGroups: string[] | null;
  /** group:artifact coordinates from Gradle files and version catalogs. */
  gradleCoords: Array<{ group: string; artifact: string }>;
  kotlinPackages: Set<string>;
  tsPathAliases: string[];
}

function readManifests(files: ScanFile[]): Manifests {
  const m: Manifests = { npm: null, npmLock: null, pythonDeps: null, swiftDeps: null, swiftLocal: new Set(), gradleGroups: null, gradleCoords: [], kotlinPackages: new Set(), tsPathAliases: [] };
  for (const f of files) {
    const base = f.path.split("/").pop()!;
    if (VENDORED.test(f.path)) continue;
    if (base === "package.json") {
      try {
        const pj = JSON.parse(f.content) as Record<string, Record<string, string> | string | undefined>;
        m.npm ??= new Set();
        for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
          const deps = pj[k];
          if (deps && typeof deps === "object") for (const d of Object.keys(deps)) m.npm.add(d);
        }
        if (typeof pj.name === "string") m.npm.add(pj.name);
      } catch {
        // malformed package.json is reported by the build check, not here
      }
    }
    if (base === "package-lock.json" || base === "yarn.lock" || base === "pnpm-lock.yaml") m.npmLock = (m.npmLock ?? "") + f.content;
    if (base === "tsconfig.json") {
      const aliases = f.content.match(/"([^"*]+)\/\*"\s*:/g) ?? [];
      for (const a of aliases) m.tsPathAliases.push(a.replace(/"|\/\*"\s*:/g, ""));
    }
    if (base === "requirements.txt" || base === "pyproject.toml") {
      m.pythonDeps ??= new Set();
      const add = (name: string) => m.pythonDeps!.add(name.toLowerCase().replace(/-/g, "_"));
      for (const line of f.content.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith("#") || t.startsWith("[")) continue;
        if (base === "requirements.txt") {
          const n = t.match(/^([A-Za-z0-9_.-]+)/);
          if (n && !t.startsWith("-")) add(n[1]);
        } else {
          for (const q of t.matchAll(/"([A-Za-z0-9_.-]+)\s*(?:[<>=!~;\[].*)?"/g)) add(q[1]);
          const kv = t.match(/^([A-Za-z0-9_-]+)\s*=\s*["{]/);
          if (kv && !["name", "version", "description", "python", "requires-python", "readme", "license"].includes(kv[1])) add(kv[1]);
        }
      }
    }
    if (base === "Package.swift") {
      m.swiftDeps ??= new Set();
      for (const p of f.content.matchAll(/\.product\(\s*name:\s*"([^"]+)"/g)) m.swiftDeps.add(p[1]);
      for (const p of f.content.matchAll(/\.package\([^)]*url:\s*"[^"]*\/([^/"]+?)(\.git)?"/g)) m.swiftDeps.add(p[1]);
      for (const p of f.content.matchAll(/\.(target|executableTarget|testTarget)\(\s*name:\s*"([^"]+)"/g)) m.swiftLocal.add(p[2]);
    }
    if (/\.gradle(\.kts)?$/.test(base) || base === "libs.versions.toml") {
      m.gradleGroups ??= [];
      for (const g of f.content.matchAll(/["']([a-z][\w.-]+):([\w.-]+)(:[^"']+)?["']/g)) {
        m.gradleGroups.push(g[1]);
        m.gradleCoords.push({ group: g[1], artifact: g[2] });
      }
      for (const g of f.content.matchAll(/group\s*=\s*"([^"]+)"(?:\s*,\s*name\s*=\s*"([^"]+)")?/g)) {
        m.gradleGroups.push(g[1]);
        if (g[2]) m.gradleCoords.push({ group: g[1], artifact: g[2] });
      }
      // the app's own namespace (R, BuildConfig) is local
      for (const g of f.content.matchAll(/\b(?:namespace|applicationId)\s*=?\s*"([\w.]+)"/g)) m.kotlinPackages.add(g[1]);
    }
    if (/\.(kt|java)$/.test(base)) {
      const pk = f.content.match(/^\s*package\s+([\w.]+)/m);
      if (pk) m.kotlinPackages.add(pk[1]);
    }
    if (base.endsWith(".swift")) {
      const dir = f.path.split("/");
      const i = dir.indexOf("Sources");
      if (i >= 0 && dir[i + 1]) m.swiftLocal.add(dir[i + 1]);
    }
  }
  return m;
}

function npmPackageName(spec: string): string {
  if (spec.startsWith("@")) return spec.split("/").slice(0, 2).join("/");
  return spec.split("/")[0];
}

function importFindings(f: ScanFile, lang: LangFamily, m: Manifests): ScanFinding[] {
  const out: ScanFinding[] = [];
  const lines = f.content.split(/\r?\n/);
  const add = (i: number, spec: string, why: string) =>
    out.push({ rule: "S3", ruleId: "S3-import", severity: "blocker", path: f.path, line: i + 1, quote: trimQuote(lines[i]), why, fix: `Declare ${spec} in the manifest (and lockfile) after checking it exists, or remove the import.` });
  lines.forEach((line, i) => {
    if (lang === "js" && m.npm) {
      const mm = line.match(/^\s*import\s+(?:type\s+)?(?:[^'"]*\s+from\s+)?['"]([^'"]+)['"]/) ?? line.match(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/) ?? line.match(/^\s*export\s+[^'"]*\s+from\s+['"]([^'"]+)['"]/);
      if (!mm) return;
      const spec = mm[1];
      if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:") || spec.startsWith("bun:")) return;
      if (m.tsPathAliases.some((a) => spec === a || spec.startsWith(`${a}/`)) || spec.startsWith("@/") || spec.startsWith("~/")) return;
      const name = npmPackageName(spec);
      if (NODE_BUILTINS.has(name)) return;
      if (!m.npm.has(name)) add(i, name, `Imports "${name}", which no package.json declares.`);
    } else if (lang === "python" && m.pythonDeps) {
      const mm = line.match(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/);
      if (!mm) return;
      const mod = (mm[1] ?? mm[2]).split(".")[0];
      if (mod.startsWith("_") || PY_STDLIB.has(mod)) return;
      const localish = f.path.split("/").slice(0, -1).includes(mod);
      if (localish) return;
      if (!m.pythonDeps.has(mod.toLowerCase())) add(i, mod, `Imports "${mod}", which requirements/pyproject does not declare.`);
    } else if (lang === "swift" && m.swiftDeps) {
      const mm = line.match(/^\s*(?:@testable\s+)?import\s+(?:struct\s+|class\s+|enum\s+|func\s+)?([A-Za-z_][\w]*)/);
      if (!mm) return;
      const mod = mm[1];
      if (APPLE_FRAMEWORKS.has(mod) || m.swiftLocal.has(mod) || m.swiftDeps.has(mod)) return;
      add(i, mod, `Imports module "${mod}", which Package.swift does not provide.`);
    } else if ((lang === "kotlin" || lang === "java") && m.gradleGroups) {
      const mm = line.match(/^\s*import\s+([\w.]+)/);
      if (!mm) return;
      const imp = mm[1];
      if (/^(java|javax|kotlin|kotlinx|android|androidx|org\.junit|junit|org\.w3c|org\.xml|dalvik)\./.test(imp)) return;
      if ([...m.kotlinPackages].some((p) => imp.startsWith(`${p}.`) || imp === p)) return;
      if (gradleProvides(imp, m)) return;
      add(i, imp, `Imports "${imp}", which no Gradle dependency provides.`);
    }
  });
  return out;
}

/**
 * Whether a declared Gradle dependency plausibly provides a JVM import. Maven
 * groups and Java packages often differ (com.squareup.retrofit2 → retrofit2,
 * com.google.dagger → dagger, io.coil-kt:coil-compose → coil), so match on the
 * group, its parent organisation, its last segment, or the artifact's stem.
 */
function gradleProvides(imp: string, m: Manifests): boolean {
  const first = imp.split(".")[0];
  for (const g of m.gradleGroups ?? []) {
    if (imp === g || imp.startsWith(`${g}.`)) return true;
    const parent = g.replace(/\.[^.]+$/, "");
    if (parent.includes(".") && imp.startsWith(`${parent}.`)) return true;
    const last = g.split(".").pop()!.replace(/-/g, "");
    if (last.length >= 3 && first === last) return true;
  }
  for (const c of m.gradleCoords) {
    const stem = c.artifact.split("-")[0];
    if (stem.length >= 3 && first === stem) return true;
  }
  return false;
}

// ───────────────────────────── S3: named imports of local modules ─────────────────────────────

const JS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function normalizePath(parts: string[]): string | null {
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(p);
  }
  return out.join("/");
}

function resolveRelative(from: string, spec: string, byPath: Map<string, ScanFile>): ScanFile | null {
  const dir = from.split("/").slice(0, -1);
  const base = normalizePath([...dir, ...spec.split("/")]);
  if (base === null) return null;
  const stripped = base.replace(/\.(m|c)?js$/, "");
  const candidates = [base, ...JS_EXTS.map((e) => `${stripped}${e}`), ...JS_EXTS.map((e) => `${base}/index${e}`)];
  for (const c of candidates) {
    const f = byPath.get(c);
    if (f && JS_EXTS.some((e) => c.endsWith(e))) return f;
  }
  return null;
}

/** Names a JS/TS module exports, or null when they cannot be determined statically. */
function exportedNames(content: string): Set<string> | null {
  if (/\bexport\s*\*|module\.exports|\bexports\.\w+\s*=|\bexport\s*=|\bexport\s+(const|let|var)\s*[{[]/.test(content)) return null;
  const names = new Set<string>();
  for (const mt of content.matchAll(/\bexport\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|const|let|var|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/g)) names.add(mt[1]);
  for (const mt of content.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}/g))
    for (const part of mt[1].split(",")) {
      const t = part.trim().replace(/^type\s+/, "");
      if (!t) continue;
      const as = t.match(/\bas\s+([\w$]+)$/);
      names.add(as ? as[1] : t);
    }
  if (/\bexport\s+default\b/.test(content)) names.add("default");
  if (!names.size) return null;
  return names;
}

function localSymbolFindings(f: ScanFile, byPath: Map<string, ScanFile>): ScanFinding[] {
  const out: ScanFinding[] = [];
  const lines = f.content.split(/\r?\n/);
  const cache = new Map<string, Set<string> | null>();
  lines.forEach((line, i) => {
    const mm = line.match(/^\s*import\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s+['"](\.{1,2}\/[^'"]*)['"]/);
    if (!mm || (!mm[1] && mm[2] === undefined)) return;
    const target = resolveRelative(f.path, mm[3], byPath);
    if (!target) return;
    if (!cache.has(target.path)) cache.set(target.path, exportedNames(target.content));
    const exported = cache.get(target.path);
    if (!exported) return;
    const wanted: string[] = [];
    if (mm[1]) wanted.push("default");
    for (const part of (mm[2] ?? "").split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (name) wanted.push(name);
    }
    const missing = wanted.filter((n) => !exported.has(n));
    if (missing.length)
      out.push({
        rule: "S3",
        ruleId: "S3-symbol",
        severity: "blocker",
        path: f.path,
        line: i + 1,
        quote: trimQuote(line),
        why: `Imports ${missing.map((n) => (n === "default" ? "a default export" : `"${n}"`)).join(", ")} from ${target.path}, which does not export ${missing.length > 1 ? "them" : "it"}.`,
        fix: "Use a symbol the module actually exports, or implement it there.",
      });
  });
  return out;
}

// ───────────────────────────── preview / debug-only regions ─────────────────────────────

/**
 * Lines that never reach a release build even though the file is shipped:
 * Swift `#if DEBUG … #endif`, `#Preview { … }` and `PreviewProvider` types,
 * Compose `@Preview` functions. S1/S2/S5 do not apply there.
 */
function debugOnlyLines(lines: string[], lang: LangFamily): Set<number> {
  const masked = new Set<number>();
  if (lang !== "swift" && lang !== "kotlin") return masked;
  const braceBlock = (start: number) => {
    let depth = 0;
    let opened = false;
    for (let j = start; j < lines.length; j++) {
      masked.add(j);
      for (const ch of lines[j].replace(/"(?:[^"\\]|\\.)*"/g, '""')) {
        if (ch === "{") {
          depth++;
          opened = true;
        } else if (ch === "}") depth--;
      }
      if (opened && depth <= 0) return j;
      if (!opened && j - start > 6) return j; // annotation without a body nearby
    }
    return lines.length - 1;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (lang === "swift" && /^\s*#if\s+DEBUG\b/.test(line)) {
      let depth = 0;
      for (let j = i; j < lines.length; j++) {
        masked.add(j);
        if (/^\s*#if\b/.test(lines[j])) depth++;
        else if (/^\s*#endif\b/.test(lines[j]) && --depth === 0) break;
        else if (depth === 1 && /^\s*#(else|elseif)\b/.test(lines[j])) {
          masked.delete(j);
          // the #else branch ships: stop masking at it, resume at #endif
          let d = 1;
          for (let k = j + 1; k < lines.length; k++) {
            if (/^\s*#if\b/.test(lines[k])) d++;
            else if (/^\s*#endif\b/.test(lines[k]) && --d === 0) {
              i = k;
              break;
            }
          }
          break;
        }
      }
    } else if (lang === "swift" && (/^\s*#Preview\b/.test(line) || /\b\w+\s*:\s*PreviewProvider\b/.test(line))) {
      i = braceBlock(i);
    } else if (lang === "kotlin" && /^\s*@Preview\b/.test(line)) {
      i = braceBlock(i);
    }
  }
  return masked;
}

// ───────────────────────────── S7: comments that restate the next line ─────────────────────────────

const NARRATION_VERBS = new Set(
  "set sets get gets return returns increment increments decrement decrements add adds call calls loop iterate iterates check checks create creates initialize initialise update updates append appends push pushes declare define assign save saves load loads fetch fetches remove removes delete deletes convert converts calculate calculates compute computes render renders print prints".split(" "),
);
const NARRATION_STOP = new Set("the a an of to through over each every all new value values and for in on with from into this it its our current".split(" "));

function identifierWords(code: string): Set<string> {
  const words = new Set<string>();
  for (const tok of code.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])
    for (const w of tok.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_]+/)) {
      const lw = w.toLowerCase();
      if (!lw) continue;
      words.add(lw);
      words.add(lw.replace(/s$/, ""));
    }
  return words;
}

function restatingComments(f: ScanFile, lines: string[], lang: LangFamily): ScanFinding[] {
  const out: ScanFinding[] = [];
  const prefix = lang === "python" || lang === "shell" ? /^\s*#+\s?/ : /^\s*\/\/+\s?/;
  for (let i = 0; i < lines.length - 1; i++) {
    if (!prefix.test(lines[i])) continue;
    const text = lines[i].replace(prefix, "").trim();
    if (!text || WHY_SIGNAL.test(text) || /[?!;]/.test(text)) continue;
    const next = lines[i + 1];
    if (!next.trim() || prefix.test(next)) continue;
    const words = text.toLowerCase().replace(/[.,]+$/, "").split(/[^a-z0-9]+/).filter(Boolean);
    if (words.length < 2 || words.length > 6 || !NARRATION_VERBS.has(words[0])) continue;
    const content = words.slice(1).filter((w) => !NARRATION_STOP.has(w));
    if (!content.length) continue;
    const code = identifierWords(next);
    if (content.every((w) => code.has(w) || code.has(w.replace(/s$/, ""))))
      out.push({ rule: "S7", ruleId: "S7-restate", severity: "nit", path: f.path, line: i + 1, quote: trimQuote(lines[i]), why: "Comment restates the next line of code.", fix: "Delete it, or say why the code exists instead of what it does." });
  }
  return out;
}

// ───────────────────────────── S11: mocking the unit under test ─────────────────────────────

function unitUnderTest(path: string): string | null {
  const base = (path.split("/").pop() ?? path).replace(/\.[^.]+$/, "");
  const unit = base
    .replace(/\.(test|spec)$/i, "")
    .replace(/(Tests?|Spec)$/, "")
    .replace(/_test$/, "")
    .replace(/^test_/, "");
  return unit || null;
}

function mockedSutFindings(f: ScanFile, lines: string[]): ScanFinding[] {
  const unit = unitUnderTest(f.path);
  if (!unit || unit.length < 3) return [];
  const u = unit.toLowerCase();
  const esc = unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const jvm = new RegExp(`\\b(mockk|mock|spyk)\\s*<\\s*${esc}\\s*>|\\b(Mockito\\.)?mock\\(\\s*${esc}::class|\\bMock${esc}\\b`);
  const out: ScanFinding[] = [];
  lines.forEach((line, i) => {
    const js = line.match(/\b(?:vi|jest)\.(?:mock|doMock)\(\s*['"]([^'"]+)['"]/);
    let hit = false;
    if (js) {
      const mod = js[1].replace(/\/index$/, "").split("/").pop()!.replace(/\.[^.]+$/, "").toLowerCase();
      hit = mod === u;
    } else hit = jvm.test(line) && !/^\s*(\/\/|\*)/.test(line);
    if (hit)
      out.push({ rule: "S11", ruleId: "S11-mock-sut", severity: "major", path: f.path, line: i + 1, quote: trimQuote(line), why: `The test mocks ${unit}, the unit it is supposed to test, so it only exercises the mock.`, fix: "Mock the unit's collaborators, not the unit; assert on the real implementation." });
  });
  return out;
}

/** Values that are clearly structured identifiers (cache keys, paths), not credentials. */
function looksLikeIdentifierPath(v: string): boolean {
  const parts = v.split(/[\/._:-]+/).filter(Boolean);
  return parts.length >= 3 && parts.every((p) => /^[a-z0-9]{1,15}$/.test(p) && !/^[0-9a-f]{12,}$/.test(p));
}

function lockfileFindings(files: ScanFile[], m: Manifests): ScanFinding[] {
  if (!m.npm || m.npmLock === null) return [];
  const out: ScanFinding[] = [];
  for (const f of files) {
    if ((f.path.split("/").pop() ?? "") !== "package.json" || VENDORED.test(f.path)) continue;
    const lines = f.content.split(/\r?\n/);
    let inDeps = false;
    lines.forEach((line, i) => {
      if (/"(dependencies|devDependencies)"\s*:/.test(line)) inDeps = true;
      else if (inDeps && /^\s*}/.test(line)) inDeps = false;
      else if (inDeps) {
        const d = line.match(/^\s*"([^"]+)"\s*:/);
        if (d && !m.npmLock!.includes(d[1]))
          out.push({ rule: "S3", ruleId: "S3-lock", severity: "blocker", path: f.path, line: i + 1, quote: trimQuote(line), why: `Declared dependency "${d[1]}" is absent from the lockfile — it may not exist or was never installed.`, fix: "Install it (which records it in the lockfile) after checking it exists, or remove it." });
      }
    });
  }
  return out;
}

// ───────────────────────────── main scan ─────────────────────────────

export function scan(input: ScanInput): ScanResult {
  const findings: ScanFinding[] = [];
  const unverified: string[] = [];
  const files = input.files.filter((f) => !VENDORED.test(f.path) && !GENERATED.test(f.path) && f.content.length <= 1_000_000);
  const manifests = readManifests(files);
  const byPath = new Map(files.map((f) => [f.path, f] as const));
  const loggers = input.loggers ?? [];
  let shippedCount = 0;
  let loggerExempt = 0;

  for (const f of files) {
    const lang = langOf(f.path);
    const shipped = isShipped(f.path);
    if (shipped) shippedCount++;
    const base = f.path.split("/").pop() ?? f.path;
    if (/@generated|DO NOT EDIT/.test(f.content.slice(0, 400))) continue;

    // S6 committed env files
    if (/^\.env(\.|$)/.test(base) && !/\.(example|sample|template)$/.test(base)) {
      findings.push({ rule: "S6", ruleId: "S6-envfile", severity: "blocker", path: f.path, line: 1, quote: trimQuote(f.content.split(/\r?\n/)[0] ?? base), why: "An .env file is committed.", fix: "Remove it from the repository and history, add it to .gitignore, and rotate what it held." });
    }
    if (LOCKFILES.test(f.path)) continue;

    const lines = f.content.split(/\r?\n/);
    const isTest = isTestFile(f.path);
    const cliEntry = isCliEntry(f.path);
    const debugOnly = shipped ? debugOnlyLines(lines, lang) : new Set<number>();
    lines.forEach((line, i) => {
      for (const r of LINE_RULES) {
        if (r.appliesTo === "shipped" && !shipped) continue;
        if (r.languages !== "any" && !r.languages.includes(lang)) continue;
        if (r.rule === "S11" && !isTest) continue;
        if ((r.rule === "S1" || r.rule === "S2" || r.rule === "S5") && debugOnly.has(i)) continue;
        if (!r.regex.test(line)) continue;
        if (r.excludeIf?.(line, f.path)) continue;
        if (r.excludeIfContext?.(lines, i, f.path)) continue;
        // a command-line entry point's print is the program's output, not a debug leftover
        if (r.rule === "S5" && cliEntry && /(^|[^\w.])print(ln)?\(|console\.log\(|println!\(|System\.out\.print/.test(line) && !USER_DATA.test(line)) continue;
        if (r.rule === "S5" && loggers.some((l) => f.path === l || f.path.endsWith(`/${l}`))) {
          // logger wrappers listed in .helm/slop-allow.json are exemptions too, and are counted
          loggerExempt++;
          continue;
        }
        findings.push({ rule: r.rule, ruleId: r.id, severity: r.severityFor?.(line) ?? r.severity, path: f.path, line: i + 1, quote: trimQuote(line), why: r.why, fix: r.fix });
      }
      // S6 high-entropy assignment to a secret-looking name (all files)
      const asg = line.match(/([A-Za-z_][\w.-]*)\s*[:=]\s*["'`]([^"'`\s]{24,})["'`]/);
      if (asg && SECRET_NAME.test(asg[1]) && shannonEntropy(asg[2]) >= 4.0 && !/^(https?:|process\.env|<)/.test(asg[2]) && !asg[2].includes("${") && !looksLikeIdentifierPath(asg[2]))
        findings.push({ rule: "S6", ruleId: "S6-entropy", severity: "blocker", path: f.path, line: i + 1, quote: trimQuote(line), why: `High-entropy value assigned to "${asg[1]}" looks like a credential.`, fix: "Load it at runtime from the keychain/keystore or environment and rotate it." });
    });

    // S12 multi-line empty catch
    if (shipped)
      for (const b of BLOCK_RULES) {
        if (!b.languages.includes(lang)) continue;
        for (const mt of f.content.matchAll(b.regex)) {
          if (b.excludeIf?.(mt[0])) continue;
          const ln = lineOfIndex(f.content, mt.index ?? 0);
          findings.push({ rule: b.rule, ruleId: b.id, severity: b.severity, path: f.path, line: ln, quote: trimQuote(lines[ln - 1] ?? mt[0]), why: b.why, fix: b.fix });
        }
      }

    // S11 test file with no assertions
    if (isTest && ["js", "swift", "kotlin", "java", "csharp", "python", "go", "rust"].includes(lang)) {
      findings.push(...mockedSutFindings(f, lines));
      const hasTests = /(^|[^.\w])(test|it|describe)\s*\(|func test\w*\(|@Test\b|def test_|#\[test\]|\[Fact\]|\[Test\]/m.test(f.content);
      if (hasTests && !ASSERTION_TOKENS.test(f.content)) {
        const idx = f.content.search(/(^|[^.\w])(test|it)\s*\(|func test\w*\(|@Test\b|def test_|#\[test\]|\[Fact\]|\[Test\]/m);
        const ln = lineOfIndex(f.content, Math.max(0, idx));
        findings.push({ rule: "S11", ruleId: "S11-noassert", severity: "major", path: f.path, line: ln, quote: trimQuote(lines[ln - 1] ?? ""), why: "Test file with no assertions — these tests cannot fail.", fix: "Assert on observable behaviour, or delete the test." });
      }
    }

    // S4 large commented-out code blocks
    if (shipped && lang !== "other" && lang !== "data" && lang !== "strings" && lang !== "markup") {
      const cp = commentPrefix(lang);
      let start = -1;
      let codeish = 0;
      const flush = (end: number) => {
        const len = end - start;
        if (start >= 0 && len >= 8 && codeish >= Math.ceil(len / 2))
          findings.push({ rule: "S4", ruleId: "S4-commented", severity: len >= 30 ? "major" : "minor", path: f.path, line: start + 1, quote: trimQuote(lines[start]), why: `${len} consecutive lines of commented-out code.`, fix: "Delete it; git history keeps the old version." });
        start = -1;
        codeish = 0;
      };
      lines.forEach((line, i) => {
        if (cp.test(line)) {
          if (start < 0) start = i;
          if (/[;{}()=]|\breturn\b|\bfunc\b|\bconst\b|\blet\b|\bvar\b/.test(line.replace(cp, ""))) codeish++;
        } else flush(i);
      });
      flush(lines.length);
    }

    if (shipped && ["js", "swift", "kotlin", "java", "csharp", "python", "go", "rust", "c", "shell"].includes(lang)) findings.push(...restatingComments(f, lines, lang));

    findings.push(...importFindings(f, lang, manifests));
    if (lang === "js") findings.push(...localSymbolFindings(f, byPath));
  }
  findings.push(...lockfileFindings(files, manifests));

  for (const h of input.history ?? []) {
    for (const r of LINE_RULES.filter((x) => x.rule === "S6")) {
      if (r.regex.test(h.line))
        findings.push({ rule: "S6", ruleId: "S6-history", severity: "blocker", path: h.path, line: 0, quote: trimQuote(h.line), why: `A credential was committed in ${h.commit.slice(0, 9)} (still in history).`, fix: "Rotate it; rewriting history alone is not enough." });
    }
  }

  if (!manifests.npm && files.some((f) => langOf(f.path) === "js")) unverified.push("JS/TS imports: no package.json found, imports not cross-checked");
  if (!manifests.swiftDeps && files.some((f) => langOf(f.path) === "swift") && files.some((f) => /\.xcodeproj\//.test(f.path)))
    unverified.push("Swift imports: Xcode project without Package.swift — only Apple frameworks and local modules recognized");

  // allowlist
  const allow = input.allow ?? [];
  let exempted = loggerExempt;
  const kept = findings.filter((f) => {
    const hit = allow.some((a) => a.rule === f.rule && (a.path === f.path || (a.path.endsWith("/**") && f.path.startsWith(a.path.slice(0, -3)))));
    if (hit) exempted++;
    return !hit;
  });

  // de-duplicate identical rule/path/line, then sort deterministically
  const seen = new Set<string>();
  const unique = kept.filter((f) => {
    const k = `${f.rule}|${f.path}|${f.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const sevOrder: Record<Severity, number> = { blocker: 0, major: 1, minor: 2, nit: 3 };
  unique.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity] || a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule));
  return { findings: unique, filesScanned: files.length, shippedFiles: shippedCount, exempted, unverified };
}

/** Command-line entry points: their stdout is the product (S5 does not apply to plain output there). */
const CLI_ENTRY = /(^|\/)(bin|cli|cmd)\/[^/]+$|(^|\/)(main\.swift|main\.go|main\.rs|__main__\.py|cli\.(ts|js|mjs|py))$/;
export function isCliEntry(path: string): boolean {
  return CLI_ENTRY.test(path);
}
