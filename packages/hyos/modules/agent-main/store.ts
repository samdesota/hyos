import { randomUUID } from "node:crypto";

import { hydb, type Database } from "@hyos/hydb";
import { perfLog, perfNow } from "./perf-time.js";
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
  AgentSessionTabsChange,
  AgentGlobalTabData,
  AgentGlobalTabRow,
  AgentFolderStateRow,
} from "../../capabilities/agent.js";

// The strip row types live in the capability contract (the renderer reads the
// same shapes over the wire); re-exported here for the store's callers.
export type { AgentGlobalTabData, AgentGlobalTabRow, AgentFolderStateRow };
import {
  agentFolderState,
  agentGlobalTabs,
  agentMessageChunks,
  agentMessageImages,
  agentMessages,
  agentSessions,
  type StoredAgentMessage,
  type StoredAgentMessageChunk,
} from "./model.js";
import type { StoredImage } from "./media-store.js";

const sessionStatusSchema = z.enum(["running", "ready", "failed", "cancelled"]);
const messageStatusSchema = z.enum(["streaming", "complete", "failed"]);
// File references persisted under the storage's media/ directory — never
// image bytes.
const storedImageSchema = z.object({
  id: z.string(),
  file: z.string(),
  mimeType: z.string(),
});

/**
 * Reference the turn's persisted media files from its user message. Files are
 * written to the media directory before the command runs; the rows only carry
 * the file name, so no image bytes ever enter the database.
 */
async function insertMessageImages(
  transaction: Parameters<Parameters<typeof hydb.command>[0]["handler"]>[0],
  sessionId: string,
  messageId: string,
  images: readonly StoredImage[],
  now: Date,
): Promise<void> {
  for (const image of images) {
    await transaction.insert(agentMessageImages, {
      id: image.id,
      sessionId,
      messageId,
      file: image.file,
      mimeType: image.mimeType,
      createdAt: now,
    });
  }
}
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

// v2 entries persist {tabId, url} pairs (intent-delta writes); v1's
// url+title snapshots decode as empty, dropping pre-delta records once.
const sessionTabsVersion = 2;

const globalTabDataVersion = 1;

function encodeGlobalTabData(data: AgentGlobalTabData): string {
  return JSON.stringify({ version: globalTabDataVersion, ...data });
}

// One row's payload, decoded defensively: torn or hand-edited JSON — or a
// shape this build doesn't understand — reads as "no data", dropping just
// that tab instead of failing the whole strip.
function decodeGlobalTabData(
  kind: string,
  value: string | null | undefined,
): AgentGlobalTabData | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return null;
    const container = parsed as { version?: unknown };
    if (container.version !== globalTabDataVersion) return null;
    if (kind === "browser") {
      const { url, title } = container as { url?: unknown; title?: unknown };
      if (typeof url !== "string" || url.length === 0) return null;
      if (typeof title !== "string") return null;
      return { kind: "browser", url, title };
    }
    if (kind === "whiteboard") {
      const { boardId } = container as { boardId?: unknown };
      if (typeof boardId !== "string" || boardId.length === 0) return null;
      return { kind: "whiteboard", boardId };
    }
    return null;
  } catch {
    return null;
  }
}

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
      const tab = entry as { kind?: unknown; tabId?: unknown; url?: unknown };
      if (tab.kind !== "browser") return [];
      if (typeof tab.tabId !== "string" || tab.tabId.length === 0) return [];
      if (typeof tab.url !== "string" || tab.url.length === 0) return [];
      return [{ kind: "browser" as const, tabId: tab.tabId, url: tab.url }];
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
    images: z.array(storedImageSchema).readonly().default([]),
    statusDetail: z.string().nullable(),
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
      statusDetail: input.statusDetail,
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
    await insertMessageImages(
      transaction,
      input.sessionId,
      input.userMessageId,
      input.images,
      input.now,
    );
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
    images: z.array(storedImageSchema).readonly().default([]),
    statusDetail: z.string().nullable(),
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
      statusDetail: input.statusDetail,
      lastError: null,
      updatedAt: assistantTime,
    });
    await insertMessageImages(
      transaction,
      input.sessionId,
      input.userMessageId,
      input.images,
      input.now,
    );
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

