// New-run wizard (§11.10): Brief → Portfolio → Models → Approve. Every step
// previews through plan_preview; nothing is created until "Approve and start".
import { useEffect, useMemo, useRef, useState } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { ModelRef, PlanPreview, PlannedApp, Portfolio, Shape, SlotId, SlotMap } from "./types.ts";
import { PLAT, SEED_PRESETS, SLOT_DEFS, clamp, errMsg, familyWarnings, fmtUnits, plural } from "./format.ts";
import { useHelm } from "./ctx.tsx";
import { Banner, Ic, Modal, ModelChip, askConfirm, cx } from "./ui.tsx";
import { StudioPanel } from "./studio.tsx";
import { ModelPicker } from "./picker.tsx";
import { PlanChat, type PlanChatState } from "./planchat.tsx";
import { clearStored, lsSet, readStored, useStored } from "./persist.ts";

/** A planner session (§7.7) as planner_get returns it. */
type PlannerState = { id: string; status: "spawning" | "running" | "done" | "failed"; error: string | null; portfolio: Portfolio | null };

const MAX_AGENTS = 250;
const STEPS = ["Brief", "Portfolio", "Models", "Approve"] as const;

export const EXAMPLES: Array<{ title: string; text: string }> = [
  {
    title: "A small wellness portfolio",
    text: `Build these three apps in parallel. Each gets its own repository and a lead developer. I want an independent review and an AI-slop check on every app before I see it.

# Wellness
- Lumen — a calm sleep and wind-down tracker with a nightly routine · iOS Android
- Tide — guided breathing sessions with haptic pacing · iOS
- Sprout — habit streaks for small daily wins, shared with one friend · iOS Android`,
  },
  {
    title: "One macOS utility",
    text: `# Utilities
- Tally — a menu-bar time tracker that groups time by project and exports a weekly CSV · macOS

Keep it native and small. No accounts, no cloud sync; data stays in a local SQLite file.`,
  },
];

const PLACEHOLDER = `Describe what you want to build, in your own words. Structured lines are read exactly:

# Group
- Name — tagline · iOS Android macOS Windows
- Name — tagline · macOS · /path/to/existing/repo · reads /path/to/shared/code`;

type Limits = { managerSpan: number; orchestratorSpan: number; concurrency: number; budgetCap: number };

function squadHas(a: PlannedApp, role: string): boolean {
  return (a.squad as unknown as Array<string | { role: string }>).some((m) => (typeof m === "string" ? m === role || m.endsWith(`.${role}`) : m.role === role));
}

// The wizard's draft (brief, portfolio, models, the planning conversation…) lives in
// localStorage under this prefix, so leaving the panel or opening Helm in another
// window resumes where you were. It is cleared when a run starts or you discard it.
const WIZ = "helm:wiz:";
const isObj = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
const orNull = (f: (v: unknown) => boolean) => (v: unknown) => v === null || f(v);

/** Start the next wizard opening from this brief, replacing any saved draft (the first-run examples). */
export function seedWizardBrief(text: string | null) {
  if (text === null) return; // keep the saved draft
  clearStored(WIZ);
  lsSet(`${WIZ}brief`, JSON.stringify(text));
}
/** Open the next wizard in "Plan with an agent" mode; an earlier planning conversation is kept. */
export function seedWizardMode(m: "brief" | "agent") {
  lsSet(`${WIZ}mode`, JSON.stringify(m));
}
/** A run made in the saved planning conversation started: that draft is finished. */
export function planChatRunStarted(runCreatedAt: number) {
  const chat = readStored<{ startedAt?: number } | null>(`${WIZ}chat`, null);
  if (chat && typeof chat.startedAt === "number" && runCreatedAt >= chat.startedAt) clearStored(WIZ);
}
/** Forget the saved draft (after a run starts, or when the human discards it). */
export function clearWizardDraft() {
  clearStored(WIZ);
}

export function WizardModal() {
  const h = useHelm();
  if (!h.wizardOpen) return null;
  return <WizardInner />;
}

