// Graph layout, semantic zoom and viewport culling for the Helm app (pure).
import { test } from "node:test";
import assert from "node:assert/strict";
import { D, fitTransform, intersects, lodFor, pathD, portfolioLayout, squadLayout, visibleIdOf, visibleIds, withOffsets, zoomAbout, type PortfolioInput } from "../../components/helm/layout.ts";
import { appMoveRule, taskMoveRule, colOfStatus, fmtUnits, fmtTokens, allowedTypes } from "../../components/helm/format.ts";

/** A portfolio the size of the spec's big case: 20 apps × 8 agents under 5 managers. */
function bigInput(over: Partial<PortfolioInput> = {}): PortfolioInput {
  const managers = Array.from({ length: 5 }, (_, m) => ({ id: `m${m}`, name: `Group ${m}`, appIds: Array.from({ length: 4 }, (_, a) => `app${m * 4 + a}`) }));
  const members: Record<string, string[]> = {};
  const appNames: Record<string, string> = {};
  for (const m of managers)
    for (const a of m.appIds) {
      appNames[a] = a;
      members[a] = ["lead", "ui", "code", "p.ios", "security", "test", "review", "slop"].map((r) => `${a}.${r}`);
    }
  return { orchId: "orch", managers, directAppIds: [], appNames, collapsed: new Set(), expanded: new Set(), members, ...over };
}

test("portfolio layout places the orchestrator, every manager and every app card without overlap", () => {
  const L = portfolioLayout(bigInput());
  assert.ok(L.rects.orch);
  assert.equal(L.rects.orch.mode, "orch");
  for (let m = 0; m < 5; m++) assert.equal(L.rects[`m${m}`].mode, "mgr");
  const apps = Object.entries(L.rects).filter(([, r]) => r.mode === "app");
  assert.equal(apps.length, 20);
  for (let i = 0; i < apps.length; i++) for (let j = i + 1; j < apps.length; j++) assert.equal(intersects(apps[i][1], apps[j][1]), false, `${apps[i][0]} overlaps ${apps[j][0]}`);
  // agents stay inside their app cards until expanded
  assert.equal(L.rects["app0.ui"], undefined);
  assert.equal(L.edges.filter((e) => e.kind === "mgr").length, 5);
  assert.equal(L.edges.filter((e) => e.kind === "app").length, 20);
  assert.ok(L.bounds.w > 0 && L.bounds.h > 0);
});

test("collapsing a manager hides its apps; expanding an app shows its members in a frame", () => {
  const collapsed = portfolioLayout(bigInput({ collapsed: new Set(["m0"]) }));
  assert.equal(collapsed.rects.app0, undefined);
  assert.ok(collapsed.rects.app4);
  const expanded = portfolioLayout(bigInput({ expanded: new Set(["app1"]) }));
  assert.equal(expanded.rects.app1, undefined, "the expanded app is drawn as a frame, not a card");
  assert.ok(expanded.frames["frame:app1"]);
  for (const id of bigInput().members.app1) {
    const r = expanded.rects[id];
    assert.ok(r, `${id} placed`);
    const f = expanded.frames["frame:app1"];
    assert.ok(r.x >= f.x && r.y >= f.y && r.x + r.w <= f.x + f.w && r.y + r.h <= f.y + f.h, `${id} inside its frame`);
  }
  assert.ok(expanded.edges.some((e) => e.to === "frame:app1"));
});

test("a one-app run (C1) puts the app directly under the orchestrator", () => {
  const L = portfolioLayout({ orchId: "orch", managers: [], directAppIds: ["tally"], appNames: { tally: "Tally" }, collapsed: new Set(), expanded: new Set(["tally"]), members: { tally: ["tally.ui", "tally.code", "tally.review", "tally.slop"] } });
  assert.ok(L.frames["frame:tally"]);
  assert.deepEqual(L.edges.map((e) => [e.from, e.to, e.kind]), [["orch", "frame:tally", "direct"]]);
  assert.equal(Object.values(L.rects).filter((r) => r.mode === "agent").length, 4);
});

