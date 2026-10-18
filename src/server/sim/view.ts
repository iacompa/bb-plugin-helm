// The simulator view: the human watches and drives the apps a run is building, in BB's
// in-app browser. iOS simulators (simctl) and Android emulators (adb, headless) stream
// frames; macOS apps are launched and their window mirrored; Windows apps cannot run on a
// Mac, so the view shows the screenshots the Windows builder committed. Everything runs on
// the run's host through Helm's host entry. Builds are found, never built: building is
// the agents' job.

import type { Engine } from "../engine/engine.ts";
import { nodeWorktree } from "../engine/gates.ts";
import type { HostOps, SimPlatform } from "../../shared/host-contract.ts";
import type { AppInfo, Platform } from "../../shared/types.ts";

const PLATFORM_OF: Partial<Record<Platform, SimPlatform>> = { ios: "ios", and: "and", mac: "mac", win: "win" };
const ROOTS_TTL = 60_000;
const BUILDS_TTL = 20_000;

export interface SimAction {
  action: "boot" | "shutdown" | "install" | "tap" | "swipe" | "text" | "key" | "appearance" | "textSize" | "url";
  platform: SimPlatform;
  id: string;
  runId?: string | null;
  appId?: string | null;
  path?: string;
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  text?: string;
  key?: "back" | "home" | "recents" | "enter" | "delete";
  value?: string;
}

export class SimView {
  private roots = new Map<string, { at: number; paths: string[] }>();
  private builds = new Map<string, { at: number; list: Array<{ path: string; mtime: number; kind: string }> }>();
  /** The window name of the macOS app last launched for (run, app). */
  private macMatch = new Map<string, string>();

  constructor(private readonly e: Engine) {}

  private host(runId?: string | null): HostOps {
    return runId && this.e.repo.getRun(runId) ? this.e.host(runId) : this.e.port.host(null);
  }

  private app(runId: string, appId: string): AppInfo {
    const app = this.e.repo.getApp(runId, appId);
    if (!app) throw new Error(`No app ${appId} in this run.`);
    return app;
  }

  /** Running (or paused) runs, the most recently active first. */
  liveRuns(): Array<{ id: string; name: string }> {
    const last = (id: string) => Math.max(0, ...this.e.repo.listNodes(id).map((n) => n.lastActivityAt ?? 0));
    return this.e.repo
      .listRuns()
      .filter((r) => r.status === "running" || r.status === "paused")
      .map((r) => ({ id: r.id, name: r.name, at: last(r.id) }))
      .sort((a, b) => b.at - a.at)
      .map(({ id, name }) => ({ id, name }));
  }

  /** Runs worth showing, their apps and platforms, and what the host can run. */
  async state(runId?: string | null) {
    const runs = this.liveRuns();
    const current = runId && runs.some((r) => r.id === runId) ? runId : runs[0]?.id ?? null;
    const apps = current
      ? this.e.repo
          .listApps(current)
          .map((a) => ({ id: a.id, name: a.name, platforms: a.platforms.map((p) => PLATFORM_OF[p]).filter((p): p is SimPlatform => !!p), stage: a.stage }))
          .filter((a) => a.platforms.length && a.stage !== "cancelled")
      : [];
    const devices = await this.host(current).simList({});
    return { runs, runId: current, apps, devices };
  }

  /** Where an app's builds can be: its repository and the worktrees of its lead and builders. */
  private async appRoots(runId: string, appId: string): Promise<string[]> {
    const key = `${runId}:${appId}`;
    const hit = this.roots.get(key);
    if (hit && this.e.now() - hit.at < ROOTS_TTL) return hit.paths;
    const app = this.app(runId, appId);
    const nodes = this.e.repo.listNodes(runId).filter((n) => n.appId === appId && n.threadId && (n.tier === "lead" || n.tier === "specialist" || n.alsoLead));
    const paths = new Set<string>();
    if (app.repoPath) paths.add(app.repoPath);
    for (const n of nodes.slice(0, 16)) {
      const wt = await nodeWorktree(this.e, n).catch(() => null);
      if (wt) paths.add(wt);
    }
    const list = [...paths];
    this.roots.set(key, { at: this.e.now(), paths: list });
    return list;
  }

  /** The newest builds of an app for a platform (Windows: committed screenshots). */
  async listBuilds(runId: string, appId: string, platform: SimPlatform) {
    const key = `${runId}:${appId}:${platform}`;
    const hit = this.builds.get(key);
    if (hit && this.e.now() - hit.at < BUILDS_TTL) return hit.list;
    const app = this.app(runId, appId);
    const roots = await this.appRoots(runId, appId);
    const names = [app.name, app.name.replace(/\s+/g, ""), app.id].slice(0, 4);
    const { builds } = await this.host(runId).simBuilds({ platform, roots, names });
    this.builds.set(key, { at: this.e.now(), list: builds });
    return builds;
  }

  /** Drop cached roots and builds of an app (the human pressed Refresh). */
  forget(runId: string, appId: string): void {
    this.roots.delete(`${runId}:${appId}`);
    for (const k of [...this.builds.keys()]) if (k.startsWith(`${runId}:${appId}:`)) this.builds.delete(k);
  }

  async frame(platform: SimPlatform, id: string, runId?: string | null, appId?: string | null) {
    const match = platform === "mac" && runId && appId ? this.macMatch.get(`${runId}:${appId}`) ?? this.e.repo.getApp(runId, appId)?.name : undefined;
    return this.host(runId).simFrame({ platform, id, match });
  }

  /** A committed screenshot, only from the list Helm found for that app. */
  async image(runId: string, appId: string, path: string) {
    const ok = (await this.listBuilds(runId, appId, "win")).some((b) => b.path === path);
    if (!ok) return { data: null, mime: "" };
    return this.host(runId).simImage({ path });
  }

  async act(a: SimAction): Promise<{ ok: boolean; message: string }> {
    const host = this.host(a.runId);
    switch (a.action) {
      case "boot":
        return host.simBoot({ platform: a.platform, id: a.id });
      case "shutdown":
        return host.simShutdown({ platform: a.platform, id: a.id });
      case "install": {
        if (!a.runId || !a.appId || !a.path) return { ok: false, message: "Pick an app build first." };
        // only a build Helm found for this app: the browser never names an arbitrary path
        const known = (await this.listBuilds(a.runId, a.appId, a.platform)).some((b) => b.path === a.path);
        if (!known) return { ok: false, message: "That build is not one of this app's builds. Refresh the list." };
        const r = await host.simInstall({ platform: a.platform, id: a.id, path: a.path });
        if (r.match) this.macMatch.set(`${a.runId}:${a.appId}`, r.match);
        if (r.ok && a.runId) this.e.repo.event(a.runId, this.e.leadOf(a.runId, a.appId)?.id ?? "orch", "sim", `the human ran ${a.appId} on ${a.platform} (${a.path.split("/").pop()})`);
        return { ok: r.ok, message: r.message };
      }
      default:
        return host.simInput({ platform: a.platform, id: a.id, action: a.action, x: a.x, y: a.y, x2: a.x2, y2: a.y2, text: a.text, key: a.key, value: a.value });
    }
  }
}
