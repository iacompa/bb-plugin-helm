// "Let me see it": what a decision in the Needs list is about, read live from git so the human
// can check it before answering. The app's checkout and work worktree (branch, commit, the
// uncommitted files), every other worktree of its repository, and each commit the decision
// names (what it is, and whether it is on the work branch or main). Read-only.

import type { Engine } from "./engine/engine.ts";
import { HelmError } from "./engine/engine.ts";
import { appWorktrees } from "./engine/worktrees.ts";

export interface LookPlace {
  role: "checkout" | "work" | "extra";
  path: string;
  branch: string | null;
  head: string | null;
  missing: boolean;
  /** Uncommitted files (at most 40), when there are any. */
  dirty: string[];
  dirtyCount: number;
  agents: string[];
  /** The decision names this folder or its commit. */
  named: boolean;
}

export interface LookCommit {
  ref: string;
  sha: string | null;
  subject: string | null;
  ts: number | null;
  onWork: boolean | null;
  onMain: boolean | null;
}

export interface NeedLook {
  app: { id: string; name: string; platforms: string[] } | null;
  repo: string | null;
  workBranch: string | null;
  mainBranch: string;
  places: LookPlace[];
  commits: LookCommit[];
  error: string | null;
}

/** Short or full commit ids in the text: 7 to 40 hex characters with at least one digit and one letter. */
export function commitRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b[0-9a-f]{7,40}\b/gi)) {
    const t = m[0].toLowerCase();
    if (/\d/.test(t) && /[a-f]/.test(t) && !out.some((x) => x.startsWith(t) || t.startsWith(x))) out.push(t);
  }
  return out.slice(0, 8);
}

export async function needLook(e: Engine, runId: string, needId: string): Promise<NeedLook> {
  const need = e.repo.getNeed(runId, needId);
  if (!need) throw new HelmError(`No need ${needId} in this run.`, "not_found");
  const appId = need.appId ?? (need.nodeId ? e.repo.getNode(runId, need.nodeId)?.appId : null) ?? null;
  const app = appId ? e.repo.getApp(runId, appId) : null;
  const text = `${need.title}\n${need.body}\n${need.evidence}`;
  const out: NeedLook = { app: app ? { id: app.id, name: app.name, platforms: app.platforms } : null, repo: app?.repoPath ?? null, workBranch: null, mainBranch: app?.userBranch ?? "main", places: [], commits: [], error: null };
  if (!app?.repoPath) return out;
  const host = e.host(runId);
  const refs = commitRefs(text);
  try {
    const [row] = await appWorktrees(e, runId, { appId: app.id, status: true });
    out.workBranch = row?.branch ?? null;
    if (row?.error) out.error = row.error;
    for (const w of row?.worktrees ?? []) {
      const tail = w.path.split("/").filter(Boolean).slice(-2).join("/");
      const named = text.includes(w.path) || (!!tail && text.includes(tail)) || (!!w.head && refs.some((r) => w.head!.startsWith(r)));
      out.places.push({ role: w.role, path: w.path, branch: w.branch, head: w.head, missing: w.missing, dirty: [], dirtyCount: w.dirty, agents: w.agents, named });
    }
    // the files themselves for the checkout, the work worktree and whatever the decision names
    for (const p of out.places.filter((x) => x.dirtyCount > 0 && !x.missing && (x.role !== "extra" || x.named)).slice(0, 4)) {
      const st = await host.status({ path: p.path }).catch(() => null);
      if (st) p.dirty = st.dirty.slice(0, 40);
    }
    out.places.sort((a, b) => Number(b.named) - Number(a.named) || order(a.role) - order(b.role));
  } catch (err) {
    out.error = err instanceof Error ? err.message.slice(0, 200) : String(err);
  }
  for (const ref of refs) {
    const sha = (await host.revParse({ repo: app.repoPath, ref }).catch(() => ({ sha: null }))).sha;
    if (!sha) {
      out.commits.push({ ref, sha: null, subject: null, ts: null, onWork: null, onMain: null });
      continue;
    }
    const c = (await host.log({ repo: app.repoPath, ref: sha, limit: 1 }).catch(() => ({ commits: [] }))).commits[0];
    const on = (branch: string | null) => (branch ? host.isAncestor({ repo: app.repoPath!, ancestor: sha, descendant: branch }).then((r) => r.ok).catch(() => null) : Promise.resolve(null));
    out.commits.push({ ref, sha, subject: c?.subject ?? null, ts: c?.ts ?? null, onWork: await on(out.workBranch), onMain: await on(out.mainBranch) });
  }
  return out;
}

function order(role: LookPlace["role"]): number {
  return role === "checkout" ? 0 : role === "work" ? 1 : 2;
}
