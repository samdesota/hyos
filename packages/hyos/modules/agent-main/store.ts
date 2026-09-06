import { randomUUID } from "node:crypto";

import { hydb, type Database } from "@hyos/hydb";
import { z } from "zod";

import type {
  AgentActivity,
  AgentMode,
  AgentMessage,
  AgentMessageCursor,
  AgentMessagePage,
  AgentMessageStatus,
  AgentPlan,
  AgentReasoningEffort,
  AgentSessionStatus,
  AgentSessionSummary,
  AgentSessionTabs,
} from "../../capabilities/agent.js";
import {
  agentMessageChunks,
  agentMessages,
  agentSessions,
  type StoredAgentMessage,
} from "./model.js";

const sessionStatusSchema = z.enum(["running", "ready", "failed", "cancelled"]);
const messageStatusSchema = z.enum(["streaming", "complete", "failed"]);
const activityPrefix = "hyos-agent-activity:v1:";
const commentaryPrefix = "hyos-agent-commentary:v2:";
const settingSeparator = "\u001fhyos-";

function storedModelId(
  modelId: string,
  reasoningEffort: AgentReasoningEffort | null | undefined,
  mode: AgentMode | undefined,
): string {
  const settings = [
    ...(reasoningEffort ? [`reasoning:${reasoningEffort}`] : []),
    ...(mode === "incremental" ? ["mode:incremental"] : []),
  ];
  return [modelId, ...settings].join(settingSeparator);
}

function modelSelection(value: string): {
  modelId: string;
  reasoningEffort: AgentReasoningEffort | null;
  mode: AgentMode;
} {
  const [modelId, ...settings] = value.split(settingSeparator);
  let reasoningEffort: AgentReasoningEffort | null = null;
  let mode: AgentMode = "standard";
  for (const setting of settings) {
    if (setting === "mode:incremental") {
      mode = "incremental";
      continue;
    }
    const effort = setting.startsWith("reasoning:")
      ? setting.slice("reasoning:".length)
      : "";
    if (
      effort === "low" ||
      effort === "medium" ||
      effort === "high" ||
      effort === "max"
    ) {
      reasoningEffort = effort;
    }
  }
  return { modelId, reasoningEffort, mode };
}

function encodeActivity(activity: AgentActivity): string {
  return activityPrefix + JSON.stringify(activity);
}

function decodeActivity(content: string): AgentActivity | null {
  if (!content.startsWith(activityPrefix)) return null;
  try {
    return JSON.parse(content.slice(activityPrefix.length)) as AgentActivity;
  } catch {
    return null;
  }
}

function encodePlan(plan: AgentPlan | null): string | null {
  return plan ? JSON.stringify(plan.tasks) : null;
}

function decodePlan(value: string | null | undefined): AgentPlan | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    const tasks = parsed.flatMap((task) => {
      const text =
        typeof (task as { text?: unknown })?.text === "string"
          ? (task as { text: string }).text.trim()
          : "";
      const done = typeof (task as { done?: unknown })?.done === "boolean";
      return text && done
        ? [{ text, done: (task as { done: boolean }).done }]
        : [];
    });
    return tasks.length > 0 ? { tasks } : null;
  } catch {
    return null;
  }
}

const sessionTabsVersion = 1;

function encodeSessionTabs(tabs: AgentSessionTabs | null): string | null {
  if (!tabs) return null;
  return JSON.stringify({
    version: sessionTabsVersion,
    tabs: tabs.tabs,
    activeIndex: tabs.activeIndex,
  });
}

