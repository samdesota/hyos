import { randomUUID } from "node:crypto";

import { hydb, type Database } from "@hyos/hydb";
import { z } from "zod";

import {
  literateDiffSchema,
  workspaceRepositorySchema,
  type LiterateDiff,
  type MessageRole,
  type SessionSnapshot,
  type SessionListItem,
  type SessionStatus,
  type WorkspaceRepository,
} from "./domain.js";
import { messages, revisions, sessions } from "./model.js";

const WORKSPACE_MESSAGE_PREFIX = "HYAGENT_WORKSPACE:";
const ARCHIVED_MESSAGE = "HYAGENT_ARCHIVED";

const createSessionCommand = hydb.command({
  input: z.object({ id: z.string(), title: z.string(), now: z.date() }),
  async handler(transaction, input) {
    await transaction.insert(sessions, {
      id: input.id,
      title: input.title,
      status: "draft",
      createdAt: input.now,
      updatedAt: input.now,
    });
  },
});

const appendMessageCommand = hydb.command({
  input: z.object({
    id: z.string(),
    sessionId: z.string(),
    role: z.enum(["user", "agent", "system"]),
    content: z.string(),
    now: z.date(),
  }),
  async handler(transaction, input) {
    await transaction.insert(messages, {
      id: input.id,
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      createdAt: input.now,
    });
    await transaction.update(sessions, [input.sessionId], {
      updatedAt: input.now,
    });
  },
});

const setStatusCommand = hydb.command({
  input: z.object({
    sessionId: z.string(),
    status: z.enum(["draft", "running", "ready", "committed", "failed"]),
    now: z.date(),
  }),
  async handler(transaction, input) {
    await transaction.update(sessions, [input.sessionId], {
      status: input.status,
      updatedAt: input.now,
    });
  },
});

const setTitleCommand = hydb.command({
  input: z.object({ sessionId: z.string(), title: z.string(), now: z.date() }),
  async handler(transaction, input) {
    await transaction.update(sessions, [input.sessionId], {
      title: input.title,
      updatedAt: input.now,
    });
  },
});

const saveRevisionCommand = hydb.command({
  input: z.object({
    id: z.string(),
    sessionId: z.string(),
    number: z.number().int().positive(),
    summary: z.string(),
    blocks: z.array(z.unknown()),
    generatedIgnores: z.array(z.unknown()),
    now: z.date(),
  }),
  async handler(transaction, input) {
    const document = literateDiffSchema.parse({
      summary: input.summary,
      blocks: input.blocks,
      generatedIgnores: input.generatedIgnores,
    });
    await transaction.insert(revisions, {
      id: input.id,
      sessionId: input.sessionId,
      number: input.number,
      summary: document.summary,
      blocks: document.blocks,
      generatedIgnores: document.generatedIgnores,
      createdAt: input.now,
    });
    await transaction.update(sessions, [input.sessionId], {
      updatedAt: input.now,
    });
  },
});

export interface HyagentStore {
  createSession(title: string): Promise<SessionSnapshot>;
  getSession(id: string): Promise<SessionSnapshot>;
  listSessions(): Promise<SessionListItem[]>;
  subscribeSessions(signal?: AbortSignal): AsyncIterable<SessionListItem[]>;
  archiveSession(id: string): Promise<void>;
  subscribeSession(
    id: string,
    signal?: AbortSignal,
  ): AsyncIterable<SessionSnapshot>;
  latestUnfinishedSession(): Promise<SessionSnapshot | null>;
  getWorkspace(id: string): Promise<WorkspaceRepository[]>;
  saveWorkspace(
    id: string,
    repositories: readonly WorkspaceRepository[],
  ): Promise<void>;
  appendMessage(id: string, role: MessageRole, content: string): Promise<void>;
  saveRevision(id: string, document: LiterateDiff): Promise<void>;
  setStatus(id: string, status: SessionStatus): Promise<void>;
  setTitle(id: string, title: string): Promise<void>;
}

