// Per-app stage machine (§5.1) and board drag rules (§5.7). Stages advance on
// evidence; the only human moves are the four listed in BOARD rules.
import type { NodeStatus, ProjectKind, Stage } from "../../shared/types.ts";

export const STAGES: Array<{ id: Stage; label: string; hint: string }> = [
  { id: "intake", label: "Intake", hint: "Waiting for capacity or a spec slot" },
  { id: "spec", label: "Spec", hint: "Lead writes SPEC, ARCHITECTURE, CONTRACT" },
  { id: "build", label: "Build", hint: "Specialists build in parallel worktrees" },
  { id: "integrate", label: "Integrate", hint: "Lead merges, runs deterministic checks" },
  { id: "review", label: "Review", hint: "Independent Reviewer agent" },
  { id: "slop", label: "Slop check", hint: "Slop Hunter + deterministic slop scan" },
  { id: "fix", label: "Fix", hint: "At most two fix rounds" },
  { id: "ready", label: "Ready", hint: "Gates green — waiting for your sign-off" },
  { id: "done", label: "Done", hint: "Signed off" },
];

export const STAGE_IDX: Record<Stage, number> = {
  intake: 0,
  spec: 1,
  build: 2,
  integrate: 3,
  review: 4,
  slop: 5,
  fix: 6,
  ready: 7,
  done: 8,
  cancelled: 9,
};

export function stageLabel(s: Stage): string {
  return STAGES.find((x) => x.id === s)?.label ?? (s === "cancelled" ? "Cancelled" : s);
}

export const IN_FLIGHT: Stage[] = ["spec", "build", "integrate", "review", "slop", "fix"];

export function isInFlight(s: Stage): boolean {
  return IN_FLIGHT.includes(s);
}

/** Transitions an App Lead may request through helm_stage. */
export const LEAD_TRANSITIONS: Partial<Record<Stage, Stage[]>> = {
  spec: ["build"],
  build: ["integrate"],
  integrate: ["review"],
  fix: ["integrate"],
};

/** Engine-driven transitions (gate verdicts, wave approval, sign-off). */
export const ENGINE_TRANSITIONS: Partial<Record<Stage, Stage[]>> = {
  intake: ["spec"],
  review: ["slop", "fix"],
  slop: ["ready", "fix"],
  fix: ["integrate", "build"],
  ready: ["done", "build"],
  done: ["ready"],
};

export const SPEC_FILES = ["SPEC.md", "ARCHITECTURE.md", "CONTRACT.md", "ACCEPTANCE.md"];

/** What Spec must commit before Build. A review project's plan is its ACCEPTANCE.md: what is audited, how, and what counts as evidence. */
export function specFilesFor(kind: ProjectKind = "app"): string[] {
  return kind === "review" ? ["ACCEPTANCE.md"] : SPEC_FILES;
}

/** The report a review project hands to its gates. */
export const REVIEW_FILE = "REVIEW.md";

export interface TransitionFacts {
  /** files that exist (and are committed) at the integration HEAD */
  committedFiles: Set<string>;
  /** every spawned builder has a verified done report */
  buildersDone: boolean;
  buildersPending: string[];
  /** deterministic checks green on the integration HEAD */
  checksGreen: boolean;
  checksMissing: string[];
  checksFailing: string[];
  integrationHead: string | null;
  /** A review project audits; its checks are evidence (a failure is a finding), and REVIEW.md is what the gates judge. */
  kind?: ProjectKind;
}

const WAIT_FOR_REPORTS = "Helm messages you as each report arrives, so wait for those rather than asking again; steer a builder that is stuck with helm_direct.";

/** Who moves an app out of a stage the lead cannot leave itself. */
const ADVANCES_BY: Partial<Record<Stage, string>> = {
  intake: "it leaves Intake when the Orchestrator's wave is approved",
  review: "Helm moves it on the Reviewer's verdict and tells you",
  slop: "Helm moves it on the Slop Hunter's verdict and tells you",
  ready: "it waits for the human's sign-off or send-back",
  done: "it is signed off",
  cancelled: "it was cancelled",
};

