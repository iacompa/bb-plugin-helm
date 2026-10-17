import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Repo, migrate } from "../../src/server/db/repo.ts";
import { MIGRATIONS } from "../../src/server/db/schema.ts";
import type { NeedInfo } from "../../src/shared/types.ts";

function fresh(start = 1_000) {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  let t = start;
  const clock = { now: () => t, set: (v: number) => (t = v) };
  return { db, repo: new Repo(db, clock.now), clock };
}

const version = (db: DatabaseSync) => (db.prepare("SELECT version FROM schema_version").all() as Array<{ version: number }>).map((r) => ({ version: Number(r.version) }));
const columns = (db: DatabaseSync, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

// ───────────────────────────── migrations (§3.4) ─────────────────────────────

test("§3.4 migrate creates every table and records the schema version", () => {
  const db = new DatabaseSync(":memory:");
  assert.equal(migrate(db), MIGRATIONS.length);
  assert.deepEqual(version(db), [{ version: MIGRATIONS.length }]);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
  for (const t of ["runs", "apps", "nodes", "directives", "directive_recipients", "policies", "outbox", "findings", "checks", "stage_history", "needs", "node_events", "comms", "seen_models", "slot_presets", "snapshots", "reports", "verdicts", "meta", "inbox", "schema_version"])
    assert.ok(tables.includes(t), `missing table ${t}`);
  assert.ok(columns(db, "needs").includes("data_json"));
  assert.ok(columns(db, "directive_recipients").includes("queued_message_id"));
});

test("§3.4 migrate is idempotent: running it again is a no-op and keeps data", () => {
  const { db, repo } = fresh();
  repo.setMeta("k", "v");
  assert.equal(migrate(db), MIGRATIONS.length);
  assert.equal(migrate(db), MIGRATIONS.length);
  assert.deepEqual(version(db), [{ version: MIGRATIONS.length }], "exactly one version row");
  assert.equal(repo.getMeta("k"), "v");
});

test("§3.4 migrate is forward-only: a v1 database only runs the newer statements", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE schema_version(version INTEGER NOT NULL)");
  db.exec(MIGRATIONS[0]);
  db.prepare("INSERT INTO schema_version(version) VALUES (1)").run();
  assert.ok(!columns(db, "needs").includes("data_json"));
  assert.equal(migrate(db), MIGRATIONS.length);
  assert.ok(columns(db, "needs").includes("data_json"));
  assert.ok(columns(db, "inbox").includes("flushed_at"));
});

test("a failing migration rolls back and leaves the version where it was", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE schema_version(version INTEGER NOT NULL)");
  db.exec(MIGRATIONS[0]);
  db.prepare("INSERT INTO schema_version(version) VALUES (1)").run();
  db.exec("ALTER TABLE needs ADD COLUMN data_json TEXT"); // migration 2 will now collide
  assert.throws(() => migrate(db), /duplicate column/);
  assert.deepEqual(version(db), [{ version: 1 }]);
  assert.ok(!columns(db, "inbox").length, "the inbox table from the failed step was rolled back");
});

// ───────────────────────────── outbox (§9.2) ─────────────────────────────

const ob = (id: string, nodeId: string | null, over: Partial<{ runId: string; kind: string; notBefore: number; idemKey: string; payload: unknown }> = {}) => ({
  id,
  runId: over.runId ?? "r1",
  kind: over.kind ?? "send",
  nodeId,
  payload: over.payload ?? { id },
  idemKey: over.idemKey ?? `k:${id}`,
  notBefore: over.notBefore,
});

