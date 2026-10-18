// Scriptable simulated agents (§14): diligent, slow, flaky, liar, silent,
// chatty, sloppy and vandal. They only use what a real agent has: the helm_*
// tools, their own worktree (through the fake git) and the text they receive.

import type { AgentDriver, TurnContext } from "./sim.ts";
import type { HelmThreadMeta } from "./port.ts";

export type Profile = "diligent" | "slow" | "flaky" | "liar" | "silent" | "chatty" | "sloppy" | "vandal" | "picky";

export interface AgentScript {
  driver: AgentDriver;
  turnMs: (meta: HelmThreadMeta | null) => number;
  profiles: Map<string, Profile>;
  log: string[];
}

interface Mem {
  builderShas: Map<string, string>;
  integrated: boolean;
  spawned: boolean;
  fixAttempts: number;
  failuresLeft: number;
}

const ACK_RE = /\b(D-\d{4,})\b/g;

function appIdOf(nodeId: string): string {
  return nodeId.split(".")[0];
}

/** profileFor(nodeId, role) decides how each agent behaves; default diligent. */
export function createSimAgents(profileFor: (meta: HelmThreadMeta) => Profile = () => "diligent", opts: { flakyFailures?: number } = {}): AgentScript {
  const mem = new Map<string, Mem>();
  const profiles = new Map<string, Profile>();
  const log: string[] = [];
  const m = (id: string): Mem => {
    let x = mem.get(id);
    if (!x) {
      x = { builderShas: new Map(), integrated: false, spawned: false, fixAttempts: 0, failuresLeft: opts.flakyFailures ?? 2 };
      mem.set(id, x);
    }
    return x;
  };

  const turnMs = (meta: HelmThreadMeta | null) => {
    const base = meta?.tier === "specialist" ? 8 * 60_000 : meta?.tier === "gate" ? 5 * 60_000 : meta?.tier === "lead" ? 4 * 60_000 : 60_000;
    const p = meta ? profileFor(meta) : "diligent";
    return p === "slow" ? base * 4 : base;
  };

  const driver: AgentDriver = async (ctx) => {
    const meta = ctx.thread.meta;
    if (!meta) return "ok";
    const profile = profileFor(meta);
    profiles.set(meta.nodeId, profile);
    const mm = m(ctx.thread.id);
    if (profile === "silent") return "hang";
    if (profile === "flaky" && mm.failuresLeft > 0) {
      mm.failuresLeft--;
      return { fail: "simulated provider failure (rate limited)" };
    }
    // acknowledge binding notices (digests answer "no ack needed", which is fine)
    const ids = [...new Set([...ctx.text.matchAll(ACK_RE)].map((x) => x[1]))];
    if (/(Message from the human|The human |Your direct report|Direction from |Reminder: please call helm_ack|Changes made before you started)/.test(ctx.text)) for (const id of ids) await ctx.tool("helm_ack", { directiveId: id, note: "adapted my plan" });
    if (/^(The human paused you|The human stopped)/.test(ctx.text)) return "paused";
    const role = meta.role;
    if (role === "planner" && meta.runId === "planner") return planner(ctx, profile);
    if (role === "planner") return amer(ctx);
    if (role === "custom") return custom(ctx);
    if (role === "watch") {
      // the sim Watcher restarts every agent in the packet
      const ids = [...ctx.text.matchAll(/^- id: (\S+)/gm)].map((x) => x[1]);
      if (ids.length) await ctx.tool("helm_watch", { verdicts: ids.map((nodeId) => ({ nodeId, verdict: "restart", note: "no progress; resume from your last commit" })) });
      return "idle";
    }
    if (role === "orch" && !(await isAlsoLead(ctx))) return orchestrator(ctx);
    if (role === "mgr") return manager(ctx);
    if (role === "lead" || role === "orch") return lead(ctx, mm, log);
    if (role === "review" || role === "slop") return gate(ctx, meta, profile);
    return specialist(ctx, meta, profile, mm);
  };

  return { driver, turnMs, profiles, log };
}

async function isAlsoLead(ctx: TurnContext): Promise<boolean> {
  return /also (its )?App Lead|you are also its App Lead/.test(ctx.text) || ctx.worktree?.includes(".bb-worktrees") === true;
}

async function orchestrator(ctx: TurnContext): Promise<string> {
  if (ctx.first) {
    await ctx.tool("helm_context", {});
    await ctx.tool("helm_world", {});
    await ctx.tool("helm_report", { status: "progress", summary: "Read the portfolio and world state; managers and leads are starting." });
  }
  return "watching the portfolio";
}

/** The run's Planner (Amer): idle until asked; answers from the world state. */
async function amer(ctx: TurnContext): Promise<string> {
  if (/From the human|Message from/.test(ctx.text)) await ctx.tool("helm_world", {});
  return "I am the run's Planner; ask me anything.";
}

