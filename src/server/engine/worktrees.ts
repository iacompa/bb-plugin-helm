// The worktree rule. Every app has the human's checkout and one shared work worktree beside it on
// the same disk, where all of the app's agents work on its work branch; the Git agent may add
// lanes (`.helm-work/<repo>--<lane>`) for parallel work, up to the run's worktree limit (default
// 10), and lane branches (`<work branch>--<lane>`) up to the run's branch limit (default 2: main
// and the work branch only). This module reports each app's worktrees, alerts
// the Git agent when an app is over the limit, still uses one worktree per agent, has leftover
// agent branches, or its disk runs low, and consolidates an app that still uses one worktree per
// agent (apps started before the rule): once every extra worktree's work is committed and on the
// work branch, its agents move into the shared worktree and the extra worktrees are removed.

import type { AppInfo, NodeInfo } from "../../shared/types.ts";
import type { Engine } from "./engine.ts";
import { HelmError, gitLimitsKey } from "./engine.ts";
import { GIT_ID } from "./custom.ts";

/** The checkout and the shared work worktree: what every app has. */
export const MAX_WORKTREES = 2;
/** The most worktrees an app may have (the run's limit, else the setting; 2 to 32). */
export const worktreeCap = (e: Engine, runId: string) => e.gitLimits(runId).worktrees;
/** The most branches an app may have (the run's limit, else the setting; 2 to 12). */
export const branchCap = (e: Engine, runId: string) => e.gitLimits(runId).branches;
/** Below this much free space on an app's disk the Git agent is told (or below 10% of the disk). */
const LOW_DISK = 15e9;
/** How often the watchdog looks at a run's worktrees. */
const AUDIT_EVERY_MS = 30 * 60_000;

export interface WorktreeRow {
  path: string;
  branch: string | null;
  head: string | null;
  dirty: number;
  missing: boolean;
  /** git status failed (a timeout on a big folder): `dirty` is unknown, not zero. */
  statusUnknown?: boolean;
  /** checkout (the human's) · work (the shared one) · lane (one the Git agent added beside it) · extra (anything else). */
  role: "checkout" | "work" | "lane" | "extra";
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
  /** How many worktrees beyond the limit (the "worktrees per project" setting). */
  extra: number;
  /** The limit it was measured against. */
  cap: number;
  /** The run's branch limit, and how many of Helm's branches (main, work, lanes, agent branches) are beyond it. */
  branchCap: number;
  overBranches: number;
  /** Branches the Git agent added for parallel work (`<work branch>--<lane>`), within the branch limit. */
  laneBranches: string[];
  /** The main branch's name (the human's). */
  mainBranch: string;
  /** One worktree per agent and no shared work worktree (an app started before the rule). */
  legacy: boolean;
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
    const cap = worktreeCap(e, runId);
    const bCap = branchCap(e, runId);
    const mainBranch = app.userBranch ?? "main";
    const row: AppWorktrees = { appId: app.id, name: app.name, repo: app.repoPath, work, branch, worktrees: [], extra: 0, cap, branchCap: bCap, overBranches: 0, laneBranches: [], mainBranch, legacy: false, extraBranches: [], otherBranches: [], error: null };
    out.push(row);
    if (!app.repoPath) continue;
    try {
      const res = await e.host(runId).worktrees({ repo: app.repoPath, status: opts.status ?? true });
      const who = opts.status === false ? new Map<string, string[]>() : await agentsByPath(e, nodes.filter((n) => n.appId === app.id || (n.alsoLead && apps[0]?.id === app.id)));
      const lanePrefix = work ? `${work}--` : null;
      row.worktrees = res.worktrees.map((w) => ({ path: w.path, branch: w.branch, head: w.head, dirty: w.dirty, missing: w.missing, ...(w.statusUnknown ? { statusUnknown: true } : {}), role: w.main ? "checkout" : w.path === work ? "work" : lanePrefix && w.path.startsWith(lanePrefix) ? "lane" : "extra", agents: who.get(w.path) ?? [] }));
      row.extra = Math.max(0, row.worktrees.length - cap);
      row.legacy = !work && row.worktrees.length > MAX_WORKTREES;
      const all = res.branches ?? [];
      const keep = new Set([branch, mainBranch, "main", "master"].filter(Boolean));
      const rest = all.filter((b) => !keep.has(b));
      row.laneBranches = branch ? rest.filter((b) => b.startsWith(`${branch}--`)) : [];
      row.extraBranches = rest.filter((b) => !row.laneBranches.includes(b) && AGENT_BRANCH.test(b));
      row.otherBranches = rest.filter((b) => !row.laneBranches.includes(b) && !AGENT_BRANCH.test(b));
      // Helm's branches: main, the work branch, lanes, agent branches (the human's own are not counted)
      const helm = (all.includes(mainBranch) ? 1 : 0) + (branch && branch !== mainBranch && all.includes(branch) ? 1 : 0) + row.laneBranches.length + row.extraBranches.length;
      row.overBranches = Math.max(0, helm - bCap);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      row.error = (/missing/.test(msg) ? msg : msg.replace(/:\s*$/, "") || "git could not read it").slice(0, 300);
    }
  }
  return out;
}

