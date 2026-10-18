// The Screens view: click through an app's screens like a tiny browser. Nothing runs and there
// is no device frame. Each page is a screenshot the builders committed, and tappable areas from
// the screen map (reports/screens/screens.json) jump to the page they lead to.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHelm } from "./ctx.tsx";
import { Banner, Ic, Modal, ModalHead, cx } from "./ui.tsx";
import { errMsg } from "./format.ts";

interface Variant {
  path: string;
  rel: string;
  platform: string | null;
  size: string | null;
  theme: string | null;
  state: string | null;
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
}
interface AppRow {
  id: string;
  name: string;
}
interface ListResult {
  apps: AppRow[];
  appId: string | null;
  map: ScreenMap | null;
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
  const [pref, setPref] = useState<{ platform: string | null; theme: string | null; size: string | null }>({ platform: null, theme: null, size: null });
  const [showAreas, setShowAreas] = useState(false);
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
    void load(null);
  }, [load]);

  const map = res?.map ?? null;
  const screens = map?.screens ?? [];
  const screen = screens.find((s) => s.id === cur) ?? null;

  // what the variant pickers can offer, across the app
  const facets = useMemo(() => {
    const all = screens.flatMap((s) => s.variants);
    const uniq = (k: "platform" | "theme" | "size") => [...new Set(all.map((v) => v[k]).filter((x): x is string => !!x))];
    return { platform: uniq("platform"), theme: uniq("theme"), size: uniq("size") };
  }, [screens]);

  const variant = useMemo(() => {
    if (!screen?.variants.length) return null;
    const score = (v: Variant) => (pref.platform && v.platform === pref.platform ? 4 : 0) + (pref.theme && v.theme === pref.theme ? 2 : 0) + (pref.size && v.size === pref.size ? 1 : 0);
    return [...screen.variants].sort((a, b) => score(b) - score(a))[0];
  }, [screen, pref]);

  // load the shown image (and keep it for the session)
  useEffect(() => {
    if (!runId || !appId || !variant || images.current.has(variant.path)) return;
    let live = true;
    images.current.set(variant.path, null);
    void (h.rpc.call("screens_image", { runId, appId, path: variant.path }) as Promise<{ dataUrl: string | null }>)
      .then((r) => {
        images.current.set(variant.path, r.dataUrl ?? "");
        if (live) bump((x) => x + 1);
      })
      .catch(() => {
        images.current.set(variant.path, "");
        if (live) bump((x) => x + 1);
      });
    return () => {
      live = false;
    };
  }, [h.rpc, runId, appId, variant]);

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
          Each app's screens as pages. Click a highlighted area or a page on the left. Nothing runs here.
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
                  The UI and platform builders commit screenshots under <code>reports/ui/</code> and <code>reports/&lt;platform&gt;/</code> while they build, and a screen map at <code>reports/screens/screens.json</code> that links the pages. They appear here; press Scan again after a builder reports.
                </span>
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
            ) : src === undefined || src === null ? (
              <div className="muted">Loading {screen?.name}…</div>
            ) : src === "" ? (
              <div className="scr-empty">
                <b>{screen?.name}</b>
                <span className="muted">This screenshot could not be read (it may have moved). Press Scan again.</span>
              </div>
            ) : (
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
            )}
          </div>
          {screen?.note || variant?.state || map?.problems.length ? (
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
