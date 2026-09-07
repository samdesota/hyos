import type {
  AgentActivity,
  AgentMode,
  AgentMessageStatus,
  AgentPlan,
  AgentProviderSummary,
  AgentReasoningEffort,
  AgentSessionTab,
} from "../../../capabilities/agent.js";
import type { BrowserClient } from "../../browser-client/types.js";

export type AgentRunInput = Readonly<{
  prompt: string;
  /** The session the run belongs to, when the run is session-backed. */
  sessionId?: string;
  mode?: AgentMode;
  intent?: "implement" | "investigate";
  firstTurn?: boolean;
  /** The session's persisted plan, sent at the start of every user response. */
  plan?: AgentPlan | null;
  folder: string;
  modelId: string;
  reasoningEffort: AgentReasoningEffort | null;
  providerSessionId: string | null;
  /**
   * Returns the full transcript of an earlier turn (thinking and tool
   * responses included), selected by the turn's id — the id of its opening
   * user message, as shown in the persisted transcript. Resolves to null for
   * unknown ids or the current turn.
   */
  sessionTranscript?: (turnId: string) => Promise<string | null>;
  /** Browser client for opening tabs and other browser operations. */
  browserClient?: BrowserClient;
  /**
   * Appends one opened page to the run's session's persisted tab strip and
   * focuses it — the durable record a subscribing renderer reconciles its
   * strip against. Absent when the run has no session-backed tab store.
   */
  appendSessionTab?: (tab: AgentSessionTab) => Promise<void>;
}>;

export type AgentTokenUsage = Readonly<{
  promptTokens: number;
  completionTokens: number | null;
  contextWindow: number;
}>;

export type AgentRunResult = Readonly<{
  providerSessionId: string | null;
  usage?: AgentTokenUsage;
}>;

export type AgentRunSink = Readonly<{
  session(providerSessionId: string): void | Promise<void>;
  /** Context usage from the most recent model round, reported as it lands. */
  usage?(usage: AgentTokenUsage): void | Promise<void>;
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
