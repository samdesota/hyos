import type { AgentReasoningEffort } from "../../../capabilities/agent.js";
import type { AgentRunInput } from "./types.js";
import { formatPlanBlock } from "../../../capabilities/plan.js";

export const incrementalFirstRequest =
  "Work collaboratively in small, fast iterations using light thinking. First understand the user's goal and propose a short plan. Identify only the first small, independently reviewable step. Do not implement it until the user approves. If you encounter something unexpected that blocks or would materially change the approved plan, stop and check in with the user before continuing.";

export const incrementalReminder =
  "Incremental mode: use light thinking and work in small, independently reviewable iterations. Complete and quickly verify one small iteration, briefly reassess the next smallest step, then continue. Do not silently expand the approved plan. If something unexpected blocks or would materially change it, stop and check in with the user.";

export const incrementalImplementRule =
  "Incremental mode: finish every implement turn with a git commit. Once this iteration's changes are verified, stage the files you touched and create a concise commit describing the change. Treat this as the user's standing authorization to run git add and git commit in this turn — but never push, and never commit when the turn was only read-only (investigate or conversation).";

export const incrementalPlanRule = `Incremental mode: maintain the session plan as a list of tasks. End every final response with the complete, updated plan in a fenced "hyos-plan" code block (info string hyos-plan), using task-list syntax "- [x] done task" and "- [ ] pending task". Rewrite the whole block each turn so it always reflects the true state of the plan, and mark a task done only after its change is verified.

Plan content rules: plans are not a log of what the agent has done — they contain only concrete, actionable implementation steps. Never add placeholder tasks such as "- [ ] Investigate user question" when no plan exists yet (a conversational or investigative turn needs no plan task), and never add tasks or prefixes about waiting for approval, such as "- [ ] investigate and wait for user approval" or "- [ ] (pending approval) Build something".

Example of the exact required format:

\`\`\`hyos-plan
- [x] Add plan parser
- [ ] Add parser tests
- [ ] Verify typecheck passes
\`\``;

export function glmTurnPolicy(
  input: AgentRunInput,
  systemPrompt: string,
): Readonly<{
  systemPrompt: string;
  prompt: string;
  effort: AgentReasoningEffort;
}> {
  if (input.mode !== "incremental") {
    return {
      systemPrompt,
      prompt: input.prompt,
      effort: input.reasoningEffort ?? "medium",
    };
  }
  const planPreamble = input.plan?.tasks.length
    ? `${formatPlanBlock(input.plan.tasks)}\n\nThe block above is the session's current plan of record. Keep it updated as instructed below.`
    : null;
  return {
    systemPrompt: `${systemPrompt}\n\nIncremental mode overrides the above requirement to complete the entire request. A conversational response without tools or file changes is a valid result. Only implement work within the approved plan.`,
    prompt: [
      planPreamble,
      input.prompt,
      input.firstTurn ? incrementalFirstRequest : null,
      input.intent === "implement" ? incrementalImplementRule : null,
      incrementalPlanRule,
      incrementalReminder,
    ]
      .filter(Boolean)
      .join("\n\n"),
    effort: "low",
  };
}