// Tabs are stored as a versioned, kind-discriminated JSON blob so new tab
// kinds join without a schema change. Decoding keeps the kinds this build
// understands and drops the rest — plus torn or hand-edited JSON — instead
// of failing the whole session load.
function decodeSessionTabs(
  value: string | null | undefined,
): AgentSessionTabs | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return null;
    const container = parsed as {
      version?: unknown;
      tabs?: unknown;
      activeIndex?: unknown;
    };
    if (
      container.version !== sessionTabsVersion ||
      !Array.isArray(container.tabs)
    ) {
      return null;
    }
    const tabs = container.tabs.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const tab = entry as { kind?: unknown; url?: unknown; title?: unknown };
      if (tab.kind !== "browser") return [];
      if (typeof tab.url !== "string" || tab.url.length === 0) return [];
      if (typeof tab.title !== "string") return [];
      return [{ kind: "browser" as const, url: tab.url, title: tab.title }];
    });
    if (tabs.length === 0) return null;
    // -1 survives decode: it means "no browser tab focused" — the pane's
    // pinned tab is showing. Any other unusable index falls back to -1 too,
    // so restoring never invents a browser focus that was never saved.
    const activeIndex =
      typeof container.activeIndex === "number" &&
      Number.isInteger(container.activeIndex)
        ? Math.min(Math.max(container.activeIndex, -1), tabs.length - 1)
        : -1;
    return { tabs, activeIndex };
  } catch {
    return null;
  }
}

const createSessionCommand = hydb.command({
  input: z.object({
    sessionId: z.string(),
    userMessageId: z.string(),
    userChunkId: z.string(),
    assistantMessageId: z.string(),
    title: z.string(),
    folder: z.string(),
    providerId: z.string(),
    modelId: z.string(),
    prompt: z.string(),
    now: z.date(),
  }),
  async handler(transaction, input) {
    await transaction.insert(agentSessions, {
      id: input.sessionId,
      title: input.title,
      folder: input.folder,
      providerId: input.providerId,
      modelId: input.modelId,
      providerSessionId: null,
      status: "running",
      lastError: null,
      createdAt: input.now,
      updatedAt: input.now,
    });
    await transaction.insert(agentMessages, {
      id: input.userMessageId,
      sessionId: input.sessionId,
      role: "user",
      status: "complete",
      lastError: null,
      createdAt: input.now,
      updatedAt: input.now,
    });
    await transaction.insert(agentMessageChunks, {
      id: input.userChunkId,
      sessionId: input.sessionId,
      messageId: input.userMessageId,
      index: 0,
      content: input.prompt,
      createdAt: input.now,
    });
    await transaction.insert(agentMessages, {
      id: input.assistantMessageId,
      sessionId: input.sessionId,
      role: "assistant",
      status: "streaming",
      lastError: null,
      createdAt: new Date(input.now.getTime() + 1),
      updatedAt: new Date(input.now.getTime() + 1),
    });
  },
});

const startTurnCommand = hydb.command({
  input: z.object({
    sessionId: z.string(),
    userMessageId: z.string(),
    userChunkId: z.string(),
    assistantMessageId: z.string(),
    modelId: z.string(),
    prompt: z.string(),
    now: z.date(),
  }),
  async handler(transaction, input) {
    await transaction.insert(agentMessages, {
      id: input.userMessageId,
      sessionId: input.sessionId,
      role: "user",
      status: "complete",
      lastError: null,
      createdAt: input.now,
      updatedAt: input.now,
    });
    await transaction.insert(agentMessageChunks, {
      id: input.userChunkId,
      sessionId: input.sessionId,
      messageId: input.userMessageId,
      index: 0,
      content: input.prompt,
      createdAt: input.now,
    });
    const assistantTime = new Date(input.now.getTime() + 1);
    await transaction.insert(agentMessages, {
      id: input.assistantMessageId,
      sessionId: input.sessionId,
      role: "assistant",
      status: "streaming",
      lastError: null,
      createdAt: assistantTime,
      updatedAt: assistantTime,
    });
    await transaction.update(agentSessions, [input.sessionId], {
      modelId: input.modelId,
      status: "running",
      lastError: null,
      updatedAt: assistantTime,
    });
  },
});

