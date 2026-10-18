// Needs you (§11.7): one inbox for everything waiting on the human, with
// context, evidence and actions that map to needs_resolve.
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useHelm } from "./ctx.tsx";
import type { DirectiveInfo, ModelRef, NeedInfo, NeedKind } from "./types.ts";
import type { RunState } from "./store.ts";
import { managerOfApp } from "./store.ts";
import { agoOf, clockOf, errMsg, fmtUnits, plural, trailLabel } from "./format.ts";
import { Fmt, Ic, Modal, ModalHead, askConfirm, askReason, cx } from "./ui.tsx";
import { ModelPicker } from "./picker.tsx";

const KIND_META: Record<NeedKind, { label: string; icon: string; tone: "warn" | "ok" | "crit" | "acc" }> = {
  approval: { label: "Approval", icon: "Terminal", tone: "warn" },
  question: { label: "Question", icon: "MessageQuestion", tone: "acc" },
  decision: { label: "Decision", icon: "CircleQuestion", tone: "acc" },
  signoff: { label: "Sign-off", icon: "CircleCheck", tone: "ok" },
  failed: { label: "Failed", icon: "AlertTriangle", tone: "crit" },
  slop: { label: "Slop gate", icon: "Clean", tone: "warn" },
  plan: { label: "Plan", icon: "Layers", tone: "acc" },
  budget: { label: "Budget", icon: "ChartColumn", tone: "crit" },
  stalled: { label: "Stalled", icon: "Clock", tone: "warn" },
  model: { label: "Model", icon: "Brain", tone: "warn" },
};
const KIND_FILTER_LABEL: Record<NeedKind, string> = {
  approval: "Approvals",
  question: "Questions",
  decision: "Decisions",
  signoff: "Sign-offs",
  failed: "Failures",
  slop: "Gates",
  plan: "Plans",
  budget: "Budget",
  stalled: "Stalled",
  model: "Models",
};
const KIND_ORDER: NeedKind[] = ["approval", "question", "decision", "signoff", "failed", "slop", "plan", "budget", "stalled", "model"];

type Action =
  | "approve"
  | "deny"
  | "answer"
  | "retry"
  | "change_model"
  | "stop"
  | "raise_cap"
  | "keep_paused"
  | "stop_run"
  | "signoff"
  | "sendback"
  | "waive"
  | "dismiss"
  | "nudge"
  | "complete_run";
interface ResolveExtra {
  text?: string;
  model?: ModelRef;
  value?: number;
  findingIds?: string[];
  rotatedConfirmed?: boolean;
}

const toneVar = (t: string) => (t === "ok" ? "ok" : t === "crit" ? "crit" : t === "acc" ? "accent" : "warn");