test("§9.2 outbox rows are ordered by insertion seq (rowid), not by id", () => {
  const { repo } = fresh();
  for (const [id, node] of [["z9", "A"], ["a1", "B"], ["m5", "A"], ["b2", null]] as const) assert.equal(repo.enqueue(ob(id, node)), true);
  const due = repo.dueOutbox(1_000);
  assert.deepEqual(due.map((o) => o.id), ["z9", "a1", "m5", "b2"]);
  assert.ok(due.every((o, i) => i === 0 || o.seq > due[i - 1].seq), "seq strictly increases");
  assert.deepEqual(due[0].payload, { id: "z9" });
  assert.equal(due[0].state, "pending");
  assert.equal(due[0].attempts, 0);
  assert.equal(due[0].createdAt, 1_000);
  assert.equal(due[3].nodeId, null);
  assert.deepEqual(repo.outboxForRun("r1").map((o) => o.id), ["z9", "a1", "m5", "b2"]);
  assert.equal(repo.getOutbox("m5")?.seq, due[2].seq);
  assert.equal(repo.outboxByIdem("k:a1")?.id, "a1");
  assert.equal(repo.getOutbox("nope"), null);
});

test("§9.2 idem_key is unique: enqueuing twice is harmless", () => {
  const { repo } = fresh();
  assert.equal(repo.enqueue(ob("o1", "A", { idemKey: "spawn:r1:A:1" })), true);
  assert.equal(repo.enqueue(ob("o2", "A", { idemKey: "spawn:r1:A:1" })), false);
  assert.deepEqual(repo.outboxForRun("r1").map((o) => o.id), ["o1"]);
});

test("§9.2 dueOutbox honours next_attempt_at and the limit, and skips non-pending rows", () => {
  const { repo, clock } = fresh();
  repo.enqueue(ob("now", "A"));
  repo.enqueue(ob("later", "A", { notBefore: 5_000 }));
  repo.enqueue(ob("done", "B"));
  repo.enqueue(ob("fly", "B"));
  repo.markOutbox("done", { state: "done", doneAt: 1_500 });
  repo.markOutbox("fly", { state: "inflight", attempts: 1 });
  assert.deepEqual(repo.dueOutbox(1_000).map((o) => o.id), ["now"]);
  assert.deepEqual(repo.dueOutbox(5_000).map((o) => o.id), ["now", "later"]);
  assert.deepEqual(repo.dueOutbox(5_000, 1).map((o) => o.id), ["now"]);
  assert.equal(repo.nextOutboxAttempt(), 1_000);
  assert.deepEqual(repo.inflightOutbox().map((o) => o.id), ["fly"]);
  // retry with backoff: back to pending with a future attempt time
  clock.set(2_000);
  repo.markOutbox("fly", { state: "pending", attempts: 2, nextAttemptAt: 10_000, lastError: "x".repeat(1000) });
  const fly = repo.getOutbox("fly")!;
  assert.equal(fly.attempts, 2);
  assert.equal(fly.lastError?.length, 600, "errors are truncated");
  assert.deepEqual(repo.dueOutbox(9_999).map((o) => o.id), ["now", "later"]);
  assert.deepEqual(repo.dueOutbox(10_000).map((o) => o.id), ["now", "later", "fly"]);
  repo.markOutbox("now", { state: "done", result: { threadId: "t1" } });
  assert.deepEqual(repo.getOutbox("now")?.result, { threadId: "t1" });
});

test("§9.2 pendingForNode: per-node FIFO of pending and inflight rows in one run", () => {
  const { repo } = fresh();
  repo.enqueue(ob("a1", "A"));
  repo.enqueue(ob("b1", "B"));
  repo.enqueue(ob("a2", "A", { kind: "spawn" }));
  repo.enqueue(ob("a3", "A"));
  repo.enqueue(ob("a4", "A"));
  repo.enqueue(ob("x1", "A", { runId: "r2" }));
  repo.markOutbox("a1", { state: "inflight" });
  repo.markOutbox("a3", { state: "done" });
  repo.markOutbox("a4", { state: "failed" });
  assert.deepEqual(repo.pendingForNode("A", "r1").map((o) => [o.id, o.state]), [["a1", "inflight"], ["a2", "pending"]]);
  assert.deepEqual(repo.pendingForNode("A", "r2").map((o) => o.id), ["x1"]);
  assert.deepEqual(repo.pendingForNode("B", "r1").map((o) => o.id), ["b1"]);
  assert.deepEqual(repo.pendingForNode("C", "r1"), []);
  assert.deepEqual(repo.outboxForRun("r1", ["done", "failed"]).map((o) => o.id), ["a3", "a4"]);
});