/** The report the Git agent and the CLI read. */
export function worktreesText(list: AppWorktrees[]): string {
  if (!list.length) return "No apps with repositories yet.";
  const over = list.filter((a) => a.extra > 0);
  const legacy = list.filter((a) => a.legacy && !a.extra);
  const branchy = list.filter((a) => a.extraBranches.length);
  const cap = list[0]?.cap ?? MAX_WORKTREES;
  const bCap = list[0]?.branchCap ?? 2;
  const lines = [
    over.length ? `${over.length} app(s) have more than ${cap} worktrees (the limit per project): ${over.map((a) => `${a.name} (${a.worktrees.length})`).join(", ")}.` : `Every app is within the limit of ${cap} worktrees per project.`,
    `This run's limits: at most ${bCap} branches and ${cap} worktrees per project (the human sets them in the Worktrees view).`,
    ...(legacy.length ? [`${legacy.length} app(s) still use one worktree per agent (consolidate them onto the shared work worktree): ${legacy.map((a) => a.name).join(", ")}.`] : []),
    branchy.length ? `${branchy.length} app(s) have agent branches besides main, the work branch and your lanes: ${branchy.map((a) => `${a.name} (${a.extraBranches.length})`).join(", ")}.` : "No agent branches besides main and the work branches.",
  ];
  for (const a of list) {
    lines.push(`\n${a.name} (${a.appId}): ${a.repo ?? "no repository yet"} · work branch ${a.branch ?? "not yet"}${a.work ? "" : a.repo ? " · no shared work worktree yet (one worktree per agent until consolidated)" : ""}`);
    if (a.error) lines.push(`  could not list worktrees: ${a.error}`);
    for (const w of a.worktrees) lines.push(`  - ${w.role.padEnd(8)} ${w.path} · ${w.branch ?? "detached"} @ ${w.head?.slice(0, 9) ?? "?"}${w.missing ? " · MISSING on disk (git worktree prune)" : w.statusUnknown ? " · status unknown (git status failed; check it before removing anything)" : w.dirty ? ` · ${w.dirty} uncommitted` : " · clean"}${w.agents.length ? ` · agents: ${w.agents.join(", ")}` : ""}`);
    if (a.laneBranches.length) lines.push(`  lane branches (yours, within the limit of ${a.branchCap}): ${a.laneBranches.join(", ")}`);
    if (a.overBranches > 0) lines.push(`  ${a.overBranches} branch(es) over the limit of ${a.branchCap}`);
    if (a.extraBranches.length) lines.push(`  agent branches to remove once merged into the work branch (git branch -d, never -D): ${a.extraBranches.slice(0, 30).join(", ")}${a.extraBranches.length > 30 ? " …" : ""}`);
    if (a.otherBranches.length) lines.push(`  other branches (the human's; leave them): ${a.otherBranches.slice(0, 20).join(", ")}${a.otherBranches.length > 20 ? " …" : ""}`);
  }
  return lines.join("\n");
}

