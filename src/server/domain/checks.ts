// The evidence wrapper (§8.5). Checks run inside agents' environments through
// .helm/run-check.sh, which tees output and appends a trailer Helm can verify.
import { shaMatches } from "./verdict.ts";

export const RUN_CHECK_SH = `#!/usr/bin/env bash
# Helm evidence wrapper. Usage: .helm/run-check.sh <name> -- <command...>
# Runs the command, tees output to reports/checks/<name>.txt and appends
# [helm-exit:<code>] [commit:<sha>] [ts:<epoch>]. Exits with the command's code.
set -u
name="\${1:?usage: run-check.sh <name> -- <command...>}"
shift
if [ "\${1:-}" = "--" ]; then shift; fi
if [ "$#" -eq 0 ]; then echo "run-check.sh: no command given" >&2; exit 64; fi
case "$name" in *[!A-Za-z0-9._-]*) echo "run-check.sh: bad check name" >&2; exit 64;; esac
root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
mkdir -p "$root/reports/checks"
out="$root/reports/checks/$name.txt"
sha="$(git -C "$root" rev-parse HEAD 2>/dev/null || echo none)"
dirty=""
if [ -n "$(git -C "$root" status --porcelain --untracked-files=no 2>/dev/null | grep -v ' reports/' || true)" ]; then dirty=" [dirty:1]"; fi
{ echo "\\$ $*"; } > "$out"
set -o pipefail
"$@" 2>&1 | tee -a "$out"
code=\${PIPESTATUS[0]}
echo "[helm-exit:$code] [commit:$sha] [ts:$(date +%s)]$dirty" >> "$out"
exit "$code"
`;

export const CHECKS_JSON_SKELETON = JSON.stringify(
  {
    build: { command: "echo 'set the build command in .helm/checks.json'", tier: "local", timeoutSec: 900, category: "build" },
    lint: { command: "echo 'set the lint command'", tier: "local", timeoutSec: 600, category: "lint" },
    tests: { command: "echo 'set the test command'", tier: "local", timeoutSec: 900, category: "tests" },
    "slop-scan": { command: "helm_slop_scan (agent tool)", tier: "local", timeoutSec: 120, category: "slop" },
  },
  null,
  2,
);

export const GITIGNORE = `node_modules/
.DS_Store
build/
dist/
DerivedData/
.gradle/
*.xcuserstate
.env
.env.*
!.env.example
`;

export interface Trailer {
  exitCode: number;
  commit: string;
  ts: number;
  dirty: boolean;
}

export function parseTrailer(output: string): Trailer | null {
  const lines = output.trimEnd().split(/\r?\n/);
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
    const m = lines[i].match(/^\[helm-exit:(-?\d+)\] \[commit:([0-9a-fA-F]{7,64}|none)\] \[ts:(\d+)\]( \[dirty:1\])?\s*$/);
    if (m) return { exitCode: Number(m[1]), commit: m[2], ts: Number(m[3]), dirty: !!m[4] };
  }
  return null;
}

export function verifyCheckClaim(claim: { exitCode: number; commit: string }, output: string | null, integrationHead: string | null): { ok: true; trailer: Trailer } | { ok: false; reason: string } {
  if (output === null) return { ok: false, reason: "output file not found — run the check through .helm/run-check.sh" };
  const t = parseTrailer(output);
  if (!t) return { ok: false, reason: "no [helm-exit:…] trailer in the output file — run the check through .helm/run-check.sh" };
  if (t.exitCode !== claim.exitCode) return { ok: false, reason: `you claimed exit ${claim.exitCode} but the trailer says ${t.exitCode}` };
  const c = claim.commit.toLowerCase();
  if (t.commit === "none" || !(t.commit.toLowerCase().startsWith(c) || c.startsWith(t.commit.toLowerCase()))) return { ok: false, reason: `the trailer is for commit ${t.commit.slice(0, 9)}, not ${claim.commit.slice(0, 9)}` };
  if (t.dirty) return { ok: false, reason: "the check ran on a dirty worktree — commit first, then re-run" };
  if (integrationHead && !(integrationHead.startsWith(t.commit) || t.commit.startsWith(integrationHead.slice(0, t.commit.length))))
    return { ok: true, trailer: t }; // recorded, but it will not count toward the current HEAD
  return { ok: true, trailer: t };
}

export interface ChecksDecl {
  [name: string]: { command: string; tier?: "local" | "ci" | "none"; timeoutSec?: number; category?: string };
}

export function parseChecksJson(text: string | null): ChecksDecl | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    return v as ChecksDecl;
  } catch {
    return null;
  }
}

/** Which declared local checks still need a passing record at `head`. */
export function missingChecks(decl: ChecksDecl | null, recorded: Array<{ name: string; exitCode: number | null; commitSha: string | null }>, head: string): { missing: string[]; failing: string[] } {
  const missing: string[] = [];
  const failing: string[] = [];
  const names = decl ? Object.entries(decl).filter(([, d]) => (d.tier ?? "local") === "local").map(([n]) => n) : ["build", "tests"];
  for (const n of names) {
    const rows = recorded.filter((r) => r.name === n && r.commitSha && shaMatches(r.commitSha, head));
    if (!rows.length) missing.push(n);
    else if (!rows.some((r) => r.exitCode === 0)) failing.push(n);
  }
  return { missing, failing };
}
