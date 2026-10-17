// "Plan with an agent" (New run → step 1): a real BB conversation, embedded with the
// host's ThreadChat, that follows the helm-planner skill — it interviews the human,
// lists the models this machine has for every role, asks where each app lives,
// writes the brief and runs `bb helm plan`. The plan it makes is an ordinary draft
// run; this panel lists it as soon as it appears (helm:runs realtime, never polled).
import { useState } from "react";
import { ThreadChat } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { ModelRef } from "./types.ts";
import { errMsg, plural } from "./format.ts";
import { useHelm } from "./ctx.tsx";
import { Banner, Ic, ModelChip } from "./ui.tsx";
import { ModelPicker } from "./picker.tsx";

export type PlanChatState = { threadId: string; startedAt: number } | null;

export function PlanChat(p: { model: ModelRef | null; setModel: (m: ModelRef) => void; chat: PlanChatState; setChat: (c: PlanChatState) => void; onOpenRun: (runId: string) => void }) {
  const h = useHelm();
  const [idea, setIdea] = useState("");
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const begin = async () => {
    if (!p.model) return;
    setBusy(true);
    setErr(null);
    try {
      const r = (await h.rpc.call("planchat_start", { model: p.model, text: idea.trim() || null })) as { threadId: string };
      p.setChat({ threadId: r.threadId, startedAt: Date.now() - 5_000 });
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  if (!p.chat)
    return (
      <div className="wpad">
        <div className="banner info">
          <Ic name="MessageSquare" />
          <div>
            Plan the build in a conversation. The planner asks what you want to build and where each app lives (an existing repository anywhere on this machine, or a new folder). Then it goes role by role (Orchestrator, Managers, Leads, UI, Code, platform, Security, Test, Reviewer, Slop Hunter, Research, Docs), showing the models <b>your</b> accounts have, with a recommendation for each that you can change. Finally it writes the brief and makes the plan. Nothing spawns until you start the plan.
          </div>
        </div>
        <div className="field">
          <span className="lbl">Planner model</span>
          <div className="row" style={{ gap: 8 }}>
            <ModelChip model={p.model} catalog={h.catalog} big title="The model that runs the planning conversation" />
            <button type="button" className="btn sm" aria-expanded={picking} onClick={() => setPicking((x) => !x)}>
              {picking ? "Done" : "Change"}
            </button>
          </div>
        </div>
        {picking ? <ModelPicker catalog={h.catalog} value={p.model} onChange={p.setModel} /> : null}
        <div className="field">
          <label className="lbl" htmlFor="wzIdea">
            What do you want to build? <span className="faint">(optional — you can also just start talking)</span>
          </label>
          <textarea id="wzIdea" className="textarea" rows={5} spellCheck={false} value={idea} onChange={(e) => setIdea(e.target.value)} placeholder="For example: finish the 3 apps in /Volumes/Work/apps (tide, lumen, sprout). They all use the shared library in /Volumes/Work/core. Use Codex for reviews." />
        </div>
        {err ? <Banner tone="crit">{err}</Banner> : null}
        <div className="row" style={{ gap: 10 }}>
          <button type="button" className="btn primary" disabled={busy || !p.model} onClick={() => void begin()} data-testid="planchat-start">
            <Ic name="Zap" size="sm" /> {busy ? "Starting…" : "Start planning"}
          </button>
          <span className="hint-t">Opens one conversation, “Helm · plan a build”. It also stays in your sidebar, so you can come back to it.</span>
        </div>
      </div>
    );

  const plans = (h.runs ?? []).filter((r) => r.status === "planning" && r.createdAt >= p.chat!.startedAt);
  return (
    <div className="col" style={{ gap: 0, height: "100%" }}>
      {plans.length ? (
        <div className="wpad" style={{ paddingBottom: 8 }}>
          <Banner tone="ok" icon="CircleCheck">
            <div className="col" style={{ gap: 6 }}>
              <b>{plans.length === 1 ? "The planner made a plan." : `The planner made ${plans.length} plans.`}</b>
              {plans.map((r) => (
                <div key={r.id} className="row" style={{ gap: 8, alignItems: "center" }}>
                  <span className="trunc">
                    {r.name} <span className="muted">· {plural(r.apps, "app")}</span> <span className="mono faint">{r.id}</span>
                  </span>
                  <button
                    type="button"
                    className="btn sm primary"
                    onClick={() => {
                      p.onOpenRun(r.id);
                      toast.success("Plan opened", { description: "Review it on the graph. Start it from the run menu when you are ready." });
                    }}
                  >
                    Open plan
                  </button>
                </div>
              ))}
            </div>
          </Banner>
        </div>
      ) : null}
      <div style={{ flex: 1, minHeight: 520, borderTop: "1px solid var(--h-line)" }} data-testid="planchat-thread">
        <ThreadChat threadId={p.chat.threadId} variant="compact" layout="contained" />
      </div>
    </div>
  );
}
