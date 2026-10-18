// The Screens view: click through an app's screens like a tiny browser. Nothing runs. Each page
// is a screenshot the builders committed, shown in a phone or tablet frame when it is one, and
// tappable areas from the screen map (reports/screens/screens.json) jump to the page they lead
// to. The server keeps out what is not the app's UI (evidence, debug shots, other platforms).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHelm } from "./ctx.tsx";
import { Banner, Ic, Modal, ModalHead, askConfirm, cx } from "./ui.tsx";
import { leadOf } from "./store.ts";
import { errMsg } from "./format.ts";
import { toast } from "sonner";

interface Variant {
  path: string;
  rel: string;
  platform: string | null;
  size: string | null;
  theme: string | null;
  state: string | null;
  form: "phone" | "tablet" | "wide" | null;
  device: string | null;
}
interface Link {
  to: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string | null;
}
interface Screen {
  id: string;
  name: string;
  note: string | null;
  variants: Variant[];
  links: Link[];
}
interface ScreenMap {
  start: string | null;
  screens: Screen[];
  source: "map" | "files";
  problems: string[];
  device: "phone" | "desktop" | "web" | "any";
  devices: string[];
  hidden: { count: number; reasons: string[] };
}
interface AppRow {
  id: string;
  name: string;
}
interface DeviceSpec {
  name: string;
  os: "ios" | "android";
  form: "phone" | "tablet";
  w: number;
  h: number;
}
interface Devices {
  catalog: DeviceSpec[];
  picked: string[];
  forApp: string[];
  max: number;
}
interface ListResult {
  apps: AppRow[];
  appId: string | null;
  map: ScreenMap | null;
  devices?: Devices;
}

const PLATFORM: Record<string, string> = { ui: "Design", ios: "iOS", and: "Android", mac: "macOS", win: "Windows", web: "Web", unreal: "Unreal", game: "Game" };

export function ScreensModal() {
  const h = useHelm();
  if (!h.screensOpen) return null;
  return <ScreensInner />;
}

