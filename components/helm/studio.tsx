// Model Studio (§11.9): the 12 slots on the left, the live catalog on the
// right, presets, family heads-up, unavailable-model state and forecast tiles.
// Also embedded as step 3 of the New-run wizard.
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { DirectiveInfo, ModelRef, Preset, Role, SlotId, SlotMap } from "./types.ts";
import {
  BASE_TOK,
  SEED_PRESETS,
  SLOT_DEFS,
  SLOT_GROUPS,
  agoOf,
  errMsg,
  familyWarnings,
  fmtTokens,
  fmtUnits,
  forecastNodes,
  modelText,
  plural,
  refProblem,
} from "./format.ts";
import { useHelm } from "./ctx.tsx";
import { Banner, Ic, Modal, ModalHead, ModelChip, Seg, askConfirm, askReason, cx } from "./ui.tsx";
import { CatalogList, ReasoningControl, pickRef } from "./picker.tsx";

export interface StudioNode {
  role: Role;
  slot: SlotId;
  model?: ModelRef | null;
  modelOverride?: boolean;
  status?: string;
}

const LIVE = new Set(["running", "waiting", "needs", "queued", "paused", "idle"]);
const DEFAULT_REQUIRED: SlotId[] = ["orchestrator", "manager", "lead", "ui", "code", "platform", "security", "review", "slop"];
const SEEDS = Object.keys(SEED_PRESETS);

export const refEq = (a: ModelRef | null | undefined, b: ModelRef | null | undefined) =>
  (!a && !b) || (!!a && !!b && a.providerId === b.providerId && a.modelId === b.modelId && (a.reasoning ?? null) === (b.reasoning ?? null) && (a.serviceTier ?? null) === (b.serviceTier ?? null));

/** Slots whose value differs from the base (only slots the draft sets). */
export function changedSlots(draft: SlotMap, base: SlotMap): SlotId[] {
  return SLOT_DEFS.filter((s) => draft[s.id] && !refEq(draft[s.id], base[s.id])).map((s) => s.id);
}

const slotName = (id: SlotId) => SLOT_DEFS.find((s) => s.id === id)?.name ?? id;

