// Gate verdicts (§5.3, appendix B §6). Validation is where hallucinated findings
// die: every finding's quote must be found at the judged commit.
import { z } from "zod";
import { REDACTED, redactSecrets } from "./slop/rules.ts";

export const SLOP_RULES = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12", "R"] as const;
export const ZERO_TOLERANCE_RULES = ["S1", "S2", "S3", "S5", "S6"] as const;

export const VerdictSchema = z
  .object({
    gate: z.enum(["review", "slop"]),
    appId: z.string().min(1),
    commit: z.string().min(4).max(64),
    verdict: z.enum(["pass", "fail"]),
    summary: z.string().max(600),
    checks: z
      .array(
        z.object({
          id: z.string().min(1).max(80),
          ok: z.boolean(),
          how: z.string().max(400),
          ref: z.string().max(300),
        }),
      )
      .max(80),
    findings: z
      .array(
        z.object({
          id: z.string().min(1).max(20),
          rule: z.enum(SLOP_RULES),
          severity: z.enum(["blocker", "major", "minor", "nit"]),
          path: z.string().max(400),
          line: z.number().int().min(0),
          quote: z.string().max(200),
          why: z.string().max(600),
          fix: z.string().max(600),
        }),
      )
      .max(60),
    unverified: z.array(z.object({ what: z.string().max(200), reason: z.string().max(300) })).max(30).default([]),
  })
  .strict();

export type Verdict = z.output<typeof VerdictSchema>;

export interface VerdictEnvironment {
  /** The integration HEAD (full sha) at submit time. */
  integrationHead: string;
  /** Read a file at the judged commit; null when it does not exist. */
  readAt(commit: string, path: string): Promise<string | null>;
  /** Whether a check ref exists (a reports/ file at the commit or in the gate worktree). */
  refExists(ref: string): Promise<boolean>;
  /** Findings Helm already knows are open for this app (e.g. scanner findings, earlier rounds). */
  priorOpenBlockingFindings?: number;
  /** Result of the read-only check on the gate's worktree. */
  worktree?: { clean: boolean; head: string | null; dirtyPaths: string[] };
}

