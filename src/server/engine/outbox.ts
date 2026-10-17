// The outbox worker (§9.2). Every BB side effect is a row written in the same
// transaction as the state change that caused it; this worker performs them.
// Per-node FIFO, different nodes in parallel (≤ 8 in flight), retry with
// backoff 2 s · 8 s · 30 s · 2 m · 10 m (± jitter), five attempts, then failed.

import type { OutboxRow, Repo } from "../db/repo.ts";
import type { Timers } from "../bb/port.ts";
import type { Logger } from "./context.ts";

export const BACKOFF_MS = [2_000, 8_000, 30_000, 120_000, 600_000];
export const MAX_ATTEMPTS = 5;
export const MAX_INFLIGHT = 8;

/** A handler finishes the row, asks to wait without spending an attempt, or throws to retry. */
export type HandlerResult = { done: true; result?: unknown } | { defer: number; reason: string };
export type Handler = (row: OutboxRow) => Promise<HandlerResult>;

export class OutboxWorker {
  private inflight = new Set<string>();
  private inflightNodes = new Set<string>();
  private timer: (() => void) | null = null;
  private timerAt = Infinity;
  private draining = false;
  private again = false;
  private stopped = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private repo: Repo,
    private timers: Timers,
    private handlers: Partial<Record<OutboxRow["kind"], Handler>>,
    private hooks: { onFailed(row: OutboxRow, error: string): void; onDone(row: OutboxRow, result: unknown): void; log: Logger; jitter?: () => number },
  ) {}

  /** Rows left inflight by a crash go back to pending (their handlers are idempotent). */
  recover(): number {
    const rows = this.repo.inflightOutbox();
    for (const r of rows) this.repo.markOutbox(r.id, { state: "pending", nextAttemptAt: this.timers.now() });
    return rows.length;
  }

  stop(): void {
    this.stopped = true;
    this.timer?.();
    this.timer = null;
  }

  /** Ask for a drain soon. Safe to call often. */
  kick(): void {
    if (this.stopped) return;
    this.schedule(this.timers.now());
  }

  /** Resolves when nothing is in flight and no row is due now (tests). */
  whenIdle(): Promise<void> {
    if (!this.inflight.size && !this.draining) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  get inflightCount(): number {
    return this.inflight.size;
  }

  private schedule(at: number): void {
    if (this.stopped) return;
    if (at >= this.timerAt) return;
    this.timer?.();
    this.timerAt = at;
    const delay = Math.max(0, at - this.timers.now());
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.timerAt = Infinity;
      void this.drain();
    }, delay);
  }

  async drain(): Promise<void> {
    if (this.stopped) return;
    if (this.draining) {
      this.again = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.again = false;
        const now = this.timers.now();
        const due = this.repo.dueOutbox(now, 256);
        const blockedNodes = new Set<string>();
        for (const row of due) {
          if (this.inflight.size >= MAX_INFLIGHT) break;
          if (this.inflight.has(row.id)) continue;
          const nodeKey = row.nodeId ? `${row.runId}:${row.nodeId}` : null;
          if (nodeKey) {
            if (this.inflightNodes.has(nodeKey) || blockedNodes.has(nodeKey)) continue;
            // per-node FIFO: an older pending row for the same node goes first
            const older = this.repo.pendingForNode(row.nodeId!, row.runId).find((o) => o.seq < row.seq);
            if (older) {
              blockedNodes.add(nodeKey);
              continue;
            }
            this.inflightNodes.add(nodeKey);
          }
          this.inflight.add(row.id);
          this.repo.markOutbox(row.id, { state: "inflight" });
          void this.execute(row, nodeKey);
        }
      } while (this.again);
    } finally {
      this.draining = false;
    }
    const next = this.repo.nextOutboxAttempt();
    if (next !== null && this.inflight.size < MAX_INFLIGHT) this.schedule(Math.max(next, this.timers.now()));
    this.maybeIdle();
  }

  private async execute(row: OutboxRow, nodeKey: string | null): Promise<void> {
    const handler = this.handlers[row.kind];
    try {
      if (!handler) throw new Error(`no handler for outbox kind ${row.kind}`);
      const res = await handler(row);
      if ("defer" in res) {
        this.repo.markOutbox(row.id, { state: "pending", nextAttemptAt: this.timers.now() + res.defer, lastError: `waiting: ${res.reason}` });
      } else {
        this.repo.markOutbox(row.id, { state: "done", doneAt: this.timers.now(), result: res.result ?? null, lastError: null });
        this.hooks.onDone(row, res.result ?? null);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const attempts = row.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        this.repo.markOutbox(row.id, { state: "failed", attempts, lastError: msg, nextAttemptAt: null });
        this.hooks.log.warn(`outbox ${row.kind} ${row.id} failed after ${attempts} attempts: ${msg}`);
        this.hooks.onFailed(row, msg);
      } else {
        const base = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
        const jitter = 1 + ((this.hooks.jitter?.() ?? 0.5) - 0.5) * 0.2;
        this.repo.markOutbox(row.id, { state: "pending", attempts, lastError: msg, nextAttemptAt: this.timers.now() + Math.round(base * jitter) });
      }
    } finally {
      this.inflight.delete(row.id);
      if (nodeKey) this.inflightNodes.delete(nodeKey);
      void this.drain();
    }
  }

  private maybeIdle(): void {
    if (this.inflight.size || this.draining) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  /** Manual retry of a failed row (Ledger "Retry"). */
  retry(id: string): boolean {
    const row = this.repo.getOutbox(id);
    if (!row || row.state !== "failed") return false;
    this.repo.markOutbox(id, { state: "pending", attempts: 0, nextAttemptAt: this.timers.now(), lastError: null });
    this.kick();
    return true;
  }
}
