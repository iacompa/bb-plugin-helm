// Realtime coalescer (§10.3): one channel per run, at most 4 messages a second,
// each a batch of patches. Patches only; the app keeps a normalized store.

import { realtimeChannel, type RealtimeBatch } from "../shared/protocol.ts";
import type { Timers } from "./bb/port.ts";

export class Coalescer {
  private pending = new Map<string, RealtimeBatch["events"]>();
  private timers = new Map<string, () => void>();
  private lastSent = new Map<string, number>();
  private seq = 0;

  constructor(
    private publish: (channel: string, payload: RealtimeBatch) => void,
    private clock: Timers,
    private minGapMs = 250,
  ) {}

  push(runId: string, event: string, payload: unknown): void {
    const list = this.pending.get(runId) ?? [];
    list.push({ event, payload, ts: this.clock.now() });
    this.pending.set(runId, list);
    if (this.timers.has(runId)) return;
    const wait = Math.max(0, (this.lastSent.get(runId) ?? 0) + this.minGapMs - this.clock.now());
    this.timers.set(runId, this.clock.setTimeout(() => this.flush(runId), wait));
  }

  flush(runId: string): void {
    this.timers.get(runId)?.();
    this.timers.delete(runId);
    const events = this.pending.get(runId);
    this.pending.delete(runId);
    if (!events?.length) return;
    this.lastSent.set(runId, this.clock.now());
    this.publish(realtimeChannel(runId), { runId, seq: ++this.seq, events });
  }

  dispose(): void {
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
    this.pending.clear();
  }
}
