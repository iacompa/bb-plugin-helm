// The GitHub view, beside Worktrees: for every app of a run, what its remote (GitHub, or any other)
// has and what it does not, without downloading anything. The host asks the remote only for its
// branch names and commits (`git ls-remote`) and counts commits locally.
//
// It reaches the network, so it is read only when the human asks: when the GitHub tab opens and
// what Helm kept is older than 15 minutes, or with Check GitHub. Never by the watchdog.

import type { Engine } from "./engine/engine.ts";
import type { RemoteStatus } from "../host/remote.ts";
import { worktreesViewFor } from "./worktree-view.ts";

const OPEN_STALE_MS = 15 * 60_000;
const AGENT_STALE_MS = 5 * 60_000;

export type GhKind = "main" | "work" | "agent" | "other";

export interface GhBranch {
  name: string;
  kind: GhKind;
  state: RemoteStatus["branches"][number]["state"];
  local: string | null;
  remote: string | null;
  ahead: number | null;
  behind: number | null;
  at: number | null;
}

export interface GhApp {
  appId: string;
  name: string;
  repo: string | null;
  remote: string | null;
  url: string | null;
  web: string | null;
  defaultBranch: string | null;
  error: string | null;
  /** Uncommitted files in its worktrees (from the Worktrees view): on no branch, so on no remote. */
  uncommitted: number;
  branches: GhBranch[];
  counts: {
    /** The same commit here and on the remote. */
    synced: number;
    /** Branches with commits the remote does not have, and how many commits. */
    toPush: number;
    commitsToPush: number;
    /** Branches only here whose commits are all on the remote already (nothing would be lost). */
    safeHere: number;
    /** Branches only on the remote. */
    onlyRemote: number;
    /** Branches the remote has newer commits on. */
    newer: number;
  };
}

export interface GhView {
  apps: GhApp[];
  checkedAt: number | null;
  checking: boolean;
  problem: string | null;
  totals: { apps: number; onRemote: number; noRemote: number; toPush: number; commitsToPush: number; newer: number };
}

interface Snap {
  at: number;
  statuses: Record<string, RemoteStatus | { error: string }>;
}

const key = (runId: string) => `gh-view:${runId}`;
const AGENT_BRANCH = /^(bb|helm)\//;

export class GithubView {
  private snaps = new Map<string, Snap>();
  private checking = new Map<string, Promise<Snap>>();

  constructor(private readonly e: Engine) {}

  /** At once, from what is kept; `open` reads the remotes again when older than 15 minutes, `now` always. */
  view(runId: string, opts: { refresh?: "open" | "now" } = {}): GhView {
    const snap = this.snap(runId);
    if (opts.refresh === "now" || (opts.refresh === "open" && (!snap || this.e.now() - snap.at > OPEN_STALE_MS))) void this.refresh(runId).catch(() => {});
    return this.build(runId, this.snap(runId));
  }

  /** Read now (or reuse a read from the last five minutes) and wait: the Git agent's helm_worktrees with github. */
  async viewAndWait(runId: string): Promise<GhView> {
    const snap = this.snap(runId);
    if (!snap || this.e.now() - snap.at > AGENT_STALE_MS) await this.refresh(runId);
    return this.build(runId, this.snap(runId));
  }

