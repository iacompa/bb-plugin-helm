// Rule table for the deterministic slop scanner (appendix B §4). Each rule is
// data; scan.ts applies them. Keep every rule paired with planted and control
// fixtures under test/fixtures/slop/.
import type { Severity } from "../../../shared/types.ts";

export type LangFamily = "js" | "swift" | "kotlin" | "java" | "csharp" | "python" | "go" | "rust" | "c" | "shell" | "markup" | "data" | "strings" | "other";

export interface LineRule {
  id: string;
  rule: string;
  severity: Severity;
  appliesTo: "shipped" | "all";
  regex: RegExp;
  languages: LangFamily[] | "any";
  why: string;
  fix: string;
  /** Return true to skip a match (false-positive control). */
  excludeIf?: (line: string, path: string) => boolean;
  /** Like excludeIf, with the surrounding lines (0-based index of the matching line). */
  excludeIfContext?: (lines: string[], index: number, path: string) => boolean;
  /** Escalate severity based on the line. */
  severityFor?: (line: string) => Severity;
}

const CODE: LangFamily[] = ["js", "swift", "kotlin", "java", "csharp", "python", "go", "rust", "c", "shell"];
const CODE_AND_RES: LangFamily[] = [...CODE, "markup", "strings", "data"];

const isComment = (line: string) => /^\s*(\/\/|#|\/\*|\*|<!--)/.test(line);
/** A comment that explains *why* (reasons, constraints, references) is never narration. */
export const WHY_SIGNAL = /\b(because|since|so that|so we|otherwise|avoid|avoids|must|never|until|instead|workaround|caveat|note|NB|see|why|unless|rather than|in order to|required by|expected)\b|https?:|#\d+|:\s/i;
export const USER_DATA = /\b(email|e-mail|password|passwd|token|ssn|phone|address|user(name)?|creditcard|card(number)?|dob|birth)/i;
/** Stock phrases of generated marketing copy (adapted from the no-ai-slop word list, MIT; see THIRD_PARTY_NOTICES.md). */
export const GENERIC_COPY =
  /\b(delv(e|es|ing) into|tapestry|seamless(ly)?|cutting[- ]edge|game[- ]chang(er|ers|ing)|supercharg(e|es|ed|ing)|unlock(s|ing)? (your|the|its) (full |true )?(potential|power)|elevate (your|the)|empower(s|ing)? (you|users|teams|people|creators|businesses)|revolutioni[sz](e|es|ing)|next[- ]level|best[- ]in[- ]class|world[- ]class|harness(es|ing)? the power|in today['’]?s (fast-paced|digital|modern) world|look no further|effortless(ly)?|blazing(ly)?[- ]fast|paradigm shift|ever[- ]evolving|it['’]?s worth noting|let['’]?s dive in)\b/i;
/** Text people read: READMEs, store-listing text and UI string resources, outside tests, fixtures and vendored code. */
export function isUserCopy(path: string): boolean {
  if (/(^|\/)(tests?|__tests__|fixtures|examples|node_modules|Pods|vendor|build|dist|\.build)\//.test(path)) return false;
  return /(^|\/)README(\.[\w-]+)?\.md$|(^|\/)fastlane\/metadata\/.+\.txt$|\.(strings|stringsdict|arb|xcstrings)$|(^|\/)res\/values[^/]*\/strings\.xml$/i.test(path);
}

export const LINE_RULES: LineRule[] = [
  // ── S1 placeholders ──
  {
    id: "S1-marker",
    rule: "S1",
    severity: "blocker",
    appliesTo: "shipped",
    regex: /\b(TODO|FIXME|XXX|HACK)\b/,
    languages: CODE_AND_RES,
    why: "Placeholder marker on a shipped path.",
    fix: "Finish the work or remove the marker; track open work in an issue, not in shipped code.",
  },
  {
    id: "S1-lorem",
    rule: "S1",
    severity: "blocker",
    appliesTo: "shipped",
    regex: /lorem ipsum/i,
    languages: CODE_AND_RES,
    why: "Lorem ipsum filler on a shipped path.",
    fix: "Replace with real, domain-specific copy.",
  },
  {
    id: "S1-soon",
    rule: "S1",
    severity: "blocker",
    appliesTo: "shipped",
    regex: /\bcoming soon\b/i,
    languages: CODE_AND_RES,
    why: '"Coming soon" placeholder on a shipped path.',
    fix: "Ship the feature or remove the entry point.",
  },
  {
    id: "S1-yourtext",
    rule: "S1",
    severity: "blocker",
    appliesTo: "shipped",
    regex: /\byour (text|name|title) here\b/i,
    languages: CODE_AND_RES,
    why: "Template placeholder text on a shipped path.",
    fix: "Replace with real copy.",
  },
  {
    id: "S1-notimpl",
    rule: "S1",
    severity: "blocker",
    appliesTo: "shipped",
    regex: /\bnot (yet )?implemented\b|fatalError\(\s*"(todo|not implemented)|\bTODO\(\s*["')]|throw new Error\(\s*['"`]not implemented|NotImplementedError|NotImplementedException/i,
    languages: CODE,
    why: "Unimplemented code path on a shipped path.",
    fix: "Implement it, or remove the path and its entry points.",
  },
  {
    id: "S1-empty-handler",
    rule: "S1",
    severity: "blocker",
    appliesTo: "shipped",
    // SwiftUI `Button("Share") {}` / `action: {}`, Compose `onClick = {}`, JSX `onClick={() => {}}`
    regex: /\bButton\((?:[^()]|\([^()]*\))*\)\s*\{\s*\}|\baction:\s*\{\s*\}|\.onTapGesture\s*\{\s*\}|\bon[A-Z]\w*\s*=\s*\{\s*\}|\bon[A-Z]\w*=\{\s*\(\s*\)\s*=>\s*\{\s*\}\s*\}/,
    languages: ["swift", "kotlin", "js"],
    why: "Empty event handler on a shipped path: the control is visible but does nothing.",
    fix: "Implement the action, or remove the control until it works.",
    excludeIf: (line) => isComment(line),
  },
  // ── S2 fake data ──
  {
    id: "S2-person",
    rule: "S2",
    severity: "blocker",
    appliesTo: "shipped",
    regex: /\b(John|Jane) Doe\b|test@example\.com|foo@bar(\.com)?\b/i,
    languages: CODE_AND_RES,
    why: "Hard-coded sample person on a shipped path.",
    fix: "Load real data; keep sample data in debug/test targets only.",
  },
  {
    id: "S2-mock-ref",
    rule: "S2",
    severity: "blocker",
    appliesTo: "shipped",
    regex: /\b(Mock|Stub|Fake|Dummy)[A-Z][A-Za-z0-9_]*/,
    languages: CODE,
    why: "A mock/stub/fake type is referenced from a shipped (non-test) file.",
    fix: "Wire the real implementation into release builds; keep test doubles in test targets.",
    excludeIf: (line) => isComment(line),
  },
  {
    id: "S2-random",
    rule: "S2",
    severity: "minor",
    appliesTo: "shipped",
    regex: /Math\.random\(\)|\bInt\.random\(|\bDouble\.random\(|\bRandom\(\)\.next|\bRandom\.next(Int|Double)\(/,
    languages: CODE,
    why: "Random values on a shipped path — confirm they never feed displayed values as if real.",
    fix: "Use real data for anything shown; keep randomness to ids, jitter and tests.",
    // randomness for retry jitter, ids and shuffling is legitimate
    excludeIf: (line) => isComment(line),
    // look at the line and the few above it (the enclosing function name, a comment)
    excludeIfContext: (lines, i) => /(jitter|backoff|delay|retry|timeout|sleep|uuid|nonce|shuffle)/i.test(lines.slice(Math.max(0, i - 3), i + 1).join("\n")),
  },
  // ── S5 debug leftovers ──
  {
    id: "S5-log",
    rule: "S5",
    severity: "major",
    appliesTo: "shipped",
    regex: /\bconsole\.(log|debug)\(|(^|[^\w.])print\(|(^|[^\w.])println\(|\bNSLog\(|\bLog\.[dv]\(|\bdebugPrint\(|\bprintln!\(|System\.out\.print|(^|\s)debugger;/,
    languages: CODE,
    why: "Debug output left on a release path.",
    fix: "Remove it or route it through the project logger with user data redacted.",
    excludeIf: (line) => isComment(line),
    severityFor: (line) => (USER_DATA.test(line) ? "blocker" : "major"),
  },
  // ── S6 secrets (everything, including tests) ──
  {
    id: "S6-token",
    rule: "S6",
    severity: "blocker",
    appliesTo: "all",
    regex: /\bsk_live_[A-Za-z0-9]{8,}|\bsk-[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b|\bghp_[A-Za-z0-9]{30,}|\bxox[abp]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{35}\b/,
    languages: "any",
    why: "A provider credential is committed.",
    fix: "Remove it, load it at runtime from the keychain/keystore or environment, and rotate the key.",
  },
  {
    id: "S6-privkey",
    rule: "S6",
    severity: "blocker",
    appliesTo: "all",
    regex: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
    languages: "any",
    why: "A private key is committed.",
    fix: "Remove it from the repository and history, and rotate it.",
  },
  // ── S7 filler ──
  {
    id: "S7-narration",
    rule: "S7",
    severity: "nit",
    appliesTo: "shipped",
    regex: /^\s*(\/\/+|#|\/\*+|\*)\s*(This|The)\s+(function|method|class|variable|constant|property)\b/,
    languages: CODE,
    why: "Narration comment that restates the code.",
    fix: "Delete it, or say why the code exists instead of what it does.",
    excludeIf: (line) => WHY_SIGNAL.test(line.replace(/^\s*(\/\/+|#|\/\*+|\*)\s*/, "")),
  },
  {
    id: "S7-narration-verb",
    rule: "S7",
    severity: "nit",
    appliesTo: "shipped",
    // short "// Import dependencies", "// Define the component", "# Set up variables"
    regex: /^\s*(\/\/+|#)\s*(Import|Imports|Define|Declare|Initiali[sz]e|Set up|Setup)\s+(the\s+|all\s+|our\s+|some\s+)?(necessary\s+|required\s+|needed\s+)?(dependencies|modules|libraries|packages|imports|variables|constants|component|components|state|class|function|helpers|types)\s*\.?\s*$/i,
    languages: CODE,
    why: "Narration comment that restates the code.",
    fix: "Delete it; the code already says this.",
  },
  {
    id: "S7-banner",
    rule: "S7",
    severity: "nit",
    appliesTo: "shipped",
    regex: /(Generated by (ChatGPT|AI|an AI|Claude|Copilot|GPT)|Created by (ChatGPT|AI|an AI|Claude|Copilot|GPT))/i,
    languages: "any",
    why: "Auto-generated banner.",
    fix: "Remove the banner.",
  },
  {
    id: "S7-copy",
    rule: "S7",
    severity: "nit",
    appliesTo: "all",
    // only in text people read (READMEs, store listings, UI strings), never in code
    regex: GENERIC_COPY,
    languages: "any",
    why: "Stock phrase that would fit any product; the reader learns nothing about this one.",
    fix: "Say what this app does instead: the action, the number, the mechanism.",
    excludeIf: (_line, path) => !isUserCopy(path),
  },
  // ── S11 skipped tests (test files) ──
  {
    id: "S11-skip",
    rule: "S11",
    severity: "major",
    appliesTo: "all",
    regex: /@Ignore\b|\bXCTSkip\b|\bit\.skip\(|\btest\.skip\(|\bdescribe\.skip\(|\bxit\(|\bxdescribe\(|@Disabled\b|@pytest\.mark\.skip/,
    languages: CODE,
    why: "A skipped test left in the suite.",
    fix: "Make the test pass or delete it with a reason in DECISIONS.md.",
  },
  {
    id: "S11-tautology",
    rule: "S11",
    severity: "major",
    appliesTo: "all",
    regex: /\bexpect\(\s*(true|false|null|undefined|1|0)\s*\)\.(toBe|toEqual|toStrictEqual)\(\s*\1\s*\)|\bXCTAssertTrue\(\s*true\s*\)|\bXCTAssertFalse\(\s*false\s*\)|\bassertTrue\(\s*true\s*\)|\bassertFalse\(\s*false\s*\)|\bassert\.ok\(\s*true\s*\)|#expect\(\s*true\s*\)|\bassert\s+True\b/,
    languages: CODE,
    why: "An assertion that cannot fail.",
    fix: "Assert on the behaviour under test, or delete the test.",
  },
  // ── S12 swallowed failures ──
  {
    id: "S12-pass",
    rule: "S12",
    severity: "major",
    appliesTo: "shipped",
    regex: /^\s*except[^:]*:\s*pass\s*$/,
    languages: ["python"],
    why: "Exception swallowed with pass.",
    fix: "Handle the error, surface it, or let it propagate.",
  },
  {
    id: "S12-try-question",
    rule: "S12",
    severity: "major",
    appliesTo: "shipped",
    regex: /\btry\?\s*[^\n]*\b(save|write|delete|upload|remove|insert|commit)\w*\(/i,
    languages: ["swift"],
    why: "`try?` discards an error on an important path (save/write/delete/upload).",
    fix: "Use do/catch and surface the failure to the user or the caller.",
  },
];

/** Multi-line patterns (empty catch blocks). */
/**
 * A catch body holding only a comment is still empty unless the comment says
 * something ("// already rolled back" explains; "// ignore" does not).
 */
const UNINFORMATIVE_COMMENT = /^(ignore[ds]?|ignore (it|this|errors?|exceptions?)|swallow(ed)?|no-?op|nothing|do nothing|nothing to do|empty|silent(ly)?( ignore)?|todo|fixme|handle (it )?later|\.{3}|-+)?[.!]?$/i;
const catchBodyIsEmpty = (match: string) => {
  // the regex only admits whitespace and comments inside the braces, so every comment in the match is in the body
  const comments = [...match.matchAll(/\/\/([^\n]*)|\/\*((?:[^*]|\*(?!\/))*)\*\//g)].map((m) => (m[1] ?? m[2] ?? "").replace(/^[\s*]+|[\s*]+$/g, ""));
  return comments.every((c) => UNINFORMATIVE_COMMENT.test(c.trim()));
};

/** How far past its `{` an empty body may reach; nothing longer is a plausible empty catch. */
const EMPTY_BODY_MAX = 4096;

/**
 * Where a body that opens at `open` (a `{`) closes, when it holds only whitespace and comments
 * within EMPTY_BODY_MAX characters; -1 otherwise. A linear scan: the regex this replaces
 * backtracked to the end of the file from every `catch` (quadratic on crafted input).
 */
export function emptyBodyEnd(s: string, open: number, max = EMPTY_BODY_MAX): number {
  const end = Math.min(s.length, open + max);
  let i = open + 1;
  while (i < end) {
    const c = s.charCodeAt(i);
    if (c === 125 /* } */) return i + 1;
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12) i++;
    else if (c === 47 /* / */ && s[i + 1] === "/") {
      const nl = s.slice(i, end).indexOf("\n");
      if (nl < 0) return -1;
      i += nl + 1;
    } else if (c === 47 && s[i + 1] === "*") {
      const close = s.slice(i + 2, end).indexOf("*/");
      if (close < 0) return -1;
      i += close + 4;
    } else return -1;
  }
  return -1;
}

/**
 * Multi-line rules: `regex` matches the header up to and including the body's `{`; the body must
 * be empty (emptyBodyEnd), and `after`, when set, must match right after it.
 */
export const BLOCK_RULES: Array<{ id: string; rule: string; severity: Severity; regex: RegExp; after?: RegExp; languages: LangFamily[]; why: string; fix: string; excludeIf?: (match: string) => boolean }> = [
  {
    id: "S12-empty-catch",
    rule: "S12",
    severity: "major",
    // a body of only whitespace and comments ("// ignore") is still empty; every quantifier is bounded or unambiguous
    regex: /(?<![.\w])catch\s*(?:\([^)]{0,300}\)\s*)?(?:let\s+\w+(?:\s+as\s+[\w.]+)?\s*)?\{/g,
    languages: ["js", "swift", "kotlin", "java", "csharp", "c"],
    why: "Empty catch block swallows the failure.",
    fix: "Handle the error, surface it, or rethrow.",
    excludeIf: (match) => !catchBodyIsEmpty(match),
  },
  {
    id: "S12-empty-promise-catch",
    rule: "S12",
    severity: "major",
    regex: /\.catch\(\s*(?:\([\w:\s]{0,200}\)|\w+)\s*=>\s*\{/g,
    after: /\s*\)/y,
    languages: ["js"],
    why: "Promise rejection swallowed by an empty .catch handler.",
    fix: "Handle the error, surface it, or let it propagate.",
    excludeIf: (match) => !catchBodyIsEmpty(match),
  },
];

/** Provider tokens S6-token recognises, for redaction (global). */
const SECRET_TOKENS = /\bsk_live_[A-Za-z0-9]{8,}|\bsk-[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b|\bghp_[A-Za-z0-9]{30,}|\bxox[abp]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{35}\b/g;
/** What a redacted value becomes; the verdict validator recognises it in a gate's quote. */
export const REDACTED = /<redacted: \d+ chars>/;
const REDACTED_AT = /^<redacted: \d+ chars>/;
const mark = (v: string) => `<redacted: ${v.length} chars>`;

/**
 * A secret's line with its value hidden (S6 quotes are stored, sent to agents, shown and exported):
 * provider tokens, quoted values of 8+ characters, and the value of a `NAME=value` / `name: value`
 * line become `<redacted: N chars>`; the name and the shape stay. Idempotent.
 */
export function redactSecrets(line: string): string {
  let out = line.replace(SECRET_TOKENS, mark);
  out = out.replace(/(["'`])([^"'`\n]{8,})\1/g, (m, q: string, v: string) => (REDACTED_AT.test(v) && v.length === v.match(REDACTED_AT)![0].length ? m : `${q}${mark(v)}${q}`));
  out = out.replace(/^(\s*(?:export\s+)?[A-Za-z_][\w.-]{0,80}\s*[=:]\s*)([^\s"'`#][^\s#]*)/, (m, head: string, v: string, at: number) => (REDACTED_AT.test(out.slice(at + head.length)) || v.length < 4 ? m : `${head}${mark(v)}`));
  return out;
}

export const ASSERTION_TOKENS = /\b(assert\w*|expect\w*|XCTAssert\w*|#expect|#require|should\w*|verify\(|toBe|toEqual|assertThat|assertEquals|Assert\.)/;

export const SECRET_NAME = /(key|secret|token|password|passwd|credential|apikey|api_key|auth)/i;
