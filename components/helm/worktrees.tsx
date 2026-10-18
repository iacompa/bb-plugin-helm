// The Git agent's Worktrees view: one row per app with how many branches and worktrees it has,
// the space it takes, which disk it is on (an external SSD or this computer's own) and a button
// that shows its folder in Finder. Click an app for each worktree and branch. It opens at once
// with what Helm last read; git is read again in the background (on open when older than a few
// minutes, every 30 minutes, or with Check now). This run's branch and worktree limits are set here.

import { useCallback, useEffect, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useHelm } from "./ctx.tsx";
import { Banner, Ic, Modal, ModalHead, cx } from "./ui.tsx";
import { agoOf, errMsg } from "./format.ts";
import { GithubBody } from "./github.tsx";
import "./worktrees.css";

type Role = "checkout" | "work" | "lane" | "extra";
type State = "running" | "editing" | "idle" | "missing";
interface Disk {
  name: string;
  external: boolean;
}
interface Row {
  path: string;
  role: Role;
  branch: string | null;
  head: string | null;
  dirty: number;
  missing: boolean;
  agents: Array<{ id: string; label: string; status: string }>;
  state: State;
  disk: Disk;
  bytes: number | null;
}
interface Branch {
  name: string;
  kind: "main" | "work" | "lane" | "helm" | "agent" | "other";
  worktree: string | null;
}
interface App {
  appId: string;
  name: string;
  stage: string;
  repo: string | null;
  repoDisk: Disk | null;
  work: string | null;
  branch: string | null;
  mainBranch: string;
  worktrees: Row[];
  branches: Branch[];
  overBranches: number;
  where: Array<Disk & { bytes: number | null }>;
  store: { path: string | null; bytes: number | null; sharedWith: string[] } | null;
  total: number | null;
  extra: number;
  legacy: boolean;
  error: string | null;
}
interface View {
  cap: number;
  branchCap: number;
  ownLimits: boolean;
  apps: App[];
  disks: Array<Disk & { free: number | null; total: number | null; apps: string[] }>;
  total: number | null;
  checkedAt: number | null;
  measuredAt: number | null;
  checking: boolean;
  measuring: boolean;
  problem: string | null;
}

const ROLE: Record<Role, string> = { checkout: "Your checkout", work: "Work worktree", lane: "Lane", extra: "Extra worktree" };
const ROLE_HINT: Record<Role, string> = {
  checkout: "Your own folder. Agents never work here.",
  work: "Where every agent of the app works, on the work branch.",
  lane: "A parallel worktree the Git agent added for this app.",
  extra: "Not one of Helm's: an older per-agent worktree, or one made by a person or a tool.",
};
const STATE: Record<State, string> = { running: "Running", editing: "Being edited", idle: "Idle", missing: "Missing on disk" };
const KIND: Record<Branch["kind"], string> = { main: "main", work: "work branch", lane: "lane", helm: "Helm branch", agent: "agent branch", other: "yours" };
const KIND_HINT: Record<Branch["kind"], string> = {
  main: "The project's main branch: work reaches it when you sign off.",
  work: "Where every agent of the project commits.",
  lane: "A branch the Git agent made for parallel work, within this run's limit.",
  helm: "A live Helm run's Helm branch or work branch (this run's or another's): kept, never deleted, not part of the limit.",
  agent: "Left by an agent's own worktree; the Git agent deletes it once it is merged.",
  other: "Yours or another tool's: counted, never touched, not part of the limit.",
};

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const FINDER = IS_MAC ? "Show in Finder" : "Show in folder";
const INTERNAL = IS_MAC ? "This Mac" : "This computer";
/** "💾My SSD" → "My SSD"; the computer's own disk → "This Mac". */
const diskName = (d: Disk) => (d.external ? d.name.replace(/^[^\p{L}\p{N}]+/u, "") || d.name : INTERNAL);