export function NeedsView() {
  const h = useHelm();
  const data = h.data;
  const [filter, setFilter] = useState<string>("open");
  const [showResolved, setShowResolved] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [modelFor, setModelFor] = useState<NeedInfo | null>(null);
  const [waiveFor, setWaiveFor] = useState<NeedInfo | null>(null);
  const [capFor, setCapFor] = useState<NeedInfo | null>(null);

  if (!data) return <div className="pagewrap"><div className="page"><h2>Needs you</h2><span className="muted">Loading…</span></div></div>;

  const open = data.needs.filter((n) => n.state === "open").sort((a, b) => b.createdAt - a.createdAt);
  const resolved = data.needs.filter((n) => n.state !== "open").sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
  const kinds = KIND_ORDER.filter((k) => data.needs.some((n) => n.kind === k));
  const list = filter === "open" ? open : filter === "all" ? open : open.filter((n) => n.kind === filter);
  const resolvedList = filter === "open" ? resolved : filter === "all" ? resolved : resolved.filter((n) => n.kind === filter);

  const resolve = async (need: NeedInfo, action: Action, extra: ResolveExtra = {}, okMsg?: string) => {
    setBusy(need.id);
    try {
      const r = (await h.rpc.call("needs_resolve", { runId: h.runId!, needId: need.id, action, ...extra })) as { directive?: DirectiveInfo | null };
      if (r?.directive) h.firePulse(r.directive);
      toast.success(okMsg ?? "Done", { description: r?.directive ? `Recorded as ${r.directive.id}; the chain above was told.` : undefined });
      h.refetch();
      return true;
    } catch (e) {
      toast.error(errMsg(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="pagewrap">
      <div className="page">
        <div>
          <h2>Needs you</h2>
          <p className="lead">Agents run in hidden threads, so BB can’t flash an attention badge for them. Everything that is waiting on you — approvals, questions, failures, gates, sign-offs — lands here, with context and one-click answers.</p>
        </div>
        <div className="ptools">
          <div className="seg" role="group" aria-label="Filter by kind">
            {([["open", "Open"], ["all", "All"], ...kinds.map((k) => [k, KIND_FILTER_LABEL[k]])] as Array<[string, string]>).map(([id, l]) => (
              <button key={id} type="button" aria-pressed={filter === id} className={filter === id ? "on" : ""} onClick={() => setFilter(id)}>
                {l}
              </button>
            ))}
          </div>
          <span className="grow" />
          <span className="muted" style={{ fontSize: 12 }}>
            {open.length} open
          </span>
        </div>
        <div className="col" style={{ gap: 12 }}>
          {list.map((n) => (
            <NeedCard key={n.id} need={n} data={data} busy={busy === n.id} resolve={resolve} onModel={() => setModelFor(n)} onWaive={() => setWaiveFor(n)} onCap={() => setCapFor(n)} />
          ))}
          {!list.length ? <div className="empty">{open.length ? "Nothing in this filter." : "All clear — nothing is waiting on you."}</div> : null}
        </div>
        {(filter === "all" || filter === "open" || resolvedList.length) && resolvedList.length ? (
          <div className="col" style={{ gap: 8 }}>
            <button type="button" className="btn ghost sm" aria-expanded={showResolved} onClick={() => setShowResolved(!showResolved)} style={{ alignSelf: "flex-start" }}>
              <Ic name={showResolved ? "ChevronDown" : "ChevronRight"} size="sm" /> Resolved ({resolvedList.length})
            </button>
            {showResolved ? resolvedList.slice(0, 200).map((n) => <ResolvedRow key={n.id} need={n} data={data} />) : null}
          </div>
        ) : null}
      </div>
      {modelFor ? <ModelModal need={modelFor} data={data} onClose={() => setModelFor(null)} onPick={async (m) => (await resolve(modelFor, "change_model", { model: m }, "Model changed")) && setModelFor(null)} /> : null}
      {waiveFor ? <WaiveModal need={waiveFor} data={data} onClose={() => setWaiveFor(null)} onWaive={async (x) => (await resolve(waiveFor, "waive", x, "Waiver recorded")) && setWaiveFor(null)} /> : null}
      {capFor ? <CapModal need={capFor} cap={data.run.budgetCap} onClose={() => setCapFor(null)} onRaise={async (v) => (await resolve(capFor, "raise_cap", { value: v }, "Budget cap raised")) && setCapFor(null)} /> : null}
    </div>
  );
}

function NeedCard({
  need,
  data,
  busy,
  resolve,
  onModel,
  onWaive,
  onCap,
}: {
  need: NeedInfo;
  data: RunState;
  busy: boolean;
  resolve: (n: NeedInfo, a: Action, x?: ResolveExtra, ok?: string) => Promise<boolean>;
  onModel: () => void;
  onWaive: () => void;
  onCap: () => void;
}) {
  const h = useHelm();
  const nav = useBbNavigate();
  const meta = KIND_META[need.kind] ?? KIND_META.question;
  const node = need.nodeId ? data.nodes[need.nodeId] : null;
  const app = need.appId ? data.apps[need.appId] : node?.appId ? data.apps[node.appId] : null;
  const mgr = app ? managerOfApp(data, app.id) : null;
  const tv = toneVar(meta.tone);
  const opts = need.options ?? [];
  const nd = (need.data ?? {}) as { completeRun?: boolean; findingIds?: string[]; commit?: string; ciPlatforms?: string[] };
  const [look, setLook] = useState(false);

  const B = ({ label, cls, icon, onClick, title }: { label: string; cls?: string; icon?: string; onClick: () => void; title?: string }) => (
    <button type="button" className={cx("btn sm", cls)} disabled={busy} onClick={onClick} title={title}>
      {icon ? <Ic name={icon} size="sm" /> : null}
      {label}
    </button>
  );
  const answerFree = async () => {
    const t = await askReason({ title: "Answer", body: need.title, placeholder: "Your answer is delivered into the asking agent’s thread.", ok: "Send answer", hint: "Recorded in the Ledger; the chain above is told." });
    if (t) void resolve(need, "answer", { text: t }, "Answer sent");
  };
  const stop = async (what: string) => {
    if (await askConfirm({ title: `Stop ${what}?`, body: "Stopped agents end their turn and are not restarted. The chain above is told.", ok: "Stop", danger: true })) void resolve(need, "stop", {}, `${what} stopped`);
  };

  let actions: ReactNode = null;
  switch (need.kind) {
    case "approval":
      actions = (
        <>
          <B label={opts[0] ?? "Approve"} cls="primary" icon="Check" onClick={() => void resolve(need, "approve", {}, "Approved")} />
          <B label={opts[1] ?? "Deny"} cls="danger" icon="X" onClick={() => void resolve(need, "deny", {}, "Denied")} />
        </>
      );
      break;
    case "question":
      actions = (
        <>
          {opts.map((o, i) => (
            <B key={o} label={o} cls={i === 0 ? "primary" : ""} onClick={() => void resolve(need, "answer", { text: o }, `Answered: ${o}`)} />
          ))}
          <B label="Answer…" icon="MessageSquare" onClick={() => void answerFree()} />
        </>
      );
      break;
    case "plan":
      actions = (
        <>
          <B label={opts[0] ?? "Approve wave"} cls="primary" icon="Check" onClick={() => void resolve(need, "approve", {}, opts[0] ?? "Approved")} />
          <B label={opts[1] ?? "Not yet"} onClick={() => void resolve(need, "deny", {}, opts[1] ?? "Not yet")} />
        </>
      );
      break;
    case "signoff": {
      const name = app?.name ?? "this app";
      actions = (
        <>
          <B
            label="Sign off"
            cls="ok"
            icon="Check"
            onClick={async () => {
              const body = `${name} is marked done and its squad’s threads are archived.${nd.commit ? ` Commit ${String(nd.commit).slice(0, 9)}.` : ""}${nd.ciPlatforms?.length ? ` ${nd.ciPlatforms.join(", ")} ${nd.ciPlatforms.length === 1 ? "is" : "are"} verified by CI only, not on this machine.` : ""} The Orchestrator${mgr ? ` and the ${mgr.name} manager are` : " is"} told.`;
              if (await askConfirm({ title: `Sign off ${name}?`, body, ok: "Sign off" })) void resolve(need, "signoff", {}, `${name} signed off`);
            }}
          />
          <B
            label="Send back…"
            icon="RotateCcw"
            onClick={async () => {
              const t = await askReason({ title: `Send ${name} back to Build`, placeholder: "What should change?", ok: "Send back" });
              if (t) void resolve(need, "sendback", { text: t }, `${name} sent back to Build`);
            }}
          />
        </>
      );
      break;
    }
    case "failed":
      actions = (
        <>
          <B label="Retry" cls="primary" icon="RotateCcw" onClick={() => void resolve(need, "retry", {}, "Retrying")} />
          <B label="Change model and retry…" icon="Brain" onClick={onModel} />
          <B label="Stop" cls="danger" icon="Square" onClick={() => void stop(node?.label ?? "this agent")} />
        </>
      );
      break;
    case "slop":
      actions = (
        <>
          <B
            label="Send back to Build with a note…"
            cls="primary"
            icon="ArrowTurnBackward"
            onClick={async () => {
              const t = await askReason({ title: `Send ${app?.name ?? "the app"} back to Build`, placeholder: "What should the lead fix?", ok: "Send back" });
              if (t) void resolve(need, "sendback", { text: t }, "Sent back to Build");
            }}
          />
          <B label="Waive named findings…" icon="SecurityCheck" onClick={onWaive} />
          <B label="Stop the app" cls="danger" icon="Square" onClick={() => void stop(app?.name ?? "the app")} />
        </>
      );
      break;
    case "budget":
      actions = (
        <>
          <B label="Raise cap…" cls="primary" icon="ArrowUp" onClick={onCap} />
          <B label="Keep paused" icon="Pause" onClick={() => void resolve(need, "keep_paused", {}, "Spawns stay paused")} />
          <B
            label="Stop run"
            cls="danger"
            icon="Square"
            onClick={async () => {
              if (await askConfirm({ title: "Stop the whole run?", body: "Every remaining agent is stopped and archived. This cannot be undone.", ok: "Stop run", danger: true })) void resolve(need, "stop_run", {}, "Run stopped");
            }}
          />
        </>
      );
      break;
    case "stalled":
      actions = (
        <>
          <B label="Nudge again" cls="primary" icon="BellDot" onClick={() => void resolve(need, "nudge", {}, "Nudged")} />
          <B label="Retry" icon="RotateCcw" onClick={() => void resolve(need, "retry", {}, "Retrying")} />
          <B label="Stop" cls="danger" icon="Square" onClick={() => void stop(node?.label ?? "this agent")} />
        </>
      );
      break;
    case "model":
      actions = <B label="Choose model…" cls="primary" icon="Brain" onClick={onModel} />;
      break;
    case "decision":
      actions = nd.completeRun ? (
        <>
          <B
            label={opts[0] ?? "Complete run"}
            cls="primary"
            icon="CircleCheck"
            onClick={async () => {
              if (await askConfirm({ title: "Complete the run?", body: "Remaining agents are stopped and archived, and the run is marked done.", ok: "Complete run" })) void resolve(need, "complete_run", {}, "Run completed");
            }}
          />
          <B label={opts[1] ?? "Keep open"} onClick={() => void resolve(need, "dismiss", {}, "Kept open")} />
        </>
      ) : (
        <>
          {opts.map((o, i) => (
            <B key={o} label={o} cls={i === 0 ? "primary" : ""} onClick={() => void resolve(need, "answer", { text: o }, `Answered: ${o}`)} />
          ))}
          <B label="Answer…" icon="MessageSquare" onClick={() => void answerFree()} />
        </>
      );
      break;
  }

  return (
    <article className={cx("ncard", meta.tone === "crit" ? "crit" : "hot")} aria-label={`${meta.label}: ${need.title}`}>
      <div className="nhead">
        <span className="tile lg" style={{ background: `var(--h-${tv}-soft)`, color: tv === "accent" ? "var(--h-accent)" : `var(--h-${tv}-ink)` }}>
          <Ic name={meta.icon} />
        </span>
        <div className="grow">
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <span className={cx("pill", meta.tone)}>{meta.label}</span>
            <span className="muted" style={{ fontSize: 11.5 }}>
              {node ? trailLabel(node, data.apps) : app?.name ?? "Run"}
              {mgr ? ` · ${mgr.name}` : ""} · {agoOf(need.createdAt)}
            </span>
            <span className="faint mono" style={{ fontSize: 10.5 }}>
              {need.id}
            </span>
          </div>
          <h3 style={{ marginTop: 6 }}>
            <Fmt text={need.title} />
          </h3>
        </div>
        {need.nodeId && data.nodes[need.nodeId] ? (
          <button type="button" className="btn sm ghost" onClick={() => h.focusNode(need.nodeId!)}>
            <Ic name="Workflow" size="sm" /> Show
          </button>
        ) : null}
      </div>
      <div className="nbody">
        {need.body ? (
          <div>
            <Fmt text={need.body} />
          </div>
        ) : null}
        {need.evidence ? <pre className="evi">{need.evidence}</pre> : null}
        {look ? <LookPanel runId={need.runId} needId={need.id} /> : null}
      </div>
      <div className="nfoot">
        {actions}
        <span className="grow" />
        {app ? (
          <button type="button" className={cx("btn sm ghost", look && "on")} aria-pressed={look} onClick={() => setLook((x) => !x)} title="See what this is about before you answer: the app's checkout and worktrees (branch, commit, uncommitted files) and the commits it names, read from git now">
            <Ic name="Search" size="sm" /> Look
          </button>
        ) : null}
        {app ? (
          <button type="button" className="btn sm ghost" onClick={() => h.openScreens(app.id)} title={`${app.name}'s screens, page by page`}>
            <Ic name="Image" size="sm" /> Screens
          </button>
        ) : null}
        {node?.threadId ? (
          <button type="button" className="btn sm ghost" onClick={() => nav.toThread(node.threadId!, { split: true })}>
            <Ic name="ExternalLink" size="sm" /> Open thread in BB
          </button>
        ) : null}
      </div>
    </article>
  );
}

function ResolvedRow({ need, data }: { need: NeedInfo; data: RunState }) {
  const meta = KIND_META[need.kind] ?? KIND_META.question;
  const node = need.nodeId ? data.nodes[need.nodeId] : null;
  const res = need.resolution as { action?: string; text?: string } | null;
  return (
    <article className="ncard resolved" aria-label={`Resolved: ${need.title}`}>
      <div className="nhead" style={{ paddingBottom: 12 }}>
        <span className="tile">
          <Ic name={meta.icon} />
        </span>
        <div className="grow">
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <span className="pill">{meta.label}</span>
            <span className="muted" style={{ fontSize: 11.5 }}>
              {node ? trailLabel(node, data.apps) : "Run"} · resolved {clockOf(need.resolvedAt)}
            </span>
          </div>
          <div style={{ fontWeight: 600, marginTop: 4 }}>
            <Fmt text={need.title} />
          </div>
          <div className="row" style={{ gap: 6, color: "var(--h-ok-ink)", marginTop: 4, fontSize: 12 }}>
            <Ic name="Check" size="sm" />
            <b>{res?.action ? res.action.replace(/_/g, " ") : "Resolved"}</b>
            {res?.text ? <span className="muted">— {res.text}</span> : null}
          </div>
        </div>
      </div>
    </article>
  );
}

function ModelModal({ need, data, onClose, onPick }: { need: NeedInfo; data: RunState; onClose: () => void; onPick: (m: ModelRef) => Promise<unknown> }) {
  const h = useHelm();
  const node = need.nodeId ? data.nodes[need.nodeId] : null;
  const [m, setM] = useState<ModelRef | null>(node?.model ?? null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal label="Change model" cls="md" onClose={onClose}>
      <ModalHead title={need.kind === "model" ? "Choose model" : "Change model and retry"} onClose={onClose} />
      <div className="mbody">
        <div className="pad col" style={{ gap: 10 }}>
          <span className="hint-t">
            {node ? `${trailLabel(node, data.apps)} uses the new model from its next turn${need.kind === "failed" ? " and is retried" : ""}. Its lead, manager and the Orchestrator are told.` : "The new model applies from the next turn."}
          </span>
          <ModelPicker catalog={h.catalog} value={m} onChange={setM} />
        </div>
      </div>
      <div className="mfoot">
        <span className="grow" />
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={!m || busy}
          onClick={async () => {
            if (!m) return;
            setBusy(true);
            await onPick(m);
            setBusy(false);
          }}
        >
          {need.kind === "failed" ? "Change and retry" : "Use this model"}
        </button>
      </div>
    </Modal>
  );
}

function WaiveModal({ need, data, onClose, onWaive }: { need: NeedInfo; data: RunState; onClose: () => void; onWaive: (x: ResolveExtra) => Promise<unknown> }) {
  const ids = ((need.data ?? {}) as { findingIds?: string[] }).findingIds ?? [];
  const findings = data.findings.filter((f) => (ids.length ? ids.includes(f.id) : f.appId === need.appId && f.status === "open"));
  const [picked, setPicked] = useState<Set<string>>(() => new Set(findings.map((f) => f.id)));
  const [text, setText] = useState("");
  const [rotated, setRotated] = useState(false);
  const [busy, setBusy] = useState(false);
  const secret = findings.some((f) => picked.has(f.id) && /secret|S6/i.test(f.rule));
  const ok = picked.size > 0 && text.trim().length > 0 && (!secret || rotated);
  return (
    <Modal label="Waive named findings" cls="md" onClose={onClose}>
      <ModalHead title="Waive named findings" onClose={onClose} />
      <div className="mbody">
        <div className="pad col" style={{ gap: 10 }}>
          <span className="hint-t">Each waiver is recorded with your reason and shown to the lead, the manager and the Orchestrator. Zero-tolerance findings need at least 20 characters of reason.</span>
          {findings.length ? (
            findings.map((f) => (
              <label key={f.id} className={cx("finding", `sev-${f.severity}`)} style={{ cursor: "pointer" }}>
                <span className="row" style={{ gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={picked.has(f.id)}
                    onChange={(e) => {
                      const s = new Set(picked);
                      if (e.target.checked) s.add(f.id);
                      else s.delete(f.id);
                      setPicked(s);
                    }}
                  />
                  <span className="pill mono">{f.id}</span>
                  <span className={cx("pill", f.severity === "blocker" ? "crit" : f.severity === "major" ? "warn" : "")}>{f.severity}</span>
                  <b className="mono" style={{ fontSize: 11.5 }}>
                    {f.rule}
                  </b>
                  <span className="grow" />
                  <span className="mono muted" style={{ fontSize: 11 }}>
                    {f.path}:{f.line}
                  </span>
                </span>
                {f.quote ? <pre className="evi">{f.quote}</pre> : null}
                {f.why ? <span className="muted">{f.why}</span> : null}
              </label>
            ))
          ) : (
            <div className="empty">No open findings are attached to this item.</div>
          )}
          <textarea className="textarea" aria-label="Reason" placeholder="Why is this acceptable?" value={text} onChange={(e) => setText(e.target.value)} />
          {secret ? (
            <label className="check">
              <input type="checkbox" checked={rotated} onChange={(e) => setRotated(e.target.checked)} />
              <span>
                <b>I have rotated this credential</b>
                <br />
                <span className="hint-t">A leaked secret can only be waived after it has been rotated.</span>
              </span>
            </label>
          ) : null}
        </div>
      </div>
      <div className="mfoot">
        <span className="hint-t">{plural(picked.size, "finding")} selected</span>
        <span className="grow" />
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={!ok || busy}
          onClick={async () => {
            setBusy(true);
            await onWaive({ findingIds: [...picked], text: text.trim(), rotatedConfirmed: secret ? rotated : undefined });
            setBusy(false);
          }}
        >
          Waive
        </button>
      </div>
    </Modal>
  );
}

function CapModal({ need, cap, onClose, onRaise }: { need: NeedInfo; cap: number; onClose: () => void; onRaise: (v: number) => Promise<unknown> }) {
  const [v, setV] = useState(String(Math.round(cap * 1.5)));
  const [busy, setBusy] = useState(false);
  const n = Number(v);
  const ok = Number.isFinite(n) && n > cap;
  return (
    <Modal label="Raise budget cap" cls="md" onClose={onClose}>
      <ModalHead title="Raise the budget cap" onClose={onClose} />
      <div className="mbody">
        <div className="pad col" style={{ gap: 10 }}>
          <span className="hint-t">{need.title}</span>
          <div className="field">
            <label className="lbl" htmlFor="helm-cap-in">
              New cap (relative units) · current {fmtUnits(cap)}
            </label>
            <input id="helm-cap-in" className="input" type="number" min={cap} step={50} value={v} onChange={(e) => setV(e.target.value)} />
            <span className="hint-t">Relative weights, not real prices. New spawns resume once the cap is above current spend.</span>
          </div>
        </div>
      </div>
      <div className="mfoot">
        <span className="grow" />
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={!ok || busy}
          onClick={async () => {
            setBusy(true);
            await onRaise(n);
            setBusy(false);
          }}
        >
          Raise cap
        </button>
      </div>
    </Modal>
  );
}

interface LookPlace {
  role: "checkout" | "work" | "extra";
  path: string;
  branch: string | null;
  head: string | null;
  missing: boolean;
  dirty: string[];
  dirtyCount: number;
  agents: string[];
  named: boolean;
}
interface LookCommit {
  ref: string;
  sha: string | null;
  subject: string | null;
  ts: number | null;
  onWork: boolean | null;
  onMain: boolean | null;
}
interface NeedLook {
  app: { id: string; name: string } | null;
  repo: string | null;
  workBranch: string | null;
  mainBranch: string;
  places: LookPlace[];
  commits: LookCommit[];
  error: string | null;
}

const ROLE: Record<LookPlace["role"], string> = { checkout: "Your checkout", work: "Work worktree (all agents)", extra: "Other worktree" };

/** What a decision is about, read from git when opened: so the human can check before answering. */
function LookPanel({ runId, needId }: { runId: string; needId: string }) {
  const h = useHelm();
  const [res, setRes] = useState<NeedLook | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void (h.rpc.call("needs_look", { runId, needId }) as Promise<NeedLook>)
      .then((r) => live && setRes(r))
      .catch((e) => live && setErr(errMsg(e)));
    return () => {
      live = false;
    };
  }, [h.rpc, runId, needId]);
  if (err) return <div className="look muted">Could not read it: {err}</div>;
  if (!res) return <div className="look muted">Reading git…</div>;
  if (!res.repo) return <div className="look muted">{res.app ? `${res.app.name} has no repository yet.` : "This is not about one app's repository."}</div>;
  const yes = (v: boolean | null, what: string) => (v === null ? null : <span className={cx("pill", v ? "ok" : "")}>{v ? `on ${what}` : `not on ${what}`}</span>);
  return (
    <div className="look" aria-label="What this is about">
      <div className="look-h">
        Read from git now · branches: <code>{res.mainBranch}</code> and <code>{res.workBranch ?? "no work branch yet"}</code>
      </div>
      {res.places.map((p) => (
        <div key={p.path} className={cx("look-row", p.named && "named")}>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <b>{ROLE[p.role]}</b>
            {p.named ? <span className="pill warn">named here</span> : null}
            {p.missing ? <span className="pill crit">missing on disk</span> : null}
            <span className="mono faint">{p.branch ?? "detached"} @ {p.head?.slice(0, 9) ?? "?"}</span>
            {p.agents.length ? <span className="faint">· {p.agents.join(", ")}</span> : null}
          </div>
          <div className="mono look-path" title={p.path}>
            {p.path}
          </div>
          {p.dirtyCount ? (
            <details>
              <summary>
                {p.dirtyCount} uncommitted file{p.dirtyCount === 1 ? "" : "s"}
              </summary>
              <pre className="evi">{p.dirty.length ? p.dirty.join("\n") + (p.dirtyCount > p.dirty.length ? "\n…" : "") : "(listed only for the checkout, the work worktree and folders named here)"}</pre>
            </details>
          ) : (
            <span className="faint">clean</span>
          )}
        </div>
      ))}
      {res.commits.length ? (
        <div className="look-row">
          <b>Commits named here</b>
          {res.commits.map((c) => (
            <div key={c.ref} className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <code>{c.ref}</code>
              {c.sha ? (
                <>
                  <span>{c.subject ?? ""}</span>
                  {c.ts ? <span className="faint">{agoOf(c.ts * (c.ts < 1e12 ? 1000 : 1))}</span> : null}
                  {yes(c.onWork, res.workBranch ?? "the work branch")}
                  {yes(c.onMain, res.mainBranch)}
                </>
              ) : (
                <span className="faint">not in this repository</span>
              )}
            </div>
          ))}
        </div>
      ) : null}
      {res.error ? <div className="faint">{res.error}</div> : null}
    </div>
  );
}
