// Data hooks: typed RPC, the run list, and one run's normalized live store
// (run_get once, then realtime patches; debounced refetch for structural events).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginRpcClient } from "@get-bb/plugin-sdk/app";
import type { Catalog, RealtimeBatch, RpcContract, RunListItem, Snapshot } from "./types.ts";
import { applyBatch, fromSnapshot, type BatchEffects, type RunState } from "./store.ts";
import { errMsg } from "./format.ts";
import { readableRpcError, requestProblem } from "./rpccheck.ts";

export type HelmRpc = PluginRpcClient<RpcContract>;

/** JSON-clean an RPC input: the wire rejects `undefined` values, so drop them. */
export function cleanInput<T>(input: T): T {
  if (input === undefined || input === null || typeof input !== "object") return input;
  return JSON.parse(JSON.stringify(input)) as T;
}

type RawCall = (m: string, ...a: unknown[]) => Promise<unknown>;
let reporter: ((r: { level: "error" | "warn" | "user"; at: string; message: string; detail?: string | null; runId?: string | null }) => void) | null = null;
const recent = new Map<string, number>();

/** Send a panel failure to Helm's error journal (`bb helm errors`). Never throws; repeats within 30 s are dropped. */
export function reportClientError(level: "error" | "warn" | "user", at: string, message: string, detail?: string | null, runId?: string | null): void {
  const key = `${at}|${message}`;
  const now = Date.now();
  if ((recent.get(key) ?? 0) > now - 30_000) return;
  recent.set(key, now);
  if (recent.size > 200) recent.clear();
  try {
    reporter?.({ level, at: at.slice(0, 200), message: message.slice(0, 2000), detail: detail ? detail.slice(0, 4000) : null, runId: runId ?? null });
  } catch {
    /* reporting must never break the panel */
  }
}

/**
 * The plugin RPC client. Inputs are JSON-cleaned (optional fields may be undefined) and
 * checked against the shared schema first; every failure is reported to the error journal
 * and surfaces as a readable message.
 */
export function useHelmRpc(): HelmRpc {
  const raw = useRpc<RpcContract>();
  return useMemo<HelmRpc>(() => {
    const call = raw.call as RawCall;
    reporter = (r) => void call("client_error", r).catch(() => undefined);
    return {
      call: (async (method: string, ...args: unknown[]) => {
        const input = cleanInput(args[0]);
        const runId = input && typeof input === "object" && typeof (input as { runId?: unknown }).runId === "string" ? (input as { runId: string }).runId : null;
        const problem = requestProblem(method, input);
        if (problem) {
          reportClientError("user", `rpc ${method}`, problem, null, runId);
          throw new Error(problem);
        }
        try {
          return await call(method, ...(args.length ? [input, ...args.slice(1)] : []));
        } catch (e) {
          const msg = errMsg(e);
          // a request the server refused with a reason is already journaled server-side
          if (/rpc input validation failed|not a JSON value|HTTP 5\d\d|failed to fetch|network/i.test(msg)) reportClientError("error", `rpc ${method}`, msg, null, runId);
          throw new Error(readableRpcError(method, msg));
        }
      }) as HelmRpc["call"],
    };
  }, [raw]);
}

export function useRuns(rpc: HelmRpc) {
  const [runs, setRuns] = useState<RunListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    rpc.call("run_list", {}).then(
      (r: { runs: RunListItem[] }) => {
        setRuns(r.runs ?? []);
        setError(null);
      },
      (e: unknown) => setError(errMsg(e)),
    );
  }, [rpc]);
  useEffect(refresh, [refresh]);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useRealtime("helm:runs", () => {
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(refresh, 300);
  });
  return { runs, error, refresh };
}

export function useCatalog(rpc: HelmRpc) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(
    (opts: { refresh?: boolean; markSeen?: boolean } = {}) => {
      setLoading(true);
      return rpc.call("models_catalog", opts).then(
        (c: Catalog) => {
          setCatalog(c);
          setError(null);
          setLoading(false);
          return c;
        },
        (e: unknown) => {
          setError(errMsg(e));
          setLoading(false);
          return null;
        },
      );
    },
    [rpc],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return { catalog, error, loading, load };
}

export interface RunData {
  state: RunState | null;
  /** increments on every applied change (snapshot or batch) */
  rev: number;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * One run's live store. `onEffects` sees every applied batch (for propagation
 * pulses and receipt flashes); it is read through a ref so it can change freely.
 */
export function useRunData(rpc: HelmRpc, runId: string | null, onEffects?: (fx: BatchEffects) => void): RunData {
  const stateRef = useRef<RunState | null>(null);
  const [rev, setRev] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fxRef = useRef(onEffects);
  fxRef.current = onEffects;
  const runRef = useRef(runId);
  runRef.current = runId;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef(false);
  const again = useRef(false);

  const load = useCallback(() => {
    const id = runRef.current;
    if (!id) return;
    if (inflight.current) {
      again.current = true;
      return;
    }
    inflight.current = true;
    rpc.call("run_get", { runId: id }).then(
      (s: Snapshot) => {
        inflight.current = false;
        // the tab switched while this was loading: load the run now shown
        if (runRef.current !== id) {
          again.current = false;
          load();
          return;
        }
        stateRef.current = fromSnapshot(s, stateRef.current?.seq ?? 0);
        setError(null);
        setLoading(false);
        setRev((r) => r + 1);
        if (again.current) {
          again.current = false;
          load();
        }
      },
      (e: unknown) => {
        inflight.current = false;
        if (runRef.current !== id) {
          again.current = false;
          load();
          return;
        }
        setError(errMsg(e));
        setLoading(false);
        if (again.current) {
          again.current = false;
          load();
        }
      },
    );
  }, [rpc]);

  const refetch = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(load, 350);
  }, [load]);

  useEffect(() => {
    stateRef.current = null;
    setRev((r) => r + 1);
    setError(null);
    if (runId) {
      setLoading(true);
      load();
    }
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [runId, load]);

  useRealtime(`run:${runId ?? "none"}`, (payload: unknown) => {
    const cur = stateRef.current;
    const batch = payload as RealtimeBatch;
    if (!cur || !runId || !batch || (batch.runId && batch.runId !== runId)) return;
    const fx = applyBatch(cur, batch);
    stateRef.current = fx.state;
    setRev((r) => r + 1);
    if (fx.refetch) refetch();
    fxRef.current?.(fx);
  });

  // after a reconnect we may have missed batches: resync
  const conn = useRealtimeConnectionState();
  const prevConn = useRef(conn);
  useEffect(() => {
    if (prevConn.current !== "connected" && conn === "connected") refetch();
    prevConn.current = conn;
  }, [conn, refetch]);

  return { state: stateRef.current, rev, loading, error, refetch };
}
