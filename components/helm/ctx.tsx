// Frame-level state shared by every Helm area: the selected run, its live
// store, the catalog, view/selection/inspector state, overlays and pulses.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { Catalog, DirectiveInfo, DirectiveType, InspTab, ReceiptState, RunListItem, SnapApp, SnapNode, View } from "./types.ts";
import { useCatalog, useHelmRpc, useRunData, useRuns, type HelmRpc } from "./data.ts";
import type { BatchEffects, RunState } from "./store.ts";
import { lsGet, lsSet, useStored } from "./persist.ts";
import { resolveSession } from "./store.ts";

export interface PulseEvent {
  key: number;
  directive: DirectiveInfo;
}
export interface ReceiptFlash {
  key: number;
  directiveId: string;
  nodeId: string;
  state: ReceiptState;
}

export interface StudioOpts {
  /** focus this slot when opening */
  slot?: string;
}

export interface HelmCtx {
  rpc: HelmRpc;
  rootRef: RefObject<HTMLDivElement | null>;
  runs: RunListItem[] | null;
  runsError: string | null;
  refreshRuns: () => void;
  runId: string | null;
  /** Show a run; it also opens a session tab for it. */
  setRunId: (id: string | null) => void;
  /** Runs open as session tabs, in tab order (remembered in this browser). */
  tabs: string[];
  /** Close a session tab; the run itself keeps going. */
  closeTab: (id: string) => void;
  /** A fresh session: the start page, with no run selected. */
  newSession: () => void;
  data: RunState | null;
  rev: number;
  loading: boolean;
  error: string | null;
  refetch: () => void;
  catalog: Catalog | null;
  catalogError: string | null;
  loadCatalog: (opts?: { refresh?: boolean; markSeen?: boolean }) => Promise<Catalog | null>;

  view: View;
  setView: (v: View) => void;
  sel: string | null;
  /** select a node (or ghost id "ghost:<threadId>") and open the inspector */
  select: (id: string | null, opts?: { tab?: InspTab; dtype?: DirectiveType; keepClosed?: boolean }) => void;
  tab: InspTab;
  setTab: (t: InspTab) => void;
  /** a directive type the Direct tab should start with (set by "Model", "Pause"… actions) */
  draftType: { type: DirectiveType; key: number } | null;
  inspOpen: boolean;
  setInspOpen: (v: boolean) => void;
  inspWide: boolean;
  setInspWide: (v: boolean) => void;
  /** The inspector's width in px once the user has dragged its edge (null: the default or wide width). */
  inspW: number | null;
  setInspW: (v: number | null) => void;
  drill: string | null;
  setDrill: (appId: string | null) => void;
  /** go to the graph and centre a node */
  focusNode: (id: string) => void;
  focusReq: { id: string; key: number } | null;
  observatory: boolean;
  setObservatory: (v: boolean) => void;

  studio: StudioOpts | null;
  openStudio: (o?: StudioOpts) => void;
  closeStudio: () => void;
  /** The Git agent's Worktrees view: every app's worktrees and branches, their state and size. */
  worktreesOpen: boolean;
  openWorktrees: () => void;
  closeWorktrees: () => void;
  screensOpen: boolean;
  /** The app Screens opens on (null: the first). */
  screensApp: string | null;
  openScreens: (appId?: string | null) => void;
  closeScreens: () => void;
  wizardOpen: boolean;
  setWizardOpen: (v: boolean) => void;

  /** realtime-derived animation triggers */
  pulse: PulseEvent | null;
  /** fire a pulse locally right after sending (the realtime echo is de-duplicated) */
  firePulse: (d: DirectiveInfo) => void;
  flashes: ReceiptFlash[];

  /** helpers over the live store */
  node: (id: string | null | undefined) => SnapNode | null;
  app: (id: string | null | undefined) => SnapApp | null;
}

const Ctx = createContext<HelmCtx | null>(null);

export function useHelm(): HelmCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useHelm outside HelmProvider");
  return c;
}

