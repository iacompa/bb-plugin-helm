// Host side of the simulator view: lists, boots and drives iOS simulators (simctl),
// Android emulators (adb, headless), and mirrors a macOS app's window. Everything runs
// with execFile (no shell); ids are validated by the contract, and every path the
// server passes in was returned by simBuilds or comes from Helm's own records.

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { homedir, platform, tmpdir } from "node:os";
import type { SimList, SimPlatform } from "../shared/host-contract.ts";

interface Out {
  code: number;
  stdout: Buffer;
  stderr: string;
}

function exec(cmd: string, args: string[], timeoutMs = 20_000): Promise<Out> {
  return new Promise((res) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 127) : 0;
      res({ code, stdout: stdout ?? Buffer.alloc(0), stderr: String(stderr ?? "") });
    });
  });
}
const text = async (cmd: string, args: string[], timeoutMs?: number) => {
  const r = await exec(cmd, args, timeoutMs);
  return { code: r.code, out: r.stdout.toString("utf8"), err: r.stderr };
};
const firstLine = (s: string) => s.trim().split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 300) ?? "";

const sdkRoot = () => process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(homedir(), "Library", "Android", "sdk");
const ADB = () => join(sdkRoot(), "platform-tools", platform() === "win32" ? "adb.exe" : "adb");
const EMULATOR = () => join(sdkRoot(), "emulator", platform() === "win32" ? "emulator.exe" : "emulator");
const isMac = () => platform() === "darwin";

async function which(cmd: string): Promise<string | null> {
  const r = await text(platform() === "win32" ? "where" : "/usr/bin/which", [cmd], 5_000);
  return r.code === 0 ? r.out.trim().split("\n")[0] || null : null;
}

// ───────── Android ─────────

interface AdbDevice {
  serial: string;
  avd: string | null;
  model: string;
}

async function adbDevices(): Promise<AdbDevice[]> {
  if (!existsSync(ADB())) return [];
  const r = await text(ADB(), ["devices", "-l"], 15_000);
  const out: AdbDevice[] = [];
  for (const line of r.out.split("\n").slice(1)) {
    const m = line.match(/^(\S+)\s+device\b(.*)$/);
    if (!m) continue;
    const serial = m[1];
    const model = m[2].match(/model:(\S+)/)?.[1]?.replace(/_/g, " ") ?? serial;
    let avd: string | null = null;
    if (serial.startsWith("emulator-")) avd = firstLine((await text(ADB(), ["-s", serial, "emu", "avd", "name"], 5_000)).out.replace(/\r/g, "").replace(/\nOK\s*$/, "")) || null;
    out.push({ serial, avd, model });
  }
  return out;
}

/** An Android id is an AVD name (booted or not) or an adb serial. */
async function serialFor(id: string): Promise<string | null> {
  const devs = await adbDevices();
  return devs.find((d) => d.serial === id || d.avd === id)?.serial ?? null;
}

const sizeCache = new Map<string, { w: number; h: number; at: number }>();
async function androidSize(serial: string): Promise<{ w: number; h: number }> {
  const c = sizeCache.get(serial);
  if (c && Date.now() - c.at < 60_000) return c;
  const r = await text(ADB(), ["-s", serial, "shell", "wm", "size"], 8_000);
  const all = [...r.out.matchAll(/(\d+)x(\d+)/g)];
  const m = all[all.length - 1]; // "Override size" wins over "Physical size"
  const v = { w: m ? Number(m[1]) : 1080, h: m ? Number(m[2]) : 2400, at: Date.now() };
  sizeCache.set(serial, v);
  return v;
}

const quoteForDeviceShell = (s: string) => `'${s.replace(/'/g, `'\\''`).replace(/ /g, "%s")}'`;

// ───────── macOS window capture ─────────

/** The on-screen window number of the largest window owned by an app whose name matches. */
async function macWindowId(match: string): Promise<number | null> {
  const script = `ObjC.import('CoreGraphics');
