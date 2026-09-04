import {
  defineRemoteCapability,
  remoteEvent,
  remoteMethod,
} from "./contract.js";

export type AgentSessionId = string;
export type AgentMessageId = string;
export type AgentFeedId = string;

export type AgentSessionStatus = "running" | "ready" | "failed" | "cancelled";
export type AgentMessageStatus = "streaming" | "complete" | "failed";
export type AgentReasoningEffort = "low" | "medium" | "high" | "max";
export type AgentMode = "standard" | "incremental";

export type AgentToolCategory =
  "read" | "edit" | "command" | "search" | "plan" | "tool";

export type AgentPatchChange = Readonly<{
  path: string;
  kind: string;
}>;

export type AgentActivity =
  | Readonly<{
      type: "commentary";
      text: string;
    }>
  | Readonly<{
      type: "tool";
      category: AgentToolCategory;
      label: string;
      detail: string;
    }>
  | Readonly<{
      type: "patch";
      explanation: string;
      changes: readonly AgentPatchChange[];
      diff: string;
    }>;

export type AgentModel = Readonly<{
  id: string;
  label: string;
  reasoningEfforts?: readonly AgentReasoningEffort[];
  defaultReasoningEffort?: AgentReasoningEffort;
}>;

export type AgentProviderSummary = Readonly<{
  id: string;
  label: string;
  models: readonly AgentModel[];
}>;

export type AgentSessionSummary = Readonly<{
  id: AgentSessionId;
  title: string;
  folder: string;
  providerId: string;
  modelId: string;
  reasoningEffort: AgentReasoningEffort | null;
  mode: AgentMode;
  status: AgentSessionStatus;
  lastError: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type AgentMessage = Readonly<{
  id: AgentMessageId;
  sessionId: AgentSessionId;
  role: "user" | "assistant" | "system";
  status: AgentMessageStatus;
  content: string;
  activity: AgentActivity | null;
  lastError: string | null;
  usage: Readonly<{
    promptTokens: number;
    completionTokens: number | null;
    contextWindow: number;
  }> | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type AgentMessageCursor = Readonly<{
  createdAt: Date;
  id: AgentMessageId;
}>;

export type AgentMessagePage = Readonly<{
  messages: readonly AgentMessage[];
  before: AgentMessageCursor | null;
  hasOlder: boolean;
}>;

export type AgentFileContent = Readonly<{
  path: string;
  content: string;
}>;

export type AgentMessageChange =
  | Readonly<{
      type: "message-created";
      sequence: number;
      message: AgentMessage;
    }>
  | Readonly<{
      type: "content-appended";
      sequence: number;
      messageId: AgentMessageId;
      content: string;
      updatedAt: Date;
    }>
  | Readonly<{
      type: "message-replaced";
      sequence: number;
      message: AgentMessage;
    }>
  | Readonly<{
      type: "message-status";
      sequence: number;
      messageId: AgentMessageId;
      status: AgentMessageStatus;
      lastError: string | null;
      updatedAt: Date;
    }>;

export type AgentSessionsState = Readonly<{
  sequence: number;
  sessions: readonly AgentSessionSummary[];
}>;

export type AgentFeedOpened = Readonly<{
  feedId: AgentFeedId;
  sequence: number;
  page: AgentMessagePage;
}>;

export type AgentFeedChange = Readonly<{
  feedId: AgentFeedId;
  change: AgentMessageChange;
}>;

export type AgentCommand =
  | Readonly<{ type: "choose-folder" }>
  | Readonly<{
      type: "start-session";
      prompt: string;
      folder: string;
      providerId: string;
      modelId: string;
      reasoningEffort?: AgentReasoningEffort | null;
      mode?: AgentMode;
      intent?: "implement" | "investigate";
    }>
  | Readonly<{
      type: "send-message";
      sessionId: AgentSessionId;
      prompt: string;
      mode?: AgentMode;
      reasoningEffort?: AgentReasoningEffort | null;
      intent?: "implement" | "investigate";
    }>
  | Readonly<{ type: "cancel"; sessionId: AgentSessionId }>
  | Readonly<{ type: "archive-session"; sessionId: AgentSessionId }>
  | Readonly<{ type: "unarchive-session"; sessionId: AgentSessionId }>;

export type AgentCommandResult =
  | Readonly<{ type: "folder-selected"; folder: string | null }>
  | Readonly<{ type: "session-started"; sessionId: AgentSessionId }>
  | Readonly<{ type: "accepted" }>;

export const agentCapability = defineRemoteCapability({
  id: "agent",
  version: 1,
  methods: {
    execute: remoteMethod<
      readonly [command: AgentCommand],
      AgentCommandResult
    >(),
    providers: remoteMethod<readonly [], readonly AgentProviderSummary[]>(),
    sessions: remoteMethod<readonly [], AgentSessionsState>(),
    openFeed: remoteMethod<
      readonly [sessionId: AgentSessionId, newestCount: number],
      AgentFeedOpened
    >(),
    loadOlder: remoteMethod<
      readonly [
        sessionId: AgentSessionId,
        before: AgentMessageCursor,
        count: number,
      ],
      AgentMessagePage
    >(),
    readFile: remoteMethod<
      readonly [sessionId: AgentSessionId, path: string],
      AgentFileContent
    >(),
    closeFeed: remoteMethod<readonly [feedId: AgentFeedId], void>(),
  },
  events: {
    sessions: remoteEvent<AgentSessionsState>(),
    messageChange: remoteEvent<AgentFeedChange>(),
  },
});
