// Shared vocabulary for Helm: server, engine, agent tools, RPC and the app all
// speak these types. Pure types only — no runtime imports from BB or the DB.

/** planner: Amer, the run's advisor beside the Orchestrator; custom: an agent the Planner designed for this run. */
export type Tier = "orchestrator" | "manager" | "lead" | "specialist" | "gate" | "planner" | "custom";
export type Role =
  | "orch"
  | "mgr"
  | "lead"
  | "ui"
  | "code"
  | "platform"
  | "security"
  | "test"
  | "research"
  | "docs"
  | "data"
  | "compliance"
  | "assets"
  | "review"
  | "slop"
  | "planner"
  | "custom";
export type Platform = "mac" | "win" | "ios" | "and" | "web";

/** What a project is (its mode). Helm decides it from the brief unless the human names it. */
export type ProjectKind = "app" | "web" | "game" | "automation" | "review";
export const PROJECT_KINDS: ProjectKind[] = ["app", "web", "game", "automation", "review"];
export const KIND_LABEL: Record<ProjectKind, string> = {
  app: "App",
  web: "Website",
  game: "Game",
  automation: "Automation",
  review: "Review",
};

/** What a project needs beyond its kind. Each need can add a specialist, a craft skill and brief guidance. */
export type ProjectNeed = "database" | "auth" | "payments" | "security" | "hipaa" | "privacy" | "realtime" | "ai" | "automation" | "assets" | "multiplayer";
export const PROJECT_NEEDS: ProjectNeed[] = ["database", "auth", "payments", "security", "hipaa", "privacy", "realtime", "ai", "automation", "assets", "multiplayer"];
export const NEED_LABEL: Record<ProjectNeed, string> = {
  database: "Database",
  auth: "Accounts",
  payments: "Payments",
  security: "Security",
  hipaa: "HIPAA",
  privacy: "Privacy law",
  realtime: "Realtime",
  ai: "AI features",
  automation: "Automation",
  assets: "Art assets",
  multiplayer: "Multiplayer",
};
export type Shape = "solo" | "lean" | "full";
export type Stage =
  | "intake"
  | "spec"
  | "build"
  | "integrate"
  | "review"
  | "slop"
  | "fix"
  | "ready"
  | "done"
  | "cancelled";
export type NodeStatus =
  | "planned"
  | "queued"
  | "running"
  | "waiting"
  | "needs"
  | "paused"
  | "idle"
  | "failed"
  | "done";
export type Priority = "low" | "normal" | "high";
export type SlotId =
  | "orchestrator"
  | "manager"
  | "lead"
  | "ui"
  | "code"
  | "platform"
  | "security"
  | "test"
  | "review"
  | "slop"
  | "research"
  | "docs"
  | "watcher"
  | "planner";

export interface ModelRef {
  providerId: string;
  modelId: string;
  reasoning: string | null;
  serviceTier?: string | null;
}

export type SlotMap = Partial<Record<SlotId, ModelRef>>;

export type Cascade = "self" | "reports" | "subtree";
export type DeliveryMode = "steer" | "queue";
export type DirectiveType =
  | "tell"
  | "model"
  | "scope"
  | "priority"
  | "pause"
  | "resume"
  | "stop"
  | "retry"
  | "waive"
  | "approve"
  | "deny"
  | "answer"
  | "signoff"
  | "sendback"
  | "plan"
  | "spawn"
  | "policy"
  | "slots";
export type RecipientLevel = "direct" | "full" | "digest";
export type ReceiptState = "queued" | "delivered" | "ack" | "rec" | "failed";

export type NeedKind =
  | "approval"
  | "question"
  | "decision"
  | "signoff"
  | "failed"
  | "slop"
  | "plan"
  | "budget"
  | "stalled"
  | "model";

export type Severity = "blocker" | "major" | "minor" | "nit";
export type FindingStatus = "open" | "fixed" | "waived" | "wontfix";
export type CheckTier = "local" | "ci" | "none";
export type RunStatus = "planning" | "running" | "paused" | "done" | "cancelled";
export type AutoAdvance = "ask" | "auto";

/** Spans, caps and knobs (§4.1). */
export interface HelmLimits {
  managerSpan: number;
  orchestratorSpan: number;
  leadSpan: number;
  maxTotalAgents: number;
  concurrency: number;
  providerCaps: Record<string, number>;
  fixRounds: number;
  stallMinutes: number;
  budgetCap: number;
  /**
   * "high": agents' questions go to their supervisor and the Orchestrator decides; waves and plan
   * changes go ahead. Only credentials, real spending, private data and access the human must grant
   * reach Needs you (plus sign-off and failures). "ask": every question, wave and plan change asks the
   * human. Runs made before this setting existed read as "ask".
   */
  autonomy?: Autonomy;
  /**
   * The human's choice of permission mode for a provider that cannot run the configured one
   * (e.g. a provider with only "accept-edits" and "full" when Helm's setting is "auto").
   */
  providerPermission?: Record<string, PermissionMode>;
}

