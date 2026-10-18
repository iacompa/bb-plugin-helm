import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, CHEAP } from "../helpers/harness.ts";
import { SimView } from "../../src/server/sim/view.ts";
import { SIM_PAGE } from "../../src/server/sim/page.ts";

const two = { apps: [{ name: "Alpha", tagline: "a", platforms: ["ios", "and"] }, { name: "Beta", tagline: "b", platforms: ["mac", "win"] }], groups: [], assumptions: [], questions: [] };

test("the simulator view lists the running run's apps with their platforms and the host's devices", async () => {
  const h = await createHarness();
  const { runId } = h.engine.createRun({ name: "S", brief: "x", portfolio: two as never, slots: CHEAP, limits: { concurrency: 48 } });
  assert.deepEqual((await h.engine.startRun(runId)).problems, []);
  const view = new SimView(h.engine);
  const st = await view.state(null);
  assert.equal(st.runId, runId);
  assert.deepEqual(st.apps.map((a) => [a.name, a.platforms]), [["Alpha", ["ios", "and"]], ["Beta", ["mac", "win"]]]);
  assert.ok(st.devices.tools);
});

test("installing refuses any path that is not one of the app's own builds", async () => {
  const h = await createHarness();
  const { runId } = h.engine.createRun({ name: "S", brief: "x", portfolio: two as never, slots: CHEAP, limits: { concurrency: 48 } });
  await h.engine.startRun(runId);
  const app = h.repo.listApps(runId)[0];
  const view = new SimView(h.engine);
  const r = await view.act({ action: "install", platform: "ios", id: "ABC", runId, appId: app.id, path: "/etc/passwd" });
  assert.equal(r.ok, false);
  assert.match(r.message, /not one of this app's builds/);
  const img = await view.image(runId, app.id, "/etc/hosts.png");
  assert.equal(img.data, null, "only screenshots Helm found are served");
});

test("the page is self-contained and its script parses", () => {
  assert.ok(!/<script[^>]+src=|<link[^>]+href=|https?:\/\/(?!…)/.test(SIM_PAGE.replace(/"https:\/\/"/g, "")), "no external assets");
  const js = SIM_PAGE.slice(SIM_PAGE.indexOf("<script>") + 8, SIM_PAGE.indexOf("</script>"));
  assert.doesNotThrow(() => new Function(js));
  assert.ok(!/innerHTML/.test(js), "server strings are set with textContent");
});