export function shaMatches(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Whether quote appears within ±2 lines of `line` (1-based), whitespace-normalized. A quote copied
 * from a redacted S6 finding (`<redacted: N chars>`) is matched against the redacted lines.
 */
export function quoteNear(content: string, line: number, quote: string, slack = 2): boolean {
  const q = norm(quote);
  if (!q) return false;
  const lines = REDACTED.test(q) ? content.split(/\r?\n/).map(redactSecrets) : content.split(/\r?\n/);
  const from = Math.max(0, line - 1 - slack);
  const to = Math.min(lines.length - 1, line - 1 + slack);
  for (let i = from; i <= to; i++) if (norm(lines[i]).includes(q)) return true;
  // a quote may span two adjacent lines
  for (let i = from; i < to; i++) if (norm(`${lines[i]} ${lines[i + 1]}`).includes(q)) return true;
  return false;
}

export interface VerdictResult {
  accepted: boolean;
  problems: string[];
  /** Findings that located correctly (kept), and rejected ones with reasons. */
  located: string[];
  unlocatable: Array<{ id: string; reason: string }>;
  readOnlyViolation: boolean;
}

export async function validateVerdict(v: Verdict, env: VerdictEnvironment): Promise<VerdictResult> {
  const problems: string[] = [];
  const located: string[] = [];
  const unlocatable: Array<{ id: string; reason: string }> = [];
  let readOnlyViolation = false;

  if (!shaMatches(v.commit, env.integrationHead))
    problems.push(`commit ${v.commit} is not the current integration HEAD (${env.integrationHead}): the lead integrated newer work while you judged. Follow the "Re-check commit" message Helm sends you for it, confirm your findings still hold there, and submit for that commit.`);

  if (v.verdict === "pass" && v.checks.length === 0) problems.push("a pass needs at least one check.");
  for (const c of v.checks) {
    if (!c.how.trim()) problems.push(`check ${c.id} has no "how" (the command or method used).`);
    if (!c.ref.trim()) problems.push(`check ${c.id} has no "ref" (an output file under reports/ or path:line).`);
    else if (!(await env.refExists(c.ref))) problems.push(`check ${c.id}: ref ${c.ref} does not exist.`);
  }

  const nits = v.findings.filter((f) => f.severity === "nit").length;
  if (nits > 10) problems.push(`${nits} nits — at most 10 are allowed. Keep the real ones.`);

  const blocking = v.findings.filter((f) => f.severity === "blocker" || f.severity === "major");
  if (v.verdict === "pass" && blocking.length) problems.push(`a pass cannot carry ${blocking.length} blocker/major findings.`);
  if (v.verdict === "pass" && v.checks.some((c) => !c.ok)) problems.push("a pass cannot include a failing check.");

  for (const f of v.findings) {
    if (!f.path.trim() || f.line < 1 || !f.quote.trim()) {
      unlocatable.push({ id: f.id, reason: "needs path, line and an exact quote" });
      continue;
    }
    const content = await env.readAt(v.commit, f.path);
    if (content === null) {
      unlocatable.push({ id: f.id, reason: `${f.path} does not exist at ${v.commit.slice(0, 9)}` });
      continue;
    }
    if (!quoteNear(content, f.line, f.quote)) {
      unlocatable.push({ id: f.id, reason: `quote not found within ±2 lines of ${f.path}:${f.line}` });
      continue;
    }
    located.push(f.id);
  }
  if (unlocatable.length)
    problems.push(`unverifiable findings: ${unlocatable.map((u) => `${u.id} (${u.reason})`).join("; ")}.`);

  if (env.worktree) {
    const outside = env.worktree.dirtyPaths.filter((p) => !p.startsWith("reports/"));
    if (outside.length || (env.worktree.head && !shaMatches(env.worktree.head, v.commit))) {
      readOnlyViolation = true;
      problems.push(
        `read-only violation: ${outside.length ? `changed ${outside.slice(0, 5).join(", ")}${outside.length > 5 ? "…" : ""}` : ""}${env.worktree.head && !shaMatches(env.worktree.head, v.commit) ? ` HEAD moved to ${env.worktree.head.slice(0, 9)}` : ""}. Gates may write only under reports/**.`,
      );
    }
  }

  return { accepted: problems.length === 0, problems, located, unlocatable, readOnlyViolation };
}

export function isZeroTolerance(rule: string): boolean {
  return (ZERO_TOLERANCE_RULES as readonly string[]).includes(rule);
}

/**
 * Does this finding block Ready (appendix B §2)? A zero-tolerance category at blocker or major,
 * except S5: debug output is zero-tolerance only when it logs user data, which the scanner
 * and the gate grade as blocker.
 */
export function blocksReady(f: { rule: string; severity: string }, rules: readonly string[] = ZERO_TOLERANCE_RULES): boolean {
  if (!rules.includes(f.rule)) return false;
  if (f.rule === "S5") return f.severity === "blocker";
  return f.severity === "blocker" || f.severity === "major";
}

/** Waiver rules (appendix B §7). Returns the problem, or null when allowed. */
export function waiverProblem(input: { rule: string; reason: string; actor: "human" | "lead"; rotatedConfirmed?: boolean }): string | null {
  if (input.actor !== "human") return "Only the human can waive a finding; propose it through helm_need.";
  const reason = input.reason.trim();
  if (!reason) return "A waiver needs a reason.";
  if (isZeroTolerance(input.rule) && reason.length < 20) return "Zero-tolerance findings need a reason of at least 20 characters.";
  if (input.rule === "S6" && !input.rotatedConfirmed && !/rotated/i.test(reason)) return 'Secret waivers need the confirmation "I have rotated this credential".';
  return null;
}
