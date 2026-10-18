// The Screens view, server side: where an app's screenshots can be (its repository and the
// worktrees of its lead and builders), the pages built from them, and one image at a time.
// Only paths the scan returned can be read.

import type { Engine } from "./engine/engine.ts";
import { nodeWorktree } from "./engine/gates.ts";
import { HelmError } from "./engine/engine.ts";
import { buildScreenMap, type ScreenMap } from "./domain/screens.ts";

const TTL = 15_000;

export class ScreensView {
  private cache = new Map<string, { at: number; map: ScreenMap; paths: Set<string> }>();

  constructor(private readonly e: Engine) {}

  /** The run's apps that are not cancelled, for the app picker. */
  apps(runId: string) {
    return this.e.repo
      .listApps(runId)
      .filter((a) => a.stage !== "cancelled")
      .map((a) => ({ id: a.id, name: a.name, kind: a.kind, platforms: a.platforms, stage: a.stage }));
  }

  private async roots(runId: string, appId: string): Promise<string[]> {
    const app = this.e.repo.getApp(runId, appId);
    if (!app) throw new HelmError(`No app ${appId} in this run.`, "not_found");
    const paths = new Set<string>();
    if (app.repoPath) paths.add(app.repoPath);
    const nodes = this.e.repo.listNodes(runId).filter((n) => n.appId === appId && n.threadId && (n.tier === "lead" || n.tier === "specialist" || n.tier === "custom" || n.alsoLead));
    for (const n of nodes.slice(0, 20)) {
      const wt = await nodeWorktree(this.e, n).catch(() => null);
      if (wt) paths.add(wt);
    }
    return [...paths];
  }

  /** The app's pages and the links between them. `fresh` skips the short cache (the human pressed Refresh). */
  async list(runId: string, appId: string, fresh = false): Promise<ScreenMap> {
    const key = `${runId}:${appId}`;
    const hit = this.cache.get(key);
    if (hit && !fresh && this.e.now() - hit.at < TTL) return hit.map;
    const roots = await this.roots(runId, appId);
    const { files, maps } = roots.length ? await this.e.host(runId).screensScan({ roots }) : { files: [], maps: [] };
    const map = buildScreenMap(files, maps);
    this.cache.set(key, { at: this.e.now(), map, paths: new Set(map.screens.flatMap((s) => s.variants.map((v) => v.path))) });
    return map;
  }

  /** One screenshot as a data URL, only from the app's own pages. */
  async image(runId: string, appId: string, path: string): Promise<{ dataUrl: string | null }> {
    let entry = this.cache.get(`${runId}:${appId}`);
    if (!entry?.paths.has(path)) {
      await this.list(runId, appId, true);
      entry = this.cache.get(`${runId}:${appId}`);
    }
    if (!entry?.paths.has(path)) return { dataUrl: null };
    const r = await this.e.host(runId).screenImage({ path });
    return { dataUrl: r.data ? `data:${r.mime};base64,${r.data}` : null };
  }
}
