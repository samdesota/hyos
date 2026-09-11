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
// the pane survives app restarts. Entries are kind-discriminated so new tab
// kinds join the same stored container without another schema change.
export type AgentSessionTab = Readonly<{
  kind: "browser";
  url: string;
  title: string;
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

/**
 * One card on a whiteboard: a markdown note or an image (via mediaId)
 * placed at world coordinates, so it pans and zooms with the canvas.
 */
export type AgentBoardCard = Readonly<{
  id: string;
  x: number;
  y: number;
  markdown: string;
  /** Reference into the board's media table once image cards exist. */
  mediaId: string | null;
}>;

/** A board's full card list plus its media (data URLs), loaded or saved as one unit. */
export type AgentBoard = Readonly<{
  boardId: string;
  cards: readonly AgentBoardCard[];
  /** Media rows keyed by id; values are image data URLs. */
  media: Readonly<Record<string, string>>;
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
  version: 7,
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
    /** A board's cards; a board that was never saved reads as empty. */
    board: remoteMethod<readonly [boardId: string], AgentBoard>(),
    /** Replace a board's whole card list with the given one. */
    saveBoard: remoteMethod<
      readonly [boardId: string, cards: readonly AgentBoardCard[]],
      void
    >(),
    /** Store one image (a data URL) referenced by a card's mediaId. */
    saveBoardMedia: remoteMethod<
      readonly [boardId: string, mediaId: string, data: string],
      void
    >(),
  },
  events: {
    sessions: remoteEvent<AgentSessionsState>(),
    messageChange: remoteEvent<AgentFeedChange>(),
    sessionTabs: remoteEvent<AgentSessionTabsChange>(),
  },
});
