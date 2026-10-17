// Shared inspector helpers: node/app detail loading, directive sending, the
// notification chain, and sending plain messages into a BB thread.
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import type { AppDetail, DirectiveInfo, DirectiveType, ForeignThread, ModelRef, NodeDetail, RecipientLevel, SnapNode } from "../types.ts";
import { errMsg, TYPE_LABEL } from "../format.ts";
import { ancestorsOf, type RunState } from "../store.ts";
import { useHelm } from "../ctx.tsx";

/** Load node_get for the selected node; refetch (debounced) on every store change. Keeps the last detail while reloading. */
export function useNodeDetail(nodeId: string | null): { detail: NodeDetail | null; error: string | null; reload: () => void } {
  const h = useHelm();
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cur = useRef(nodeId);
  cur.current = nodeId;
  const load = useCallback(() => {
    const id = cur.current;
    if (!id || !h.runId || id.startsWith("ghost:")) return;
    h.rpc.call("node_get", { runId: h.runId, nodeId: id }).then(
      (d: NodeDetail) => {
        if (cur.current !== id) return;
        setDetail(d);
        setError(null);
      },
      (e: unknown) => {
        if (cur.current !== id) return;
        setError(errMsg(e));
      },
    );
  }, [h.rpc, h.runId]);
  useEffect(() => {
    setDetail((d) => (d && d.node.id === nodeId ? d : null));
    setError(null);
    load();
  }, [nodeId, load]);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(load, 800);
    return () => clearTimeout(t);
  }, [h.rev, load]);
  return { detail: detail && detail.node.id === nodeId ? detail : null, error, reload: load };
}

export function useAppDetail(appId: string | null | undefined): AppDetail | null {
  const h = useHelm();
  const [detail, setDetail] = useState<AppDetail | null>(null);
  useEffect(() => {
    if (!appId || !h.runId) {
      setDetail(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      h.rpc.call("app_get", { runId: h.runId!, appId }).then(
        (d: AppDetail) => live && setDetail(d),
        () => live && setDetail(null),
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [appId, h.runId, h.rpc, h.rev]);
  return detail && detail.app.id === appId ? detail : null;
}

export interface DirectiveDraft {
  type: DirectiveType;
  target: string;
  cascade?: "self" | "reports" | "subtree";
  mode?: "steer" | "queue";
  policy?: boolean;
  text?: string;
  value?: unknown;
  modelTo?: ModelRef | null;
  findingIds?: string[];
  rotatedConfirmed?: boolean;
}

/** Create a directive, pulse the chain, toast the outcome. Resolves with the stored directive or null. */
export function useSendDirective() {
  const h = useHelm();
  return useCallback(
    async (d: DirectiveDraft): Promise<DirectiveInfo | null> => {
      if (!h.runId) return null;
      try {
        const res = (await h.rpc.call("directive_create", { runId: h.runId, directive: { cascade: "self", ...d } })) as DirectiveInfo;
        h.firePulse(res);
        toast.success(`${res.id} · ${TYPE_LABEL[res.type] ?? res.type}`, { description: res.summary });
        return res;
      } catch (e) {
        toast.error("Directive not sent", { description: errMsg(e) });
        return null;
      }
    },
    [h],
  );
}

export interface ChainLink {
  id: string;
  level: RecipientLevel;
  world: boolean;
}
/** Who is told when this node changes: parent (full), higher ancestors (digest), the Orchestrator always in world state. */
export function notifyChain(s: RunState, id: string): ChainLink[] {
  return ancestorsOf(s, id).map((a, i) => ({ id: a, level: i === 0 ? "full" : "digest", world: s.nodes[a]?.role === "orch" }));
}

export const isOrch = (n: SnapNode | null | undefined) => !!n && n.role === "orch";

/** Send plain text into a BB thread (questions to the Orchestrator are not directives, §6.8). */
export async function sendThreadText(sdk: PluginBrowserBbSdk, threadId: string, text: string): Promise<void> {
  await sdk.threads.send({ threadId, input: [{ type: "text", text, mentions: [] }], mode: "queue-if-active" });
}

// ───────────── Observatory ghost cache ─────────────

const ghostCache = new Map<string, ForeignThread>();
let ghostLoad: Promise<void> | null = null;
export function useGhost(threadId: string | null): { ghost: ForeignThread | null; loading: boolean } {
  const h = useHelm();
  const [, setTick] = useState(0);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!threadId || ghostCache.has(threadId)) return;
    setLoading(true);
    ghostLoad ??= h.rpc.call("observatory_list", { limit: 200 }).then(
      (list: ForeignThread[] | { threads?: ForeignThread[] }) => {
        const arr = Array.isArray(list) ? list : list?.threads ?? [];
        for (const t of arr) ghostCache.set(t.threadId, t);
      },
      () => undefined,
    );
    const p = ghostLoad;
    void p.then(() => {
      if (ghostLoad === p) ghostLoad = null;
      setLoading(false);
      setTick((t) => t + 1);
    });
  }, [threadId, h.rpc]);
  return { ghost: threadId ? ghostCache.get(threadId) ?? null : null, loading };
}