  private refresh(runId: string): Promise<Snap> {
    const running = this.checking.get(runId);
    if (running) return running;
    const p = (async () => {
      const apps = this.e.repo.listApps(runId).filter((a) => a.stage !== "cancelled" && a.repoPath);
      const statuses: Snap["statuses"] = {};
      let i = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, apps.length) }, async () => {
          while (i < apps.length) {
            const a = apps[i++];
            statuses[a.id] = await this.e
              .host(runId)
              .remoteStatus({ repo: a.repoPath! })
              .catch((err: unknown) => ({ error: err instanceof Error ? err.message.slice(0, 200) : String(err) }));
          }
        }),
      );
      const snap: Snap = { at: this.e.now(), statuses };
      this.snaps.set(runId, snap);
      this.e.repo.setMeta(key(runId), JSON.stringify(snap));
      return snap;
    })().finally(() => this.checking.delete(runId));
    this.checking.set(runId, p);
    return p;
  }

  private snap(runId: string): Snap | null {
    const hit = this.snaps.get(runId);
    if (hit) return hit;
    const raw = this.e.repo.getMeta(key(runId));
    if (!raw) return null;
    try {
      const s = JSON.parse(raw) as Snap;
      this.snaps.set(runId, s);
      return s;
    } catch {
      return null;
    }
  }

  private build(runId: string, snap: Snap | null): GhView {
    const dirty = worktreesViewFor(this.e).uncommitted(runId);
    const apps: GhApp[] = this.e.repo
      .listApps(runId)
      .filter((a) => a.stage !== "cancelled")
      .map((a) => {
        const st = snap?.statuses[a.id];
        const full = st && "branches" in st ? st : null;
        const mainBranch = a.userBranch ?? "main";
        const work = this.e.repo.appExtra(runId, a.id).integrationBranch;
        const kind = (n: string): GhKind => (n === mainBranch || n === full?.defaultBranch ? "main" : n === work ? "work" : AGENT_BRANCH.test(n) ? "agent" : "other");
        const order: Record<GhKind, number> = { main: 0, work: 1, other: 2, agent: 3 };
        const branches: GhBranch[] = (full?.branches ?? []).map((b) => ({ ...b, kind: kind(b.name) })).sort((x, y) => order[x.kind] - order[y.kind] || x.name.localeCompare(y.name));
        const pushable = branches.filter((b) => (b.state === "ahead" || b.state === "diverged" || b.state === "local") && (b.ahead === null || b.ahead > 0));
        return {
          appId: a.id,
          name: a.name,
          repo: a.repoPath,
          remote: full?.remote ?? null,
          url: full?.url ?? null,
          web: full?.web ?? null,
          defaultBranch: full?.defaultBranch ?? null,
          error: st ? (full ? full.error : (st as { error: string }).error) : null,
          uncommitted: dirty.get(a.id) ?? 0,
          branches,
          counts: {
            synced: branches.filter((b) => b.state === "synced").length,
            toPush: pushable.length,
            commitsToPush: pushable.reduce((n, b) => n + (b.ahead ?? 0), 0),
            safeHere: branches.filter((b) => b.state === "local" && b.ahead === 0).length,
            onlyRemote: branches.filter((b) => b.state === "remote").length,
            newer: branches.filter((b) => b.state === "behind" || b.state === "newer" || b.state === "diverged").length,
          },
        };
      });
    const checked = apps.filter((a) => snap?.statuses[a.appId]);
    return {
      apps,
      checkedAt: snap?.at ?? null,
      checking: this.checking.has(runId),
      problem: null,
      totals: {
        apps: apps.length,
        onRemote: checked.filter((a) => a.remote && !a.error).length,
        noRemote: checked.filter((a) => a.repo && !a.remote && !a.error).length,
        toPush: apps.reduce((n, a) => n + a.counts.toPush, 0),
        commitsToPush: apps.reduce((n, a) => n + a.counts.commitsToPush, 0),
        newer: apps.reduce((n, a) => n + a.counts.newer, 0),
      },
    };
  }
}

const views = new WeakMap<Engine, GithubView>();
export function githubViewFor(e: Engine): GithubView {
  let v = views.get(e);
  if (!v) views.set(e, (v = new GithubView(e)));
  return v;
}

/** The Git agent's text: per app, what is on its remote and what is not. */
export function githubText(v: GhView): string {
  const lines = [`Remotes read ${v.checkedAt ? "in the last few minutes" : "not yet"} (branch names and commits only; nothing downloaded) · ${v.totals.onRemote} app(s) with a remote, ${v.totals.noRemote} without · ${v.totals.toPush} branch(es) with ${v.totals.commitsToPush} commit(s) not on their remote · ${v.totals.newer} branch(es) newer on the remote`];
  for (const a of v.apps) {
    if (!a.repo) continue;
    lines.push(`\n${a.name}: ${a.error ? `could not read its remote: ${a.error}` : a.remote ? `${a.remote} ${a.url ?? ""}${a.defaultBranch ? ` (default branch ${a.defaultBranch})` : ""}` : "no remote: nothing of it is on GitHub"}${a.uncommitted ? ` · ${a.uncommitted} uncommitted file(s) in its worktrees` : ""}`);
    for (const b of a.branches) {
      const what =
        b.state === "synced" ? "same on both" : b.state === "ahead" ? `${b.ahead} commit(s) not on the remote` : b.state === "behind" ? `the remote has ${b.behind} newer commit(s)` : b.state === "diverged" ? `both changed: ${b.ahead} here, ${b.behind} there` : b.state === "newer" ? "the remote has commits this computer has never seen" : b.state === "local" ? (b.ahead === 0 ? "only here; its commits are all on the remote" : `only here: ${b.ahead ?? "some"} commit(s) on no remote branch`) : "only on the remote";
      lines.push(`  - ${b.kind.padEnd(5)} ${b.name} · ${what}`);
    }
  }
  return lines.join("\n");
}
