export const DEFAULT_UI_AGENT_MODEL = "zai/glm-5.3-flash";

export interface UiAgentModelOption {
  id: string;
  label: string;
}

export const UI_AGENT_MODEL_OPTIONS: UiAgentModelOption[] = [
  { id: "zai/glm-5.3-flash", label: "GLM 5.3 Flash" },
  { id: "thinkingmachines/inkling-small", label: "Inkling Small" },
  { id: "google/gemini-3-flash", label: "Gemini 3 Flash" },
  { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5" },
  { id: "openai/gpt-5.4-mini-fast", label: "GPT-5.4 Mini Fast" },
];

export function availableModelOptions(
  configuredModel: string,
  options = UI_AGENT_MODEL_OPTIONS,
): UiAgentModelOption[] {
  if (options.some((option) => option.id === configuredModel)) return options;
  return [{ id: configuredModel, label: configuredModel }, ...options];
}
