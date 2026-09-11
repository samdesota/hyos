import {
  hydb,
  id,
  index,
  integer,
  number,
  text,
  timestamp,
  uniqueIndex,
  type InferRow,
} from "@hyos/hydb";

const sessionStatus = hydb.enum("hyos_agent_session_status", [
  "running",
  "ready",
  "failed",
  "cancelled",
] as const);
const messageRole = hydb.enum("hyos_agent_message_role", [
  "user",
  "assistant",
  "system",
] as const);
const messageStatus = hydb.enum("hyos_agent_message_status", [
  "streaming",
  "complete",
  "failed",
] as const);

export const agentSessions = hydb.table(
  "hyos_agent_sessions",
  {
    id: id().primaryKey(),
    title: text().notNull(),
    folder: text().notNull(),
    providerId: text().notNull(),
    modelId: text().notNull(),
    providerSessionId: text(),
    status: sessionStatus().notNull(),
    statusDetail: text(),
    lastError: text(),
    plan: text(),
    tabs: text(),
    // Manual sidebar rank (null = never manually ordered; those sort newest-first).
    order: integer(),
    archivedAt: timestamp(),
    createdAt: timestamp().notNull(),
    updatedAt: timestamp().notNull(),
  },
  (columns) => [
    index("hyos_agent_sessions_updated_idx").on(columns.updatedAt, columns.id),
  ],
);

export const agentMessages = hydb.table(
  "hyos_agent_messages",
  {
    id: id().primaryKey(),
    sessionId: id()
      .notNull()
      .references(() => agentSessions.id),
    role: messageRole().notNull(),
    status: messageStatus().notNull(),
    lastError: text(),
    promptTokens: integer(),
    completionTokens: integer(),
    contextWindow: integer(),
    createdAt: timestamp().notNull(),
    updatedAt: timestamp().notNull(),
  },
  (columns) => [
    index("hyos_agent_messages_session_created_idx").on(
      columns.sessionId,
      columns.createdAt,
      columns.id,
    ),
  ],
);

export const agentMessageChunks = hydb.table(
  "hyos_agent_message_chunks",
  {
    id: id().primaryKey(),
    sessionId: id()
      .notNull()
      .references(() => agentSessions.id),
    messageId: id()
      .notNull()
      .references(() => agentMessages.id),
    index: integer().notNull(),
    content: text().notNull(),
    createdAt: timestamp().notNull(),
  },
  (columns) => [
    uniqueIndex("hyos_agent_chunks_message_index_idx").on(
      columns.messageId,
      columns.index,
    ),
    index("hyos_agent_chunks_session_created_idx").on(
      columns.sessionId,
      columns.createdAt,
      columns.id,
    ),
  ],
);

// Boards are identified up front by the tab's uuid, so the row is created
// lazily on first save; a board with no row simply has no cards yet.
export const agentBoards = hydb.table(
  "hyos_agent_boards",
  {
    id: id().primaryKey(),
    createdAt: timestamp().notNull(),
    updatedAt: timestamp().notNull(),
  },
  (columns) => [index("hyos_agent_boards_updated_idx").on(columns.updatedAt)],
);

// hydb has no blob type (Uint8Array silently corrupts), so image bytes
// live as base64 text in this dedicated table, referenced by card mediaId.
// Declared before the cards table so their forward reference is safe.
export const agentBoardMedia = hydb.table(
  "hyos_agent_board_media",
  {
    id: id().primaryKey(),
    boardId: id()
      .notNull()
      .references(() => agentBoards.id),
    data: text().notNull(),
    createdAt: timestamp().notNull(),
  },
  (columns) => [
    index("hyos_agent_board_media_board_idx").on(columns.boardId, columns.id),
  ],
);

export const agentBoardCards = hydb.table(
  "hyos_agent_board_cards",
  {
    id: id().primaryKey(),
    boardId: id()
      .notNull()
      .references(() => agentBoards.id),
    // World coordinates of the card's top-left corner.
    x: number().notNull(),
    y: number().notNull(),
    markdown: text().notNull(),
    // Set once image cards exist: a reference into agentBoardMedia.
    mediaId: id().references(() => agentBoardMedia.id),
    createdAt: timestamp().notNull(),
    updatedAt: timestamp().notNull(),
  },
  (columns) => [
    index("hyos_agent_board_cards_board_idx").on(columns.boardId, columns.id),
  ],
);

// The agent's global tab strip: one row per tab, so the strip survives app
// restarts. `kind` is the queryable discriminator; everything kind-specific
// (a browser tab's url/title, a whiteboard tab's boardId) rides in the
// versioned JSON `data` field, so new tab kinds join without a schema
// change. `active` (1 = focused tab) and `position` are strip-level state,
// not tab data.
export const agentGlobalTabs = hydb.table(
  "hyos_agent_global_tabs",
  {
    id: id().primaryKey(),
    kind: text().notNull(),
    data: text(),
    active: integer().notNull(),
    position: integer().notNull(),
    createdAt: timestamp().notNull(),
    updatedAt: timestamp().notNull(),
  },
  (columns) => [
    uniqueIndex("hyos_agent_global_tabs_position_idx").on(columns.position),
  ],
);

export const agentSchema = hydb.schema({
  agentSessions,
  agentMessages,
  agentMessageChunks,
  agentBoards,
  agentBoardCards,
  agentBoardMedia,
  agentGlobalTabs,
});

export type StoredAgentSession = InferRow<typeof agentSessions>;
export type StoredAgentMessage = InferRow<typeof agentMessages>;
export type StoredAgentMessageChunk = InferRow<typeof agentMessageChunks>;
