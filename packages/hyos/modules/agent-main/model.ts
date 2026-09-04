import {
  hydb,
  id,
  index,
  integer,
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
    lastError: text(),
    plan: text(),
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

export const agentSchema = hydb.schema({
  agentSessions,
  agentMessages,
  agentMessageChunks,
});

export type StoredAgentSession = InferRow<typeof agentSessions>;
export type StoredAgentMessage = InferRow<typeof agentMessages>;
