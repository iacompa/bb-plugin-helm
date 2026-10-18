// The Graph: HTML cards on an SVG edge layer inside one CSS-transformed stage,
// with semantic zoom, viewport culling, grouping, search/filters, the action
// bar, the propagation pulse, receipt flashes, the Observatory and an Outline.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { Catalog, ForeignThread, NeedInfo, SnapApp, SnapNode } from "./types.ts";
import { useHelm } from "./ctx.tsx";
import { ancestorsOf, appMembers, leadOf, type RunState } from "./store.ts";
import { PLAT, ROLE_LABEL, TYPE_LABEL, appStatus, mgrHue, plural, stageLabel, statusLabel, trailLabel, modelName } from "./format.ts";
import { fitTransform, lodFor, pathD, portfolioLayout, rectOf, squadLayout, visibleIdOf, visibleIds, zoomAbout, type Layout, type Lod, type PlacedRect } from "./layout.ts";
import { Dot, Ic, Kbd, ModelChip, Popover, RoleTile, Seg, StagePill, StatusPill, cx } from "./ui.tsx";

type StatusFilter = "all" | "running" | "needs" | "touched";
const GHOST = "ghost:";

// keep per-run graph UI state across tab switches and remounts
const uiCache = new Map<string, { collapsed: Set<string>; expanded: Set<string> }>();

