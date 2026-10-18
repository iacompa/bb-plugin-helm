// The simulator view's page: one self-contained HTML document served by Helm's HTTP route
// and opened in BB's in-app browser. No external assets; every string from the server is
// set with textContent. Frames are fetched one at a time (the next only after the last
// arrived) and only while the page is visible.

export const SIM_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Helm · Simulators</title>
<style>
:root { color-scheme: dark light; --bg:#0f1115; --panel:#171a21; --line:#272b35; --text:#e6e8ee; --dim:#9aa1b2; --acc:#6ea8fe; --ok:#3fb950; --warn:#d29922; --bad:#f85149; }
@media (prefers-color-scheme: light) { :root { --bg:#f6f7f9; --panel:#fff; --line:#e3e6eb; --text:#1d2330; --dim:#5d6678; --acc:#2563eb; } }
* { box-sizing: border-box; }
body { margin:0; font:13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); height:100vh; display:flex; flex-direction:column; }
header { display:flex; gap:8px; align-items:center; padding:8px 12px; border-bottom:1px solid var(--line); background:var(--panel); flex-wrap:wrap; }
header h1 { font-size:13px; margin:0 8px 0 0; font-weight:600; }
select, input, button { font:inherit; color:inherit; background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:4px 8px; }
button { cursor:pointer; } button:hover { border-color:var(--acc); } button:disabled { opacity:.5; cursor:default; }
button.pri { background:var(--acc); border-color:var(--acc); color:#fff; }
.tabs { display:flex; gap:4px; } .tabs button.on { border-color:var(--acc); color:var(--acc); }
main { flex:1; display:flex; min-height:0; }
aside { width:280px; border-right:1px solid var(--line); overflow:auto; padding:10px; background:var(--panel); }
aside h2 { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); margin:14px 0 6px; }
.row { display:flex; align-items:center; gap:6px; padding:6px; border-radius:6px; border:1px solid transparent; }
.row.sel { border-color:var(--acc); } .row:hover { background:var(--bg); }
.row .grow { flex:1; min-width:0; } .row .t { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; } .row .d { color:var(--dim); font-size:11px; }
.dot { width:8px; height:8px; border-radius:50%; background:var(--line); flex:none; } .dot.on { background:var(--ok); }
section.stage { flex:1; display:flex; flex-direction:column; align-items:center; min-width:0; padding:12px; gap:10px; overflow:auto; }
.controls { display:flex; gap:6px; flex-wrap:wrap; justify-content:center; }
.screen { position:relative; flex:1; min-height:0; display:flex; align-items:center; justify-content:center; width:100%; }
.screen img { max-width:100%; max-height:100%; border-radius:18px; box-shadow:0 8px 30px rgba(0,0,0,.35); user-select:none; -webkit-user-drag:none; background:#000; }
.screen img.mac { border-radius:8px; }
.screen.touch img { cursor:crosshair; }
.msg { color:var(--dim); text-align:center; max-width:460px; }
.msg b { color:var(--text); }
.gallery { display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:10px; width:100%; }
.gallery figure { margin:0; background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
.gallery img { width:100%; display:block; background:#000; } .gallery figcaption { padding:6px 8px; font-size:11px; color:var(--dim); word-break:break-all; }
#status { margin-left:auto; color:var(--dim); font-size:12px; } #status.bad { color:var(--bad); } #status.ok { color:var(--ok); }
.fps { color:var(--dim); font-size:11px; }
</style>
</head>
<body>
<header>
  <h1>Simulators</h1>
  <select id="run" aria-label="Run"></select>
  <select id="app" aria-label="App"></select>
  <div class="tabs" id="tabs" role="tablist" aria-label="Platform"></div>
  <span id="status" role="status"></span>
</header>
<main>
  <aside>
    <div id="devwrap"><h2 id="devhead">Devices</h2><div id="devices"></div></div>
    <h2 id="buildhead">Builds</h2>
    <div id="builds"></div>
    <div style="margin-top:6px"><button id="refreshBuilds">Refresh builds</button></div>
  </aside>
  <section class="stage">
    <div class="controls" id="controls"></div>
    <div class="screen" id="screen"><div class="msg" id="msg">Loading…</div></div>
    <div class="fps" id="fps"></div>
  </section>
</main>
<script>
(function () {
  var base = location.pathname.replace(/\\/sim\\/?$/, "/sim");
  var q = new URLSearchParams(location.search);
  var S = { runId: q.get("run"), appId: q.get("app"), platform: q.get("p"), device: null, state: null, builds: [], frameOn: false, touch: false, lastUrl: null };
  var $ = function (id) { return document.getElementById(id); };
  var LABEL = { ios: "iOS", and: "Android", mac: "macOS", win: "Windows" };

  function el(tag, props, kids) {
    var n = document.createElement(tag);
    for (var k in props || {}) { if (k === "text") n.textContent = props[k]; else if (k === "cls") n.className = props[k]; else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), props[k]); else n.setAttribute(k, props[k]); }
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function status(t, kind) { var s = $("status"); s.textContent = t || ""; s.className = kind || ""; }
  function get(path, params) {
    var u = new URL(base + path, location.href);
    for (var k in params || {}) if (params[k] != null) u.searchParams.set(k, params[k]);
    return fetch(u, { cache: "no-store" });
  }
  function post(body) {
    return fetch(base + "/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ runId: S.runId, appId: S.appId, platform: S.platform, id: S.device }, body)) })
      .then(function (r) { return r.json(); });
  }
  function act(body, quiet) {
    if (!quiet) status("Working…");
    return post(body).then(function (r) { status(r.message, r.ok ? "ok" : "bad"); return r; }, function (e) { status(String(e), "bad"); });
  }

  function load() {
    status("Loading…");
    return get("/state", { run: S.runId }).then(function (r) { return r.json(); }).then(function (st) {
      if (st.error) { status(st.error, "bad"); return; }
      S.state = st; S.runId = st.runId;
      var run = $("run"); run.textContent = "";
      if (!st.runs.length) run.appendChild(el("option", { text: "No running run" }));
      st.runs.forEach(function (r) { var o = el("option", { value: r.id, text: r.name }); if (r.id === S.runId) o.selected = true; run.appendChild(o); });
      var app = $("app"); app.textContent = "";
      if (!st.apps.length) app.appendChild(el("option", { text: "No apps with platforms" }));
      if (!st.apps.some(function (a) { return a.id === S.appId; })) S.appId = st.apps[0] ? st.apps[0].id : null;
      st.apps.forEach(function (a) { var o = el("option", { value: a.id, text: a.name + " · " + a.stage }); if (a.id === S.appId) o.selected = true; app.appendChild(o); });
      status("");
      pickApp();
    }, function (e) { status("Helm did not answer: " + e, "bad"); });
  }

  function curApp() { return S.state && S.state.apps.find(function (a) { return a.id === S.appId; }); }

  function pickApp() {
    var a = curApp();
    var plats = a ? a.platforms : ["ios", "and", "mac", "win"];
    if (plats.indexOf(S.platform) < 0) S.platform = plats[0] || "ios";
    var tabs = $("tabs"); tabs.textContent = "";
    plats.forEach(function (p) { tabs.appendChild(el("button", { cls: p === S.platform ? "on" : "", role: "tab", "aria-selected": String(p === S.platform), text: LABEL[p], onclick: function () { S.platform = p; S.device = null; pickApp(); } })); });
    renderDevices();
    loadBuilds();
    renderControls();
    restartFrames();
  }

  function devicesFor(p) {
    var d = S.state && S.state.devices;
    if (!d) return [];
    if (p === "ios") return d.ios; if (p === "and") return d.and;
    if (p === "mac") return d.host === "darwin" ? [{ id: "local", name: "This Mac", detail: "the app runs natively", booted: true }] : [];
    return [];
  }

  function renderDevices() {
    var box = $("devices"); box.textContent = "";
    var p = S.platform, list = devicesFor(p), t = S.state ? S.state.devices.tools : {};
    $("devwrap").style.display = p === "win" ? "none" : "";
    if (p === "ios" && !t.simctl) box.appendChild(el("div", { cls: "msg", text: "iOS simulators need Xcode on a Mac host." }));
    if (p === "and" && !t.adb) box.appendChild(el("div", { cls: "msg", text: "Android needs the Android SDK (platform-tools and emulator) on this host." }));
    if (!S.device || !list.some(function (d) { return d.id === S.device; })) { var b = list.find(function (d) { return d.booted; }) || list[0]; S.device = b ? b.id : null; }
    list.slice(0, 30).forEach(function (d) {
      var row = el("div", { cls: "row" + (d.id === S.device ? " sel" : ""), onclick: function () { S.device = d.id; renderDevices(); renderControls(); restartFrames(); } }, [
        el("span", { cls: "dot" + (d.booted ? " on" : ""), title: d.booted ? "running" : "off" }),
        el("div", { cls: "grow" }, [el("div", { cls: "t", text: d.name }), el("div", { cls: "d", text: d.detail })]),
        p === "mac" ? null : el("button", { text: d.booted ? "Stop" : "Start", onclick: function (ev) { ev.stopPropagation(); S.device = d.id; act({ action: d.booted ? "shutdown" : "boot" }).then(function () { setTimeout(load, d.booted ? 1500 : 4000); }); } }),
      ]);
      box.appendChild(row);
    });
  }

  function loadBuilds(force) {
    var box = $("builds"); box.textContent = "";
    $("buildhead").textContent = S.platform === "win" ? "Screenshots the Windows builder committed" : "Builds";
    if (!S.runId || !S.appId) return;
    box.appendChild(el("div", { cls: "d", text: "Looking for builds…" }));
    get("/builds", { run: S.runId, app: S.appId, p: S.platform, force: force ? "1" : null }).then(function (r) { return r.json(); }).then(function (res) {
      S.builds = res.builds || []; box.textContent = "";
      if (S.platform === "win") { renderGallery(); return; }
      if (!S.builds.length) box.appendChild(el("div", { cls: "msg", text: "No " + LABEL[S.platform] + " build of this app yet. Builders put them in their worktree (or Xcode's DerivedData); ask the lead for a debug build." }));
      S.builds.forEach(function (b, i) {
        var name = b.path.split("/").slice(-1)[0], when = new Date(b.mtime).toLocaleString();
        box.appendChild(el("div", { cls: "row" }, [
          el("div", { cls: "grow" }, [el("div", { cls: "t", text: name, title: b.path }), el("div", { cls: "d", text: (i === 0 ? "newest · " : "") + when })]),
          el("button", { cls: i === 0 ? "pri" : "", text: S.platform === "mac" ? "Launch" : "Install & run", onclick: function () {
            if (!S.device) { status("Pick a device first.", "bad"); return; }
            act({ action: "install", path: b.path }).then(restartFrames);
          } }),
        ]));
      });
    }, function (e) { box.textContent = ""; box.appendChild(el("div", { cls: "msg", text: String(e) })); });
  }

  function renderGallery() {
    stopFrames();
    var scr = $("screen"); scr.textContent = "";
    if (!S.builds.length) { scr.appendChild(el("div", { cls: "msg", text: "Windows apps cannot run on this Mac, and the Windows builder has not committed screenshots yet (reports/win/…). Its CI run (windows-latest) is where the app is built and tested." })); return; }
    var g = el("div", { cls: "gallery" });
    S.builds.forEach(function (b) {
      var u = new URL(base + "/image", location.href); u.searchParams.set("run", S.runId); u.searchParams.set("app", S.appId); u.searchParams.set("path", b.path);
      g.appendChild(el("figure", {}, [el("img", { src: u.toString(), alt: b.path.split("/").pop(), loading: "lazy" }), el("figcaption", { text: b.path.split("/").slice(-3).join("/") + " · " + new Date(b.mtime).toLocaleString() })]));
    });
    scr.appendChild(g);
    $("fps").textContent = "";
  }

  function renderControls() {
    var c = $("controls"); c.textContent = "";
    var p = S.platform, t = S.state ? S.state.devices.tools : {};
    if (p === "win" || !S.device) return;
    S.touch = p === "and" || (p === "ios" && t.idb);
    var btn = function (label, body, title) { c.appendChild(el("button", { text: label, title: title || label, onclick: function () { act(body); } })); };
    if (p === "and") { btn("◁ Back", { action: "key", key: "back" }); btn("○ Home", { action: "key", key: "home" }); btn("▢ Recents", { action: "key", key: "recents" }); }
    if (p === "ios" && t.idb) btn("Home", { action: "key", key: "home" });
    if (p === "ios" || p === "and") {
      btn("Dark", { action: "appearance", value: "dark" }, "Dark appearance"); btn("Light", { action: "appearance", value: "light" }, "Light appearance");
      btn("Large text", { action: "textSize", value: "large" }, "Largest accessibility text size"); btn("Normal text", { action: "textSize", value: "normal" });
      c.appendChild(el("button", { text: "Open URL…", onclick: function () { var u = prompt("URL or deep link to open in the app:", "https://"); if (u) act({ action: "url", text: u }); } }));
    }
    if (S.touch) {
      var inp = el("input", { placeholder: "Type into the app, Enter to send", "aria-label": "Type text", size: "28" });
      inp.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { if (inp.value) act({ action: "text", text: inp.value }, true); else act({ action: "key", key: "enter" }, true); inp.value = ""; } });
      c.appendChild(inp);
    }
  }

  // ── frames ──
  var frameTimer = null, frameGen = 0, frames = 0, since = Date.now();
  function stopFrames() { frameGen++; S.frameOn = false; if (frameTimer) clearTimeout(frameTimer); }
  function restartFrames() {
    stopFrames();
    if (S.platform === "win") return;
    var scr = $("screen"); scr.textContent = ""; scr.className = "screen" + (S.touch ? " touch" : "");
    if (!S.device) { scr.appendChild(el("div", { cls: "msg", text: S.platform === "mac" ? "macOS apps can only be mirrored on a Mac host." : "No " + LABEL[S.platform] + " device on this host." })); return; }
    var img = el("img", { id: "frame", alt: LABEL[S.platform] + " screen", draggable: "false", cls: S.platform === "mac" ? "mac" : "" });
    img.style.display = "none";
    var msg = el("div", { cls: "msg", id: "msg", text: "Connecting…" });
    scr.appendChild(img); scr.appendChild(msg);
    wireTouch(img);
    S.frameOn = true; frames = 0; since = Date.now();
    tick(frameGen);
  }
  function explain(err) {
    if (err === "not-booted") return S.platform === "ios" ? "This simulator is off. Press Start, then install a build." : "This emulator is off. Press Start (it runs headless; the first boot takes a minute), then install a build.";
    if (err === "not-running") return "The app is not running on this Mac. Press Launch next to a build.";
    if (err === "booting") return "Starting… waiting for the first frame.";
    if (/^screen-recording:/.test(err)) return err.replace(/^screen-recording:\\s*/, "");
    return err;
  }
  function tick(gen) {
    if (gen !== frameGen || !S.frameOn) return;
    if (document.visibilityState !== "visible") { frameTimer = setTimeout(function () { tick(gen); }, 1000); return; }
    var t0 = Date.now();
    get("/frame", { p: S.platform, id: S.device, run: S.runId, app: S.appId }).then(function (r) {
      if (gen !== frameGen) return;
      var ct = r.headers.get("content-type") || "";
      if (!r.ok || ct.indexOf("image/") !== 0) return r.json().then(function (j) { throw new Error(j.error || "no frame"); });
      return r.blob().then(function (b) {
        if (gen !== frameGen) return;
        var img = $("frame"), msg = $("msg");
        var u = URL.createObjectURL(b);
        img.onload = function () { if (S.lastUrl) URL.revokeObjectURL(S.lastUrl); S.lastUrl = u; };
        img.src = u; img.style.display = ""; if (msg) msg.style.display = "none";
        frames++; var s = (Date.now() - since) / 1000; if (s > 3) { $("fps").textContent = (frames / s).toFixed(1) + " fps · " + (S.touch ? "click to tap, drag to swipe" : S.platform === "ios" ? "watch-only (install idb to tap)" : "mirror"); frames = 0; since = Date.now(); }
        frameTimer = setTimeout(function () { tick(gen); }, Math.max(60, 220 - (Date.now() - t0)));
      });
    }).catch(function (e) {
      if (gen !== frameGen) return;
      var img = $("frame"), msg = $("msg");
      if (img) img.style.display = "none";
      if (msg) { msg.style.display = ""; msg.textContent = explain(String(e.message || e)); }
      frameTimer = setTimeout(function () { tick(gen); }, 2500);
    });
  }

  // click → tap, drag → swipe, in 0..1 coordinates of the screen image
  function wireTouch(img) {
    var start = null;
    function pt(ev) { var r = img.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)) }; }
    img.addEventListener("pointerdown", function (ev) { if (!S.touch) return; start = pt(ev); img.setPointerCapture(ev.pointerId); });
    img.addEventListener("pointerup", function (ev) {
      if (!S.touch || !start) return;
      var end = pt(ev), dx = end.x - start.x, dy = end.y - start.y;
      if (Math.sqrt(dx * dx + dy * dy) < 0.02) post({ action: "tap", x: start.x, y: start.y }).then(function (r) { if (!r.ok) status(r.message, "bad"); });
      else post({ action: "swipe", x: start.x, y: start.y, x2: end.x, y2: end.y }).then(function (r) { if (!r.ok) status(r.message, "bad"); });
      start = null;
    });
  }

  $("run").addEventListener("change", function (e) { S.runId = e.target.value; S.appId = null; load(); });
  $("app").addEventListener("change", function (e) { S.appId = e.target.value; S.device = null; pickApp(); });
  $("refreshBuilds").addEventListener("click", function () { loadBuilds(true); });
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible" && S.frameOn) { /* the loop picks up on its own */ } });
  load();
})();
</script>
</body>
</html>`;
