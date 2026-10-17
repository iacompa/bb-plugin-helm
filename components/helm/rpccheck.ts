// Checks a request against the same schema BB validates on the wire, before it is sent,
// so a bad request fails with a sentence that names the field ("The text is 23,412
// characters; Helm accepts up to 200,000") instead of "rpc input validation failed".
import { RPC_SCHEMAS } from "../../src/shared/rpc-schemas.ts";

type Issue = { code: string; path: PropertyKey[]; message: string; maximum?: number | bigint; minimum?: number | bigint; origin?: string };
type Schema = { safeParse(v: unknown): { success: true } | { success: false; error: { issues: Issue[] } } };

const FIELD: Record<string, string> = { text: "The text", brief: "The brief", name: "The run name", appsRoot: "The folder", runId: "The run id", model: "The model", portfolio: "The portfolio" };

function at(input: unknown, path: PropertyKey[]): unknown {
  let v = input;
  for (const k of path) v = v && typeof v === "object" ? (v as Record<PropertyKey, unknown>)[k] : undefined;
  return v;
}

/** null when the request is valid; otherwise one sentence a person can act on. */
export function requestProblem(method: string, input: unknown): string | null {
  const schema = (RPC_SCHEMAS as unknown as Record<string, { input: Schema } | undefined>)[method]?.input;
  if (!schema) return null;
  const r = schema.safeParse(input ?? undefined);
  if (r.success) return null;
  const i = r.error.issues[0];
  const field = FIELD[String(i.path[0])] ?? (i.path.length ? `“${i.path.join(".")}”` : "The request");
  const v = at(input, i.path);
  if (i.code === "too_big" && typeof v === "string") return `${field} is ${v.length.toLocaleString()} characters; Helm accepts up to ${Number(i.maximum).toLocaleString()}. Shorten it, or save it to a file and refer to the file.`;
  if (i.code === "too_big" && Array.isArray(v)) return `${field} has ${v.length} items; Helm accepts up to ${Number(i.maximum)}.`;
  if (i.code === "too_small" && typeof v === "string") return `${field} is empty.`;
  return `${field}: ${i.message} (${method}).`;
}

/** Map BB's generic wire errors to something readable. */
export function readableRpcError(method: string, message: string): string {
  if (/rpc input validation failed/i.test(message)) return `Helm could not send this request (${method}): BB rejected its input. This is a Helm bug; it has been recorded — run \`bb helm errors\`.`;
  if (/not a JSON value/i.test(message)) return `Helm's server sent an answer BB could not read (${method}). This is a Helm bug; it has been recorded — run \`bb helm errors\`.`;
  return message;
}
