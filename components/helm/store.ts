// Normalized run store and realtime patch application. Pure: no React, no I/O,
// so it can be unit tested with node --test.
import type {
  DirectiveInfo,
  FindingInfo,
  NeedInfo,
  NodeInfo,
  PlannedManager,
  PolicyInfo,
  RealtimeBatch,
  ReceiptState,
  SnapApp,
  SnapNode,
  SnapRun,
  Snapshot,
  Stage,
  OutboxFailed,
} from "./types.ts";

export interface RunState {
  run: SnapRun;
  managers: PlannedManager[];
  apps: Record<string, SnapApp>;
  appOrder: string[];
  nodes: Record<string, SnapNode>;
  nodeOrder: string[];
  /** parentId → child ids, in nodeOrder order */
  children: Record<string, string[]>;
  directives: DirectiveInfo[];
  needs: NeedInfo[];
  policies: PolicyInfo[];
  findings: FindingInfo[];
  outboxFailed: OutboxFailed[];
  /** highest realtime seq applied */
  seq: number;
}

export interface BatchEffects {
  state: RunState;
  /** Something structural changed that a patch cannot express: refetch run_get (debounced). */
  refetch: boolean;
  /** Directives that arrived in this batch (for the propagation pulse). */
  created: DirectiveInfo[];
  receipts: Array<{ directiveId: string; nodeId: string; state: ReceiptState }>;
  /** Nodes whose status changed in this batch. */
  statusChanged: string[];
  needsCreated: NeedInfo[];
}

function childIndex(nodes: Record<string, SnapNode>, order: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const id of order) {
    const p = nodes[id]?.parentId;
    if (p) (out[p] ??= []).push(id);
  }
  return out;
}

export function fromSnapshot(s: Snapshot, seq = 0): RunState {
  const nodes: Record<string, SnapNode> = {};
  const nodeOrder: string[] = [];
  for (const n of s.nodes) {
    nodes[n.id] = n;
    nodeOrder.push(n.id);
  }
  const apps: Record<string, SnapApp> = {};
  const appOrder: string[] = [];
  for (const a of [...s.apps].sort((x, y) => x.order - y.order)) {
    apps[a.id] = a;
    appOrder.push(a.id);
  }
  return {
    run: s.run,
    managers: s.managers ?? [],
    apps,
    appOrder,
    nodes,
    nodeOrder,
    children: childIndex(nodes, nodeOrder),
    directives: s.directives ?? [],
    needs: s.needs ?? [],
    policies: s.policies ?? [],
    findings: s.findings ?? [],
    outboxFailed: s.outboxFailed ?? [],
    seq,
  };
}

const STAGE_BASE: Record<Stage, number> = { intake: 0, spec: 8, build: 25, integrate: 60, review: 72, slop: 82, fix: 75, ready: 100, done: 100, cancelled: 0 };
const STRUCTURAL = new Set(["plan.changed", "run.started", "run.reconciled", "edge.added"]);