test("squad layout: chain above the lead, specialists and gates in frames", () => {
  const L = squadLayout({ chain: ["orch", "m0"], leadId: "a.lead", specialists: ["a.ui", "a.code", "a.p.ios"], gates: ["a.review", "a.slop"] });
  assert.equal(L.rects.orch.mode, "chip");
  assert.equal(L.rects.m0.mode, "chip");
  assert.ok(L.rects.orch.y < L.rects.m0.y && L.rects.m0.y < L.rects["a.lead"].y);
  assert.ok(L.frames.sf && L.frames.gf);
  assert.deepEqual(L.edges.filter((e) => e.kind === "v").map((e) => `${e.from}>${e.to}`).sort(), ["m0>a.lead", "orch>m0"]);
  assert.ok(L.rects["a.lead"].y + L.rects["a.lead"].h <= L.frames.sf.y, "builders below the lead");
  assert.ok(L.frames.sf.y + L.frames.sf.h <= L.frames.gf.y, "gates below the builders");
  // C1: the orchestrator leads, no chain
  const c1 = squadLayout({ chain: [], leadId: "orch", specialists: ["t.ui"], gates: ["t.review"] });
  assert.equal(c1.rects.orch.mode, "agent");
});

test("semantic zoom thresholds", () => {
  assert.equal(lodFor(0.3), "far");
  assert.equal(lodFor(0.59), "far");
  assert.equal(lodFor(0.6), "mid");
  assert.equal(lodFor(0.81), "mid");
  assert.equal(lodFor(0.82), "near");
  assert.equal(lodFor(1.5), "near");
});

test("fit and zoom-about keep the point under the cursor fixed and clamp zoom", () => {
  const t = fitTransform({ w: 2000, h: 1000 }, 1000, 800);
  assert.ok(t.zoom >= 0.28 && t.zoom <= 1);
  const v = { px: 100, py: 50, zoom: 1 };
  const z = zoomAbout(v, 400, 300, 1.5);
  // world point under (400,300) before and after
  assert.ok(Math.abs((400 - v.px) / v.zoom - (400 - z.px) / z.zoom) < 1e-9);
  assert.equal(zoomAbout(v, 0, 0, 10).zoom, 1.8);
  assert.equal(zoomAbout(v, 0, 0, 0.01).zoom, 0.25);
});

test("culling keeps only nodes near the viewport, plus pinned ids, at ~170 nodes", () => {
  const input = bigInput({ expanded: new Set(Object.keys(bigInput().members)) });
  const L = portfolioLayout(input);
  const total = Object.keys(L.rects).length;
  assert.equal(total, 160 + 5 + 1, "every agent, manager and the orchestrator is placed");
  // a small viewport at near zoom over the top-left corner
  const ids = visibleIds(L, { px: 0, py: 0, zoom: 1, w: 600, h: 400 }, ["app19.slop"], 0);
  assert.ok(ids.length < total / 4, `culled to ${ids.length} of ${total}`);
  assert.ok(ids.includes("app19.slop"), "pinned selection kept");
  // zoomed out far enough to see the whole bounds, everything is kept
  const zoom = Math.min(1600 / L.bounds.w, 1000 / L.bounds.h);
  const all = visibleIds(L, { px: 0, py: 0, zoom, w: 1600, h: 1000 });
  assert.equal(all.length, total);
});

test("the visible stand-in for a hidden node is its app card or collapsed manager", () => {
  const L = portfolioLayout(bigInput({ collapsed: new Set(["m1"]) }));
  const appOf = (id: string) => id.split(".")[0];
  const mgrOf = (a: string) => `m${Math.floor(Number(a.replace("app", "")) / 4)}`;
  assert.equal(visibleIdOf(L, "app0.ui", appOf, mgrOf), "app0");
  assert.equal(visibleIdOf(L, "app5.ui", appOf, mgrOf), "m1");
  assert.equal(visibleIdOf(L, "m2", appOf, mgrOf), "m2");
  assert.ok(D.app.w > 0);
});