const appendChunkCommand = hydb.command({
  input: z.object({
    id: z.string(),
    sessionId: z.string(),
    messageId: z.string(),
    index: z.number().int().nonnegative(),
    content: z.string(),
    now: z.date(),
  }),
  async handler(transaction, input) {
    await transaction.insert(agentMessageChunks, {
      id: input.id,
      sessionId: input.sessionId,
      messageId: input.messageId,
      index: input.index,
      content: input.content,
      createdAt: input.now,
    });
    await transaction.update(agentMessages, [input.messageId], {
      updatedAt: input.now,
    });
    await transaction.update(agentSessions, [input.sessionId], {
      updatedAt: input.now,
    });
  },
});

const createActivityCommand = hydb.command({
  input: z.object({
    id: z.string(),
    sessionId: z.string(),
    content: z.string(),
    status: messageStatusSchema,
    now: z.date(),
  }),
  async handler(transaction, input) {
    await transaction.insert(agentMessages, {
      id: input.id,
      sessionId: input.sessionId,
      role: "system",
      status: input.status,
      lastError: null,
      createdAt: input.now,
      updatedAt: input.now,
    });
    await transaction.insert(agentMessageChunks, {
      id: input.id,
      sessionId: input.sessionId,
      messageId: input.id,
      index: 0,
      content: input.content,
      createdAt: input.now,
    });
    await transaction.update(agentSessions, [input.sessionId], {
      updatedAt: input.now,
    });
  },
});

const appendCommentaryCommand = hydb.command({
  input: z.object({
    id: z.string(),
    sessionId: z.string(),
    messageId: z.string(),
    index: z.number().int().positive(),
    content: z.string(),
    status: messageStatusSchema,
    now: z.date(),
  }),
  async handler(transaction, input) {
    if (input.content)
      await transaction.insert(agentMessageChunks, {
        id: input.id,
        sessionId: input.sessionId,
        messageId: input.messageId,
        index: input.index,
        content: input.content,
        createdAt: input.now,
      });
    await transaction.update(agentMessages, [input.messageId], {
      status: input.status,
      updatedAt: input.now,
    });
    await transaction.update(agentSessions, [input.sessionId], {
      updatedAt: input.now,
    });
  },
});

const updateActivityCommand = hydb.command({
  input: z.object({
    id: z.string(),
    sessionId: z.string(),
    content: z.string(),
    status: messageStatusSchema,
    now: z.date(),
  }),
  async handler(transaction, input) {
    await transaction.update(agentMessageChunks, [input.id], {
      content: input.content,
    });
    await transaction.update(agentMessages, [input.id], {
      status: input.status,
      updatedAt: input.now,
    });
    await transaction.update(agentSessions, [input.sessionId], {
      updatedAt: input.now,
    });
  },
});

const updateUsageCommand = hydb.command({
  input: z.object({
    sessionId: z.string(),
    messageId: z.string(),
    usage: z.object({
      promptTokens: z.number().int(),
      completionTokens: z.number().int().nullable(),
      contextWindow: z.number().int(),
    }),
    now: z.date(),
  }),
  async handler(transaction, input) {
    await transaction.update(agentMessages, [input.messageId], {
      promptTokens: input.usage.promptTokens,
      completionTokens: input.usage.completionTokens,
      contextWindow: input.usage.contextWindow,
      createdAt: input.now,
      updatedAt: input.now,
    });
    await transaction.update(agentSessions, [input.sessionId], {
      updatedAt: input.now,
    });
  },
});

