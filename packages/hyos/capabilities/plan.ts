import type { AgentPlanTask } from "./agent.js";

/**
 * The session plan travels as a fenced code block with the `hyos-plan`
 * info string, holding a GitHub-style task list:
 *
 * ```hyos-plan
 * - [x] Done task
 * - [ ] Pending task
 * ```
 *
 * A fenced block is used (rather than an HTML comment) so the plan stays
 * visible as a plain code block wherever the structured rendering is
 * unavailable.
 */
export const planInfoString = "hyos-plan";

const planBlockPattern =
  /(^|\n)[ \t]{0,3}(`{3,}|~{3,})[ \t]*hyos-plan(?:[ \t]+[^\n]*)?\r?\n([\s\S]*?)\r?\n\2[ \t]*(?=\n|$)/g;

const taskPattern = /^[ \t]*[-*][ \t]+\[([ xX])\][ \t]+(.*)$/;

/** Parse the task lines of one plan block body. */
export function parsePlanTasks(body: string): readonly AgentPlanTask[] {
  const tasks: AgentPlanTask[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = taskPattern.exec(line);
    const text = match?.[2]?.trim();
    if (!match || !text) continue;
    tasks.push({ text, done: match[1] !== " " });
  }
  return tasks;
}

/**
 * The tasks of the last ```hyos-plan block in the content, or null when the
 * content carries no complete plan block (an unterminated fence while
 * streaming does not count).
 */
export function parsePlanBlock(
  content: string,
): readonly AgentPlanTask[] | null {
  let tasks: readonly AgentPlanTask[] | null = null;
  for (const match of content.matchAll(planBlockPattern)) {
    const parsed = parsePlanTasks(match[3] ?? "");
    if (parsed.length > 0) tasks = parsed;
  }
  return tasks;
}

/** Remove every complete ```hyos-plan block from the content. */
export function stripPlanBlocks(content: string): string {
  return content.replace(
    planBlockPattern,
    (_match, leading: string) => leading,
  );
}

/** Serialize tasks back into the fenced plan block. */
export function formatPlanBlock(tasks: readonly AgentPlanTask[]): string {
  const list = tasks
    .map((task) => `- [${task.done ? "x" : " "}] ${task.text}`)
    .join("\n");
  return `\`\`\`${planInfoString}\n${list}\n\`\`\``;
}
