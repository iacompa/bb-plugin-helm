// Engine-wide settings and small helpers shared by the engine modules.
import type { HelmLimits, ModelRef, Tier } from "../../shared/types.ts";
import { LIMIT_DEFAULTS } from "../../shared/types.ts";
import { SEED_WEIGHTS } from "../domain/models.ts";
import type { PermissionMode } from "../bb/port.ts";

export interface HelmSettings {
  limits: HelmLimits;
  permissionMode: Record<Tier, PermissionMode>;
  showLeadsInSidebar: boolean;
  /** Parent folder for runs; a run lives at <appsRoot>/<run-slug>/<app> (D2). */
  appsRoot: string;
  weights: Record<string, number>;
  zeroTolerance: string[];
  createRemote: boolean;
  /** Run-level standing policies seeded at run start (§6.7). */
  runPolicies: string[];
  autoAdvance: "ask" | "auto";
  /** Who answers an agent's BB permission prompt: its supervisor (escalating only what the human must decide) or the human. */
  approvePrompts: "supervisor" | "human";
  /** Default personal names for new runs ("" = none: just the role); any agent can be renamed later. */
  names: { planner: string; orchestrator: string; git: string };
  /** Default models (settings plannerModel, orchestratorModel, gitModel): used when a run's slot is empty. */
  defaultModels: { planner: ModelRef | null; orchestrator: ModelRef | null; git: ModelRef | null };
  /** What the Git agent does when the human signs a project off. */
  gitOnSignoff: "push" | "merge-push" | "report";
}

export const DEFAULT_SETTINGS: HelmSettings = {
  limits: LIMIT_DEFAULTS,
  permissionMode: { orchestrator: "auto", manager: "auto", lead: "auto", specialist: "auto", gate: "auto", planner: "auto", git: "auto", custom: "auto" },
  names: { planner: "", orchestrator: "", git: "" },
  defaultModels: { planner: null, orchestrator: null, git: null },
  gitOnSignoff: "merge-push",
  showLeadsInSidebar: false,
  appsRoot: "~/Projects/helm",
  weights: SEED_WEIGHTS,
  zeroTolerance: ["S1", "S2", "S3", "S5", "S6"],
  createRemote: false,
  runPolicies: ["Slop gates are zero-tolerance for secrets, placeholders and invented dependencies."],
  autoAdvance: "ask",
  approvePrompts: "supervisor",
};

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** run_<ulid>-style id: 10 chars of time + 16 of randomness, Crockford base32, lowercase. */
export function newRunId(now: number, rand: () => number = Math.random): string {
  const A = "0123456789abcdefghjkmnpqrstvwxyz";
  let t = now;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = A[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let r = "";
  for (let i = 0; i < 16; i++) r += A[Math.floor(rand() * 32)];
  return `run_${time}${r}`;
}

export function pad4(n: number): string {
  return String(n).padStart(4, "0");
}

export function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Expand a leading ~ against HOME (the host entry resolves the real path; this is for display and storage). */
export function expandHome(p: string, home: string | undefined): string {
  if (p === "~") return home ?? p;
  if (p.startsWith("~/") && home) return `${home}${p.slice(1)}`;
  return p;
}
