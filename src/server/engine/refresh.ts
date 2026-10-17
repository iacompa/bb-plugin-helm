// Bring a running run up to the installed Helm version. BB applies a plugin's tools, skills
// and system prompt only when an agent's session is next started or resumed, so agents that
// were spawned before an upgrade keep the old ones until then. A refresh rewrites every brief
// (new scope rules and sections), then stops each live agent's turn and resumes it with a
// message, which makes BB rebuild the session with the new configuration. Supervisors go
// first and are told which agents under them still need a task. Uncommitted work stays in
// the worktree, as with a Watcher restart.

import type { NodeInfo } from "../../shared/types.ts";
import type { Engine } from "./engine.ts";
import { HelmError } from "./engine.ts";
import { craftSkill, scopeFor, skillsFor } from "../domain/roles.ts";
import { getTask, isAbove } from "./tasks.ts";

const TIER_ORDER = ["orchestrator", "manager", "lead", "specialist", "gate"];

export interface RefreshResult {
  restarted: string[];
  briefs: number;
  scopes: number;
  skipped: string[];
}

/** Agents under a supervisor that it should write tasks for, and that have none yet. */
function untasked(e: Engine, sup: NodeInfo, nodes: NodeInfo[]): NodeInfo[] {
  const forTier = sup.tier === "orchestrator" ? ["manager", "lead"] : sup.tier === "manager" ? ["lead"] : ["specialist", "gate"];
  const own = sup.alsoLead ? [...forTier, "specialist", "gate"] : forTier;
  return nodes.filter((n) => own.includes(n.tier) && n.status !== "done" && isAbove(e, sup, n) && !getTask(e, n.runId, n.id) && (sup.tier !== "lead" || n.parentId === sup.id));
}

export function refreshRun(e: Engine, runId: string): RefreshResult {
  const run = e.run(runId);
  if (run.status !== "running") throw new HelmError(`${run.name} is ${run.status}; only a running run can be refreshed.`, "bad_state");
  const ts = e.now();
  const res: RefreshResult = { restarted: [], briefs: 0, scopes: 0, skipped: [] };
  e.repo.tx(() => {
    // scope rules that changed with the upgrade, only where nobody edited the scope
    for (const n of e.repo.listNodes(runId)) {
      if (n.role !== "platform" || !n.platform) continue;
      const now = scopeFor(n.role, n.platform);
      if (JSON.stringify(n.scopeGlobs) === JSON.stringify([`apps/${n.platform}/**`])) {
        e.repo.updateNode(runId, n.id, { scopeGlobs: now });
        res.scopes++;
      }
    }
    const nodes = e.repo.listNodes(runId).sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));
    for (const n of nodes) {
      if (!n.threadId) continue;
      e.repo.enqueue({ id: e.oid(), runId, kind: "file", nodeId: null, payload: { path: e.briefPath(run, n.id), content: e.buildBrief(run, n) }, idemKey: `refresh-brief:${runId}:${n.id}:${ts}` });
      res.briefs++;
      if (!["running", "waiting"].includes(n.status)) {
        res.skipped.push(`${n.id} (${n.status})`);
        continue;
      }
      const app = n.appId ? e.repo.getApp(runId, n.appId) : null;
      const skills = skillsFor(n, app);
      const craft = craftSkill(n.role, n.platform);
      const L = [
        `Helm was upgraded and restarted your session so it loads the new version. Your skills: ${skills.join(", ")}${craft ? ` (${craft} is new: how to do your kind of work well — follow it from now on)` : ""}. Your brief file was rewritten.`,
        "Re-read your BRIEF and helm_context, check git status, then continue from your last commit. Nothing you committed is lost.",
      ];
      if (["orchestrator", "manager", "lead"].includes(n.tier) || n.alsoLead) {
        const todo = untasked(e, n, nodes);
        L.push(
          `New tool: helm_set_task {nodeId, task} — write each agent under you a tailored task (150–600 words; the template is in your skill). It becomes part of that agent's system prompt and brief, and a running agent is told at once.${todo.length ? ` These have no task yet: ${todo.slice(0, 20).map((x) => `${x.id} (${e.label(x)})`).join(", ")}. Write theirs first, most active first.` : ""}`,
        );
        if (n.tier === "lead" || n.alsoLead) L.push("helm_spawn_squad items now take a `task` too.");
      }
      if (n.tier === "manager") L.push(e.scopeLine(n) ?? "");
      L.push("Report with helm_report when you are moving again.");
      if (n.status === "running") e.repo.enqueue({ id: e.oid(), runId, kind: "stop", nodeId: n.id, payload: { nodeIds: [n.id] }, idemKey: `refresh-stop:${runId}:${n.id}:${ts}` });
      e.sendFromHelm(runId, n.id, L.filter(Boolean).join("\n"), { mode: "queue", key: `refresh:${runId}:${n.id}:${ts}` });
      e.repo.event(runId, n.id, "refresh", "restarted to load the upgraded Helm (skills, tools, prompt)");
      res.restarted.push(n.id);
    }
  });
  e.outbox.kick();
  return res;
}
