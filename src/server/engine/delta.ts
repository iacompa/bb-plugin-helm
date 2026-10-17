// Changing the plan mid-run (§4.5): add apps, drop apps, change shapes.
// Live reporting lines are never rebalanced (V10): new apps join a manager with
// room, else attach to the Orchestrator, else get a new manager if the span allows.

import type { NodeInfo, PortfolioApp, Shape } from "../../shared/types.ts";
import { HelmError, type Engine } from "./engine.ts";
import { leadIdFor, nodeIdFor, ORCH_ID, slugify, squadFor, type PlannedApp, type PlannedNode, type TopologyPlan } from "../domain/topology.ts";
import { scopeFor, slotOfRole, tierOfRole } from "../domain/roles.ts";
import { bottomUp } from "../domain/directives.ts";

export interface PlanDelta {
  add?: PortfolioApp[];
  drop?: string[];
  shapes?: Record<string, Shape>;
}

export function validateDelta(e: Engine, runId: string, delta: PlanDelta): { ok: true; summary: string; agents: number } | { ok: false; error: string } {
  const run = e.run(runId);
  const plan = e.plan(runId);
  const apps = e.repo.listApps(runId);
  for (const id of delta.drop ?? []) if (!apps.find((a) => a.id === id)) return { ok: false, error: `No app ${id} to drop.` };
  for (const id of Object.keys(delta.shapes ?? {})) if (!apps.find((a) => a.id === id)) return { ok: false, error: `No app ${id} to reshape.` };
  let agents = 0;
  for (const a of delta.add ?? []) agents += 1 + squadFor(a.shape ?? "full", a.platforms, !!a.test).length;
  for (const [id, shape] of Object.entries(delta.shapes ?? {})) {
    const app = apps.find((x) => x.id === id)!;
    agents += squadFor(shape, app.platforms, app.test).length - squadFor(app.shape, app.platforms, app.test).length;
  }
  const total = e.repo.listNodes(runId).length + agents;
  if (total > run.limits.maxTotalAgents) return { ok: false, error: `The plan would have ${total} agents, over the cap of ${run.limits.maxTotalAgents}.` };
  const addN = delta.add?.length ?? 0;
  if (addN) {
    const room = plan.managers.reduce((s, m) => s + Math.max(0, run.limits.managerSpan - m.appIds.length), 0);
    const topRoom = run.limits.orchestratorSpan - plan.managers.length - plan.directAppIds.length - (plan.rule === "C3" ? 0 : apps.length);
    const newManagers = Math.max(0, Math.ceil(Math.max(0, addN - room - Math.max(0, topRoom)) / run.limits.managerSpan));
    if (plan.rule === "C1") return { ok: false, error: "This run has a single app led by the Orchestrator; start a new run for more apps." };
    if (addN > room + Math.max(0, topRoom) && plan.managers.length + plan.directAppIds.length + newManagers > run.limits.orchestratorSpan)
      return { ok: false, error: `No room: managers are full and the Orchestrator's span of ${run.limits.orchestratorSpan} is used. Raise the spans or start a second run.` };
  }
  const parts: string[] = [];
  if (addN) parts.push(`add ${delta.add!.map((a) => a.name).join(", ")}`);
  if (delta.drop?.length) parts.push(`drop ${delta.drop.join(", ")}`);
  for (const [id, s] of Object.entries(delta.shapes ?? {})) parts.push(`${id} → ${s}`);
  return { ok: true, summary: parts.join("; "), agents };
}

