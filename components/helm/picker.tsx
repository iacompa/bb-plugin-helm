// The live model catalog as a picker: providers, search, NEW tags, a
// reasoning control and (when offered) service tiers. Used by the Model
// Studio, the Direct tab's model change and "Change model and retry".
import { useMemo, useState, type ReactNode } from "react";
import type { Catalog, CatalogModel, ModelRef } from "./types.ts";
import { PROVIDER_LABEL, findModel, providerVar, reasonLabel } from "./format.ts";
import { Ic, cx } from "./ui.tsx";

const costMark = (w: number) => (w < 0.6 ? "·" : w < 1.2 ? "··" : w < 2.2 ? "···" : "····");

export function pickRef(m: CatalogModel, prev: ModelRef | null | undefined): ModelRef {
  const keep = prev?.reasoning && m.reasoning.includes(prev.reasoning) ? prev.reasoning : null;
  return { providerId: m.providerId, modelId: m.modelId, reasoning: keep ?? m.defaultReasoning ?? (m.reasoning.includes("high") ? "high" : m.reasoning[0] ?? null) };
}

export function CatalogList({ catalog, value, onPick, compact }: { catalog: Catalog | null; value: ModelRef | null | undefined; onPick: (m: CatalogModel) => void; compact?: boolean }) {
  const [prov, setProv] = useState("all");
  const [q, setQ] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const models = catalog?.models ?? [];
  const providers = useMemo(() => {
    const seen = new Map<string, string>();
    for (const p of catalog?.providers ?? []) seen.set(p.id, p.label);
    for (const m of models) if (!seen.has(m.providerId)) seen.set(m.providerId, m.providerLabel);
    return [...seen.entries()];
  }, [catalog, models]);
  const ql = q.trim().toLowerCase();
  const isCur = (m: CatalogModel) => !!value && value.providerId === m.providerId && value.modelId === m.modelId;
  const list = models.filter((m) => (showHidden || !m.hidden || isCur(m)) && (prov === "all" || m.providerId === prov) && (!ql || `${m.name} ${m.modelId} ${m.providerLabel}`.toLowerCase().includes(ql)));
  const groups = new Map<string, CatalogModel[]>();
  for (const m of list) groups.set(m.providerId, [...(groups.get(m.providerId) ?? []), m]);
  const hiddenN = models.filter((m) => m.hidden).length;
  const unavailable = (catalog?.providers ?? []).filter((p) => !p.available);
  return (
    <>
      <div className={compact ? "col" : "cat-top"} style={compact ? { gap: 8, marginBottom: 8 } : undefined}>
        {providers.length > 1 ? (
          <div className="seg" role="group" aria-label="Provider">
            {[["all", "All"] as [string, string], ...providers.map(([id, l]) => [id, (PROVIDER_LABEL[id] ?? l).replace(" (ACP)", "")] as [string, string])].map(([id, l]) => (
              <button key={id} type="button" aria-pressed={prov === id} className={prov === id ? "on" : ""} onClick={() => setProv(id)}>
                {l}
              </button>
            ))}
          </div>
        ) : null}
        <label className="search" style={{ width: "100%", background: "var(--h-surface)", border: "1px solid var(--h-line-strong)", borderRadius: 9 }}>
          <Ic name="Search" />
          <input placeholder="Search models" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search models" autoComplete="off" spellCheck={false} />
        </label>
      </div>
      <div className={compact ? "picker-box" : "cat-list"} role="listbox" aria-label="Models">
        {unavailable.map((p) => (
          <div key={p.id} className="hint-t" style={{ padding: "8px 10px" }}>
            <b>{p.label}</b> is not available on this machine{p.error ? `: ${p.error}` : ""}.
          </div>
        ))}
        {[...groups.entries()].map(([p, ms]) => (
          <div key={p}>
            <div className="provh">
              <i className="pdot" style={{ background: providerVar(p) }} />
              {PROVIDER_LABEL[p] ?? ms[0]?.providerLabel ?? p}
              <span className="faint" style={{ letterSpacing: 0, textTransform: "none", fontFamily: "inherit", fontWeight: 500 }}>
                {ms.length} models
              </span>
            </div>
            {ms.map((m) => (
              <button key={m.modelId} type="button" role="option" aria-selected={isCur(m)} aria-pressed={isCur(m)} className="mrow" onClick={() => onPick(m)}>
                <span className="mi">
                  <b>
                    {m.name}
                    {m.isNew ? <span className="tagnew">NEW</span> : null}
                    {m.isDefault ? <span className="pill">provider default</span> : null}
                    {m.hidden ? <span className="pill">older</span> : null}
                    {!m.weightKnown ? (
                      <span className="pill warn" title="No relative cost weight is configured for this model; forecasts use 1.0">
                        weight unknown
                      </span>
                    ) : null}
                  </b>
                  <span>
                    {m.modelId} · {m.reasoning.length ? `${m.reasoning.length} reasoning levels` : "no reasoning setting"}
                  </span>
                </span>
                <span className="mono muted" title={`Relative cost weight ${m.weight}`} style={{ fontSize: 11 }}>
                  {costMark(m.weight)}
                </span>
              </button>
            ))}
          </div>
        ))}
        {!list.length ? <div className="empty" style={{ margin: 10 }}>{models.length ? "No model matches." : "No models were reported by this machine’s providers."}</div> : null}
        {hiddenN ? (
          <button type="button" className="more" style={{ margin: "10px 4px 4px", width: "calc(100% - 8px)" }} onClick={() => setShowHidden(!showHidden)}>
            {showHidden ? "Hide" : "Show"} {hiddenN} older models
          </button>
        ) : null}
      </div>
    </>
  );
}

export function ReasoningControl({ catalog, value, onChange, label }: { catalog: Catalog | null; value: ModelRef | null | undefined; onChange: (r: ModelRef) => void; label: string }) {
  const m = findModel(catalog, value);
  return (
    <div className="field">
      <span className="lbl">{label}</span>
      {m && value && m.reasoning.length ? (
        <div className="reasons" role="group" aria-label={label}>
          {m.reasoning.map((r) => (
            <button key={r} type="button" aria-pressed={value.reasoning === r} onClick={() => onChange({ ...value, reasoning: r })} title={reasonLabel(r)}>
              {r}
            </button>
          ))}
        </div>
      ) : (
        <span className="hint-t">{m ? "This model has no reasoning setting." : value ? "This model is not in the live catalog." : "Pick a model first."}</span>
      )}
      {m && value && m.serviceTiers.length ? (
        <div className="reasons" role="group" aria-label="Service tier" style={{ marginTop: 6 }}>
          {m.serviceTiers.map((t) => (
            <button key={t} type="button" aria-pressed={(value.serviceTier ?? null) === t} onClick={() => onChange({ ...value, serviceTier: value.serviceTier === t ? null : t })}>
              {t}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Compact picker: list + reasoning, for inline use. */
export function ModelPicker({ catalog, value, onChange, label = "Reasoning", children }: { catalog: Catalog | null; value: ModelRef | null | undefined; onChange: (r: ModelRef) => void; label?: string; children?: ReactNode }) {
  return (
    <div className={cx("col")} style={{ gap: 10 }}>
      <CatalogList catalog={catalog} value={value} compact onPick={(m) => onChange(pickRef(m, value))} />
      <ReasoningControl catalog={catalog} value={value} onChange={onChange} label={label} />
      {children}
    </div>
  );
}
