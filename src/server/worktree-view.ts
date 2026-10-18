// The Git agent's Worktrees view: every app of a run with its branches and worktrees, what each
// worktree is doing (agents running in it, being edited, idle), which disk it is on (an external
// SSD or the computer's own), and the space it all takes: each worktree's own files, the
// repository's shared git storage (every branch lives there; a branch without a worktree takes no
// space of its own), the app's total, and each disk's free space.
//
// Nothing waits on git: the view is kept (in memory and in the database) and shown at once. It is
// checked again in the background when the Worktrees view opens and it is older than a few
// minutes, by the watchdog every 30 minutes, and when the human presses Check now. Sizes, which
// take longer, are measured at most every 30 minutes on open and every two hours by the watchdog.

import type { Engine } from "./engine/engine.ts";
import { HelmError } from "./engine/engine.ts";
import { appWorktrees, gb, type AppWorktrees, type WorktreeRow } from "./engine/worktrees.ts";

/** Opening the view checks git again when what is kept is older than this. */
const OPEN_STALE_MS = 3 * 60_000;
/** The watchdog checks git again when what is kept is older than this. */
const WATCH_STALE_MS = 30 * 60_000;
/** Sizes are measured again on open when older than this, by the watchdog when older than SIZES_WATCH_MS. */
const SIZES_OPEN_MS = 30 * 60_000;
const SIZES_WATCH_MS = 2 * 60 * 60_000;
/** The Git agent's helm_worktrees with sizes reuses sizes this fresh. */
const SIZES_AGENT_MS = 10 * 60_000;

export type WtState = "running" | "editing" | "idle" | "missing";

export interface WtDisk {
  /** The disk's name: an external volume's ("Team SSD"), or "internal" for the computer's own. */
  name: string;
  external: boolean;
}

export interface WtViewRow {
  path: string;
  role: WorktreeRow["role"];
  branch: string | null;
  head: string | null;
  dirty: number;
  missing: boolean;
  agents: Array<{ id: string; label: string; status: string }>;
  state: WtState;
  disk: WtDisk;
  /** This worktree's own files (nested worktrees and the git storage not counted); null until measured. */
  bytes: number | null;
}

export interface WtViewBranch {
  name: string;
  kind: "main" | "work" | "lane" | "agent" | "other";
  /** The worktree that has it checked out, if any. */
  worktree: string | null;
}

export interface WtViewApp {
  appId: string;
  name: string;
  stage: string;
  repo: string | null;
  repoDisk: WtDisk | null;
  work: string | null;
  branch: string | null;
  mainBranch: string;
  worktrees: WtViewRow[];
  branches: WtViewBranch[];
  /** Branches beyond the run's limit (main, work, lanes and agent branches count; the human's own do not). */
  overBranches: number;
  /** The space on each disk the app uses (worktrees, and its git storage on the disk it is on). */
  where: Array<WtDisk & { bytes: number | null }>;
  /** The repository's git storage: objects and refs shared by every branch and worktree. */
  store: { path: string | null; bytes: number | null; sharedWith: string[] } | null;
  /** Worktrees plus git storage; null until measured. */
  total: number | null;
  extra: number;
  legacy: boolean;
  error: string | null;
}

export interface WtView {
  cap: number;
  branchCap: number;
  /** The run has its own limits (not the settings'). */
  ownLimits: boolean;
  apps: WtViewApp[];
  disks: Array<WtDisk & { free: number | null; total: number | null; apps: string[] }>;
  /** Everything together, git storage counted once per repository. */
  total: number | null;
  /** When git was last read (null: never yet). */
  checkedAt: number | null;
  measuredAt: number | null;
  /** Git is being read again in the background. */
  checking: boolean;
  measuring: boolean;
  /** The last background check failed. */
  problem: string | null;
}

interface Measured {
  at: number;
  sizes: Map<string, { bytes: number | null; dev: number | null; free: number | null; total: number | null }>;
  stores: Map<string, { gitDir: string | null; bytes: number | null }>;
}

interface Snap {
  at: number;
  list: AppWorktrees[];
  measured: Measured | null;
  problem: string | null;
}

