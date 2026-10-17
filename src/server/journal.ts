// Error journal helpers. Failures are recorded in Helm's database (table errors) so they can
// be read with `bb helm errors` and `bb helm doctor`. Request contents are never stored,
// only their shape (field names, types and lengths), so a brief or a secret never lands here.
import { HelmError } from "./engine/engine.ts";
import type { Repo } from "./db/repo.ts";

export type RpcHandler = (input: unknown, ctx: unknown) => unknown;

/** Field names with their type and size: {"brief":"string(23456)","model":"object"}. */
export function inputShape(input: unknown): string {
  if (input === null || input === undefined) return String(input);
  if (typeof input !== "object") return typeof input;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>).slice(0, 30))
    out[k] = typeof v === "string" ? `string(${v.length})` : Array.isArray(v) ? `array(${v.length})` : v === null ? "null" : typeof v;
  return JSON.stringify(out);
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Wrap RPC handlers so every failure is journaled (a refused request as "user", anything else as "error") and rethrown. */
export function journaledHandlers(handlers: Record<string, RpcHandler>, repo: Repo): Record<string, RpcHandler> {
  const out: Record<string, RpcHandler> = {};
  for (const [name, fn] of Object.entries(handlers)) {
    out[name] = async (input, ctx) => {
      try {
        return await fn(input, ctx);
      } catch (e) {
        try {
          const runId = input && typeof input === "object" && typeof (input as { runId?: unknown }).runId === "string" ? (input as { runId: string }).runId : null;
          repo.recordError({ level: e instanceof HelmError ? "user" : "error", source: "rpc", at: name, runId, message: errText(e), detail: `input ${inputShape(input)}${e instanceof Error && !(e instanceof HelmError) && e.stack ? `\n${e.stack.split("\n").slice(0, 6).join("\n")}` : ""}` });
        } catch {
          /* never mask the original error */
        }
        throw e;
      }
    };
  }
  return out;
}

/** Plain-text listing for the CLI. */
export function errorsText(entries: ReturnType<Repo["listErrors"]>, counts: Record<string, number>, sinceLabel: string): string {
  const head = `Helm error journal — ${sinceLabel}: ${counts.error ?? 0} errors · ${counts.warn ?? 0} warnings · ${counts.user ?? 0} refused requests`;
  if (!entries.length) return `${head}\nNothing recorded.`;
  const L = [head, ""];
  for (const e of entries) {
    const t = new Date(e.ts);
    const when = `${t.toISOString().slice(0, 10)} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}`;
    L.push(`${when}  ${e.level.padEnd(5)}  ${e.source}/${e.at}${e.runId ? `  ${e.runId}` : ""}`);
    L.push(`    ${e.message.split("\n")[0].slice(0, 300)}`);
    if (e.detail) L.push(...e.detail.split("\n").slice(0, 4).map((x) => `    ${x.slice(0, 200)}`));
  }
  return L.join("\n");
}
