// The Inspector (§11.8): header, breadcrumb and seven tabs for the selected
// agent; an Observatory ghost gets a read-only Overview only.
import { useRef, type KeyboardEvent } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import "./inspector.css";
import type { InspTab, SnapNode } from "../types.ts";
import { PROVIDER_LABEL, agoOf, plural, roleText, statusLabel, trailLabel } from "../format.ts";
import { ancestorsOf } from "../store.ts";
import { useHelm } from "../ctx.tsx";
import { Banner, Ic, ModelChip, RoleTile, Sec, StatusPill, cx } from "../ui.tsx";
import { useGhost, useNodeDetail } from "./shared.tsx";
import { Overview } from "./overview.tsx";
import { ChatTab } from "./chat.tsx";
import { DirectTab } from "./direct.tsx";
import { BriefTab, ChangesTab, CommsTab, ReportsTab } from "./tabs.tsx";

const TABS: Array<[InspTab, string]> = [
  ["overview", "Overview"],
  ["chat", "Chat"],
  ["direct", "Direct"],
  ["comms", "Comms"],
  ["brief", "Brief"],
  ["reports", "Reports"],
  ["changes", "Changes"],
];

export function Inspector() {
  const h = useHelm();
  const sel = h.sel;
  const ghostId = sel?.startsWith("ghost:") ? sel.slice(6) : null;
  const n = !ghostId ? h.node(sel) : null;
  return (
    <aside className={cx("inspector", h.inspWide && "wide")} aria-label="Inspector">
      {ghostId ? <GhostInspector threadId={ghostId} /> : n ? <NodeInspector key={n.id} n={n} /> : <EmptyInspector />}
    </aside>
  );
}

function HeadButtons() {
  const h = useHelm();
  return (
    <div className="row" style={{ gap: 2, flex: "none" }}>
      <button type="button" className="iconbtn sm" onClick={() => h.setInspWide(!h.inspWide)} title={h.inspWide ? "Narrower" : "Wider"} aria-label={h.inspWide ? "Make the inspector narrower" : "Make the inspector wider"}>
        <Ic name={h.inspWide ? "Minimize2" : "Maximize2"} size="sm" />
      </button>
      <button type="button" className="iconbtn sm" onClick={() => h.setInspOpen(false)} title="Hide inspector" aria-label="Hide inspector">
        <Ic name="X" size="sm" />
      </button>
    </div>
  );
}