// A global-tabs save is a whole-strip replacement: rows the renderer dropped
// are deleted and the rest upserted. Doing it in one transaction keeps the
// unique position index from transiently colliding mid-write.
const replaceGlobalTabsCommand = hydb.command({
  input: z.object({
    now: z.date(),
    tabs: z.array(
      z.object({
        id: z.string(),
        kind: z.string(),
        data: z.string(),
        active: z.number(),
        position: z.number(),
      }),
    ),
    removedIds: z.array(z.string()),
  }),
  async handler(transaction, input) {
    for (const removedId of input.removedIds) {
      if ((await transaction.get(agentGlobalTabs, [removedId])) !== undefined) {
        await transaction.delete(agentGlobalTabs, [removedId]);
      }
    }
    for (const tab of input.tabs) {
      const existing = await transaction.get(agentGlobalTabs, [tab.id]);
      if (existing === undefined) {
        await transaction.insert(agentGlobalTabs, {
          id: tab.id,
          kind: tab.kind,
          data: tab.data,
          active: tab.active,
          position: tab.position,
          createdAt: input.now,
          updatedAt: input.now,
        });
      } else {
        await transaction.update(agentGlobalTabs, [tab.id], {
          kind: tab.kind,
          data: tab.data,
          active: tab.active,
          position: tab.position,
          updatedAt: input.now,
        });
      }
    }
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

const renameSessionCommand = hydb.command({
  input: z.object({ sessionId: z.string(), title: z.string(), now: z.date() }),
  async handler(transaction, input) {
    await transaction.update(agentSessions, [input.sessionId], {
      title: input.title,
      updatedAt: input.now,
    });
  },
});

const setStatusDetailCommand = hydb.command({
  input: z.object({
    sessionId: z.string(),
    statusDetail: z.string(),
    now: z.date(),
  }),
  async handler(transaction, input) {
    await transaction.update(agentSessions, [input.sessionId], {
      statusDetail: input.statusDetail,
      updatedAt: input.now,
    });
  },
});

const reorderSessionsCommand = hydb.command({
  input: z.object({ orderedIds: z.array(z.string()) }),
  async handler(transaction, input) {
    for (const [index, sessionId] of input.orderedIds.entries()) {
      await transaction.update(agentSessions, [sessionId], {
        order: index,
      });
    }
  },
});

// Folder state is a lazy upsert: only fields the caller passes are written
// (null = leave unchanged), so a reorder doesn't clobber collapse flags and
// vice versa. Rows appear on first write and are never deleted — stale rows
// for vanished folders are simply ignored by the ordering logic.
const upsertFolderStateCommand = hydb.command({
  input: z.object({
    now: z.date(),
    entries: z.array(
      z.object({
        folder: z.string(),
        position: z.number().nullable(),
        collapsed: z.number().nullable(),
        worktreeDefault: z.number().nullable(),
      }),
    ),
  }),
  async handler(transaction, input) {
    for (const entry of input.entries) {
      const existing = await transaction.get(agentFolderState, [entry.folder]);
      if (existing === undefined) {
        await transaction.insert(agentFolderState, {
          folder: entry.folder,
          position: entry.position,
          collapsed: entry.collapsed,
          worktreeDefault: entry.worktreeDefault,
          createdAt: input.now,
          updatedAt: input.now,
        });
      } else {
        await transaction.update(agentFolderState, [entry.folder], {
          position: entry.position ?? existing.position,
          collapsed: entry.collapsed ?? existing.collapsed,
          worktreeDefault: entry.worktreeDefault ?? existing.worktreeDefault,
          updatedAt: input.now,
        });
      }
    }
  },
});

// Deliberately does not touch updatedAt: marking an outcome seen must not
// reorder the sidebar.
const markSessionSeenCommand = hydb.command({
  input: z.object({
    sessionId: z.string(),
    seenStatusDetail: z.string().nullable(),
  }),
  async handler(transaction, input) {
    await transaction.update(agentSessions, [input.sessionId], {
      seenStatusDetail: input.seenStatusDetail,
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
    statusDetail: string | null;
    seenStatusDetail: string | null;
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
    statusDetail: row.statusDetail,
    seenStatusDetail: row.seenStatusDetail,
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
  /** Media files already written to disk; rows reference them by id. */
  images?: readonly StoredImage[];
}>;

export type StartedTurn = Readonly<{
  sessionId: string;
  assistantMessageId: string;
  /**
   * The previous assistant response the deterministic status detail was
   * derived from, so the host can offer it to model-generated descriptions.
   */
  previousResponse: string | null;
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
    images?: readonly StoredImage[],
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
  /** The persisted global tab strip, ordered by position. */
  loadGlobalTabs(): Promise<AgentGlobalTabRow[]>;
  /** Replace the whole global tab strip with the given one. */
  replaceGlobalTabs(tabs: readonly AgentGlobalTabRow[]): Promise<void>;
  /** Fires whenever the global tabs table changes; the caller re-reads. */
  watchGlobalTabs(listener: () => void): () => void;
  /** The persisted per-folder sidebar state, ordered by position. */
  loadFolderState(): Promise<AgentFolderStateRow[]>;
  /** Persist the manual folder order (list index = position rank). */
  reorderFolders(orderedFolders: readonly string[]): Promise<void>;
  /** Persist one folder's collapsed flag. */
  setFolderCollapsed(folder: string, collapsed: boolean): Promise<void>;
  /** Persist whether new sessions for a folder default to a worktree. */
  setFolderWorktree(folder: string, worktree: boolean): Promise<void>;
  /** Fires whenever the folder state table changes; the caller re-reads. */
  watchFolderState(listener: () => void): () => void;
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
  renameSession(sessionId: string, title: string): Promise<void>;
  /**
   * Persist a manual sidebar order: each id gets its list index as rank.
   * Sessions not listed keep their existing rank; never-ordered sessions
   * (null rank) still sort above manually ordered ones, newest first.
   */
  reorderSessions(orderedIds: readonly string[]): Promise<void>;
  /** Copy the session's current statusDetail into seenStatusDetail. */
  markSessionSeen(sessionId: string): Promise<void>;
  setStatusDetail(sessionId: string, statusDetail: string): Promise<void>;
  listSessions(): Promise<AgentSessionSummary[]>;
  pageMessages(
    sessionId: string,
    before: AgentMessageCursor | null,
    count: number,
  ): Promise<AgentMessagePage>;
  watchSessions(listener: () => void): () => void;
  watchMessages(sessionId: string, listener: () => void): () => void;
  /**
   * Fires with a session's decoded strip whenever its persisted tabs column
   * changes — agent `browser_open_tab` writes or renderer saves. Null means
   * the strip was cleared. One subscription covers every session so the host
   * can forward changes without knowing which ones a renderer watches.
   */
  watchSessionTabs(
    listener: (change: AgentSessionTabsChange) => void,
  ): () => void;
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

  /**
   * Plain text of the session's most recent assistant response — the raw
   * streamed reply, without reasoning or tool activity — used to describe
   * the next turn's work when the prompt is a bare continuation.
   */
  async function latestAssistantText(
    sessionId: string,
  ): Promise<string | null> {
    const rows = await database.fetch(
      hydb
        .query(agentMessages)
        .where((message) => message.sessionId.eq(sessionId))
        .orderBy((message) => [message.createdAt.desc(), message.id.desc()])
        .limit(20)
        .many(),
    );
    const latest = rows.find((row) => row.role === "assistant");
    if (!latest) return null;
    const chunks = await database.fetch(
      hydb
        .query(agentMessageChunks)
        .where((chunk) => chunk.messageId.eq(latest.id))
        .orderBy((chunk) => [chunk.index.asc(), chunk.id.asc()])
        .many(),
    );
    const content = chunks.map((chunk) => chunk.content).join("");
    return content.startsWith(activityPrefix) ||
      content.startsWith(commentaryPrefix)
      ? null
      : content;
  }

  async function fetchSessionChunks(
    sessionId: string,
  ): Promise<Map<string, StoredAgentMessageChunk[]>> {
    // One query for the whole session's chunks instead of one per message:
    // hydb serializes fetches (~11ms each), so per-message queries made
    // opening a 200-message page cost seconds. Grouped in memory by message.
    const chunks = await database.fetch(
      hydb
        .query(agentMessageChunks)
        .where((chunk) => chunk.sessionId.eq(sessionId))
        .orderBy((chunk) => [chunk.index.asc(), chunk.id.asc()])
        .many(),
    );
    const byMessage = new Map<string, StoredAgentMessageChunk[]>();
    for (const chunk of chunks) {
      const existing = byMessage.get(chunk.messageId);
      if (existing) existing.push(chunk);
      else byMessage.set(chunk.messageId, [chunk]);
    }
    return byMessage;
  }

  function messageValue(
    row: StoredAgentMessage,
    chunks: StoredAgentMessageChunk[],
  ): AgentMessage {
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
        statusDetail: null,
        ...input,
        modelId: storedModelId(
          input.modelId,
          input.reasoningEffort,
          input.mode,
        ),
        now: now(),
      });
      return { sessionId, assistantMessageId, previousResponse: null };
    },
    async startTurn(sessionId, prompt, mode, reasoningEffort, images) {
      const getSessionStartedAt = perfNow();
      const session = await getSession(sessionId);
      perfLog(`send:getSession(${sessionId})`, perfNow() - getSessionStartedAt);
      const previousResponse = await latestAssistantText(sessionId);
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
        images: images ?? [],
        statusDetail: null,
        now: now(),
      });
      return { sessionId, assistantMessageId, previousResponse };
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
      console.log(
        `[tabs-debug] store: saveSessionTabs session=${sessionId} tabs=${tabs?.tabs.length ?? 0} focus=${tabs?.activeIndex}`,
      );
      await database.execute(updateSessionTabsCommand, {
        sessionId,
        tabs: encodeSessionTabs(tabs),
      });
    },
    async loadGlobalTabs() {
      const rows = await database.fetch(
        hydb
          .query(agentGlobalTabs)
          .orderBy((tab) => [tab.position.asc(), tab.id.asc()])
          .many(),
      );
      return rows.flatMap((row) => {
        const data = decodeGlobalTabData(row.kind, row.data);
        return data
          ? [
              {
                id: row.id,
                data,
                active: row.active !== 0,
                position: row.position,
              },
            ]
          : [];
      });
    },
    async replaceGlobalTabs(tabs) {
      const stored = await database.fetch(hydb.query(agentGlobalTabs).many());
      const kept = new Set(tabs.map((tab) => tab.id));
      const removedIds = stored
        .filter((row) => !kept.has(row.id))
        .map((row) => row.id);
      await database.execute(replaceGlobalTabsCommand, {
        now: now(),
        tabs: tabs.map((tab) => ({
          id: tab.id,
          kind: tab.data.kind,
          data: encodeGlobalTabData(tab.data),
          active: tab.active ? 1 : 0,
          position: tab.position,
        })),
        removedIds,
      });
    },
    watchGlobalTabs(listener) {
      // One row per tab means any commit touching the table is a strip
      // change; the caller re-fetches via loadGlobalTabs, so a bare ping
      // carries all the information there is.
      return database.subscribe(
        hydb
          .query(agentGlobalTabs)
          .orderBy((tab) => [tab.position.asc(), tab.id.asc()])
          .many(),
        listener,
      );
    },
    async loadFolderState() {
      const rows = await database.fetch(hydb.query(agentFolderState).many());
      // Manually ordered folders first, in rank order; unordered and
      // half-ordered rows trail in stable path order. The renderer further
      // filters this against the folders it actually has sessions for.
      return rows
        .sort(
          (left, right) =>
            (left.position ?? Number.POSITIVE_INFINITY) -
              (right.position ?? Number.POSITIVE_INFINITY) ||
            left.folder.localeCompare(right.folder),
        )
        .map((row) => ({
          folder: row.folder,
          position: row.position,
          collapsed: row.collapsed !== 0 && row.collapsed !== null,
          worktreeDefault: row.worktreeDefault === 1,
        }));
    },
    async reorderFolders(orderedFolders) {
      if (orderedFolders.length === 0) return;
      await database.execute(upsertFolderStateCommand, {
        now: now(),
        entries: orderedFolders.map((folder, index) => ({
          folder,
          position: index,
          collapsed: null,
          worktreeDefault: null,
        })),
      });
    },
    async setFolderCollapsed(folder, collapsed) {
      await database.execute(upsertFolderStateCommand, {
        now: now(),
        entries: [
          {
            folder,
            position: null,
            collapsed: collapsed ? 1 : 0,
            worktreeDefault: null,
          },
        ],
      });
    },
    async setFolderWorktree(folder, worktree) {
      await database.execute(upsertFolderStateCommand, {
        now: now(),
        entries: [
          {
            folder,
            position: null,
            collapsed: null,
            worktreeDefault: worktree ? 1 : 0,
          },
        ],
      });
    },
    watchFolderState(listener) {
      return database.subscribe(hydb.query(agentFolderState).many(), listener);
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
    async renameSession(sessionId, title) {
      await database.execute(renameSessionCommand, {
        sessionId,
        title: titleFromPrompt(title),
        now: now(),
      });
    },
    async reorderSessions(orderedIds) {
      if (orderedIds.length === 0) return;
      await database.execute(reorderSessionsCommand, {
        orderedIds: [...orderedIds],
      });
    },
    async markSessionSeen(sessionId) {
      const row = await database.fetch(
        hydb
          .query(agentSessions)
          .where((session) => session.id.eq(sessionId))
          .require(),
      );
      await database.execute(markSessionSeenCommand, {
        sessionId,
        seenStatusDetail: row.statusDetail,
      });
    },
    async setStatusDetail(sessionId, statusDetail) {
      await database.execute(setStatusDetailCommand, {
        sessionId,
        statusDetail,
        now: now(),
      });
    },
    async listSessions() {
      const rows = await database.fetch(
        hydb
          .query(agentSessions)
          .orderBy((session) => [session.createdAt.desc(), session.id.asc()])
          .many(),
      );
      // Manual order wins: ranked sessions sort by rank; sessions never
      // manually ordered (null rank) stay on top, newest first — matching
      // the pre-order behavior for brand-new sessions.
      const ordered = rows.toSorted((left, right) => {
        if (left.order === null && right.order === null) return 0;
        if (left.order === null) return -1;
        if (right.order === null) return 1;
        return left.order - right.order;
      });
      return ordered.map(sessionSummary);
    },
    async pageMessages(sessionId, before, count) {
      const startedAt = perfNow();
      let t = startedAt;
      const rows = await database.fetch(
        hydb
          .query(agentMessages)
          .where((message) => message.sessionId.eq(sessionId))
          .orderBy((message) => [message.createdAt.desc(), message.id.desc()])
          .many(),
      );
      const fetchMs = perfNow() - t;
      t = perfNow();
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
      selected.reverse();
      const chunksByMessage = await fetchSessionChunks(sessionId);
      const assembled = selected.map((row) =>
        messageValue(row, chunksByMessage.get(row.id) ?? []),
      );
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
      const assembleMs = perfNow() - t;
      perfLog(
        `session-open:page-fetch(${sessionId}) [${rows.length} rows]`,
        fetchMs,
      );
      perfLog(`session-open:page-assemble(${sessionId})`, assembleMs);
      perfLog(`session-open:pageMessages(${sessionId})`, perfNow() - startedAt);
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
          .orderBy((session) => [session.createdAt.desc(), session.id.asc()])
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
    watchSessionTabs(listener) {
      // The tabs column rides on the session rows, so one subscription on
      // the sessions table covers every session; a diff of the raw encoded
      // strings decides which sessions actually changed, so unchanged
      // writes (and writes this build decodes to nothing) never fire.
      const lastTabs = new Map<string, string | null>();
      const seed = async (): Promise<void> => {
        for (const row of await database.fetch(
          hydb.query(agentSessions).many(),
        ))
          lastTabs.set(row.id, row.tabs ?? null);
      };
      void seed();
      return database.subscribe(hydb.query(agentSessions).many(), () => {
        void (async () => {
          for (const row of await database.fetch(
            hydb.query(agentSessions).many(),
          )) {
            const encoded = row.tabs ?? null;
            if (lastTabs.get(row.id) === encoded) continue;
            lastTabs.set(row.id, encoded);
            listener({
              sessionId: row.id,
              tabs: decodeSessionTabs(encoded),
            });
          }
        })();
      });
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
