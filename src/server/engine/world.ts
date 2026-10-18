// World state (§8.4): a database read, never a thread scan. helm_world, the
// CLI `world`, PORTFOLIO.md's machine block and the UI snapshot all come from here.

import type { Engine } from "./engine.ts";
import type { AppInfo, DirectiveInfo, NodeInfo, Stage } from "../../shared/types.ts";
import { STAGES } from "../domain/stages.ts";
import { forecast, fmtUnits } from "../domain/models.ts";
import { profileLine } from "../domain/profile.ts";

const age = (e: Engine, ts: number) => Math.max(0, Math.round((e.now() - ts) / 60_000));

export function receiptCounts(d: DirectiveInfo): Record<"queued" | "delivered" | "ack" | "rec" | "failed", number> {
  const c = { queued: 0, delivered: 0, ack: 0, rec: 0, failed: 0 };
  for (const r of d.recipients) c[r.state]++;
  return c;
}

export function world(e: Engine, runId: string, opts: { appsPage?: number } = {}) {
  const run = e.run(runId);
  const plan = e.plan(runId);
  const nodes = e.repo.listNodes(runId);
  const apps = e.repo.listApps(runId);
  const byStatus = (s: string) => nodes.filter((n) => n.status === s).length;
  const fc = forecast(nodes.map((n) => ({ role: n.role, slot: n.slot, model: n.model })), run.slots, e.settings.weights);
  const stages = Object.fromEntries(STAGES.map((s) => [s.id, apps.filter((a) => a.stage === s.id).length])) as Record<Stage, number>;
  const needs = e.repo.listNeeds(runId, "open").map((x) => ({ id: x.id, kind: x.kind, title: x.title, node: x.nodeId, ageMin: age(e, x.createdAt) }));
  const recent = e.repo.listDirectives(runId, 15).map((d) => ({ id: d.id, type: d.type, target: d.targetNodeId, by: d.byNode ?? "human", summary: d.summary, ageMin: age(e, d.ts), receipts: receiptCounts(d) }));
  const touched = nodes.filter((n) => n.touched).map((n) => n.id);
  const policies = e.repo.listPolicies(runId).map((p) => ({ id: p.id, text: p.text, scope: p.scopeNodeId }));
  const page = Math.max(0, opts.appsPage ?? 0);
  const appLine = (a: AppInfo) => {
    const lead = e.leadOf(runId, a.id);
    const blockers = [
      ...e.repo.listNeeds(runId, "open").filter((x) => x.appId === a.id).map((x) => `${x.id} ${x.kind}`),
      ...nodes.filter((n) => n.appId === a.id && n.warning).map((n) => `${n.id}: ${n.warning!.slice(0, 60)}`),
    ].slice(0, 4);
    // where the app lives, so the chain of command can check each agent works in the right place
    const where = { repo: a.repoPath ?? a.targetPath ?? null, existingRepo: a.adopted, helmBranch: a.helmBranch, humanBranch: a.userBranch, reads: a.reads };
    return { id: a.id, name: a.name, profile: profileLine(a), stage: a.stage, status: lead?.status ?? "planned", priority: a.priority, blockers, where };
  };
  const pageApps = (ids: string[]) => ids.slice(page * 30, page * 30 + 30);
  const managers = plan.managers.map((m) => ({ id: m.id, name: m.name, apps: pageApps(m.appIds).map((id) => apps.find((a) => a.id === id)).filter((a): a is AppInfo => !!a).map(appLine) }));
  const direct = plan.directAppIds.length || plan.rule !== "C3" ? { id: "orch", name: "Direct reports", apps: pageApps(plan.rule === "C3" ? plan.directAppIds : apps.map((a) => a.id)).map((id) => apps.find((a) => a.id === id)).filter((a): a is AppInfo => !!a).map(appLine) } : null;
  return {
    run: {
      name: run.name,
      status: run.status,
      apps: apps.length,
      managers: plan.managers.length,
      agents: { spawned: nodes.filter((n) => n.threadId).length, running: byStatus("running"), queued: byStatus("queued"), planned: byStatus("planned"), cap: run.limits.maxTotalAgents },
      spend: { units: Math.round(e.spend(runId) * 100) / 100, forecast: Math.round(fc.units * 100) / 100, cap: run.budgetCap },
      spawnsPaused: run.spawnsPaused,
      autoAdvance: run.autoAdvance,
    },
    stages,
    needs,
    recentDirectives: recent,
    touched: { count: touched.length, nodes: touched.slice(0, 40) },
    policies,
    managers: direct ? [...managers, direct] : managers,
    // omitted, never undefined: RPC results must be plain JSON (BB rejects undefined values)
    ...(apps.length > 30 ? { appsPage: { page, pages: Math.ceil(apps.length / 30) } } : {}),
  };
}

/** The machine-written block of PORTFOLIO.md. */
export function worldBlock(e: Engine, runId: string): string {
  const w = world(e, runId);
  const L: string[] = [];
  L.push(`Run ${w.run.name} — ${w.run.status}${w.run.spawnsPaused ? " · SPAWNS PAUSED" : ""} · ${w.run.apps} apps · ${w.run.agents.spawned} agents spawned (${w.run.agents.running} running) · spend ${fmtUnits(w.run.spend.units)} of ${fmtUnits(w.run.spend.cap)}`);
  L.push(`Stages: ${Object.entries(w.stages).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}`);
  if (w.needs.length) L.push(`Needs the human: ${w.needs.map((x) => `${x.id} ${x.kind} — ${x.title}`).slice(0, 8).join("; ")}`);
  if (w.recentDirectives.length) L.push("Recent directives (by the human unless a supervisor is named):", ...w.recentDirectives.slice(0, 8).map((d) => `- ${d.id} ${d.summary}`));
  if (w.policies.length) L.push("Standing policies:", ...w.policies.map((p) => `- ${p.id} (${p.scope}): ${p.text}`));
  for (const m of w.managers) L.push(`${m.name}: ${m.apps.map((a) => `${a.name} ${a.stage}${a.blockers.length ? ` [${a.blockers.length} blockers]` : ""}`).join(", ")}`);
  return L.join("\n");
}