function prefersReducedMotion(): boolean {
  try {
    return !!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function nowFallback(n: SnapNode): string {
  if (n.nowLine) return n.nowLine;
  switch (n.status) {
    case "planned":
      return "Not spawned yet";
    case "queued":
      return "Waiting for a free slot";
    case "paused":
      return "Paused by you";
    case "done":
      return "Finished";
    case "failed":
      return n.warning ?? "Failed";
    case "needs":
      return "Waiting on you";
    default:
      return "No activity reported yet";
  }
}

const SIDE_ORDER = ["planner", "git", "custom"];

function agentTitle(n: SnapNode): string {
  if (n.role === "planner" || n.role === "git" || n.role === "custom") return n.label;
  if (n.role === "platform" && n.platform) return `${PLAT[n.platform] ?? n.platform} builder`;
  return ROLE_LABEL[n.role] ?? n.label;
}

interface Derived {
  managerIds: string[];
  directAppIds: string[];
  members: Record<string, string[]>;
  appStatusOf: Record<string, string>;
  needsByNode: Record<string, number>;
  needsByApp: Record<string, number>;
  appOfNode: (id: string) => string | null;
  mgrOfApp: (appId: string) => string | null;
}

function derive(d: RunState): Derived {
  const managerIds = d.managers.map((m) => m.id);
  const inMgr = new Set(d.managers.flatMap((m) => m.appIds));
  const directAppIds = d.appOrder.filter((id) => !inMgr.has(id));
  const members: Record<string, string[]> = {};
  const appStatusOf: Record<string, string> = {};
  for (const id of d.appOrder) {
    const ms = appMembers(d, id);
    members[id] = ms.map((m) => m.id);
    appStatusOf[id] = appStatus(d.apps[id], ms);
  }
  const needsByNode: Record<string, number> = {};
  const needsByApp: Record<string, number> = {};
  for (const n of d.needs as NeedInfo[]) {
    if (n.state !== "open") continue;
    if (n.nodeId) needsByNode[n.nodeId] = (needsByNode[n.nodeId] ?? 0) + 1;
    const appId = n.appId ?? (n.nodeId ? d.nodes[n.nodeId]?.appId : null);
    if (appId) needsByApp[appId] = (needsByApp[appId] ?? 0) + 1;
  }
  const mgrMap = new Map<string, string>();
  for (const m of d.managers) for (const a of m.appIds) mgrMap.set(a, m.id);
  return {
    managerIds,
    directAppIds,
    members,
    appStatusOf,
    needsByNode,
    needsByApp,
    appOfNode: (id) => d.nodes[id]?.appId ?? null,
    mgrOfApp: (a) => mgrMap.get(a) ?? null,
  };
}

/** A string that changes only when the graph's structure changes (not on status). */
function structKey(d: RunState): string {
  let k = `${d.run.id}|${d.managers.map((m) => `${m.id}:${m.appIds.join(",")}`).join(";")}|${d.appOrder.join(",")}|`;
  for (const id of d.nodeOrder) k += `${id}<${d.nodes[id].parentId ?? ""}:${d.nodes[id].appId ?? ""}:${d.nodes[id].tier};`;
  return k;
}

export function GraphView({ active }: { active: boolean }) {
  const h = useHelm();
  const { data, rev, sel, select, drill, setDrill, observatory, setObservatory, catalog, pulse, flashes, focusReq } = h;
  const nav = useBbNavigate();
  const canvasRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const zlRef = useRef<HTMLSpanElement>(null);
  const abarRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const vp = useRef({ px: 0, py: 0, zoom: 1, auto: true });
  const [lod, setLod] = useState<Lod>("near");
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const visKey = useRef("");
  const [filter, setFilter] = useState("");
  const [sf, setSf] = useState<StatusFilter>("all");
  const [outline, setOutline] = useState(false);
  const [help, setHelp] = useState<HTMLElement | null>(null);
  const [ghosts, setGhosts] = useState<ForeignThread[]>([]);
  const [lit, setLit] = useState<Record<string, string>>({});
  const [hot, setHot] = useState<Set<string>>(new Set());
  const [pulsing, setPulsing] = useState<Set<string>>(new Set());
  const [flashing, setFlashing] = useState<Set<string>>(new Set());
  const [reduced] = useState(prefersReducedMotion);

  // per-run grouping state; collapsed by default above ~60 nodes
  const runId = data?.run.id ?? null;
  const [ui, setUi] = useState<{ collapsed: Set<string>; expanded: Set<string> }>({ collapsed: new Set(), expanded: new Set() });
  const initRun = useRef<string | null>(null);
  useEffect(() => {
    if (!data || initRun.current === data.run.id) return;
    initRun.current = data.run.id;
    const cached = uiCache.get(data.run.id);
    if (cached) return setUi(cached);
    const big = data.nodeOrder.length > 60;
    const expanded = new Set<string>(big ? [] : data.appOrder);
    const collapsed = new Set<string>(data.nodeOrder.length > 170 ? data.managers.map((m) => m.id) : []);
    setUi({ collapsed, expanded });
  }, [data, rev]);
  useEffect(() => {
    if (runId) uiCache.set(runId, ui);
  }, [ui, runId]);

  // Observatory: BB threads outside this run (read-only)
  useEffect(() => {
    if (!observatory) {
      setGhosts([]);
      return;
    }
    let live = true;
    h.rpc.call("observatory_list", { limit: 200 }).then(
      (list: ForeignThread[]) => {
        if (!live) return;
        const mine = new Set(Object.values(data?.nodes ?? {}).map((n) => n.threadId).filter(Boolean) as string[]);
        setGhosts((list ?? []).filter((t) => !t.hidden && t.originPluginId !== "helm" && !mine.has(t.threadId)).slice(0, 24));
      },
      () => live && setGhosts([]),
    );
    return () => {
      live = false;
    };
  }, [observatory, h.rpc, runId]); // eslint-disable-line react-hooks/exhaustive-deps

  const der = useMemo(() => (data ? derive(data) : null), [data, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const skey = data ? structKey(data) : "";
  const ghostKey = ghosts.map((g) => g.threadId).join(",");

  const layout: Layout | null = useMemo(() => {
    if (!data || !der) return null;
    if (drill && data.apps[drill]) {
      const lead = leadOf(data, drill);
      if (lead) {
        const ms = appMembers(data, drill).filter((m) => m.id !== lead.id);
        return squadLayout({
          chain: ancestorsOf(data, lead.id).reverse(),
          leadId: lead.id,
          specialists: ms.filter((m) => m.tier !== "gate").map((m) => m.id),
          gates: ms.filter((m) => m.tier === "gate").map((m) => m.id),
          hue: mgrHue(der.managerIds, der.mgrOfApp(drill)),
        });
      }
    }
    const orch = data.nodeOrder.find((id) => data.nodes[id].role === "orch") ?? "orch";
    return portfolioLayout({
      orchId: orch,
      managers: data.managers.map((m) => ({ ...m, hue: mgrHue(der.managerIds, m.id) })),
      directAppIds: der.directAppIds,
      appNames: Object.fromEntries(data.appOrder.map((id) => [id, data.apps[id].name])),
      collapsed: ui.collapsed,
      expanded: ui.expanded,
      members: der.members,
      // free-standing beside the Orchestrator: the Planner, the Git agent, then custom agents with no app
      side: data.nodeOrder
        .map((id) => data.nodes[id])
        .filter((n) => n.role === "planner" || n.role === "git" || (n.role === "custom" && !n.appId && n.status !== "done"))
        .sort((a, b) => SIDE_ORDER.indexOf(a.role) - SIDE_ORDER.indexOf(b.role))
        .map((n) => ({ id: n.id, parentId: n.role === "custom" ? n.parentId : null })),
      ghosts: ghosts.map((g) => GHOST + g.threadId),
      ghostLabel: ghosts.length ? `Outside this run · ${plural(ghosts.length, "thread")} · read-only` : undefined,
    });
  }, [skey, drill, ui, ghostKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── transform, LOD, culling (no React render per frame) ──
  const raf = useRef<number | null>(null);
  const cull = useCallback(() => {
    raf.current = null;
    const cv = canvasRef.current;
    if (!cv || !layout) return;
    const ids = visibleIds(layout, { ...vp.current, w: cv.clientWidth, h: cv.clientHeight }, sel ? [sel] : []);
    const key = ids.join("|");
    if (key !== visKey.current) {
      visKey.current = key;
      setVisible(new Set(ids));
    }
  }, [layout, sel]);
  const cullRef = useRef(cull);
  cullRef.current = cull;
  const placeAbar = useCallback(() => {
    const bar = abarRef.current;
    if (!bar) return;
    const z = vp.current.zoom;
    const below = bar.dataset.below === "1";
    bar.style.transform = `translate(-50%,${below ? "0" : "-100%"}) scale(${1 / z})`;
  }, []);
  const apply = useCallback(
    (animate = false) => {
      const st = stageRef.current;
      const cv = canvasRef.current;
      if (!st || !cv) return;
      if (animate && !reduced) {
        st.classList.add("anim");
        setTimeout(() => st.classList.remove("anim"), 420);
      }
      const { px, py, zoom } = vp.current;
      st.style.transform = `translate(${px}px,${py}px) scale(${zoom})`;
      const l = lodFor(zoom);
      if (cv.dataset.lod !== l) {
        cv.dataset.lod = l;
        setLod(l);
      }
      if (zlRef.current) zlRef.current.textContent = `${Math.round(zoom * 100)}%`;
      placeAbar();
      if (raf.current === null) raf.current = requestAnimationFrame(() => cullRef.current());
    },
    [placeAbar, reduced],
  );
  const fit = useCallback(
    (animate = true) => {
      const cv = canvasRef.current;
      if (!cv || !layout || !cv.clientWidth) return;
      const t = fitTransform(layout.bounds, cv.clientWidth, cv.clientHeight);
      vp.current = { ...t, auto: true };
      apply(animate);
    },
    [layout, apply],
  );
  const centerOn = useCallback(
    (id: string, animate = true) => {
      const cv = canvasRef.current;
      if (!cv || !layout) return;
      const r = rectOf(layout, id);
      if (!r) return;
      const z = Math.max(vp.current.zoom, 0.85);
      vp.current = { zoom: z, px: cv.clientWidth / 2 - (r.x + r.w / 2) * z, py: cv.clientHeight / 2 - (r.y + r.h / 2) * z, auto: false };
      apply(animate);
    },
    [layout, apply],
  );

  // refit when the layout's shape changes (drill, collapse, ghosts) while auto-fitting
  const lastBoundsKey = useRef("");
  useLayoutEffect(() => {
    if (!layout) return;
    const k = `${drill ?? ""}|${layout.bounds.w}x${layout.bounds.h}`;
    if (k !== lastBoundsKey.current) {
      const first = !lastBoundsKey.current;
      lastBoundsKey.current = k;
      if (vp.current.auto || first || drill !== null) fit(false);
      else apply(false);
    } else apply(false);
  }, [layout, drill, fit, apply]);

  useEffect(() => {
    if (active) {
      // becoming visible: sizes are known again
      if (vp.current.auto) fit(false);
      else apply(false);
    }
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ro = new ResizeObserver(() => {
      if (!cv.clientWidth) return;
      if (vp.current.auto) fit(false);
      else apply(false);
    });
    ro.observe(cv);
    return () => ro.disconnect();
  }, [fit, apply]);

  // focus requests from elsewhere (Show buttons, Needs, Ledger)
  useEffect(() => {
    if (!focusReq || !layout || !der) return;
    const t = setTimeout(() => {
      const vid = visibleIdOf(layout, focusReq.id, der.appOfNode, der.mgrOfApp);
      if (vid) centerOn(vid, true);
    }, 60);
    return () => clearTimeout(t);
  }, [focusReq, layout]); // eslint-disable-line react-hooks/exhaustive-deps

  // wheel: ⌘/Ctrl + scroll zooms, plain scroll pans
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest(".glass, .pop")) return;
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const t = zoomAbout(vp.current, e.clientX - r.left, e.clientY - r.top, vp.current.zoom * Math.exp(-e.deltaY * 0.0022));
        vp.current = { ...t, auto: false };
      } else vp.current = { ...vp.current, px: vp.current.px - e.deltaX, py: vp.current.py - e.deltaY, auto: false };
      apply(false);
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  }, [apply]);

  const pan = useRef<{ x: number; y: number; px: number; py: number; id: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".node, .abar, .glass, button, input, .cluster .cl-label")) return;
    pan.current = { x: e.clientX, y: e.clientY, px: vp.current.px, py: vp.current.py, id: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.classList.add("panning");
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = pan.current;
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    vp.current = { ...vp.current, px: p.px + dx, py: p.py + dy, auto: Math.abs(dx) + Math.abs(dy) > 3 ? false : vp.current.auto };
    apply(false);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pan.current) return;
    pan.current = null;
    e.currentTarget.classList.remove("panning");
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };
  const zoomBy = (k: number) => {
    const cv = canvasRef.current;
    if (!cv) return;
    vp.current = { ...zoomAbout(vp.current, cv.clientWidth / 2, cv.clientHeight / 2, vp.current.zoom * k), auto: false };
    apply(false);
  };

  // keyboard: "/" search, "f" fit (only while the graph is the active view and nothing is being typed)
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof Element ? (e.target as HTMLElement) : null;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (t.closest("input, textarea, select, [contenteditable=true], .modal, .pop") || t.isContentEditable)) return;
      if (t && t !== document.body && !canvasRef.current?.closest(".helm")?.contains(t)) return;
      if (e.key === "/") {
        e.preventDefault();
        setOutline(false);
        searchRef.current?.focus();
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        fit(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, fit]);

  // ── propagation pulse: target → parent → … → Orchestrator, ~200 ms per hop ──
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    if (!pulse || !data || !layout || !der || !active) return;
    const d = pulse.directive;
    const chain = [d.targetNodeId, ...ancestorsOf(data, d.targetNodeId)];
    const vis: string[] = [];
    for (const id of chain) {
      const v = visibleIdOf(layout, id, der.appOfNode, der.mgrOfApp);
      if (v && !vis.includes(v)) vis.push(v);
    }
    if (!vis.length) return;
    timers.current.forEach(clearTimeout);
    timers.current = [];
    const label = (vid: string, i: number): string => {
      const by = d.byNode ? trailLabel(data.nodes[d.byNode], data.apps) || d.byNode : null;
      if (i === 0) return `${by ? `${by} →` : "You ·"} ${TYPE_LABEL[d.type] ?? d.type}`;
      if (d.byNode && vid === d.byNode) return `${by} · sent it`;
      const n = data.nodes[vid];
      const app = data.apps[vid];
      const who = n ? trailLabel(n, data.apps) : app ? `${app.name} lead` : vid.startsWith("frame:") ? data.apps[vid.slice(6)]?.name ?? "" : vid;
      const r = d.recipients.find((x) => x.nodeId === vid || (app && x.nodeId === leadOf(data, vid)?.id));
      const how = r?.world && n?.role === "orch" ? "world state" : r?.level === "full" ? "full notice" : r?.level === "direct" ? "target" : "digest";
      return `${who} · ${how}`;
    };
    const edges = new Set<string>();
    for (let i = 1; i < vis.length; i++) edges.add(`${vis[i]}|${vis[i - 1]}`);
    if (reduced) {
      // static highlight of the whole chain
      setLit(Object.fromEntries(vis.map((v, i) => [v, label(v, i)])));
      setHot(edges);
      timers.current.push(
        setTimeout(() => {
          setLit({});
          setHot(new Set());
        }, 3200),
      );
      return;
    }
    setHot(edges);
    vis.forEach((v, i) => {
      timers.current.push(
        setTimeout(() => {
          setPulsing((p) => new Set(p).add(v));
          setLit((l) => ({ ...l, [v]: label(v, i) }));
        }, i * 200),
      );
    });
    timers.current.push(
      setTimeout(() => {
        setPulsing(new Set());
        setLit({});
        setHot(new Set());
      }, vis.length * 200 + 2600),
    );
  }, [pulse]); // eslint-disable-line react-hooks/exhaustive-deps

  // receipt flashes on the recipient's card
  const lastFlash = useRef(0);
  useEffect(() => {
    if (!layout || !der || !active) return;
    const fresh = flashes.filter((f) => f.key > lastFlash.current);
    if (!fresh.length) return;
    lastFlash.current = fresh[fresh.length - 1].key;
    const ids = fresh.map((f) => visibleIdOf(layout, f.nodeId, der.appOfNode, der.mgrOfApp)).filter((x): x is string => !!x);
    if (!ids.length) return;
    setFlashing((s) => new Set([...s, ...ids]));
    const t = setTimeout(() => setFlashing((s) => new Set([...s].filter((x) => !ids.includes(x)))), 950);
    return () => clearTimeout(t);
  }, [flashes]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── filtering ──
  const q = filter.trim().toLowerCase();
  const filtering = !!q || sf !== "all";
  const matches = useCallback(
    (id: string): boolean => {
      if (!data || !der) return true;
      const app = data.apps[id];
      const n = data.nodes[id];
      const g = id.startsWith(GHOST) ? ghosts.find((x) => GHOST + x.threadId === id) : null;
      let ok = true;
      if (sf !== "all") {
        if (app) {
          const st = der.appStatusOf[id];
          const ms = der.members[id].map((m) => data.nodes[m]);
          ok = sf === "running" ? st === "running" : sf === "needs" ? st === "needs" || st === "failed" || !!der.needsByApp[id] : ms.some((m) => m?.touched);
        } else if (n) ok = sf === "running" ? n.status === "running" : sf === "needs" ? n.status === "needs" || n.status === "failed" || !!der.needsByNode[n.id] : n.touched;
        else ok = !!g && sf === "running" && g.status === "running";
      }
      if (ok && q) {
        let hay = "";
        if (app) hay = [app.name, app.tagline, app.platforms.map((p) => PLAT[p]).join(" "), stageLabel(app.stage), data.managers.find((m) => m.appIds.includes(id))?.name ?? ""].join(" ");
        else if (n) hay = [n.label, n.id, ROLE_LABEL[n.role], modelName(catalog, n.model), n.model?.modelId ?? "", n.model?.reasoning ?? "", n.nowLine ?? "", statusLabel(n.status)].join(" ");
        else if (g) hay = [g.title ?? "", g.providerId ?? "", g.status ?? ""].join(" ");
        ok = hay.toLowerCase().includes(q);
      }
      return ok;
    },
    [data, der, ghosts, sf, q, catalog],
  );
  const firstMatch = () => {
    if (!layout) return null;
    const ids = Object.keys(layout.rects).filter(matches);
    return ids.find((id) => data?.nodes[id]?.role !== "orch") ?? ids[0] ?? null;
  };

  // ── selection helpers ──
  const selectId = (id: string) => {
    if (!data) return;
    if (data.apps[id]) {
      const lead = leadOf(data, id);
      if (lead) select(lead.id);
    } else select(id);
  };
  const toggleCollapse = (mgrId: string) =>
    setUi((u) => {
      const c = new Set(u.collapsed);
      if (c.has(mgrId)) c.delete(mgrId);
      else c.add(mgrId);
      vp.current.auto = true;
      return { ...u, collapsed: c };
    });
  const toggleExpand = (appId: string) =>
    setUi((u) => {
      const x = new Set(u.expanded);
      if (x.has(appId)) x.delete(appId);
      else x.add(appId);
      vp.current.auto = true;
      return { ...u, expanded: x };
    });
  const anyCollapsed = !!data && (data.managers.some((m) => ui.collapsed.has(m.id)) || data.appOrder.some((a) => !ui.expanded.has(a)));
  const collapseAll = () => {
    if (!data) return;
    vp.current.auto = true;
    if (anyCollapsed) setUi({ collapsed: new Set(), expanded: new Set(data.appOrder) });
    else setUi({ collapsed: new Set(data.managers.length > 1 ? data.managers.map((m) => m.id) : []), expanded: new Set() });
  };
  const drillInto = (appId: string) => {
    setDrill(appId);
    const lead = data ? leadOf(data, appId) : null;
    if (lead) select(lead.id, { keepClosed: !h.inspOpen });
    vp.current.auto = true;
  };

  const onNodeClick = (e: ReactMouseEvent, id: string) => {
    if ((e.target as HTMLElement).closest("[data-act]")) return;
    selectId(id);
  };
  const onNodeDouble = (id: string, mode: string) => {
    if (mode === "app") drillInto(id);
    else if (mode === "mgr" && !drill) toggleCollapse(id);
  };
  const onNodeKey = (e: ReactKeyboardEvent, id: string, mode: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (mode === "app" && (e.shiftKey || e.metaKey)) drillInto(id);
      else selectId(id);
    }
  };

  if (!data || !der || !layout) {
    return <div className="canvas" ref={canvasRef} data-lod="near" />;
  }

  // which rect carries the selection
  const selNode = sel ? data.nodes[sel] : null;
  const selApp = selNode?.appId ?? null;
  const selRect = sel ? (layout.rects[sel] ? sel : selNode && selNode.role === "lead" && selApp && layout.rects[selApp] ? selApp : null) : null;
  const ghostSel = sel?.startsWith(GHOST) ? sel : null;

  const edgeClass = (e: Layout["edges"][number]): string => {
    let cls = "";
    if (e.kind === "app" || e.kind === "direct") {
      const appId = e.to.startsWith("frame:") ? e.to.slice(6) : e.to;
      const st = der.appStatusOf[appId];
      cls = st === "running" ? "run" : st === "planned" || st === "queued" ? "plan" : "";
      if (der.members[appId]?.some((m) => data.nodes[m]?.touched)) cls += " touch";
    } else if (e.kind === "mgr") {
      const m = data.managers.find((x) => x.id === e.to);
      cls = m?.appIds.some((a) => der.appStatusOf[a] === "running") ? "run" : "";
      if (data.nodes[e.to]?.touched) cls += " touch";
    } else if (e.kind === "frame" && drill) {
      cls = layoutIds(layout, "sf").some((id) => data.nodes[id]?.status === "running") ? "run" : "";
    } else if (e.kind === "gate" && drill) {
      cls = `gate ${layoutIds(layout, "gf").some((id) => data.nodes[id]?.status === "running") ? "run" : "plan"}`;
    } else cls = "chain";
    if (hot.has(`${e.from}|${e.to}`)) cls += ` hot${reduced ? "" : " anim"}`;
    return cls;
  };

  const abarFor = selRect ?? (ghostSel && layout.rects[ghostSel] ? ghostSel : null);
  const abarRect = abarFor ? layout.rects[abarFor] : null;
  const abarBelow = !!drill && !!abarFor && data.nodes[abarFor]?.id === leadOf(data, drill)?.id;
  const abarTarget = abarFor && data.apps[abarFor] ? leadOf(data, abarFor) : abarFor ? data.nodes[abarFor] : null;
  const ghostObj = ghostSel ? ghosts.find((g) => GHOST + g.threadId === ghostSel) : null;

  const rendered = Object.entries(layout.rects).filter(([id]) => visible.has(id) || id === selRect);
  const a = drill ? data.apps[drill] : null;
  const mgrOfDrill = drill ? der.mgrOfApp(drill) : null;

  return (
    <div className="view" style={{ visibility: active ? "visible" : "hidden" }} aria-hidden={!active}>
      <div className="canvas" ref={canvasRef} data-lod={lod} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} role="application" aria-label="Agent graph. Use the Outline for a list view.">
        <div className="stage" ref={stageRef}>
          {layout.clusters.map((c) => (
            <div key={c.id} className={cx("cluster", c.dashed && "dashed")} style={{ left: c.x, top: c.y, width: c.w, height: c.h, ...(c.hue ? { borderColor: `color-mix(in oklab, ${c.hue} 38%, var(--h-line))` } : {}) }}>
              <span className="cl-label" style={c.hue ? { color: c.hue } : undefined}>
                {c.label}
              </span>
            </div>
          ))}
          {layout.labels.map((l, i) => (
            <div key={i} className="zone-label" style={{ left: l.x, top: l.y }}>
              {l.text}
            </div>
          ))}
          <svg className="edges" width={layout.bounds.w + 40} height={layout.bounds.h + 40} aria-hidden="true">
            <defs>
              <marker id="helm-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M1 1 9 5 1 9" fill="none" style={{ stroke: "var(--h-fg-4)" }} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </marker>
            </defs>
            {layout.edges.map((e) => {
              const ra = rectOf(layout, e.from);
              const rb = rectOf(layout, e.to);
              if (!ra || !rb) return null;
              if (!visible.has(e.from) && !visible.has(e.to) && !e.to.startsWith("frame:") && e.to !== "sf" && e.to !== "gf") return null;
              return <path key={`${e.from}|${e.to}`} className={edgeClass(e)} d={pathD(ra, rb, e.kind === "v" ? "v" : "h")} />;
            })}
            {layout.deco.map((d, i) => (
              <path key={`deco${i}`} className="deco" d={`M${d.x} ${d.y1} L${d.x} ${d.y2}`} markerEnd="url(#helm-arr)" />
            ))}
          </svg>
          {layout.deco.map((d, i) => (
            <div key={`dl${i}`} className="zone-label" style={{ left: d.x + 12, top: (d.y1 + d.y2) / 2 - 6 }}>
              {d.text}
            </div>
          ))}
          {rendered.map(([id, r]) => {
            const isSel = id === selRect || id === ghostSel;
            const within = !isSel && !!data.apps[id] && selApp === id;
            const common = {
              id,
              r,
              sel: isSel,
              within,
              dim: filtering && !matches(id),
              hit: filtering && !!q && matches(id),
              pulse: pulsing.has(id),
              chain: reduced && !!lit[id],
              flash: flashing.has(id),
              onClick: onNodeClick,
              onDouble: onNodeDouble,
              onKey: onNodeKey,
            };
            if (r.mode === "ghost") {
              const g = ghosts.find((x) => GHOST + x.threadId === id);
              return g ? <GhostCard key={id} {...common} g={g} /> : null;
            }
            if (r.mode === "app") {
              const app = data.apps[id];
              const ms = der.members[id].map((m) => data.nodes[m]).filter(Boolean);
              return <AppCard key={id} {...common} app={app} status={der.appStatusOf[id]} members={ms} needs={der.needsByApp[id] ?? 0} expanded={ui.expanded.has(id)} onToggle={toggleExpand} />;
            }
            const n = data.nodes[id];
            if (!n) return null;
            if (r.mode === "orch" || r.mode === "mgr") {
              const m = data.managers.find((x) => x.id === id);
              const appIds = m ? m.appIds : [];
              const needs = r.mode === "orch" ? der.needsByNode[id] ?? 0 : appIds.reduce((s, x) => s + (der.needsByApp[x] ?? 0), 0) + (der.needsByNode[id] ?? 0);
              const sub =
                r.mode === "orch"
                  ? n.alsoLead && data.appOrder[0]
                    ? `also leads ${data.apps[data.appOrder[0]].name}`
                    : `${plural(data.appOrder.length, "app")} · ${plural(data.managers.length, "manager")}`
                  : `${m?.name ?? n.label} · ${plural(appIds.length, "app")}`;
              return (
                <TierCard
                  key={id}
                  {...common}
                  n={n}
                  catalog={catalog}
                  sub={sub}
                  needs={needs}
                  appDots={appIds.map((x) => ({ id: x, name: data.apps[x]?.name ?? x, status: der.appStatusOf[x] ?? "planned", stage: data.apps[x]?.stage }))}
                  collapsed={ui.collapsed.has(id)}
                  onToggle={r.mode === "mgr" && !drill ? toggleCollapse : undefined}
                />
              );
            }
            if (r.mode === "chip") return <ChipCard key={id} {...common} n={n} catalog={catalog} title={n.role === "orch" ? n.label : `${data.managers.find((m) => m.id === id)?.name ?? n.label} manager`} />;
            const app = n.appId ? data.apps[n.appId] : null;
            const kids = n.role === "lead" || (n.alsoLead && drill) ? (data.children[id] ?? []).map((c) => data.nodes[c]).filter((c) => c && c.appId === (app?.id ?? c.appId)) : [];
            return <AgentCard key={id} {...common} n={n} app={app} catalog={catalog} needs={der.needsByNode[id] ?? 0} kids={kids} lead={n.role === "lead" || (!!drill && id === leadOf(data, drill)?.id)} />;
          })}
          {Object.entries(lit).map(([vid, text]) => {
            const r = rectOf(layout, vid);
            if (!r) return null;
            return (
              <span key={`n${vid}`} className="notified" style={{ left: r.x + r.w / 2, top: r.y - 6, transform: `translate(-50%,-100%) scale(${1 / vp.current.zoom})` }}>
                <Ic name="Check" />
                {text}
              </span>
            );
          })}
          {abarRect && (abarTarget || ghostObj) ? (
            <div
              ref={(el) => {
                abarRef.current = el;
                if (el) {
                  el.dataset.below = abarBelow ? "1" : "0";
                  placeAbar();
                }
              }}
              className={cx("abar", abarBelow && "below")}
              role="toolbar"
              aria-label="Actions for the selected node"
              style={{ left: abarRect.x + abarRect.w / 2, top: abarBelow ? abarRect.y + abarRect.h + 12 : abarRect.y - 12 }}
            >
              {ghostObj ? (
                <>
                  <button type="button" disabled title="Adopting threads is not supported by this Helm backend yet">
                    <Ic name="Plus" size="sm" /> Adopt into run
                  </button>
                  <button type="button" onClick={() => nav.toThread(ghostObj.threadId, { split: true })}>
                    <Ic name="ExternalLink" size="sm" /> Open thread
                  </button>
                </>
              ) : abarTarget ? (
                <>
                  {data.apps[abarFor!] ? (
                    <>
                      <button type="button" data-testid="drill" onClick={() => drillInto(abarFor!)}>
                        <Ic name="Workflow" size="sm" /> Open squad
                      </button>
                      <span className="sepv" />
                    </>
                  ) : null}
                  <button type="button" data-testid="bar-tell" onClick={() => select(abarTarget.id, { tab: "direct", dtype: "tell" })}>
                    <Ic name="MessageSquare" size="sm" /> Tell
                  </button>
                  <button type="button" data-testid="bar-model" onClick={() => select(abarTarget.id, { tab: "direct", dtype: "model" })}>
                    <Ic name="Brain" size="sm" /> Model
                  </button>
                  {abarTarget.status === "planned" ? (
                    <button type="button" onClick={() => select(abarTarget.id, { tab: "direct", dtype: "spawn" })}>
                      <Ic name="Play" size="sm" /> Spawn now
                    </button>
                  ) : ["done", "idle", "failed"].includes(abarTarget.status) ? null : (
                    <button type="button" data-testid="bar-pause" onClick={() => select(abarTarget.id, { tab: "direct", dtype: abarTarget.status === "paused" ? "resume" : "pause" })}>
                      <Ic name={abarTarget.status === "paused" ? "Play" : "Pause"} size="sm" /> {abarTarget.status === "paused" ? "Resume" : "Pause"}
                    </button>
                  )}
                  <button type="button" data-testid="bar-direct" onClick={() => select(abarTarget.id, { tab: "direct" })}>
                    <Ic name="SlidersHorizontal" size="sm" /> More…
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* chrome: crumbs, search, filters */}
        <div className="ctl tl">
          <div className="glass crumbs">
            {a ? (
              <button type="button" className="crumb" onClick={() => setDrill(null)}>
                <Ic name="Layers" size="sm" /> Portfolio
              </button>
            ) : (
              <span className="crumb cur">
                <Ic name="Layers" size="sm" /> Portfolio
              </span>
            )}
            {a ? (
              <>
                {mgrOfDrill ? (
                  <>
                    <Ic name="ChevronRight" className="sep" />
                    <button type="button" className="crumb" onClick={() => h.focusNode(mgrOfDrill)}>
                      {data.managers.find((m) => m.id === mgrOfDrill)?.name}
                    </button>
                  </>
                ) : null}
                <Ic name="ChevronRight" className="sep" />
                <span className="crumb cur">{a.name} squad</span>
              </>
            ) : null}
          </div>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <label className="glass search">
              <Ic name="Search" />
              <input
                ref={searchRef}
                placeholder="Find agent, app or model"
                value={filter}
                aria-label="Find agent, app or model"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const hit = firstMatch();
                    if (hit) {
                      selectId(hit);
                      centerOn(hit, true);
                    }
                  } else if (e.key === "Escape") {
                    e.stopPropagation();
                    setFilter("");
                    (e.target as HTMLInputElement).blur();
                  }
                }}
              />
              <Kbd>/</Kbd>
            </label>
            <Seg<StatusFilter>
              className="glass"
              style={{ padding: 2 }}
              label="Status filter"
              value={sf}
              onChange={setSf}
              options={[
                ["all", "All"],
                ["running", "Running"],
                ["needs", "Needs you"],
                ["touched", "Touched by you"],
              ]}
            />
          </div>
        </div>
        <div className="ctl tr">
          {!a ? (
            <button type="button" className="btn glass sm" onClick={collapseAll} title="Collapse or expand every group">
              <Ic name="Layers" size="sm" /> {anyCollapsed ? "Expand all" : "Collapse all"}
            </button>
          ) : null}
          <button type="button" className={cx("btn glass sm", observatory && "on")} aria-pressed={observatory} onClick={() => setObservatory(!observatory)} title="Show BB threads outside this run (read-only)">
            <Ic name="Globe" size="sm" /> Observatory
          </button>
          <button type="button" className={cx("btn glass sm", outline && "on")} aria-pressed={outline} onClick={() => setOutline(!outline)} title="A list view of the same agents, for keyboard and screen readers">
            <Ic name="ListView" size="sm" /> Outline
          </button>
          <div className="glass zoomctl">
            <button type="button" className="iconbtn sm" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">
              <Ic name="ZoomOut" size="sm" />
            </button>
            <span className="zl" ref={zlRef}>
              100%
            </span>
            <button type="button" className="iconbtn sm" onClick={() => zoomBy(1.2)} aria-label="Zoom in">
              <Ic name="ZoomIn" size="sm" />
            </button>
            <button type="button" className="iconbtn sm" onClick={() => fit(true)} aria-label="Fit to screen" title="Fit to screen (F)">
              <Ic name="Maximize2" size="sm" />
            </button>
            <button type="button" className="iconbtn sm" onClick={(e) => setHelp(help ? null : e.currentTarget)} aria-label="Gestures and shortcuts" title="Gestures and shortcuts">
              <b style={{ font: "700 12px inherit" }}>?</b>
            </button>
          </div>
        </div>
        <div className="ctl bl">
          <div className="glass legend" aria-label="Legend">
            {(["running", "waiting", "queued", "needs", "failed", "done", "planned"] as const).map((s) => (
              <span key={s} className={cx("lgi", `s-${s}`)}>
                <Dot status={s} />
                {statusLabel(s)}
              </span>
            ))}
            <span className="lgi">
              <span className="touchb static">
                <Ic name="UserRound" />
                you
              </span>
              changed by you
            </span>
          </div>
        </div>
        <div className="ctl br">
          <div className="hint">
            {a ? "Click an agent to inspect or change it · " : "Double-click an app to open its squad · "}Drag to pan · <Kbd>⌘</Kbd>/<Kbd>Ctrl</Kbd> + scroll to zoom
          </div>
        </div>
      </div>
      {outline ? <Outline data={data} catalog={catalog} sel={sel} onSelect={(id) => select(id)} onClose={() => setOutline(false)} /> : null}
      {help ? (
        <Popover anchor={help} onClose={() => setHelp(null)} width={340} align="right" label="Gestures and shortcuts">
          <div className="ph">
            <span>Gestures and shortcuts</span>
            <button type="button" className="iconbtn sm" onClick={() => setHelp(null)} aria-label="Close">
              <Ic name="X" size="sm" />
            </button>
          </div>
          <div className="pb">
            <dl className="kv">
              <dt>Click</dt>
              <dd>Inspect an agent: chat, model, role, brief</dd>
              <dt>Double-click</dt>
              <dd>Open an app’s squad, or fold a manager</dd>
              <dt>Drag</dt>
              <dd>Pan the canvas</dd>
              <dt>⌘ / Ctrl + scroll</dt>
              <dd>Zoom</dd>
              <dt>/</dt>
              <dd>Find an agent, app or model</dd>
              <dt>F</dt>
              <dd>Fit to screen</dd>
              <dt>1 – 4</dt>
              <dd>Graph · Board · Ledger · Needs you</dd>
              <dt>Esc</dt>
              <dd>Close a dialog or popover</dd>
            </dl>
          </div>
        </Popover>
      ) : null}
    </div>
  );
}

