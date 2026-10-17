// The Watcher: a light model (the run's "watcher" slot, e.g. Haiku low) that looks at agents
// Helm suspects are stuck and decides what to do with each. Helm's watchdog finds suspects
// from its own database (silent past the stall limit, or a failed command); only then does it
// read those threads from BB and send one compact packet to the watcher thread, which answers
// with helm_watch. No suspects, no tokens. Without a watcher model the plain watchdog runs.

import type { NodeInfo, RunInfo } from "../../shared/types.ts";
import type { Engine } from "./engine.ts";
import { createDirective } from "./direct.ts";

export type WatchVerdict = "ok" | "nudge" | "restart" | "escalate" | "human";

/** A watcher thread is replaced by a fresh one after this many packets, so its context stays small. */
const SWEEPS_PER_THREAD = 25;
/** At most this many agents per packet. */
const MAX_SUSPECTS = 12;

interface WatcherState {
  threadId: string | null;
  sweeps: number;
  gen: number;
}

const stateKey = (runId: string) => `watcher:${runId}`;
const threadKey = (threadId: string) => `watcher-thread:${threadId}`;
const watchedKey = (runId: string, nodeId: string) => `watched:${runId}:${nodeId}`;

function state(e: Engine, runId: string): WatcherState {
  try {
    return { threadId: null, sweeps: 0, gen: 0, ...(JSON.parse(e.repo.getMeta(stateKey(runId)) ?? "{}") as Partial<WatcherState>) };
  } catch {
    return { threadId: null, sweeps: 0, gen: 0 };
  }
}

/** The run a watcher thread belongs to, or null. */
export function watcherRun(e: Engine, threadId: string): string | null {
  return e.repo.getMeta(threadKey(threadId));
}

export const WATCHER_INSTRUCTIONS = [
  "You are Helm's Watcher for one build run. Helm sends you packets about agents that look stuck. For every agent in a packet, call helm_watch once (one call can carry all verdicts). Never run commands or edit files: helm_watch is your only tool.",
  "Verdicts:",
  "- ok: it is clearly working (BB says active and its recent output shows progress on a long task). Leave it.",
  "- nudge: idle or drifting, but nothing is broken. Helm interrupts it at its next step with your note.",
  "- restart: its turn hung (BB says active but nothing new for a long time), it is looping, or its last command failed and it stopped. Helm stops the turn and resumes it with your note.",
  "- escalate: it needs a decision, is blocked on another agent, or keeps failing. Helm sends your note to its nearest active supervisor (its lead, else its manager, else the Orchestrator).",
  "- human: only for credentials, spending real money, private data, access only the human can grant, or a failure nobody in the org can fix.",
  "Keep notes short and concrete: what you saw and what the agent should do next.",
].join("\n");

/** The nearest supervisor that is alive (lead → manager → Orchestrator), skipping failed, stopped or paused ones. */
export function activeSupervisor(e: Engine, n: NodeInfo): NodeInfo | null {
  let cur = n.parentId ? e.repo.getNode(n.runId, n.parentId) : null;
  while (cur) {
    if (cur.threadId && ["running", "waiting", "needs"].includes(cur.status)) return cur;
    cur = cur.parentId ? e.repo.getNode(n.runId, cur.parentId) : null;
  }
  return null;
}

/** Agents worth a look, from Helm's database only: silent past the stall limit, or stopped on a failed command. */
export function suspects(e: Engine, run: RunInfo): NodeInfo[] {
  const now = e.now();
  const stallMs = run.limits.stallMinutes * 60_000;
  return e.repo
    .listNodes(run.id)
    .filter((n) => {
      if (!n.threadId) return false;
      const last = Number(e.repo.getMeta(watchedKey(run.id, n.id)) ?? 0);
      if (now - last < stallMs) return false; // looked at recently
      if (n.status === "running") return now - (n.lastActivityAt ?? n.spawnedAt ?? now) >= stallMs;
      return n.status === "waiting" && /failed/i.test(n.warning ?? "");
    })
    .slice(0, MAX_SUSPECTS);
}

