// The Screens view's pages: screenshots become pages, the screen map adds names and links.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScreenMap, debugCapture, deviceFor, deviceName, deviceSlug, formOf, isScreenFile, parseScreenFile } from "../../src/server/domain/screens.ts";
import { imageSize } from "../../src/host/screens.ts";

const f = (rel: string, mtime = 1, root = "/r", w: number | null = null, h: number | null = null) => ({ root, rel, mtime, w, h });

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
  assert.deepEqual(m.screens.map((s) => s.id), ["today", "settings"], "only the map's pages, in its order; a page with nothing to show is left out");
  assert.deepEqual(m.hidden, { count: 1, reasons: ["1 captures of screens that are not in the screen map"] });
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

test("evidence and debug captures are never pages: before/after shots, probes, a commit or a time in the name", () => {
  for (const rel of [
    "docs/evidence/device-ui-c/screenshots/amp-modeler-after.png",
    "reports/ui/web/browser-view-photos-8ae75717-0013z.png",
    "reports/ui/guitar-pedal-before.png",
    "reports/ui/web-probe-reload-persisted-es.png",
    "reports/ui/web-stuck-wasm-unresolved.png",
    "screenshots/daw-review-2026-09-30-layout.png",
    "reports/ui/debug/home.png",
  ])
    assert.ok(debugCapture(rel), rel);
  for (const rel of ["reports/ui/home--default--phone--light.png", "reports/ios/screens/01-settings.png", "reports/ui/room-detail--empty--phone--dark.png", "reports/ui/add-photos.png"]) assert.ok(!debugCapture(rel), rel);
  const m = buildScreenMap([f("reports/ui/home--default--phone--light.png"), f("docs/evidence/x/screenshots/amp-after.png"), f("reports/ui/t1-photos-web-76daa495.png")], []);
  assert.deepEqual(m.screens.map((s) => s.id), ["home"]);
  assert.equal(m.hidden.count, 2);
  assert.match(m.hidden.reasons[0], /^2 evidence or debug captures/);
});

test("a phone app shows only phone-shaped captures for its own platforms, framed as a phone", () => {
  const espacia = { name: "Espacia", platforms: ["ios", "and"] };
  const m = buildScreenMap(
    [
      f("reports/ui/web/rooms.png", 1, "/r", 1440, 900),
      f("reports/ui/rooms--default--phone--light.png", 1, "/r", 1179, 2556),
      f("reports/ui/room-detail--default--phone--light.png", 1, "/r", 2560, 1440),
      f("reports/ios/screens/settings.png", 1, "/r", 1179, 2556),
      f("reports/ui/ipad-home.png", 1, "/r", 1640, 2360),
    ],
    [],
    espacia,
  );
  assert.equal(m.device, "phone");
  assert.deepEqual(m.screens.map((s) => s.id).sort(), ["home", "rooms", "settings"]);
  assert.equal(m.screens.find((s) => s.id === "rooms")!.variants[0].form, "phone");
  assert.equal(m.screens.find((s) => s.id === "home")!.variants[0].form, "tablet");
  assert.equal(m.screens.find((s) => s.id === "home")!.variants[0].device, "iPad");
  assert.deepEqual(m.hidden.reasons.sort(), ["1 captures for the web, which Espacia does not target", "1 captures shaped like a computer screen; Espacia is a phone app"]);
  // a desktop app keeps its wide captures
  const desk = buildScreenMap([f("reports/ui/editor.png", 1, "/r", 1200, 800)], [], { name: "Ignite Link", platforms: ["mac", "win"] });
  assert.equal(desk.device, "desktop");
  assert.equal(desk.screens.length, 1);
  // the map cannot sneak a computer-shaped capture into a phone app either
  const map = JSON.stringify({ screens: [{ id: "home", image: "reports/ui/home-wide.png" }] });
  const mm = buildScreenMap([f("reports/ui/home-wide.png", 1, "/r", 1920, 1080)], [{ root: "/r", text: map, mtime: 1 }], espacia);
  assert.equal(mm.screens.length, 0);
  assert.equal(mm.hidden.count, 1);
});

test("shapes and devices", () => {
  assert.equal(formOf(1179, 2556, null), "phone");
  assert.equal(formOf(1640, 2360, null), "tablet");
  assert.equal(formOf(1440, 900, null), "wide");
  assert.equal(formOf(null, null, "phone"), "phone");
  assert.equal(formOf(null, null, "1440"), "wide");
  assert.equal(formOf(null, null, null), null);
  assert.equal(deviceFor(["ios"]), "phone");
  assert.equal(deviceFor(["ios", "web"]), "any");
  assert.equal(deviceFor(["web"]), "web");
  assert.equal(deviceFor(["mac", "win"]), "desktop");
});