function layoutIds(L: Layout, frame: "sf" | "gf"): string[] {
  const f = L.frames[frame];
  if (!f) return [];
  return Object.entries(L.rects)
    .filter(([, r]) => r.x >= f.x && r.y >= f.y && r.x < f.x + f.w && r.y < f.y + f.h)
    .map(([id]) => id);
}

// ───────────── cards ─────────────

interface CardCommon {
  id: string;
  r: PlacedRect;
  sel: boolean;
  within: boolean;
  dim: boolean;
  hit: boolean;
  pulse: boolean;
  chain: boolean;
  flash: boolean;
  onClick: (e: ReactMouseEvent, id: string) => void;
  onDouble: (id: string, mode: string) => void;
  onKey: (e: ReactKeyboardEvent, id: string, mode: string) => void;
}

function cardProps(c: CardCommon, cls: string, label: string) {
  return {
    className: cx("node", cls, c.sel && "sel", c.within && "within", c.dim && "dim", c.hit && "hit", c.pulse && "pulse", c.chain && "chainlit", c.flash && "flash"),
    style: { left: c.r.x, top: c.r.y, width: c.r.w, height: c.r.h },
    tabIndex: 0,
    role: "button" as const,
    "aria-label": label,
    "aria-pressed": c.sel,
    "data-id": c.id,
    onClick: (e: ReactMouseEvent) => c.onClick(e, c.id),
    onDoubleClick: () => c.onDouble(c.id, c.r.mode),
    onKeyDown: (e: ReactKeyboardEvent) => c.onKey(e, c.id, c.r.mode),
  };
}

