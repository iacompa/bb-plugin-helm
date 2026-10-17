// Inspector → Comms, Brief, Reports, Changes.
import { useState } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import type { DirectiveInfo, NodeDetail, SnapNode } from "../types.ts";
import { TYPE_ICON, TYPE_LABEL, agoOf, clockOf, trailLabel } from "../format.ts";
import { useHelm } from "../ctx.tsx";
import { Banner, Empty, Ic, ReceiptChip, Seg, cx } from "../ui.tsx";
import { useAppDetail } from "./shared.tsx";

function Loading() {
  return <div className="pad muted">Loading…</div>;
}

// ───────────── Comms ─────────────

type CommsFilter = "all" | "agents" | "notices";

export function CommsTab({ n, detail }: { n: SnapNode; detail: NodeDetail | null }) {
  const h = useHelm();
  const s = h.data!;
  const [f, setF] = useState<CommsFilter>("all");
  if (!detail) return <Loading />;
  const name = (id: string) => (id === "human" || id === "you" ? "You" : id === "helm" ? "Helm" : trailLabel(s.nodes[id], s.apps) || id);
  type Row = { key: string; ts: number; from: string; to: string; text: string; kind: string; directiveId: string | null; notice: boolean };
  const rows: Row[] = [];
  for (const c of detail.comms) rows.push({ key: `c${c.id}`, ts: c.ts, from: name(c.fromNode), to: name(c.toNode), text: c.summary, kind: c.kind, directiveId: c.directiveId, notice: !!c.directiveId || c.kind === "notice" });
  for (const m of detail.inbox) rows.push({ key: `i${m.id ?? m.ts}`, ts: m.ts, from: "Helm", to: name(n.id), text: m.text, kind: "digest", directiveId: m.directiveId ?? null, notice: true });
  rows.sort((a, b) => b.ts - a.ts);
  const list = rows.filter((r) => (f === "all" ? true : f === "notices" ? r.notice : !r.notice));
  const receipt = (directiveId: string | null) => {
    if (!directiveId) return null;
    const d = s.directives.find((x) => x.id === directiveId) ?? detail.directives.find((x) => x.id === directiveId);
    const r = d?.recipients.find((x) => x.nodeId === n.id);
    return r ? <ReceiptChip state={r.state} /> : null;
  };
  return (
    <div className="pad">
      <div className="row" style={{ justifyContent: "space-between", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <Seg
          label="Filter messages"
          value={f}
          onChange={setF}
          options={[
            ["all", "All"],
            ["agents", "Agents"],
            ["notices", "Notices"],
          ]}
        />
        <span className="muted" style={{ fontSize: 12 }}>
          {list.length} of {rows.length}
        </span>
      </div>
      <div className="hint-t" style={{ marginBottom: 6 }}>
        Everything this agent sent or received, including notices about your changes. Each notice carries a delivery receipt.
      </div>
      {list.length ? (
        list.map((c) => (
          <div key={c.key} className="comm">
            <span className="tm">{clockOf(c.ts)}</span>
            <div className="grow">
              <div className="arrow">
                <b>{c.from}</b>
                <Ic name="ChevronRight" size="sm" />
                <b>{c.to}</b>
                <span className="faint">{c.kind}</span>
                {c.directiveId ? <span className="pill human mono">{c.directiveId}</span> : null}
                {receipt(c.directiveId)}
              </div>
              <div className="body">{c.text}</div>
            </div>
          </div>
        ))
      ) : (
        <Empty>{rows.length ? "Nothing in this filter." : "No messages yet."}</Empty>
      )}
    </div>
  );
}

// ───────────── Brief ─────────────

export function BriefTab({ n, detail }: { n: SnapNode; detail: NodeDetail | null }) {
  const h = useHelm();
  if (!detail) return <Loading />;
  const scopeEdits = detail.directives.filter((d) => d.type === "scope" && d.targetNodeId === n.id);
  return (
    <div className="pad">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12, gap: 8 }}>
        <span className="pill mono">brief v{n.briefVersion}</span>
        <button type="button" className="btn sm" onClick={() => h.select(n.id, { tab: "direct", dtype: "scope" })}>
          <Ic name="FileText" size="sm" /> Edit brief
        </button>
      </div>
      {scopeEdits[0] ? (
        <Banner tone="human" icon="UserRound" style={{ marginBottom: 12 }}>
          <b>You edited this brief ({scopeEdits[0].id}).</b> {scopeEdits[0].text}
        </Banner>
      ) : null}
      <dl className="kv" style={{ marginBottom: 12 }}>
        <dt>Write scope</dt>
        <dd className="mono" style={{ fontSize: 11.5 }}>
          {n.scopeGlobs?.length ? n.scopeGlobs.join(", ") : "—"}
        </dd>
        {n.branch ? (
          <>
            <dt>Branch</dt>
            <dd className="mono" style={{ fontSize: 11.5 }}>
              {n.branch}
            </dd>
          </>
        ) : null}
      </dl>
      {detail.brief ? (
        <div className="brief">
          <BriefBody text={detail.brief} />
        </div>
      ) : (
        <Empty>{n.status === "planned" ? "The brief is written when this agent spawns. Edits you make now are added to it." : "No brief recorded for this agent."}</Empty>
      )}
      <div className="hint-t" style={{ marginTop: 14 }}>
        Briefs follow a fixed shape — objective, outputs, boundaries, inputs, acceptance — so no agent has to guess what “done” means. The agent reads it as BRIEF.md.
      </div>
    </div>
  );
}

