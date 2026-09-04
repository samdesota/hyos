import type { AgentMode } from "../../capabilities/agent.js";

export function selectedMode(
  providerId: string,
  persisted: AgentMode = "incremental",
  draft?: AgentMode,
): AgentMode {
  return providerId === "glm" ? (draft ?? persisted) : "standard";
}