export type PermissionMode = "accept-edits" | "auto" | "full";
export const PERMISSION_LABEL: Record<PermissionMode, string> = {
  "accept-edits": "Accept edits (asks you before commands)",
  auto: "Auto (BB's classifier decides)",
  full: "Full access (no permission checks)",
};

export type Autonomy = "high" | "ask";
/** What may still reach the human when autonomy is high. */
export const HUMAN_ONLY = ["credentials", "spending", "privacy", "access"] as const;
export type HumanOnly = (typeof HUMAN_ONLY)[number];
/** What a helm_need is about: the human-only four, a question only the owner can answer, or anything else. */
export const NEED_ABOUT = [...HUMAN_ONLY, "owner", "other"] as const;

export const LIMIT_DEFAULTS: HelmLimits = {
  managerSpan: 4,
  orchestratorSpan: 6,
  leadSpan: 6,
  maxTotalAgents: 250,
  concurrency: 24,
  providerCaps: { codex: 12, "claude-code": 16, "acp-cursor": 4, "acp-grok": 4 },
  fixRounds: 2,
  stallMinutes: 20,
  budgetCap: 2500,
  autonomy: "high",
};

export const LIMIT_CEILINGS = {
  managerSpan: 6,
  orchestratorSpan: 8,
  leadSpan: 8,
  maxTotalAgents: 400,
  concurrency: 48,
  fixRounds: 3,
} as const;

// ───────────── portfolio input (planner / parser output) ─────────────

export interface PortfolioApp {
  name: string;
  tagline: string;
  platforms: Platform[];
  platformsAssumed?: boolean;
  group?: string | null;
  shape?: Shape;
  notes?: string | null;
  priority?: Priority;
  test?: boolean;
  /** Where the app lives: an existing repository or a new folder, anywhere on the host. Default: <apps root>/<run>/<app>. */
  path?: string | null;
  /** Other folders the app's agents may read (never write), e.g. a shared core library. */
  reads?: string[];
  /** The project's mode. Default: decided from the name, tagline and notes. */
  kind?: ProjectKind;
  needs?: ProjectNeed[];
  /** External programs ("blender", "unreal") and BB plugins ("plugin:browser-automation") the agents should use. */
  tools?: string[];
}

export interface Portfolio {
  apps: PortfolioApp[];
  groups: string[];
  assumptions: string[];
  questions: string[];
}

// ───────────── entities (DB rows as the app and tools see them) ─────────────

