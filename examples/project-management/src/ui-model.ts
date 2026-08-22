import type { TaskStatus } from "./data.js";

export type ActivityEntry = Readonly<{
  id: number;
  title: string;
  detail: string;
  time: string;
  kind: "query" | "command";
}>;

export const statusDetails: Record<
  TaskStatus,
  Readonly<{ label: string; eyebrow: string; next?: TaskStatus }>
> = {
  backlog: { label: "Backlog", eyebrow: "Queue", next: "in_progress" },
  in_progress: { label: "In progress", eyebrow: "Active", next: "done" },
  done: { label: "Done", eyebrow: "Complete" },
};

export const priorityLabels = ["", "Low", "Normal", "High", "Urgent"];
export const projectColors = ["#6c5ce7", "#e17055", "#00a884", "#2d7ff9"];