const norm = (p: string) => p.replace(/[\\/]+$/, "");
const inside = (child: string, parent: string) => norm(child).startsWith(`${norm(parent)}/`);
const snapKey = (runId: string) => `wt-view:${runId}`;

/** Which disk a folder is on, from its path: an external volume's name, or the computer's own disk. */
export function diskOf(path: string): WtDisk {
  const mac = path.match(/^\/Volumes\/([^/]+)/);
  if (mac) return { name: mac[1], external: true };
  const linux = path.match(/^\/(?:run\/media\/[^/]+|media\/[^/]+|mnt)\/([^/]+)/);
  if (linux) return { name: linux[1], external: true };
  const win = path.match(/^([A-Za-z]):[\\/]/);
  if (win && win[1].toUpperCase() !== "C") return { name: `${win[1].toUpperCase()}: drive`, external: true };
  return { name: "internal", external: false };
}

export class WorktreesView {
  private snaps = new Map<string, Snap>();
  private checking = new Map<string, Promise<Snap>>();
  private measuring = new Set<string>();

  constructor(private readonly e: Engine) {}

  /**
   * The view at once, from what is kept. `refresh: "open"` checks again in the background when it is
   * older than a few minutes (and sizes when older than 30 minutes); `"now"` checks everything again.
   */
  view(runId: string, opts: { refresh?: "open" | "now" } = {}): WtView {
    const snap = this.snap(runId);
    const age = snap ? this.e.now() - snap.at : Infinity;
    const sizesAge = snap?.measured ? this.e.now() - snap.measured.at : Infinity;
    if (opts.refresh === "now") this.kick(runId, true);
    else if (opts.refresh === "open" && (age > OPEN_STALE_MS || sizesAge > SIZES_OPEN_MS)) this.kick(runId, sizesAge > SIZES_OPEN_MS);
    return this.build(runId, this.snap(runId));
  }

  /** The watchdog: git every 30 minutes, sizes every two hours. */
  async refreshIfStale(runId: string): Promise<void> {
    const snap = this.snap(runId);
    const age = snap ? this.e.now() - snap.at : Infinity;
    const sizesAge = snap?.measured ? this.e.now() - snap.measured.at : Infinity;
    if (age > WATCH_STALE_MS || sizesAge > SIZES_WATCH_MS) await this.refresh(runId, sizesAge > SIZES_WATCH_MS);
  }

  /** Read git and measure now, and wait (the Git agent's helm_worktrees with sizes). */
  async measureAndWait(runId: string): Promise<WtView> {
    const snap = this.snap(runId);
    if (!snap?.measured || this.e.now() - snap.measured.at > SIZES_AGENT_MS) await this.refresh(runId, true);
    return this.build(runId, this.snap(runId));
  }

  /** Uncommitted files per app from what is kept (nothing is read): work that is on no branch, so on no remote either. */
  uncommitted(runId: string): Map<string, number> {
    return new Map((this.snap(runId)?.list ?? []).map((a) => [a.appId, a.worktrees.reduce((n, w) => n + (w.missing ? 0 : w.dirty), 0)]));
  }

  /** Show a folder of this view in Finder (Explorer, the Files app). Only folders the view lists. */
  async reveal(runId: string, path: string): Promise<{ ok: boolean; shown: string | null }> {
    const snap = this.snap(runId);
    const known = new Set<string>();
    for (const a of snap?.list ?? []) {
      if (a.repo) known.add(norm(a.repo));
      if (a.work) known.add(norm(a.work));
      for (const w of a.worktrees) known.add(norm(w.path));
    }
    for (const s of snap?.measured?.stores.values() ?? []) if (s.gitDir) known.add(norm(s.gitDir));
    if (!known.has(norm(path))) throw new HelmError("That folder is not one of this run's worktrees.", "bad_request");
    return this.e.host(runId).reveal({ path });
  }

  private kick(runId: string, sizes: boolean): void {
    void this.refresh(runId, sizes).catch(() => {});
  }

