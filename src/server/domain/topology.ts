// planTopology — the one pure function that decides the org shape (§1.4, §1.5).
// The wizard preview, the CLI `plan`, the planner thread and the engine all call
// this; the model never decides the topology.
import type {
  Platform,
  PortfolioApp,
  Role,
  Shape,
  SlotId,
  Tier,
} from "../../shared/types.ts";
import { LIMIT_CEILINGS } from "../../shared/types.ts";
import { PLATFORM_ORDER, slotOfRole, tierOfRole } from "./roles.ts";

export interface TopologySettings {
  managerSpan: number;
  orchestratorSpan: number;
  leadSpan: number;
  maxTotalAgents: number;
  defaultShape?: Shape;
}

export interface SquadMember {
  role: Role;
  platform: Platform | null;
}

export interface PlannedApp {
  id: string;
  name: string;
  tagline: string;
  platforms: Platform[];
  platformsAssumed: boolean;
  shape: Shape;
  group: string | null;
  managerId: string | null;
  order: number;
  test: boolean;
  priority: "low" | "normal" | "high";
  notes: string | null;
  /** The folder the human named (unexpanded), or null for <apps root>/<run>/<app>. */
  path: string | null;
  reads: string[];
  /** All agents this app can ever have (lead + squad + gates), per its shape. */
  agents: number;
  squad: SquadMember[];
  staggered: boolean;
}

export interface PlannedManager {
  id: string;
  name: string;
  appIds: string[];
}

export interface PlannedNode {
  id: string;
  tier: Tier;
  role: Role;
  platform: Platform | null;
  appId: string | null;
  parentId: string | null;
  slot: SlotId;
  alsoLead: boolean;
}

export type CollapseRule = "C1" | "C2" | "C3" | "none";

export interface TopologyCounts {
  apps: number;
  managers: number;
  leads: number;
  specialists: number;
  gates: number;
  total: number;
  platforms: number;
  bySlot: Record<SlotId, number>;
}

export interface TopologyPlan {
  ok: boolean;
  error: string | null;
  rule: CollapseRule;
  grouping: "single" | "direct" | "semantic" | "balanced" | "none";
  why: string;
  apps: PlannedApp[];
  managers: PlannedManager[];
  directAppIds: string[];
  nodes: PlannedNode[];
  counts: TopologyCounts;
  warnings: string[];
}

export const ORCH_ID = "orch";

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return s || "app";
}

export function uniqueSlugs(names: string[]): string[] {
  const used = new Map<string, number>();
  return names.map((n) => {
    const base = slugify(n);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    if (seen === 0) return base;
    let k = seen + 1;
    while (used.has(`${base}-${k}`)) k++;
    used.set(`${base}-${k}`, 1);
    return `${base}-${k}`;
  });
}

function orderedPlatforms(ps: Platform[]): Platform[] {
  return PLATFORM_ORDER.filter((p) => ps.includes(p));
}

/** Squad members below the lead for a shape (C6). Gates are always present. */
export function squadFor(shape: Shape, platforms: Platform[], test: boolean): SquadMember[] {
  const ps = orderedPlatforms(platforms);
  const out: SquadMember[] = [];
  if (shape === "full") {
    out.push({ role: "ui", platform: null }, { role: "code", platform: null });
    for (const p of ps) out.push({ role: "platform", platform: p });
    out.push({ role: "security", platform: null });
  } else if (shape === "lean") {
    out.push({ role: "ui", platform: null }, { role: "code", platform: null });
    if (ps.length > 1) for (const p of ps) out.push({ role: "platform", platform: p });
  }
  if (test && shape !== "solo") out.push({ role: "test", platform: null });
  out.push({ role: "review", platform: null }, { role: "slop", platform: null });
  return out;
}

export function nodeIdFor(appId: string, m: SquadMember): string {
  if (m.role === "platform") return `${appId}.p.${m.platform}`;
  return `${appId}.${m.role}`;
}

