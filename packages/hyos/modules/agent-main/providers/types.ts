import type {
  AgentActivity,
  AgentMessageStatus,
  AgentProviderSummary,
  AgentReasoningEffort,
} from "../../../capabilities/agent.js";

export type AgentRunInput = Readonly<{
  prompt: string;
  folder: string;
  modelId: string;
  reasoningEffort: AgentReasoningEffort | null;
  providerSessionId: string | null;
}>;

export type AgentRunResult = Readonly<{
  providerSessionId: string | null;
}>;

export type AgentRunSink = Readonly<{
  session(providerSessionId: string): void | Promise<void>;
  response(content: string): void | Promise<void>;
  activity(
    providerItemId: string,
    activity: AgentActivity,
    status: AgentMessageStatus,
  ): void | Promise<void>;
}>;

export interface AgentProvider {
  readonly summary: AgentProviderSummary;
  prepare?(): Promise<void>;
  run(
    input: AgentRunInput,
    sink: AgentRunSink,
    signal: AbortSignal,
  ): Promise<AgentRunResult>;
}

export function novelSuffix(previous: string, next: string): string {
  if (next.startsWith(previous)) return next.slice(previous.length);
  return next;
}