const LS_RUN = "helm:lastRun";
const LS_TABS = "helm:tabs";
function readTabs(): string[] | null {
  const raw = lsGet(LS_TABS);
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 20) : [];
  } catch {
    return [];
  }
}
export function HelmProvider({ children, rootRef }: { children: ReactNode; rootRef: RefObject<HTMLDivElement | null> }) {
  const rpc = useHelmRpc();
  const { runs, error: runsError, refresh: refreshRuns } = useRuns(rpc);
  const [runId, setRunIdState] = useState<string | null>(() => lsGet(LS_RUN));
  const { catalog, error: catalogError, load: loadCatalog } = useCatalog(rpc);

  const [pulse, setPulse] = useState<PulseEvent | null>(null);
  const [flashes, setFlashes] = useState<ReceiptFlash[]>([]);
  const pulsed = useRef(new Set<string>());
  const key = useRef(0);
  const firePulse = useCallback((d: DirectiveInfo) => {
    if (pulsed.current.has(d.id)) return;
    pulsed.current.add(d.id);
    setPulse({ key: ++key.current, directive: d });
  }, []);
  const onEffects = useCallback(
    (fx: BatchEffects) => {
      for (const d of fx.created) if (d.actor !== "system") firePulse(d);
      if (fx.receipts.length) {
        const add = fx.receipts.map((r) => ({ key: ++key.current, ...r }));
        setFlashes((f) => [...f.slice(-30), ...add]);
      }
    },
    [firePulse],
  );
  const { state: data, rev, loading, error, refetch } = useRunData(rpc, runId, onEffects);

  // session tabs: every run you opened stays one click away until you close its tab
  const [tabs, setTabsState] = useState<string[]>(() => readTabs() ?? (lsGet(LS_RUN) ? [lsGet(LS_RUN)!] : []));
  const firstTabs = useRef(readTabs() === null);
  const setTabs = useCallback((f: (t: string[]) => string[]) => {
    setTabsState((t) => {
      const next = f(t);
      lsSet(LS_TABS, JSON.stringify(next));
      return next;
    });
  }, []);

  // pick a run once the runs list is known (see resolveSession); a deliberate fresh session stays blank
  const firstLoad = useRef(true);
  useEffect(() => {
    if (!runs) return;
    const r = resolveSession(runs.map((x) => x.id), runId, tabs, { firstLoad: firstLoad.current, firstVisit: firstTabs.current });
    firstLoad.current = false;
    firstTabs.current = false;
    if (r.tabs.join() !== tabs.join()) setTabs(() => r.tabs);
    if (r.runId !== runId) {
      setRunIdState(r.runId);
      lsSet(LS_RUN, r.runId);
    }
  }, [runs, runId]); // eslint-disable-line react-hooks/exhaustive-deps

  const [view, setView] = useStored<View>("helm:view", "graph", (v) => ["graph", "board", "ledger", "needs"].includes(v as string));
  const [sel, setSel] = useStored<string | null>("helm:sel", null, (v) => v === null || typeof v === "string");
  const [tab, setTab] = useStored<InspTab>("helm:tab", "overview");
  const [draftType, setDraftType] = useState<{ type: DirectiveType; key: number } | null>(null);
  const [inspOpen, setInspOpen] = useState<boolean>(() => {
    const w = rootRef.current?.clientWidth ?? globalThis.innerWidth ?? 1400;
    return w > 1100;
  });
  const [inspWide, setInspWide] = useStored("helm:inspWide", false);
  const [inspW, setInspW] = useStored<number | null>("helm:inspW", null, (v) => v === null || (typeof v === "number" && v >= 280 && v <= 4000));
  const [drill, setDrill] = useStored<string | null>("helm:drill", null, (v) => v === null || typeof v === "string");
  const [focusReq, setFocusReq] = useState<{ id: string; key: number } | null>(null);
  const [observatory, setObservatory] = useState(false);
  const [studio, setStudio] = useState<StudioOpts | null>(null);
  const [screensOpen, setScreensOpen] = useState(false);
  const [screensApp, setScreensApp] = useState<string | null>(null);
  const [worktreesOpen, setWorktreesOpen] = useState(false);
  // the wizard stays open (with its draft) when you leave the panel and come back
  const [wizardOpen, setWizardOpen] = useStored("helm:wizardOpen", false);

  const setRunId = useCallback((id: string | null) => {
    setRunIdState(id);
    lsSet(LS_RUN, id);
    if (id) setTabs((t) => (t.includes(id) ? t : [...t, id]));
    setSel(null);
    setDrill(null);
    setTab("overview");
  }, [setTabs]);
  const newSession = useCallback(() => setRunId(null), [setRunId]);
  const closeTab = useCallback(
    (id: string) => {
      const i = tabs.indexOf(id);
      const rest = tabs.filter((x) => x !== id);
      setTabs(() => rest);
      if (id === runId) setRunId(rest[Math.min(Math.max(i, 0), rest.length - 1)] ?? null);
    },
    [tabs, runId, setTabs, setRunId],
  );

  const select = useCallback((id: string | null, opts: { tab?: InspTab; dtype?: DirectiveType; keepClosed?: boolean } = {}) => {
    setSel(id);
    if (opts.tab) setTab(opts.tab);
    if (opts.dtype) setDraftType({ type: opts.dtype, key: ++key.current });
    if (id && !opts.keepClosed) setInspOpen(true);
  }, []);

  const node = useCallback((id: string | null | undefined) => (id && data ? data.nodes[id] ?? null : null), [data, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const app = useCallback((id: string | null | undefined) => (id && data ? data.apps[id] ?? null : null), [data, rev]); // eslint-disable-line react-hooks/exhaustive-deps

  const focusNode = useCallback(
    (id: string) => {
      const n = data?.nodes[id];
      setView("graph");
      // a specialist or gate is easiest to see inside its squad; tier nodes in the portfolio
      if (n && n.appId && (n.tier === "specialist" || n.tier === "gate" || n.tier === "lead")) setDrill(n.appId);
      else if (n) setDrill(null);
      setSel(id);
      setInspOpen(true);
      setFocusReq({ id, key: ++key.current });
    },
    [data],
  );

  // drop selection that vanished with a refetch
  useEffect(() => {
    if (sel && data && !sel.startsWith("ghost:") && !data.nodes[sel]) setSel(null);
    if (drill && data && !data.apps[drill]) setDrill(null);
  }, [data, rev, sel, drill]);

  const value = useMemo<HelmCtx>(
    () => ({
      rpc,
      rootRef,
      runs,
      runsError,
      refreshRuns,
      runId,
      setRunId,
      tabs,
      closeTab,
      newSession,
      data,
      rev,
      loading,
      error,
      refetch,
      catalog,
      catalogError,
      loadCatalog,
      view,
      setView,
      sel,
      select,
      tab,
      setTab,
      draftType,
      inspOpen,
      setInspOpen,
      inspWide,
      setInspWide,
      inspW,
      setInspW,
      drill,
      setDrill,
      focusNode,
      focusReq,
      observatory,
      setObservatory,
      studio,
      openStudio: (o: StudioOpts = {}) => setStudio(o),
      closeStudio: () => setStudio(null),
      worktreesOpen,
      openWorktrees: () => setWorktreesOpen(true),
      closeWorktrees: () => setWorktreesOpen(false),
      screensOpen,
      screensApp,
      openScreens: (appId?: string | null) => {
        setScreensApp(appId ?? null);
        setScreensOpen(true);
      },
      closeScreens: () => setScreensOpen(false),
      wizardOpen,
      setWizardOpen,
      pulse,
      firePulse,
      flashes,
      node,
      app,
    }),
    [rpc, rootRef, runs, runsError, refreshRuns, runId, setRunId, tabs, closeTab, newSession, data, rev, loading, error, refetch, catalog, catalogError, loadCatalog, view, sel, select, tab, draftType, inspOpen, inspWide, inspW, drill, focusNode, focusReq, observatory, studio, worktreesOpen, screensOpen, screensApp, wizardOpen, pulse, firePulse, flashes, node, app],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// ───────────── Escape stack: the top-most overlay closes first ─────────────

const escStack: Array<{ id: number; fn: () => void }> = [];
let escId = 0;
/** Register an Escape handler while `active`; the most recent registration wins. */
export function useEscape(fn: () => void, active = true) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    const id = ++escId;
    escStack.push({ id, fn: () => ref.current() });
    return () => {
      const i = escStack.findIndex((e) => e.id === id);
      if (i >= 0) escStack.splice(i, 1);
    };
  }, [active]);
}
/** Run the top-most Escape handler. Returns false when nothing was open. */
export function popEscape(): boolean {
  const top = escStack[escStack.length - 1];
  if (!top) return false;
  top.fn();
  return true;
}