/** A custom agent: does its mission once per wake-up and reports. */
async function custom(ctx: TurnContext): Promise<string> {
  if (ctx.first) await ctx.tool("helm_context", {});
  await ctx.tool("helm_report", { status: "done", summary: ctx.first ? "Mission understood; first pass done." : "Woken; checked and reported." });
  return "done";
}

async function manager(ctx: TurnContext): Promise<string> {
  if (ctx.first) {
    await ctx.tool("helm_context", {});
    await ctx.tool("helm_report", { status: "progress", summary: "Group understood; leads will report to me." });
  }
  return "watching my group";
}

const CLEAN_FILE = (name: string) => `export function ${name}(input: number): number {\n  if (input < 0) throw new RangeError("negative input");\n  return input * 2;\n}\n`;
const SLOP_LINES = /TODO|FIXME|lorem ipsum|coming soon/i;

function childIds(contextText: string): Array<{ id: string; status: string }> {
  const line = contextText.split("\n").find((l) => l.startsWith("Children:"));
  if (!line) return [];
  return line
    .replace(/^Children:\s*/, "")
    .replace(/\.$/, "")
    .split(",")
    .map((s) => s.trim().split(/\s+/))
    .filter((p) => p.length >= 2)
    .map(([id, status]) => ({ id, status }));
}

async function runAndRecordChecks(ctx: TurnContext): Promise<string> {
  const wt = ctx.worktree!;
  const w = ctx.git.wts.get(wt)!;
  const head = ctx.git.head(w)!;
  for (const name of ["build", "lint", "tests"]) {
    const ref = ctx.git.runCheck(wt, name, 0, `${name} passed`);
    await ctx.tool("helm_record_check", { name, command: `.helm/run-check.sh ${name} -- npm run ${name}`, exitCode: 0, outputRef: ref, commit: head });
  }
  await ctx.tool("helm_slop_scan", {});
  return head;
}

function cleanSlop(ctx: TurnContext, wt: string, paths?: string[]): number {
  const w = ctx.git.wts.get(wt)!;
  let n = 0;
  for (const [p, c] of [...w.work]) {
    if (paths && !paths.includes(p)) continue;
    if (p.startsWith("reports/") || p.endsWith(".md") || p.startsWith(".helm/")) continue;
    const lines = c.split("\n");
    const kept = lines.filter((l) => !SLOP_LINES.test(l));
    if (kept.length !== lines.length) {
      w.work.set(p, kept.join("\n"));
      n++;
    }
  }
  return n;
}