export function leadIdFor(appId: string): string {
  return `${appId}.lead`;
}

function emptyBySlot(): Record<SlotId, number> {
  return {
    orchestrator: 0,
    manager: 0,
    lead: 0,
    ui: 0,
    code: 0,
    platform: 0,
    security: 0,
    test: 0,
    review: 0,
    slop: 0,
    research: 0,
    docs: 0,
  };
}

function balancedSizes(n: number, span: number): number[] {
  const k = Math.ceil(n / span);
  const base = Math.floor(n / k);
  let rem = n % k;
  const sizes: number[] = [];
  for (let g = 0; g < k; g++) sizes.push(base + (rem-- > 0 ? 1 : 0));
  return sizes;
}

function plural(n: number, a: string, b?: string): string {
  return `${n} ${n === 1 ? a : b ?? `${a}s`}`;
}

export function validateSpans(s: TopologySettings): string | null {
  if (!Number.isInteger(s.managerSpan) || s.managerSpan < 2 || s.managerSpan > LIMIT_CEILINGS.managerSpan)
    return `Apps per manager must be between 2 and ${LIMIT_CEILINGS.managerSpan} (got ${s.managerSpan}).`;
  if (!Number.isInteger(s.orchestratorSpan) || s.orchestratorSpan < 2 || s.orchestratorSpan > LIMIT_CEILINGS.orchestratorSpan)
    return `The Orchestrator's span must be between 2 and ${LIMIT_CEILINGS.orchestratorSpan} (got ${s.orchestratorSpan}).`;
  if (!Number.isInteger(s.leadSpan) || s.leadSpan < 1 || s.leadSpan > LIMIT_CEILINGS.leadSpan)
    return `Specialists per lead must be between 1 and ${LIMIT_CEILINGS.leadSpan} (got ${s.leadSpan}).`;
  if (!Number.isInteger(s.maxTotalAgents) || s.maxTotalAgents < 1 || s.maxTotalAgents > LIMIT_CEILINGS.maxTotalAgents)
    return `The agent cap must be between 1 and ${LIMIT_CEILINGS.maxTotalAgents} (got ${s.maxTotalAgents}).`;
  return null;
}

