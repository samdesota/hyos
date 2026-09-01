export const ACTIVITY_MESSAGE_PREFIX = "HYAGENT_ACTIVITY:";

export interface AgentActivityEvent {
  runId: string;
  status: "working" | "complete" | "failed" | "stopped";
  summary: string;
  detail?: string;
}

export function encodeActivityEvent(event: AgentActivityEvent): string {
  return `${ACTIVITY_MESSAGE_PREFIX}${JSON.stringify(event)}`;
}

export function decodeActivityEvent(
  content: string,
): AgentActivityEvent | null {
  if (!content.startsWith(ACTIVITY_MESSAGE_PREFIX)) return null;
  try {
    const value = JSON.parse(content.slice(ACTIVITY_MESSAGE_PREFIX.length)) as
      Partial<AgentActivityEvent> | undefined;
    if (
      typeof value?.runId !== "string" ||
      !["working", "complete", "failed", "stopped"].includes(
        value.status ?? "",
      ) ||
      typeof value.summary !== "string" ||
      (value.detail !== undefined && typeof value.detail !== "string")
    ) {
      return null;
    }
    return value as AgentActivityEvent;
  } catch {
    return null;
  }
}