async function lead(ctx: TurnContext, mm: Mem, log: string[]): Promise<string> {
  const wt = ctx.worktree;
  if (!wt) return "no worktree";
  const appId = ctx.thread.meta!.nodeId === "orch" ? guessApp(ctx) : appIdOf(ctx.thread.meta!.nodeId);
  // collect builder evidence from reports
  for (const mt of ctx.text.matchAll(/Report from (.+?) — done: .*?\[evidence: commit ([0-9a-f]{9,12})/g)) mm.builderShas.set(mt[1], mt[2]);
  if (ctx.first || !mm.spawned) {
    for (const [f, body] of Object.entries({ "SPEC.md": `# SPEC — ${appId}\n\nScreens and flows.\n`, "ARCHITECTURE.md": "# ARCHITECTURE\n\nModules: core, ui, platforms.\n", "CONTRACT.md": "# CONTRACT v1\n\nexport function core(input: number): number\n", "ACCEPTANCE.md": "# ACCEPTANCE\n\n- build, lint, tests pass\n" })) ctx.git.write(wt, f, body);
    ctx.git.write(wt, ".helm/checks.json", JSON.stringify({ build: { command: "npm run build", tier: "local" }, lint: { command: "npm run lint", tier: "local" }, tests: { command: "npm test", tier: "local" }, "slop-scan": { command: "helm_slop_scan", tier: "local" } }, null, 2));
    ctx.git.write(wt, "package.json", JSON.stringify({ name: appId, version: "1.0.0", dependencies: {} }, null, 2));
    ctx.git.commit(wt, "Spec, architecture, contract v1, acceptance");
    await ctx.tool("helm_publish_contract", { version: 1, summary: "core(input) contract" });
    const st = await ctx.tool("helm_stage", { to: "build", evidence: [{ kind: "file", ref: "SPEC.md" }] });
    log.push(`${ctx.thread.meta!.nodeId} stage build: ${st}`);
    if (st.startsWith("Rejected")) return st;
    const c = await ctx.tool("helm_context", {});
    const builders = childIds(c).filter((x) => !/\.(review|slop)$/.test(x.id));
    mm.spawned = true;
    if (!builders.length) {
      ctx.git.write(wt, "src/app.ts", CLEAN_FILE("app"));
      ctx.git.commit(wt, "Solo build");
    } else {
      const spawn = builders.map((b) => {
        const parts = b.id.split(".");
        return parts[1] === "p" ? { role: "platform", platform: parts[2] } : { role: parts[1] };
      });
      const r = await ctx.tool("helm_spawn_squad", { spawn });
      log.push(`${ctx.thread.meta!.nodeId} squad: ${r}`);
      return "squad spawned; waiting for builders";
    }
  }
  // fix round: clean the named files ourselves, re-integrate, re-run checks
  const fixMatch = ctx.text.match(/^Fix round (\d+)/m);
  if (fixMatch) {
    const paths = [...ctx.text.matchAll(/- F-\d+ S?\w+ \w+ ([^\s:]+):\d+/g)].map((x) => x[1]);
    cleanSlop(ctx, wt, paths.length ? paths : undefined);
    ctx.git.commit(wt, `Fix round ${fixMatch[1]}`);
    await runAndRecordChecks(ctx);
    const s1 = await ctx.tool("helm_stage", { to: "integrate", evidence: [] });
    log.push(`${ctx.thread.meta!.nodeId} fix→integrate: ${s1}`);
    const s2 = await ctx.tool("helm_stage", { to: "review", evidence: [] });
    log.push(`${ctx.thread.meta!.nodeId} →review: ${s2}`);
    return "fixes integrated";
  }
  // build → integrate once every builder is done
  if (!mm.integrated) {
    const c = await ctx.tool("helm_context", {});
    const builders = childIds(c).filter((x) => !/\.(review|slop)$/.test(x.id));
    if (builders.length && !builders.every((b) => b.status === "done")) return "waiting for builders";
    for (const sha of mm.builderShas.values()) ctx.git.merge(wt, sha);
    const s1 = await ctx.tool("helm_stage", { to: "integrate", evidence: [] });
    log.push(`${ctx.thread.meta!.nodeId} →integrate: ${s1}`);
    if (s1.startsWith("Rejected") && !/cannot move Integrate/.test(s1)) return s1;
    mm.integrated = true;
    await runAndRecordChecks(ctx);
    let s2 = await ctx.tool("helm_stage", { to: "review", evidence: [] });
    if (s2.startsWith("Rejected") && /zero-tolerance|slop-scan/.test(s2) && mm.fixAttempts < 2) {
      mm.fixAttempts++;
      cleanSlop(ctx, wt);
      ctx.git.commit(wt, "Remove placeholders found by the scanner");
      await runAndRecordChecks(ctx);
      s2 = await ctx.tool("helm_stage", { to: "review", evidence: [] });
    }
    log.push(`${ctx.thread.meta!.nodeId} →review: ${s2}`);
    return s2;
  }
  return "waiting";
}

function guessApp(ctx: TurnContext): string {
  const m = ctx.text.match(/App (\S+?): stage/);
  return m ? m[1] : "app";
}

async function specialist(ctx: TurnContext, meta: HelmThreadMeta, profile: string, mm: Mem): Promise<string> {
  const wt = ctx.worktree;
  if (!wt) return "no worktree";
  void mm;
  const fix = ctx.text.match(/^Fix (F-\d+) .*? at ([^\s:]+):(\d+)/m);
  if (fix) {
    cleanSlop(ctx, wt, [fix[2]]);
    const sha = ctx.git.commit(wt, `Fix ${fix[1]}`);
    await ctx.tool("helm_report", { status: "done", summary: `Fixed ${fix[1]}`, evidence: [{ kind: "commit", ref: sha }] });
    return "fixed";
  }
  if (!ctx.first && !/^retry/.test(ctx.text)) return "nothing to do";
  if (profile === "liar") {
    await ctx.tool("helm_report", { status: "done", summary: "All done, everything works!", evidence: [] });
    return "done (claimed)";
  }
  const part = meta.nodeId.split(".").slice(1).join("-");
  const path = meta.role === "platform" ? `platforms/${part}/main.ts` : meta.role === "security" ? "src/security/audit.ts" : `src/${meta.role}/${part}.ts`;
  const body = CLEAN_FILE(part.replace(/[^a-z]/g, "") || "work") + (profile === "sloppy" ? "// TODO: handle the real data later\n" : "");
  ctx.git.write(wt, path, body);
  if (profile === "chatty") for (let i = 0; i < 5; i++) await ctx.tool("helm_report", { status: "progress", summary: `step ${i + 1} of 5` });
  const sha = ctx.git.commit(wt, `${meta.role}: first implementation`);
  const r = await ctx.tool("helm_report", { status: "done", summary: `Implemented ${path}`, evidence: [{ kind: "commit", ref: sha }, { kind: "file", ref: path }] });
  return r;
}

async function gate(ctx: TurnContext, meta: HelmThreadMeta, profile: string): Promise<string> {
  const wt = ctx.worktree;
  if (!wt) return "no worktree";
  const sha = ctx.text.match(/Judge exactly this commit: `([0-9a-f]{7,40})`/)?.[1] ?? ctx.text.match(/Re-check commit ([0-9a-f]{7,40})/)?.[1];
  if (!sha) return "no commit to judge";
  ctx.git.checkoutDetached(wt, sha);
  if (profile === "vandal") {
    const w = ctx.git.wts.get(wt)!;
    const first = [...w.work.keys()].find((p) => p.startsWith("src/"));
    if (first) ctx.git.write(wt, first, `${w.work.get(first)}\n// tidied by the reviewer\n`);
  }
  const checks = ["build", "tests"].map((name) => {
    const ref = ctx.git.runCheck(wt, name, 0, `${name} passed`);
    return { id: name, ok: true, how: `.helm/run-check.sh ${name} -- npm run ${name}`, ref };
  });
  const appId = appIdOf(meta.nodeId) === "orch" ? "app" : appIdOf(meta.nodeId);
  const findings: Array<{ id: string; rule: string; severity: string; path: string; line: number; quote: string; why: string; fix: string }> = [];
  // picky: the first judgement fails with one real, locatable review finding; re-checks pass
  if (profile === "picky" && !/Re-check commit/.test(ctx.text)) {
    const w = ctx.git.wts.get(wt)!;
    const target = [...w.work.keys()].find((p) => /^(src|packages|apps)\//.test(p) && !p.endsWith(".md"));
    const first = target ? (w.work.get(target) ?? "").split("\n")[0] : "";
    if (target && first.trim()) findings.push({ id: "f1", rule: "R", severity: "major", path: target, line: 1, quote: first.slice(0, 60), why: "acceptance criterion not met", fix: "implement the missing case" });
  }
  if (meta.role === "slop") {
    let k = 0;
    for (const mt of ctx.text.matchAll(/- (S\d+) (blocker|major) ([^\s:]+):(\d+) “([^”]*)”/g)) findings.push({ id: `f${++k}`, rule: mt[1], severity: mt[2], path: mt[3], line: Number(mt[4]), quote: mt[5].replace(/…$/, "").slice(0, 60), why: "zero-tolerance category", fix: "remove it and implement the behaviour" });
  }
  const r = await ctx.tool("helm_verdict", { gate: meta.role, appId, commit: sha, verdict: findings.length ? "fail" : "pass", summary: findings.length ? `${findings.length} zero-tolerance findings` : "Acceptance met; checks green.", checks, findings, unverified: [] });
  return r;
}

/**
 * The simulated planner reads free-text lines like "Mint Jar: a savings jar for kids, on iPhone and Android"
 * from the brief. "sloppy" first proposes an invalid portfolio (empty names), then the right one;
 * "liar" ends its turn without proposing.
 */
async function planner(ctx: TurnContext, profile: string): Promise<string> {
  if (profile === "liar") return "I read the brief.";
  const brief = ctx.text.match(/<brief>\n?([\s\S]*?)<\/brief>/)?.[1] ?? "";
  const apps = [...brief.matchAll(/^\s*([A-Z][\w ]{1,40}?):\s*(.+)$/gm)].map((m) => {
    const rest = m[2];
    const platforms = [/\b(iphone|ios)\b/i.test(rest) && "ios", /\bandroid\b/i.test(rest) && "android", /\bmac(os)?\b/i.test(rest) && "macos", /\bwindows\b/i.test(rest) && "windows"].filter(Boolean) as string[];
    return { name: m[1].trim(), tagline: rest.split(/,\s*on\s/i)[0].slice(0, 120), platforms: platforms.length ? platforms : ["ios", "android"] };
  });
  if (profile === "sloppy") {
    const bad = await ctx.tool("helm_propose_plan", { portfolio: { apps: apps.map((a) => ({ ...a, name: "" })), groups: [], assumptions: [], questions: [] } });
    if (!/^(Rejected|Invalid arguments)/.test(bad)) return "unexpectedly accepted";
  }
  const unclear = apps.filter((a) => !/iphone|ios|android|mac|windows/i.test(brief.split("\n").find((l) => l.includes(a.name)) ?? ""));
  return ctx.tool("helm_propose_plan", {
    portfolio: { apps, groups: [], assumptions: unclear.map((a) => `${a.name}: no platforms given — assumed iOS and Android.`), questions: unclear.slice(0, 3).map((a) => `Should ${a.name} also ship on macOS?`) },
  });
}