function ScreensInner() {
  const h = useHelm();
  const runId = h.data?.run?.id ?? null;
  const [appId, setAppId] = useState<string | null>(null);
  const [res, setRes] = useState<ListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cur, setCur] = useState<string | null>(null);
  const [hist, setHist] = useState<{ back: string[]; fwd: string[] }>({ back: [], fwd: [] });
  const [pref, setPref] = useState<{ platform: string | null; theme: string | null; size: string | null; device: string | null }>({ platform: null, theme: null, size: null, device: null });
  const [allPhones, setAllPhones] = useState(false);
  const [showAreas, setShowAreas] = useState(false);
  const [picking, setPicking] = useState(false);
  const images = useRef(new Map<string, string | null>());
  const [, bump] = useState(0);

  const load = useCallback(
    async (id: string | null, fresh = false) => {
      if (!runId) return;
      setLoading(true);
      setErr(null);
      try {
        const r = (await h.rpc.call("screens_list", { runId, appId: id, fresh })) as ListResult;
        setRes(r);
        setAppId(r.appId);
        setCur((c) => (c && r.map?.screens.some((s) => s.id === c) ? c : r.map?.start ?? null));
        if (fresh) images.current.clear();
      } catch (e) {
        setErr(errMsg(e));
      } finally {
        setLoading(false);
      }
    },
    [h.rpc, runId],
  );

  useEffect(() => {
    void load(h.screensApp);
  }, [load, h.screensApp]);

  const map = res?.map ?? null;
  const screens = map?.screens ?? [];
  const screen = screens.find((s) => s.id === cur) ?? null;

  // what the variant pickers can offer, across the app
  const facets = useMemo(() => {
    const all = screens.flatMap((s) => s.variants);
    const uniq = (k: "platform" | "theme" | "size") => [...new Set(all.map((v) => v[k]).filter((x): x is string => !!x))];
    return { platform: uniq("platform"), theme: uniq("theme"), size: uniq("size") };
  }, [screens]);

  // the phone shown by default: the human's first phone that has captures
  useEffect(() => {
    if (map?.devices.length && (!pref.device || !map.devices.includes(pref.device))) setPref((p) => ({ ...p, device: map.devices[0] }));
  }, [map, pref.device]);

  const score = useCallback(
    (v: Variant, device: string | null) => (device && v.device === device ? 8 : 0) + (pref.platform && v.platform === pref.platform ? 4 : 0) + (pref.theme && v.theme === pref.theme ? 2 : 0) + (pref.size && v.size === pref.size ? 1 : 0),
    [pref],
  );
  const pick = useCallback((s: Screen | null, device: string | null) => (s?.variants.length ? [...s.variants].sort((a, b) => score(b, device) - score(a, device))[0] : null), [score]);
  const variant = useMemo(() => pick(screen, pref.device), [pick, screen, pref.device]);
  // side by side: this page on each phone that has it
  const phones = useMemo(
    () =>
      allPhones && map
        ? map.devices
            .map((d) => ({ device: d, v: pick(screen, d) }))
            .filter((x): x is { device: string; v: Variant } => !!x.v && x.v.device === x.device)
        : [],
    [allPhones, map, screen, pick],
  );

  // load the shown images (and keep them for the session)
  const want = useMemo(() => (phones.length ? phones.map((x) => x.v.path) : variant ? [variant.path] : []), [phones, variant]);
  useEffect(() => {
    if (!runId || !appId) return;
    for (const path of want) {
      if (images.current.has(path)) continue;
      images.current.set(path, null);
      void (h.rpc.call("screens_image", { runId, appId, path }) as Promise<{ dataUrl: string | null }>)
        .then((r) => images.current.set(path, r.dataUrl ?? ""))
        .catch(() => images.current.set(path, ""))
        .finally(() => bump((x) => x + 1));
    }
  }, [h.rpc, runId, appId, want]);

  // ask the app's lead for fresh captures of every page on the human's phones
  const recapture = async () => {
    const data = h.data;
    const lead = data && appId ? leadOf(data, appId) ?? data.nodes["orch"] ?? null : null;
    if (!runId || !lead) return;
    const picked = res?.devices?.forApp ?? [];
    const phonesText = picked.length ? picked.join(", ") : map?.devices.length ? map.devices.join(", ") : "the devices in your brief";
    const text = `The human wants to see ${appName || "the app"} in Screens: capture every page again, on each of these devices the human picked (${phonesText}), upright, both themes, named reports/ui/<screen>--<state>--<phone>--<theme>.png, and update reports/screens/screens.json with every page and its links. Have the UI or platform builder do it, then check it with bb helm screens --app ${appId}.`;
    if (!(await askConfirm({ title: `Ask for fresh screens of ${appName || "this app"}?`, body: `${data?.nodes[lead.id] ? "The app lead" : "The lead"} is told:\n\n${text}`, ok: "Ask the lead" }))) return;
    try {
      await h.rpc.call("directive_create", { runId, directive: { type: "tell", target: lead.id, mode: "queue", text } });
      toast.success("Asked the lead for fresh screens");
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const go = (id: string) => {
    if (id === cur || !screens.some((s) => s.id === id)) return;
    setHist((x) => ({ back: cur ? [...x.back, cur].slice(-50) : x.back, fwd: [] }));
    setCur(id);
  };
  const back = () => {
    const prev = hist.back[hist.back.length - 1];
    if (!prev) return;
    setHist((x) => ({ back: x.back.slice(0, -1), fwd: cur ? [cur, ...x.fwd] : x.fwd }));
    setCur(prev);
  };
  const forward = () => {
    const next = hist.fwd[0];
    if (!next) return;
    setHist((x) => ({ back: cur ? [...x.back, cur] : x.back, fwd: x.fwd.slice(1) }));
    setCur(next);
  };
  const step = (d: 1 | -1) => {
    const i = screens.findIndex((s) => s.id === cur);
    const next = screens[(i + d + screens.length) % screens.length];
    if (next) go(next.id);
  };
  const pickApp = (id: string) => {
    setHist({ back: [], fwd: [] });
    setCur(null);
    void load(id);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest("select, input, textarea")) return;
      if (e.key === "ArrowLeft" && e.altKey) back();
      else if (e.key === "ArrowRight" && e.altKey) forward();
      else if (e.key === "ArrowDown" || e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowUp" || e.key === "ArrowLeft") step(-1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const src = variant ? images.current.get(variant.path) : undefined;
  // a phone app's pages sit in a phone; a capture that knows its shape says so itself
  const frame = variant?.form === "phone" || variant?.form === "tablet" ? variant.form : !variant?.form && map?.device === "phone" ? "phone" : null;
  const appName = res?.apps.find((a) => a.id === appId)?.name ?? "";

  return (
    <Modal label="Screens" cls="lg" onClose={h.closeScreens}>
      <ModalHead title="Screens" onClose={h.closeScreens}>
        {res?.apps.length ? (
          <select className="select" aria-label="App" value={appId ?? ""} onChange={(e) => pickApp(e.target.value)} style={{ width: 200 }}>
            {res.apps.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        ) : null}
        <span className="muted" style={{ fontSize: 12 }}>
          Each app's own screens as pages, as they look on its device. Click a highlighted area or a page on the left. Nothing runs here.
        </span>
      </ModalHead>
      {!runId ? (
        <Banner tone="info" style={{ margin: "12px 18px" }}>
          Select a run to see its apps' screens.
        </Banner>
      ) : err ? (
        <Banner tone="crit" style={{ margin: "12px 18px" }}>
          Could not load the screens: {err}
        </Banner>
      ) : null}
      <div className="mbody scr">
        <nav className="scr-pages" aria-label="Pages">
          <div className="scr-pages-h">
            <span>{screens.length ? `${screens.length} page${screens.length === 1 ? "" : "s"}` : "Pages"}</span>
            <button type="button" className="iconbtn sm" title="Scan again" aria-label="Scan again" disabled={loading || !appId} onClick={() => void load(appId, true)}>
              <Ic name="Refresh" size="sm" className={cx(loading && "spin")} />
            </button>
            <button type="button" className="iconbtn sm" title="Ask the app's lead to capture every page again on your phones" aria-label="Capture again" disabled={!appId} onClick={() => void recapture()}>
              <Ic name="Camera" size="sm" />
            </button>
          </div>
          {screens.map((s) => (
            <button key={s.id} type="button" className="scr-page" aria-current={s.id === cur ? "page" : undefined} onClick={() => go(s.id)} title={s.note ?? s.name}>
              <Ic name={s.id === map?.start ? "Home" : "File"} size="sm" />
              <span className="grow">{s.name}</span>
              {s.links.length ? <span className="scr-n">{s.links.length}</span> : null}
            </button>
          ))}
        </nav>
        <section className="scr-main">
          <div className="scr-bar">
            <button type="button" className="iconbtn sm" onClick={back} disabled={!hist.back.length} title="Back (Alt+←)" aria-label="Back">
              <Ic name="ArrowLeft" size="sm" />
            </button>
            <button type="button" className="iconbtn sm" onClick={forward} disabled={!hist.fwd.length} title="Forward (Alt+→)" aria-label="Forward">
              <Ic name="ArrowRight" size="sm" />
            </button>
            <button type="button" className="iconbtn sm" onClick={() => map?.start && go(map.start)} disabled={!map?.start || cur === map.start} title="First page" aria-label="First page">
              <Ic name="Home" size="sm" />
            </button>
            <div className="scr-addr" title={variant?.rel}>
              {appName ? <b>{appName}</b> : null}
              {screen ? <span> / {screen.name}</span> : null}
            </div>
            {map?.devices.length ? (
              <select className="select sm" aria-label="Phone" value={pref.device ?? ""} disabled={allPhones} onChange={(e) => setPref((p) => ({ ...p, device: e.target.value || null }))} style={{ width: "auto" }}>
                {map.devices.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            ) : null}
            {res?.devices ? (
              <span className="scr-pickwrap">
                <button type="button" className={cx("btn sm", picking && "on")} aria-expanded={picking} onClick={() => setPicking((x) => !x)} title="Pick the phones and tablets every page is captured on">
                  <Ic name="SlidersHorizontal" size="sm" />
                  <span className="btn-lbl"> Devices</span>
                </button>
                {picking ? (
                  <DevicePicker
                    devices={res.devices}
                    phoneApp={map?.device === "phone"}
                    onClose={() => setPicking(false)}
                    onSave={async (list) => {
                      try {
                        await h.rpc.call("screens_setDevices", { devices: list });
                        setPicking(false);
                        await load(appId, true);
                        toast.success("Saved. Press the camera to ask for captures on them now.");
                      } catch (e) {
                        toast.error(errMsg(e));
                      }
                    }}
                  />
                ) : null}
              </span>
            ) : null}
            {(map?.devices.length ?? 0) > 1 ? (
              <button type="button" className={cx("btn sm", allPhones && "on")} aria-pressed={allPhones} onClick={() => setAllPhones((x) => !x)} title="This page on every phone, side by side">
                <Ic name="Smartphone" size="sm" />
                <span className="btn-lbl"> All phones</span>
              </button>
            ) : null}
            {facets.platform.length > 1 ? <Facet label="Platform" values={facets.platform} value={pref.platform} names={PLATFORM} onPick={(v) => setPref((p) => ({ ...p, platform: v }))} /> : null}
            {facets.size.length > 1 ? <Facet label="Size" values={facets.size} value={pref.size} onPick={(v) => setPref((p) => ({ ...p, size: v }))} /> : null}
            {facets.theme.length > 1 ? <Facet label="Theme" values={facets.theme} value={pref.theme} onPick={(v) => setPref((p) => ({ ...p, theme: v }))} /> : null}
            {screen?.links.length ? (
              <button type="button" className={cx("btn sm", showAreas && "on")} aria-pressed={showAreas} onClick={() => setShowAreas((x) => !x)} title="Show where you can tap">
                <Ic name="Cursor" size="sm" />
                <span className="btn-lbl"> Tappable areas</span>
              </button>
            ) : null}
          </div>
          <div className="scr-stage">
            {loading && !map ? (
              <div className="muted">Looking for screens…</div>
            ) : !screens.length ? (
              <div className="scr-empty">
                <Ic name="Image" size="lg" />
                <b>No screens for {appName || "this app"} yet</b>
                <span className="muted">
                  The UI and platform builders commit screenshots of every page under <code>reports/ui/</code> and <code>reports/&lt;platform&gt;/</code>
                  {map?.device === "phone" ? <>, captured on a phone simulator or emulator</> : null}, and a screen map at <code>reports/screens/screens.json</code> that links the pages. They appear here; press Scan again after a builder reports.
                </span>
                {map?.hidden.count ? (
                  <span className="muted">
                    {map.hidden.count} other capture{map.hidden.count === 1 ? " was" : "s were"} found and left out: {map.hidden.reasons.join("; ")}.
                  </span>
                ) : null}
              </div>
            ) : !variant ? (
              <div className="scr-empty">
                <b>{screen?.name}</b>
                <span className="muted">This page is in the screen map but has no screenshot yet.</span>
                {screen?.links.length ? (
                  <span className="row" style={{ gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
                    {screen.links.map((l, i) => (
                      <button key={i} type="button" className="btn sm" onClick={() => go(l.to)}>
                        {l.label ?? screens.find((s) => s.id === l.to)?.name ?? l.to} →
                      </button>
                    ))}
                  </span>
                ) : null}
              </div>
            ) : phones.length ? (
              <div className="scr-phones">
                {phones.map(({ device, v }) => {
                  const img = images.current.get(v.path);
                  return (
                    <figure key={device} className="scr-phone">
                      <div className={cx("scr-dev", v.form === "tablet" ? "tablet" : "phone")}>
                        <div className="scr-shot">{img ? <img src={img} alt={`${appName} · ${screen?.name ?? ""} · ${device}`} draggable={false} /> : <div className="scr-ph muted">{img === "" ? "Could not read it" : "Loading…"}</div>}</div>
                      </div>
                      <figcaption>{device}</figcaption>
                    </figure>
                  );
                })}
              </div>
            ) : src === undefined || src === null ? (
              <div className="muted">Loading {screen?.name}…</div>
            ) : src === "" ? (
              <div className="scr-empty">
                <b>{screen?.name}</b>
                <span className="muted">This screenshot could not be read (it may have moved). Press Scan again.</span>
              </div>
            ) : (
              <div className="scr-single">
              <div className={cx("scr-dev", frame)}>
              <div className={cx("scr-shot", showAreas && "show")}>
                <img src={src} alt={`${appName} · ${screen?.name ?? ""}`} draggable={false} />
                {screen?.links.map((l, i) => {
                  const to = screens.find((s) => s.id === l.to);
                  return (
                    <button
                      key={i}
                      type="button"
                      className="scr-hot"
                      style={{ left: `${l.x * 100}%`, top: `${l.y * 100}%`, width: `${l.w * 100}%`, height: `${l.h * 100}%` }}
                      title={`${l.label ? `${l.label} → ` : "→ "}${to?.name ?? l.to}`}
                      aria-label={`${l.label ?? "Open"}: ${to?.name ?? l.to}`}
                      disabled={!to}
                      onClick={() => go(l.to)}
                    />
                  );
                })}
              </div>
              </div>
              {variant.device ? <div className="scr-devname">{variant.device}</div> : null}
              </div>
            )}
          </div>
          {screen?.note || variant?.state || map?.problems.length || (map?.hidden.count && screens.length) ? (
            <div className="scr-foot">
              {screen?.note ? <span>{screen.note}</span> : null}
              {variant?.state ? <span className="pill">{variant.state}</span> : null}
              {map?.problems.length ? (
                <span className="warn" title={map.problems.join("\n")}>
                  <Ic name="Warning" size="sm" /> Screen map: {map.problems[0]}
                  {map.problems.length > 1 ? ` (+${map.problems.length - 1})` : ""}
                </span>
              ) : null}
              {map?.source === "files" && screens.length ? <span className="muted">No screen map yet: pages come from the screenshots, without links.</span> : null}
              {map?.hidden.count && screens.length ? (
                <span className="muted" title={map.hidden.reasons.join("\n")}>
                  {map.hidden.count} capture{map.hidden.count === 1 ? "" : "s"} left out (not pages of {appName || "this app"})
                </span>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
    </Modal>
  );
}

function Facet({ label, values, value, names, onPick }: { label: string; values: string[]; value: string | null; names?: Record<string, string>; onPick: (v: string | null) => void }) {
  return (
    <select className="select sm" aria-label={label} value={value ?? ""} onChange={(e) => onPick(e.target.value || null)} style={{ width: "auto" }}>
      <option value="">{label}: any</option>
      {values.map((v) => (
        <option key={v} value={v}>
          {names?.[v] ?? v}
        </option>
      ))}
    </select>
  );
}

const GROUPS: Array<{ title: string; test: (d: DeviceSpec) => boolean }> = [
  { title: "iPhone", test: (d) => d.os === "ios" && d.form === "phone" },
  { title: "Android phones", test: (d) => d.os === "android" && d.form === "phone" },
  { title: "Tablets", test: (d) => d.form === "tablet" },
];

/** Pick the devices from a list (no typing, so a model name is never wrong). */
function DevicePicker({ devices, phoneApp, onClose, onSave }: { devices: Devices; phoneApp: boolean; onClose: () => void; onSave: (list: string[]) => Promise<void> }) {
  const [sel, setSel] = useState<Set<string>>(new Set(devices.picked));
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest?.(".scr-pickwrap")) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);
  const flip = (name: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else if (n.size < devices.max) n.add(name);
      return n;
    });
  const changed = sel.size !== devices.picked.length || devices.picked.some((d) => !sel.has(d));
  return (
    <div ref={ref} className="scr-devpick" role="dialog" aria-label="Devices for screenshots">
      <div className="scr-devpick-h">
        <b>Devices for screenshots</b>
        <span className="faint">
          {sel.size} of at most {devices.max}
        </span>
      </div>
      {!phoneApp ? <p className="faint scr-devpick-note">This app runs on a computer: Helm captures its pages at 1440×900 (laptop) and 1920×1080 (desktop), and a web app also at a phone's width. These devices are for phone and tablet apps.</p> : null}
      {GROUPS.map((g) => (
        <fieldset key={g.title} className="scr-devgroup">
          <legend>{g.title}</legend>
          {devices.catalog.filter(g.test).map((d) => (
            <label key={d.name} className={cx("scr-devopt", sel.has(d.name) && "on")}>
              <input type="checkbox" checked={sel.has(d.name)} disabled={!sel.has(d.name) && sel.size >= devices.max} onChange={() => flip(d.name)} />
              <span className="grow">{d.name}</span>
              <span className="faint">
                {d.w}×{d.h}
              </span>
            </label>
          ))}
        </fieldset>
      ))}
      <p className="faint scr-devpick-note">An iOS app is captured on the Apple devices you pick, an Android app on the Android ones. Builders use them from their next capture.</p>
      <div className="scr-devpick-f">
        <button type="button" className="btn sm" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn sm primary"
          disabled={!sel.size || !changed || busy}
          onClick={() => {
            setBusy(true);
            void onSave(devices.catalog.filter((d) => sel.has(d.name)).map((d) => d.name)).finally(() => setBusy(false));
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}
