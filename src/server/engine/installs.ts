// Installs: the human allows them, the Git agent makes them. Any agent asks with helm_install
// (what, why, where); the Git agent installs it, records it with helm_installed, and every agent
// that asked is told. The ledger keeps what was installed, where, with which command, why, and
// for which agents (bb helm installs; the Git agent's and the Orchestrator's helm_context).

import type { InstallInfo, NodeInfo } from "../../shared/types.ts";
import { ORCH_ID } from "../domain/topology.ts";
import { ensureGitAgent, GIT_ID } from "./custom.ts";
import type { Engine } from "./engine.ts";
import { nodeWorktree } from "./gates.ts";

const norm = (s: string | null) => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/** What a helm_install request tells the Git agent to do. */
function gitAsk(e: Engine, x: InstallInfo, from: NodeInfo, why: string): string {
  return [
    `Install request ${x.id} from ${e.label(from)} (${from.id}): ${x.what}`,
    `Why: ${why}`,
    `Where: ${x.where ?? "its worktree (ask it if unclear)"}`,
    "The human allows installs: do it now. Nobody's approval is needed, and no supervisor's hold or rule applies to installs.",
    "Install into that folder the project's usual way (npm/pnpm/yarn install, pod install, pip into the project's venv, Gradle sync, …). A machine-wide tool (a CLI, an SDK, a Homebrew package) is fine too when it needs no password. Never use sudo, never type a password, never sign in, never pay: if it needs any of that, record needs_human and raise helm_need (about credentials or spending).",
    `Then record it: helm_installed {id: "${x.id}", state: "done" | "failed" | "needs_human", command: the exact command you ran, note}. Everyone who asked is told.`,
  ].join("\n");
}

/** helm_install: ask the run's Git agent to install something. Returns the tool result. */
export async function requestInstall(e: Engine, from: NodeInfo, p: { what: string; why: string; where?: string }): Promise<string> {
  const runId = from.runId;
  const what = p.what.trim();
  const why = p.why.trim();
  const where = p.where?.trim() || (await nodeWorktree(e, from).catch(() => null)) || null;
  if (from.id === GIT_ID) return "You are the Git agent: install it yourself, then record it with helm_installed (ask for an id with this tool from another agent, or note it in your report).";
  const open = e.repo.listInstalls(runId).find((x) => x.state === "requested" && norm(x.what) === norm(what) && norm(x.where) === norm(where));
  if (open) {
    if (!open.neededBy.some((b) => b.nodeId === from.id)) {
      e.repo.tx(() => {
        e.repo.updateInstall(runId, open.id, { neededBy: [...open.neededBy, { nodeId: from.id, why: why.slice(0, 300), at: e.now() }] });
        e.repo.event(runId, from.id, "install", `also needs ${open.id}: ${what}`.slice(0, 300));
      });
    }
    return `Already asked for as ${open.id}; the Git agent is on it and you are told when it is installed. Keep working on what does not need it.`;
  }
  const git = await ensureGitAgent(e, runId, { queue: true });
  const x: InstallInfo = { id: `I-${e.repo.listInstalls(runId).length + 1}`, runId, what: what.slice(0, 300), where, state: "requested", neededBy: [{ nodeId: from.id, why: why.slice(0, 300), at: e.now() }], command: null, note: null, byNode: null, createdAt: e.now(), doneAt: null };
  e.repo.tx(() => {
    e.repo.insertInstall(x);
    e.repo.event(runId, from.id, "install", `asked the Git agent for ${x.id}: ${what}`.slice(0, 300));
    e.repo.comms(runId, { from: from.id, to: git.id, kind: "ask", summary: `install ${x.id}: ${what}`.slice(0, 300) });
    e.sendFromHelm(runId, git.id, gitAsk(e, x, from, why).slice(0, 3000), { senderNodeId: from.id, kind: "message", commsKind: "ask", key: `install:${runId}:${x.id}` });
  });
  e.outbox.kick();
  await e.pump(runId);
  const when = !git.threadId ? " The Git agent is starting; it gets the request first." : git.status === "paused" ? " The Git agent is paused; it gets the request when it is resumed." : "";
  return `Asked the Git agent for ${x.id} (${what}${where ? ` in ${where}` : ""}). It installs it and records it in the run's install ledger; you are told when it is done.${when} Keep working on what does not need it.`;
}