function Badges({ touched, needs }: { touched: number; needs: number }) {
  return (
    <>
      {touched ? (
        <span className="touchb" title="Changed by you">
          <Ic name="UserRound" />
          you{touched > 1 ? ` ×${touched}` : ""}
        </span>
      ) : null}
      {needs ? (
        <span className="needb" title="Needs you">
          <Ic name="BellDot" />
          {needs}
        </span>
      ) : null}
    </>
  );
}

const AppCard = memo(function AppCard(p: CardCommon & { app: SnapApp; status: string; members: SnapNode[]; needs: number; expanded: boolean; onToggle: (id: string) => void }) {
  const touched = p.members.filter((m) => m.touched).length;
  return (
    <div {...cardProps(p, cx("app", `s-${p.status}`, touched > 0 && "touched-ring"), `${p.app.name} app, ${stageLabel(p.app.stage)}, ${statusLabel(p.status)}`)}>
      <Badges touched={touched} needs={p.needs} />
      <div className="a-top">
        <b className="a-name">{p.app.name}</b>
        <StagePill stage={p.app.stage} />
        <button type="button" className="iconbtn sm" data-act="expand" title={p.expanded ? "Fold this app’s agents" : "Show this app’s agents in place"} aria-label={p.expanded ? `Fold ${p.app.name}` : `Expand ${p.app.name}`} onClick={() => p.onToggle(p.id)}>
          <Ic name={p.expanded ? "ChevronDown" : "ChevronRight"} size="sm" />
        </button>
      </div>
      <div className="dots">
        {p.members.map((m) => (
          <Dot key={m.id} status={m.status} touched={m.touched} title={`${agentTitle(m)} · ${statusLabel(m.status)}`} />
        ))}
      </div>
      <div className="a-bot">
        <span className="a-plats">{p.app.platforms.join(" · ")}</span>
        <span className="mono muted" style={{ fontSize: 10.5 }} title="Derived from the stage, never claimed by an agent">
          {p.app.pct}%
        </span>
      </div>
    </div>
  );
});

