// The GitHub tab beside Worktrees: for every app, what its remote (GitHub or any other) has and
// what it does not, without downloading anything (Helm asks the remote only for its branch names
// and commits). One row per app; click it for each branch: same on both, commits not on GitHub
// yet, newer on GitHub, only on this Mac, only on GitHub. It is read when this tab opens and what
// Helm kept is older than 15 minutes, or with Check GitHub; never in the background.

import { useCallback, useEffect, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useHelm } from "./ctx.tsx";
import { Banner, Ic, cx } from "./ui.tsx";
import { agoOf, errMsg } from "./format.ts";

type State = "synced" | "ahead" | "behind" | "diverged" | "newer" | "local" | "remote";
type Kind = "main" | "work" | "agent" | "other";
interface Branch {
  name: string;
  kind: Kind;
  state: State;
  local: string | null;
  remote: string | null;
  ahead: number | null;
  behind: number | null;
  at: number | null;
}
interface App {
  appId: string;
  name: string;
  repo: string | null;
  remote: string | null;
  url: string | null;
  web: string | null;
  defaultBranch: string | null;
  error: string | null;
  uncommitted: number;
  branches: Branch[];
  counts: { synced: number; toPush: number; commitsToPush: number; safeHere: number; onlyRemote: number; newer: number };
}
interface View {
  apps: App[];
  checkedAt: number | null;
  checking: boolean;
  totals: { apps: number; onRemote: number; noRemote: number; toPush: number; commitsToPush: number; newer: number };
}

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const HERE = IS_MAC ? "this Mac" : "this computer";
const KIND: Record<Kind, string> = { main: "main", work: "work branch", agent: "agent branch", other: "other" };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "https://github.com/owner/repo" → "github.com/owner/repo". */
const short = (web: string) => web.replace(/^https?:\/\//, "");

function stateText(b: Branch, remoteName: string): { text: string; tone: "ok" | "warn" | "crit" | "info" | "" } {
  switch (b.state) {
    case "synced":
      return { text: "Same on both", tone: "ok" };
    case "ahead":
      return { text: `${plural(b.ahead ?? 0, "commit")} not on ${remoteName} yet`, tone: "warn" };
    case "behind":
      return { text: `${remoteName} has ${plural(b.behind ?? 0, "newer commit")}`, tone: "info" };
    case "diverged":
      return { text: `Both changed: ${b.ahead} here, ${b.behind} on ${remoteName}`, tone: "crit" };
    case "newer":
      return { text: `${remoteName} has commits ${HERE} has never seen`, tone: "info" };
    case "local":
      return b.ahead === 0 ? { text: `Only on ${HERE}; its commits are all on ${remoteName}`, tone: "" } : { text: `Only on ${HERE}: ${b.ahead === null ? "its commits" : plural(b.ahead, "commit")} on no ${remoteName} branch`, tone: "warn" };
    case "remote":
      return { text: `Only on ${remoteName}`, tone: "info" };
  }
}

export function GithubBody() {
  const h = useHelm();
  const nav = useBbNavigate();
  const runId = h.data?.run?.id ?? null;
  const [v, setV] = useState<View | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(
    async (refresh?: "open" | "now") => {
      if (!runId) return;
      try {
        setV((await h.rpc.call("github_view", { runId, ...(refresh ? { refresh } : {}) })) as View);
        setErr(null);
      } catch (e) {
        setErr(errMsg(e));
      }
    },
    [h.rpc, runId],
  );
  useEffect(() => {
    void load("open");
  }, [load]);
  // while the remotes are read, pick up the result (only while this tab is open)
  useEffect(() => {
    if (!v?.checking) return;
    const t = setTimeout(() => void load(), 2500);
    return () => clearTimeout(t);
  }, [v, load]);

  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const reveal = async (path: string) => {
    if (!runId) return;
    await h.rpc.call("worktrees_reveal", { runId, path }).catch(() => undefined);
  };
  const known = !!v?.checkedAt;

  return (
    <div className="mbody wt">
      {err ? <Banner tone="crit">Could not read the remotes: {err}</Banner> : null}
      <div className="gh-sum">
        <div className="gh-tile">
          <b>{known ? v!.totals.onRemote : "…"}</b>
          <span>on GitHub</span>
        </div>
        <div className={cx("gh-tile", known && v!.totals.noRemote > 0 && "warn")}>
          <b>{known ? v!.totals.noRemote : "…"}</b>
          <span>with no remote</span>
        </div>
        <div className={cx("gh-tile", known && v!.totals.toPush > 0 && "warn")}>
          <b>{known ? v!.totals.commitsToPush : "…"}</b>
          <span>commits not on GitHub{known ? ` (${plural(v!.totals.toPush, "branch", "branches")})` : ""}</span>
        </div>
        <div className="gh-tile">
          <b>{known ? v!.totals.newer : "…"}</b>
          <span>branches newer on GitHub</span>
        </div>
      </div>
      <div className="wt-actions">
        <span className="faint wt-checked">
          {v?.checking ? (
            <>
              <Ic name="Refresh" size="sm" className="spin" /> Asking GitHub for its branches…
            </>
          ) : v?.checkedAt ? (
            `Checked ${agoOf(v.checkedAt)} · branch names and commits only, nothing downloaded`
          ) : (
            "Nothing downloaded: Helm asks each remote only for its branch names and commits."
          )}
        </span>
        <span className="grow" />
        <button type="button" className="btn sm" disabled={!v || v.checking} onClick={() => void load("now")} title="Ask every app's remote for its branches again">
          <Ic name="Refresh" size="sm" /> Check GitHub
        </button>
      </div>

      <div className="wt-list" role="table" aria-label="Apps on GitHub">
        <div className="wt-row gh-row wt-head" role="row">
          <span />
          <span role="columnheader">App</span>
          <span role="columnheader">On GitHub</span>
          <span role="columnheader">Not on GitHub</span>
          <span role="columnheader">Newer on GitHub</span>
          <span role="columnheader">Repository</span>
          <span />
        </div>
        {!v ? (
          <div className="muted wt-empty">Opening…</div>
        ) : !v.apps.length ? (
          <div className="muted wt-empty">No apps in this run yet.</div>
        ) : (
          v.apps.map((a) => {
            const isOpen = open.has(a.appId);
            const checked = known && (a.remote !== null || a.error !== null || a.branches.length > 0);
            const notOn = [a.counts.toPush ? `${plural(a.counts.commitsToPush, "commit")} on ${plural(a.counts.toPush, "branch", "branches")}` : "", a.uncommitted ? `${plural(a.uncommitted, "uncommitted file")}` : ""].filter(Boolean);
            return (
              <section key={a.appId} className={cx("wt-app", isOpen && "open", a.error && "bad")} role="rowgroup">
                <div className="wt-row gh-row" role="row">
                  <button type="button" className="iconbtn sm wt-chev" aria-expanded={isOpen} aria-label={`${isOpen ? "Hide" : "Show"} ${a.name}'s branches`} onClick={() => toggle(a.appId)} disabled={!a.branches.length}>
                    <Ic name={isOpen ? "ChevronDown" : "ChevronRight"} size="sm" />
                  </button>
                  <button type="button" className="wt-namecell" onClick={() => toggle(a.appId)} role="cell">
                    <b className="wt-ellip">{a.name}</b>
                    {a.error ? <span className="wt-err wt-ellip">{a.error}</span> : !a.repo ? <span className="faint">no repository yet</span> : known && !a.remote ? <span className="wt-err">no remote: nothing of it is on GitHub</span> : null}
                  </button>
                  <span role="cell">{!a.repo || !known ? <span className="faint">{a.repo ? "…" : ""}</span> : a.remote ? <span className="pill ok">{plural(a.counts.synced, "branch", "branches")} the same</span> : <span className="faint">–</span>}</span>
                  <span role="cell">
                    {!checked ? null : notOn.length ? (
                      notOn.map((t) => (
                        <span key={t} className="gh-line warn">
                          {t}
                        </span>
                      ))
                    ) : (
                      <span className="faint">nothing</span>
                    )}
                  </span>
                  <span role="cell">{!checked || !a.remote ? null : a.counts.newer || a.counts.onlyRemote ? <span className="pill run">{plural(a.counts.newer + a.counts.onlyRemote, "branch", "branches")}</span> : <span className="faint">nothing</span>}</span>
                  <span role="cell" className="wt-ellip">
                    {a.web ? (
                      <span className="mono gh-repo" title={a.url ?? a.web}>
                        {short(a.web)}
                      </span>
                    ) : a.url ? (
                      <span className="mono gh-repo" title={a.url}>
                        {a.url}
                      </span>
                    ) : null}
                  </span>
                  <span role="cell" className="gh-acts">
                    {a.web ? (
                      <button type="button" className="btn sm" onClick={() => nav.openUrl(a.web!)} title={`Open ${short(a.web)}`}>
                        <Ic name="ExternalLink" size="sm" />
                        <span className="btn-lbl"> Open on GitHub</span>
                      </button>
                    ) : null}
                    {a.repo ? (
                      <button type="button" className="iconbtn sm" onClick={() => void reveal(a.repo!)} title={IS_MAC ? "Show in Finder" : "Show in folder"} aria-label={`Show ${a.name} in Finder`}>
                        <Ic name="FolderOpen" size="sm" />
                      </button>
                    ) : null}
                  </span>
                </div>
                {isOpen ? <Branches a={a} /> : null}
              </section>
            );
          })
        )}
      </div>
      <p className="faint wt-foot">
        Helm reads only the list of each remote's branches and the commit each points at (<code>git ls-remote</code>), with the login git already has; nothing is downloaded and Helm never sees a password or token. "Not on GitHub" counts commits on {HERE} that no GitHub branch has, and uncommitted files, which are on no branch at all. Ask the Git agent to push what should be there; it never force-pushes.
      </p>
    </div>
  );
}

function Branches({ a }: { a: App }) {
  const remoteName = a.web && /github\.com/.test(a.web) ? "GitHub" : a.remote ?? "the remote";
  return (
    <div className="wt-detail">
      <table className="wt-table">
        <thead>
          <tr>
            <th>Branch</th>
            <th>On {HERE}</th>
            <th>On {remoteName}</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {a.branches.map((b) => {
            const s = stateText(b, remoteName);
            return (
              <tr key={b.name}>
                <td>
                  <code className="wt-ellip">{b.name}</code>
                  <div>
                    <span className={cx("pill", b.kind === "agent" && "warn")}>{KIND[b.kind]}</span>
                    {b.name === a.defaultBranch ? <span className="faint"> · default on {remoteName}</span> : null}
                  </div>
                </td>
                <td className="mono">
                  {b.local ? b.local.slice(0, 9) : <span className="faint">–</span>}
                  {b.at ? <div className="faint">{agoOf(b.at)}</div> : null}
                </td>
                <td className="mono">{b.remote ? b.remote.slice(0, 9) : <span className="faint">–</span>}</td>
                <td>
                  <span className={cx("gh-state", s.tone)}>{s.text}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