/** Rolled-up state of the apps under a manager or the Orchestrator (helm_digest). */
export function digest(e: Engine, n: NodeInfo): string {
  const nodes = e.repo.listNodes(n.runId);
  const appIds = new Set(nodes.filter((x) => x.parentId === n.id && x.tier === "lead").map((x) => x.appId!).filter(Boolean));
  if (n.role === "orch") for (const a of e.repo.listApps(n.runId)) appIds.add(a.id);
  const lines = [...appIds].map((id) => {
    const a = e.repo.getApp(n.runId, id)!;
    const squad = nodes.filter((x) => x.appId === id);
    const running = squad.filter((x) => x.status === "running").length;
    const done = squad.filter((x) => x.status === "done").length;
    const warn = squad.filter((x) => x.warning).map((x) => `${x.id}: ${x.warning!.slice(0, 60)}`);
    const last = e.repo.commsFor(n.runId, e.leadOf(n.runId, id)?.id ?? "", 1)[0];
    return `- ${a.name}: ${a.stage} (round ${a.fixRound}) · ${running} running · ${done}/${squad.length} done${warn.length ? ` · ${warn.slice(0, 2).join("; ")}` : ""}${last ? ` · last: ${last.summary.slice(0, 100)}` : ""}`;
  });
  const fyi = e.repo.unflushedInbox(n.runId, n.id);
  return [`Apps under ${e.label(n)}:`, ...lines, ...(fyi.length ? ["", "Unread FYI:", ...fyi.slice(-10).map((l) => `- ${l.text}`)] : [])].join("\n").slice(0, 6000);
}

/** helm_context (≤ 2 KB). */
export function context(e: Engine, n: NodeInfo): string {
  const parent = n.parentId ? e.repo.getNode(n.runId, n.parentId) : null;
  const children = e.repo.childrenOf(n.runId, n.id);
  const unacked = e.repo.unackedFor(n.runId, n.id);
  const policies = e.policiesFor(n.runId, n.id);
  const app = n.appId ? e.repo.getApp(n.runId, n.appId) : n.alsoLead ? e.repo.listApps(n.runId)[0] : null;
  const extra = app ? e.repo.appExtra(n.runId, app.id) : null;
  const run = e.run(n.runId);
  const running = e.repo.countRunning();
  const fyi = e.repo.unflushedInbox(n.runId, n.id);
  const L = [
    `You: ${e.label(n)} (${n.id}), ${n.status}, brief v${n.briefVersion}${n.branch ? `, branch ${n.branch}` : ""}.`,
    `Parent: ${parent ? `${e.label(parent)} (${parent.id})` : "the human"}.`,
    children.length ? `Children: ${children.map((c) => `${c.id} ${c.status}`).join(", ")}.` : "",
    app ? `App ${app.name} (appId ${app.id}): stage ${app.stage}, CONTRACT v${extra!.contractVersion}, integration ${extra!.integrationBranch ?? "—"}${extra!.integrationHead ? ` @ ${extra!.integrationHead.slice(0, 9)}` : ""}, fix round ${app.fixRound}/${run.limits.fixRounds}.` : "",
    unacked.length ? `Unacknowledged directives (call helm_ack): ${unacked.map((r) => `${r.directiveId}: ${r.notice.slice(0, 140)}`).join(" | ")}` : "No directives waiting for your ack.",
    policies.length ? `Standing policies: ${policies.map((p) => `${p.id} ${p.text.slice(0, 160)}`).join(" | ")}` : "",
    fyi.length ? `Unread FYI: ${fyi.slice(-5).map((l) => l.text.slice(0, 160)).join(" | ")}` : "",
    `Capacity: ${running}/${run.limits.concurrency} running${run.spawnsPaused ? ", spawns paused" : ""}.`,
  ].filter(Boolean);
  if (fyi.length) e.repo.markInboxFlushed(fyi.map((l) => l.id));
  return L.join("\n").slice(0, 2048);
}

/** Everything the UI needs for one run, normalized. Patches arrive over realtime after this. */
export function snapshot(e: Engine, runId: string) {
  const run = e.run(runId);
  const plan = e.plan(runId);
  const nodes = e.repo.listNodes(runId).map((n) => ({ ...n, label: e.label(n), model: n.model ?? e.effectiveModel(run, n) }));
  return {
    run: { ...run, spend: e.spend(runId), rule: plan.rule, grouping: plan.grouping, why: plan.why, counts: plan.counts },
    managers: plan.managers,
    apps: e.repo.listApps(runId).map((a) => ({ ...a, ...e.repo.appExtra(runId, a.id) })),
    nodes,
    directives: e.repo.listDirectives(runId, 300),
    needs: e.repo.listNeeds(runId),
    policies: e.repo.listPolicies(runId, true),
    findings: e.repo.findings(runId),
    outboxFailed: e.repo.outboxForRun(runId, ["failed"]).map((o) => ({ id: o.id, kind: o.kind, nodeId: o.nodeId, lastError: o.lastError, attempts: o.attempts })),
  };
}
