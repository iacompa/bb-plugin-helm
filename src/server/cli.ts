// `bb helm …` (§10.1). Human output by default, `--json` when asked; failures
// raise PluginCliError so BB prints `{ok:false,error}` under --json. Multi-line
// text only ever comes from --message-file / --brief-file.

import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { cliCommand, defineCli, PluginCliError, type PluginCliContext, type PluginCliResult } from "@get-bb/plugin-sdk";
import type { Cascade, Portfolio, Priority, SlotId, SlotMap } from "../shared/types.ts";
import { Planner } from "./engine/planner.ts";
import { HelmError } from "./engine/engine.ts";
import { parseSlotArg, type HelmService } from "./service.ts";
import { fmtUnits } from "./domain/models.ts";
import { profileLine } from "./domain/profile.ts";
import { PLATFORM_LABEL, roleLabel } from "./domain/roles.ts";
import { errorsText } from "./journal.ts";

const MAX_TEXT = 20_000;
/** How long `bb helm plan` waits for a planner before handing back its id. */
const PLANNER_WAIT_MS = 150_000;

const RUN = { type: "string", description: "Run id (default: the newest running run)", placeholder: "run" } as const;
const JSON_OPT = { type: "boolean", description: "Print machine-readable JSON" } as const;
const CASCADE = { type: "enum", values: ["self", "reports", "subtree"], description: "Who the change applies to" } as const;

function out(json: boolean | undefined, data: unknown, human: string): PluginCliResult {
  return { exitCode: 0, stdout: json ? `${JSON.stringify({ ok: true, ...((typeof data === "object" && data) || { result: data }) }, null, 2)}\n` : human.endsWith("\n") ? human : `${human}\n` };
}

async function readText(path: string, ctx: PluginCliContext, what: string): Promise<string> {
  const full = isAbsolute(path) ? path : resolve(ctx.cwd ?? process.cwd(), path);
  let text: string;
  try {
    text = await readFile(full, "utf8");
  } catch {
    throw new PluginCliError(`Cannot read the ${what} file ${full}.`, { code: "invalid_value" });
  }
  if (!text.trim()) throw new PluginCliError(`The ${what} file is empty.`, { code: "invalid_value" });
  if (text.length > MAX_TEXT) throw new PluginCliError(`The ${what} file is over ${MAX_TEXT} characters.`, { code: "invalid_value" });
  return text.trim();
}

/** Run a command body, turning Helm's errors into CLI errors. */
async function guard(fn: () => Promise<PluginCliResult>): Promise<PluginCliResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PluginCliError) throw e;
    if (e instanceof HelmError) throw new PluginCliError(e.message, { code: e.code, hint: e.hint });
    throw new PluginCliError(e instanceof Error ? e.message : String(e), { code: "internal" });
  }
}