const TierCard = memo(function TierCard(
  p: CardCommon & { n: SnapNode; catalog: Catalog | null; sub: string; needs: number; appDots: Array<{ id: string; name: string; status: string; stage?: string }>; collapsed: boolean; onToggle?: (id: string) => void },
) {
  const isM = p.r.mode === "mgr";
  return (
    <div {...cardProps(p, cx("tier", `s-${p.n.status}`, p.n.touched && "touched-ring"), `${isM ? "Manager" : p.n.label} ${p.sub}, ${statusLabel(p.n.status)}`)}>
      <Badges touched={p.n.touched ? 1 : 0} needs={p.needs} />
      <div className="n-head">
        <RoleTile node={p.n} />
        <div className="n-title">
          <b>{isM ? "Manager" : p.n.label}</b>
          <span className="n-sub">{p.sub}</span>
        </div>
        {p.onToggle ? (
          <button type="button" className="iconbtn sm" data-act="toggle-collapse" title={`${p.collapsed ? "Show" : "Hide"} this manager’s apps`} aria-label={`${p.collapsed ? "Show" : "Hide"} apps`} aria-expanded={!p.collapsed} onClick={() => p.onToggle?.(p.id)}>
            <Ic name={p.collapsed ? "ChevronRight" : "ChevronDown"} size="sm" />
          </button>
        ) : (
          <StatusPill status={p.n.status} />
        )}
      </div>
      <ModelChip model={p.n.model} catalog={p.catalog} planned={p.n.status === "planned"} />
      <div className="now">{nowFallback(p.n)}</div>
      {isM ? (
        <div className="dots" style={{ marginTop: 1 }}>
          {p.appDots.map((a) => (
            <Dot key={a.id} status={a.status} title={`${a.name} · ${a.stage ? stageLabel(a.stage) : ""}`} />
          ))}
          <span className="mono muted" style={{ fontSize: 10, marginLeft: 4 }}>
            {p.collapsed ? `${plural(p.appDots.length, "app")} hidden` : ""}
          </span>
        </div>
      ) : null}
    </div>
  );
});