  /** Read git (and with `sizes` measure) again; one at a time per run. */
  private refresh(runId: string, sizes: boolean): Promise<Snap> {
    const running = this.checking.get(runId);
    if (running) return running;
    const p = (async () => {
      const before = this.snap(runId);
      let snap: Snap;
      try {
        const list = await appWorktrees(this.e, runId, { status: true });
        snap = { at: this.e.now(), list, measured: before?.measured ?? null, problem: null };
      } catch (err) {
        snap = { at: before?.at ?? 0, list: before?.list ?? [], measured: before?.measured ?? null, problem: err instanceof Error ? err.message.slice(0, 200) : String(err) };
      }
      this.save(runId, snap);
      if (sizes && snap.list.length) {
        this.measuring.add(runId);
        try {
          snap = { ...snap, measured: await this.measure(runId, snap.list) };
          this.save(runId, snap);
        } catch (err) {
          snap = { ...snap, problem: `could not measure sizes: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}` };
          this.save(runId, snap);
        } finally {
          this.measuring.delete(runId);
        }
      }
      return snap;
    })().finally(() => this.checking.delete(runId));
    this.checking.set(runId, p);
    return p;
  }

  private async measure(runId: string, list: AppWorktrees[]): Promise<Measured> {
    const paths = [...new Set(list.flatMap((a) => a.worktrees.filter((w) => !w.missing).map((w) => norm(w.path))))].slice(0, 80);
    const repos = [...new Set(list.filter((a) => !a.error).map((a) => a.repo).filter((r): r is string => !!r))].slice(0, 40);
    const r = await this.e.host(runId).diskUsage({ paths, repos, measure: true });
    return { at: this.e.now(), sizes: new Map(r.sizes.map((s) => [norm(s.path), { bytes: s.bytes, dev: s.dev, free: s.free, total: s.total }])), stores: new Map(r.repos.map((s) => [s.repo, { gitDir: s.gitDir ? norm(s.gitDir) : null, bytes: s.bytes }])) };
  }

  /** What is kept for the run: in memory, else in the database (so a restart shows it at once). */
  private snap(runId: string): Snap | null {
    const hit = this.snaps.get(runId);
    if (hit) return hit;
    const raw = this.e.repo.getMeta(snapKey(runId));
    if (!raw) return null;
    try {
      const j = JSON.parse(raw) as { at: number; list: AppWorktrees[]; measured: { at: number; sizes: Array<[string, never]>; stores: Array<[string, never]> } | null; problem?: string | null };
      const snap: Snap = { at: j.at, list: j.list, measured: j.measured ? { at: j.measured.at, sizes: new Map(j.measured.sizes), stores: new Map(j.measured.stores) } : null, problem: j.problem ?? null };
      this.snaps.set(runId, snap);
      return snap;
    } catch {
      return null;
    }
  }

  private save(runId: string, snap: Snap): void {
    this.snaps.set(runId, snap);
    const m = snap.measured;
    this.e.repo.setMeta(snapKey(runId), JSON.stringify({ at: snap.at, list: snap.list, measured: m ? { at: m.at, sizes: [...m.sizes], stores: [...m.stores] } : null, problem: snap.problem }));
  }