/**
 * Watchdog: wake the Git agent when an app is over the worktree limit, still uses one worktree per
 * agent, has leftover agent branches, or its disk runs low. At most every 30 minutes per run, and
 * once per distinct situation (low disk: once a day per disk).
 */
export async function auditWorktrees(e: Engine, runId: string): Promise<string[]> {
  const git = e.repo.getNode(runId, GIT_ID);
  if (!git?.threadId) return [];
  const last = Number(e.repo.getMeta(`wt-audit-at:${runId}`) ?? 0);
  if (e.now() - last < AUDIT_EVERY_MS) return [];
  e.repo.setMeta(`wt-audit-at:${runId}`, String(e.now()));
  const list = await appWorktrees(e, runId, { status: false });
  await lowDiskCheck(e, runId, list);
  const over = list.filter((a) => a.extra > 0 || a.legacy || a.extraBranches.length > 0 || a.overBranches > 0);
  const sig = over.map((a) => `${a.appId}:${a.worktrees.length}:${a.extraBranches.length}:${a.overBranches}`).join(",");
  if (!over.length || e.repo.getMeta(`wt-alert:${runId}`) === sig) return over.map((a) => a.appId);
  e.repo.setMeta(`wt-alert:${runId}`, sig);
  const what = (a: AppWorktrees) =>
    [
      a.extra > 0 ? `${a.name} has ${a.worktrees.length} worktrees (limit ${a.cap})` : a.legacy ? `${a.name} has ${a.worktrees.length} worktrees, one per agent, and no shared work worktree` : null,
      a.extraBranches.length ? `${a.name} has ${a.extraBranches.length} agent branch(es) besides main and ${a.branch ?? "its work branch"}` : a.overBranches > 0 ? `${a.name} has ${a.overBranches} branch(es) over the limit of ${a.branchCap}` : null,
    ]
      .filter(Boolean)
      .join("; ");
  e.sendFromHelm(runId, GIT_ID, `Helm worktree check: ${over.map(what).join("; ")} (this run's rule: ${branchCap(e, runId) <= 2 ? "two branches, main and the work branch" : `at most ${branchCap(e, runId)} branches, main, the work branch and lane branches you made`}; worktrees: the checkout, the shared work worktree and any lanes you made, at most ${worktreeCap(e, runId)} per project). Call helm_worktrees, then: helm_consolidate an app that uses one worktree per agent once that work is committed and on the work branch; remove lanes that are merged and idle to get under the limit; \`git branch -d\` agent branches already merged into the work branch. Your instructions on git are binding on every agent. Tell the human what you did.`, { key: `wt-alert:${runId}:${sig}` });
  return over.map((a) => a.appId);
}

/** Tell the Git agent once a day per disk when an app's disk is low on space (free space only; nothing is measured). */
async function lowDiskCheck(e: Engine, runId: string, list: AppWorktrees[]): Promise<void> {
  const paths = list.map((a) => a.repo).filter((p): p is string => !!p);
  if (!paths.length) return;
  const r = await e.host(runId).diskUsage({ paths: paths.slice(0, 40), measure: false }).catch(() => null);
  const day = Math.floor(e.now() / 86_400_000);
  const seen = new Set<number>();
  for (const s of r?.sizes ?? []) {
    if (s.free === null || s.total === null || s.dev === null || seen.has(s.dev)) continue;
    seen.add(s.dev);
    if (s.free >= LOW_DISK && s.free >= s.total * 0.1) continue;
    const apps = list.filter((a) => a.repo && r!.sizes.find((x) => x.path === a.repo)?.dev === s.dev).map((a) => a.name);
    e.sendFromHelm(runId, GIT_ID, `Helm disk check: only ${gb(s.free)} free of ${gb(s.total)} on the disk holding ${apps.join(", ")}. Call helm_worktrees with sizes: true to see what each worktree takes, then free space without losing work: remove merged, idle lanes and extra worktrees (\`git worktree remove\`, never --force), consolidate apps that use one worktree per agent, \`git worktree prune\`. Build folders inside worktrees (build/, DerivedData, node_modules) are the agents': ask the app's lead before deleting them. Tell the human what you freed and what is left.`, { key: `disk-alert:${runId}:${s.dev}:${day}` });
  }
}

