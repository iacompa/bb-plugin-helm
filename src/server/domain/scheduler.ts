// Admission, waves and priority (§4.2, §4.3, appendix A6). Pure.
import type { NodeStatus, Priority, Stage, Tier } from "../../shared/types.ts";
import { STAGE_IDX, isInFlight } from "./stages.ts";

export const AVG_CONCURRENT_PER_APP = 5;

export function inFlightCap(concurrency: number): number {
  return Math.max(1, Math.floor(concurrency / AVG_CONCURRENT_PER_APP));
}

export function wavesEstimate(apps: number, concurrency: number): { inFlight: number; waves: number } {
  const inFlight = inFlightCap(concurrency);
  return { inFlight, waves: apps === 0 ? 0 : Math.ceil(apps / inFlight) };
}

const PRIO: Record<Priority, number> = { high: 0, normal: 1, low: 2 };

export interface WaveApp {
  id: string;
  stage: Stage;
  priority: Priority;
  order: number;
  managerId: string | null;
}

/** Round-robin across managers, then take `free` (appendix A6 fairShareByManager). */
export function fairShareByManager<T extends { managerId: string | null }>(queue: T[], free: number): T[] {
  const lanes = new Map<string, T[]>();
  for (const a of queue) {
    const k = a.managerId ?? "_";
    if (!lanes.has(k)) lanes.set(k, []);
    lanes.get(k)!.push(a);
  }
  const out: T[] = [];
  const keys = [...lanes.keys()];
  while (out.length < free && keys.some((k) => lanes.get(k)!.length)) {
    for (const k of keys) {
      const lane = lanes.get(k)!;
      if (lane.length && out.length < free) out.push(lane.shift()!);
    }
  }
  return out;
}

export function nextWave(apps: WaveApp[], concurrency: number, spawnsPaused: boolean, opts: { batch?: boolean } = {}): WaveApp[] {
  if (spawnsPaused) return [];
  const inFlight = apps.filter((a) => isInFlight(a.stage)).length;
  const cap = inFlightCap(concurrency);
  const free = cap - inFlight;
  if (free <= 0) return [];
  const queue = apps.filter((a) => a.stage === "intake").sort((a, b) => PRIO[a.priority] - PRIO[b.priority] || a.order - b.order);
  // batching (asked waves): wait until half the in-flight slots are free, unless the rest fits or nothing is running
  if (opts.batch && inFlight > 0 && free < Math.ceil(cap / 2) && queue.length > free) return [];
  return fairShareByManager(queue, free);
}

/** The first wave the human approves with the plan. */
export function firstWave(apps: WaveApp[], concurrency: number): WaveApp[] {
  return nextWave(apps, concurrency, false);
}

export interface Eligible {
  nodeId: string;
  tier: Tier;
  appPriority: Priority;
  appStage: Stage | null;
  managerId: string | null;
  createdAt: number;
  firstInLine: boolean;
  providerId: string | null;
}

/** At start the Orchestrator, then Managers, go first: a child cannot spawn before its parent has a thread. */
const SUPERVISOR_RANK: Partial<Record<Tier, number>> = { orchestrator: 0, manager: 1 };

/** Sort key per §4.3: first-in-line, supervisors before their teams, app priority, stage depth (gates first), fair share, age. */
export function prioritize(nodes: Eligible[]): Eligible[] {
  const managerTurn = new Map<string, number>();
  const byKey = nodes.map((n) => {
    const m = n.managerId ?? "_";
    const turn = managerTurn.get(m) ?? 0;
    managerTurn.set(m, turn + 1);
    return { n, key: [n.firstInLine ? 0 : 1, n.firstInLine ? SUPERVISOR_RANK[n.tier] ?? 2 : 2, PRIO[n.appPriority], -(n.appStage ? STAGE_IDX[n.appStage] : 0) - (n.tier === "gate" ? 1 : 0), turn, n.createdAt] };
  });
  byKey.sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
    return a.n.nodeId.localeCompare(b.n.nodeId);
  });
  return byKey.map((x) => x.n);
}

export interface Capacity {
  concurrency: number;
  running: number;
  maxTotalAgents: number;
  nonPlanned: number;
  providerCaps: Record<string, number>;
  runningByProvider: Record<string, number>;
  spawnsPaused: boolean;
}

/** Pick which eligible nodes may start now. Caps are hard; the stricter of Helm's and BB's wins. */
export function admit(nodes: Eligible[], cap: Capacity, opts: { alreadyCounted?: Set<string> } = {}): { start: string[]; held: Array<{ nodeId: string; reason: string }> } {
  const start: string[] = [];
  const held: Array<{ nodeId: string; reason: string }> = [];
  if (cap.spawnsPaused) return { start, held: nodes.map((n) => ({ nodeId: n.nodeId, reason: "spawns paused" })) };
  let running = cap.running;
  let total = cap.nonPlanned;
  const byProv = { ...cap.runningByProvider };
  for (const n of prioritize(nodes)) {
    const counted = opts.alreadyCounted?.has(n.nodeId) ?? false;
    if (running >= cap.concurrency) {
      held.push({ nodeId: n.nodeId, reason: `concurrency ${cap.concurrency} reached` });
      continue;
    }
    if (!counted && total >= cap.maxTotalAgents) {
      held.push({ nodeId: n.nodeId, reason: `agent cap ${cap.maxTotalAgents} reached` });
      continue;
    }
    if (n.providerId) {
      const pc = cap.providerCaps[n.providerId];
      if (pc !== undefined && (byProv[n.providerId] ?? 0) >= pc) {
        held.push({ nodeId: n.nodeId, reason: `${n.providerId} cap ${pc} reached` });
        continue;
      }
      byProv[n.providerId] = (byProv[n.providerId] ?? 0) + 1;
    }
    start.push(n.nodeId);
    running++;
    if (!counted) total++;
  }
  return { start, held };
}

/** Status values that count against maxTotalAgents (§3.1). */
export function countsAgainstCap(s: NodeStatus): boolean {
  return s !== "planned";
}

export function isActiveStatus(s: NodeStatus): boolean {
  return s === "running";
}
