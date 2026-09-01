import { hydb, id, index, integer, json, text, timestamp } from "@hyos/hydb";

import type {
  GeneratedIgnore,
  LiterateBlock,
  MessageRole,
  SessionStatus,
} from "./domain.js";

const sessionStatus = hydb.enum("hyagent_session_status", [
  "draft",
  "running",
  "ready",
  "committed",
  "failed",
] as const);
const messageRole = hydb.enum("hyagent_message_role", [
  "user",
  "agent",
  "system",
] as const);

export const sessions = hydb.table("hyagent_sessions", {
  id: id().primaryKey(),
  title: text().notNull(),
  status: sessionStatus().notNull(),
  createdAt: timestamp().notNull(),
  updatedAt: timestamp().notNull(),
});

export const messages = hydb.table(
  "hyagent_messages",
  {
    id: id().primaryKey(),
    sessionId: id()
      .notNull()
      .references(() => sessions.id),
    role: messageRole().notNull(),
    content: text().notNull(),
    createdAt: timestamp().notNull(),
  },
  (columns) => [
    index("hyagent_messages_session_created_idx").on(
      columns.sessionId,
      columns.createdAt,
    ),
  ],
);

export const revisions = hydb.table(
  "hyagent_revisions",
  {
    id: id().primaryKey(),
    sessionId: id()
      .notNull()
      .references(() => sessions.id),
    number: integer().notNull(),
    summary: text().notNull(),
    blocks: json<readonly LiterateBlock[]>().notNull(),
    generatedIgnores: json<readonly GeneratedIgnore[]>().notNull(),
    createdAt: timestamp().notNull(),
  },
  (columns) => [
    index("hyagent_revisions_session_number_idx").on(
      columns.sessionId,
      columns.number,
    ),
  ],
);

export const hyagentSchema = hydb.schema({ sessions, messages, revisions });

// Keep the enum unions visible at this persistence seam.
export type StoredSessionStatus = SessionStatus;
export type StoredMessageRole = MessageRole;
