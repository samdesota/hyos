import type { AgentRunInput } from "./types.js";

export const incrementalFirstRequest =
  "Work collaboratively in small, fast iterations using light thinking. First understand the user's goal and propose a short plan. Identify only the first small, independently reviewable step. Do not implement it until the user approves. If you encounter something unexpected that blocks or would materially change the approved plan, stop and check in with the user before continuing.";

export const incrementalReminder =
  "Incremental mode: use light thinking and work in small, independently reviewable iterations. Complete and quickly verify one small iteration, briefly reassess the next smallest step, then continue. Do not silently expand the approved plan. If something unexpected blocks or would materially change it, stop and check in with the user.";

export const incrementalImplementRule =
  "Incremental mode: finish every implement turn with a git commit. Once this iteration's changes are verified, stage the files you touched and create a concise commit describing the change. Treat this as the user's standing authorization to run git add and git commit in this turn — but never push, and never commit when the turn was only read-only (investigate or conversation).";

export function glmTurnPolicy(input: AgentRunInput, systemPrompt: string) {
  if (input.mode !== "incremental") {
    return {
      systemPrompt,
      prompt: input.prompt,
      effort: input.reasoningEffort ?? "medium",
    };
  }
  return {
    systemPrompt: `${systemPrompt}\n\nIncremental mode overrides the above requirement to complete the entire request. A conversational response without tools or file changes is a valid result. Only implement work within the approved plan.`,
    prompt: [
      input.prompt,
      input.firstTurn ? incrementalFirstRequest : null,
      input.intent === "implement" ? incrementalImplementRule : null,
      incrementalReminder,
    ]
      .filter(Boolean)
      .join("\n\n"),
    effort: "low",
  };
}
