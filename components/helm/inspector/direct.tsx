// Inspector → Direct: choose a change, who it applies to, preview the exact
// notice every recipient will receive (server-rendered), then send it.
import { useEffect, useMemo, useRef, useState } from "react";
import type { DirectiveInfo, DirectivePreview, DirectiveType, ModelRef, Priority, SnapNode } from "../types.ts";
import { SELF_ONLY, TYPE_ICON, TYPE_LABEL, ZERO_TOLERANCE, allowedTypes, errMsg, fmtUnits, plural, reasonLabel, sameRef, statusLabel, trailLabel } from "../format.ts";
import { descendantsOf } from "../store.ts";
import { useHelm } from "../ctx.tsx";
import { Banner, Ic, LevelChip, ModelChip, ReceiptChip, Seg, cx } from "../ui.tsx";
import { ModelPicker } from "../picker.tsx";
import { useSendDirective } from "./shared.tsx";

const ORDER: DirectiveType[] = ["tell", "model", "scope", "priority", "pause", "resume", "stop", "retry", "spawn", "waive"];
const DLABEL: Partial<Record<DirectiveType, string>> = { tell: "Message", model: "Model", scope: "Role / scope", priority: "Priority", waive: "Waive finding", spawn: "Spawn now" };
type CascadeId = "self" | "reports" | "subtree";
/** draftType requests already honoured, so a stale request doesn't re-apply on a later mount */
let consumedKey = 0;

