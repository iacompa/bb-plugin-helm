// The two-worktree rule. Every app has exactly two worktrees: the human's checkout and one
// shared work worktree beside it on the same disk, where all of the app's agents work on its
// integration branch. This module reports each app's worktrees, alerts the Git agent when an app
// has more, and consolidates an app that still uses one worktree per agent (apps started before
// the rule): once every extra worktree's work is committed and on the integration branch, its
// agents move into the shared worktree and the extra worktrees are removed.

import type { AppInfo, NodeInfo } from "../../shared/types.ts";
import type { Engine } from "./engine.ts";
import { HelmError } from "./engine.ts";
import { GIT_ID } from "./custom.ts";

export const MAX_WORKTREES = 2;
/** How often the watchdog looks at a run's worktrees. */
const AUDIT_EVERY_MS = 30 * 60_000;

export interface WorktreeRow {
  path: string;
  branch: string | null;
  head: string | null;
  dirty: number;
  missing: boolean;
  role: "checkout" | "work" | "extra";
  /** The agents whose BB environment is this folder. */
  agents: string[];
}

export interface AppWorktrees {
  appId: string;
  name: string;
  repo: string | null;
  work: string | null;
  branch: string | null;
  worktrees: WorktreeRow[];
  /** How many worktrees beyond the allowed two. */
  extra: number;
  /** Branches besides main and the work branch that Helm's agents made (bb/…, helm/…): the Git agent removes them once merged. */
  extraBranches: string[];
  /** Other branches (the human's or another tool's): reported, never touched. */
  otherBranches: string[];
  error: string | null;
}

/** Branches Helm's agents make (BB worktree branches, older Helm branches). */
const AGENT_BRANCH = /^(bb|helm)\//;

/** Which agents work in which folder (from their BB environments). */
async function agentsByPath(e: Engine, nodes: NodeInfo[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const n of nodes.slice(0, 60)) {
    const envId = e.repo.nodeEnvironment(n.runId, n.id);
    if (!envId) continue;
    const env = await e.port.environment(envId).catch(() => null);
    if (!env?.path) continue;
    out.set(env.path, [...(out.get(env.path) ?? []), n.id]);
  }
  return out;
}

/** Every app's worktrees, from git itself. `status` adds the uncommitted-change count of each. */
export async function appWorktrees(e: Engine, runId: string, opts: { appId?: string; status?: boolean } = {}): Promise<AppWorktrees[]> {
  const apps = e.repo.listApps(runId).filter((a) => a.stage !== "cancelled" && (!opts.appId || a.id === opts.appId));
  const nodes = e.repo.listNodes(runId);
  const out: AppWorktrees[] = [];
  for (const app of apps) {
    const work = e.workTree(runId, app.id);
    const branch = e.repo.appExtra(runId, app.id).integrationBranch;
    const row: AppWorktrees = { appId: app.id, name: app.name, repo: app.repoPath, work, branch, worktrees: [], extra: 0, extraBranches: [], otherBranches: [], error: null };
    out.push(row);
    if (!app.repoPath) continue;
    try {
      const res = await e.host(runId).worktrees({ repo: app.repoPath, status: opts.status ?? true });
      const who = opts.status === false ? new Map<string, string[]>() : await agentsByPath(e, nodes.filter((n) => n.appId === app.id || (n.alsoLead && apps[0]?.id === app.id)));
      row.worktrees = res.worktrees.map((w) => ({ path: w.path, branch: w.branch, head: w.head, dirty: w.dirty, missing: w.missing, role: w.main ? "checkout" : w.path === work ? "work" : "extra", agents: who.get(w.path) ?? [] }));
      row.extra = Math.max(0, row.worktrees.length - MAX_WORKTREES);
      const keep = new Set([branch, app.userBranch ?? "main", "main", "master"].filter(Boolean));
      const rest = (res.branches ?? []).filter((b) => !keep.has(b));
      row.extraBranches = rest.filter((b) => AGENT_BRANCH.test(b));
      row.otherBranches = rest.filter((b) => !AGENT_BRANCH.test(b));
    } catch (err) {
      row.error = err instanceof Error ? err.message.slice(0, 200) : String(err);
    }
  }
  return out;
}