  private build(runId: string, snap: Snap | null): WtView {
    const lim = this.e.gitLimits(runId);
    const nodes = new Map(this.e.repo.listNodes(runId).map((n) => [n.id, n]));
    const apps = this.e.repo.listApps(runId).filter((a) => a.stage !== "cancelled");
    const m = snap?.measured ?? null;
    // never read yet: the run's apps, with nothing known about them
    const list: AppWorktrees[] =
      snap?.list ??
      apps.map((a) => ({ appId: a.id, name: a.name, repo: a.repoPath, work: this.e.workTree(runId, a.id), branch: this.e.repo.appExtra(runId, a.id).integrationBranch, worktrees: [], extra: 0, cap: lim.worktrees, branchCap: lim.branches, overBranches: 0, laneBranches: [], mainBranch: a.userBranch ?? "main", legacy: false, extraBranches: [], otherBranches: [], error: null }));
    const storeOwners = new Map<string, string[]>();
    for (const a of list) {
      const g = a.repo ? m?.stores.get(a.repo)?.gitDir : null;
      if (g) storeOwners.set(g, [...(storeOwners.get(g) ?? []), a.name]);
    }
    const allPaths = [...(m?.sizes.keys() ?? [])];
    const own = (path: string, gitDir: string | null, storeBytes: number | null): number | null => {
      const b = m?.sizes.get(norm(path))?.bytes;
      if (b === null || b === undefined) return null;
      // subtract the worktrees nested in it (outermost only) and the git storage when it is inside
      const nested = allPaths.filter((p) => inside(p, path));
      const outer = nested.filter((p) => !nested.some((q) => q !== p && inside(p, q)));
      let n = b - outer.reduce((s, p) => s + (m!.sizes.get(p)?.bytes ?? 0), 0);
      if (gitDir && inside(gitDir, path)) n -= storeBytes ?? 0;
      return Math.max(0, n);
    };
    const out: WtViewApp[] = list.map((a) => {
      const info = apps.find((x) => x.id === a.appId);
      const mainBranch = a.mainBranch ?? info?.userBranch ?? "main";
      const store = a.repo && m ? m.stores.get(a.repo) ?? null : null;
      const worktrees: WtViewRow[] = a.worktrees.map((w) => {
        const agents = w.agents.map((id) => nodes.get(id)).filter((n): n is NonNullable<typeof n> => !!n).map((n) => ({ id: n.id, label: this.e.label(n), status: n.status }));
        const state: WtState = w.missing ? "missing" : agents.some((x) => x.status === "running") ? "running" : w.dirty > 0 ? "editing" : "idle";
        return { path: w.path, role: w.role, branch: w.branch, head: w.head, dirty: w.dirty, missing: w.missing, agents, state, disk: diskOf(w.path), bytes: m ? own(w.path, store?.gitDir ?? null, store?.bytes ?? null) : null };
      });
      const at = (b: string) => a.worktrees.find((w) => w.branch === b)?.path ?? null;
      const known = !a.error && a.repo && snap;
      const branches: WtViewBranch[] = !known
        ? []
        : [
            { name: mainBranch, kind: "main" as const, worktree: at(mainBranch) },
            ...(a.branch && a.branch !== mainBranch ? [{ name: a.branch, kind: "work" as const, worktree: at(a.branch) }] : []),
            ...(a.laneBranches ?? []).map((b) => ({ name: b, kind: "lane" as const, worktree: at(b) })),
            ...a.extraBranches.map((b) => ({ name: b, kind: "agent" as const, worktree: at(b) })),
            ...a.otherBranches.filter((b) => b !== mainBranch).map((b) => ({ name: b, kind: "other" as const, worktree: at(b) })),
          ];
      const sized = worktrees.every((w) => w.bytes !== null || w.missing);
      const total = m && a.repo && sized && worktrees.length ? worktrees.reduce((s, w) => s + (w.bytes ?? 0), 0) + (store?.bytes ?? 0) : null;
      // space per disk, the checkout's disk first
      const where = new Map<string, WtDisk & { bytes: number | null }>();
      const add = (d: WtDisk, bytes: number | null) => {
        const cur = where.get(d.name) ?? { ...d, bytes: 0 };
        cur.bytes = cur.bytes === null || bytes === null ? null : cur.bytes + bytes;
        where.set(d.name, cur);
      };
      if (a.repo) add(diskOf(a.repo), m ? store?.bytes ?? 0 : null);
      for (const w of worktrees) if (!w.missing) add(w.disk, w.bytes);
      return {
        appId: a.appId,
        name: a.name,
        stage: info?.stage ?? "",
        repo: a.repo,
        repoDisk: a.repo ? diskOf(a.repo) : null,
        work: a.work,
        branch: a.branch,
        mainBranch,
        worktrees,
        branches,
        // against the run's limit now (the human may have changed it since git was read)
        overBranches: Math.max(0, branches.filter((b) => b.kind !== "other").length - lim.branches),
        where: [...where.values()],
        store: a.repo && !a.error ? { path: store?.gitDir ?? null, bytes: store?.bytes ?? null, sharedWith: (store?.gitDir ? storeOwners.get(store.gitDir) ?? [] : []).filter((n) => n !== a.name) } : null,
        total,
        extra: a.extra,
        legacy: a.legacy,
        error: a.error,
      };
    });
    // disks: free space from the measured folders, every disk an app is on
    const disks = new Map<string, WtDisk & { free: number | null; total: number | null; apps: Set<string> }>();
    for (const a of out) {
      const places = [...(a.repo ? [{ path: a.repo, disk: a.repoDisk! }] : []), ...a.worktrees.filter((w) => !w.missing).map((w) => ({ path: w.path, disk: w.disk }))];
      for (const p of places) {
        const s = m?.sizes.get(norm(p.path));
        const d = disks.get(p.disk.name) ?? { ...p.disk, free: null, total: null, apps: new Set<string>() };
        if (s && s.free !== null && d.free === null) {
          d.free = s.free;
          d.total = s.total;
        }
        d.apps.add(a.name);
        disks.set(p.disk.name, d);
      }
    }
    const seenStores = new Set<string>();
    let total: number | null = m ? 0 : null;
    for (const a of out) {
      if (total === null) break;
      total += a.worktrees.reduce((s, w) => s + (w.bytes ?? 0), 0);
      if (a.store?.path && !seenStores.has(a.store.path)) {
        seenStores.add(a.store.path);
        total += a.store.bytes ?? 0;
      }
    }
    return {
      cap: lim.worktrees,
      branchCap: lim.branches,
      ownLimits: lim.own,
      apps: out,
      disks: [...disks.values()].sort((x, y) => Number(y.external) - Number(x.external)).map((d) => ({ ...d, apps: [...d.apps] })),
      total,
      checkedAt: snap?.at || null,
      measuredAt: m?.at ?? null,
      checking: this.checking.has(runId),
      measuring: this.measuring.has(runId),
      problem: snap?.problem ?? null,
    };
  }
}

