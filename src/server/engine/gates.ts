// Stages, evidence, checks, gates and the fix loop (§5). Every advance is
// mechanically checked: commits must exist on branches, files at commits,
// checks must carry the wrapper trailer for the integration HEAD, and gate
// findings must quote real lines. Agents' claims never move a stage.

import { getTask, storeTask } from "./tasks.ts";
import type { AppInfo, CheckInfo, DirectiveInfo, EvidenceRef, FindingInfo, NodeInfo, Stage } from "../../shared/types.ts";
import type { Engine } from "./engine.ts";
import type { ScanOutput } from "../../shared/host-contract.ts";
import { leadTransition, readyAllowed, SPEC_FILES, stageLabel, stagePct } from "../domain/stages.ts";
import { missingChecks, parseChecksJson, verifyCheckClaim, type ChecksDecl } from "../domain/checks.ts";
import { validateVerdict, blocksReady, type Verdict, shaMatches } from "../domain/verdict.ts";
import { admissibleSpecialists, nodeIdFor, squadFor, type SquadMember } from "../domain/topology.ts";
import { roleLabel } from "../domain/roles.ts";
import { bottomUp } from "../domain/directives.ts";

const PLACEHOLDER_CMD = /set the (build|lint|test) command|^echo\s+['"]?set the/i;

// ───────────────────────────── helpers ─────────────────────────────

export async function nodeWorktree(e: Engine, n: NodeInfo): Promise<string | null> {
  const envId = e.repo.nodeEnvironment(n.runId, n.id);
  if (envId) {
    const env = await e.port.environment(envId);
    if (env?.path) return env.path;
  }
  if (n.threadId) return (await e.port.threadState(n.threadId))?.path ?? null;
  return null;
}

export async function integrationHead(e: Engine, app: AppInfo): Promise<string | null> {
  const extra = e.repo.appExtra(app.runId, app.id);
  if (!extra.integrationBranch || !app.repoPath) return null;
  return (await e.host(app.runId).revParse({ repo: app.repoPath, ref: extra.integrationBranch })).sha;
}

function appOf(e: Engine, n: NodeInfo): AppInfo | null {
  if (n.appId) return e.repo.getApp(n.runId, n.appId);
  if (n.alsoLead) return e.repo.listApps(n.runId)[0] ?? null;
  return null;
}

function setStage(e: Engine, runId: string, appId: string, stage: Stage, evidence: unknown): void {
  e.repo.updateApp(runId, appId, { stage, pct: stagePct(stage) });
  e.repo.enterStage(runId, appId, stage, evidence);
  const lead = e.leadOf(runId, appId);
  if (lead) e.repo.event(runId, lead.id, "stage", `${e.repo.getApp(runId, appId)?.name}: → ${stageLabel(stage)}`);
  e.emit(runId, "stage.changed", { appId, stage });
}

/** Verify evidence refs (§5.2). Returns the verified refs and the problems. */
export async function verifyEvidence(e: Engine, n: NodeInfo, evidence: EvidenceRef[]): Promise<{ verified: EvidenceRef[]; problems: string[] }> {
  const verified: EvidenceRef[] = [];
  const problems: string[] = [];
  const app = appOf(e, n);
  const host = e.host(n.runId);
  const repo = app?.repoPath ?? null;
  const integration = app ? e.repo.appExtra(n.runId, app.id).integrationBranch : null;
  for (const ev of evidence.slice(0, 20)) {
    const ref = String(ev.ref ?? "").trim();
    if (!ref) {
      problems.push(`empty ${ev.kind} ref`);
      continue;
    }
    if (ev.kind === "commit") {
      if (!repo) {
        problems.push(`commit ${ref}: no repository for this node`);
        continue;
      }
      const sha = (await host.revParse({ repo, ref })).sha;
      if (!sha) {
        problems.push(`commit ${ref} does not exist`);
        continue;
      }
      const branches = [ev.branch, n.branch, integration].filter((b): b is string => !!b);
      let onBranch = false;
      for (const b of branches) if ((await host.isAncestor({ repo, ancestor: sha, descendant: b })).ok) onBranch = true;
      if (!onBranch) {
        problems.push(`commit ${ref.slice(0, 9)} is not on ${branches.join(" or ") || "any known branch"}`);
        continue;
      }
      verified.push({ kind: "commit", ref: sha, branch: ev.branch });
    } else if (ev.kind === "file") {
      if (!repo) {
        problems.push(`file ${ref}: no repository`);
        continue;
      }
      const at = n.branch ?? integration ?? "HEAD";
      const c = (await host.fileAt({ repo, ref: at, path: ref, maxBytes: 4_000_000 })).content;
      const c2 = c ?? (integration && integration !== at ? (await host.fileAt({ repo, ref: integration, path: ref, maxBytes: 4_000_000 })).content : null);
      if (c2 === null) problems.push(`file ${ref} is not committed on ${at}`);
      else verified.push({ kind: "file", ref });
    } else if (ev.kind === "check") {
      if (!app) {
        problems.push(`check ${ref}: no app`);
        continue;
      }
      const head = await integrationHead(e, app);
      const row = e.repo.checks(n.runId, app.id).find((c) => c.name === ref && c.exitCode === 0 && !!head && !!c.commitSha && shaMatches(c.commitSha, head));
      if (!row) problems.push(`check ${ref} has no passing record on the integration HEAD${head ? ` ${head.slice(0, 9)}` : ""}`);
      else verified.push({ kind: "check", ref });
    } else if (ev.kind === "report") {
      const wt = await nodeWorktree(e, n);
      const c = wt ? (await host.readFile({ path: `${wt}/${ref.replace(/^\.\//, "")}` })).content : null;
      if (c === null) problems.push(`report ${ref} not found in your worktree`);
      else verified.push({ kind: "report", ref });
    }
  }
  return { verified, problems };
}

// ───────────────────────────── reports ─────────────────────────────

export async function report(e: Engine, n: NodeInfo, input: { status: "progress" | "blocked" | "done" | "failed"; summary: string; evidence?: EvidenceRef[]; blockers?: string[]; next?: string }): Promise<string> {
  const summary = input.summary.slice(0, 600);
  const { verified, problems } = await verifyEvidence(e, n, input.evidence ?? []);
  let ok = problems.length === 0;
  if (input.status === "done" && n.tier === "specialist") {
    const commits = verified.filter((v) => v.kind === "commit");
    const base = e.repo.getMeta(`base:${n.runId}:${n.id}`);
    const app = appOf(e, n);
    if (!commits.length) {
      ok = false;
      problems.push("done needs at least one commit on your branch as evidence");
    } else if (base && app?.repoPath) {
      // the commit you started from (or anything before it) is not your work
      let fresh = false;
      for (const c of commits) if (!(await e.host(n.runId).isAncestor({ repo: app.repoPath, ancestor: c.ref, descendant: base })).ok) fresh = true;
      if (!fresh) {
        ok = false;
        problems.push(`every cited commit was already on the integration branch when you started (${base.slice(0, 9)}); cite a commit you made. If there is nothing for you to do, report "blocked" and say so; your lead can release you`);
      }
    }
  }
  const parent = n.parentId ? e.repo.getNode(n.runId, n.parentId) : null;
  e.repo.tx(() => {
    e.repo.addReport(n.runId, n.id, { status: input.status, summary, evidence: verified, verified: ok, problems });
    e.repo.updateNode(n.runId, n.id, { nowLine: summary.slice(0, 160), lastActivityAt: e.now() });
    e.repo.event(n.runId, n.id, `report.${input.status}`, summary.slice(0, 200));
    if (input.status === "done") {
      if (ok && n.tier === "specialist") e.repo.updateNode(n.runId, n.id, { status: "done", endedAt: e.now(), warning: null });
      else if (!ok) e.repo.updateNode(n.runId, n.id, { warning: `claimed done without verifiable evidence: ${problems.join("; ").slice(0, 200)}` });
    }
    if (input.status === "blocked") e.repo.updateNode(n.runId, n.id, { warning: `blocked: ${(input.blockers ?? []).join("; ").slice(0, 160) || summary.slice(0, 160)}` });
    if (input.status === "failed") e.repo.updateNode(n.runId, n.id, { warning: `reported failed: ${summary.slice(0, 160)}` });
    if (parent) {
      const ev = verified.map((v) => `${v.kind} ${v.ref.slice(0, 12)}`).join(", ");
      const line = `${e.label(n)} — ${input.status}${ok ? "" : " (unverified)"}: ${summary}${ev ? ` [evidence: ${ev}]` : ""}${input.next ? ` Next: ${input.next.slice(0, 120)}` : ""}`;
      e.repo.comms(n.runId, { from: n.id, to: parent.id, kind: `report.${input.status}`, summary: line });
      if (input.status === "progress") {
        // progress never wakes an idle parent; at most once per 2 min per child (§8.1)
        const last = e.repo.nodeFlags(n.runId, n.id).lastReportForwardAt ?? 0;
        if (e.now() - last >= 120_000) {
          e.repo.updateNode(n.runId, n.id, { lastReportForwardAt: e.now() });
          e.fyi(n.runId, parent.id, line);
        }
      } else if (input.status === "done" && !ok) {
        e.fyi(n.runId, parent.id, line);
      } else {
        e.sendFromHelm(n.runId, parent.id, `Report from ${line}`, { key: `report:${n.runId}:${n.id}:${e.now()}` });
      }
    }
  });
  e.emit(n.runId, "node.updated", e.repo.getNode(n.runId, n.id));
  if (input.status === "done" && ok && n.tier === "specialist") {
    await admitDeferred(e, n);
    await e.pump(n.runId);
  }
  if (!ok) return `Recorded, but not verified: ${problems.join("; ")}. ${input.status === "done" ? "You stay in Waiting until a report with verifiable evidence (a commit on your branch) arrives." : ""}`.trim();
  return input.status === "done" ? "Recorded and verified. Your lead has been told. Stop now; you will be woken if there is more." : "Recorded.";
}

// ───────────────────────────── squad (lead) ─────────────────────────────

function squadNodes(e: Engine, runId: string, app: AppInfo): NodeInfo[] {
  return e.repo.listNodes(runId).filter((x) => x.appId === app.id && x.tier === "specialist");
}

function coreContractPublished(e: Engine, runId: string, app: AppInfo): boolean {
  const extra = e.repo.appExtra(runId, app.id);
  if (extra.contractVersion >= 2) return true;
  const core = e.repo.getNode(runId, `${app.id}.code`);
  return !!core && e.repo.reportsFor(runId, core.id, 50).some((r) => r.verified && r.evidence.length > 0);
}

export async function spawnSquad(e: Engine, lead: NodeInfo, spawn: Array<{ role: string; platform?: string | null; task?: string | null }>): Promise<string> {
  const app = appOf(e, lead);
  if (!app) return "No app for this lead.";
  if (!["build", "fix"].includes(app.stage)) return `The squad spawns in Build (the app is in ${stageLabel(app.stage)}). Move to Build with helm_stage first.`;
  const extra = e.repo.appExtra(lead.runId, app.id);
  if (extra.contractVersion < 1) return "Publish CONTRACT v1 first (helm_publish_contract).";
  const squad = squadNodes(e, lead.runId, app);
  const wanted: NodeInfo[] = [];
  const refused: string[] = [];
  for (const s of spawn.slice(0, 12)) {
    const id = s.role === "platform" ? `${app.id}.p.${s.platform}` : `${app.id}.${s.role}`;
    const nd = squad.find((x) => x.id === id);
    if (!nd) refused.push(`${s.role}${s.platform ? `/${s.platform}` : ""}: not in this app's ${app.shape} squad`);
    else if (nd.status !== "planned") refused.push(`${roleLabel(nd.role, nd.platform)}: already ${nd.status}`);
    else {
      // the lead's tailored task goes into the member's system prompt and brief
      const err = s.task?.trim() ? storeTask(e, lead, nd, s.task) : null;
      if (err) refused.push(`${roleLabel(nd.role, nd.platform)}: ${err}`);
      else wanted.push(nd);
    }
  }
  const untasked = wanted.filter((nd) => !getTask(e, lead.runId, nd.id)).map((nd) => roleLabel(nd.role, nd.platform));
  for (const nd of wanted) e.repo.setMeta(`squad:${lead.runId}:${nd.id}`, "requested");
  const res = await admitSquadMembers(e, lead.runId, app, wanted);
  const parts = [];
  if (res.started.length) parts.push(`accepted: ${res.started.join(", ")} (queued for capacity)`);
  if (res.deferred.length) parts.push(`deferred: ${res.deferred.join("; ")}`);
  if (refused.length) parts.push(`refused: ${refused.join("; ")}`);
  if (untasked.length) parts.push(`no task given for ${untasked.join(", ")} — they work from the role brief alone; helm_set_task gives each a tailored task`);
  return parts.join(" · ") || "Nothing to spawn.";
}

/** The lead drops squad members its SPEC no longer needs: stopped (never archived early), never re-admitted. */
export function releaseSquadMembers(e: Engine, lead: NodeInfo, release: Array<{ role: string; platform?: string | null; reason: string }>): string {
  const app = appOf(e, lead);
  if (!app) return "No app for this lead.";
  if (["ready", "done", "cancelled"].includes(app.stage)) return `${app.name} is ${stageLabel(app.stage)}; there is no squad to release.`;
  const squad = squadNodes(e, lead.runId, app);
  const released: string[] = [];
  const refused: string[] = [];
  e.repo.tx(() => {
    for (const r of release.slice(0, 12)) {
      const id = r.role === "platform" ? `${app.id}.p.${r.platform}` : `${app.id}.${r.role}`;
      const nd = squad.find((x) => x.id === id);
      const name = `${r.role}${r.platform ? `/${r.platform}` : ""}`;
      if (!nd) { refused.push(`${name}: not in this app's ${app.shape} squad`); continue; }
      if (nd.status === "done") { refused.push(`${roleLabel(nd.role, nd.platform)}: already done`); continue; }
      if (e.repo.getMeta(`squad:${lead.runId}:${nd.id}`) === "released") { released.push(roleLabel(nd.role, nd.platform)); continue; }
      const reason = r.reason.trim().slice(0, 300) || "not needed";
      e.repo.setMeta(`squad:${lead.runId}:${nd.id}`, "released");
      e.repo.updateNode(lead.runId, nd.id, { status: nd.threadId ? "idle" : "planned", endedAt: e.now(), warning: `released by the lead: ${reason}` });
      e.repo.event(lead.runId, nd.id, "released", reason.slice(0, 200));
      if (nd.threadId) e.repo.enqueue({ id: e.oid(), runId: lead.runId, kind: "stop", nodeId: lead.id, payload: { nodeIds: [nd.id] }, idemKey: `release:${lead.runId}:${nd.id}` });
      released.push(roleLabel(nd.role, nd.platform));
    }
  });
  for (const r of squad) if (released.includes(roleLabel(r.role, r.platform))) e.emit(lead.runId, "node.updated", e.repo.getNode(lead.runId, r.id));
  e.outbox.kick();
  const parts = [];
  if (released.length) parts.push(`released: ${released.join(", ")} (stopped; not waited for at Integrate)`);
  if (refused.length) parts.push(`refused: ${refused.join("; ")}`);
  return parts.join(" · ") || "Nothing to release.";
}

async function admitSquadMembers(e: Engine, runId: string, app: AppInfo, wanted: NodeInfo[]): Promise<{ started: string[]; deferred: string[] }> {
  const run = e.run(runId);
  const squad = squadNodes(e, runId, app);
  const active = squad.filter((x) => ["queued", "running", "waiting", "needs", "paused"].includes(x.status)).length;
  const plan = e.plan(runId).apps.find((a) => a.id === app.id);
  const members: SquadMember[] = wanted.map((w) => ({ role: w.role, platform: w.platform }));
  const r = admissibleSpecialists(members, active, run.limits.leadSpan, !!plan?.staggered, coreContractPublished(e, runId, app));
  const started: string[] = [];
  const deferred: string[] = [];
  e.repo.tx(() => {
    for (const m of r.start) {
      const id = nodeIdFor(app.id, m);
      e.repo.updateNode(runId, id, { status: "queued", warning: null });
      e.repo.setMeta(`squad:${runId}:${id}`, "admitted");
      started.push(roleLabel(m.role, m.platform));
    }
    for (const d of r.deferred) {
      const id = nodeIdFor(app.id, d.member);
      e.repo.updateNode(runId, id, { warning: `deferred: ${d.reason}` });
      deferred.push(`${roleLabel(d.member.role, d.member.platform)} — ${d.reason}`);
    }
  });
  await e.pump(runId);
  return { started, deferred };
}

/** A builder finished: start deferred squad members the lead already asked for (C7). */
async function admitDeferred(e: Engine, n: NodeInfo): Promise<void> {
  const app = appOf(e, n);
  if (!app) return;
  const pending = squadNodes(e, n.runId, app).filter((x) => x.status === "planned" && e.repo.getMeta(`squad:${n.runId}:${x.id}`) === "requested");
  if (pending.length) await admitSquadMembers(e, n.runId, app, pending);
}

export function publishContract(e: Engine, lead: NodeInfo, version: number, summary: string): string {
  const app = appOf(e, lead);
  if (!app) return "No app for this lead.";
  const extra = e.repo.appExtra(lead.runId, app.id);
  if (version <= extra.contractVersion) return `CONTRACT is already v${extra.contractVersion}; publish v${extra.contractVersion + 1} or later.`;
  e.repo.tx(() => {
    e.repo.updateApp(lead.runId, app.id, { contractVersion: version });
    e.repo.event(lead.runId, lead.id, "contract", `CONTRACT v${version}: ${summary.slice(0, 200)}`);
    for (const b of squadNodes(e, lead.runId, app).filter((x) => x.threadId && !["done", "idle", "failed"].includes(x.status)))
      e.sendFromHelm(lead.runId, b.id, `CONTRACT.md is now v${version} (${summary.slice(0, 300)}). Pull the integration branch and adapt; reply with helm_report if this changes your plan.`, { key: `contract:${lead.runId}:${app.id}:${version}:${b.id}`, senderNodeId: lead.id, kind: "message", commsKind: "contract" });
  });
  void admitDeferred(e, lead);
  return `CONTRACT v${version} published; ${squadNodes(e, lead.runId, app).filter((x) => x.threadId).length} builders notified.`;
}

// ───────────────────────────── existing repositories ─────────────────────────────

const DOC_FILE: Record<"spec" | "architecture" | "contract" | "acceptance", string> = { spec: "SPEC.md", architecture: "ARCHITECTURE.md", contract: "CONTRACT.md", acceptance: "ACCEPTANCE.md" };

export interface ExistingDecl {
  docs: Partial<Record<keyof typeof DOC_FILE, string>>;
  checks: ChecksDecl | null;
  reason: string | null;
}

/** What a lead in an adopted repository declared with helm_existing_docs (Helm's DB, never the repo). */
export function existingFor(e: Engine, runId: string, appId: string): ExistingDecl | null {
  const raw = e.repo.getMeta(`existing:${runId}:${appId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ExistingDecl;
  } catch {
    return null;
  }
}

/** helm_existing_docs: reuse the repository's own documents and check commands (no Helm files, no bootstrap commits). */
export async function declareExisting(e: Engine, lead: NodeInfo, p: { docs?: ExistingDecl["docs"]; checks?: ChecksDecl; reason?: string }): Promise<string> {
  const app = appOf(e, lead);
  if (!app) return "No app for this lead.";
  if (!app.adopted || !app.repoPath)
    return "Rejected: helm_existing_docs is only for an app in an existing repository. Here, commit SPEC.md, ARCHITECTURE.md, CONTRACT.md, ACCEPTANCE.md and .helm/checks.json on the integration branch.";
  if (!p.docs && !p.checks) return "Rejected: name at least one document (docs) or check (checks).";
  const host = e.host(lead.runId);
  const head = (await integrationHead(e, app)) ?? e.repo.appExtra(lead.runId, app.id).baseCommit;
  if (!head) return "Rejected: the integration branch has no commit yet.";
  const missing: string[] = [];
  for (const [k, path] of Object.entries(p.docs ?? {})) if (path && (await host.fileAt({ repo: app.repoPath, ref: head, path })).content === null) missing.push(`${k}: ${path}`);
  if (missing.length) return `Rejected: not committed at ${head.slice(0, 9)}: ${missing.join(", ")}. Name files that exist on the integration branch.`;
  const placeholders = Object.entries(p.checks ?? {}).filter(([, d]) => PLACEHOLDER_CMD.test(d.command) || /^\s*(true|:|exit 0|echo\b)/.test(d.command)).map(([k]) => k);
  if (placeholders.length) return `Rejected: these checks do not run anything real: ${placeholders.join(", ")}. Use the repository's actual build, lint and test commands.`;
  const prev = existingFor(e, lead.runId, app.id);
  const next: ExistingDecl = { docs: { ...(prev?.docs ?? {}), ...(p.docs ?? {}) }, checks: p.checks ? { ...(prev?.checks ?? {}), ...p.checks } : prev?.checks ?? null, reason: p.reason ?? prev?.reason ?? null };
  e.repo.setMeta(`existing:${lead.runId}:${app.id}`, JSON.stringify(next));
  const docs = Object.entries(next.docs).map(([k, v]) => `${k} = ${v}`);
  const checks = Object.keys(next.checks ?? {});
  e.repo.event(lead.runId, lead.id, "existing", `uses existing documents (${docs.join(", ") || "none"}) and checks (${checks.join(", ") || "none"})`);
  const stillNeeded = (Object.keys(DOC_FILE) as Array<keyof typeof DOC_FILE>).filter((k) => !next.docs[k]).map((k) => DOC_FILE[k]);
  return `Recorded at ${head.slice(0, 9)}. Documents: ${docs.join(", ") || "none"}. Checks: ${checks.join(", ") || "none (Helm will look for .helm/checks.json)"}.${stillNeeded.length ? ` Still needed for Build: ${stillNeeded.join(", ")} (name an existing file for each, or commit one).` : ""}`;
}

// ───────────────────────────── stage transitions (lead) ─────────────────────────────

export async function stageRequest(e: Engine, lead: NodeInfo, to: Stage, evidence: EvidenceRef[]): Promise<string> {
  const app = appOf(e, lead);
  if (!app) return "No app for this lead.";
  if (!app.repoPath) return "The app repository is not ready yet.";
  const host = e.host(lead.runId);
  const head = await integrationHead(e, app);
  const extra = e.repo.appExtra(lead.runId, app.id);
  const committed = new Set<string>();
  const existing = app.adopted ? existingFor(e, lead.runId, app.id) : null;
  if (head)
    for (const f of SPEC_FILES) {
      // an existing repository may reuse its own documents (helm_existing_docs)
      const mapped = existing ? Object.entries(DOC_FILE).find(([, file]) => file === f)?.[0] : undefined;
      const alt = mapped ? existing!.docs[mapped as keyof typeof DOC_FILE] : undefined;
      if (alt && (await host.fileAt({ repo: app.repoPath, ref: head, path: alt })).content !== null) {
        committed.add(f);
        continue;
      }
      const now = (await host.fileAt({ repo: app.repoPath, ref: head, path: f })).content;
      if (now === null) continue;
      // an adopted repository may already have an ARCHITECTURE.md: it counts only once this run changed it
      if (app.adopted && extra.baseCommit && (await host.fileAt({ repo: app.repoPath, ref: extra.baseCommit, path: f })).content === now) continue;
      committed.add(f);
    }
  const builders = squadNodes(e, lead.runId, app).filter((x) => x.threadId || x.status === "queued");
  let pending: string[] = [];
  // a builder the lead released, or one the human stopped, is not waited for
  const outOfPlay = (b: NodeInfo) => b.status === "idle" || e.repo.getMeta(`squad:${lead.runId}:${b.id}`) === "released";
  if (to === "integrate" && app.stage === "build") pending = builders.filter((b) => !outOfPlay(b) && !e.repo.lastVerifiedDone(lead.runId, b.id)).map((b) => e.label(b));
  if (to === "integrate" && app.stage === "fix") {
    const open = e.repo.findings(lead.runId, app.id).filter((f) => f.status === "open" && f.round === app.fixRound && (f.severity === "blocker" || f.severity === "major"));
    for (const f of open) {
      if (!f.ownerNodeId || f.ownerNodeId === lead.id) continue;
      const done = e.repo.reportsFor(lead.runId, f.ownerNodeId, 50).find((r) => r.status === "done" && r.verified && r.ts >= f.createdAt);
      if (!done) pending.push(`${f.id} (owner ${f.ownerNodeId})`);
    }
  }
  let checksGreen = true;
  let checksMissing: string[] = [];
  let checksFailing: string[] = [];
  let extraProblem: string | null = null;
  if (to === "review" && head) {
    const declText = (await host.fileAt({ repo: app.repoPath, ref: head, path: ".helm/checks.json" })).content;
    const decl = parseChecksJson(declText) ?? existing?.checks ?? null;
    const placeholders = decl ? Object.entries(decl).filter(([, d]) => (d.tier ?? "local") === "local" && PLACEHOLDER_CMD.test(d.command)).map(([k]) => k) : [];
    if (placeholders.length) extraProblem = `.helm/checks.json still has placeholder commands for: ${placeholders.join(", ")}. Set real build/lint/test commands from ACCEPTANCE.md.`;
    const recorded = e.repo.checks(lead.runId, app.id).map((c) => ({ name: c.name, exitCode: c.exitCode, commitSha: c.commitSha }));
    const mc = missingChecks(decl, recorded, head);
    checksMissing = mc.missing;
    checksFailing = mc.failing;
    checksGreen = !mc.missing.length && !mc.failing.length;
    if (!extraProblem) {
      const scan = await host.scan({ repo: app.repoPath, ref: head });
      const hard = scan.findings.filter((f) => blocksReady(f, e.settings.zeroTolerance));
      if (hard.length) extraProblem = `The deterministic scanner found ${hard.length} zero-tolerance item${hard.length === 1 ? "" : "s"} on ${head.slice(0, 9)}: ${hard.slice(0, 6).map((f) => `${f.rule} ${f.path}:${f.line}`).join(", ")}${hard.length > 6 ? "…" : ""}. Fix them first (helm_slop_scan lists them).`;
    }
  }
  const check = leadTransition(app.stage, to, { committedFiles: committed, buildersDone: pending.length === 0, buildersPending: pending, checksGreen, checksMissing, checksFailing, integrationHead: head });
  if (!check.ok) return `Rejected: ${check.reason}`;
  if (extraProblem) return `Rejected: ${extraProblem}`;
  const { verified, problems } = await verifyEvidence(e, lead, evidence);
  if (problems.length) return `Rejected: evidence did not verify — ${problems.join("; ")}.`;
  e.repo.tx(() => {
    if (head) e.repo.updateApp(lead.runId, app.id, { integrationHead: head });
    setStage(e, lead.runId, app.id, to, { by: lead.id, head, evidence: verified, contract: extra.contractVersion });
  });
  if (to === "review") await enterGate(e, lead.runId, app.id, "review");
  return `${app.name} is now in ${stageLabel(to)}${head ? ` at ${head.slice(0, 9)}` : ""}.${to === "build" ? " Next: helm_spawn_squad." : to === "review" ? " The Reviewer has been engaged; wait for the verdict." : ""}`;
}

// ───────────────────────────── checks ─────────────────────────────

export async function recordCheck(e: Engine, n: NodeInfo, input: { name: string; command: string; exitCode: number; outputRef: string; commit: string }): Promise<string> {
  const app = appOf(e, n);
  if (!app) return "No app for this node.";
  if (!input.command.trim()) return "Rejected: a check needs the command that ran.";
  const wt = await nodeWorktree(e, n);
  const out = wt ? (await e.host(n.runId).readFile({ path: `${wt}/${input.outputRef.replace(/^\.\//, "")}` })).content : null;
  const head = await integrationHead(e, app);
  const v = verifyCheckClaim({ exitCode: input.exitCode, commit: input.commit }, out, head);
  if (!v.ok) return `Rejected: ${v.reason}.`;
  const sha = (await e.host(n.runId).revParse({ repo: app.repoPath!, ref: v.trailer.commit })).sha ?? v.trailer.commit;
  const row: CheckInfo = { id: `C-${e.oid().slice(2)}`, runId: n.runId, appId: app.id, name: input.name.slice(0, 80), command: input.command.slice(0, 400), status: input.exitCode === 0 ? "pass" : "fail", exitCode: input.exitCode, outputRef: input.outputRef.slice(0, 300), commitSha: sha, tier: "local", nodeId: n.id, ts: e.now() };
  e.repo.tx(() => {
    e.repo.insertCheck(row);
    e.repo.event(n.runId, n.id, "check", `${row.name} ${row.status} on ${sha.slice(0, 9)}`);
  });
  const atHead = !!head && shaMatches(sha, head);
  return `Recorded ${row.name}: ${row.status} on ${sha.slice(0, 9)}${atHead ? "" : head ? ` (note: the integration HEAD is ${head.slice(0, 9)}, so this does not count toward it)` : ""}.`;
}

export async function slopScan(e: Engine, n: NodeInfo, paths: string[] | undefined): Promise<string> {
  const app = appOf(e, n);
  if (!app?.repoPath) return "No repository yet.";
  const ref = n.tier === "gate" ? (e.repo.appExtra(n.runId, app.id).integrationHead ?? "HEAD") : n.branch ?? e.repo.appExtra(n.runId, app.id).integrationBranch ?? "HEAD";
  const res = await e.host(n.runId).scan({ repo: app.repoPath, ref, paths, history: n.tier !== "specialist" });
  const hard = res.findings.filter((f) => blocksReady(f, e.settings.zeroTolerance));
  if (res.commit && e.isLeadNode(n) && !paths?.length) {
    const head = await integrationHead(e, app);
    if (head && shaMatches(res.commit, head))
      e.repo.insertCheck({ id: `C-${e.oid().slice(2)}`, runId: n.runId, appId: app.id, name: "slop-scan", command: "helm_slop_scan", status: hard.length ? "fail" : "pass", exitCode: hard.length ? 1 : 0, outputRef: null, commitSha: res.commit, tier: "local", nodeId: n.id, ts: e.now() });
  }
  const lines = res.findings.slice(0, 40).map((f) => `${f.rule} ${f.severity} ${f.path}:${f.line} — ${f.quote.slice(0, 80)}`);
  return `Scanned ${res.filesScanned} files at ${res.commit?.slice(0, 9) ?? ref}: ${res.findings.length} findings (${hard.length} zero-tolerance).${lines.length ? `\n${lines.join("\n")}` : ""}${res.findings.length > 40 ? `\n…and ${res.findings.length - 40} more.` : ""}${res.unverified.length ? `\nNot verified: ${res.unverified.join("; ")}` : ""}`;
}

/**
 * Scanner findings are stored with gate "scan" (appendix B §4) and kept in step with the latest scan
 * of the judged commit: a finding the scanner no longer reports is fixed; waived ones stay waived.
 * Open zero-tolerance scan findings block Ready like any other (§5.3).
 */
export function syncScanFindings(e: Engine, runId: string, appId: string, head: string, found: ScanOutput["findings"]): void {
  const key = (f: { rule: string; path: string; quote: string }) => `${f.rule}|${f.path}|${f.quote.trim()}`;
  const existing = e.repo.findings(runId, appId).filter((f) => f.gate === "scan");
  const now = new Set(found.map(key));
  for (const f of existing) if (f.status === "open" && !now.has(key(f))) e.repo.updateFinding(runId, f.id, { status: "fixed" });
  const known = new Set(existing.filter((f) => f.status !== "fixed").map(key));
  for (const f of found) {
    if (known.has(key(f))) continue;
    known.add(key(f));
    e.repo.insertFinding({ id: `F-${e.repo.nextSeq(runId, "finding")}`, runId, appId, gate: "scan", rule: f.rule, severity: f.severity, path: f.path, line: f.line, quote: f.quote.slice(0, 200), why: f.why, fix: f.fix, commitSha: head, status: "open", round: 0, ownerNodeId: null, waiverDirectiveId: null, createdAt: e.now() });
  }
}

// ───────────────────────────── gates ─────────────────────────────

/** Engage the Reviewer or Slop Hunter on the current integration HEAD (spawn or re-check). */
export async function enterGate(e: Engine, runId: string, appId: string, gate: "review" | "slop"): Promise<void> {
  const app = e.repo.getApp(runId, appId)!;
  const g = e.repo.getNode(runId, `${appId}.${gate}`);
  if (!g) return;
  const head = e.repo.appExtra(runId, appId).integrationHead;
  if (!head) return;
  let scanner: string | null = null;
  let scanFindings: ScanOutput["findings"] | null = null;
  if (gate === "slop" && app.repoPath) {
    const res = await e.host(runId).scan({ repo: app.repoPath, ref: head, history: true });
    scanFindings = res.findings;
    scanner = res.findings.length ? res.findings.slice(0, 30).map((f) => `- ${f.rule} ${f.severity} ${f.path}:${f.line} “${f.quote.slice(0, 80)}”`).join("\n") : "- none";
  }
  e.repo.tx(() => {
    if (scanFindings) syncScanFindings(e, runId, appId, head, scanFindings);
    if (!g.threadId) {
      if (g.status === "planned" || g.status === "idle") e.repo.updateNode(runId, g.id, { status: "queued", firstInLine: true });
      if (scanner) e.repo.setMeta(`scanner:${runId}:${g.id}`, scanner);
    } else {
      const prior = e.repo.findings(runId, appId).filter((f) => f.gate === gate && f.status !== "open" && f.status !== "waived").map((f) => f.id);
      const open = e.repo.findings(runId, appId).filter((f) => f.gate === gate && f.status === "open").map((f) => `${f.id} ${f.path}:${f.line}`);
      e.repo.updateNode(runId, g.id, { status: "running", lastActivityAt: e.now(), nudgedAt: null });
      e.sendFromHelm(runId, g.id, `Re-check commit ${head}: run \`git checkout --detach ${head}\`, verify the earlier findings first${open.length ? ` (${open.join(", ")})` : prior.length ? ` (${prior.join(", ")})` : ""}, then review the new diff and re-run every check through the wrapper. Answer with one helm_verdict.${scanner ? `\nScanner findings at this commit:\n${scanner}` : ""}`, { key: `recheck:${runId}:${g.id}:${head}`, bypassPause: false });
    }
    e.repo.event(runId, g.id, "gate", `${gate === "review" ? "Reviewer" : "Slop Hunter"} engaged on ${head.slice(0, 9)}`);
  });
  await e.pump(runId);
}

export async function verdict(e: Engine, gate: NodeInfo, v: Verdict): Promise<string> {
  const app = appOf(e, gate);
  if (!app?.repoPath) return "Rejected: no app repository.";
  const gateKind = gate.role === "review" ? "review" : "slop";
  if (v.gate !== gateKind) return `Rejected: you are the ${gateKind} gate; set gate to "${gateKind}".`;
  if (v.appId !== app.id) return `Rejected: appId must be "${app.id}".`;
  if (app.stage !== gateKind) return `Rejected: ${app.name} is in ${stageLabel(app.stage)}, not ${stageLabel(gateKind)}.`;
  const head = e.repo.appExtra(gate.runId, app.id).integrationHead;
  if (!head) return "Rejected: no integration HEAD recorded.";
  const host = e.host(gate.runId);
  const wt = await nodeWorktree(e, gate);
  const st = wt ? await host.status({ path: wt }) : null;
  const res = await validateVerdict(v, {
    integrationHead: head,
    readAt: async (commit, path) => (await host.fileAt({ repo: app.repoPath!, ref: commit, path, maxBytes: 4_000_000 })).content,
    refExists: async (ref) => {
      const m = ref.match(/^(.+?):(\d+)$/);
      if (m) return (await host.fileAt({ repo: app.repoPath!, ref: head, path: m[1] })).content !== null;
      if (wt && (await host.readFile({ path: `${wt}/${ref.replace(/^\.\//, "")}` })).content !== null) return true;
      return (await host.fileAt({ repo: app.repoPath!, ref: head, path: ref })).content !== null;
    },
    worktree: st ? { clean: st.clean, head: st.head, dirtyPaths: st.dirty } : undefined,
  });
  const vid = `V-${e.oid().slice(2)}`;
  e.repo.tx(() => {
    e.repo.insertVerdict({ id: vid, runId: gate.runId, nodeId: gate.id, appId: app.id, gate: gateKind, commit: head, verdict: v.verdict, summary: v.summary, checks: v.checks, unverified: v.unverified, accepted: res.accepted, problems: res.problems, ts: e.now() });
    e.repo.event(gate.runId, gate.id, "verdict", `${v.verdict}${res.accepted ? "" : " (rejected)"}: ${v.summary.slice(0, 160)}`, vid);
    if (res.readOnlyViolation)
      e.raiseNeed(gate.runId, { kind: "failed", nodeId: gate.id, appId: app.id, title: `${e.label(gate)} changed source while judging`, body: res.problems.filter((p) => p.startsWith("read-only")).join(" "), evidence: `verdict ${vid}`, options: ["Retry", "Stop"], dedupeKey: `readonly:${gate.id}:${head}` });
  });
  if (!res.accepted) return `Rejected — fix and call helm_verdict again: ${res.problems.join(" ")}`;

  const round = app.fixRound;
  if (v.verdict === "pass") {
    e.repo.tx(() => {
      e.repo.updateNode(gate.runId, gate.id, { status: "waiting" });
      // the same gate passing a newer commit is the evidence that its earlier findings are fixed
      for (const f of e.repo.findings(gate.runId, app.id))
        if (f.gate === gateKind && f.status === "open" && !shaMatches(f.commitSha ?? "", head)) {
          e.repo.updateFinding(gate.runId, f.id, { status: "fixed" });
          e.emit(gate.runId, "finding.updated", { id: f.id, status: "fixed", verdict: vid });
        }
      if (gateKind === "review") setStage(e, gate.runId, app.id, "slop", { verdict: vid, commit: head });
    });
    if (gateKind === "review") await enterGate(e, gate.runId, app.id, "slop");
    else await tryReady(e, gate.runId, app.id, vid);
    return `Verdict accepted (${v.verdict}). Stop now; you will be woken for a re-check if the commit changes.`;
  }
  // fail: record located findings, move to Fix, tell the lead
  const located = new Set(res.located);
  e.repo.tx(() => {
    for (const f of v.findings.filter((x) => located.has(x.id))) {
      const fid = `F-${e.repo.nextSeq(gate.runId, "finding")}`;
      const fi: FindingInfo = { id: fid, runId: gate.runId, appId: app.id, gate: gateKind, rule: f.rule, severity: f.severity, path: f.path, line: f.line, quote: f.quote, why: f.why, fix: f.fix, commitSha: head, status: "open", round: round + 1, ownerNodeId: null, waiverDirectiveId: null, createdAt: e.now() };
      e.repo.insertFinding(fi);
    }
    e.repo.updateNode(gate.runId, gate.id, { status: "waiting" });
  });
  await enterFix(e, gate.runId, app.id, gateKind, vid);
  return "Verdict accepted (fail). Findings recorded and sent to the lead. Stop now; you will be asked to re-check the fixed commit.";
}

async function enterFix(e: Engine, runId: string, appId: string, gate: "review" | "slop", verdictId: string): Promise<void> {
  const run = e.run(runId);
  const app = e.repo.getApp(runId, appId)!;
  const lead = e.leadOf(runId, appId);
  const nextRound = app.fixRound + 1;
  const open = e.repo.findings(runId, appId).filter((f) => f.status === "open" && (f.severity === "blocker" || f.severity === "major"));
  if (nextRound > run.limits.fixRounds) {
    e.repo.tx(() => {
      e.raiseNeed(runId, {
        kind: gate === "slop" ? "slop" : "failed",
        nodeId: lead?.id ?? null,
        appId,
        title: `${app.name}: findings still open after ${run.limits.fixRounds} fix rounds`,
        body: open.slice(0, 12).map((f) => `${f.id} ${f.rule} ${f.severity} ${f.path}:${f.line} — ${f.why.slice(0, 100)}`).join("\n"),
        evidence: `verdict ${verdictId}`,
        options: ["Send back to Build with a note", "Waive named findings", "Stop the app"],
        dedupeKey: `fixrounds:${appId}:${nextRound}`,
        data: { findingIds: open.map((f) => f.id) },
      });
    });
    return;
  }
  e.repo.tx(() => {
    e.repo.updateApp(runId, appId, { fixRound: nextRound });
    setStage(e, runId, appId, "fix", { verdict: verdictId, round: nextRound });
    if (lead) {
      e.repo.updateNode(runId, lead.id, { status: lead.status === "waiting" || lead.status === "running" ? lead.status : lead.status });
      e.sendFromHelm(runId, lead.id, `Fix round ${nextRound} of ${run.limits.fixRounds} for ${app.name} (${gate === "review" ? "Reviewer" : "Slop Hunter"} failed, ${verdictId}). Open findings:\n${open.slice(0, 20).map((f) => `- ${f.id} ${f.rule} ${f.severity} ${f.path}:${f.line} — ${f.why.slice(0, 120)} Fix: ${f.fix.slice(0, 120)}`).join("\n")}\nAssign each with helm_assign_fix (or fix it yourself on the integration branch), re-integrate, re-run the checks, then helm_stage to integrate and review.`, { key: `fix:${runId}:${appId}:${nextRound}` });
    }
  });
}

async function tryReady(e: Engine, runId: string, appId: string, verdictId: string): Promise<void> {
  const app = e.repo.getApp(runId, appId)!;
  const head = e.repo.appExtra(runId, appId).integrationHead;
  const verdicts = e.repo.verdicts(runId, appId).filter((v) => v.accepted && v.verdict === "pass");
  const checks = e.repo.checks(runId, appId);
  const greenAt = head && checks.some((c) => c.commitSha && shaMatches(c.commitSha, head) && c.exitCode === 0) ? head : null;
  const zt = e.repo.findings(runId, appId).filter((f) => f.status === "open" && blocksReady(f, e.settings.zeroTolerance)).length;
  const r = readyAllowed({
    commit: head,
    // a gate may quote a short sha: once it matches HEAD, compare as HEAD
    reviewPassCommit: verdicts.some((v) => v.gate === "review" && head && shaMatches(v.commit, head)) ? head : null,
    slopPassCommit: verdicts.some((v) => v.gate === "slop" && head && shaMatches(v.commit, head)) ? head : null,
    checksGreenCommit: greenAt,
    openZeroTolerance: zt,
    waivedGates: app.waivedGates,
  });
  if (!r.ok) {
    const lead = e.leadOf(runId, appId);
    if (lead) e.repo.event(runId, lead.id, "ready.blocked", r.reason);
    return;
  }
  const ciPlatforms = app.platforms.filter((p) => p === "win" || p === "and");
  const unverified = e.repo.verdicts(runId, appId).filter((v) => v.accepted && head && shaMatches(v.commit, head)).flatMap((v) => v.unverified.map((u) => `${u.what}: ${u.reason}`));
  e.repo.tx(() => {
    setStage(e, runId, appId, "ready", { verdict: verdictId, commit: head });
    const notes = ciPlatforms.map((p) => `${p === "win" ? "Windows" : "Android"} build not verified on this machine`);
    e.raiseNeed(runId, {
      kind: "signoff",
      nodeId: e.leadOf(runId, appId)?.id ?? null,
      appId,
      title: `${app.name} is ready for sign-off`,
      body: [
        ...e.repo.verdicts(runId, appId).filter((v) => v.accepted && head && shaMatches(v.commit, head)).map((v) => `${v.gate === "review" ? "Reviewer" : "Slop Hunter"}: ${v.verdict} — ${v.summary}`),
        `Checks green on ${head?.slice(0, 9)}: ${[...new Set(checks.filter((c) => c.commitSha && head && shaMatches(c.commitSha, head) && c.exitCode === 0).map((c) => c.name))].join(", ")}`,
        ...notes,
        `Result: ${extraBranch(e, runId, appId)} in ${app.repoPath ?? "the app repository"}.${app.adopted ? ` Helm never merges into your branches; merge it into ${app.userBranch ?? "your branch"} yourself when you are happy.` : ""}`,
      ].join("\n"),
      evidence: unverified.length ? `Unverified: ${unverified.join("; ")}` : "",
      options: ["Sign off", "Send back"],
      dedupeKey: `signoff:${appId}:${head}`,
      data: { commit: head, ciPlatforms },
    });
  });
  e.proposeNextWave(runId);
}

function extraBranch(e: Engine, runId: string, appId: string): string {
  const b = e.repo.appExtra(runId, appId).integrationBranch;
  return b ? `branch ${b}` : "the integration branch";
}

export async function assignFix(e: Engine, lead: NodeInfo, findingId: string, nodeId: string): Promise<string> {
  const f = e.repo.getFinding(lead.runId, findingId);
  const app = appOf(e, lead);
  if (!f || !app || f.appId !== app.id) return `No finding ${findingId} in this app.`;
  const owner = e.repo.getNode(lead.runId, nodeId);
  if (!owner || (owner.appId !== app.id && owner.id !== lead.id)) return `${nodeId} is not in this app.`;
  e.repo.tx(() => {
    e.repo.updateFinding(lead.runId, findingId, { ownerNodeId: owner.id });
    if (owner.id !== lead.id) {
      if (owner.status === "done") e.repo.updateNode(lead.runId, owner.id, { status: "waiting" });
      e.sendFromHelm(lead.runId, owner.id, `Fix ${f.id} (${f.rule} ${f.severity}) at ${f.path}:${f.line} — “${f.quote.slice(0, 120)}”. Why: ${f.why.slice(0, 200)} Fix: ${f.fix.slice(0, 200)}. Commit on your branch and helm_report done with the commit.`, { key: `assign:${lead.runId}:${f.id}:${owner.id}`, senderNodeId: lead.id, kind: "message", commsKind: "ask" });
    }
  });
  return `${f.id} assigned to ${e.label(owner)}.`;
}

// ───────────────────────────── sign-off, send-back, cleanup ─────────────────────────────

export async function signoff(e: Engine, runId: string, appId: string, d: DirectiveInfo): Promise<void> {
  const app = e.repo.getApp(runId, appId)!;
  if (app.stage !== "ready") return;
  const nodes = e.repo.listNodes(runId).filter((n) => n.appId === appId && n.id !== "orch");
  const order = bottomUp(e.tree(runId), nodes.map((n) => n.id));
  e.repo.tx(() => {
    setStage(e, runId, appId, "done", { directive: d.id });
    for (const id of order) e.repo.updateNode(runId, id, { status: "done", endedAt: e.now() });
    const withThread = order.filter((id) => e.repo.getNode(runId, id)?.threadId);
    if (withThread.length) e.repo.enqueue({ id: e.oid(), runId, kind: "archive", nodeId: null, payload: { nodeIds: withThread }, idemKey: `archive:${runId}:${appId}:${d.id}` });
  });
  e.outbox.kick();
  e.proposeNextWave(runId);
  await e.pump(runId);
  maybeFinishRun(e, runId);
}

export async function sendback(e: Engine, runId: string, appId: string, d: DirectiveInfo): Promise<void> {
  const app = e.repo.getApp(runId, appId)!;
  const gates = [`${appId}.review`, `${appId}.slop`].map((id) => e.repo.getNode(runId, id)).filter((g): g is NodeInfo => !!g);
  e.repo.tx(() => {
    setStage(e, runId, appId, "build", { directive: d.id, reason: d.text });
    e.repo.updateApp(runId, appId, { fixRound: 0 });
    const withThread = gates.filter((g) => g.threadId).map((g) => g.id);
    if (withThread.length) e.repo.enqueue({ id: e.oid(), runId, kind: "archive", nodeId: null, payload: { nodeIds: withThread }, idemKey: `archive:${runId}:${appId}:gates:${d.id}` });
    for (const g of gates) e.repo.updateNode(runId, g.id, { status: "planned", threadId: null, environmentId: null, branch: null, endedAt: e.now() });
    const lead = e.leadOf(runId, appId);
    if (lead && lead.status === "done") e.repo.updateNode(runId, lead.id, { status: "waiting" });
  });
  void app;
  e.outbox.kick();
}

export function maybeFinishRun(e: Engine, runId: string): void {
  const apps = e.repo.listApps(runId);
  if (apps.length && apps.every((a) => a.stage === "done" || a.stage === "cancelled")) {
    if (e.run(runId).status !== "running") return;
    e.repo.tx(() => {
      e.repo.event(runId, "orch", "run", "every app is signed off or cancelled — the run can be completed");
      e.raiseNeed(runId, {
        kind: "decision",
        nodeId: null,
        appId: null,
        title: "Every app is signed off — complete the run?",
        body: "Completing stops and archives every remaining agent, including the managers and the Orchestrator. Repositories, branches and worktrees stay where they are.",
        evidence: `${apps.filter((a) => a.stage === "done").length} done, ${apps.filter((a) => a.stage === "cancelled").length} cancelled`,
        options: ["Complete run", "Keep open"],
        dedupeKey: `complete:${runId}`,
        data: { completeRun: true },
      });
    });
    e.emit(runId, "run.updated", { id: runId, allDone: true });
  }
}

export async function completeRun(e: Engine, runId: string, status: "done" | "cancelled"): Promise<void> {
  const nodes = e.repo.listNodes(runId);
  const order = bottomUp(e.tree(runId), nodes.map((n) => n.id));
  e.repo.tx(() => {
    for (const id of order) {
      const n = e.repo.getNode(runId, id)!;
      if (!["done", "failed"].includes(n.status)) e.repo.updateNode(runId, id, { status: n.threadId ? "idle" : n.status === "planned" ? "planned" : "idle", endedAt: e.now() });
    }
    const withThread = order.filter((id) => e.repo.getNode(runId, id)?.threadId);
    const retired = e.retiredThreads(runId);
    if (withThread.length || retired.length) {
      // same nodeId so the per-node FIFO runs stop before archive; replaced threads go too
      e.repo.enqueue({ id: e.oid(), runId, kind: "stop", nodeId: "orch", payload: { nodeIds: withThread, threadIds: retired }, idemKey: `stopall:${runId}` });
      e.repo.enqueue({ id: e.oid(), runId, kind: "archive", nodeId: "orch", payload: { nodeIds: withThread, threadIds: retired }, idemKey: `archiveall:${runId}` });
    }
    e.repo.updateRun(runId, { status, endedAt: e.now() });
    for (const need of e.repo.listNeeds(runId, "open")) e.repo.resolveNeed(runId, need.id, { action: "run-ended" });
  });
  e.emit(runId, "run.updated", { id: runId, status });
  e.outbox.kick();
}