export function DirectTab({ n }: { n: SnapNode }) {
  const h = useHelm();
  const s = h.data!;
  const send = useSendDirective();
  const allowed = allowedTypes(n, s.run.status);
  const [type, setType] = useState<DirectiveType>(() => {
    const req = h.draftType;
    if (!req || req.key <= consumedKey) return "tell";
    consumedKey = req.key;
    return allowed.includes(req.type) ? req.type : "tell";
  });
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"steer" | "queue">("steer");
  const [cascade, setCascade] = useState<CascadeId>("self");
  const [policy, setPolicy] = useState(false);
  const [model, setModel] = useState<ModelRef | null>(n.model);
  const [priority, setPriority] = useState<Priority>(n.priority === "high" ? "normal" : "high");
  const [globs, setGlobs] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [rotated, setRotated] = useState(false);
  const [preview, setPreview] = useState<DirectivePreview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<DirectiveInfo | null>(null);

  // follow "Tell" / "Change model" / "Waive…" requests from elsewhere
  const lastKey = useRef(h.draftType?.key ?? 0);
  useEffect(() => {
    if (!h.draftType || h.draftType.key === lastKey.current) return;
    lastKey.current = h.draftType.key;
    consumedKey = Math.max(consumedKey, h.draftType.key);
    if (allowedTypes(n, s.run.status).includes(h.draftType.type)) setType(h.draftType.type);
  }, [h.draftType, n]);
  useEffect(() => {
    if (!allowed.includes(type)) setType("tell");
  }, [allowed.join(","), type]); // eslint-disable-line react-hooks/exhaustive-deps

  const kids = s.children[n.id] ?? [];
  const below = useMemo(() => descendantsOf(s, n.id), [s, n.id]);
  const liveBelow = below.filter((id) => s.nodes[id] && s.nodes[id].status !== "planned").length;
  const selfOnly = SELF_ONLY.includes(type);
  const showCascade = !selfOnly && (kids.length > 0 || n.role === "orch");
  const effCascade: CascadeId = showCascade ? cascade : "self";

  const findings = n.appId ? s.findings.filter((f) => f.appId === n.appId && f.status === "open") : [];
  const pickedFindings = findings.filter((f) => picked.has(f.id));
  const needsLong = pickedFindings.some((f) => ZERO_TOLERANCE.includes(f.rule));
  const needsRotated = pickedFindings.some((f) => f.rule === "S6");

  const value: unknown = type === "priority" ? priority : type === "scope" && globs.trim() ? { scopeGlobs: globs.split(/[\s,]+/).filter(Boolean) } : undefined;
  const modelTo = type === "model" ? model : null;

  const problem = ((): string | null => {
    const t = text.trim();
    if (type === "tell" || type === "scope") return t ? null : "Write something first";
    if (type === "model") return !model ? "Pick a model" : sameRef(model, n.model) ? "Pick a different model or reasoning level" : null;
    if (type === "priority") return priority === n.priority ? "Pick a different priority" : null;
    if (type === "waive") {
      if (!pickedFindings.length) return "Choose the findings to waive";
      if (!t) return "Write why it’s acceptable";
      if (needsLong && t.length < 20) return "Zero-tolerance findings need a reason of at least 20 characters";
      if (needsRotated && !rotated && !/rotated/i.test(t)) return "Confirm the credential was rotated";
      return null;
    }
    return null;
  })();
  const valid = !problem;

  // live preview — the exact notice per recipient, rendered by the server
  const pkey = JSON.stringify([type, effCascade, text, value, modelTo]);
  useEffect(() => {
    if (!h.runId) return;
    let live = true;
    const t = setTimeout(() => {
      h.rpc.call("directive_previewNotices", { runId: h.runId!, type, target: n.id, cascade: effCascade, text, value, modelTo }).then(
        (p: DirectivePreview) => {
          if (!live) return;
          setPreview(p);
          setPreviewErr(null);
        },
        (e: unknown) => live && setPreviewErr(errMsg(e)),
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [pkey, h.runId, h.rpc, n.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (!valid || sending) return;
    setSending(true);
    const d = await send({
      type,
      target: n.id,
      cascade: effCascade,
      mode,
      policy: policy || undefined,
      text: text.trim() || undefined,
      value,
      modelTo: type === "model" ? model : undefined,
      findingIds: type === "waive" ? pickedFindings.map((f) => f.id) : undefined,
      rotatedConfirmed: type === "waive" && needsRotated ? rotated : undefined,
    });
    setSending(false);
    if (d) {
      setSent(d);
      setText("");
      setPolicy(false);
      setPicked(new Set());
    }
  };

  const liveSent = sent ? s.directives.find((d) => d.id === sent.id) ?? sent : null;
  const modeSeg = (
    <div className="field">
      <span className="lbl">Delivery</span>
      <Seg
        label="Delivery"
        value={mode}
        onChange={setMode}
        options={[
          ["steer", "Steer now"],
          ["queue", "Queue for after this turn"],
        ]}
      />
      <span className="hint-t">{mode === "steer" ? "Interrupts the current turn so the change lands immediately." : "Waits for the agent to finish its current work first."}</span>
    </div>
  );

  return (
    <>
      {liveSent ? <SentBox d={liveSent} onClose={() => setSent(null)} /> : null}
      <section className="sec">
        <h4>
          <span>What do you want to change?</span>
        </h4>
        <div className="dtypes" role="group" aria-label="Kind of change">
          {ORDER.filter((t) => t !== "resume" || allowed.includes("resume"))
            .filter((t) => !(t === "pause" && allowed.includes("resume")))
            .filter((t) => t !== "spawn" || allowed.includes("spawn"))
            .filter((t) => t !== "waive" || n.tier === "gate")
            .map((t) => {
              const ok = allowed.includes(t);
              return (
                <button key={t} type="button" className="dtype" aria-pressed={type === t} disabled={!ok} title={ok ? TYPE_LABEL[t] : "Not available for this agent right now"} onClick={() => setType(t)} data-testid={`dtype-${t}`}>
                  <Ic name={TYPE_ICON[t]} />
                  {DLABEL[t] ?? TYPE_LABEL[t]}
                </button>
              );
            })}
        </div>
      </section>

      <section className="sec">
        {type === "tell" ? (
          <div className="col" style={{ gap: 12 }}>
            <div className="field">
              <label className="lbl" htmlFor="dText">
                Message to {trailLabel(n, s.apps)}
              </label>
              <textarea id="dText" className="textarea" placeholder="e.g. Use warmer colors in dark mode — no pure black." value={text} onChange={(e) => setText(e.target.value)} />
            </div>
            {modeSeg}
          </div>
        ) : null}
        {type === "model" ? (
          <div className="col" style={{ gap: 12 }}>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <span className="lbl">Current</span>
              <ModelChip model={n.model} catalog={h.catalog} />
              <span className="faint">→</span>
              <span className="lbl">New</span>
              <ModelChip model={model} catalog={h.catalog} />
            </div>
            <ModelPicker catalog={h.catalog} value={model} onChange={setModel} label="Reasoning" />
            <Banner tone="info" icon="Brain">
              {model && n.model && model.providerId !== n.model.providerId ? (
                <>Another provider: a <b>new thread</b> on it takes over in the same workspace, starting from the agent’s brief; the old thread is stopped.</>
              ) : (
                <>Takes effect on the agent’s <b>next turn</b>; no restart and nothing is lost.</>
              )}{" "}
              The change is stored as a per-agent override, so slot changes in Model Studio won’t overwrite it.
            </Banner>
          </div>
        ) : null}
        {type === "scope" ? (
          <div className="col" style={{ gap: 12 }}>
            <div className="field">
              <label className="lbl" htmlFor="dText">
                New role, scope or acceptance criteria
              </label>
              <textarea id="dText" className="textarea" style={{ minHeight: 110 }} placeholder="e.g. Also own accessibility: VoiceOver labels on every control; Dynamic Type up to XXL." value={text} onChange={(e) => setText(e.target.value)} />
              <span className="hint-t">Saved as brief v{n.briefVersion + 1}. The agent re-reads BRIEF.md and stays inside the new scope.</span>
            </div>
            <div className="field">
              <label className="lbl" htmlFor="dGlobs">
                Write scope (optional)
              </label>
              <input id="dGlobs" className="input mono" placeholder={n.scopeGlobs?.length ? n.scopeGlobs.join(", ") : "e.g. src/ui/**, assets/**"} value={globs} onChange={(e) => setGlobs(e.target.value)} />
              <span className="hint-t">Comma- or space-separated globs. Leave empty to keep the current scope.</span>
            </div>
            {modeSeg}
          </div>
        ) : null}
        {type === "priority" ? (
          <div className="col" style={{ gap: 12 }}>
            <div className="field">
              <span className="lbl">Priority</span>
              <Seg
                label="Priority"
                value={priority}
                onChange={setPriority}
                options={[
                  ["high", "High"],
                  ["normal", "Normal"],
                  ["low", "Low"],
                ]}
              />
              <span className="hint-t">The scheduler serves higher priority first when capacity is tight. Currently {n.priority}.</span>
            </div>
            <div className="field">
              <label className="lbl" htmlFor="dText">
                Why (optional)
              </label>
              <input id="dText" className="input" placeholder="e.g. Launch date moved up" value={text} onChange={(e) => setText(e.target.value)} />
            </div>
          </div>
        ) : null}
        {type === "pause" ? (
          <div className="col" style={{ gap: 12 }}>
            <div className="field">
              <label className="lbl" htmlFor="dText">
                Reason (optional)
              </label>
              <input id="dText" className="input" placeholder="e.g. Waiting on a licensing decision" value={text} onChange={(e) => setText(e.target.value)} />
            </div>
            <Banner tone="info" icon="Pause">
              The agent finishes its current step, then waits. Its worktree and context are kept. Pausing a lead doesn’t pause its builders — use “Everyone below” for that.
            </Banner>
          </div>
        ) : null}
        {type === "resume" ? (
          <Banner tone="info" icon="Play">
            The agent picks up where it stopped, with a note that you released it.
          </Banner>
        ) : null}
        {type === "stop" ? (
          <div className="col" style={{ gap: 12 }}>
            <Banner tone="crit">
              <b>Stops the thread.</b> The worktree stays on disk. Stopping does not cascade — children keep running unless you choose “Everyone below”.
            </Banner>
            <div className="field">
              <label className="lbl" htmlFor="dText">
                Reason (optional)
              </label>
              <input id="dText" className="input" value={text} onChange={(e) => setText(e.target.value)} />
            </div>
          </div>
        ) : null}
        {type === "retry" ? (
          <Banner tone="info" icon="RotateCcw">
            Re-runs the agent’s last turn. If the failure was a provider error, you can change its model first.
          </Banner>
        ) : null}
        {type === "spawn" ? (
          <Banner tone="info" icon="Play">
            Spawns this agent now, ahead of the queue. Anything you changed before it started is injected into its spawn prompt.
          </Banner>
        ) : null}
        {type === "waive" ? (
          <div className="col" style={{ gap: 12 }}>
            <div className="field">
              <span className="lbl">Findings to waive</span>
              {findings.length ? (
                <div className="col" style={{ gap: 6 }}>
                  {findings.map((f) => (
                    <label key={f.id} className={cx("finding", `sev-${f.severity}`, "check")} style={{ flexDirection: "row" }}>
                      <input
                        type="checkbox"
                        checked={picked.has(f.id)}
                        onChange={(e) => {
                          const next = new Set(picked);
                          if (e.target.checked) next.add(f.id);
                          else next.delete(f.id);
                          setPicked(next);
                        }}
                      />
                      <span className="grow">
                        <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                          <span className="pill mono">{f.id}</span>
                          <span className={cx("pill", f.severity === "blocker" ? "crit" : f.severity === "major" ? "warn" : "")}>{f.severity}</span>
                          <span className="pill mono">{f.rule}</span>
                          {ZERO_TOLERANCE.includes(f.rule) ? <span className="pill crit">zero-tolerance</span> : null}
                          <span className="mono muted" style={{ fontSize: 11 }}>
                            {f.path}:{f.line}
                          </span>
                        </span>
                        <span style={{ display: "block", marginTop: 4 }}>{f.why}</span>
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <span className="hint-t">No open findings for this app.</span>
              )}
            </div>
            <div className="field">
              <label className="lbl" htmlFor="dText">
                Why it’s acceptable (required)
              </label>
              <textarea id="dText" className="textarea" placeholder="e.g. The license header on the vendored file is acceptable." value={text} onChange={(e) => setText(e.target.value)} />
              {needsLong ? <span className="hint-t">Zero-tolerance findings need a reason of at least 20 characters ({text.trim().length}/20).</span> : null}
            </div>
            {needsRotated ? (
              <label className="check">
                <input type="checkbox" checked={rotated} onChange={(e) => setRotated(e.target.checked)} />
                <span>
                  <b>I have rotated this credential</b>
                </span>
              </label>
            ) : null}
            <Banner tone="warn" icon="SecurityCheck">
              A waiver is recorded with your name and shown to the lead, the manager and the Orchestrator. Zero-tolerance findings (secrets, placeholders on shipped paths, invented dependencies) need a written reason.
            </Banner>
          </div>
        ) : null}
      </section>

      {showCascade ? (
        <section className="sec">
          <h4>
            <span>Who it applies to</span>
          </h4>
          <div className="cards" role="radiogroup" aria-label="Who it applies to">
            <CascadeCard id="self" cur={cascade} set={setCascade} title="Only this agent" desc="Its chain above is told, nobody below changes." />
            <CascadeCard id="reports" cur={cascade} set={setCascade} title={`This agent + its ${plural(kids.length, "direct report")}`} desc="Each of them gets the same directive." />
            <CascadeCard
              id="subtree"
              cur={cascade}
              set={setCascade}
              title={`Everyone below · ${plural(liveBelow, "live agent")}${below.length - liveBelow ? ` + ${below.length - liveBelow} planned` : ""}`}
              desc={`Applies down the whole subtree (${plural(below.length, "node")}).${type === "model" ? " Model changes take effect on each agent’s next turn." : ""}`}
            />
          </div>
        </section>
      ) : null}

      <section className="sec">
        <h4>
          <span>What each person sees</span>
          <span className="r">
            {preview ? `${plural(preview.recipients.length, "recipient")}${preview.affected.length > 1 ? ` · ${plural(preview.affected.length, "agent")} affected` : ""}` : ""}
          </span>
        </h4>
        {previewErr ? <Banner tone="crit">Preview failed: {previewErr}</Banner> : null}
        {preview ? <PreviewBox p={preview} n={n} valid={valid} showAll={showAll} setShowAll={setShowAll} /> : !previewErr ? <div className="muted">Preparing preview…</div> : null}
        {!selfOnly ? (
          <label className="check" style={{ marginTop: 12 }}>
            <input type="checkbox" checked={policy} onChange={(e) => setPolicy(e.target.checked)} />
            <span>
              <b>Make it a standing policy</b>
              <br />
              <span className="hint-t">Inject it into every agent spawned under {trailLabel(n, s.apps)} from now on.</span>
            </span>
          </label>
        ) : null}
      </section>

      <div className="dsend">
        <span className="hint-t grow">{valid ? (preview ? `${type === "tell" ? "Acted on now, without asking anyone. " : ""}${plural(preview.recipients.filter((r) => r.level !== "direct").length, "agent")} up the chain get an FYI` : "") : problem}</span>
        <button type="button" className="btn primary" disabled={!valid || sending} onClick={() => void submit()} data-testid="dsend">
          <Ic name="Sent" size="sm" /> {sending ? "Sending…" : "Send directive"}
        </button>
      </div>
    </>
  );
}

function CascadeCard({ id, cur, set, title, desc }: { id: CascadeId; cur: CascadeId; set: (c: CascadeId) => void; title: string; desc: string }) {
  return (
    <button type="button" className="rcard" role="radio" aria-checked={cur === id} onClick={() => set(id)}>
      <span className="rd" />
      <span>
        <b>{title}</b>
        <span className="d">{desc}</span>
      </span>
    </button>
  );
}

function PreviewBox({ p, n, valid, showAll, setShowAll }: { p: DirectivePreview; n: SnapNode; valid: boolean; showAll: boolean; setShowAll: (v: boolean) => void }) {
  const direct = p.recipients.filter((r) => r.level === "direct");
  const target = direct.find((r) => r.id === n.id) ?? direct[0];
  const others = direct.filter((r) => r !== target);
  const collapse = direct.length > 6 && !showAll;
  const up = p.recipients.filter((r) => r.level !== "direct");
  const rows = [...(target ? [target] : []), ...(collapse ? [] : others), ...up];
  return (
    <div className="preview">
      <div className="ph">
        <span>Preview</span>
        <span className="mono" style={{ letterSpacing: 0, textTransform: "none" }} title="Estimated extra reading for the recipients — relative units, not a price">
          {p.id ? `${p.id} · ` : ""}≈ {fmtUnits(p.units)} of extra reading (estimate)
        </span>
      </div>
      {rows.map((r) => (
        <div key={r.id} className="prow">
          <div className="pw">
            <b>{r.label}</b>
            <LevelChip level={r.level} world={r.world} />
            <span className="faint" style={{ fontSize: 10.5 }}>
              {statusLabel(r.status)}
              {r.hasThread ? "" : " · no thread yet"}
            </span>
          </div>
          <div className="pt">{valid ? r.notice ?? "—" : <span className="faint">Fill in the form above to see the exact notice.</span>}</div>
        </div>
      ))}
      {collapse ? (
        <div className="prow">
          <div className="pw">
            <b>+ {others.length} below</b>
            <span className="lvl">Target</span>
          </div>
          <div className="pt">
            {plural(others.length, "agent")} below get the same directive, each in its own thread with its own receipt.{" "}
            <button type="button" className="link" onClick={() => setShowAll(true)}>
              Show all
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SentBox({ d, onClose }: { d: DirectiveInfo; onClose: () => void }) {
  const h = useHelm();
  const s = h.data!;
  const done = d.recipients.every((r) => r.state === "ack" || r.state === "rec");
  return (
    <section className="sec">
      <div className={cx("banner", done ? "ok" : "human")} style={{ flexDirection: "column", gap: 8 }} role="status">
        <div className="row" style={{ gap: 8, width: "100%" }}>
          <Ic name={done ? "CircleCheck" : "Sent"} />
          <b>
            {d.id} {done ? "delivered and acknowledged" : "on its way"}
          </b>
          <span className="grow" />
          <button type="button" className="btn sm ghost" onClick={() => h.setView("ledger")}>
            Ledger <Ic name="ChevronRight" size="sm" />
          </button>
          <button type="button" className="iconbtn sm" aria-label="Dismiss" onClick={onClose}>
            <Ic name="X" size="sm" />
          </button>
        </div>
        <div className="col" style={{ gap: 5, width: "100%", color: "var(--h-fg-2)" }}>
          {d.recipients.slice(0, 12).map((r) => (
            <div key={r.nodeId} className="row" style={{ justifyContent: "space-between", fontSize: 12, gap: 8 }}>
              <span className="trunc">
                <b>{trailLabel(s.nodes[r.nodeId], s.apps) || r.nodeId}</b> <span className="faint">{r.level === "direct" ? "target" : r.world ? "world state" : r.level}</span>
              </span>
              <ReceiptChip state={r.state} />
            </div>
          ))}
          {d.recipients.length > 12 ? <span className="faint">+ {d.recipients.length - 12} more — see the Ledger</span> : null}
        </div>
        {d.type === "model" && d.modelTo ? (
          <span className="hint-t">
            Model → {d.modelTo.modelId} {reasonLabel(d.modelTo.reasoning)}
          </span>
        ) : null}
      </div>
    </section>
  );
}