function WizardInner() {
  const h = useHelm();
  const [step, setStep] = useStored(`${WIZ}step`, 1, (v) => v === 1 || v === 2 || v === 3 || v === 4);
  const [brief, setBrief] = useStored(`${WIZ}brief`, "");
  const [name, setName] = useStored(`${WIZ}name`, "");
  const [portfolio, setPortfolio] = useStored<Portfolio | null>(`${WIZ}portfolio`, null, orNull((v) => isObj(v) && Array.isArray((v as Portfolio).apps)));
  const seededFrom = useRef<string | null>(readStored<string | null>(`${WIZ}seededFrom`, null, orNull((v) => typeof v === "string")));
  const setSeeded = (b: string) => {
    seededFrom.current = b;
    lsSet(`${WIZ}seededFrom`, JSON.stringify(b));
  };
  const [limits, setLimits] = useStored<Limits>(`${WIZ}limits`, { managerSpan: 4, orchestratorSpan: 6, concurrency: 24, budgetCap: 2500 }, (v) => isObj(v) && typeof (v as Limits).concurrency === "number");
  const [slots, setSlots] = useStored<SlotMap>(`${WIZ}slots`, () => JSON.parse(JSON.stringify(SEED_PRESETS["Studio default"])) as SlotMap);
  const [autoAdvance, setAutoAdvance] = useStored<"ask" | "auto">(`${WIZ}autoAdvance`, "ask", (v) => v === "ask" || v === "auto");
  const [dryRun, setDryRun] = useStored(`${WIZ}dryRun`, false);
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const body = useRef<HTMLDivElement>(null);
  // step 1 has two ways in: write a brief, or plan it in a conversation with the helm-planner agent
  const [mode, setMode] = useStored<"brief" | "agent">(`${WIZ}mode`, "brief", (v) => v === "brief" || v === "agent");
  const [chat, setChat] = useStored<PlanChatState>(`${WIZ}chat`, null, orNull((v) => isObj(v) && typeof (v as { threadId?: unknown }).threadId === "string" && typeof (v as { startedAt?: unknown }).startedAt === "number"));
  const [appsRoot, setAppsRoot] = useStored(`${WIZ}appsRoot`, "");

  // §7.7: a free-text brief is read by one short planner thread on a model the human chooses
  const [plannerModel, setPlannerModel] = useStored<ModelRef | null>(`${WIZ}plannerModel`, null, orNull((v) => isObj(v) && typeof (v as ModelRef).modelId === "string"));
  const plannerRef: ModelRef | null = plannerModel ?? (slots.code ? { ...slots.code, reasoning: "medium" } : null);
  const [pl, setPl] = useStored<PlannerState | null>(`${WIZ}planner`, null, orNull((v) => isObj(v) && typeof (v as PlannerState).id === "string"));
  const [plFor, setPlFor] = useStored<string | null>(`${WIZ}plannerFor`, null, orNull((v) => typeof v === "string"));
  const [plBrief, setPlBrief] = useStored(`${WIZ}plannerBrief`, "");
  const adoptPlanner = (s: PlannerState, forBrief = plBrief) => {
    setPl(s);
    if (s.status === "done" && s.portfolio) {
      setPortfolio(s.portfolio);
      setSeeded(forBrief);
      setPlFor(forBrief);
    }
  };
  // a planner that was still reading when the panel closed: ask where it got to
  useEffect(() => {
    if (pl?.id && (pl.status === "spawning" || pl.status === "running")) h.rpc.call("planner_get", { id: pl.id }).then((s: PlannerState) => adoptPlanner(s), () => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useRealtime("helm:planner", (msg: unknown) => {
    const id = (msg as { id?: string } | null)?.id;
    if (!pl || id !== pl.id) return;
    h.rpc.call("planner_get", { id }).then((s: PlannerState) => adoptPlanner(s), () => {});
  });
  const startPlanner = () => {
    if (!plannerRef) return;
    setPlBrief(brief);
    setPl({ id: "", status: "spawning", error: null, portfolio: null });
    h.rpc.call("planner_start", { brief, model: plannerRef }).then(
      (s: PlannerState) => adoptPlanner(s, brief),
      (e: unknown) => setPl({ id: "", status: "failed", error: errMsg(e), portfolio: null }),
    );
  };

  // debounced plan_preview: by brief on step 1 (or the planner's portfolio for this brief), by the edited portfolio afterwards
  const reqId = useRef(0);
  useEffect(() => {
    const id = ++reqId.current;
    const usePortfolio = portfolio && (step >= 2 || plFor === brief);
    if (!usePortfolio && !brief.trim()) {
      setPreview(null);
      setPreviewErr(null);
      return;
    }
    setPreviewing(true);
    const t = setTimeout(() => {
      const input = usePortfolio
        ? { brief, portfolio: portfolio as never, slots: slots as Record<string, ModelRef>, limits }
        : { brief, slots: slots as Record<string, ModelRef>, limits };
      h.rpc.call("plan_preview", input).then(
        (p: PlanPreview) => {
          if (id !== reqId.current) return;
          setPreview(p);
          setPreviewErr(null);
          setPreviewing(false);
        },
        (e: unknown) => {
          if (id !== reqId.current) return;
          setPreviewErr(errMsg(e));
          setPreviewing(false);
        },
      );
    }, 400);
    return () => clearTimeout(t);
  }, [h.rpc, step, brief, portfolio, slots, limits, plFor]);

  const plan = preview?.plan ?? null;
  const appsFound = preview?.portfolio?.apps?.length ?? 0;
  const required: SlotId[] = preview?.required ?? [];
  const unset = required.filter((id) => !slots[id]);
  const fam = familyWarnings(h.catalog, slots);
  const noModels = !!h.catalog && (!h.catalog.models.length || !h.catalog.providers.some((p) => p.available));

  // closing keeps the draft (New run reopens it); Discard is the explicit way to throw it away
  const close = () => {
    if (brief.trim() || chat) toast("Your draft is kept", { description: "New run opens it where you left off." });
    h.setWizardOpen(false);
  };
  const discard = async () => {
    if ((brief.trim() || chat || step > 1) && !(await askConfirm({ title: "Discard this draft?", body: chat ? "The brief and choices are cleared. The planning conversation stays in your sidebar (“Helm · plan a build”), and any plan it made stays in the run menu." : "The brief and every choice in this wizard are cleared.", ok: "Discard", danger: true }))) return;
    clearWizardDraft();
    h.setWizardOpen(false);
  };
  // opening a plan keeps the conversation (New run comes back to it); starting that plan clears it
  const openRun = (runId: string) => {
    h.refreshRuns();
    h.setRunId(runId);
    h.setView("graph");
    h.setWizardOpen(false);
  };

  const go = (n: number) => {
    if (n >= 2 && step === 1 && preview && seededFrom.current !== brief) {
      setPortfolio(preview.portfolio);
      setSeeded(brief);
    }
    setStep(n);
    body.current?.scrollTo?.({ top: 0 });
  };

  const editApp = (appName: string, patch: Partial<Portfolio["apps"][number]> | null) => {
    if (!portfolio) return;
    const apps = patch === null ? portfolio.apps.filter((a) => a.name !== appName) : portfolio.apps.map((a) => (a.name === appName ? { ...a, ...patch } : a));
    setPortfolio({ ...portfolio, apps });
  };

  const blocked =
    busy ||
    (step === 1 ? !appsFound || previewing : step === 2 ? !plan || !plan.ok || !plan.apps.length || (plan.counts.total > MAX_AGENTS) || previewing : step === 3 ? unset.length > 0 : unset.length > 0 || !plan?.ok);
  const why =
    step === 1 && !appsFound && brief.trim() && !previewing
      ? "No apps found yet"
      : step === 2 && plan && !plan.ok
        ? "Fix the plan first"
        : step === 2 && plan && plan.counts.total > MAX_AGENTS
          ? `Over the ${MAX_AGENTS}-agent cap`
          : step >= 3 && unset.length
            ? `${plural(unset.length, "slot")} still need a model`
            : "";

  const start = async () => {
    if (!plan || !preview) return;
    setBusy(true);
    setErr(null);
    setProblems([]);
    try {
      const v = (await h.rpc.call("models_validate", { slots: slots as Record<string, ModelRef> })) as { problems: Array<{ slot: string; message: string }> };
      if (v.problems?.length) {
        setProblems(v.problems.map((p) => `${SLOT_DEFS.find((s) => s.id === p.slot)?.name ?? p.slot}: ${p.message}`));
        setBusy(false);
        return;
      }
      const created = (await h.rpc.call("run_create", {
        brief,
        portfolio: (portfolio ?? preview.portfolio) as never,
        name: name.trim() || undefined,
        slots: slots as Record<string, ModelRef>,
        limits,
        autoAdvance,
        ...(appsRoot.trim() ? { appsRoot: appsRoot.trim() } : {}),
      })) as { runId: string; problems?: string[] };
      h.refreshRuns();
      if (created.problems?.length) {
        setProblems(created.problems);
        h.setRunId(created.runId);
        setErr("The run was created but not started (it is in planning). Fix what is listed (models in Model Studio; folders by going back to Portfolio and creating the run again), then start it.");
        setBusy(false);
        return;
      }
      await h.rpc.call("run_setSlots", { runId: created.runId, slots: slots as Record<string, ModelRef> });
      await h.rpc.call("run_start", { runId: created.runId, dryRun });
      h.refreshRuns();
      h.setRunId(created.runId);
      clearWizardDraft();
      h.setWizardOpen(false);
      toast.success(dryRun ? "Plan created (dry run)" : "Run started", {
        description: dryRun ? "Projects and briefs were written; nothing was spawned." : `${plural(plan.apps.length, "app")} · the Orchestrator is starting${plan.managers.length ? ` with ${plural(plan.managers.length, "manager")}` : ""}.`,
      });
    } catch (e) {
      setErr(errMsg(e));
      setBusy(false);
    }
  };

  return (
    <Modal label="New run" cls="lg" onClose={close}>
      <div className="wiz">
        <div className="mhead">
          <span className="tile lg tier">
            <Ic name="Workflow" />
          </span>
          <div className="grow">
            <h3>New run</h3>
            <div className="muted" style={{ fontSize: 12 }}>
              Nothing is spawned until you approve the plan on the last step.
            </div>
          </div>
          <button type="button" className="iconbtn" onClick={close} aria-label="Close (the draft is kept)">
            <Ic name="X" />
          </button>
        </div>
        <ol className="steps" aria-label="Steps" style={{ listStyle: "none", margin: 0 }}>
          {STEPS.map((s, i) => (
            <li key={s} className={cx("stp", step === i + 1 && "on", step > i + 1 && "done")} aria-current={step === i + 1 ? "step" : undefined}>
              <span className="nb">{step > i + 1 ? <Ic name="Check" size="sm" /> : i + 1}</span>
              {s}
            </li>
          ))}
        </ol>
        <div className="wbody" ref={body}>
          {noModels || h.catalogError ? (
            <div style={{ padding: "14px 22px 0" }}>
              <Banner tone="crit">
                <b>No provider or model is available on this machine.</b> Helm reads models live from BB’s providers. Set one up in BB’s Settings → Providers, then come back — you can still write the brief meanwhile.
              </Banner>
            </div>
          ) : null}
          {step === 1 ? (
            <div className="wpad" style={{ paddingBottom: 0 }}>
              <span className="shapechip" role="group" aria-label="How to plan">
                <button type="button" aria-pressed={mode === "brief"} onClick={() => setMode("brief")} data-testid="mode-brief">
                  Write a brief
                </button>
                <button type="button" aria-pressed={mode === "agent"} onClick={() => setMode("agent")} data-testid="mode-agent">
                  Plan with an agent
                </button>
              </span>
            </div>
          ) : null}
          {step === 1 && mode === "agent" ? (
            <PlanChat model={plannerRef} setModel={setPlannerModel} chat={chat} setChat={setChat} onOpenRun={openRun} />
          ) : step === 1 ? (
            <StepBrief brief={brief} setBrief={setBrief} name={name} setName={setName} slots={slots} preview={preview} previewing={previewing} previewErr={previewErr} appsFound={appsFound} plannerModel={plannerRef} setPlannerModel={setPlannerModel} planner={pl} plannerRead={plFor === brief} startPlanner={startPlanner} />
          ) : step === 2 ? (
            <StepPortfolio plan={plan} preview={preview} previewErr={previewErr} limits={limits} setLimits={setLimits} editApp={editApp} appsRoot={appsRoot} setAppsRoot={setAppsRoot} />
          ) : step === 3 ? (
            <div className="col">
              <div className="wpad" style={{ paddingBottom: 0 }}>
                <div className="banner info">
                  <Ic name="Brain" />
                  <div>
                    <b>Which models should this run use?</b> Models change fast, so Helm asks every time and reads the list from your machine. “Studio default” is pre-filled; the rest need a choice.
                    {unset.length ? (
                      <>
                        {" "}
                        <b>
                          Still unset: {unset.map((id) => SLOT_DEFS.find((s) => s.id === id)?.name ?? id).join(", ")}.
                        </b>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
              <div style={{ height: 560, marginTop: 12, borderTop: "1px solid var(--h-line)" }}>
                <StudioPanel slots={slots} onChange={setSlots} mode="wizard" bySlot={plan?.counts.bySlot} required={required} />
              </div>
            </div>
          ) : (
            <StepApprove
              plan={plan}
              preview={preview}
              unset={unset}
              fam={fam}
              limits={limits}
              setLimits={setLimits}
              autoAdvance={autoAdvance}
              setAutoAdvance={setAutoAdvance}
              dryRun={dryRun}
              setDryRun={setDryRun}
              problems={problems}
              err={err}
            />
          )}
        </div>
        <div className="mfoot">
          {step > 1 ? (
            <button type="button" className="btn" onClick={() => go(step - 1)} disabled={busy}>
              Back
            </button>
          ) : null}
          <span className="grow" />
          <span className="hint-t">{step === 1 && mode === "agent" ? (chat ? "Open the plan when the planner has made it." : "") : previewing ? "Reading…" : why}</span>
          <button type="button" className="btn ghost" onClick={() => void discard()} disabled={busy} title="Clear this draft and close">
            Discard
          </button>
          <button type="button" className="btn" onClick={close} disabled={busy} title="Close; New run reopens this draft">
            Close
          </button>
          {(step === 1 || step === 2) && !(step === 1 && mode === "agent") && !blocked && !unset.length && preview ? (
            <button type="button" className="btn" onClick={() => go(4)} title="Every role already has a model: go straight to the summary">
              Skip to review
            </button>
          ) : null}
          {step === 1 && mode === "agent" ? null : step < 4 ? (
            <button type="button" className="btn primary" disabled={blocked} onClick={() => go(step + 1)}>
              {["Read my brief", "Choose models", "Review and approve"][step - 1]} <Ic name="ChevronRight" size="sm" />
            </button>
          ) : (
            <button type="button" className="btn primary" disabled={blocked} onClick={() => void start()}>
              <Ic name="Play" size="sm" /> {busy ? "Starting…" : dryRun ? "Create the plan (dry run)" : "Approve and start"}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function StepBrief(p: {
  brief: string;
  setBrief: (s: string) => void;
  name: string;
  setName: (s: string) => void;
  slots: SlotMap;
  preview: PlanPreview | null;
  previewing: boolean;
  previewErr: string | null;
  appsFound: number;
  plannerModel: ModelRef | null;
  setPlannerModel: (m: ModelRef) => void;
  planner: PlannerState | null;
  plannerRead: boolean;
  startPlanner: () => void;
}) {
  const h = useHelm();
  const planner = p.plannerModel;
  const [picking, setPicking] = useState(false);
  const reading = p.planner && (p.planner.status === "spawning" || p.planner.status === "running");
  const needsPlanner = !!p.brief.trim() && !p.previewing && !p.appsFound && !p.plannerRead;
  const questions = p.preview?.portfolio?.questions ?? [];
  const assumptions = [...(p.preview?.portfolio?.assumptions ?? []), ...(p.preview?.assumed ?? [])];
  return (
    <div className="wpad">
      <div className="banner info">
        <Ic name="MessageSquare" />
        <div>Tell the Orchestrator what to build, in your own words. Helm works out how many apps, managers and agents are needed, and shows you the plan before anything starts.</div>
      </div>
      <div className="row" style={{ gap: 14, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div className="field" style={{ flex: 1, minWidth: 220 }}>
          <label className="lbl" htmlFor="wzName">
            Run name
          </label>
          <input id="wzName" className="input" value={p.name} maxLength={80} placeholder="Optional — defaults to the first group" onChange={(e) => p.setName(e.target.value)} />
        </div>
        <div className="field">
          <span className="lbl">Planner model</span>
          <div className="row" style={{ gap: 8 }}>
            <ModelChip model={planner} catalog={h.catalog} big title="Reads a free-text brief. Default: the Code builders’ model at medium reasoning" />
            <button type="button" className="btn sm" aria-expanded={picking} onClick={() => setPicking((x) => !x)}>
              {picking ? "Done" : "Change"}
            </button>
          </div>
        </div>
      </div>
      {picking ? <ModelPicker catalog={h.catalog} value={planner} onChange={p.setPlannerModel} /> : null}
      <span className="hint-t">A brief in the structured shape is read directly. Anything else is read by one short, hidden planner thread on this model, and nothing else spawns until you approve.</span>
      <div className="field">
        <label className="lbl" htmlFor="wzBrief">
          Your brief
        </label>
        <textarea id="wzBrief" className="textarea briefarea" spellCheck={false} placeholder={PLACEHOLDER} value={p.brief} onChange={(e) => p.setBrief(e.target.value)} />
      </div>
      <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
        <span className={cx("pill", p.appsFound ? "ok" : p.brief.trim() ? "warn" : "")} aria-live="polite">
          {p.previewing ? "Reading…" : `${plural(p.appsFound, "app")} found`}
        </span>
        <span className="hint-t">
          It understands lines like <span className="mono">- Name — tagline · iOS Android macOS</span> under <span className="mono"># Group</span> headings. Add <span className="mono">· /path/to/repo</span> to work in an existing repository or a folder anywhere, and <span className="mono">· reads /path/a, /path/b</span> for folders its agents may read.
        </span>
      </div>
      {p.previewErr ? <Banner tone="crit">{p.previewErr}</Banner> : null}
      {needsPlanner || reading || p.planner?.status === "failed" ? (
        <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <button type="button" className="btn primary sm" disabled={!!reading || !planner} onClick={p.startPlanner}>
            <Ic name="Zap" size="sm" />
            {reading ? "The planner is reading…" : p.planner?.status === "failed" ? "Try the planner again" : "Read with the planner"}
          </button>
          <span className="hint-t" aria-live="polite">
            {reading ? "One hidden thread on the planner model; it is archived when it answers." : p.planner?.status === "failed" ? `The planner could not read it: ${p.planner.error ?? "unknown error"}` : "No structured app lines found. The planner can read free text."}
          </span>
        </div>
      ) : null}
      {questions.length || assumptions.length ? (
        <div className="col" style={{ gap: 6 }}>
          <span className="lbl">What the planner noticed</span>
          <div className="topics">
            {questions.map((q) => (
              <span key={`q-${q}`} className="topic" title="Clarifying question — edit the brief to answer it">
                ? {q}
              </span>
            ))}
            {assumptions.map((a) => (
              <span key={`a-${a}`} className="topic" title="Assumption the plan makes">
                {a}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      <div className="col" style={{ gap: 6 }}>
        <span className="lbl">Use an example</span>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {EXAMPLES.map((ex) => (
            <button key={ex.title} type="button" className="btn sm" onClick={() => p.setBrief(ex.text)}>
              <Ic name="FileText" size="sm" />
              {ex.title}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function StepPortfolio(p: {
  plan: PlanPreview["plan"] | null;
  preview: PlanPreview | null;
  previewErr: string | null;
  limits: Limits;
  setLimits: (l: Limits) => void;
  editApp: (name: string, patch: Partial<Portfolio["apps"][number]> | null) => void;
  appsRoot: string;
  setAppsRoot: (s: string) => void;
}) {
  const { plan, limits } = p;
  if (!plan) return <div className="wpad">{p.previewErr ? <Banner tone="crit">{p.previewErr}</Banner> : <span className="hint-t">Reading the plan…</span>}</div>;
  const appById = new Map(plan.apps.map((a) => [a.id, a]));
  const stepper = (key: "managerSpan" | "orchestratorSpan", min: number, max: number, label: string) => (
    <div className="field">
      <span className="lbl">{label}</span>
      <div className="numstep" role="group" aria-label={label}>
        <button type="button" aria-label="Decrease" disabled={limits[key] <= min} onClick={() => p.setLimits({ ...limits, [key]: clamp(limits[key] - 1, min, max) })}>
          <Ic name="Minus" size="sm" />
        </button>
        <b aria-live="polite">{limits[key]}</b>
        <button type="button" aria-label="Increase" disabled={limits[key] >= max} onClick={() => p.setLimits({ ...limits, [key]: clamp(limits[key] + 1, min, max) })}>
          <Ic name="Plus" size="sm" />
        </button>
      </div>
    </div>
  );
  const row = (a: PlannedApp, removable: boolean) => (
    <div key={a.id} className="approw" style={{ flexWrap: "wrap" }}>
      <div className="trunc">
        <b>{a.name}</b> <span className="muted">{a.tagline}</span>
        <FolderField app={a} onChange={(path) => p.editApp(a.name, { path: path || null })} />
      </div>
      <span className="plt">
        {a.platforms.map((x) => (
          <i key={x} className={a.platformsAssumed ? "assumed" : ""} title={a.platformsAssumed ? "Assumed — the brief didn’t name platforms" : undefined}>
            {PLAT[x] ?? x}
          </i>
        ))}
      </span>
      <div className="row" style={{ gap: 8 }}>
        <span className="shapechip" role="group" aria-label={`Squad shape for ${a.name}`}>
          {(["solo", "lean", "full"] as Shape[]).map((s) => (
            <button key={s} type="button" aria-pressed={a.shape === s} onClick={() => p.editApp(a.name, { shape: s })}>
              {s}
            </button>
          ))}
        </span>
        <span className="mono muted" style={{ fontSize: 11.5 }}>
          {plural(a.agents, "agent")}
        </span>
        {removable ? (
          <button type="button" className="iconbtn sm" onClick={() => p.editApp(a.name, null)} title="Remove from this run" aria-label={`Remove ${a.name}`}>
            <Ic name="X" size="sm" />
          </button>
        ) : null}
      </div>
    </div>
  );
  const removable = plan.apps.length > 1;
  const direct = plan.directAppIds.map((id) => appById.get(id)).filter((a): a is PlannedApp => !!a);
  const c = plan.counts;
  return (
    <div className="wpad">
      <div className="row" style={{ gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
        {stepper("managerSpan", 2, 6, "Apps per manager (max 6)")}
        {stepper("orchestratorSpan", 4, 8, "Managers per Orchestrator (max 8)")}
        <div className="hint-t grow" style={{ minWidth: 240 }}>
          Smaller spans mean closer supervision and more managers. Helm only adds a manager layer when the Orchestrator would otherwise lead too many apps.
        </div>
      </div>
      <div className="field">
        <label className="lbl" htmlFor="wzRoot">
          New app folders go under <span className="faint">(optional)</span>
        </label>
        <input id="wzRoot" className="input mono" value={p.appsRoot} maxLength={500} placeholder="Default: the apps root in Helm settings — or e.g. /Volumes/Work/apps" onChange={(e) => p.setAppsRoot(e.target.value)} />
        <span className="hint-t">Apps without their own folder get a new repository here. Give an app its own folder below to use an existing repository (Helm works on a new helm/… branch and never touches your checkout) or a new folder anywhere.</span>
      </div>
      <Banner tone={plan.ok ? "info" : "crit"} icon={plan.ok ? "Workflow" : "AlertTriangle"}>
        <b>Why this shape{plan.rule && plan.rule !== "none" ? ` (${plan.rule})` : ""}.</b> {plan.ok ? plan.why : plan.error}
      </Banner>
      {plan.warnings.map((w) => (
        <Banner key={w} tone="warn">
          {w}
        </Banner>
      ))}
      <div className="totals">
        <div className="tot">
          <b>{c.apps}</b>
          <span>apps</span>
        </div>
        <div className="tot">
          <b>{c.managers}</b>
          <span>managers</span>
        </div>
        <div className="tot">
          <b>{c.leads}</b>
          <span>app leads</span>
        </div>
        <div className="tot">
          <b>{c.specialists}</b>
          <span>specialists</span>
        </div>
        <div className="tot">
          <b>{c.gates}</b>
          <span>gates, spawned on demand</span>
        </div>
        <div className={cx("tot", c.total > MAX_AGENTS && "bad")}>
          <b>{c.total}</b>
          <span>agents at most (cap {MAX_AGENTS})</span>
        </div>
      </div>
      {plan.managers.map((m, i) => {
        const apps = m.appIds.map((id) => appById.get(id)).filter((a): a is PlannedApp => !!a);
        return (
          <div key={m.id} className="grp">
            <div className="grp-h">
              <span className="mcolor" style={{ background: `var(--h-m${i % 5})`, height: 20 }} />
              <b>{m.name}</b>
              <span className="pill">{plural(apps.length, "app")}</span>
              <span className="grow" />
              <span className="hint-t">Manager {i + 1}</span>
            </div>
            {apps.map((a) => row(a, removable))}
          </div>
        );
      })}
      {direct.length ? (
        <div className="grp">
          <div className="grp-h">
            <b>{plan.managers.length ? "Reports to the Orchestrator" : "Orchestrator leads directly"}</b>
            <span className="pill">{plural(direct.length, "app")}</span>
          </div>
          {direct.map((a) => row(a, removable))}
        </div>
      ) : null}
      {!plan.managers.length && !direct.length ? (
        <div className="grp">
          <div className="grp-h">
            <b>Orchestrator leads directly</b>
          </div>
          {plan.apps.map((a) => row(a, removable))}
        </div>
      ) : null}
      <div className="hint-t">
        Shapes: <b>solo</b> — the lead builds alone; <b>lean</b> — UI and Code builders; <b>full</b> — UI, Code, one builder per platform and Security. Every app also gets a Reviewer and a Slop Hunter, spawned only when it reaches those gates.
      </div>
    </div>
  );
}

/** An app's folder: blank = a new repository under the run folder; else an existing repository or a new folder anywhere. */
function FolderField({ app, onChange }: { app: PlannedApp; onChange: (path: string) => void }) {
  const [open, setOpen] = useState(!!app.path);
  const [v, setV] = useState(app.path ?? "");
  if (!open)
    return (
      <div>
        <button type="button" className="btn sm ghost" onClick={() => setOpen(true)} title="Use an existing repository or a folder anywhere on this machine">
          <Ic name="GitBranch" size="sm" /> Folder: new, under the run folder · change
        </button>
        {app.reads?.length ? <span className="hint-t"> · reads {app.reads.join(", ")}</span> : null}
      </div>
    );
  return (
    <div className="row" style={{ gap: 6, marginTop: 4 }}>
      <input
        className="input mono"
        style={{ minWidth: 280 }}
        value={v}
        maxLength={500}
        aria-label={`Folder for ${app.name}`}
        placeholder="/path/to/existing/repo or a new folder"
        onChange={(e) => setV(e.target.value)}
        onBlur={() => onChange(v.trim())}
        onKeyDown={(e) => {
          if (e.key === "Enter") onChange(v.trim());
        }}
      />
      {app.reads?.length ? <span className="hint-t">reads {app.reads.join(", ")}</span> : null}
    </div>
  );
}

function StepApprove(p: {
  plan: PlanPreview["plan"] | null;
  preview: PlanPreview | null;
  unset: SlotId[];
  fam: string[];
  limits: Limits;
  setLimits: (l: Limits) => void;
  autoAdvance: "ask" | "auto";
  setAutoAdvance: (a: "ask" | "auto") => void;
  dryRun: boolean;
  setDryRun: (b: boolean) => void;
  problems: string[];
  err: string | null;
}) {
  const { plan, preview, limits } = p;
  const ciApps = useMemo(() => (plan?.apps ?? []).filter((a) => a.platforms.some((x) => x === "win" || x === "and")), [plan]);
  if (!plan || !preview) return <div className="wpad"><span className="hint-t">Reading the plan…</span></div>;
  const c = plan.counts;
  const gatesOk = plan.apps.every((a) => squadHas(a, "review") && squadHas(a, "slop"));
  const check = (ok: boolean, text: string, info = false) => (
    <div className="row" style={{ gap: 9, alignItems: "flex-start" }}>
      <Ic name={ok ? "Check" : info ? "Info" : "AlertTriangle"} size="sm" style={{ color: ok ? "var(--h-ok-ink)" : info ? "var(--h-accent)" : "var(--h-warn-ink)", marginTop: 2 }} />
      <span style={{ color: ok || info ? "var(--h-fg-2)" : "var(--h-warn-ink)" }}>
        <span className="sr-only">{ok ? "Pass: " : info ? "Note: " : "Check: "}</span>
        {text}
      </span>
    </div>
  );
  return (
    <div className="wpad">
      <div className="totals">
        <div className="tot">
          <b>{plural(c.apps, "app")}</b>
          <span>
            {c.managers ? `${plural(c.managers, "manager")} · ` : ""}
            {plural(c.leads, "lead")}
          </span>
        </div>
        <div className={cx("tot", c.total > MAX_AGENTS && "bad")}>
          <b>{c.total}</b>
          <span>agents at most · spawned lazily</span>
        </div>
        <div className="tot">
          <b>{plural(preview.waves.waves, "wave")}</b>
          <span>
            {plural(preview.waves.inFlight, "app")} in flight at {limits.concurrency} concurrent
          </span>
        </div>
        <div className="tot">
          <b>
            {fmtUnits(preview.forecast.low).replace(" u", "")}–{fmtUnits(preview.forecast.high)}
          </b>
          <span>estimated · relative units{preview.forecast.unknownWeights.length ? ` · ${plural(preview.forecast.unknownWeights.length, "model")} without a weight` : ""}</span>
        </div>
      </div>
      <Banner tone="warn">
        Estimates use relative weights, not real prices. Multi-agent runs use many times the tokens of one chat, because every agent reads its own context — set a budget cap below and Helm stops spawning when it is reached.
      </Banner>
      <div className="grp">
        <div className="grp-h">
          <b>Checks before start</b>
        </div>
        <div className="pad col" style={{ gap: 9 }}>
          {check(!p.unset.length, p.unset.length ? `${plural(p.unset.length, "role")} still without a model: ${p.unset.map((id) => SLOT_DEFS.find((s) => s.id === id)?.name ?? id).join(", ")}` : "Every role has a model you chose")}
          {check(plan.ok && c.total <= MAX_AGENTS, `Plan fits the agent cap (${c.total} of ${MAX_AGENTS})`)}
          {check(gatesOk, gatesOk ? "Every app gets an independent Reviewer and a Slop Hunter; “ready” also needs green deterministic checks" : "Some apps are missing a Reviewer or Slop Hunter")}
          {check(false, `${plural(c.apps, "new project")} (one repository per app) will be created`, true)}
          {check(!p.fam.length, p.fam.length ? `Gates share a model family with a builder — ${p.fam[0]}` : "Gates use different model families from the builders")}
          {ciApps.length
            ? check(false, `${ciApps.map((a) => a.name).join(", ")}: Windows and Android builds are verified on the CI tier — sign-off says so`, true)
            : check(true, "Every platform can be verified on this machine")}
        </div>
      </div>
      <div className="row" style={{ gap: 20, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div className="field" style={{ minWidth: 260, flex: 1 }}>
          <span className="lbl">Wave approval</span>
          <div className="cards" role="radiogroup" aria-label="Wave approval">
            {(
              [
                ["ask", "Ask me before each wave", "The Orchestrator proposes, you approve in Needs you."],
                ["auto", "Run waves automatically", "Each wave starts as capacity frees up; Needs you still gets approvals and failures."],
              ] as const
            ).map(([v, t, d]) => (
              <button key={v} type="button" role="radio" aria-checked={p.autoAdvance === v} className="rcard" onClick={() => p.setAutoAdvance(v)}>
                <span className="rd" />
                <span>
                  <b>{t}</b>
                  <span className="d">{d}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="col" style={{ gap: 12, minWidth: 260, flex: 1 }}>
          <div className="field">
            <label className="lbl" htmlFor="wzConc">
              Max concurrent agents · <span className="mono">{limits.concurrency}</span>
            </label>
            <input id="wzConc" className="slider" type="range" min={4} max={48} step={2} value={limits.concurrency} onChange={(e) => p.setLimits({ ...limits, concurrency: Number(e.target.value) })} />
            <span className="hint-t">Raising this finishes sooner and hits provider rate limits sooner.</span>
          </div>
          <div className="field">
            <label className="lbl" htmlFor="wzBudget">
              Budget cap (stops new spawns)
            </label>
            <div className="row" style={{ gap: 8 }}>
              <input
                id="wzBudget"
                className="input"
                type="number"
                min={1}
                step={100}
                value={limits.budgetCap}
                style={{ width: 140 }}
                onChange={(e) => p.setLimits({ ...limits, budgetCap: Math.max(1, Number(e.target.value) || 0) })}
              />
              <span className="hint-t">relative units, same scale as the estimate above</span>
            </div>
          </div>
          <label className="check">
            <input type="checkbox" checked={p.dryRun} onChange={(e) => p.setDryRun(e.target.checked)} />
            <span>
              <b>Dry run</b>
              <br />
              <span className="hint-t">Plan, create projects and write briefs, but spawn nothing.</span>
            </span>
          </label>
        </div>
      </div>
      {p.problems.length ? (
        <Banner tone="crit">
          {p.problems.map((x) => (
            <div key={x}>{x}</div>
          ))}
        </Banner>
      ) : null}
      {p.err ? <Banner tone="crit">{p.err}</Banner> : null}
    </div>
  );
}