/** Can the lead move from → to right now? Returns the reason when not. */
export function leadTransition(from: Stage, to: Stage, facts: TransitionFacts): { ok: true } | { ok: false; reason: string } {
  const allowed = LEAD_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to))
    return {
      ok: false,
      reason:
        from === to ? `The app is already in ${stageLabel(from)}; nothing to request.`
        : allowed.length ? `helm_stage cannot move ${stageLabel(from)} → ${stageLabel(to)}. From ${stageLabel(from)} you can request only ${allowed.map(stageLabel).join(" or ")}.`
        : `helm_stage cannot move ${stageLabel(from)} → ${stageLabel(to)}: there is nothing for you to request in ${stageLabel(from)}; ${ADVANCES_BY[from] ?? "Helm moves it"}.`,
    };
  if (to === "build") {
    const missing = specFilesFor(facts.kind).filter((f) => !facts.committedFiles.has(f));
    if (missing.length) return { ok: false, reason: `Spec is not complete: ${missing.join(", ")} not committed on the integration branch.` };
  }
  if (to === "integrate" && from === "build" && !facts.buildersDone)
    return { ok: false, reason: `Builders without a verified done report: ${facts.buildersPending.join(", ")}. ${WAIT_FOR_REPORTS}` };
  if (to === "integrate" && from === "fix" && !facts.buildersDone)
    return { ok: false, reason: `Fixes not reported with evidence yet: ${facts.buildersPending.join(", ")}. ${WAIT_FOR_REPORTS}` };
  if (to === "review") {
    if (!facts.integrationHead) return { ok: false, reason: "No integration HEAD found." };
    if (facts.kind === "review") {
      if (!facts.committedFiles.has(REVIEW_FILE)) return { ok: false, reason: `${REVIEW_FILE} is not committed on the integration branch: compile the auditors' findings into it first.` };
      return { ok: true };
    }
    if (facts.checksMissing.length) return { ok: false, reason: `Checks not recorded on ${facts.integrationHead.slice(0, 9)}: ${facts.checksMissing.join(", ")}. Run them through the check wrapper your BRIEF names and call helm_record_check.` };
    if (!facts.checksGreen) return { ok: false, reason: `Checks failing on ${facts.integrationHead.slice(0, 9)}: ${facts.checksFailing.join(", ")}.` };
  }
  return { ok: true };
}

/** Ready requires both gates passed and checks green on the same commit (A13). */
export function readyAllowed(input: {
  commit: string | null;
  reviewPassCommit: string | null;
  slopPassCommit: string | null;
  checksGreenCommit: string | null;
  openZeroTolerance: number;
  waivedGates: string[];
}): { ok: true } | { ok: false; reason: string } {
  if (!input.commit) return { ok: false, reason: "No integration commit." };
  const reviewOk = input.waivedGates.includes("review") || input.reviewPassCommit === input.commit;
  const slopOk = input.waivedGates.includes("slop") || input.slopPassCommit === input.commit;
  if (!reviewOk) return { ok: false, reason: "No valid Reviewer pass on this commit." };
  if (!slopOk) return { ok: false, reason: "No valid Slop Hunter pass on this commit." };
  if (input.checksGreenCommit !== input.commit) return { ok: false, reason: "Deterministic checks are not green on this commit." };
  if (input.openZeroTolerance > 0) return { ok: false, reason: `${input.openZeroTolerance} zero-tolerance findings are still open.` };
  return { ok: true };
}

// ───────────────────────────── board rules ─────────────────────────────

export type AppMove =
  | { ok: true; noop: true }
  | { ok: true; noop?: false; act: "signoff" | "sendback" | "start" | "reopen"; label: string }
  | { ok: false; why: string };