const ChipCard = memo(function ChipCard(p: CardCommon & { n: SnapNode; catalog: Catalog | null; title: string }) {
  return (
    <div {...cardProps(p, cx("tier", `s-${p.n.status}`), `${p.title}, ${statusLabel(p.n.status)}`)} style={{ left: p.r.x, top: p.r.y, width: p.r.w, height: p.r.h, flexDirection: "row", alignItems: "center", gap: 9, padding: "0 12px 0 14px" }}>
      <Badges touched={p.n.touched ? 1 : 0} needs={0} />
      <RoleTile node={p.n} />
      <div className="n-title">
        <b>{p.title}</b>
        <span className="n-sub">{p.n.model ? `${modelName(p.catalog, p.n.model)}${p.n.model.reasoning ? ` · ${p.n.model.reasoning}` : ""}` : "model not set"}</span>
      </div>
      <StatusPill status={p.n.status} />
    </div>
  );
});

const AgentCard = memo(function AgentCard(p: CardCommon & { n: SnapNode; app: SnapApp | null; catalog: Catalog | null; needs: number; kids: SnapNode[]; lead: boolean }) {
  const n = p.n;
  const title = n.role === "orch" ? n.label : agentTitle(n);
  const sub = n.role === "orch" ? (p.app ? `also leads ${p.app.name}` : "Orchestrator") : `${p.app?.name ?? ""}${n.priority === "high" ? " · high priority" : n.priority === "low" ? " · low priority" : ""}`;
  return (
    <div {...cardProps(p, cx("agent", `s-${n.status}`, n.tier === "gate" && "gate", n.touched && "touched-ring"), `${title}${p.app ? `, ${p.app.name}` : ""}, ${statusLabel(n.status)}`)}>
      <Badges touched={n.touched ? 1 : 0} needs={p.needs} />
      <div className="n-head">
        <RoleTile node={n} />
        <div className="n-title">
          <b>{title}</b>
          <span className="n-sub">{sub}</span>
        </div>
        <StatusPill status={n.status} />
      </div>
      <ModelChip model={n.model} catalog={p.catalog} planned={n.status === "planned"} />
      <div className="now">{nowFallback(n)}</div>
      {p.lead && p.kids.length ? (
        <div className="dots" style={{ marginTop: 2 }}>
          {p.kids.map((c) => (
            <Dot key={c.id} status={c.status} touched={c.touched} title={`${agentTitle(c)} · ${statusLabel(c.status)}`} />
          ))}
          {p.app ? (
            <span className="mono muted" style={{ fontSize: 10, marginLeft: 5 }}>
              {stageLabel(p.app.stage)} · {p.app.pct}%
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

const GhostCard = memo(function GhostCard(p: CardCommon & { g: ForeignThread }) {
  const st = p.g.status ?? "idle";
  return (
    <div {...cardProps(p, cx("ghostn", `s-${st}`), `Outside this run: ${p.g.title ?? p.g.threadId}, read-only`)}>
      <div className="n-head">
        <span className="tile">
          <Ic name="Globe" />
        </span>
        <div className="n-title">
          <b>{p.g.title || "Untitled thread"}</b>
          <span className="n-sub">{p.g.providerId ?? "thread"} · read-only</span>
        </div>
        <span className={cx("stpill", `s-${st}`)}>{statusLabel(st)}</span>
      </div>
      <div className="now">{p.g.updatedAt ? `Updated ${new Date(p.g.updatedAt).toLocaleString()}` : "Not part of this run"}</div>
    </div>
  );
});

// ───────────── Outline: the same agents as an accessible tree ─────────────

function Outline({ data, catalog, sel, onSelect, onClose }: { data: RunState; catalog: Catalog | null; sel: string | null; onSelect: (id: string) => void; onClose: () => void }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(data.nodeOrder.filter((id) => data.nodes[id].tier !== "specialist" && data.nodes[id].tier !== "gate")));
  const treeRef = useRef<HTMLUListElement>(null);
  const roots = data.nodeOrder.filter((id) => !data.nodes[id].parentId);
  const toggle = (id: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const onKey = (e: ReactKeyboardEvent<HTMLLIElement>, id: string) => {
    const items = Array.from(treeRef.current?.querySelectorAll<HTMLElement>("[role=treeitem]") ?? []);
    const i = items.indexOf(e.currentTarget);
    const kids = data.children[id] ?? [];
    if (e.key === "ArrowDown") items[i + 1]?.focus();
    else if (e.key === "ArrowUp") items[i - 1]?.focus();
    else if (e.key === "ArrowRight" && kids.length && !open.has(id)) toggle(id);
    else if (e.key === "ArrowLeft" && open.has(id)) toggle(id);
    else if (e.key === "ArrowLeft") {
      const p = data.nodes[id]?.parentId;
      if (p) treeRef.current?.querySelector<HTMLElement>(`[data-oid="${CSS.escape(p)}"]`)?.focus();
    } else if (e.key === "Enter" || e.key === " ") onSelect(id);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const item = (id: string, level: number): ReactElement => {
    const n = data.nodes[id];
    const kids = data.children[id] ?? [];
    const app = n.appId ? data.apps[n.appId] : null;
    const isOpen = open.has(id);
    return (
      <li key={id} role="treeitem" aria-level={level} aria-expanded={kids.length ? isOpen : undefined} aria-selected={sel === id} tabIndex={0} data-oid={id} onKeyDown={(e) => onKey(e, id)}>
        <div className={cx("orow", sel === id && "sel")} style={{ paddingLeft: 8 + (level - 1) * 18 }} onClick={() => onSelect(id)}>
          <span className="tw" onClick={(e) => (e.stopPropagation(), kids.length && toggle(id))} aria-hidden="true">
            {kids.length ? <Ic name={isOpen ? "ChevronDown" : "ChevronRight"} size="sm" /> : null}
          </span>
          <RoleTile node={n} />
          <span className="grow trunc">
            <b>{n.role === "orch" ? n.label : n.role === "mgr" ? n.label : agentTitle(n)}</b>
            {app && n.role !== "orch" ? <span className="muted"> · {app.name}</span> : null}
            {n.role === "lead" && app ? <span className="muted"> · {stageLabel(app.stage)}</span> : null}
          </span>
          {n.touched ? <span className="pill human">changed by you</span> : null}
          <ModelChip model={n.model} catalog={catalog} />
          <StatusPill status={n.status} />
        </div>
        {kids.length && isOpen ? (
          <ul role="group" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {kids.map((k) => item(k, level + 1))}
          </ul>
        ) : null}
      </li>
    );
  };
  return (
    <div className="outline" role="region" aria-label="Outline of agents">
      <div className="row" style={{ maxWidth: 880, margin: "0 auto 10px", justifyContent: "space-between" }}>
        <b>Outline · {plural(data.nodeOrder.length, "agent")}</b>
        <button type="button" className="btn sm" onClick={onClose}>
          <Ic name="Workflow" size="sm" /> Back to graph
        </button>
      </div>
      <ul role="tree" aria-label="Agents" ref={treeRef} style={{ listStyle: "none", margin: "0 auto" }}>
        {roots.map((id) => item(id, 1))}
      </ul>
    </div>
  );
}
