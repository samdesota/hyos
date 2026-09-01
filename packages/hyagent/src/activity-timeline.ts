import type { AgentActivityEvent } from "./activity.js";

export interface ActivityTimelineItem {
  activity: AgentActivityEvent;
  createdAt: Date | string;
}

export type ActivityTimelineGroup =
  | { kind: "thinking"; item: ActivityTimelineItem }
  | { kind: "commands"; items: ActivityTimelineItem[] };

export function activityTimeline(
  events: readonly ActivityTimelineItem[],
): ActivityTimelineGroup[] {
  const groups: ActivityTimelineGroup[] = [];
  for (const item of events) {
    if (item.activity.status !== "working") continue;
    if (item.activity.kind === "thinking") {
      groups.push({ kind: "thinking", item });
      continue;
    }
    if (item.activity.kind !== "command") continue;
    const previous = groups.at(-1);
    if (previous?.kind === "commands") previous.items.push(item);
    else groups.push({ kind: "commands", items: [item] });
  }
  return groups;
}

type CommandCategory = "edit" | "read" | "run" | "search" | "finish" | "use";

function commandCategory(summary: string): CommandCategory {
  if (/^(Updating|Rewinding|Replaying)\b/.test(summary)) return "edit";
  if (/^Reading\b/.test(summary)) return "read";
  if (/^Running\b/.test(summary)) return "run";
  if (/^Searching\b/.test(summary)) return "search";
  if (/^Finishing\b/.test(summary)) return "finish";
  return "use";
}

export function commandGroupSummary(
  items: readonly ActivityTimelineItem[],
): string {
  const categories = new Map<CommandCategory, number>();
  for (const { activity } of items) {
    const category = commandCategory(activity.summary);
    categories.set(category, (categories.get(category) ?? 0) + 1);
  }
  const phrase = (category: CommandCategory, count: number): string => {
    if (category === "edit") return "Edited files";
    if (category === "read") return count === 1 ? "Read a file" : "Read files";
    if (category === "run")
      return count === 1 ? "Ran a command" : "Ran commands";
    if (category === "search") return "Searched the web";
    if (category === "finish") return "Finished the run";
    return count === 1 ? "Used a tool" : "Used tools";
  };
  const parts = [...categories].map(([category, count]) =>
    phrase(category, count),
  );
  return parts
    .map((part, index) => (index === 0 ? part : part.toLowerCase()))
    .join(", ");
}
