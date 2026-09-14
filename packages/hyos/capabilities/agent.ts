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

export type AgentPlanTask = Readonly<{
  text: string;
  done: boolean;
}>;

export type AgentPlan = Readonly<{
  tasks: readonly AgentPlanTask[];
}>;

// A session's persisted tabs: which tabs it shows and which is focused, so
// the pane survives app restarts. Each entry names the host tab it came
// from (`tabId`, verified against `url` on restore — ids die with a host
// generation, so the url is the fallback that re-opens the page) — the
// record is written as user-intent deltas, never as pane snapshots. Entries
// are kind-discriminated so new tab kinds join the same stored container
// without another schema change.
export type AgentSessionTab = Readonly<{
  kind: "browser";
  tabId: string;
  url: string;
}>;

export type AgentSessionTabs = Readonly<{
  tabs: readonly AgentSessionTab[];
  activeIndex: number;
}>;

/**
 * One change to a session's persisted tab strip, published to the renderer
 * as it lands in the database — the intent-carrying signal (an agent opened
 * a tab, the user edited the strip) that replaces inferring from browser
 * host publishes.
 */
export type AgentSessionTabsChange = Readonly<{
  sessionId: AgentSessionId;
  tabs: AgentSessionTabs | null;
}>;

/**
 * One persisted global tab's kind-specific payload, decoded from the row's
 * versioned JSON `data` field. Kinds form an open union so new surfaces join
 * without a schema change.
 */
export type AgentGlobalTabData =
  | Readonly<{ kind: "browser"; url: string; title: string }>
  | Readonly<{ kind: "whiteboard"; boardId: string }>;

/** One global tab strip entry as the store API hands it around. */
export type AgentGlobalTabRow = Readonly<{
  id: string;
  data: AgentGlobalTabData;
  active: boolean;
  position: number;
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
  plan: AgentPlan | null;
  status: AgentSessionStatus;
  /** Short (3–5 word) description of the current/last run's work. */
  statusDetail: string | null;
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
      intent?: "implement" | "investigate" | "summary";
    }>
  | Readonly<{ type: "cancel"; sessionId: AgentSessionId }>
  | Readonly<{ type: "interrupt"; sessionId: AgentSessionId }>
  | Readonly<{ type: "archive-session"; sessionId: AgentSessionId }>
  | Readonly<{ type: "unarchive-session"; sessionId: AgentSessionId }>
  | Readonly<{
      type: "rename-session";
      sessionId: AgentSessionId;
      title: string;
    }>
  | Readonly<{
      type: "reorder-sessions";
      orderedIds: readonly AgentSessionId[];
    }>;

export type AgentCommandResult =
  | Readonly<{ type: "folder-selected"; folder: string | null }>
  | Readonly<{ type: "session-started"; sessionId: AgentSessionId }>
  | Readonly<{ type: "accepted" }>;

export const agentCapability = defineRemoteCapability({
  id: "agent",
  version: 9,
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
    sessionTabs: remoteMethod<
      readonly [sessionId: AgentSessionId],
      AgentSessionTabs | null
    >(),
    saveSessionTabs: remoteMethod<
      readonly [sessionId: AgentSessionId, tabs: AgentSessionTabs | null],
      void
    >(),
    /** The persisted global tab strip, ordered by position. */
    globalTabs: remoteMethod<readonly [], readonly AgentGlobalTabRow[]>(),
    /** Replace the whole global tab strip with the given one. */
    replaceGlobalTabs: remoteMethod<
      readonly [tabs: readonly AgentGlobalTabRow[]],
      void
    >(),
  },
  events: {
    sessions: remoteEvent<AgentSessionsState>(),
    messageChange: remoteEvent<AgentFeedChange>(),
    sessionTabs: remoteEvent<AgentSessionTabsChange>(),
    /** Pings whenever the global tab strip changed; the caller re-reads. */
    globalTabs: remoteEvent<void>(),
  },
});
