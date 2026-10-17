// Start bar: a planned run says plainly that nothing has started, whether it can,
// and starts with one click. The checks are the server's own (run_readiness), and
// "Start" reports the server's answer, so it never claims a start that was refused.
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { errMsg, fmtUnits, forecastNodes, plural } from "./format.ts";
import { useHelm } from "./ctx.tsx";
import { Ic, askConfirm, cx } from "./ui.tsx";
import { planChatRunStarted } from "./wizard.tsx";

type Readiness = { ok: boolean; problems: string[]; notes: string[]; runFolder: string | null };
type StartResult = { ok: boolean; problems: string[]; dryRun: boolean; studioPath: string | null };

/** Start a planned run; returns the server's problems when it refused (nothing started). */
export function useStartRun() {
  const h = useHelm();
  return async (runId: string, dryRun: boolean): Promise<string[] | null> => {
    const r = (await h.rpc.call("run_start", { runId, dryRun })) as StartResult;
    h.refetch();
    h.refreshRuns();
    if (!r?.ok) {
      const problems = r?.problems?.length ? r.problems : ["The server did not say why."];
      toast.error("The run did not start", { description: problems.length > 1 ? `${problems[0]} (+${problems.length - 1} more)` : problems[0] });
      return problems;
    }
    const made = h.runs?.find((x) => x.id === runId)?.createdAt;
    if (!dryRun && made) planChatRunStarted(made);
    toast.success(dryRun ? "Plan created (dry run)" : "Run started", {
      description: dryRun ? "Projects and briefs were written; nothing was spawned." : "The Orchestrator is starting and the first wave of apps is admitted.",
    });
    return null;
  };
}

export function StartBar() {
  const h = useHelm();
  const run = h.data?.run;
  const planning = run?.status === "planning";
  const runId = run?.id ?? null;
  const slotsKey = JSON.stringify(run?.slots ?? null);
  const [ready, setReady] = useState<Readiness | null>(null);
  const [busy, setBusy] = useState<"start" | "dry" | "discard" | null>(null);
  const [open, setOpen] = useState(false);
  const startRun = useStartRun();
  const nodes = useMemo(() => (h.data ? Object.values(h.data.nodes) : []), [h.data]);
  const fc = useMemo(() => (run ? forecastNodes(nodes, run.slots, h.catalog) : null), [nodes, run, h.catalog]);

  useEffect(() => {
    if (!planning || !runId) return;
    let live = true;
    setReady(null);
    h.rpc.call("run_readiness", { runId }).then(
      (r: Readiness) => live && setReady(r),
      (e: unknown) => live && setReady({ ok: false, problems: [`Could not check the plan: ${errMsg(e)}`], notes: [], runFolder: null }),
    );
    return () => {
      live = false;
    };
  }, [h.rpc, planning, runId, slotsKey]);

  if (!run || !planning) return null;
  const problems = ready?.problems ?? [];

  const go = async (dry: boolean) => {
    setBusy(dry ? "dry" : "start");
    try {
      const refused = await startRun(run.id, dry);
      if (refused) {
        setReady((r) => ({ ok: false, problems: refused, notes: r?.notes ?? [], runFolder: r?.runFolder ?? null }));
        setOpen(true);
      }
    } catch (e) {
      toast.error("The run did not start", { description: errMsg(e) });
    } finally {
      setBusy(null);
    }
  };
  const discard = async () => {
    if (!(await askConfirm({ title: "Discard this plan?", body: "Nothing was spawned. The plan is closed as cancelled and leaves the session tabs.", ok: "Discard", danger: true }))) return;
    setBusy("discard");
    try {
      await h.rpc.call("run_finish", { runId: run.id, status: "cancelled" });
      h.refetch();
      h.refreshRuns();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const c = run.counts;
  const status = !ready ? "Checking models and folders…" : ready.ok ? "Models and folders are ready" : `${plural(problems.length, "thing")} to fix before it can start`;
  return (
    <div className={cx("startbar", ready && !ready.ok && "bad")} role="region" aria-label="This run has not started" data-testid="start-bar">
      <div className="sb-row">
        <span className="tile tier">
          <Ic name="Play" />
        </span>
        <div className="grow col" style={{ gap: 2, minWidth: 0 }}>
          <b>{run.dryRun ? "Dry run: nothing has been spawned." : "Not started yet. This is the plan."}</b>
          <span className="hint-t trunc">
            {plural(c.apps, "app")} · {c.total} agents at most, spawned only when needed{fc ? ` · about ${fmtUnits(fc.units)}` : ""} ·{" "}
            <span className={cx(ready && (ready.ok ? "ok-t" : "crit-t"))} aria-live="polite">
              {status}
            </span>
          </span>
        </div>
        <button type="button" className="btn sm ghost" aria-expanded={open} onClick={() => setOpen((x) => !x)}>
          {open ? "Hide details" : "Details"}
        </button>
        <button type="button" className="btn sm" onClick={() => h.openStudio()} title="Which model each role uses">
          <Ic name="Brain" size="sm" /> Models
        </button>
        <button type="button" className="btn primary" disabled={!ready?.ok || !!busy} onClick={() => void go(false)} data-testid="start-run">
          <Ic name="Play" size="sm" /> {busy === "start" ? "Starting…" : "Start run"}
        </button>
      </div>
      {open || (ready && !ready.ok) ? (
        <div className="sb-more">
          {problems.length ? (
            <ul className="sb-list crit-t">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : null}
          {open ? (
            <>
              <ul className="sb-list">
                <li>Starting admits the first wave of apps right away. {run.autoAdvance === "auto" ? "Later waves start on their own as capacity frees up." : "Helm asks you before each later wave (in Needs you)."}</li>
                {ready?.runFolder ? (
                  <li>
                    New app folders and Helm's own notes (<span className="mono">_studio</span>) go under <span className="mono">{ready.runFolder}</span>.
                  </li>
                ) : null}
                {(ready?.notes ?? []).map((n) => (
                  <li key={n}>{n}</li>
                ))}
                <li>Agents see only committed work in existing repositories. Commit anything they should build on before you start.</li>
              </ul>
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn sm" disabled={!ready?.ok || !!busy} onClick={() => void go(true)} title="Create the projects and briefs, but spawn nothing">
                  {busy === "dry" ? "Creating…" : "Dry run"}
                </button>
                <button type="button" className="btn sm danger" disabled={!!busy} onClick={() => void discard()}>
                  <Ic name="X" size="sm" /> Discard plan…
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