test("client-side board rules match the spec (§5.7)", () => {
  assert.deepEqual(appMoveRule({ name: "A", stage: "ready" }, "done"), { ok: true, act: "signoff", label: "Sign off" });
  assert.equal((appMoveRule({ name: "A", stage: "ready" }, "build") as { act: string }).act, "sendback");
  assert.equal((appMoveRule({ name: "A", stage: "intake" }, "spec") as { act: string }).act, "start");
  const r = appMoveRule({ name: "Lumen", stage: "build" }, "review");
  assert.equal(r.ok, false);
  assert.match((r as { why: string }).why, /stages advance on evidence, not on drag/);
  assert.equal((taskMoveRule({ status: "planned" }, "queued") as { act: string }).act, "spawn");
  assert.equal((taskMoveRule({ status: "running" }, "queued") as { act: string }).act, "hold");
  assert.equal(taskMoveRule({ status: "failed" }, "running").ok, false);
  assert.equal(colOfStatus("paused"), "queued");
});

test("formatting never shows dollars and tokens are raw counts", () => {
  assert.equal(fmtUnits(3.456), "3.46 u");
  assert.equal(fmtUnits(1234.4), "1,234 u");
  assert.equal(fmtTokens(301283), "301k");
  assert.equal(fmtTokens(1_400_000), "1.4M");
  assert.deepEqual(allowedTypes({ tier: "specialist", status: "planned", threadId: null }), ["tell", "model", "scope", "priority", "spawn"]);
  assert.ok(allowedTypes({ tier: "gate", status: "running", threadId: "t" }).includes("waive"));
});

test("nodes moved by hand: a card moves, an expanded app's squad moves with its frame, group boxes stretch, anything may go above or left of the origin", () => {
  const L = portfolioLayout(bigInput({ expanded: new Set(["app0"]) }));
  assert.equal(withOffsets(L, {}), L, "no offsets: the same layout");
  const inBox = (r: { x: number; y: number; w: number; h: number }, c: { x: number; y: number; w: number; h: number }) => r.x >= c.x && r.y >= c.y && r.x + r.w <= c.x + c.w && r.y + r.h <= c.y + c.h;
  const frame = L.frames["frame:app0"];
  assert.ok(frame, "app0 is expanded");
  const squad = Object.keys(L.rects).filter((id) => inBox(L.rects[id], frame));
  assert.ok(squad.length > 0);
  const M = withOffsets(L, { "frame:app0": { dx: 400, dy: 120 } });
  for (const id of squad) assert.deepEqual([M.rects[id].x - L.rects[id].x, M.rects[id].y - L.rects[id].y], [400, 120], `${id} moved with its frame`);
  assert.deepEqual([M.frames["frame:app0"].x - frame.x, M.frames["frame:app0"].w], [400, frame.w], "the frame moved, same size");
  const group = L.clusters.find((c) => c.id !== "frame:app0" && inBox(frame, c))!;
  assert.ok(inBox(M.frames["frame:app0"], M.clusters.find((c) => c.id === group.id)!), "its group box stretched to hold it");
  const card = withOffsets(L, { app1: { dx: -30, dy: 50 } });
  assert.deepEqual([card.rects.app1.x - L.rects.app1.x, card.rects.app1.y - L.rects.app1.y], [-30, 50]);
  const far = withOffsets(L, { orch: { dx: -5000, dy: -300 } });
  assert.deepEqual([far.rects.orch.x - L.rects.orch.x, far.rects.orch.y - L.rects.orch.y], [-5000, -300], "free in both directions");
  assert.ok(far.bounds.x0! <= far.rects.orch.x && far.bounds.y0! <= far.rects.orch.y, "the drawing starts where the moved card is");
  const near = withOffsets(L, { orch: { dx: -L.rects.orch.x - 400, dy: -200 } });
  assert.ok(near.rects.orch.x < 0 && near.rects.orch.y < 0, "above and left of the origin");
  const fit = fitTransform(near.bounds, 1400, 900);
  assert.ok(fit.px + near.rects.orch.x * fit.zoom >= 0 && fit.py + near.rects.orch.y * fit.zoom >= 0, "fit shows it");
  assert.ok(M.bounds.w >= L.bounds.w);
});