export async function applyDelta(e: Engine, runId: string, delta: PlanDelta): Promise<string> {
  const v = validateDelta(e, runId, delta);
  if (!v.ok) throw new HelmError(v.error, "invalid_plan");
  const run = e.run(runId);
  const plan: TopologyPlan = JSON.parse(JSON.stringify(e.plan(runId)));
  e.repo.tx(() => {
    const existing = new Set(e.repo.listApps(runId).map((a) => a.id));
    let order = e.repo.listApps(runId).length;
    for (const a of delta.add ?? []) {
      let id = slugify(a.name);
      for (let k = 2; existing.has(id); k++) id = `${slugify(a.name)}-${k}`;
      existing.add(id);
      const shape = a.shape ?? "full";
      // placement: a manager with room (same group first), else the Orchestrator, else a new manager
      let parent: string = ORCH_ID;
      const withRoom = plan.managers.filter((m) => m.appIds.length < run.limits.managerSpan);
      const sameGroup = withRoom.find((m) => a.group && m.name.toLowerCase() === a.group.toLowerCase());
      const top = plan.managers.length + plan.directAppIds.length + (plan.rule === "C3" ? 0 : plan.apps.length);
      if (sameGroup ?? withRoom[0]) parent = (sameGroup ?? withRoom[0]).id;
      else if (top < run.limits.orchestratorSpan) {
        parent = ORCH_ID;
        if (plan.rule === "C3") plan.directAppIds.push(id);
      } else {
        const mid = `m${plan.managers.length}`;
        plan.managers.push({ id: mid, name: a.group ?? `Group ${plan.managers.length + 1}`, appIds: [] });
        e.repo.insertNode({ runId, id: mid, appId: null, tier: "manager", role: "mgr", platform: null, parentId: ORCH_ID, slot: "manager", alsoLead: false, model: run.slots.manager ?? null, scopeGlobs: scopeFor("mgr", null), branch: null, briefMd: null });
        if (run.status === "running") e.repo.updateNode(runId, mid, { status: "queued" });
        plan.nodes.push({ id: mid, tier: "manager", role: "mgr", platform: null, appId: null, parentId: ORCH_ID, slot: "manager", alsoLead: false });
        parent = mid;
      }
      const m = plan.managers.find((x) => x.id === parent);
      if (m) m.appIds.push(id);
      e.repo.insertApp({ runId, id, name: a.name, tagline: a.tagline, platforms: a.platforms, platformsAssumed: !!a.platformsAssumed, shape, managerNodeId: m ? m.id : null, order: order++, test: !!a.test, priority: a.priority ?? "normal", notes: a.notes ?? null, targetPath: a.path ?? null, reads: a.reads ?? [] });
      const squad = squadFor(shape, a.platforms, !!a.test);
      const leadId = leadIdFor(id);
      const newNodes: PlannedNode[] = [{ id: leadId, tier: "lead", role: "lead", platform: null, appId: id, parentId: parent, slot: "lead", alsoLead: false }, ...squad.map((s) => ({ id: nodeIdFor(id, s), tier: tierOfRole(s.role), role: s.role, platform: s.platform, appId: id, parentId: leadId, slot: slotOfRole(s.role), alsoLead: false }))];
      for (const nd of newNodes) {
        e.repo.insertNode({ runId, id: nd.id, appId: id, tier: nd.tier, role: nd.role, platform: nd.platform, parentId: nd.parentId, slot: nd.slot, alsoLead: false, model: run.slots[nd.slot] ?? null, scopeGlobs: scopeFor(nd.role, nd.platform), branch: null, briefMd: null });
        plan.nodes.push(nd);
      }
      const pa: PlannedApp = { id, name: a.name, tagline: a.tagline, platforms: a.platforms, platformsAssumed: !!a.platformsAssumed, shape, group: a.group ?? null, managerId: m ? m.id : null, order, test: !!a.test, priority: a.priority ?? "normal", notes: a.notes ?? null, path: a.path ?? null, reads: a.reads ?? [], agents: newNodes.length, squad, staggered: squad.filter((s) => s.role !== "review" && s.role !== "slop").length > run.limits.leadSpan };
      plan.apps.push(pa);
      e.repo.event(runId, ORCH_ID, "plan", `added ${a.name} under ${m ? m.name : "the Orchestrator"}`);
    }
    for (const appId of delta.drop ?? []) dropAppTx(e, runId, appId);
    for (const [appId, shape] of Object.entries(delta.shapes ?? {})) reshapeTx(e, runId, appId, shape, plan);
    recount(plan);
    e.repo.db.prepare("UPDATE runs SET plan_json = ? WHERE id = ?").run(JSON.stringify(plan), runId);
  });
  e.cachePlan(runId, plan);
  e.emit(runId, "plan.changed", { summary: v.summary });
  e.outbox.kick();
  e.proposeNextWave(runId);
  await e.pump(runId);
  return v.summary;
}