test("tx commits on success and rolls back state changes and outbox rows together on error", () => {
  const { repo } = fresh();
  repo.tx(() => {
    repo.enqueue(ob("ok", "A"));
    repo.tx(() => repo.setMeta("nested", "1"));
  });
  assert.throws(() =>
    repo.tx(() => {
      repo.enqueue(ob("bad", "A"));
      repo.setMeta("lost", "1");
      throw new Error("boom");
    }),
  );
  assert.deepEqual(repo.outboxForRun("r1").map((o) => o.id), ["ok"]);
  assert.equal(repo.getMeta("nested"), "1");
  assert.equal(repo.getMeta("lost"), null);
});

// ───────────────────────────── inbox ─────────────────────────────

test("inbox: push, unflushed in order, markFlushed, recent newest-first", () => {
  const { repo, clock } = fresh();
  repo.pushInbox("r1", "lumen.lead", "first", "D-1");
  clock.set(1_100);
  repo.pushInbox("r1", "lumen.lead", "second");
  repo.pushInbox("r1", "lumen.lead", "x".repeat(2000));
  repo.pushInbox("r1", "stride.lead", "other node");
  repo.pushInbox("r2", "lumen.lead", "other run");
  const un = repo.unflushedInbox("r1", "lumen.lead");
  assert.deepEqual(un.map((x) => [x.text.slice(0, 6), x.directiveId, x.ts]), [["first", "D-1", 1_000], ["second", null, 1_100], ["xxxxxx", null, 1_100]]);
  assert.equal(un[2].text.length, 800, "lines are capped at 800 chars");
  clock.set(2_000);
  repo.markInboxFlushed([un[0].id, un[1].id]);
  repo.markInboxFlushed([]);
  assert.deepEqual(repo.unflushedInbox("r1", "lumen.lead").map((x) => x.id), [un[2].id]);
  const recent = repo.recentInbox("r1", "lumen.lead");
  assert.deepEqual(recent.map((x) => x.id), [un[2].id, un[1].id, un[0].id]);
  assert.deepEqual(recent.map((x) => x.flushedAt), [null, 2_000, 2_000]);
  assert.equal(repo.recentInbox("r1", "lumen.lead", 1).length, 1);
  assert.deepEqual(repo.unflushedInbox("r1", "stride.lead").map((x) => x.text), ["other node"]);
});

// ───────────────────────────── directive recipients ─────────────────────────────

