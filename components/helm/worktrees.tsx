// The Git agent's Worktrees view: every app of the run with its worktrees and branches, what
// each worktree is doing (agents running in it, being edited, idle), and the space it all takes.
// Click an app to see each worktree and branch. Sizes are measured on the host in the background.

import { useCallback, useEffect, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useHelm } from "./ctx.tsx";
import { Banner, Ic, Modal, ModalHead, cx } from "./ui.tsx";
import { agoOf, errMsg } from "./format.ts";
import "./worktrees.css";

type Role = "checkout" | "work" | "lane" | "extra";
type State = "running" | "editing" | "idle" | "missing";
interface Row {
  path: string;
  role: Role;
  branch: string | null;
  head: string | null;
  dirty: number;
  missing: boolean;
  agents: Array<{ id: string; label: string; status: string }>;
  state: State;
  bytes: number | null;
}
interface Branch {
  name: string;
  kind: "main" | "work" | "agent" | "other";
  worktree: string | null;
}
interface App {
  appId: string;
  name: string;
  stage: string;
  repo: string | null;
  work: string | null;
  branch: string | null;
  mainBranch: string;
  worktrees: Row[];
  branches: Branch[];
  store: { path: string | null; bytes: number | null; sharedWith: string[] } | null;
  total: number | null;
  extra: number;
  legacy: boolean;
  error: string | null;
}
interface View {
  cap: number;
  apps: App[];
  disks: Array<{ dev: number; free: number | null; total: number | null; apps: string[] }>;
  total: number | null;
  measuredAt: number | null;
  measuring: boolean;
}

const ROLE: Record<Role, string> = { checkout: "Main checkout (yours)", work: "Work worktree", lane: "Lane", extra: "Extra worktree" };
const ROLE_HINT: Record<Role, string> = {
  checkout: "Your own folder. Agents never work here.",
  work: "Where every agent of the app works, on the work branch.",
  lane: "A parallel worktree the Git agent added for this app.",
  extra: "Not one of Helm's: an older per-agent worktree, or one made by a person or a tool.",
};
const STATE: Record<State, string> = { running: "Running", editing: "Being edited", idle: "Idle", missing: "Missing on disk" };
const KIND: Record<Branch["kind"], string> = { main: "main", work: "work branch", agent: "agent branch", other: "other" };

