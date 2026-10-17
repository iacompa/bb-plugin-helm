// Inspector → quick steer: a one-line composer pinned under every tab, so steering
// an agent is one sentence and Enter. It sends the same "tell" directive as the
// Direct tab; the line under it says exactly who else hears about it.
import { useState, type KeyboardEvent } from "react";
import type { SnapNode } from "../types.ts";
import { plural, trailLabel } from "../format.ts";
import { descendantsOf } from "../store.ts";
import { useHelm } from "../ctx.tsx";
import { Ic } from "../ui.tsx";
import { notifyChain, useSendDirective } from "./shared.tsx";

type Scope = "self" | "reports" | "subtree";

export function QuickSteer({ n }: { n: SnapNode }) {
  const h = useHelm();
  const s = h.data!;
  const send = useSendDirective();
  const [text, setText] = useState("");
  const [later, setLater] = useState(false);
  const [scope, setScope] = useState<Scope>("self");
  const [busy, setBusy] = useState(false);
  if (n.status === "done") return null;

  const kids = s.children[n.id] ?? [];
  const below = kids.length ? descendantsOf(s, n.id).length : 0;
  const chain = notifyChain(s, n.id);
  const parent = chain[0] ? trailLabel(s.nodes[chain[0].id], s.apps) : null;
  const others = Math.max(0, chain.length - 1);
  const told = scope === "self" ? 1 : scope === "reports" ? 1 + kids.length : 1 + below;
  const who = [
    told > 1 ? `${told} agents get it directly` : null,
    parent ? `${parent} gets it in full` : null,
    others ? `${plural(others, "level")} above ${others === 1 ? "sees" : "see"} one FYI line (no extra turn)` : null,
  ].filter(Boolean).join(" · ");

  const go = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    const d = await send({ type: "tell", target: n.id, text: t, mode: later ? "queue" : "steer", cascade: scope });
    setBusy(false);
    if (d) setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void go();
    }
  };
  const idle = !n.threadId || ["idle", "failed"].includes(n.status);

  return (
    <div className="qsteer" data-testid="quick-steer">
      <div className="qs-row">
        <textarea
          className="qs-input"
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder={`Steer ${n.role === "orch" ? "the Orchestrator" : trailLabel(n, s.apps)}… (Enter to send)`}
          aria-label="Steer this agent"
          spellCheck
        />
        <button type="button" className="btn sm primary" disabled={!text.trim() || busy} onClick={() => void go()} title={later ? "Delivered after its current turn" : "Interrupts its current turn"}>
          <Ic name="Sent" size="sm" /> {busy ? "Sending…" : later ? "Queue" : "Steer"}
        </button>
      </div>
      <div className="qs-meta">
        <label className="check" title="Steer interrupts the current turn; queue waits until it ends">
          <input type="checkbox" checked={later} onChange={(e) => setLater(e.target.checked)} /> after its turn
        </label>
        {kids.length ? (
          <select className="select qs-scope" aria-label="Who it applies to" value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
            <option value="self">just this agent</option>
            <option value="reports">+ its {plural(kids.length, "report")}</option>
            <option value="subtree">+ everyone below ({below})</option>
          </select>
        ) : null}
        <span className="qs-who" title="Who hears about this message">
          {idle ? "Not running: it reads this when it next starts. " : ""}
          {who}
        </span>
      </div>
    </div>
  );
}