const views = new WeakMap<Engine, WorktreesView>();
/** One view per engine, so the panel, the watchdog and the Git agent share what is kept. */
export function worktreesViewFor(e: Engine): WorktreesView {
  let v = views.get(e);
  if (!v) views.set(e, (v = new WorktreesView(e)));
  return v;
}

const diskLabel = (d: WtDisk) => (d.external ? d.name : "the computer's own disk");

/** The Git agent's text: worktrees with their state and sizes, each disk's free space. */
export function worktreeSizesText(v: WtView): string {
  const lines = [`Sizes measured ${v.measuredAt ? "in the last 10 minutes" : "not yet"} · this run's limits: ${v.branchCap} branches and ${v.cap} worktrees per project · everything: ${gb(v.total)}`];
  for (const d of v.disks) lines.push(`Disk ${diskLabel(d)} (${d.apps.join(", ")}): ${gb(d.free)} free of ${gb(d.total)}`);
  for (const a of v.apps) {
    lines.push(`\n${a.name}: ${a.branches.length} branches · ${gb(a.total)} in total${a.store ? ` (git storage ${gb(a.store.bytes)}${a.store.sharedWith.length ? `, shared with ${a.store.sharedWith.join(", ")}` : ""})` : ""} · on ${a.where.map((w) => `${diskLabel(w)} ${gb(w.bytes)}`).join(", ") || "no disk yet"}`);
    if (a.error) lines.push(`  problem: ${a.error}`);
    for (const w of a.worktrees) lines.push(`  - ${w.role.padEnd(8)} ${gb(w.bytes).padStart(7)} · ${w.state}${w.dirty ? ` (${w.dirty} uncommitted)` : ""} · ${w.branch ?? "detached"} · ${w.path}${w.agents.length ? ` · ${w.agents.map((x) => x.label).join(", ")}` : ""}`);
    const loose = a.branches.filter((b) => !b.worktree);
    if (loose.length) lines.push(`  branches without a worktree (no space of their own): ${loose.map((b) => b.name).join(", ")}`);
  }
  return lines.join("\n");
}
