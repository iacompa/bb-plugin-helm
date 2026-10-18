// App-side view of the server's JSON. Types only — nothing from the server or
// shared folders is imported at runtime.
import type {
  AppInfo,
  Catalog,
  CatalogModel,
  CheckInfo,
  CommsInfo,
  DirectiveInfo,
  DirectiveType,
  FindingInfo,
  ModelRef,
  NeedInfo,
  NodeEventInfo,
  NodeInfo,
  Platform,
  PolicyInfo,
  ProjectKind,
  ProjectNeed,
  Priority,
  ReceiptState,
  RecipientInfo,
  RecipientLevel,
  ReportInfo,
  Role,
  RunInfo,
  Shape,
  SlotId,
  SlotMap,
  Stage,
  StageHistoryInfo,
  VerdictInfo,
} from "../../src/shared/types.ts";

export type {
  AppInfo,
  Catalog,
  CatalogModel,
  CheckInfo,
  CommsInfo,
  DirectiveInfo,
  DirectiveType,
  FindingInfo,
  ModelRef,
  NeedInfo,
  NodeEventInfo,
  NodeInfo,
  Platform,
  PolicyInfo,
  Priority,
  ReceiptState,
  RecipientInfo,
  RecipientLevel,
  ReportInfo,
  ProjectKind,
  ProjectNeed,
  Role,
  RunInfo,
  Shape,
  SlotId,
  SlotMap,
  Stage,
  StageHistoryInfo,
  VerdictInfo,
};
export type { NodeStatus, NeedKind, Cascade, Tier, Portfolio, PortfolioApp } from "../../src/shared/types.ts";
export type { RealtimeBatch, RpcContract } from "../../src/shared/protocol.ts";

/** A node as the snapshot sends it: label and the effective model filled in. */
export type SnapNode = NodeInfo & { label: string };

export type SnapApp = AppInfo & {
  contractVersion?: number | null;
  integrationBranch?: string | null;
  integrationHead?: string | null;
  platformsAssumed?: boolean;
  notes?: string | null;
};

export interface PlanCounts {
  apps: number;
  managers: number;
  leads: number;
  specialists: number;
  gates: number;
  total: number;
  platforms?: number;
  bySlot?: Partial<Record<SlotId, number>>;
}

export type SnapRun = RunInfo & {
  spend: number;
  rule: "C1" | "C2" | "C3" | "none" | string;
  grouping: string;
  why: string;
  counts: PlanCounts;
};

export interface PlannedManager {
  id: string;
  name: string;
  appIds: string[];
}

export interface OutboxFailed {
  id: string;
  kind: string;
  nodeId: string | null;
  lastError: string | null;
  attempts: number;
}

export interface Snapshot {
  run: SnapRun;
  managers: PlannedManager[];
  apps: SnapApp[];
  nodes: SnapNode[];
  directives: DirectiveInfo[];
  needs: NeedInfo[];
  policies: PolicyInfo[];
  findings: FindingInfo[];
  outboxFailed: OutboxFailed[];
}

export type RunListItem = RunInfo & { spend: number; apps: number; needs?: number };

export interface NodeDetail {
  node: SnapNode;
  brief: string | null;
  events: NodeEventInfo[];
  comms: CommsInfo[];
  reports: ReportInfo[];
  directives: DirectiveInfo[];
  inbox: Array<{ id?: number; ts: number; text: string; directiveId?: string | null }>;
  needs: NeedInfo[];
  children: string[];
}

export interface AppDetail {
  app: SnapApp;
  verdicts: VerdictInfo[];
  checks: CheckInfo[];
  findings: FindingInfo[];
  stageHistory: StageHistoryInfo[];
}

export interface PreviewRecipient {
  id: string;
  level: RecipientLevel;
  world: boolean;
  label: string;
  hasThread: boolean;
  status: string;
  notice?: string;
}

export interface DirectivePreview {
  id?: string;
  affected: string[];
  recipients: PreviewRecipient[];
  counts: { direct: number; full: number; digest: number };
  readCostK: number;
  units: number;
  runStatus: string;
}

export interface WorldState {
  run: {
    name: string;
    status: string;
    apps: number;
    managers: number;
    agents: { spawned: number; running: number; queued: number; planned: number; cap: number };
    spend: { units: number; forecast: number; cap: number };
    spawnsPaused: boolean;
    autoAdvance: string;
  };
  stages: Record<string, number>;
  needs: Array<{ id: string; kind: string; title: string; nodeId?: string | null }>;
  recentDirectives: Array<{ id: string; summary: string; ts?: number }>;
  touched: { count: number; nodes: string[] };
  policies: Array<{ id: string; text: string }>;
}

export interface ForeignThread {
  threadId: string;
  title: string | null;
  status: string | null;
  projectId: string | null;
  providerId: string | null;
  parentThreadId: string | null;
  originPluginId: string | null;
  hidden: boolean;
  updatedAt: number | null;
}

export interface PlannedApp {
  id: string;
  name: string;
  tagline: string;
  platforms: Platform[];
  platformsAssumed?: boolean;
  shape: Shape;
  group: string | null;
  managerId: string | null;
  order: number;
  test: boolean;
  priority: Priority;
  notes: string | null;
  /** The folder the human named (existing repository or new folder), else null for the run folder. */
  path?: string | null;
  reads?: string[];
  kind?: ProjectKind;
  needs?: ProjectNeed[];
  tools?: string[];
  agents: number;
  squad: Array<{ role: Role; platform?: Platform | null }>;
  staggered?: boolean;
}

export interface TopologyPlan {
  ok: boolean;
  error: string | null;
  rule: string;
  grouping: string;
  why: string;
  apps: PlannedApp[];
  managers: PlannedManager[];
  directAppIds: string[];
  nodes: Array<{ id: string; role: Role; slot: SlotId; tier: string; parentId: string | null; appId: string | null; platform?: Platform | null }>;
  counts: PlanCounts;
  warnings: string[];
}

export interface PlanPreview {
  plan: TopologyPlan;
  portfolio: import("../../src/shared/types.ts").Portfolio;
  assumed: string[];
  forecast: { units: number; low: number; high: number; tokensK: number; unknownWeights: string[] };
  waves: { inFlight: number; waves: number };
  required: SlotId[];
  unset: SlotId[];
  warnings: string[];
}

export interface Preset {
  name: string;
  slots: SlotMap;
  updatedAt?: number;
}

export type View = "graph" | "board" | "ledger" | "needs";
export type InspTab = "overview" | "chat" | "direct" | "comms" | "brief" | "reports" | "changes";