function EmptyInspector() {
  const h = useHelm();
  const orch = h.data ? Object.values(h.data.nodes).find((x) => x.role === "orch") : null;
  return (
    <>
      <div className="insp-head">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="lbl">Inspector</span>
          <HeadButtons />
        </div>
      </div>
      <div className="insp-body">
        <div className="pad col" style={{ gap: 12 }}>
          <div className="empty">Select an agent on the graph or board to inspect it.</div>
          {orch ? (
            <button type="button" className="btn" style={{ alignSelf: "flex-start" }} onClick={() => h.select(orch.id)}>
              <Ic name="Workflow" size="sm" /> Open the Orchestrator
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}

function NodeInspector({ n }: { n: SnapNode }) {
  const h = useHelm();
  const { detail, error } = useNodeDetail(n.id);
  const s = h.data!;
  const anc = ancestorsOf(s, n.id).reverse();
  const app = h.app(n.appId);
  const mgr = n.role === "mgr" ? s.managers.find((m) => m.id === n.id) : null;
  const title = n.role === "orch" ? "Orchestrator" : n.label;
  const sub = n.role === "orch" ? `${s.run.name} · sees everything` : n.role === "mgr" ? `${plural(mgr?.appIds.length ?? 0, "app")} · reports to the Orchestrator` : `${app?.name ?? ""}${app ? " · " : ""}${roleText(n)}`;
  const changes = detail?.directives.length ?? 0;
  const reports = detail?.reports.length ?? 0;
  const comms = (detail?.comms.length ?? 0) + (detail?.inbox.length ?? 0);
  const count: Partial<Record<InspTab, number>> = { comms, reports, changes };
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const onTabKey = (e: KeyboardEvent, i: number) => {
    let j = -1;
    if (e.key === "ArrowRight") j = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft") j = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = TABS.length - 1;
    if (j < 0) return;
    e.preventDefault();
    h.setTab(TABS[j][0]);
    tabRefs.current[j]?.focus();
  };
  const tab = h.tab;
  return (
    <>
      <div className="insp-head">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
          <nav className="trail" aria-label="Chain of command">
            <span className="you">
              <Ic name="UserRound" size="sm" /> You
            </span>
            {anc.map((id) => (
              <span key={id} className="row" style={{ gap: 2 }}>
                <Ic name="ChevronRight" className="sep" />
                <button type="button" onClick={() => h.select(id)}>
                  {trailLabel(s.nodes[id], s.apps)}
                </button>
              </span>
            ))}
            <Ic name="ChevronRight" className="sep" />
            <span className="faint" aria-current="page" style={{ padding: "2px 4px" }}>
              {trailLabel(n, s.apps)}
            </span>
          </nav>
          <HeadButtons />
        </div>
        <div className="insp-title">
          <RoleTile node={n} lg />
          <div className="grow">
            <h2>{title}</h2>
            <div className="sub">{sub}</div>
          </div>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <ModelChip model={n.model} catalog={h.catalog} big planned={n.status === "planned"} onClick={() => h.select(n.id, { tab: "direct", dtype: "model" })} title="Change model" />
          {n.modelOverride ? (
            <span className="pill human">
              <Ic name="UserRound" size="sm" /> per-agent override
            </span>
          ) : null}
          {n.priority !== "normal" ? <span className={cx("pill", n.priority === "high" && "acc")}>{n.priority} priority</span> : null}
          {n.touched ? (
            <span className="touchb static" title="Changed by you">
              <Ic name="UserRound" /> you
            </span>
          ) : null}
          <StatusPill status={n.status} className="ml-auto-insp" />
        </div>
      </div>
      <div className="insp-tabs" role="tablist" aria-label="Inspector sections">
        {TABS.map(([id, label], i) => (
          <button
            key={id}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`insp-tab-${id}`}
            className="itab"
            aria-selected={tab === id}
            aria-controls="insp-panel"
            tabIndex={tab === id ? 0 : -1}
            onClick={() => h.setTab(id)}
            onKeyDown={(e) => onTabKey(e, i)}
            data-testid={`tab-${id}`}
          >
            {label}
            {count[id] ? <span className="count">{count[id]}</span> : null}
          </button>
        ))}
      </div>
      <div className="insp-body" role="tabpanel" id="insp-panel" aria-labelledby={`insp-tab-${tab}`}>
        {error && !detail ? (
          <div className="pad">
            <Banner tone="crit">Could not load this agent: {error}</Banner>
          </div>
        ) : null}
        {tab === "overview" ? <Overview n={n} detail={detail} /> : null}
        {tab === "chat" ? <ChatTab n={n} detail={detail} /> : null}
        {tab === "direct" ? <DirectTab key={n.id} n={n} /> : null}
        {tab === "comms" ? <CommsTab n={n} detail={detail} /> : null}
        {tab === "brief" ? <BriefTab n={n} detail={detail} /> : null}
        {tab === "reports" ? <ReportsTab n={n} detail={detail} /> : null}
        {tab === "changes" ? <ChangesTab n={n} detail={detail} /> : null}
      </div>
    </>
  );
}

function GhostInspector({ threadId }: { threadId: string }) {
  const h = useHelm();
  const nav = useBbNavigate();
  const { ghost, loading } = useGhost(threadId);
  const status = ghost?.status ?? "idle";
  return (
    <>
      <div className="insp-head">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="pill">
            <Ic name="Globe" size="sm" /> Outside this run
          </span>
          <HeadButtons />
        </div>
        <div className="insp-title">
          <span className="tile lg">
            <Ic name="Globe" />
          </span>
          <div className="grow">
            <h2>{ghost?.title || (loading ? "Loading…" : "Untitled thread")}</h2>
            <div className="sub">
              {ghost?.projectId ?? "No project"} · <StatusPill status={status} />
            </div>
          </div>
        </div>
      </div>
      <div className="insp-tabs" role="tablist" aria-label="Inspector sections">
        <button type="button" role="tab" className="itab" aria-selected aria-controls="insp-panel" id="insp-tab-overview">
          Overview
        </button>
      </div>
      <div className="insp-body" role="tabpanel" id="insp-panel" aria-labelledby="insp-tab-overview">
        <div className="sec">
          <Banner tone="info" icon="Globe">
            <b>Outside this run — read-only.</b> The Observatory lists BB threads that Helm does not own so you can see the whole machine. Helm never changes them.
          </Banner>
        </div>
        <Sec title="Thread">
          <dl className="kv">
            <dt>Title</dt>
            <dd>{ghost?.title || "Untitled"}</dd>
            <dt>Status</dt>
            <dd>{statusLabel(status)}</dd>
            <dt>Project</dt>
            <dd className="mono" style={{ fontSize: 11.5 }}>
              {ghost?.projectId ?? "—"}
            </dd>
            <dt>Provider</dt>
            <dd>{ghost?.providerId ? PROVIDER_LABEL[ghost.providerId] ?? ghost.providerId : "—"}</dd>
            {ghost?.originPluginId ? (
              <>
                <dt>Created by</dt>
                <dd>{ghost.originPluginId} plugin</dd>
              </>
            ) : null}
            <dt>Updated</dt>
            <dd>{agoOf(ghost?.updatedAt)}</dd>
            <dt>Thread</dt>
            <dd className="mono" style={{ fontSize: 11.5 }}>
              {threadId}
            </dd>
          </dl>
        </Sec>
        <Sec title="Actions">
          <div className="actions">
            <button type="button" className="btn primary sm" disabled title="Adopting threads is not supported by this Helm backend yet">
              <Ic name="Plus" size="sm" /> Adopt into run
            </button>
            <button type="button" className="btn sm" onClick={() => nav.toThread(threadId, { split: true })}>
              <Ic name="ExternalLink" size="sm" /> Open thread in BB
            </button>
            <button type="button" className="btn sm ghost" onClick={() => h.select(null)}>
              Clear selection
            </button>
          </div>
        </Sec>
      </div>
    </>
  );
}
