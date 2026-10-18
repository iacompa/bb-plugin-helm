// The Git agent's Worktrees view: every app of a run with its worktrees and branches, what each
// worktree is doing (agents running in it, being edited, idle), and the disk space it all takes:
// each worktree's own files, the repository's shared git storage (every branch lives there; a
// branch without a worktree takes no space of its own), the app's total, and each disk's free
// space. Sizes are measured on the host in the background and kept for ten minutes.

import type { Engine } from "./engine/engine.ts";
import { appWorktrees, worktreeCap, gb, type AppWorktrees, type WorktreeRow } from "./engine/worktrees.ts";

const KEEP_MS = 10 * 60_000;

export type WtState = "running" | "editing" | "idle" | "missing";

export interface WtViewRow {
  path: string;
  role: WorktreeRow["role"];
  branch: string | null;
  head: string | null;
  dirty: number;
  missing: boolean;
  agents: Array<{ id: string; label: string; status: string }>;
  state: WtState;
  /** This worktree's own files (nested worktrees and the git storage not counted); null until measured. */
  bytes: number | null;
}

export interface WtViewBranch {
  name: string;
  kind: "main" | "work" | "agent" | "other";
  /** The worktree that has it checked out, if any. */
  worktree: string | null;
}

export interface WtViewApp {
  appId: string;
  name: string;
  stage: string;
  repo: string | null;
  work: string | null;
  branch: string | null;
  mainBranch: string;
  worktrees: WtViewRow[];
  branches: WtViewBranch[];
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
  apps: WtViewApp[];
  disks: Array<{ dev: number; free: number | null; total: number | null; apps: string[] }>;
  /** Everything together, git storage counted once per repository. */
  total: number | null;
  measuredAt: number | null;
  measuring: boolean;
}

interface Measured {
  at: number;
  sizes: Map<string, { bytes: number | null; dev: number | null; free: number | null; total: number | null }>;
  stores: Map<string, { gitDir: string | null; bytes: number | null }>;
}

const norm = (p: string) => p.replace(/[\\/]+$/, "");
const inside = (child: string, parent: string) => norm(child).startsWith(`${norm(parent)}/`);

export class WorktreesView {
  private measured = new Map<string, Measured>();
  private running = new Map<string, Promise<Measured>>();

  constructor(private readonly e: Engine) {}

  /** The view now; with `measure`, sizes are (re)measured in the background when older than ten minutes or `fresh`. */
  async view(runId: string, opts: { measure?: boolean; fresh?: boolean } = {}): Promise<WtView> {
    const list = await appWorktrees(this.e, runId, { status: true });
    const m = this.measured.get(runId) ?? null;
    if (opts.measure && !this.running.has(runId) && (opts.fresh || !m || this.e.now() - m.at > KEEP_MS)) void this.measure(runId, list).catch(() => {});
    return this.build(runId, list, m);
  }

  /** Measure now and wait (the Git agent's helm_worktrees with sizes). */
  async measureAndWait(runId: string): Promise<WtView> {
    const list = await appWorktrees(this.e, runId, { status: true });
    const m = this.measured.get(runId);
    const fresh = m && this.e.now() - m.at <= KEEP_MS ? m : await (this.running.get(runId) ?? this.measure(runId, list));
    return this.build(runId, list, fresh);
  }

  private measure(runId: string, list: AppWorktrees[]): Promise<Measured> {
    const paths = [...new Set(list.flatMap((a) => a.worktrees.filter((w) => !w.missing).map((w) => norm(w.path))))].slice(0, 80);
    const repos = [...new Set(list.map((a) => a.repo).filter((r): r is string => !!r))].slice(0, 40);
    const p = this.e
      .host(runId)
      .diskUsage({ paths, repos, measure: true })
      .then((r) => {
        const out: Measured = { at: this.e.now(), sizes: new Map(r.sizes.map((s) => [norm(s.path), { bytes: s.bytes, dev: s.dev, free: s.free, total: s.total }])), stores: new Map(r.repos.map((s) => [s.repo, { gitDir: s.gitDir ? norm(s.gitDir) : null, bytes: s.bytes }])) };
        this.measured.set(runId, out);
        return out;
      })
      .finally(() => this.running.delete(runId));
    this.running.set(runId, p);
    return p;
  }