export function size(n: number | null | undefined): string {
  if (n === null || n === undefined) return "…";
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 100e9 ? 0 : 1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

export function WorktreesModal() {
  const h = useHelm();
  if (!h.worktreesOpen) return null;
  return <WorktreesInner />;
}

function WorktreesInner() {
  const h = useHelm();
  const nav = useBbNavigate();
  const runId = h.data?.run?.id ?? null;
  const [v, setV] = useState<View | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(
    async (fresh = false) => {
      if (!runId) return;
      try {
        setV((await h.rpc.call("worktrees_view", { runId, measure: true, fresh })) as View);
        setErr(null);
      } catch (e) {
        setErr(errMsg(e));
      }
    },
    [h.rpc, runId],
  );

  useEffect(() => {
    void load();
  }, [load]);
  // while the host measures, look again every few seconds (only while this view is open)
  useEffect(() => {
    if (!v?.measuring) return;
    const t = setTimeout(() => void load(), 4000);
    return () => clearTimeout(t);
  }, [v, load]);

  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const git = Object.values(h.data?.nodes ?? {}).find((n) => n.id === "git");
  const count = v?.apps.reduce((s, a) => s + a.worktrees.length, 0) ?? 0;
  const biggest = Math.max(1, ...(v?.apps.map((a) => a.total ?? 0) ?? [1]));

  return (
    <Modal label="Worktrees" cls="lg" onClose={h.closeWorktrees}>
      <ModalHead title="Worktrees" onClose={h.closeWorktrees}>
        <span className="muted" style={{ fontSize: 12 }}>
          {v ? `${v.apps.length} app${v.apps.length === 1 ? "" : "s"} · ${count} worktree${count === 1 ? "" : "s"} · ${v.total === null ? "measuring…" : `${size(v.total)} in total`} · at most ${v.cap} per project` : "Reading git…"}
        </span>
      </ModalHead>
      {err ? (
        <Banner tone="crit" style={{ margin: "12px 18px" }}>
          Could not read the worktrees: {err}
        </Banner>
      ) : null}
      <div className="mbody wt">
        <div className="wt-top">
          {v?.disks.map((d) => {
            const used = d.total && d.free !== null ? 1 - d.free / d.total : null;
            return (
              <div key={d.dev} className={cx("wt-disk", used !== null && used > 0.9 && "low")} title={`Apps on this disk: ${d.apps.join(", ")}`}>
                <div className="row" style={{ gap: 6 }}>
                  <Ic name="HardDrive" size="sm" />
                  <b>{size(d.free)} free</b>
                  <span className="faint">of {size(d.total)}</span>
                </div>
                <div className="wt-bar">
                  <span style={{ width: `${Math.round((used ?? 0) * 100)}%` }} />
                </div>
                <span className="faint wt-disk-apps">{d.apps.join(", ")}</span>
              </div>
            );
          })}
          <span className="grow" />
          <span className="faint" style={{ fontSize: 11.5 }}>
            {v?.measuring ? "Measuring sizes…" : v?.measuredAt ? `Sizes from ${agoOf(v.measuredAt)}` : ""}
          </span>
          <button type="button" className="btn sm" disabled={!v || v.measuring} onClick={() => void load(true)} title="Measure every worktree again">
            <Ic name="Refresh" size="sm" className={cx(v?.measuring && "spin")} /> Measure again
          </button>
          {git?.threadId ? (
            <button type="button" className="btn sm" onClick={() => nav.toThread(git.threadId!, { split: true })} title="Ask the Git agent to tidy up or free space">
              <Ic name="MessageSquare" size="sm" /> Ask the Git agent
            </button>
          ) : null}
        </div>
        {!v ? (
          <div className="muted" style={{ padding: 18 }}>
            Reading git…
          </div>
        ) : !v.apps.length ? (
          <div className="muted" style={{ padding: 18 }}>
            No apps in this run yet.
          </div>
        ) : (
          v.apps.map((a) => {
            const isOpen = open.has(a.appId);
            const running = a.worktrees.filter((w) => w.state === "running").length;
            const editing = a.worktrees.filter((w) => w.state === "editing").length;
            const over = a.worktrees.length > v.cap;
            return (
              <section key={a.appId} className={cx("wt-app", isOpen && "open")}>
                <button type="button" className="wt-app-h" aria-expanded={isOpen} onClick={() => toggle(a.appId)}>
                  <Ic name={isOpen ? "ChevronDown" : "ChevronRight"} size="sm" />
                  <b className="wt-name">{a.name}</b>
                  {a.stage ? <span className="pill">{a.stage}</span> : null}
                  <span className={cx("pill", over && "crit")} title={`${a.worktrees.length} of at most ${v.cap} worktrees`}>
                    {a.worktrees.length} / {v.cap} worktrees
                  </span>
                  {running ? <span className="pill ok">{running} running</span> : null}
                  {editing ? <span className="pill warn">{editing} being edited</span> : null}
                  {a.legacy ? <span className="pill warn">one per agent</span> : null}
                  <span className="grow" />
                  <span className="wt-size">{a.repo ? size(a.total) : "no repository yet"}</span>
                  <span className="wt-mini" aria-hidden>
                    <span style={{ width: `${Math.round(((a.total ?? 0) / biggest) * 100)}%` }} />
                  </span>
                </button>
                {isOpen ? <AppDetail a={a} /> : null}
              </section>
            );
          })
        )}
        <p className="faint wt-foot">
          Each project has two branches, {v?.apps[0]?.mainBranch ?? "main"} and its work branch. A branch takes no space of its own: its commits live in the repository's git storage, which every branch and worktree shares. What takes space is each worktree's files (with its build output) and that storage. The Git agent keeps each project within {v?.cap ?? 10} worktrees (Settings → Worktrees per project) and frees space when a disk runs low.
        </p>
      </div>
    </Modal>
  );
}

function AppDetail({ a }: { a: App }) {
  return (
    <div className="wt-detail">
      {a.error ? <div className="warn">Could not list worktrees: {a.error}</div> : null}
      <table className="wt-table">
        <thead>
          <tr>
            <th>Worktree</th>
            <th>State</th>
            <th>Branch</th>
            <th>Agents</th>
            <th className="num">Size</th>
          </tr>
        </thead>
        <tbody>
          {a.worktrees.map((w) => (
            <tr key={w.path}>
              <td>
                <div title={ROLE_HINT[w.role]}>
                  <b>{ROLE[w.role]}</b>
                </div>
                <div className="mono faint wt-path" title={w.path}>
                  {w.path}
                </div>
              </td>
              <td>
                <span className={cx("wt-state", w.state)}>
                  {STATE[w.state]}
                  {w.state === "editing" ? ` (${w.dirty} file${w.dirty === 1 ? "" : "s"})` : ""}
                </span>
                {w.state === "running" && w.dirty ? <div className="faint">{w.dirty} uncommitted</div> : null}
              </td>
              <td className="mono">
                {w.branch ?? "detached"}
                <div className="faint">{w.head?.slice(0, 9) ?? ""}</div>
              </td>
              <td>{w.agents.length ? w.agents.map((x) => <div key={x.id}>{x.label}</div>) : <span className="faint">none</span>}</td>
              <td className="num">{w.missing ? "–" : size(w.bytes)}</td>
            </tr>
          ))}
          {a.store ? (
            <tr className="wt-store">
              <td colSpan={4}>
                <b>Git storage</b> <span className="faint">(every branch's commits; shared by all worktrees{a.store.sharedWith.length ? ` and with ${a.store.sharedWith.join(", ")}` : ""})</span>
                {a.store.path ? (
                  <div className="mono faint wt-path" title={a.store.path}>
                    {a.store.path}
                  </div>
                ) : null}
              </td>
              <td className="num">{size(a.store.bytes)}</td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <div className="wt-branches">
        <b>Branches</b>
        {a.branches.map((b) => (
          <div key={b.name} className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <code>{b.name}</code>
            <span className={cx("pill", b.kind === "agent" && "warn")}>{KIND[b.kind]}</span>
            <span className="faint">{b.worktree ? `checked out in ${a.worktrees.find((w) => w.path === b.worktree)?.role === "checkout" ? "your checkout" : b.worktree}` : "no worktree: no space of its own"}</span>
            {b.kind === "agent" ? <span className="faint">· the Git agent deletes it once merged</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
