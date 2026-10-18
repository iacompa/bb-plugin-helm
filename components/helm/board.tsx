// Board (§11.5): Apps by stage (optional manager swimlanes) and Agent tasks.
// Drags are validated client-side with the same rules as the server; the
// server is the authority, and an illegal drop snaps back with the reason.
import { useMemo, useRef, useState, type DragEvent } from "react";
import { toast } from "sonner";
import { useHelm } from "./ctx.tsx";
import type { SnapApp, SnapNode, Stage } from "./types.ts";
import type { RunState } from "./store.ts";
import { appMembers, leadOf, managerOfApp, openNeeds } from "./store.ts";
import { STAGES, TASK_COLS, appMoveRule, appStatus, colOfStatus, errMsg, kindLabel, mgrHue, plural, statusLabel, taskMoveRule, type TaskCol } from "./format.ts";
import { Dot, Ic, ModelChip, RoleTile, StagePill, StatusPill, askConfirm, askReason, cx } from "./ui.tsx";

type Drag = { kind: "app"; id: string } | { kind: "task"; id: string };
/** Cancelled apps sit in the Done column (their card says Cancelled), so the header count matches the cards. */
const inCol = (a: { stage: string }, col: string) => a.stage === col || (col === "done" && a.stage === "cancelled");
const LIM = 30;
const ORDER: Record<string, number> = { needs: 0, failed: 0, running: 1, waiting: 2, queued: 3, paused: 3, idle: 3, planned: 4, done: 5 };

