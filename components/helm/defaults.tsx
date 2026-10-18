// Default models for the Planner (Amer) and the Orchestrator (Gestra): Helm settings that fill
// those roles when a run leaves them empty. Changing the Planner's can also move every running
// run's Planner now.

import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { ModelRef } from "./types.ts";
import { useHelm } from "./ctx.tsx";
import { Ic, ModelChip, Popover } from "./ui.tsx";
import { ModelPicker } from "./picker.tsx";
import { errMsg } from "./format.ts";

interface Defaults {
  planner: ModelRef | null;
  orchestrator: ModelRef | null;
  moved?: string[];
}

const ROWS = [
  { key: "planner", label: "Planner (Amer)", empty: "Not set: uses each run's Orchestrator model" },
  { key: "orchestrator", label: "Orchestrator (Gestra)", empty: "Not set: chosen in each new run" },
] as const;

export function DefaultModels() {
  const h = useHelm();
  const [d, setD] = useState<Defaults | null>(null);
  const [open, setOpen] = useState<{ key: "planner" | "orchestrator"; el: HTMLElement } | null>(null);
  const [draft, setDraft] = useState<ModelRef | null>(null);
  const [applyLive, setApplyLive] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    h.rpc.call("settings_models", {}).then(
      (r: Defaults) => live && setD(r),
      (e: unknown) => live && toast.error("Could not read the default models", { description: errMsg(e) }),
    );
    return () => {
      live = false;
    };
  }, [h.rpc]);

  const save = async (key: "planner" | "orchestrator", ref: ModelRef | null) => {
    setBusy(true);
    try {
      const r = (await h.rpc.call("settings_setModels", { [key]: ref, applyToPlanners: key === "planner" && applyLive && !!ref })) as Defaults;
      setD(r);
      setOpen(null);
      toast.success(`Default ${key === "planner" ? "Planner" : "Orchestrator"} model ${ref ? "saved" : "cleared"}`, {
        description: r.moved?.length ? `The Planner moved to it now in: ${r.moved.join(", ")}.` : key === "planner" ? "Used by runs whose Planner role has no model." : "Used by new runs that do not choose an Orchestrator model.",
      });
    } catch (e) {
      toast.error("Could not save the default model", { description: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="defmodels" data-testid="default-models">
      <span className="defmodels-h">
        <Ic name="SlidersHorizontal" size="sm" /> Default models
      </span>
      {ROWS.map((row) => {
        const v = d?.[row.key] ?? null;
        return (
          <span key={row.key} className="defmodels-row">
            <span className="muted">{row.label}</span>
            <button
              type="button"
              className="btn sm"
              disabled={!d || busy}
              onClick={(e) => {
                setDraft(v);
                setOpen({ key: row.key, el: e.currentTarget });
              }}
              title={v ? "Change the default" : row.empty}
            >
              {v ? <ModelChip model={v} catalog={h.catalog} /> : <span className="muted">{row.empty}</span>}
              <Ic name="ChevronDown" size="sm" />
            </button>
          </span>
        );
      })}
      {open ? (
        <Popover anchor={open.el} onClose={() => setOpen(null)} width={420} label={`Default ${open.key} model`}>
          <div className="col" style={{ gap: 10, padding: 12 }}>
            <b>Default {open.key === "planner" ? "Planner (Amer)" : "Orchestrator (Gestra)"} model</b>
            <span className="muted" style={{ fontSize: 12 }}>
              {open.key === "planner" ? "Used whenever a run's Planner role has no model. Pick something affordable: the Planner is idle until you ask it something." : "Used for new runs that do not choose an Orchestrator model."}
            </span>
            <ModelPicker catalog={h.catalog} value={draft} onChange={setDraft} />
            {open.key === "planner" ? (
              <label className="row" style={{ gap: 8, fontSize: 12.5 }}>
                <input type="checkbox" checked={applyLive} onChange={(e) => setApplyLive(e.target.checked)} />
                Also switch the Planner in running runs to it now
              </label>
            ) : null}
            <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
              {d?.[open.key] ? (
                <button type="button" className="btn sm" disabled={busy} onClick={() => void save(open.key, null)}>
                  Clear
                </button>
              ) : null}
              <button type="button" className="btn sm primary" disabled={busy || !draft} onClick={() => draft && void save(open.key, draft)}>
                Save
              </button>
            </div>
          </div>
        </Popover>
      ) : null}
    </div>
  );
}
