// The Screens view's pages: screenshots become pages, the screen map adds names and links.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScreenMap, isScreenFile, parseScreenFile } from "../../src/server/domain/screens.ts";

const f = (rel: string, mtime = 1, root = "/r") => ({ root, rel, mtime });

test("screenshot names become screens and variants", () => {
  const ui = parseScreenFile(f("reports/ui/settings--empty--tablet--dark.png"))!;
  assert.equal(ui.id, "settings");
  assert.deepEqual([ui.variant.platform, ui.variant.state, ui.variant.size, ui.variant.theme], ["ui", "empty", "tablet", "dark"]);
  const web = parseScreenFile(f("reports/web/T3/screens/checkout-1440-light.png"))!;
  assert.deepEqual([web.id, web.variant.size, web.variant.theme, web.variant.platform], ["checkout", "1440", "light", "web"]);
  assert.equal(parseScreenFile(f("reports/ios/T2/screens/01-home.png"))!.id, "home", "a leading order number is dropped");
  assert.equal(parseScreenFile(f("reports/ios/T2/screens/01-home.png"))!.variant.path, "/r/reports/ios/T2/screens/01-home.png");
  assert.ok(!isScreenFile("reports/slop/finding.png"), "gate evidence is not a screen");
  assert.ok(!isScreenFile("assets/icon.png"), "app assets are not screens");
  assert.ok(isScreenFile("docs/screenshots/home.png"));
});

test("without a screen map, every captured screen is a page and Home comes first", () => {
  const m = buildScreenMap([f("reports/ui/settings--default--phone--light.png"), f("reports/ui/home--default--phone--light.png"), f("reports/ui/home--default--phone--dark.png"), f("reports/ui/about--default--phone--light.png")], []);
  assert.equal(m.source, "files");
  assert.deepEqual(m.screens.map((s) => s.id), ["home", "about", "settings"]);
  assert.equal(m.start, "home");
  assert.equal(m.screens[0].name, "Home");
  assert.equal(m.screens[0].variants[0].theme, "light", "light before dark by default");
});

test("the screen map names pages, orders them, and links tappable areas to other pages", () => {
  const map = JSON.stringify({
    start: "today",
    screens: [
      { id: "today", name: "Today", image: "reports/ui/today--default--phone--light.png", links: [{ to: "settings", x: 0.85, y: 0.03, w: 0.3, h: 0.07, label: "Gear" }, { to: "nowhere", x: 0, y: 0.9, w: 0.2, h: 0.1 }] },
      { id: "settings", name: "Settings", images: ["reports/ui/settings--default--phone--light.png"], links: [{ to: "today", x: 0, y: 0, w: 0.15, h: 0.07, label: "Back" }] },
      { id: "paywall", note: "Not captured yet", image: "/etc/passwd.png" },
    ],
  });
  const m = buildScreenMap([f("reports/ui/today--default--phone--light.png"), f("reports/ui/settings--default--phone--light.png"), f("reports/ui/history--default--phone--light.png")], [{ root: "/r", text: map, mtime: 2 }]);
  assert.equal(m.source, "map");
  assert.equal(m.start, "today");
  assert.deepEqual(m.screens.map((s) => s.id), ["today", "settings", "history"], "map order first; a page with nothing to show is left out");
  const today = m.screens[0];
  assert.deepEqual(today.links[0], { to: "settings", x: 0.85, y: 0.03, w: 0.15000000000000002, h: 0.07, label: "Gear" }, "areas are clipped to the image");
  assert.ok(m.problems.some((p) => /link to unknown screen "nowhere"/.test(p)));
  assert.ok(m.problems.some((p) => /must be a relative image path/.test(p)));
});

test("a broken screen map is reported and the screenshots still show", () => {
  const m = buildScreenMap([f("reports/ui/home--default--phone--light.png")], [{ root: "/r", text: "{ nope", mtime: 1 }]);
  assert.equal(m.source, "files");
  assert.deepEqual(m.screens.map((s) => s.id), ["home"]);
  assert.match(m.problems[0], /not valid JSON/);
});

test("the same screenshot in several worktrees counts once: the newest", () => {
  const m = buildScreenMap([f("reports/ui/home--default--phone--light.png", 1, "/repo"), f("reports/ui/home--default--phone--light.png", 9, "/wt/ui")], []);
  assert.equal(m.screens[0].variants.length, 1);
  assert.equal(m.screens[0].variants[0].path, "/wt/ui/reports/ui/home--default--phone--light.png");
});