test("recipients are found by BB queued-message id (message.dispatched receipts)", () => {
  const { repo } = fresh();
  const base = { world: false, state: "queued" as const, notice: "n", outboxId: null };
  repo.insertRecipient("r1", { ...base, directiveId: "D-1", nodeId: "lumen.ui", level: "direct" });
  repo.insertRecipient("r1", { ...base, directiveId: "D-1", nodeId: "lumen.lead", level: "full" });
  repo.insertRecipient("r1", { ...base, directiveId: "D-1", nodeId: "orch", level: "digest", world: true });
  repo.insertRecipient("r2", { ...base, directiveId: "D-1", nodeId: "lumen.ui", level: "direct" });
  assert.deepEqual(repo.recipientsByQueuedMessage("qm-1"), []);
  repo.updateRecipient("r1", "D-1", "lumen.ui", { queuedMessageId: "qm-1", outboxId: "o1" });
  repo.updateRecipient("r1", "D-1", "lumen.lead", { queuedMessageId: "qm-1" });
  repo.updateRecipient("r2", "D-1", "lumen.ui", { queuedMessageId: "qm-2" });
  const got = repo.recipientsByQueuedMessage("qm-1");
  assert.deepEqual(got.map((r) => [r.runId, r.nodeId, r.level]).sort(), [["r1", "lumen.lead", "full"], ["r1", "lumen.ui", "direct"]]);
  assert.deepEqual(repo.recipientsByQueuedMessage("qm-2").map((r) => r.runId), ["r2"]);
  assert.deepEqual(repo.recipientsByOutbox("o1").map((r) => r.nodeId), ["lumen.ui"]);
  // delivery receipt
  repo.updateRecipient("r1", "D-1", "lumen.ui", { state: "delivered", deliveredAt: 1_234 });
  const ui = repo.recipients("r1", "D-1").find((r) => r.nodeId === "lumen.ui")!;
  assert.equal(ui.state, "delivered");
  assert.equal(ui.deliveredAt, 1_234);
  assert.equal(repo.recipients("r1", "D-1").find((r) => r.nodeId === "orch")!.world, true);
  // clearing the queued-message id detaches it
  repo.updateRecipient("r1", "D-1", "lumen.lead", { queuedMessageId: null });
  assert.deepEqual(repo.recipientsByQueuedMessage("qm-1").map((r) => r.nodeId), ["lumen.ui"]);
  // unacked direct/full recipients per node
  assert.deepEqual(repo.unackedFor("r1", "lumen.ui").map((r) => r.directiveId), ["D-1"]);
  assert.deepEqual(repo.unackedFor("r1", "orch"), [], "digest recipients never owe an ack");
});

// ───────────────────────────── needs ─────────────────────────────

const need = (id: string, over: Partial<NeedInfo & { dedupeKey: string | null }> = {}): NeedInfo & { dedupeKey?: string | null } => ({
  id,
  runId: "r1",
  kind: "plan",
  nodeId: "orch",
  appId: null,
  title: "Start the next wave?",
  body: "2 apps",
  evidence: "",
  options: ["Approve", "Deny"],
  interactionId: null,
  state: "open",
  createdAt: 1_000,
  resolvedAt: null,
  resolution: null,
  ...over,
});

test("needs: data_json round-trips machine data exactly", () => {
  const { repo } = fresh();
  const data = { appIds: ["lumen", "stride"], agentsAdded: 17, forecastDelta: 12.5, nested: { ok: true, list: [1, null, "x"] }, unicode: "Mint Jar — “quotes” ✓" };
  assert.equal(repo.insertNeed(need("N-1", { data })), true);
  const got = repo.getNeed("r1", "N-1")!;
  assert.deepEqual(got.data, data);
  assert.deepEqual(got.options, ["Approve", "Deny"]);
  assert.equal(got.kind, "plan");
  // absent data comes back as null
  repo.insertNeed(need("N-2"));
  assert.equal(repo.getNeed("r1", "N-2")!.data, null);
  assert.equal(repo.getNeed("r1", "missing"), null);
});

test("needs: dedupe key blocks a second open need; resolving stores the resolution and frees the key", () => {
  const { repo, clock } = fresh();
  assert.equal(repo.insertNeed(need("N-1", { dedupeKey: "signoff:lumen:abc" })), true);
  assert.equal(repo.insertNeed(need("N-2", { dedupeKey: "signoff:lumen:abc" })), false);
  assert.deepEqual(repo.listNeeds("r1", "open").map((n) => n.id), ["N-1"]);
  clock.set(3_000);
  repo.resolveNeed("r1", "N-1", { choice: "Approve", by: "human" });
  const r = repo.getNeed("r1", "N-1")!;
  assert.equal(r.state, "resolved");
  assert.equal(r.resolvedAt, 3_000);
  assert.deepEqual(r.resolution, { choice: "Approve", by: "human" });
  assert.equal(repo.insertNeed(need("N-3", { dedupeKey: "signoff:lumen:abc" })), true);
  assert.deepEqual(repo.openNeedsFor("r1", "orch").map((n) => n.id), ["N-3"]);
});
