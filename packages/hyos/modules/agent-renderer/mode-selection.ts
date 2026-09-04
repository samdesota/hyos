import type { AgentMode } from "../../capabilities/agent.js";

export function selectedMode(
  providerId: string,
  persisted: AgentMode = "standard",
  draft?: AgentMode,
): AgentMode {
  return providerId === "glm" ? (draft ?? persisted) : "standard";
}
