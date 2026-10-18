// HTTP routes for the simulator view (auth "local": the BB app's own origin or no Origin
// header, i.e. BB's in-app browser on this machine), and opening the view as a tab in
// BB's in-app browser.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Engine } from "../engine/engine.ts";
import { SimIdZ, SimPlatformZ } from "../../shared/host-contract.ts";
import { SIM_PAGE } from "./page.ts";
import { SimView } from "./view.ts";

const ActionZ = z
  .object({
    action: z.enum(["boot", "shutdown", "install", "tap", "swipe", "text", "key", "appearance", "textSize", "url"]),
    platform: SimPlatformZ,
    id: SimIdZ,
    runId: z.string().max(80).nullish(),
    appId: z.string().max(80).nullish(),
    path: z.string().max(1500).optional(),
    x: z.number().min(0).max(1).optional(),
    y: z.number().min(0).max(1).optional(),
    x2: z.number().min(0).max(1).optional(),
    y2: z.number().min(0).max(1).optional(),
    text: z.string().max(500).optional(),
    key: z.enum(["back", "home", "recents", "enter", "delete"]).optional(),
    value: z.string().max(40).optional(),
  })
  .strict();

type Ctx = { req: { url: string; json(): Promise<unknown> } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const params = (c: Ctx) => new URL(c.req.url).searchParams;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 400);

export function registerSimView(bb: BbPluginApi, engine: Engine): SimView {
  const view = new SimView(engine);
  const route = (method: "GET" | "POST", path: string, fn: (c: Ctx) => Promise<Response>) =>
    bb.http.route(method, path, async (c: unknown) => {
      try {
        return await fn(c as Ctx);
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
    }, { auth: "local" });

  route("GET", "/sim", async () => new Response(SIM_PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "SAMEORIGIN" } }));
  route("GET", "/sim/state", async (c) => json(await view.state(params(c).get("run"))));
  route("GET", "/sim/builds", async (c) => {
    const q = params(c);
    const p = SimPlatformZ.parse(q.get("p"));
    if (q.get("force")) view.forget(q.get("run") ?? "", q.get("app") ?? "");
    return json({ builds: await view.listBuilds(String(q.get("run")), String(q.get("app")), p) });
  });
  route("GET", "/sim/frame", async (c) => {
    const q = params(c);
    const f = await view.frame(SimPlatformZ.parse(q.get("p")), SimIdZ.parse(q.get("id")), q.get("run"), q.get("app"));
    if (!f.data) return json({ error: f.error ?? "no frame" }, 409);
    return new Response(Buffer.from(f.data, "base64"), { headers: { "content-type": f.mime, "cache-control": "no-store" } });
  });
  route("GET", "/sim/image", async (c) => {
    const q = params(c);
    const img = await view.image(String(q.get("run")), String(q.get("app")), String(q.get("path")));
    if (!img.data) return json({ error: "not found" }, 404);
    return new Response(Buffer.from(img.data, "base64"), { headers: { "content-type": img.mime, "cache-control": "private, max-age=300" } });
  });
  route("POST", "/sim/action", async (c) => {
    const a = ActionZ.safeParse(await c.req.json());
    if (!a.success) return json({ ok: false, message: a.error.issues.map((i) => i.message).join("; ") }, 400);
    return json(await view.act(a.data));
  });
  return view;
}

/** The view's URL on this BB server. */
export function simUrl(bb: BbPluginApi, runId?: string | null, appId?: string | null): string {
  const u = new URL(`${bb.server.loopbackBaseUrl}/api/v1/plugins/${encodeURIComponent(bb.pluginId)}/http/sim`);
  if (runId) u.searchParams.set("run", runId);
  if (appId) u.searchParams.set("app", appId);
  return u.toString();
}

/**
 * Open the view as a tab in BB's in-app browser, in the run's Orchestrator thread (the
 * Helm panel itself has no browser). Returns the thread to show, or null when no desktop
 * browser is available (the caller then opens the URL directly).
 */
export async function openSimTab(bb: BbPluginApi, engine: Engine, view: SimView, runId?: string | null, appId?: string | null): Promise<{ url: string; threadId: string | null; message: string }> {
  runId = runId ?? view.liveRuns()[0]?.id ?? null;
  const url = simUrl(bb, runId, appId);
  const run = runId ? engine.repo.getRun(runId) : null;
  const threadId = run ? engine.repo.getNode(run.id, "orch")?.threadId ?? null : null;
  if (!threadId) return { url, threadId: null, message: "No Orchestrator thread to host the browser tab; opening the page directly." };
  try {
    const browsers = (bb.sdk as unknown as { experimental_desktopBrowsers?: { listInstances(i: { hostId: string }): Promise<{ instances: Array<{ instanceId: string; generation: string; hostId: string }> }>; createTab(i: Record<string, unknown>): Promise<unknown> } }).experimental_desktopBrowsers;
    if (!browsers) return { url, threadId: null, message: "This BB has no desktop browser API; opening the page directly." };
    const hostId = engine.repo.runHost(run!.id) ?? (await engine.port.primaryHostId());
    if (!hostId) return { url, threadId: null, message: "No host." };
    const { instances } = await browsers.listInstances({ hostId });
    const inst = instances[0];
    if (!inst) return { url, threadId: null, message: "BB's desktop app is not open on this machine; opening the page directly." };
    await browsers.createTab({ hostId, instanceId: inst.instanceId, generation: inst.generation, threadId, url, presentation: "reveal" });
    return { url, threadId, message: "Opened in the Orchestrator thread's browser." };
  } catch (e) {
    return { url, threadId: null, message: `Could not open a browser tab (${errText(e)}); opening the page directly.` };
  }
}