/** One watchdog pass for a run with a watcher model. Returns the agents sent to the watcher. */
export async function sweep(e: Engine, run: RunInfo): Promise<string[]> {
  const model = run.slots.watcher;
  if (!model) return [];
  const list = suspects(e, run);
  if (!list.length) return [];
  const now = e.now();
  const lines: string[] = [`Packet at ${new Date(now).toISOString()}: ${list.length} agent${list.length === 1 ? "" : "s"} to check.`];
  for (const n of list) {
    const st = await e.port.threadState(n.threadId!).catch(() => null);
    const out = await e.port.threadOutput(n.threadId!).catch(() => null);
    const rep = e.repo.reportsFor(run.id, n.id, 1)[0];
    const sup = activeSupervisor(e, n);
    const silent = Math.round((now - (n.lastActivityAt ?? n.spawnedAt ?? now)) / 60_000);
    lines.push(
      [
        `- id: ${n.id} | ${e.label(n)} | Helm status ${n.status}${n.warning ? ` (${n.warning.slice(0, 120)})` : ""} | BB thread ${st ? `${st.status}${st.hasPendingInteraction ? ", waiting on a permission prompt" : ""}${st.archived ? ", archived" : ""}` : "unknown"} | silent ${silent} min`,
        `  last report: ${rep ? `${rep.status}: ${rep.summary.slice(0, 200)}` : "none"}`,
        `  nearest active supervisor: ${sup ? `${e.label(sup)} (${sup.id})` : "none — escalate would reach the human"}`,
        `  recent output: ${out ? out.slice(-500).replace(/\s+/g, " ") : "none"}`,
      ].join("\n"),
    );
  }
  const text = `${lines.join("\n")}\n\nCall helm_watch with a verdict for each id.`;
  const s = state(e, run.id);
  let threadId = s.threadId;
  const fresh = !threadId || s.sweeps >= SWEEPS_PER_THREAD || !(await e.port.threadState(threadId).catch(() => null));
  if (fresh) {
    const old = threadId;
    const orch = e.repo.getNode(run.id, "orch");
    const hostId = e.repo.runHost(run.id);
    if (!run.studioProjectId) return [];
    const cat = await e.catalog(hostId);
    const modes = cat.providers.find((p) => p.id === model.providerId)?.permissionModes;
    const ref = await e.port.spawnThread({
      projectId: run.studioProjectId,
      environment: { kind: "path", hostId, path: e.studioPath(run) },
      title: `Helm · Watcher · ${run.name}`,
      prompt: `${WATCHER_INSTRUCTIONS}\n\n${text}`,
      model,
      // it never runs commands; the mode only matters to BB
      permissionMode: !modes?.length || modes.includes("auto") ? "auto" : modes[0],
      visibility: "hidden",
      lifecycleOwnerThreadId: orch?.threadId ?? null,
      meta: { v: 1, runId: run.id, nodeId: "watch", tier: "watcher", role: "watch", key: `${run.id}:watch#${s.gen + 1}` },
    });
    threadId = ref.threadId;
    e.repo.tx(() => {
      e.repo.setMeta(threadKey(ref.threadId), run.id);
      e.repo.setMeta(stateKey(run.id), JSON.stringify({ threadId: ref.threadId, sweeps: 1, gen: s.gen + 1 }));
    });
    if (old) await e.port.archiveThread(old).catch(() => []);
  } else {
    await e.port.sendMessage({ threadId: threadId!, text, mode: "queue" });
    e.repo.setMeta(stateKey(run.id), JSON.stringify({ ...s, sweeps: s.sweeps + 1 }));
  }
  e.repo.tx(() => {
    for (const n of list) {
      e.repo.setMeta(watchedKey(run.id, n.id), String(now));
      e.repo.event(run.id, n.id, "watch", `sent to the Watcher (silent ${Math.round((now - (n.lastActivityAt ?? now)) / 60_000)} min)`);
    }
  });
  return list.map((n) => n.id);
}

