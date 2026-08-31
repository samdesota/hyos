export interface AgentOption {
  id: string;
  label: string;
}

export const DEFAULT_AGENT = "anthropic/claude-sonnet-4.5";

export const AGENT_OPTIONS: readonly AgentOption[] = [
  { id: DEFAULT_AGENT, label: "Claude Sonnet 4.5" },
  { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "anthropic/claude-opus-5", label: "Claude Opus 5" },
  { id: "openai/gpt-5.6-sol", label: "GPT 5.6 Sol" },
  { id: "openai/gpt-5.6-terra", label: "GPT 5.6 Terra" },
  { id: "openai/gpt-5.6-luna", label: "GPT 5.6 Luna" },
  { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
  { id: "zai/glm-5.3-flash", label: "GLM 5.3 Flash" },
];

export function availableAgents(configuredAgent: string): AgentOption[] {
  if (AGENT_OPTIONS.some((agent) => agent.id === configuredAgent)) {
    return [...AGENT_OPTIONS];
  }
  return [
    { id: configuredAgent, label: `${configuredAgent} (configured)` },
    ...AGENT_OPTIONS,
  ];
}