test("the Planner and the Git agent sit beside the Orchestrator on its row, unconnected; custom agents with no app beside them, linked to their supervisor", () => {
  const L = portfolioLayout(bigInput({ side: [{ id: "planner", parentId: null }, { id: "git", parentId: null }, { id: "c1", parentId: "m1" }, { id: "c2", parentId: "orch" }] }));
  const o = L.rects.orch;
  const p = L.rects.planner;
  const g = L.rects.git;
  const mid = (r: { y: number; h: number }) => r.y + r.h / 2;
  for (const r of [p, g]) assert.equal(mid(r), mid(o), "same row as the Orchestrator");
  assert.ok(p.x + p.w <= o.x, "the Planner on its left");
  assert.ok(g.x >= o.x + o.w, "the Git agent on its right");
  assert.equal(L.edges.some((e) => e.from === "planner" || e.to === "planner" || e.to === "git"), false, "no line to the Planner or the Git agent");
  assert.ok(L.edges.some((e) => e.from === "m1" && e.to === "c1"));
  assert.equal(L.edges.some((e) => e.to === "c2"), false, "the Orchestrator's own agents need no line");
  const all = Object.entries(L.rects);
  for (const id of ["planner", "git", "c1", "c2"]) for (const [other, r] of all) if (other !== id) assert.equal(intersects(L.rects[id], r), false, `${id} overlaps ${other}`);
  assert.ok(Object.values(L.rects).every((r) => r.x >= 0 && r.y >= 0), "nothing starts left of the origin");
});

test("top-down: the Orchestrator's row, then the managers, then the apps, then an expanded app's agents in a square under its lead", () => {
  const L = portfolioLayout(bigInput({ expanded: new Set(["app5"]), side: [{ id: "planner", parentId: null }, { id: "git", parentId: null }] }));
  const bottom = (r: { y: number; h: number }) => r.y + r.h;
  const o = L.rects.orch;
  for (let m = 0; m < 5; m++) {
    const mg = L.rects[`m${m}`];
    assert.ok(bottom(o) < mg.y, `m${m} below the Orchestrator`);
    assert.equal(mg.y, L.rects.m0.y, "managers share a row");
  }
  for (const id of ["app0", "app1", "app4", "app9", "app19"]) assert.ok(bottom(L.rects.m0) < L.rects[id].y, `${id} below the managers`);
  // the apps of a manager sit under it
  const m1 = L.rects.m1;
  const box = L.clusters.find((c) => c.id === "cl-m1")!;
  for (const id of ["app4", "frame:app5", "app6", "app7"]) {
    const r = L.rects[id] ?? L.frames[id];
    assert.ok(r.x >= box.x && r.x + r.w <= box.x + box.w, `${id} under its manager`);
  }
  assert.ok(m1.x >= box.x && m1.x + m1.w <= box.x + box.w);
  // the expanded app: lead on top, the other seven in a 3-column square below
  const lead = L.rects["app5.lead"];
  const others = bigInput().members.app5.slice(1).map((id) => L.rects[id]);
  for (const r of others) assert.ok(r.y >= bottom(lead), "below its lead");
  assert.equal(new Set(others.map((r) => r.x)).size, 3, "three columns");
  assert.equal(new Set(others.map((r) => r.y)).size, 3, "three rows");
  // the Orchestrator is centred over the managers
  const ms = [0, 1, 2, 3, 4].map((m) => L.rects[`m${m}`]);
  const span = (ms[0].x + ms[4].x + ms[4].w) / 2;
  assert.ok(Math.abs(o.x + o.w / 2 - span) < 2, "centred");
});

test("dragging the Orchestrator left and right moves it, and edges stay drawable", () => {
  const L = portfolioLayout(bigInput({ side: [{ id: "planner", parentId: null }, { id: "git", parentId: null }] }));
  for (const dx of [-400, 400]) {
    const M = withOffsets(L, { orch: { dx, dy: 0 } });
    assert.equal(M.rects.orch.x, L.rects.orch.x + dx);
    assert.match(pathD(M.rects.orch, M.rects.m0), /^M[-\d.]+ [-\d.]+ C/);
  }
  // a single-app run with no managers puts the app straight under the Orchestrator
  const c1 = portfolioLayout({ orchId: "orch", managers: [], directAppIds: ["tally"], appNames: { tally: "Tally" }, collapsed: new Set(), expanded: new Set(), members: { tally: ["tally.lead"] } });
  assert.ok(c1.rects.tally.y > c1.rects.orch.y + c1.rects.orch.h);
});