  private build(runId: string, list: AppWorktrees[], m: Measured | null): WtView {
    const nodes = new Map(this.e.repo.listNodes(runId).map((n) => [n.id, n]));
    const apps = this.e.repo.listApps(runId);
    const storeOwners = new Map<string, string[]>();
    for (const a of list) {
      const g = a.repo ? m?.stores.get(a.repo)?.gitDir : null;
      if (g) storeOwners.set(g, [...(storeOwners.get(g) ?? []), a.name]);
    }
    const allPaths = [...(m?.sizes.keys() ?? [])];
    const own = (path: string, gitDir: string | null): number | null => {
      const b = m?.sizes.get(norm(path))?.bytes;
      if (b === null || b === undefined) return null;
      // subtract the worktrees nested in it (outermost only) and the git storage when it is inside
      const nested = allPaths.filter((p) => inside(p, path));
      const outer = nested.filter((p) => !nested.some((q) => q !== p && inside(p, q)));
      let n = b - outer.reduce((s, p) => s + (m!.sizes.get(p)?.bytes ?? 0), 0);
      if (gitDir && inside(gitDir, path)) n -= m?.stores.get(list.find((a) => a.repo && m?.stores.get(a.repo)?.gitDir === gitDir)?.repo ?? "")?.bytes ?? 0;
      return Math.max(0, n);
    };
    const out: WtViewApp[] = list.map((a) => {
      const info = apps.find((x) => x.id === a.appId);
      const mainBranch = info?.userBranch ?? "main";
      const store = a.repo && m ? m.stores.get(a.repo) ?? null : null;
      const worktrees: WtViewRow[] = a.worktrees.map((w) => {
        const agents = w.agents.map((id) => nodes.get(id)).filter((n): n is NonNullable<typeof n> => !!n).map((n) => ({ id: n.id, label: this.e.label(n), status: n.status }));
        const state: WtState = w.missing ? "missing" : agents.some((x) => x.status === "running") ? "running" : w.dirty > 0 ? "editing" : "idle";
        return { path: w.path, role: w.role, branch: w.branch, head: w.head, dirty: w.dirty, missing: w.missing, agents, state, bytes: m ? own(w.path, store?.gitDir ?? null) : null };
      });
      const at = (b: string) => a.worktrees.find((w) => w.branch === b)?.path ?? null;
      const branches: WtViewBranch[] = [
        { name: mainBranch, kind: "main" as const, worktree: at(mainBranch) },
        ...(a.branch && a.branch !== mainBranch ? [{ name: a.branch, kind: "work" as const, worktree: at(a.branch) }] : []),
        ...a.extraBranches.map((b) => ({ name: b, kind: "agent" as const, worktree: at(b) })),
        ...a.otherBranches.filter((b) => b !== mainBranch).map((b) => ({ name: b, kind: "other" as const, worktree: at(b) })),
      ];
      const sized = worktrees.every((w) => w.bytes !== null || w.missing);
      const total = m && a.repo && sized ? worktrees.reduce((s, w) => s + (w.bytes ?? 0), 0) + (store?.bytes ?? 0) : null;
      return {
        appId: a.appId,
        name: a.name,
        stage: info?.stage ?? "",
        repo: a.repo,
        work: a.work,
        branch: a.branch,
        mainBranch,
        worktrees,
        branches,
        store: a.repo ? { path: store?.gitDir ?? null, bytes: store?.bytes ?? null, sharedWith: (store?.gitDir ? storeOwners.get(store.gitDir) ?? [] : []).filter((n) => n !== a.name) } : null,
        total,
        extra: a.extra,
        legacy: a.legacy,
        error: a.error,
      };
    });
    // disks, from the measured folders
    const disks = new Map<number, { dev: number; free: number | null; total: number | null; apps: Set<string> }>();
    for (const a of out)
      for (const w of a.worktrees) {
        const s = m?.sizes.get(norm(w.path));
        if (!s || s.dev === null) continue;
        const d = disks.get(s.dev) ?? { dev: s.dev, free: s.free, total: s.total, apps: new Set<string>() };
        d.apps.add(a.name);
        disks.set(s.dev, d);
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
    return { cap: worktreeCap(this.e), apps: out, disks: [...disks.values()].map((d) => ({ ...d, apps: [...d.apps] })), total, measuredAt: m?.at ?? null, measuring: this.running.has(runId) };
  }
}

const views = new WeakMap<Engine, WorktreesView>();
/** One view per engine, so the panel and the Git agent share measured sizes. */
export function worktreesViewFor(e: Engine): WorktreesView {
  let v = views.get(e);
  if (!v) views.set(e, (v = new WorktreesView(e)));
  return v;
}

/** The Git agent's text: worktrees with their state and sizes, each disk's free space. */
export function worktreeSizesText(v: WtView): string {
  const lines = [`Sizes measured ${v.measuredAt ? "just now or in the last 10 minutes" : "not yet"} · limit ${v.cap} worktrees per project · everything: ${gb(v.total)}`];
  for (const d of v.disks) lines.push(`Disk with ${d.apps.join(", ")}: ${gb(d.free)} free of ${gb(d.total)}`);
  for (const a of v.apps) {
    lines.push(`\n${a.name}: ${gb(a.total)} in total${a.store ? ` (git storage ${gb(a.store.bytes)}${a.store.sharedWith.length ? `, shared with ${a.store.sharedWith.join(", ")}` : ""})` : ""}`);
    for (const w of a.worktrees) lines.push(`  - ${w.role.padEnd(8)} ${gb(w.bytes).padStart(7)} · ${w.state}${w.dirty ? ` (${w.dirty} uncommitted)` : ""} · ${w.branch ?? "detached"} · ${w.path}${w.agents.length ? ` · ${w.agents.map((x) => x.label).join(", ")}` : ""}`);
    const loose = a.branches.filter((b) => !b.worktree);
    if (loose.length) lines.push(`  branches without a worktree (no space of their own): ${loose.map((b) => b.name).join(", ")}`);
  }
  return lines.join("\n");
}
