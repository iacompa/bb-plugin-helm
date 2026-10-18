// Change ledger (§11.6): every directive, who was told, at what level, the
// exact notice each recipient received, and its receipt.
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { experimental_saveFile } from "@get-bb/plugin-sdk/app";
import { useHelm } from "./ctx.tsx";
import type { DirectiveInfo } from "./types.ts";
type RecipientInfo = DirectiveInfo["recipients"][number];
import type { RunState } from "./store.ts";
import { TYPE_ICON, TYPE_LABEL, agoOf, clockOf, errMsg, pendingReceipts, plural, trailLabel } from "./format.ts";
import { Fmt, Ic, LevelChip, ReceiptBar, ReceiptChip, Seg, cx } from "./ui.tsx";

const LEDGER_FILTERS: Array<[string, string]> = [
  ["all", "All"],
  ["model", "Models"],
  ["tell", "Messages"],
  ["scope", "Scope"],
  ["control", "Pause / stop / retry"],
  ["gate", "Gates & approvals"],
  ["policy", "Policies"],
];

function ledgerMatch(d: DirectiveInfo, f: string): boolean {
  if (f === "all") return true;
  if (f === "model") return d.type === "model" || d.type === "slots";
  if (f === "tell") return d.type === "tell" || d.type === "answer";
  if (f === "scope") return d.type === "scope" || d.type === "priority";
  if (f === "control") return ["pause", "resume", "stop", "retry", "spawn"].includes(d.type);
  if (f === "gate") return ["waive", "approve", "deny", "signoff", "sendback", "plan"].includes(d.type);
  if (f === "policy") return d.policy || d.type === "policy";
  return true;
}

