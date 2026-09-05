import { createClaudeProvider } from "./claude.js";
import { createCodexProvider } from "./codex.js";
import { createGlmProvider } from "./glm.js";
import type { AgentProvider } from "./types.js";

export type { AgentProvider, AgentRunInput, AgentRunResult } from "./types.js";

export function createAgentProviders(
  enabled: readonly string[],
  config: Readonly<{
    codex?: Readonly<{
      authDirectory?: string;
    }>;
    claude?: Readonly<{
      binaryPath?: string;
      configDirectory?: string;
    }>;
    glm?: Readonly<{
      apiKeyEnvironment?: string;
      environmentFile?: string;
      baseUrl?: string;
    }>;
  }> = {},
): ReadonlyMap<string, AgentProvider> {
  const available = new Map(
    [
      createCodexProvider(config.codex),
      createClaudeProvider(config.claude),
      createGlmProvider(config.glm),
    ].map((provider) => [provider.summary.id, provider]),
  );
  return new Map(
    enabled.flatMap((id) => {
      const provider = available.get(id);
      return provider ? [[id, provider] as const] : [];
    }),
  );
}
