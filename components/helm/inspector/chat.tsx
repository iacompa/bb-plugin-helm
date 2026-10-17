// Inspector → Chat: the agent's real BB thread (ThreadChat, compact). If the
// host component fails, fall back to Helm's own record (events, comms and
// directive notices) with a composer that sends tell directives.
import { Component, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { toast } from "sonner";
import { ThreadChat, useSdk } from "@get-bb/plugin-sdk/app";
import type { NodeDetail, SnapNode } from "../types.ts";
import { TYPE_LABEL, clockOf, errMsg, isQuestion, roleIcon, trailLabel } from "../format.ts";
import { useHelm } from "../ctx.tsx";
import { Banner, Ic, cx } from "../ui.tsx";
import { isOrch, notifyChain, sendThreadText, useSendDirective } from "./shared.tsx";
import { reportClientError } from "../data.ts";

class ChatBoundary extends Component<{ fallback: (err: string) => ReactNode; children: ReactNode }, { err: string | null }> {
  state = { err: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { err: e instanceof Error ? e.message : String(e) };
  }
  componentDidCatch(e: unknown, _info: ErrorInfo) {
    // the fallback renders Helm's own record; the failure goes to the error journal
    reportClientError("warn", "thread chat", e instanceof Error ? e.message : String(e));
  }
  render() {
    return this.state.err ? this.props.fallback(this.state.err) : this.props.children;
  }
}

export function ChatTab({ n, detail }: { n: SnapNode; detail: NodeDetail | null }) {
  if (!n.threadId)
    return (
      <div className="chatwrap">
        <div className="sec" style={{ flex: "none" }}>
          <Banner tone="info" icon="Clock">
            This agent has no thread yet — messages are stored and injected into its spawn prompt.
          </Banner>
        </div>
        <FallbackChat n={n} detail={detail} />
      </div>
    );
  return (
    <div className="chatwrap">
      <div className="chatnote">
        <Ic name="UserRound" size="sm" />
        <span>Typing here goes straight into the agent’s thread; Helm records it as an implicit message so the chain is told.</span>
      </div>
      <ChatBoundary
        key={n.threadId}
        fallback={(err) => (
          <>
            <div className="sec" style={{ flex: "none" }}>
              <Banner tone="warn">The BB chat view could not load here ({err}). Showing Helm’s record of this agent instead.</Banner>
            </div>
            <FallbackChat n={n} detail={detail} />
          </>
        )}
      >
        <div className="bbchat">
          <ThreadChat threadId={n.threadId} variant="compact" />
        </div>
      </ChatBoundary>
    </div>
  );
}

type Row = { key: string; ts: number; kind: "sys" | "human" | "agent" | "comm"; text: string; who?: string; badge?: string };

function FallbackChat({ n, detail }: { n: SnapNode; detail: NodeDetail | null }) {
  const h = useHelm();
  const s = h.data!;
  const sdk = useSdk();
  const send = useSendDirective();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const name = (id: string) => (id === "human" || id === "you" ? "You" : id === "helm" ? "Helm" : trailLabel(s.nodes[id], s.apps) || id);

  const rows = useMemo<Row[]>(() => {
    if (!detail) return [];
    const out: Row[] = [];
    for (const e of detail.events) out.push({ key: `e${e.id}`, ts: e.ts, kind: e.kind === "report" || e.kind === "now" ? "agent" : "sys", text: e.summary, badge: e.kind });
    for (const c of detail.comms) {
      if (c.directiveId) continue; // shown with the directive below
      out.push({ key: `c${c.id}`, ts: c.ts, kind: "comm", text: c.summary, who: `${name(c.fromNode)} → ${name(c.toNode)}` });
    }
    for (const d of detail.directives) {
      const mine = d.recipients.find((r) => r.nodeId === n.id);
      out.push({ key: `d${d.id}`, ts: d.ts, kind: d.actor === "human" ? "human" : "sys", text: mine?.notice || d.summary, who: `${d.actor === "human" ? "You" : "Helm"} · ${TYPE_LABEL[d.type] ?? d.type}${d.implicit ? " (typed in the thread)" : ""}`, badge: d.id });
    }
    return out.sort((a, b) => a.ts - b.ts);
  }, [detail, n.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = scroll.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  const chain = notifyChain(s, n.id);
  const seen = chain.length ? chain.map((c) => trailLabel(s.nodes[c.id], s.apps)).join(" · ") : "recorded in the world state";
  const orchQuestion = isOrch(n) && isQuestion(text);

  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      if (isOrch(n) && isQuestion(t)) {
        if (!n.threadId) {
          toast.error("The Orchestrator has no thread yet", { description: "Questions are answered in its thread once the run starts." });
          return;
        }
        await sendThreadText(sdk, n.threadId, t);
        toast.success("Asked the Orchestrator", { description: "Questions are not directives; it answers from world state." });
        setText("");
      } else {
        const d = await send({ type: "tell", target: n.id, text: t, mode: "steer", cascade: "self" });
        if (d) setText("");
      }
    } catch (e) {
      toast.error("Not sent", { description: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };

  const ph = isOrch(n) ? "Ask the Orchestrator anything, or tell it what to change…" : n.status === "planned" ? `Leave a note for ${n.label} — it’s added to the spawn brief` : `Message ${n.label}…`;
  return (
    <>
      <div className="chat" ref={scroll} aria-live="polite">
        {!detail ? <div className="muted">Loading…</div> : null}
        {detail && !rows.length ? <div className="muted">Nothing recorded yet.</div> : null}
        {rows.map((r) =>
          r.kind === "human" || r.kind === "sys" ? (
            <div key={r.key} className={cx("sysnote", r.kind === "human" && "human")}>
              <Ic name={r.kind === "human" ? "UserRound" : "Info"} size="sm" />
              <div className="grow">
                {r.who ? <b>{r.who}: </b> : null}
                {r.text} <span className="faint">{clockOf(r.ts)}</span>
              </div>
            </div>
          ) : (
            <div key={r.key} className="msg">
              <span className="av">
                <Ic name={r.kind === "comm" ? "MessageSquare" : roleIcon(n)} />
              </span>
              <div className="bub">
                <div className="who">
                  <b>{r.who ?? (isOrch(n) ? "Orchestrator" : n.label)}</b>
                  <span className="faint">{clockOf(r.ts)}</span>
                  {r.badge ? <span className="faint">{r.badge}</span> : null}
                </div>
                <div className="txt">{r.text}</div>
              </div>
            </div>
          ),
        )}
      </div>
      <div className="composer">
        <textarea
          placeholder={ph}
          aria-label="Message"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="cmp-foot">
          <div className="notifychips">
            <Ic name="UserRound" size="sm" />
            {orchQuestion ? (
              <span>A question — sent as a plain message, not a directive.</span>
            ) : (
              <span>
                Logged as a directive. Seen by <b style={{ color: "var(--h-fg-2)" }}>{seen}</b>
              </span>
            )}
          </div>
          <button type="button" className="btn primary sm" disabled={!text.trim() || busy} onClick={() => void submit()}>
            <Ic name="Sent" size="sm" /> Send
          </button>
        </div>
      </div>
    </>
  );
}
