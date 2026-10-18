// The Screens view reads the screenshots builders commit in their worktrees, and serves only those.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP } from "../helpers/harness.ts";
import { HelmService } from "../../src/server/service.ts";
import { parseBrief, SAMPLE_BRIEF } from "../../src/server/domain/brief.ts";
import { nodeWorktree } from "../../src/server/engine/gates.ts";

test("an app's screens come from its builders' worktrees; only listed images can be read", async () => {
  const h = await createHarness();
  const p = parseBrief(SAMPLE_BRIEF).portfolio;
  const { runId } = h.engine.createRun({ name: "S", brief: "x", portfolio: { ...p, apps: p.apps.slice(0, 2).map((a) => ({ ...a, group: null })) }, slots: CHEAP, limits: { concurrency: 32 } });
  await h.engine.startRun(runId);
  const ui = h.repo.listNodes(runId).find((n) => n.role === "ui")!;
  await h.clock.runUntil(h.clock.now() + 6 * 3600_000, { stopWhen: () => !!h.repo.getNode(runId, ui.id)?.threadId });
  const wt = (await nodeWorktree(h.engine, h.repo.getNode(runId, ui.id)!))!;
  h.sim.git.write(wt, "reports/ui/home--default--phone--light.png", "PNGDATA-home");
  h.sim.git.write(wt, "reports/ui/settings--default--phone--light.png", "PNGDATA-settings");
  h.sim.git.write(wt, "reports/screens/screens.json", JSON.stringify({ start: "home", screens: [{ id: "home", links: [{ to: "settings", x: 0.8, y: 0, w: 0.2, h: 0.1, label: "Gear" }] }, { id: "settings" }] }));
  const svc = new HelmService(h.engine);
  const map = await svc.screens.list(runId, ui.appId!, true);
  assert.equal(map.source, "map");
  assert.deepEqual(map.screens.map((s) => s.id), ["home", "settings"]);
  assert.equal(map.screens[0].links[0].to, "settings");
  const img = await svc.screens.image(runId, ui.appId!, map.screens[1].variants[0].path);
  assert.equal(img.dataUrl, `data:image/png;base64,${Buffer.from("PNGDATA-settings").toString("base64")}`);
  assert.equal((await svc.screens.image(runId, ui.appId!, `${wt}/src/secret.png`)).dataUrl, null, "a path the scan did not return is refused");
  assert.deepEqual(svc.screens.apps(runId).map((a) => a.id).length, 2);
});
