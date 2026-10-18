// Decision rights: Helm runs like a company. Each level decides what is inside its own remit and
// goes up only when something crosses that remit, the plan changes, it is stuck after trying, or
// only the owner can answer. The Orchestrator oversees and delegates; it does not hand out
// per-item GOs.

import type { Tier } from "../../shared/types.ts";

/** Waking questions a Lead may send its Manager, or a Manager the Orchestrator, per hour. More arrive as FYI. */
export const UPWARD_ASKS_PER_HOUR = 3;

const HUMAN = "credentials or API keys, real spending, private data, or access only the owner grants";

/** The "Your authority" section of a supervisor's brief (null for everyone else). */
export function authorityText(tier: Tier, scope: string): string | null {
  if (tier === "orchestrator")
    return [
      "You oversee the run and delegate what the human wants done. You do not run every step.",
      "- Managers decide everything inside their groups; leads decide everything inside their apps. Give them standing authority (\"you decide X within your group\") and never require a per-item GO / NO-GO for work inside a group or app.",
      "- Step in when something crosses groups, the plan changes (add, drop or reshape apps), a manager is stuck after trying, results go wrong (stages stall, gates keep failing, the budget runs hot), or the human asks for something. Then decide it, or delegate it with a clear owner.",
      "- Watch outcomes (stages, reports, the Watcher, the budget), not activity. A quiet group that is moving needs nothing from you.",
      "- When a manager asks about something inside its own group, answer in one line that it is their call, and why, rather than making the call for them.",
      `- The owner hears only about ${HUMAN}, or a question only the owner can answer (helm_need, about: owner).`,
    ].join("\n");
  if (tier === "manager")
    return [
      `You run ${scope} like a department head. Inside it you decide: priorities and order, task splits, any lead's next step, retries, fix rounds, check and gate runs, and disputes between your leads. Nobody needs the Orchestrator's GO for work inside your group.`,
      `Go to the Orchestrator (helm_message, kind ask, with the facts and your recommendation) only when something crosses into another group, changes the run's plan, needs capacity or budget your group does not have, or you are stuck after trying. At most ${UPWARD_ASKS_PER_HOUR} questions an hour wake it; batch the rest into one message. Send results, not questions: helm_report when an app is Ready, blocked or failed.`,
      `Go to the owner with helm_need only for ${HUMAN} (set \`about\`), or a question only the owner can answer about what the product should be (about: owner).`,
      "Your leads decide inside their apps. When a lead asks you about something inside its own app, tell it it is its call.",
    ].join("\n");
  if (tier === "lead")
    return [
      `You run ${scope}. Inside it you decide: the spec and contract, the squad and their tasks, the order of work, fixes, retries, check runs and when to go to Review. The Reviewer's and Slop Hunter's verdicts are binding: you decide how to fix, not whether to.`,
      `Go to your manager (helm_message, kind ask, with the facts and your recommendation) only when you finish (Ready), when something changes another app, when you need capacity or budget your app does not have, or when you are stuck after trying. At most ${UPWARD_ASKS_PER_HOUR} questions an hour wake it; batch the rest.`,
      `Go to the owner with helm_need for ${HUMAN} (set \`about\`). A question only the owner can answer (about: owner) goes to your manager first, who answers it from the brief or passes it on.`,
      "Your squad decides inside their tasks. Answer their questions quickly; they are blocked until you do.",
    ].join("\n");
  return null;
}

/** What helm_need tells a supervisor whose ordinary question stays with it (autonomy on). */
export function decideYourselfText(tier: Tier, scope: string): string {
  if (tier === "orchestrator")
    return "Autonomy is on: the human wants you to decide this. Pick the safest reasonable option, write it under Decisions in PORTFOLIO.md, tell the agents it affects (helm_direct), and keep going. The human reviews everything at sign-off. helm_need reaches the human only with about: credentials, spending, privacy, access, or owner (a question only the owner can answer).";
  const up = tier === "manager" ? "the Orchestrator" : "your manager";
  return `Autonomy is on, and this is your call: you decide what is inside ${scope}. Pick the safest reasonable option, record it in your notes, tell the agents it affects, and keep going. Ask ${up} (helm_message, kind ask) only if it crosses into another ${tier === "manager" ? "group" : "app"}, needs capacity or budget you do not have, or you are stuck after trying. helm_need reaches the owner only with about: credentials, spending, privacy, access, or owner.`;
}
