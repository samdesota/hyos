import type { AgentMode } from "../../capabilities/agent.js";

/**
 * Providers whose turn policy runs hyos's incremental mode (glm-turn-policy):
 * glm and codex both call it; claude does not, so it stays standard-only.
 */
export function supportsIncremental(providerId: string): boolean {
  return providerId === "glm" || providerId === "codex";
}

export function selectedMode(
  providerId: string,
  persisted: AgentMode = "incremental",
  draft?: AgentMode,
): AgentMode {
  return supportsIncremental(providerId) ? (draft ?? persisted) : "standard";
}