/** helm_installed: the Git agent records an install. Returns the tool result. */
export function recordInstall(e: Engine, git: NodeInfo, p: { id: string; state: "done" | "failed" | "needs_human"; command?: string; note?: string }): string {
  const runId = git.runId;
  const x = e.repo.getInstall(runId, p.id);
  if (!x) return `No install request ${p.id}. Open ones: ${e.repo.listInstalls(runId).filter((i) => i.state === "requested").map((i) => i.id).join(", ") || "none"}.`;
  const command = p.command?.trim() || null;
  if (p.state === "done" && !command) return "Rejected: say the exact command you ran (command), so the ledger shows how it was installed.";
  const note = p.note?.trim() || null;
  const where = x.where ? ` in ${x.where}` : "";
  const tell =
    p.state === "done"
      ? `Install ${x.id} is done: ${x.what}${where} (${command}).${note ? ` ${note}` : ""} Carry on with the work that needed it.`
      : p.state === "failed"
        ? `Install ${x.id} failed: ${x.what}${where}.${note ? ` ${note}` : ""} Work around it if you can, or ask again with helm_install saying what you need instead.`
        : `Install ${x.id} needs the human (a key, a login, a password or a payment): ${x.what}.${note ? ` ${note}` : ""} Work on what does not depend on it.`;
  e.repo.tx(() => {
    e.repo.updateInstall(runId, x.id, { state: p.state, command, note, byNode: git.id, doneAt: e.now() });
    e.repo.event(runId, git.id, "install", `${x.id} ${p.state}: ${x.what}${command ? ` (${command})` : ""}`.slice(0, 300));
    for (const b of x.neededBy) {
      const n = e.repo.getNode(runId, b.nodeId);
      if (!n || n.status === "done") continue;
      e.sendFromHelm(runId, n.id, tell.slice(0, 1500), { senderNodeId: git.id, kind: "message", commsKind: "info", key: `installed:${runId}:${x.id}:${n.id}:${p.state}` });
    }
    if (!x.neededBy.some((b) => b.nodeId === ORCH_ID)) e.fyi(runId, ORCH_ID, `Install ledger: ${x.id} ${p.state.replace("_", " ")} — ${x.what}${where} for ${x.neededBy.map((b) => b.nodeId).join(", ")}.`);
  });
  e.outbox.kick();
  return `Recorded ${x.id} as ${p.state.replace("_", " ")}; ${x.neededBy.length === 1 ? "the agent that asked was" : `the ${x.neededBy.length} agents that asked were`} told.`;
}

/** The ledger as text: newest first. */
export function installsText(e: Engine, runId: string, opts: { openOnly?: boolean; limit?: number } = {}): string {
  const all = e.repo.listInstalls(runId).filter((x) => !opts.openOnly || x.state === "requested");
  if (!all.length) return opts.openOnly ? "No open install requests." : "Nothing installed yet.";
  const who = (id: string) => {
    const n = e.repo.getNode(runId, id);
    return n ? `${e.label(n)} (${id})` : id;
  };
  return all
    .slice(0, opts.limit ?? 50)
    .map((x) => {
      const when = new Date(x.doneAt ?? x.createdAt).toISOString().slice(0, 16).replace("T", " ");
      const lines = [`${x.id}  ${x.state.replace("_", " ")}  ${x.what}${x.where ? `  —  ${x.where}` : ""}  (${when}Z)`];
      if (x.command) lines.push(`      command: ${x.command}`);
      for (const b of x.neededBy) lines.push(`      needed by ${who(b.nodeId)}: ${b.why}`);
      if (x.note) lines.push(`      note: ${x.note}`);
      return lines.join("\n");
    })
    .join("\n");
}
