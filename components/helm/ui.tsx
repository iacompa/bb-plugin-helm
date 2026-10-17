// Small presentational parts shared by every Helm area. Status is always
// colour + icon/dot + text; overlays render inside the .helm root.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { experimental_Icon as BbIcon } from "@get-bb/plugin-sdk/app";
import type { Catalog, DirectiveInfo, ModelRef, ReceiptState, RecipientLevel, SnapNode, Stage } from "./types.ts";
import { findModel, providerVar, reasonLabel, receiptCounts, refProblem, roleIcon, stageLabel, stagePillClass, statusLabel } from "./format.ts";
import { useEscape, useHelm } from "./ctx.tsx";

export const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");

export function Ic({ name, size, className, style, label }: { name: string; size?: "sm" | "lg"; className?: string; style?: CSSProperties; label?: string }) {
  return <BbIcon name={name} fallback="Circle" className={cx("ic", size, className)} style={style} aria-hidden={label ? undefined : true} aria-label={label} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}

export function StatusPill({ status, className }: { status: string; className?: string }) {
  return <span className={cx("stpill", `s-${status}`, className)}>{statusLabel(status)}</span>;
}

export function Dot({ status, touched, title }: { status: string; touched?: boolean; title?: string }) {
  return <i className={cx("dot", `s-${status}`, touched && "touched")} title={title} />;
}

export function StagePill({ stage }: { stage: Stage }) {
  return <span className={cx("stage-pill", stagePillClass(stage))}>{stageLabel(stage)}</span>;
}

export function RoleTile({ node, lg }: { node: Pick<SnapNode, "role" | "tier" | "platform">; lg?: boolean }) {
  const tier = node.tier === "orchestrator" || node.tier === "manager";
  return (
    <span className={cx("tile", lg && "lg", tier && "tier", node.tier === "gate" && "gate")}>
      <Ic name={roleIcon(node)} />
    </span>
  );
}

