// Questions between agents (helm_message kind "ask") and the turn that answers them.

/** The open question `from` asked `to` (meta): sending → queued → live (the turn that answers it is running). */
export function askKey(runId: string, to: string, from: string): string {
  return `ask:${runId}:${to}:${from}`;
}