export interface RunInfo {
  id: string;
  name: string;
  status: RunStatus;
  brief: string;
  dryRun: boolean;
  studioProjectId: string | null;
  appsRoot: string | null;
  budgetCap: number;
  maxAgents: number;
  concurrency: number;
  spawnsPaused: boolean;
  autoAdvance: AutoAdvance;
  limits: HelmLimits;
  slots: SlotMap;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

export interface AppInfo {
  id: string;
  runId: string;
  name: string;
  tagline: string;
  platforms: Platform[];
  shape: Shape;
  managerNodeId: string | null;
  projectId: string | null;
  repoPath: string | null;
  stage: Stage;
  priority: Priority;
  fixRound: number;
  pct: number;
  order: number;
  test: boolean;
  slotOverrides: SlotMap;
  waivedGates: string[];
  /** The folder the human named for this app (unexpanded), or null for Helm's default. */
  targetPath: string | null;
  /** Read-only reference folders for this app's agents. */
  reads: string[];
  /** True when the app is an existing repository Helm adopted (it works on its own branch there). */
  adopted: boolean;
  /** Adopted repos: the branch Helm created for the run, and the branch the human had checked out. */
  helmBranch: string | null;
  userBranch: string | null;
  kind: ProjectKind;
  needs: ProjectNeed[];
  tools: string[];
}

/** What wakes a custom agent (instead of polling): a stage change, an app reaching Ready, a sign-off, a failure, in its scope. */
export type WakeEvent = "stage" | "ready" | "signoff" | "failed";
export const WAKE_EVENTS: WakeEvent[] = ["stage", "ready", "signoff", "failed"];

export interface NodeInfo {
  id: string;
  runId: string;
  appId: string | null;
  tier: Tier;
  role: Role;
  /** A personal name ("Gestra", "Amer", "Ledger"); the human or the Planner can change it. */
  name: string | null;
  /** A custom agent's job title ("GitHub Sync"). */
  title: string | null;
  /** A custom agent's mission, as the Planner wrote it. */
  charter: string | null;
  wakeOn: WakeEvent[];
  /** Who designed it (a custom agent: the Planner's node id). */
  createdBy: string | null;
  platform: Platform | null;
  parentId: string | null;
  threadId: string | null;
  status: NodeStatus;
  alsoLead: boolean;
  slot: SlotId;
  model: ModelRef | null;
  modelOverride: boolean;
  briefVersion: number;
  scopeGlobs: string[];
  branch: string | null;
  priority: Priority;
  nowLine: string | null;
  topics: string[];
  tokens: number;
  turns: number;
  cost: number;
  touched: boolean;
  warning: string | null;
  createdAt: number;
  spawnedAt: number | null;
  endedAt: number | null;
  lastActivityAt: number | null;
}

export interface RecipientInfo {
  directiveId: string;
  nodeId: string;
  level: RecipientLevel;
  world: boolean;
  state: ReceiptState;
  notice: string;
  deliveredAt: number | null;
  ackAt: number | null;
  ackNote: string | null;
}

export interface DirectiveInfo {
  id: string;
  runId: string;
  ts: number;
  type: DirectiveType;
  targetNodeId: string;
  cascade: Cascade;
  mode: DeliveryMode;
  policy: boolean;
  text: string;
  value: unknown;
  modelFrom: ModelRef | null;
  modelTo: ModelRef | null;
  affected: string[];
  actor: "human" | "system" | "agent";
  /** The supervisor that issued it, when actor is "agent" (helm_direct). */
  byNode: string | null;
  implicit: boolean;
  summary: string;
  recipients: RecipientInfo[];
}

export interface PolicyInfo {
  id: string;
  runId: string;
  text: string;
  scopeNodeId: string;
  fromDirective: string | null;
  createdAt: number;
  retiredAt: number | null;
}

export interface NeedInfo {
  id: string;
  runId: string;
  kind: NeedKind;
  nodeId: string | null;
  appId: string | null;
  title: string;
  body: string;
  evidence: string;
  options: string[];
  interactionId: string | null;
  state: "open" | "resolved";
  createdAt: number;
  resolvedAt: number | null;
  resolution: unknown;
  /** Machine data the resolver needs (wave app ids, finding ids, interaction payload). */
  data?: unknown;
}

export interface FindingInfo {
  id: string;
  runId: string;
  appId: string;
  gate: "review" | "slop" | "scan";
  rule: string;
  severity: Severity;
  path: string;
  line: number;
  quote: string;
  why: string;
  fix: string;
  commitSha: string | null;
  status: FindingStatus;
  round: number;
  ownerNodeId: string | null;
  waiverDirectiveId: string | null;
  createdAt: number;
}

export interface CheckInfo {
  id: string;
  runId: string;
  appId: string;
  name: string;
  command: string;
  status: "pass" | "fail" | "unverified";
  exitCode: number | null;
  outputRef: string | null;
  commitSha: string | null;
  tier: CheckTier;
  nodeId: string | null;
  ts: number;
}

export interface NodeEventInfo {
  id: number;
  runId: string;
  nodeId: string;
  ts: number;
  kind: string;
  summary: string;
  ref: string | null;
}

export interface CommsInfo {
  id: number;
  runId: string;
  ts: number;
  fromNode: string;
  toNode: string;
  kind: string;
  summary: string;
  directiveId: string | null;
}

export interface ReportInfo {
  id: number;
  runId: string;
  nodeId: string;
  ts: number;
  status: "progress" | "blocked" | "done" | "failed";
  summary: string;
  evidence: EvidenceRef[];
  verified: boolean;
  problems: string[];
}

export interface EvidenceRef {
  kind: "commit" | "file" | "check" | "report";
  ref: string;
  branch?: string;
}

export interface StageHistoryInfo {
  appId: string;
  stage: Stage;
  enteredAt: number;
  exitedAt: number | null;
  evidence: unknown;
}

export interface VerdictInfo {
  id: string;
  appId: string;
  gate: "review" | "slop";
  commit: string;
  verdict: "pass" | "fail";
  summary: string;
  checks: Array<{ id: string; ok: boolean; how: string; ref: string }>;
  unverified: Array<{ what: string; reason: string }>;
  accepted: boolean;
  problems: string[];
  ts: number;
}

/** A row in the live model catalog, normalized from providers.models. */
export interface CatalogModel {
  providerId: string;
  providerLabel: string;
  modelId: string;
  name: string;
  description: string | null;
  family: string;
  reasoning: string[];
  defaultReasoning: string | null;
  serviceTiers: string[];
  isDefault: boolean;
  isNew: boolean;
  hidden: boolean;
  weight: number;
  weightKnown: boolean;
}

export interface Catalog {
  hostId: string | null;
  fetchedAt: number;
  providers: Array<{ id: string; label: string; available: boolean; error: string | null; permissionModes?: PermissionMode[] | null }>;
  models: CatalogModel[];
}