export function planTopology(input: PortfolioApp[], settings: TopologySettings): TopologyPlan {
  const warnings: string[] = [];
  const span = settings.managerSpan;
  const ospan = settings.orchestratorSpan;
  const defaultShape = settings.defaultShape ?? "full";
  const ids = uniqueSlugs(input.map((a) => a.name));
  const apps: PlannedApp[] = input.map((a, i) => {
    const shape = a.shape ?? defaultShape;
    const platforms = orderedPlatforms(a.platforms.length ? a.platforms : ["ios", "and"]);
    const test = a.test ?? false;
    const squad = squadFor(shape, platforms, test);
    const builders = squad.filter((m) => tierOfRole(m.role) === "specialist").length;
    return {
      id: ids[i],
      name: a.name,
      tagline: a.tagline,
      platforms,
      platformsAssumed: a.platformsAssumed ?? a.platforms.length === 0,
      shape,
      group: a.group ?? null,
      managerId: null,
      order: i,
      test,
      priority: a.priority ?? "normal",
      notes: a.notes ?? null,
      path: a.path?.trim() || null,
      reads: a.reads ?? [],
      agents: 1 + squad.length,
      squad,
      staggered: builders > settings.leadSpan,
    };
  });
  for (const a of apps)
    if (a.staggered)
      warnings.push(
        `${a.name}: ${a.squad.filter((m) => tierOfRole(m.role) === "specialist").length} builders exceed ${settings.leadSpan} at once — platform builders start after the Core builder publishes the first CONTRACT.`,
      );

  const n = apps.length;
  const result: TopologyPlan = {
    ok: true,
    error: null,
    rule: "none",
    grouping: "none",
    why: "",
    apps,
    managers: [],
    directAppIds: [],
    nodes: [],
    counts: { apps: n, managers: 0, leads: 0, specialists: 0, gates: 0, total: 0, platforms: 0, bySlot: emptyBySlot() },
    warnings,
  };

  const spanError = validateSpans(settings);
  if (spanError) {
    result.ok = false;
    result.error = spanError;
  }

  if (n === 0) {
    result.ok = false;
    result.why = "No apps found yet. Add lines like “- Name — tagline · iOS Android”.";
    finishCounts(result);
    return result;
  }

  if (n === 1) {
    result.rule = "C1";
    result.grouping = "single";
    result.why = "1 app, so the Orchestrator also acts as its App Lead — one node with both toolsets, no managers.";
  } else if (n <= 4) {
    result.rule = "C2";
    result.grouping = "direct";
    result.directAppIds = apps.map((a) => a.id);
    result.why = `${n} apps ≤ 4, so the Orchestrator leads the app leads directly — no manager layer.`;
  } else {
    result.rule = "C3";
    // Semantic groups from the brief's headings, in order of first appearance.
    const groupOrder: string[] = [];
    const byGroup = new Map<string, PlannedApp[]>();
    for (const a of apps) {
      const g = a.group?.trim();
      if (!g) continue;
      if (!byGroup.has(g)) {
        byGroup.set(g, []);
        groupOrder.push(g);
      }
      byGroup.get(g)!.push(a);
    }
    const everyAppGrouped = apps.every((a) => a.group?.trim());
    const groups = groupOrder.map((g) => ({ name: g, apps: byGroup.get(g)! }));
    const semantic =
      everyAppGrouped && groups.length > 1 && groups.every((g) => g.apps.length <= span) && groups.length <= ospan;
    if (semantic) {
      result.grouping = "semantic";
      let mi = 0;
      const singles: string[] = [];
      for (const g of groups) {
        if (g.apps.length === 1) {
          // C4: no one-app managers. The Orchestrator's span is already
          // satisfied because group count ≤ ospan.
          result.directAppIds.push(g.apps[0].id);
          singles.push(g.name);
          continue;
        }
        const id = `m${mi++}`;
        result.managers.push({ id, name: g.name, appIds: g.apps.map((a) => a.id) });
        for (const a of g.apps) a.managerId = id;
      }
      result.why = `${n} apps > 4, so managers are needed. Your headings group them naturally, and every group fits within ${span} leads — kept as written.`;
      if (singles.length)
        result.why += ` ${plural(singles.length, "one-app group")} (${singles.join(", ")}) ${singles.length === 1 ? "reports" : "report"} straight to the Orchestrator — no one-app manager.`;
    } else {
      result.grouping = "balanced";
      const sizes = balancedSizes(n, span);
      let i = 0;
      sizes.forEach((sz, g) => {
        const members = apps.slice(i, i + sz);
        i += sz;
        const id = `m${g}`;
        const names = new Set(members.map((a) => a.group).filter(Boolean));
        const name = names.size === 1 ? [...names][0]! : groups.length ? `Group ${g + 1}` : `Manager ${g + 1}`;
        result.managers.push({ id, name, appIds: members.map((a) => a.id) });
        for (const a of members) a.managerId = id;
      });
      result.why = `${n} apps > 4, so managers are needed. With at most ${span} leads each that is ${sizes.length} managers, balanced as ${sizes.join(" + ")}.`;
      if (groups.length > 1 && !everyAppGrouped) result.why += " Some apps have no heading, so the headings could not be kept.";
      else if (groups.length > 1 && groups.length > ospan)
        result.why += ` Your ${groups.length} headings exceed the Orchestrator's span of ${ospan}, so they were rebalanced.`;
      else if (groups.length > 1) result.why += ` A heading has more than ${span} apps, so the groups were rebalanced.`;
    }
    const top = result.managers.length + result.directAppIds.length;
    if (top > ospan && !result.error) {
      result.ok = false;
      result.error = result.directAppIds.length
        ? `${plural(result.managers.length, "manager")} and ${plural(result.directAppIds.length, "direct lead")} exceed the Orchestrator’s span of ${ospan}. Raise the manager span (max ${LIMIT_CEILINGS.managerSpan}) or split this into two runs.`
        : `${result.managers.length} managers exceeds the Orchestrator’s span of ${ospan}. Raise the manager span (max ${LIMIT_CEILINGS.managerSpan}) or split this into two runs.`;
    }
  }

  buildNodes(result);
  finishCounts(result);
  if (result.counts.total > settings.maxTotalAgents && !result.error) {
    result.ok = false;
    result.error = `${result.counts.total} agents exceeds the cap of ${settings.maxTotalAgents}. Use Lean or Solo shapes for some apps, drop apps, or raise the cap (max ${LIMIT_CEILINGS.maxTotalAgents}).`;
  }
  return result;
}