/** Carry out the watcher's verdicts. Returns the tool result. */
export async function applyVerdicts(e: Engine, runId: string, verdicts: Array<{ nodeId: string; verdict: WatchVerdict; note: string }>): Promise<string> {
  const out: string[] = [];
  for (const v of verdicts) {
    const n = e.repo.getNode(runId, v.nodeId);
    if (!n) {
      out.push(`${v.nodeId}: no such agent`);
      continue;
    }
    const note = v.note.trim().slice(0, 600);
    const who = e.label(n);
    switch (v.verdict) {
      case "ok":
        e.repo.event(runId, n.id, "watch-ok", `Watcher: working — ${note}`.slice(0, 300));
        out.push(`${n.id}: left alone`);
        break;
      case "nudge":
        if (!n.threadId) {
          out.push(`${n.id}: no thread to nudge`);
          break;
        }
        e.repo.tx(() => {
          e.sendFromHelm(runId, n.id, `Helm's Watcher: ${note}\nReply with helm_report (progress, blocked or done, with evidence), then continue.`, { mode: "steer", key: `watch-nudge:${runId}:${n.id}:${e.now()}` });
          e.repo.event(runId, n.id, "watch-nudge", `Watcher nudged: ${note}`.slice(0, 300));
        });
        out.push(`${n.id}: nudged`);
        break;
      case "restart": {
        if (!n.threadId) {
          out.push(`${n.id}: no thread to restart`);
          break;
        }
        if (n.status === "failed") {
          await createDirective(e, runId, { type: "retry", target: n.id, text: `Watcher: ${note}`, actor: "system" });
          out.push(`${n.id}: retried`);
          break;
        }
        // same nodeId: the per-node outbox order stops the hung turn before the resume message
        e.repo.tx(() => {
          e.repo.enqueue({ id: e.oid(), runId, kind: "stop", nodeId: n.id, payload: { nodeIds: [n.id] }, idemKey: `watch-stop:${runId}:${n.id}:${e.now()}` });
          e.sendFromHelm(runId, n.id, `Helm's Watcher stopped your turn because it looked stuck: ${note}\nRe-read your BRIEF and helm_context, check git status, then continue from your last commit. Report with helm_report.`, { mode: "queue", key: `watch-resume:${runId}:${n.id}:${e.now()}` });
          e.repo.event(runId, n.id, "watch-restart", `Watcher restarted its turn: ${note}`.slice(0, 300));
        });
        out.push(`${n.id}: stopped and resumed`);
        break;
      }
      case "escalate": {
        const sup = activeSupervisor(e, n);
        if (!sup) {
          raiseStalled(e, n, `${note} (no supervisor is active)`);
          out.push(`${n.id}: no active supervisor — sent to the human`);
          break;
        }
        e.repo.tx(() => {
          e.repo.comms(runId, { from: n.id, to: sup.id, kind: "ask", summary: `Watcher: ${who} looks stuck — ${note}`.slice(0, 300) });
          e.sendFromHelm(runId, sup.id, `Helm's Watcher about ${who} (${n.id}), in your org: ${note}\nDecide what it should do and tell it (helm_direct or helm_message), or reassign the work. Escalate to the human only for credentials, spending, private data or access.`, { senderNodeId: n.id, kind: "message", commsKind: "ask", key: `watch-esc:${runId}:${n.id}:${e.now()}` });
          e.repo.event(runId, n.id, "watch-escalate", `Watcher escalated to ${e.label(sup)}: ${note}`.slice(0, 300));
        });
        out.push(`${n.id}: escalated to ${sup.id}`);
        break;
      }
      case "human":
        raiseStalled(e, n, note);
        out.push(`${n.id}: sent to the human`);
        break;
    }
  }
  e.outbox.kick();
  return out.join("\n") || "No verdicts.";
}

function raiseStalled(e: Engine, n: NodeInfo, note: string): void {
  e.raiseNeed(n.runId, {
    kind: "stalled",
    nodeId: n.id,
    appId: n.appId,
    title: `${e.label(n)} looks stuck`,
    body: `Helm's Watcher: ${note}`,
    evidence: n.lastActivityAt ? `last activity ${new Date(n.lastActivityAt).toISOString()}` : "",
    options: ["Nudge again", "Retry", "Stop"],
    dedupeKey: `watch:${n.id}:${e.now()}`,
  });
}