export function ModelChip({
  model,
  catalog,
  big,
  planned,
  onClick,
  title,
}: {
  model: ModelRef | null | undefined;
  catalog: Catalog | null;
  big?: boolean;
  planned?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  if (!model) {
    const cls = cx("mchip", "unset", big && "big");
    return onClick ? (
      <button type="button" className={cls} onClick={onClick} title={title}>
        <i className="pdot" />
        <span className="mn">Not set</span>
      </button>
    ) : (
      <span className={cls} title={title}>
        <i className="pdot" />
        <span className="mn">Not set</span>
      </span>
    );
  }
  const m = findModel(catalog, model);
  const problem = refProblem(catalog, model);
  const cls = cx("mchip", big && "big", planned && "planned", problem && "bad");
  const body = (
    <>
      <i className="pdot" style={{ background: providerVar(model.providerId) }} />
      <span className="mn">{m?.name ?? model.modelId}</span>
      {model.reasoning ? <em>{reasonLabel(model.reasoning)}</em> : null}
    </>
  );
  const t = problem ? `Unavailable: ${problem}` : title ?? `${m?.providerLabel ?? model.providerId} · ${model.modelId}${model.reasoning ? ` · ${reasonLabel(model.reasoning)}` : ""}`;
  return onClick ? (
    <button type="button" className={cls} onClick={onClick} title={t} aria-label={`Model ${m?.name ?? model.modelId}${problem ? ", unavailable" : ""}`}>
      {body}
    </button>
  ) : (
    <span className={cls} title={t}>
      {body}
    </span>
  );
}

export function LevelChip({ level, world }: { level: RecipientLevel; world: boolean }) {
  if (world && level === "digest") return <span className="lvl world">World state</span>;
  if (world && level === "full") return <span className="lvl full">Full + world state</span>;
  if (world && level === "direct") return <span className="lvl">Target + world state</span>;
  if (level === "full") return <span className="lvl full">Full</span>;
  if (level === "direct") return <span className="lvl">Target</span>;
  return <span className="lvl dig">Digest</span>;
}

const RC: Record<ReceiptState, [string, string]> = { queued: ["q", "Queued"], delivered: ["d", "Delivered"], ack: ["a", "Acknowledged"], rec: ["r", "Recorded"], failed: ["f", "Failed"] };
export function ReceiptChip({ state }: { state: ReceiptState }) {
  const [c, l] = RC[state] ?? RC.queued;
  return (
    <span className={cx("rc", c)}>
      {state === "ack" ? <Ic name="Check" /> : state === "failed" ? <Ic name="AlertTriangle" /> : null}
      {l}
    </span>
  );
}

export function ReceiptBar({ d }: { d: DirectiveInfo }) {
  const c = receiptCounts(d);
  const total = Math.max(1, d.recipients.length);
  const seg = (n: number, bg: string) => (n ? <i style={{ flex: n, background: bg }} /> : null);
  return (
    <span className="rbar" role="img" aria-label={`Receipts: ${c.ack} acknowledged, ${c.rec} recorded, ${c.delivered} delivered, ${c.queued} queued${c.failed ? `, ${c.failed} failed` : ""}`} title={`${c.ack + c.rec}/${total} confirmed`}>
      {seg(c.ack, "var(--h-ok)")}
      {seg(c.rec, "var(--h-accent)")}
      {seg(c.delivered, "var(--h-wait)")}
      {seg(c.queued, "var(--h-line-strong)")}
      {seg(c.failed, "var(--h-crit)")}
    </span>
  );
}

export function Banner({ tone = "info", icon, children, style }: { tone?: "info" | "warn" | "crit" | "human" | "ok"; icon?: string; children: ReactNode; style?: CSSProperties }) {
  const ic = icon ?? (tone === "warn" || tone === "crit" ? "AlertTriangle" : tone === "ok" ? "CircleCheck" : "Info");
  return (
    <div className={cx("banner", tone)} role={tone === "crit" ? "alert" : "status"} style={style}>
      <Ic name={ic} />
      <div className="grow">{children}</div>
    </div>
  );
}

export function Seg<T extends string>({ options, value, onChange, label, className, style }: { options: Array<[T, ReactNode]>; value: T; onChange: (v: T) => void; label: string; className?: string; style?: CSSProperties }) {
  return (
    <div className={cx("seg", className)} role="group" aria-label={label} style={style}>
      {options.map(([id, l]) => (
        <button key={id} type="button" aria-pressed={value === id} className={value === id ? "on" : ""} onClick={() => onChange(id)}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function Sec({ title, right, children }: { title: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="sec">
      <h4>
        <span>{title}</span>
        {right ? <span className="r">{right}</span> : null}
      </h4>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** Render `code` spans in plain text (the prototype's `fmt`). */
export function Fmt({ text }: { text: string | null | undefined }) {
  const parts = String(text ?? "").split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) => (p.startsWith("`") && p.endsWith("`") && p.length > 1 ? <code key={i} className="mono">{p.slice(1, -1)}</code> : <span key={i}>{p}</span>))}
    </>
  );
}

// ───────────── overlays ─────────────

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ label, cls, onClose, children, initialFocus }: { label: string; cls?: string; onClose: () => void; children: ReactNode; initialFocus?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEscape(onClose);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = (initialFocus && el?.querySelector<HTMLElement>(initialFocus)) || el?.querySelector<HTMLElement>("textarea, input") || el?.querySelector<HTMLElement>(FOCUSABLE);
    setTimeout(() => first?.focus(), 20);
    return () => prev?.focus?.();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Tab" || !ref.current) return;
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={cx("modal", cls)} role="dialog" aria-modal="true" aria-label={label} onKeyDown={onKey}>
        {children}
      </div>
    </div>
  );
}

export function ModalHead({ title, onClose, children }: { title: ReactNode; onClose: () => void; children?: ReactNode }) {
  return (
    <div className="mhead">
      <h3>{title}</h3>
      {children}
      <span className="grow" />
      <button type="button" className="iconbtn" onClick={onClose} aria-label="Close">
        <Ic name="X" />
      </button>
    </div>
  );
}

/** A popover anchored to an element, positioned inside the .helm root. */
export function Popover({ anchor, onClose, width = 360, align = "left", label, children }: { anchor: HTMLElement | null; onClose: () => void; width?: number; align?: "left" | "right"; label: string; children: ReactNode }) {
  const { rootRef } = useHelm();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEscape(onClose);
  useLayoutEffect(() => {
    // measure against the box the popover is actually positioned in
    const root = (ref.current?.offsetParent as HTMLElement | null) ?? rootRef.current;
    if (!anchor || !root || !ref.current) return;
    const rr = root.getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    const w = Math.min(width, rr.width - 20);
    let left = (align === "right" ? a.right - w : a.left) - rr.left;
    left = Math.max(10, Math.min(left, rr.width - w - 10));
    const h = ref.current.offsetHeight;
    let top = a.bottom - rr.top + 8;
    if (top + h > rr.height - 10) top = Math.max(10, a.top - rr.top - h - 8);
    if (top + h > rr.height - 10) top = Math.max(10, rr.height - h - 10);
    setPos({ left, top });
  }, [anchor, width, align, rootRef]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [anchor, onClose]);
  useEffect(() => {
    setTimeout(() => ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus(), 20);
  }, []);
  // positions are relative to the Helm root, so render a Popover as a direct child of it
  // (never inside the top bar, whose box would size and clip it)
  return (
    <div ref={ref} className="pop" role="dialog" aria-label={label} style={{ width, left: pos?.left ?? -9999, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }}>
      {children}
    </div>
  );
}

// ───────────── confirm / reason prompts (a tiny store rendered by <DialogHost/>) ─────────────

interface DialogReq {
  id: number;
  kind: "confirm" | "reason";
  title: string;
  body?: string;
  ok?: string;
  danger?: boolean;
  placeholder?: string;
  hint?: string;
  optional?: boolean;
  resolve: (v: string | boolean | null) => void;
}
let dialogs: DialogReq[] = [];
let dialogSeq = 0;
const dialogSubs = new Set<() => void>();
const emitDialogs = () => dialogSubs.forEach((f) => f());

export function askConfirm(o: { title: string; body?: string; ok?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((res) => {
    dialogs = [...dialogs, { id: ++dialogSeq, kind: "confirm", ...o, resolve: (v) => res(v === true) }];
    emitDialogs();
  });
}
/** Ask for a reason. Resolves with the trimmed text, or null when cancelled. */
export function askReason(o: { title: string; body?: string; ok?: string; placeholder?: string; hint?: string; optional?: boolean; danger?: boolean }): Promise<string | null> {
  return new Promise((res) => {
    dialogs = [...dialogs, { id: ++dialogSeq, kind: "reason", ...o, resolve: (v) => res(typeof v === "string" ? v : null) }];
    emitDialogs();
  });
}

export function DialogHost() {
  const list = useSyncExternalStore(
    (f) => {
      dialogSubs.add(f);
      return () => dialogSubs.delete(f);
    },
    () => dialogs,
  );
  const top = list[list.length - 1];
  if (!top) return null;
  return <DialogView key={top.id} d={top} />;
}

function DialogView({ d }: { d: DialogReq }) {
  const [text, setText] = useState("");
  const done = (v: string | boolean | null) => {
    dialogs = dialogs.filter((x) => x.id !== d.id);
    emitDialogs();
    d.resolve(v);
  };
  const ok = () => {
    if (d.kind === "confirm") return done(true);
    const t = text.trim();
    if (!t && !d.optional) return;
    done(t);
  };
  return (
    <Modal label={d.title} cls="md" onClose={() => done(d.kind === "confirm" ? false : null)}>
      <ModalHead title={d.title} onClose={() => done(d.kind === "confirm" ? false : null)} />
      <div className="mbody">
        <div className="pad col" style={{ gap: 10, color: "var(--h-fg-2)", lineHeight: 1.55 }}>
          {d.body ? (
            <div style={{ whiteSpace: "pre-wrap" }}>
              <Fmt text={d.body} />
            </div>
          ) : null}
          {d.kind === "reason" ? (
            <>
              <textarea
                className="textarea"
                style={{ minHeight: 110 }}
                placeholder={d.placeholder ?? ""}
                value={text}
                aria-label={d.title}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ok();
                }}
              />
              <span className="hint-t">{d.hint ?? (d.optional ? "Optional. It is recorded in the Ledger." : "Required. It is recorded in the Ledger and delivered to the lead, the manager and the Orchestrator.")}</span>
            </>
          ) : null}
        </div>
      </div>
      <div className="mfoot">
        <span className="grow" />
        <button type="button" className="btn" onClick={() => done(d.kind === "confirm" ? false : null)}>
          Cancel
        </button>
        <button type="button" className={cx("btn", d.danger ? "danger" : "primary")} disabled={d.kind === "reason" && !d.optional && !text.trim()} onClick={ok}>
          {d.ok ?? "OK"}
        </button>
      </div>
    </Modal>
  );
}