export function StudioPanel(props: {
  slots: SlotMap;
  onChange: (s: SlotMap) => void;
  mode: "run" | "wizard";
  baseSlots?: SlotMap;
  nodes?: StudioNode[];
  bySlot?: Partial<Record<SlotId, number>>;
  required?: SlotId[];
  initialSel?: SlotId;
  readOnly?: boolean;
}) {
  const { slots, onChange, mode, baseSlots, nodes, bySlot, readOnly } = props;
  const h = useHelm();
  const cat = h.catalog;
  const required = useMemo<SlotId[]>(() => {
    if (props.required) return props.required;
    if (mode === "run" && nodes?.length) return SLOT_DEFS.filter((s) => nodes.some((n) => n.slot === s.id)).map((s) => s.id);
    return DEFAULT_REQUIRED;
  }, [props.required, mode, nodes]);
  const [sel, setSel] = useState<SlotId>(() => props.initialSel ?? (mode === "wizard" ? (required.find((id) => !slots[id]) ?? "orchestrator") : "ui"));
  const [preset, setPreset] = useState<string>(mode === "run" ? "Current run" : "Studio default");
  const [warnAck, setWarnAck] = useState(false);
  const [saved, setSaved] = useState<Preset[]>([]);

  const loadPresets = useCallback(() => {
    h.rpc.call("presets_list", {}).then(
      (r: { presets: Preset[] }) => setSaved(r.presets ?? []),
      () => setSaved([]),
    );
  }, [h.rpc]);
  useEffect(loadPresets, [loadPresets]);

  const change = (next: SlotMap, label = "Custom") => {
    if (readOnly) return;
    setPreset(label);
    setWarnAck(false);
    onChange(next);
  };
  const setSlot = (id: SlotId, r: ModelRef) => change({ ...slots, [id]: r });

  const applyPreset = (name: string) => {
    if (name === "Current run") return change({ ...(baseSlots ?? {}) }, name);
    const p = SEED_PRESETS[name] ?? saved.find((x) => x.name === name)?.slots;
    if (!p) return;
    const copy = JSON.parse(JSON.stringify(p)) as SlotMap;
    change(mode === "run" ? { ...(baseSlots ?? {}), ...copy } : copy, name);
  };
  const savePreset = async () => {
    const name = await askReason({ title: "Save as preset", ok: "Save preset", placeholder: "e.g. Fast prototype week", hint: "Presets store the choices only — Helm still asks every run and re-checks the catalog." });
    if (!name) return;
    try {
      const r = (await h.rpc.call("presets_save", { name: name.slice(0, 80), slots: slots as Record<string, ModelRef> })) as { presets: Preset[] };
      setSaved(r.presets ?? []);
      setPreset(name.slice(0, 80));
      toast.success("Preset saved", { description: "Presets store the choices only — Helm still asks every run and re-checks the catalog." });
    } catch (e) {
      toast.error("Could not save the preset", { description: errMsg(e) });
    }
  };
  const deletePreset = async () => {
    if (!saved.some((p) => p.name === preset)) return;
    if (!(await askConfirm({ title: `Delete preset “${preset}”?`, body: "Runs that already used it keep their models.", ok: "Delete", danger: true }))) return;
    try {
      const r = (await h.rpc.call("presets_delete", { name: preset })) as { presets: Preset[] };
      setSaved(r.presets ?? []);
      setPreset("Custom");
    } catch (e) {
      toast.error("Could not delete the preset", { description: errMsg(e) });
    }
  };

  // counts per slot
  const uses = (id: SlotId) => {
    if (mode === "run" && nodes) {
      const ns = nodes.filter((n) => n.slot === id);
      return { live: ns.filter((n) => LIVE.has(n.status ?? "")).length, planned: ns.filter((n) => n.status === "planned").length, overrides: ns.filter((n) => n.modelOverride).length, total: ns.length };
    }
    return { live: 0, planned: 0, overrides: 0, total: bySlot?.[id] ?? 0 };
  };

  // forecast
  const forecastSet: StudioNode[] = useMemo(() => {
    if (nodes?.length) return nodes;
    const out: StudioNode[] = [];
    for (const s of SLOT_DEFS) for (let i = 0; i < (bySlot?.[s.id] ?? 0); i++) out.push({ role: s.role, slot: s.id });
    return out;
  }, [nodes, bySlot]);
  const fc = forecastNodes(forecastSet as Parameters<typeof forecastNodes>[0], slots, cat);
  const base = mode === "run" && baseSlots ? forecastNodes(forecastSet as Parameters<typeof forecastNodes>[0], baseSlots, cat) : null;
  const delta = base ? fc.units - base.units : 0;
  const tokK = forecastSet.reduce((a, n) => a + (BASE_TOK[n.role] ?? 300), 0);

  const unset = required.filter((id) => !slots[id]);
  const newModels = (cat?.models ?? []).filter((m) => m.isNew);
  const warns = warnAck ? [] : familyWarnings(cat, slots);
  const sd = SLOT_DEFS.find((s) => s.id === sel)!;
  const cur = slots[sel] ?? null;
  const problem = refProblem(cat, cur);
  const presetIsSaved = saved.some((p) => p.name === preset);
  const noModels = !!cat && (!cat.models.length || !cat.providers.some((p) => p.available));

  return (
    <div className="studio">
      <div className="studio-l">
        <div className="st-top">
          <select className="select" aria-label="Preset" style={{ width: 180 }} value={preset} disabled={readOnly} onChange={(e) => applyPreset(e.target.value)}>
            {mode === "run" ? <option value="Current run">Current run</option> : null}
            {SEEDS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
            {saved
              .filter((p) => !SEEDS.includes(p.name))
              .map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            <option value="Custom" disabled={preset !== "Custom"}>
              Custom
            </option>
          </select>
          <button type="button" className="btn sm" onClick={savePreset} disabled={readOnly || !Object.keys(slots).length}>
            Save as preset…
          </button>
          {presetIsSaved && !readOnly ? (
            <button type="button" className="iconbtn sm" onClick={deletePreset} aria-label={`Delete preset ${preset}`} title="Delete this saved preset">
              <Ic name="Trash2" size="sm" />
            </button>
          ) : null}
          <span className="grow" />
          {cat ? (
            <span className={cx("pill", noModels ? "warn" : "ok")} title="Models were read from this machine's providers, so the list reflects what is installed now">
              <Ic name={noModels ? "AlertTriangle" : "Check"} size="sm" />
              Verified on this machine · {plural(cat.models.length, "model")} · {agoOf(cat.fetchedAt)}
            </span>
          ) : (
            <span className="pill warn">{h.catalogError ? "Catalog unavailable" : "Reading catalog…"}</span>
          )}
          <button type="button" className="iconbtn sm" onClick={() => void h.loadCatalog({ refresh: true })} aria-label="Refresh the model catalog" title="Read the catalog again">
            <Ic name="RotateCcw" size="sm" />
          </button>
        </div>
        {noModels || h.catalogError ? (
          <Banner tone="crit" style={{ margin: "12px 16px 0" }}>
            <b>No provider or model is available on this machine.</b> {h.catalogError ? `${h.catalogError}. ` : ""}Helm reads models live from BB’s providers — set one up in BB’s Settings → Providers, then refresh.
          </Banner>
        ) : null}
        {newModels.length && mode !== "wizard" ? (
          <div className="banner info" style={{ margin: "12px 16px 0" }}>
            <Ic name="Zap" />
            <div className="grow">
              <b>{plural(newModels.length, "model")} you haven’t used with Helm before:</b>{" "}
              {newModels.slice(0, 4).map((m, i) => (
                <span key={`${m.providerId}/${m.modelId}`}>
                  {i ? (i === Math.min(newModels.length, 4) - 1 ? " and " : ", ") : ""}
                  <b>{m.name}</b>
                </span>
              ))}
              {newModels.length > 4 ? ` and ${newModels.length - 4} more` : ""}. Models change quickly — Helm asks every run instead of remembering old picks.
            </div>
            <button type="button" className="btn sm" onClick={() => void h.loadCatalog({ markSeen: true })}>
              Mark as seen
            </button>
          </div>
        ) : null}
        {unset.length ? (
          <div className="banner warn" style={{ margin: "12px 16px 0" }}>
            <Ic name="AlertTriangle" />
            <div className="grow">
              <b>
                {plural(unset.length, "slot")} still {unset.length === 1 ? "needs" : "need"} a model.
              </b>{" "}
              Coordination roles are never guessed for you.
            </div>
            {slots.code && !readOnly ? (
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  const next = { ...slots };
                  for (const id of unset) next[id] = { ...slots.code! };
                  change(next);
                }}
              >
                Use Code builders’ model for them
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="slots" role="group" aria-label="Model slots">
          {SLOT_GROUPS.map((g) => (
            <div key={g}>
              <div className="slotgroup">{g}</div>
              {SLOT_DEFS.filter((s) => s.group === g).map((s) => {
                const v = slots[s.id];
                const u = uses(s.id);
                const isReq = required.includes(s.id);
                return (
                  <button key={s.id} type="button" className="slot" aria-pressed={sel === s.id} onClick={() => setSel(s.id)}>
                    <span className="sn">
                      {s.name}
                      {!v && isReq ? <span className="pill warn">needs a model</span> : null}
                    </span>
                    <span className="sv">
                      {v ? <ModelChip model={v} catalog={cat} /> : <span className={cx("mchip", isReq && "unset")}>Choose a model…</span>}
                      <span className="uses">
                        {mode === "run" && nodes
                          ? `${u.live} live · ${u.planned} planned${u.overrides ? ` · ${u.overrides} overridden` : ""}`
                          : u.total
                            ? `×${u.total}`
                            : isReq
                              ? "required"
                              : "optional"}
                      </span>
                    </span>
                    <span className="sd">{s.desc}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="studio-r">
        <div className="cat-top" style={{ paddingBottom: 0 }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
            <div>
              <div className="lbl">Choosing for</div>
              <div style={{ fontWeight: 650, fontSize: 18, letterSpacing: "-.01em" }}>{sd.name}</div>
            </div>
            {sel !== "code" && slots.code && !readOnly ? (
              <button type="button" className="btn sm" onClick={() => setSlot(sel, { ...slots.code! })}>
                Same as Code builders
              </button>
            ) : null}
          </div>
        </div>
        <CatalogList key={sel} catalog={cat} value={cur} onPick={(m) => !readOnly && setSlot(sel, pickRef(m, cur))} />
        <div className="cat-foot">
          <ReasoningControl catalog={cat} value={cur} onChange={(r) => !readOnly && setSlot(sel, r)} label={`Reasoning for ${sd.name.toLowerCase()}`} />
          {problem ? (
            <Banner tone="crit">
              <b>Unavailable model.</b> {problem} Pick another model for {sd.name.toLowerCase()} — Helm won’t start agents on a model this machine can’t run.
            </Banner>
          ) : null}
          {warns.length ? (
            <div className="banner warn" style={{ flexDirection: "column", gap: 6 }}>
              <div className="row" style={{ gap: 8 }}>
                <Ic name="AlertTriangle" />
                <b>Heads-up — worth a thought, not a blocker</b>
              </div>
              {warns.map((w) => (
                <div key={w}>{w}</div>
              ))}
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn sm" onClick={() => setWarnAck(true)}>
                  Keep my choice
                </button>
              </div>
            </div>
          ) : null}
          <div className="forecast">
            <div className="tot">
              <b style={{ fontSize: 16 }}>
                {fmtUnits(fc.low).replace(" u", "")}–{fmtUnits(fc.high)}
              </b>
              <span>est. run cost · relative units, not real prices</span>
            </div>
            <div className="tot">
              <b style={{ fontSize: 16 }}>≈ {fmtTokens(tokK * 1000)}</b>
              <span>tokens (estimate)</span>
            </div>
            {base ? (
              <div className="tot">
                <b style={{ fontSize: 16, color: delta > 0.005 ? "var(--h-warn-ink)" : delta < -0.005 ? "var(--h-ok-ink)" : "inherit" }}>
                  {Math.abs(delta) < 0.005 ? "±0" : `${delta > 0 ? "+" : "−"}${fmtUnits(Math.abs(delta))}`}
                </b>
                <span>vs current run</span>
              </div>
            ) : (
              <div className="tot">
                <b style={{ fontSize: 16 }}>{uses(sel).total}</b>
                <span>{uses(sel).total === 1 ? "agent uses" : "agents use"} this slot</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ───────────── the modal ─────────────

export function StudioModal() {
  const h = useHelm();
  if (!h.studio) return null;
  return <StudioModalInner />;
}

function StudioModalInner() {
  const h = useHelm();
  const run = h.data?.run ?? null;
  const base: SlotMap = run?.slots ?? {};
  const [draft, setDraft] = useState<SlotMap>(() => JSON.parse(JSON.stringify(base)) as SlotMap);
  const [scope, setScope] = useState<"future" | "all">("future");
  const [problems, setProblems] = useState<Array<{ slot: string; message: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nodes = useMemo(() => (h.data ? Object.values(h.data.nodes) : []), [h.data, h.rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = h.closeStudio;
  const finished = run && (run.status === "done" || run.status === "cancelled");
  const readOnly = !run || !!finished;
  const changes = changedSlots(draft, base);
  const started = run && run.status !== "planning";
  const existing = changes.reduce((a, id) => a + nodes.filter((n) => n.slot === id && n.threadId && !n.modelOverride && !["done", "idle", "failed"].includes(n.status)).length, 0);
  const kept = changes.reduce((a, id) => a + nodes.filter((n) => n.slot === id && n.modelOverride).length, 0);

  const apply = async () => {
    if (!run || !changes.length) return;
    setBusy(true);
    setErr(null);
    try {
      const v = (await h.rpc.call("models_validate", { slots: draft as Record<string, ModelRef> })) as { problems: Array<{ slot: string; message: string }> };
      setProblems(v.problems ?? []);
      if (v.problems?.length) {
        setBusy(false);
        return;
      }
      const changed = Object.fromEntries(changes.map((id) => [id, draft[id]!])) as Record<string, ModelRef>;
      if (run.status === "planning") {
        await h.rpc.call("run_setSlots", { runId: run.id, slots: changed });
        toast.success("Model Studio updated", { description: "The plan uses the new models when the run starts." });
      } else {
        const text = `Model Studio — ${changes.map((id) => `${slotName(id)}: ${modelText(h.catalog, draft[id])}`).join("; ")} (${scope === "all" ? "future spawns and running agents’ next turn" : "future spawns"})`;
        const d = (await h.rpc.call("directive_create", { runId: run.id, directive: { type: "slots", target: "orch", slots: changed, slotsScope: scope, text } })) as DirectiveInfo;
        if (d?.id) h.firePulse(d);
        toast.success("Model Studio updated", {
          description: scope === "all" ? `${plural(existing, "agent")} switch on their next turn. Orchestrator, managers and leads were told.` : "Future spawns use the new models. Orchestrator, managers and leads were told.",
        });
      }
      h.refetch();
      close();
    } catch (e) {
      setErr(errMsg(e));
      setBusy(false);
    }
  };

  return (
    <Modal label="Model Studio" cls="lg" onClose={close}>
      <ModalHead title="Model Studio" onClose={close}>
        {run ? <span className={cx("pill", run.status === "running" ? "run" : run.status === "planning" ? "acc" : "")}>{run.status}</span> : null}
        <span className="muted" style={{ fontSize: 12 }}>
          Which model does each role use? Changes apply to future spawns — and optionally to agents that already exist.
        </span>
      </ModalHead>
      {!run ? (
        <Banner tone="info" style={{ margin: "12px 18px 0" }}>
          No run is selected, so this is read-only. Start a New run to choose models for it.
        </Banner>
      ) : finished ? (
        <Banner tone="info" style={{ margin: "12px 18px 0" }}>
          This run is {run.status}; its models can no longer change.
        </Banner>
      ) : null}
      <div className="mbody" style={{ overflow: "hidden" }}>
        <StudioPanel slots={draft} onChange={setDraft} mode="run" baseSlots={base} nodes={nodes} initialSel={h.studio?.slot as SlotId | undefined} readOnly={readOnly} />
      </div>
      <div className="mfoot">
        <div className="grow col" style={{ gap: 6, minWidth: 0 }}>
          {problems.length ? (
            <Banner tone="crit">
              {problems.map((p) => (
                <div key={p.slot}>
                  <b>{slotName(p.slot as SlotId)}:</b> {p.message}
                </div>
              ))}
            </Banner>
          ) : null}
          {err ? <Banner tone="crit">{err}</Banner> : null}
          {changes.length ? (
            <>
              <span className="hint-t">
                <b>{plural(changes.length, "change")}:</b> {changes.map(slotName).join(", ")}
              </span>
              {started ? (
                <>
                  <Seg
                    label="Who the change applies to"
                    value={scope}
                    onChange={setScope}
                    options={[
                      ["future", "New agents only"],
                      ["all", `Also running agents’ next turn${existing ? ` (${existing})` : ""}`],
                    ]}
                    style={{ alignSelf: "flex-start" }}
                  />
                  <span className="hint-t">
                    {scope === "all"
                      ? `Existing agents switch on their next turn — nothing restarts.${kept ? ` ${plural(kept, "per-agent override")} ${kept === 1 ? "is" : "are"} kept.` : ""}`
                      : "Agents already running keep their model. The Orchestrator and leads are told what future spawns will use."}
                  </span>
                </>
              ) : (
                <span className="hint-t">This run hasn’t started, so the new models simply become the plan.</span>
              )}
            </>
          ) : (
            <span className="hint-t">No changes yet. Pick a role, then a model.</span>
          )}
        </div>
        <button type="button" className="btn" onClick={close}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={readOnly || busy || !changes.length} onClick={apply}>
          {busy ? "Applying…" : `Apply${changes.length ? ` ${plural(changes.length, "change")}` : ""}`}
        </button>
      </div>
    </Modal>
  );
}