var list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0));
var want = ${JSON.stringify(norm(match))}; var best = null; var area = 0;
for (var i = 0; i < list.count; i++) {
  var w = list.objectAtIndex(i);
  var owner = ObjC.unwrap(w.objectForKey('kCGWindowOwnerName')) || '';
  var layer = ObjC.unwrap(w.objectForKey('kCGWindowLayer'));
  var b = ObjC.deepUnwrap(w.objectForKey('kCGWindowBounds')) || {};
  var o = String(owner).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (layer !== 0 || !o || (o.indexOf(want) < 0 && want.indexOf(o) < 0)) continue;
  var a = (b.Width || 0) * (b.Height || 0);
  if (a > area) { area = a; best = ObjC.unwrap(w.objectForKey('kCGWindowNumber')); }
}
best === null ? '' : String(best);`;
  const r = await text("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], 10_000);
  const n = Number(r.out.trim());
  return r.code === 0 && Number.isFinite(n) && n > 0 ? n : null;
}
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// ───────── frames ─────────

/** Downscale and re-encode with sips (macOS), else return the file as it is. */
async function toJpeg(file: string, dir: string): Promise<{ data: string; mime: string }> {
  if (isMac()) {
    const outFile = join(dir, "frame.jpg");
    const r = await exec("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "70", "-Z", "1100", file, "--out", outFile], 15_000);
    if (r.code === 0) return { data: (await readFile(outFile)).toString("base64"), mime: "image/jpeg" };
  }
  const ext = extname(file).toLowerCase();
  return { data: (await readFile(file)).toString("base64"), mime: ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png" };
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "helm-sim-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ───────── builds ─────────

const SKIP = new Set(["node_modules", ".git", ".gradle", "Pods", ".build", "SourcePackages", "Index.noindex", "ModuleCache.noindex", ".helm", ".worktrees"]);

/** Breadth-limited walk: calls `hit` for directories/files that match; never descends into an .app. */
async function walk(root: string, depth: number, hit: (path: string, name: string, isDir: boolean) => boolean, deadline: number): Promise<void> {
  if (depth < 0 || Date.now() > deadline) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of entries) {
    if (Date.now() > deadline) return;
    if (SKIP.has(d.name)) continue;
    const p = join(root, d.name);
    if (hit(p, d.name, d.isDirectory())) continue;
    if (d.isDirectory() && !d.name.endsWith(".app") && !d.name.endsWith(".xcarchive")) await walk(p, depth - 1, hit, deadline);
  }
}

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

async function plistValue(plist: string, key: string): Promise<string | null> {
  const r = await text("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], 5_000);
  return r.code === 0 ? r.out.trim() || null : null;
}

async function aapt(): Promise<string | null> {
  const bt = join(sdkRoot(), "build-tools");
  try {
    const vs = (await readdir(bt)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of vs) if (existsSync(join(bt, v, "aapt"))) return join(bt, v, "aapt");
  } catch {}
  return null;
}

// ───────── the ops ─────────

export function createSimOps() {
  return {
    async simList(_input?: Record<string, never>): Promise<SimList> {
      const mac = isMac();
      const [idb, adbOk, emuOk] = [mac ? await which("idb") : null, existsSync(ADB()), existsSync(EMULATOR())];
      const ios: SimList["ios"] = [];
      if (mac) {
        const r = await text("/usr/bin/xcrun", ["simctl", "list", "devices", "available", "-j"], 20_000);
        try {
          const devices = (JSON.parse(r.out) as { devices: Record<string, Array<{ udid: string; name: string; state: string }>> }).devices;
          for (const [runtime, list] of Object.entries(devices)) {
            if (!/iOS/i.test(runtime)) continue;
            const rt = runtime.split(".").pop()!.replace(/^iOS-/, "iOS ").replace(/-/g, ".");
            for (const d of list) ios.push({ id: d.udid, name: d.name, detail: rt, booted: d.state === "Booted" });
          }
        } catch {}
        ios.sort((a, b) => Number(b.booted) - Number(a.booted) || Number(/iPhone/.test(b.name)) - Number(/iPhone/.test(a.name)) || b.detail.localeCompare(a.detail, undefined, { numeric: true }));
      }
      const and: SimList["and"] = [];
      const devs = adbOk ? await adbDevices() : [];
      if (emuOk) {
        const avds = (await text(EMULATOR(), ["-list-avds"], 15_000)).out.split("\n").map((s) => s.trim()).filter((s) => /^[\w.-]+$/.test(s));
        for (const a of avds) {
          const d = devs.find((x) => x.avd === a);
          and.push({ id: a, name: a.replace(/_/g, " "), detail: d ? `emulator · ${d.serial}` : "emulator", booted: !!d });
        }
      }
      for (const d of devs) if (!d.avd) and.push({ id: d.serial, name: d.model, detail: `device · ${d.serial}`, booted: true });
      return { host: platform(), ios: ios.slice(0, 40), and, tools: { simctl: mac, adb: adbOk, emulator: emuOk, idb: !!idb, screencapture: mac } };
    },

    async simBoot({ platform: p, id }: { platform: SimPlatform; id: string }) {
      if (p === "ios") {
        const r = await text("/usr/bin/xcrun", ["simctl", "boot", id], 60_000);
        const ok = r.code === 0 || /current state: Booted/i.test(r.err);
        return { ok, message: ok ? "Booting the simulator…" : firstLine(r.err) || "simctl boot failed" };
      }
      if (p === "and") {
        if (await serialFor(id)) return { ok: true, message: "Already running." };
        if (!existsSync(EMULATOR())) return { ok: false, message: "The Android emulator is not installed (Android SDK → emulator)." };
        // headless: the only screen is Helm's view
        const child = spawn(EMULATOR(), ["-avd", id, "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot-save"], { detached: true, stdio: "ignore" });
        child.unref();
        return { ok: true, message: "Starting the emulator (headless)… the first boot takes a minute." };
      }
      return { ok: false, message: p === "mac" ? "Install a build to launch the app on this Mac." : "Windows apps cannot run on this Mac." };
    },

    async simShutdown({ platform: p, id }: { platform: SimPlatform; id: string }) {
      if (p === "ios") {
        const r = await text("/usr/bin/xcrun", ["simctl", "shutdown", id], 60_000);
        return { ok: r.code === 0, message: r.code === 0 ? "Shut down." : firstLine(r.err) };
      }
      if (p === "and") {
        const s = await serialFor(id);
        if (!s) return { ok: true, message: "Not running." };
        const r = await text(ADB(), ["-s", s, "emu", "kill"], 15_000);
        return { ok: r.code === 0, message: r.code === 0 ? "Shut down." : firstLine(r.err) };
      }
      return { ok: false, message: "Nothing to shut down." };
    },

    async simFrame({ platform: p, id, match }: { platform: SimPlatform; id: string; match?: string }) {
      return withTmp(async (dir) => {
        if (p === "ios") {
          const file = join(dir, "s.png");
          const r = await exec("/usr/bin/xcrun", ["simctl", "io", id, "screenshot", "--type=png", file], 20_000);
          if (r.code !== 0) return { data: null, mime: "", error: /No devices are booted|Unable to lookup|not booted|Shutdown/i.test(r.stderr) ? "not-booted" : firstLine(r.stderr) || "screenshot failed" };
          return { ...(await toJpeg(file, dir)), error: null };
        }
        if (p === "and") {
          const s = await serialFor(id);
          if (!s) return { data: null, mime: "", error: "not-booted" };
          const r = await exec(ADB(), ["-s", s, "exec-out", "screencap", "-p"], 20_000);
          if (r.code !== 0 || r.stdout.length < 100) return { data: null, mime: "", error: firstLine(r.stderr) || "booting" };
          const file = join(dir, "s.png");
          await writeFile(file, r.stdout);
          return { ...(await toJpeg(file, dir)), error: null };
        }
        if (p === "mac") {
          if (!isMac()) return { data: null, mime: "", error: "macOS apps can only be mirrored on a Mac host." };
          if (!match) return { data: null, mime: "", error: "not-running" };
          const wid = await macWindowId(match);
          if (!wid) return { data: null, mime: "", error: "not-running" };
          const file = join(dir, "w.png");
          const r = await exec("/usr/sbin/screencapture", ["-x", "-o", `-l${wid}`, "-t", "png", file], 15_000);
          if (r.code !== 0 || !existsSync(file)) return { data: null, mime: "", error: "screen-recording: macOS blocked the capture. Allow BB in System Settings → Privacy & Security → Screen & System Audio Recording, then restart BB." };
          return { ...(await toJpeg(file, dir)), error: null };
        }
        return { data: null, mime: "", error: "Windows apps cannot run on this Mac; see the screenshots the Windows builder committed." };
      });
    },

    async simInput(i: { platform: SimPlatform; id: string; action: string; x?: number; y?: number; x2?: number; y2?: number; text?: string; key?: string; value?: string }) {
      const ok = (message: string) => ({ ok: true, message });
      const fail = (message: string) => ({ ok: false, message });
      if (i.platform === "and") {
        const s = await serialFor(i.id);
        if (!s) return fail("The emulator is not running.");
        const run = async (args: string[]) => {
          const r = await text(ADB(), ["-s", s, "shell", ...args], 15_000);
          return r.code === 0 ? ok("done") : fail(firstLine(r.err) || "adb failed");
        };
        const { w, h } = await androidSize(s);
        const px = (v?: number) => String(Math.round((v ?? 0.5) * w));
        const py = (v?: number) => String(Math.round((v ?? 0.5) * h));
        switch (i.action) {
          case "tap":
            return run(["input", "tap", px(i.x), py(i.y)]);
          case "swipe":
            return run(["input", "swipe", px(i.x), py(i.y), px(i.x2), py(i.y2), "250"]);
          case "text":
            return i.text ? run([`input text ${quoteForDeviceShell(i.text)}`]) : fail("No text.");
          case "key": {
            const code = { back: "4", home: "3", recents: "187", enter: "66", delete: "67" }[i.key ?? "back"]!;
            return run(["input", "keyevent", code]);
          }
          case "appearance":
            return run(["cmd", "uimode", "night", i.value === "dark" ? "yes" : "no"]);
          case "textSize":
            return run(["settings", "put", "system", "font_scale", i.value === "large" ? "1.6" : "1.0"]);
          case "url":
            return i.text && /^[a-z][\w+.-]*:\S+$/i.test(i.text) ? run(["am", "start", "-a", "android.intent.action.VIEW", "-d", quoteForDeviceShell(i.text).replace(/%s/g, " ")]) : fail("Give a URL like https://… or myapp://…");
        }
        return fail("Not supported on Android.");
      }
      if (i.platform === "ios") {
        const sim = async (args: string[]) => {
          const r = await text("/usr/bin/xcrun", ["simctl", ...args], 20_000);
          return r.code === 0 ? ok("done") : fail(firstLine(r.err) || "simctl failed");
        };
        switch (i.action) {
          case "appearance":
            return sim(["ui", i.id, "appearance", i.value === "dark" ? "dark" : "light"]);
          case "textSize":
            return sim(["ui", i.id, "content_size", i.value === "large" ? "accessibility-extra-large" : "large"]);
          case "url":
            return i.text && /^[a-z][\w+.-]*:\S+$/i.test(i.text) ? sim(["openurl", i.id, i.text]) : fail("Give a URL like https://… or myapp://…");
          case "tap":
          case "swipe":
          case "text":
          case "key": {
            const idb = await which("idb");
            if (!idb) return fail("Tapping an iOS simulator needs idb (Facebook's iOS Development Bridge). Without it the view is watch-only; use the buttons or Simulator.app.");
            const desc = await text(idb, ["describe", "--udid", i.id, "--json"], 10_000);
            let pw = 390, ph = 844;
            try {
              const sd = (JSON.parse(desc.out) as { screen_dimensions?: { width_points?: number; height_points?: number } }).screen_dimensions;
              if (sd?.width_points && sd.height_points) [pw, ph] = [sd.width_points, sd.height_points];
            } catch {}
            const X = (v?: number) => String(Math.round((v ?? 0.5) * pw));
            const Y = (v?: number) => String(Math.round((v ?? 0.5) * ph));
            const args =
              i.action === "tap" ? ["ui", "tap", X(i.x), Y(i.y)]
              : i.action === "swipe" ? ["ui", "swipe", X(i.x), Y(i.y), X(i.x2), Y(i.y2)]
              : i.action === "text" ? ["ui", "text", i.text ?? ""]
              : i.key === "home" ? ["ui", "button", "HOME"] : null;
            if (!args) return fail("That key has no iOS equivalent.");
            const r = await text(idb, [...args, "--udid", i.id], 15_000);
            return r.code === 0 ? ok("done") : fail(firstLine(r.err) || "idb failed");
          }
        }
        return fail("Not supported on iOS.");
      }
      return fail(i.platform === "mac" ? "Use the app's own window on this Mac to interact with it." : "Windows apps cannot run on this Mac.");
    },

    async simBuilds({ platform: p, roots, names }: { platform: SimPlatform; roots: string[]; names: string[] }) {
      const found = new Map<string, number>();
      const deadline = Date.now() + 12_000;
      const add = async (path: string) => {
        if (found.has(path)) return;
        try {
          found.set(path, (await stat(path)).mtimeMs);
        } catch {}
      };
      const pending: Array<Promise<void>> = [];
      const hit = (path: string, name: string, isDir: boolean): boolean => {
        if (p === "ios" && isDir && name.endsWith(".app") && /-iphonesimulator$/.test(basename(join(path, "..")))) return pending.push(add(path)), true;
        if (p === "mac" && isDir && name.endsWith(".app") && /\/Build\/Products\/(Debug|Release)[^/]*$/.test(join(path, "..")) && !/iphone|appletv|watch|xr/i.test(basename(join(path, "..")))) return pending.push(add(path)), true;
        if (p === "and" && !isDir && name.endsWith(".apk") && /\/outputs\/apk\//.test(path) && !/androidTest|-unsigned/.test(name)) return pending.push(add(path)), true;
        if (p === "win" && !isDir && IMAGE.test(name) && /\/(reports\/win|evidence|screenshots)\//i.test(path)) return pending.push(add(path)), true;
        return false;
      };
      for (const r of roots) if (existsSync(r)) await walk(r, 9, hit, deadline);
      if ((p === "ios" || p === "mac") && isMac()) {
        const dd = join(homedir(), "Library", "Developer", "Xcode", "DerivedData");
        const wanted = names.map(norm).filter(Boolean);
        try {
          for (const d of await readdir(dd)) {
            const n = norm(d.replace(/-[a-z]{28}$/, ""));
            if (wanted.some((w) => n === w || n.startsWith(w))) await walk(join(dd, d, "Build", "Products"), 2, hit, deadline);
          }
        } catch {}
      }
      await Promise.all(pending);
      const builds = [...found.entries()].sort((a, b) => b[1] - a[1]).slice(0, p === "win" ? 40 : 8).map(([path, mtime]) => ({ path, mtime, kind: (p === "and" ? "apk" : p === "win" ? "image" : "app") as "app" | "apk" | "image" }));
      return { builds };
    },

    async simInstall({ platform: p, id, path }: { platform: SimPlatform; id: string; path: string }) {
      if (!existsSync(path)) return { ok: false, message: "That build is gone.", match: null };
      if (p === "ios") {
        const bundle = await plistValue(join(path, "Info.plist"), "CFBundleIdentifier");
        if (!bundle) return { ok: false, message: "Not an app bundle (no CFBundleIdentifier).", match: null };
        let r = await text("/usr/bin/xcrun", ["simctl", "install", id, path], 120_000);
        if (r.code !== 0) return { ok: false, message: firstLine(r.err) || "install failed", match: null };
        r = await text("/usr/bin/xcrun", ["simctl", "launch", "--terminate-running-process", id, bundle], 60_000);
        return { ok: r.code === 0, message: r.code === 0 ? `Installed and launched ${bundle}.` : firstLine(r.err), match: null };
      }
      if (p === "and") {
        const s = await serialFor(id);
        if (!s) return { ok: false, message: "Start the emulator first.", match: null };
        let r = await text(ADB(), ["-s", s, "install", "-r", "-t", path], 180_000);
        if (r.code !== 0) return { ok: false, message: firstLine(r.err || r.out) || "install failed", match: null };
        const tool = await aapt();
        const pkg = tool ? (await text(tool, ["dump", "badging", path], 20_000)).out.match(/package: name='([^']+)'/)?.[1] : null;
        if (!pkg) return { ok: true, message: "Installed; open it from the launcher.", match: null };
        r = await text(ADB(), ["-s", s, "shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"], 20_000);
        return { ok: r.code === 0, message: r.code === 0 ? `Installed and launched ${pkg}.` : firstLine(r.err), match: null };
      }
      if (p === "mac") {
        const r = await text("/usr/bin/open", ["-n", path], 30_000);
        const name = (await plistValue(join(path, "Contents", "Info.plist"), "CFBundleExecutable")) ?? basename(path, ".app");
        return { ok: r.code === 0, message: r.code === 0 ? `Launched ${basename(path)} on this Mac.` : firstLine(r.err), match: name };
      }
      return { ok: false, message: "Windows builds cannot be installed on this Mac.", match: null };
    },

    async simImage({ path }: { path: string }) {
      const ext = extname(path).toLowerCase();
      if (!MIME[ext] || !existsSync(path)) return { data: null, mime: "" };
      const st = await stat(path);
      if (!st.isFile() || st.size > 8 * 1024 * 1024) return { data: null, mime: "" };
      return { data: (await readFile(path)).toString("base64"), mime: MIME[ext] };
    },
  };
}
