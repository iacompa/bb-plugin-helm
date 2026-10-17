// The Helm frame: top bar (brand · run switcher · tabs · caps · spend · Models
// · inspector toggle · New run), the main view, the Inspector, overlays,
// first-run states and global shortcuts.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { EXAMPLES, WizardModal, seedWizardBrief } from "./wizard.tsx";

export function HelmApp() {
  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <div className="helm" ref={rootRef} data-testid="helm-root">
      <HelmProvider rootRef={rootRef}>
        <Frame />
      </HelmProvider>
    </div>
  );
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

  const noRuns = h.runs !== null && h.runs.length === 0;
  const showInspector = inspOpen && !!data;

  return (
    <>
      <TopBar />
      <div className="main">
        <section className="stagewrap" aria-label="Main view">
          {noRuns ? (
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
        </section>
        {showInspector ? <Inspector /> : null}
      </div>
      <StudioModal />
      <WizardModal />
      <DialogHost />
    </>
  );
}

// ───────────── top bar ─────────────

function TopBar() {
  const h = useHelm();
  const { data, view, setView, catalog } = h;
  const conn = useRealtimeConnectionState();
  const [pop, setPop] = useState<{ kind: "run" | "cap"; el: HTMLElement } | null>(null);
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
    <header className="topbar">
      <div className="brand">
        <span className="logo">
          <Ic name="Workflow" />
        </span>
        <span className="wm">Helm</span>
      </div>
      {h.runs && h.runs.length ? (
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
      {pop?.kind === "run" ? <RunPopover anchor={pop.el} onClose={() => setPop(null)} /> : null}
      {pop?.kind === "cap" ? <CapPopover anchor={pop.el} onClose={() => setPop(null)} /> : null}
    </header>
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

  const start = async () => {
    if (!run) return;
    setBusy(true);
    try {
      await h.rpc.call("run_start", { runId: run.id, dryRun: run.dryRun });
      toast.success("Run started");
      h.refetch();
      h.refreshRuns();
      onClose();
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
        <div className="field">
          <label className="lbl" htmlFor="helm-cap">
            Max concurrent agents · <span className="mono">{run.concurrency}</span>
          </label>
          <input id="helm-cap" className="slider" type="range" min={4} max={48} step={2} value={run.concurrency} disabled readOnly />
          <span className="hint-t">Set when the run is approved. This Helm backend does not change concurrency mid-run yet.</span>
        </div>
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