export function createHyagentStore(database: Database): HyagentStore {
  let lastWriteTime = 0;
  function observeTime(value: Date) {
    lastWriteTime = Math.max(lastWriteTime, value.getTime());
  }
  function nextWriteTime(): Date {
    lastWriteTime = Math.max(Date.now(), lastWriteTime + 1);
    return new Date(lastWriteTime);
  }

  async function getSession(id: string): Promise<SessionSnapshot> {
    const session = await database.fetch(
      hydb
        .query(sessions)
        .where((row) => row.id.eq(id))
        .require(),
    );
    const messageRows = await database.fetch(
      hydb
        .query(messages)
        .where((row) => row.sessionId.eq(id))
        .orderBy((row) => [row.createdAt.asc(), row.id.asc()])
        .many(),
    );
    const revisionRows = await database.fetch(
      hydb
        .query(revisions)
        .where((row) => row.sessionId.eq(id))
        .orderBy((row) => [row.number.desc()])
        .limit(1)
        .many(),
    );
    const revision = revisionRows[0];
    observeTime(session.updatedAt);
    for (const message of messageRows) observeTime(message.createdAt);
    for (const storedRevision of revisionRows)
      observeTime(storedRevision.createdAt);
    return {
      ...session,
      messages: messageRows
        .filter(
          (message) =>
            !message.content.startsWith(WORKSPACE_MESSAGE_PREFIX) &&
            message.content !== ARCHIVED_MESSAGE,
        )
        .map(({ sessionId: _sessionId, ...message }) => message),
      revision: revision
        ? {
            id: revision.id,
            number: revision.number,
            summary: revision.summary,
            blocks: [...revision.blocks],
            generatedIgnores: [...revision.generatedIgnores],
            createdAt: revision.createdAt,
          }
        : null,
    };
  }

  const sessionListQuery = () =>
    hydb
      .query(sessions)
      .orderBy((row) => [row.updatedAt.desc(), row.id.asc()])
      .many();

  async function listSessions(): Promise<SessionListItem[]> {
    const [rows, messageRows] = await Promise.all([
      database.fetch(sessionListQuery()),
      database.fetch(hydb.query(messages).many()),
    ]);
    const archived = new Set(
      messageRows
        .filter((message) => message.content === ARCHIVED_MESSAGE)
        .map((message) => message.sessionId),
    );
    for (const row of rows) observeTime(row.updatedAt);
    return rows.filter((row) => !archived.has(row.id));
  }

  return {
    async createSession(title) {
      const id = randomUUID();
      await database.execute(createSessionCommand, {
        id,
        title,
        now: nextWriteTime(),
      });
      return getSession(id);
    },
    getSession,
    listSessions,
    async *subscribeSessions(signal) {
      let dirty = false;
      let wake: (() => void) | undefined;
      const notify = () => {
        dirty = true;
        wake?.();
        wake = undefined;
      };
      const unsubscribe = database.subscribe(sessionListQuery(), notify);
      const abort = () => {
        wake?.();
        wake = undefined;
      };
      signal?.addEventListener("abort", abort);
      try {
        while (!signal?.aborted) {
          if (!dirty) {
            await new Promise<void>((resolveWake) => {
              wake = resolveWake;
              if (dirty || signal?.aborted) abort();
            });
          }
          if (signal?.aborted) return;
          dirty = false;
          yield await listSessions();
        }
      } finally {
        signal?.removeEventListener("abort", abort);
        unsubscribe();
      }
    },
    async archiveSession(id) {
      await database.execute(appendMessageCommand, {
        id: randomUUID(),
        sessionId: id,
        role: "system",
        content: ARCHIVED_MESSAGE,
        now: nextWriteTime(),
      });
    },
    async *subscribeSession(id, signal) {
      let dirty = false;
      let wake: (() => void) | undefined;
      const notify = () => {
        dirty = true;
        wake?.();
        wake = undefined;
      };
      const unsubscribe = database.subscribe(
        hydb
          .query(sessions)
          .where((row) => row.id.eq(id))
          .require(),
        notify,
      );
      signal?.addEventListener("abort", notify);
      try {
        while (!signal?.aborted) {
          if (!dirty) {
            await new Promise<void>((resolveWake) => {
              wake = resolveWake;
              if (dirty || signal?.aborted) notify();
            });
          }
          if (signal?.aborted) return;
          dirty = false;
          yield await getSession(id);
        }
      } finally {
        signal?.removeEventListener("abort", notify);
        unsubscribe();
      }
    },
    async latestUnfinishedSession() {
      const rows = await listSessions();
      const latest = rows.find((row) => row.status !== "committed");
      return latest ? getSession(latest.id) : null;
    },
    async getWorkspace(id) {
      const rows = await database.fetch(
        hydb
          .query(messages)
          .where((row) => row.sessionId.eq(id))
          .orderBy((row) => [row.createdAt.desc()])
          .many(),
      );
      const saved = rows.find((row) =>
        row.content.startsWith(WORKSPACE_MESSAGE_PREFIX),
      );
      if (!saved) return [];
      return z
        .array(workspaceRepositorySchema)
        .parse(
          JSON.parse(saved.content.slice(WORKSPACE_MESSAGE_PREFIX.length)),
        );
    },
    async saveWorkspace(id, repositories) {
      const parsed = z
        .array(workspaceRepositorySchema)
        .min(1)
        .max(20)
        .parse(repositories);
      await database.execute(appendMessageCommand, {
        id: randomUUID(),
        sessionId: id,
        role: "system",
        content: `${WORKSPACE_MESSAGE_PREFIX}${JSON.stringify(parsed)}`,
        now: nextWriteTime(),
      });
    },
    async appendMessage(id, role, content) {
      await database.execute(appendMessageCommand, {
        id: randomUUID(),
        sessionId: id,
        role,
        content,
        now: nextWriteTime(),
      });
    },
    async saveRevision(id, rawDocument) {
      const document = literateDiffSchema.parse(rawDocument);
      const existing = await database.fetch(
        hydb
          .query(revisions)
          .where((row) => row.sessionId.eq(id))
          .orderBy((row) => row.number.desc())
          .limit(1)
          .many(),
      );
      await database.execute(saveRevisionCommand, {
        id: randomUUID(),
        sessionId: id,
        number: (existing[0]?.number ?? 0) + 1,
        summary: document.summary,
        blocks: document.blocks,
        generatedIgnores: document.generatedIgnores,
        now: nextWriteTime(),
      });
    },
    async setStatus(id, status) {
      await database.execute(setStatusCommand, {
        sessionId: id,
        status,
        now: nextWriteTime(),
      });
    },
    async setTitle(id, title) {
      await database.execute(setTitleCommand, {
        sessionId: id,
        title: z.string().trim().min(1).max(100).parse(title),
        now: nextWriteTime(),
      });
    },
  };
}