/** Apply one realtime batch. Returns a new state (unchanged parts are shared). */
export function applyBatch(prev: RunState, batch: RealtimeBatch): BatchEffects {
  const fx: BatchEffects = { state: prev, refetch: false, created: [], receipts: [], statusChanged: [], needsCreated: [] };
  if (!batch || !Array.isArray(batch.events)) return fx;
  if (batch.runId && batch.runId !== prev.run.id) return fx;
  let s: RunState = { ...prev, seq: Math.max(prev.seq, Number(batch.seq) || 0) };
  let nodesCopied = false;
  const nodesW = () => {
    if (!nodesCopied) {
      s.nodes = { ...s.nodes };
      nodesCopied = true;
    }
    return s.nodes;
  };
  for (const ev of batch.events) {
    const p = (ev?.payload ?? {}) as Record<string, unknown>;
    switch (ev?.event) {
      case "node.updated": {
        const raw = p as unknown as NodeInfo;
        if (!raw || typeof raw.id !== "string") break;
        const old = s.nodes[raw.id];
        const merged: SnapNode = {
          ...(old ?? ({} as SnapNode)),
          ...raw,
          label: old?.label ?? (raw as Partial<SnapNode>).label ?? raw.id,
          // node.updated carries the raw row: model null means "follow the slot", so keep the effective model we know
          model: raw.model ?? old?.model ?? null,
        };
        nodesW()[raw.id] = merged;
        if (!old) {
          s.nodeOrder = [...s.nodeOrder, raw.id];
          s.children = childIndex(s.nodes, s.nodeOrder);
          fx.refetch = true; // a new node needs its label from the server
        } else if (old.parentId !== merged.parentId) {
          s.children = childIndex(s.nodes, s.nodeOrder);
        }
        if (!old || old.status !== merged.status) fx.statusChanged.push(raw.id);
        break;
      }
      case "directive.created": {
        const d = p as unknown as DirectiveInfo;
        if (!d || typeof d.id !== "string") break;
        const i = s.directives.findIndex((x) => x.id === d.id);
        s.directives = i >= 0 ? s.directives.map((x) => (x.id === d.id ? d : x)) : [d, ...s.directives];
        if (i < 0) fx.created.push(d);
        if (d.policy) fx.refetch = true; // a standing policy row was created with it
        break;
      }
      case "receipt.updated": {
        const { directiveId, nodeId, state } = p as { directiveId: string; nodeId: string; state: ReceiptState };
        if (!directiveId || !nodeId) break;
        let hit = false;
        s.directives = s.directives.map((d) => {
          if (d.id !== directiveId) return d;
          hit = true;
          return { ...d, recipients: d.recipients.map((r) => (r.nodeId === nodeId ? { ...r, state, ackAt: state === "ack" ? ev.ts : r.ackAt, deliveredAt: state === "delivered" ? ev.ts : r.deliveredAt } : r)) };
        });
        if (!hit) fx.refetch = true;
        fx.receipts.push({ directiveId, nodeId, state });
        break;
      }
      case "need.created": {
        const n = p as unknown as NeedInfo;
        if (!n || typeof n.id !== "string") break;
        const exists = s.needs.some((x) => x.id === n.id);
        s.needs = exists ? s.needs.map((x) => (x.id === n.id ? n : x)) : [n, ...s.needs];
        if (!exists) fx.needsCreated.push(n);
        break;
      }
      case "need.resolved": {
        const { id, action } = p as { id: string; action: string };
        if (!id) break;
        s.needs = s.needs.map((x) => (x.id === id ? { ...x, state: "resolved", resolvedAt: ev.ts ?? Date.now(), resolution: x.resolution ?? { action } } : x));
        break;
      }
      case "stage.changed": {
        const { appId, stage } = p as { appId: string; stage: Stage };
        const a = s.apps[appId];
        if (!a) {
          fx.refetch = true;
          break;
        }
        s.apps = { ...s.apps, [appId]: { ...a, stage, pct: STAGE_BASE[stage] ?? a.pct } };
        break;
      }
      case "spend.updated": {
        const { nodeId, tokens, cost, runSpend } = p as { nodeId: string; tokens: number; cost: number; runSpend: number };
        const n = s.nodes[nodeId];
        if (n) nodesW()[nodeId] = { ...n, tokens: tokens ?? n.tokens, cost: cost ?? n.cost };
        if (typeof runSpend === "number") s.run = { ...s.run, spend: runSpend };
        break;
      }
      case "spawns.paused": {
        const { paused, budgetCap } = p as { paused: boolean; budgetCap?: number };
        s.run = { ...s.run, spawnsPaused: !!paused, ...(typeof budgetCap === "number" ? { budgetCap } : {}) };
        break;
      }
      case "finding.updated": {
        const { id, status } = p as { id: string; status: FindingInfo["status"] };
        if (!id) break;
        if (!s.findings.some((f) => f.id === id)) fx.refetch = true;
        else s.findings = s.findings.map((f) => (f.id === id ? { ...f, status: status ?? f.status } : f));
        break;
      }
      case "run.updated": {
        const st = (p as { status?: SnapRun["status"] }).status;
        if (st) s.run = { ...s.run, status: st };
        fx.refetch = true;
        break;
      }
      default:
        if (STRUCTURAL.has(ev?.event) || ev?.event) fx.refetch = true;
    }
  }
  fx.state = s;
  return fx;
}

// ───────────── selectors ─────────────

export function ancestorsOf(s: Pick<RunState, "nodes">, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  let n = s.nodes[id];
  while (n && n.parentId && !seen.has(n.parentId)) {
    out.push(n.parentId);
    seen.add(n.parentId);
    n = s.nodes[n.parentId];
  }
  return out;
}
export function descendantsOf(s: Pick<RunState, "children">, id: string): string[] {
  const out: string[] = [];
  const walk = (i: string) => {
    for (const c of s.children[i] ?? []) {
      out.push(c);
      walk(c);
    }
  };
  walk(id);
  return out;
}
/** The node that leads an app (the Orchestrator itself in a one-app C1 run). */
export function leadOf(s: Pick<RunState, "nodes" | "nodeOrder">, appId: string): SnapNode | null {
  for (const id of s.nodeOrder) {
    const n = s.nodes[id];
    if (n.appId === appId && n.role === "lead") return n;
  }
  for (const id of s.nodeOrder) {
    const n = s.nodes[id];
    if (n.alsoLead) return n;
  }
  return null;
}
/** Members of an app: its lead first (unless the Orchestrator leads), then specialists, then gates. */
export function appMembers(s: Pick<RunState, "nodes" | "nodeOrder">, appId: string): SnapNode[] {
  const all = s.nodeOrder.map((id) => s.nodes[id]).filter((n) => n.appId === appId && n.role !== "orch");
  const rank = (n: SnapNode) => (n.tier === "lead" ? 0 : n.tier === "gate" ? 2 : 1);
  return all.sort((a, b) => rank(a) - rank(b));
}
export function openNeeds(s: Pick<RunState, "needs">): NeedInfo[] {
  return s.needs.filter((n) => n.state === "open");
}
export function managerOfApp(s: Pick<RunState, "managers">, appId: string): PlannedManager | null {
  return s.managers.find((m) => m.appIds.includes(appId)) ?? null;
}

/**
 * Session tabs: which run to show and which tabs stay open once the runs list is known.
 * A run that no longer exists closes; on the first load the remembered run, else an open
 * tab, else (first visit ever) the newest run is shown. After that a null run is a
 * deliberate fresh session and stays blank.
 */
export function resolveSession(runIds: string[], runId: string | null, tabs: string[], opts: { firstLoad: boolean; firstVisit: boolean }): { runId: string | null; tabs: string[] } {
  const exists = new Set(runIds);
  let open = tabs.filter((id) => exists.has(id));
  let next = runId;
  if (next && !exists.has(next)) next = open[0] ?? null;
  else if (!next && opts.firstLoad) next = open[0] ?? (opts.firstVisit ? runIds[0] ?? null : null);
  if (next && !open.includes(next)) open = [...open, next];
  return { runId: next, tabs: open };
}
