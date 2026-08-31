import { randomUUID } from "node:crypto";

import { hydb, type Database } from "@hyos/hydb";
import { z } from "zod";

import {
  literateDiffSchema,
  workspaceRepositorySchema,
  type LiterateDiff,
  type MessageRole,
  type SessionDiff,
  type SessionSnapshot,
  type SessionListItem,
  type SessionStatus,
  type WorkspaceRepository,
} from "./domain.js";
import { messages, revisions, sessions } from "./model.js";

const WORKSPACE_MESSAGE_PREFIX = "HYAGENT_WORKSPACE:";
const SOURCE_REPOSITORIES_MESSAGE_PREFIX = "HYAGENT_SOURCE_REPOSITORIES:";
const ARCHIVED_MESSAGE = "HYAGENT_ARCHIVED";
const PATCH_CURSOR_MESSAGE_PREFIX = "HYAGENT_PATCH_CURSOR:";
const DIFF_STARTED_MESSAGE_PREFIX = "HYAGENT_DIFF_STARTED:";
const DIFF_COMMITTED_MESSAGE_PREFIX = "HYAGENT_DIFF_COMMITTED:";

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
  recentRepositories(): Promise<WorkspaceRepository[]>;
  saveWorkspace(
    id: string,
    repositories: readonly WorkspaceRepository[],
  ): Promise<void>;
  saveSourceRepositories(
    id: string,
    repositories: readonly WorkspaceRepository[],
  ): Promise<void>;
  appendMessage(id: string, role: MessageRole, content: string): Promise<void>;
  saveRevision(
    id: string,
    document: LiterateDiff,
    appliedThrough?: string | null,
  ): Promise<void>;
  startDiff(id: string): Promise<SessionSnapshot>;
  commitDiff(
    id: string,
    revisionId: string,
    appliedThrough: string | null,
  ): Promise<SessionSnapshot>;
  setAppliedThrough(id: string, appliedThrough: string | null): Promise<void>;
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
        .orderBy((row) => [row.number.asc()])
        .many(),
    );
    const startedDiffs = messageRows.flatMap((message) => {
      if (!message.content.startsWith(DIFF_STARTED_MESSAGE_PREFIX)) return [];
      const parsed = z
        .object({ id: z.string().min(1) })
        .safeParse(
          JSON.parse(message.content.slice(DIFF_STARTED_MESSAGE_PREFIX.length)),
        );
      return parsed.success
        ? [{ ...parsed.data, createdAt: message.createdAt }]
        : [];
    });
    const committedDiffs = messageRows.flatMap((message) => {
      if (!message.content.startsWith(DIFF_COMMITTED_MESSAGE_PREFIX)) return [];
      const parsed = z
        .object({
          id: z.string().min(1),
          revisionId: z.string().min(1),
          appliedThrough: z.string().min(1).nullable(),
        })
        .safeParse(
          JSON.parse(
            message.content.slice(DIFF_COMMITTED_MESSAGE_PREFIX.length),
          ),
        );
      return parsed.success
        ? [{ ...parsed.data, createdAt: message.createdAt }]
        : [];
    });
    const activeStart = startedDiffs.at(-1);
    const activeDiffId = activeStart?.id ?? id;
    const activeRevisionRows = activeStart
      ? revisionRows.filter(
          (revision) =>
            revision.createdAt.getTime() > activeStart.createdAt.getTime(),
        )
      : revisionRows;
    const revision = activeRevisionRows.at(-1);
    const cursorMessage = [...messageRows]
      .reverse()
      .find(
        (message) =>
          message.content.startsWith(PATCH_CURSOR_MESSAGE_PREFIX) &&
          (!activeStart ||
            message.createdAt.getTime() > activeStart.createdAt.getTime()),
      );
    const defaultAppliedThrough =
      [...(revision?.blocks ?? [])]
        .reverse()
        .find((block) => block.kind === "apply_patch")?.id ?? null;
    let appliedThrough = defaultAppliedThrough;
    if (cursorMessage) {
      const parsed = z
        .object({ appliedThrough: z.string().min(1).nullable() })
        .safeParse(
          JSON.parse(
            cursorMessage.content.slice(PATCH_CURSOR_MESSAGE_PREFIX.length),
          ),
        );
      if (parsed.success) appliedThrough = parsed.data.appliedThrough;
    }
    const revisionById = new Map(
      revisionRows.map((storedRevision) => [storedRevision.id, storedRevision]),
    );
    const toRevision = (storedRevision: (typeof revisionRows)[number]) => ({
      id: storedRevision.id,
      number: storedRevision.number,
      summary: storedRevision.summary,
      blocks: [...storedRevision.blocks],
      generatedIgnores: [...storedRevision.generatedIgnores],
      createdAt: storedRevision.createdAt,
    });
    const diffs: SessionDiff[] = committedDiffs.flatMap((committed) => {
      const storedRevision = revisionById.get(committed.revisionId);
      return storedRevision
        ? [
            {
              id: committed.id,
              status: "committed" as const,
              revision: toRevision(storedRevision),
            },
          ]
        : [];
    });
    const firstStart = startedDiffs[0];
    const legacyRevision = firstStart
      ? revisionRows
          .filter(
            (storedRevision) =>
              storedRevision.createdAt.getTime() <
              firstStart.createdAt.getTime(),
          )
          .at(-1)
      : session.status === "committed" && committedDiffs.length === 0
        ? revisionRows.at(-1)
        : undefined;
    if (legacyRevision && !diffs.some((diff) => diff.id === id)) {
      diffs.unshift({
        id,
        status: "committed" as const,
        revision: toRevision(legacyRevision),
      });
    }
    if (!diffs.some((diff) => diff.id === activeDiffId)) {
      diffs.push({
        id: activeDiffId,
        status: "active" as const,
        revision: revision ? toRevision(revision) : null,
      });
    }
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
            !message.content.startsWith(SOURCE_REPOSITORIES_MESSAGE_PREFIX) &&
            !message.content.startsWith(PATCH_CURSOR_MESSAGE_PREFIX) &&
            !message.content.startsWith(DIFF_STARTED_MESSAGE_PREFIX) &&
            !message.content.startsWith(DIFF_COMMITTED_MESSAGE_PREFIX) &&
            message.content !== ARCHIVED_MESSAGE,
        )
        .map(({ sessionId: _sessionId, ...message }) => message),
      revision: revision ? toRevision(revision) : null,
      diffs,
      activeDiffId,
      latestRevisionNumber: revisionRows.at(-1)?.number ?? 0,
      appliedThrough,
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
    async recentRepositories() {
      const rows = await database.fetch(
        hydb
          .query(messages)
          .orderBy((row) => [row.createdAt.desc(), row.id.asc()])
          .many(),
      );
      const recent: WorkspaceRepository[] = [];
      const seen = new Set<string>();
      const sessionsWithSources = new Set(
        rows
          .filter((row) =>
            row.content.startsWith(SOURCE_REPOSITORIES_MESSAGE_PREFIX),
          )
          .map((row) => row.sessionId),
      );
      for (const row of rows) {
        const prefix = row.content.startsWith(
          SOURCE_REPOSITORIES_MESSAGE_PREFIX,
        )
          ? SOURCE_REPOSITORIES_MESSAGE_PREFIX
          : row.content.startsWith(WORKSPACE_MESSAGE_PREFIX)
            ? WORKSPACE_MESSAGE_PREFIX
            : null;
        if (!prefix) continue;
        if (
          prefix === WORKSPACE_MESSAGE_PREFIX &&
          sessionsWithSources.has(row.sessionId)
        ) {
          continue;
        }
        try {
          const repositories = z
            .array(workspaceRepositorySchema)
            .parse(JSON.parse(row.content.slice(prefix.length)));
          for (const repository of repositories) {
            if (seen.has(repository.root)) continue;
            seen.add(repository.root);
            recent.push(repository);
          }
        } catch {
          // Ignore malformed internal history while preserving other choices.
        }
      }
      return recent.slice(0, 20);
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
    async saveSourceRepositories(id, repositories) {
      const parsed = z
        .array(workspaceRepositorySchema)
        .min(1)
        .max(20)
        .parse(repositories);
      await database.execute(appendMessageCommand, {
        id: randomUUID(),
        sessionId: id,
        role: "system",
        content: `${SOURCE_REPOSITORIES_MESSAGE_PREFIX}${JSON.stringify(parsed)}`,
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
    async saveRevision(id, rawDocument, rawAppliedThrough) {
      const document = literateDiffSchema.parse(rawDocument);
      const appliedThrough =
        rawAppliedThrough === undefined
          ? ([...document.blocks]
              .reverse()
              .find((block) => block.kind === "apply_patch")?.id ?? null)
          : z.string().min(1).nullable().parse(rawAppliedThrough);
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
      await database.execute(appendMessageCommand, {
        id: randomUUID(),
        sessionId: id,
        role: "system",
        content: `${PATCH_CURSOR_MESSAGE_PREFIX}${JSON.stringify({ appliedThrough })}`,
        now: nextWriteTime(),
      });
    },
    async startDiff(id) {
      const session = await getSession(id);
      if (session.status !== "committed") {
        throw new Error("Only a committed diff can start a new diff");
      }
      await database.execute(appendMessageCommand, {
        id: randomUUID(),
        sessionId: id,
        role: "system",
        content: `${DIFF_STARTED_MESSAGE_PREFIX}${JSON.stringify({ id: randomUUID() })}`,
        now: nextWriteTime(),
      });
      await database.execute(setStatusCommand, {
        sessionId: id,
        status: "draft",
        now: nextWriteTime(),
      });
      return getSession(id);
    },
    async commitDiff(id, revisionId, appliedThrough) {
      const session = await getSession(id);
      if (session.revision?.id !== revisionId) {
        throw new Error("Only the active literate diff can be committed");
      }
      await database.execute(appendMessageCommand, {
        id: randomUUID(),
        sessionId: id,
        role: "system",
        content: `${DIFF_COMMITTED_MESSAGE_PREFIX}${JSON.stringify({
          id: session.activeDiffId,
          revisionId,
          appliedThrough,
        })}`,
        now: nextWriteTime(),
      });
      await database.execute(setStatusCommand, {
        sessionId: id,
        status: "committed",
        now: nextWriteTime(),
      });
      return getSession(id);
    },
    async setAppliedThrough(id, rawAppliedThrough) {
      const appliedThrough = z
        .string()
        .min(1)
        .nullable()
        .parse(rawAppliedThrough);
      await database.execute(appendMessageCommand, {
        id: randomUUID(),
        sessionId: id,
        role: "system",
        content: `${PATCH_CURSOR_MESSAGE_PREFIX}${JSON.stringify({ appliedThrough })}`,
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