function recount(plan: TopologyPlan): void {
  const c = plan.counts;
  c.apps = plan.apps.length;
  c.managers = plan.managers.length;
  c.leads = plan.nodes.filter((x) => x.tier === "lead").length;
  c.specialists = plan.nodes.filter((x) => x.tier === "specialist").length;
  c.gates = plan.nodes.filter((x) => x.tier === "gate").length;
  c.total = plan.nodes.length;
  c.platforms = plan.apps.reduce((s, a) => s + a.platforms.length, 0);
  for (const k of Object.keys(c.bySlot) as Array<keyof typeof c.bySlot>) c.bySlot[k] = plan.nodes.filter((n) => n.slot === k).length;
}

export function dropAppTx(e: Engine, runId: string, appId: string): void {
  const nodes = e.repo.listNodes(runId).filter((n) => n.appId === appId);
  const order = bottomUp(e.tree(runId), nodes.map((n) => n.id));
  for (const id of order) {
    const n = nodes.find((x) => x.id === id)!;
    if (n.status !== "done") e.repo.updateNode(runId, id, { status: n.threadId ? "idle" : "planned", endedAt: e.now() });
  }
  const withThread = order.filter((id) => nodes.find((x) => x.id === id)?.threadId);
  if (withThread.length) {
    e.repo.enqueue({ id: e.oid(), runId, kind: "stop", nodeId: `${appId}.lead`, payload: { nodeIds: withThread }, idemKey: `drop-stop:${runId}:${appId}` });
    e.repo.enqueue({ id: e.oid(), runId, kind: "archive", nodeId: `${appId}.lead`, payload: { nodeIds: withThread }, idemKey: `drop-archive:${runId}:${appId}` });
  }
  e.repo.updateApp(runId, appId, { stage: "cancelled" });
  e.repo.enterStage(runId, appId, "cancelled", { why: "dropped from the plan" });
  for (const need of e.repo.listNeeds(runId, "open").filter((x) => x.appId === appId)) e.repo.resolveNeed(runId, need.id, { action: "app-dropped" });
  e.emit(runId, "stage.changed", { appId, stage: "cancelled" });
}

function reshapeTx(e: Engine, runId: string, appId: string, shape: Shape, plan: TopologyPlan): void {
  const app = e.repo.getApp(runId, appId)!;
  const run = e.run(runId);
  const want = squadFor(shape, app.platforms, app.test);
  const wantIds = new Set(want.map((m) => nodeIdFor(appId, m)));
  const lead = e.leadOf(runId, appId)!;
  const current = e.repo.listNodes(runId).filter((n) => n.appId === appId && (n.tier === "specialist" || n.tier === "gate"));
  const extras: NodeInfo[] = current.filter((n) => !wantIds.has(n.id));
  for (const m of want) {
    const id = nodeIdFor(appId, m);
    if (current.find((n) => n.id === id)) continue;
    e.repo.insertNode({ runId, id, appId, tier: tierOfRole(m.role), role: m.role, platform: m.platform, parentId: lead.id, slot: slotOfRole(m.role), alsoLead: false, model: run.slots[slotOfRole(m.role)] ?? null, scopeGlobs: scopeFor(m.role, m.platform), branch: null, briefMd: null });
    plan.nodes.push({ id, tier: tierOfRole(m.role), role: m.role, platform: m.platform, appId, parentId: lead.id, slot: slotOfRole(m.role), alsoLead: false });
  }
  const withThread = extras.filter((n) => n.threadId).map((n) => n.id);
  for (const n of extras) {
    if (n.threadId) e.repo.updateNode(runId, n.id, { status: "idle", endedAt: e.now() });
    else {
      e.repo.db.prepare("DELETE FROM nodes WHERE run_id = ? AND id = ?").run(runId, n.id);
      plan.nodes = plan.nodes.filter((x) => x.id !== n.id);
    }
  }
  if (withThread.length) e.repo.enqueue({ id: e.oid(), runId, kind: "archive", nodeId: lead.id, payload: { nodeIds: withThread }, idemKey: `reshape:${runId}:${appId}:${shape}` });
  e.repo.updateApp(runId, appId, { shape });
  const pa = plan.apps.find((a) => a.id === appId);
  if (pa) {
    pa.shape = shape;
    pa.squad = want;
  }
  e.repo.event(runId, lead.id, "plan", `${app.name} reshaped to ${shape}`);
}