const finishRunCommand = hydb.command({
  input: z.object({
    sessionId: z.string(),
    messageId: z.string(),
    providerSessionId: z.string().nullable(),
    usage: z
      .object({
        promptTokens: z.number().int(),
        completionTokens: z.number().int().nullable(),
        contextWindow: z.number().int(),
      })
      .nullable(),
    now: z.date(),
  }),
  async handler(transaction, input) {
    await transaction.update(agentMessages, [input.messageId], {
      status: "complete",
      lastError: null,
      promptTokens: input.usage?.promptTokens ?? null,
      completionTokens: input.usage?.completionTokens ?? null,
      contextWindow: input.usage?.contextWindow ?? null,
      createdAt: input.now,
      updatedAt: input.now,
    });
    await transaction.update(agentSessions, [input.sessionId], {
      providerSessionId: input.providerSessionId,
      status: "ready",
      lastError: null,
      updatedAt: input.now,
    });
  },
});

const checkpointProviderSessionCommand = hydb.command({
  input: z.object({
    sessionId: z.string(),
    providerSessionId: z.string(),
    now: z.date(),
  }),
  async handler(transaction, input) {
    await transaction.update(agentSessions, [input.sessionId], {
      providerSessionId: input.providerSessionId,
      updatedAt: input.now,
    });
  },
});

const updatePlanCommand = hydb.command({
  input: z.object({
    sessionId: z.string(),
    plan: z.string().nullable(),
    now: z.date(),
  }),
  async handler(transaction, input) {
    await transaction.update(agentSessions, [input.sessionId], {
      plan: input.plan,
      updatedAt: input.now,
    });
  },
});

// Tab saves are background pane state, persisted on every debounced publish:
// unlike every other session write they must not bump updatedAt, or the
// sessions list would reorder underneath the user.
const updateSessionTabsCommand = hydb.command({
  input: z.object({ sessionId: z.string(), tabs: z.string().nullable() }),
  async handler(transaction, input) {
    await transaction.update(agentSessions, [input.sessionId], {
      tabs: input.tabs,
    });
  },
});

const endRunCommand = hydb.command({
  input: z.object({
    sessionId: z.string(),
    messageId: z.string(),
    sessionStatus: sessionStatusSchema,
    messageStatus: messageStatusSchema,
    error: z.string(),
    now: z.date(),
  }),
  async handler(transaction, input) {
    await transaction.update(agentMessages, [input.messageId], {
      status: input.messageStatus,
      lastError: input.error,
      createdAt: input.now,
      updatedAt: input.now,
    });
    await transaction.update(agentSessions, [input.sessionId], {
      status: input.sessionStatus,
      lastError: input.error,
      updatedAt: input.now,
    });
  },
});

const setSessionArchivedCommand = hydb.command({
  input: z.object({
    sessionId: z.string(),
    archivedAt: z.date().nullable(),
    now: z.date(),
  }),
  async handler(transaction, input) {
    await transaction.update(agentSessions, [input.sessionId], {
      archivedAt: input.archivedAt,
      updatedAt: input.now,
    });
  },
});

const recoverSessionCommand = hydb.command({
  input: z.object({ sessionId: z.string(), error: z.string(), now: z.date() }),
  async handler(transaction, input) {
    await transaction.update(agentSessions, [input.sessionId], {
      status: "failed",
      lastError: input.error,
      updatedAt: input.now,
    });
  },
});

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0] ?? "New session";
  return firstLine.length <= 72 ? firstLine : `${firstLine.slice(0, 69)}…`;
}