test("the host reads pixel sizes from image headers", () => {
  const png = Buffer.alloc(32);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(1179, 16);
  png.writeUInt32BE(2556, 20);
  assert.deepEqual(imageSize(png), { w: 1179, h: 2556 });
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x84, 0x05, 0xa0, 0, 0, 0, 0, 0]);
  assert.deepEqual(imageSize(jpg), { w: 1440, h: 900 });
  assert.equal(imageSize(Buffer.from("not an image at all")), null);
});

test("the phone a page was captured on comes from its file name, and pages follow the human's phones", () => {
  const v = (rel: string) => parseScreenFile(f(rel))!;
  assert.deepEqual([v("reports/ui/home--default--iphone-17-pro-max--light.png").id, v("reports/ui/home--default--iphone-17-pro-max--light.png").variant.device], ["home", "iPhone 17 Pro Max"]);
  assert.equal(v("reports/ui/home--default--iphone-17-pro-max--light.png").variant.theme, "light");
  assert.equal(v("reports/ui/home--default--iphone-17-pro-max--light.png").variant.state, "default");
  assert.deepEqual([v("reports/ios/home-iphone-air-dark.png").id, v("reports/ios/home-iphone-air-dark.png").variant.device], ["home", "iPhone Air"]);
  assert.equal(v("reports/ui/settings--default--iphone-17e--light.png").variant.device, "iPhone 17e");
  assert.equal(v("reports/and/feed--default--pixel-9-pro--light.png").variant.device, "Pixel 9 Pro");
  assert.equal(v("reports/ui/home--default--phone--light.png").variant.device, null);
  assert.equal(v("reports/ui/home--default--iphone-air--light.png").variant.form, "phone", "a phone without pixel sizes is still a phone");
  assert.equal(deviceSlug("iPhone 18 Pro"), "iphone-18-pro");
  assert.equal(deviceName("iphone-se-3rd-generation"), "iPhone SE (3rd generation)", "a device in Helm's list keeps its exact name");
  const m = buildScreenMap(
    [f("reports/ui/home--default--iphone-air--light.png"), f("reports/ui/home--default--iphone-17-pro-max--light.png"), f("reports/ui/home--default--iphone-18-pro--light.png"), f("reports/ui/home--default--pixel-9--light.png")],
    [],
    { name: "Espacia", platforms: ["ios", "and"], devices: ["iPhone 18 Pro", "iPhone 17 Pro Max", "iPhone Air"] },
  );
  assert.deepEqual(m.devices, ["iPhone 18 Pro", "iPhone 17 Pro Max", "iPhone Air", "Pixel 9"]);
  assert.deepEqual(m.screens[0].variants.map((x) => x.device), ["iPhone 18 Pro", "iPhone 17 Pro Max", "iPhone Air", "Pixel 9"]);
});

test("devices: the human picks from Helm's list; each app gets its platform's; file names map to the exact model", async () => {
  const { cleanDevices, devicesForPlatforms, DEFAULT_DEVICES } = await import("../../src/shared/devices.ts");
  assert.equal(DEFAULT_DEVICES.length, 6);
  assert.deepEqual(cleanDevices(["pixel 9", "iPhone Air", "iPhone 99 Ultra"]), ["iPhone Air", "Pixel 9"], "catalog order, unknown names dropped");
  assert.deepEqual(cleanDevices([]), DEFAULT_DEVICES);
  assert.deepEqual(devicesForPlatforms(["iPhone Air", "Pixel 9", "iPad mini (A17 Pro)"], ["ios"]), ["iPhone Air", "iPad mini (A17 Pro)"]);
  assert.deepEqual(devicesForPlatforms(["iPhone Air"], ["and"]), ["Pixel 9", "Samsung Galaxy S25"], "none picked for Android: its default phones");
  assert.deepEqual(devicesForPlatforms(["iPhone Air"], ["mac"]), []);
  assert.equal(deviceName("iphone-se-3rd-generation"), "iPhone SE (3rd generation)");
  assert.equal(parseScreenFile(f("reports/ui/home--default--samsung-galaxy-s25--light.png"))!.variant.device, "Samsung Galaxy S25");
  assert.equal(parseScreenFile(f("reports/ui/home--default--ipad-pro-11-inch-m5--light.png"))!.variant.device, "iPad Pro 11-inch (M5)");
  assert.equal(parseScreenFile(f("reports/ui/home--default--ipad-pro-11-inch-m5--light.png"))!.variant.form, "tablet");
  const desk = parseScreenFile(f("reports/ui/home--default--1440x900--light.png"))!;
  assert.equal(desk.variant.size, "1440x900");
  assert.equal(desk.variant.device, null);
});