export function BoardView() {
  const h = useHelm();
  const data = h.data;
  const [lens, setLens] = useState<"apps" | "tasks">("apps");
  const [swim, setSwim] = useState(false);
  const [hideDone, setHideDone] = useState(false);
  const [taskApp, setTaskApp] = useState("all");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const drag = useRef<Drag | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [hover, setHover] = useState<{ key: string; ok: boolean; noop: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!data) return <div className="boardwrap"><div className="bhead"><h2>Board</h2><span className="muted">Loading…</span></div></div>;

  const apps = data.appOrder.map((id) => data.apps[id]);
  const counts = apps.reduce<Record<string, number>>((m, a) => ((m[a.stage] = (m[a.stage] ?? 0) + 1), m), {});
  const agents = data.nodeOrder.map((id) => data.nodes[id]).filter((n) => n.role !== "orch" && n.role !== "mgr");

  const snapBack = (why: string) => toast.warning("Snapped back", { description: why });

  const runMove = async (fn: () => Promise<unknown>, ok: string, sub?: string) => {
    setBusy(true);
    try {
      const r = (await fn()) as { ok?: boolean; why?: string; directive?: unknown; result?: { directive?: unknown } } | null;
      if (r && r.ok === false) {
        snapBack(r.why ?? "The server refused this move.");
        return;
      }
      const d = (r?.directive ?? r?.result?.directive ?? (r?.result && (r.result as { id?: string }).id ? r.result : null)) as Parameters<typeof h.firePulse>[0] | null;
      if (d && typeof d === "object" && "recipients" in d) h.firePulse(d);
      toast.success(ok, sub ? { description: sub } : undefined);
      h.refetch();
    } catch (e) {
      snapBack(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const dropApp = async (a: SnapApp, to: Stage) => {
    const r = appMoveRule(a, to);
    if ("noop" in r && r.noop) return;
    if (!r.ok) return snapBack(r.why);
    const runId = h.runId!;
    const mgr = managerOfApp(data, a.id);
    if (r.act === "signoff") {
      const yes = await askConfirm({
        title: `Sign off ${a.name}?`,
        body: `Signing off marks ${a.name} done and archives its squad’s threads. The server checks that both gates passed and the deterministic checks are green on the same commit; if not, it refuses. The Orchestrator${mgr ? ` and the ${mgr.name} manager are` : " is"} told.`,
        ok: "Sign off",
      });
      if (!yes) return;
      return runMove(() => h.rpc.call("board_moveApp", { runId, appId: a.id, to: "done" }), `${a.name} signed off`, `Orchestrator${mgr ? ` and ${mgr.name} manager` : ""} notified.`);
    }
    if (r.act === "sendback") {
      const txt = await askReason({ title: `Send ${a.name} back to Build`, placeholder: "What should change? The lead and the Orchestrator will see exactly this.", ok: "Send back" });
      if (!txt) return;
      return runMove(() => h.rpc.call("board_moveApp", { runId, appId: a.id, to: "build", text: txt }), `${a.name} sent back to Build`, "Gates reset; the lead is re-planning.");
    }
    if (r.act === "start") return runMove(() => h.rpc.call("board_moveApp", { runId, appId: a.id, to: "spec" }), `${a.name} started`, "Moved from Intake to Spec ahead of the queue.");
    // reopen: the server decides (it currently refuses with a reason)
    return runMove(() => h.rpc.call("board_moveApp", { runId, appId: a.id, to: "ready" }), `${a.name} reopened`, "Back in Ready.");
  };

  const dropTask = (n: SnapNode, to: TaskCol) => {
    const r = taskMoveRule(n, to);
    if ("noop" in r && r.noop) return;
    if (!r.ok) return snapBack(r.why);
    const label = r.act === "hold" ? `${n.label} held` : r.act === "spawn" ? `${n.label} spawned` : `${n.label} started`;
    const sub = r.act === "hold" ? "It keeps its worktree and resumes when you release it." : "Its lead and manager were told.";
    void runMove(() => h.rpc.call("board_moveTask", { runId: h.runId!, nodeId: n.id, to }), label, sub);
  };

  const ruleFor = (kind: Drag["kind"], target: string) => {
    const d = drag.current;
    if (!d || d.kind !== kind) return null;
    if (d.kind === "app") {
      const a = data.apps[d.id];
      return a ? appMoveRule(a, target as Stage) : null;
    }
    const n = data.nodes[d.id];
    return n ? taskMoveRule(n, target as TaskCol) : null;
  };

  const zone = (key: string, kind: Drag["kind"], target: string) => ({
    onDragOver: (e: DragEvent) => {
      const r = ruleFor(kind, target);
      if (!r) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = r.ok ? "move" : "none";
      const noop = "noop" in r && !!r.noop;
      if (!hover || hover.key !== key || hover.ok !== r.ok || hover.noop !== noop) setHover({ key, ok: r.ok, noop });
    },
    onDragLeave: (e: DragEvent) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null) && hover?.key === key) setHover(null);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const d = drag.current;
      drag.current = null;
      setHover(null);
      setDraggingId(null);
      if (!d || d.kind !== kind) return;
      if (d.kind === "app") {
        const a = data.apps[d.id];
        if (a) void dropApp(a, target as Stage);
      } else {
        const n = data.nodes[d.id];
        if (n) dropTask(n, target as TaskCol);
      }
    },
    className: hover?.key === key ? (hover.ok ? (hover.noop ? "" : "drop-ok") : "drop-no") : "",
  });

  const dragProps = (d: Drag) => ({
    draggable: !busy,
    onDragStart: (e: DragEvent) => {
      drag.current = d;
      setDraggingId(d.id);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", d.id);
    },
    onDragEnd: () => {
      drag.current = null;
      setDraggingId(null);
      setHover(null);
    },
  });

  const head = (
    <div className="bhead">
      <h2>Board</h2>
      <div className="seg" role="group" aria-label="Board lens">
        <button type="button" aria-pressed={lens === "apps"} className={lens === "apps" ? "on" : ""} onClick={() => setLens("apps")}>
          <Ic name="Layers" size="sm" /> Apps by stage
        </button>
        <button type="button" aria-pressed={lens === "tasks"} className={lens === "tasks" ? "on" : ""} onClick={() => setLens("tasks")}>
          <Ic name="Columns2" size="sm" /> Agent tasks
        </button>
      </div>
      {lens === "apps" ? (
        <label className="check" style={{ alignItems: "center" }}>
          <input type="checkbox" checked={swim} onChange={(e) => setSwim(e.target.checked)} disabled={!data.managers.length} /> Swimlanes by manager
        </label>
      ) : (
        <select className="select" aria-label="Filter by app" style={{ width: 160 }} value={taskApp} onChange={(e) => setTaskApp(e.target.value)}>
          <option value="all">All apps</option>
          {apps.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      )}
      <label className="check" style={{ alignItems: "center" }}>
        <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} /> Hide done
      </label>
      <span className="grow" />
      <span className="muted" style={{ fontSize: 12 }}>
        {lens === "apps"
          ? `${plural(apps.length, "app")} · ${counts.build ?? 0} building · ${(counts.review ?? 0) + (counts.slop ?? 0)} in gates · ${counts.ready ?? 0} ready`
          : `${plural(agents.length, "agent")} across ${plural(apps.length, "app")}`}
      </span>
    </div>
  );

  const rule = (
    <div className="rulebar" role="note">
      <Ic name="AlertTriangle" size="sm" />
      <span>
        {lens === "apps" ? (
          <>
            <b>Stages advance on evidence, not on drag.</b> You can sign off a Ready app (→ Done), send it back to Build with a reason, or start an Intake app now. Anything else snaps back.
          </>
        ) : (
          <>
            <b>You can start or hold work.</b> Drag Planned or Queued to Running to start it now, Planned to Queued to spawn it, or Running to Queued to hold it. Approvals and failures are resolved in <b>Needs you</b>.
          </>
        )}
      </span>
    </div>
  );

  return (
    <div className="boardwrap">
      {head}
      {rule}
      <div className="bscroll">
        {lens === "apps" ? (
          <AppsLens data={data} hideDone={hideDone} swim={swim && data.managers.length > 0} expanded={expanded} setExpanded={setExpanded} zone={zone} dragProps={dragProps} draggingId={draggingId} />
        ) : (
          <TasksLens data={data} agents={agents} taskApp={taskApp} hideDone={hideDone} expanded={expanded} setExpanded={setExpanded} zone={zone} dragProps={dragProps} draggingId={draggingId} />
        )}
      </div>
    </div>
  );
}