export function size(n: number | null | undefined): string {
  if (n === null || n === undefined) return "…";
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 100e9 ? 0 : 1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<"worktrees" | "github">("worktrees");

  const load = useCallback(
    async (refresh?: "open" | "now") => {
      if (!runId) return;
      try {
        setV((await h.rpc.call("worktrees_view", { runId, ...(refresh ? { refresh } : {}) })) as View);
        setErr(null);
      } catch (e) {
        setErr(errMsg(e));
      }
    },
    [h.rpc, runId],
  );

  // once on open (git is read again in the background only when what Helm kept is a few minutes old)
  useEffect(() => {
    void load("open");
  }, [load]);
  // while git is read or sizes measured in the background, pick up the result (only while this view is open)
  useEffect(() => {
    if (!v?.checking && !v?.measuring) return;
    const t = setTimeout(() => void load(), 3000);
    return () => clearTimeout(t);
  }, [v, load]);

  const reveal = useCallback(
    async (path: string) => {
      if (!runId) return;
      try {
        const r = (await h.rpc.call("worktrees_reveal", { runId, path })) as { ok: boolean; shown: string | null };
        setNote(!r.ok ? `Could not open ${path}` : r.shown && r.shown !== path ? `That folder is gone; opened ${r.shown}` : null);
      } catch (e) {
        setNote(errMsg(e));
      }
    },
    [h.rpc, runId],
  );

  const setLimits = useCallback(
    async (input: { branches?: number | null; worktrees?: number | null }) => {
      if (!runId) return;
      try {
        const r = (await h.rpc.call("git_setLimits", { runId, ...input })) as { view: View };
        setV(r.view);
      } catch (e) {
        setNote(errMsg(e));
      }
    },
    [h.rpc, runId],
  );

  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const git = Object.values(h.data?.nodes ?? {}).find((n) => n.id === "git");
  const count = v?.apps.reduce((s, a) => s + a.worktrees.length, 0) ?? 0;
  const known = !!v?.checkedAt;

  return (
    <Modal label="Worktrees" cls="lg" onClose={h.closeWorktrees}>
      <ModalHead title={tab === "github" ? "GitHub" : "Worktrees"} onClose={h.closeWorktrees}>
        <div className="seg" role="tablist" aria-label="View">
          <button type="button" role="tab" aria-selected={tab === "worktrees"} onClick={() => setTab("worktrees")}>
            <Ic name="GitBranch" size="sm" /> Worktrees
          </button>
          <button type="button" role="tab" aria-selected={tab === "github"} onClick={() => setTab("github")} title="What is on GitHub and what is not (nothing downloaded)">
            <Ic name="Globe" size="sm" /> GitHub
          </button>
        </div>
        <span className="muted wt-sub" hidden={tab !== "worktrees"}>
          {v ? (
            <>
              {plural(v.apps.length, "app")}
              {known ? ` · ${plural(count, "worktree")}` : ""}
              {v.total !== null ? ` · ${size(v.total)}` : ""}
            </>
          ) : null}
        </span>
      </ModalHead>
      {tab === "github" ? (
        <GithubBody />
      ) : (
      <div className="mbody wt">
        {err ? <Banner tone="crit">Could not read the worktrees: {err}</Banner> : null}
        {note ? (
          <Banner tone="warn">
            <span className="row" style={{ gap: 8 }}>
              <span className="grow">{note}</span>
              <button type="button" className="iconbtn sm" aria-label="Dismiss" onClick={() => setNote(null)}>
                <Ic name="X" size="sm" />
              </button>
            </span>
          </Banner>
        ) : null}
        {v?.problem ? <Banner tone="warn">The last check had a problem: {v.problem}</Banner> : null}

        <div className="wt-top">
          <div className="wt-disks">
            {v?.disks.map((d) => {
              const used = d.total && d.free !== null ? 1 - d.free / d.total : null;
              return (
                <div key={d.name} className={cx("wt-disk", used !== null && used > 0.9 && "low")} title={`On this disk: ${d.apps.join(", ")}`}>
                  <div className="row" style={{ gap: 6 }}>
                    <Ic name="HardDrive" size="sm" />
                    <b className="wt-ellip">{diskName(d)}</b>
                    <span className="faint">{d.external ? "external" : "internal"}</span>
                  </div>
                  <div className="wt-bar">
                    <span style={{ width: `${Math.round((used ?? 0) * 100)}%` }} />
                  </div>
                  <span className="faint">
                    {d.free !== null ? `${size(d.free)} free of ${size(d.total)}` : "free space after the first measure"} · {plural(d.apps.length, "app")}
                  </span>
                </div>
              );
            })}
          </div>
          {v ? (
            <div className="wt-limits" title="This run's limits. Agents started from now on get them in their briefs, and the Git agent is told at once.">
              <b>This run</b>
              <Stepper label="branches per project" value={v.branchCap} min={2} max={12} onChange={(n) => void setLimits({ branches: n })} />
              <Stepper label="worktrees per project" value={v.cap} min={2} max={32} onChange={(n) => void setLimits({ worktrees: n })} />
              {v.ownLimits ? (
                <button type="button" className="linkbtn" onClick={() => void setLimits({ branches: null, worktrees: null })}>
                  Use the settings
                </button>
              ) : (
                <span className="faint">from Settings</span>
              )}
            </div>
          ) : null}
        </div>

        <div className="wt-actions">
          <span className="faint wt-checked">
            {v?.checking ? (
              <>
                <Ic name="Refresh" size="sm" className="spin" /> Checking git in the background…
              </>
            ) : v?.measuring ? (
              <>
                <Ic name="Refresh" size="sm" className="spin" /> Measuring sizes in the background…
              </>
            ) : v?.checkedAt ? (
              `Checked ${agoOf(v.checkedAt)}${v.measuredAt ? ` · sizes from ${agoOf(v.measuredAt)}` : ""} · checked again every 30 minutes`
            ) : (
              ""
            )}
          </span>
          <span className="grow" />
          <button type="button" className="btn sm" disabled={!v || v.checking || v.measuring} onClick={() => void load("now")} title="Read git and measure every worktree again now">
            <Ic name="Refresh" size="sm" /> Check now
          </button>
          {git?.threadId ? (
            <button type="button" className="btn sm" onClick={() => nav.toThread(git.threadId!, { split: true })} title="Ask the Git agent to tidy up or free space">
              <Ic name="MessageSquare" size="sm" /> Ask the Git agent
            </button>
          ) : null}
        </div>

        <div className="wt-list" role="table" aria-label="Apps">
          <div className="wt-row wt-head" role="row">
            <span />
            <span role="columnheader">App</span>
            <span role="columnheader">Branches</span>
            <span role="columnheader">Worktrees</span>
            <span role="columnheader" className="num">
              Size
            </span>
            <span role="columnheader">Where</span>
            <span />
          </div>
          {!v ? (
            <div className="muted wt-empty">Opening…</div>
          ) : !v.apps.length ? (
            <div className="muted wt-empty">No apps in this run yet.</div>
          ) : (
            v.apps.map((a) => <AppRow key={a.appId} a={a} v={v} known={known} open={open.has(a.appId)} onToggle={() => toggle(a.appId)} onReveal={reveal} />)
          )}
        </div>

        <p className="faint wt-foot">
          Each project has its main branch and its work branch, where every agent commits; this run allows {v ? plural(v.branchCap, "branch", "branches") : "…"} per project, so the Git agent may add {v && v.branchCap > 2 ? `up to ${v.branchCap - 2} lane branches` : "no other branches"} for parallel work. Branches you or other tools made are counted but never touched. A branch takes no space of its own: its commits live in the repository's git storage, which every branch and worktree shares. What takes space is each worktree's files (with its build output) and that storage. The Git agent keeps each project within {v?.cap ?? 10} worktrees and frees space when a disk runs low.
        </p>
      </div>
      )}
    </Modal>
  );
}