function BriefBody({ text }: { text: string }) {
  return <Markdown content={text} />;
}

// ───────────── Reports ─────────────

export function ReportsTab({ n, detail }: { n: SnapNode; detail: NodeDetail | null }) {
  const h = useHelm();
  const isGateOrLead = !!n.appId && (n.tier === "gate" || n.tier === "lead" || n.alsoLead);
  const app = useAppDetail(isGateOrLead ? n.appId : null);
  if (!detail) return <Loading />;
  const gate = n.role === "review" ? "review" : n.role === "slop" ? "slop" : null;
  const verdicts = (app?.verdicts ?? []).filter((v) => !gate || v.gate === gate);
  const findings = (app?.findings ?? []).filter((f) => !gate || f.gate === gate || (gate === "slop" && f.gate === "scan"));
  return (
    <div className="pad">
      {isGateOrLead ? (
        <>
          <div className="lbl" style={{ marginBottom: 8 }}>
            {gate ? "Verdicts" : "Gate verdicts for this app"}
          </div>
          {!app ? <div className="muted" style={{ marginBottom: 12 }}>Loading gate results…</div> : null}
          {app && !verdicts.length ? <Empty>No verdicts yet.</Empty> : null}
          {verdicts.map((v) => (
            <article key={v.id} className="rep">
              <div className="rep-h">
                <span className={cx("pill", v.verdict === "pass" ? "ok" : "crit")}>{v.verdict === "pass" ? "Pass" : "Fail"}</span>
                <b>{v.gate === "review" ? "Reviewer" : "Slop Hunter"}</b>
                <span className="mono muted">{v.commit.slice(0, 9)}</span>
                {!v.accepted ? <span className="pill warn">not accepted</span> : null}
                <span className="grow" />
                <span className="faint">{clockOf(v.ts)}</span>
              </div>
              <div className="rep-b">
                <div>{v.summary}</div>
                {v.checks.length ? (
                  <div>
                    {v.checks.map((c) => (
                      <div key={c.id} className="chk">
                        <Ic name={c.ok ? "Check" : "X"} size="sm" />
                        <span className="grow">{c.how}</span>
                        <span className="mono faint">{c.ref}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
                {v.unverified.length ? (
                  <div className="muted">
                    <b style={{ color: "var(--h-fg-2)" }}>Unverified:</b> {v.unverified.map((u) => `${u.what} (${u.reason})`).join("; ")}
                  </div>
                ) : null}
                {v.problems.length ? <Banner tone="warn">{v.problems.join(" ")}</Banner> : null}
              </div>
            </article>
          ))}
          {app?.checks.length ? (
            <>
              <div className="lbl" style={{ margin: "12px 0 8px" }}>
                Deterministic checks
              </div>
              <div className="wv" style={{ marginBottom: 12 }}>
                {app.checks.map((c) => (
                  <div key={c.id} className="chk">
                    <span className={cx("pill", c.status === "pass" ? "ok" : c.status === "fail" ? "crit" : "warn")}>{c.status}</span>
                    <b className="grow trunc">{c.name}</b>
                    <span className="faint">{c.tier}</span>
                    {c.exitCode !== null ? <span className="mono faint">exit {c.exitCode}</span> : null}
                    {c.commitSha ? <span className="mono faint">{c.commitSha.slice(0, 9)}</span> : null}
                  </div>
                ))}
              </div>
            </>
          ) : null}
          {findings.length ? (
            <>
              <div className="lbl" style={{ margin: "12px 0 8px" }}>
                Findings · {findings.filter((f) => f.status === "open").length} open
              </div>
              <div className="col" style={{ gap: 8, marginBottom: 14 }}>
                {findings.map((f) => (
                  <div key={f.id} className={cx("finding", `sev-${f.severity}`)}>
                    <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                      <span className="pill mono">{f.id}</span>
                      <span className={cx("pill", f.severity === "blocker" ? "crit" : f.severity === "major" ? "warn" : "")}>{f.severity}</span>
                      <span className="pill mono">{f.rule}</span>
                      <span className="mono muted trunc" style={{ fontSize: 11 }}>
                        {f.path}:{f.line}
                      </span>
                      <span className="grow" />
                      <span className={cx("pill", f.status === "open" ? "warn" : f.status === "fixed" ? "ok" : "")}>{f.status}</span>
                    </div>
                    {f.quote ? <pre className="evi">{f.quote}</pre> : null}
                    <div>
                      <b>Why:</b> {f.why}
                    </div>
                    {f.fix ? (
                      <div className="muted">
                        <b style={{ color: "var(--h-fg-2)" }}>Fix:</b> {f.fix}
                      </div>
                    ) : null}
                    {f.status === "open" && n.tier === "gate" ? (
                      <div>
                        <button type="button" className="btn sm" onClick={() => h.select(n.id, { tab: "direct", dtype: "waive" })}>
                          <Ic name="SecurityCheck" size="sm" /> Waive…
                        </button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          ) : null}
          <div className="lbl" style={{ margin: "12px 0 8px" }}>
            Reports from this agent
          </div>
        </>
      ) : null}
      {detail.reports.length ? (
        detail.reports.map((r) => (
          <article key={r.id} className="rep">
            <div className="rep-h">
              <span className={cx("pill", r.status === "done" ? "ok" : r.status === "failed" ? "crit" : r.status === "blocked" ? "warn" : "run")}>{r.status}</span>
              <span className={cx("pill", r.verified ? "ok" : "warn")}>{r.verified ? "verified" : "unverified"}</span>
              <span className="grow" />
              <span className="faint">
                {clockOf(r.ts)} · {agoOf(r.ts)}
              </span>
            </div>
            <div className="rep-b">
              <div style={{ whiteSpace: "pre-wrap" }}>{r.summary}</div>
              {r.evidence.length ? (
                <pre className="evi">
                  {r.evidence.map((e) => `${e.kind}: ${e.ref}${e.branch ? ` (${e.branch})` : ""}`).join("\n")}
                </pre>
              ) : null}
              {r.problems.length ? <Banner tone="warn">{r.problems.join(" ")}</Banner> : null}
            </div>
          </article>
        ))
      ) : (
        <Empty>{n.status === "planned" ? "Not spawned yet — no reports." : "No reports yet."}</Empty>
      )}
      <div className="hint-t">Reports are evidence, not proof: the lead (and the gates) re-check them against the code.</div>
    </div>
  );
}

// ───────────── Changes ─────────────

function roleFor(d: DirectiveInfo, n: SnapNode, label: (id: string) => string): [string, string] {
  if (d.targetNodeId === n.id) return ["You changed this agent", "human"];
  if (d.affected.includes(n.id)) return [`Cascaded from ${label(d.targetNodeId)}`, "human"];
  const r = d.recipients.find((x) => x.nodeId === n.id);
  if (!r) return ["", ""];
  if (r.level === "full") return [`Parent of the target — full notice (${label(d.targetNodeId)} was changed)`, "acc"];
  if (r.level === "digest") return [`Ancestor — digest (${label(d.targetNodeId)} was changed)`, "acc"];
  return ["Target", "human"];
}

export function ChangesTab({ n, detail }: { n: SnapNode; detail: NodeDetail | null }) {
  const h = useHelm();
  const s = h.data!;
  if (!detail) return <Loading />;
  const label = (id: string) => trailLabel(s.nodes[id], s.apps) || id;
  const live = (d: DirectiveInfo) => s.directives.find((x) => x.id === d.id) ?? d;
  const list = detail.directives.map(live);
  const policies = s.policies.filter((p) => !p.retiredAt);
  return (
    <div className="pad col" style={{ gap: 10 }}>
      <div className="hint-t">Every change you made to this agent, anything below it, or anything it should know about. The same list the Orchestrator reads.</div>
      {list.length ? (
        list.map((d) => {
          const [role, cls] = roleFor(d, n, label);
          const r = d.recipients.find((x) => x.nodeId === n.id);
          return (
            <div key={d.id} className="lrow">
              <button type="button" className="lmain" onClick={() => h.setView("ledger")} title="Open in the Ledger">
                <span className="lid">{d.id}</span>
                <span className="tile">
                  <Ic name={TYPE_ICON[d.type] ?? "MessageSquare"} />
                </span>
                <span className="ltxt">
                  <b>{TYPE_LABEL[d.type] ?? d.type}</b>
                  {d.policy ? <span className="pill acc"> standing policy</span> : null}
                  {d.cascade !== "self" ? <span className="pill"> {d.cascade === "reports" ? "+ reports" : "everyone below"}</span> : null}
                  {d.implicit ? <span className="pill"> typed in the thread</span> : null}
                  <div className="sub">{d.summary}</div>
                  {role ? (
                    <div style={{ marginTop: 4 }}>
                      <span className={cx("pill", cls)}>{role}</span>
                    </div>
                  ) : null}
                </span>
                <span className="lside">
                  <span className="faint mono" style={{ fontSize: 11 }}>
                    {clockOf(d.ts)} · {agoOf(d.ts)}
                  </span>
                  {r ? <ReceiptChip state={r.state} /> : null}
                </span>
              </button>
            </div>
          );
        })
      ) : (
        <Empty>Nothing has been changed here. When you edit this agent, it’ll show up here — and in its lead’s, manager’s and the Orchestrator’s lists.</Empty>
      )}
      {policies.length ? (
        <>
          <div className="lbl" style={{ marginTop: 6 }}>
            Standing policies in this run
          </div>
          {policies.map((p) => (
            <div key={p.id} className="row" style={{ alignItems: "flex-start", gap: 9, fontSize: 12.5 }}>
              <Ic name="Layers" size="sm" />
              <span className="grow">
                {p.text} <span className="faint">· {p.id} · {label(p.scopeNodeId)}</span>
              </span>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}