type ZoneFn = (key: string, kind: Drag["kind"], target: string) => {
  onDragOver: (e: DragEvent) => void;
  onDragLeave: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  className: string;
};
type DragPropsFn = (d: Drag) => { draggable: boolean; onDragStart: (e: DragEvent) => void; onDragEnd: () => void };

function AppCard({ data, a, dragProps, dragging }: { data: RunState; a: SnapApp; dragProps: DragPropsFn; dragging: boolean }) {
  const h = useHelm();
  const members = appMembers(data, a.id);
  const lead = leadOf(data, a.id);
  const st = appStatus(a, members);
  const mgr = managerOfApp(data, a.id);
  const hue = mgrHue(data.managers.map((m) => m.id), mgr?.id);
  const ids = new Set([...members.map((m) => m.id), ...(lead ? [lead.id] : [])]);
  const nNeed = openNeeds(data).filter((n) => n.appId === a.id || (n.nodeId && ids.has(n.nodeId) && lead?.role !== "orch")).length;
  const nTouch = members.filter((m) => m.touched).length;
  const sel = !!h.sel && (h.sel === lead?.id || (h.node(h.sel)?.appId === a.id && h.node(h.sel)?.role !== "orch"));
  const open = () => lead && h.select(lead.id);
  return (
    <div
      role="button"
      tabIndex={0}
      className={cx("bcard", `s-${st}`, sel && "sel", dragging && "dragging")}
      aria-label={`${a.name}, ${a.stage === "cancelled" ? "cancelled" : statusLabel(st)}, ${a.pct}%`}
      onClick={open}
      onDoubleClick={() => {
        h.setDrill(a.id);
        h.setView("graph");
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      {...dragProps({ kind: "app", id: a.id })}
    >
      <div className="row" style={{ gap: 6 }}>
        <b className="b-name">{a.name}</b>
        <span className="grow" />
        {a.stage === "cancelled" ? <span className="pill">Cancelled</span> : null}
        {nNeed ? (
          <span className="pill warn" title="Needs you">
            <Ic name="BellDot" size="sm" />
            {nNeed}
          </span>
        ) : null}
        {nTouch ? (
          <span className="touchb static" title="Changed by you">
            <Ic name="UserRound" />
            you{nTouch > 1 ? ` ×${nTouch}` : ""}
          </span>
        ) : null}
      </div>
      {a.tagline ? <div className="b-sub">{a.tagline}</div> : null}
      <div className="row" style={{ gap: 6 }}>
        <StagePill stage={a.stage} />
        {lead ? <StatusPill status={lead.status} /> : null}
        <span className="grow" />
        <span className="mono muted" style={{ fontSize: 10.5 }}>
          {a.pct}%
        </span>
      </div>
      <div className="meter run" aria-hidden="true">
        <i style={{ width: `${Math.max(0, Math.min(100, a.pct))}%` }} />
      </div>
      {members.length ? (
        <div className="dots">
          {members.map((m) => (
            <Dot key={m.id} status={m.status} touched={m.touched} title={`${m.label} · ${statusLabel(m.status)}`} />
          ))}
        </div>
      ) : null}
      <div className="b-foot">
        {mgr ? (
          <span className="mtag">
            <i style={{ background: hue }} />
            {mgr.name}
          </span>
        ) : (
          <span className="mtag">
            <i style={{ background: "var(--h-fg-4)" }} />
            Orchestrator
          </span>
        )}
        <span className="plt">
          {a.kind && a.kind !== "app" ? <i className="kind">{kindLabel(a.kind)}</i> : null}
          {a.platforms.map((p) => (
            <i key={p} className={a.platformsAssumed ? "assumed" : ""} title={a.platformsAssumed ? "Platform assumed by the planner" : undefined}>
              {p}
            </i>
          ))}
        </span>
      </div>
    </div>
  );
}

function AppsLens({
  data,
  hideDone,
  swim,
  expanded,
  setExpanded,
  zone,
  dragProps,
  draggingId,
}: {
  data: RunState;
  hideDone: boolean;
  swim: boolean;
  expanded: Record<string, boolean>;
  setExpanded: (f: (e: Record<string, boolean>) => Record<string, boolean>) => void;
  zone: ZoneFn;
  dragProps: DragPropsFn;
  draggingId: string | null;
}) {
  const h = useHelm();
  const stages = hideDone ? STAGES.filter((s) => s.id !== "done") : STAGES;
  const apps = data.appOrder.map((id) => data.apps[id]);
  const cols = `repeat(${stages.length}, minmax(170px, 1fr))`;
  const cards = (list: SnapApp[], key: string) => {
    const open = expanded[key];
    const shown = open ? list : list.slice(0, LIM);
    return (
      <>
        {shown.map((a) => (
          <AppCard key={a.id} data={data} a={a} dragProps={dragProps} dragging={draggingId === a.id} />
        ))}
        {!list.length ? <div className="faint" style={{ fontSize: 11.5, padding: "4px 2px" }}>—</div> : null}
        {list.length > LIM && !open ? (
          <button type="button" className="more" onClick={() => setExpanded((e) => ({ ...e, [key]: true }))}>
            +{list.length - LIM} more
          </button>
        ) : null}
      </>
    );
  };
  if (!apps.length) return <div className="empty">No apps in this run yet.</div>;
  if (!swim) {
    return (
      <div className="bgrid" style={{ gridTemplateColumns: cols }}>
        {stages.map((s) => {
          const z = zone(`a:${s.id}`, "app", s.id);
          const list = apps.filter((a) => inCol(a, s.id));
          return (
            <div key={s.id} className={cx("bcol", z.className)} onDragOver={z.onDragOver} onDragLeave={z.onDragLeave} onDrop={z.onDrop} aria-label={`${s.label} column`}>
              <div className="bcol-h" title={s.hint}>
                {s.label}
                <span className="count">{list.length}</span>
              </div>
              <div className="bcol-b">{cards(list, `a:${s.id}`)}</div>
            </div>
          );
        })}
      </div>
    );
  }
  const gc = `134px ${cols}`;
  const managed = new Set(data.managers.flatMap((m) => m.appIds));
  const lanes: Array<{ id: string; name: string; appIds: string[]; hue: string; nodeId: string | null }> = data.managers.map((m) => ({ id: m.id, name: m.name, appIds: m.appIds, hue: mgrHue(data.managers.map((x) => x.id), m.id), nodeId: data.nodes[m.id] ? m.id : null }));
  const direct = apps.filter((a) => !managed.has(a.id)).map((a) => a.id);
  if (direct.length) lanes.push({ id: "direct", name: "Orchestrator", appIds: direct, hue: "var(--h-fg-4)", nodeId: data.nodes.orch ? "orch" : null });
  return (
    <>
      <div className="colhead-row" style={{ gridTemplateColumns: gc }}>
        <div />
        {stages.map((s) => (
          <div key={s.id} className="ch" title={s.hint}>
            {s.label}
            <span className="count">{apps.filter((a) => inCol(a, s.id)).length}</span>
          </div>
        ))}
      </div>
      {lanes.map((m) => {
        const as = m.appIds.map((id) => data.apps[id]).filter(Boolean);
        const run = as.filter((a) => appStatus(a, appMembers(data, a.id)) === "running").length;
        return (
          <div key={m.id} className="swim" style={{ gridTemplateColumns: gc }}>
            <div className="swimlabel" style={{ borderLeft: `3px solid ${m.hue}` }}>
              <b>{m.id === "direct" ? "Direct reports" : m.name}</b>
              <span className="muted" style={{ fontSize: 11.5 }}>
                {plural(as.length, "app")} · {run} running
              </span>
              {m.nodeId ? (
                <button type="button" className="btn sm ghost" onClick={() => h.focusNode(m.nodeId!)} style={{ justifyContent: "flex-start", padding: 0, height: 22, color: "var(--h-accent)" }}>
                  {m.id === "direct" ? "Orchestrator" : "Manager"} <Ic name="ChevronRight" size="sm" />
                </button>
              ) : null}
            </div>
            {stages.map((s) => {
              const z = zone(`a:${m.id}:${s.id}`, "app", s.id);
              const list = as.filter((a) => inCol(a, s.id));
              return (
                <div key={s.id} className={cx("cell", z.className)} onDragOver={z.onDragOver} onDragLeave={z.onDragLeave} onDrop={z.onDrop} aria-label={`${m.name} · ${s.label}`}>
                  {list.length ? cards(list, `a:${m.id}:${s.id}`) : null}
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

function TaskCard({ data, n, dragProps, dragging }: { data: RunState; n: SnapNode; dragProps: DragPropsFn; dragging: boolean }) {
  const h = useHelm();
  const a = n.appId ? data.apps[n.appId] : null;
  const mgr = a ? managerOfApp(data, a.id) : null;
  const open = () => h.select(n.id);
  return (
    <div
      role="button"
      tabIndex={0}
      className={cx("bcard", `s-${n.status}`, h.sel === n.id && "sel", dragging && "dragging")}
      aria-label={`${n.label}, ${statusLabel(n.status)}`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      {...dragProps({ kind: "task", id: n.id })}
    >
      <div className="row" style={{ gap: 7 }}>
        <RoleTile node={n} />
        <div className="grow" style={{ minWidth: 0 }}>
          <b className="b-name trunc" style={{ fontSize: 13, display: "block" }}>
            {n.label}
          </b>
          <span className="b-sub" style={{ fontSize: 11 }}>
            {a?.name ?? "Run"}
            {mgr ? ` · ${mgr.name}` : ""}
          </span>
        </div>
        {n.touched ? (
          <span className="pill human" title="Changed by you">
            <Ic name="UserRound" size="sm" />
          </span>
        ) : null}
      </div>
      <div className="row" style={{ gap: 6 }}>
        <StatusPill status={n.status} />
        {n.priority === "high" ? <span className="pill warn">high priority</span> : n.priority === "low" ? <span className="pill">low priority</span> : null}
      </div>
      {n.nowLine || n.warning ? (
        <div className="b-sub" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
          {n.warning ? `⚠ ${n.warning}` : n.nowLine}
        </div>
      ) : null}
      <div className="b-foot">
        <ModelChip model={n.model} catalog={h.catalog} planned={n.status === "planned"} />
      </div>
    </div>
  );
}

function TasksLens({
  data,
  agents,
  taskApp,
  hideDone,
  expanded,
  setExpanded,
  zone,
  dragProps,
  draggingId,
}: {
  data: RunState;
  agents: SnapNode[];
  taskApp: string;
  hideDone: boolean;
  expanded: Record<string, boolean>;
  setExpanded: (f: (e: Record<string, boolean>) => Record<string, boolean>) => void;
  zone: ZoneFn;
  dragProps: DragPropsFn;
  draggingId: string | null;
}) {
  const all = useMemo(() => agents.filter((n) => taskApp === "all" || n.appId === taskApp), [agents, taskApp]);
  const cols = hideDone ? TASK_COLS.filter((c) => c.id !== "done") : TASK_COLS;
  if (!agents.length) return <div className="empty">No agents in this run yet.</div>;
  return (
    <div className="bgrid" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(236px, 1fr))` }}>
      {cols.map((c) => {
        const items = all
          .filter((n) => colOfStatus(n.status) === c.id)
          .sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || Number(b.priority === "high") - Number(a.priority === "high") || a.id.localeCompare(b.id));
        const key = `t:${c.id}`;
        const open = expanded[key];
        const shown = open ? items : items.slice(0, LIM);
        const z = zone(key, "task", c.id);
        return (
          <div key={c.id} className={cx("bcol", z.className)} onDragOver={z.onDragOver} onDragLeave={z.onDragLeave} onDrop={z.onDrop} aria-label={`${c.label} column`}>
            <div className="bcol-h" title={c.hint}>
              {c.label}
              <span className="count">{items.length}</span>
            </div>
            <div className="bcol-b">
              {shown.map((n) => (
                <TaskCard key={n.id} data={data} n={n} dragProps={dragProps} dragging={draggingId === n.id} />
              ))}
              {!items.length ? <div className="faint" style={{ fontSize: 11.5, padding: "4px 2px" }}>—</div> : null}
              {items.length > LIM && !open ? (
                <button type="button" className="more" onClick={() => setExpanded((e) => ({ ...e, [key]: true }))}>
                  +{items.length - LIM} more
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