function Stepper({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  return (
    <span className="wt-step">
      <button type="button" className="iconbtn sm" aria-label={`Fewer ${label}`} disabled={value <= min} onClick={() => onChange(value - 1)}>
        <Ic name="Minus" size="sm" />
      </button>
      <b className="wt-step-n" aria-live="polite">
        {value}
      </b>
      <button type="button" className="iconbtn sm" aria-label={`More ${label}`} disabled={value >= max} onClick={() => onChange(value + 1)}>
        <Ic name="Plus" size="sm" />
      </button>
      <span>{label}</span>
    </span>
  );
}

function AppRow({ a, v, known, open, onToggle, onReveal }: { a: App; v: View; known: boolean; open: boolean; onToggle: () => void; onReveal: (path: string) => void }) {
  const running = a.worktrees.filter((w) => w.state === "running").length;
  const editing = a.worktrees.filter((w) => w.state === "editing").length;
  const over = a.worktrees.length > v.cap;
  const counts = { lane: 0, agent: 0, other: 0 };
  for (const b of a.branches) if (b.kind === "lane" || b.kind === "agent" || b.kind === "other") counts[b.kind]++;
  const branchHint = [`${a.mainBranch} and ${a.branch ?? "its work branch"}`, counts.lane ? `${counts.lane} lane(s)` : "", counts.agent ? `${counts.agent} agent branch(es) to remove once merged` : "", counts.other ? `${counts.other} of yours (not counted in the limit)` : ""].filter(Boolean).join(" · ");
  const notes = [running ? `${running} running` : "", editing ? `${editing} being edited` : "", a.legacy ? "one worktree per agent" : ""].filter(Boolean);
  return (
    <section className={cx("wt-app", open && "open", a.error && "bad")} role="rowgroup">
      <div className="wt-row" role="row">
        <button type="button" className="iconbtn sm wt-chev" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} ${a.name}'s worktrees and branches`} onClick={onToggle}>
          <Ic name={open ? "ChevronDown" : "ChevronRight"} size="sm" />
        </button>
        <button type="button" className="wt-namecell" onClick={onToggle} role="cell">
          <b className="wt-ellip">{a.name}</b>
          {a.error ? <span className="wt-err wt-ellip">{a.error}</span> : notes.length ? <span className="faint wt-ellip">{notes.join(" · ")}</span> : a.stage ? <span className="faint wt-ellip">{a.stage}</span> : null}
        </button>
        <span role="cell" title={known && !a.error ? branchHint : undefined}>
          {!a.repo ? <span className="faint">no repository yet</span> : !known ? <span className="faint">…</span> : <span className={cx("pill", a.overBranches > 0 && "crit", !a.branches.length && "warn")}>{plural(a.branches.length, "branch", "branches")}</span>}
          {a.overBranches > 0 ? <span className="wt-over">{a.overBranches} over {v.branchCap}</span> : null}
        </span>
        <span role="cell">{!a.repo || !known ? <span className="faint">{a.repo ? "…" : ""}</span> : <span className={cx("pill", over && "crit")} title={`${a.worktrees.length} of at most ${v.cap} worktrees`}>{plural(a.worktrees.length, "worktree")}</span>}</span>
        <span role="cell" className="num wt-size">
          {a.error ? "–" : a.repo ? size(a.total) : ""}
        </span>
        <span role="cell" className="wt-where">
          {a.where.map((d) => (
            <span key={d.name} className={cx("wt-diskchip", d.external ? "ext" : "int")} title={`${d.external ? "External disk" : "This computer's own disk"}${d.bytes !== null ? `: ${size(d.bytes)} of this app` : ""}`}>
              <Ic name="HardDrive" size="sm" />
              {diskName(d)}
              {a.where.length > 1 && d.bytes !== null ? <span className="faint"> {size(d.bytes)}</span> : null}
            </span>
          ))}
        </span>
        <span role="cell">
          {a.repo ? (
            <button type="button" className="btn sm" onClick={() => onReveal(a.repo!)} title={a.error ? "The folder is gone: opens the nearest folder that is still there" : a.repo}>
              <Ic name="FolderOpen" size="sm" />
              <span className="btn-lbl"> {FINDER}</span>
            </button>
          ) : null}
        </span>
      </div>
      {open ? <AppDetail a={a} onReveal={onReveal} /> : null}
    </section>
  );
}

