// The Helm frame: top bar (brand · run switcher · tabs · caps · spend · Models
// · inspector toggle · New run), the main view, the Inspector, overlays,
// first-run states and global shortcuts.
import { Component, Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { toast } from "sonner";
import { useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";
import { HelmProvider, popEscape, useHelm } from "./ctx.tsx";
import type { View } from "./types.ts";
import { PROVIDER_LABEL, STAGES, STAGE_IDX, agoOf, clockOf, errMsg, fmtUnits, forecastNodes, plural, providerVar } from "./format.ts";
import { openNeeds } from "./store.ts";
import { Banner, DialogHost, Ic, Popover, askConfirm, cx } from "./ui.tsx";
import { GraphView } from "./graph.tsx";
import { BoardView } from "./board.tsx";
import { LedgerView } from "./ledger.tsx";
import { NeedsView } from "./needs.tsx";
import { Inspector } from "./inspector/index.tsx";
import { StudioModal } from "./studio.tsx";
import { ScreensModal } from "./screens.tsx";
import { EXAMPLES, WizardModal, seedWizardBrief, seedWizardMode } from "./wizard.tsx";
import { reportClientError } from "./data.ts";
import { StartBar, useStartRun } from "./startbar.tsx";

export function HelmApp() {
  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <div className="helm" ref={rootRef} data-testid="helm-root">
      <HelmProvider rootRef={rootRef}>
        <CrashBoundary>
          <Frame />
        </CrashBoundary>
      </HelmProvider>
    </div>
  );
}

/** A crash anywhere in the panel is reported to the error journal and offers a retry instead of a blank panel. */
class CrashBoundary extends Component<{ children: ReactNode }, { err: string | null; key: number }> {
  state = { err: null as string | null, key: 0 };
  static getDerivedStateFromError(e: unknown) {
    return { err: e instanceof Error ? e.message : String(e) };
  }
  componentDidCatch(e: unknown, info: ErrorInfo) {
    const stack = e instanceof Error && e.stack ? e.stack.split("\n").slice(0, 6).join("\n") : "";
    reportClientError("error", "panel crash", e instanceof Error ? e.message : String(e), `${stack}\n${(info.componentStack ?? "").split("\n").slice(0, 8).join("\n")}`);
  }
  render() {
    if (!this.state.err) return <Fragment key={this.state.key}>{this.props.children}</Fragment>;
    return (
      <div className="hero" style={{ gridRow: "2 / span 2" }}>
        <div className="hero-in">
          <Banner tone="crit">
            Helm's panel hit an error: {this.state.err}. It has been recorded (run <code>bb helm errors</code>). Your runs are not affected.
          </Banner>
          <button type="button" className="btn primary" onClick={() => this.setState((s) => ({ err: null, key: s.key + 1 }))}>
            <Ic name="RotateCcw" size="sm" /> Try again
          </button>
        </div>
      </div>
    );
  }
}

const VIEWS: View[] = ["graph", "board", "ledger", "needs"];

function Frame() {
  const h = useHelm();
  const { data, view, setView, inspOpen, setInspOpen, rootRef } = h;

  // below 1100 px (the panel's width, not the window's) the Inspector is an overlay and starts closed
  useLayoutEffect(() => {
    const w = rootRef.current?.clientWidth ?? 0;
    if (w && w <= 1100) setInspOpen(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // global keys: Esc closes the top-most overlay (then the overlay Inspector); 1–4 switch views
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = rootRef.current;
      const t = e.target instanceof Element ? (e.target as HTMLElement) : null;
      if (!root || (t && t !== document.body && !root.contains(t))) return;
      if (e.key === "Escape") {
        if (popEscape()) {
          e.preventDefault();
          return;
        }
        if (inspOpen && root.clientWidth <= 1100) {
          e.preventDefault();
          setInspOpen(false);
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (t.closest("input, textarea, select, [contenteditable=true], .modal, .pop") || t.isContentEditable)) return;
      const i = ["1", "2", "3", "4"].indexOf(e.key);
      if (i >= 0) {
        e.preventDefault();
        setView(VIEWS[i]);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [rootRef, inspOpen, setInspOpen, setView]);

  const startPage = h.runs !== null && (h.runs.length === 0 || !h.runId);
  const showInspector = inspOpen && !!data && !!h.runId;

  return (
    <>
      <TopBar />
      <RunTabs />
      <div className="main">
        <section className="stagewrap" aria-label="Main view">
          {!startPage && data ? <StartBar /> : null}
          <div className="stagebody">
          {startPage ? (
            <Hero />
          ) : !data ? (
            <div className="hero">
              <div className="hero-in">
                {h.error ? (
                  <Banner tone="crit">
                    Could not load the run: {h.error}{" "}
                    <button type="button" className="link" onClick={h.refetch}>
                      Retry
                    </button>
                  </Banner>
                ) : h.runsError ? (
                  <Banner tone="crit">Could not list runs: {h.runsError}</Banner>
                ) : (
                  <span className="muted">Loading…</span>
                )}
              </div>
            </div>
          ) : (
            <>
              <GraphView active={view === "graph"} />
              {view === "board" ? (
                <div className="view">
                  <BoardView />
                </div>
              ) : null}
              {view === "ledger" ? (
                <div className="view">
                  <LedgerView />
                </div>
              ) : null}
              {view === "needs" ? (
                <div className="view">
                  <NeedsView />
                </div>
              ) : null}
            </>
          )}
          </div>
        </section>
        {showInspector ? <Inspector /> : null}
      </div>
      <StudioModal />
      <ScreensModal />
      <WizardModal />
      <DialogHost />
    </>
  );
}

// ───────────── session tabs ─────────────

function RunTabs() {
  const h = useHelm();
  const runs = h.runs ?? [];
  if (!runs.length) return <div className="runtabs" />;
  const byId = new Map(runs.map((r) => [r.id, r]));
  const open = h.tabs.filter((id) => byId.has(id));
  return (
    <div className="runtabs" role="tablist" aria-label="Open sessions">
      {open.map((id) => {
        const r = byId.get(id)!;
        const live = r.status === "running" || r.status === "paused";
        return (
          <div key={id} className={cx("rtab", id === h.runId && "on")}>
            <button type="button" role="tab" aria-selected={id === h.runId} className="rt-main" onClick={() => h.setRunId(id)} title={`${r.name} · ${plural(r.apps, "app")} · ${r.status}`}>
              <span className={cx("live-dot", !live && "off")} />
              <span className="trunc">{r.name}</span>
              {live ? null : <span className="rt-st">{r.status}</span>}
              {r.needs ? (
                <span className="count warn" aria-label={`${r.needs} need you`}>
                  {r.needs}
                </span>
              ) : null}
            </button>
            <button type="button" className="rt-x" onClick={() => h.closeTab(id)} aria-label={`Close ${r.name} (the run keeps going)`} title="Close this tab — the run keeps going">
              <Ic name="X" size="sm" />
            </button>
          </div>
        );
      })}
      {!h.runId ? (
        <div className="rtab on">
          <span className="rt-main">
            <Ic name="Plus" size="sm" /> New session
          </span>
        </div>
      ) : null}
      <button type="button" className="rt-new" onClick={h.newSession} title="Start a fresh session (your runs keep going)" data-testid="new-session">
        <Ic name="Plus" size="sm" /> {h.runId ? "New session" : ""}
      </button>
    </div>
  );
}

// ───────────── top bar ─────────────

function TopBar() {
  const h = useHelm();
  const { data, view, setView, catalog } = h;
  const conn = useRealtimeConnectionState();
  const [pop, setPop] = useState<{ kind: "run" | "cap" | "perm"; el: HTMLElement } | null>(null);
  const toggle = (kind: "run" | "cap", el: HTMLElement) => setPop((p) => (p && p.kind === kind ? null : { kind, el }));
  const run = data?.run ?? null;
  const nodes = useMemo(() => (data ? data.nodeOrder.map((id) => data.nodes[id]) : []), [data, h.rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = data ? openNeeds(data).length : 0;
  const spawned = nodes.filter((n) => n.threadId).length;
  const running = nodes.filter((n) => n.status === "running").length;
  const maxAgents = run?.limits?.maxTotalAgents ?? run?.maxAgents ?? 250;
  const fc = useMemo(() => (run ? forecastNodes(nodes, run.slots, catalog) : null), [nodes, run, catalog]);
  const live = run && (run.status === "running" || run.status === "paused");

  const tab = (id: View, label: string, icon: string, extra?: ReactNode) => (
    <button key={id} type="button" role="tab" aria-selected={view === id} className={cx("tab", view === id && "on")} onClick={() => setView(id)} data-testid={`view-${id}`}>
      <Ic name={icon} />
      <span className="tl">{label}</span>
      {extra}
    </button>
  );

  return (
    <>
    <header className="topbar">
      <div className="brand">
        <span className="logo">
          <Ic name="Workflow" />
        </span>
        <span className="wm">Helm</span>
      </div>
      {h.runId && h.runs && h.runs.length ? (
        <button type="button" className="runsw" onClick={(e) => toggle("run", e.currentTarget)} aria-label="Run details and switcher" aria-haspopup="dialog" aria-expanded={pop?.kind === "run"}>
          <span className={cx("live-dot", !live && "off")} title={live ? (conn === "connected" ? "Live" : "Reconnecting…") : run?.status ?? ""} />
          <b>{run?.name ?? "Loading…"}</b>
          {run ? (
            <span className="muted rs-sub">
              {plural(data!.appOrder.length, "app")} · {run.status}
              {run.dryRun ? " · dry run" : ""}
            </span>
          ) : null}
          <Ic name="ChevronDown" size="sm" />
        </button>
      ) : null}
      {data ? (
        <nav className="tabs" role="tablist" aria-label="Views">
          {tab("graph", "Graph", "Workflow")}
          {tab("board", "Board", "Columns2")}
          {tab("ledger", "Ledger", "ListTodo", <span className="count">{data.directives.length}</span>)}
          {tab(
            "needs",
            "Needs you",
            "BellDot",
            <span className={cx("count", open > 0 && "warn")} aria-label={`${open} open`}>
              {open}
            </span>,
          )}
        </nav>
      ) : null}
      <span className="spacer" />
      {conn !== "connected" && data ? (
        <span className="pill warn" title="Realtime connection lost; Helm will resync when it returns">
          Reconnecting…
        </span>
      ) : null}
      {run?.spawnsPaused ? (
        <span className="pill warn" title="Running agents finish their turn; nothing new starts">
          Spawns paused
        </span>
      ) : null}
      {run ? (
        <>
          <button type="button" className="chip cap" onClick={(e) => toggle("cap", e.currentTarget)} aria-label={`Capacity: ${spawned} of ${maxAgents} agents, ${running} of ${run.concurrency} running`} aria-haspopup="dialog">
            <Ic name="Bot" size="sm" />
            <span>
              <b>{spawned}</b>/{maxAgents}
              <span className="lbl-hide"> agents</span>
            </span>
            <i className="sep" />
            <span>
              <b>{running}</b>/{run.concurrency}
              <span className="lbl-hide"> running</span>
            </span>
          </button>
          <span className="chip" title="Spent so far / forecast to finish (relative weights, not real prices)">
            <span>
              <b>{fmtUnits(run.spend)}</b>
              <span className="lbl-hide"> spent</span>
            </span>
            <i className="sep fc" />
            <span className="fc">
              ~<b>{fmtUnits(fc?.units ?? 0)}</b>
            </span>
          </span>
        </>
      ) : null}
      <button type="button" className="btn" onClick={() => h.openScreens()} disabled={!run} title="Screens: click through each app's own screens, page by page, as they look on its device (nothing runs)" aria-label="Screens" aria-pressed={h.screensOpen} data-testid="screens">
        <Ic name="Smartphone" size="sm" />
        <span className="btn-lbl"> Screens</span>
      </button>
      <button type="button" className="btn" onClick={(e) => setPop(pop?.kind === "perm" ? null : { kind: "perm", el: e.currentTarget })} title="Permissions: what agents may do, and who approves their prompts" aria-label="Permissions" aria-expanded={pop?.kind === "perm"} data-testid="permissions">
        <Ic name="SecurityCheck" size="sm" />
        <span className="btn-lbl"> Permissions</span>
      </button>
      <button type="button" className="btn" onClick={() => h.openStudio()} title="Model Studio" aria-label="Model Studio" data-testid="studio">
        <Ic name="SlidersHorizontal" size="sm" />
        <span className="btn-lbl"> Models</span>
      </button>
      {data ? (
        <button type="button" className={cx("iconbtn", h.inspOpen && "on")} onClick={() => h.setInspOpen(!h.inspOpen)} title="Show or hide the inspector" aria-label="Toggle inspector" aria-pressed={h.inspOpen}>
          <Ic name="PanelRight" />
        </button>
      ) : null}
      <button type="button" className="btn primary" onClick={() => h.setWizardOpen(true)} data-testid="new-run">
        <Ic name="Plus" size="sm" /> <span className="btn-lbl">New run</span>
      </button>
    </header>
    {pop?.kind === "run" ? <RunPopover anchor={pop.el} onClose={() => setPop(null)} /> : null}
    {pop?.kind === "cap" ? <CapPopover anchor={pop.el} onClose={() => setPop(null)} /> : null}
    {pop?.kind === "perm" ? <PermPopover anchor={pop.el} onClose={() => setPop(null)} /> : null}
    </>
  );
}

const STAGE_COLOR: Record<string, string> = {
  intake: "var(--h-idle)",
  spec: "var(--h-wait)",
  build: "var(--h-running)",
  integrate: "var(--h-running)",
  review: "var(--h-accent)",
  slop: "var(--h-accent)",
  fix: "var(--h-warn)",
  ready: "var(--h-ok)",
  done: "var(--h-ok)",
};

function RunPopover({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  const h = useHelm();
  const { data, runs } = h;
  const [busy, setBusy] = useState(false);
  const run = data?.run;
  const counts: Record<string, number> = {};
  if (data) for (const id of data.appOrder) counts[data.apps[id].stage] = (counts[data.apps[id].stage] ?? 0) + 1;
  const policies = (data?.policies ?? []).filter((p) => !p.retiredAt);

  const startRun = useStartRun();
  const start = async () => {
    if (!run) return;
    setBusy(true);
    try {
      // a refusal (models, folders) is shown by useStartRun and in the start bar
      if (!(await startRun(run.id, run.dryRun))) onClose();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const finish = async (status: "done" | "cancelled") => {
    if (!run) return;
    const ok = await askConfirm({
      title: status === "done" ? "Mark this run done?" : "End this run?",
      body: status === "done" ? "The run is closed as done. Agents that are still working are stopped." : "Every agent still working is stopped and nothing new is spawned. The ledger and evidence stay.",
      ok: status === "done" ? "Mark done" : "End run",
      danger: status !== "done",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await h.rpc.call("run_finish", { runId: run.id, status });
      toast.success(status === "done" ? "Run marked done" : "Run ended");
      h.refetch();
      h.refreshRuns();
      onClose();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover anchor={anchor} onClose={onClose} width={420} label="Run details">
      <div className="ph">
        <span>{run?.name ?? "Runs"}</span>
        <button type="button" className="iconbtn sm" onClick={onClose} aria-label="Close">
          <Ic name="X" size="sm" />
        </button>
      </div>
      <div className="pb">
        {run && data ? (
          <>
            <div className="hint-t">
              {run.startedAt ? `Started ${clockOf(run.startedAt)} (${agoOf(run.startedAt)})` : `Created ${agoOf(run.createdAt)} · not started`} · {plural(data.appOrder.length, "app")} · {plural(data.managers.length, "manager")} · concurrency {run.concurrency} · {run.status}
              {run.dryRun ? " · dry run" : ""}
            </div>
            {run.why ? (
              <div className="hint-t">
                <b>Shape {run.rule}:</b> {run.why}
              </div>
            ) : null}
            <div>
              <div className="stackbar" role="img" aria-label={STAGES.filter((s) => counts[s.id]).map((s) => `${s.label} ${counts[s.id]}`).join(", ")}>
                {STAGES.map((s) => (counts[s.id] ? <i key={s.id} style={{ flex: counts[s.id], background: STAGE_COLOR[s.id], opacity: 0.45 + STAGE_IDX[s.id] * 0.07 }} title={`${s.label} ${counts[s.id]}`} /> : null))}
              </div>
              <div className="row" style={{ flexWrap: "wrap", gap: "4px 12px", marginTop: 8, fontSize: 11.5, color: "var(--h-fg-3)" }}>
                {STAGES.map((s) =>
                  counts[s.id] ? (
                    <span key={s.id}>
                      {s.label}{" "}
                      <b className="mono" style={{ color: "var(--h-fg)" }}>
                        {counts[s.id]}
                      </b>
                    </span>
                  ) : null,
                )}
              </div>
            </div>
            <div>
              <div className="lbl" style={{ marginBottom: 6 }}>
                Standing policies
              </div>
              {policies.length ? (
                policies.map((p) => (
                  <div key={p.id} className="row" style={{ alignItems: "flex-start", gap: 8, fontSize: 12, marginBottom: 5 }}>
                    <Ic name="Layers" size="sm" />
                    <span>
                      <span className="mono faint">{p.id}</span> {p.text}
                    </span>
                  </div>
                ))
              ) : (
                <span className="hint-t">None yet.</span>
              )}
            </div>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              {run.status === "planning" ? (
                <button type="button" className="btn sm primary" disabled={busy} onClick={start}>
                  <Ic name="Play" size="sm" /> Start run
                </button>
              ) : null}
              {run.status === "running" || run.status === "paused" ? (
                <>
                  <button type="button" className="btn sm" disabled={busy} onClick={() => finish("done")}>
                    <Ic name="Check" size="sm" /> Mark done…
                  </button>
                  <button type="button" className="btn sm danger" disabled={busy} onClick={() => finish("cancelled")}>
                    <Ic name="Square" size="sm" /> End run…
                  </button>
                </>
              ) : null}
              {run.status === "planning" ? (
                <button type="button" className="btn sm danger" disabled={busy} onClick={() => finish("cancelled")}>
                  <Ic name="X" size="sm" /> Discard…
                </button>
              ) : null}
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  h.setView("ledger");
                  onClose();
                }}
              >
                Open Ledger
              </button>
            </div>
          </>
        ) : null}
        {runs && runs.length > 1 ? (
          <div>
            <div className="lbl" style={{ marginBottom: 6 }}>
              Switch run
            </div>
            <div className="col" style={{ gap: 2 }} role="listbox" aria-label="Runs">
              {runs.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  role="option"
                  aria-selected={r.id === h.runId}
                  className={cx("kidrow", r.id === h.runId && "sel")}
                  onClick={() => {
                    h.setRunId(r.id);
                    onClose();
                  }}
                >
                  <span className={cx("live-dot", !(r.status === "running" || r.status === "paused") && "off")} />
                  <span className="n trunc">{r.name}</span>
                  <span className="muted" style={{ fontSize: 11.5 }}>
                    {plural(r.apps, "app")} · {r.status} · {agoOf(r.createdAt)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </Popover>
  );
}

/** Change this run's concurrency and budget cap now (run_setLimits); the Orchestrator is told. */
function LimitsEditor() {
  const h = useHelm();
  const run = h.data!.run;
  const finished = run.status === "done" || run.status === "cancelled";
  const [conc, setConc] = useState(run.concurrency);
  const [cap, setCap] = useState(Math.round(run.budgetCap));
  const runAutonomy = run.limits?.autonomy ?? "ask";
  const [auto, setAuto] = useState<"high" | "ask">(runAutonomy);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setConc(run.concurrency);
    setCap(Math.round(run.budgetCap));
    setAuto(runAutonomy);
  }, [run.id, run.concurrency, run.budgetCap, runAutonomy]);
  const dirty = conc !== run.concurrency || cap !== Math.round(run.budgetCap) || auto !== runAutonomy;
  const apply = async () => {
    setBusy(true);
    try {
      await h.rpc.call("run_setLimits", { runId: run.id, ...(conc !== run.concurrency ? { concurrency: conc } : {}), ...(cap !== Math.round(run.budgetCap) ? { budgetCap: cap } : {}), ...(auto !== runAutonomy ? { autonomy: auto } : {}) });
      toast.success("Run settings updated", { description: `At most ${conc} agents at once · budget cap ${cap} u · ${auto === "high" ? "the Orchestrator decides" : "asks you"}. ${run.status === "planning" ? "" : "Every live agent was told."}` });
      h.refetch();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="field">
        <label className="lbl" htmlFor="helm-cap">
          Max agents running at once (this run) · <span className="mono">{conc}</span>
        </label>
        <input id="helm-cap" className="slider" type="range" min={1} max={48} step={1} value={conc} disabled={finished || busy} onChange={(e) => setConc(Number(e.target.value))} />
        <span className="hint-t">Each run has its own limit. BB's own thread limit (Settings) still applies on top.</span>
      </div>
      <div className="field">
        <label className="lbl" htmlFor="helm-autonomy">
          Who decides
        </label>
        <select id="helm-autonomy" className="select" value={auto} disabled={finished || busy} onChange={(e) => setAuto(e.target.value as "high" | "ask")}>
          <option value="high">The Orchestrator (asks me only about credentials, spending, private data or access)</option>
          <option value="ask">Me: every question, wave and plan change</option>
        </select>
        <span className="hint-t">Sign-off and real failures always come to you, and the budget cap still stops spending.</span>
      </div>
      <div className="field">
        <label className="lbl" htmlFor="helm-budget">
          Budget cap (relative units)
        </label>
        <input id="helm-budget" className="input" type="number" min={1} step={100} style={{ width: 140 }} value={cap} disabled={finished || busy} onChange={(e) => setCap(Math.max(1, Math.round(Number(e.target.value) || 0)))} />
      </div>
      {dirty && !finished ? (
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn sm primary" disabled={busy} onClick={() => void apply()} data-testid="apply-limits">
            {busy ? "Applying…" : "Apply now"}
          </button>
          <button type="button" className="btn sm ghost" disabled={busy} onClick={() => { setConc(run.concurrency); setCap(Math.round(run.budgetCap)); }}>
            Reset
          </button>
        </div>
      ) : null}
    </div>
  );
}

type PermMode = "auto" | "accept-edits" | "full";
type Perms = { modes: Record<string, PermMode>; approvePrompts: "supervisor" | "human" };
const PERM_ROLES: Array<[string, string]> = [
  ["orchestrator", "Orchestrator"],
  ["manager", "Managers"],
  ["lead", "App leads"],
  ["specialist", "Builders (UI, code, platform…)"],
  ["gate", "Gates (Reviewer, Slop Hunter)"],
];
const PERM_MODES: Array<[PermMode, string]> = [
  ["auto", "Auto"],
  ["accept-edits", "Allow edits"],
  ["full", "Full access"],
];

/** Helm's permission settings, editable from the panel (the same values as BB → Settings → Helm). */
function PermPopover({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  const h = useHelm();
  const [saved, setSaved] = useState<Perms | null>(null);
  const [draft, setDraft] = useState<Perms | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    h.rpc.call("settings_permissions", {}).then(
      (r: Perms) => live && (setSaved(r), setDraft(r)),
      (e: unknown) => live && toast.error("Could not read Helm's permission settings", { description: errMsg(e) }),
    );
    return () => {
      live = false;
    };
  }, [h.rpc]);
  const dirty = !!saved && !!draft && JSON.stringify(saved) !== JSON.stringify(draft);
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const r = (await h.rpc.call("settings_setPermissions", draft)) as Perms;
      setSaved(r);
      setDraft(r);
      toast.success("Permissions saved", { description: "New agents start with these modes. Running agents keep the mode they started with." });
    } catch (e) {
      toast.error("Could not save permissions", { description: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popover anchor={anchor} onClose={onClose} width={440} align="right" label="Permissions">
      <div className="ph">
        <span>Permissions</span>
        <button type="button" className="iconbtn sm" onClick={onClose} aria-label="Close">
          <Ic name="X" size="sm" />
        </button>
      </div>
      <div className="pb">
        {!draft ? (
          <span className="muted">Loading…</span>
        ) : (
          <div className="col" style={{ gap: 12 }}>
            <div className="field">
              <span className="lbl">Who approves agents' permission prompts</span>
              <div className="seg" role="radiogroup" aria-label="Who approves agents' permission prompts">
                {([["supervisor", "Their supervisor, for me"], ["human", "Me, every time"]] as const).map(([v, l]) => (
                  <button key={v} type="button" role="radio" aria-checked={draft.approvePrompts === v} className={draft.approvePrompts === v ? "on" : ""} disabled={busy} onClick={() => setDraft({ ...draft, approvePrompts: v })}>
                    {l}
                  </button>
                ))}
              </div>
              <span className="hint-t">
                {draft.approvePrompts === "supervisor"
                  ? "A builder's prompt goes to its lead, a lead's to its manager, a manager's to the Orchestrator. You get only credentials, spending, private data or access, the Orchestrator's own prompts, and anything unanswered for 15 minutes."
                  : "Every permission prompt from every agent comes to Needs you."}
              </span>
            </div>
            <div className="field">
              <span className="lbl">What each role may do</span>
              {PERM_ROLES.map(([tier, label]) => (
                <div key={tier} className="row" style={{ justifyContent: "space-between", gap: 8, marginTop: 4 }}>
                  <span style={{ minWidth: 0 }}>{label}</span>
                  <div className="seg" role="radiogroup" aria-label={`Permission mode: ${label}`}>
                    {PERM_MODES.map(([v, l]) => (
                      <button key={v} type="button" role="radio" aria-checked={draft.modes[tier] === v} className={draft.modes[tier] === v ? "on" : ""} disabled={busy} onClick={() => setDraft({ ...draft, modes: { ...draft.modes, [tier]: v } })}>
                        {l}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <span className="hint-t">
                <b>Auto</b>: BB's safety check allows routine commands and asks about risky ones. <b>Allow edits</b>: file edits go ahead, commands ask. <b>Full access</b>: no permission checks. Applies to agents started after you save; running agents keep their mode. Some providers (e.g. Grok) have no Auto mode.
              </span>
            </div>
            {dirty ? (
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn sm primary" disabled={busy} onClick={() => void save()} data-testid="save-permissions">
                  {busy ? "Saving…" : "Save"}
                </button>
                <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setDraft(saved)}>
                  Reset
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </Popover>
  );
}

function CapPopover({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  const h = useHelm();
  const { data } = h;
  if (!data) return null;
  const run = data.run;
  const nodes = data.nodeOrder.map((id) => data.nodes[id]);
  const spawned = nodes.filter((n) => n.threadId).length;
  const running = nodes.filter((n) => n.status === "running").length;
  const queued = nodes.filter((n) => n.status === "queued").length;
  const planned = nodes.filter((n) => n.status === "planned").length;
  const maxAgents = run.limits?.maxTotalAgents ?? run.maxAgents;
  const caps = run.limits?.providerCaps ?? {};
  const byProv: Record<string, number> = {};
  for (const n of nodes) if (n.status === "running" && n.model) byProv[n.model.providerId] = (byProv[n.model.providerId] ?? 0) + 1;
  const provs = Array.from(new Set([...Object.keys(byProv), ...nodes.map((n) => n.model?.providerId).filter((x): x is string => !!x)])).filter((p) => caps[p] !== undefined || byProv[p]);
  return (
    <Popover anchor={anchor} onClose={onClose} width={400} align="right" label="Capacity">
      <div className="ph">
        <span>Capacity</span>
        <button type="button" className="iconbtn sm" onClick={onClose} aria-label="Close">
          <Ic name="X" size="sm" />
        </button>
      </div>
      <div className="pb">
        <div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="lbl">Agents spawned</span>
            <span className="mono">
              {spawned} / {maxAgents}
            </span>
          </div>
          <div className="meter" style={{ marginTop: 5 }}>
            <i style={{ width: `${Math.min(100, (spawned / Math.max(1, maxAgents)) * 100)}%` }} />
          </div>
          <div className="hint-t" style={{ marginTop: 4 }}>
            {planned} more are planned but not spawned. Specialists and gates spawn lazily, so the peak is far below the total.
          </div>
        </div>
        <div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="lbl">Running now</span>
            <span className="mono">
              {running} / {run.concurrency}
            </span>
          </div>
          <div className="meter run" style={{ marginTop: 5 }}>
            <i style={{ width: `${Math.min(100, (running / Math.max(1, run.concurrency)) * 100)}%` }} />
          </div>
          <div className="hint-t" style={{ marginTop: 4 }}>
            {queued} waiting for a free slot. Needs-you work goes first, then priority, then fair share per manager.
          </div>
        </div>
        {provs.length ? (
          <div>
            <div className="lbl" style={{ marginBottom: 6 }}>
              Per provider
            </div>
            {provs.map((p) => (
              <div key={p} className="row" style={{ gap: 8, marginBottom: 5 }}>
                <i className="pdot" style={{ background: providerVar(p) }} />
                <span style={{ width: 110 }} className="trunc">
                  {PROVIDER_LABEL[p] ?? p}
                </span>
                <div className="meter grow">
                  <i style={{ width: `${caps[p] ? Math.min(100, ((byProv[p] ?? 0) / caps[p]) * 100) : 0}%`, background: providerVar(p) }} />
                </div>
                <span className="mono muted" style={{ width: 48, textAlign: "right" }}>
                  {byProv[p] ?? 0}/{caps[p] ?? "—"}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        <div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="lbl">Budget</span>
            <span className="mono">
              {fmtUnits(run.spend)} / {fmtUnits(run.budgetCap)}
            </span>
          </div>
          <div className={cx("meter", run.spend > run.budgetCap * 0.85 && "warn")} style={{ marginTop: 5 }}>
            <i style={{ width: `${Math.min(100, (run.spend / Math.max(1, run.budgetCap)) * 100)}%` }} />
          </div>
          <div className="hint-t" style={{ marginTop: 4 }}>
            Relative units, not real prices. Reaching the cap pauses new spawns and asks you in Needs you.
          </div>
        </div>
        <LimitsEditor />
        <label className="check" title="This Helm backend pauses spawns itself when the budget cap is reached; a manual switch is not available yet">
          <input type="checkbox" checked={run.spawnsPaused} disabled readOnly />
          <span>
            <b>Pause new spawns</b>
            <br />
            <span className="hint-t">{run.spawnsPaused ? "Spawns are paused (budget cap). Raise the cap from Needs you to resume." : "Running agents finish their turn; nothing new starts. Set automatically at the budget cap; no manual switch in this backend yet."}</span>
          </span>
        </label>
      </div>
    </Popover>
  );
}

// ───────────── first-run hero ─────────────

function Hero() {
  const h = useHelm();
  const noModels = h.catalog && (!h.catalog.models.length || !h.catalog.providers.some((p) => p.available));
  return (
    <div className="hero">
      <div className="hero-in">
        <span className="tile lg tier" style={{ width: 52, height: 52, borderRadius: 14 }}>
          <Ic name="Workflow" size="lg" />
        </span>
        <h1>Describe what you want to build</h1>
        <p className="muted" style={{ margin: 0, maxWidth: "56ch" }}>
          Helm reads a plain-language brief, plans a portfolio of apps, staffs each one with an agent squad, and asks which models to use every run. Nothing spawns until you approve.
        </p>
        {noModels ? (
          <Banner tone="warn">
            No provider or model is available on this machine yet. Add or sign in to a provider in BB’s Settings → Providers, then come back — Helm reads the live model list every run.
          </Banner>
        ) : null}
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            seedWizardBrief(null);
            h.setWizardOpen(true);
          }}
        >
          <Ic name="Plus" size="sm" /> New run
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            seedWizardBrief(null);
            seedWizardMode("agent");
            h.setWizardOpen(true);
          }}
        >
          <Ic name="MessageSquare" size="sm" /> Plan with an agent
        </button>
        {h.runs?.length ? (
          <div className="recent">
            <div className="lbl" style={{ marginBottom: 4 }}>
              Or open a run
            </div>
            {h.runs.slice(0, 8).map((r) => (
              <button key={r.id} type="button" className="kidrow" onClick={() => h.setRunId(r.id)}>
                <span className={cx("live-dot", !(r.status === "running" || r.status === "paused") && "off")} />
                <span className="n trunc">{r.name}</span>
                <span className="muted" style={{ fontSize: 11.5 }}>
                  {plural(r.apps, "app")} · {r.status}
                  {r.needs ? ` · ${r.needs} need you` : ""} · {agoOf(r.createdAt)}
                </span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="col" style={{ gap: 10, width: "100%" }}>
          {EXAMPLES.map((ex) => (
            <button
              key={ex.title}
              type="button"
              className="ex"
              onClick={() => {
                seedWizardBrief(ex.text);
                h.setWizardOpen(true);
              }}
            >
              <b>{ex.title}</b>
              <span className="muted trunc" style={{ fontSize: 12 }}>
                {ex.text.split("\n").find((l) => l.startsWith("- "))?.slice(2) ?? ex.text.slice(0, 90)}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
