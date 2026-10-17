// Inspector → Overview: what the agent is doing, its numbers and settings,
// who is told when it changes, its children and the quick actions. The
// Orchestrator also shows the State of the world; a manager its apps.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { experimental_copyToClipboard, useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import type { NodeDetail, SnapNode, WorldState } from "../types.ts";
import {
  PROVIDER_LABEL,
  allowedTypes,
  appStatus,
  clockOf,
  durationOf,
  errMsg,
  findModel,
  fmtTokens,
  fmtUnits,
  isQuestion,
  plural,
  reasonLabel,
  roleIcon,
  roleText,
  statusLabel,
  trailLabel,
} from "../format.ts";
import { appMembers, leadOf } from "../store.ts";
import { useHelm } from "../ctx.tsx";
import { Banner, Dot, Ic, LevelChip, Sec, StagePill, StatusPill, askConfirm, cx } from "../ui.tsx";
import { isOrch, notifyChain, sendThreadText, useSendDirective } from "./shared.tsx";

export function Overview({ n, detail }: { n: SnapNode; detail: NodeDetail | null }) {
  const h = useHelm();
  const s = h.data!;
  const send = useSendDirective();
  const nav = useBbNavigate();
  const parent = n.parentId ? s.nodes[n.parentId] : null;
  const need = s.needs.find((x) => x.state === "open" && x.nodeId === n.id);
  const live = !["planned", "queued"].includes(n.status);
  const m = findModel(h.catalog, n.model);
  const allowed = allowedTypes(n);
  const kids = (s.children[n.id] ?? []).map((id) => s.nodes[id]).filter(Boolean);
  const findings = n.appId && (n.tier === "gate" || n.tier === "lead" || n.alsoLead) ? s.findings.filter((f) => f.appId === n.appId && f.status === "open") : [];

  const quick = async (type: "spawn" | "pause" | "resume" | "retry" | "stop") => {
    if (type === "stop") {
      const ok = await askConfirm({
        title: `Stop ${trailLabel(n, s.apps)}?`,
        body: "Stops the thread. The worktree stays on disk. Stopping does not cascade — children keep running unless you choose “Everyone below” in Direct.",
        ok: "Stop agent",
        danger: true,
      });
      if (!ok) return;
    }
    await send({ type, target: n.id, cascade: "self" });
  };

  return (
    <>
      {n.status === "planned" ? (
        <div className="sec">
          <Banner tone="info" icon="Clock">
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <span className="grow">
                <b>Not spawned yet.</b> {n.tier === "gate" ? "The lead spawns gates when integration checks are green, so they judge the merged result." : "Helm spawns it when its stage needs it and capacity allows."} Change its model or brief now and the spawn will use your choice.
              </span>
              {allowed.includes("spawn") ? (
                <button type="button" className="btn sm primary" onClick={() => void quick("spawn")}>
                  <Ic name="Play" size="sm" /> Spawn now
                </button>
              ) : null}
            </div>
          </Banner>
        </div>
      ) : null}
      {need ? (
        <div className="sec">
          <Banner tone="warn" icon="BellDot">
            <div className="row" style={{ gap: 8 }}>
              <span className="grow">
                <b>Waiting on you.</b> {need.title}
              </span>
              <button type="button" className="btn sm" onClick={() => h.setView("needs")}>
                Open
              </button>
            </div>
          </Banner>
        </div>
      ) : null}
      {n.warning ? (
        <div className="sec">
          <Banner tone="warn">{n.warning}</Banner>
        </div>
      ) : null}

      <Sec title="Talking about now">
        <div className="talk">
          {n.nowLine ? n.nowLine : <span className="muted">{n.status === "planned" ? "Not spawned yet." : "No activity reported yet."}</span>}
          {n.topics?.length ? (
            <div className="topics">
              {n.topics.map((t) => (
                <span key={t} className="topic">
                  {t}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </Sec>

      <Sec title="Run">
        <div className="statrow">
          <div className="stat">
            <b>{live ? fmtTokens(n.tokens) : "—"}</b>
            <span>tokens</span>
          </div>
          <div className="stat">
            <b>{live ? n.turns : "—"}</b>
            <span>turns</span>
          </div>
          <div className="stat" title="Relative units from recorded tokens and model weights — not a price">
            <b>{live ? fmtUnits(n.cost) : "—"}</b>
            <span>cost so far</span>
          </div>
          <div className="stat">
            <b>{n.spawnedAt ? durationOf(n.spawnedAt, n.endedAt ?? Date.now()) : "—"}</b>
            <span>{n.endedAt ? "ran for" : "running"}</span>
          </div>
        </div>
        <dl className="kv" style={{ marginTop: 12 }}>
          <dt>Role</dt>
          <dd>
            {roleText(n)}
            {n.alsoLead ? <span className="muted">· also the app lead</span> : null}
            <span className="muted">
              · model slot “{n.slot}”{n.modelOverride ? " (overridden)" : ""}
            </span>
          </dd>
          {parent ? (
            <>
              <dt>Reports to</dt>
              <dd>
                <button type="button" className="link" onClick={() => h.select(parent.id)}>
                  {trailLabel(parent, s.apps)}
                </button>
              </dd>
            </>
          ) : null}
          <dt>Model</dt>
          <dd>
            {n.model ? (
              <>
                {m?.name ?? n.model.modelId} <span className="mono muted">{n.model.modelId}</span> · {reasonLabel(n.model.reasoning) || "—"}
                {n.modelOverride ? <span className="pill human">override</span> : null}
              </>
            ) : (
              <span className="muted">Not set — the slot has no model</span>
            )}
          </dd>
          <dt>Provider</dt>
          <dd>{n.model ? m?.providerLabel ?? PROVIDER_LABEL[n.model.providerId] ?? n.model.providerId : "—"}</dd>
          {n.branch ? (
            <>
              <dt>Branch</dt>
              <dd className="mono" style={{ fontSize: 11.5 }}>
                <Ic name="GitBranch" size="sm" /> {n.branch}
              </dd>
            </>
          ) : null}
          <dt>Write scope</dt>
          <dd className="mono" style={{ fontSize: 11.5 }}>
            {n.scopeGlobs?.length ? n.scopeGlobs.join(", ") : <span className="muted">—</span>}
          </dd>
          <dt>Brief</dt>
          <dd>v{n.briefVersion}</dd>
          <dt>Priority</dt>
          <dd>{n.priority}</dd>
          <dt>Thread</dt>
          <dd className="mono" style={{ fontSize: 11.5 }}>
            {n.threadId ? (
              <>
                {n.threadId}
                <button
                  type="button"
                  className="iconbtn sm"
                  aria-label="Copy thread id"
                  title="Copy thread id"
                  onClick={() => void experimental_copyToClipboard({ text: n.threadId! }).then((ok) => ok && toast.success("Thread id copied"))}
                >
                  <Ic name="Copy" size="sm" />
                </button>
              </>
            ) : (
              <span className="muted">no thread yet</span>
            )}
          </dd>
        </dl>
      </Sec>

      {isOrch(n) ? <WorldSection n={n} /> : null}
      {n.role === "mgr" ? <AppsInGroup managerId={n.id} /> : null}

      <WhoSees n={n} />

      {kids.length ? (
        <Sec title={n.role === "lead" || n.alsoLead ? "Reports to this lead" : n.role === "mgr" ? "Leads" : n.role === "orch" ? "Reports" : "Children"}>
          <div className="kidlist">
            {kids.map((c) => (
              <button key={c.id} type="button" className="kidrow" onClick={() => h.select(c.id)}>
                <Dot status={c.status} touched={c.touched} title={statusLabel(c.status)} />
                <span className="n trunc">{trailLabel(c, s.apps)}</span>
                <span className="muted trunc" style={{ fontSize: 11, maxWidth: 150 }}>
                  {c.model ? `${findModel(h.catalog, c.model)?.name ?? c.model.modelId} · ${reasonLabel(c.model.reasoning)}` : "model not set"}
                </span>
                <StatusPill status={c.status} />
              </button>
            ))}
          </div>
        </Sec>
      ) : null}

      {findings.length ? (
        <Sec title={`Open findings · ${findings.length}`} right={<button type="button" className="btn sm ghost" onClick={() => h.setTab("reports")}>Reports</button>}>
          <div className="col" style={{ gap: 6 }}>
            {findings.slice(0, 6).map((f) => (
              <div key={f.id} className={cx("finding", `sev-${f.severity}`)}>
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  <span className={cx("pill", f.severity === "blocker" ? "crit" : f.severity === "major" ? "warn" : "")}>{f.severity}</span>
                  <span className="pill mono">{f.rule}</span>
                  <span className="mono muted trunc" style={{ fontSize: 11 }}>
                    {f.path}:{f.line}
                  </span>
                </div>
                <div>{f.why}</div>
              </div>
            ))}
          </div>
        </Sec>
      ) : null}

      <Sec title="Actions">
        <div className="actions">
          <button type="button" className="btn sm" onClick={() => h.select(n.id, { tab: "direct", dtype: "tell" })}>
            <Ic name="MessageSquare" size="sm" /> Tell
          </button>
          <button type="button" className="btn sm" onClick={() => h.select(n.id, { tab: "direct", dtype: "model" })}>
            <Ic name="Brain" size="sm" /> Change model
          </button>
          {allowed.includes("spawn") ? (
            <button type="button" className="btn sm" onClick={() => void quick("spawn")}>
              <Ic name="Play" size="sm" /> Spawn now
            </button>
          ) : null}
          {allowed.includes("pause") ? (
            <button type="button" className="btn sm" onClick={() => void quick("pause")}>
              <Ic name="Pause" size="sm" /> Pause
            </button>
          ) : null}
          {allowed.includes("resume") ? (
            <button type="button" className="btn sm" onClick={() => void quick("resume")}>
              <Ic name="Play" size="sm" /> Resume
            </button>
          ) : null}
          {allowed.includes("retry") ? (
            <button type="button" className="btn sm" onClick={() => void quick("retry")}>
              <Ic name="RotateCcw" size="sm" /> Retry
            </button>
          ) : null}
          {allowed.includes("stop") && !isOrch(n) ? (
            <button type="button" className="btn sm danger" onClick={() => void quick("stop")}>
              <Ic name="Square" size="sm" /> Stop
            </button>
          ) : null}
          {n.appId && n.role !== "orch" ? (
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                h.setDrill(n.appId);
                h.setView("graph");
              }}
            >
              <Ic name="Workflow" size="sm" /> Open squad
            </button>
          ) : null}
          {n.threadId ? (
            <button type="button" className="btn sm" onClick={() => nav.toThread(n.threadId!, { split: true })}>
              <Ic name="ExternalLink" size="sm" /> Open thread in BB
            </button>
          ) : null}
        </div>
      </Sec>

      <Sec title="Recent events">
        {detail ? (
          detail.events.length ? (
            <div className="tl-list">
              {detail.events.slice(0, 8).map((e) => (
                <div key={e.id} className="tl-item">
                  <span className="tm">{clockOf(e.ts)}</span>
                  <span className="ev">
                    <span className="faint">{e.kind} · </span>
                    {e.summary}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="muted">No events recorded yet.</div>
          )
        ) : (
          <div className="muted">Loading…</div>
        )}
      </Sec>
    </>
  );
}

function WhoSees({ n }: { n: SnapNode }) {
  const h = useHelm();
  const s = h.data!;
  const chain = notifyChain(s, n.id);
  if (!chain.length)
    return (
      <Sec title="Who sees changes to this agent">
        <Banner tone="human" icon="UserRound">
          This is the top of the tree. Anything you change anywhere is recorded here first — in the Orchestrator’s world state — so it can answer for the whole portfolio.
        </Banner>
      </Sec>
    );
  return (
    <Sec title="Who sees changes to this agent">
      <div className="chain">
        <div className="lk">
          <span className="tile you">
            <Ic name="UserRound" />
          </span>
          <div className="who">
            <b>You</b> change <b>{trailLabel(n, s.apps)}</b>
          </div>
        </div>
        <div className="lk">
          <span className="tile">
            <Ic name={roleIcon(n)} />
          </span>
          <div className="who">
            <b>{trailLabel(n, s.apps)}</b> <span className="muted">· told directly, must acknowledge</span>
          </div>
          <LevelChip level="direct" world={false} />
        </div>
        {chain.map((c) => {
          const x = s.nodes[c.id];
          if (!x) return null;
          const tier = x.tier === "orchestrator" || x.tier === "manager" || x.tier === "lead";
          return (
            <div key={c.id} className="lk">
              <span className={cx("tile", tier && "tier")}>
                <Ic name={roleIcon(x)} />
              </span>
              <div className="who">
                <button type="button" onClick={() => h.select(c.id)} style={{ fontWeight: 650, textAlign: "left" }}>
                  {trailLabel(x, s.apps)}
                </button>
                <span className="muted">
                  {" "}
                  · {c.world ? "always in world state" : c.level === "full" ? "full notice, told it is binding" : "one-line digest"}
                </span>
              </div>
              <LevelChip level={c.level} world={c.world} />
            </div>
          );
        })}
      </div>
      <div className="hint-t" style={{ marginTop: 6 }}>
        Delivered as a message into their thread, with a receipt. They’re told it’s binding: adapt, don’t undo.
      </div>
    </Sec>
  );
}

function AppsInGroup({ managerId }: { managerId: string }) {
  const h = useHelm();
  const s = h.data!;
  const mg = s.managers.find((m) => m.id === managerId);
  if (!mg) return null;
  return (
    <Sec title="Apps in this group">
      <div className="kidlist">
        {mg.appIds.map((id) => {
          const a = s.apps[id];
          if (!a) return null;
          const lead = leadOf(s, id);
          const st = appStatus(a, appMembers(s, id));
          return (
            <button key={id} type="button" className="kidrow" onClick={() => lead && h.select(lead.id)}>
              <Dot status={st} title={statusLabel(st)} />
              <span className="n trunc">{a.name}</span>
              <StagePill stage={a.stage} />
              <span className="muted" style={{ fontSize: 11 }}>
                lead {lead ? statusLabel(lead.status).toLowerCase() : "—"}
              </span>
              <span className="mono muted" style={{ fontSize: 11, width: 34, textAlign: "right" }}>
                {a.pct}%
              </span>
            </button>
          );
        })}
      </div>
    </Sec>
  );
}

const ASKS: Array<[string, string]> = [
  ["What did I change today?", "What did I change today?"],
  ["What is blocking progress?", "What’s blocking progress?"],
  ["How is spend tracking?", "How’s spend tracking?"],
];

function WorldSection({ n }: { n: SnapNode }) {
  const h = useHelm();
  const sdk = useSdk();
  const s = h.data!;
  const [w, setW] = useState<WorldState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!h.runId) return;
    let live = true;
    const t = setTimeout(() => {
      h.rpc.call("world_get", { runId: h.runId! }).then(
        (x: WorldState) => {
          if (!live) return;
          setW(x);
          setErr(null);
        },
        (e: unknown) => live && setErr(errMsg(e)),
      );
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [h.runId, h.rpc, h.rev]);

  const ask = async (q: string) => {
    if (!n.threadId) {
      toast.error("The Orchestrator has no thread yet", { description: "Start the run first; questions go into its BB thread." });
      return;
    }
    if (!isQuestion(q)) return;
    try {
      await sendThreadText(sdk, n.threadId, q);
      toast.success("Asked the Orchestrator", { description: "It answers from world state in its thread." });
      h.setTab("chat");
    } catch (e) {
      toast.error("Could not send the question", { description: errMsg(e) });
    }
  };

  const st = w?.stages ?? {};
  const policies = s.policies.filter((p) => !p.retiredAt);
  return (
    <>
      <Sec title="State of the world">
        {err && !w ? <Banner tone="crit">Could not read world state: {err}</Banner> : null}
        {w ? (
          <div className="world">
            <div className="wcell">
              <b>{st.build ?? 0} building</b>
              <span>
                {(st.review ?? 0) + (st.slop ?? 0)} in gates · {st.fix ?? 0} fixing · {st.ready ?? 0} ready · {st.done ?? 0} done
                {st.spec || st.intake ? ` · ${st.spec ?? 0} spec · ${st.intake ?? 0} intake` : ""}
              </span>
            </div>
            <div className="wcell">
              <b>
                {w.run.agents.spawned} / {w.run.agents.cap} agents
              </b>
              <span>
                {w.run.agents.running} running · {w.run.agents.queued} queued · {w.run.agents.planned} planned
              </span>
            </div>
            <div className="wcell" title="Relative units, not real prices">
              <b>{fmtUnits(w.run.spend.units)}</b>
              <span>
                spent · forecast {fmtUnits(w.run.spend.forecast)} · cap {fmtUnits(w.run.spend.cap)}
              </span>
            </div>
            <div className="wcell">
              <b>{w.needs.length} need you</b>
              <span>{plural(w.touched.count, "agent")} changed by you</span>
            </div>
          </div>
        ) : !err ? (
          <div className="muted">Reading world state…</div>
        ) : null}
        {w?.run.spawnsPaused ? (
          <Banner tone="warn" style={{ marginTop: 10 }}>
            Spawns are paused — running agents finish their turn; nothing new starts.
          </Banner>
        ) : null}
        <div className="hint-t" style={{ marginTop: 10 }}>
          Built from the database on every question, so it is never out of date. Every change you make anywhere lands here first.
        </div>
        <div style={{ marginTop: 12 }}>
          <div className="lbl" style={{ marginBottom: 6 }}>
            Ask the Orchestrator
          </div>
          <div className="askrow">
            {ASKS.map(([q, l]) => (
              <button key={q} type="button" disabled={!n.threadId} title={n.threadId ? "Sent as a plain question into its thread — not a directive" : "The Orchestrator has no thread yet"} onClick={() => void ask(q)}>
                {l}
              </button>
            ))}
          </div>
        </div>
      </Sec>
      <Sec title={`Standing policies · ${policies.length}`}>
        {policies.length ? (
          <div className="col" style={{ gap: 8 }}>
            {policies.map((p) => (
              <div key={p.id} className="row" style={{ alignItems: "flex-start", gap: 9 }}>
                <Ic name="Layers" size="sm" />
                <div className="grow">
                  <div style={{ fontSize: 12.5 }}>{p.text}</div>
                  <div className="faint" style={{ fontSize: 11 }}>
                    {p.id} · {trailLabel(s.nodes[p.scopeNodeId], s.apps) || p.scopeNodeId}
                    {p.fromDirective ? ` · from ${p.fromDirective}` : ""} · injected into every new spawn
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="muted">No standing policies. Tick “Make it a standing policy” on a directive to add one.</div>
        )}
      </Sec>
    </>
  );
}

