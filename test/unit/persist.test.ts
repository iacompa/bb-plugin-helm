// The panel's saved state (wizard draft, planning conversation, view) comes back after
// leaving the panel, and anything unreadable or of the wrong shape falls back safely.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearStored, lsGet, lsSet, readStored, sameKind } from "../../components/helm/persist.ts";

function fakeStorage() {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

test("saved values round-trip, and wrong shapes or broken JSON fall back to the default", () => {
  (globalThis as { localStorage?: unknown }).localStorage = fakeStorage();
  lsSet("helm:wiz:chat", JSON.stringify({ threadId: "thr_1", startedAt: 5 }));
  assert.deepEqual(readStored("helm:wiz:chat", null), { threadId: "thr_1", startedAt: 5 });
  lsSet("helm:wiz:limits", "null");
  assert.deepEqual(readStored("helm:wiz:limits", { concurrency: 24 }, sameKind({ concurrency: 24 })), { concurrency: 24 }, "null is not an object");
  lsSet("helm:wiz:step", "{oops");
  assert.equal(readStored("helm:wiz:step", 1, sameKind(1)), 1);
  lsSet("helm:wiz:step", '"3"');
  assert.equal(readStored("helm:wiz:step", 1, sameKind(1)), 1, "a string is not a step");
  assert.equal(sameKind([])({}), false);
  assert.equal(sameKind(null)("anything"), true);
});

test("clearing the wizard draft leaves the rest of the panel's state alone", () => {
  (globalThis as { localStorage?: unknown }).localStorage = fakeStorage();
  lsSet("helm:wiz:brief", '"hello"');
  lsSet("helm:wiz:chat", "null");
  lsSet("helm:tabs", '["run_1"]');
  clearStored("helm:wiz:");
  assert.equal(lsGet("helm:wiz:brief"), null);
  assert.equal(lsGet("helm:wiz:chat"), null);
  assert.equal(lsGet("helm:tabs"), '["run_1"]');
});

test("no storage at all (private mode, sandboxed frame): reads return defaults, writes do nothing", () => {
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
  };
  assert.equal(readStored("helm:view", "graph"), "graph");
  assert.doesNotThrow(() => lsSet("helm:view", '"board"'));
  assert.doesNotThrow(() => clearStored("helm:wiz:"));
  delete (globalThis as { localStorage?: unknown }).localStorage;
});