export function appMoveRule(app: { name: string; stage: Stage }, to: Stage): AppMove {
  const from = app.stage;
  if (from === to) return { ok: true, noop: true };
  if (from === "ready" && to === "done") return { ok: true, act: "signoff", label: "Sign off" };
  if (from === "ready" && to === "build") return { ok: true, act: "sendback", label: "Send back to Build" };
  if (from === "intake" && to === "spec") return { ok: true, act: "start", label: "Start now" };
  if (from === "done" && to === "ready") return { ok: true, act: "reopen", label: "Reopen" };
  if (from === "ready" || from === "done")
    return { ok: false, why: `${stageLabel(from)} apps can be signed off or sent back to Build — not moved to ${stageLabel(to)}.` };
  if (STAGE_IDX[to] > STAGE_IDX[from])
    return {
      ok: false,
      why: `${app.name} moves to ${stageLabel(to)} when its ${from === "build" ? "builders finish and integration checks pass" : from === "review" ? "Reviewer passes" : from === "slop" ? "Slop Hunter passes" : "work completes"} — stages advance on evidence, not on drag.`,
    };
  return { ok: false, why: "Stages don’t run backwards by drag. To redo work, send the app back from Ready, or tell its lead what to redo." };
}

export const TASK_COLS = [
  { id: "planned", label: "Planned", hint: "Not spawned yet" },
  { id: "queued", label: "Queued / held", hint: "Waiting for capacity, or paused by you" },
  { id: "running", label: "Running", hint: "" },
  { id: "waiting", label: "Waiting", hint: "On children, a gate, or fixes" },
  { id: "needs", label: "Needs you", hint: "Approvals, questions, failures" },
  { id: "done", label: "Done", hint: "" },
] as const;

export type TaskCol = (typeof TASK_COLS)[number]["id"];

export function colOfStatus(s: NodeStatus): TaskCol {
  const map: Record<NodeStatus, TaskCol> = {
    planned: "planned",
    queued: "queued",
    paused: "queued",
    idle: "queued",
    running: "running",
    waiting: "waiting",
    needs: "needs",
    failed: "needs",
    done: "done",
  };
  return map[s] ?? "queued";
}

export type TaskMove =
  | { ok: true; noop: true }
  | { ok: true; noop?: false; act: "start" | "spawn" | "hold"; label: string }
  | { ok: false; why: string };

export function taskMoveRule(node: { status: NodeStatus }, to: TaskCol): TaskMove {
  const from = colOfStatus(node.status);
  if (from === to) return { ok: true, noop: true };
  if ((from === "planned" || from === "queued") && to === "running")
    return { ok: true, act: "start", label: node.status === "planned" ? "Spawn and start now" : "Start now" };
  if (from === "planned" && to === "queued") return { ok: true, act: "spawn", label: "Spawn (queue)" };
  if (from === "running" && to === "queued") return { ok: true, act: "hold", label: "Hold" };
  if (from === "needs") return { ok: false, why: "This is waiting on you — resolve it in Needs you, then it moves on its own." };
  if (from === "done") return { ok: false, why: "Done work is final. To redo it, tell the lead what to change." };
  if (to === "done" || to === "waiting" || to === "needs")
    return { ok: false, why: `Agents move to ${TASK_COLS.find((c) => c.id === to)!.label} when they report it, not by drag.` };
  return { ok: false, why: "That move isn’t something you can force." };
}

/** Rough % complete for an app card — derived from stage, never claimed by an agent. */
export function stagePct(stage: Stage, fraction = 0): number {
  const base: Record<Stage, number> = { intake: 0, spec: 8, build: 25, integrate: 60, review: 72, slop: 82, fix: 75, ready: 100, done: 100, cancelled: 0 };
  const next: Record<Stage, number> = { intake: 8, spec: 25, build: 60, integrate: 72, review: 82, slop: 95, fix: 90, ready: 100, done: 100, cancelled: 0 };
  return Math.round(base[stage] + (next[stage] - base[stage]) * Math.max(0, Math.min(1, fraction)));
}