/**
 * The human sets a run's git limits (the Worktrees view): the most branches and worktrees per
 * project. `null` for both goes back to the settings. The Git agent is told; every agent started
 * after this gets the new limits in its brief.
 */
export function setGitLimits(e: Engine, runId: string, input: { branches?: number | null; worktrees?: number | null }): { branches: number; worktrees: number; own: boolean } {
  e.run(runId);
  const before = e.gitLimits(runId);
  let cur: { branches?: number; worktrees?: number } = {};
  try {
    cur = JSON.parse(e.repo.getMeta(gitLimitsKey(runId)) ?? "{}") ?? {};
  } catch {}
  if (input.branches !== undefined) cur.branches = input.branches === null ? undefined : input.branches;
  if (input.worktrees !== undefined) cur.worktrees = input.worktrees === null ? undefined : input.worktrees;
  if (cur.branches === undefined && cur.worktrees === undefined) e.repo.deleteMeta(gitLimitsKey(runId));
  else e.repo.setMeta(gitLimitsKey(runId), JSON.stringify(cur));
  const after = e.gitLimits(runId);
  if (after.branches !== before.branches || after.worktrees !== before.worktrees) {
    e.repo.event(runId, GIT_ID, "worktrees", `The human set this run's git limits: ${after.branches} branches and ${after.worktrees} worktrees per project.`);
    if (e.repo.getNode(runId, GIT_ID)?.threadId)
      e.sendFromHelm(runId, GIT_ID, `Git rule from the human: from now on each project of this run may have at most ${after.branches} branches (${after.branches <= 2 ? "main and its work branch only" : `main, its work branch and up to ${after.branches - 2} lane branches \`<work branch>--<lane>\` that only you create when the lead or the Orchestrator asks for parallel work`}) and at most ${after.worktrees} worktrees. Call helm_worktrees and bring any project over a limit back within it without losing work; tell the agents concerned. Agents started from now on have these limits in their briefs.`, { key: `git-limits:${runId}:${after.branches}:${after.worktrees}:${e.now()}` });
    e.repo.deleteMeta(`wt-alert:${runId}`);
  }
  return after;
}

export const gb = (n: number | null) => (n === null ? "?" : n >= 1e9 ? `${(n / 1e9).toFixed(n >= 100e9 ? 0 : 1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

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
    const st = await host.status({ path: m.path }).catch((err: unknown) => ({ error: err instanceof Error ? err.message.slice(0, 200) : String(err) }) as const);
    if ("missing" in st && st.missing) continue; // already gone from disk
    // a status git could not read is unknown, never clean: nothing is removed on a guess
    if ("error" in st && st.error) {
      problems.push(`${e.label(m.n)} (${m.n.id}): could not read ${m.path} (${st.error}). Check it by hand (\`git -C ${m.path} status\`), then try again.`);
      continue;
    }
    if (!("dirty" in st)) continue;
    const dirty = st.dirty.filter((p) => !p.startsWith("reports/checks/"));
    const more = (st.dirtyCount ?? st.dirty.length) - st.dirty.length;
    if (dirty.length) problems.push(`${e.label(m.n)} (${m.n.id}): ${dirty.length + more} uncommitted file(s) in ${m.path}: ${dirty.slice(0, 6).join(", ")}${dirty.length > 6 || more ? " …" : ""}. Have them committed (code) or copied into the shared worktree's same paths (untracked reports), then try again.`);
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