export function buildCli(svc: HelmService, extra: { doctor(): Promise<{ ok: boolean; lines: string[]; checks: unknown[] }> }) {
  const runOf = (r?: string) => svc.runFor(r ?? null);

  const lifecycle = (type: "pause" | "resume" | "stop" | "retry", summary: string) =>
    cliCommand({
      summary,
      positionals: [{ name: "node", description: "Node id, app name (its lead) or orch", required: true }] as const,
      options: { run: RUN, json: JSON_OPT, cascade: CASCADE },
      run: (i) =>
        guard(async () => {
          const run = runOf(i.options.run);
          const node = svc.nodeFor(run.id, i.positionals.node!);
          const d = await svc.directive(run.id, { type, target: node.id, cascade: (i.options.cascade as Cascade | undefined) ?? (type === "stop" || type === "pause" ? "subtree" : "self") });
          return out(i.options.json, { directive: d }, `${d.id}: ${d.summary} — ${d.recipients.length} recipients.`);
        }),
    });

  const decide = (action: "approve" | "deny") =>
    cliCommand({
      summary: action === "approve" ? "Approve a Needs-you item" : "Deny a Needs-you item",
      positionals: [{ name: "needId", description: "N-12 or 12", required: true }] as const,
      options: { run: RUN, json: JSON_OPT, reason: { type: "string", description: "One-line reason" } },
      run: (i) =>
        guard(async () => {
          const run = runOf(i.options.run);
          const need = svc.repo.getNeed(run.id, i.positionals.needId!.toUpperCase().startsWith("N-") ? i.positionals.needId!.toUpperCase() : `N-${i.positionals.needId}`);
          const isComplete = !!(need?.data as { completeRun?: boolean } | undefined)?.completeRun;
          const r = await svc.resolve(run.id, i.positionals.needId!, { action: isComplete ? (action === "approve" ? "complete_run" : "dismiss") : action, text: i.options.reason });
          return out(i.options.json, r, `${r.need?.id} ${action === "approve" ? "approved" : "denied"}${r.directive ? ` (${r.directive.id})` : ""}.`);
        }),
    });

  return defineCli({
    name: "helm",
    summary: "Run a portfolio of apps, websites, games, automation and reviews with a supervised hierarchy of agents",
    description: "Helm plans an org (Orchestrator, Managers, App Leads, Specialists, gates), spawns it lazily and lets you steer any agent; every change reaches its whole chain of command.",
    commands: {
      status: cliCommand({
        summary: "Current run summary",
        options: { run: RUN, json: JSON_OPT },
        run: (i) =>
          guard(async () => {
            const id = i.options.run ?? svc.defaultRunId();
            return out(i.options.json, id ? { world: svc.world(id) } : { world: null }, svc.statusText(id));
          }),
      }),
      runs: cliCommand({
        summary: "List runs",
        options: { json: JSON_OPT },
        run: (i) =>
          guard(async () => {
            const runs = svc.repo.listRuns().sort((a, b) => b.createdAt - a.createdAt);
            const text = runs.length ? runs.map((r) => `${r.id}  ${r.status.padEnd(9)} ${r.name}`).join("\n") : "No runs yet.";
            return out(i.options.json, { runs }, text);
          }),
      }),
      plan: cliCommand({
        summary: "Create a plan from a brief (nothing spawns); prints the shape and forecast",
        options: {
          "brief-file": { type: "string", required: true, description: "File with the plain-language brief", placeholder: "file" },
          preset: { type: "string", description: "Model preset (e.g. \"Cheap dev run\")" },
          slot: { type: "string", repeatable: true, description: "slot=provider/model:reasoning (repeatable)" },
          name: { type: "string", description: "Run name" },
          concurrency: { type: "integer", min: 1, max: 48, description: "Concurrent agents" },
          auto: { type: "boolean", description: "Admit later waves without asking" },
          shape: { type: "enum", values: ["solo", "lean", "full"], description: "Squad shape for every app (default full)" },
          "planner-model": { type: "string", description: "Model for reading a free-text brief: provider/model:reasoning (default: the code slot at medium)" },
          planner: { type: "string", description: "Use the portfolio of a finished planner (id from an earlier bb helm plan)" },
          root: { type: "string", description: "Parent folder for this run's new app repositories (default: the apps root setting). Apps can also name their own folder or an existing repository in the brief: '- Name — tagline · macOS · /path/to/repo'", placeholder: "folder" },
          json: JSON_OPT,
        },
        run: (i, ctx) =>
          guard(async () => {
            const brief = await readText(i.options["brief-file"], ctx, "brief");
            const slots = Object.fromEntries((i.options.slot ?? []).map(parseSlotArg));
            // §7.7: a structured brief is parsed; free text goes to one short planner thread
            let portfolio: Portfolio | undefined;
            let questions: string[] = [];
            if (i.options.planner || Planner.needsPlanner(brief)) {
              let s = i.options.planner ? svc.plannerGet(i.options.planner) : null;
              if (!s) {
                const model = i.options["planner-model"] ? parseSlotArg(`code=${i.options["planner-model"]}`)[1] : null;
                s = await svc.plannerStart({ brief, model, preset: i.options.preset, slots });
                s = (await svc.planner!.wait(s.id, PLANNER_WAIT_MS)) ?? s;
              }
              if (s.status === "failed") throw new PluginCliError(`The planner could not read the brief: ${s.error ?? "unknown error"}`, { code: "planner_failed", hint: "Re-run bb helm plan, choose another --planner-model, or write the brief as '# Group' headings with '- Name — tagline · iOS Android' lines." });
              if (s.status !== "done" || !s.portfolio) {
                return out(i.options.json, { planner: s }, `The planner (${s.id}) is still reading the brief. When it finishes, run:\n  bb helm plan --brief-file ${i.options["brief-file"]} --planner ${s.id}${i.options.preset ? ` --preset ${JSON.stringify(i.options.preset)}` : ""}`);
              }
              portfolio = s.portfolio;
              questions = s.portfolio.questions;
            }
            const r = await svc.plan({ brief, portfolio, name: i.options.name, preset: i.options.preset, slots, limits: i.options.concurrency ? { concurrency: i.options.concurrency } : undefined, autoAdvance: i.options.auto ? "auto" : "ask", shape: i.options.shape as "solo" | "lean" | "full" | undefined, appsRoot: i.options.root });
            const c = r.plan.counts;
            const lines = [
              `Plan ${r.runId}: ${c.apps} apps · ${c.managers} managers · ${c.leads} leads · ${c.specialists} specialists · ${c.gates} gates · ${c.total} agents (${r.plan.rule})`,
              r.plan.why,
              "Projects:",
              ...r.plan.apps.slice(0, 40).map((a) => `  · ${a.name} — ${profileLine(a)}${a.platforms.length ? ` · ${a.platforms.map((x) => PLATFORM_LABEL[x]).join(" ")}` : ""} · ${a.shape}: ${a.squad.filter((m) => m.role !== "review" && m.role !== "slop").map((m) => roleLabel(m.role, m.platform)).join(", ") || "the lead builds it"} (+ Reviewer, Slop Hunter)`),
              `Forecast: ${fmtUnits(r.forecast.low)}–${fmtUnits(r.forecast.high)} (estimate)`,
              ...(portfolio ? [`Read by the planner: ${portfolio.apps.map((a) => a.name).join(", ")}`] : []),
              ...(questions.length ? ["The planner asks:", ...questions.map((q) => `  ? ${q}`)] : []),
              ...(r.assumed.length ? [`Assumed: ${r.assumed.join("; ")}`] : []),
              `New app folders and Helm's notes (_studio) go under: ${r.runFolder ?? "the apps root"}${i.options.root ? "" : " (change with --root)"}`,
              ...(r.locations.length ? ["Folders:", ...r.locations.map((n) => `  · ${n}`)] : []),
              ...(r.problems.length ? ["Before it can start:", ...r.problems.map((p) => `  - ${p}`), "Fix models with --preset / --slot and folders in the brief or --root, then re-run bb helm plan."] : [`Start it with: bb helm start ${r.runId} (or press Start run in the Helm panel). Discard it with: bb helm end --run ${r.runId} --yes`]),
            ];
            return out(i.options.json, r, lines.join("\n"));
          }),
      }),
      start: cliCommand({
        summary: "Approve and start a planned run",
        positionals: [{ name: "runId", description: "The plan id from bb helm plan", required: true }] as const,
        options: { yes: { type: "boolean", description: "Do not ask again" }, "dry-run": { type: "boolean", description: "Write the Studio files only; spawn nothing" }, json: JSON_OPT },
        run: (i) =>
          guard(async () => {
            const run = svc.runFor(i.positionals.runId);
            if (!i.options.yes && !i.options["dry-run"]) {
              const c = svc.engine.plan(run.id).counts;
              throw new PluginCliError(`Starting ${run.name} creates up to ${c.apps} projects and spawns up to ${c.total} agents over the run.`, { code: "confirmation_required", hint: `Re-run with --yes to start, or --dry-run to only write the plan files.` });
            }
            const r = await svc.start(run.id, { dryRun: i.options["dry-run"] });
            if (!r.ok) throw new PluginCliError(`Cannot start yet:\n${r.problems.map((p) => `  - ${p}`).join("\n")}`, { code: "not_ready" });
            return out(i.options.json, r, r.dryRun ? `Dry run written to ${r.studioPath}. Nothing was spawned.` : `${r.run.name} is running. Watch it with: bb helm status`);
          }),
      }),
      world: cliCommand({
        summary: "The same data as helm_world",
        options: { run: RUN, json: JSON_OPT },
        run: (i) =>
          guard(async () => {
            const run = runOf(i.options.run);
            const w = svc.world(run.id);
            return { exitCode: 0, stdout: `${JSON.stringify(i.options.json ? { ok: true, world: w } : w, null, 2)}\n` };
          }),
      }),
      tell: cliCommand({
        summary: "Tell an agent something; its whole chain of command is informed",
        positionals: [{ name: "node", description: "Node id, app name (its lead) or orch", required: true }] as const,
        options: {
          "message-file": { type: "string", required: true, description: "File with the message", placeholder: "file" },
          cascade: CASCADE,
          mode: { type: "enum", values: ["steer", "queue"], description: "Interrupt now (steer) or after the current turn (queue)" },
          policy: { type: "boolean", description: "Make it a standing policy for this subtree" },
          run: RUN,
          json: JSON_OPT,
        },
        run: (i, ctx) =>
          guard(async () => {
            const run = runOf(i.options.run);
            const text = await readText(i.options["message-file"], ctx, "message");
            const node = svc.nodeFor(run.id, i.positionals.node!);
            const d = await svc.directive(run.id, { type: "tell", target: node.id, text, cascade: i.options.cascade as Cascade | undefined, mode: i.options.mode as "steer" | "queue" | undefined, policy: i.options.policy });
            return out(i.options.json, { directive: d }, `${d.id} → ${svc.engine.label(node)}: ${d.recipients.length} recipients (${d.recipients.map((r) => `${r.nodeId}:${r.level}`).join(", ")}).`);
          }),
      }),
      model: cliCommand({
        summary: "Change an agent's model (applied now, recorded from → to)",
        positionals: [{ name: "node", description: "Node id, app name (its lead) or orch", required: true }] as const,
        options: {
          model: { type: "string", required: true, description: "Model id" },
          provider: { type: "string", description: "Provider id (default: the agent's current provider)" },
          reasoning: { type: "string", description: "Reasoning level" },
          cascade: CASCADE,
          run: RUN,
          json: JSON_OPT,
        },
        run: (i) =>
          guard(async () => {
            const run = runOf(i.options.run);
            const node = svc.nodeFor(run.id, i.positionals.node!);
            const cur = node.model ?? svc.engine.effectiveModel(run, node);
            const providerId = i.options.provider ?? cur?.providerId;
            if (!providerId) throw new PluginCliError("Say which provider with --provider.", { code: "missing_required" });
            const d = await svc.directive(run.id, { type: "model", target: node.id, cascade: i.options.cascade as Cascade | undefined, modelTo: { providerId, modelId: i.options.model, reasoning: i.options.reasoning ?? cur?.reasoning ?? null } });
            return out(i.options.json, { directive: d }, `${d.id}: ${d.summary}`);
          }),
      }),
      slots: cliCommand({
        summary: "Change which model each role uses, mid-run: every agent in those roles moves now (another provider gets a new thread in the same workspace; failed agents retry)",
        options: {
          run: RUN,
          slot: { type: "string", repeatable: true, description: "role=provider/model:reasoning, e.g. ui=claude-code/claude-sonnet-5-5:high (repeatable)" },
          replace: { type: "string", description: "Provider id to move off (out of usage or down): every role on it gets --with" },
          with: { type: "string", description: "provider/model:reasoning for --replace" },
          future: { type: "boolean", description: "Only agents spawned from now on; existing agents keep their models" },
          json: JSON_OPT,
        },
        run: (i) =>
          guard(async () => {
            const run = runOf(i.options.run);
            const slots: SlotMap = Object.fromEntries((i.options.slot ?? []).map(parseSlotArg));
            if (i.options.replace) {
              if (!i.options.with) throw new PluginCliError("Say which model replaces it with --with provider/model:reasoning.", { code: "missing_required" });
              const to = parseSlotArg(`code=${i.options.with}`)[1];
              const hit = Object.entries(run.slots).filter(([, r]) => r?.providerId === i.options.replace);
              if (!hit.length) throw new PluginCliError(`No role of ${run.name} uses ${i.options.replace}.`, { code: "not_found", hint: `Roles use: ${[...new Set(Object.values(run.slots).map((r) => r?.providerId))].filter(Boolean).join(", ")}` });
              for (const [id] of hit) slots[id as SlotId] ??= to;
            }
            if (!Object.keys(slots).length) {
              const cur = Object.entries(run.slots).map(([id, r]) => `  ${id.padEnd(13)} ${r ? `${r.providerId}/${r.modelId}${r.reasoning ? `:${r.reasoning}` : ""}` : "(none)"}`);
              return out(i.options.json, { slots: run.slots }, [`${run.name} — models by role:`, ...cur, "Change with --slot role=provider/model:reasoning, or --replace <provider> --with provider/model:reasoning."].join("\n"));
            }
            const r = await svc.changeSlots(run.id, slots, i.options.future ? "future" : "all");
            return out(i.options.json, r, r.directive ? `${r.directive.id}: ${r.directive.summary}` : `${run.name} is still a plan: its roles now use the new models.`);
          }),
      }),
      pause: lifecycle("pause", "Pause an agent (and its subtree by default)"),
      resume: lifecycle("resume", "Resume a paused agent"),
      stop: lifecycle("stop", "Stop an agent (and its subtree by default), bottom-up"),
      retry: lifecycle("retry", "Retry a failed or stopped agent"),
      priority: cliCommand({
        summary: "Set an app's priority",
        positionals: [
          { name: "target", description: "App name or node id", required: true },
          { name: "level", description: "low, normal or high", required: true },
        ] as const,
        options: { run: RUN, json: JSON_OPT },
        run: (i) =>
          guard(async () => {
            const level = i.positionals.level as Priority;
            if (!["low", "normal", "high"].includes(level)) throw new PluginCliError("Priority is low, normal or high.", { code: "invalid_value" });
            const run = runOf(i.options.run);
            const node = svc.nodeFor(run.id, i.positionals.target!);
            const d = await svc.directive(run.id, { type: "priority", target: node.id, value: level });
            return out(i.options.json, { directive: d }, `${d.id}: ${d.summary}`);
          }),
      }),
      needs: cliCommand({
        summary: "Open Needs-you items",
        options: { run: RUN, json: JSON_OPT },
        run: (i) =>
          guard(async () => {
            const run = runOf(i.options.run);
            const needs = svc.repo.listNeeds(run.id, "open");
            const text = needs.length ? needs.map((n) => `${n.id}  [${n.kind}]  ${n.title}\n      ${n.body.split("\n")[0].slice(0, 160)}\n      options: ${n.options.join(" · ")}`).join("\n") : "Nothing needs you.";
            return out(i.options.json, { needs }, text);
          }),
      }),
      approve: decide("approve"),
      deny: decide("deny"),
      answer: cliCommand({
        summary: "Answer an agent's question",
        positionals: [{ name: "needId", description: "N-12 or 12", required: true }] as const,
        options: { "message-file": { type: "string", required: true, description: "File with the answer", placeholder: "file" }, run: RUN, json: JSON_OPT },
        run: (i, ctx) =>
          guard(async () => {
            const run = runOf(i.options.run);
            const text = await readText(i.options["message-file"], ctx, "answer");
            const r = await svc.resolve(run.id, i.positionals.needId!, { action: "answer", text });
            return out(i.options.json, r, `${r.need?.id} answered${r.directive ? ` (${r.directive.id})` : ""}.`);
          }),
      }),
      signoff: cliCommand({
        summary: "Sign off an app that is Ready",
        positionals: [{ name: "app", description: "App name or id", required: true }] as const,
        options: { run: RUN, json: JSON_OPT, accept: { type: "string", description: "Explicit acceptance note for CI-tier platforms" } },
        run: (i) =>
          guard(async () => {
            const run = runOf(i.options.run);
            const r = await svc.signoffApp(run.id, i.positionals.app!, i.options.accept);
            return out(i.options.json, r, `Signed off. Its agents are being archived; the repo and branches stay.`);
          }),
      }),
      sendback: cliCommand({
        summary: "Send an app back with a reason",
        positionals: [{ name: "app", description: "App name or id", required: true }] as const,
        options: { "message-file": { type: "string", required: true, description: "File with the reason", placeholder: "file" }, run: RUN, json: JSON_OPT },
        run: (i, ctx) =>
          guard(async () => {
            const run = runOf(i.options.run);
            const text = await readText(i.options["message-file"], ctx, "reason");
            const r = await svc.sendbackApp(run.id, i.positionals.app!, text);
            return out(i.options.json, r, `Sent back${r.directive ? ` (${r.directive.id})` : ""}.`);
          }),
      }),
      complete: cliCommand({
        summary: "Complete a run whose apps are all signed off (stops and archives every remaining agent)",
        options: { run: RUN, yes: { type: "boolean", description: "Confirm" }, cancel: { type: "boolean", description: "Cancel the run instead (apps need not be done)" }, json: JSON_OPT },
        run: (i) =>
          guard(async () => {
            const run = runOf(i.options.run);
            if (!i.options.yes) throw new PluginCliError(`This stops and archives every remaining agent of ${run.name}, including the Orchestrator. Repos and branches stay.`, { code: "confirmation_required", hint: "Re-run with --yes." });
            const r = await svc.finish(run.id, i.options.cancel ? "cancelled" : "done");
            return out(i.options.json, { run: r }, `${r.name} is ${r.status}.`);
          }),
      }),
      limits: cliCommand({
        summary: "Change a run's limits now: how many agents run at once, and the budget cap",
        options: {
          run: RUN,
          concurrency: { type: "integer", min: 1, max: 48, description: "Agents allowed to run at once in this run" },
          budget: { type: "integer", min: 1, max: 1000000, description: "Budget cap in relative units (raising it above the spend lifts a budget pause)" },
          autonomy: { type: "enum", values: ["high", "ask"], description: "high: the Orchestrator decides everything except credentials, spending, private data and access; ask: every question, wave and plan change asks you" },
          permission: { type: "string", description: "provider=accept-edits|auto|full: the mode for a provider that cannot run Helm's configured one (e.g. acp-grok=full)" },
          json: JSON_OPT,
        },
        run: (i) =>
          guard(async () => {
            const run = runOf(i.options.run);
            const line = (x: typeof run) => `${x.name}: at most ${x.concurrency} agents at once · budget cap ${Math.round(x.budgetCap)} u · autonomy ${x.limits.autonomy ?? "ask"}${Object.keys(x.limits.providerPermission ?? {}).length ? ` · permission ${Object.entries(x.limits.providerPermission!).map(([p, m]) => `${p}=${m}`).join(", ")}` : ""}.`;
            if (i.options.concurrency === undefined && i.options.budget === undefined && i.options.autonomy === undefined && !i.options.permission) return out(i.options.json, { run }, `${line(run)} Change with --concurrency N, --budget N, --autonomy high|ask or --permission provider=mode.`);
            const pm = i.options.permission?.match(/^([\w.-]+)=(accept-edits|auto|full)$/);
            if (i.options.permission && !pm) throw new PluginCliError("Write it as provider=accept-edits|auto|full, e.g. acp-grok=full.", { code: "invalid_value" });
            const r = await svc.setLimits(run.id, { concurrency: i.options.concurrency, budgetCap: i.options.budget, autonomy: i.options.autonomy as "high" | "ask" | undefined, permission: pm ? { providerId: pm[1], mode: pm[2] as "accept-edits" | "auto" | "full" } : undefined });
            return out(i.options.json, { run: r }, line(r));
          }),
      }),
      sim: cliCommand({
        summary: "Open the simulator view (iOS, Android, macOS; Windows screenshots) in BB's in-app browser, or print its URL",
        options: { run: RUN, app: { type: "string", description: "App id to show first" }, json: JSON_OPT },
        run: (i) =>
          guard(async () => {
            // without --run: the most recently active run
            const run = i.options.run ? runOf(i.options.run) : null;
            const r = await svc.openSimulators(run?.id ?? null, i.options.app ?? null);
            return out(i.options.json, r, `${r.message}\n${r.url}`);
          }),
      }),
      refresh: cliCommand({
        summary: "Bring a running run up to the installed Helm version: rewrite briefs and restart live agents so they load the new skills, tools and prompts",
        options: { run: RUN, yes: { type: "boolean", description: "Confirm" }, json: JSON_OPT },
        run: (i) =>
          guard(async () => {
            const run = runOf(i.options.run);
            if (!i.options.yes) throw new PluginCliError(`This stops each running agent of ${run.name} at its current step and resumes it on the installed Helm version (committed and uncommitted work stays in its worktree). Supervisors go first and are told which agents still need a task.`, { code: "confirmation_required", hint: "Re-run with --yes." });
            const r = await svc.refresh(run.id);
            return out(i.options.json, r, `${run.name}: ${r.restarted.length} agents restarting on the new version · ${r.briefs} briefs rewritten${r.scopes ? ` · ${r.scopes} platform scopes widened to reports/<platform>/**` : ""}${r.skipped.length ? ` · not restarted (pick it up when they next start): ${r.skipped.slice(0, 12).join(", ")}` : ""}.`);
          }),
      }),
      end: cliCommand({
        summary: "End a run now: cancel it (or discard a plan), stopping and archiving every agent it spawned",
        options: { run: RUN, yes: { type: "boolean", description: "Confirm" }, json: JSON_OPT },
        run: (i) =>
          guard(async () => {
            const run = runOf(i.options.run);
            if (!i.options.yes)
              throw new PluginCliError(
                run.status === "planning" ? `This discards the plan ${run.name}; nothing was spawned.` : `This ends ${run.name}: every agent it spawned is stopped and archived, including the Orchestrator. Repos, branches and the ledger stay.`,
                { code: "confirmation_required", hint: "Re-run with --yes." },
              );
            const r = await svc.finish(run.id, "cancelled");
            return out(i.options.json, { run: r }, `${r.name} is ended (${r.status}).`);
          }),
      }),
      ledger: cliCommand({
        summary: "Every change with its receipts",
        options: { run: RUN, json: JSON_OPT, limit: { type: "integer", min: 1, max: 500, description: "How many (default 30)" } },
        run: (i) =>
          guard(async () => {
            const run = runOf(i.options.run);
            return out(i.options.json, { directives: svc.repo.listDirectives(run.id, i.options.limit ?? 30) }, svc.ledgerText(run.id, i.options.limit ?? 30));
          }),
      }),
      models: cliCommand({
        summary: "Live model catalog with NEW flags and the current slots",
        options: { json: JSON_OPT },
        run: (i) =>
          guard(async () => {
            const host = await svc.engine.port.primaryHostId();
            const cat = await svc.engine.catalog(host, true);
            return out(i.options.json, { catalog: cat }, await svc.modelsText());
          }),
      }),
      errors: cliCommand({
        summary: "Helm's error journal: server, RPC, agent-tool and panel failures, newest first",
        options: {
          json: JSON_OPT,
          limit: { type: "integer", min: 1, max: 500, description: "How many (default 30)" },
          hours: { type: "integer", min: 1, max: 720, description: "Only the last N hours (default 24)" },
          all: { type: "boolean", description: "Include refused requests (by default only errors and warnings)" },
          clear: { type: "boolean", description: "Delete the journal after showing it" },
        },
        run: (i) =>
          guard(async () => {
            const hours = i.options.hours ?? 24;
            const since = svc.engine.now() - hours * 3600_000;
            const all = svc.repo.listErrors({ since, limit: 500 });
            const entries = (i.options.all ? all : all.filter((x) => x.level !== "user")).slice(0, i.options.limit ?? 30);
            const counts = svc.repo.countErrors(since);
            const text = errorsText(entries, counts, `last ${hours} h`) + (i.options.clear ? `\nCleared ${svc.repo.clearErrors()} entries.` : "");
            return out(i.options.json, { counts, errors: entries }, text);
          }),
      }),
      doctor: cliCommand({
        summary: "Check Helm's platform assumptions without spawning anything",
        options: { json: JSON_OPT },
        run: (i) =>
          guard(async () => {
            const r = await extra.doctor();
            return { exitCode: r.ok ? 0 : 1, stdout: i.options.json ? `${JSON.stringify({ ok: r.ok, checks: r.checks }, null, 2)}\n` : `${r.lines.join("\n")}\n` };
          }),
      }),
      reconcile: cliCommand({
        summary: "Compare Helm's state with BB's and repair it (§9.4)",
        options: { json: JSON_OPT },
        run: (i) =>
          guard(async () => {
            const lines = await svc.reconcileAll();
            return out(i.options.json, { results: lines }, lines.length ? lines.join("\n") : "No active runs.");
          }),
      }),
      export: cliCommand({
        summary: "Write a JSON snapshot of a run",
        positionals: [{ name: "run", description: "Run id", required: true }] as const,
        options: { out: { type: "string", required: true, description: "Output file", placeholder: "file" }, json: JSON_OPT },
        run: (i, ctx) =>
          guard(async () => {
            const run = svc.runFor(i.positionals.run);
            const file = isAbsolute(i.options.out) ? i.options.out : resolve(ctx.cwd ?? process.cwd(), i.options.out);
            await writeFile(file, JSON.stringify(svc.exportRun(run.id), null, 2));
            return out(i.options.json, { file }, `Wrote ${file}`);
          }),
      }),
    },
  });
}
