// Tailored tasks: the supervisor who knows the work writes each agent's task, so every agent
// starts with a short system prompt and a brief section made for exactly its job. The
// Orchestrator writes tasks for managers and leads, a manager for its leads, a lead for its
// squad and gates. A task is binding until its author (or anyone above it) replaces it.

import type { NodeInfo } from "../../shared/types.ts";
import type { Engine } from "./engine.ts";

/** A task is at most this long (about 1,500 tokens). */
export const TASK_MAX = 6000;

export interface AgentTask {
  text: string;
  by: string;
  at: number;
}

const key = (runId: string, nodeId: string) => `task:${runId}:${nodeId}`;

export function getTask(e: Engine, runId: string, nodeId: string): AgentTask | null {
  const raw = e.repo.getMeta(key(runId, nodeId));
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as AgentTask;
    return t.text ? t : null;
  } catch {
    return null;
  }
}

/** True when `by` is above `target` in the org (its parent, grandparent, …). */
export function isAbove(e: Engine, by: NodeInfo, target: NodeInfo): boolean {
  let cur = target.parentId ? e.repo.getNode(target.runId, target.parentId) : null;
  while (cur) {
    if (cur.id === by.id) return true;
    cur = cur.parentId ? e.repo.getNode(target.runId, cur.parentId) : null;
  }
  return false;
}

/** Store a task without telling anyone (spawn time: the brief carries it). Returns an error or null. */
export function storeTask(e: Engine, by: NodeInfo, target: NodeInfo, text: string): string | null {
  if (!isAbove(e, by, target)) return `${e.label(target)} is not in your org; you can only write tasks for agents under you.`;
  const t = text.trim().slice(0, TASK_MAX);
  if (!t) return "The task is empty.";
  e.repo.setMeta(key(target.runId, target.id), JSON.stringify({ text: t, by: by.id, at: e.now() } satisfies AgentTask));
  return null;
}

/** helm_set_task: write or replace the task of an agent under you. A running agent is told at its next step. */
export function setTask(e: Engine, by: NodeInfo, nodeId: string, text: string): string {
  const target = e.repo.getNode(by.runId, nodeId);
  if (!target) return `No node ${nodeId}. Use ids from helm_context${by.role === "orch" ? " or helm_world" : " or helm_digest"}.`;
  const err = storeTask(e, by, target, text);
  if (err) return err;
  const task = getTask(e, by.runId, target.id)!;
  const live = !!target.threadId && !["done", "planned"].includes(target.status);
  e.repo.tx(() => {
    e.repo.event(by.runId, target.id, "task", `task set by ${e.label(by)}: ${task.text.slice(0, 200)}`);
    if (live) {
      const run = e.run(by.runId);
      e.repo.enqueue({ id: e.oid(), runId: by.runId, kind: "file", nodeId: null, payload: { path: e.briefPath(run, target.id), content: e.buildBrief(run, e.node(by.runId, target.id)) }, idemKey: `task-brief:${by.runId}:${target.id}:${task.at}` });
      e.sendFromHelm(by.runId, target.id, `${e.label(by)} set your task (binding until they change it; your brief file has it too):\n\n${task.text}\n\nFinish the step you are on, then work to this task. Report with helm_report.`, { senderNodeId: by.id, kind: "message", key: `task:${by.runId}:${target.id}:${task.at}` });
    }
  });
  e.outbox.kick();
  return live ? `Task set for ${e.label(target)}; it was told and its brief file was rewritten.` : `Task set for ${e.label(target)}; it starts with it.`;
}