function buildNodes(plan: TopologyPlan): void {
  const nodes: PlannedNode[] = [];
  const c1 = plan.rule === "C1";
  nodes.push({ id: ORCH_ID, tier: "orchestrator", role: "orch", platform: null, appId: c1 ? plan.apps[0].id : null, parentId: null, slot: "orchestrator", alsoLead: c1 });
  for (const m of plan.managers)
    nodes.push({ id: m.id, tier: "manager", role: "mgr", platform: null, appId: null, parentId: ORCH_ID, slot: "manager", alsoLead: false });
  for (const a of plan.apps) {
    let leadId = ORCH_ID;
    if (!c1) {
      leadId = leadIdFor(a.id);
      nodes.push({ id: leadId, tier: "lead", role: "lead", platform: null, appId: a.id, parentId: a.managerId ?? ORCH_ID, slot: "lead", alsoLead: false });
    }
    for (const m of a.squad)
      nodes.push({ id: nodeIdFor(a.id, m), tier: tierOfRole(m.role), role: m.role, platform: m.platform, appId: a.id, parentId: leadId, slot: slotOfRole(m.role), alsoLead: false });
  }
  plan.nodes = nodes;
}

function finishCounts(plan: TopologyPlan): void {
  const c = plan.counts;
  c.bySlot = emptyBySlot();
  for (const nd of plan.nodes) c.bySlot[nd.slot]++;
  c.managers = plan.managers.length;
  c.leads = plan.nodes.filter((x) => x.tier === "lead").length;
  c.specialists = plan.nodes.filter((x) => x.tier === "specialist").length;
  c.gates = plan.nodes.filter((x) => x.tier === "gate").length;
  c.platforms = plan.apps.reduce((s, a) => s + a.platforms.length, 0);
  c.total = plan.nodes.length;
}

/** Builders a lead may start right now under C7 (leadSpan) and the stagger rule. */
export function admissibleSpecialists(
  pending: SquadMember[],
  running: number,
  leadSpan: number,
  staggered: boolean,
  coreContractPublished: boolean,
): { start: SquadMember[]; deferred: Array<{ member: SquadMember; reason: string }> } {
  const order: Role[] = ["code", "ui", "security", "test", "research", "docs", "platform"];
  const sorted = [...pending].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
  const start: SquadMember[] = [];
  const deferred: Array<{ member: SquadMember; reason: string }> = [];
  let slots = Math.max(0, leadSpan - running);
  for (const m of sorted) {
    if (staggered && m.role === "platform" && !coreContractPublished) {
      deferred.push({ member: m, reason: "waits for the Core builder's first CONTRACT (more builders than the lead span)" });
      continue;
    }
    if (slots <= 0) {
      deferred.push({ member: m, reason: `lead span ${leadSpan} reached` });
      continue;
    }
    start.push(m);
    slots--;
  }
  return { start, deferred };
}