function sessionSummary(
  row: Readonly<{
    id: string;
    title: string;
    folder: string;
    providerId: string;
    modelId: string;
    status: AgentSessionStatus;
    lastError: string | null;
    plan: string | null;
    archivedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }>,
): AgentSessionSummary {
  const model = modelSelection(row.modelId);
  return {
    id: row.id,
    title: row.title,
    folder: row.folder,
    providerId: row.providerId,
    modelId: model.modelId,
    reasoningEffort: model.reasoningEffort,
    mode: model.mode,
    plan: decodePlan(row.plan),
    status: row.status,
    lastError: row.lastError,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type NewAgentSession = Readonly<{
  prompt: string;
  folder: string;
  providerId: string;
  modelId: string;
  reasoningEffort?: AgentReasoningEffort | null;
  mode?: AgentMode;
}>;

export type StartedTurn = Readonly<{
  sessionId: string;
  assistantMessageId: string;
}>;

export type AgentSessionRecord = AgentSessionSummary &
  Readonly<{ providerSessionId: string | null }>;

export interface AgentStore {
  createSession(input: NewAgentSession): Promise<StartedTurn>;
  startTurn(
    sessionId: string,
    prompt: string,
    mode?: AgentMode,
    reasoningEffort?: AgentReasoningEffort | null,
  ): Promise<StartedTurn>;
  appendAssistantChunk(
    sessionId: string,
    messageId: string,
    index: number,
    content: string,
  ): Promise<void>;
  upsertActivity(
    sessionId: string,
    messageId: string | null,
    activity: AgentActivity,
    status: AgentMessageStatus,
  ): Promise<string>;
  appendCommentary(
    sessionId: string,
    messageId: string | null,
    index: number,
    text: string,
    status: AgentMessageStatus,
    replace?: boolean,
  ): Promise<string>;
  checkpointProviderSession(
    sessionId: string,
    providerSessionId: string,
  ): Promise<void>;
  updatePlan(sessionId: string, plan: AgentPlan | null): Promise<void>;
  loadSessionTabs(sessionId: string): Promise<AgentSessionTabs | null>;
  saveSessionTabs(
    sessionId: string,
    tabs: AgentSessionTabs | null,
  ): Promise<void>;
  updateUsage(
    sessionId: string,
    messageId: string,
    usage: Readonly<{
      promptTokens: number;
      completionTokens: number | null;
      contextWindow: number;
    }>,
  ): Promise<void>;
  finishRun(
    sessionId: string,
    messageId: string,
    providerSessionId: string | null,
    usage?: Readonly<{
      promptTokens: number;
      completionTokens: number | null;
      contextWindow: number;
    }> | null,
  ): Promise<void>;
  endRun(
    sessionId: string,
    messageId: string,
    sessionStatus: AgentSessionStatus,
    messageStatus: AgentMessageStatus,
    error: string,
  ): Promise<void>;
  getSession(id: string): Promise<AgentSessionRecord>;
  setSessionArchived(sessionId: string, archived: boolean): Promise<void>;
  listSessions(): Promise<AgentSessionSummary[]>;
  pageMessages(
    sessionId: string,
    before: AgentMessageCursor | null,
    count: number,
  ): Promise<AgentMessagePage>;
  watchSessions(listener: () => void): () => void;
  watchMessages(sessionId: string, listener: () => void): () => void;
  recoverInterruptedSessions(): Promise<void>;
}

export function createAgentStore(database: Database): AgentStore {
  let lastWriteTime = 0;
  const now = (): Date => {
    lastWriteTime = Math.max(Date.now(), lastWriteTime + 2);
    return new Date(lastWriteTime);
  };

  async function getSession(id: string): Promise<AgentSessionRecord> {
    const row = await database.fetch(
      hydb
        .query(agentSessions)
        .where((session) => session.id.eq(id))
        .require(),
    );
    return { ...sessionSummary(row), providerSessionId: row.providerSessionId };
  }

  async function messageValue(row: StoredAgentMessage): Promise<AgentMessage> {
    const chunks = await database.fetch(
      hydb
        .query(agentMessageChunks)
        .where((chunk) => chunk.messageId.eq(row.id))
        .orderBy((chunk) => [chunk.index.asc(), chunk.id.asc()])
        .many(),
    );
    const storedContent = chunks.map((chunk) => chunk.content).join("");
    const content = storedContent.startsWith(commentaryPrefix)
      ? encodeActivity({
          type: "commentary",
          text: chunks.reduce((text, chunk) => {
            const part = JSON.parse(
              chunk.content.slice(commentaryPrefix.length),
            ) as { text: string; replace: boolean };
            return part.replace ? part.text : text + part.text;
          }, ""),
        })
      : storedContent;
    return {
      ...row,
      content,
      activity: decodeActivity(content),
      usage:
        row.promptTokens !== null && row.contextWindow !== null
          ? {
              promptTokens: row.promptTokens,
              completionTokens: row.completionTokens,
              contextWindow: row.contextWindow,
            }
          : null,
    };
  }

  return {
    async createSession(input) {
      const sessionId = randomUUID();
      const assistantMessageId = randomUUID();
      await database.execute(createSessionCommand, {
        sessionId,
        userMessageId: randomUUID(),
        userChunkId: randomUUID(),
        assistantMessageId,
        title: titleFromPrompt(input.prompt),
        ...input,
        modelId: storedModelId(
          input.modelId,
          input.reasoningEffort,
          input.mode,
        ),
        now: now(),
      });
      return { sessionId, assistantMessageId };
    },
    async startTurn(sessionId, prompt, mode, reasoningEffort) {
      const session = await getSession(sessionId);
      const assistantMessageId = randomUUID();
      await database.execute(startTurnCommand, {
        sessionId,
        userMessageId: randomUUID(),
        userChunkId: randomUUID(),
        assistantMessageId,
        modelId: storedModelId(
          session.modelId,
          reasoningEffort === undefined
            ? session.reasoningEffort
            : reasoningEffort,
          mode ?? session.mode,
        ),
        prompt,
        now: now(),
      });
      return { sessionId, assistantMessageId };
    },
    async appendAssistantChunk(sessionId, messageId, index, content) {
      if (content.length === 0) return;
      await database.execute(appendChunkCommand, {
        id: randomUUID(),
        sessionId,
        messageId,
        index,
        content,
        now: now(),
      });
    },
    async appendCommentary(
      sessionId,
      messageId,
      index,
      text,
      status,
      replace = false,
    ) {
      const id = messageId ?? randomUUID();
      const content = commentaryPrefix + JSON.stringify({ text, replace });
      if (messageId === null) {
        await database.execute(createActivityCommand, {
          id,
          sessionId,
          content,
          status,
          now: now(),
        });
      } else {
        await database.execute(appendCommentaryCommand, {
          id: randomUUID(),
          sessionId,
          messageId,
          index,
          content: text || replace ? content : "",
          status,
          now: now(),
        });
      }
      return id;
    },
    async upsertActivity(sessionId, messageId, activity, status) {
      const id = messageId ?? randomUUID();
      const input = {
        id,
        sessionId,
        content: encodeActivity(activity),
        status,
        now: now(),
      };
      await database.execute(
        messageId ? updateActivityCommand : createActivityCommand,
        input,
      );
      return id;
    },
    async checkpointProviderSession(sessionId, providerSessionId) {
      await database.execute(checkpointProviderSessionCommand, {
        sessionId,
        providerSessionId,
        now: now(),
      });
    },
    async updatePlan(sessionId, plan) {
      await database.execute(updatePlanCommand, {
        sessionId,
        plan: encodePlan(plan),
        now: now(),
      });
    },
    async loadSessionTabs(sessionId) {
      const row = await database.fetch(
        hydb
          .query(agentSessions)
          .where((session) => session.id.eq(sessionId))
          .require(),
      );
      return decodeSessionTabs(row.tabs);
    },
    async saveSessionTabs(sessionId, tabs) {
      await database.execute(updateSessionTabsCommand, {
        sessionId,
        tabs: encodeSessionTabs(tabs),
      });
    },
    async updateUsage(sessionId, messageId, usage) {
      await database.execute(updateUsageCommand, {
        sessionId,
        messageId,
        usage,
        now: now(),
      });
    },
    async finishRun(sessionId, messageId, providerSessionId, usage) {
      await database.execute(finishRunCommand, {
        sessionId,
        messageId,
        providerSessionId,
        usage: usage ?? null,
        now: now(),
      });
    },
    async endRun(sessionId, messageId, sessionStatus, messageStatus, error) {
      await database.execute(endRunCommand, {
        sessionId,
        messageId,
        sessionStatus,
        messageStatus,
        error,
        now: now(),
      });
    },
    getSession,
    async setSessionArchived(sessionId, archived) {
      await database.execute(setSessionArchivedCommand, {
        sessionId,
        archivedAt: archived ? now() : null,
        now: now(),
      });
    },
    async listSessions() {
      const rows = await database.fetch(
        hydb
          .query(agentSessions)
          .orderBy((session) => [session.updatedAt.desc(), session.id.asc()])
          .many(),
      );
      return rows.map(sessionSummary);
    },
    async pageMessages(sessionId, before, count) {
      const rows = await database.fetch(
        hydb
          .query(agentMessages)
          .where((message) => message.sessionId.eq(sessionId))
          .orderBy((message) => [message.createdAt.desc(), message.id.desc()])
          .many(),
      );
      const start = before
        ? Math.max(
            0,
            rows.findIndex(
              (row) =>
                row.id === before.id &&
                row.createdAt.getTime() === before.createdAt.getTime(),
            ) + 1,
          )
        : 0;
      const selected = rows.slice(start, start + Math.max(1, count));
      const assembled = await Promise.all(selected.reverse().map(messageValue));
      const maxPageBytes = 512 * 1024;
      let bytes = 0;
      let firstIncluded = assembled.length;
      for (let index = assembled.length - 1; index >= 0; index -= 1) {
        const size = Buffer.byteLength(assembled[index].content, "utf8");
        if (firstIncluded < assembled.length && bytes + size > maxPageBytes) {
          break;
        }
        bytes += size;
        firstIncluded = index;
      }
      const messages = assembled.slice(firstIncluded);
      const oldest = messages[0];
      return {
        messages,
        before: oldest
          ? { id: oldest.id, createdAt: oldest.createdAt }
          : before,
        hasOlder: start + messages.length < rows.length,
      };
    },
    watchSessions(listener) {
      return database.subscribe(
        hydb
          .query(agentSessions)
          .orderBy((session) => [session.updatedAt.desc(), session.id.asc()])
          .many(),
        listener,
      );
    },
    watchMessages(sessionId, listener) {
      const unsubscribeMessages = database.subscribe(
        hydb
          .query(agentMessages)
          .where((message) => message.sessionId.eq(sessionId))
          .orderBy((message) => [message.createdAt.desc(), message.id.desc()])
          .limit(80)
          .many(),
        listener,
      );
      const unsubscribeChunks = database.subscribe(
        hydb
          .query(agentMessageChunks)
          .where((chunk) => chunk.sessionId.eq(sessionId))
          .orderBy((chunk) => [chunk.createdAt.desc(), chunk.id.desc()])
          .limit(512)
          .many(),
        listener,
      );
      return () => {
        unsubscribeChunks();
        unsubscribeMessages();
      };
    },
    async recoverInterruptedSessions() {
      const rows = await database.fetch(
        hydb
          .query(agentSessions)
          .where((session) => session.status.eq("running"))
          .many(),
      );
      for (const row of rows) {
        const error = "Agent stopped before the previous turn completed.";
        const streamingMessages = await database.fetch(
          hydb
            .query(agentMessages)
            .where((message) =>
              message.sessionId.eq(row.id).and(message.status.eq("streaming")),
            )
            .many(),
        );
        if (streamingMessages.length === 0) {
          await database.execute(recoverSessionCommand, {
            sessionId: row.id,
            error,
            now: now(),
          });
          continue;
        }
        for (const message of streamingMessages) {
          await database.execute(endRunCommand, {
            sessionId: row.id,
            messageId: message.id,
            sessionStatus: "failed",
            messageStatus: "failed",
            error,
            now: now(),
          });
        }
      }
    },
  };
}