function AppDetail({ a, onReveal }: { a: App; onReveal: (path: string) => void }) {
  return (
    <div className="wt-detail">
      {a.error ? (
        <div className="wt-err">
          {a.error}. {/missing/.test(a.error) ? "Its folder was moved or deleted. Ask the Git agent to find where its work is now (other worktrees of the project may still have it)." : "Ask the Git agent to look into it."}
        </div>
      ) : null}
      {a.worktrees.length ? (
        <table className="wt-table">
          <thead>
            <tr>
              <th>Worktree</th>
              <th>State</th>
              <th>Branch</th>
              <th>Agents</th>
              <th>Where</th>
              <th className="num">Size</th>
              <th />
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
                    {w.state === "editing" ? ` (${plural(w.dirty, "file")})` : ""}
                  </span>
                  {w.state === "running" && w.dirty ? <div className="faint">{w.dirty} uncommitted</div> : null}
                </td>
                <td className="mono">
                  {w.branch ?? "detached"}
                  <div className="faint">{w.head?.slice(0, 9) ?? ""}</div>
                </td>
                <td>{w.agents.length ? w.agents.map((x) => <div key={x.id}>{x.label}</div>) : <span className="faint">none</span>}</td>
                <td className="nowrap">{diskName(w.disk)}</td>
                <td className="num">{w.missing ? "–" : size(w.bytes)}</td>
                <td>
                  <button type="button" className="iconbtn sm" title={FINDER} aria-label={`${FINDER}: ${w.path}`} onClick={() => onReveal(w.path)}>
                    <Ic name="FolderOpen" size="sm" />
                  </button>
                </td>
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
                <td className="nowrap">{a.repoDisk ? diskName(a.repoDisk) : ""}</td>
                <td className="num">{size(a.store.bytes)}</td>
                <td>
                  {a.store.path ? (
                    <button type="button" className="iconbtn sm" title={FINDER} aria-label={`${FINDER}: git storage`} onClick={() => onReveal(a.store!.path!)}>
                      <Ic name="FolderOpen" size="sm" />
                    </button>
                  ) : null}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      ) : null}
      {a.branches.length ? (
        <div className="wt-branches">
          <b>{plural(a.branches.length, "branch", "branches")}</b>
          {a.branches.map((b) => (
            <div key={b.name} className="wt-branch">
              <code className="wt-ellip">{b.name}</code>
              <span className={cx("pill", b.kind === "agent" && "warn", b.kind === "lane" && "run")} title={KIND_HINT[b.kind]}>
                {KIND[b.kind]}
              </span>
              <span className="faint wt-ellip">{b.worktree ? `checked out in ${a.worktrees.find((w) => w.path === b.worktree)?.role === "checkout" ? "your checkout" : b.worktree}` : "no worktree: no space of its own"}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