/** The report the Git agent and the CLI read. */
export function worktreesText(list: AppWorktrees[]): string {
  if (!list.length) return "No apps with repositories yet.";
  const over = list.filter((a) => a.extra > 0);
  const branchy = list.filter((a) => a.extraBranches.length);
  const lines = [
    over.length ? `${over.length} app(s) have more than ${MAX_WORKTREES} worktrees: ${over.map((a) => `${a.name} (${a.worktrees.length})`).join(", ")}.` : `Every app has at most ${MAX_WORKTREES} worktrees.`,
    branchy.length ? `${branchy.length} app(s) have agent branches besides main and the work branch: ${branchy.map((a) => `${a.name} (${a.extraBranches.length})`).join(", ")}.` : "No agent branches besides main and the work branches.",
  ];
  for (const a of list) {
    lines.push(`\n${a.name} (${a.appId}): ${a.repo ?? "no repository yet"} · work branch ${a.branch ?? "not yet"}${a.work ? "" : a.repo ? " · no shared work worktree yet (one worktree per agent until consolidated)" : ""}`);
    if (a.error) lines.push(`  could not list worktrees: ${a.error}`);
    for (const w of a.worktrees) lines.push(`  - ${w.role.padEnd(8)} ${w.path} · ${w.branch ?? "detached"} @ ${w.head?.slice(0, 9) ?? "?"}${w.missing ? " · MISSING on disk (git worktree prune)" : w.dirty ? ` · ${w.dirty} uncommitted` : " · clean"}${w.agents.length ? ` · agents: ${w.agents.join(", ")}` : ""}`);
    if (a.extraBranches.length) lines.push(`  agent branches to remove once merged into the work branch (git branch -d, never -D): ${a.extraBranches.slice(0, 30).join(", ")}${a.extraBranches.length > 30 ? " …" : ""}`);
    if (a.otherBranches.length) lines.push(`  other branches (the human's; leave them): ${a.otherBranches.slice(0, 20).join(", ")}${a.otherBranches.length > 20 ? " …" : ""}`);
  }
  return lines.join("\n");
}

/**
 * Watchdog: wake the Git agent when an app has more than two worktrees. At most every 30
 * minutes per run, and once per distinct situation.
 */
export async function auditWorktrees(e: Engine, runId: string): Promise<string[]> {
  const git = e.repo.getNode(runId, GIT_ID);
  if (!git?.threadId) return [];
  const last = Number(e.repo.getMeta(`wt-audit-at:${runId}`) ?? 0);
  if (e.now() - last < AUDIT_EVERY_MS) return [];
  e.repo.setMeta(`wt-audit-at:${runId}`, String(e.now()));
  const list = await appWorktrees(e, runId, { status: false });
  const over = list.filter((a) => a.extra > 0 || a.extraBranches.length > 0);
  const sig = over.map((a) => `${a.appId}:${a.worktrees.length}:${a.extraBranches.length}`).join(",");
  if (!over.length || e.repo.getMeta(`wt-alert:${runId}`) === sig) return over.map((a) => a.appId);
  e.repo.setMeta(`wt-alert:${runId}`, sig);
  const what = (a: AppWorktrees) => [a.extra > 0 ? `${a.name} has ${a.worktrees.length} worktrees` : null, a.extraBranches.length ? `${a.name} has ${a.extraBranches.length} agent branch(es) besides main and ${a.branch ?? "its work branch"}` : null].filter(Boolean).join("; ");
  e.sendFromHelm(runId, GIT_ID, `Helm worktree check: ${over.map(what).join("; ")} (the rule: two worktrees, the checkout and one shared work worktree; two branches, main and the work branch). Call helm_worktrees, then bring each app back to two: helm_consolidate once the extra worktrees' work is committed and on the work branch, and \`git branch -d\` for agent branches already merged into it. Your instructions on git are binding on every agent. Tell the human what you did.`, { key: `wt-alert:${runId}:${sig}` });
  return over.map((a) => a.appId);
}

/**
 * Move an app onto one shared work worktree. Refuses (with what to do) while any extra worktree
 * has uncommitted work or commits that are not on the integration branch. Then its agents' threads
 * are archived, their BB worktrees removed, the shared worktree created on the integration branch,
 * and the agents that were working start again there with a hand-over.
 */