export function LedgerView() {
  const h = useHelm();
  const data = h.data;
  const [filter, setFilter] = useState("all");
  const [agent, setAgent] = useState("all");
  const [source, setSource] = useState("all");
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [older, setOlder] = useState<DirectiveInfo[] | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const all = useMemo(() => {
    if (!data) return [];
    if (!older) return data.directives;
    const seen = new Set(data.directives.map((d) => d.id));
    return [...data.directives, ...older.filter((d) => !seen.has(d.id))];
  }, [data, h.rev, older]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <div className="pagewrap"><div className="page"><h2>Change ledger</h2><span className="muted">Loading…</span></div></div>;

  const targets = [...new Set(all.map((d) => d.targetNodeId))].map((id) => ({ id, label: trailLabel(data.nodes[id], data.apps) || id })).sort((a, b) => a.label.localeCompare(b.label));
  const fromMatch = (d: DirectiveInfo) => source === "all" || (source === "agent" ? d.actor === "agent" : d.actor !== "agent");
  const list = all.filter((d) => ledgerMatch(d, filter) && fromMatch(d) && (agent === "all" || d.targetNodeId === agent || d.affected.includes(agent) || d.byNode === agent) && (!pending || pendingReceipts(d) > 0));
  const bySupervisors = all.filter((d) => d.actor === "agent").length;
  const touched = data.nodeOrder.filter((id) => data.nodes[id].touched).length;
  const policies = [...data.policies].sort((a, b) => Number(!!a.retiredAt) - Number(!!b.retiredAt) || b.createdAt - a.createdAt);

  const exportJsonl = async () => {
    const lines = all.map((d) => JSON.stringify(d)).join("\n");
    const blob = new Blob([lines + "\n"], { type: "application/x-ndjson" });
    const r = await experimental_saveFile({ fileName: `helm-ledger-${h.runId}.jsonl`, blob });
    if (r === "started") toast.success("Ledger exported", { description: plural(all.length, "entry", "entries") });
  };

  const loadOlder = async () => {
    setLoadingOlder(true);
    try {
      const r = (await h.rpc.call("ledger_list", { runId: h.runId!, limit: 1000 })) as { directives: DirectiveInfo[] };
      setOlder(r.directives ?? []);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoadingOlder(false);
    }
  };

  return (
    <div className="pagewrap">
      <div className="page">
        <div className="row" style={{ alignItems: "flex-start" }}>
          <div className="grow">
            <h2>Change ledger</h2>
            <p className="lead">Every intervention, yours and your supervisors' (when the Orchestrator, a Manager or a Lead steers someone below it), with who was told and whether they acknowledged it. The Orchestrator reads this same list, so it always knows what changed and why.</p>
          </div>
          <button type="button" className="btn sm" onClick={() => void exportJsonl()} disabled={!all.length}>
            <Ic name="Download" size="sm" /> Export JSONL
          </button>
        </div>

        <section aria-label="Standing policies" className="col" style={{ gap: 6 }}>
          <div className="lbl">Standing policies</div>
          {policies.length ? (
            policies.map((p) => (
              <div key={p.id} className="row" style={{ gap: 9, fontSize: 12.5, opacity: p.retiredAt ? 0.55 : 1, alignItems: "flex-start" }}>
                <Ic name="Layers" size="sm" />
                <span className="pill mono">{p.id}</span>
                <span className="grow">
                  {p.text}
                  <span className="faint">
                    {" "}
                    · applies to {trailLabel(data.nodes[p.scopeNodeId], data.apps) || p.scopeNodeId}
                    {p.fromDirective ? ` · from ${p.fromDirective}` : " · run setting"}
                    {p.retiredAt ? " · retired" : ""}
                  </span>
                </span>
                {!p.retiredAt ? (
                  <button type="button" className="btn sm" disabled title="Retiring a policy is not supported by this Helm backend yet">
                    Retire
                  </button>
                ) : null}
              </div>
            ))
          ) : (
            <span className="hint-t">No standing policies yet. Tick “Make it a standing policy” when you send a directive to create one.</span>
          )}
        </section>

        <div className="ptools">
          <Seg options={LEDGER_FILTERS} value={filter} onChange={setFilter} label="Filter by type" />
          <select className="select" aria-label="Filter by agent" value={agent} onChange={(e) => setAgent(e.target.value)} style={{ maxWidth: 200 }}>
            <option value="all">All agents</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <select className="select" aria-label="Filter by who sent it" value={source} onChange={(e) => setSource(e.target.value)} style={{ maxWidth: 170 }}>
            <option value="all">From anyone</option>
            <option value="human">From you</option>
            <option value="agent">From supervisors ({bySupervisors})</option>
          </select>
          <label className="check" style={{ alignItems: "center" }}>
            <input type="checkbox" checked={pending} onChange={(e) => setPending(e.target.checked)} /> Receipts pending
          </label>
          <span className="grow" />
          <span className="muted" style={{ fontSize: 12 }}>
            {plural(list.length, "entry", "entries")} · {touched} agents touched
          </span>
        </div>

        <div className="col" style={{ gap: 10 }}>
          {list.map((d) => (
            <LedgerRow key={d.id} d={d} data={data} open={open === d.id} onToggle={() => setOpen(open === d.id ? null : d.id)} />
          ))}
          {!list.length ? <div className="empty">{all.length ? "Nothing matches this filter." : "No changes yet. Every directive you send — from the Inspector, the Board or Needs you — is recorded here."}</div> : null}
          {data.directives.length >= 300 && !older ? (
            <button type="button" className="more" onClick={() => void loadOlder()} disabled={loadingOlder}>
              {loadingOlder ? "Loading…" : "Load older entries"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function LedgerRow({ d, data, open, onToggle }: { d: DirectiveInfo; data: RunState; open: boolean; onToggle: () => void }) {
  const confirmed = d.recipients.filter((r) => r.state === "ack" || r.state === "rec").length;
  const target = data.nodes[d.targetNodeId];
  return (
    <div className="lrow">
      <button type="button" className="lmain" aria-expanded={open} onClick={onToggle}>
        <span className="lid">{d.id}</span>
        <span className="tile">
          <Ic name={TYPE_ICON[d.type] ?? "MessageSquare"} />
        </span>
        <span className="ltxt">
          <b>{TYPE_LABEL[d.type] ?? d.type}</b>
          {d.policy ? <span className="pill acc" style={{ marginLeft: 6 }}>standing policy</span> : null}
          {d.cascade !== "self" ? <span className="pill" style={{ marginLeft: 6 }}>{d.cascade === "reports" ? "+ reports" : "everyone below"}</span> : null}
          {d.implicit ? <span className="pill" style={{ marginLeft: 6 }} title="Typed directly in the agent's thread">typed in thread</span> : null}
          {d.actor === "system" ? <span className="pill" style={{ marginLeft: 6 }}>system</span> : null}
          {d.byNode ? (
            <span className="pill acc" style={{ marginLeft: 6 }} title="Sent by a supervisor (helm_direct or helm_set_model)">
              by {trailLabel(data.nodes[d.byNode], data.apps) || d.byNode}
            </span>
          ) : null}
          <div className="sub">
            <Fmt text={d.summary} />
          </div>
          <div className="sub">→ {trailLabel(target, data.apps) || d.targetNodeId}</div>
        </span>
        <span className="lside">
          <span className="faint mono" style={{ fontSize: 11 }}>
            {clockOf(d.ts)} · {agoOf(d.ts)}
          </span>
          <ReceiptBar d={d} />
          <span className="muted" style={{ fontSize: 11 }}>
            {confirmed}/{d.recipients.length} confirmed
          </span>
        </span>
      </button>
      {open ? <LedgerDetail d={d} data={data} /> : null}
    </div>
  );
}

export function LedgerDetail({ d, data }: { d: DirectiveInfo; data: RunState }) {
  const h = useHelm();
  const [showAll, setShowAll] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const target = data.nodes[d.targetNodeId];
  const direct = d.recipients.filter((r) => r.level === "direct");
  const collapse = direct.length > 6 && !showAll;
  const hiddenDirect = collapse ? direct.filter((r) => r.nodeId !== d.targetNodeId) : [];
  const hiddenIds = new Set(hiddenDirect.map((r) => r.nodeId));
  const rows = d.recipients.filter((r) => !hiddenIds.has(r.nodeId));

  const retry = async (r: RecipientInfo) => {
    const ob = data.outboxFailed.find((o) => o.nodeId === r.nodeId);
    if (!ob) return;
    setRetrying(r.nodeId);
    try {
      const res = (await h.rpc.call("outbox_retry", { runId: h.runId!, outboxId: ob.id })) as { ok: boolean };
      if (res.ok) toast.success("Delivery retried");
      else toast.warning("Could not retry this delivery");
      h.refetch();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setRetrying(null);
    }
  };

  return (
    <div className="ldetail">
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <span className="pill mono">{d.id}</span>
        <span className="pill">{d.mode === "steer" ? "steered now" : "queued after turn"}</span>
        {d.policy ? <span className="pill acc">standing policy — injected into future spawns</span> : null}
        <span className="grow" />
        {target ? (
          <button type="button" className="btn sm" onClick={() => h.focusNode(target.id)}>
            <Ic name="Workflow" size="sm" /> Show {trailLabel(target, data.apps)}
          </button>
        ) : null}
      </div>
      {d.text && d.type !== "tell" ? (
        <div className="hint-t">
          {d.byNode ? "Their" : "Your"} text: “<Fmt text={d.text} />”
        </div>
      ) : null}
      <div className="lbl">What each recipient received</div>
      {rows.map((r) => {
        const n = data.nodes[r.nodeId];
        const canRetry = r.state === "failed" && data.outboxFailed.some((o) => o.nodeId === r.nodeId);
        return (
          <div key={r.nodeId} className="recip">
            <div className="rw">
              <b>{trailLabel(n, data.apps) || r.nodeId}</b>
              <LevelChip level={r.level} world={r.world} />
            </div>
            <div className="rt">
              <Fmt text={r.notice} />
              {r.ackNote ? (
                <div className="hint-t" style={{ marginTop: 4 }}>
                  Ack: “{r.ackNote}”
                </div>
              ) : null}
            </div>
            <div className="col" style={{ gap: 4, alignItems: "flex-end" }}>
              <ReceiptChip state={r.state} />
              {canRetry ? (
                <button type="button" className="btn sm danger" disabled={retrying === r.nodeId} onClick={() => void retry(r)}>
                  <Ic name="RotateCcw" size="sm" /> Retry
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
      {collapse ? (
        <div className={cx("recip")}>
          <div className="rw">
            <b>+ {hiddenDirect.length} more agents</b>
            <LevelChip level="direct" world={false} />
          </div>
          <div className="rt">Same directive, delivered to each agent’s thread separately — receipts are still tracked per agent.</div>
          <button type="button" className="btn sm" onClick={() => setShowAll(true)}>
            Show all
          </button>
        </div>
      ) : null}
    </div>
  );
}