export async function consolidate(e: Engine, runId: string, appId: string, by: string): Promise<string> {
  const run = e.run(runId);
  const app = e.repo.getApp(runId, appId);
  if (!app) throw new HelmError(`No app ${appId} in this run.`, "not_found");
  if (!app.repoPath) throw new HelmError(`${app.name} has no repository yet.`, "bad_state");
  const branch = e.repo.appExtra(runId, appId).integrationBranch;
  const work = e.workTree(runId, appId);
  const host = e.host(runId);
  const members = e.repo.listNodes(runId).filter((n) => n.appId === appId || (n.alsoLead && e.repo.listApps(runId)[0]?.id === appId));
  // the agents' own BB environments (not the shared worktree)
  const moving: Array<{ n: NodeInfo; envId: string; path: string | null }> = [];
  for (const n of members) {
    const envId = e.repo.nodeEnvironment(runId, n.id);
    if (!envId) continue;
    const env = await e.port.environment(envId).catch(() => null);
    if (env?.path && env.path === work) continue;
    moving.push({ n, envId, path: env?.path ?? null });
  }
  if (!moving.length) {
    // a consolidation that stopped half-way, or an older app none of whose agents holds a worktree now
    if (!work && branch) return finish(e, run, app as AppInfo, branch, by, "");
    const list = await appWorktrees(e, runId, { appId });
    const rest = list[0]?.worktrees.filter((w) => w.role === "extra") ?? [];
    if (!work && branch === null) return `${app.name} has not started yet; Helm gives it one shared work worktree when its first agent starts.`;
    if (!rest.length) return `${app.name} already has ${list[0]?.worktrees.length ?? 2} worktrees: nothing to consolidate.`;
    return `${app.name}'s agents already work in the shared worktree. Extra worktrees not made by Helm's agents: ${rest.map((w) => `${w.path} (${w.branch ?? "detached"}${w.dirty ? `, ${w.dirty} uncommitted` : ""})`).join("; ")}. Remove each yourself once its work is merged (\`git -C ${app.repoPath} worktree remove <path>\`), or ask the human first if it holds work you cannot place.`;
  }
  if (!branch) throw new HelmError(`${app.name} has no integration branch yet.`, "bad_state");
  // 1. nothing may be lost: every extra worktree clean and merged
  const problems: string[] = [];
  for (const m of moving) {
    if (!m.path) continue;
    const st = await host.status({ path: m.path }).catch(() => null);
    if (!st) continue; // already gone from disk
    const dirty = st.dirty.filter((p) => !p.startsWith("reports/checks/"));
    if (dirty.length) problems.push(`${e.label(m.n)} (${m.n.id}): ${dirty.length} uncommitted file(s) in ${m.path}: ${dirty.slice(0, 6).join(", ")}${dirty.length > 6 ? " …" : ""}. Have them committed (code) or copied into the shared worktree's same paths (untracked reports), then try again.`);
    if (st.head) {
      const merged = await host.isAncestor({ repo: app.repoPath, ancestor: st.head, descendant: branch }).then((r) => r.ok, () => false);
      if (!merged) problems.push(`${e.label(m.n)} (${m.n.id}): ${st.branch ?? "its branch"} @ ${st.head.slice(0, 9)} is not on the integration branch ${branch}. Merge it first (the app lead, or you: \`git -C <the integration branch's worktree> merge ${st.head.slice(0, 12)}\`), then try again.`);
    }
  }
  // the integration branch's last commit: if removing a BB worktree also removes its branch (in
  // older apps the lead's worktree holds the integration branch), it is recreated right there
  const keep = (await host.revParse({ repo: app.repoPath, ref: `refs/heads/${branch}` }).catch(() => ({ sha: null }))).sha;
  if (!keep) problems.push(`The integration branch ${branch} does not exist in ${app.repoPath}.`);
  if (problems.length) return `Rejected: ${app.name} cannot be consolidated yet; nothing was changed.\n${problems.map((p) => `- ${p}`).join("\n")}`;

  // 2. stop the agents' threads (their work is safe on the integration branch) and remove the extra worktrees
  const wasLive = new Set(moving.filter((m) => m.n.threadId && !["done", "planned"].includes(m.n.status)).map((m) => m.n.id));
  const threads = moving.map((m) => m.n.threadId).filter((t): t is string => !!t);
  e.repo.tx(() => {
    e.repo.setMeta(consolidatingKey(runId, appId), keep!);
    for (const m of moving) {
      e.repo.updateNode(runId, m.n.id, { threadId: null, environmentId: null, branch: null, ...(m.n.status === "done" ? {} : { status: "planned", warning: "moving to the app's shared work worktree" }) });
      e.repo.deleteMeta(`reuse:${runId}:${m.n.id}`);
      if (wasLive.has(m.n.id)) e.repo.setMeta(`moved:${runId}:${m.n.id}`, "1");
    }
  });
  for (const t of threads) {
    e.archiving.add(t);
    await e.port.archiveThread(t).catch(() => undefined);
  }
  const left: string[] = [];
  for (const envId of [...new Set(moving.map((m) => m.envId))]) {
    try {
      await e.port.deleteEnvironment(envId);
    } catch (err) {
      left.push(`${envId}: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
    }
  }

  // 3. the shared worktree on the integration branch, then the agents start again there
  return finish(e, run, app as AppInfo, branch, by, `Removed ${moving.length - left.length} agent worktree(s)${left.length ? `; could not remove ${left.join("; ")}` : ""}. `);
}

/** Set while an app moves to its shared worktree, so its agents wait instead of getting their own. Value: the integration branch's last commit. */
export const consolidatingKey = (runId: string, appId: string) => `consolidating:${runId}:${appId}`;

/**
 * Create the shared worktree and start the moved agents there. Also resumes a consolidation that
 * stopped half-way. BB removes worktrees in the background, so the integration branch can still be
 * held by the old lead worktree for a while: then the agents are queued anyway and the worktree is
 * created by their spawn as soon as BB is done.
 */
async function finish(e: Engine, run: ReturnType<Engine["run"]>, app: AppInfo, branch: string, by: string, removed: string): Promise<string> {
  const runId = run.id;
  const key = consolidatingKey(runId, app.id);
  const keep = e.repo.getMeta(key) ?? (await e.host(runId).revParse({ repo: app.repoPath!, ref: `refs/heads/${branch}` }).catch(() => ({ sha: null }))).sha;
  if (!keep) return `Rejected: the integration branch ${branch} does not exist in ${app.repoPath}. ${removed}`;
  if (!e.repo.getMeta(key)) e.repo.setMeta(key, keep);
  const waiting = e.repo.listNodes(runId).filter((n) => (n.appId === app.id || (n.alsoLead && e.repo.listApps(runId)[0]?.id === app.id)) && !n.threadId && n.status !== "done" && e.repo.getMeta(`moved:${runId}:${n.id}`));
  const ids = waiting.map((n) => n.id).join(", ") || "none";
  let path: string;
  try {
    path = await e.ensureWorkTree(run, app, keep);
  } catch (err) {
    const why = err instanceof Error ? err.message.slice(0, 200) : String(err);
    const busy = /checked out in/.test(why);
    e.repo.tx(() => {
      for (const n of waiting) e.repo.updateNode(runId, n.id, busy ? { status: "queued", firstInLine: true, warning: "waiting for BB to finish removing the old worktrees" } : { status: "idle", warning: `waiting for the shared work worktree: ${why}` });
    });
    if (busy) {
      await e.pump(runId);
      return `${app.name} is moving to one shared worktree on ${branch}. ${removed}BB is still removing the old worktrees (${why}); the shared worktree is created as soon as it is done, and ${waiting.length} agent(s) start there with a hand-over: ${ids}.`;
    }
    return `Rejected: ${removed}but the shared work worktree could not be created: ${why}. ${app.name}'s agents are stopped; fix that and consolidate again.`;
  }
  e.repo.tx(() => {
    e.repo.deleteMeta(key);
    for (const n of waiting) e.repo.updateNode(runId, n.id, { status: "queued", firstInLine: true, warning: null });
    e.repo.event(runId, e.leadOf(runId, app.id)?.id ?? by, "worktrees", `${app.name}: consolidated into ${path} by ${by}. ${removed}`.trim());
  });
  await e.pump(runId);
  return `${app.name} now works in one shared worktree: ${path} on ${branch}. ${removed}${waiting.length} agent(s) start again there with a hand-over: ${ids}.`;
}
